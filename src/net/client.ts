/**
 * ClientSession (docs/plans/phase3-online.md §2): a remote player's side of one online session. It builds a mirror
 * world from the host's SessionConfig and never simulates the other cars:
 * - every fixed step it quantises the local input into a record (cumulative one-shot counters), predicts its own car
 *   with the same per-car step the host runs (race predictHumanStep) and sends the last INPUT_REDUNDANCY records
 *   every other step;
 * - snapshots carry the own car's authoritative state with the last applied input seq: the state is taken and the
 *   unacknowledged inputs replayed on top; the visual jump is smoothed out (beyond TELEPORT m: shown at once);
 * - the other cars are shown on the own car's timeline: its prediction stands for the host time of the newest
 *   snapshot plus the unacknowledged inputs, so they are extrapolated along the track that far past the newest
 *   snapshot (at most MAX_EXTRAPOLATION s; the jump a new snapshot makes is smoothed out). While the host drives the
 *   own car (pit autopilot, formation, parking) it is extrapolated the same way, so taking over and handing back
 *   keep one timeline (the prediction starts with the unacknowledged inputs replayed). Before the first snapshot of
 *   the own car everything is interpolated INTERP_DELAY s behind the host clock; the view time eases toward its
 *   target. The mirror world's other cars (slipstream, minimap) follow the view;
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
import { angleDiff, clamp, clamp01, lerp, wrapAngle } from '../core/math';
import { isCarHeld } from '../physics/index';
import { buildRenderFrame, createWorld, getPlayerCarId, predictHumanStep } from '../race/index';
import { forwardDistance, poseAt, projectToTrack, signedDeltaS, wrapS } from '../track/track';
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

/** While the host drives the own car: render everything this far (s) behind the estimated host clock (interpolation). */
export const INTERP_DELAY = 0.1;
/** The other cars are extrapolated at most this far (s) past the newest snapshot (to the own car's timeline). */
export const MAX_EXTRAPOLATION = 0.4;
/** Rate (1/s) at which the other cars' view time follows its target (own-car timeline / interpolation delay). */
const VIEW_LEAD_RATE = 3;
/** Extrapolation limits: along-track acceleration (m/s²) taken from the last two snapshots, lateral speed (m/s). */
const EXTRAP_ACCEL_MIN = -60;
const EXTRAP_ACCEL_MAX = 25;
const EXTRAP_LAT_SPEED = 6;
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

/** A car's (or the safety car's) place relative to the track in one snapshot. */
interface TrackPos {
  s: number;
  lat: number;
  /** height above the centre line and yaw against the track direction */
  dy: number;
  dyaw: number;
  index: number;
}

/** A buffered snapshot with the track places of its cars (by car id; the safety car under -1). */
interface Buffered {
  snap: Snapshot;
  at: Map<number, TrackPos>;
}

type Vec3 = { x: number; y: number; z: number };

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
  /** own round trip to the host (ms) as the host last measured it; null before the first measurement */
  ping: number | null = null;
  /** statistics: largest own-car correction (m) and reconciliations done */
  maxCorrection = 0;
  corrections = 0;

  private seq = 0;
  private readonly counters: number[] = ONE_SHOTS.map(() => 0);
  private pending: PendingInput[] = [];
  private sent: InputRecord[] = [];
  private stepCount = 0;
  private snapshots: Buffered[] = [];
  private clock: number | null = null;
  /** the other cars' view time = clock + viewLead (eases toward targetLead) */
  private viewLead = -INTERP_DELAY;
  /** host time of the snapshot the own car was last reconciled to */
  private ownSnapTime: number | null = null;
  /** decaying visual correction of each other car (the jump a new snapshot makes in the extrapolation) */
  private othersSmooth = new Map<number, Vec3>();
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
    const wasPredicted = this.ownPredicted;
    this.ownPredicted = car !== undefined && this.canPredict(car);
    this.viewLead += (this.targetLead() - this.viewLead) * (1 - Math.exp(-VIEW_LEAD_RATE * SIM_DT));
    const decay = Math.exp(-SMOOTH_RATE * SIM_DT);
    for (const d of this.othersSmooth.values()) {
      d.x *= decay;
      d.y *= decay;
      d.z *= decay;
    }
    this.syncOthers();
    if (car && this.ownPredicted) {
      // taking over from the host: its last state plus every unacknowledged input (this one is the last of them)
      if (!wasPredicted) for (const p of this.pending) this.predict(car, p.input);
      else this.predict(car, input);
    }
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
   * The frame to draw: the other cars at the view time (the own car's timeline, see the header), the own car where
   * the prediction has it (plus the decaying correction). `dt` (s) decays the own car's correction.
   */
  renderFrame(dt: number): RenderFrame {
    const decay = Math.exp(-SMOOTH_RATE * Math.max(0, Number.isFinite(dt) ? dt : 0));
    this.smooth.x *= decay;
    this.smooth.y *= decay;
    this.smooth.z *= decay;
    const local = buildRenderFrame(this.world, this.track);
    const view = this.viewTime();
    const frame = (view !== null ? this.frameAt(view) : null) ?? local;
    frame.cars = frame.cars.map((c) => {
      const d = this.othersSmooth.get(c.carId);
      return d && c.carId !== this.carId ? { ...c, x: c.x + d.x, y: c.y + d.y, z: c.z + d.z } : c;
    });
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

  private viewTime(): number | null {
    return this.clock === null ? null : this.clock + this.viewLead;
  }

  /** View time ahead of the clock: the own car's timeline (interpolation delay before its first snapshot). */
  private targetLead(): number {
    if (this.ownSnapTime === null || this.clock === null) return -INTERP_DELAY;
    const own = this.ownSnapTime + this.pending.length * SIM_DT;
    return clamp(own - this.clock, -INTERP_DELAY, MAX_EXTRAPOLATION);
  }

  /** The mirror world's other cars at the view time (the prediction's slipstream, minimap and audio read them). */
  private syncOthers(): void {
    const view = this.viewTime();
    if (view === null) return;
    const places = new Map<number, { s: number; lat: number }>();
    const frame = this.frameAt(view, places);
    if (!frame) return;
    for (const c of frame.cars) {
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
      const at = places.get(c.carId);
      if (at) {
        p.s = at.s;
        p.lateral = at.lat;
      }
    }
  }

  /**
   * Everything at host time `t`: interpolated inside the snapshot buffer, extrapolated along the track past its
   * newest snapshot (at most MAX_EXTRAPOLATION s; frame.time is the time shown). `places` receives the other cars'
   * s / lateral. Null before any snapshot.
   */
  private frameAt(t: number, places?: Map<number, { s: number; lat: number }>): RenderFrame | null {
    const n = this.snapshots.length;
    if (n === 0) return null;
    const first = this.snapshots[0] as Buffered;
    const last = this.snapshots[n - 1] as Buffered;
    if (n >= 2 && t > last.snap.time) return extrapolateFrame(this.track, this.snapshots[n - 2] as Buffered, last, Math.min(t - last.snap.time, MAX_EXTRAPOLATION), places);
    if (n === 1 || t <= first.snap.time || t >= last.snap.time) {
      const b = n === 1 || t <= first.snap.time ? first : last;
      if (places) for (const [id, at] of b.at) places.set(id, { s: at.s, lat: at.lat });
      return cloneFrame(b.snap.frame, b.snap.time);
    }
    let i = 0;
    while (i < n - 2 && (this.snapshots[i + 1] as Buffered).snap.time <= t) i++;
    const a = this.snapshots[i] as Buffered;
    const b = this.snapshots[i + 1] as Buffered;
    const f = b.snap.time > a.snap.time ? clamp01((t - a.snap.time) / (b.snap.time - a.snap.time)) : 0;
    if (places) {
      for (const [id, pb] of b.at) {
        const pa = a.at.get(id);
        places.set(id, pa ? { s: wrapS(this.track, pa.s + signedDeltaS(this.track, pa.s, pb.s) * f), lat: lerp(pa.lat, pb.lat, f) } : { s: pb.s, lat: pb.lat });
      }
    }
    return blendFrames(a.snap.frame, b.snap.frame, f, t);
  }

  /** Track places of a snapshot's cars and safety car (projected near their places in the previous one). */
  private trackPlaces(s: Snapshot): Map<number, TrackPos> {
    const prev = this.snapshots[this.snapshots.length - 1]?.at;
    const at = new Map<number, TrackPos>();
    const place = (id: number, x: number, y: number, z: number, yaw: number): void => {
      const pr = projectToTrack(this.track, x, z, prev?.get(id)?.index, y);
      at.set(id, { s: pr.s, lat: pr.lateral, dy: y - pr.height, dyaw: angleDiff(pr.heading, yaw), index: pr.index });
    };
    for (const c of s.frame.cars) if (c.carId >= 0) place(c.carId, c.x, c.y, c.z, c.yaw);
    const sc = s.frame.safetyCar;
    if (sc) place(-1, sc.x, sc.y, sc.z, sc.yaw);
    return at;
  }

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
          // its physics subset of the other cars is older than the view
          this.syncOthers();
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
      case 'ping': {
        const own = m.pings?.[this.playerIndex];
        if (typeof own === 'number') this.ping = own;
        this.send({ t: 'pong', at: m.at });
        return;
      }
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
    if (last && s.time <= last.snap.time) return;
    // the other cars where they were drawn just now, to smooth out the jump the new snapshot makes
    const view = this.viewTime();
    const before = view !== null ? this.frameAt(view) : null;
    this.snapshots.push({ snap: s, at: this.trackPlaces(s) });
    while (this.snapshots.length > 2 && (this.snapshots[0] as Buffered).snap.time < s.time - BUFFER_SECONDS) this.snapshots.shift();
    if (before) {
      // the same moment as just drawn (the newer snapshot may extrapolate further)
      const after = this.frameAt(before.time);
      for (const c of after?.cars ?? []) {
        const o = before.cars.find((x) => x.carId === c.carId);
        if (!o || c.carId === this.carId) continue;
        const d = this.othersSmooth.get(c.carId) ?? { x: 0, y: 0, z: 0 };
        const e = { x: o.x - c.x, y: o.y - c.y, z: o.z - c.z };
        if (Math.hypot(e.x, e.z) > TELEPORT || !Number.isFinite(e.x + e.y + e.z)) this.othersSmooth.set(c.carId, { x: 0, y: 0, z: 0 });
        else this.othersSmooth.set(c.carId, { x: d.x + e.x, y: d.y + e.y, z: d.z + e.z });
      }
    }
    // host clock estimate: the newest snapshot's time, eased in (jumps beyond 0.5 s taken at once)
    if (this.clock === null || Math.abs(s.time - this.clock) > 0.5) this.clock = s.time;
    else this.clock += (s.time - this.clock) * 0.1;
    this.reconcile(s);
    this.syncOthers();
  }

  private reconcile(s: Snapshot): void {
    const car = this.car;
    if (!s.own || !car || s.own.carId !== this.carId) return;
    const wasPredicting = this.ownPredicted;
    const before = { x: car.phys.x, y: car.phys.y, z: car.phys.z };
    this.ownSnapTime = s.time;
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
  return { ...f, time, cars: f.cars.map((c) => ({ ...c, damage: { ...c.damage } })), safetyCar: f.safetyCar ? { ...f.safetyCar } : (f.safetyCar ?? null) };
}

/** A moving thing in two consecutive snapshots carried `tau` s past the second along the track (null: a teleport). */
function extrapolatePose(
  track: BuiltTrack,
  a: { x: number; z: number; speed: number },
  pa: TrackPos,
  b: { x: number; z: number; speed: number },
  pb: TrackPos,
  dt: number,
  tau: number,
): { x: number; y: number; z: number; yaw: number; speed: number; s: number; lat: number } | null {
  if (!(dt > 0) || Math.hypot(b.x - a.x, b.z - a.z) > SNAP_TELEPORT) return null;
  const acc = clamp((b.speed - a.speed) / dt, EXTRAP_ACCEL_MIN, EXTRAP_ACCEL_MAX);
  // along-track speed at b (the position step is the interval's mean); a braking car stops, never reverses
  const v = Math.max(0, signedDeltaS(track, pa.s, pb.s) / dt + (acc * dt) / 2);
  const tt = acc < 0 ? Math.min(tau, v / -acc) : tau;
  const s = wrapS(track, pb.s + v * tt + 0.5 * acc * tt * tt);
  const lat = pb.lat + clamp((pb.lat - pa.lat) / dt, -EXTRAP_LAT_SPEED, EXTRAP_LAT_SPEED) * tau;
  const pose = poseAt(track, s, lat);
  return { x: pose.x, y: pose.y + pb.dy, z: pose.z, yaw: wrapAngle(pose.yaw + pb.dyaw), speed: Math.max(0, b.speed + acc * tt), s, lat };
}

/** The newest snapshot's frame with its cars and safety car carried `tau` s further (see extrapolatePose). */
function extrapolateFrame(track: BuiltTrack, a: Buffered, b: Buffered, tau: number, places?: Map<number, { s: number; lat: number }>): RenderFrame {
  const dt = b.snap.time - a.snap.time;
  const frame = cloneFrame(b.snap.frame, b.snap.time + tau);
  for (const c of frame.cars) {
    const pb = b.at.get(c.carId);
    const ca = a.snap.frame.cars.find((x) => x.carId === c.carId);
    const pa = a.at.get(c.carId);
    const e = ca && pa && pb ? extrapolatePose(track, ca, pa, c, pb, dt, tau) : null;
    if (e) {
      c.x = e.x;
      c.y = e.y;
      c.z = e.z;
      c.yaw = e.yaw;
      c.speed = e.speed;
      places?.set(c.carId, { s: e.s, lat: e.lat });
    } else if (pb) places?.set(c.carId, { s: pb.s, lat: pb.lat });
  }
  const sa = a.snap.frame.safetyCar;
  const sb = frame.safetyCar;
  const psa = a.at.get(-1);
  const psb = b.at.get(-1);
  if (sa && sb && psa && psb) {
    const e = extrapolatePose(track, sa, psa, sb, psb, dt, tau);
    if (e) frame.safetyCar = { ...sb, x: e.x, y: e.y, z: e.z, yaw: e.yaw, speed: e.speed };
  }
  return frame;
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
