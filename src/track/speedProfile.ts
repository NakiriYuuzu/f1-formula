/**
 * Reference speed profile along the racing line for REFERENCE_CAR (dry, soft tyres, no DRS):
 * aero-dependent corner limit, forward power/traction pass, backward braking pass (friction circle),
 * iterated around the closed loop until converged; plus racing-line path geometry and lap time.
 */
import { AIR_DENSITY, G, angleDiff } from '../core/math';
import { REFERENCE_CAR } from '../core/defaults';
import { smoothClosed } from './signal';

const CAR = REFERENCE_CAR;
/** aero coefficients per unit mass: downforce / drag acceleration = k · v² */
const DOWNFORCE_K = (0.5 * AIR_DENSITY * CAR.downforceArea) / CAR.mass;
const DRAG_K = (0.5 * AIR_DENSITY * CAR.dragArea) / CAR.mass;
const MIN_SPEED = 5;

export interface LinePath {
  /** world XZ of the racing line */
  qx: Float64Array;
  qz: Float64Array;
  /** length of segment i → i+1 (m) */
  ds: Float64Array;
  /** signed curvature (+ right) of the racing line at each sample */
  curvature: Float64Array;
}

/** Geometry of the path p + offset·right (closed). */
export function linePath(
  px: Float64Array,
  pz: Float64Array,
  rx: Float64Array,
  rz: Float64Array,
  offset: Float64Array,
): LinePath {
  const n = px.length;
  const qx = new Float64Array(n);
  const qz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    qx[i] = px[i] + offset[i] * rx[i];
    qz[i] = pz[i] + offset[i] * rz[i];
  }
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ds[i] = Math.max(1e-6, Math.hypot(qx[j] - qx[i], qz[j] - qz[i]));
  }
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const yawIn = Math.atan2(qx[i] - qx[a], qz[i] - qz[a]);
    const yawOut = Math.atan2(qx[b] - qx[i], qz[b] - qz[i]);
    // + = right: turning right decreases yaw
    raw[i] = -angleDiff(yawIn, yawOut) / (0.5 * (ds[a] + ds[i]));
  }
  return { qx, qz, ds, curvature: smoothClosed(raw, 2, 2) };
}

/** Maximum steady-state speed for |curvature| (m/s), capped at the reference top speed. */
export function cornerSpeedLimit(absCurvature: number): number {
  const k = Math.abs(absCurvature);
  const denom = k - CAR.mu * DOWNFORCE_K;
  if (denom <= 0) return CAR.topSpeed;
  return Math.min(CAR.topSpeed, Math.sqrt((CAR.mu * G) / denom));
}

/** Total tyre acceleration capacity (m/s²) at speed v. */
function gripAccel(v: number): number {
  return CAR.mu * (G + DOWNFORCE_K * v * v);
}

function driveAccel(v: number, absCurvature: number): number {
  const vs = Math.max(v, MIN_SPEED);
  const grip = gripAccel(vs);
  const lat = vs * vs * absCurvature;
  const longGrip = Math.sqrt(Math.max(0, grip * grip - lat * lat));
  const power = CAR.power / (CAR.mass * vs);
  return Math.max(0, Math.min(power, longGrip) - DRAG_K * vs * vs);
}

function brakeAccel(v: number, absCurvature: number): number {
  const vs = Math.max(v, MIN_SPEED);
  const grip = CAR.brakeDecel + CAR.mu * DOWNFORCE_K * vs * vs;
  const lat = vs * vs * absCurvature;
  const longGrip = Math.sqrt(Math.max(0, grip * grip - lat * lat));
  return longGrip + DRAG_K * vs * vs;
}

/** Speed profile (m/s) for the closed path described by per-sample curvature and segment lengths. */
export function computeSpeedProfile(curvature: Float64Array, ds: Float64Array): Float64Array {
  const n = curvature.length;
  const limit = new Float64Array(n);
  let start = 0;
  for (let i = 0; i < n; i++) {
    limit[i] = Math.max(MIN_SPEED, cornerSpeedLimit(curvature[i]));
    if (limit[i] < limit[start]) start = i;
  }
  const v = Float64Array.from(limit);
  for (let iter = 0; iter < 12; iter++) {
    let change = 0;
    // forward: acceleration limited by power, drag and remaining grip
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const j = (i + 1) % n;
      const reach = Math.sqrt(v[i] * v[i] + 2 * driveAccel(v[i], Math.abs(curvature[i])) * ds[i]);
      if (reach < v[j]) {
        change = Math.max(change, v[j] - reach);
        v[j] = reach;
      }
    }
    // backward: braking limited by grip (incl. aero) and drag
    for (let k = 0; k < n; k++) {
      const j = (start - k + n) % n;
      const i = (j - 1 + n) % n;
      const reach = Math.sqrt(v[j] * v[j] + 2 * brakeAccel(v[j], Math.abs(curvature[j])) * ds[i]);
      if (reach < v[i]) {
        change = Math.max(change, v[i] - reach);
        v[i] = reach;
      }
    }
    if (change < 1e-6) break;
  }
  for (let i = 0; i < n; i++) v[i] = Math.min(CAR.topSpeed, Math.max(MIN_SPEED, v[i]));
  return v;
}

/**
 * Speed profile (m/s) along an open path that starts at v0 and is free at its end (the same corner limit, power and
 * braking as computeSpeedProfile; samples i → i+1 are ds[i] apart).
 */
export function pathSpeeds(curvature: ArrayLike<number>, ds: ArrayLike<number>, v0: number): Float64Array {
  const n = curvature.length;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.max(MIN_SPEED, cornerSpeedLimit(curvature[i]));
  v[0] = v0;
  for (let i = 0; i + 1 < n; i++) {
    v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] * v[i] + 2 * driveAccel(v[i], Math.abs(curvature[i])) * ds[i]));
  }
  for (let j = n - 1; j > 1; j--) {
    v[j - 1] = Math.min(v[j - 1], Math.sqrt(v[j] * v[j] + 2 * brakeAccel(v[j], Math.abs(curvature[j])) * ds[j - 1]));
  }
  return v;
}

/** Time (s) to drive an open path at the given per-sample speeds (mean speed per segment). */
export function pathTime(speed: ArrayLike<number>, ds: ArrayLike<number>): number {
  let t = 0;
  for (let i = 0; i + 1 < speed.length; i++) t += ds[i] / Math.max(0.1, 0.5 * (speed[i] + speed[i + 1]));
  return t;
}

/** Time (s) to drive the closed path at the given per-sample speeds (mean speed per segment). */
export function lapTime(speed: Float64Array, ds: Float64Array): number {
  const n = speed.length;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vAvg = Math.max(0.1, 0.5 * (speed[i] + speed[j]));
    t += ds[i] / vAvg;
  }
  return t;
}
