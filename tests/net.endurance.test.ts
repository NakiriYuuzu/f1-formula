/**
 * Endurance race online (loopback, with delay, jitter, loss and duplicates): the host runs the clock and the stops; the
 * guest reads the time left from the mirrored session state on the host's clock, asks for its own fill with its pit
 * request, sees the same stops (and what went in) and the same classification.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, GameEvent, PlayerIndex, SessionConfig } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { buildSessionResult, createWorld, enduranceLeft, fuelTank, getPlayerCarId, isSessionOver, stepWorld } from '../src/race/index';
import { HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { LoopbackNetwork } from '../src/net/loopback';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');
/** one snapshot interval (SNAPSHOT_HZ = 30) */
const SNAPSHOT = 1 / 30;

/** Six cars over 5 minutes: the host's player on pole, the guest's at the back of the grid. */
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
    // no neutralisation: the clock runs on, so both ends compare it at every step
    rules: { ...DEFAULT_RULES, safetyCar: 'off', redFlags: false },
    seed: 11,
    ghost: null,
    objective: null,
    raceFormat: { kind: 'endurance', duration: 300 },
  };
}

type Stop = { carId: number; compound: string; fuel: number | undefined; duration: number };
const stops = (events: readonly GameEvent[]): Stop[] =>
  events.flatMap((e) => (e.type === 'pitStop' ? [{ carId: e.carId, compound: e.compound, fuel: e.fuel, duration: e.duration }] : []));

describe('endurance race online (loopback)', () => {
  test('host and guest agree on the time left, the stops and what went in, and the result', () => {
    const track = getLayout('monza');
    const cfg = config();
    const net = new LoopbackNetwork({ delayMs: 80, jitterMs: 30, loss: 0.05, duplicate: 0.03, seed: 5 });
    const [h1, c1] = net.pair();
    const world = createWorld(cfg, track);
    const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h1 }], {});
    const a = new ClientSession(cfg, track, 1, 1, c1);
    const tank = fuelTank(world.cars[a.carId]!.spec, track);
    const hostStops: Stop[] = [];
    const guestStops: Stop[] = [];
    let guestCalls = 0;
    // the host's time left by its step (time / SIM_DT), and the guest's against it at the same race time
    const hostLeft = new Map<number, number>();
    const sameTimeErr: number[] = [];
    // and at the same moment (the guest's clock trails the host's by the mirror's delivery delay)
    const lag: number[] = [];
    let asked = false;
    let resultSent = false;
    while (world.time < 900 && !(isSessionOver(world) && a.result?.final)) {
      const inputs: (ControlInput | null)[] = [null, null, null, null];
      inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
      host.fillInputs(inputs);
      stepWorld(world, track, inputs, SIM_DT);
      const events = world.events.splice(0);
      hostStops.push(...stops(events));
      host.forwardEvents(events);
      host.afterStep();
      if (isSessionOver(world) && !resultSent) {
        host.sendResult(buildSessionResult(world), true);
        resultSent = true;
      }
      const running = world.session.phase === 'running';
      const hLeft = enduranceLeft(world)!;
      if (running && hLeft > 0) hostLeft.set(Math.round(world.time / SIM_DT), hLeft);
      // the guest drives itself and boxes on lap 2 for 90 % of the tank
      const own = a.world.cars[a.carId]!;
      a.step(computeAIInput(a.world, own, track, SIM_DT));
      if (!asked && own.timing.lap === 2 && own.pit.phase === 'none') {
        a.requestPit('hard', 0.9 * tank);
        asked = true;
      }
      const ge = a.takeEvents();
      guestStops.push(...stops(ge));
      guestCalls += ge.filter((e) => e.type === 'finalLap').length;
      net.advance(SIM_DT * 1000);
      const gLeft = enduranceLeft(a.world);
      if (gLeft !== null && gLeft > 0 && a.world.session.phase === 'running') {
        const h = hostLeft.get(Math.round(a.world.time / SIM_DT));
        if (h !== undefined) sameTimeErr.push(Math.abs(gLeft - h));
        if (running && hLeft > 0) lag.push(gLeft - hLeft);
      }
      a.renderFrame(SIM_DT);
    }
    guestStops.push(...stops(a.takeEvents()));
    // the guest's stop: its fill, asked from the guest, decided on the host
    const mine = hostStops.filter((s) => s.carId === a.carId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ compound: 'hard' });
    expect(mine[0]!.fuel!).toBeGreaterThan(0);
    // the same stops on both ends, with what went in (reliable events, none lost to the 5 % loss)
    expect(guestStops).toEqual(hostStops);
    expect(guestCalls).toBe(1);
    // the time left at the same race time is the host's (the mirror rounds the clock to 1 ms)
    expect(sameTimeErr.length).toBeGreaterThan(10_000);
    expect(Math.max(...sameTimeErr)).toBeLessThan(SNAPSHOT);
    // at the same moment it trails by the mirror's delivery delay (80 ± 30 ms here), within one mirror interval of that
    lag.sort((x, y) => x - y);
    expect(lag[0]!).toBeGreaterThan(-SNAPSHOT);
    expect(lag[Math.floor(lag.length * 0.95)]!).toBeLessThan(0.08 + 0.03 + SNAPSHOT);
    // the same classification: the host's result reached the guest
    expect(a.result?.final).toBe(true);
    const hostRows = buildSessionResult(world).rows.map((r) => [r.carId, r.position, r.lapsCompleted, r.gapText, r.pitStops]);
    expect(a.result!.result.rows.map((r) => [r.carId, r.position, r.lapsCompleted, r.gapText, r.pitStops])).toEqual(hostRows);
    a.dispose();
    host.dispose();
  }, 180_000);
});
