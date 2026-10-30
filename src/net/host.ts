/**
 * HostSession (docs/plans/phase3-online.md §2): the host side of one online session. The host runs the full world
 * (every car, AI included); this class only connects it to the remote players:
 * - per remote player an input timeline: record seq q is played at host step q + delay, the delay being the earliest
 *   arrival of the last AGE_WINDOW steps plus PLAYOUT_MARGIN (re-anchored when the records keep arriving later,
 *   shortened a step at a time when they arrive earlier); one-shots fire on counter changes. On the open road the
 *   car steps once per record as the delay moves with the link's jitter — a longer delay holds the car a step (race
 *   netHold), a shorter one gives it an extra step of the next record (predictHumanStep), one every SHRINK_EVERY
 *   steps, the host drawing both spread out (race netDraw) — so the player's own prediction never meets an input
 *   skipped or one it did not send, while the car's steps stay within LEAD_MAX of the world's in all. A change of
 *   more than LEAD_MAX still to take (the host or the sender lost time) and the part of one past that band are taken
 *   at once, as off the open road: records skipped, or the timeline taken back — a record already played is never
 *   played again (its step on the last input: no one-shot fires twice). An arrival's age counts
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
 * - snapshots at SNAPSHOT_HZ, two datagrams of one packet each with the receiver's snapshot seq (the frame, and the
 *   receiver's car before its first guess still open to a replay with the seq before it and the host time of that
 *   state), the HUD mirror at MIRROR_HZ (patches), game events as
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
import { COAST_INPUT, RETIRE_BY_CHOICE, buildRenderFrame, cancelPit, getPlayerCarId, predictHumanStep, requestPit, retireCar, setErsMode } from '../race/index';
import { assignDeep, diffMirror, mirrorView } from './mirror';
import {
  ONE_SHOTS,
  SEQ_MOD,
  decodeInputPacket,
  decodeMessage,
  encodeMessage,
  encodeOwnState,
  encodeSnapshot,
  nextSeq,
  oneShotsBetween,
  recordToInput,
  type InputRecord,
  type NetMessage,
} from './protocol';
import { decodeProbe, encodeProbe } from './probe';
import { StatWindow, byteSize, type HostLinkStats, type PeerLinkStats } from './stats';
import type { NetTransport } from './transport';

export const SNAPSHOT_HZ = 30;
export const MIRROR_HZ = 5;
/** Ping cadence (s of simulation time). */
const PING_EVERY = 1;
/** With no probe echo for this long (ms; a few pings) the reliable pongs time the guest again. */
const ECHO_STALE_MS = 3000;
/** Suffix of a car whose player left. */
export const AI_TAKEOVER_SUFFIX = '（AI 代駕）';
/** Input timeline: steps played behind the earliest arrival of the last AGE_WINDOW steps. */
const PLAYOUT_MARGIN = 2;
const AGE_WINDOW = 240;
/** Arrivals later than the delay allows by more than LATE_TOLERANCE steps, LATE_STREAK steps in a row: re-anchor. */
const LATE_TOLERANCE = 6;
const LATE_STREAK = 8;
/** A delay change is taken one step every SHRINK_EVERY steps; off the open road more than SHRINK_JUMP steps too long, at once. */
const SHRINK_EVERY = 4;
const SHRINK_JUMP = 30;
/** On the open road a car's steps stay within this many of the world's in all (holds and extra steps, ±0.25 s on the
 * field): room for the jitter, a route that gets up to 0.25 s slower or faster, a few small time losses, and no more
 * than that for a sender whose clock runs fast. A delay change of more than this still to take is somebody losing
 * time: taken at once. */
const LEAD_MAX = 30;
/** Host view: a held or extra step is drawn spread out over about this time (s) (race netDraw), not stood still / jumped. */
const DRAW_SMOOTH = 0.1;
/** Steps a late input can still be replayed (0.75 s). */
export const REWIND_STEPS = 90;
/** Guessed steps in a row after which the car is a ghost on the host (race netGhost) until a real input is back. */
const GHOST_AFTER = 6;
/** Off the open road: steps the delay may grow by holding the last input; the sender further behind what was played
 * is re-anchored at once (it lost time: the guesses so far final). */
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
  /** unwrapped seq played */
  seq: number;
  /** the record played (null: guessed) */
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
  /** newest seq played with its real record: never played again (its one-shots fired, its step taken) */
  real: number;
  /** playout delay (steps): step k plays seq k − delay */
  delay: number;
  /** earliest arrival age (steps) before each step of the window; the one since the last step */
  ages: { step: number; age: number }[];
  arrival: number | null;
  late: number[];
  shrinkAt: number;
  /** open-road car steps minus world steps (extra steps − holds), within ±LEAD_MAX */
  lead: number;
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
  /** last round trip (ms, a probe on the 'state' channel: probe.ts), null before the first answer */
  ping: number | null;
  /** clock (ms) of the last probe echo, -Infinity before one: a reliable 'pong' counts only ECHO_STALE_MS after it */
  echoAt: number;
  connected: boolean;
  /** seq of the next snapshot sent to it */
  snapshotSeq: number;
  /** link statistics (diagnostics panel) */
  stats: { snapshots: StatWindow; deferred: StatWindow; up: StatWindow; down: StatWindow; guesses: StatWindow };
  /** what WebRTC last reported of the link (polled while someone looks: linkStats) */
  peer: PeerLinkStats | null;
  peerAt: number | null;
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
    const start = this.clock();
    for (const p of players) {
      const r: Remote = {
        playerIndex: p.playerIndex,
        name: p.name,
        transport: p.transport,
        records: new Map(),
        newest: null,
        playSeq: null,
        played: null,
        real: -Infinity,
        delay: 0,
        ages: [],
        arrival: null,
        late: [],
        shrinkAt: 0,
        lead: 0,
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
        echoAt: -Infinity,
        connected: true,
        snapshotSeq: 0,
        // (deferred snapshots and guessed inputs are rare on a good link: their rates count from the start)
        stats: { snapshots: new StatWindow(), deferred: new StatWindow(start), up: new StatWindow(), down: new StatWindow(), guesses: new StatWindow(start) },
        peer: null,
        peerAt: null,
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

  /** Newest seq of a remote player's inputs its car has played with the record (-Infinity: none yet). */
  playedRecordOf(playerIndex: PlayerIndex): number {
    return this.remotes.get(playerIndex)?.real ?? -Infinity;
  }

  /** The connected remote players in seat order with their last round trip (ms; null: not measured yet). */
  pings(): { playerIndex: PlayerIndex; name: string; ms: number | null }[] {
    return [...this.remotes.values()]
      .filter((r) => r.connected)
      .sort((a, b) => a.playerIndex - b.playerIndex)
      .map((r) => ({ playerIndex: r.playerIndex, name: r.name, ms: r.ping }));
  }

  /**
   * The link to each connected remote player as the host measures it (diagnostics panel); also asks WebRTC for its
   * view of the link, at most once a second (its answer shows in a later call).
   */
  linkStats(): ({ playerIndex: PlayerIndex } & HostLinkStats)[] {
    const now = this.clock();
    return [...this.remotes.values()]
      .filter((r) => r.connected)
      .sort((a, b) => a.playerIndex - b.playerIndex)
      .map((r) => {
        if (r.transport.stats && (r.peerAt === null || now - r.peerAt >= 1000)) {
          r.peerAt = now;
          r.transport.stats().then(
            (p) => (r.peer = p),
            () => (r.peer = null),
          );
        }
        return {
          playerIndex: r.playerIndex,
          name: r.name,
          pingMs: r.ping,
          peer: r.peer,
          snapshotHz: r.stats.snapshots.perSecond(now),
          deferredHz: r.stats.deferred.perSecond(now),
          upBps: r.stats.up.perSecond(now),
          downBps: r.stats.down.perSecond(now),
          backlogBytes: this.backlog(r),
          inputDelayMs: r.delay * SIM_DT * 1000,
          guessHz: r.stats.guesses.perSecond(now),
        };
      });
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
    const now = this.clock();
    for (const r of this.remotes.values()) {
      if (snapshot) {
        // the previous one still waits for a clear link: this one takes its place
        if (r.snapshotDue) r.stats.deferred.add(now);
        r.snapshotDue = true;
      }
      if (mirror && r.mirrorDueAt === null) r.mirrorDueAt = this.steps;
    }
    this.sendSnapshots();
    this.sendMirror(false);
    if (this.world.time >= this.pingAt) {
      this.pingAt = this.world.time + PING_EVERY;
      // the round trip of the race data's own channel (probe.ts), not of the reliable one
      const now = this.clock();
      for (const r of this.remotes.values()) if (r.connected) this.sendState(r, encodeProbe({ echo: false, at: now }), now);
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
    if (car) {
      car.race.netHold = false;
      const d = car.race.netDraw;
      if (d) {
        const f = Math.exp(-SIM_DT / DRAW_SMOOTH);
        d.x *= f;
        d.y *= f;
        d.z *= f;
        if (Math.hypot(d.x, d.y, d.z) < 1e-3) car.race.netDraw = undefined;
      }
    }
    if (r.playSeq === null) {
      if (r.newest === null) return null;
      r.playSeq = k - r.delay;
    }
    const open = car !== undefined && openRoad(this.world, car);
    // the seq due now: behind it the delay grew, ahead of it it shrank
    const due = k - r.delay;
    if (!open && due < r.playSeq - HOLD_STEPS) this.back(r, due);
    const input = open ? this.openRoadStep(r, car, k, due) : this.offRoadStep(r, car, k, due);
    for (const q of r.records.keys()) if (q < r.playSeq - REWIND_STEPS) r.records.delete(q);
    return input;
  }

  /**
   * On the open road: one car step per record (see the header). A grown delay holds the car this step, a shrunk one
   * runs the next record first in a step of its own, one every SHRINK_EVERY steps, as long as the car's steps stay
   * within LEAD_MAX of the world's (r.lead). A change of more than LEAD_MAX still to take (the host or the sender lost
   * time), or the part of a change beyond the band, is taken at once as off the open road — the seqs since played
   * again (grown: guesses replaced by their records, the ones already played on the last input) or skipped (shrunk) —
   * so no car gains or loses more than LEAD_MAX steps on the field. Returns the input of the world step (null: the car
   * waits).
   */
  private openRoadStep(r: Remote, car: CarEntry, k: number, due: number): ControlInput | null {
    const gap = (r.playSeq as number) - due;
    if (gap > LEAD_MAX) this.back(r, due);
    else if (gap > LEAD_MAX + r.lead) this.back(r, due + LEAD_MAX + r.lead);
    else if (-gap > LEAD_MAX) r.playSeq = due;
    else if (-gap > LEAD_MAX - r.lead) r.playSeq = due - (LEAD_MAX - r.lead);
    const playSeq = r.playSeq as number;
    if (due !== playSeq && k >= r.shrinkAt) {
      r.shrinkAt = k + SHRINK_EVERY;
      // the host draws the car's lost / extra step spread out (the step it did not take, or took on top)
      const p = car.phys;
      if (due < playSeq) {
        r.lead--;
        car.race.netHold = true;
        this.drawShift(car, p.x - car.race.prevX, p.y - car.race.prevY, p.z - car.race.prevZ);
        return null;
      }
      r.lead++;
      const x = p.x;
      const y = p.y;
      const z = p.z;
      predictHumanStep(this.world, this.track, car, this.carStep(r, car) ?? COAST_INPUT, SIM_DT);
      this.drawShift(car, x - p.x, y - p.y, z - p.z);
    }
    return this.carStep(r, car);
  }

  /** The timeline taken back to `to` (the delay grew past what holds take): every step since final; a seq already
   * played with its record is not played again (see carStep). */
  private back(r: Remote, to: number): void {
    r.playSeq = to;
    r.played = Math.max(r.real, to - 1);
    r.slots = [];
  }

  private drawShift(car: CarEntry, x: number, y: number, z: number): void {
    const d = (car.race.netDraw ??= { x: 0, y: 0, z: 0 });
    d.x += x;
    d.y += y;
    d.z += z;
  }

  /**
   * The next record of an open-road car step (a guess if it is not there; the AI's input once nothing can be
   * replayed). A seq already played with its record (the timeline taken back over it) is a step on the last input:
   * no record, no one-shot, final.
   */
  private carStep(r: Remote, car: CarEntry): ControlInput | null {
    const seq = r.playSeq as number;
    r.playSeq = seq + 1;
    if (seq <= r.real) {
      r.slots = [];
      car.race.netGuess = false;
      car.race.netGhost = false;
      return this.play(r, null);
    }
    r.played = seq;
    const rec = r.records.get(seq) ?? null;
    r.records.delete(seq);
    if (rec) r.real = seq;
    r.slots.push({ seq, rec, time: this.world.time, car: saveCar(car), counters: r.lastCounters, last: r.last });
    if (r.slots.length > REWIND_STEPS) r.slots.shift();
    r.guessRun = rec ? 0 : r.guessRun + 1;
    if (!rec) r.stats.guesses.add(this.clock());
    car.race.netGuess = r.guessRun > 0;
    car.race.netGhost = r.guessRun > GHOST_AFTER;
    return r.guessRun > REWIND_STEPS ? computeAIInput(this.world, car, this.track, SIM_DT) : this.play(r, rec);
  }

  /**
   * Off the open road (pit lane, formation, parking — nothing is replayed): one record per step as it is due; a grown
   * delay holds the last input (no record used), a shrunk one skips records (their one-shots fire with the next one,
   * the counters being cumulative).
   */
  private offRoadStep(r: Remote, car: CarEntry | undefined, k: number, due: number): ControlInput | null {
    let seq: number | null = null;
    let playSeq = r.playSeq as number;
    if (due >= playSeq) {
      if (due - playSeq > SHRINK_JUMP) playSeq = due;
      else if (due > playSeq && k >= r.shrinkAt) {
        playSeq++;
        r.shrinkAt = k + SHRINK_EVERY;
      }
      seq = playSeq++;
      r.playSeq = playSeq;
      // (a seq already played with its record — the timeline taken back over it — holds the last input)
      if (seq <= r.real) seq = null;
      else r.played = seq;
    }
    const rec = seq !== null ? (r.records.get(seq) ?? null) : null;
    if (seq !== null) r.records.delete(seq);
    if (rec) r.real = seq as number;
    else if (seq !== null) r.stats.guesses.add(this.clock());
    r.slots = [];
    r.guessRun = rec ? 0 : r.guessRun + 1;
    if (car) {
      car.race.netGuess = false;
      car.race.netGhost = false;
    }
    return this.play(r, rec);
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
    const from = r.slots.findIndex((s) => s.rec === null && r.records.has(s.seq));
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
      if (s.rec === null) {
        const rec = r.records.get(s.seq);
        if (rec) {
          s.rec = rec;
          r.records.delete(s.seq);
          r.real = Math.max(r.real, s.seq);
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
    r.stats.down.add(this.clock(), byteSize(data));
    if (channel === 'state') {
      const probe = decodeProbe(data);
      if (probe) {
        if (probe.echo) {
          r.echoAt = this.clock();
          r.ping = Math.max(0, Math.round(r.echoAt - probe.at));
        }
        return;
      }
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
    if (m.t === 'pong') {
      // a guest from before the probes, or a state channel gone silent (the ping then reads its outage)
      if (this.clock() - r.echoAt > ECHO_STALE_MS) r.ping = Math.max(0, Math.round(this.clock() - m.at));
    }
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
        if (car && car.status !== 'finished' && car.status !== 'retired') retireCar(this.world, carId, RETIRE_BY_CHOICE);
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

  /** Due snapshots to the remotes whose link is clear (see the header: newest wins): the frame, then the own car. */
  private sendSnapshots(): void {
    let frame: RenderFrame | null = null;
    for (const r of this.remotes.values()) {
      if (!r.connected || !r.snapshotDue || this.backlog(r) > LINK_BACKLOG) continue;
      r.snapshotDue = false;
      frame ??= buildRenderFrame(this.world, this.track);
      const seq = r.snapshotSeq;
      r.snapshotSeq = nextSeq(seq);
      const now = this.clock();
      r.stats.snapshots.add(now);
      this.sendState(r, encodeSnapshot({ seq, tick: this.world.tick, time: this.world.time, frame }), now);
      const car = this.carOf(r);
      if (!car) continue;
      // the car before its first guess still open to a replay (the steps after it are the client's to predict)
      const guess = r.slots.find((s) => s.rec === null);
      const ack = guess ? guess.seq - 1 : r.played;
      this.sendState(
        r,
        encodeOwnState({
          seq,
          ack: ack === null ? null : ((ack % SEQ_MOD) + SEQ_MOD) % SEQ_MOD,
          carId: car.id,
          time: guess ? guess.time : this.world.time,
          phys: guess ? guess.car.phys : car.phys,
        }),
        now,
      );
    }
  }

  private sendState(r: Remote, buf: ArrayBuffer, now: number): void {
    if (!r.transport.open) return;
    r.stats.up.add(now, buf.byteLength);
    r.transport.send('state', buf);
  }

  /** Due mirror patches (`force`: every remote now, e.g. before the result) to the remotes whose link is clear. */
  private sendMirror(force: boolean): void {
    for (const r of this.remotes.values()) {
      if (!r.connected) continue;
      if (!force && (r.mirrorDueAt === null || (this.backlog(r) > LINK_BACKLOG && (this.steps - r.mirrorDueAt < MIRROR_MAX_WAIT || r.transport.buffered('reliable') > LINK_BACKLOG)))) continue;
      r.mirrorDueAt = null;
      // (each receiver's own view: see mirror.ts)
      const view = mirrorView(this.world, this.carOf(r)?.id ?? -1);
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
      car.race.netHold = false;
      car.race.netDraw = undefined;
      if (!car.displayName.endsWith(AI_TAKEOVER_SUFFIX)) car.displayName += AI_TAKEOVER_SUFFIX;
    }
    this.broadcast({ t: 'left', playerIndex: r.playerIndex, name: r.name });
    this.cb.playerLeft?.(r.playerIndex, r.name);
  }

  private broadcast(m: NetMessage): void {
    for (const r of this.remotes.values()) if (r.connected) this.send(r, m);
  }

  private send(r: Remote, m: NetMessage): void {
    if (!r.transport.open) return;
    const data = encodeMessage(m);
    r.stats.up.add(this.clock(), byteSize(data));
    r.transport.send('reliable', data);
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
