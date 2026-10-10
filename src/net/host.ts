/**
 * HostSession (docs/plans/phase3-online.md §2): the host side of one online session. The host runs the full world
 * (every car, AI included); this class only connects it to the remote players:
 * - per remote player an input buffer (records by seq; one applied per world step, the next in sequence or the oldest
 *   newer one after a gap, the last input held when none arrived; one-shots fire on counter changes);
 * - snapshots at SNAPSHOT_HZ (the packed render frame + the receiver's car and last applied input seq), the HUD mirror
 *   at MIRROR_HZ (patches), game events as they happen, pings;
 * - commands (pit request / cancel, ERS mode, retire) for the sender's own car only;
 * - a player whose link closes hands its car to the AI controller (name marked 「AI 代駕」) and the race goes on.
 * Pure logic over NetTransport (tests: loopback).
 */
import type { BuiltTrack, ControlInput, GameEvent, PlayerIndex, SessionResult, WorldState } from '../core/types';
import { SIM_DT } from '../core/defaults';
import { buildRenderFrame, cancelPit, getPlayerCarId, requestPit, retireCar, setErsMode } from '../race/index';
import { diffMirror, mirrorView } from './mirror';
import {
  ONE_SHOTS,
  decodeInputPacket,
  decodeMessage,
  encodeMessage,
  encodeSnapshot,
  oneShotsBetween,
  recordToInput,
  seqNewer,
  type InputRecord,
  type NetMessage,
} from './protocol';
import type { NetTransport } from './transport';

export const SNAPSHOT_HZ = 30;
export const MIRROR_HZ = 5;
/** Input records buffered beyond this many steps are dropped (oldest first): bounds the input delay. */
const MAX_BUFFER = 12;
/** Ping cadence (s of simulation time). */
const PING_EVERY = 1;
/** Suffix of a car whose player left. */
export const AI_TAKEOVER_SUFFIX = '（AI 代駕）';

interface Remote {
  playerIndex: PlayerIndex;
  name: string;
  transport: NetTransport;
  buffer: InputRecord[];
  lastSeq: number | null;
  lastCounters: number[];
  last: ControlInput | null;
  /** last mirror state sent (diff base) */
  mirror: unknown;
  mirrorSeq: number;
  eventSeq: number;
  ping: number;
  connected: boolean;
}

export interface HostCallbacks {
  /** a remote player's link closed (its car is now AI-driven) */
  playerLeft?(playerIndex: PlayerIndex, name: string): void;
}

export class HostSession {
  readonly session: number;
  private readonly remotes = new Map<PlayerIndex, Remote>();
  private steps = 0;
  private readonly snapshotEvery = Math.max(1, Math.round(1 / (SNAPSHOT_HZ * SIM_DT)));
  private readonly mirrorEvery = Math.max(1, Math.round(1 / (MIRROR_HZ * SIM_DT)));
  private pingAt = 0;
  private disposed = false;

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
        buffer: [],
        lastSeq: null,
        lastCounters: ONE_SHOTS.map(() => 0),
        last: null,
        mirror: undefined,
        mirrorSeq: 0,
        eventSeq: 0,
        ping: 0,
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
    for (const r of this.remotes.values()) r.mirror = undefined;
  }

  get connectedPlayers(): PlayerIndex[] {
    return [...this.remotes.values()].filter((r) => r.connected).map((r) => r.playerIndex);
  }

  pingOf(playerIndex: PlayerIndex): number {
    return this.remotes.get(playerIndex)?.ping ?? 0;
  }

  /** Fill `inputs[playerIndex]` for every remote player for the coming world step. */
  fillInputs(inputs: (ControlInput | null)[]): void {
    for (const r of this.remotes.values()) {
      if (!r.connected) continue;
      inputs[r.playerIndex] = this.nextInput(r);
    }
  }

  /** After each world step: snapshots, mirror, pings on their cadence. */
  afterStep(): void {
    if (this.disposed) return;
    this.steps++;
    if (this.steps % this.snapshotEvery === 0) this.sendSnapshots();
    if (this.steps % this.mirrorEvery === 0) this.sendMirror();
    if (this.world.time >= this.pingAt) {
      this.pingAt = this.world.time + PING_EVERY;
      this.broadcast({ t: 'ping', at: this.world.time });
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
    this.sendMirror();
    this.broadcast({ t: 'result', session: this.session, result, final });
  }

  setPaused(paused: boolean): void {
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

  private nextInput(r: Remote): ControlInput | null {
    // the next record in sequence, else (a record lost for good) the oldest newer one
    let rec: InputRecord | undefined;
    if (r.buffer.length > 0) {
      const want = r.lastSeq === null ? null : (r.lastSeq + 1) & 0xffff;
      const i = want === null ? -1 : r.buffer.findIndex((x) => x.seq === want);
      rec = i >= 0 ? r.buffer.splice(i, 1)[0] : r.buffer.shift();
    }
    if (!rec) {
      // nothing new: hold the last continuous input, no one-shots
      return r.last ? { ...r.last } : null;
    }
    const input = recordToInput(rec);
    const fired = oneShotsBetween(r.lastCounters, rec.counters);
    for (const k of ONE_SHOTS) input[k] = fired[k];
    r.lastCounters = rec.counters.slice();
    r.lastSeq = rec.seq;
    r.last = recordToInput(rec);
    return input;
  }

  private receive(r: Remote, channel: string, data: ArrayBuffer | string): void {
    if (this.disposed) return;
    if (channel === 'state') {
      const records = decodeInputPacket(data);
      if (!records) return;
      for (const rec of records) {
        if (r.lastSeq !== null && !seqNewer(rec.seq, r.lastSeq)) continue;
        if (r.buffer.some((x) => x.seq === rec.seq)) continue;
        r.buffer.push(rec);
      }
      // oldest first (wrap-aware), bounded
      r.buffer.sort((a, b) => (seqNewer(a.seq, b.seq) ? 1 : seqNewer(b.seq, a.seq) ? -1 : 0));
      if (r.buffer.length > MAX_BUFFER) {
        const drop = r.buffer.splice(0, r.buffer.length - MAX_BUFFER);
        // dropped records still count as applied (their one-shots fire with the next record: counters are cumulative)
        const lastDropped = drop[drop.length - 1];
        if (lastDropped) r.lastSeq = lastDropped.seq;
      }
      return;
    }
    const m = decodeMessage(data);
    if (!m) return;
    if (m.t === 'pong') r.ping = Math.max(0, Math.round((this.world.time - m.at) * 1000));
    else if (m.t === 'cmd' && m.session === this.session) this.command(r, m.command);
  }

  private command(r: Remote, c: Extract<NetMessage, { t: 'cmd' }>['command']): void {
    const carId = getPlayerCarId(this.world, r.playerIndex);
    if (carId < 0) return;
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

  private sendSnapshots(): void {
    const frame = buildRenderFrame(this.world, this.track);
    for (const r of this.remotes.values()) {
      if (!r.connected) continue;
      const carId = getPlayerCarId(this.world, r.playerIndex);
      const car = carId >= 0 ? this.world.cars[carId] : undefined;
      const buf = encodeSnapshot({
        tick: this.world.tick,
        time: this.world.time,
        ack: r.lastSeq,
        frame,
        own: car ? { carId: car.id, phys: car.phys } : null,
      });
      r.transport.send('state', buf);
    }
  }

  private sendMirror(): void {
    const view = mirrorView(this.world);
    for (const r of this.remotes.values()) {
      if (!r.connected) continue;
      const patch = diffMirror(r.mirror as never, view);
      r.mirror = view;
      if (patch === undefined) continue;
      this.send(r, { t: 'mirror', session: this.session, seq: r.mirrorSeq++, patch });
    }
  }

  private dropPlayer(r: Remote): void {
    if (!r.connected) return;
    r.connected = false;
    r.buffer = [];
    // its car is driven by the AI from now on
    const carId = getPlayerCarId(this.world, r.playerIndex);
    const car = carId >= 0 ? this.world.cars[carId] : undefined;
    if (car) {
      car.playerIndex = -1;
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
