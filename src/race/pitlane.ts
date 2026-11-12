/**
 * Pit lane. Engages when an autopilot car with a pit request passes pit.entry, or a car is driven onto the pit road.
 * The speed limit applies only between the speed-limit lines (the pit straight, entry + ramp … exit − ramp); the entry
 * and exit roads are free.
 *
 * Autopilot (AI, and humans with the pit assist): moves the car kinematically along the lane: entry (blend from the
 * current lateral onto the lane, hold speed and brake to reach the limit at the line) → lane (limiter, drive to the
 * box, queue behind a team-mate) → stopped (held, 2.0–3.5 s seeded + repair of every damaged part; a bent suspension is
 * only straightened back to SUSPENSION_PIT_RESIDUAL) → lane → exit ramp
 * (accelerate from the line, merge at the road edge) → control handed back at pit.exit.
 * Its speed changes at bounded rates (nextSpeed: a stop or a slower point ahead is met at one constant deceleration)
 * and its path turns at a bounded yaw rate (followPath), whatever state it takes the car over in.
 *
 * Manual (humans without the pit assist, CarRaceInternal.pitManual): the driver drives the lane with full physics and
 * toggles the limiter; exceeding the limit between the lines costs PIT_SPEEDING_PENALTY in a race (a radio warning
 * otherwise). Only the box manoeuvre is automatic: where the autopilot has to start braking at BOX_TAKEOVER_DECEL for
 * the stop spot (at least BOX_SWING_START before it) it takes over (pitAuto), stops, services and drives back to the
 * lane centre, then hands back with the limiter on. A driver who stays on the track past the entry has not come in (the
 * request stays for the next lap); one who drives back onto it from the entry road cancels the visit.
 *
 * Every step leaves a consistent CarPhysicsState (pose, velocity, gear, rpm, limiter).
 */
import type { BuiltTrack, CarEntry, CarSpec, DamageState, RaceControlMode, WorldState } from '../core/types';
import { G, clamp, damp, forwardX, forwardZ, lerp, moveToward, randRange, smoothstep, wrapAngle } from '../core/math';
import { fitTyres, isBroken, rpmForSpeed, setCarHeld, speedForRpm } from '../physics/index';
import {
  forwardDistance,
  isInPitZone,
  pitLaneOffsetAt,
  pitRampLength,
  pitZoneLength,
  poseAt,
  projectToTrack,
  sampleAt,
  wrapS,
} from '../track/track';
import { PATH_EDGE_MARGIN, PIT_LINE_UP, isDry, lookaheadDistance } from '../ai/index';
import { linePath, pathSpeeds, pathTime } from '../track/speedProfile';
import { applyProjection, emit, fin, inGarage, isHuman } from './events';
import type { CarRaceInternal } from './types';
import { applyTimePenalty } from './legality';
import { radioPitExit, radioPitSpeeding } from './radio';
import { FULL_FILL, fuelTank, stopFill } from './endurance';

/** Kinematic decelerations / accelerations (m/s²). */
const ENTRY_DECEL = 24;
/** Hardest pit-entry braking (m/s²) when the car reaches the entry above the ENTRY_DECEL curve. */
const ENTRY_DECEL_MAX = 45;
const BOX_DECEL = 7;
const LANE_ACCEL = 7;
const EXIT_ACCEL = 11;
/** Lateral distance (m) of the box (working lane) from the lane centre, toward the garages. */
const BOX_LATERAL = 4;
/** Queue spot (m) behind an occupied box. */
const QUEUE_GAP = 9;
/** Lane traffic: cars closer than LANE_SHARE (m) across share a lane; a car keeps CAR_GAP (m, centre to centre: a car
 * length and a little) behind the one ahead. */
const LANE_SHARE = 2.4;
const CAR_GAP = 7;
/** Extra stationary time (s) to repair each part, in full from REPAIR_FULL damage (less for lighter damage). */
const REPAIR_TIME: Record<Exclude<keyof DamageState, 'suspension'>, number> = { frontWing: 6, rearWing: 8, floor: 10 };
const REPAIR_FULL = 0.3;
/**
 * A stop cannot fully repair a bent suspension: it is straightened back to this bend (a little grip lost, the wheel a
 * touch out of line), never further; a lighter bend is left as it is. A car whose suspension broke never gets here.
 */
export const SUSPENSION_PIT_RESIDUAL = 0.25;
/** Extra stationary time (s) to straighten a suspension from just short of breaking (less for a lighter bend). */
const SUSPENSION_REPAIR_TIME = 10;
/**
 * Manual pit: the box autopilot takes over where it has to start braking at this deceleration (m/s², a firm stop into
 * the box) to stop on the spot; a car arriving faster is braked harder from there, at one constant deceleration.
 */
const BOX_TAKEOVER_DECEL = 16;
/** Box swing: the path leaves the lane centre this far (m) before the stop spot, is in the box this far before it, and
 * is back on the lane centre this far past it. */
const BOX_SWING_START = 14;
const BOX_SWING_END = 2;
const BOX_SWING_OUT = 12;
/** Manual pit: distance (m) past the box where the car, back on the lane centre, is handed back to the driver. */
const BOX_HANDBACK = 14;
/** Kinematic path: lateral gain (1/m; the path closes on its plan within a few times 1/PATH_GAIN metres), steepest
 * slope against the track, fastest yaw rate (rad/s). */
const PATH_GAIN = 0.3;
const PATH_SLOPE = 0.5;
const PATH_YAW_RATE = 2;
/** Speed (m/s) above the pit limit that counts as speeding (≈ 2 km/h). */
const PIT_SPEED_TOLERANCE = 0.6;
/** Race time penalty (s) for speeding in the pit lane. */
export const PIT_SPEEDING_PENALTY = 5;

/** Mean stationary time (s) of a stop without repairs (startStop: 2.0–3.5 s). */
const STOP_TIME = 2.75;
/**
 * A racing car's lap against the reference speed profile (REFERENCE_CAR, soft tyres, light fuel): on race fuel and
 * medium tyres the AI (difficulty 90) laps 1.058–1.077 × referenceLapTime on 8 layouts.
 */
const RACE_PACE = 1.065;
/** Lateral rate (m/s) the AI moves across to line up for the entry (ai/traffic.ts: a plan with no car around). */
const LINE_UP_RATE = 2.2;
/** Distance (m) past the pit exit over which the car gets back up to racing speed (counted in the loss). */
const RECOVERY = 1000;
/** Pit loss (s) assumed when the track has no usable pit lane data. */
export const PIT_LOSS_FALLBACK = 22;
/**
 * Pit loss under a neutralisation, as a share of the green-flag loss. The lane costs the same, but the field covers the
 * entry → exit stretch at the neutralised pace (VSC reference 0.6 / safety car 0.7 of the reference speed, capped at
 * 50 / 60 m/s) instead of racing speed: 7–9 s of racing become 10–16 s, which leaves 0.74–0.76 of the loss on every
 * layout (VSC: the delta keeps the gaps, so that is the loss). Behind the safety car the field is also queued nose to
 * tail and a car that rejoins behind its queue catches up again at 0.85 of the reference speed, so only the places to
 * the cars that drive by during the stop are lost — measured as 0–7 s of race time against 17–28 s under green (a stop
 * requested under the SC against the same race without it, 12 cars, 4 layouts × 3 cars: mean 0.19, median 0.13 of the
 * estimate, measured at the earlier 0.58 / 52 m/s safety-car pace; 0.3 keeps a margin for the places lost in the queue).
 * In the lap the safety car comes in ('scEnding') the
 * field is released at the line while the car is still in the lane: mean 0.70, median 0.77 of the estimate (same runs).
 */
export const SC_PIT_LOSS_FACTOR = 0.3;
export const SC_ENDING_PIT_LOSS_FACTOR = 0.75;
export const VSC_PIT_LOSS_FACTOR = 0.75;

const pitLossCache = new WeakMap<BuiltTrack, number>();

/**
 * Estimated time lost by a stop under green, against racing past: lining up on the pit side over the last PIT_LINE_UP
 * before the entry, the autopilot's drive through the zone (entry road, the lane at the limit with the box stop, exit
 * road) and the stop, then getting back up to racing speed after the exit: within 0.45 s of one AI car's simulated stop
 * on 12 layouts (tools/bench/pit/loss.ts). Shared by the HUD (MFD) and the AI strategy; cached per track.
 */
export function estimatePitLoss(track: BuiltTrack): number {
  const hit = pitLossCache.get(track);
  if (hit !== undefined) return hit;
  const loss = computePitLoss(track);
  pitLossCache.set(track, loss);
  return loss;
}

function computePitLoss(track: BuiltTrack): number {
  const pit = track.pit;
  const n = track.count;
  if (!pit || !(pit.laneLength > 0) || !(pit.speedLimit > 0) || n < 2 || !(track.length > 0)) return PIT_LOSS_FALLBACK;
  const index = (s: number): number => Math.round(wrapS(track, s) / track.spacing) % n;
  const take = (a: ArrayLike<number>, from: number, count: number): Float64Array => {
    const out = new Float64Array(count);
    for (let k = 0; k < count; k++) out[k] = a[(from + k) % n];
    return out;
  };
  const prof = track.speedProfile;
  const line = linePath(track.px, track.pz, track.rx, track.rz, track.racingLine);
  // racing past, at the field's pace: `count` samples of the racing line from `from`
  const racing = (from: number, count: number): number => RACE_PACE * pathTime(take(prof, from, count), take(line.ds, from, count));

  // lining up: from the racing line, the lateral moves toward the pit-side edge (at the look-ahead) at LINE_UP_RATE; the
  // AI plans its speed for the lateral it holds
  const up = Math.round(PIT_LINE_UP / track.spacing);
  const from = (index(pit.entry) - up + n) % n;
  const offset = Float64Array.from(track.racingLine);
  let lat = track.racingLine[from];
  // (on past the entry for a few samples: the path's curvature there reads its neighbours)
  for (let k = 0; k <= up + 5; k++) {
    const i = (from + k) % n;
    const edge = Math.max(0.5, sampleAt(track, track.halfWidth, track.s[i] + lookaheadDistance(prof[i])) - PATH_EDGE_MARGIN);
    lat = moveToward(lat, pit.side * edge, (LINE_UP_RATE * track.spacing) / Math.max(1, prof[i]));
    const here = Math.max(0.5, track.halfWidth[i] - PATH_EDGE_MARGIN);
    offset[i] = clamp(lat, -here, here);
  }
  const path = linePath(track.px, track.pz, track.rx, track.rz, offset);
  const ds = take(path.ds, from, up + 1);
  const vUp = pathSpeeds(take(path.curvature, from, up + 1), ds, prof[from]);
  const approach = RACE_PACE * pathTime(vUp, ds) - racing(from, up + 1);

  // the zone (kinematic): hold the arrival speed and brake to the limit at the line, the lane at the limit with the
  // stop in the box, accelerate from the line to the exit; against racing through it
  const zone = pitZoneLength(track);
  const ramp = pitRampLength(track);
  const limit = pit.speedLimit;
  const vIn = Math.max(limit, vUp[up] / RACE_PACE);
  const brake = (vIn * vIn - limit * limit) / (2 * ENTRY_DECEL);
  const entryRoad = brake <= ramp ? (ramp - brake) / vIn + (vIn - limit) / ENTRY_DECEL : (2 * ramp) / (vIn + limit);
  const lane = (zone - 2 * ramp) / limit + limit / (2 * BOX_DECEL) + limit / (2 * LANE_ACCEL);
  const vOut = Math.sqrt(limit * limit + 2 * EXIT_ACCEL * ramp);
  const exitRoad = (vOut - limit) / EXIT_ACCEL;
  const inZone = racing(index(pit.entry), Math.round(zone / track.spacing) + 1);

  // after the exit: from vOut back up to racing speed on the line
  const back = Math.round(RECOVERY / track.spacing);
  const exit = index(pit.exit);
  const dsBack = take(line.ds, exit, back);
  const after = RACE_PACE * pathTime(pathSpeeds(take(line.curvature, exit, back), dsBack, vOut * RACE_PACE), dsBack) - racing(exit, back);

  const loss = approach + entryRoad + lane + exitRoad + STOP_TIME - inZone + after;
  return Number.isFinite(loss) ? clamp(loss, 8, 45) : PIT_LOSS_FALLBACK;
}

/** Share of the green-flag pit loss a stop costs under the current race-control mode (SC / VSC cheaper). */
export function pitLossFactor(mode: RaceControlMode): number {
  if (mode === 'sc') return SC_PIT_LOSS_FACTOR;
  if (mode === 'scEnding') return SC_ENDING_PIT_LOSS_FACTOR;
  if (mode === 'vsc') return VSC_PIT_LOSS_FACTOR;
  return 1;
}

/** Gear the auto gearbox would hold at speed v (and its rpm). */
export function gearForSpeed(spec: CarSpec, v: number): { gear: number; rpm: number } {
  const n = spec.gearRatios.length;
  let gear = n;
  for (let g = 1; g <= n; g++) {
    if (speedForRpm(spec, g, spec.shiftRpm * 0.93) >= v) {
      gear = g;
      break;
    }
  }
  const rpm = clamp(rpmForSpeed(spec, gear, Math.max(0, v)), spec.idleRpm, spec.maxRpm);
  return { gear, rpm };
}

/** The driver drives this car's pit visits (CarRaceInternal.pitManual): a human without the pit assist or the formation autopilot. */
export function drivesOwnPitVisit(car: CarEntry): boolean {
  return isHuman(car) && !car.race.formationAuto && !car.assists.pitAssist;
}

/**
 * Does a pit visit start now? An autopilot car called in when it crosses the entry; a car its driver drives (called in
 * or not) once it is on the pit road on the entry ramp, so a driver who stays out has not been in the pit lane at all.
 * Never a car with a broken suspension: it has no drive and is withdrawn where it stops (damageRules).
 */
export function shouldEngagePit(world: WorldState, track: BuiltTrack, car: CarEntry, prevS: number): boolean {
  if (car.pit.phase !== 'none' || car.status !== 'running' || world.config.kind === 'timeTrial') return false;
  if (isBroken(car.phys)) return false;
  const ph = world.session.phase;
  if (ph !== 'running' && ph !== 'chequered') return false;
  const p = car.phys;
  const ds = forwardDistance(track, prevS, p.s);
  if (ds > 50) return false;
  if (car.pit.requested && !drivesOwnPitVisit(car) && forwardDistance(track, prevS, track.pit.entry) <= ds && ds > 0) return true;
  // on the pit road on the entry ramp (asked or not: box anyway)
  if (!isInPitZone(track, p.s) || p.surface !== 'pitlane') return false;
  const d = forwardDistance(track, track.pit.entry, p.s);
  return d < pitRampLength(track) && Math.sign(p.lateral) === track.pit.side;
}

export function engagePit(world: WorldState, track: BuiltTrack, car: CarEntry): void {
  const p = car.phys;
  const r = car.race;
  car.pit.requested = true;
  car.pit.phase = 'entry';
  car.pit.timer = 0;
  if (car.status === 'running') car.status = 'pitting';
  r.pitStartLat = p.lateral;
  r.pitLat = p.lateral;
  r.pitSlope = headingSlope(track, car);
  r.pitSpeed = Math.max(0, Math.min(p.speed, 95));
  r.pitStopS = car.pit.boxS;
  r.pitStopTotal = 0;
  r.pitRepair = false;
  r.pitManual = drivesOwnPitVisit(car);
  r.pitAuto = false;
  r.pitSpeeding = false;
  p.drs.open = false;
  p.drs.available = false;
  p.drs.eligible = false;
  p.ers.overtakeAvailable = false;
  r.drsZone = -1;
  if (world.config.kind !== 'race') car.timing.lapValid = false;
  emit(world, { type: 'pitEntry', carId: car.id });
}

/** Another car occupies (or is about to occupy) this car's box: stands in it, has not pulled CAR_GAP clear of it yet,
 * or is ahead of this car on its way into it. */
function boxOccupied(world: WorldState, track: BuiltTrack, car: CarEntry, myD: number): boolean {
  const boxD = forwardDistance(track, track.pit.entry, car.pit.boxS);
  for (const o of world.cars) {
    if (o === car || o.pit.boxS !== car.pit.boxS || o.pit.phase === 'none' || o.pit.phase === 'exit') continue;
    if (o.pit.phase === 'stopped') return true;
    const od = forwardDistance(track, track.pit.entry, o.phys.s);
    if (o.race.pitStopTotal > 0) {
      if (od - boxD < CAR_GAP) return true;
      continue;
    }
    if (od > myD && o.race.pitStopS === o.pit.boxS) return true;
  }
  return false;
}

/** A car on the road there (not retired out of sight, not parked in its garage). */
const present = (world: WorldState, o: CarEntry): boolean => (o.status !== 'retired' || o.race.hazard) && !inGarage(world, o);

/**
 * The nearest car ahead in the pit zone on this car's path — closer than LANE_SHARE to where the path `plan` will be
 * at its place — as a hold CAR_GAP behind it at its speed.
 */
function carAhead(world: WorldState, track: BuiltTrack, car: CarEntry, d: number, plan: (dd: number) => number): SpeedHold | null {
  const zone = pitZoneLength(track);
  let hold: SpeedHold | null = null;
  for (const o of world.cars) {
    if (o === car || !present(world, o)) continue;
    const od = forwardDistance(track, track.pit.entry, o.phys.s);
    if (od <= d || od >= zone || Math.abs(o.phys.lateral - plan(od)) >= LANE_SHARE) continue;
    const x = od - d - CAR_GAP;
    if (!hold || x < hold.x) hold = { x, u: Math.max(0, o.phys.speed), decel: BOX_DECEL };
  }
  return hold;
}

/**
 * A car served in its box waits for the lane: a car in the fast lane (closer than LANE_SHARE to its centre) that will
 * drive past the box, alongside it (within CAR_GAP) or so close behind that it could not stay CAR_GAP behind the car
 * pulling away (at LANE_ACCEL) braking at BOX_DECEL.
 */
function laneTrafficBehind(world: WorldState, track: BuiltTrack, car: CarEntry, d: number, laneLat: (dd: number) => number): boolean {
  for (const o of world.cars) {
    if (o === car || o.pit.phase === 'none' || o.pit.phase === 'stopped' || !present(world, o)) continue;
    const od = forwardDistance(track, track.pit.entry, o.phys.s);
    const v = Math.max(0, o.phys.speed);
    if (od >= d + CAR_GAP || d - od >= CAR_GAP + (v * v) / (2 * (LANE_ACCEL + BOX_DECEL))) continue;
    if (Math.abs(o.phys.lateral - laneLat(od)) >= LANE_SHARE) continue;
    if (o.race.pitStopTotal > 0 || forwardDistance(track, track.pit.entry, o.race.pitStopS) > d) return true;
  }
  return false;
}

/** One kinematic autopilot step. Call instead of input + physics while car.pit.phase !== 'none'. */
export function stepPitLane(world: WorldState, track: BuiltTrack, car: CarEntry, dt: number): void {
  const p = car.phys;
  const r = car.race;
  const pit = car.pit;
  const tp = track.pit;
  const zone = pitZoneLength(track);
  const ramp = pitRampLength(track);
  const d = forwardDistance(track, tp.entry, p.s);
  const limit = tp.speedLimit;
  const boxD = forwardDistance(track, tp.entry, pit.boxS);
  const boxLat = tp.laneOffset + tp.side * BOX_LATERAL;
  const v = Math.max(0, r.pitSpeed);

  if (d >= zone - 0.01 || !isInPitZone(track, p.s)) {
    releaseCar(world, track, car);
    return;
  }

  // manual visit: back on the lane centre after the box → the driver takes over again
  if (r.pitManual && pit.phase === 'lane' && r.pitStopTotal > 0 && d - boxD >= BOX_HANDBACK) {
    r.pitAuto = false;
    p.limiter = true;
    return;
  }

  // the stop spot: the own box, or the queue spot behind it while a team-mate has it
  const occupied = pit.phase === 'lane' && r.pitStopTotal <= 0 && boxOccupied(world, track, car, d);
  if (pit.phase === 'lane' && r.pitStopTotal <= 0) r.pitStopS = occupied ? wrapS(track, pit.boxS - QUEUE_GAP) : pit.boxS;
  const stopD = forwardDistance(track, tp.entry, r.pitStopS);
  // lateral path, planned per distance from the entry (outside the zone, at the last exit step: the current lateral)
  const laneLat = (dd: number): number => pitLaneOffsetAt(track, wrapS(track, tp.entry + dd)) ?? r.pitLat;
  const plan = (dd: number): number => {
    if (pit.phase === 'entry') return lerp(r.pitStartLat, laneLat(dd), smoothstep(0, ramp * 0.85, dd));
    if (pit.phase === 'exit') return laneLat(dd);
    if (r.pitStopTotal <= 0) return occupied ? laneLat(dd) : lerp(laneLat(dd), boxLat, smoothstep(BOX_SWING_START, BOX_SWING_END, stopD - dd));
    return lerp(boxLat, laneLat(dd), smoothstep(0, BOX_SWING_OUT, dd - boxD));
  };
  const ahead = pit.phase === 'stopped' ? null : carAhead(world, track, car, d, plan);
  const traffic: SpeedHold[] = ahead ? [ahead] : [];

  let nv = v;
  // metres driven this step (the stop spot is not overshot)
  let step = -1;
  switch (pit.phase) {
    case 'entry': {
      // the entry road is free: hold speed (a slow car picks up to the limit), brake to reach the limit on the
      // speed-limit line (entry + ramp)
      nv = nextSpeed(v, dt, LANE_ACCEL, Math.max(v, limit), [{ x: ramp - d, u: limit, decel: ENTRY_DECEL }, ...traffic]);
      if (d >= ramp) pit.phase = 'lane';
      p.limiter = d >= ramp - 1;
      break;
    }
    case 'lane': {
      p.limiter = true;
      if (r.pitStopTotal <= 0) {
        const remain = stopD - d;
        nv = nextSpeed(v, dt, LANE_ACCEL, limit, [{ x: remain, u: 0, decel: BOX_DECEL }, ...traffic]);
        step = Math.min(nv * dt, Math.max(0, remain));
        // on the spot (within a millimetre) and braked to a crawl: it stands
        if (remain - step <= 1e-3 && nv <= 1e-3) {
          nv = 0;
          if (!occupied) startStop(world, track, car);
        }
      } else if (v < 0.5 && d - boxD < 0.5 && laneTrafficBehind(world, track, car, d, laneLat)) {
        // served: held in the box until the lane behind is clear
        nv = 0;
      } else {
        nv = nextSpeed(v, dt, LANE_ACCEL, limit, traffic);
        if (d >= zone - ramp) pit.phase = 'exit';
      }
      break;
    }
    case 'stopped': {
      nv = 0;
      pit.timer = Math.max(0, pit.timer - dt);
      if (pit.timer <= 0) serviceDone(world, track, car);
      break;
    }
    case 'exit': {
      p.limiter = false;
      nv = nextSpeed(v, dt, EXIT_ACCEL, Infinity, traffic);
      break;
    }
    default:
      break;
  }
  if (step < 0) step = nv * dt;
  const lat = step > 0 ? followPath(r, plan, d, step, Math.max(v, nv)) : r.pitLat;
  moveAlong(track, car, wrapS(track, p.s + step), lat, nv, (nv - v) / dt, dt, r.pitSlope);
}

/** A point ahead the autopilot has to pass at `u` m/s at most: `x` m on, normally braked for at `decel` m/s². */
interface SpeedHold {
  x: number;
  u: number;
  decel: number;
}

/**
 * Next autopilot speed: accelerate at `accel` up to `vmax` while every hold ahead can still be met braking at its own
 * deceleration after this step; past that point brake at the one constant deceleration that meets the most demanding
 * hold exactly as the steps move the car (at most ENTRY_DECEL_MAX), not below that hold's speed while short of it (a hold
 * reached within this step even at its speed is met at it; one already passed, a gap already closed, opens again).
 * Above `vmax` (with nothing to brake for) it slows to it at ENTRY_DECEL.
 */
function nextSpeed(v: number, dt: number, accel: number, vmax: number, holds: readonly SpeedHold[]): number {
  let brake = 0;
  let floor = 0;
  let cap = vmax;
  for (const h of holds) {
    const x = Math.max(0, h.x);
    const easy = Math.sqrt(h.u * h.u + 2 * h.decel * Math.max(0, x - v * dt));
    // braking from this step on at a, the steps cover (v² − u²) / 2a − (v − u)·dt/2 to reach u
    if (v > easy) {
      const a = (v * v - h.u * h.u) / (2 * x + (v - h.u) * dt);
      if (a > brake) {
        brake = a;
        floor = h.x >= 0 ? h.u : 0;
      }
    } else cap = Math.min(cap, easy);
  }
  if (brake > 0) return Math.max(floor, v - Math.min(brake, ENTRY_DECEL_MAX) * dt);
  if (v > cap) return Math.max(cap, v - ENTRY_DECEL * dt);
  return Math.min(cap, v + accel * dt);
}

/**
 * The kinematic path's lateral after `step` m from `d`: it closes on `plan` (lateral per distance from the entry)
 * critically damped, with the plan's own curvature fed forward; its slope stays within PATH_SLOPE and turns no faster
 * than PATH_YAW_RATE at speed `v`. Updates r.pitSlope.
 */
function followPath(r: CarRaceInternal, plan: (dd: number) => number, d: number, step: number, v: number): number {
  const h = 0.5;
  const at = plan(d);
  const behind = plan(d - h);
  const ahead = plan(d + h);
  const slope = (ahead - behind) / (2 * h);
  const curvature = (ahead - 2 * at + behind) / (h * h);
  const turn = curvature - 2 * PATH_GAIN * (r.pitSlope - slope) - PATH_GAIN * PATH_GAIN * (r.pitLat - at);
  const most = PATH_YAW_RATE / Math.max(v, 1);
  r.pitSlope = clamp(r.pitSlope + clamp(turn, -most, most) * step, -PATH_SLOPE, PATH_SLOPE);
  return r.pitLat + r.pitSlope * step;
}

/** The car's heading against the track as a path slope (lateral m per m), for the autopilot taking it over. */
function headingSlope(track: BuiltTrack, car: CarEntry): number {
  const p = car.phys;
  const along = poseAt(track, p.s, p.lateral).yaw;
  return clamp(Math.tan(wrapAngle(along - p.yaw)), -PATH_SLOPE, PATH_SLOPE);
}

/**
 * Bookkeeping of a manual pit visit after the car's physics step (call while r.pitManual && !r.pitAuto): phase from
 * the speed-limit lines, speeding penalty, missed entry, autopilot takeover for the box manoeuvre, release at pit.exit.
 */
export function stepManualPit(world: WorldState, track: BuiltTrack, car: CarEntry): void {
  const p = car.phys;
  const r = car.race;
  const pit = car.pit;
  const tp = track.pit;
  const zone = pitZoneLength(track);
  const ramp = pitRampLength(track);
  const d = forwardDistance(track, tp.entry, p.s);
  if (d >= zone - 0.01 || !isInPitZone(track, p.s)) {
    releaseManual(world, car);
    return;
  }
  const lineIn = ramp;
  const lineOut = zone - ramp;
  const pitSide = Math.sign(p.lateral) === tp.side;
  // still on the track well past the entry, or on the track side of the pit wall: the driver did not come in
  const onTrack = !pitSide || Math.abs(p.lateral) <= sampleAt(track, track.halfWidth, p.s);
  const behindWall = !pitSide || Math.abs(p.lateral) < Math.abs(tp.wallOffset);
  if ((d < lineIn && d > ramp * 0.6 && onTrack) || (d >= lineIn && d < lineOut && behindWall)) {
    cancelManual(car);
    return;
  }
  pit.phase = d < lineIn ? 'entry' : d < lineOut ? 'lane' : 'exit';
  if (pit.phase === 'exit') p.limiter = false;

  if (pit.phase === 'lane' && !r.pitSpeeding && p.speed > tp.speedLimit + PIT_SPEED_TOLERANCE) {
    r.pitSpeeding = true;
    if (world.config.kind === 'race') applyTimePenalty(world, car, PIT_SPEEDING_PENALTY, '維修道超速');
    else radioPitSpeeding(world, car);
  }

  if (pit.phase === 'lane' && pit.requested && r.pitStopTotal <= 0) {
    const boxD = forwardDistance(track, tp.entry, pit.boxS);
    const stopD = boxOccupied(world, track, car, d) ? boxD - QUEUE_GAP : boxD;
    if (stopD - d <= Math.max(BOX_SWING_START, (p.speed * p.speed) / (2 * BOX_TAKEOVER_DECEL))) {
      r.pitAuto = true;
      r.pitLat = p.lateral;
      r.pitSlope = headingSlope(track, car);
      r.pitSpeed = Math.max(0, p.speed);
    }
  }
}

/** The driver stayed on track after a pit request: no visit this lap, the request stays armed for the next one. */
function cancelManual(car: CarEntry): void {
  const p = car.phys;
  car.pit.phase = 'none';
  car.pit.timer = 0;
  if (car.status === 'pitting') car.status = 'running';
  car.race.pitManual = false;
  car.race.pitAuto = false;
  p.limiter = false;
}

/** Manual visit done at pit.exit: the car simply keeps driving (no pose / velocity change). */
function releaseManual(world: WorldState, car: CarEntry): void {
  car.pit.phase = 'none';
  car.pit.requested = false;
  car.pit.timer = 0;
  if (car.status === 'pitting') car.status = 'running';
  car.race.pitManual = false;
  car.race.pitAuto = false;
  car.phys.limiter = false;
  emit(world, { type: 'pitExit', carId: car.id });
  radioPitExit(world, car);
}

function startStop(world: WorldState, track: BuiltTrack, car: CarEntry): void {
  const r = car.race;
  const pit = car.pit;
  pit.phase = 'stopped';
  // every damaged part is repaired, a bent suspension partly
  const dmg = car.phys.damage;
  let repair = 0;
  for (const part of ['frontWing', 'rearWing', 'floor'] as const) {
    if (dmg[part] > 0) repair += REPAIR_TIME[part] * Math.min(1, dmg[part] / REPAIR_FULL);
  }
  const bend = fin(dmg.suspension) - SUSPENSION_PIT_RESIDUAL;
  if (bend > 0) repair += SUSPENSION_REPAIR_TIME * Math.min(1, bend / (1 - SUSPENSION_PIT_RESIDUAL));
  r.pitRepair = repair > 0;
  // unserved time penalties first: the car stands for them before anyone may work on it (FIA B1.9.6 b)
  const pen = car.penalties;
  const serve = world.config.kind === 'race' ? Math.max(0, fin(pen.timeSec) - fin(pen.servedSec)) : 0;
  if (serve > 0) {
    pen.servedSec = fin(pen.servedSec) + serve;
    emit(world, { type: 'penaltyServed', carId: car.id, seconds: serve });
  }
  // an endurance race refuels: the stop lasts the longer of the tyre change and the fill, which end together
  const tyres = randRange(world.rng, 2.0, 3.5);
  const fuel = stopFill(world, track, car);
  const duration = serve + Math.max(tyres, fuel) + repair;
  pit.timer = duration;
  r.pitStopTotal = duration;
  r.pitHold = serve + repair + Math.max(0, fuel - tyres);
  r.pitFuel = fuel;
  setCarHeld(car.phys, true);
}

function serviceDone(world: WorldState, track: BuiltTrack, car: CarEntry): void {
  const p = car.phys;
  const r = car.race;
  const pit = car.pit;
  const compound = pit.nextCompound;
  fitTyres(p, compound, r.pitRepair);
  let fuel = 0;
  if (r.pitFuel > 0) {
    const tank = fuelTank(car.spec, track);
    fuel = Math.min(tank - p.fuelKg, (r.pitFuel / FULL_FILL) * tank);
    p.fuelKg += fuel;
    r.pitFuel = 0;
  }
  delete pit.fuelTarget;
  // repaired parts report damage again from where they now are (reportedDamage: [frontWing, rearWing, floor,
  // suspension]; the suspension keeps its residual bend)
  if (r.pitRepair) {
    p.damage.suspension = Math.min(fin(p.damage.suspension), SUSPENSION_PIT_RESIDUAL);
    r.reportedDamage.fill(0, 0, 3);
    r.reportedDamage[3] = Math.min(r.reportedDamage[3] ?? 0, p.damage.suspension);
  }
  if (isDry(compound)) {
    if (!r.usedCompounds.includes(compound)) r.usedCompounds.push(compound);
  } else {
    r.usedWetTyre = true;
  }
  pit.stops += 1;
  pit.requested = false;
  pit.phase = 'lane';
  setCarHeld(p, false);
  if (p.gear < 1) p.gear = 1;
  car.ai.stintWear = 0;
  car.ai.stintStartProgress = car.timing.progress;
  r.radioWearWarned = false;
  r.radioDamageWarned = p.damage.frontWing > 0.3;
  emit(world, { type: 'pitStop', carId: car.id, duration: r.pitStopTotal, compound, ...(fuel > 0 ? { fuel } : {}) });
}

/**
 * Place the car on the kinematic path with a consistent physics state (pit lane, grid parking). `slope` = the path's
 * slope there (its heading against the track); by default the lateral moved over the step.
 */
export function moveAlong(track: BuiltTrack, car: CarEntry, s: number, lat: number, v: number, accel: number, dt: number, slope?: number): void {
  const p = car.phys;
  const r = car.race;
  const pose = poseAt(track, s, lat);
  const step = v * dt;
  if (slope === undefined) slope = step > 1e-3 ? clamp((lat - r.pitLat) / step, -0.5, 0.5) : 0;
  const yaw = wrapAngle(pose.yaw - Math.atan(slope));
  const prevYaw = p.yaw;
  p.x = pose.x;
  p.z = pose.z;
  p.yaw = yaw;
  p.vx = forwardX(yaw) * v;
  p.vz = forwardZ(yaw) * v;
  p.speed = v;
  p.vLong = v;
  p.vLat = 0;
  p.yawRate = dt > 0 ? clamp(wrapAngle(yaw - prevYaw) / dt, -1, 1) : 0;
  p.steerAngle = moveToward(p.steerAngle, clamp(-slope * 0.6, -0.2, 0.2), 1.6 * dt);
  p.throttle = accel > 0.5 ? 0.5 : v > 0.5 && accel > -0.5 ? 0.25 : 0;
  p.brake = accel < -0.5 ? clamp(-accel / 30, 0.1, 1) : 0;
  if (car.pit.phase !== 'stopped') {
    const g = gearForSpeed(car.spec, v);
    p.gear = v > 0.5 ? g.gear : Math.max(1, p.gear);
    p.rpm = damp(p.rpm, v > 0.5 ? g.rpm : car.spec.idleRpm, 20, dt);
  } else {
    p.rpm = damp(p.rpm, car.spec.idleRpm, 10, dt);
  }
  p.wheelSpin = (p.wheelSpin + (v / car.spec.wheelRadius) * dt) % (Math.PI * 2);
  p.slipAngleFront = 0;
  p.slipAngleRear = 0;
  p.slipRatio = 0;
  p.lockup = 0;
  p.gLong = accel / G;
  p.gLat = 0;
  p.pitch = damp(p.pitch, clamp(0.006 * p.gLong, -0.035, 0.035), 8, dt);
  p.roll = damp(p.roll, 0, 8, dt);
  p.drs.open = false;
  p.ers.overtakeActive = false;
  p.internal.accelLong = accel;
  p.internal.accelLat = 0;
  p.internal.shiftTimer = 0;
  r.pitLat = lat;
  r.pitSpeed = v;
  applyProjection(car, projectToTrack(track, p.x, p.z, p.trackIndex));
}

/** Hand the car back to its driver at the pit exit. */
function releaseCar(world: WorldState, track: BuiltTrack, car: CarEntry): void {
  const p = car.phys;
  const r = car.race;
  const v = Math.max(r.pitSpeed, track.pit.speedLimit);
  car.pit.phase = 'none';
  car.pit.requested = false;
  car.pit.timer = 0;
  if (car.status === 'pitting') car.status = 'running';
  r.pitManual = false;
  r.pitAuto = false;
  p.limiter = false;
  if (p.internal.held) setCarHeld(p, false);
  const g = gearForSpeed(car.spec, v);
  p.vx = forwardX(p.yaw) * v;
  p.vz = forwardZ(p.yaw) * v;
  p.speed = v;
  p.vLong = v;
  p.vLat = 0;
  p.yawRate = 0;
  p.gear = g.gear;
  p.rpm = g.rpm;
  p.internal.shiftTimer = 0;
  p.internal.shiftCooldown = 0;
  car.ai.offset = p.lateral - sampleAt(track, track.racingLine, p.s);
  car.ai.integral = 0;
  car.ai.stuckTimer = 0;
  emit(world, { type: 'pitExit', carId: car.id });
  radioPitExit(world, car);
}
