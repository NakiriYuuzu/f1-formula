/**
 * Replay recording & playback data (pure). RenderFrames are captured at REPLAY_HZ of simulation time into a
 * bounded ring (oldest dropped after REPLAY_MAX_SECONDS), each packed into one Float32Array to keep long races
 * small. sampleClip() rebuilds an interpolated RenderFrame at any time (positions/angles blended, discrete
 * fields from the nearer frame, no blending across teleports).
 */
import type { CarRenderState, RenderFrame, SurfaceKind, TireCompound, WeatherKind } from '../core/types';
import { angleDiff, clamp, clamp01, lerp, wrapAngle } from '../core/math';

export const REPLAY_HZ = 30;
export const REPLAY_MAX_SECONDS = 15 * 60;
/** Position jump (m) between two recorded frames treated as a teleport (no interpolation). */
const TELEPORT_DISTANCE = 30;

const COMPOUND_CODES: readonly TireCompound[] = ['soft', 'medium', 'hard', 'inter', 'wet'];
const SURFACE_CODES: readonly SurfaceKind[] = ['asphalt', 'kerb', 'grass', 'gravel', 'runoff', 'pitlane'];
const WEATHER_CODES: readonly WeatherKind[] = ['clear', 'overcast', 'lightRain', 'heavyRain'];

// frame header: lights lit, lights out, weather kind, rain, wetness
const HEADER = 5;
// per car
const F_ID = 0;
const F_X = 1;
const F_Y = 2;
const F_Z = 3;
const F_YAW = 4;
const F_PITCH = 5;
const F_ROLL = 6;
const F_SPEED = 7;
const F_STEER = 8;
const F_SPIN = 9;
const F_THROTTLE = 10;
const F_BRAKE = 11;
const F_RPM = 12;
const F_GEAR = 13;
const F_DMG_FRONT = 14;
const F_DMG_REAR = 15;
const F_SLIP = 16;
const F_LOCKUP = 17;
const F_IMPACT = 18;
const F_COMPOUND = 19;
const F_SURFACE = 20;
const F_FLAGS = 21;
const F_DMG_FLOOR = 22;
const F_DMG_SUSPENSION = 23;
const CAR_FIELDS = 24;

const FLAG_DRS = 1;
const FLAG_RAIN = 2;
const FLAG_LIMITER = 4;
const FLAG_BOOST = 8;
const FLAG_VISIBLE = 16;
const FLAG_GHOST = 32;
/** bits 6–7 of the flags: the bent suspension's corner (0..3) */
const CORNER_SHIFT = 6;

/**
 * Layout of encodeFrame's packed array for the online snapshot, which quantises it field by field
 * (src/net/protocol.ts; a field not named here travels as float32).
 */
export const FRAME_LAYOUT = {
  header: HEADER,
  carFields: CAR_FIELDS,
  id: F_ID,
  yaw: F_YAW,
  pitch: F_PITCH,
  roll: F_ROLL,
  speed: F_SPEED,
  steer: F_STEER,
  throttle: F_THROTTLE,
  brake: F_BRAKE,
  rpm: F_RPM,
  gear: F_GEAR,
  damage: [F_DMG_FRONT, F_DMG_REAR, F_DMG_FLOOR, F_DMG_SUSPENSION],
  slip: F_SLIP,
  lockup: F_LOCKUP,
  compound: F_COMPOUND,
  surface: F_SURFACE,
  flags: F_FLAGS,
} as const;

const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

function codeOf<T>(list: readonly T[], value: T): number {
  const i = list.indexOf(value);
  return i < 0 ? 0 : i;
}

function valueOf<T>(list: readonly T[], code: number): T {
  const i = Number.isFinite(code) ? clamp(Math.round(code), 0, list.length - 1) : 0;
  return list[i] as T;
}

/** Pack one RenderFrame (time is stored separately by the recorder). */
export function encodeFrame(frame: RenderFrame): Float32Array {
  const cars = frame.cars ?? [];
  const out = new Float32Array(HEADER + cars.length * CAR_FIELDS);
  out[0] = fin(frame.startLights?.lit ?? 0);
  out[1] = frame.startLights?.out === false ? 0 : 1;
  out[2] = codeOf(WEATHER_CODES, frame.weather?.kind ?? 'clear');
  out[3] = clamp01(fin(frame.weather?.rain ?? 0));
  out[4] = clamp01(fin(frame.weather?.wetness ?? 0));
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i] as CarRenderState;
    const o = HEADER + i * CAR_FIELDS;
    out[o + F_ID] = c.carId;
    out[o + F_X] = fin(c.x);
    out[o + F_Y] = fin(c.y);
    out[o + F_Z] = fin(c.z);
    out[o + F_YAW] = fin(c.yaw);
    out[o + F_PITCH] = fin(c.pitch);
    out[o + F_ROLL] = fin(c.roll);
    out[o + F_SPEED] = fin(c.speed);
    out[o + F_STEER] = fin(c.steerAngle);
    out[o + F_SPIN] = fin(c.wheelSpin);
    out[o + F_THROTTLE] = fin(c.throttle);
    out[o + F_BRAKE] = fin(c.brake);
    out[o + F_RPM] = fin(c.rpm);
    out[o + F_GEAR] = fin(c.gear);
    out[o + F_DMG_FRONT] = fin(c.damage?.frontWing ?? 0);
    out[o + F_DMG_REAR] = fin(c.damage?.rearWing ?? 0);
    out[o + F_DMG_FLOOR] = fin(c.damage?.floor ?? 0);
    out[o + F_DMG_SUSPENSION] = fin(c.damage?.suspension ?? 0);
    out[o + F_SLIP] = fin(c.slip);
    out[o + F_LOCKUP] = fin(c.lockup);
    out[o + F_IMPACT] = fin(c.impact);
    out[o + F_COMPOUND] = codeOf(COMPOUND_CODES, c.compound);
    out[o + F_SURFACE] = codeOf(SURFACE_CODES, c.surface);
    out[o + F_FLAGS] =
      (c.drsOpen ? FLAG_DRS : 0) |
      (c.rainLight ? FLAG_RAIN : 0) |
      (c.limiter ? FLAG_LIMITER : 0) |
      (c.boost ? FLAG_BOOST : 0) |
      (c.visible ? FLAG_VISIBLE : 0) |
      (c.ghost ? FLAG_GHOST : 0) |
      ((fin(c.damage?.corner ?? 0) & 3) << CORNER_SHIFT);
  }
  return out;
}

function carCount(data: Float32Array): number {
  return Math.max(0, Math.floor((data.length - HEADER) / CAR_FIELDS));
}

function decodeCar(a: Float32Array, oa: number, b: Float32Array | null, ob: number, f: number): CarRenderState {
  // discrete fields come from the nearer frame
  const near = b && f >= 0.5 ? b : a;
  const on = b && f >= 0.5 ? ob : oa;
  const flags = near[on + F_FLAGS] ?? 0;
  const v = (field: number): number => {
    const va = fin(a[oa + field] ?? 0);
    return b ? lerp(va, fin(b[ob + field] ?? 0), f) : va;
  };
  const yawA = fin(a[oa + F_YAW] ?? 0);
  const yaw = b ? wrapAngle(yawA + angleDiff(yawA, fin(b[ob + F_YAW] ?? 0)) * f) : yawA;
  return {
    carId: Math.round(fin(a[oa + F_ID] ?? 0)),
    x: v(F_X),
    y: v(F_Y),
    z: v(F_Z),
    yaw,
    pitch: v(F_PITCH),
    roll: v(F_ROLL),
    speed: v(F_SPEED),
    steerAngle: v(F_STEER),
    wheelSpin: v(F_SPIN),
    throttle: v(F_THROTTLE),
    brake: v(F_BRAKE),
    rpm: v(F_RPM),
    gear: Math.round(fin(near[on + F_GEAR] ?? 0)),
    drsOpen: (flags & FLAG_DRS) !== 0,
    compound: valueOf(COMPOUND_CODES, near[on + F_COMPOUND] ?? 0),
    rainLight: (flags & FLAG_RAIN) !== 0,
    limiter: (flags & FLAG_LIMITER) !== 0,
    damage: {
      frontWing: clamp01(v(F_DMG_FRONT)),
      rearWing: clamp01(v(F_DMG_REAR)),
      floor: clamp01(v(F_DMG_FLOOR)),
      suspension: clamp01(v(F_DMG_SUSPENSION)),
      corner: (flags >> CORNER_SHIFT) & 3,
    },
    slip: clamp01(v(F_SLIP)),
    lockup: clamp01(v(F_LOCKUP)),
    impact: Math.max(0, v(F_IMPACT)),
    surface: valueOf(SURFACE_CODES, near[on + F_SURFACE] ?? 0),
    boost: (flags & FLAG_BOOST) !== 0,
    visible: (flags & FLAG_VISIBLE) !== 0,
    ghost: (flags & FLAG_GHOST) !== 0,
  };
}

/** Interpolated frame between packed frames a (f = 0) and b (f = 1); b = null decodes a as is. */
export function decodeFrame(time: number, a: Float32Array, b: Float32Array | null, fIn: number): RenderFrame {
  const f = b ? clamp01(fin(fIn)) : 0;
  const n = carCount(a);
  const nb = b ? carCount(b) : 0;
  const cars: CarRenderState[] = [];
  for (let i = 0; i < n; i++) {
    const o = HEADER + i * CAR_FIELDS;
    if (!b || i >= nb) {
      cars.push(decodeCar(a, o, null, 0, 0));
      continue;
    }
    const sameCar = Math.round(fin(a[o + F_ID] ?? 0)) === Math.round(fin(b[o + F_ID] ?? 0));
    const jump = Math.hypot(fin(b[o + F_X] ?? 0) - fin(a[o + F_X] ?? 0), fin(b[o + F_Z] ?? 0) - fin(a[o + F_Z] ?? 0));
    if (sameCar && jump < TELEPORT_DISTANCE) cars.push(decodeCar(a, o, b, o, f));
    else cars.push(decodeCar(f >= 0.5 ? b : a, o, null, 0, 0));
  }
  const hdr = b && f >= 0.5 ? b : a;
  return {
    time,
    cars,
    startLights: { lit: Math.round(fin(hdr[0] ?? 0)), out: (hdr[1] ?? 1) !== 0 },
    weather: {
      kind: valueOf(WEATHER_CODES, hdr[2] ?? 0),
      rain: b ? clamp01(lerp(fin(a[3] ?? 0), fin(b[3] ?? 0), f)) : clamp01(fin(a[3] ?? 0)),
      wetness: b ? clamp01(lerp(fin(a[4] ?? 0), fin(b[4] ?? 0), f)) : clamp01(fin(a[4] ?? 0)),
    },
  };
}

/** Immutable recorded replay: frames[i] was captured at times[i] (ascending simulation time). */
export interface ReplayClip {
  readonly times: readonly number[];
  readonly frames: readonly Float32Array[];
}

export function clipStart(clip: ReplayClip): number {
  return clip.times.length > 0 ? (clip.times[0] as number) : 0;
}

export function clipDuration(clip: ReplayClip): number {
  const n = clip.times.length;
  return n > 1 ? Math.max(0, (clip.times[n - 1] as number) - (clip.times[0] as number)) : 0;
}

/** Interpolated RenderFrame at absolute simulation time t (clamped to the clip); null for an empty clip. */
export function sampleClip(clip: ReplayClip, t: number): RenderFrame | null {
  const n = Math.min(clip.times.length, clip.frames.length);
  if (n === 0) return null;
  const first = clip.times[0] as number;
  const last = clip.times[n - 1] as number;
  const time = clamp(fin(t, first), first, last);
  if (n === 1 || time <= first) return decodeFrame(first, clip.frames[0] as Float32Array, null, 0);
  if (time >= last) return decodeFrame(last, clip.frames[n - 1] as Float32Array, null, 0);
  // binary search: times[lo] <= time < times[hi]
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((clip.times[mid] as number) <= time) lo = mid;
    else hi = mid;
  }
  const t0 = clip.times[lo] as number;
  const t1 = clip.times[hi] as number;
  const f = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
  return decodeFrame(time, clip.frames[lo] as Float32Array, clip.frames[hi] as Float32Array, f);
}

/** Bounded ring of packed frames captured at a fixed rate of simulation time. */
export class ReplayRecorder {
  private readonly capacity: number;
  private readonly interval: number;
  private frames: (Float32Array | undefined)[];
  private times: Float64Array;
  private head = 0;
  private count = 0;
  private nextAt = Number.NEGATIVE_INFINITY;

  constructor(hz = REPLAY_HZ, maxSeconds = REPLAY_MAX_SECONDS) {
    const rate = Number.isFinite(hz) && hz > 0 ? hz : REPLAY_HZ;
    this.interval = 1 / rate;
    this.capacity = Math.max(2, Math.ceil(rate * (Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : REPLAY_MAX_SECONDS)) + 1);
    this.frames = new Array<Float32Array | undefined>(this.capacity);
    this.times = new Float64Array(this.capacity);
  }

  /** Record a frame if one is due at simulation time `time` (the frame is built lazily). Returns true if stored. */
  maybeRecord(time: number, build: () => RenderFrame): boolean {
    if (!Number.isFinite(time) || time + 1e-9 < this.nextAt) return false;
    const last = this.lastTime;
    if (last !== null && time <= last) return false;
    this.push(time, encodeFrame(build()));
    // steady cadence; after a gap (or the first frame) restart from now instead of bursting to catch up
    this.nextAt += this.interval;
    if (!(this.nextAt > time)) this.nextAt = time + this.interval;
    return true;
  }

  /** Drop every frame recorded after `time` (flashback). */
  truncateAfter(time: number): void {
    while (this.count > 0) {
      const lastIdx = (this.head + this.count - 1) % this.capacity;
      if ((this.times[lastIdx] as number) <= time + 1e-9) break;
      this.frames[lastIdx] = undefined;
      this.count--;
    }
    const last = this.lastTime;
    this.nextAt = last === null ? Number.NEGATIVE_INFINITY : last + this.interval;
  }

  clear(): void {
    this.frames = new Array<Float32Array | undefined>(this.capacity);
    this.head = 0;
    this.count = 0;
    this.nextAt = Number.NEGATIVE_INFINITY;
  }

  get length(): number {
    return this.count;
  }

  get lastTime(): number | null {
    return this.count > 0 ? (this.times[(this.head + this.count - 1) % this.capacity] as number) : null;
  }

  /** Ordered snapshot of the recording (frames are shared, never mutated afterwards). */
  toClip(): ReplayClip {
    const times: number[] = [];
    const frames: Float32Array[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      const f = this.frames[idx];
      if (!f) continue;
      times.push(this.times[idx] as number);
      frames.push(f);
    }
    return { times, frames };
  }

  private push(time: number, data: Float32Array): void {
    if (this.count < this.capacity) {
      const idx = (this.head + this.count) % this.capacity;
      this.frames[idx] = data;
      this.times[idx] = time;
      this.count++;
    } else {
      // full: overwrite the oldest
      this.frames[this.head] = data;
      this.times[this.head] = time;
      this.head = (this.head + 1) % this.capacity;
    }
  }
}
