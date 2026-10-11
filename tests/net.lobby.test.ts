/**
 * Online lobby (src/net/lobby.ts) over the loopback transport: seats, unique drivers, ready / start, a full room,
 * protocol versions, guests leaving, the guests' car setup and assists reaching the host, session start messages.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_ASSISTS, DEFAULT_SETUP } from '../src/core/defaults';
import type { SessionConfig } from '../src/core/types';
import { builtinRoster } from '../src/meta/roster';
import { GuestLobby, HostLobby } from '../src/net/lobby';
import { LoopbackNetwork } from '../src/net/loopback';
import { encodeMessage } from '../src/net/protocol';

const settings = {
  layoutId: 'monza',
  laps: 5,
  weather: 'clear',
  aiCount: 8,
  aiDifficulty: 80,
  regulation: '2025',
  format: 'raceOnly',
  rules: { safetyCar: 'standard', redFlags: true, formationLap: false, aeroWake: true },
} as const;

function setup(guests: number) {
  const net = new LoopbackNetwork({ delayMs: 20 });
  const host = new HostLobby({ code: 'K7MPQ2', name: 'Host', roster: builtinRoster(), settings, now: () => net.now });
  const starts: { session: number; final: boolean }[][] = [];
  const closed: string[] = [];
  const lobbies = Array.from({ length: guests }, (_, i) => {
    const [h, g] = net.pair();
    host.addGuest(h);
    starts.push([]);
    return new GuestLobby(g, `G${i + 1}`, {
      start: (session, _c, final) => starts[i]!.push({ session, final }),
      closed: (r) => closed.push(`${i}:${r}`),
    });
  });
  net.advance(200);
  return { net, host, lobbies, starts, closed };
}

describe('online lobby', () => {
  test('guests get seats 1–3 with distinct drivers; picks stay unique; everyone sees the lobby', () => {
    const { net, host, lobbies } = setup(3);
    expect(lobbies.map((l) => l.playerIndex)).toEqual([1, 2, 3]);
    expect(host.state.players.map((p) => p.playerIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(host.state.players.map((p) => p.driverId)).size).toBe(4);
    for (const l of lobbies) expect(l.state?.players).toHaveLength(4);
    // a guest asks for the host's driver: refused; a free one: taken
    const hostDriver = host.host.driverId;
    const free = host.state.roster.drivers.find((d) => !host.state.players.some((p) => p.driverId === d.id))!;
    const g1 = lobbies[0]!;
    const hostTeam = host.state.roster.drivers.find((d) => d.id === hostDriver)!.teamId;
    g1.pick(hostTeam, hostDriver);
    net.advance(100);
    expect(host.state.players[1]!.driverId).not.toBe(hostDriver);
    g1.pick(free.teamId, free.id, { ...DEFAULT_SETUP, frontWing: DEFAULT_SETUP.frontWing + 2 }, { ...DEFAULT_ASSISTS, abs: false });
    net.advance(100);
    expect(host.state.players[1]!.driverId).toBe(free.id);
    expect(lobbies[2]!.state?.players[1]!.driverId).toBe(free.id);
    // the host simulates the guest's car with the guest's setup and assists
    const car = host.guestCar(1)!;
    expect(car.setup.frontWing).toBe(DEFAULT_SETUP.frontWing + 2);
    expect(car.assists.abs).toBe(false);
    // a team / driver mismatch is refused too
    const other = host.state.roster.drivers.find((d) => d.teamId !== free.teamId)!;
    g1.pick(other.teamId === free.teamId ? 'x' : free.teamId, other.id);
    net.advance(100);
    expect(host.state.players[1]!.driverId).toBe(free.id);
    // the host's race-control rules reach every guest (safety car off)
    host.setSettings({ rules: { ...host.state.settings.rules, safetyCar: 'off' } });
    net.advance(100);
    for (const l of lobbies) expect(l.state?.settings.rules.safetyCar).toBe('off');
  });

  test('start needs every guest ready; the start message reaches everyone; links leave the lobby during a session', () => {
    const { net, host, lobbies, starts } = setup(2);
    expect(host.canStart()).toBe(false);
    lobbies[0]!.setReady(true);
    net.advance(100);
    expect(host.canStart()).toBe(false);
    lobbies[1]!.setReady(true);
    net.advance(100);
    expect(host.canStart()).toBe(true);
    const players = host.sessionPlayers();
    expect(players.map((p) => p.playerIndex)).toEqual([1, 2]);
    host.startSession(1, { layoutId: 'monza', grid: [] } as unknown as SessionConfig, false);
    net.advance(100);
    expect(starts).toEqual([[{ session: 1, final: false }], [{ session: 1, final: false }]]);
    // during the session the lobby ignores picks; afterwards (weekend over) ready flags reset
    lobbies[0]!.setReady(false);
    net.advance(100);
    expect(host.state.players[1]!.ready).toBe(true);
    host.attach(true);
    net.advance(100);
    expect(host.state.players.slice(1).every((p) => !p.ready)).toBe(true);
  });

  test('a fifth player, a wrong version and a running weekend are refused; leaving frees the seat', () => {
    const { net, host, lobbies, closed } = setup(3);
    const [h5, g5] = net.pair();
    host.addGuest(h5);
    const late = new GuestLobby(g5, 'late', { closed: (r) => closed.push(`late:${r}`) });
    net.advance(100);
    expect(late.playerIndex).toBeNull();
    expect(closed.some((c) => c.startsWith('late:') && c.includes('已滿'))).toBe(true);
    // a guest leaves: the seat frees up for the next one
    lobbies[1]!.leave();
    net.advance(100);
    expect(host.state.players.map((p) => p.playerIndex)).toEqual([0, 1, 3]);
    // another build of the game
    const [hv, gv] = net.pair();
    host.addGuest(hv);
    let reason = '';
    gv.onMessage = (_c, d) => {
      if (typeof d === 'string' && d.includes('reject')) reason = d;
    };
    gv.send('reliable', encodeMessage({ t: 'join', version: 999, name: 'old' }));
    net.advance(100);
    expect(reason).toContain('版本');
    expect(host.state.players).toHaveLength(3);
    // a weekend under way takes nobody
    host.startSession(1, { layoutId: 'monza', grid: [] } as unknown as SessionConfig, true);
    const [hs, gs] = net.pair();
    host.addGuest(hs);
    const during = new GuestLobby(gs, 'during', { closed: (r) => closed.push(`during:${r}`) });
    net.advance(100);
    expect(during.playerIndex).toBeNull();
    expect(closed.some((c) => c.startsWith('during:'))).toBe(true);
  });

  test('the host closing the room tells every guest', () => {
    const { net, host, closed } = setup(2);
    host.close();
    net.advance(100);
    expect(closed).toHaveLength(2);
    expect(closed.every((c) => c.includes('房主'))).toBe(true);
  });
});
