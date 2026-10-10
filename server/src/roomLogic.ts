/**
 * Matchmaking room logic (pure): who is in a room, relaying WebRTC signalling between its members and closing it.
 * The Durable Object (room.ts) and the browser-only local test channel (src/net/signal/broadcast.ts) both run it.
 * A room holds the host (first to connect) and up to MAX_GUESTS guests; it only relays `signal` payloads (offer /
 * answer / ICE) between members and never sees game data. The host leaving closes the room; so does
 * IDLE_MS without activity.
 *
 * Wire messages (JSON text):
 *   client → room: { type: 'signal', to, payload } | { type: 'leave' }
 *   room → client: { type: 'welcome', id, host, hostId, peers } | { type: 'peer-joined', id } | { type: 'peer-left', id }
 *                  | { type: 'signal', from, payload } | { type: 'error', reason } | { type: 'closed', reason }
 */
export const MAX_GUESTS = 3;
export const IDLE_MS = 10 * 60 * 1000;
/** Room codes: 6 characters without the easily confused 0 O 1 I L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export interface RoomState {
  hostId: string | null;
  /** members in join order (the host first) */
  members: string[];
  lastActivity: number;
  closed: boolean;
}

export type RoomInput =
  | { kind: 'connect'; id: string; now: number }
  | { kind: 'message'; from: string; data: string; now: number }
  | { kind: 'disconnect'; id: string; now: number }
  | { kind: 'alarm'; now: number };

export interface RoomStep {
  state: RoomState;
  /** messages to deliver (JSON text) */
  out: { to: string; data: string }[];
  /** connections to close after delivering */
  close: string[];
}

export function createRoomState(now: number): RoomState {
  return { hostId: null, members: [], lastActivity: now, closed: false };
}

/** Random room code from `random()` in [0, 1). */
export function makeRoomCode(random: () => number): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return code;
}

export function isRoomCode(code: unknown): code is string {
  return typeof code === 'string' && code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

const msg = (v: unknown): string => JSON.stringify(v);

export function roomStep(prev: RoomState, input: RoomInput): RoomStep {
  const state: RoomState = { ...prev, members: [...prev.members] };
  const out: { to: string; data: string }[] = [];
  const close: string[] = [];
  const closeAll = (reason: string): void => {
    for (const m of state.members) {
      out.push({ to: m, data: msg({ type: 'closed', reason }) });
      close.push(m);
    }
    state.members = [];
    state.hostId = null;
    state.closed = true;
  };

  switch (input.kind) {
    case 'connect': {
      if (state.closed) {
        out.push({ to: input.id, data: msg({ type: 'error', reason: 'closed' }) });
        close.push(input.id);
        break;
      }
      if (state.members.includes(input.id)) break;
      if (state.members.length >= MAX_GUESTS + 1) {
        out.push({ to: input.id, data: msg({ type: 'error', reason: 'full' }) });
        close.push(input.id);
        break;
      }
      const host = state.hostId === null;
      if (host) state.hostId = input.id;
      const peers = [...state.members];
      state.members.push(input.id);
      state.lastActivity = input.now;
      out.push({ to: input.id, data: msg({ type: 'welcome', id: input.id, host, hostId: state.hostId, peers }) });
      for (const p of peers) out.push({ to: p, data: msg({ type: 'peer-joined', id: input.id }) });
      break;
    }
    case 'message': {
      if (!state.members.includes(input.from)) break;
      state.lastActivity = input.now;
      let m: unknown;
      try {
        m = JSON.parse(input.data);
      } catch {
        break;
      }
      if (typeof m !== 'object' || m === null) break;
      const o = m as { type?: unknown; to?: unknown; payload?: unknown };
      if (o.type === 'signal' && typeof o.to === 'string' && o.to !== input.from && state.members.includes(o.to)) {
        out.push({ to: o.to, data: msg({ type: 'signal', from: input.from, payload: o.payload ?? null }) });
      } else if (o.type === 'leave') {
        return roomStep(state, { kind: 'disconnect', id: input.from, now: input.now });
      }
      break;
    }
    case 'disconnect': {
      if (!state.members.includes(input.id)) break;
      state.lastActivity = input.now;
      if (input.id === state.hostId) {
        state.members = state.members.filter((m) => m !== input.id);
        close.push(input.id);
        closeAll('host-left');
        break;
      }
      state.members = state.members.filter((m) => m !== input.id);
      close.push(input.id);
      for (const p of state.members) out.push({ to: p, data: msg({ type: 'peer-left', id: input.id }) });
      break;
    }
    case 'alarm': {
      if (!state.closed && input.now - state.lastActivity >= IDLE_MS) closeAll('idle');
      break;
    }
  }
  return { state, out, close };
}
