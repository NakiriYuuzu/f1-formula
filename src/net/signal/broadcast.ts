/**
 * Local test signalling without a server: tabs of one browser (same origin) meet on a BroadcastChannel named after
 * the room code. The host tab runs the room logic itself (server/src/roomLogic.ts — the same rules as the Worker:
 * full room, relay, host leaves → closed); guests talk to it through the channel.
 */
import { createRoomState, makeRoomCode, roomStep, type RoomInput, type RoomState } from '../../../server/src/roomLogic';
import { signalReasonText, type SignalClient, type SignalWelcome } from './types';

const JOIN_TIMEOUT_MS = 2500;

type Packet =
  | { kind: 'connect'; id: string }
  | { kind: 'message'; from: string; data: string }
  | { kind: 'disconnect'; id: string }
  | { kind: 'deliver'; to: string; data: string };

const channelName = (code: string): string => `formula-nova-room-${code}`;

const randomId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`;

/** A new local room code (UI randomness, not simulation). */
export function createLocalRoomCode(): string {
  return makeRoomCode(Math.random);
}

export function broadcastAvailable(): boolean {
  return typeof BroadcastChannel === 'function';
}

export class BroadcastSignal implements SignalClient {
  onSignal: ((from: string, payload: unknown) => void) | null = null;
  onPeerJoined: ((id: string) => void) | null = null;
  onPeerLeft: ((id: string) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private readonly id = randomId();
  private channel: BroadcastChannel | null = null;
  private room: RoomState | null = null;
  private welcome: ((w: SignalWelcome) => void) | null = null;
  private refuse: ((e: Error) => void) | null = null;
  private done = false;

  constructor(
    private readonly code: string,
    private readonly asHost: boolean,
  ) {}

  connect(): Promise<SignalWelcome> {
    return new Promise((resolve, reject) => {
      if (!broadcastAvailable()) {
        reject(new Error('這個瀏覽器不支援本機測試連線'));
        return;
      }
      const ch = new BroadcastChannel(channelName(this.code));
      this.channel = ch;
      ch.onmessage = (e: MessageEvent) => this.onPacket(e.data as Packet);
      this.welcome = resolve;
      this.refuse = reject;
      if (this.asHost) {
        this.room = createRoomState(Date.now());
        this.apply({ kind: 'connect', id: this.id, now: Date.now() });
        return;
      }
      this.post({ kind: 'connect', id: this.id });
      setTimeout(() => {
        if (this.welcome) {
          this.welcome = null;
          reject(new Error(signalReasonText('not-found')));
          this.close();
        }
      }, JOIN_TIMEOUT_MS);
    });
  }

  send(to: string, payload: unknown): void {
    this.toRoom({ kind: 'message', from: this.id, data: JSON.stringify({ type: 'signal', to, payload }) });
  }

  close(): void {
    if (this.done) return;
    this.toRoom({ kind: 'disconnect', id: this.id });
    this.done = true;
    this.channel?.close();
    this.channel = null;
  }

  // the host tab is the room; guests post to it
  private toRoom(p: Packet): void {
    if (this.done) return;
    if (this.room) {
      if (p.kind === 'connect') this.apply({ kind: 'connect', id: p.id, now: Date.now() });
      else if (p.kind === 'message') this.apply({ kind: 'message', from: p.from, data: p.data, now: Date.now() });
      else if (p.kind === 'disconnect') this.apply({ kind: 'disconnect', id: p.id, now: Date.now() });
    } else this.post(p);
  }

  private onPacket(p: Packet): void {
    if (this.done || typeof p !== 'object' || p === null) return;
    if (p.kind === 'deliver') {
      if (p.to === this.id) this.handle(p.data);
      return;
    }
    if (this.room) this.toRoom(p);
  }

  private apply(input: RoomInput): void {
    if (!this.room) return;
    const step = roomStep(this.room, input);
    this.room = step.state;
    for (const o of step.out) {
      if (o.to === this.id) this.handle(o.data);
      else this.post({ kind: 'deliver', to: o.to, data: o.data });
    }
  }

  private handle(data: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.type) {
      case 'welcome': {
        const w = this.welcome;
        this.welcome = null;
        this.refuse = null;
        w?.({ id: String(m.id), host: m.host === true, hostId: typeof m.hostId === 'string' ? m.hostId : null, peers: Array.isArray(m.peers) ? m.peers.map(String) : [] });
        break;
      }
      case 'error': {
        const refuse = this.refuse;
        this.welcome = null;
        this.refuse = null;
        refuse?.(new Error(signalReasonText(String(m.reason))));
        this.done = true;
        this.channel?.close();
        this.channel = null;
        break;
      }
      case 'signal':
        if (typeof m.from === 'string') this.onSignal?.(m.from, m.payload);
        break;
      case 'peer-joined':
        if (typeof m.id === 'string') this.onPeerJoined?.(m.id);
        break;
      case 'peer-left':
        if (typeof m.id === 'string') this.onPeerLeft?.(m.id);
        break;
      case 'closed':
        this.finish(String(m.reason));
        break;
      default:
        break;
    }
  }

  private post(p: Packet): void {
    try {
      this.channel?.postMessage(p);
    } catch {
      // channel closed
    }
  }

  private finish(reason: string): void {
    if (this.done) return;
    this.done = true;
    this.channel?.close();
    this.channel = null;
    this.onClosed?.(reason);
  }
}
