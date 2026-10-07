/**
 * Car specification: builds CarSpec from team ratings + setup + regulation, plus static capability helpers
 * (steering map, power curve, lateral/braking limits) shared by the physics step and the AI.
 */
import type { CarSetup, CarSpec, Regulation, TeamDef } from '../core/types';
import { AIR_DENSITY, G, clamp, clamp01 } from '../core/math';
import { DEFAULT_SETUP } from '../core/defaults';

/** Max rate the wheel angle can change (rad/s). AI: the applied angle moves toward the target by STEER_RATE·dt per step. */
export const STEER_RATE = 1.6;
/** Speed (m/s) at which the steering lock is halved (no steering assist). */
export const STEER_SPEED_REF = 30;
/** Steering assist: speed at which lock is halved (stronger reduction). */
export const STEER_SPEED_REF_ASSIST = 24;
/** Nominal fuel load (kg) used for capability estimates. */
export const NOMINAL_FUEL_KG = 50;
/** Racing-pace fuel use of a 640 kW 2025 power unit (kg/km); scales with ICE power. */
export const FUEL_KG_PER_KM_REF = 0.33;
/**
 * Rear-axle grip margin over the front (per unit load). Keeps the limit balance understeery even when lifting off
 * shifts load forward, so overdriving a corner pushes wide instead of snapping into a spin.
 */
export const REAR_GRIP_MARGIN = 1.12;
/** Max front slip angle (rad) the steering can command beyond the zero-slip direction (tyre peak ≈ 0.09 rad). */
export const FRONT_SLIP_STEER_CAP = 0.12;
/** Speed (m/s) above which the front-slip steering cap applies (low-speed manoeuvres keep full lock). */
export const FRONT_SLIP_CAP_SPEED = 6;
const ICE_REF_POWER = 640_000;

interface RegulationBase {
  mass: number;
  length: number;
  width: number;
  wheelbase: number;
  trackWidth: number;
  icePower: number;
  ersPower: number;
  batteryCapacity: number;
  ersHarvestBrake: number;
  ersHarvestThrottle: number;
  overtakeBoost: number;
  dragArea: number;
  downforceArea: number;
  fuelCapacity: number;
  /** wheel speed (m/s) at maxRpm in 1st..8th */
  gearTopSpeeds: number[];
  drsDragScale: number;
  drsFrontDownforceScale: number;
  drsRearDownforceScale: number;
}

const REGULATIONS: Record<Regulation, RegulationBase> = {
  '2025': {
    mass: 800,
    length: 5.6,
    width: 2.0,
    wheelbase: 3.6,
    trackWidth: 1.6,
    icePower: 640_000,
    ersPower: 120_000,
    batteryCapacity: 4_000_000,
    ersHarvestBrake: 120_000,
    ersHarvestThrottle: 40_000,
    overtakeBoost: 0,
    dragArea: 1.3,
    downforceArea: 4.2,
    fuelCapacity: 110,
    gearTopSpeeds: [26, 37, 47, 57, 67, 77, 88, 101],
    // rear-flap DRS: ~half of the rear wing's drag share, slight rear downforce loss
    drsDragScale: 0.865,
    drsFrontDownforceScale: 1,
    drsRearDownforceScale: 0.85,
  },
  '2026': {
    mass: 770,
    length: 5.4,
    width: 1.9,
    wheelbase: 3.4,
    trackWidth: 1.55,
    icePower: 400_000,
    ersPower: 350_000,
    batteryCapacity: 4_000_000,
    ersHarvestBrake: 350_000,
    ersHarvestThrottle: 70_000,
    overtakeBoost: 0.5,
    dragArea: 1.2,
    downforceArea: 3.8,
    fuelCapacity: 75,
    gearTopSpeeds: [27, 38, 49, 59, 70, 81, 92, 105],
    // active aero straight mode: front + rear wings open
    drsDragScale: 0.7,
    drsFrontDownforceScale: 0.6,
    drsRearDownforceScale: 0.6,
  },
};

const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** Build static car parameters from team ratings, setup and regulation. `upgrade` (0..0.1) = My Team R&D bonus. */
export function createCarSpec(team: TeamDef, setup: CarSetup, regulation: Regulation, upgrade = 0): CarSpec {
  const base = REGULATIONS[regulation] ?? REGULATIONS['2025'];
  const up = clamp(finiteOr(upgrade, 0), 0, 0.1) * 0.5;
  const rate = (r: number): number => clamp(finiteOr(r, 0.9) + up, 0.5, 1.05);
  const aero = rate(team.rating.aero);
  const power = rate(team.rating.power);
  const chassis = rate(team.rating.chassis);
  // reliability already contains My Team R&D (department rating): ±~10 % impact damage around the field average
  const reliability = clamp(finiteOr(team.rating.reliability, 0.93), 0.5, 1.05);

  const s = (key: keyof CarSetup, lo: number, hi: number): number => clamp(finiteOr(setup[key], DEFAULT_SETUP[key]), lo, hi);
  const fw = s('frontWing', 0, 50);
  const rw = s('rearWing', 0, 50);
  const diff = s('diffOnThrottle', 10, 100);
  const bias = s('brakeBias', 50, 70);
  const susp = s('suspension', 1, 11);
  const ride = s('rideHeight', 1, 11);
  const press = s('tyrePressure', 1, 11);
  const dSusp = susp - DEFAULT_SETUP.suspension;
  const dRide = ride - DEFAULT_SETUP.rideHeight;
  const dPress = press - DEFAULT_SETUP.tyrePressure;
  const diffN = (diff - DEFAULT_SETUP.diffOnThrottle) / 45; // ≈ -1..1

  // Aero: wings scale their axle's downforce; rear wing dominates drag. Neutral (25/25) = regulation base.
  const neutralBalance = 0.44;
  const frontDf = neutralBalance * (0.7 + 0.012 * fw);
  const rearDf = (1 - neutralBalance) * (0.7 + 0.012 * rw);
  const wingDf = frontDf + rearDf;
  const platform = (1 - 0.012 * dRide) * (1 + 0.004 * dSusp);
  const aeroEff = 1 - 0.6 * (1 - aero);
  const downforceArea = base.downforceArea * wingDf * platform * aeroEff;
  const dragArea = base.dragArea * (0.84 + 0.0016 * fw + 0.0048 * rw) * (1 - 0.004 * dRide) * (1 + 0.3 * (1 - aero));

  const wheelbase = base.wheelbase;
  const cgToRear = 0.45 * wheelbase; // 45 % static weight on the front axle
  const cgToFront = wheelbase - cgToRear;
  const nominalMass = base.mass + NOMINAL_FUEL_KG;

  const powerScale = 1 - 0.5 * (1 - power);
  const wheelRadius = 0.36;
  const maxRpm = 12_500;
  const finalDrive = 3.0;
  const engineOmegaMax = (maxRpm * 2 * Math.PI) / 60;
  const gearRatios = base.gearTopSpeeds.map((v) => (engineOmegaMax * wheelRadius) / (finalDrive * v));

  return {
    regulation,
    mass: base.mass,
    length: base.length,
    width: base.width,
    wheelbase,
    cgToFront,
    cgToRear,
    trackWidth: base.trackWidth,
    wheelRadius,
    gearRatios,
    finalDrive,
    idleRpm: 4000,
    maxRpm,
    shiftRpm: 11_800,
    icePower: base.icePower * powerScale,
    ersPower: base.ersPower * (0.97 + 0.03 * power),
    batteryCapacity: base.batteryCapacity,
    dragArea,
    downforceArea,
    aeroBalance: clamp(frontDf / wingDf, 0.3, 0.6),
    fuelCapacity: base.fuelCapacity,
    maxSteer: 0.35,
    cgHeight: 0.3,
    yawInertia: nominalMass * cgToFront * cgToRear * 0.9,
    // 1.82 (vs REFERENCE_CAR mu 1.75) compensates the friction-circle / slip-angle losses of the full tyre model
    baseMu: 1.82 * (1 - 0.15 * (1 - chassis)),
    frontGrip: 1 - 0.006 * Math.max(0, diffN),
    rearGrip: (1.035 + 0.01 * diffN) * REAR_GRIP_MARGIN,
    tractionGrip: 0.96 + 0.04 * diffN,
    diffLock: clamp01((diff - 10) / 90),
    brakeBias: bias / 100,
    maxBrakeForce: 62_000,
    rollingResistance: 0.011 * (1 - 0.03 * dPress),
    drivetrainEfficiency: 0.88,
    tyreB: 20 * (1 + 0.02 * dSusp),
    tyreC: 1.45,
    kerbGrip: clamp(0.92 - 0.012 * dSusp + 0.006 * dRide, 0.8, 0.98),
    tyreHeatScale: 1 + 0.03 * dPress,
    tyreWearScale: 1 + 0.03 * dPress,
    tyreGripScale: 1 - 0.006 * dPress,
    drsDragScale: base.drsDragScale,
    drsFrontDownforceScale: base.drsFrontDownforceScale,
    drsRearDownforceScale: base.drsRearDownforceScale,
    ersHarvestBrake: base.ersHarvestBrake,
    ersHarvestThrottle: base.ersHarvestThrottle,
    overtakeBoost: base.overtakeBoost,
    launchRpm: 8500,
    reverseRatio: gearRatios[0] ?? 6,
    damageScale: clamp(1 + (0.93 - reliability) * 3, 0.75, 1.3),
  };
}

/** Expected fuel use (kg) per km at racing pace — used to fuel cars for a race distance. */
export function fuelPerKm(spec: CarSpec): number {
  const p = Number.isFinite(spec.icePower) && spec.icePower > 0 ? spec.icePower : ICE_REF_POWER;
  // smaller engines run a larger share of the lap at full load: sub-linear scaling (fit to simulated laps)
  return FUEL_KG_PER_KM_REF * Math.pow(p / ICE_REF_POWER, 0.84);
}

/** Overall engine→wheel ratio for a gear (-1 = reverse). 0 for neutral / invalid. */
export function totalRatio(spec: CarSpec, gear: number): number {
  if (gear === -1) return spec.reverseRatio * spec.finalDrive;
  if (gear < 1) return 0;
  const idx = Math.min(Math.round(gear), spec.gearRatios.length) - 1;
  const r = spec.gearRatios[idx];
  return r !== undefined && r > 0 ? r * spec.finalDrive : 0;
}

/** Speed (m/s, ≥ 0) for display/AI at an rpm in a gear (reverse returns the backwards speed magnitude, neutral 0). */
export function speedForRpm(spec: CarSpec, gear: number, rpm: number): number {
  const ratio = totalRatio(spec, gear);
  if (ratio <= 0 || !Number.isFinite(rpm)) return 0;
  return (Math.max(0, rpm) * 2 * Math.PI * spec.wheelRadius) / (60 * ratio);
}

/** Engine rpm the wheels impose at forward speed `u` in a gear (no clutch slip). */
export function rpmForSpeed(spec: CarSpec, gear: number, u: number): number {
  const ratio = totalRatio(spec, gear);
  if (ratio <= 0 || spec.wheelRadius <= 0) return 0;
  return ((Math.abs(u) / spec.wheelRadius) * ratio * 60) / (2 * Math.PI);
}

/** Normalised ICE power curve (0..1) at an rpm: rises from idle, flat peak ≈ 85–96 % of maxRpm. */
export function powerCurve(spec: CarSpec, rpm: number): number {
  const n = clamp(rpm / spec.maxRpm, 0, 1.05);
  if (n <= 0.88) {
    const t = clamp((n - 0.3) / 0.58, 0, 1);
    return 0.35 + 0.65 * Math.sin((Math.PI / 2) * t);
  }
  const over = n - 0.88;
  return clamp(1 - 0.5 * over * over, 0, 1);
}

/** Steering assist: extra overall lock reduction on top of the stronger speed scaling. */
export const STEER_ASSIST_SCALE = 0.9;

/** Lock reduction with speed: full lock at rest, halved at the reference speed (assist: stronger + 0.9 overall). */
export function steerSpeedScale(speed: number, steeringAssist = false): number {
  const ref = steeringAssist ? STEER_SPEED_REF_ASSIST : STEER_SPEED_REF;
  const v = Math.abs(finiteOr(speed, 0)) / ref;
  return (steeringAssist ? STEER_ASSIST_SCALE : 1) / (1 + v * v);
}

/** Wheel angle (rad, + right) commanded by a steer input at a speed (before the rate limit). */
export function steerAngleForInput(spec: CarSpec, speed: number, steer: number, steeringAssist = false): number {
  return clamp(finiteOr(steer, 0), -1, 1) * spec.maxSteer * steerSpeedScale(speed, steeringAssist);
}

/** Inverse of steerAngleForInput: steer input (clamped to [-1, 1]) that commands wheel angle `angle` at `speed`. */
export function steerInputForAngle(spec: CarSpec, speed: number, angle: number, steeringAssist = false): number {
  const maxAngle = spec.maxSteer * steerSpeedScale(speed, steeringAssist);
  if (!(maxAngle > 1e-6) || !Number.isFinite(angle)) return 0;
  return clamp(angle / maxAngle, -1, 1);
}

/** Aero downforce (N) at forward speed `speed` for this spec (no DRS, no damage). */
export function downforceAt(spec: CarSpec, speed: number): number {
  const v = finiteOr(speed, 0);
  return 0.5 * AIR_DENSITY * spec.downforceArea * v * v;
}

/**
 * Steady-state max lateral acceleration (m/s²) at `speed`, limited by the weaker axle.
 * `gripScale` = tyreGrip × surface × difficulty factors (1 = fresh softs, dry, optimal temperature).
 */
export function maxLateralAccel(spec: CarSpec, speed: number, gripScale = 1, fuelKg = NOMINAL_FUEL_KG): number {
  const m = spec.mass + Math.max(0, finiteOr(fuelKg, NOMINAL_FUEL_KG));
  const L = spec.wheelbase;
  const df = downforceAt(spec, speed);
  const mu = spec.baseMu * spec.tyreGripScale * Math.max(0, finiteOr(gripScale, 1));
  const fzF = (m * G * spec.cgToRear) / L + df * spec.aeroBalance;
  const fzR = (m * G * spec.cgToFront) / L + df * (1 - spec.aeroBalance);
  const aFront = (mu * spec.frontGrip * fzF * L) / (m * spec.cgToRear);
  const aRear = (mu * spec.rearGrip * fzR * L) / (m * spec.cgToFront);
  const a = Math.min(aFront, aRear);
  return Number.isFinite(a) ? Math.max(0, a) : 0;
}

/**
 * Max straight-line braking deceleration (m/s², positive) at `speed` with ABS-style per-axle limiting, brake bias,
 * load transfer, brake-force cap and aero drag. `gripScale` as in maxLateralAccel.
 */
export function maxBrakeDecel(spec: CarSpec, speed: number, gripScale = 1, fuelKg = NOMINAL_FUEL_KG): number {
  const m = spec.mass + Math.max(0, finiteOr(fuelKg, NOMINAL_FUEL_KG));
  const L = spec.wheelbase;
  const v = Math.abs(finiteOr(speed, 0));
  const df = downforceAt(spec, v);
  const drag = 0.5 * AIR_DENSITY * spec.dragArea * v * v;
  const mu = spec.baseMu * spec.tyreGripScale * Math.max(0, finiteOr(gripScale, 1)) * 0.96;
  let decel = mu * G;
  for (let i = 0; i < 4; i++) {
    const transfer = (m * decel * spec.cgHeight) / L;
    const fzF = Math.max(0, (m * G * spec.cgToRear) / L + df * spec.aeroBalance + transfer);
    const fzR = Math.max(0, (m * G * spec.cgToFront) / L + df * (1 - spec.aeroBalance) - transfer);
    const front = Math.min(spec.maxBrakeForce * spec.brakeBias, mu * spec.frontGrip * fzF);
    const rear = Math.min(spec.maxBrakeForce * (1 - spec.brakeBias), mu * spec.rearGrip * fzR);
    decel = (front + rear + drag) / m;
  }
  return Number.isFinite(decel) ? Math.max(0, decel) : 0;
}

/** Hard cap (m/s) returned by maxCornerSpeed for straights / aero-limited curvature. */
export const MAX_CORNER_SPEED = 120;

/**
 * Highest steady-state speed (m/s) through a curvature |κ| (1/m) using maxLateralAccel (downforce included).
 * Returns MAX_CORNER_SPEED for (near-)straight sections. Real driving reaches ≈ 0.95 of this.
 */
export function maxCornerSpeed(spec: CarSpec, curvature: number, gripScale = 1, fuelKg = NOMINAL_FUEL_KG): number {
  const k = Math.abs(finiteOr(curvature, 0));
  if (k < 1e-5) return MAX_CORNER_SPEED;
  let v = MAX_CORNER_SPEED;
  for (let i = 0; i < 12; i++) v = Math.min(MAX_CORNER_SPEED, Math.sqrt(maxLateralAccel(spec, v, gripScale, fuelKg) / k));
  return Number.isFinite(v) ? v : 0;
}
