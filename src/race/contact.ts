/**
 * Contacts: barrier containment from barrierLimits (pit wall aware, both sides of it), car-vs-car collisions for
 * nearby pairs (skipped in the pit lane, for retired cars, on different levels of a grade-separated crossing and
 * when rules.collisions is off), impact damage and the
 * rate-limited collision / damage events.
 */
import type { BuiltTrack, CarEntry, DamageState, TrackProjection, WorldState } from '../core/types';
import { angleDiff, rightX, rightZ } from '../core/math';
import { applyImpactDamage, collideCars, collideWithBarrier, isFrontalContact } from '../physics/index';
import { barrierLimits, isInPitStraight, projectToTrack, sameLevel } from '../track/track';
import { applyProjection, emit, fin } from './events';

/** Impulse (N·s) above which a collision event is emitted. */
export const COLLISION_EVENT_IMPULSE = 1200;
/** Minimum seconds between two collision events of the same car. */
const COLLISION_EVENT_COOLDOWN = 0.4;
/** Damage increase that triggers a new damage event. */
const DAMAGE_EVENT_STEP = 0.05;
const DAMAGE_PARTS: (keyof DamageState)[] = ['frontWing', 'rearWing', 'floor', 'suspension'];

export function damageMultiplier(world: WorldState): number {
  const d = world.config.rules.damage;
  return d === 'full' ? 1 : d === 'reduced' ? 0.5 : 0;
}

function reportContact(world: WorldState, car: CarEntry, other: number | null, impulse: number): void {
  const r = car.race;
  if (r.netGuess) return;
  r.impactPeak = Math.max(r.impactPeak, impulse);
  if (other !== null && impulse > COLLISION_EVENT_IMPULSE) r.carContactAt = world.time;
  if (impulse > COLLISION_EVENT_IMPULSE && r.collisionCooldown <= 0) {
    r.collisionCooldown = COLLISION_EVENT_COOLDOWN;
    emit(world, { type: 'collision', carId: car.id, otherCarId: other, impulse });
  }
  const dmg = car.phys.damage;
  for (let i = 0; i < DAMAGE_PARTS.length; i++) {
    const part = DAMAGE_PARTS[i];
    const level = fin(dmg[part]);
    if (level - (r.reportedDamage[i] ?? 0) >= DAMAGE_EVENT_STEP) {
      r.reportedDamage[i] = level;
      emit(world, { type: 'damage', carId: car.id, part, level });
    }
  }
}

/** Keep a car out of the pit wall when it is (illegally) on the lane side of it. */
function pushFromPitWall(car: CarEntry, track: BuiltTrack, proj: TrackProjection): void {
  const p = car.phys;
  const side = track.pit.side;
  const wall = Math.abs(track.pit.wallOffset);
  const rel = angleDiff(proj.heading, p.yaw);
  const extent = Math.abs(Math.sin(rel)) * car.spec.length * 0.5 + Math.abs(Math.cos(rel)) * car.spec.width * 0.5;
  const pen = wall - (Math.abs(proj.lateral) - extent);
  if (!(pen > 0)) return;
  const nx = rightX(proj.heading) * side;
  const nz = rightZ(proj.heading) * side;
  const push = Math.min(pen, 3);
  p.x += nx * push;
  p.z += nz * push;
  const vIn = -(p.vx * nx + p.vz * nz);
  if (vIn > 0) {
    p.vx += nx * vIn * 1.2;
    p.vz += nz * vIn * 1.2;
  }
}

/** Barrier contact for one car after its physics step. Returns the (possibly updated) projection. */
export function barrierContact(world: WorldState, track: BuiltTrack, car: CarEntry, proj: TrackProjection): TrackProjection {
  const p = car.phys;
  const lim = barrierLimits(track, proj.s, proj.lateral);
  const laneSide =
    isInPitStraight(track, proj.s) &&
    Math.sign(proj.lateral) === track.pit.side &&
    Math.abs(proj.lateral) > Math.abs(track.pit.wallOffset);
  if (laneSide) pushFromPitWall(car, track, proj);
  const wall = proj.lateral >= 0 ? lim.max : -lim.min;
  if (!(wall > 0) || Math.abs(proj.lateral) + car.spec.length * 0.5 < wall) {
    return laneSide ? projectToTrack(track, p.x, p.z, proj.index) : proj;
  }
  const impulse = collideWithBarrier(p, car.spec, { ...proj, wallDistance: wall }, proj.heading);
  if (impulse > 0) {
    const side = proj.lateral >= 0 ? 1 : -1;
    const rel = angleDiff(proj.heading, p.yaw);
    const frontal = side * -Math.sin(rel) > 0.35;
    applyImpactDamage(p, impulse, frontal, damageMultiplier(world) * car.spec.damageScale);
    reportContact(world, car, null, impulse);
  }
  return projectToTrack(track, p.x, p.z, proj.index);
}

const collidable = (car: CarEntry): boolean => (car.status !== 'retired' || car.race.hazard) && car.pit.phase === 'none' && !car.race.netGhost;

/** Car-vs-car contacts for all close pairs (deterministic id order). */
export function carContacts(world: WorldState, track: BuiltTrack): void {
  if (!world.config.rules.collisions) return;
  const cars = world.cars;
  const mult = damageMultiplier(world);
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    if (!collidable(a)) continue;
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j];
      if (!collidable(b)) continue;
      const dx = b.phys.x - a.phys.x;
      const dz = b.phys.z - a.phys.z;
      const reach = (a.spec.length + b.spec.length) * 0.5;
      if (dx * dx + dz * dz >= reach * reach) continue;
      if (!sameLevel(track, a.phys.s, b.phys.s)) continue;
      a.race.touchAt = world.time;
      b.race.touchAt = world.time;
      const ax = a.phys.x;
      const az = a.phys.z;
      const bx = b.phys.x;
      const bz = b.phys.z;
      const impulse = collideCars(a.phys, a.spec, b.phys, b.spec);
      if (impulse > 0) {
        applyImpactDamage(a.phys, impulse, isFrontalContact(a.phys, a.spec, bx, bz), mult * a.spec.damageScale);
        applyImpactDamage(b.phys, impulse, isFrontalContact(b.phys, b.spec, ax, az), mult * b.spec.damageScale);
        reportContact(world, a, b.id, impulse);
        reportContact(world, b, a.id, impulse);
      }
      if (a.phys.x !== ax || a.phys.z !== az) applyProjection(a, projectToTrack(track, a.phys.x, a.phys.z, a.phys.trackIndex));
      if (b.phys.x !== bx || b.phys.z !== bz) applyProjection(b, projectToTrack(track, b.phys.x, b.phys.z, b.phys.trackIndex));
    }
  }
}
