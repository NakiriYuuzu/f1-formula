/**
 * Pit-lane autopilot (all cars). Engages when a car with a pit request passes pit.entry (or drives into the lane);
 * then moves the car kinematically along the lane: entry (blend from the current lateral onto the lane, brake to
 * the 80 km/h limit) → lane (limiter, drive to the box, queue behind a team-mate) → stopped (held, 2.0–3.5 s seeded
 * + repair of every damaged part) → lane → exit ramp (accelerate, merge at the road edge) → control handed back at pit.exit.
 * Every step leaves a consistent CarPhysicsState (pose, velocity, gear, rpm, limiter).
 */
import type { BuiltTrack, CarEntry, CarSpec, DamageState, WorldState } from '../core/types';
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
import { applyProjection, emit } from './events';
import { radioPitExit } from './radio';

/** Kinematic decelerations / accelerations (m/s²). */
const ENTRY_DECEL = 24;
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

  switch (pit.phase) {
    case 'entry': {
      const nv = Math.max(limit, v - ENTRY_DECEL * dt);
      accel = (nv - v) / dt;
      v = nv;
      if (d >= ramp) pit.phase = 'lane';
      p.limiter = d >= ramp * 0.5;
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
  car.ai.stintStartLap = car.timing.lapsCompleted;
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
