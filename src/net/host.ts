/**
 * HostSession (docs/plans/phase3-online.md §2): the host side of one online session. The host runs the full world
 * (every car, AI included); this class only connects it to the remote players:
 * - per remote player an input timeline: record seq q is played at host step q + delay, the delay being the earliest
 *   arrival of the last AGE_WINDOW steps plus PLAYOUT_MARGIN (re-anchored when the records keep arriving later,
 *   shortened a step at a time when they arrive earlier); one-shots fire on counter changes. An arrival's age counts
 *   the steps the host still has to run (what its clock still simulates given the wall-clock time since its last
 *   step: HostCallbacks.owed): records that arrive while the host's frame stalls are not early, and the delay stays
 *   the link's. A record not there in
 *   time is guessed (the last one held); when it arrives the car is put back to before that step and every step since
 *   replayed with the inputs known now, by the per-car step the client predicts with (race predictHumanStep): a lag
 *   spike leaves no trace on the car. Only on the open road, never across a car-to-car contact, a completed lap or a
 *   command, at most REWIND_STEPS back. A guessed step reports no contact and no track limits (race netGuess); more
 *   than GHOST_AFTER in a row and the car is a ghost to the other cars (netGhost), more than REWIND_STEPS (nothing
 *   left to replay: a frozen tab) and the AI controller drives it. A sender whose records keep arriving behind what
 *   was played (it lost time) is taken back on its own timeline at once;
 * - snapshots at SNAPSHOT_HZ (the packed render frame + the receiver's car before its first guess still open to a
 *   replay, the seq before it and the host time of that state), the HUD mirror at MIRROR_HZ (patches), game events as
 *   they happen, pings. Newest wins: a snapshot or patch that is due waits (the next step tries again) while the link
 *   still has more than LINK_BACKLOG bytes queued, so a link slower than what the host sends gets fewer, fresh
 *   snapshots instead of a queue of stale ones that every message waits behind. Snapshots go first; a mirror patch
 *   (the diff since the last one sent) takes the link when it is clear, after MIRROR_MAX_WAIT also past queued
 *   snapshots, never behind a reliable message still queued (on a very slow link patches would pile up);
 * - commands (pit request / cancel, ERS mode, retire) for the sender's own car only;
 * - a player whose link closes hands its car to the AI controller (name marked 「AI 代駕」) and the race goes on.
 * Pure logic over NetTransport (tests: loopback).
 */
import type { BuiltTrack, CarEntry, CarPhysicsState, ControlInput, GameEvent, PlayerIndex, RenderFrame, SessionResult, WorldState } from '../core/types';
import { SIM_DT } from '../core/defaults';
import { computeAIInput } from '../ai/index';
import { isCarHeld } from '../physics/index';
import { COAST_INPUT, buildRenderFrame, cancelPit, getPlayerCarId, predictHumanStep, requestPit, retireCar, setErsMode } from '../race/index';
import { assignDeep, diffMirror, mirrorView } from './mirror';
import {
  ONE_SHOTS,
  SEQ_MOD,
  decodeInputPacket,
  decodeMessage,
  encodeMessage,
  encodeSnapshot,
  oneShotsBetween,
  recordToInput,
  type InputRecord,
  type NetMessage,
} from './protocol';
import type { NetTransport } from './transport';

export const SNAPSHOT_HZ = 30;
export const MIRROR_HZ = 5;
/** Ping cadence (s of simulation time). */
const PING_EVERY = 1;
/** Suffix of a car whose player left. */
export const AI_TAKEOVER_SUFFIX = '（AI 代駕）';
/** Input timeline: steps played behind the earliest arrival of the last AGE_WINDOW steps. */
const PLAYOUT_MARGIN = 2;
const AGE_WINDOW = 240;
/** Arrivals later than the delay allows by more than LATE_TOLERANCE steps, LATE_STREAK steps in a row: re-anchor. */
const LATE_TOLERANCE = 6;
const LATE_STREAK = 8;
/** A too long delay shrinks one step every SHRINK_EVERY steps; more than SHRINK_JUMP steps too long, at once. */
const SHRINK_EVERY = 4;
const SHRINK_JUMP = 30;
/** Steps a late input can still be replayed (0.75 s). */
export const REWIND_STEPS = 90;
/** Guessed steps in a row after which the car is a ghost on the host (race netGhost) until a real input is back. */
const GHOST_AFTER = 6;
/** Steps the delay may grow by holding; the sender further behind what was played is re-anchored at once. */
const HOLD_STEPS = 2;
/** Records further ahead of the newest one (steps) are ignored. */
const MAX_AHEAD = 1200;
/** Without HostCallbacks.owed: the wall-clock time since the last step counts, at most this many steps. */
const MAX_BEHIND = 60;
/** A due snapshot / mirror patch waits while more than this (bytes) is queued on the link (nothing but what is leaving). */
const LINK_BACKLOG = 1024;
/** Steps a due mirror patch waits for a clear link at most (then it goes behind queued snapshots, not patches). */
const MIRROR_MAX_WAIT = 60;

/** The car before a step: what predictHumanStep reads and writes. */
interface SavedCar {
  phys: CarPhysicsState;
  prevX: number;
  prevY: number;
  prevZ: number;
  prevYaw: number;
  collisionCooldown: number;
  impactPeak: number;
  reportedDamage: number[];
  wake: CarEntry['race']['wake'];
}

/** One step of a remote car that can still be replayed. */
interface Slot {
  /** unwrapped seq played (null: a step held while the delay grew) */
  seq: number | null;
  /** the record played (null: guessed / held) */
  rec: InputRecord | null;
  /** world time before the step and the car then */
  time: number;
  car: SavedCar;
  /** one-shot counters and held input before the step */
  counters: number[];
  last: ControlInput | null;
}

interface Remote {
  playerIndex: PlayerIndex;
  name: string;
  transport: NetTransport;
  /** received records by unwrapped seq: not played yet, or late for a guessed step */
  records: Map<number, InputRecord>;
  /** newest unwrapped seq received / next to play / last played (null: none yet) */
  newest: number | null;
  playSeq: number | null;
  played: number | null;
  /** playout delay (steps): step k plays seq k − delay */
  delay: number;
  /** earliest arrival age (steps) before each step of the window; the one since the last step */
  ages: { step: number; age: number }[];
  arrival: number | null;
  late: number[];
  shrinkAt: number;
  /** a late record waits for its guessed step */
  rewind: boolean;
  lastCounters: number[];
  /** continuous part of the last record played (what a guess holds) */
  last: ControlInput | null;
  /** steps in a row without a real input */
  guessRun: number;
  /** replayable steps, oldest first (cleared by a contact, a lap completed, a command or off the open road) */
  slots: Slot[];
  touchAt: number | null;
  laps: number;
  /** last mirror state sent (diff base) */
  mirror: unknown;
  mirrorSeq: number;
  /** a snapshot is due / the step a mirror patch became due (null: none) */
  snapshotDue: boolean;
  mirrorDueAt: number | null;
  eventSeq: number;
  /** last round trip (ms), null before the first answer */
  ping: number | null;
  connected: boolean;
}

export interface HostCallbacks {
  /** a remote player's link closed (its car is now AI-driven) */
  playerLeft?(playerIndex: PlayerIndex, name: string): void;
  /** wall clock (ms) the round trips are measured with; default the simulation time (tests: loopback time) */
  now?(): number;
  /**
   * Real time (s) the host still simulates if a frame came `sinceLastStep` s after its last step: its clock's backlog
   * plus that frame, as the clock keeps them (FixedStepClock.owed). Default: `sinceLastStep` (at most MAX_BEHIND steps).
   */
  owed?(sinceLastStep: number): number;
}

export class HostSession {
  readonly session: number;
  private readonly remotes = new Map<PlayerIndex, Remote>();
  private steps = 0;
  private readonly snapshotEvery = Math.max(1, Math.round(1 / (SNAPSHOT_HZ * SIM_DT)));
  private readonly mirrorEvery = Math.max(1, Math.round(1 / (MIRROR_HZ * SIM_DT)));
  private pingAt = 0;
  /** wall clock (ms, see clock()) of the last step; null before the first / after a pause */
  private lastStepAt: number | null = null;
  private disposed = false;
  /** statistics: steps replayed after late inputs */
  replayed = 0;

  constructor(
    private world: WorldState,
    private readonly track: BuiltTrack,
    session: number,
    players: readonly { playerIndex: PlayerIndex; name: string; transport: NetTransport }[],
    private readonly cb: HostCallbacks = {},
  ) {
    this.session = session;
    for (const p of players) {
      const r: Remote = {
        playerIndex: p.playerIndex,
        name: p.name,
        transport: p.transport,
        records: new Map(),
        newest: null,
        playSeq: null,
        played: null,
        delay: 0,
        ages: [],
        arrival: null,
        late: [],
        shrinkAt: 0,
        rewind: false,
        lastCounters: ONE_SHOTS.map(() => 0),
        last: null,
        guessRun: 0,
        slots: [],
        touchAt: null,
        laps: 0,
        mirror: undefined,
        mirrorSeq: 0,
        snapshotDue: false,
        mirrorDueAt: null,
        eventSeq: 0,
        ping: null,
        connected: true,
      };
      this.remotes.set(p.playerIndex, r);
      p.transport.onMessage = (channel, data) => this.receive(r, channel, data);
      p.transport.onClose = () => this.dropPlayer(r);
      if (!p.transport.open) this.dropPlayer(r);
    }
  }

  /** The world after a restart / flashback swap (not used online, kept for safety). */
  setWorld(world: WorldState): void {
    this.world = world;
    for (const r of this.remotes.values()) {
      r.mirror = undefined;
      r.slots = [];
    }
  }

  get connectedPlayers(): PlayerIndex[] {
    return [...this.remotes.values()].filter((r) => r.connected).map((r) => r.playerIndex);
  }

  pingOf(playerIndex: PlayerIndex): number {
    return this.remotes.get(playerIndex)?.ping ?? 0;
  }

  /** Playout delay of a remote player's inputs (steps). */
  inputDelayOf(playerIndex: PlayerIndex): number {
    return this.remotes.get(playerIndex)?.delay ?? 0;
  }

  /** The connected remote players in seat order with their last round trip (ms; null: not measured yet). */
  pings(): { playerIndex: PlayerIndex; name: string; ms: number | null }[] {
    return [...this.remotes.values()]
      .filter((r) => r.connected)
      .sort((a, b) => a.playerIndex - b.playerIndex)
      .map((r) => ({ playerIndex: r.playerIndex, name: r.name, ms: r.ping }));
  }

  /** Fill `inputs[playerIndex]` for every remote player for the coming world step. */
  fillInputs(inputs: (ControlInput | null)[]): void {
    for (const r of this.remotes.values()) {
      if (!r.connected) continue;
      inputs[r.playerIndex] = this.nextInput(r);
    }
  }

  /** After each world step: replay windows closed by contacts, snapshots, mirror, pings on their cadence. */
  afterStep(): void {
    if (this.disposed) return;
    this.steps++;
    this.lastStepAt = this.clock();
    for (const r of this.remotes.values()) {
      if (!r.connected) continue;
      // a car-to-car contact, a lap completed (per-lap tyre / ERS counters) or a step off the open road: the steps so
      // far are final
      const car = this.carOf(r);
      const touch = car?.race.touchAt ?? null;
      const laps = car?.timing.lapsCompleted ?? 0;
      if (!car || touch !== r.touchAt || laps !== r.laps || !openRoad(this.world, car)) r.slots = [];
      r.touchAt = touch;
      r.laps = laps;
    }
    const snapshot = this.steps % this.snapshotEvery === 0;
    const mirror = this.steps % this.mirrorEvery === 0;
    for (const r of this.remotes.values()) {
      if (snapshot) r.snapshotDue = true;
      if (mirror && r.mirrorDueAt === null) r.mirrorDueAt = this.steps;
    }
    this.sendSnapshots();
    this.sendMirror(false);
    if (this.world.time >= this.pingAt) {
      this.pingAt = this.world.time + PING_EVERY;
      // every player's last round trip rides along (each client shows its own)
      const pings: (number | null)[] = [null, null, null, null];
      for (const r of this.remotes.values()) if (r.connected) pings[r.playerIndex] = r.ping;
      this.broadcast({ t: 'ping', at: this.clock(), pings });
    }
  }

  /** Game events drained from the world this frame (shift events are the clients' own business). */
  forwardEvents(events: readonly GameEvent[]): void {
    const list = events.filter((e) => e.type !== 'shift');
    if (list.length === 0) return;
    for (const r of this.remotes.values()) {
      if (!r.connected) continue;
      this.send(r, { t: 'events', session: this.session, seq: r.eventSeq++, events: list });
    }
  }

  /** Session over: the classification for everyone (a last mirror first, so HUD and results agree). */
  sendResult(result: SessionResult, final: boolean): void {
    this.sendMirror(true);
    this.broadcast({ t: 'result', session: this.session, result, final });
  }

  setPaused(paused: boolean): void {
    this.lastStepAt = null;
    this.broadcast({ t: 'pause', paused });
  }

  /** Stop listening (the transports stay open for the next session). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.remotes.values()) {
      r.transport.onMessage = null;
      r.transport.onClose = null;
    }
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** ms for round trips (a frame's worth of simulation time would quantise them) */
  private clock(): number {
    return this.cb.now ? this.cb.now() : this.world.time * 1000;
  }

  private carOf(r: Remote): CarEntry | undefined {
    const carId = getPlayerCarId(this.world, r.playerIndex);
    return carId >= 0 ? this.world.cars[carId] : undefined;
  }

  private nextInput(r: Remote): ControlInput | null {
    const k = this.steps;
    this.updateDelay(r, k);
    const car = this.carOf(r);
    if (r.rewind) {
      r.rewind = false;
      if (car) this.replay(r, car);
    }
    if (r.playSeq === null) {
      if (r.newest === null) return null;
      r.playSeq = k - r.delay;
    }
    // the seq due now; behind it the delay grew (a held step, no record used), ahead of it it shrank (records skipped:
    // their one-shots fire with the next one, the counters being cumulative)
    const due = k - r.delay;
    if (due < r.playSeq - HOLD_STEPS) {
      // far behind what was played (the sender lost time): its own timeline from here, the guesses so far final
      r.playSeq = due;
      r.slots = [];
    }
    let seq: number | null = null;
    if (due >= r.playSeq) {
      if (due - r.playSeq > SHRINK_JUMP) r.playSeq = due;
      else if (due > r.playSeq && k >= r.shrinkAt) {
        r.playSeq++;
        r.shrinkAt = k + SHRINK_EVERY;
      }
      seq = r.playSeq++;
      r.played = seq;
    }
    const rec = seq !== null ? (r.records.get(seq) ?? null) : null;
    if (seq !== null) r.records.delete(seq);
    const open = car !== undefined && openRoad(this.world, car);
    const slot: Slot | null = car && open ? { seq, rec, time: this.world.time, car: saveCar(car), counters: r.lastCounters, last: r.last } : null;
    r.guessRun = rec ? 0 : r.guessRun + 1;
    if (car) {
      car.race.netGuess = open && r.guessRun > 0;
      car.race.netGhost = open && r.guessRun > GHOST_AFTER;
    }
    const input = car && open && r.guessRun > REWIND_STEPS ? computeAIInput(this.world, car, this.track, SIM_DT) : this.play(r, rec);
    if (slot) {
      r.slots.push(slot);
      if (r.slots.length > REWIND_STEPS) r.slots.shift();
    } else r.slots = [];
    for (const q of r.records.keys()) if (q < r.playSeq - REWIND_STEPS) r.records.delete(q);
    return input;
  }

  /** The input of one step: a record with its one-shots, else the last record held (no one-shots). */
  private play(r: Remote, rec: InputRecord | null): ControlInput | null {
    if (!rec) return r.last ? { ...r.last } : null;
    const input = recordToInput(rec);
    const fired = oneShotsBetween(r.lastCounters, rec.counters);
    for (const k of ONE_SHOTS) input[k] = fired[k];
    r.lastCounters = rec.counters.slice();
    r.last = recordToInput(rec);
    return input;
  }

  /** Fold the arrivals since the last step into the playout delay (see the header). */
  private updateDelay(r: Remote, k: number): void {
    const age = r.arrival;
    r.arrival = null;
    if (age !== null) {
      if (r.ages.length > 0 && age > r.delay + LATE_TOLERANCE) r.late.push(age);
      else r.late = [];
      r.ages.push({ step: k, age });
      if (r.late.length >= LATE_STREAK) {
        // later and later for a while (the sender lost time, the route got slower): anchor on these
        r.ages = r.late.map((a) => ({ step: k, age: a }));
        r.late = [];
      }
    }
    while (r.ages.length > 0 && (r.ages[0] as { step: number }).step < k - AGE_WINDOW) r.ages.shift();
    if (r.ages.length > 0) {
      let min = Infinity;
      for (const a of r.ages) min = Math.min(min, a.age);
      r.delay = min + PLAYOUT_MARGIN;
    }
  }

  /** Late records for guessed steps: the car back to before the first of them, every step since played again. */
  private replay(r: Remote, car: CarEntry): void {
    const from = r.slots.findIndex((s) => s.rec === null && s.seq !== null && r.records.has(s.seq));
    if (from < 0 || !openRoad(this.world, car)) return;
    const first = r.slots[from] as Slot;
    // DRS / overtake eligibility belong to the race layer (set at its lines): each step replays with the values it
    // had, the car ends with today's
    const now = raceOwned(car.phys);
    restoreCar(car, first.car);
    r.lastCounters = first.counters;
    r.last = first.last;
    let run = 0;
    for (let i = from - 1; i >= 0 && (r.slots[i] as Slot).rec === null; i--) run++;
    for (let i = from; i < r.slots.length; i++) {
      const s = r.slots[i] as Slot;
      if (i > from) {
        const was = raceOwned(s.car.phys);
        s.car = saveCar(car);
        setRaceOwned(s.car.phys, was);
        setRaceOwned(car.phys, was);
        s.counters = r.lastCounters;
        s.last = r.last;
      }
      if (s.rec === null && s.seq !== null) {
        const rec = r.records.get(s.seq);
        if (rec) {
          s.rec = rec;
          r.records.delete(s.seq);
        }
      }
      run = s.rec ? 0 : run + 1;
      car.race.netGuess = run > 0;
      predictHumanStep(this.world, this.track, car, this.play(r, s.rec) ?? COAST_INPUT, SIM_DT);
      this.replayed++;
    }
    setRaceOwned(car.phys, now);
    r.guessRun = run;
  }

  private receive(r: Remote, channel: string, data: ArrayBuffer | string): void {
    if (this.disposed) return;
    if (channel === 'state') {
      const records = decodeInputPacket(data);
      if (!records) return;
      // (records come newest first: the first packet unwraps against its newest)
      const ref = r.newest ?? (records[0] as InputRecord).seq;
      let newest: number | null = null;
      for (const rec of records) {
        const u = unwrapSeq(rec.seq, ref);
        if (r.newest !== null && u > r.newest + MAX_AHEAD) continue;
        if (newest === null || u > newest) newest = u;
        if (r.records.has(u)) continue;
        if (r.played === null || u > r.played) r.records.set(u, rec);
        else if (r.slots.some((s) => s.seq === u && s.rec === null)) {
          // late for a guessed step still in the window: replayed before the next step
          r.records.set(u, rec);
          r.rewind = true;
        }
      }
      if (newest === null) return;
      if (r.newest === null || newest > r.newest) r.newest = newest;
      // steps the host has not run yet (a stall it is catching up) do not make the records look early
      const age = this.steps + this.behind() - newest;
      r.arrival = r.arrival === null ? age : Math.min(r.arrival, age);
      return;
    }
    const m = decodeMessage(data);
    if (!m) return;
    if (m.t === 'pong') r.ping = Math.max(0, Math.round(this.clock() - m.at));
    else if (m.t === 'cmd' && m.session === this.session) this.command(r, m.command);
  }

  private command(r: Remote, c: Extract<NetMessage, { t: 'cmd' }>['command']): void {
    const carId = getPlayerCarId(this.world, r.playerIndex);
    if (carId < 0) return;
    // a replay never undoes a command (ERS mode)
    r.slots = [];
    switch (c.cmd) {
      case 'pit':
        requestPit(this.world, carId, c.compound);
        break;
      case 'cancelPit':
        cancelPit(this.world, carId);
        break;
      case 'ers':
        setErsMode(this.world, carId, c.mode);
        break;
      case 'retire': {
        const car = this.world.cars[carId];
        if (car && car.status !== 'finished' && car.status !== 'retired') retireCar(this.world, carId, '車手退賽');
        break;
      }
    }
  }

  /** Steps the host still has to run now (its clock's owed time for the wall-clock time since the last step). */
  private behind(): number {
    if (this.lastStepAt === null) return 0;
    const since = Math.max(0, (this.clock() - this.lastStepAt) / 1000);
    const owed = this.cb.owed ? this.cb.owed(since) : Math.min(since, MAX_BEHIND * SIM_DT);
    // (whole steps; the epsilon keeps an exact multiple from rounding down: one step short shrinks the delay)
    return Number.isFinite(owed) ? Math.max(0, Math.floor(owed / SIM_DT + 1e-6)) : 0;
  }

  /** Bytes still queued on a remote's link (both channels share it). */
  private backlog(r: Remote): number {
    return r.transport.buffered('state') + r.transport.buffered('reliable');
  }

  /** Due snapshots to the remotes whose link is clear (see the header: newest wins). */
  private sendSnapshots(): void {
    let frame: RenderFrame | null = null;
    for (const r of this.remotes.values()) {
      if (!r.connected || !r.snapshotDue || this.backlog(r) > LINK_BACKLOG) continue;
      r.snapshotDue = false;
      frame ??= buildRenderFrame(this.world, this.track);
      const car = this.carOf(r);
      // the car before its first guess still open to a replay (the steps after it are the client's to predict)
      const guess = r.slots.find((s) => s.rec === null && s.seq !== null);
      const ack = guess && guess.seq !== null ? guess.seq - 1 : r.played;
      const buf = encodeSnapshot({
        tick: this.world.tick,
        time: this.world.time,
        ack: ack === null ? null : ((ack % SEQ_MOD) + SEQ_MOD) % SEQ_MOD,
        frame,
        own: car ? { carId: car.id, phys: guess ? guess.car.phys : car.phys, time: guess ? guess.time : this.world.time } : null,
      });
      r.transport.send('state', buf);
    }
  }

  /** Due mirror patches (`force`: every remote now, e.g. before the result) to the remotes whose link is clear. */
  private sendMirror(force: boolean): void {
    let view: ReturnType<typeof mirrorView> | null = null;
    for (const r of this.remotes.values()) {
      if (!r.connected) continue;
      if (!force && (r.mirrorDueAt === null || (this.backlog(r) > LINK_BACKLOG && (this.steps - r.mirrorDueAt < MIRROR_MAX_WAIT || r.transport.buffered('reliable') > LINK_BACKLOG)))) continue;
      r.mirrorDueAt = null;
      view ??= mirrorView(this.world);
      const patch = diffMirror(r.mirror as never, view);
      r.mirror = view;
      if (patch === undefined) continue;
      this.send(r, { t: 'mirror', session: this.session, seq: r.mirrorSeq++, patch });
    }
  }

  private dropPlayer(r: Remote): void {
    if (!r.connected) return;
    r.connected = false;
    r.records.clear();
    r.slots = [];
    // its car is driven by the AI from now on
    const car = this.carOf(r);
    if (car) {
      car.playerIndex = -1;
      car.race.netGuess = false;
      car.race.netGhost = false;
      if (!car.displayName.endsWith(AI_TAKEOVER_SUFFIX)) car.displayName += AI_TAKEOVER_SUFFIX;
    }
    this.broadcast({ t: 'left', playerIndex: r.playerIndex, name: r.name });
    this.cb.playerLeft?.(r.playerIndex, r.name);
  }

  private broadcast(m: NetMessage): void {
    for (const r of this.remotes.values()) if (r.connected) this.send(r, m);
  }

  private send(r: Remote, m: NetMessage): void {
    if (r.transport.open) r.transport.send('reliable', encodeMessage(m));
  }
}

/** A uint16 seq as the unwrapped one nearest `ref`. */
function unwrapSeq(seq: number, ref: number): number {
  const half = SEQ_MOD / 2;
  return ref + ((((seq - ref + half) % SEQ_MOD) + SEQ_MOD) % SEQ_MOD) - half;
}

/** The host drives this step from the player's input alone, as the client predicts it: a running car on track. */
function openRoad(world: WorldState, car: CarEntry): boolean {
  const phase = world.session.phase;
  if (phase !== 'running' && phase !== 'chequered') return false;
  const r = car.race;
  return car.playerIndex >= 0 && car.status === 'running' && car.pit.phase === 'none' && !r.parking && !r.formationAuto && !isCarHeld(car.phys);
}

type RaceOwned = { eligible: boolean; available: boolean; overtake: boolean };

const raceOwned = (p: CarPhysicsState): RaceOwned => ({ eligible: p.drs.eligible, available: p.drs.available, overtake: p.ers.overtakeAvailable });

function setRaceOwned(p: CarPhysicsState, v: RaceOwned): void {
  p.drs.eligible = v.eligible;
  p.drs.available = v.available;
  p.ers.overtakeAvailable = v.overtake;
}

function saveCar(car: CarEntry): SavedCar {
  const r = car.race;
  return {
    phys: structuredClone(car.phys),
    prevX: r.prevX,
    prevY: r.prevY,
    prevZ: r.prevZ,
    prevYaw: r.prevYaw,
    collisionCooldown: r.collisionCooldown,
    impactPeak: r.impactPeak,
    reportedDamage: r.reportedDamage.slice(),
    wake: r.wake,
  };
}

function restoreCar(car: CarEntry, s: SavedCar): void {
  assignDeep(car.phys as unknown as Record<string, unknown>, s.phys as unknown as Record<string, unknown>);
  const r = car.race;
  r.prevX = s.prevX;
  r.prevY = s.prevY;
  r.prevZ = s.prevZ;
  r.prevYaw = s.prevYaw;
  r.collisionCooldown = s.collisionCooldown;
  r.impactPeak = s.impactPeak;
  r.reportedDamage = s.reportedDamage.slice();
  r.wake = s.wake;
}
