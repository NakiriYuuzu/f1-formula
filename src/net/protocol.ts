/**
 * Wire formats of the online mode (docs/plans/phase3-online.md §2):
 * - input packets (client → host, 'state'): the last INPUT_REDUNDANCY input records of the client's fixed steps,
 *   quantised (throttle / brake uint8, steer int8) with cumulative one-shot counters (a lost or repeated packet never
 *   drops or repeats a gear shift: the host fires on a counter change);
 * - snapshots (host → client, 'state'): the packed render frame of every car (src/app/replay.ts encoding) plus ground
 *   pitch, safety car pose, marshal panels, the receiver's last input seq the host's state is final for (later ones may
 *   still be replayed) and (some snapshots) its own car's authoritative physics state right after it (with its host
 *   time) as JSON;
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
import { decodeFrame, encodeFrame } from '../app/replay';

export const PROTOCOL_VERSION = 2;

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

const SNAPSHOT_TYPE = 2;
const MODES: readonly RaceControlMode[] = ['green', 'formation', 'vsc', 'vscEnding', 'sc', 'scEnding', 'red'];
const SNAP_HEADER = 1 + 1 + 4 + 8 + 2 + 4;
const FLAG_SC = 1;
const FLAG_OWN = 2;
const FLAG_ACK = 4;
const SC_FIELDS = 8;

export interface Snapshot {
  tick: number;
  time: number;
  /** receiver's last input seq the host's car state is final for (null: none yet); `own` is the car right after it */
  ack: number | null;
  frame: RenderFrame;
  /** the receiver's own car, authoritative (JSON-safe subset of CarPhysicsState), when included */
  own: OwnCarState | null;
}

/** The receiver's car as the host has it: physics state + the few race fields prediction needs. */
export interface OwnCarState {
  carId: number;
  phys: CarPhysicsState;
  /** host time of this state (absent: the snapshot's; earlier while the host still guesses later inputs) */
  time?: number;
}

const finiteOr = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);

export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  const packed = encodeFrame(s.frame);
  const cars = s.frame.cars ?? [];
  const sc = s.frame.safetyCar ?? null;
  const rc = s.frame.raceControl;
  const own = s.own ? new TextEncoder().encode(JSON.stringify(s.own)) : null;
  const size = SNAP_HEADER + packed.byteLength + cars.length * 4 + (sc ? SC_FIELDS * 4 : 0) + 4 + (own ? 4 + own.byteLength : 0);
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o++, SNAPSHOT_TYPE);
  v.setUint8(o++, (sc ? FLAG_SC : 0) | (own ? FLAG_OWN : 0) | (s.ack !== null ? FLAG_ACK : 0));
  v.setUint32(o, s.tick >>> 0);
  o += 4;
  v.setFloat64(o, finiteOr(s.time));
  o += 8;
  v.setUint16(o, (s.ack ?? 0) & 0xffff);
  o += 2;
  v.setUint32(o, packed.length);
  o += 4;
  for (let i = 0; i < packed.length; i++, o += 4) v.setFloat32(o, packed[i] as number);
  for (const c of cars) {
    v.setFloat32(o, finiteOr(c.groundPitch ?? 0));
    o += 4;
  }
  if (sc) {
    for (const x of [sc.x, sc.y, sc.z, sc.yaw, sc.pitch ?? 0, sc.speed, sc.wheelSpin, sc.lightsOn ? 1 : 0]) {
      v.setFloat32(o, finiteOr(x));
      o += 4;
    }
  }
  v.setUint8(o++, rc ? Math.max(0, MODES.indexOf(rc.mode)) : 0);
  for (let k = 0; k < 3; k++) v.setUint8(o++, Math.max(0, Math.min(2, Math.round(rc?.sectorFlags[k] ?? 0))));
  if (own) {
    v.setUint32(o, own.byteLength);
    o += 4;
    new Uint8Array(buf, o, own.byteLength).set(own);
  }
  return buf;
}

export function decodeSnapshot(data: unknown): Snapshot | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength < SNAP_HEADER + 4) return null;
  const v = new DataView(data);
  let o = 0;
  if (v.getUint8(o++) !== SNAPSHOT_TYPE) return null;
  const flags = v.getUint8(o++);
  const tick = v.getUint32(o);
  o += 4;
  const time = v.getFloat64(o);
  o += 8;
  const ackRaw = v.getUint16(o);
  o += 2;
  const n = v.getUint32(o);
  o += 4;
  if (!Number.isFinite(time) || n < 5 || n > 100_000 || o + n * 4 > data.byteLength) return null;
  const packed = new Float32Array(n);
  for (let i = 0; i < n; i++, o += 4) packed[i] = v.getFloat32(o);
  for (const x of packed) if (!Number.isFinite(x)) return null;
  const frame = decodeFrame(time, packed, null, 0);
  const cars = frame.cars.length;
  const scBytes = flags & FLAG_SC ? SC_FIELDS * 4 : 0;
  if (o + cars * 4 + scBytes + 4 > data.byteLength) return null;
  for (let i = 0; i < cars; i++, o += 4) {
    const g = v.getFloat32(o);
    if (!Number.isFinite(g)) return null;
    (frame.cars[i] as { groundPitch?: number }).groundPitch = g;
  }
  if (flags & FLAG_SC) {
    const f: number[] = [];
    for (let k = 0; k < SC_FIELDS; k++, o += 4) f.push(v.getFloat32(o));
    if (f.some((x) => !Number.isFinite(x))) return null;
    frame.safetyCar = { x: f[0]!, y: f[1]!, z: f[2]!, yaw: f[3]!, pitch: f[4]!, speed: f[5]!, wheelSpin: f[6]!, lightsOn: f[7]! > 0.5 };
  } else frame.safetyCar = null;
  const mode = MODES[v.getUint8(o++)] ?? 'green';
  const sectorFlags = [v.getUint8(o++), v.getUint8(o++), v.getUint8(o++)].map((x) => Math.min(2, x));
  frame.raceControl = { mode, sectorFlags };
  let own: OwnCarState | null = null;
  if (flags & FLAG_OWN) {
    if (o + 4 > data.byteLength) return null;
    const len = v.getUint32(o);
    o += 4;
    if (o + len !== data.byteLength) return null;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(data, o, len)));
      own = isOwnCar(parsed) ? parsed : null;
    } catch {
      return null;
    }
    if (!own) return null;
  } else if (o !== data.byteLength) return null;
  return { tick, time, ack: flags & FLAG_ACK ? ackRaw : null, frame, own };
}

function isOwnCar(v: unknown): v is OwnCarState {
  if (!isObj(v) || !isInt(v.carId) || !isObj(v.phys) || (v.time !== undefined && !isNum(v.time))) return false;
  const p = v.phys;
  for (const k of ['x', 'y', 'z', 'yaw', 'vx', 'vz', 'speed', 'gear', 'rpm', 'fuelKg']) if (!isNum(p[k])) return false;
  return isObj(p.tire) && isObj(p.ers) && isObj(p.drs) && isObj(p.damage) && isObj(p.internal);
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
  /** client → host: choices (setup / assists: the host runs this car's physics with them) */
  | { t: 'pick'; teamId: string; driverId: string; setup?: unknown; assists?: unknown }
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
      return typeof v.teamId === 'string' && typeof v.driverId === 'string' ? (v as NetMessage) : null;
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
    (p) => isObj(p) && isSeat(p.playerIndex) && typeof p.name === 'string' && typeof p.teamId === 'string' && typeof p.driverId === 'string' && typeof p.ready === 'boolean',
  );
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;
export const isSeat = (v: unknown): v is PlayerIndex => v === 0 || v === 1 || v === 2 || v === 3;
