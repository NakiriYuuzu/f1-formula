/**
 * ClientSession (docs/plans/phase3-online.md §2): a remote player's side of one online session. It builds a mirror
 * world from the host's SessionConfig and never simulates the other cars:
 * - every fixed step it quantises the local input into a record (cumulative one-shot counters), predicts its own car
 *   with the same per-car step the host runs (race predictHumanStep) and sends the last INPUT_REDUNDANCY records
 *   every other step;
 * - beside each snapshot (a datagram of its own, the newest seq taken) comes the own car's authoritative state right
 *   after the last input the host's state is final for (its seq and host time; inputs the host still guesses are
 *   replayed on its side once they arrive): the state is taken and the unacknowledged inputs replayed on top; the
 *   visual jump is smoothed out (beyond TELEPORT m: shown at once);
 * - everything the host drives is a Follower (follow.ts): the newest snapshot's fix of it carried along its arc to
 *   the view time, with an offset that fades each correction in. The view time is the own car's timeline — its
 *   prediction stands for the host time of its last state plus the unacknowledged inputs — so the others are shown
 *   where the host will have them when it plays the input the player is giving now;
 * - the own car is driven by this side's prediction or by the host (Drive: pit autopilot, formation, parking). Hosted,
 *   it is one more Follower on the same timeline; when it changes hands it is drawn on from where it was drawn.
 *   Before the first state of the own car, and while the player spectates (setSpectating), the view time runs
 *   INTERP_DELAY s behind the host clock instead: with no own car to line the others up with, they are shown as the
 *   host had them. The view time is a clock of its own,
 *   steered toward its target by running at most VIEW_WARP faster or slower than the steps (set at once only when
 *   VIEW_SNAP off, also by a frame that runs no step), so network jitter does not shake the other cars. The host clock
 *   estimate is the earliest arrival of the last CLOCK_WINDOW s, timed with the steps the frame clock still owes
 *   (useClock: a stalled frame being caught up does not make snapshots look early; the time of a hidden page, which is
 *   skipped, is not owed: skipTime); it bounds the target, so a host or this side losing time is
 *   followed within a fraction of a second. The mirror world's other cars (slipstream, minimap) are where the host
 *   most likely has them at the view time (the followers without their fading offsets);
 * - HUD mirror patches update timing, positions, pit, flags, session and weather of the mirror world; events are
 *   queued in order (deduplicated by seq) for the HUD and audio; commands go to the host.
 * Pure logic over NetTransport (tests: loopback).
 */
import type {
  BuiltTrack,
  CarEntry,
  CarPhysicsState,
  CarRenderState,
  ControlInput,
  ErsMode,
  GameEvent,
  PlayerIndex,
  RenderFrame,
  SessionConfig,
  SessionResult,
  TireCompound,
  TrackProjection,
  WorldState,
} from '../core/types';
import { SIM_DT } from '../core/defaults';
import { angleDiff, clamp, rightX, rightZ } from '../core/math';
import { isCarHeld } from '../physics/index';
import { buildRenderFrame, createWorld, getPlayerCarId, predictHumanStep } from '../race/index';
import { barrierLimits, forwardDistance, projectToTrack } from '../track/track';
import { Follower, MAX_CARRY, shownTime, type Fix, type Ground, type Pose } from './follow';
import { applyMirrorPatch, applyMirrorToWorld } from './mirror';
import {
  INPUT_REDUNDANCY,
  ONE_SHOTS,
  decodeMessage,
  decodeOwnState,
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
  type Motion,
  type NetMessage,
  type OwnState,
  type Snapshot,
} from './protocol';
import { decodeProbe, encodeProbe } from './probe';
import { SeqTracker, StatWindow, byteSize, type GuestLinkStats, type PeerLinkStats } from './stats';
import type { NetTransport } from './transport';

/** Spectating (and before the own car's first state): everything is shown this far (s) behind the estimated host clock. */
export const INTERP_DELAY = 0.1;
/** The view time runs 1 + VIEW_GAIN · (target − view) times as fast as the steps (at most ± VIEW_WARP); further than
 * VIEW_SNAP (s) from its target it is set to it. */
const VIEW_GAIN = 6;
const VIEW_WARP = 0.5;
const VIEW_SNAP = 0.15;
/** Host clock estimate: the earliest arrival of the last CLOCK_WINDOW s (local), approached this share per snapshot. */
const CLOCK_WINDOW = 0.3;
const CLOCK_GAIN = 0.5;
/** Own-car correction beyond this distance (m) is shown at once instead of smoothed. */
const TELEPORT = 3;
/** Share of the remaining visual correction of the own car removed per second (exponential). */
const SMOOTH_RATE = 10;
/** Unacknowledged inputs kept at most (2 s of steps). */
const MAX_PENDING = 240;
/** The own car changing hands further than this (m) from where it was drawn is shown at once. */
const HANDOVER_MAX = 30;
/** With the pit autopilot on and a stop requested, prediction hands over to the host this far (m) before the entry. */
const PIT_HANDOFF = 150;
/** The safety car's follower (car ids start at 0). */
const SAFETY_CAR = -1;

interface PendingInput {
  rec: InputRecord;
  input: ControlInput;
}

type Vec3 = { x: number; y: number; z: number };

/**
 * Who moves the own car on this side: its prediction from the player's inputs, or the host (pit autopilot and the
 * approach to it, formation, parking, a held or stopped car), which it then follows like any other car.
 */
type Drive = 'predicted' | 'hosted';

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
  /** link statistics (diagnostics panel): frame snapshots and own-car states by seq, bytes, corrections */
  private readonly linkSnapshots = new SeqTracker();
  private readonly linkOwn = new SeqTracker();
  private readonly linkDown = new StatWindow();
  private readonly linkUp = new StatWindow();
  private readonly linkCorrections = new StatWindow();
  private peer: PeerLinkStats | null = null;
  private peerAt: number | null = null;
  /** seq of the own-car state last reconciled to (older ones arriving late are dropped) */
  private ownSeq: number | null = null;

  private seq = 0;
  private readonly counters: number[] = ONE_SHOTS.map(() => 0);
  private pending: PendingInput[] = [];
  private sent: InputRecord[] = [];
  private stepCount = 0;
  /** the newest snapshot (what the followers do not carry is drawn from it) and a follower per car it holds */
  private newest: Snapshot | null = null;
  private readonly followers = new Map<number, Follower>();
  /** estimate of the host's time (s): the newest snapshot's as it arrives with the least delay, one step a step */
  private hostClock: number | null = null;
  /** snapshot arrivals of the last CLOCK_WINDOW s: local time (steps · SIM_DT) and host time − local time */
  private arrivals: { at: number; offset: number }[] = [];
  /** the frame clock the steps come from (useClock) and its time at the last step (ms; null: none since a pause) */
  private clock: { now(): number; owed(sinceLastStep: number): number } | null = null;
  private lastStepAt: number | null = null;
  /** the view time (s of host time) the followers are shown at, steered toward viewTarget(); null before a snapshot */
  private view: number | null = null;
  /** host time of the snapshot the own car was last reconciled to */
  private ownSnapTime: number | null = null;
  /** the host's state of the own car then: what its prediction starts from, the pending inputs played on it */
  private hostOwn: CarPhysicsState | null = null;
  /** the player watches the others (own car out of the race; setSpectating) */
  private spectating = false;
  private events: GameEvent[] = [];
  private eventSeq = 0;
  private mirrorSeq = 0;
  private mirrorState: unknown = undefined;
  /** predicted own car: drawn − predicted, fading out */
  private smooth: Vec3 = { x: 0, y: 0, z: 0 };
  private drive: Drive = 'hosted';
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

  /**
   * The link to the host as this side measures it (diagnostics panel); also asks WebRTC for its view of the link, at
   * most once a second (its answer shows in a later call).
   */
  linkStats(): GuestLinkStats {
    const now = this.wallClock();
    if (this.transport.stats && (this.peerAt === null || now - this.peerAt >= 1000)) {
      this.peerAt = now;
      this.transport.stats().then(
        (p) => (this.peer = p),
        () => (this.peer = null),
      );
    }
    return {
      pingMs: this.ping,
      peer: this.peer,
      snapshotHz: this.linkSnapshots.rate(now),
      snapshotLoss: this.linkSnapshots.loss(now),
      ownLoss: this.linkOwn.loss(now),
      maxGapMs: this.linkSnapshots.maxGap(now),
      correctionM: this.linkCorrections.max(now),
      downBps: this.linkDown.perSecond(now),
      upBps: this.linkUp.perSecond(now),
    };
  }

  /** Inputs not yet acknowledged by the host. */
  get pendingInputs(): number {
    return this.pending.length;
  }

  /**
   * The frame clock this session's steps come from (the App's online clock: `now` in ms, `owed` = FixedStepClock.owed).
   * Snapshot arrivals are then timed with the steps it still owes, so a stalled frame that is caught up does not make
   * them look early (without it: the steps run so far).
   */
  useClock(clock: { now(): number; owed(sinceLastStep: number): number }): void {
    this.clock = clock;
  }

  /** The frame clock skips the time from now to the next step (a hidden page): arrivals meanwhile owe no steps. */
  skipTime(): void {
    this.lastStepAt = null;
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
    const to: Drive = car && this.canPredict(car) ? 'predicted' : 'hosted';
    // (to the host before the view moves on: both are where the last step left them)
    if (car && to === 'hosted') this.handOver(car, to, this.drawnOwn(car));
    if (this.hostClock !== null) this.hostClock += SIM_DT;
    this.advanceView();
    this.syncOthers();
    if (car && to === 'predicted') {
      if (this.drive === 'predicted') this.predict(car, input);
      else this.handOver(car, to, this.drawnOwn(car));
    }
    // the mirrored timers move on (corrected by the next mirror patch)
    if (this.world.session.phase === 'running' || this.world.session.phase === 'chequered') {
      this.world.time += SIM_DT;
      if (car && car.status === 'running' && car.timing.lap >= 1) {
        car.timing.currentLapTime += SIM_DT;
        // race distance follows the own car between mirror patches (fuel per lap and gap read it every frame)
        car.timing.progress = raceDistance(car.timing.progress, car.timing.lapsCompleted, car.phys.s, this.track.length);
      }
      // the other cars' lap timers (not mirrored) as the host keeps them: a spectator's HUD shows the watched car's
      for (const c of this.world.cars) {
        if (c.id !== this.carId && (c.status === 'running' || c.status === 'pitting') && c.timing.lap >= 1) {
          c.timing.currentLapTime = Math.max(0, this.world.time - c.timing.lapStart);
        }
      }
    }
    this.stepCount++;
    this.lastStepAt = this.clock ? this.clock.now() : null;
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
   * The player's view follows another car (their own is out of the race) / their own again. Spectating, the view
   * time drops back to INTERP_DELAY behind the host clock at once — the camera changes car at this moment anyway —
   * and the others are shown as the host had them.
   */
  setSpectating(on: boolean): void {
    if (on === this.spectating) return;
    this.spectating = on;
    const target = this.viewTarget();
    if (target !== null) this.setView(target);
  }

  /**
   * The frame to draw: what the host drives where its followers are at the view time, the own car where the
   * prediction has it (plus the decaying correction) unless the host drives it too. `dt` (s) decays that correction.
   */
  renderFrame(dt: number): RenderFrame {
    const decay = Math.exp(-SMOOTH_RATE * Math.max(0, Number.isFinite(dt) ? dt : 0));
    this.smooth.x *= decay;
    this.smooth.y *= decay;
    this.smooth.z *= decay;
    const local = buildRenderFrame(this.world, this.track);
    // a frame that ran no step (the first one back after a hidden page) does not draw a view left far behind
    const target = this.viewTarget();
    if (this.view !== null && target !== null && !(Math.abs(target - this.view) <= VIEW_SNAP)) this.setView(target);
    const frame = this.hostFrame() ?? local;
    // where each stop is (the pit crews' clock): the snapshot leaves it out, the mirrored pit state has it
    if (frame !== local) {
      for (const c of frame.cars) {
        const service = local.cars.find((l) => l.carId === c.carId)?.pitService;
        if (service !== undefined) c.pitService = service;
      }
    }
    const car = this.car;
    const predicted = this.drive === 'predicted' ? local.cars.find((c) => c.carId === this.carId) : undefined;
    if (!car || !predicted) return frame;
    const shown: CarRenderState = { ...predicted, ...this.drawnOwn(car) };
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
   * Steps the frame clock still owes (useClock): what it will simulate of the wall-clock time since the last step
   * (after skipTime / a pause: of its backlog only).
   */
  private behind(): number {
    if (!this.clock) return 0;
    const since = this.lastStepAt === null ? 0 : Math.max(0, (this.clock.now() - this.lastStepAt) / 1000);
    const owed = this.clock.owed(since);
    return Number.isFinite(owed) ? Math.max(0, Math.floor(owed / SIM_DT + 1e-6)) : 0;
  }

  /**
   * Where the view time should be: the own car's timeline (interpolation delay before its first snapshot, and while
   * spectating: with no own car to line the others up with, they are shown as the host had them).
   */
  private viewTarget(): number | null {
    if (this.hostClock === null) return null;
    if (this.ownSnapTime === null || this.spectating) return this.hostClock - INTERP_DELAY;
    const own = this.ownSnapTime + this.pending.length * SIM_DT;
    return this.hostClock + clamp(own - this.hostClock, -INTERP_DELAY, MAX_CARRY);
  }

  /** One step of the view time, steered toward its target (see the header); the followers go with it. */
  private advanceView(): void {
    const target = this.viewTarget();
    if (target === null) return;
    if (this.view === null || !(Math.abs(target - this.view) <= VIEW_SNAP)) {
      this.setView(target);
      return;
    }
    // steered on the gap left after this step: on the gap before it the view settles a step past its target
    this.view += SIM_DT * (1 + clamp(VIEW_GAIN * (target - (this.view + SIM_DT)), -VIEW_WARP, VIEW_WARP));
    for (const f of this.followers.values()) f.step(this.view);
  }

  /** The view time set (not run) to `t`: everything is shown where it is then, at once. */
  private setView(t: number): void {
    this.view = t;
    for (const f of this.followers.values()) f.jump(t);
  }

  /** The mirror world's other cars at the view time (the prediction's slipstream, minimap and audio read them). */
  private syncOthers(): void {
    if (!this.newest) return;
    for (const c of this.newest.frame.cars) {
      const car = c.carId === this.carId ? undefined : this.world.cars[c.carId];
      const at = this.followers.get(c.carId)?.at;
      if (!car || !at) continue;
      const p = car.phys;
      p.x = at.x;
      p.y = at.y;
      p.z = at.z;
      p.yaw = at.yaw;
      p.speed = at.speed;
      p.gear = c.gear;
      p.rpm = c.rpm;
      p.throttle = c.throttle;
      p.brake = c.brake;
      const place = projectToTrack(this.track, at.x, at.z, p.trackIndex, at.y);
      p.trackIndex = place.index;
      p.s = place.s;
      p.lateral = place.lateral;
      // (not mirrored: the mirrored laps and this place; the AI driving the own car reads it to see a car lap it)
      car.timing.progress = raceDistance(car.timing.progress, car.timing.lapsCompleted, place.s, this.track.length);
    }
  }

  /** The newest snapshot's frame with everything in it where its follower is drawn at the view time. */
  private hostFrame(): RenderFrame | null {
    const s = this.newest;
    if (!s || this.view === null) return null;
    const sc = s.frame.safetyCar;
    return {
      ...s.frame,
      time: shownTime(s.time, this.view),
      cars: s.frame.cars.map((c) => ({ ...c, ...this.followers.get(c.carId)?.drawn, damage: { ...c.damage } })),
      safetyCar: sc ? { ...sc, ...this.followers.get(SAFETY_CAR)?.drawn } : null,
    };
  }

  /** Where the own car is drawn now. */
  private drawnOwn(car: CarEntry): Vec3 {
    if (this.drive === 'hosted') return this.followers.get(this.carId)?.drawn ?? car.phys;
    return { x: car.phys.x + this.smooth.x, y: car.phys.y + this.smooth.y, z: car.phys.z + this.smooth.z };
  }

  /** The own car changes hands (see Drive): it is drawn on from `drawn`, where it was drawn until now. */
  private handOver(car: CarEntry, to: Drive, drawn: Vec3): void {
    if (to === this.drive) return;
    this.drive = to;
    const follower = this.followers.get(this.carId);
    if (to === 'predicted') {
      // from the host's last state, with every input it has not played (since it was taken the car may have been
      // predicted on and handed to the host: that state has them played already)
      if (this.hostOwn) assignDeep(car.phys as unknown as Record<string, unknown>, this.hostOwn as unknown as Record<string, unknown>);
      for (const p of this.pending) this.predict(car, p.input);
      const d = { x: drawn.x - car.phys.x, y: drawn.y - car.phys.y, z: drawn.z - car.phys.z };
      this.smooth = follower && Math.hypot(d.x, d.z) < HANDOVER_MAX ? d : { x: 0, y: 0, z: 0 };
    } else if (follower) {
      if (Math.hypot(drawn.x - follower.at.x, drawn.z - follower.at.z) < HANDOVER_MAX) follower.resume(drawn);
      else follower.show();
    }
  }

  /**
   * Driving freely, on the track or down the pit lane: the prediction applies. The pit-lane autopilot (and the approach
   * to it), parking and the formation autopilot are the host's: the own car then follows the snapshots.
   */
  private canPredict(car: CarEntry): boolean {
    const phase = this.world.session.phase;
    if (phase !== 'running' && phase !== 'chequered') return false;
    if ((car.status !== 'running' && car.status !== 'pitting') || car.race.parking || car.race.formationAuto || isCarHeld(car.phys)) return false;
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
    if (this.sent.length === 0 || !this.transport.open) return;
    const packet = encodeInputPacket(this.sent);
    this.linkUp.add(this.wallClock(), packet.byteLength);
    this.transport.send('state', packet);
  }

  /** Wall clock (ms) of the link statistics: the frame clock's, else the steps run. */
  private wallClock(): number {
    return this.clock ? this.clock.now() : this.stepCount * SIM_DT * 1000;
  }

  private receive(channel: string, data: ArrayBuffer | string): void {
    if (this.disposed) return;
    const now = this.wallClock();
    this.linkDown.add(now, byteSize(data));
    if (channel === 'state') {
      const probe = decodeProbe(data);
      if (probe) {
        // echoed at once: the host times the round trip of this channel
        if (!probe.echo && this.transport.open) {
          const echo = encodeProbe({ echo: true, at: probe.at });
          this.linkUp.add(now, echo.byteLength);
          this.transport.send('state', echo);
        }
        return;
      }
      const s = decodeSnapshot(data);
      if (s) {
        this.linkSnapshots.arrived(s.seq, now);
        this.onSnapshot(s);
        return;
      }
      const own = decodeOwnState(data);
      if (own) {
        this.linkOwn.arrived(own.seq, now);
        this.reconcile(own);
      }
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
        this.lastStepAt = null;
        this.cb.paused?.(m.paused);
        return;
      case 'left':
        this.cb.playerLeft?.(m.playerIndex, m.name);
        return;
      case 'ping': {
        const own = m.pings?.[this.playerIndex];
        if (typeof own === 'number') this.ping = own;
        // (a host from before the probes times this one)
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
    if (this.newest && s.time <= this.newest.time) return;
    this.newest = s;
    // host clock estimate: the earliest arrival of the last CLOCK_WINDOW s — jitter only delays snapshots, so a late
    // one does not pull it back, a window of them all behind it (the host lost time, a slower route) does; jumps
    // beyond 0.5 s taken at once. The view time starts with the first snapshot
    const local = (this.stepCount + this.behind()) * SIM_DT;
    const newest = this.arrivals[this.arrivals.length - 1];
    // (arrivals while no step runs — a hidden tab — share one entry)
    if (newest && newest.at === local) newest.offset = Math.max(newest.offset, s.time - local);
    else this.arrivals.push({ at: local, offset: s.time - local });
    while (this.arrivals.length > 1 && (this.arrivals[0] as { at: number }).at < local - CLOCK_WINDOW) this.arrivals.shift();
    let offset = -Infinity;
    for (const a of this.arrivals) offset = Math.max(offset, a.offset);
    const clock = this.stepCount * SIM_DT + offset;
    if (this.hostClock === null || Math.abs(clock - this.hostClock) > 0.5) this.hostClock = clock;
    else this.hostClock += (clock - this.hostClock) * CLOCK_GAIN;
    if (this.view === null) this.advanceView();
    const view = this.view ?? s.time;
    const follow = (id: number, at: Pose, motion: Motion): void => {
      const fix: Fix = { time: s.time, x: at.x, y: at.y, z: at.z, yaw: at.yaw, speed: at.speed, ...motion };
      const f = this.followers.get(id);
      if (f) f.take(fix, view);
      else this.followers.set(id, new Follower(fix, view, this.ground(this.world.cars[id]?.spec)));
    };
    s.frame.cars.forEach((c, i) => follow(c.carId, c, s.motion[i] as Motion));
    const sc = s.frame.safetyCar;
    if (sc && s.safetyCarMotion) follow(SAFETY_CAR, sc, s.safetyCarMotion);
    else this.followers.delete(SAFETY_CAR);
    this.syncOthers();
  }

  /**
   * The ground one follower stands on, as the host's step leaves a car: a body (none: the safety car) reaching past the
   * barrier pushed back across the road (race barrierContact; not in the pit lane, where the host moves cars along it
   * without), at the road's height under it (race applyProjection). Its last place on the track is the next search's
   * hint.
   */
  private ground(body?: { length: number; width: number }): Ground {
    let index: number | undefined;
    return (p) => {
      let place = projectToTrack(this.track, p.x, p.z, index, p.y);
      let { x, z } = p;
      const into = body && place.surface !== 'pitlane' ? intoBarrier(this.track, place, p.yaw, body) : 0;
      if (into > 0) {
        const side = place.lateral >= 0 ? 1 : -1;
        x -= rightX(place.heading) * side * into;
        z -= rightZ(place.heading) * side * into;
        place = projectToTrack(this.track, x, z, place.index, p.y);
      }
      index = place.index;
      return { ...p, x, z, y: place.height };
    };
  }

  /**
   * The host's state of the own car (newest seq only): taken; while this side drives, the unacknowledged inputs are
   * replayed on top and the step that makes in what is drawn fades out.
   */
  private reconcile(own: OwnState): void {
    const car = this.car;
    if (!car || own.carId !== this.carId) return;
    if (this.ownSeq !== null && !seqNewer(own.seq, this.ownSeq)) return;
    this.ownSeq = own.seq;
    const before = { x: car.phys.x, y: car.phys.y, z: car.phys.z };
    const drawn = this.drawnOwn(car);
    this.ownSnapTime = own.time;
    this.hostOwn = own.phys;
    assignDeep(car.phys as unknown as Record<string, unknown>, own.phys as unknown as Record<string, unknown>);
    if (own.ack !== null) {
      const ack = own.ack;
      this.pending = this.pending.filter((p) => seqNewer(p.rec.seq, ack));
    }
    const to: Drive = this.canPredict(car) ? 'predicted' : 'hosted';
    if (to !== this.drive) {
      this.handOver(car, to, drawn);
      return;
    }
    // following the host there is nothing to correct
    if (to === 'hosted') return;
    for (const p of this.pending) this.predict(car, p.input);
    const err = { x: before.x - car.phys.x, y: before.y - car.phys.y, z: before.z - car.phys.z };
    const d = Math.hypot(err.x, err.z);
    this.corrections++;
    this.maxCorrection = Math.max(this.maxCorrection, d);
    if (Number.isFinite(d)) this.linkCorrections.add(this.wallClock(), d);
    if (d > TELEPORT || !Number.isFinite(d)) this.smooth = { x: 0, y: 0, z: 0 };
    else {
      this.smooth.x += err.x;
      this.smooth.y += err.y;
      this.smooth.z += err.z;
    }
  }

  private send(m: NetMessage): void {
    if (!this.transport.open) return;
    const data = encodeMessage(m);
    this.linkUp.add(this.wallClock(), byteSize(data));
    this.transport.send('reliable', data);
  }

  private lost(): void {
    if (this.hostLeft) return;
    this.hostLeft = true;
    this.cb.hostLost?.();
  }
}

/**
 * Race distance (m) from the completed laps and the place on the lap, taken within half a lap of `prev` (around the
 * line the place and the lap count change at different moments: one from a snapshot, the other from a mirror patch).
 */
function raceDistance(prev: number, laps: number, s: number, length: number): number {
  let progress = laps * length + s;
  if (progress < prev - length / 2) progress += length;
  else if (progress > prev + length / 2) progress -= length;
  return Number.isFinite(progress) ? progress : prev;
}

/** How far (m) a body at this place and yaw reaches past the barrier on its side (≤ 0: inside), as race barrierContact. */
function intoBarrier(track: BuiltTrack, place: TrackProjection, yaw: number, body: { length: number; width: number }): number {
  const lim = barrierLimits(track, place.s, place.lateral);
  const wall = place.lateral >= 0 ? lim.max : -lim.min;
  if (!(wall > 0)) return 0;
  const rel = angleDiff(place.heading, yaw);
  return Math.abs(place.lateral) + Math.abs(Math.sin(rel)) * body.length * 0.5 + Math.abs(Math.cos(rel)) * body.width * 0.5 - wall;
}

/** A record's input with the one-shots fired since `prev` counters (what the host applies for it). */
function withOneShots(rec: InputRecord, prev: readonly number[]): ControlInput {
  const input = recordToInput(rec);
  const fired = oneShotsBetween(prev, rec.counters);
  for (const k of ONE_SHOTS) input[k] = fired[k];
  return input;
}

function assignDeep(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const cur = target[k];
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof cur === 'object' && cur !== null && !Array.isArray(cur)) {
      assignDeep(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else target[k] = v;
  }
}
