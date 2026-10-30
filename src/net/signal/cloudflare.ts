/**
 * Signalling through the matchmaking Worker (server/): POST {base}/rooms creates a room, a WebSocket to
 * {base}/rooms/{code}/ws joins it. The base URL comes from VITE_SIGNAL_URL (build time) or the online screen.
 */
import { signalReasonText, type SignalClient, type SignalWelcome } from './types';

/** Configured matchmaking server URL (build time), '' when none. */
export function defaultSignalUrl(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    const v = env?.VITE_SIGNAL_URL;
    return typeof v === 'string' ? v.trim().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

/** Create a room on the server; resolves its code. */
export async function createRemoteRoom(base: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/rooms`, { method: 'POST' });
  } catch {
    throw new Error(signalReasonText('unreachable'));
  }
  if (!res.ok) throw new Error(`${signalReasonText('unreachable')}（${res.status}）`);
  const body: unknown = await res.json().catch(() => null);
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : null;
  if (typeof code !== 'string') throw new Error(signalReasonText('unreachable'));
  return code;
}

/** A TURN URL browsers accept (RFC 7065: turn[s]:host[:port][?transport=udp|tcp]); server/src/turn.ts checks the same. */
const TURN_URL = /^turns?:(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(?:\?transport=(?:udp|tcp))?$/;

function isTurnUrl(url: unknown): boolean {
  const m = typeof url === 'string' ? TURN_URL.exec(url) : null;
  return m !== null && (m[1] === undefined || (Number(m[1]) >= 1 && Number(m[1]) <= 65535));
}

/**
 * The matchmaking server's TURN relay (GET {base}/turn: short-lived credentials, server/src/turn.ts) as ICE servers;
 * none when it has no relay configured (or predates the route). Rejects (zh-TW) when the server cannot be reached or
 * refuses.
 */
export async function fetchIceServers(base: string): Promise<RTCIceServer[]> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/turn`);
  } catch {
    throw new Error(signalReasonText('unreachable'));
  }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${signalReasonText('unreachable')}（${res.status}）`);
  const body: unknown = await res.json().catch(() => null);
  const list = typeof body === 'object' && body !== null ? (body as { iceServers?: unknown }).iceServers : null;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s): s is RTCIceServer =>
      typeof s === 'object' &&
      s !== null &&
      Array.isArray((s as RTCIceServer).urls) &&
      ((s as RTCIceServer).urls as unknown[]).every(isTurnUrl) &&
      typeof (s as RTCIceServer).username === 'string' &&
      typeof (s as RTCIceServer).credential === 'string',
  );
}

/**
 * While anyone else is in the room, a message this often (ms) keeps it from closing as idle (server/src/roomLogic.ts
 * IDLE_MS) while no signalling flows — all through a race — and the connection alive through NATs. A host alone in its
 * room sends none: a forgotten room still closes (and stops costing the Worker).
 */
export const KEEPALIVE_MS = 60_000;

export class CloudflareSignal implements SignalClient {
  onSignal: ((from: string, payload: unknown) => void) | null = null;
  onPeerJoined: ((id: string) => void) | null = null;
  onPeerLeft: ((id: string) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private ws: WebSocket | null = null;
  private done = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  /** the other members of the room */
  private readonly others = new Set<string>();

  constructor(
    private readonly base: string,
    private readonly code: string,
  ) {}

  connect(): Promise<SignalWelcome> {
    const url = `${this.base.replace(/\/+$/, '').replace(/^http/, 'ws')}/rooms/${encodeURIComponent(this.code)}/ws`;
    return new Promise((resolve, reject) => {
      let welcomed = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        reject(new Error(signalReasonText('unreachable')));
        return;
      }
      this.ws = ws;
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(e.data) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (m.type) {
          case 'welcome': {
            welcomed = true;
            const peers = Array.isArray(m.peers) ? m.peers.map(String) : [];
            for (const p of peers) this.others.add(p);
            this.keepalive ??= setInterval(() => {
              if (this.others.size > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'keepalive' }));
            }, KEEPALIVE_MS);
            resolve({ id: String(m.id), host: m.host === true, hostId: typeof m.hostId === 'string' ? m.hostId : null, peers });
            break;
          }
          case 'error':
            if (!welcomed) reject(new Error(signalReasonText(String(m.reason))));
            break;
          case 'signal':
            if (typeof m.from === 'string') this.onSignal?.(m.from, m.payload);
            break;
          case 'peer-joined':
            if (typeof m.id === 'string') {
              this.others.add(m.id);
              this.onPeerJoined?.(m.id);
            }
            break;
          case 'peer-left':
            if (typeof m.id === 'string') {
              this.others.delete(m.id);
              this.onPeerLeft?.(m.id);
            }
            break;
          case 'closed':
            this.finish(String(m.reason));
            break;
          default:
            break;
        }
      };
      ws.onclose = () => {
        // a refused upgrade (unknown code) closes before any welcome
        if (!welcomed) reject(new Error(signalReasonText('not-found')));
        this.finish('connection');
      };
      ws.onerror = () => {
        if (!welcomed) reject(new Error(signalReasonText('unreachable')));
      };
    });
  }

  send(to: string, payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'signal', to, payload }));
  }

  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'leave' }));
    this.stopKeepalive();
    this.done = true;
    this.ws?.close();
    this.ws = null;
  }

  private finish(reason: string): void {
    this.stopKeepalive();
    if (this.done) return;
    this.done = true;
    this.onClosed?.(reason);
  }

  private stopKeepalive(): void {
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
  }
}
