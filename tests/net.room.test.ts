/**
 * Matchmaking room logic (server/src/roomLogic.ts, shared by the Cloudflare Durable Object and the local
 * BroadcastChannel test channel): join / host, full room, relay only between members, host leaving closes the room,
 * guests leaving, idle close, room codes, allowed origins.
 */
import { describe, expect, test } from 'bun:test';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  IDLE_MS,
  MAX_GUESTS,
  createRoomState,
  isOriginAllowed,
  isRoomCode,
  makeRoomCode,
  roomStep,
  type RoomInput,
  type RoomState,
} from '../server/src/roomLogic';

type Out = { to: string; msg: Record<string, unknown> };

function run(state: RoomState, inputs: RoomInput[]): { state: RoomState; out: Out[]; close: string[] } {
  const out: Out[] = [];
  const close: string[] = [];
  let s = state;
  for (const i of inputs) {
    const r = roomStep(s, i);
    s = r.state;
    for (const o of r.out) out.push({ to: o.to, msg: JSON.parse(o.data) as Record<string, unknown> });
    close.push(...r.close);
  }
  return { state: s, out, close };
}

describe('room logic', () => {
  test('the first member hosts; later ones learn the members and the host id; members hear of joins', () => {
    const r = run(createRoomState(0), [
      { kind: 'connect', id: 'h', now: 1 },
      { kind: 'connect', id: 'a', now: 2 },
      { kind: 'connect', id: 'b', now: 3 },
    ]);
    expect(r.state.hostId).toBe('h');
    expect(r.state.members).toEqual(['h', 'a', 'b']);
    const welcome = (id: string) => r.out.find((o) => o.to === id && o.msg.type === 'welcome')!.msg;
    expect(welcome('h')).toMatchObject({ host: true, hostId: 'h', peers: [] });
    expect(welcome('a')).toMatchObject({ host: false, hostId: 'h', peers: ['h'] });
    expect(welcome('b')).toMatchObject({ host: false, peers: ['h', 'a'] });
    expect(r.out.filter((o) => o.msg.type === 'peer-joined' && o.msg.id === 'b').map((o) => o.to).sort()).toEqual(['a', 'h']);
    expect(r.close).toHaveLength(0);
  });

  test('a full room (host + 3) refuses the fifth player', () => {
    const joins: RoomInput[] = ['h', 'a', 'b', 'c', 'd'].map((id, i) => ({ kind: 'connect', id, now: i }));
    const r = run(createRoomState(0), joins);
    expect(MAX_GUESTS).toBe(3);
    expect(r.state.members).toEqual(['h', 'a', 'b', 'c']);
    expect(r.out.find((o) => o.to === 'd')!.msg).toEqual({ type: 'error', reason: 'full' });
    expect(r.close).toEqual(['d']);
  });

  test('signalling is relayed to the addressed member only (never to outsiders or back to the sender)', () => {
    const base = run(createRoomState(0), [
      { kind: 'connect', id: 'h', now: 0 },
      { kind: 'connect', id: 'a', now: 0 },
    ]).state;
    const r = run(base, [
      { kind: 'message', from: 'a', data: JSON.stringify({ type: 'signal', to: 'h', payload: { kind: 'offer', sdp: 'x' } }), now: 5 },
      { kind: 'message', from: 'a', data: JSON.stringify({ type: 'signal', to: 'nobody', payload: 1 }), now: 5 },
      { kind: 'message', from: 'a', data: JSON.stringify({ type: 'signal', to: 'a', payload: 1 }), now: 5 },
      { kind: 'message', from: 'stranger', data: JSON.stringify({ type: 'signal', to: 'h', payload: 1 }), now: 5 },
      { kind: 'message', from: 'a', data: 'not json', now: 5 },
    ]);
    expect(r.out).toEqual([{ to: 'h', msg: { type: 'signal', from: 'a', payload: { kind: 'offer', sdp: 'x' } } }]);
    expect(r.state.lastActivity).toBe(5);
  });

  test('a guest leaving is announced; the host leaving closes the room for everyone', () => {
    const base = run(createRoomState(0), ['h', 'a', 'b'].map((id) => ({ kind: 'connect', id, now: 0 }) as RoomInput)).state;
    const guest = run(base, [{ kind: 'message', from: 'a', data: JSON.stringify({ type: 'leave' }), now: 1 }]);
    expect(guest.state.members).toEqual(['h', 'b']);
    expect(guest.out.map((o) => [o.to, o.msg.type, o.msg.id])).toEqual([
      ['h', 'peer-left', 'a'],
      ['b', 'peer-left', 'a'],
    ]);
    const host = run(guest.state, [{ kind: 'disconnect', id: 'h', now: 2 }]);
    expect(host.state.closed).toBe(true);
    expect(host.state.members).toEqual([]);
    expect(host.out).toEqual([{ to: 'b', msg: { type: 'closed', reason: 'host-left' } }]);
    expect(host.close.sort()).toEqual(['b', 'h']);
    // a closed room takes nobody
    const late = run(host.state, [{ kind: 'connect', id: 'z', now: 3 }]);
    expect(late.out[0]!.msg).toEqual({ type: 'error', reason: 'closed' });
  });

  test('idle for 10 minutes: closed', () => {
    const base = run(createRoomState(0), [{ kind: 'connect', id: 'h', now: 1000 }]).state;
    expect(run(base, [{ kind: 'alarm', now: 1000 + IDLE_MS - 1 }]).state.closed).toBe(false);
    const idle = run(base, [{ kind: 'alarm', now: 1000 + IDLE_MS }]);
    expect(idle.state.closed).toBe(true);
    expect(idle.out).toEqual([{ to: 'h', msg: { type: 'closed', reason: 'idle' } }]);
  });

  test('room codes: 6 characters without 0 O 1 I L', () => {
    for (const c of '0O1IL') expect(CODE_ALPHABET.includes(c)).toBe(false);
    let x = 7;
    const random = (): number => {
      x = (x * 16807) % 2147483647;
      return x / 2147483647;
    };
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode(random);
      expect(code).toHaveLength(CODE_LENGTH);
      expect(isRoomCode(code)).toBe(true);
    }
    expect(isRoomCode('ABC1EF')).toBe(false);
    expect(isRoomCode('ABCDE')).toBe(false);
    expect(isRoomCode(42)).toBe(false);
  });

  test('allowed origins: anyone with an empty list, else an exact scheme + host match; no Origin is refused', () => {
    expect(isOriginAllowed('https://evil.example', '')).toBe(true);
    expect(isOriginAllowed(null, ' ')).toBe(true);
    const list = 'https://github.yuuzu.net, http://github.yuuzu.net/';
    expect(isOriginAllowed('https://github.yuuzu.net', list)).toBe(true);
    expect(isOriginAllowed('http://github.yuuzu.net', list)).toBe(true);
    expect(isOriginAllowed('https://github.yuuzu.net:8443', list)).toBe(false);
    expect(isOriginAllowed('https://nakiriyuuzu.github.io', list)).toBe(false);
    expect(isOriginAllowed('http://localhost:5173', list)).toBe(false);
    expect(isOriginAllowed('null', list)).toBe(false);
    expect(isOriginAllowed(null, list)).toBe(false);
  });
});
