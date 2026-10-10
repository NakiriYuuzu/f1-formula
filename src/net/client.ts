/**
 * ClientSession (docs/plans/phase3-online.md §2): a remote player's side of one online session. It builds a mirror
 * world from the host's SessionConfig and never simulates the other cars:
 * - every fixed step it quantises the local input into a record (cumulative one-shot counters), predicts its own car
 *   with the same per-car step the host runs (race predictHumanStep) and sends the last INPUT_REDUNDANCY records
 *   every other step;
 * - snapshots fill an interpolation buffer (rendered INTERP_DELAY s behind the estimated host clock) and carry the
 *   own car's authoritative state with the last applied input seq: the state is taken and the unacknowledged inputs
 *   replayed on top; the visual jump is smoothed out (beyond TELEPORT m: shown at once);
 * - HUD mirror patches update timing, positions, pit, flags, session and weather of the mirror world; events are
 *   queued in order (deduplicated by seq) for the HUD and audio; commands go to the host.
 * Pure logic over NetTransport (tests: loopback).
 */
import type {
  BuiltTrack,
  CarEntry,
  CarRenderState,
  ControlInput,
  ErsMode,
  GameEvent,
  PlayerIndex,
  RenderFrame,
  SessionConfig,
  SessionResult,
  TireCompound,
  WorldState,
} from '../core/types';
import { SIM_DT } from '../core/defaults';
import { angleDiff, clamp01, lerp, wrapAngle } from '../core/math';
import { isCarHeld } from '../physics/index';
import { buildRenderFrame, createWorld, getPlayerCarId, predictHumanStep } from '../race/index';
import { forwardDistance } from '../track/track';
import { applyMirrorPatch, applyMirrorToWorld } from './mirror';
import {
  INPUT_REDUNDANCY,
  ONE_SHOTS,
  decodeMessage,
  decodeSnapshot,
  encodeInputPacket,
  encodeMessage,
  nextSeq,
  oneShotsBetween,
  quantizeInput,
  recordToInput,
  seqNewer,
  type ClientCommand,
  type InputRecord,
  type NetMessage,
  type Snapshot,
} from './protocol';
import type { NetTransport } from './transport';

/** Render the other cars this far (s) behind the estimated host clock (interpolation buffer). */
export const INTERP_DELAY = 0.1;
/** Own-car correction beyond this distance (m) is shown at once instead of smoothed. */
const TELEPORT = 3;
/** Share of the remaining visual correction removed per second (exponential). */
const SMOOTH_RATE = 10;
/** Snapshots kept (s of host time). */
const BUFFER_SECONDS = 1;
/** Unacknowledged inputs kept at most (2 s of steps). */
const MAX_PENDING = 240;
/** Recognised as a car-to-car teleport between two snapshots (m). */
const SNAP_TELEPORT = 30;
/** With the pit autopilot on and a stop requested, prediction hands over to the host this far (m) before the entry. */
const PIT_HANDOFF = 150;

interface PendingInput {
  rec: InputRecord;
  input: ControlInput;
}

export interface ClientCallbacks {
  /** another player left (its car is AI-driven now) */
  playerLeft?(playerIndex: PlayerIndex, name: string): void;
  /** the host paused / resumed */
  paused?(paused: boolean): void;
  /** the host link closed */
  hostLost?(): void;
  /** messages outside the session (lobby, the next session's start) */
  other?(m: NetMessage): void;
}

export class ClientSession {
  world: WorldState;
  readonly track: BuiltTrack;
  readonly session: number;
  readonly playerIndex: PlayerIndex;
  readonly carId: number;
  /** final classification once the host sent it */
  result: { result: SessionResult; final: boolean } | null = null;
  paused = false;
  hostLeft = false;
  /** statistics: largest own-car correction (m) and reconciliations done */
  maxCorrection = 0;
  corrections = 0;

  private seq = 0;
  private readonly counters: number[] = ONE_SHOTS.map(() => 0);
  private pending: PendingInput[] = [];
  private sent: InputRecord[] = [];
  private stepCount = 0;
  private snapshots: Snapshot[] = [];
  private clock: number | null = null;
  private events: GameEvent[] = [];
  private eventSeq = 0;
  private mirrorSeq = 0;
  private mirrorState: unknown = undefined;
  private smooth = { x: 0, y: 0, z: 0 };
  /** own car as last drawn and whether it was the predicted one (a hand-over is blended, not jumped) */
  private lastShown: { x: number; y: number; z: number } | null = null;
  private lastPredicted = false;
  /** the own car's state is a prediction (the last step predicted it) */
  private ownPredicted = false;
  private disposed = false;

  constructor(
    config: SessionConfig,
    track: BuiltTrack,
    session: number,
    playerIndex: PlayerIndex,
    private readonly transport: NetTransport,
    private readonly cb: ClientCallbacks = {},
  ) {
    this.track = track;
    this.session = session;
    this.playerIndex = playerIndex;
    this.world = createWorld(config, track);
    this.carId = getPlayerCarId(this.world, playerIndex);
    transport.onMessage = (channel, data) => this.receive(channel, data);
    transport.onClose = () => this.lost();
    if (!transport.open) this.lost();
  }

  get car(): CarEntry | undefined {
    return this.world.cars[this.carId];
  }

  /** Inputs not yet acknowledged by the host. */
  get pendingInputs(): number {
    return this.pending.length;
  }

  /** One fixed simulation step of local play with this control input. */
  step(control: ControlInput): void {
    if (this.disposed || this.paused || this.hostLeft) return;
    const prev = this.counters.slice();
    ONE_SHOTS.forEach((k, i) => {
      if (control[k]) this.counters[i] = (this.counters[i]! + 1) & 0xff;
    });
    const rec = quantizeInput(this.seq, control, this.counters);
    this.seq = nextSeq(this.seq);
    const input = withOneShots(rec, prev);
    this.pending.push({ rec, input });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    this.sent.unshift(rec);
    if (this.sent.length > INPUT_REDUNDANCY) this.sent.length = INPUT_REDUNDANCY;
    const car = this.car;
    this.ownPredicted = car !== undefined && this.canPredict(car);
    if (car && this.ownPredicted) this.predict(car, input);
    // the host's clock moves on; the mirrored timers too (corrected by the next mirror patch)
    if (this.clock !== null) this.clock += SIM_DT;
    if (this.world.session.phase === 'running' || this.world.session.phase === 'chequered') {
      this.world.time += SIM_DT;
      if (car && car.status === 'running' && car.timing.lap >= 1) {
        car.timing.currentLapTime += SIM_DT;
        // race distance follows the own car between mirror patches (fuel per lap and gap read it every frame)
        const L = this.track.length;
        const mirrored = car.timing.progress;
        let progress = car.timing.lapsCompleted * L + car.phys.s;
        if (progress < mirrored - L / 2) progress += L;
        else if (progress > mirrored + L / 2) progress -= L;
        if (Number.isFinite(progress)) car.timing.progress = progress;
      }
    }
    this.stepCount++;
    if (this.stepCount % 2 === 0) this.flushInputs();
  }

  /** Game events received since the last call (in host order). */
  takeEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Commands for the own car (pit request / cancel, ERS mode, retirement). */
  command(command: ClientCommand): void {
    this.send({ t: 'cmd', session: this.session, command });
  }

  requestPit(compound: TireCompound): void {
    this.command({ cmd: 'pit', compound });
  }

  cancelPit(): void {
    this.command({ cmd: 'cancelPit' });
  }

  setErsMode(mode: ErsMode): void {
    this.command({ cmd: 'ers', mode });
  }

  retire(): void {
    this.command({ cmd: 'retire' });
  }

  /**
   * The frame to draw: the other cars interpolated INTERP_DELAY s behind the host clock, the own car where the
   * prediction has it (plus the decaying correction). `dt` (s) decays the correction.
   */
  renderFrame(dt: number): RenderFrame {
    const decay = Math.exp(-SMOOTH_RATE * Math.max(0, Number.isFinite(dt) ? dt : 0));
    this.smooth.x *= decay;
    this.smooth.y *= decay;
    this.smooth.z *= decay;
    const local = buildRenderFrame(this.world, this.track);
    const frame = this.interpolated() ?? local;
    const car = this.car;
    if (!car) return frame;
    const predicted = this.canPredict(car);
    const base = (predicted ? local : frame).cars.find((c) => c.carId === this.carId);
    if (!base) return frame;
    // switching between the predicted and the host's (interpolated) car: carry the difference over and let it decay
    if (this.lastShown && predicted !== this.lastPredicted) {
      const d = { x: this.lastShown.x - base.x, y: this.lastShown.y - base.y, z: this.lastShown.z - base.z };
      if (Math.hypot(d.x, d.z) < SNAP_TELEPORT) this.smooth = d;
      else this.smooth = { x: 0, y: 0, z: 0 };
    }
    const shown: CarRenderState = { ...base, x: base.x + this.smooth.x, y: base.y + this.smooth.y, z: base.z + this.smooth.z };
    this.lastShown = { x: shown.x, y: shown.y, z: shown.z };
    this.lastPredicted = predicted;
    const i = frame.cars.findIndex((c) => c.carId === this.carId);
    if (i >= 0) frame.cars[i] = shown;
    else frame.cars.push(shown);
    return frame;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transport.onMessage = null;
    this.transport.onClose = null;
  }

  // ───────────────────────────── internals ─────────────────────────────

  /**
   * Driving freely: the prediction applies. The pit-lane autopilot (and the approach to it), parking and the
   * formation autopilot are the host's: the own car then follows the snapshots.
   */
  private canPredict(car: CarEntry): boolean {
    const phase = this.world.session.phase;
    if (phase !== 'running' && phase !== 'chequered') return false;
    if (car.status !== 'running' || car.race.parking || car.race.formationAuto || isCarHeld(car.phys)) return false;
    if (car.pit.phase === 'none') {
      const autopilot = car.assists.pitAssist && car.pit.requested;
      return !(autopilot && forwardDistance(this.track, car.phys.s, this.track.pit.entry) < PIT_HANDOFF);
    }
    return car.race.pitManual && !car.race.pitAuto;
  }

  private predict(car: CarEntry, input: ControlInput): void {
    predictHumanStep(this.world, this.track, car, input, SIM_DT);
    // the host reports what really happened (contacts, damage): local events would be duplicates
    this.world.events.length = 0;
  }

  private flushInputs(): void {
    if (this.sent.length > 0 && this.transport.open) this.transport.send('state', encodeInputPacket(this.sent));
  }

  private receive(channel: string, data: ArrayBuffer | string): void {
    if (this.disposed) return;
    if (channel === 'state') {
      const s = decodeSnapshot(data);
      if (s) this.onSnapshot(s);
      return;
    }
    const m = decodeMessage(data);
    if (m) this.onMessage(m);
  }

  private onMessage(m: NetMessage): void {
    switch (m.t) {
      case 'events':
        if (m.session !== this.session || m.seq < this.eventSeq) return;
        this.eventSeq = m.seq + 1;
        for (const e of m.events) this.events.push(e);
        return;
      case 'mirror': {
        if (m.session !== this.session || m.seq < this.mirrorSeq) return;
        // patches build on the first, complete one
        if (this.mirrorState === undefined && m.seq !== 0) return;
        this.mirrorSeq = m.seq + 1;
        this.mirrorState = applyMirrorPatch(this.mirrorState, m.patch);
        if (typeof this.mirrorState === 'object' && this.mirrorState !== null) {
          applyMirrorToWorld(this.world, this.mirrorState as Record<string, unknown>, this.carId);
        }
        return;
      }
      case 'result':
        if (m.session === this.session) this.result = { result: m.result, final: m.final };
        return;
      case 'pause':
        this.paused = m.paused;
        this.cb.paused?.(m.paused);
        return;
      case 'left':
        this.cb.playerLeft?.(m.playerIndex, m.name);
        return;
      case 'ping':
        this.send({ t: 'pong', at: m.at });
        return;
      case 'bye':
        this.lost();
        return;
      default:
        this.cb.other?.(m);
        return;
    }
  }

  private onSnapshot(s: Snapshot): void {
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && s.time <= last.time) return;
    this.snapshots.push(s);
    while (this.snapshots.length > 2 && (this.snapshots[0] as Snapshot).time < s.time - BUFFER_SECONDS) this.snapshots.shift();
    // host clock estimate: the newest snapshot's time, eased in (jumps beyond 0.5 s taken at once)
    if (this.clock === null || Math.abs(s.time - this.clock) > 0.5) this.clock = s.time;
    else this.clock += (s.time - this.clock) * 0.1;
    // the other cars in the mirror (minimap, slipstream, audio)
    for (const c of s.frame.cars) {
      if (c.carId === this.carId) continue;
      const car = this.world.cars[c.carId];
      if (!car) continue;
      const p = car.phys;
      p.x = c.x;
      p.y = c.y;
      p.z = c.z;
      p.yaw = c.yaw;
      p.speed = c.speed;
      p.gear = c.gear;
      p.rpm = c.rpm;
      p.throttle = c.throttle;
      p.brake = c.brake;
    }
    this.reconcile(s);
  }

  private reconcile(s: Snapshot): void {
    const car = this.car;
    if (!s.own || !car || s.own.carId !== this.carId) return;
    const wasPredicting = this.ownPredicted;
    const before = { x: car.phys.x, y: car.phys.y, z: car.phys.z };
    assignDeep(car.phys as unknown as Record<string, unknown>, s.own.phys as unknown as Record<string, unknown>);
    if (s.ack !== null) {
      const ack = s.ack;
      this.pending = this.pending.filter((p) => seqNewer(p.rec.seq, ack));
    }
    const predicting = this.canPredict(car);
    if (predicting) for (const p of this.pending) this.predict(car, p.input);
    this.ownPredicted = predicting;
    // the visual correction of the predicted car (following the host there is nothing to correct)
    if (!wasPredicting || !predicting) return;
    const err = { x: before.x - car.phys.x, y: before.y - car.phys.y, z: before.z - car.phys.z };
    const d = Math.hypot(err.x, err.z);
    this.corrections++;
    this.maxCorrection = Math.max(this.maxCorrection, d);
    if (d > TELEPORT || !Number.isFinite(d)) this.smooth = { x: 0, y: 0, z: 0 };
    else {
      this.smooth.x += err.x;
      this.smooth.y += err.y;
      this.smooth.z += err.z;
    }
  }

  /** Snapshots around the render time, blended (null before any snapshot). */
  private interpolated(): RenderFrame | null {
    const n = this.snapshots.length;
    if (n === 0 || this.clock === null) return null;
    const t = this.clock - INTERP_DELAY;
    const first = this.snapshots[0] as Snapshot;
    const lastS = this.snapshots[n - 1] as Snapshot;
    if (n === 1 || t <= first.time) return cloneFrame(first.frame, first.time);
    if (t >= lastS.time) return cloneFrame(lastS.frame, lastS.time);
    let i = 0;
    while (i < n - 2 && (this.snapshots[i + 1] as Snapshot).time <= t) i++;
    const a = this.snapshots[i] as Snapshot;
    const b = this.snapshots[i + 1] as Snapshot;
    const f = b.time > a.time ? clamp01((t - a.time) / (b.time - a.time)) : 0;
    return blendFrames(a.frame, b.frame, f, t);
  }

  private send(m: NetMessage): void {
    if (this.transport.open) this.transport.send('reliable', encodeMessage(m));
  }

  private lost(): void {
    if (this.hostLeft) return;
    this.hostLeft = true;
    this.cb.hostLost?.();
  }
}

/** A record's input with the one-shots fired since `prev` counters (what the host applies for it). */
function withOneShots(rec: InputRecord, prev: readonly number[]): ControlInput {
  const input = recordToInput(rec);
  const fired = oneShotsBetween(prev, rec.counters);
  for (const k of ONE_SHOTS) input[k] = fired[k];
  return input;
}

function cloneFrame(f: RenderFrame, time: number): RenderFrame {
  return { ...f, time, cars: f.cars.map((c) => ({ ...c, damage: { ...c.damage } })) };
}

function blendCar(a: CarRenderState, b: CarRenderState, f: number): CarRenderState {
  const near = f >= 0.5 ? b : a;
  if (Math.hypot(b.x - a.x, b.z - a.z) > SNAP_TELEPORT) return { ...near, damage: { ...near.damage } };
  return {
    ...near,
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    z: lerp(a.z, b.z, f),
    yaw: wrapAngle(a.yaw + angleDiff(a.yaw, b.yaw) * f),
    pitch: lerp(a.pitch, b.pitch, f),
    groundPitch: lerp(a.groundPitch ?? 0, b.groundPitch ?? 0, f),
    roll: lerp(a.roll, b.roll, f),
    speed: lerp(a.speed, b.speed, f),
    steerAngle: lerp(a.steerAngle, b.steerAngle, f),
    wheelSpin: lerp(a.wheelSpin, b.wheelSpin, f),
    throttle: lerp(a.throttle, b.throttle, f),
    brake: lerp(a.brake, b.brake, f),
    rpm: lerp(a.rpm, b.rpm, f),
    damage: { ...near.damage },
  };
}

function blendFrames(a: RenderFrame, b: RenderFrame, f: number, time: number): RenderFrame {
  const cars: CarRenderState[] = [];
  for (const ca of a.cars) {
    const cb = b.cars.find((c) => c.carId === ca.carId);
    cars.push(cb ? blendCar(ca, cb, f) : { ...ca, damage: { ...ca.damage } });
  }
  const near = f >= 0.5 ? b : a;
  const sa = a.safetyCar ?? null;
  const sb = b.safetyCar ?? null;
  const safetyCar =
    sa && sb && Math.hypot(sb.x - sa.x, sb.z - sa.z) < SNAP_TELEPORT
      ? { ...sb, x: lerp(sa.x, sb.x, f), y: lerp(sa.y, sb.y, f), z: lerp(sa.z, sb.z, f), yaw: wrapAngle(sa.yaw + angleDiff(sa.yaw, sb.yaw) * f), speed: lerp(sa.speed, sb.speed, f) }
      : (near.safetyCar ?? null);
  return {
    time,
    cars,
    startLights: { ...near.startLights },
    weather: { kind: near.weather.kind, rain: lerp(a.weather.rain, b.weather.rain, f), wetness: lerp(a.weather.wetness, b.weather.wetness, f) },
    safetyCar,
    ...(near.raceControl ? { raceControl: { mode: near.raceControl.mode, sectorFlags: [...near.raceControl.sectorFlags] } } : {}),
  };
}

function assignDeep(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const cur = target[k];
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof cur === 'object' && cur !== null && !Array.isArray(cur)) {
      assignDeep(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else target[k] = v;
  }
}
