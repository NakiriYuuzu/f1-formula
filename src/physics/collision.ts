/**
 * Collisions and damage: barrier containment against the track projection, car-vs-car (two circles per car,
 * positional separation + rigid-body impulse with yaw), impact damage to wings / floor.
 */
import type { CarPhysicsState, CarSpec, TrackProjection } from '../core/types';
import { angleDiff, clamp, clamp01, forwardX, forwardZ, rightX, rightZ, worldToLocal, wrapAngle } from '../core/math';
import { NOMINAL_FUEL_KG } from './spec';

const BARRIER_RESTITUTION = 0.2;
const BARRIER_FRICTION = 0.35;
const CAR_RESTITUTION = 0.3;
/** impulse (N·s) below which contact causes no damage */
const DAMAGE_THRESHOLD = 2500;
/** impulse (N·s) above the threshold that destroys a part at multiplier 1 */
const DAMAGE_SCALE = 16_000;
/**
 * Suspension / structure: only heavy hits bend it. Wheel-to-wheel racing contact stays below ~4000 N·s (AI races),
 * a wall hit at a shallow angle is 11–15k (bent), steering into a wall at racing speed 27–37k. At multiplier 1 one
 * hit of SUSPENSION_THRESHOLD + SUSPENSION_SCALE (18k, ≈ 80 km/h straight into the wall) breaks it; at 0.5
 * ('reduced') it takes 31k (the team's damageScale, from its reliability, scales both).
 */
const SUSPENSION_THRESHOLD = 5000;
const SUSPENSION_SCALE = 13_000;

const num = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

function carMass(car: CarPhysicsState, spec: CarSpec): number {
  return Math.max(1, spec.mass + Math.max(0, num(car.fuelKg)));
}

function carInertia(car: CarPhysicsState, spec: CarSpec, mass: number): number {
  return Math.max(1, spec.yawInertia * (mass / (spec.mass + NOMINAL_FUEL_KG)));
}

/** Refresh speed / body-frame velocity after a velocity change outside the step. */
function refreshDerived(car: CarPhysicsState): void {
  car.speed = Math.hypot(car.vx, car.vz);
  const loc = worldToLocal(car.yaw, car.vx, car.vz);
  car.vLong = loc.forward;
  car.vLat = loc.right;
}

/**
 * Keep the car inside the barriers given a fresh projection. If the car body crosses `proj.wallDistance`,
 * push it back, remove/reflect the normal velocity, scrub speed and return the impulse (N·s); else 0.
 */
export function collideWithBarrier(car: CarPhysicsState, spec: CarSpec, proj: TrackProjection, trackHeading: number): number {
  const lateral = num(proj.lateral);
  const wall = num(proj.wallDistance, Infinity);
  const heading = num(trackHeading, num(proj.heading));
  if (!Number.isFinite(wall) || wall <= 0) return 0;
  const side = lateral >= 0 ? 1 : -1;
  const rel = angleDiff(heading, num(car.yaw));
  const extent = Math.abs(Math.sin(rel)) * spec.length * 0.5 + Math.abs(Math.cos(rel)) * spec.width * 0.5;
  const penetration = Math.abs(lateral) + extent - wall;
  if (!(penetration > 0)) return 0;

  // push back along the track right vector, towards the centre line
  const nx = rightX(heading) * side;
  const nz = rightZ(heading) * side;
  const push = Math.min(penetration, 5);
  car.x -= nx * push;
  car.z -= nz * push;

  const vn = car.vx * nx + car.vz * nz; // > 0 = moving into the wall
  if (vn <= 0) {
    refreshDerived(car);
    return 0;
  }
  const m = carMass(car, spec);
  const dvn = (1 + BARRIER_RESTITUTION) * vn;
  car.vx -= dvn * nx;
  car.vz -= dvn * nz;
  // tangential scrub (Coulomb, never reversing the sliding direction)
  const tx = -nz;
  const tz = nx;
  const vt = car.vx * tx + car.vz * tz;
  const scrub = Math.min(Math.abs(vt), BARRIER_FRICTION * dvn);
  const dvt = Math.sign(vt) * scrub;
  car.vx -= dvt * tx;
  car.vz -= dvt * tz;
  // yaw: damp spin and nudge the nose parallel to the wall
  car.yawRate = num(car.yawRate) * 0.6;
  const align = angleDiff(car.yaw, Math.abs(rel) < Math.PI / 2 ? heading : wrapAngle(heading + Math.PI));
  car.yaw = wrapAngle(car.yaw + clamp(align * 0.15, -0.08, 0.08));
  refreshDerived(car);
  const impulse = m * Math.hypot(dvn, scrub);
  car.impact = Math.max(num(car.impact), impulse);
  return Number.isFinite(impulse) ? impulse : 0;
}

interface Circle {
  x: number;
  z: number;
  /** offset from the car centre (world) */
  ox: number;
  oz: number;
}

function carCircles(car: CarPhysicsState, spec: CarSpec): [Circle, Circle] {
  const off = Math.max(0, spec.length * 0.5 - spec.width * 0.5);
  const fx = forwardX(car.yaw) * off;
  const fz = forwardZ(car.yaw) * off;
  return [
    { x: car.x + fx, z: car.z + fz, ox: fx, oz: fz },
    { x: car.x - fx, z: car.z - fz, ox: -fx, oz: -fz },
  ];
}

/** Velocity of a body point at world offset (ox, oz): v + yawRate × r (yaw convention of core/math). */
function pointVelocity(car: CarPhysicsState, ox: number, oz: number): { x: number; z: number } {
  return { x: car.vx + car.yawRate * oz, z: car.vz - car.yawRate * ox };
}

/** Resolve overlap between two cars (two circles each). Returns impulse (N·s), 0 if none; on an impulse the contact
 * point (world) is written into `contact` when given. */
export function collideCars(a: CarPhysicsState, specA: CarSpec, b: CarPhysicsState, specB: CarSpec, contact?: { x: number; z: number }): number {
  const ra = specA.width * 0.5;
  const rb = specB.width * 0.5;
  const reach = specA.length * 0.5 + specB.length * 0.5;
  const dcx = b.x - a.x;
  const dcz = b.z - a.z;
  if (!(dcx * dcx + dcz * dcz < reach * reach)) return 0;

  const ca = carCircles(a, specA);
  const cb = carCircles(b, specB);
  let best: { pa: Circle; pb: Circle; depth: number; dx: number; dz: number; d: number } | null = null;
  for (const pa of ca) {
    for (const pb of cb) {
      const dx = pa.x - pb.x;
      const dz = pa.z - pb.z;
      const d = Math.hypot(dx, dz);
      const depth = ra + rb - d;
      if (depth > 0 && (!best || depth > best.depth)) best = { pa, pb, depth, dx, dz, d };
    }
  }
  if (!best) return 0;

  // contact normal from b to a
  let nx: number;
  let nz: number;
  if (best.d > 1e-6) {
    nx = best.dx / best.d;
    nz = best.dz / best.d;
  } else {
    const cd = Math.hypot(dcx, dcz);
    nx = cd > 1e-6 ? -dcx / cd : rightX(a.yaw);
    nz = cd > 1e-6 ? -dcz / cd : rightZ(a.yaw);
  }
  const ma = carMass(a, specA);
  const mb = carMass(b, specB);
  const ia = carInertia(a, specA, ma);
  const ib = carInertia(b, specB, mb);
  const depth = Math.min(best.depth, 3);
  const wa = mb / (ma + mb);
  const wb = ma / (ma + mb);
  a.x += nx * depth * wa;
  a.z += nz * depth * wa;
  b.x -= nx * depth * wb;
  b.z -= nz * depth * wb;

  // contact point offsets (midpoint between circle surfaces)
  const cpx = (best.pa.x - nx * ra + best.pb.x + nx * rb) * 0.5;
  const cpz = (best.pa.z - nz * ra + best.pb.z + nz * rb) * 0.5;
  const oax = cpx - a.x;
  const oaz = cpz - a.z;
  const obx = cpx - b.x;
  const obz = cpz - b.z;
  const va = pointVelocity(a, oax, oaz);
  const vb = pointVelocity(b, obx, obz);
  const vrel = (va.x - vb.x) * nx + (va.z - vb.z) * nz;
  if (vrel >= 0) {
    refreshDerived(a);
    refreshDerived(b);
    return 0;
  }
  // cross(r, n) in the yaw convention: Δ yawRate = (rz·Jx − rx·Jz) / I
  const crossA = oaz * nx - oax * nz;
  const crossB = obz * nx - obx * nz;
  const denom = 1 / ma + 1 / mb + (crossA * crossA) / ia + (crossB * crossB) / ib;
  const j = (-(1 + CAR_RESTITUTION) * vrel) / denom;
  if (!Number.isFinite(j) || j <= 0) return 0;
  a.vx += (j * nx) / ma;
  a.vz += (j * nz) / ma;
  b.vx -= (j * nx) / mb;
  b.vz -= (j * nz) / mb;
  a.yawRate = clamp(num(a.yawRate) + (j * crossA) / ia, -6, 6);
  b.yawRate = clamp(num(b.yawRate) - (j * crossB) / ib, -6, 6);
  refreshDerived(a);
  refreshDerived(b);
  a.impact = Math.max(num(a.impact), j);
  b.impact = Math.max(num(b.impact), j);
  if (contact) {
    contact.x = cpx;
    contact.z = cpz;
  }
  return j;
}

/** Was the contact on the car's nose? (helper for the runtime: pass as `frontal` to applyImpactDamage) */
export function isFrontalContact(car: CarPhysicsState, spec: CarSpec, px: number, pz: number): boolean {
  const loc = worldToLocal(car.yaw, px - car.x, pz - car.z);
  return loc.forward > spec.length * 0.3;
}

/** Corner of the car (0 FL, 1 FR, 2 RL, 3 RR) facing a contact at world point (px, pz): pass as `corner` to
 * applyImpactDamage. */
export function contactCorner(car: CarPhysicsState, px: number, pz: number): number {
  const loc = worldToLocal(car.yaw, num(px) - car.x, num(pz) - car.z);
  return (loc.forward >= 0 ? 0 : 2) + (loc.right > 0 ? 1 : 0);
}

/**
 * Apply collision damage from an impulse. `frontal` = impact on the nose (front wing), `corner` = the corner hit
 * (contactCorner), multiplier = env.damageMultiplier. The damage shows at the corner (damageCorner) of the hit that
 * did more than all earlier hits together: once the suspension is bent, by its bend (kept once it broke); before
 * that, by the wing / floor damage.
 */
export function applyImpactDamage(car: CarPhysicsState, impulse: number, frontal: boolean, multiplier: number, corner: number): void {
  const mult = clamp(num(multiplier), 0, 2);
  const imp = num(impulse);
  if (mult <= 0 || imp <= DAMAGE_THRESHOLD) return;
  const amount = ((imp - DAMAGE_THRESHOLD) / DAMAGE_SCALE) * mult;
  const d = car.damage;
  const bentBefore = clamp01(num(d.suspension));
  const partsBefore = num(d.frontWing) + num(d.rearWing) + num(d.floor);
  const bend = imp > SUSPENSION_THRESHOLD ? ((imp - SUSPENSION_THRESHOLD) / SUSPENSION_SCALE) * mult : 0;
  if (bend > 0) d.suspension = clamp01(bentBefore + bend);
  if (frontal) {
    d.frontWing = clamp01(num(d.frontWing) + amount);
    d.floor = clamp01(num(d.floor) + amount * 0.2);
  } else {
    d.floor = clamp01(num(d.floor) + amount * 0.45);
    d.rearWing = clamp01(num(d.rearWing) + amount * 0.35);
  }
  const partsAdded = d.frontWing + d.rearWing + d.floor - partsBefore;
  const moves = bentBefore > 0 ? bentBefore < 1 && bend > bentBefore : bend > 0 || partsAdded > partsBefore;
  if (moves) car.damageCorner = clamp(Math.floor(num(corner)), 0, 3);
}
