/**
 * Vehicle physics (owner: physics agent). Pure logic — must NOT import three.js or the track module.
 * Exported signatures are a CONTRACT: keep them (you may add exports / optional params).
 *
 * Race-start protocol (runtime):
 *   1. Grid cars: createCarPhysics(pose, compound, fuel, spec, 'grid') → gear 0 (N), internal.held = true.
 *      While held, stepCarPhysics keeps the car pinned (zero velocity, pose untouched) but rpm follows the throttle.
 *   2. Lights out: setCarHeld(car, false). The car stays in N (and at rest) until the first step with
 *      throttle > 0.05 (or a shift-up), which engages 1st and launches with clutch slip.
 *   setCarHeld(car, true) may also be used to pin a car during a pit stop (gear is kept).
 */
import type { CarPhysicsState, CarSpec, TireCompound } from '../core/types';
import { clamp, wrapAngle } from '../core/math';
import { COMPOUND_PARAMS } from './tyres';

export {
  createCarSpec,
  fuelPerKm,
  speedForRpm,
  rpmForSpeed,
  totalRatio,
  powerCurve,
  steerInputForAngle,
  steerAngleForInput,
  steerSpeedScale,
  maxLateralAccel,
  maxBrakeDecel,
  maxCornerSpeed,
  downforceAt,
  STEER_RATE,
  STEER_SPEED_REF,
  STEER_SPEED_REF_ASSIST,
  STEER_ASSIST_SCALE,
  MAX_CORNER_SPEED,
  NOMINAL_FUEL_KG,
  FUEL_KG_PER_KM_REF,
} from './spec';
export { tyreGrip, wetGrip, temperatureGrip, wearGrip, COMPOUND_PARAMS, SURFACE_GRIP, SURFACE_DRAG_DECEL } from './tyres';
export { stepCarPhysics, SUBSTEPS, isBroken } from './step';
export { collideWithBarrier, collideCars, applyImpactDamage, isFrontalContact } from './collision';
export { REVERSE_HOLD_TIME, REVERSE_MAX_SPEED, UPSHIFT_TIME, DOWNSHIFT_TIME, assistedErsMode, nextErsMode } from './powertrain';

/** 'running' = 1st gear, free to move; 'grid' = neutral and held until setCarHeld(car, false). */
export type CarStartMode = 'running' | 'grid';

/** Fresh physics state at a pose, stationary, in 1st gear (or neutral + held before a race start: startMode 'grid'). */
export function createCarPhysics(
  pose: { x: number; y: number; z: number; yaw: number },
  compound: TireCompound,
  fuelKg: number,
  spec: CarSpec,
  startMode: CarStartMode = 'running',
): CarPhysicsState {
  const fin = (v: number): number => (Number.isFinite(v) ? v : 0);
  const grid = startMode === 'grid';
  return {
    x: fin(pose.x),
    y: fin(pose.y),
    z: fin(pose.z),
    yaw: wrapAngle(fin(pose.yaw)),
    pitch: 0,
    roll: 0,
    vx: 0,
    vz: 0,
    yawRate: 0,
    speed: 0,
    vLong: 0,
    vLat: 0,
    steerAngle: 0,
    throttle: 0,
    brake: 0,
    gear: grid ? 0 : 1,
    rpm: spec.idleRpm,
    wheelSpin: 0,
    slipAngleFront: 0,
    slipAngleRear: 0,
    slipRatio: 0,
    lockup: 0,
    gLat: 0,
    gLong: 0,
    tire: { compound, wear: 0, temp: COMPOUND_PARAMS[compound].blanketTemp, laps: 0 },
    fuelKg: clamp(fin(fuelKg), 0, Math.max(0, spec.fuelCapacity)),
    ers: { charge: 1, mode: 'medium', deployedLap: 0, harvestedLap: 0, overtakeAvailable: false, overtakeActive: false },
    drs: { eligible: false, available: false, open: false },
    damage: { frontWing: 0, rearWing: 0, floor: 0, suspension: 0 },
    limiter: false,
    impact: 0,
    surface: 'asphalt',
    trackIndex: 0,
    s: 0,
    lateral: 0,
    internal: {
      held: grid,
      shiftTimer: 0,
      shiftCooldown: 0,
      brakeHoldTime: 0,
      revDriven: false,
      revArmed: false,
      accelLong: 0,
      accelLat: 0,
      fyFront: 0,
      fyRear: 0,
      spin: 0,
      odometer: 0,
      ersDeployW: 0,
      ersHarvestW: 0,
      icePowerW: 0,
    },
  };
}

/** Pin (held = true) or release a car. Holding zeroes its velocity; releasing keeps the current gear (N on the grid). */
export function setCarHeld(car: CarPhysicsState, held: boolean): void {
  car.internal.held = held;
  if (held) {
    car.vx = 0;
    car.vz = 0;
    car.yawRate = 0;
    car.speed = 0;
    car.vLong = 0;
    car.vLat = 0;
    car.drs.open = false;
  }
}

/** True while the runtime holds the car (grid / pit stop). */
export function isCarHeld(car: CarPhysicsState): boolean {
  return car.internal.held;
}

/** Fit a new set of tyres (wear 0, warm-ish blanket temp) and optionally repair the wings and floor (a pit stop cannot
 * repair the suspension). */
export function fitTyres(car: CarPhysicsState, compound: TireCompound, repair: boolean): void {
  car.tire = { compound, wear: 0, temp: COMPOUND_PARAMS[compound].blanketTemp, laps: 0 };
  if (repair) {
    car.damage.frontWing = 0;
    car.damage.rearWing = 0;
    car.damage.floor = 0;
  }
}
