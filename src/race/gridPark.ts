/**
 * Grid slots and the race-control moves that use them: formation-lap auto-parking (kinematic, like the pit-lane
 * autopilot) and the red-flag regroup that lines the field up on the grid for a standing restart.
 */
import type { BuiltTrack, CarEntry, TireCompound, WorldState } from '../core/types';
import { clamp, lerp, smoothstep } from '../core/math';
import { fitTyres, setCarHeld } from '../physics/index';
import { forwardDistance, indexAtS, poseAt, projectToTrack, wrapS } from '../track/track';
import { chooseDryCompound, weatherCompound } from '../ai/index';
import { applyProjection } from './events';
import { moveAlong } from './pitlane';

/** Distance (m) of pole position behind the line, gap (m) between grid slots, lateral offset (m) of the columns. */
export const GRID_FRONT = 8;
export const GRID_GAP = 8;
export const GRID_LATERAL = 2.4;
/** Formation lap: a car is taken over for parking this far (m) before its slot. */
export const PARK_RANGE = 350;
/** Parking motion: deceleration / acceleration (m/s²) and speed cap (m/s). */
const PARK_DECEL = 4.5;
const PARK_ACCEL = 3;
const PARK_MAX_SPEED = 36;

/** Grid slot of starting index `index` (0 = pole, on the side away from the pit lane). */
export function gridSlot(track: BuiltTrack, index: number): { s: number; lateral: number } {
  return {
    s: wrapS(track, track.length - (GRID_FRONT + GRID_GAP * index)),
    lateral: (index % 2 === 0 ? -track.pit.side : track.pit.side) * GRID_LATERAL,
  };
}

/** Formation lap: the car has driven most of the lap and is within PARK_RANGE of its own slot. */
export function wantsToPark(track: BuiltTrack, car: CarEntry): boolean {
  const r = car.race;
  if (r.parking || r.parked || r.formationDist < track.length - PARK_RANGE - 250) return false;
  return forwardDistance(track, car.phys.s, r.gridS) <= PARK_RANGE;
}

export function startParking(track: BuiltTrack, car: CarEntry): void {
  const r = car.race;
  const p = car.phys;
  r.parking = true;
  r.parkStartD = Math.max(1, forwardDistance(track, p.s, r.gridS));
  r.parkStartLat = p.lateral;
  r.pitLat = p.lateral;
  r.pitSpeed = clamp(p.speed, 0, PARK_MAX_SPEED);
  p.limiter = false;
}

/** One kinematic parking step: slow down along the track and slide into the slot. */
export function stepParking(track: BuiltTrack, car: CarEntry, dt: number): void {
  const p = car.phys;
  const r = car.race;
  let d = forwardDistance(track, p.s, r.gridS);
  if (d > track.length / 2) d = 0;
  const vMax = Math.sqrt(2 * PARK_DECEL * Math.max(0, d - 0.1));
  const v = Math.max(0, Math.min(r.pitSpeed + PARK_ACCEL * dt, vMax, PARK_MAX_SPEED));
  const step = Math.min(v * dt, d);
  if (d - step <= 0.05 || (v < 0.05 && d < 0.6)) {
    parkOnSlot(track, car);
    return;
  }
  const frac = clamp(1 - (d - step) / r.parkStartD, 0, 1);
  const lat = lerp(r.parkStartLat, r.gridLat, smoothstep(0, 0.8, frac));
  const accel = dt > 0 ? (v - r.pitSpeed) / dt : 0;
  moveAlong(track, car, wrapS(track, p.s + step), lat, v, accel, dt);
}

/** Put the car exactly on its slot, in neutral and held. */
export function parkOnSlot(track: BuiltTrack, car: CarEntry): void {
  const p = car.phys;
  const r = car.race;
  const pose = poseAt(track, r.gridS, r.gridLat);
  p.x = pose.x;
  p.y = pose.y;
  p.z = pose.z;
  p.yaw = pose.yaw;
  setCarHeld(p, true);
  p.gear = 0;
  p.rpm = car.spec.idleRpm;
  p.steerAngle = 0;
  p.throttle = 0;
  p.brake = 0;
  p.pitch = 0;
  p.roll = 0;
  r.parking = false;
  r.parked = true;
  r.pitSpeed = 0;
  r.pitLat = r.gridLat;
  applyProjection(car, projectToTrack(track, p.x, p.z, indexAtS(track, r.gridS), pose.y));
}

function restartCompound(world: WorldState, track: BuiltTrack, car: CarEntry): TireCompound {
  if (car.playerIndex !== -1) return car.pit.nextCompound;
  const wet = weatherCompound(car.phys.tire.compound, world.weather.wetness);
  if (wet === 'inter' || wet === 'wet') return wet;
  const lapsLeft = Math.max(1, world.session.totalLaps - car.timing.lapsCompleted);
  return chooseDryCompound(car, track, lapsLeft);
}

/**
 * Red flag: line every running car up on the grid in classification order (laps kept), repair damage, fit fresh
 * tyres and hold them for a standing restart. Progress is re-based so the next line crossing starts a new lap.
 */
export function regroupOnGrid(world: WorldState, track: BuiltTrack): void {
  const L = track.length;
  const cars = world.cars;
  const sp = world.race.cpSpacing;
  let index = 0;
  for (const id of world.race.order) {
    const car = cars[id];
    if (!car || car.status === 'retired' || car.status === 'finished') continue;
    const p = car.phys;
    const r = car.race;
    const slot = gridSlot(track, index++);
    car.pit.phase = 'none';
    car.pit.requested = false;
    car.pit.timer = 0;
    car.status = 'grid';
    p.limiter = false;
    r.gridS = slot.s;
    r.gridLat = slot.lateral;
    r.parking = false;
    r.parked = true;
    p.damage.frontWing = 0;
    p.damage.rearWing = 0;
    p.damage.floor = 0;
    fitTyres(p, restartCompound(world, track, car), true);
    parkOnSlot(track, car);
    const t = car.timing;
    t.progress = t.lapsCompleted * L + (slot.s - L);
    // a fresh set: its wear rate is measured from here (as after a pit stop)
    car.ai.stintWear = p.tire.wear;
    car.ai.stintStartProgress = t.progress;
    r.lastS = slot.s;
    r.ctlS = slot.s;
    r.cpTimes.fill(-1e9);
    r.cpAbs.fill(-1e9);
    r.cpLast = sp > 0 ? Math.floor(t.progress / sp) : 0;
    r.stopTime = 0;
    car.flags.delta = null;
    car.flags.giveBack = null;
    car.flags.queuing = false;
    car.ai.mode = 'race';
    car.ai.offset = 0;
    car.ai.integral = 0;
  }
}
