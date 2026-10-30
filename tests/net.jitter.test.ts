/**
 * Online jitter (Wi-Fi-like link) on the loopback transport: 35 ± 10 ms, 1 % loss, the link held for 20–90 ms every
 * 0.3–1.5 s (retries, power saving) and its base delay moving between 20 and 65 ms every 2–6 s. The host's playout
 * delay follows the link a step at a time, holding the guest's car or giving it an extra step (src/net/host.ts) while
 * the car's steps stay within LEAD_MAX (30) of the field, never skipping or inventing one of its inputs — so the
 * guest's own prediction is never corrected for it — and draws those steps spread out; a host or guest that loses
 * time is taken at once and leaves the band to the jitter, and a guest whose clock runs fast gains no more than the
 * band. The guest draws the other cars on a steered view clock with their snapshot jumps blended out
 * (src/net/client.ts), so their drawn motion stays smooth, also at 300 ms round trip.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, PlayerIndex, SessionConfig, WorldState } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { buildRenderFrame, createWorld, getPlayerCarId, stepWorld } from '../src/race/index';
import { HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { LoopbackNetwork } from '../src/net/loopback';
import type { NetTransport } from '../src/net/transport';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(cars: number): SessionConfig {
  const ids = RACERS.slice(0, cars);
  const seats: PlayerIndex[] = [0, 1];
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

interface WifiRun {
  cars: number;
  /** every step after 10 s with the guest's drawn frame */
  each?: (frame: ReturnType<ClientSession['renderFrame']>, guest: ClientSession, world: WorldState) => void;
  /** after every host step: the host's world and its end of the link */
  afterHost?: (world: WorldState, link: NetTransport) => void;
  /** the host's frame stalls and `steps` of its time are dropped at `at` s (the guest keeps driving) */
  hostDrop?: { at: number; steps: number }[];
  /** the guest's frame stalls past what its clock catches up: `steps` of its time lost at `at` s */
  guestStall?: { at: number; steps: number }[];
  /** the route `ms` slower for good from `at` s */
  routeAdd?: { at: number; ms: number };
  /** another link instead, steady (no hold-ups, no route changes) */
  link?: { delayMs: number; jitterMs: number; loss: number };
  /** the guest's clock runs fast: an extra step every this many */
  guestFast?: number;
  /** the link's random seed (default 9) */
  seed?: number;
}

/** Host (its car on the AI) + one guest (seat 1, its car on the AI on its mirror world) on the Wi-Fi-like link for 70 s. */
function wifiRace(o: WifiRun) {
  const track = getLayout('monza');
  const cfg = config(o.cars);
  const net = new LoopbackNetwork({ ...(o.link ?? { delayMs: 35, jitterMs: 10, loss: 0.01 }), seed: o.seed ?? 9 });
  const [h, c] = net.pair();
  const world = createWorld(cfg, track);
  const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
  const guest = new ClientSession(cfg, track, 1, 1, c);
  let rng = 12345;
  const random = (): number => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x7fffffff;
  };
  const guestStep = (): ReturnType<ClientSession['renderFrame']> => {
    guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
    guest.takeEvents();
    return guest.renderFrame(SIM_DT);
  };
  let nextStall = 5;
  let nextRoute = 8;
  let route = 35;
  let delay = -1;
  let delayChanges = 0;
  const hostDrops = (o.hostDrop ?? []).slice();
  const guestStalls = (o.guestStall ?? []).map((g) => ({ ...g }));
  while (world.time < 70) {
    const drop = hostDrops[0];
    if (drop && world.time >= drop.at) {
      hostDrops.shift();
      for (let i = 0; i < drop.steps; i++) {
        guestStep();
        net.advance(SIM_DT * 1000);
      }
    }
    if (o.routeAdd && Math.abs(world.time - o.routeAdd.at) < SIM_DT / 2) net.setDelay(route + o.routeAdd.ms);
    const inputs: (ControlInput | null)[] = [null, null, null, null];
    inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
    host.fillInputs(inputs);
    stepWorld(world, track, inputs, SIM_DT);
    world.events.length = 0;
    host.afterStep();
    o.afterHost?.(world, h);
    const stall = guestStalls.find((g) => world.time >= g.at && g.steps > 0);
    if (stall) stall.steps--;
    const frame = stall ? null : guestStep();
    if (o.guestFast && Math.round(world.time / SIM_DT) % o.guestFast === 0) guestStep();
    net.advance(SIM_DT * 1000);
    if (!o.link && world.time >= nextStall) {
      net.stall(20 + random() * 70);
      nextStall = world.time + 0.3 + random() * 1.2;
    }
    if (!o.link && world.time >= nextRoute) {
      route = 20 + random() * 45;
      net.setDelay(route + (o.routeAdd && world.time >= o.routeAdd.at ? o.routeAdd.ms : 0));
      nextRoute = world.time + 2 + random() * 4;
    }
    if (host.inputDelayOf(1) !== delay) {
      if (world.time > 10) delayChanges++;
      delay = host.inputDelayOf(1);
    }
    if (world.time < 10) guest.maxCorrection = 0;
    else if (frame) o.each?.(frame, guest, world);
  }
  return { world, host, guest, delayChanges };
}

/** Per-step second difference of a drawn path (smooth motion: millimetres; a step stood still or doubled: a step). */
function secondDiffs(): { add(x: number, z: number): void; values: number[] } {
  const h: { x: number; z: number }[] = [];
  const values: number[] = [];
  return {
    values,
    add(x, z) {
      h.push({ x, z });
      if (h.length > 3) h.shift();
      if (h.length === 3) values.push(Math.hypot(h[2]!.x - 2 * h[1]!.x + h[0]!.x, h[2]!.z - 2 * h[1]!.z + h[0]!.z));
    },
  };
}

describe('online jitter', () => {
  test(
    "the host's playout delay follows the link without touching the guest's inputs: no own-car correction, the host draws the car smoothly",
    () => {
      // two cars far apart: nothing but the timeline could move the guest's car off its prediction
      const track = getLayout('monza');
      const drawnOnHost = secondDiffs();
      const { world, guest, delayChanges } = wifiRace({
        cars: 2,
        afterHost: (w) => {
          if (w.time < 10) return;
          const c = buildRenderFrame(w, track).cars.find((x) => x.carId === 1)!;
          drawnOnHost.add(c.x, c.z);
        },
      });
      expect(delayChanges).toBeGreaterThanOrEqual(5);
      // measured 0.00 m (skipping a record when the delay shrank / driving a step on the last one when it grew:
      // 0.2–1.3 m pull-backs, one at every change)
      expect(guest.maxCorrection).toBeLessThan(0.1);
      expect(guest.corrections).toBeGreaterThan(1000);
      expect(world.cars[guest.carId]!.status).toBe('running');
      expect(world.cars[guest.carId]!.phys.speed).toBeGreaterThan(20);
      // the guest's car as the host draws it: measured max 0.055–0.154 m over 12 link seeds (a held / extra step drawn
      // as it is: 0.68 m)
      expect(Math.max(...drawnOnHost.values)).toBeLessThan(0.25);
    },
    120_000,
  );

  test(
    'the other cars move smoothly on the guest: no jumps from late snapshots or extrapolation corrections',
    () => {
      // second difference of each other car's drawn position per step (smooth motion: millimetres)
      const paths = new Map<number, ReturnType<typeof secondDiffs>>();
      const { guest } = wifiRace({
        cars: 12,
        each: (frame, g) => {
          for (const c of frame.cars) {
            if (c.carId === g.carId) continue;
            const p = paths.get(c.carId) ?? secondDiffs();
            p.add(c.x, c.z);
            paths.set(c.carId, p);
          }
        },
      });
      const jerk = [...paths.values()].flatMap((p) => p.values).sort((a, b) => a - b);
      expect(jerk.length).toBeGreaterThan(50_000);
      // measured p99 0.019 m, max 0.051 m. The place alone blended (no speed term): max 0.095 m; the view time nudged
      // toward every snapshot's arrival as before (a late one pulled every car back) with an exponential correction:
      // p99 0.14 m, max 0.9 m
      expect(jerk[Math.floor(jerk.length * 0.99)]!).toBeLessThan(0.03);
      expect(jerk[jerk.length - 1]!).toBeLessThan(0.075);
      expect(guest.corrections).toBeGreaterThan(1000);
    },
    120_000,
  );

  test(
    'at 300 ms round trip (the view at the extrapolation limit) the other cars still move smoothly on the guest',
    () => {
      // the per-step second difference's p99 sits on its ~1 % of jumps, so it moves with the link's luck: 5 link seeds
      const p99s: number[] = [];
      for (const seed of [9, 10, 11, 12, 13]) {
        const paths = new Map<number, ReturnType<typeof secondDiffs>>();
        wifiRace({
          cars: 12,
          seed,
          link: { delayMs: 150, jitterMs: 40, loss: 0.02 },
          each: (frame, g) => {
            for (const c of frame.cars) {
              if (c.carId === g.carId) continue;
              const p = paths.get(c.carId) ?? secondDiffs();
              p.add(c.x, c.z);
              paths.set(c.carId, p);
            }
          },
        });
        const jerk = [...paths.values()].flatMap((p) => p.values).sort((a, b) => a - b);
        expect(jerk.length).toBeGreaterThan(50_000);
        p99s.push(jerk[Math.floor(jerk.length * 0.99)]!);
      }
      // measured 0.18 m (0.11–0.30 per seed). 409fe48 without the blend: 0.36; the blend's drawn speed taken a step
      // ahead (past the limit: 0, a brake): 0.58
      expect(p99s.reduce((a, b) => a + b, 0) / p99s.length).toBeLessThan(0.265);
    },
    120_000,
  );

  test(
    'a guest whose clock runs 0.83 % fast gains at most the band on the field (0.25 s), its records past it skipped',
    () => {
      const progress = (fast?: number) => {
        const track: { t: number; progress: number }[] = [];
        wifiRace({
          cars: 2,
          ...(fast ? { guestFast: fast } : {}),
          afterHost: (w) => track.push({ t: w.time, progress: w.cars[getPlayerCarId(w, 1)]!.timing.progress }),
        });
        return track;
      };
      const normal = progress();
      const fast = progress(120);
      // when the fast guest's car gets where the other one was at 65 s
      const mark = normal.find((p) => p.t >= 65)!;
      const reached = fast.find((p) => p.progress >= mark.progress)!;
      // measured 0.23 s. Every record played once (no band, or one re-centred while the car is settled): 0.43 s by
      // then and growing, 0.83 % of the race
      expect(mark.t - reached.t).toBeLessThan(0.3);
    },
    120_000,
  );

  test(
    'after the host or the guest lost time the band is still there for the jitter: no own-car correction',
    () => {
      // the host drops 0.5 s at 12 s, the guest loses 0.33 s at 30 s; each is taken at once (an own-car correction
      // then, the time really lost), the jitter after it again a step at a time
      const after: number[] = [];
      const { world, guest } = wifiRace({
        cars: 2,
        hostDrop: [{ at: 12, steps: 60 }],
        guestStall: [{ at: 30, steps: 40 }],
        each: (_frame, g, w) => {
          const t = w.time;
          if ((t > 13 && t < 29.9) || t > 31.5) after.push(g.maxCorrection);
          if ((t >= 29.9 && t < 31.5) || (t >= 12 && t <= 13)) g.maxCorrection = 0;
        },
      });
      // measured 0.00 m (409fe48: 1.95 m after the host's loss, 0.71 m after the guest's)
      expect(Math.max(...after)).toBeLessThan(0.1);
      expect(world.cars[guest.carId]!.status).toBe('running');
    },
    120_000,
  );

  test(
    'lasting changes (the guest or the host loses a few steps, the route 80 or 200 ms slower) leave the band to the jitter',
    () => {
      // holds or extra steps, not a jump: 15 of the band's 30 in all, or 10 / 24 at once
      const losses = [{ at: 15, steps: 5 }, { at: 25, steps: 5 }, { at: 35, steps: 5 }];
      for (const run of [{ guestStall: losses }, { hostDrop: losses }, { routeAdd: { at: 15, ms: 80 } }, { routeAdd: { at: 15, ms: 200 } }]) {
        let worst = 0;
        wifiRace({ cars: 2, ...run, each: (_frame, g) => (worst = Math.max(worst, g.maxCorrection)) });
        // measured 0.00 m each (a band of 12: used up, the jitter after it corrected 1.41 / 1.37 / 0.65 m; more than 12
        // steps still to take treated as lost time, at once: 9.2 m for the 200 ms)
        expect(worst).toBeLessThan(0.1);
      }
    },
    120_000,
  );

  test(
    "a guest whose link closes on a step its car is held: the AI drives the car on",
    () => {
      const drop = { at: -1, progress: 0 };
      const { world } = wifiRace({
        cars: 2,
        afterHost: (w, link) => {
          const car = w.cars[1]!;
          if (drop.at >= 0 || w.time < 12 || !car.race.netHold) return;
          drop.at = w.time;
          drop.progress = car.timing.progress;
          link.onClose?.();
        },
      });
      const car = world.cars[1]!;
      expect(drop.at).toBeGreaterThan(0);
      expect(car.playerIndex).toBe(-1);
      // the hold flag cleared with the player (still set, the car never steps again: it stays where it was dropped)
      expect(car.race.netHold).toBeFalsy();
      expect(car.timing.progress - drop.progress).toBeGreaterThan(1000);
    },
    120_000,
  );
});
