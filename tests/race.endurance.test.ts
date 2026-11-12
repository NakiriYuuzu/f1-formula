/**
 * Endurance race (race/endurance.ts), headless with the real track, physics, race runtime and AI: a 20-car race to its
 * end (refuelled, nobody dry, classified by laps then time, the same for a seed), the finish rule (the leader's next
 * crossing after the time is up, a lapped car and a car in the pit lane at their own next one), the fill (limited by the
 * tank, the stop the longer of the tyre change and the fill), the driver's fuel choice, and the clock under the safety
 * car (it runs) and the red flag (it stops).
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import type { BuiltTrack, ControlInput, GameEvent, SafetyCarSetting, SessionConfig, WorldState } from '../src/core/types';
import { computeAIInput } from '../src/ai/index';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { forwardDistance } from '../src/track/track';
import {
  autoFuel,
  buildSessionResult,
  createWorld,
  enduranceFormat,
  enduranceLeft,
  fillTime,
  forceIncident,
  fuelTank,
  getPlayerCarId,
  isSessionOver,
  requestPit,
  stepWorld,
} from '../src/race/index';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

interface Options {
  cars?: number;
  minutes?: number;
  seed?: number;
  safetyCar?: SafetyCarSetting;
  /** a human player in the last grid slot */
  player?: boolean;
  /** a race decided by distance instead */
  standard?: boolean;
}

function config(o: Options = {}): SessionConfig {
  const field = RACERS.slice(0, o.cars ?? 20);
  const last = field.length - 1;
  const human = (i: number): boolean => o.player === true && i === last;
  return {
    mode: 'grandPrix',
    kind: 'race',
    layoutId: 'monza',
    laps: 6,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 90,
    players: o.player ? [{ playerIndex: 0, driverId: field[last]!.id, teamId: field[last]!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } }] : [],
    grid: field.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: human(i) ? 0 : -1, startCompound: i % 3 === 0 ? 'soft' : 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: o.safetyCar ?? 'off', mandatoryPitStop: false },
    seed: o.seed ?? 5,
    ghost: null,
    objective: null,
    ...(o.standard ? {} : { raceFormat: enduranceFormat(o.minutes ?? 8) }),
  };
}

interface Run {
  world: WorldState;
  track: BuiltTrack;
  events: { t: number; e: GameEvent }[];
  /** world time the clock ran out (null: not yet) */
  timeUp: number | null;
  /** the leader's lap then */
  leaderLapAtTimeUp: number;
  /** cars in the pit lane then */
  inLaneAtTimeUp: number[];
  /** each car's laps when the leader took the flag */
  lapsAtFlag: Map<number, number>;
  /** least fuel (kg) a car still racing had, and the most against its tank */
  fuel: number;
  overTank: number;
}

function start(o: Options = {}): Run {
  const track = getLayout('monza');
  return { world: createWorld(config(o), track), track, events: [], timeUp: null, leaderLapAtTimeUp: 0, inLaneAtTimeUp: [], lapsAtFlag: new Map(), fuel: Infinity, overTank: -Infinity };
}

/** Step until `until` or `maxSec` of sim time. */
function run(r: Run, maxSec: number, until?: (w: WorldState) => boolean, inputs?: (w: WorldState) => (ControlInput | null)[]): void {
  const w = r.world;
  const end = w.time + maxSec;
  while (!isSessionOver(w) && w.time < end) {
    stepWorld(w, r.track, inputs ? inputs(w) : [], SIM_DT);
    for (const e of w.events) {
      if (e.type === 'sector' || e.type === 'shift') continue;
      r.events.push({ t: w.time, e });
      // (the laps the leader's flag finds each car on; a car crossing the line later in the same step is still on it)
      if (e.type === 'chequered') for (const c of w.cars) r.lapsAtFlag.set(c.id, c.timing.lapsCompleted - (c.status === 'finished' && c.timing.finishTime! > w.session.chequeredAt! ? 1 : 0));
    }
    w.events.length = 0;
    for (const c of w.cars) {
      if (c.status !== 'running' && c.status !== 'pitting') continue;
      r.fuel = Math.min(r.fuel, c.phys.fuelKg);
      r.overTank = Math.max(r.overTank, c.phys.fuelKg - fuelTank(c.spec, r.track));
    }
    const left = enduranceLeft(w);
    if (r.timeUp === null && w.session.phase === 'running' && left !== null && left <= 0) {
      r.timeUp = w.time;
      r.leaderLapAtTimeUp = w.session.leaderLap;
      r.inLaneAtTimeUp = w.cars.filter((c) => c.pit.phase !== 'none').map((c) => c.id);
    }
    if (until && until(w)) return;
  }
}

const ofType = <T extends GameEvent['type']>(r: Run, type: T): { t: number; e: Extract<GameEvent, { type: T }> }[] =>
  r.events.filter((x): x is { t: number; e: Extract<GameEvent, { type: T }> } => x.e.type === type);

/** The result rows are in order of laps, then time. */
function classifiedByLapsThenTime(r: Run): void {
  const rows = buildSessionResult(r.world).rows.filter((row) => row.status === 'finished');
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    expect(b.lapsCompleted).toBeLessThanOrEqual(a.lapsCompleted);
    if (b.lapsCompleted === a.lapsCompleted) expect(b.time!).toBeGreaterThanOrEqual(a.time!);
  }
}

describe('a 20-car endurance race', () => {
  test('refuels to the flag, nobody dry; the leader takes the flag at its first crossing after the time is up; the same for a seed', () => {
    const races = [0, 1].map(() => {
      const r = start({ cars: 20, minutes: 20, safetyCar: 'standard' });
      run(r, 3600);
      return r;
    });
    const [r] = races;
    const w = r!.world;
    expect(isSessionOver(w)).toBe(true);
    // the time is up 20 min of racing after lights out (no red flag here); the leader's lap then is the last
    expect(r!.timeUp! - w.session.startTime!).toBeCloseTo(20 * 60, 1);
    const flag = w.session.chequeredAt!;
    expect(flag).toBeGreaterThan(r!.timeUp!);
    expect(flag - r!.timeUp!).toBeLessThan(w.cars[0]!.race.lastCleanLap + 10);
    const winner = w.cars[buildSessionResult(w).rows[0]!.carId]!;
    expect(winner.timing.lapsCompleted).toBe(r!.leaderLapAtTimeUp);
    // the last lap is called once, when the time is up
    const calls = ofType(r!, 'finalLap');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.t).toBeCloseTo(r!.timeUp!, 6);
    // a tank lasts 16 min at the nominal use: every car to the flag refuels, nobody runs dry, nobody holds more than
    // its tank
    const stops = ofType(r!, 'pitStop');
    const finished = w.cars.filter((c) => c.status === 'finished');
    expect(finished.length).toBeGreaterThanOrEqual(18);
    for (const c of w.cars) {
      const own = stops.filter((x) => x.e.carId === c.id);
      if (c.status === 'finished') expect(own.some((x) => (x.e.fuel ?? 0) > 0)).toBe(true);
      // the stop lasts at least the fill
      for (const x of own) expect(x.e.duration).toBeGreaterThanOrEqual(fillTime(x.e.fuel ?? 0, fuelTank(c.spec, r!.track)) - 1e-9);
    }
    expect(r!.fuel).toBeGreaterThan(0.3);
    expect(r!.overTank).toBeLessThanOrEqual(1e-9);
    classifiedByLapsThenTime(r!);
    // the same race for the seed
    const log = (x: Run): string => JSON.stringify(x.events);
    expect(log(races[1]!)).toBe(log(r!));
  }, 240_000);
});

describe('the finish rule', () => {
  test('a lapped car and a car in the pit lane when the time is up take the flag at their own next crossing', () => {
    const r = start({ cars: 9, minutes: 8, player: true });
    const me = getPlayerCarId(r.world, 0);
    // the player drives at a third of the throttle: lapped within the 8 minutes
    const slow = (w: WorldState): (ControlInput | null)[] => {
      const ai = computeAIInput(w, w.cars[me]!, r.track, SIM_DT);
      return [{ ...ai, throttle: Math.min(ai.throttle, 0.33) }];
    };
    // a car called in just before the time is up: at the pit entry (at its average speed) 2–25 s before it runs out (a
    // visit takes 33 s here), in the lane then
    let called = -1;
    run(
      r,
      1800,
      (w) => {
        const left = enduranceLeft(w)!;
        const reach = (c: (typeof w.cars)[number]): number => (forwardDistance(r.track, c.phys.s, r.track.pit.entry) / r.track.length) * (c.race.lastCleanLap || 90);
        if (called < 0 && w.session.phase === 'running' && left > 0 && left < 60) {
          const car = w.cars.find((c) => c.id !== me && c.id !== w.race.order[0] && c.pit.phase === 'none' && reach(c) > left - 25 && reach(c) < left - 2);
          if (car) {
            requestPit(w, car.id, 'hard');
            called = car.id;
          }
        }
        return false;
      },
      slow,
    );
    const w = r.world;
    expect(isSessionOver(w)).toBe(true);
    expect(called).toBeGreaterThanOrEqual(0);
    expect(r.inLaneAtTimeUp).toContain(called);
    const flag = w.session.chequeredAt!;
    const leaderLaps = r.leaderLapAtTimeUp;
    const winner = buildSessionResult(w).rows[0]!.carId;
    expect(w.cars[winner]!.timing.lapsCompleted).toBe(leaderLaps);
    for (const c of w.cars) {
      expect(c.status).toBe('finished');
      // nobody takes the flag before the leader, everyone else at its first crossing after the leader's
      expect(c.timing.finishTime!).toBeGreaterThanOrEqual(flag - SIM_DT);
      if (c.id !== winner) expect(c.timing.lapsCompleted).toBe(r.lapsAtFlag.get(c.id)! + 1);
    }
    expect(Math.max(...w.cars.map((c) => c.timing.lapsCompleted))).toBe(leaderLaps);
    // the player is lapped, the car that pitted stays on the lead lap
    expect(w.cars[me]!.timing.lapsCompleted).toBeLessThan(leaderLaps);
    expect(w.cars[called]!.timing.lapsCompleted).toBe(leaderLaps);
    expect(w.cars[called]!.pit.stops).toBe(1);
    classifiedByLapsThenTime(r);
  }, 120_000);
});

describe('refuelling', () => {
  test('the fill is limited by the tank; the stop lasts the longer of the tyre change and the fill', () => {
    const r = start({ cars: 4, minutes: 8 });
    const w = r.world;
    const tank = (id: number): number => fuelTank(w.cars[id]!.spec, r.track);
    // on lap 2: car 0 asks for more than the tank holds, car 1 for no fuel, car 2 for a top-up shorter than any tyre change
    const before = new Map<number, number>();
    let target2 = NaN;
    run(r, 600, (x) => {
      for (const c of x.cars) if (c.pit.phase === 'stopped' && !before.has(c.id)) before.set(c.id, c.phys.fuelKg);
      if (x.cars[0]!.timing.lap === 2 && !x.cars[0]!.pit.requested && x.cars[0]!.pit.stops === 0) {
        target2 = x.cars[2]!.phys.fuelKg;
        requestPit(x, 0, 'hard', 999);
        requestPit(x, 1, 'hard', 0);
        requestPit(x, 2, 'hard', target2);
      }
      return [0, 1, 2].every((id) => x.cars[id]!.pit.stops === 1);
    });
    const stop = (id: number) => ofType(r, 'pitStop').find((x) => x.e.carId === id)!.e;
    // car 0: filled to the tank, the fill longer than the tyre change sets the stop
    const full = stop(0);
    expect(full.fuel!).toBeCloseTo(tank(0) - before.get(0)!, 6);
    expect(w.cars[0]!.phys.fuelKg).toBeCloseTo(tank(0), 6);
    expect(fillTime(full.fuel!, tank(0))).toBeGreaterThan(3.5);
    expect(full.duration).toBeCloseTo(fillTime(full.fuel!, tank(0)), 6);
    // car 1: no fuel, the tyre change sets the stop
    const none = stop(1);
    expect(none.fuel).toBeUndefined();
    expect(none.duration).toBeGreaterThanOrEqual(2);
    expect(none.duration).toBeLessThanOrEqual(3.5);
    // car 2: a lap's top-up (under 2 s), the tyre change sets the stop
    const top = stop(2);
    expect(top.fuel!).toBeCloseTo(target2 - before.get(2)!, 6);
    expect(fillTime(top.fuel!, tank(2))).toBeLessThan(2);
    expect(top.duration).toBeGreaterThanOrEqual(2);
    expect(top.duration).toBeLessThanOrEqual(3.5);
    // the choice is spent with the stop
    for (const id of [0, 1, 2]) expect(w.cars[id]!.pit.fuelTarget).toBeUndefined();
  }, 120_000);

  test("the driver's choice: a tank of their own or the automatic fill; a race decided by distance never refuels", () => {
    // 20 minutes: more than a tank, so the start's is short of the flag
    const r = start({ cars: 3, minutes: 20, player: true });
    const me = getPlayerCarId(r.world, 0);
    const autopilot = (w: WorldState): (ControlInput | null)[] => [computeAIInput(w, w.cars[me]!, r.track, SIM_DT)];
    const car = r.world.cars[me]!;
    const tank = fuelTank(car.spec, r.track);
    // lap 2: the automatic fill (the laps to go at the planning rate), read the moment the car stops
    let auto = NaN;
    let had = NaN;
    run(r, 600, (w) => {
      if (car.timing.lap === 2 && car.pit.stops === 0 && !car.pit.requested) requestPit(w, me, 'medium');
      if (car.pit.phase === 'stopped' && Number.isNaN(auto)) {
        auto = autoFuel(w, r.track, car);
        had = car.phys.fuelKg;
      }
      return car.pit.stops === 1;
    }, autopilot);
    expect(auto).toBeGreaterThan(had);
    expect(auto).toBeLessThan(tank);
    expect(car.phys.fuelKg).toBeCloseTo(auto, 1);
    // lap 4: 90 % of the tank
    run(r, 600, (w) => {
      if (car.timing.lap === 4 && car.pit.stops === 1 && !car.pit.requested) requestPit(w, me, 'hard', 0.9 * tank);
      return car.pit.stops === 2;
    }, autopilot);
    expect(car.phys.fuelKg).toBeCloseTo(0.9 * tank, 6);
    // a race decided by distance: the choice is not kept, no fuel goes in
    const s = start({ cars: 3, player: true, standard: true });
    const sme = getPlayerCarId(s.world, 0);
    const scar = s.world.cars[sme]!;
    let at = NaN;
    run(s, 600, (w) => {
      if (scar.timing.lap === 2 && scar.pit.stops === 0 && !scar.pit.requested) {
        requestPit(w, sme, 'hard', 50);
        expect(scar.pit.fuelTarget).toBeUndefined();
      }
      if (scar.pit.phase === 'stopped' && Number.isNaN(at)) at = scar.phys.fuelKg;
      return scar.pit.stops === 1;
    }, (w) => [computeAIInput(w, scar, s.track, SIM_DT)]);
    const sstop = ofType(s, 'pitStop')[0]!.e;
    expect(sstop.fuel).toBeUndefined();
    expect(scar.phys.fuelKg).toBeLessThanOrEqual(at);
  }, 120_000);
});

describe('the clock', () => {
  test('runs under the safety car', () => {
    const r = start({ cars: 8, minutes: 10, safetyCar: 'standard' });
    run(r, 60, (w) => w.session.phase === 'running' && w.time > (w.session.startTime ?? Infinity) + 20);
    expect(forceIncident(r.world, r.track, 'sc')).toBe(true);
    let neutral = 0;
    let drift = 0;
    const due = r.world.time + enduranceLeft(r.world)!;
    run(r, 600, (w) => {
      if (w.session.control.mode === 'green') return true;
      neutral += SIM_DT;
      drift = Math.max(drift, Math.abs(w.time + enduranceLeft(w)! - due));
      return false;
    });
    expect(neutral).toBeGreaterThan(20);
    expect(drift).toBeLessThan(1e-6);
  }, 120_000);

  test('stops under a red flag and runs on from there', () => {
    const r = start({ cars: 8, minutes: 6, safetyCar: 'standard' });
    run(r, 60, (w) => w.session.phase === 'running' && w.time > (w.session.startTime ?? Infinity) + 20);
    expect(forceIncident(r.world, r.track, 'red')).toBe(true);
    run(r, SIM_DT);
    const held = enduranceLeft(r.world)!;
    let red = 0;
    let moved = 0;
    run(r, 900, (w) => {
      if (w.session.control.mode !== 'red') return true;
      red += SIM_DT;
      if (Math.abs(enduranceLeft(w)! - held) > 1e-9) moved++;
      return false;
    });
    expect(red).toBeGreaterThan(5);
    expect(moved).toBe(0);
    // the time is up 6 min of racing after lights out: the stoppage to the restart's lights out not counted
    let stopped = red + SIM_DT;
    run(r, 1800, (w) => {
      if (w.session.phase !== 'running' || w.session.control.mode === 'red') stopped += SIM_DT;
      return r.timeUp !== null;
    });
    expect(Math.abs(r.timeUp! - r.world.session.startTime! - stopped - 6 * 60)).toBeLessThan(3 * SIM_DT);
  }, 180_000);
});
