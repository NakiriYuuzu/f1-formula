/**
 * Wire formats of the online mode (docs/plans/phase3-online.md §2):
 * - input packets (client → host, 'state'): the last INPUT_REDUNDANCY input records of the client's fixed steps,
 *   quantised (throttle / brake uint8, steer int8) with cumulative one-shot counters (a lost or repeated packet never
 *   drops or repeats a gear shift: the host fires on a counter change);
 * - snapshots (host → client, 'state'), two datagrams of one packet each (ONE_PACKET_BYTES) with the receiver's
 *   snapshot seq: the frame (the packed render frame of every car, src/app/replay.ts encoding, quantised field by
 *   field, plus ground pitch, safety car pose, marshal panels) and the own state (the receiver's car's authoritative
 *   physics state, float64, right after the last input seq the host's state is final for — later ones may still be
 *   replayed — with its host time);
 * - reliable messages (JSON): lobby, session start, events, commands, HUD mirror patches, results, pause, departures.
 * Every decoder returns null for a malformed payload (wrong length / type, non-finite numbers).
 */
import type {
  CarPhysicsState,
  ControlInput,
  ErsMode,
  GameEvent,
  PlayerIndex,
  RaceControlMode,
  RenderFrame,
  SessionConfig,
  SessionResult,
  SessionRules,
  TireCompound,
} from '../core/types';
import { FRAME_LAYOUT, decodeFrame, encodeFrame } from '../app/replay';
import { wrapAngle } from '../core/math';

export const PROTOCOL_VERSION = 4;

// ───────────────────────────── sequence numbers ─────────────────────────────

export const SEQ_MOD = 0x10000;

/** a is newer than b (uint16 wrap-around). */
export function seqNewer(a: number, b: number): boolean {
  const d = (a - b + SEQ_MOD) % SEQ_MOD;
  return d > 0 && d < SEQ_MOD / 2;
}

export const nextSeq = (s: number): number => (s + 1) % SEQ_MOD;

// ───────────────────────────── inputs ─────────────────────────────

/** One-shot actions as cumulative uint8 counters, in this order. */
export const ONE_SHOTS = ['shiftUp', 'shiftDown', 'drsPressed', 'ersCycle', 'limiterToggle'] as const;
export type OneShot = (typeof ONE_SHOTS)[number];

export interface InputRecord {
  seq: number;
  /** quantised: throttle / brake 0..255, steer −127..127 */
  throttle: number;
  brake: number;
  steer: number;
  overtake: boolean;
  /** cumulative counters (mod 256) of ONE_SHOTS */
  counters: number[];
}

export const INPUT_REDUNDANCY = 6;
const INPUT_TYPE = 1;
const RECORD_BYTES = 11;

const clampInt = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : 0);

/** Quantise a control input into a record (counters already advanced by the caller). */
export function quantizeInput(seq: number, input: ControlInput, counters: readonly number[]): InputRecord {
  return {
    seq: ((seq % SEQ_MOD) + SEQ_MOD) % SEQ_MOD,
    throttle: clampInt(input.throttle * 255, 0, 255),
    brake: clampInt(input.brake * 255, 0, 255),
    steer: clampInt(input.steer * 127, -127, 127),
    overtake: input.overtakeHeld === true,
    counters: ONE_SHOTS.map((_, i) => ((counters[i] ?? 0) & 0xff) >>> 0),
  };
}

/** Continuous part of a record as a ControlInput (one-shots false: see oneShotsBetween). */
export function recordToInput(r: InputRecord): ControlInput {
  return {
    throttle: r.throttle / 255,
    brake: r.brake / 255,
    steer: r.steer / 127,
    shiftUp: false,
    shiftDown: false,
    drsPressed: false,
    ersCycle: false,
    limiterToggle: false,
    overtakeHeld: r.overtake,
  };
}

/** One-shots that fired between two counter sets (each at most once per step). */
export function oneShotsBetween(prev: readonly number[], next: readonly number[]): Record<OneShot, boolean> {
  const out = {} as Record<OneShot, boolean>;
  ONE_SHOTS.forEach((k, i) => {
    out[k] = ((next[i] ?? 0) & 0xff) !== ((prev[i] ?? 0) & 0xff);
  });
  return out;
}

/** Input packet: records newest first. */
export function encodeInputPacket(records: readonly InputRecord[]): ArrayBuffer {
  const n = Math.min(255, records.length);
  const buf = new ArrayBuffer(2 + n * RECORD_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, INPUT_TYPE);
  v.setUint8(1, n);
  for (let i = 0; i < n; i++) {
    const r = records[i] as InputRecord;
    const o = 2 + i * RECORD_BYTES;
    v.setUint16(o, r.seq & 0xffff);
    v.setUint8(o + 2, clampInt(r.throttle, 0, 255));
    v.setUint8(o + 3, clampInt(r.brake, 0, 255));
    v.setInt8(o + 4, clampInt(r.steer, -127, 127));
    v.setUint8(o + 5, r.overtake ? 1 : 0);
    for (let k = 0; k < ONE_SHOTS.length; k++) v.setUint8(o + 6 + k, (r.counters[k] ?? 0) & 0xff);
  }
  return buf;
}

export function decodeInputPacket(data: unknown): InputRecord[] | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 2) return null;
  const v = new DataView(data);
  if (v.getUint8(0) !== INPUT_TYPE) return null;
  const n = v.getUint8(1);
  if (n === 0 || data.byteLength !== 2 + n * RECORD_BYTES) return null;
  const out: InputRecord[] = [];
  for (let i = 0; i < n; i++) {
    const o = 2 + i * RECORD_BYTES;
    const steer = v.getInt8(o + 4);
    if (steer < -127) return null;
    out.push({
      seq: v.getUint16(o),
      throttle: v.getUint8(o + 2),
      brake: v.getUint8(o + 3),
      steer,
      overtake: (v.getUint8(o + 5) & 1) === 1,
      counters: ONE_SHOTS.map((_, k) => v.getUint8(o + 6 + k)),
    });
  }
  return out;
}

// ───────────────────────────── snapshots ─────────────────────────────

/**
 * Largest message (bytes) that still goes in one packet: a WebRTC data channel puts about 1150 bytes of a message in
 * one SCTP packet. A message split over several is lost with any one of them, so each half of a snapshot fits one.
 */
export const ONE_PACKET_BYTES = 1150;

const SNAPSHOT_TYPE = 2;
const OWN_TYPE = 3;
const MODES: readonly RaceControlMode[] = ['green', 'formation', 'vsc', 'vscEnding', 'sc', 'scEnding', 'red'];
/** type, flags, seq, tick, time, cars, fields per car */
const SNAP_HEADER = 1 + 1 + 2 + 4 + 8 + 1 + 1;
const FLAG_SC = 1;
const SC_FIELDS = 8;

/**
 * The frame part of a snapshot, the same for every receiver: the packed render frame of every car (src/app/replay.ts)
 * quantised field by field (CAR_CODECS), ground pitch, safety car pose, marshal panels. The receiver's own car goes
 * beside it in an OwnState with the same seq.
 */
export interface Snapshot {
  /** the receiver's snapshot seq (uint16, one per snapshot sent to it: a gap is a datagram lost on the way) */
  seq: number;
  tick: number;
  time: number;
  frame: RenderFrame;
}

/** One packed frame field on the wire. */
interface FieldCodec {
  bytes: number;
  put(v: DataView, o: number, x: number): void;
  get(v: DataView, o: number): number;
}

const F32: FieldCodec = { bytes: 4, put: (v, o, x) => v.setFloat32(o, x), get: (v, o) => v.getFloat32(o) };
const U8: FieldCodec = { bytes: 1, put: (v, o, x) => v.setUint8(o, clampInt(x, 0, 255)), get: (v, o) => v.getUint8(o) };
const I8: FieldCodec = { bytes: 1, put: (v, o, x) => v.setInt8(o, clampInt(x, -128, 127)), get: (v, o) => v.getInt8(o) };
const U16: FieldCodec = { bytes: 2, put: (v, o, x) => v.setUint16(o, clampInt(x, 0, 0xffff)), get: (v, o) => v.getUint16(o) };
/** int16 in steps of 1 / scale */
const i16 = (scale: number): FieldCodec => ({
  bytes: 2,
  put: (v, o, x) => v.setInt16(o, clampInt(x * scale, -32767, 32767)),
  get: (v, o) => v.getInt16(o) / scale,
});
/** 0..1 in 1/255 steps */
const UNIT: FieldCodec = { bytes: 1, put: (v, o, x) => v.setUint8(o, clampInt(x * 255, 0, 255)), get: (v, o) => v.getUint8(o) / 255 };
/** 0..1 damage in 1/255 steps: a scratch never reads as intact */
const DAMAGE: FieldCodec = {
  bytes: 1,
  put: (v, o, x) => v.setUint8(o, x > 0 ? clampInt(x * 255, 1, 255) : 0),
  get: (v, o) => v.getUint8(o) / 255,
};
/** heading, wrapped to ±π in 0.1 mrad steps (the client reads headings with angleDiff / wrapAngle only) */
const HEADING: FieldCodec = {
  bytes: 2,
  put: (v, o, x) => v.setInt16(o, clampInt((wrapAngle(Number.isFinite(x) ? x : 0) / Math.PI) * 32767, -32767, 32767)),
  get: (v, o) => (v.getInt16(o) / 32767) * Math.PI,
};
/** small angles (rad: pitch, roll, steering, ground pitch) in 0.1 mrad steps, ±3.2 rad */
const ANGLE = i16(10_000);

/** Codec of each packed car field: positions, wheel spin, impact (and any field added later) stay float32. */
const CAR_CODECS: readonly FieldCodec[] = (() => {
  const L = FRAME_LAYOUT;
  const c: FieldCodec[] = Array.from({ length: L.carFields }, () => F32);
  c[L.id] = U8;
  c[L.yaw] = HEADING;
  c[L.pitch] = ANGLE;
  c[L.roll] = ANGLE;
  c[L.steer] = ANGLE;
  // m/s in 1 cm/s steps
  c[L.speed] = i16(100);
  c[L.throttle] = UNIT;
  c[L.brake] = UNIT;
  c[L.slip] = UNIT;
  c[L.lockup] = UNIT;
  c[L.rpm] = U16;
  c[L.gear] = I8;
  for (const f of L.damage) c[f] = DAMAGE;
  c[L.compound] = U8;
  c[L.surface] = U8;
  c[L.flags] = U8;
  return c;
})();
/** bytes per car: its fields and its ground pitch */
const CAR_BYTES = CAR_CODECS.reduce((n, c) => n + c.bytes, 0) + ANGLE.bytes;

const finiteOr = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);

const snapshotBytes = (cars: number, sc: boolean): number => SNAP_HEADER + FRAME_LAYOUT.header * 4 + cars * CAR_BYTES + (sc ? SC_FIELDS * 4 : 0) + 4;

export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  const L = FRAME_LAYOUT;
  const packed = encodeFrame(s.frame);
  const n = Math.min(255, Math.max(0, Math.floor((packed.length - L.header) / L.carFields)));
  const cars = s.frame.cars ?? [];
  const sc = s.frame.safetyCar ?? null;
  const rc = s.frame.raceControl;
  const buf = new ArrayBuffer(snapshotBytes(n, sc !== null));
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o++, SNAPSHOT_TYPE);
  v.setUint8(o++, sc ? FLAG_SC : 0);
  v.setUint16(o, s.seq & 0xffff);
  o += 2;
  v.setUint32(o, s.tick >>> 0);
  o += 4;
  v.setFloat64(o, finiteOr(s.time));
  o += 8;
  v.setUint8(o++, n);
  v.setUint8(o++, L.carFields);
  for (let i = 0; i < L.header; i++, o += 4) v.setFloat32(o, packed[i] as number);
  for (let i = 0; i < n; i++) {
    const base = L.header + i * L.carFields;
    for (let f = 0; f < L.carFields; f++) {
      const c = CAR_CODECS[f] as FieldCodec;
      c.put(v, o, packed[base + f] as number);
      o += c.bytes;
    }
    ANGLE.put(v, o, finiteOr(cars[i]?.groundPitch ?? 0));
    o += ANGLE.bytes;
  }
  if (sc) {
    for (const x of [sc.x, sc.y, sc.z, sc.yaw, sc.pitch ?? 0, sc.speed, sc.wheelSpin, sc.lightsOn ? 1 : 0]) {
      v.setFloat32(o, finiteOr(x));
      o += 4;
    }
  }
  v.setUint8(o++, rc ? Math.max(0, MODES.indexOf(rc.mode)) : 0);
  for (let k = 0; k < 3; k++) v.setUint8(o++, Math.max(0, Math.min(2, Math.round(rc?.sectorFlags[k] ?? 0))));
  return buf;
}

export function decodeSnapshot(data: unknown): Snapshot | null {
  const L = FRAME_LAYOUT;
  if (!(data instanceof ArrayBuffer) || data.byteLength < snapshotBytes(0, false)) return null;
  const v = new DataView(data);
  let o = 0;
  if (v.getUint8(o++) !== SNAPSHOT_TYPE) return null;
  const flags = v.getUint8(o++);
  const seq = v.getUint16(o);
  o += 2;
  const tick = v.getUint32(o);
  o += 4;
  const time = v.getFloat64(o);
  o += 8;
  const n = v.getUint8(o++);
  // (a peer with another frame layout is another build: the lobby refuses it by PROTOCOL_VERSION)
  if (v.getUint8(o++) !== L.carFields || !Number.isFinite(time) || data.byteLength !== snapshotBytes(n, (flags & FLAG_SC) !== 0)) return null;
  const packed = new Float32Array(L.header + n * L.carFields);
  for (let i = 0; i < L.header; i++, o += 4) packed[i] = v.getFloat32(o);
  const groundPitch: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = L.header + i * L.carFields;
    for (let f = 0; f < L.carFields; f++) {
      const c = CAR_CODECS[f] as FieldCodec;
      packed[base + f] = c.get(v, o);
      o += c.bytes;
    }
    groundPitch.push(ANGLE.get(v, o));
    o += ANGLE.bytes;
  }
  for (const x of packed) if (!Number.isFinite(x)) return null;
  const frame = decodeFrame(time, packed, null, 0);
  frame.cars.forEach((c, i) => ((c as { groundPitch?: number }).groundPitch = groundPitch[i] ?? 0));
  if (flags & FLAG_SC) {
    const f: number[] = [];
    for (let k = 0; k < SC_FIELDS; k++, o += 4) f.push(v.getFloat32(o));
    if (f.some((x) => !Number.isFinite(x))) return null;
    frame.safetyCar = { x: f[0]!, y: f[1]!, z: f[2]!, yaw: f[3]!, pitch: f[4]!, speed: f[5]!, wheelSpin: f[6]!, lightsOn: f[7]! > 0.5 };
  } else frame.safetyCar = null;
  const mode = MODES[v.getUint8(o++)] ?? 'green';
  const sectorFlags = [v.getUint8(o++), v.getUint8(o++), v.getUint8(o++)].map((x) => Math.min(2, x));
  frame.raceControl = { mode, sectorFlags };
  return { seq, tick, time, frame };
}

/** The receiver's car as the host has it, right after the last input the host's state is final for. */
export interface OwnState {
  /** seq of the snapshot it goes with */
  seq: number;
  /** the receiver's last input seq the state is final for (null: none yet) */
  ack: number | null;
  carId: number;
  /** host time of this state (earlier than the snapshot's while the host still guesses later inputs) */
  time: number;
  phys: CarPhysicsState;
}

/**
 * The leaves of CarPhysicsState sent in binary, by dotted path: numbers as float64 (the client predicts on from
 * exactly the host's state), flags as bits, texts as UTF-8. A leaf not listed here, or holding another kind of value,
 * goes as JSON behind them, so the state always arrives whole (a test lists the leaves of real states: add new ones).
 */
const OWN_NUMBERS: readonly string[] = [
  'x', 'y', 'z', 'yaw', 'pitch', 'roll', 'vx', 'vz', 'yawRate', 'speed', 'vLong', 'vLat', 'steerAngle', 'throttle', 'brake',
  'gear', 'rpm', 'wheelSpin', 'slipAngleFront', 'slipAngleRear', 'slipRatio', 'lockup', 'gLat', 'gLong',
  'tire.wear', 'tire.temp', 'tire.laps', 'fuelKg', 'ers.charge', 'ers.deployedLap', 'ers.harvestedLap',
  'damage.frontWing', 'damage.rearWing', 'damage.floor', 'damage.suspension', 'impact', 'trackIndex', 's', 'lateral',
  'internal.shiftTimer', 'internal.shiftCooldown', 'internal.brakeHoldTime', 'internal.accelLong', 'internal.accelLat',
  'internal.fyFront', 'internal.fyRear', 'internal.spin', 'internal.odometer', 'internal.ersDeployW',
  'internal.ersHarvestW', 'internal.icePowerW',
];
const OWN_FLAGS: readonly string[] = [
  'ers.overtakeAvailable', 'ers.overtakeActive', 'drs.eligible', 'drs.available', 'drs.open', 'limiter',
  'internal.held', 'internal.revDriven', 'internal.revArmed',
];
const OWN_TEXTS: readonly string[] = ['tire.compound', 'ers.mode', 'surface'];
const OWN_LEAVES: readonly [string, 'number' | 'boolean' | 'string'][] = [
  ...OWN_NUMBERS.map((p) => [p, 'number'] as [string, 'number']),
  ...OWN_FLAGS.map((p) => [p, 'boolean'] as [string, 'boolean']),
  ...OWN_TEXTS.map((p) => [p, 'string'] as [string, 'string']),
];
/** one bit per OWN_LEAVES entry: present in binary */
const OWN_MASK_BYTES = Math.ceil(OWN_LEAVES.length / 8);
const OWN_FLAG_BYTES = Math.ceil(OWN_FLAGS.length / 8);
/** type, flags, seq, ack, car id, time, present leaves */
const OWN_HEADER = 1 + 1 + 2 + 2 + 2 + 8 + OWN_MASK_BYTES;
const OWN_FLAG_ACK = 1;
/** numbers without which it is no car state */
const OWN_REQUIRED = ['x', 'y', 'z', 'yaw', 'vx', 'vz', 'speed', 'gear', 'rpm', 'fuelKg'];
const OWN_PARTS = ['tire', 'ers', 'drs', 'damage', 'internal'];

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** The leaves of a state by dotted path (plain objects are walked, anything else is a leaf). */
export function stateLeaves(obj: Record<string, unknown>, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [k, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObj(val)) stateLeaves(val, path, out);
    else out.set(path, val);
  }
  return out;
}

/** Leaves of an own state that do not travel in binary (JSON behind it): none for the states the physics makes. */
export function ownStateExtras(phys: CarPhysicsState): string[] {
  const leaves = stateLeaves(phys as unknown as Record<string, unknown>);
  for (const [path, kind] of OWN_LEAVES) if (binaryLeaf(leaves.get(path), kind)) leaves.delete(path);
  return [...leaves].filter(([, val]) => val !== undefined).map(([path]) => path);
}

function binaryLeaf(val: unknown, kind: 'number' | 'boolean' | 'string'): boolean {
  return typeof val === kind && (kind !== 'string' || utf8.encode(val as string).length <= 255);
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function setPath(obj: Record<string, unknown>, path: string, val: unknown): boolean {
  const keys = path.split('.');
  if (keys.some((k) => k === '' || UNSAFE_KEYS.has(k))) return false;
  let at = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i] as string;
    const next = at[k];
    if (isObj(next)) at = next;
    else {
      const made: Record<string, unknown> = {};
      at[k] = made;
      at = made;
    }
  }
  at[keys[keys.length - 1] as string] = val;
  return true;
}

export function encodeOwnState(s: OwnState): ArrayBuffer {
  const leaves = stateLeaves(s.phys as unknown as Record<string, unknown>);
  const mask = new Uint8Array(OWN_MASK_BYTES);
  const numbers: number[] = [];
  const flagBits = new Uint8Array(OWN_FLAG_BYTES);
  const texts: Uint8Array[] = [];
  OWN_LEAVES.forEach(([path, kind], i) => {
    const val = leaves.get(path);
    if (!binaryLeaf(val, kind)) return;
    leaves.delete(path);
    mask[i >> 3]! |= 1 << (i & 7);
    if (kind === 'number') numbers.push(val as number);
    else if (kind === 'string') texts.push(utf8.encode(val as string));
    else if (val) {
      const k = i - OWN_NUMBERS.length;
      flagBits[k >> 3]! |= 1 << (k & 7);
    }
  });
  const rest: Record<string, unknown> = {};
  for (const [path, val] of leaves) if (val !== undefined) rest[path] = val;
  const extra = Object.keys(rest).length > 0 ? utf8.encode(JSON.stringify(rest)) : new Uint8Array(0);
  const size = OWN_HEADER + numbers.length * 8 + OWN_FLAG_BYTES + texts.reduce((n, t) => n + 1 + t.length, 0) + 2 + extra.length;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  v.setUint8(o++, OWN_TYPE);
  v.setUint8(o++, s.ack !== null ? OWN_FLAG_ACK : 0);
  v.setUint16(o, s.seq & 0xffff);
  o += 2;
  v.setUint16(o, (s.ack ?? 0) & 0xffff);
  o += 2;
  v.setUint16(o, clampInt(s.carId, 0, 0xffff));
  o += 2;
  v.setFloat64(o, s.time);
  o += 8;
  bytes.set(mask, o);
  o += OWN_MASK_BYTES;
  for (const x of numbers) {
    v.setFloat64(o, x);
    o += 8;
  }
  bytes.set(flagBits, o);
  o += OWN_FLAG_BYTES;
  for (const t of texts) {
    v.setUint8(o++, t.length);
    bytes.set(t, o);
    o += t.length;
  }
  v.setUint16(o, extra.length);
  o += 2;
  bytes.set(extra, o);
  return buf;
}

export function decodeOwnState(data: unknown): OwnState | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength < OWN_HEADER + OWN_FLAG_BYTES + 2) return null;
  const end = data.byteLength;
  const v = new DataView(data);
  let o = 0;
  if (v.getUint8(o++) !== OWN_TYPE) return null;
  const flags = v.getUint8(o++);
  const seq = v.getUint16(o);
  o += 2;
  const ack = v.getUint16(o);
  o += 2;
  const carId = v.getUint16(o);
  o += 2;
  const time = v.getFloat64(o);
  o += 8;
  const mask = new Uint8Array(data, o, OWN_MASK_BYTES);
  o += OWN_MASK_BYTES;
  const has = (i: number): boolean => ((mask[i >> 3] ?? 0) & (1 << (i & 7))) !== 0;
  const phys: Record<string, unknown> = {};
  let i = 0;
  for (const path of OWN_NUMBERS) {
    if (!has(i++)) continue;
    if (o + 8 > end) return null;
    setPath(phys, path, v.getFloat64(o));
    o += 8;
  }
  if (o + OWN_FLAG_BYTES > end) return null;
  OWN_FLAGS.forEach((path, k) => {
    if (has(i + k)) setPath(phys, path, ((v.getUint8(o + (k >> 3)) >> (k & 7)) & 1) === 1);
  });
  i += OWN_FLAGS.length;
  o += OWN_FLAG_BYTES;
  for (const path of OWN_TEXTS) {
    if (!has(i++)) continue;
    if (o + 1 > end) return null;
    const n = v.getUint8(o++);
    if (o + n > end) return null;
    setPath(phys, path, fromUtf8.decode(new Uint8Array(data, o, n)));
    o += n;
  }
  if (o + 2 > end) return null;
  const extraLength = v.getUint16(o);
  o += 2;
  if (o + extraLength !== end) return null;
  if (extraLength > 0) {
    let rest: unknown;
    try {
      rest = JSON.parse(fromUtf8.decode(new Uint8Array(data, o, extraLength)));
    } catch {
      return null;
    }
    if (!isObj(rest)) return null;
    for (const [path, val] of Object.entries(rest)) if (!setPath(phys, path, val)) return null;
  }
  if (!Number.isFinite(time) || !OWN_REQUIRED.every((k) => isNum(phys[k])) || !OWN_PARTS.every((k) => isObj(phys[k]))) return null;
  return { seq, ack: flags & OWN_FLAG_ACK ? ack : null, carId, time, phys: phys as unknown as CarPhysicsState };
}

// ───────────────────────────── reliable messages ─────────────────────────────

/** Lobby seat as everyone sees it. */
export interface LobbyPlayer {
  playerIndex: PlayerIndex;
  name: string;
  teamId: string;
  driverId: string;
  ready: boolean;
  /** round trip to the host (ms; host: 0) */
  ping: number;
  connected: boolean;
  /** the player races as their own driver / My Team (meta/onlineEntry.ts); absent: the roster driver */
  entry?: LobbyEntry;
  /** guest: `seq` of its last pick the host has handled, taken or refused (the guest sees which it was) */
  pickSeq?: number;
}

/** A player's own driver / team as the lobby lists it: a driver in `driverId`'s seat, or a team in `teamId`'s place. */
export interface LobbyEntry {
  kind: 'driver' | 'team';
  /** driver entry: the save it comes from */
  source?: 'career' | 'myTeamDriver';
  /** driver display name */
  driver: string;
  /** team entry: its name and #rrggbb colour */
  team?: string;
  color?: string;
}

/** Race settings the host picks in the lobby. */
export interface LobbySettings {
  layoutId: string;
  /** race laps */
  laps: number;
  weather: string;
  aiCount: number;
  aiDifficulty: number;
  regulation: string;
  format: string;
  rules: LobbyRules;
}

/** Race-control rules the host picks in the lobby (the other session rules stay at their defaults online). */
export type LobbyRules = Required<Pick<SessionRules, 'safetyCar' | 'redFlags' | 'formationLap' | 'aeroWake'>>;

/** The host's roster as the lobby lists it (the session config carries the full definitions). */
export interface LobbyRoster {
  teams: { id: string; name: string; color: string }[];
  drivers: { id: string; name: string; teamId: string }[];
}

export interface LobbyState {
  code: string;
  players: LobbyPlayer[];
  settings: LobbySettings;
  roster: LobbyRoster;
}

export type ClientCommand =
  | { cmd: 'pit'; compound: TireCompound }
  | { cmd: 'cancelPit' }
  | { cmd: 'ers'; mode: ErsMode }
  | { cmd: 'retire' };

export type NetMessage =
  /** client → host on connect */
  | { t: 'join'; version: number; name: string }
  /** host → client: refused (full / version / started) */
  | { t: 'reject'; reason: string }
  /** host → client: your seat */
  | { t: 'welcome'; playerIndex: PlayerIndex }
  | { t: 'lobby'; lobby: LobbyState }
  /** client → host: choices (setup / assists: the host runs this car's physics with them; entry: what the guest races as, absent = unchanged) */
  | { t: 'pick'; teamId: string; driverId: string; setup?: unknown; assists?: unknown; entry?: unknown; seq?: number }
  | { t: 'ready'; ready: boolean }
  /** host → all: a session begins (every player builds the same world from the config) */
  | { t: 'start'; session: number; config: SessionConfig; final: boolean }
  /** host → client: game events of a session in order */
  | { t: 'events'; session: number; seq: number; events: GameEvent[] }
  /** host → client: HUD mirror patch of a session (first one complete) */
  | { t: 'mirror'; session: number; seq: number; patch: unknown }
  | { t: 'cmd'; session: number; command: ClientCommand }
  /** host → all: the session ended with this classification */
  | { t: 'result'; session: number; result: SessionResult; final: boolean }
  | { t: 'pause'; paused: boolean }
  /** host → all: a player left (its car is now driven by the AI) */
  | { t: 'left'; playerIndex: PlayerIndex; name: string }
  /** round-trip probe; in a session the host adds every player's last round trip (ms) by playerIndex (null: none) */
  | { t: 'ping'; at: number; pings?: (number | null)[] }
  | { t: 'pong'; at: number }
  /** host → all: the room is closing (host leaves) */
  | { t: 'bye'; reason: string };

const MESSAGE_TYPES = new Set(['join', 'reject', 'welcome', 'lobby', 'pick', 'ready', 'start', 'events', 'mirror', 'cmd', 'result', 'pause', 'left', 'ping', 'pong', 'bye']);

export function encodeMessage(m: NetMessage): string {
  return JSON.stringify(m);
}

/** Parse and shape-check a reliable message; null if malformed. */
export function decodeMessage(data: unknown): NetMessage | null {
  if (typeof data !== 'string' || data.length > 4_000_000) return null;
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.t !== 'string' || !MESSAGE_TYPES.has(v.t)) return null;
  switch (v.t) {
    case 'join':
      return isInt(v.version) && typeof v.name === 'string' ? (v as NetMessage) : null;
    case 'reject':
    case 'bye':
      return typeof v.reason === 'string' ? (v as NetMessage) : null;
    case 'welcome':
      return isSeat(v.playerIndex) ? (v as NetMessage) : null;
    case 'lobby':
      return isLobby(v.lobby) ? (v as NetMessage) : null;
    case 'pick':
      return typeof v.teamId === 'string' && typeof v.driverId === 'string' && (v.seq === undefined || isInt(v.seq)) ? (v as NetMessage) : null;
    case 'ready':
      return typeof v.ready === 'boolean' ? (v as NetMessage) : null;
    case 'start':
      return isInt(v.session) && isObj(v.config) && typeof v.config.layoutId === 'string' && Array.isArray(v.config.grid) && typeof v.final === 'boolean'
        ? (v as NetMessage)
        : null;
    case 'events':
      return isInt(v.session) && isInt(v.seq) && Array.isArray(v.events) && v.events.every((e) => isObj(e) && typeof e.type === 'string') ? (v as NetMessage) : null;
    case 'mirror':
      return isInt(v.session) && isInt(v.seq) && isObj(v.patch) ? (v as NetMessage) : null;
    case 'cmd':
      return isInt(v.session) && isCommand(v.command) ? (v as NetMessage) : null;
    case 'result':
      return isInt(v.session) && isObj(v.result) && Array.isArray(v.result.rows) && typeof v.final === 'boolean' ? (v as NetMessage) : null;
    case 'pause':
      return typeof v.paused === 'boolean' ? (v as NetMessage) : null;
    case 'left':
      return isSeat(v.playerIndex) && typeof v.name === 'string' ? (v as NetMessage) : null;
    case 'ping':
      return isNum(v.at) && (v.pings === undefined || (Array.isArray(v.pings) && v.pings.length <= 4 && v.pings.every((x) => x === null || isNum(x))))
        ? (v as NetMessage)
        : null;
    case 'pong':
      return isNum(v.at) ? (v as NetMessage) : null;
    default:
      return null;
  }
}

function isCommand(v: unknown): v is ClientCommand {
  if (!isObj(v)) return false;
  switch (v.cmd) {
    case 'pit':
      return typeof v.compound === 'string' && ['soft', 'medium', 'hard', 'inter', 'wet'].includes(v.compound);
    case 'cancelPit':
    case 'retire':
      return true;
    case 'ers':
      return typeof v.mode === 'string' && ['none', 'medium', 'hotlap', 'overtake'].includes(v.mode);
    default:
      return false;
  }
}

function isLobby(v: unknown): v is LobbyState {
  if (!isObj(v) || typeof v.code !== 'string' || !Array.isArray(v.players) || !isObj(v.settings) || !isObj(v.roster)) return false;
  if (!Array.isArray(v.roster.teams) || !Array.isArray(v.roster.drivers)) return false;
  const s = v.settings;
  if (typeof s.layoutId !== 'string' || !isNum(s.laps) || !isNum(s.aiCount) || !isNum(s.aiDifficulty) || !isObj(s.rules)) return false;
  return v.players.every(
    (p) =>
      isObj(p) &&
      isSeat(p.playerIndex) &&
      typeof p.name === 'string' &&
      typeof p.teamId === 'string' &&
      typeof p.driverId === 'string' &&
      typeof p.ready === 'boolean' &&
      (p.entry === undefined || isLobbyEntry(p.entry)) &&
      (p.pickSeq === undefined || isInt(p.pickSeq)),
  );
}

function isLobbyEntry(v: unknown): v is LobbyEntry {
  return (
    isObj(v) &&
    (v.kind === 'driver' || v.kind === 'team') &&
    (v.source === undefined || v.source === 'career' || v.source === 'myTeamDriver') &&
    typeof v.driver === 'string' &&
    (v.team === undefined || typeof v.team === 'string') &&
    (v.color === undefined || (typeof v.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.color)))
  );
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;
export const isSeat = (v: unknown): v is PlayerIndex => v === 0 || v === 1 || v === 2 || v === 3;
