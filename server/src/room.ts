/**
 * Durable Object `Room`: one matchmaking room (code = object name). WebSocket members; all decisions come from the
 * pure roomLogic.ts (relay signalling, full room, host leaves → closed, idle → closed). Never sees game data.
 */
import { IDLE_MS, createRoomState, roomStep, type RoomInput, type RoomState } from './roomLogic';

export interface Env {
  ROOMS: DurableObjectNamespace;
  /** comma-separated allowed origins for POST /rooms (empty: any) */
  ALLOWED_ORIGINS?: string;
}

export class Room {
  private state: RoomState = createRoomState(Date.now());
  private readonly sockets = new Map<string, WebSocket>();
  private created: boolean | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (this.created === null) this.created = (await this.ctx.storage.get<boolean>('created')) === true;
    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.created) return new Response('exists', { status: 409 });
      this.created = true;
      await this.ctx.storage.put('created', true);
      this.state = createRoomState(Date.now());
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      return new Response('ok');
    }
    if (url.pathname === '/ws') {
      if (!this.created || this.state.closed) return new Response('room not found', { status: 404 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      const id = crypto.randomUUID();
      this.sockets.set(id, server);
      server.addEventListener('message', (e: MessageEvent) => {
        if (typeof e.data === 'string' && e.data.length < 64_000) this.apply({ kind: 'message', from: id, data: e.data, now: Date.now() });
      });
      const gone = (): void => this.apply({ kind: 'disconnect', id, now: Date.now() });
      server.addEventListener('close', gone);
      server.addEventListener('error', gone);
      this.apply({ kind: 'connect', id, now: Date.now() });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    this.apply({ kind: 'alarm', now: Date.now() });
    if (this.state.closed) {
      await this.ctx.storage.deleteAll();
      this.created = false;
    } else await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  private apply(input: RoomInput): void {
    const step = roomStep(this.state, input);
    this.state = step.state;
    for (const o of step.out) {
      try {
        this.sockets.get(o.to)?.send(o.data);
      } catch {
        // socket already gone
      }
    }
    for (const id of step.close) {
      const s = this.sockets.get(id);
      this.sockets.delete(id);
      try {
        s?.close(1000, 'bye');
      } catch {
        // already closed
      }
    }
    if (this.state.closed) {
      void this.ctx.storage.deleteAll();
      this.created = false;
    }
  }
}
