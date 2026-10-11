/**
 * Online lag (src/net/host.ts input timeline) on the loopback transport: lag spikes (everything held for 600 ms, then
 * a burst), a guest frame that loses time, a guest frozen for 3 s and a host frame that loses time. The host guesses a
 * late input, replays the car with the real ones once they arrive and keeps its playout delay at the link's latency;
 * a guessed car is a ghost to the others (race netGhost). Online seats 3 and 4 get their car and drive it.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, PlayerIndex, SessionConfig } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { createWorld, getPlayerCarId, stepWorld } from '../src/race/index';
import { carContacts } from '../src/race/contact';
import { HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { LoopbackNetwork } from '../src/net/loopback';
import { standardRoster } from '../src/meta/roster';
import { buildSessionConfig, validateSessionConfig } from '../src/meta/sessionBuilder';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(layoutId: string, seats: readonly PlayerIndex[], cars = 8): SessionConfig {
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

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

/** Host (its car on the AI) + one guest in seat 1 driving its car with the AI on its mirror world. */
function race(layoutId: string) {
  const track = getLayout(layoutId);
  const cfg = config(layoutId, [0, 1]);
  const net = new LoopbackNetwork({ delayMs: 40, jitterMs: 10, loss: 0.02, seed: 3 });
  const [h, c] = net.pair();
  const world = createWorld(cfg, track);
  const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
  const guest = new ClientSession(cfg, track, 1, 1, c);
  const hostStep = (): void => {
    const inputs: (ControlInput | null)[] = [null, null, null, null];
    inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
    host.fillInputs(inputs);
    stepWorld(world, track, inputs, SIM_DT);
    world.events.length = 0;
    host.afterStep();
  };
  const guestStep = (): void => {
    guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
    guest.takeEvents();
    guest.renderFrame(SIM_DT);
  };
  return { world, net, host, guest, hostStep, guestStep };
}

describe('online lag', () => {
  test(
    'lag spikes: late inputs are replayed (the car drives as the player saw it), the input delay comes back',
    () => {
      const { world, net, host, guest, hostStep, guestStep } = race('monaco');
      const spikes = [30, 40, 50, 60];
      const before: number[] = [];
      const after: number[] = [];
      let delayBefore = 0;
      while (world.time < 75) {
        hostStep();
        guestStep();
        net.advance(SIM_DT * 1000);
        if (spikes.length > 0 && world.time >= spikes[0]!) {
          spikes.shift();
          if (delayBefore === 0) delayBefore = host.inputDelayOf(1);
          net.stall(600);
        }
        if (world.time > 20 && world.time < 30) before.push(guest.pendingInputs);
        if (world.time > 68) after.push(guest.pendingInputs);
      }
      const car = world.cars[guest.carId]!;
      expect(car.status).toBe('running');
      // every spike: about 70 steps (0.6 s) guessed, then replayed with the real inputs
      expect(host.replayed).toBeGreaterThan(4 * 50);
      // the host's car is where the guest predicted it (measured 0.1 m; holding the last input instead: 34 m and
      // into the barriers)
      expect(guest.maxCorrection).toBeLessThan(1.5);
      // no delay left behind (measured 13 → 13 steps; buffering instead: 11 → 21)
      expect(median(after)).toBeLessThanOrEqual(median(before) + 1);
      expect(Math.abs(host.inputDelayOf(1) - delayBefore)).toBeLessThanOrEqual(1);
    },
    120_000,
  );

  test(
    'a guest frame and a host frame that lose 40 steps: the playout delay re-anchors, the input latency comes back',
    () => {
      const { world, net, guest, hostStep, guestStep } = race('monza');
      const before: number[] = [];
      const afterGuest: number[] = [];
      const afterHost: number[] = [];
      let hostHitch = false;
      while (world.time < 70) {
        if (!hostHitch && world.time >= 50) {
          // the host's frame stalls: the guest keeps sending
          hostHitch = true;
          for (let i = 0; i < 40; i++) {
            guestStep();
            net.advance(SIM_DT * 1000);
          }
        }
        hostStep();
        // the guest's frame stalls past what it catches up: 40 steps of its time lost
        if (world.time < 30 || world.time >= 30 + 40 * SIM_DT) guestStep();
        net.advance(SIM_DT * 1000);
        if (world.time > 20 && world.time < 30) before.push(guest.pendingInputs);
        if (world.time > 44 && world.time < 50) afterGuest.push(guest.pendingInputs);
        if (world.time > 64) afterHost.push(guest.pendingInputs);
      }
      expect(world.cars[guest.carId]!.status).toBe('running');
      expect(median(afterGuest)).toBeLessThanOrEqual(median(before) + 2);
      expect(median(afterHost)).toBeLessThanOrEqual(median(before) + 2);
      // and settled: the prediction matches the host again
      guest.maxCorrection = 0;
      for (let i = 0; i < 600; i++) {
        hostStep();
        guestStep();
        net.advance(SIM_DT * 1000);
      }
      expect(guest.maxCorrection).toBeLessThan(1.5);
    },
    120_000,
  );

  test(
    'a guest frozen for 3 s (a background tab) drives its car again right after it is back',
    () => {
      const { world, net, guest, hostStep, guestStep } = race('monza');
      const brake: ControlInput = { throttle: 0, brake: 1, steer: 0, shiftUp: false, shiftDown: false, drsPressed: false, ersCycle: false, limiterToggle: false, overtakeHeld: false };
      let back = -1;
      const throttle: number[] = [];
      while (world.time < 40) {
        hostStep();
        if (world.time < 30) guestStep();
        else if (world.time >= 33) {
          if (back < 0) back = world.time;
          if (world.time < back + 1.3) {
            // back: full brakes at once
            guest.step(brake);
            guest.takeEvents();
            guest.renderFrame(SIM_DT);
          } else guestStep();
          if (world.time > back + 2) expect(guest.pendingInputs).toBeGreaterThan(0);
        }
        net.advance(SIM_DT * 1000);
        if (back >= 0 && world.time > back + 0.3 && world.time < back + 1.3) throttle.push(world.cars[guest.carId]!.phys.throttle);
      }
      // the host applies the guest's braking within 0.3 s (re-anchoring by holding instead: 3 s of old inputs)
      expect(throttle.length).toBeGreaterThan(100);
      expect(Math.max(...throttle)).toBeLessThan(0.05);
      guest.maxCorrection = 0;
      for (let i = 0; i < 360; i++) {
        hostStep();
        guestStep();
        net.advance(SIM_DT * 1000);
      }
      expect(guest.maxCorrection).toBeLessThan(1.5);
    },
    120_000,
  );

  test('a car driven on a guess for a while (race netGhost) touches no other car', () => {
    const track = getLayout('monza');
    const world = createWorld(config('monza', [0], 2), track);
    const [a, b] = world.cars as [(typeof world.cars)[0], (typeof world.cars)[0]];
    const overlap = (): void => {
      b.phys.x = a.phys.x + 1;
      b.phys.z = a.phys.z;
      b.phys.s = a.phys.s;
      world.events.length = 0;
    };
    overlap();
    a.race.netGhost = true;
    carContacts(world, track);
    expect(world.events.some((e) => e.type === 'collision')).toBe(false);
    expect(b.phys.x).toBe(a.phys.x + 1);
    a.race.netGhost = false;
    a.phys.vx = 30;
    carContacts(world, track);
    expect(b.phys.x).not.toBe(a.phys.x + 1);
  });

  test('online seats 3 and 4 are in the session and drive their own cars', () => {
    const roster = standardRoster();
    const ds = roster.drivers.slice(0, 4);
    const built = buildSessionConfig({
      mode: 'splitScreen',
      kind: 'race',
      layoutId: 'monza',
      raceLaps: 3,
      weather: 'clear',
      timeOfDay: 'auto',
      regulation: '2025',
      aiDifficulty: 80,
      qualifying: 'oneShot',
      rules: { ...DEFAULT_RULES },
      seed: 1,
      players: ds.map((d, i) => ({ playerIndex: i as PlayerIndex, driverId: d.id, teamId: d.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS }, startCompound: null })),
      roster,
      aiCount: 4,
      gridOrder: null,
      playerStartPosition: null,
      ghost: null,
      objective: null,
    });
    expect(validateSessionConfig(built)).toEqual([]);
    expect(built.players.map((p) => p.playerIndex)).toEqual([0, 1, 2, 3]);
    expect(built.grid.filter((g) => g.playerIndex !== -1).map((g) => g.playerIndex).sort()).toEqual([0, 1, 2, 3]);
    // no input from anyone for 30 s: every human car is still on the grid (the AI would be racing)
    const track = getLayout('monza');
    const world = createWorld(config('monza', [0, 1, 2, 3], 6), track);
    const idle: ControlInput = { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false, drsPressed: false, ersCycle: false, limiterToggle: false, overtakeHeld: false };
    for (let i = 0; i < 30 / SIM_DT; i++) stepWorld(world, track, [idle, idle, idle, idle], SIM_DT);
    for (const pi of [0, 1, 2, 3] as const) expect(world.cars[getPlayerCarId(world, pi)]!.phys.speed).toBeLessThan(1);
    expect(Math.max(...world.cars.filter((c) => c.playerIndex === -1).map((c) => c.timing.progress))).toBeGreaterThan(300);
  });
});
