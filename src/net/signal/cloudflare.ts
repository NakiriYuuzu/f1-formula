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

export class CloudflareSignal implements SignalClient {
  onSignal: ((from: string, payload: unknown) => void) | null = null;
  onPeerJoined: ((id: string) => void) | null = null;
  onPeerLeft: ((id: string) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private ws: WebSocket | null = null;
  private done = false;

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
          case 'welcome':
            welcomed = true;
            resolve({ id: String(m.id), host: m.host === true, hostId: typeof m.hostId === 'string' ? m.hostId : null, peers: Array.isArray(m.peers) ? m.peers.map(String) : [] });
            break;
          case 'error':
            if (!welcomed) reject(new Error(signalReasonText(String(m.reason))));
            break;
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
    this.done = true;
    this.ws?.close();
    this.ws = null;
  }

  private finish(reason: string): void {
    if (this.done) return;
    this.done = true;
    this.onClosed?.(reason);
  }
}
