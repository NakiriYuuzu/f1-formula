/**
 * Powertrain: gearbox state machine (neutral / reverse / manual / auto), engine + ERS drive force, ERS mode logic,
 * battery bookkeeping. Operates on CarPhysicsState in place; no chassis dynamics here.
 */
import type { CarPhysicsState, CarSpec, ErsMode, Regulation } from '../core/types';
import { clamp, clamp01 } from '../core/math';
import { powerCurve, rpmForSpeed, totalRatio } from './spec';

export const UPSHIFT_TIME = 0.05;
export const DOWNSHIFT_TIME = 0.07;
const AUTO_SHIFT_COOLDOWN = 0.25;
/** brake held at standstill for this long (s), throttle released ⇒ reverse */
export const REVERSE_HOLD_TIME = 0.6;
/** max reverse speed (m/s) and reverse tractive acceleration (m/s²) */
export const REVERSE_MAX_SPEED = 7;
const REVERSE_ACCEL = 4;
/** fuel burnt per joule of ICE output at the crank (kg/J); calibrated to fuelPerKm ≈ 0.33 kg/km in 2025 */
export const FUEL_PER_JOULE = 4.43e-8;
/** ICE output fraction left when the tank is empty (limp mode) */
const EMPTY_TANK_POWER = 0.35;

/** Deployment as a fraction of spec.ersPower per mode. */
const ERS_DEPLOY: Record<Regulation, Record<ErsMode, number>> = {
  '2025': { none: 0, medium: 0.55, hotlap: 0.85, overtake: 1 },
  '2026': { none: 0, medium: 0.4, hotlap: 0.7, overtake: 1 },
};
/** Multiplier on the "free" on-throttle harvest per mode. */
const ERS_THROTTLE_HARVEST: Record<ErsMode, number> = { none: 1.8, medium: 1, hotlap: 0.6, overtake: 0 };
const ERS_CYCLE: readonly ErsMode[] = ['none', 'medium', 'hotlap', 'overtake'];

export function nextErsMode(mode: ErsMode): ErsMode {
  const i = ERS_CYCLE.indexOf(mode);
  return ERS_CYCLE[(i + 1) % ERS_CYCLE.length] ?? 'medium';
}

/** ERS assist: pick a mode from the state of charge with hysteresis (never selects 'overtake'). */
export function assistedErsMode(current: ErsMode, charge: number): ErsMode {
  const c = clamp01(charge);
  switch (current) {
    case 'none':
      return c > 0.4 ? 'medium' : 'none';
    case 'medium':
      if (c > 0.75) return 'hotlap';
      return c < 0.2 ? 'none' : 'medium';
    case 'hotlap':
    case 'overtake':
      if (c < 0.2) return 'none';
      return c < 0.5 ? 'medium' : 'hotlap';
  }
}

export interface GearboxInput {
  /** forward speed (m/s, signed) */
  u: number;
  throttleRaw: number;
  brakeRaw: number;
  /** throttle / brake after assists */
  throttle: number;
  brake: number;
  shiftUp: boolean;
  shiftDown: boolean;
  auto: boolean;
  dt: number;
}

function engage(car: CarPhysicsState, gear: number, shiftTime: number): void {
  car.gear = gear;
  car.internal.shiftTimer = shiftTime;
  car.internal.shiftCooldown = AUTO_SHIFT_COOLDOWN;
}

/** Highest-priority automatic shift decision for forward gears. */
function autoShift(car: CarPhysicsState, spec: CarSpec, g: GearboxInput): void {
  const maxGear = spec.gearRatios.length;
  const u = Math.max(0, g.u);
  const rpm = rpmForSpeed(spec, car.gear, u);
  if (car.gear < maxGear && u > 1 && ((rpm >= spec.shiftRpm && g.throttle > 0.05) || rpm >= spec.maxRpm - 100)) {
    engage(car, car.gear + 1, UPSHIFT_TIME);
    return;
  }
  if (car.gear <= 1) return;
  const braking = g.brake > 0.2;
  const low = braking ? 0.72 * spec.maxRpm : 0.62 * spec.maxRpm;
  const ceiling = braking ? spec.maxRpm - 600 : spec.shiftRpm - 900;
  if (rpm >= low) return;
  let target = car.gear - 1;
  while (target > 1 && rpmForSpeed(spec, target, u) < low && rpmForSpeed(spec, target - 1, u) < ceiling) target--;
  if (rpmForSpeed(spec, target, u) < ceiling) engage(car, target, DOWNSHIFT_TIME);
}

/**
 * Gear state machine. Neutral → 1st on first throttle (or shift-up). Reverse: standstill + brake held
 * REVERSE_HOLD_TIME with throttle released. Leaving R: shift-up, or (after reversing) release the throttle at
 * standstill and press it again with the brake released.
 */
export function updateGearbox(car: CarPhysicsState, spec: CarSpec, g: GearboxInput): void {
  const it = car.internal;
  it.shiftTimer = Math.max(0, it.shiftTimer - g.dt);
  it.shiftCooldown = Math.max(0, it.shiftCooldown - g.dt);
  if (it.held) {
    it.brakeHoldTime = 0;
    return;
  }
  const absU = Math.abs(g.u);

  if (car.gear === 0) {
    if (g.throttleRaw > 0.05 || g.shiftUp) car.gear = 1;
    else if (g.shiftDown && absU < 1) car.gear = -1;
    return;
  }

  if (car.gear === -1) {
    it.brakeHoldTime = 0;
    if (g.shiftUp) {
      car.gear = 1;
      it.revDriven = false;
      it.revArmed = false;
      return;
    }
    if (g.throttleRaw > 0.1) {
      if (it.revArmed && absU < 0.5 && g.brakeRaw < 0.1) {
        car.gear = 1;
        it.revDriven = false;
        it.revArmed = false;
        return;
      }
      it.revDriven = true;
      it.revArmed = false;
    } else if (g.throttleRaw < 0.05 && it.revDriven && absU < 0.5) {
      it.revArmed = true;
    }
    return;
  }

  // forward gears: reverse engagement by holding the brake at standstill
  if (absU < 1 && g.brakeRaw > 0.5 && g.throttleRaw < 0.05) {
    it.brakeHoldTime += g.dt;
    if (it.brakeHoldTime >= REVERSE_HOLD_TIME) {
      car.gear = -1;
      it.brakeHoldTime = 0;
      it.revDriven = false;
      it.revArmed = false;
      it.shiftTimer = 0;
      return;
    }
  } else {
    it.brakeHoldTime = 0;
  }

  const maxGear = spec.gearRatios.length;
  if (car.gear > maxGear) car.gear = maxGear;
  if (!g.auto) {
    if (g.shiftUp && car.gear < maxGear) engage(car, car.gear + 1, UPSHIFT_TIME);
    else if (g.shiftDown) {
      if (car.gear > 1) {
        if (rpmForSpeed(spec, car.gear - 1, g.u) <= spec.maxRpm * 1.02) engage(car, car.gear - 1, DOWNSHIFT_TIME);
      } else if (absU < 1) {
        car.gear = -1;
        it.revDriven = false;
        it.revArmed = false;
      }
    }
    return;
  }
  if (it.shiftTimer <= 0 && it.shiftCooldown <= 0) autoShift(car, spec, g);
}

export interface DriveResult {
  /** tractive force demand at the rear wheels (N, + forward) */
  force: number;
  /** engine rpm (incl. clutch slip / free revving) */
  rpm: number;
  /** ICE crank power (W) and ERS deployment (W) used */
  iceW: number;
  ersW: number;
  overtakeActive: boolean;
}

/** ERS deployment power (W) for the current mode / boost, before battery limits. */
function ersDeployPower(car: CarPhysicsState, spec: CarSpec, throttle: number, overtake: boolean): number {
  const table = ERS_DEPLOY[spec.regulation] ?? ERS_DEPLOY['2025'];
  let frac = table[car.ers.mode] ?? 0;
  if (overtake) {
    frac = spec.regulation === '2026' ? Math.min(1 + spec.overtakeBoost, frac + spec.overtakeBoost) : table.overtake;
  }
  return Math.max(0, frac) * spec.ersPower * throttle;
}

/**
 * Engine + ERS tractive force for the current gear. `performance` scales power (env.performanceScale).
 * Battery is NOT modified here (see applyErsEnergy).
 */
export function computeDrive(
  car: CarPhysicsState,
  spec: CarSpec,
  throttle: number,
  u: number,
  overtakeHeld: boolean,
  performance: number,
  mass: number,
  dt: number,
): DriveResult {
  const it = car.internal;
  const thr = clamp01(throttle);
  const revTarget = spec.idleRpm + thr * (0.82 * spec.maxRpm - spec.idleRpm);
  const free = (): DriveResult => ({
    force: 0,
    rpm: clamp(car.rpm + (revTarget - car.rpm) * Math.min(1, 12 * dt), spec.idleRpm * 0.9, spec.maxRpm),
    iceW: 0,
    ersW: 0,
    overtakeActive: false,
  });
  if (it.held || car.gear === 0) return free();
  if (car.gear === -1) {
    const fade = clamp((REVERSE_MAX_SPEED + u) / 2, 0, 1);
    const rpm = spec.idleRpm + clamp(Math.abs(u) / REVERSE_MAX_SPEED, 0, 1) * 0.45 * spec.maxRpm;
    return { force: -thr * REVERSE_ACCEL * mass * fade, rpm, iceW: thr * 40_000, ersW: 0, overtakeActive: false };
  }
  const ratio = totalRatio(spec, car.gear);
  if (ratio <= 0) return free();
  const wheelRpm = rpmForSpeed(spec, car.gear, Math.max(0, u));
  const clutchRpm = thr > 0.05 ? spec.idleRpm + (spec.launchRpm - spec.idleRpm) * Math.min(1, thr * 1.4) : spec.idleRpm;
  const rpm = clamp(Math.max(wheelRpm, clutchRpm), spec.idleRpm * 0.9, spec.maxRpm * 1.02);
  if (it.shiftTimer > 0) return { force: 0, rpm, iceW: 0, ersW: 0, overtakeActive: false };

  const limiter = clamp((spec.maxRpm - wheelRpm) / 150, 0, 1);
  const perf = clamp(Number.isFinite(performance) ? performance : 1, 0.5, 1.5);
  const fuelFactor = car.fuelKg > 0 ? 1 : EMPTY_TANK_POWER;
  const iceW = spec.icePower * powerCurve(spec, rpm) * thr * limiter * perf * fuelFactor;
  const overtake = overtakeHeld && car.ers.overtakeAvailable && car.ers.charge > 0.001 && thr > 0.1;
  let ersW = 0;
  if (u > 3 && thr > 0.1 && car.ers.charge > 0) {
    const energyLeft = car.ers.charge * spec.batteryCapacity;
    ersW = Math.min(ersDeployPower(car, spec, thr, overtake) * limiter * perf, dt > 0 ? energyLeft / dt : 0);
  }
  const omega = (rpm * 2 * Math.PI) / 60;
  const force = omega > 1 ? (((iceW + ersW) / omega) * ratio * spec.drivetrainEfficiency) / spec.wheelRadius : 0;
  return { force: Number.isFinite(force) ? force : 0, rpm, iceW, ersW, overtakeActive: overtake && ersW > 0 };
}

/** Peak engine-braking torque (N·m at the crank); kept modest so lifting mid-corner does not overload the rear tyres. */
const ENGINE_BRAKE_TORQUE = 40;

/** Engine-braking force magnitude (N) at the rear wheels when off throttle in a forward gear. */
export function engineBrakeForce(car: CarPhysicsState, spec: CarSpec, throttle: number, u: number): number {
  if (car.internal.held || car.gear < 1 || throttle > 0.05 || car.internal.shiftTimer > 0 || u <= 1) return 0;
  const ratio = totalRatio(spec, car.gear);
  const rpm = rpmForSpeed(spec, car.gear, u);
  const torque = ENGINE_BRAKE_TORQUE * (0.4 + 0.6 * clamp(rpm / spec.maxRpm, 0, 1.1));
  return (torque * ratio) / spec.wheelRadius;
}

export interface HarvestInput {
  throttle: number;
  brake: number;
  /** applied brake force (N) */
  brakeForce: number;
  u: number;
}

/** ERS harvest power (W) and the extra coasting regen drag it causes (N). */
export function harvestPower(car: CarPhysicsState, spec: CarSpec, h: HarvestInput): { watts: number; coastDrag: number } {
  if (car.gear < 1 || car.internal.held || h.u <= 3) return { watts: 0, coastDrag: 0 };
  const brakeW = h.brake > 0.05 ? Math.min(spec.ersHarvestBrake, 0.5 * h.brakeForce * h.u) : 0;
  let coastW = 0;
  if (h.throttle < 0.05 && h.brake < 0.05 && h.u > 15) coastW = 0.25 * spec.ersHarvestBrake;
  const throttleW =
    h.throttle > 0.3 && h.u > 20 ? spec.ersHarvestThrottle * ERS_THROTTLE_HARVEST[car.ers.mode] * h.throttle : 0;
  const watts = brakeW + coastW + throttleW;
  return { watts: Number.isFinite(watts) ? watts : 0, coastDrag: coastW / Math.max(h.u, 5) };
}

/** Apply deployment / harvest to the battery (charge clamped 0..1) and the per-lap counters. */
export function applyErsEnergy(car: CarPhysicsState, spec: CarSpec, deployW: number, harvestW: number, dt: number): void {
  const cap = spec.batteryCapacity > 0 ? spec.batteryCapacity : 1;
  const dep = Math.max(0, Number.isFinite(deployW) ? deployW : 0) * dt;
  const har = Math.max(0, Number.isFinite(harvestW) ? harvestW : 0) * dt;
  const charge = Number.isFinite(car.ers.charge) ? car.ers.charge : 0;
  car.ers.charge = clamp01(charge + (har - dep) / cap);
  car.ers.deployedLap = (Number.isFinite(car.ers.deployedLap) ? car.ers.deployedLap : 0) + dep;
  car.ers.harvestedLap = (Number.isFinite(car.ers.harvestedLap) ? car.ers.harvestedLap : 0) + har;
  car.internal.ersDeployW = dep / Math.max(dt, 1e-9);
  car.internal.ersHarvestW = har / Math.max(dt, 1e-9);
}
