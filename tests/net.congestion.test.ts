/**
 * Online congestion (src/net/host.ts send policy) on a bandwidth-limited loopback link: when the host's upload gets
 * slower than what it sends (Wi-Fi trouble, another upload), snapshots and HUD mirror patches must not queue behind
 * each other — the guest would see the race seconds late and the ping would read seconds. The host sends real-time
 * state only while the link has nothing much waiting (newest wins), so the delay stays at the link's own.
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
import { LoopbackNetwork } from '../src/net/loopback';
import { decodeMessage, decodeSnapshot } from '../src/net/protocol';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(layoutId: string, seats: readonly PlayerIndex[], cars: number): SessionConfig {
  const ids = RACERS.slice(0, cars);
  return {
    mode: 'splitScreen',
    kind: 'race',
    layoutId,
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

const KB = 1024;

/** Host + one guest (seat 1) on a 20-car grid, both cars driven by the AI; `hook` sees every message the guest gets. */
function setup(bandwidth: number) {
  const track = getLayout('monza');
  const cfg = config('monza', [0, 1], 20);
  const net = new LoopbackNetwork({ delayMs: 40, jitterMs: 5, loss: 0.01, seed: 5, bandwidth });
  const [h, c] = net.pair();
  const world = createWorld(cfg, track);
  const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
  const guest = new ClientSession(cfg, track, 1, 1, c);
  const step = (): void => {
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
  };
  return { world, net, host, guest, link: h, guestEnd: c, step };
}

describe('online congestion', () => {
  test(
    'a link slower than the host sends for 3 s: the guest sees the race at the link delay, not seconds late',
    () => {
      const track = getLayout('monza');
      // a full field: ~1.4 KB snapshots (frame + own car) at 30 Hz + ~5 KB mirror patches at 5 Hz ≈ 70 KB/s to the guest
      const cfg = config('monza', [0, 1], 20);
      const net = new LoopbackNetwork({ delayMs: 40, jitterMs: 5, loss: 0.01, seed: 5, bandwidth: 400 * KB });
      const [h, c] = net.pair();
      const world = createWorld(cfg, track);
      const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
      const guest = new ClientSession(cfg, track, 1, 1, c);
      // how old each snapshot is when the guest gets it (s of host time)
      const ages: { at: number; age: number }[] = [];
      // when HUD mirror patches arrive
      const mirrors: number[] = [];
      const deliver = c.onMessage;
      c.onMessage = (channel, data) => {
        if (channel === 'state') {
          const s = decodeSnapshot(data);
          if (s) ages.push({ at: world.time, age: world.time - s.time });
        } else if (decodeMessage(data)?.t === 'mirror') mirrors.push(world.time);
        deliver?.(channel, data);
      };
      const pings: { at: number; ms: number }[] = [];
      let lastPing = -1;
      const DIP_FROM = 20;
      const DIP_TO = 23;
      let dipped = false;
      let restored = false;
      while (world.time < 32) {
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
        if (!dipped && world.time >= DIP_FROM) {
          dipped = true;
          net.setBandwidth(50 * KB);
        }
        if (!restored && world.time >= DIP_TO) {
          restored = true;
          net.setBandwidth(400 * KB);
        }
        const p = host.pingOf(1);
        if (p !== lastPing) {
          lastPing = p;
          pings.push({ at: world.time, ms: p });
        }
      }
      const worst = (from: number, to: number): number => Math.max(...ages.filter((a) => a.at >= from && a.at < to).map((a) => a.age));
      const before = worst(10, DIP_FROM);
      const during = worst(DIP_FROM, DIP_TO + 0.5);
      const after = worst(DIP_TO + 2, 32);
      const pingDuring = Math.max(...pings.filter((p) => p.at >= DIP_FROM && p.at < DIP_TO + 2).map((p) => p.ms));
      // healthy: 40–45 ms link + up to one snapshot interval of the guest's frame
      expect(before).toBeLessThan(0.1);
      // congested: one snapshot's transmission at 50 KB/s on top (~60 ms), never a queue of them (sending all: 3–4 s)
      expect(during).toBeLessThan(0.25);
      expect(after).toBeLessThan(0.1);
      // the reliable channel (events, pings, results) is not stuck behind HUD patches either (sending all: seconds)
      expect(pingDuring).toBeLessThan(400);
      // healthy: every snapshot (30 Hz); congested: fewer, not none (measured 13 / s at 50 KB/s, positions first)
      expect(ages.filter((a) => a.at >= 10 && a.at < DIP_FROM).length).toBeGreaterThanOrEqual(29 * 10);
      expect(ages.filter((a) => a.at >= DIP_FROM && a.at < DIP_TO).length).toBeGreaterThan(30);
      // the HUD mirror: 5 Hz healthy, still about every 0.6–0.9 s while congested (snapshots first)
      expect(mirrors.filter((t) => t >= 10 && t < DIP_FROM).length).toBeGreaterThanOrEqual(49);
      const gaps = mirrors.filter((t) => t >= DIP_FROM - 1 && t < DIP_TO + 1).map((t, i, a) => (i > 0 ? t - a[i - 1]! : 0));
      expect(Math.max(...gaps)).toBeLessThan(1);
      expect(world.cars[guest.carId]!.status).toBe('running');
    },
    120_000,
  );

  test(
    'a very slow link (8 KB/s, less than the HUD patches alone): nothing piles up, snapshots still get through',
    () => {
      const { world, net, host, link, guestEnd, step } = setup(400 * KB);
      let snapshots = 0;
      const deliver = guestEnd.onMessage;
      guestEnd.onMessage = (channel, data) => {
        if (channel === 'state' && decodeSnapshot(data)) snapshots++;
        deliver?.(channel, data);
      };
      while (world.time < 10) step();
      net.setBandwidth(8 * KB);
      snapshots = 0;
      let queued = 0;
      while (world.time < 30) {
        step();
        if (world.time > 15) queued = Math.max(queued, link.buffered('reliable'));
      }
      // forced patches only behind snapshots, never behind another patch: the reliable queue stays at about one
      // patch (forcing behind queued patches: 16 → 40 KB and growing, the ping 1 → 3.6 s, 1 snapshot in 30 s)
      expect(queued).toBeLessThan(10 * KB);
      expect(host.pingOf(1)).toBeLessThan(1500);
      expect(snapshots).toBeGreaterThan(10);
    },
    120_000,
  );
});
