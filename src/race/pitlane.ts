/**
 * Pit lane. Engages when a car with a pit request passes pit.entry (or drives into the lane). The speed limit applies
 * only between the speed-limit lines (the pit straight, entry + ramp … exit − ramp); the entry and exit roads are free.
 *
 * Autopilot (AI, and humans with the pit assist): moves the car kinematically along the lane: entry (blend from the
 * current lateral onto the lane, hold speed and brake to reach the limit at the line) → lane (limiter, drive to the
 * box, queue behind a team-mate) → stopped (held, 2.0–3.5 s seeded + repair of every damaged part) → lane → exit ramp
 * (accelerate from the line, merge at the road edge) → control handed back at pit.exit.
 *
 * Manual (humans without the pit assist, CarRaceInternal.pitManual): the driver drives the lane with full physics and
 * toggles the limiter; exceeding the limit between the lines costs PIT_SPEEDING_PENALTY in a race (a radio warning
 * otherwise). Only the box manoeuvre is automatic: from BOX_APPROACH before the stop spot the autopilot takes over
 * (pitAuto), stops, services and drives back to the lane centre, then hands back with the limiter on. Not steering
 * into the lane after the entry cancels the visit (the request stays for the next lap).
 *
 * Every step leaves a consistent CarPhysicsState (pose, velocity, gear, rpm, limiter).
 */
import type { BuiltTrack, CarEntry, CarSpec, DamageState, RaceControlMode, WorldState } from '../core/types';
import { G, clamp, damp, forwardX, forwardZ, lerp, moveToward, randRange, smoothstep, wrapAngle } from '../core/math';
import { fitTyres, rpmForSpeed, setCarHeld, speedForRpm } from '../physics/index';
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
import { isDry } from '../ai/index';
import { applyProjection, emit, fin, isHuman } from './events';
import { applyTimePenalty } from './legality';
import { radioPitExit, radioPitSpeeding } from './radio';

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
/** Extra stationary time (s) to repair each part, in full from REPAIR_FULL damage (less for lighter damage). */
const REPAIR_TIME: Record<keyof DamageState, number> = { frontWing: 6, rearWing: 8, floor: 10 };
const REPAIR_FULL = 0.3;
/** Manual pit: distance (m) before the stop spot where the autopilot takes over the box manoeuvre. */
const BOX_APPROACH = 30;
/** Manual pit: distance (m) past the box where the car, back on the lane centre, is handed back to the driver. */
const BOX_HANDBACK = 14;
/** Speed (m/s) above the pit limit that counts as speeding (≈ 2 km/h). */
const PIT_SPEED_TOLERANCE = 0.6;
/** Race time penalty (s) for speeding in the pit lane. */
export const PIT_SPEEDING_PENALTY = 5;

/**
 * Average stationary time (SPEC: 2–3.5 s) and the extra loss around the box and outside the zone (lining up for the
 * entry, accelerating back to racing speed after the exit) — fitted to simulated stops (±1.1 s on 7 layouts).
 */
const STOP_TIME = 2.8;
const BOX_MANOEUVRE = 3.5;
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
 * Estimated time lost by a stop under green: entry road (racing speed down to the limit at the line) + lane between the
 * lines at the limit + exit road (accelerating from the line) + stop − racing time over the same stretch. Shared by the
 * HUD (MFD) and the AI strategy; cached per track.
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
  const len = track.length;
  if (!pit || !(pit.laneLength > 0) || !(pit.speedLimit > 0) || track.count < 2 || !(len > 0)) return PIT_LOSS_FALLBACK;
  const wrap = (s: number): number => ((s % len) + len) % len;
  const entry = wrap(pit.entry);
  const exit = wrap(pit.exit);
  let racing = 0;
  for (let i = 0; i < track.count; i++) {
    const s = track.s[i];
    const inside = entry <= exit ? s >= entry && s < exit : s >= entry || s < exit;
    if (!inside) continue;
    const next = i + 1 < track.count ? track.s[i + 1] : len;
    const ds = next - s;
    if (!(ds > 0) || !Number.isFinite(ds)) continue;
    racing += ds / Math.max(10, fin(track.speedProfile[i], 60));
  }
  const limit = pit.speedLimit;
  const ramp = Math.min(pitRampLength(track), pit.laneLength / 2);
  const vIn = Math.max(limit, fin(sampleAt(track, track.speedProfile, entry), limit));
  const vOut = Math.max(limit, Math.min(fin(sampleAt(track, track.speedProfile, exit), limit), Math.sqrt(limit * limit + 2 * EXIT_ACCEL * ramp)));
  const roads = ramp / (0.5 * (vIn + limit)) + ramp / (0.5 * (limit + vOut));
  const loss = (pit.laneLength - 2 * ramp) / limit + roads + STOP_TIME + BOX_MANOEUVRE - racing;
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

/** Should a car (without autopilot) be put on the autopilot now? Requested + crossed the entry, or drove into the lane. */
export function shouldEngagePit(world: WorldState, track: BuiltTrack, car: CarEntry, prevS: number): boolean {
  if (car.pit.phase !== 'none' || car.status !== 'running' || world.config.kind === 'timeTrial') return false;
  const ph = world.session.phase;
  if (ph !== 'running' && ph !== 'chequered') return false;
  const p = car.phys;
  const ds = forwardDistance(track, prevS, p.s);
  if (ds > 50) return false;
  if (car.pit.requested && forwardDistance(track, prevS, track.pit.entry) <= ds && ds > 0) return true;
  // drove into the lane band on the entry ramp without asking: box anyway
  if (!isInPitZone(track, p.s) || p.surface !== 'pitlane') return false;
  const d = forwardDistance(track, track.pit.entry, p.s);
  return d < pitRampLength(track) && Math.sign(p.lateral) === track.pit.side;
}

export function engagePit(world: WorldState, car: CarEntry): void {
  const p = car.phys;
  const r = car.race;
  car.pit.requested = true;
  car.pit.phase = 'entry';
  car.pit.timer = 0;
  if (car.status === 'running') car.status = 'pitting';
  r.pitStartLat = p.lateral;
  r.pitLat = p.lateral;
  r.pitSpeed = Math.max(0, Math.min(p.speed, 95));
  r.pitStopS = car.pit.boxS;
  r.pitStopTotal = 0;
  r.pitRepair = false;
  r.pitManual = isHuman(car) && !r.formationAuto && !car.assists.pitAssist;
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

/** Another car occupies (or is about to occupy) this car's box. */
function boxOccupied(world: WorldState, track: BuiltTrack, car: CarEntry, myD: number): boolean {
  for (const o of world.cars) {
    if (o === car || o.pit.boxS !== car.pit.boxS || o.pit.phase === 'none' || o.pit.phase === 'exit') continue;
    if (o.pit.phase === 'stopped') return true;
    if (o.race.pitStopTotal > 0) continue; // already served, leaving the box
    const od = forwardDistance(track, track.pit.entry, o.phys.s);
    if (od > myD && o.race.pitStopS === o.pit.boxS) return true;
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
  // outside the zone (last exit step) keep the current lateral rather than jumping back to the lane centre
  const laneLat = (s: number): number => pitLaneOffsetAt(track, s) ?? r.pitLat;
  const boxLat = tp.laneOffset + tp.side * BOX_LATERAL;
  let v = Math.max(0, r.pitSpeed);
  let accel = 0;

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

  switch (pit.phase) {
    case 'entry': {
      // the entry road is free: hold speed, brake (ENTRY_DECEL, harder if it arrives above that curve) to reach the
      // limit on the speed-limit line (entry + ramp)
      const toLine = Math.max(0, ramp - d - v * dt);
      const brakeTarget = Math.sqrt(limit * limit + 2 * ENTRY_DECEL * toLine);
      const nv = Math.max(limit, Math.min(v, Math.max(brakeTarget, v - ENTRY_DECEL_MAX * dt)));
      accel = (nv - v) / dt;
      v = nv;
      if (d >= ramp) pit.phase = 'lane';
      p.limiter = d >= ramp - 1;
      break;
    }
    case 'lane': {
      p.limiter = true;
      if (r.pitStopTotal <= 0) {
        const occupied = boxOccupied(world, track, car, d);
        const stopD = occupied ? boxD - QUEUE_GAP : boxD;
        r.pitStopS = occupied ? wrapS(track, pit.boxS - QUEUE_GAP) : pit.boxS;
        const remain = stopD - d;
        const target = remain > 0 ? Math.min(limit, Math.sqrt(2 * BOX_DECEL * remain)) : 0;
        const nv = target > v ? Math.min(target, v + LANE_ACCEL * dt) : target;
        accel = (nv - v) / dt;
        v = nv;
        if (remain <= 0.05 && !occupied) {
          v = 0;
          startStop(world, car);
        }
      } else {
        const nv = Math.min(limit, v + LANE_ACCEL * dt);
        accel = (nv - v) / dt;
        v = nv;
        if (d >= zone - ramp) pit.phase = 'exit';
      }
      break;
    }
    case 'stopped': {
      v = 0;
      pit.timer = Math.max(0, pit.timer - dt);
      if (pit.timer <= 0) serviceDone(world, car);
      break;
    }
    case 'exit': {
      p.limiter = false;
      const nv = v + EXIT_ACCEL * dt;
      accel = (nv - v) / dt;
      v = nv;
      break;
    }
    default:
      break;
  }

  // lateral path
  const sNext = wrapS(track, p.s + v * dt);
  const dNext = Math.min(zone, d + v * dt);
  let lat: number;
  if (pit.phase === 'entry') {
    lat = lerp(r.pitStartLat, laneLat(sNext), smoothstep(0, ramp * 0.85, dNext));
  } else if (pit.phase === 'exit') {
    lat = laneLat(sNext);
  } else if (r.pitStopTotal <= 0) {
    const stopD = forwardDistance(track, tp.entry, r.pitStopS);
    const toBox = r.pitStopS === pit.boxS ? stopD - dNext : Infinity;
    lat = lerp(laneLat(sNext), boxLat, smoothstep(14, 2, toBox));
  } else {
    lat = lerp(boxLat, laneLat(sNext), smoothstep(0, 12, dNext - boxD));
  }
  if (pit.phase === 'stopped') lat = r.pitLat;
  else lat = moveToward(r.pitLat, lat, (1 + 0.35 * v) * dt);
  moveAlong(track, car, sNext, lat, v, accel, dt);
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
    if (stopD - d <= BOX_APPROACH) {
      r.pitAuto = true;
      r.pitLat = p.lateral;
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

function startStop(world: WorldState, car: CarEntry): void {
  const r = car.race;
  const pit = car.pit;
  pit.phase = 'stopped';
  // every damaged part is repaired
  const dmg = car.phys.damage;
  let repair = 0;
  for (const part of ['frontWing', 'rearWing', 'floor'] as const) {
    if (dmg[part] > 0) repair += REPAIR_TIME[part] * Math.min(1, dmg[part] / REPAIR_FULL);
  }
  r.pitRepair = repair > 0;
  const duration = randRange(world.rng, 2.0, 3.5) + repair;
  pit.timer = duration;
  r.pitStopTotal = duration;
  setCarHeld(car.phys, true);
}

function serviceDone(world: WorldState, car: CarEntry): void {
  const p = car.phys;
  const r = car.race;
  const pit = car.pit;
  const compound = pit.nextCompound;
  fitTyres(p, compound, r.pitRepair);
  // repaired parts report damage again from zero (reportedDamage: [frontWing, rearWing, floor])
  if (r.pitRepair) r.reportedDamage.fill(0);
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
  emit(world, { type: 'pitStop', carId: car.id, duration: r.pitStopTotal, compound });
}

/** Place the car on the kinematic path with a consistent physics state (pit lane, grid parking). */
export function moveAlong(track: BuiltTrack, car: CarEntry, s: number, lat: number, v: number, accel: number, dt: number): void {
  const p = car.phys;
  const r = car.race;
  const pose = poseAt(track, s, lat);
  const step = v * dt;
  const slope = step > 1e-3 ? clamp((lat - r.pitLat) / step, -0.5, 0.5) : 0;
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
