/**
 * Speed planning for AI drivers (and the human braking assist): racing-line curvature per track (cached), per-car
 * capability fitted from the physics helpers, and the look-ahead braking target speed at a position.
 *
 * Capability model (per step, from physics):
 *   lateral  a(v) = latA + latB·v²   (steady-state grip incl. downforce, × latFactor)
 *   braking  d(v) = brkA + brkB·v²   (straight-line ABS braking incl. downforce + drag, × brakeFactor)
 * Corner speed at |κ|: v² = latA / (|κ| − latB) (capped). Braking target: backward recurrence over the horizon with
 * the friction circle (braking reduced by the lateral demand of curved samples; a trail-braking driver keeps more of
 * it). Kerb use: a second minimum-curvature line whose box reaches over the kerbs (cached per track); a driver's line
 * and speed plan blend toward it by its kerb use.
 */
import type { AeroWake, BuiltTrack, CarSpec } from '../core/types';
import { angleDiff, clamp, clamp01 } from '../core/math';
import { maxBrakeDecel, maxLateralAccel } from '../physics/index';
import { RACING_LINE_MARGIN, computeRacingLine, sampleAt } from '../track/track';

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

/**
 * Kerb use: the kerb-use line may run up to min(kerb width, KERB_REACH) × kerb use further out than the racing line's
 * box (RACING_LINE_MARGIN inside the road edge) over a kerb — the car centre stays ≥ 0.4 m inside the white line, so
 * the outer wheels ride the kerb while the inner ones stay on the road (track limits need all four wheels beyond it).
 */
export const KERB_REACH = 0.9;

interface KerbData {
  /** full-kerb-use line minus the racing line (m) per sample */
  delta: Float64Array;
  /** signed curvature (+ right) of the full-kerb-use line per sample, and its path length to the next sample (m) */
  curv: Float64Array;
  ds: Float64Array;
}

const kerbCache = new WeakMap<BuiltTrack, KerbData>();

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

/** Curvature / segment lengths of the path at lateral offsets `lat` (smoothed like the racing line's). */
function pathData(track: BuiltTrack, lat: ArrayLike<number>): LineData {
  const n = track.count;
  const qx = new Float64Array(n);
  const qz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    qx[i] = track.px[i] + lat[i] * track.rx[i];
    qz[i] = track.pz[i] + lat[i] * track.rz[i];
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
  return { curv: n > 4 ? smoothLoop(raw, 2, 2) : raw, ds };
}

/** Racing-line geometry of a track (computed once per BuiltTrack, cached). */
export function lineData(track: BuiltTrack): LineData {
  const cached = lineCache.get(track);
  if (cached) return cached;
  const data = pathData(track, track.racingLine);
  lineCache.set(track, data);
  return data;
}

/** Full-kerb-use line of a track: the minimum-curvature line with its box widened over the kerbs (cached). */
export function kerbData(track: BuiltTrack): KerbData {
  const cached = kerbCache.get(track);
  if (cached) return cached;
  const n = track.count;
  const left = new Float64Array(n);
  const right = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = clamp(Number.isFinite(track.kerbLeft[i]) ? track.kerbLeft[i] : 0, 0, KERB_REACH);
    right[i] = clamp(Number.isFinite(track.kerbRight[i]) ? track.kerbRight[i] : 0, 0, KERB_REACH);
  }
  const line = n > 4 ? computeRacingLine(track.px, track.pz, track.rx, track.rz, track.halfWidth, RACING_LINE_MARGIN, left, right) : track.racingLine;
  const delta = new Float64Array(n);
  for (let i = 0; i < n; i++) delta[i] = Number.isFinite(line[i]) ? line[i] - track.racingLine[i] : 0;
  const path = n > 4 ? pathData(track, line) : lineData(track);
  const data: KerbData = { delta, curv: path.curv, ds: path.ds };
  kerbCache.set(track, data);
  return data;
}

/** Racing line (m, + right) at distance s for a driver's kerb use 0..1 (0 = the plain racing line). */
export function kerbLineAt(track: BuiltTrack, s: number, kerbUse: number): number {
  const line = sampleAt(track, track.racingLine, s);
  const k = clamp01(Number.isFinite(kerbUse) ? kerbUse : 0);
  return k > 0 ? line + k * sampleAt(track, kerbData(track).delta, s) : line;
}

/**
 * How far (m) the driver's own kerb-use line runs beyond the racing line's box on the left / right at distance s: the
 * driven path edge widens by exactly that much there (no extra room for tactical offsets anywhere else). `out` (if
 * given) is filled and returned instead of a new object (per-step callers).
 */
export function kerbReachAt(
  track: BuiltTrack,
  s: number,
  kerbUse: number,
  out: { left: number; right: number } = { left: 0, right: 0 },
): { left: number; right: number } {
  const k = clamp01(Number.isFinite(kerbUse) ? kerbUse : 0);
  if (k <= 0) {
    out.left = 0;
    out.right = 0;
    return out;
  }
  const line = kerbLineAt(track, s, k);
  const box = Math.max(0, sampleAt(track, track.halfWidth, s) - RACING_LINE_MARGIN);
  out.left = Math.max(0, -box - line);
  out.right = Math.max(0, line - box);
  return out;
}

export interface Capability {
  latA: number;
  latB: number;
  brkA: number;
  brkB: number;
  /** trail braking 0..TRAIL_MAX: how far braking under lateral load follows the true friction circle (brakingDecel) */
  trail: number;
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
 * factors = fraction of the physical limit the driver uses, `wake` = the aero wake it runs in (none = clean air),
 * `trail` = trail-braking skill (0 = the conservative friction circle).
 */
export function capability(
  baseSpec: CarSpec,
  gripScale: number,
  fuelKg: number,
  latFactor: number,
  brakeFactor: number,
  wake?: AeroWake,
  trail = 0,
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
    trail: Number.isFinite(trail) ? clamp(trail, 0, 1) : 0,
  };
}

/** Steady-state corner speed (m/s) for curvature κ under a capability. */
export function cornerSpeed(cap: Capability, curvature: number): number {
  const denom = Math.abs(curvature) - cap.latB;
  if (!(denom > 1e-9)) return SPEED_CAP;
  const v = Math.sqrt(cap.latA / denom);
  return v < SPEED_CAP ? v : SPEED_CAP;
}

/**
 * Braking deceleration (m/s², positive) available at speed v on a sample of curvature κ (friction circle). With
 * r = lateral use, the share of braking kept is 1 − r² (conservative: trail-braking at the lateral limit unloads the
 * rear) blended toward the true circle √(1 − r²) by `cap.trail`; at least 0.1.
 */
export function brakingDecel(cap: Capability, v: number, curvature: number): number {
  const v2 = v * v;
  const total = cap.brkA + cap.brkB * v2;
  const latMax = cap.latA + cap.latB * v2;
  const r = latMax > 0 ? (v2 * Math.abs(curvature)) / latMax : 1;
  const q = r >= 1 ? 0 : 1 - r * r;
  const trail = cap.trail > 0 ? cap.trail : 0;
  const f = trail > 0 ? q + trail * (Math.sqrt(q) - q) : q;
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
 * Optional read-out of targetSpeedAt's plan further ahead (no second horizon scan): `ahead` (m, input) beyond the
 * queried position → `speed` (m/s, output), the highest speed planned at the sample there (SPEED_CAP when invalid).
 */
export interface SpeedProbe {
  ahead: number;
  speed: number;
}

/** Curvature of the driven path at sample i: the kerb-use blend of the line, or the offset path when tighter. */
function pathCurvature(track: BuiltTrack, base: LineData, kerb: KerbData | null, ku: number, off: number, i: number): number {
  const kl = kerb ? base.curv[i] + ku * (kerb.curv[i] - base.curv[i]) : base.curv[i];
  if (off === 0) return kl;
  const ko = offsetPathCurvature(track, i, off);
  return Math.abs(ko) > Math.abs(kl) ? ko : kl;
}

/**
 * Highest speed (m/s) allowed at distance `s` so the car can still slow down for every sample within the braking
 * horizon. `scale` multiplies the corner speeds (e.g. 0.75 for a cool-down lap). `fromCurrentSpeed` sizes the
 * horizon (braking distance from that speed). `offset` (m) = tactical offset from the racing line: when the car is
 * off-line the curvature of its actual (offset, road-clamped) path is used. `kerbUse` (0..1) = the driver's line
 * blends toward the kerb-use line (its curvature blended alike). `probe` (optional) reads the same plan `probe.ahead`
 * m further on (e.g. "is braking due within half a second" — no second scan; within the horizon a scan from there
 * would find the same braking need, short of rounding to a sample).
 */
export function targetSpeedAt(
  track: BuiltTrack,
  cap: Capability,
  s: number,
  fromCurrentSpeed: number,
  scale = 1,
  offset = 0,
  kerbUse = 0,
  probe?: SpeedProbe,
): number {
  const n = track.count;
  if (probe) probe.speed = SPEED_CAP;
  if (n < 2) return SPEED_CAP;
  const base = lineData(track);
  const off = Number.isFinite(offset) && Math.abs(offset) > 0.3 ? offset : 0;
  const ku = Number.isFinite(kerbUse) ? clamp01(kerbUse) : 0;
  const kerb = ku > 0 ? kerbData(track) : null;
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
  const probeAhead = probe && Number.isFinite(probe.ahead) ? Math.max(0, probe.ahead) : 0;
  const horizon = Math.min(450, Math.max(60, (v0 * v0) / (2 * cap.brkA) + 40));
  const steps = Math.min(n - 1, Math.ceil(horizon / sp));
  // the sample the probe reads (step 0 = the queried position itself; beyond the horizon: its last sample)
  const at = probe ? Math.round(frac + probeAhead / sp) : -1;

  let kNext = pathCurvature(track, base, kerb, ku, off, (i0 + steps) % n);
  let v = cornerSpeed(cap, kNext) * k;
  if (probe && at >= steps) probe.speed = v;
  for (let step = steps - 1; step >= 1; step--) {
    const i = (i0 + step) % n;
    const ki = pathCurvature(track, base, kerb, ku, off, i);
    const dsi = kerb ? ds[i] + ku * (kerb.ds[i] - ds[i]) : ds[i];
    const reach = Math.sqrt(v * v + 2 * brakingDecel(cap, v, kNext) * dsi);
    const lim = cornerSpeed(cap, ki) * k;
    v = reach < lim ? reach : lim;
    kNext = ki;
    if (step === at && probe) probe.speed = v;
  }
  // current position: between i0 and i0 + 1
  const k0 = pathCurvature(track, base, kerb, ku, off, i0);
  const remain = (1 - frac) * (kerb ? ds[i0] + ku * (kerb.ds[i0] - ds[i0]) : ds[i0]);
  const reach = Math.sqrt(v * v + 2 * brakingDecel(cap, v, kNext) * remain);
  const lim = cornerSpeed(cap, k0 + (kNext - k0) * frac) * k;
  const out = reach < lim ? reach : lim;
  const res = Number.isFinite(out) ? out : SPEED_CAP;
  if (probe && at === 0) probe.speed = res;
  if (probe && !Number.isFinite(probe.speed)) probe.speed = SPEED_CAP;
  return res;
}

/** Signed racing-line curvature (+ right) at distance s (nearest sample); `kerbUse` blends toward the kerb-use line. */
export function lineCurvatureAt(track: BuiltTrack, s: number, kerbUse = 0): number {
  const n = track.count;
  if (n === 0) return 0;
  let w = Number.isFinite(s) ? s % track.length : 0;
  if (w < 0) w += track.length;
  const i = Math.min(n - 1, Math.round(w / track.spacing) % n);
  const k = lineData(track).curv[i];
  const ku = Number.isFinite(kerbUse) ? clamp01(kerbUse) : 0;
  return ku > 0 ? k + ku * (kerbData(track).curv[i] - k) : k;
}
