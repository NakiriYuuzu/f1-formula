/**
 * stepCarPhysics: one fixed simulation step for one car — input sanitising, assists (braking, limiter, steering,
 * ERS, DRS), gearbox, drive, aero + grip, chassis sub-steps, then pose integration and all derived telemetry
 * (g-forces, rpm, wheel spin, slip, pitch/roll, tyres, fuel, battery). Never leaves NaN/Infinity behind.
 */
import type { CarPhysicsState, CarSpec, ControlInput, PhysicsEnv } from '../core/types';
import { G, TAU, clamp, clamp01, damp, forwardX, forwardZ, moveToward, rightX, rightZ, wrapAngle } from '../core/math';
import { REFERENCE_CAR } from '../core/defaults';
import { type BodyState, type ChassisParams, chassisSubstep, createChassisOut } from './chassis';
import {
  applyErsEnergy,
  assistedErsMode,
  computeDrive,
  engineBrakeForce,
  harvestPower,
  nextErsMode,
  updateGearbox,
  FUEL_PER_JOULE,
} from './powertrain';
import { FRONT_SLIP_CAP_SPEED, FRONT_SLIP_STEER_CAP, NOMINAL_FUEL_KG, STEER_RATE, steerAngleForInput } from './spec';
import { SURFACE_DRAG_DECEL, SURFACE_GRIP, tyreGrip, updateTyre } from './tyres';

/** Chassis sub-steps per simulation step (1/240 s at SIM_DT) for stiff low-speed tyre dynamics. */
export const SUBSTEPS = 2;

const num = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/** Grip lost with a bent suspension (share of μ at 0.99). */
const SUSPENSION_GRIP_LOSS = 0.08;
/** Broken suspension (damage 1): no drive, and the wrecked corner drags the car down (m/s²). */
const BROKEN_DRAG_DECEL = 5;

/** The suspension is broken: the car cannot be driven any more. */
export const isBroken = (car: CarPhysicsState): boolean => num(car.damage.suspension) >= 1;

interface SafeInput {
  throttle: number;
  brake: number;
  steer: number;
}

function sanitizeInput(input: ControlInput): SafeInput {
  return {
    throttle: clamp01(num(input.throttle)),
    brake: clamp01(num(input.brake)),
    steer: clamp(num(input.steer), -1, 1),
  };
}

/** Braking assist: env.assistTargetSpeed = max speed allowed NOW (runtime computes it from the braking curve). */
function applyBrakingAssist(env: PhysicsEnv, u: number, inp: SafeInput): void {
  const target = env.assistTargetSpeed;
  if (env.assists.braking === 'off' || target === null || !Number.isFinite(target) || u < 5) return;
  const excess = u - Math.max(0, target);
  if (excess <= 0) return;
  if (env.assists.braking === 'high') {
    inp.brake = Math.max(inp.brake, clamp(excess / 4, 0, 1));
    inp.throttle *= clamp(1 - excess / 2, 0, 1);
  } else {
    inp.brake = Math.max(inp.brake, clamp(excess / 8, 0, 0.6));
    inp.throttle *= clamp(1 - excess / 4, 0, 1);
  }
}

/**
 * Active aero that also sheds front downforce (2026 straight mode) returns to corner mode above this lateral load
 * (g) and may only open again below the lower one, so it never stays open through a flat-out corner of its zone.
 */
const STRAIGHT_MODE_CLOSE_G = 1.0;
const STRAIGHT_MODE_OPEN_G = 0.6;

function updateDrs(car: CarPhysicsState, spec: CarSpec, input: ControlInput, env: PhysicsEnv, brake: number): void {
  const drs = car.drs;
  const gLat = Math.abs(num(car.gLat));
  const activeAero = spec.drsFrontDownforceScale < 1;
  if (!drs.available || brake > 0.1 || (activeAero && gLat > STRAIGHT_MODE_CLOSE_G)) {
    drs.open = false;
    return;
  }
  if (activeAero && !drs.open && gLat > STRAIGHT_MODE_OPEN_G) return;
  if (input.drsPressed || env.assists.drsAssist) drs.open = true;
}

function updateErsMode(car: CarPhysicsState, input: ControlInput, env: PhysicsEnv): void {
  if (env.assists.ersAssist) car.ers.mode = assistedErsMode(car.ers.mode, car.ers.charge);
  else if (input.ersCycle) car.ers.mode = nextErsMode(car.ers.mode);
}

function steerTarget(car: CarPhysicsState, spec: CarSpec, env: PhysicsEnv, steer: number, speed: number, body: BodyState): number {
  const assist = env.assists.steering;
  let target = steerAngleForInput(spec, speed, steer, assist);
  if (assist) {
    // counter-steer against a sliding rear (rear slip angle sign = slide direction)
    const ar = num(car.slipAngleRear);
    const excess = Math.max(0, Math.abs(ar) - 0.05);
    target += clamp(0.6 * Math.sign(ar) * excess, -0.12, 0.12);
  }
  if (body.u > FRONT_SLIP_CAP_SPEED) {
    // lock beyond the front tyres' peak slip only scrubs speed: cap it around the zero-slip direction
    const zeroSlip = Math.atan2(body.v + body.w * spec.cgToFront, body.u);
    target = clamp(target, zeroSlip - FRONT_SLIP_STEER_CAP, zeroSlip + FRONT_SLIP_STEER_CAP);
  }
  return clamp(target, -spec.maxSteer, spec.maxSteer);
}

function holdStep(car: CarPhysicsState, spec: CarSpec, env: PhysicsEnv, inp: SafeInput, dt: number): void {
  car.vx = 0;
  car.vz = 0;
  car.yawRate = 0;
  car.speed = 0;
  car.vLong = 0;
  car.vLat = 0;
  car.gLat = 0;
  car.gLong = 0;
  car.slipAngleFront = 0;
  car.slipAngleRear = 0;
  car.slipRatio = 0;
  car.lockup = 0;
  car.throttle = inp.throttle;
  car.brake = inp.brake;
  car.drs.open = false;
  car.ers.overtakeActive = false;
  car.steerAngle = moveToward(num(car.steerAngle), steerAngleForInput(spec, 0, inp.steer), STEER_RATE * dt);
  car.rpm = computeDrive(car, spec, inp.throttle, 0, false, 1, spec.mass, dt).rpm;
  car.pitch = damp(num(car.pitch), 0, 6, dt);
  car.roll = damp(num(car.roll), 0, 6, dt);
  car.impact = decayImpact(car.impact, dt);
  car.internal.accelLong = 0;
  car.internal.accelLat = 0;
  updateTyre(car.tire, { slipPower: 0, slipIntensity: 0, speed: 0 }, env.trackTemp, env.wetness, spec.tyreHeatScale, 0, 0, dt);
}

function decayImpact(impact: number, dt: number): number {
  const v = num(impact) * Math.exp(-5 * dt);
  return v < 1 ? 0 : v;
}

/**
 * Advance one car by dt (SIM_DT). Applies assists, gearbox, ERS, DRS open/close (given car.drs.available set by the
 * runtime), aero, tyre forces, wear/temperature, fuel burn; updates pose/velocity and all derived fields.
 * Must never produce NaN/Infinity for any input in range and must be stable at 0 speed.
 */
export function stepCarPhysics(car: CarPhysicsState, spec: CarSpec, input: ControlInput, env: PhysicsEnv, dt: number): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const h = Math.min(dt, 0.05);
  const saved = { x: num(car.x), y: num(car.y), z: num(car.z), yaw: wrapAngle(num(car.yaw)) };
  sanitizeState(car, spec);

  const inp = sanitizeInput(input);
  if (input.limiterToggle) car.limiter = !car.limiter;
  updateErsMode(car, input, env);
  if (car.internal.held) {
    holdStep(car, spec, env, inp, h);
    return;
  }

  const fx0 = forwardX(car.yaw);
  const fz0 = forwardZ(car.yaw);
  const rx0 = rightX(car.yaw);
  const rz0 = rightZ(car.yaw);
  const body: BodyState = { u: car.vx * fx0 + car.vz * fz0, v: car.vx * rx0 + car.vz * rz0, w: -car.yawRate };
  const vx0 = car.vx;
  const vz0 = car.vz;

  applyBrakingAssist(env, body.u, inp);
  if (car.limiter) inp.throttle = Math.min(inp.throttle, clamp((REFERENCE_CAR.pitSpeed - body.u) * 0.8, 0, 1));
  const broken = isBroken(car);
  if (broken) inp.throttle = 0;
  updateDrs(car, spec, input, env, inp.brake);

  updateGearbox(car, spec, {
    u: body.u,
    throttleRaw: clamp01(num(input.throttle)),
    brakeRaw: clamp01(num(input.brake)),
    throttle: inp.throttle,
    brake: inp.brake,
    shiftUp: input.shiftUp,
    shiftDown: input.shiftDown,
    auto: env.assists.gearbox === 'auto',
    dt: h,
  });

  const speed0 = Math.hypot(body.u, body.v);
  car.steerAngle = moveToward(car.steerAngle, steerTarget(car, spec, env, inp.steer, speed0, body), STEER_RATE * h);

  const mass = spec.mass + car.fuelKg;
  const perf = clamp(num(env.performanceScale, 1), 0.5, 1.5);
  const drive = computeDrive(car, spec, inp.throttle, body.u, input.overtakeHeld, perf, mass, h);
  const engineBrake = engineBrakeForce(car, spec, inp.throttle, body.u);
  const brakeForce = inp.brake * spec.maxBrakeForce;
  const harvest = harvestPower(car, spec, { throttle: inp.throttle, brake: inp.brake, brakeForce, u: body.u });

  // aero (DRS / active aero, damage, the wake of a car ahead)
  const dmg = car.damage;
  const floorLoss = 1 - 0.3 * clamp01(dmg.floor);
  const open = car.drs.open;
  const wake = env.wake;
  const wakeDrag = wake ? clamp(num(wake.drag, 1), 0.5, 1) : 1;
  const wakeFront = wake ? clamp(num(wake.frontDownforce, 1), 0.5, 1) : 1;
  const wakeRear = wake ? clamp(num(wake.rearDownforce, 1), 0.5, 1) : 1;
  const dragArea =
    spec.dragArea * (open ? spec.drsDragScale : 1) * (1 + 0.08 * clamp01(dmg.frontWing) + 0.05 * clamp01(dmg.floor)) * wakeDrag;
  const clFront =
    spec.downforceArea *
    spec.aeroBalance *
    (open ? spec.drsFrontDownforceScale : 1) *
    (1 - 0.6 * clamp01(dmg.frontWing)) *
    floorLoss *
    wakeFront;
  const clRear =
    spec.downforceArea *
    (1 - spec.aeroBalance) *
    (open ? spec.drsRearDownforceScale : 1) *
    (1 - 0.55 * clamp01(dmg.rearWing)) *
    floorLoss *
    wakeRear;

  // grip
  const wet = clamp01(num(env.wetness));
  const surface = env.surface;
  const surfaceGrip = surface === 'kerb' ? spec.kerbGrip : (SURFACE_GRIP[surface] ?? 1);
  const tyre = tyreGrip(car.tire.compound, car.tire.wear, car.tire.temp, wet);
  const mu =
    spec.baseMu *
    spec.tyreGripScale *
    tyre *
    surfaceGrip *
    (1 + 0.03 * clamp01(num(env.rubber))) *
    (1 + (perf - 1) * 0.6) *
    (1 - SUSPENSION_GRIP_LOSS * clamp01(num(dmg.suspension)));
  const diffUndersteer = 1 - 0.04 * (spec.diffLock - 0.5) * inp.throttle;
  const surfaceDecel = (SURFACE_DRAG_DECEL[surface] ?? 0) * clamp(Math.abs(body.u) / 20, 0.15, 1);

  const params: ChassisParams = {
    mass,
    iz: spec.yawInertia * (mass / (spec.mass + NOMINAL_FUEL_KG)),
    steer: car.steerAngle,
    drive: drive.force,
    brakeForce,
    engineBrake,
    extraResist: mass * (surfaceDecel + (broken ? BROKEN_DRAG_DECEL : 0)) + harvest.coastDrag,
    dragArea,
    clFront,
    clRear,
    muFront: mu * spec.frontGrip * diffUndersteer,
    muRear: mu * spec.rearGrip,
    traction: spec.tractionGrip,
    abs: env.assists.abs,
    tc: env.assists.traction,
    accelLong: car.internal.accelLong,
  };

  const out = createChassisOut();
  let slipPower = 0;
  const hs = h / SUBSTEPS;
  for (let i = 0; i < SUBSTEPS; i++) {
    chassisSubstep(body, spec, params, hs, out);
    slipPower += out.slipPower / SUBSTEPS;
  }

  // pose integration (semi-implicit: new yaw, then world velocity, then position)
  car.yawRate = -body.w;
  car.yaw = wrapAngle(car.yaw + car.yawRate * h);
  const fx = forwardX(car.yaw);
  const fz = forwardZ(car.yaw);
  const rx = rightX(car.yaw);
  const rz = rightZ(car.yaw);
  car.vx = body.u * fx + body.v * rx;
  car.vz = body.u * fz + body.v * rz;
  car.x += car.vx * h;
  car.z += car.vz * h;

  // derived telemetry
  const ax = clamp((car.vx - vx0) / h, -80, 80);
  const az = clamp((car.vz - vz0) / h, -80, 80);
  const it = car.internal;
  it.accelLong = damp(it.accelLong, ax * fx + az * fz, 15, h);
  it.accelLat = damp(it.accelLat, ax * rx + az * rz, 15, h);
  it.fyFront = out.fyFront;
  it.fyRear = out.fyRear;
  it.spin = damp(it.spin, out.spin, 10, h);
  it.odometer += Math.abs(body.u) * h;
  it.icePowerW = drive.iceW;
  car.speed = Math.hypot(car.vx, car.vz);
  car.vLong = body.u;
  car.vLat = body.v;
  car.gLong = it.accelLong / G;
  car.gLat = it.accelLat / G;
  car.rpm = damp(car.rpm, drive.rpm, 30, h);
  const dyn = 1 - out.kinematic;
  car.slipAngleFront = out.alphaFront * dyn;
  car.slipAngleRear = out.alphaRear * dyn;
  car.slipRatio = out.slipRatio * (Math.abs(body.u) > 1 ? 1 : 0);
  car.lockup = damp(car.lockup, Math.max(out.lockFront, out.lockRear), 15, h);
  car.wheelSpin = (car.wheelSpin + (body.u / spec.wheelRadius) * (1 + 0.6 * it.spin) * (1 - car.lockup) * h) % TAU;
  car.pitch = damp(car.pitch, clamp(0.006 * car.gLong, -0.035, 0.035), 8, h);
  car.roll = damp(car.roll, clamp(-0.005 * car.gLat, -0.03, 0.03), 8, h);
  car.impact = decayImpact(car.impact, h);
  car.throttle = inp.throttle;
  car.brake = inp.brake;
  car.ers.overtakeActive = drive.overtakeActive;

  const slipIntensity =
    (Math.abs(car.slipAngleFront) + Math.abs(car.slipAngleRear)) / 0.1 + Math.abs(car.slipRatio) * 4 + car.lockup * 2;
  updateTyre(
    car.tire,
    { slipPower, slipIntensity, speed: Math.abs(body.u) },
    env.trackTemp,
    wet,
    spec.tyreHeatScale,
    spec.tyreWearScale,
    env.wearMultiplier,
    h,
  );
  const fuelUse = FUEL_PER_JOULE * drive.iceW * h * Math.max(0, num(env.fuelMultiplier, 1));
  car.fuelKg = Math.max(0, car.fuelKg - fuelUse);
  applyErsEnergy(car, spec, drive.ersW, harvest.watts, h);

  if (!isStateFinite(car)) restoreSafe(car, saved);
}

/** Replace non-finite scalar state with safe values before integrating. */
function sanitizeState(car: CarPhysicsState, spec: CarSpec): void {
  car.yaw = wrapAngle(num(car.yaw));
  car.vx = num(car.vx);
  car.vz = num(car.vz);
  car.yawRate = clamp(num(car.yawRate), -6, 6);
  car.steerAngle = clamp(num(car.steerAngle), -spec.maxSteer, spec.maxSteer);
  car.rpm = clamp(num(car.rpm, spec.idleRpm), 0, spec.maxRpm * 1.05);
  car.fuelKg = clamp(num(car.fuelKg), 0, Math.max(spec.fuelCapacity, 0));
  car.wheelSpin = num(car.wheelSpin);
  car.lockup = clamp01(num(car.lockup));
  car.pitch = num(car.pitch);
  car.roll = num(car.roll);
  car.ers.charge = clamp01(num(car.ers.charge));
  const g = Math.round(num(car.gear));
  car.gear = clamp(g, -1, spec.gearRatios.length);
  const it = car.internal;
  it.accelLong = clamp(num(it.accelLong), -80, 80);
  it.accelLat = clamp(num(it.accelLat), -80, 80);
  it.fyFront = num(it.fyFront);
  it.fyRear = num(it.fyRear);
  it.spin = clamp01(num(it.spin));
  it.shiftTimer = clamp(num(it.shiftTimer), 0, 1);
  it.shiftCooldown = clamp(num(it.shiftCooldown), 0, 1);
  it.brakeHoldTime = clamp(num(it.brakeHoldTime), 0, 10);
  it.odometer = num(it.odometer);
}

function isStateFinite(car: CarPhysicsState): boolean {
  const vals = [
    car.x, car.z, car.yaw, car.vx, car.vz, car.yawRate, car.speed, car.vLong, car.vLat, car.steerAngle, car.rpm,
    car.wheelSpin, car.gLat, car.gLong, car.pitch, car.roll, car.slipAngleFront, car.slipAngleRear, car.slipRatio,
    car.lockup, car.fuelKg, car.tire.temp, car.tire.wear, car.ers.charge, car.ers.deployedLap, car.ers.harvestedLap,
    car.internal.accelLong, car.internal.accelLat, car.internal.fyFront, car.internal.fyRear,
  ];
  for (const v of vals) if (!Number.isFinite(v)) return false;
  return true;
}

/** Last-resort recovery: back to the pre-step pose at rest with neutral telemetry. */
function restoreSafe(car: CarPhysicsState, saved: { x: number; y: number; z: number; yaw: number }): void {
  car.x = saved.x;
  car.y = saved.y;
  car.z = saved.z;
  car.yaw = saved.yaw;
  car.vx = 0;
  car.vz = 0;
  car.yawRate = 0;
  car.speed = 0;
  car.vLong = 0;
  car.vLat = 0;
  car.gLat = 0;
  car.gLong = 0;
  car.pitch = 0;
  car.roll = 0;
  car.slipAngleFront = 0;
  car.slipAngleRear = 0;
  car.slipRatio = 0;
  car.lockup = 0;
  car.steerAngle = num(car.steerAngle);
  car.rpm = num(car.rpm, 4000);
  car.wheelSpin = num(car.wheelSpin);
  car.fuelKg = Math.max(0, num(car.fuelKg));
  car.tire.temp = num(car.tire.temp, 60);
  car.tire.wear = clamp01(num(car.tire.wear));
  car.ers.charge = clamp01(num(car.ers.charge));
  car.ers.deployedLap = num(car.ers.deployedLap);
  car.ers.harvestedLap = num(car.ers.harvestedLap);
  const it = car.internal;
  it.accelLong = 0;
  it.accelLat = 0;
  it.fyFront = 0;
  it.fyRear = 0;
}
