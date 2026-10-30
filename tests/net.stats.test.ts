/**
 * Connection diagnostics (src/net/stats.ts, the sessions' linkStats, src/ui/hud/netPanel.ts): seq gaps counted as
 * loss (a late one taken back, uint16 wrap-around), rates over the window, and on a loopback link the guest's and the
 * host's numbers matching what the link does — a lossy link shows loss, a congested one deferred snapshots, not loss.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, PlayerIndex, SessionConfig } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { createWorld, getPlayerCarId, stepWorld } from '../src/race/index';
import { HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { LoopbackNetwork, type LoopbackOptions } from '../src/net/loopback';
import { STATS_WINDOW_MS, SeqTracker, StatWindow } from '../src/net/stats';
import { netPanelRows } from '../src/ui/hud/netPanel';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');
const KB = 1024;

function config(seats: readonly PlayerIndex[], cars: number): SessionConfig {
  const ids = RACERS.slice(0, cars);
  return {
    mode: 'splitScreen',
    kind: 'race',
    layoutId: 'monza',
    laps: 50,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 80,
    players: seats.map((pi) => ({ playerIndex: pi, driverId: ids[pi]!.id, teamId: ids[pi]!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } })),
    grid: ids.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: (seats.includes(i as PlayerIndex) ? i : -1) as -1 | PlayerIndex, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed: 21,
    ghost: null,
    objective: null,
  };
}

describe('statistics', () => {
  test('seq gaps are loss; a late arrival is taken back; uint16 wrap-around is no gap', () => {
    const t = new SeqTracker();
    let at = 0;
    for (let seq = 0; seq < 50; seq++, at += 33) if (seq % 10 !== 5) t.arrived(seq, at);
    expect(t.loss(at)).toBeCloseTo(5 / 50, 5);
    // seq 45 turns up late after all
    t.arrived(45, at);
    expect(t.loss(at)).toBeCloseTo(4 / 50, 5);
    const w = new SeqTracker();
    for (const seq of [65533, 65534, 65535, 0, 1, 2]) w.arrived(seq, (at += 33));
    expect(w.loss(at)).toBe(0);
    // the longest wait counts the one still going on
    expect(w.maxGap(at)).toBe(33);
    expect(w.maxGap(at + 500)).toBe(500);
  });

  test('a duplicate counts once, of the newest seq or of an older one', () => {
    const t = new SeqTracker();
    let at = 0;
    for (let seq = 0; seq < 60; seq++, at += 33) if (seq !== 30) t.arrived(seq, at);
    t.arrived(59, at);
    t.arrived(20, at);
    expect(t.loss(at)).toBeCloseTo(1 / 60, 5);
  });

  test('a rare event long after watching began is a rare rate, not a burst', () => {
    const s = new StatWindow(0);
    s.add(60_000);
    expect(s.perSecond(60_100)).toBeCloseTo(1000 / STATS_WINDOW_MS, 5);
  });

  test('rates over the window, its start included; old samples age out', () => {
    const s = new StatWindow();
    for (let at = 0; at <= 1000; at += 100) s.add(at, 10);
    expect(s.perSecond(1000)).toBeCloseTo(110, 5);
    expect(s.max(1000)).toBe(10);
    expect(s.perSecond(1000 + STATS_WINDOW_MS + 1)).toBe(0);
  });
});

/** Host + one guest (seat 1) on a 20-car grid, both cars driven by the AI, until `seconds` of race time. */
function race(opts: LoopbackOptions, seconds: number) {
  const track = getLayout('monza');
  const cfg = config([0, 1], 20);
  const net = new LoopbackNetwork(opts);
  const [h, c] = net.pair();
  const world = createWorld(cfg, track);
  const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
  const guest = new ClientSession(cfg, track, 1, 1, c);
  guest.useClock({ now: () => net.now, owed: (since) => since });
  // the guest's 2 s loss figures, one sample per window after the first
  const losses: { snapshot: number; own: number }[] = [];
  let sampleAt = 4;
  while (world.time < seconds) {
    const inputs: (ControlInput | null)[] = [null, null, null, null];
    inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
    host.fillInputs(inputs);
    stepWorld(world, track, inputs, SIM_DT);
    host.forwardEvents(world.events);
    world.events.length = 0;
    host.afterStep();
    guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
    guest.takeEvents();
    guest.renderFrame(SIM_DT);
    net.advance(SIM_DT * 1000);
    if (world.time >= sampleAt) {
      sampleAt += 2;
      const g = guest.linkStats();
      losses.push({ snapshot: g.snapshotLoss, own: g.ownLoss });
    }
  }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return { host: host.linkStats(), guest: guest.linkStats(), snapshotLoss: mean(losses.map((l) => l.snapshot)), ownLoss: mean(losses.map((l) => l.own)) };
}

describe('session link statistics', () => {
  test(
    'a lossy link: the guest reports the loss and ~30 Hz less what was lost; the host sent every snapshot',
    () => {
      const { host, guest, snapshotLoss, ownLoss } = race({ delayMs: 60, jitterMs: 10, loss: 0.08, seed: 3 }, 20);
      // (the 2 s windows of the race averaged: one window alone swings with the dice)
      expect(snapshotLoss).toBeGreaterThan(0.05);
      expect(snapshotLoss).toBeLessThan(0.11);
      expect(ownLoss).toBeGreaterThan(0.05);
      expect(ownLoss).toBeLessThan(0.11);
      expect(guest.snapshotHz).toBeGreaterThan(24);
      expect(guest.snapshotHz).toBeLessThan(30.5);
      expect(guest.pingMs).toBeGreaterThan(100);
      // the guest gets the snapshots and the HUD mirror, sends 60 input packets a second
      expect(guest.downBps).toBeGreaterThan(20 * KB);
      expect(guest.upBps).toBeGreaterThan(1 * KB);
      expect(guest.peer).toBeNull();
      expect(host).toHaveLength(1);
      expect(host[0]!.snapshotHz).toBeGreaterThan(29);
      expect(host[0]!.deferredHz).toBe(0);
      expect(host[0]!.inputDelayMs).toBeGreaterThan(40);
      // what the host sent arrives less the 8 % the link drops (the reliable part all of it)
      expect(guest.downBps / host[0]!.upBps).toBeGreaterThan(0.8);
      expect(guest.downBps / host[0]!.upBps).toBeLessThan(1.02);
    },
    120_000,
  );

  test(
    'a congested link: the host defers snapshots (newest wins), the guest gets fewer but loses none',
    () => {
      const { host, guest } = race({ delayMs: 40, jitterMs: 5, seed: 4, bandwidth: 25 * KB }, 20);
      expect(host[0]!.deferredHz).toBeGreaterThan(3);
      expect(host[0]!.snapshotHz).toBeLessThan(27);
      expect(guest.snapshotHz).toBeLessThan(27);
      expect(guest.snapshotLoss).toBe(0);
    },
    120_000,
  );
});

describe('diagnostics panel', () => {
  test('a guest on a bad link: the culprits are marked, the healthy values are not', () => {
    const rows = netPanelRows(
      {
        role: 'guest',
        link: {
          pingMs: 130,
          peer: { rttMs: 118, route: 'direct' },
          snapshotHz: 14,
          snapshotLoss: 0.12,
          ownLoss: 0.01,
          maxGapMs: 400,
          correctionM: 0.1,
          downBps: 50 * KB,
          upBps: 5 * KB,
        },
      },
      60,
    );
    const at = (label: string) => rows.find((r) => r.label === label)!;
    expect(at('路徑').value).toBe('點對點直連');
    expect(at('網路來回')).toMatchObject({ value: '118 ms', level: 'warn' });
    expect(at('快照')).toMatchObject({ value: '14 Hz・遺失 12.0%', level: 'bad' });
    expect(at('最長間隔').level).toBe('bad');
    expect(at('自車狀態').level).toBeNull();
    expect(at('畫面')).toMatchObject({ value: '60 FPS', level: null });
  });

  test('the host lists each guest under its name; a slow frame rate is marked', () => {
    const link = { name: 'Ann', pingMs: 40, peer: null, snapshotHz: 30, deferredHz: 0, upBps: 45 * KB, downBps: 4 * KB, backlogBytes: 0, inputDelayMs: 50, guessHz: 0 };
    const rows = netPanelRows({ role: 'host', links: [link, { ...link, name: 'Bo', deferredHz: 8, backlogBytes: 40000 }] }, 24);
    expect(rows.filter((r) => r.label === null).map((r) => r.value)).toEqual(['Ann', 'Bo']);
    expect(rows.filter((r) => r.label === '快照').map((r) => r.level)).toEqual([null, 'bad']);
    expect(rows.filter((r) => r.label === '上傳').map((r) => r.level)).toEqual([null, 'bad']);
    expect(rows.find((r) => r.label === '路徑')!.value).toBe('—');
    expect(rows[rows.length - 1]).toMatchObject({ label: '畫面', level: 'bad' });
    expect(netPanelRows({ role: 'host', links: [] }, 60)[0]!.value).toBe('沒有連線中的玩家');
  });
});
