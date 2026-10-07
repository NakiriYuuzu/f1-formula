/**
 * Speed planning for AI drivers (and the human braking assist): racing-line curvature per track (cached), per-car
 * capability fitted from the physics helpers, and the look-ahead braking target speed at a position.
 *
 * Capability model (per step, from physics):
 *   lateral  a(v) = latA + latB·v²   (steady-state grip incl. downforce, × latFactor)
 *   braking  d(v) = brkA + brkB·v²   (straight-line ABS braking incl. downforce + drag, × brakeFactor)
 * Corner speed at |κ|: v² = latA / (|κ| − latB) (capped). Braking target: backward recurrence over the horizon with
 * the friction circle (braking reduced by the lateral demand of curved samples).
 */
import type { AeroWake, BuiltTrack, CarSpec } from '../core/types';
import { angleDiff, clamp } from '../core/math';
import { maxBrakeDecel, maxLateralAccel } from '../physics/index';

/** Speed cap (m/s) used for straights: above any physical top speed. */
export const SPEED_CAP = 100;
/** Speed used to fit the quadratic aero terms of the capability model (m/s). */
const FIT_SPEED = 80;

interface LineData {
  /** signed curvature (+ right) of the racing line per sample */
  curv: Float64Array;
  /** racing-line path length from sample i to i+1 (m) */
  ds: Float64Array;
}

const lineCache = new WeakMap<BuiltTrack, LineData>();

function smoothLoop(src: Float64Array, radius: number, passes: number): Float64Array {
  const n = src.length;
  let cur = src;
  const span = 2 * radius + 1;
  for (let p = 0; p < passes; p++) {
    const next = new Float64Array(n);
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += cur[(k + n) % n];
    for (let i = 0; i < n; i++) {
      next[i] = sum / span;
      sum += cur[(i + radius + 1) % n] - cur[(i - radius + n) % n];
    }
    cur = next;
  }
  return cur;
}

/** Racing-line geometry of a track (computed once per BuiltTrack, cached). */
export function lineData(track: BuiltTrack): LineData {
  const cached = lineCache.get(track);
  if (cached) return cached;
  const n = track.count;
  const qx = new Float64Array(n);
  const qz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    qx[i] = track.px[i] + track.racingLine[i] * track.rx[i];
    qz[i] = track.pz[i] + track.racingLine[i] * track.rz[i];
  }
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    ds[i] = Math.max(1e-3, Math.hypot(qx[j] - qx[i], qz[j] - qz[i]));
  }
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? n - 1 : i - 1;
    const b = i + 1 === n ? 0 : i + 1;
    const yawIn = Math.atan2(qx[i] - qx[a], qz[i] - qz[a]);
    const yawOut = Math.atan2(qx[b] - qx[i], qz[b] - qz[i]);
    const k = -angleDiff(yawIn, yawOut) / (0.5 * (ds[a] + ds[i]));
    raw[i] = Number.isFinite(k) ? k : 0;
  }
  const data: LineData = { curv: n > 4 ? smoothLoop(raw, 2, 2) : raw, ds };
  lineCache.set(track, data);
  return data;
}

export interface Capability {
  latA: number;
  latB: number;
  brkA: number;
  brkB: number;
}

/** The spec as the air sees it in a wake: drag and front / rear downforce scaled (downforce balance shifts rearward). */
function wakeSpec(spec: CarSpec, wake: AeroWake): CarSpec {
  const f = clamp(wake.frontDownforce, 0.5, 1);
  const r = clamp(wake.rearDownforce, 0.5, 1);
  const front = spec.aeroBalance * f;
  const total = front + (1 - spec.aeroBalance) * r;
  return {
    ...spec,
    dragArea: spec.dragArea * clamp(wake.drag, 0.5, 1),
    downforceArea: spec.downforceArea * total,
    aeroBalance: total > 0 ? front / total : spec.aeroBalance,
  };
}

/**
 * Capability of a car right now. `gripScale` = tyre × rubber × performance grip (1 = fresh dry softs),
 * factors = fraction of the physical limit the driver uses, `wake` = the aero wake it runs in (none = clean air).
 */
export function capability(
  baseSpec: CarSpec,
  gripScale: number,
  fuelKg: number,
  latFactor: number,
  brakeFactor: number,
  wake?: AeroWake,
): Capability {
  const spec = wake && (wake.drag !== 1 || wake.frontDownforce !== 1 || wake.rearDownforce !== 1) ? wakeSpec(baseSpec, wake) : baseSpec;
  const g = Number.isFinite(gripScale) && gripScale > 0 ? gripScale : 1;
  const fuel = Number.isFinite(fuelKg) ? Math.max(0, fuelKg) : 0;
  const lf = Number.isFinite(latFactor) ? Math.max(0.3, latFactor) : 0.9;
  const bf = Number.isFinite(brakeFactor) ? Math.max(0.3, brakeFactor) : 0.85;
  const v2 = FIT_SPEED * FIT_SPEED;
  const lat0 = maxLateralAccel(spec, 0, g, fuel);
  const lat1 = maxLateralAccel(spec, FIT_SPEED, g, fuel);
  const brk0 = maxBrakeDecel(spec, 0, g, fuel);
  const brk1 = maxBrakeDecel(spec, FIT_SPEED, g, fuel);
  return {
    latA: Math.max(1, lat0 * lf),
    latB: Math.max(0, ((lat1 - lat0) / v2) * lf),
    brkA: Math.max(1, brk0 * bf),
    brkB: Math.max(0, ((brk1 - brk0) / v2) * bf),
  };
}

/** Steady-state corner speed (m/s) for curvature κ under a capability. */
export function cornerSpeed(cap: Capability, curvature: number): number {
  const denom = Math.abs(curvature) - cap.latB;
  if (!(denom > 1e-9)) return SPEED_CAP;
  const v = Math.sqrt(cap.latA / denom);
  return v < SPEED_CAP ? v : SPEED_CAP;
}

/** Braking deceleration (m/s², positive) available at speed v on a sample of curvature κ (friction circle). */
export function brakingDecel(cap: Capability, v: number, curvature: number): number {
  const v2 = v * v;
  const total = cap.brkA + cap.brkB * v2;
  const latMax = cap.latA + cap.latB * v2;
  const r = latMax > 0 ? (v2 * Math.abs(curvature)) / latMax : 1;
  // conservative combination: trail-braking at the lateral limit unloads the rear
  const f = r >= 0.95 ? 0.1 : 1 - r * r;
  return total * Math.max(0.1, f);
}

/** Lateral margin (m) between the car centre and the road edge used for driven paths. */
export const PATH_EDGE_MARGIN = 1.15;
/** Sample offset for the three-point curvature of an offset path (±3 samples ≈ ±6 m). */
const CURV_SPAN = 3;

function pathLateral(track: BuiltTrack, i: number, offset: number): number {
  const edge = Math.max(0.5, track.halfWidth[i] - PATH_EDGE_MARGIN);
  const lat = track.racingLine[i] + offset;
  return lat < -edge ? -edge : lat > edge ? edge : lat;
}

/**
 * Curvature (1/m, + right) of the path the car actually drives with a tactical `offset` from the racing line,
 * clamped to the road (an off-line car pinned to the edge through a kink follows a much tighter path).
 */
export function offsetPathCurvature(track: BuiltTrack, i: number, offset: number): number {
  const n = track.count;
  const a = (i - CURV_SPAN + n) % n;
  const c = (i + CURV_SPAN) % n;
  const la = pathLateral(track, a, offset);
  const lb = pathLateral(track, i, offset);
  const lc = pathLateral(track, c, offset);
  const ax = track.px[a] + la * track.rx[a];
  const az = track.pz[a] + la * track.rz[a];
  const bx = track.px[i] + lb * track.rx[i];
  const bz = track.pz[i] + lb * track.rz[i];
  const cx = track.px[c] + lc * track.rx[c];
  const cz = track.pz[c] + lc * track.rz[c];
  const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
  const d = Math.hypot(bx - ax, bz - az) * Math.hypot(cx - bx, cz - bz) * Math.hypot(cx - ax, cz - az);
  const k = d > 1e-9 ? (2 * cross) / d : 0;
  return Number.isFinite(k) ? k : 0;
}

/**
 * Highest speed (m/s) allowed at distance `s` so the car can still slow down for every sample within the braking
 * horizon. `scale` multiplies the corner speeds (e.g. 0.75 for a cool-down lap). `fromCurrentSpeed` sizes the
 * horizon (braking distance from that speed). `offset` (m) = tactical offset from the racing line: when the car is
 * off-line the curvature of its actual (offset, road-clamped) path is used.
 */
export function targetSpeedAt(
  track: BuiltTrack,
  cap: Capability,
  s: number,
  fromCurrentSpeed: number,
  scale = 1,
  offset = 0,
): number {
  const n = track.count;
  if (n < 2) return SPEED_CAP;
  const base = lineData(track);
  const off = Number.isFinite(offset) && Math.abs(offset) > 0.3 ? offset : 0;
  const curvAt = (i: number): number => {
    const kl = base.curv[i];
    if (off === 0) return kl;
    const ko = offsetPathCurvature(track, i, off);
    return Math.abs(ko) > Math.abs(kl) ? ko : kl;
  };
  const ds = base.ds;
  const sp = track.spacing;
  const L = track.length;
  let w = Number.isFinite(s) ? s % L : 0;
  if (w < 0) w += L;
  const u = w / sp;
  const i0 = Math.min(n - 1, Math.floor(u));
  const frac = Math.min(1, Math.max(0, u - i0));
  const v0 = Number.isFinite(fromCurrentSpeed) ? Math.abs(fromCurrentSpeed) : 0;
  const k = Math.max(0.3, Number.isFinite(scale) ? scale : 1);
  const horizon = Math.min(450, Math.max(60, (v0 * v0) / (2 * cap.brkA) + 40));
  const steps = Math.min(n - 1, Math.ceil(horizon / sp));

  let kNext = curvAt((i0 + steps) % n);
  let v = cornerSpeed(cap, kNext) * k;
  for (let step = steps - 1; step >= 1; step--) {
    const i = (i0 + step) % n;
    const ki = curvAt(i);
    const reach = Math.sqrt(v * v + 2 * brakingDecel(cap, v, kNext) * ds[i]);
    const lim = cornerSpeed(cap, ki) * k;
    v = reach < lim ? reach : lim;
    kNext = ki;
  }
  // current position: between i0 and i0 + 1
  const k0 = curvAt(i0);
  const remain = (1 - frac) * ds[i0];
  const reach = Math.sqrt(v * v + 2 * brakingDecel(cap, v, kNext) * remain);
  const lim = cornerSpeed(cap, k0 + (kNext - k0) * frac) * k;
  const out = reach < lim ? reach : lim;
  return Number.isFinite(out) ? out : SPEED_CAP;
}

/** Signed racing-line curvature (+ right) at distance s (nearest sample). */
export function lineCurvatureAt(track: BuiltTrack, s: number): number {
  const n = track.count;
  if (n === 0) return 0;
  let w = Number.isFinite(s) ? s % track.length : 0;
  if (w < 0) w += track.length;
  const i = Math.min(n - 1, Math.round(w / track.spacing) % n);
  return lineData(track).curv[i];
}
