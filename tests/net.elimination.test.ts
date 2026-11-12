/**
 * Elimination race online (loopback, with delay, jitter, loss and duplicates): the host runs the countdown and takes
 * the cars out; the guest reads the countdown from the mirrored session state on the host's clock, sees the same
 * eliminations in the same order and the same classification, and once its own car is out spectates the others.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, GameEvent, PlayerIndex, SessionConfig } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { buildSessionResult, COAST_INPUT, createWorld, eliminationFormat, eliminationLeft, getPlayerCarId, isSessionOver, stepWorld } from '../src/race/index';
import { Spectator } from '../src/app/spectate';
import { HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { LoopbackNetwork } from '../src/net/loopback';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');
const INTERVAL = 30;
/** one snapshot interval (SNAPSHOT_HZ = 30) */
const SNAPSHOT = 1 / 30;
/** the HUD's OUT_BANNER_SECONDS: an out player's view switches over after the banner */
const BANNER = 6;

/** Six cars: the host's player on pole, the guest's at the back of the grid. */
function config(): SessionConfig {
  const ids = RACERS.slice(0, 6);
  const seat = (i: number): -1 | PlayerIndex => (i === 0 ? 0 : i === ids.length - 1 ? 1 : -1);
  return {
    mode: 'splitScreen',
    kind: 'race',
    layoutId: 'monza',
    laps: 3,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 80,
    players: ids.flatMap((d, i) => {
      const pi = seat(i);
      return pi === -1 ? [] : [{ playerIndex: pi, driverId: d.id, teamId: d.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist: true } }];
    }),
    grid: ids.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: seat(i), startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    // no neutralisation: the countdown runs on, so both ends compare it at every step
    rules: { ...DEFAULT_RULES, safetyCar: 'off', redFlags: false },
    seed: 11,
    ghost: null,
    objective: null,
    raceFormat: eliminationFormat(INTERVAL),
  };
}

type Out = { carId: number; position: number };
const outs = (events: readonly GameEvent[]): Out[] =>
  events.flatMap((e) => (e.type === 'eliminated' ? [{ carId: e.carId, position: e.position }] : []));

describe('elimination race online (loopback)', () => {
  test('host and guest agree on the countdown, the eliminations and the result; the guest out spectates', () => {
    const track = getLayout('monza');
    const cfg = config();
    const net = new LoopbackNetwork({ delayMs: 80, jitterMs: 30, loss: 0.05, duplicate: 0.03, seed: 5 });
    const [h1, c1] = net.pair();
    const world = createWorld(cfg, track);
    const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h1 }], {});
    const a = new ClientSession(cfg, track, 1, 1, c1);
    const spectator = new Spectator(a.carId);
    const hostOuts: Out[] = [];
    const guestOuts: Out[] = [];
    // the host's countdown by its step (time / SIM_DT), and the guest's against it at the same race time
    const hostLeft = new Map<number, number>();
    const sameTimeErr: number[] = [];
    // and at the same moment (the guest's clock trails the host's by the mirror's delivery delay, as every mirrored timer)
    const lag: number[] = [];
    const watched = new Set<number>();
    let spectateAt: number | null = null;
    let resultSent = false;
    while (world.time < 400 && !(isSessionOver(world) && a.result?.final)) {
      const inputs: (ControlInput | null)[] = [null, null, null, null];
      inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
      host.fillInputs(inputs);
      stepWorld(world, track, inputs, SIM_DT);
      const events = world.events.splice(0);
      hostOuts.push(...outs(events));
      host.forwardEvents(events);
      host.afterStep();
      if (isSessionOver(world) && !resultSent) {
        host.sendResult(buildSessionResult(world), true);
        resultSent = true;
      }
      const he = world.session.elimination!;
      const running = world.session.phase === 'running' && he.held === null;
      const hLeft = eliminationLeft(he, INTERVAL, world.time);
      if (running) hostLeft.set(Math.round(world.time / SIM_DT), hLeft);
      // the guest sits on the grid: last, so the first one out
      a.step(COAST_INPUT);
      guestOuts.push(...outs(a.takeEvents()));
      net.advance(SIM_DT * 1000);
      const ge = a.world.session.elimination;
      if (ge && ge.held === null && a.world.session.phase === 'running') {
        const gLeft = eliminationLeft(ge, INTERVAL, a.world.time);
        const h = hostLeft.get(Math.round(a.world.time / SIM_DT));
        if (h !== undefined) sameTimeErr.push(Math.abs(gLeft - h));
        if (running && hostOuts.length < cfg.grid.length - 1) lag.push((((gLeft - hLeft) % INTERVAL) + INTERVAL) % INTERVAL);
      }
      // as SessionRuntime: the view follows another car once the 退賽 / 淘汰 banner has had its time
      if (spectator.update(a.world, BANNER)) a.setSpectating(spectator.watching !== null);
      if (spectator.watching !== null) {
        spectateAt ??= a.world.time;
        watched.add(spectator.watching);
      }
      a.renderFrame(SIM_DT);
    }
    // (the last one came with the result)
    guestOuts.push(...outs(a.takeEvents()));
    const n = cfg.grid.length;
    // every car but the winner went out, one per countdown, the guest's first
    expect(hostOuts.length).toBe(n - 1);
    expect(hostOuts.map((o) => o.position)).toEqual([6, 5, 4, 3, 2]);
    expect(hostOuts[0]!.carId).toBe(a.carId);
    // the guest saw the same eliminations in the same order (reliable events, none lost to the 5 % loss)
    expect(guestOuts).toEqual(hostOuts);
    expect(a.world.session.elimination!.out).toEqual(world.session.elimination!.out);
    // the countdown at the same race time is the host's. Read on its cycle: at the step a car goes out the guest's clock
    // (the mirror rounds it to 1 ms) can sit a hair short of it, 0 against the host's fresh 30, the same instant
    // (measured: 20 388 samples, 1 such step, otherwise within 5e-11 s)
    expect(sameTimeErr.length).toBeGreaterThan(10_000);
    expect(Math.max(...sameTimeErr.map((e) => Math.min(e, INTERVAL - e)))).toBeLessThan(SNAPSHOT);
    expect(sameTimeErr.filter((e) => e > SNAPSHOT).length).toBeLessThanOrEqual(hostOuts.length);
    // at the same moment it trails by the mirror's delivery delay (80 ± 30 ms here; measured mean 90, max 108 ms),
    // never a countdown behind
    lag.sort((x, y) => x - y);
    expect(lag[Math.floor(lag.length * 0.95)]!).toBeLessThan(0.08 + 0.03 + SNAPSHOT);
    // the same classification: the host's result reached the guest
    expect(a.result?.final).toBe(true);
    const hostRows = buildSessionResult(world).rows.map((r) => [r.carId, r.position, r.gapText]);
    expect(a.result!.result.rows.map((r) => [r.carId, r.position, r.gapText])).toEqual(hostRows);
    expect(hostRows.at(-1)).toEqual([a.carId, n, '淘汰']);
    // out, the guest spectated the cars still racing
    expect(world.cars[a.carId]!.status).toBe('retired');
    expect(a.world.cars[a.carId]!.status).toBe('retired');
    expect(spectateAt).not.toBeNull();
    expect(watched.size).toBeGreaterThan(0);
    expect(watched.has(a.carId)).toBe(false);
    a.dispose();
    host.dispose();
  }, 180_000);
});
