/**
 * Chassis force model + integrator for one sub-step: axle loads (static + aero + longitudinal transfer),
 * friction-circle tyre forces (simplified Pacejka lateral, TC/ABS/lock/spin longitudinal), dynamic bicycle
 * integration in the body frame and a smooth kinematic blend below ~3 m/s.
 *
 * Body frame: u = forward speed, v = lateral speed (+ right), w = turn rate (+ = turning RIGHT = -yawRate).
 */
import type { CarSpec, TractionControl } from '../core/types';
import { AIR_DENSITY, G, clamp, lerp, moveToward, smoothstep } from '../core/math';

const KIN_BLEND_LO = 1.5;
const KIN_BLEND_HI = 3;
const MAX_TURN_RATE = 6;
const MAX_U = 130;
const MAX_V = 80;
/** fraction of the "cancel this slip in one sub-step" force a tyre may apply (prevents low-speed overshoot) */
const NO_OVERSHOOT = 0.9;

export interface BodyState {
  u: number;
  v: number;
  w: number;
}

/** Per-step constants shared by the sub-steps. */
export interface ChassisParams {
  mass: number;
  iz: number;
  /** wheel angle (rad, + right) */
  steer: number;
  /** tractive force demand at the rear (N, + forward) */
  drive: number;
  /** total brake force demand (N) incl. assists, and engine braking (N, rear) */
  brakeForce: number;
  engineBrake: number;
  /** other resistive forces (N): surface drag + regen coasting drag */
  extraResist: number;
  dragArea: number;
  clFront: number;
  clRear: number;
  muFront: number;
  muRear: number;
  /** rear longitudinal grip multiplier (differential) */
  traction: number;
  abs: boolean;
  tc: TractionControl;
  /** filtered longitudinal acceleration (m/s², + forward) for load transfer */
  accelLong: number;
}

/** Results of the latest sub-step (forces in the wheel frame, slip values). */
export interface ChassisOut {
  fyFront: number;
  fyRear: number;
  alphaFront: number;
  alphaRear: number;
  slipRatio: number;
  spin: number;
  lockFront: number;
  lockRear: number;
  /** frictional slip power (W) */
  slipPower: number;
  /** applied brake force magnitude (N) */
  brakeApplied: number;
  /** kinematic blend weight 0..1 */
  kinematic: number;
}

export function createChassisOut(): ChassisOut {
  return {
    fyFront: 0,
    fyRear: 0,
    alphaFront: 0,
    alphaRear: 0,
    slipRatio: 0,
    spin: 0,
    lockFront: 0,
    lockRear: 0,
    slipPower: 0,
    brakeApplied: 0,
    kinematic: 1,
  };
}

/** Normalised simplified-Pacejka lateral characteristic: sin(C·atan(B·α)), peak 1. */
export function pacejka(alpha: number, b: number, c: number): number {
  return Math.sin(c * Math.atan(b * alpha));
}

const TC_CAP: Record<TractionControl, number> = { off: Infinity, medium: 1.04, full: 0.95 };

/** Minimum rear braking (fraction of rear capacity) ABS always allows, even at full cornering demand. */
const ABS_REAR_FLOOR = 0.12;

/** Fraction of a relative load change (vs the no-transfer load) that is lost as friction coefficient. */
const LOAD_SENSITIVITY = 0.5;

/** μ multiplier for an axle carrying `fz` instead of its no-transfer load `nominal`. */
function loadSensitivity(fz: number, nominal: number): number {
  if (!(nominal > 1)) return 1;
  return clamp(1 - LOAD_SENSITIVITY * ((fz - nominal) / nominal), 0.8, 1.2);
}

/**
 * Advance the body state by `h` seconds. TC / ABS limit the longitudinal force to what the friction circle leaves
 * after the lateral DEMAND (full-capacity Pacejka force at the current slip angle). Writes results into `out`.
 */
export function chassisSubstep(body: BodyState, spec: CarSpec, p: ChassisParams, h: number, out: ChassisOut): void {
  const { u, v, w } = body;
  const m = p.mass;
  const a = spec.cgToFront;
  const b = spec.cgToRear;
  const L = spec.wheelbase;
  const absU = Math.abs(u);
  const dir = u > 0.05 ? 1 : u < -0.05 ? -1 : 0;

  // ── normal loads ──
  const q = 0.5 * AIR_DENSITY * u * u;
  const dfF = q * p.clFront;
  const dfR = q * p.clRear;
  const transfer = clamp((m * p.accelLong * spec.cgHeight) / L, -0.35 * m * G, 0.35 * m * G);
  const fzF = Math.max((0.15 * m * G * b) / L, (m * G * b) / L + dfF - transfer);
  const fzR = Math.max((0.15 * m * G * a) / L, (m * G * a) / L + dfR + transfer);
  // tyre load sensitivity: an axle gaining load through longitudinal transfer gains proportionally less grip
  const nomF = (m * G * b) / L + dfF;
  const nomR = (m * G * a) / L + dfR;
  const fmaxF = Math.max(1, p.muFront * fzF * loadSensitivity(fzF, nomF));
  const fmaxR = Math.max(1, p.muRear * fzR * loadSensitivity(fzR, nomR));
  const fmaxRL = fmaxR * p.traction;

  // ── slip angles and full-capacity lateral demand ──
  const delta = p.steer;
  const cosD = Math.cos(delta);
  const sinD = Math.sin(delta);
  const vF = v + w * a;
  const vR = v - w * b;
  const uWF = cosD * u + sinD * vF;
  const sF = -sinD * u + cosD * vF;
  const alphaF = Math.atan2(sF, Math.max(Math.abs(uWF), 0.5));
  const alphaR = Math.atan2(vR, Math.max(absU, 0.5));
  const pacF = pacejka(alphaF, spec.tyreB, spec.tyreC);
  const pacR = pacejka(alphaR, spec.tyreB, spec.tyreC);
  const demandF = fmaxF * Math.abs(pacF);
  const demandR = fmaxR * Math.abs(pacR);

  // ── front axle: braking (ABS or lock) ──
  // the tyres take braking up to fmax × brakeGrip (brakes part; 1 = undeveloped): ABS caps and the lock-up threshold
  // scale with it, and the friction circle below counts brake use against that limit
  const bg = spec.brakeGrip;
  const fbF = fmaxF * bg;
  let brakeF = p.brakeForce * spec.brakeBias;
  if (p.abs) brakeF = Math.min(brakeF, Math.max(0.4 * fmaxF, 0.95 * Math.sqrt(Math.max(0, fmaxF * fmaxF - demandF * demandF))) * bg);
  let lockF = 0;
  if (brakeF > fbF && absU > 1) {
    lockF = clamp((brakeF / fbF - 1) * 3, 0, 1);
    brakeF = fbF * (1 - 0.15 * lockF);
  } else brakeF = Math.min(brakeF, fbF);
  if (dir === 0) lockF = 0;

  // ── rear axle: drive (TC / spin) and braking (ABS / lock) ──
  let drive = p.drive;
  const remainR = Math.max(0.15 * fmaxRL, Math.sqrt(Math.max(0, fmaxRL * fmaxRL - demandR * demandR)));
  const tcCap = TC_CAP[p.tc] * remainR;
  if (Math.abs(drive) > tcCap) drive = Math.sign(drive) * tcCap;
  let brakeR = p.brakeForce * (1 - spec.brakeBias) + p.engineBrake;
  // ABS on the rear keeps the cornering grip first (like brake-force distribution): small floor, no lateral starvation
  if (p.abs) brakeR = Math.min(brakeR, Math.max(ABS_REAR_FLOOR * fmaxR, 0.95 * remainR) * bg);
  let spin = 0;
  let lockR = 0;
  let fxRDrive = drive;
  if (Math.abs(drive) > fmaxRL) {
    spin = clamp((Math.abs(drive) / fmaxRL - 1) * 2.5, 0, 1);
    fxRDrive = Math.sign(drive) * fmaxRL * (1 - 0.12 * spin);
  }
  const fbR = fmaxR * bg;
  if (brakeR > fbR && absU > 1) {
    lockR = clamp((brakeR / fbR - 1) * 3, 0, 1);
    brakeR = fbR * (1 - 0.15 * lockR);
  } else brakeR = Math.min(brakeR, fbR);
  if (dir === 0) lockR = 0;
  // braking uses the friction circle as a share of fmax × brakeGrip
  const fxRUsed = Math.min(fmaxR, Math.abs(fxRDrive) + (dir !== 0 ? brakeR / bg : 0));
  const fxFUsed = dir !== 0 ? brakeF / bg : 0;

  // ── lateral tyre forces (friction circle + no-overshoot clamp) ──
  const capF = Math.sqrt(Math.max(0, fmaxF * fmaxF - fxFUsed * fxFUsed)) * (1 - 0.75 * lockF);
  const capR = Math.sqrt(Math.max(0, fmaxR * fmaxR - fxRUsed * fxRUsed)) * (1 - 0.7 * Math.max(spin, lockR));
  const killF = (Math.abs(sF) / ((1 / m + (a * cosD) ** 2 / p.iz) * h)) * NO_OVERSHOOT;
  const killR = (Math.abs(vR) / ((1 / m + (b * b) / p.iz) * h)) * NO_OVERSHOOT;
  const fyF = clamp(-capF * pacF, -killF, killF);
  const fyR = clamp(-capR * pacR, -killR, killR);

  // ── integrate (semi-implicit Euler, resistive forces never reverse the motion) ──
  const rolling = spec.rollingResistance * (fzF + fzR);
  const drag = q * p.dragArea;
  const resist = brakeF + brakeR + drag + (absU > 0.05 ? rolling + p.extraResist : 0);
  const fxFree = fxRDrive - fyF * sinD;
  const fyBody = fyF * cosD + fyR;
  const mz = a * fyF * cosD - b * fyR;
  let u1 = u + h * (fxFree / m + v * w);
  u1 = moveToward(u1, 0, (h * resist) / m);
  let v1 = v + h * (fyBody / m - u * w);
  let w1 = w + (h * mz) / p.iz;

  // blend on total speed: a car sliding sideways at speed (u ≈ 0) must stay fully dynamic
  const kin = 1 - smoothstep(KIN_BLEND_LO, KIN_BLEND_HI, Math.hypot(u1, v1));
  if (kin > 0) {
    const wK = (u1 * Math.tan(delta)) / L;
    v1 = lerp(v1, wK * b, kin);
    w1 = lerp(w1, wK, kin);
  }
  body.u = clamp(u1, -MAX_U, MAX_U);
  body.v = clamp(v1, -MAX_V, MAX_V);
  body.w = clamp(w1, -MAX_TURN_RATE, MAX_TURN_RATE);

  // ── outputs ──
  // unlocked braking slip grows with brake use as a share of fmax × brakeGrip, like the friction circle above
  const slipF = lockF > 0 ? -lockF : (0.08 * (dir !== 0 ? -brakeF / bg : 0)) / fmaxF;
  let slipR: number;
  if (spin > 0) slipR = Math.sign(fxRDrive) * (0.1 + 0.9 * spin);
  else if (lockR > 0) slipR = -(0.1 + 0.9 * lockR);
  else slipR = (0.08 * (fxRDrive - (dir * brakeR) / bg)) / fmaxR;
  out.fyFront = fyF;
  out.fyRear = fyR;
  out.alphaFront = alphaF;
  out.alphaRear = alphaR;
  out.slipRatio = clamp(slipR, -1, 1);
  out.spin = spin;
  out.lockFront = lockF;
  out.lockRear = lockR;
  out.slipPower =
    Math.abs(fyF * sF) + Math.abs(fyR * vR) + absU * (Math.abs(fxRDrive * slipR) + Math.abs(brakeF * slipF) + Math.abs(brakeR * (lockR > 0 ? slipR : 0.02)));
  out.brakeApplied = dir !== 0 ? brakeF + brakeR : 0;
  out.kinematic = kin;
}
