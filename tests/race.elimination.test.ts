/**
 * Elimination race (race/elimination.ts), headless with the real track, physics, race runtime and AI: a 20-car race to
 * its end (one car out per interval of green-flag racing, classified in reverse order of elimination, over when one car
 * is left, the same for a seed), the car in the pit lane, a mechanical retirement mid-countdown, the countdown frozen
 * by the safety car / VSC / red flag, the player eliminated, a 2-car race, and the car at risk spending its battery.
 */
import { describe, expect, test } from 'bun:test';
import { SIM_DT, DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, POINTS_TABLE } from '../src/core/defaults';
import type { BuiltTrack, ControlInput, GameEvent, SafetyCarSetting, SessionConfig, WorldState } from '../src/core/types';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import {
  ELIMINATED_REASON,
  buildSessionResult,
  concludeRace,
  createWorld,
  eliminationFormat,
  eliminationLeft,
  forceIncident,
  getPlayerCarId,
  isSessionOver,
  requestPit,
  retireCar,
  snapshotWorld,
  stepWorld,
} from '../src/race/index';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

interface Options {
  cars?: number;
  interval?: number;
  grace?: number;
  seed?: number;
  safetyCar?: SafetyCarSetting;
  /** a human player in the last grid slot */
  player?: boolean;
  regulation?: '2025' | '2026';
}

function config(o: Options = {}): SessionConfig {
  const field = RACERS.slice(0, o.cars ?? 20);
  const format = eliminationFormat(o.interval ?? 30);
  const last = field.length - 1;
  const human = (i: number): boolean => o.player === true && i === last;
  return {
    mode: 'grandPrix',
    kind: 'race',
    layoutId: 'monza',
    laps: 3,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: o.regulation ?? '2025',
    aiDifficulty: 90,
    players: o.player ? [{ playerIndex: 0, driverId: field[last]!.id, teamId: field[last]!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } }] : [],
    grid: field.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: human(i) ? 0 : -1, startCompound: i % 3 === 0 ? 'soft' : 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: o.safetyCar ?? 'off', mandatoryPitStop: true },
    seed: o.seed ?? 11,
    ghost: null,
    objective: null,
    raceFormat: o.grace === undefined ? format : { ...format, grace: o.grace },
  };
}

interface Out {
  carId: number;
  position: number;
  time: number;
  /** seconds of green-flag racing since lights out when it happened */
  green: number;
}

interface Run {
  world: WorldState;
  track: BuiltTrack;
  events: GameEvent[];
  outs: Out[];
  green: number;
  /** the least fuel (kg) any car still racing had */
  fuel: number;
}

function start(o: Options = {}): Run {
  const track = getLayout('monza');
  return { world: createWorld(config(o), track), track, events: [], outs: [], green: 0, fuel: Infinity };
}

/** Step (humans coast) until `until` or `maxSec` of sim time, counting green-flag time and eliminations. */
function run(r: Run, maxSec: number, until?: (w: WorldState) => boolean, inputs: (ControlInput | null)[] = []): void {
  const end = r.world.time + maxSec;
  while (!isSessionOver(r.world) && r.world.time < end) {
    stepWorld(r.world, r.track, inputs, SIM_DT);
    const s = r.world.session;
    if (s.phase === 'running' && s.control.mode === 'green') r.green += SIM_DT;
    for (const c of r.world.cars) if (c.status === 'running' || c.status === 'pitting') r.fuel = Math.min(r.fuel, c.phys.fuelKg);
    for (const e of r.world.events) {
      if (e.type === 'sector' || e.type === 'shift') continue;
      r.events.push(e);
      if (e.type === 'eliminated') r.outs.push({ carId: e.carId, position: e.position, time: r.world.time, green: r.green });
    }
    r.world.events.length = 0;
    if (until && until(r.world)) return;
  }
}

const left = (w: WorldState): number => eliminationLeft(w.session.elimination!, w.config.raceFormat!.interval, w.time);
const runningOrder = (w: WorldState): number[] => w.race.order.filter((id) => ['grid', 'running', 'pitting'].includes(w.cars[id]!.status));

describe('a 20-car elimination race', () => {
  test('one car out per interval of green-flag racing, classified in reverse order of elimination; over when one is left; the same for a seed', () => {
    const r = start({ cars: 20, interval: 30 });
    const { grace, interval } = r.world.config.raceFormat!;
    expect(grace).toBe(50);
    run(r, 1200);
    const w = r.world;
    expect(isSessionOver(w)).toBe(true);
    expect(r.outs).toHaveLength(19);
    r.outs.forEach((o, k) => {
      // each at its multiple of the interval, never two at once
      expect(Math.abs(o.green - (grace + k * interval))).toBeLessThan(3 * SIM_DT);
      expect(o.position).toBe(20 - k);
    });
    // over the moment the 19th car went out: one finisher, no lap target reached, no last-lap call
    const last = r.outs[18]!;
    expect(w.session.chequeredAt).toBeCloseTo(last.time, 6);
    expect(w.cars.filter((c) => c.status === 'finished')).toHaveLength(1);
    expect(r.events.filter((e) => e.type === 'finalLap')).toHaveLength(0);
    expect(r.events.filter((e) => e.type === 'chequered')).toHaveLength(1);
    // the tyre rule does not apply: the winner is not disqualified for never stopping
    const result = buildSessionResult(w);
    const winner = w.cars.find((c) => c.status === 'finished')!;
    expect(result.rows[0]!.carId).toBe(winner.id);
    expect(result.rows[0]!.disqualified).toBe(false);
    expect(result.rows.slice(1).map((row) => row.carId)).toEqual(r.outs.map((o) => o.carId).reverse());
    for (const row of result.rows.slice(1)) {
      expect(row.eliminated).toBe(true);
      expect(row.gapText).toBe('淘汰');
      expect(row.status).toBe('retired');
    }
    expect(result.rows.map((row) => row.points).slice(0, 10)).toEqual([25, 18, 15, 12, 10, 8, 6, 4, 2, 1]);
    expect(w.session.elimination!.out).toEqual(r.outs.map((o) => o.carId));
    // fuelled for the longest race the countdown allows: no car ran dry
    expect(r.fuel).toBeGreaterThan(1);

    const again = start({ cars: 20, interval: 30 });
    run(again, 1200);
    expect(again.outs).toEqual(r.outs);
  }, 120_000);
});

describe('elimination rules', () => {
  test('the car last in the running order is out while it is in the pit lane', () => {
    const r = start({ cars: 6, interval: 30, grace: 900 });
    run(r, 30, (w) => w.session.phase === 'running');
    run(r, 10);
    const id = runningOrder(r.world).at(-1)!;
    requestPit(r.world, id, 'hard');
    run(r, 200, (w) => w.cars[id]!.pit.phase === 'lane' || w.cars[id]!.pit.phase === 'stopped');
    const car = r.world.cars[id]!;
    expect(['lane', 'stopped']).toContain(car.pit.phase);
    expect(runningOrder(r.world).at(-1)).toBe(id);
    // the countdown runs out now
    r.world.session.elimination!.dueAt = r.world.time;
    run(r, SIM_DT);
    expect(r.outs.map((o) => o.carId)).toEqual([id]);
    expect(car.status).toBe('retired');
    expect(car.pit.phase).toBe('none');
    expect(r.events.some((e) => e.type === 'retired' && e.carId === id && e.reason === ELIMINATED_REASON)).toBe(true);
  }, 60_000);

  test('a mechanical retirement mid-countdown leaves the countdown as it was; the car is classified behind the eliminated', () => {
    // the player never leaves the grid: the first one out, with less distance than the car that fails before it
    const r = start({ cars: 6, interval: 30, player: true });
    const me = getPlayerCarId(r.world, 0);
    run(r, 30, (w) => w.session.phase === 'running');
    run(r, 20);
    const e = r.world.session.elimination!;
    const due = e.dueAt;
    const before = left(r.world);
    const broken = runningOrder(r.world)[1]!;
    retireCar(r.world, broken, '引擎故障');
    run(r, SIM_DT);
    expect(e.dueAt).toBe(due);
    expect(left(r.world)).toBeCloseTo(before - SIM_DT, 6);
    expect(e.out).toEqual([]);
    run(r, 60, () => r.outs.length > 0);
    expect(r.outs[0]!.time).toBeGreaterThanOrEqual(due);
    expect(r.outs[0]!.time).toBeLessThan(due + 2 * SIM_DT);
    expect(r.outs[0]!.carId).toBe(me);
    expect(r.world.cars[me]!.timing.progress).toBeLessThan(r.world.cars[broken]!.timing.progress);
    run(r, 600);
    expect(isSessionOver(r.world)).toBe(true);
    // 6 cars, one out by failure: 4 eliminations leave the winner
    expect(r.outs).toHaveLength(4);
    const rows = buildSessionResult(r.world).rows;
    // it went out first: last
    const dnf = rows.find((row) => row.carId === broken)!;
    expect(dnf.position).toBe(6);
    expect(dnf.gapText).toBe('退賽');
    expect(dnf.eliminated).toBeUndefined();
    expect(dnf.points).toBe(0);
    expect(rows.slice(1, 5).map((row) => row.carId)).toEqual(r.outs.map((o) => o.carId).reverse());
  }, 60_000);

  test('a car retiring after eliminations is classified behind every eliminated car, who keep their places and points', () => {
    const r = start({ cars: 8, interval: 30 });
    run(r, 30, (w) => w.session.phase === 'running');
    run(r, 300, () => r.outs.length === 3);
    // the car running second fails
    const broken = runningOrder(r.world)[1]!;
    retireCar(r.world, broken, '引擎故障');
    run(r, 900);
    expect(isSessionOver(r.world)).toBe(true);
    const out = r.outs.map((o) => o.carId);
    const winner = r.world.cars.find((c) => c.status === 'finished')!.id;
    const rows = buildSessionResult(r.world).rows;
    const n = out.length;
    expect(rows.slice(0, n + 1).map((row) => row.carId)).toEqual([winner, ...[...out].reverse()]);
    expect(rows.slice(1, n + 1).map((row) => row.points)).toEqual(POINTS_TABLE.slice(1, n + 1));
    // the retirements after them, the late one included, without points
    const rest = rows.slice(n + 1);
    expect(rest.map((row) => row.carId)).toContain(broken);
    for (const row of rest) expect(row).toMatchObject({ gapText: '退賽', points: 0, status: 'retired' });
    // the live order (timing tower) agrees
    expect(r.world.race.order).toEqual(rows.map((row) => row.carId));
  }, 60_000);

  for (const kind of ['sc', 'vsc', 'red'] as const) {
    test(`the countdown is frozen while the race is neutralised (${kind}) and runs on from there at the green flag`, () => {
      const r = start({ cars: 8, interval: 30, safetyCar: 'standard' });
      run(r, 30, (w) => w.session.phase === 'running');
      run(r, 15);
      expect(forceIncident(r.world, r.track, kind)).toBe(true);
      run(r, SIM_DT);
      // held at what was left (grace 50 s, 15 s of it raced)
      const frozen = r.world.session.elimination!.held ?? NaN;
      expect(frozen).toBeCloseTo(r.world.config.raceFormat!.grace - r.green, 2);
      let moved = 0;
      let neutral = 0;
      run(r, 600, (w) => {
        const live = w.session.phase === 'running' && w.session.control.mode === 'green';
        if (live) return true;
        neutral += SIM_DT;
        if (Math.abs(left(w) - frozen) > 1e-9) moved++;
        return false;
      });
      expect(neutral).toBeGreaterThan(5);
      expect(moved).toBe(0);
      expect(r.outs).toHaveLength(0);
      // no other random incident before the first elimination: it comes after `grace` seconds of green-flag racing
      run(r, 120, () => r.outs.length > 0);
      expect(r.outs).toHaveLength(1);
      expect(Math.abs(r.outs[0]!.green - r.world.config.raceFormat!.grace)).toBeLessThan(3 * SIM_DT);
    }, 90_000);
  }

  test('safety cars stretch the race past its planned laps: the laps stay ahead of the leader, nothing reads as its end', () => {
    // 20 cars: a race of 10 planned laps, where a safety car stays out for two laps of the leader
    const r = start({ cars: 20, interval: 30, safetyCar: 'standard' });
    const planned = r.world.session.totalLaps;
    run(r, 30, (w) => w.session.phase === 'running');
    // two safety cars: the countdown waits, the laps go on
    const at = [100, 250];
    let closest = Infinity;
    run(r, 3000, (w) => {
      if (at.length > 0 && r.green >= at[0]! && forceIncident(w, r.track, 'sc')) at.shift();
      // what race control, damage rules, the AI and the lap timing read as the last lap
      if (w.session.phase === 'running') closest = Math.min(closest, w.session.totalLaps - w.session.leaderLap);
      return false;
    });
    expect(at).toEqual([]);
    expect(isSessionOver(r.world)).toBe(true);
    expect(Math.max(...r.world.cars.map((c) => c.timing.lapsCompleted))).toBeGreaterThan(planned);
    expect(closest).toBeGreaterThanOrEqual(1);
    expect(r.events.filter((e) => e.type === 'finalLap')).toHaveLength(0);
    // decided by the countdown alone: one finisher, at the last elimination
    expect(r.world.cars.filter((c) => c.status === 'finished')).toHaveLength(1);
    expect(r.world.session.chequeredAt).toBeCloseTo(r.outs.at(-1)!.time, 6);
  }, 90_000);

  test('the player eliminated: retired as 淘汰 at their place, and the race concluded from there is classified', () => {
    const r = start({ cars: 6, interval: 30, player: true });
    const me = getPlayerCarId(r.world, 0);
    // the player never leaves the grid: last from lights out
    run(r, 200, () => r.outs.length > 0);
    expect(r.outs[0]).toMatchObject({ carId: me, position: 6 });
    const car = r.world.cars[me]!;
    expect(car.status).toBe('retired');
    expect(r.events.some((e) => e.type === 'retired' && e.carId === me && e.reason === ELIMINATED_REASON)).toBe(true);
    // what the session runtime does once every human car is out: fast-forward, then conclude
    run(r, 40);
    const order = runningOrder(r.world);
    concludeRace(r.world, r.track);
    expect(isSessionOver(r.world)).toBe(true);
    const rows = buildSessionResult(r.world).rows;
    // the cars still racing in their running order (the leader wins), then the ones out before, last out first
    expect(rows.map((row) => row.carId)).toEqual([...order, ...r.outs.map((o) => o.carId).reverse()]);
    expect(rows[0]!.status).toBe('finished');
    expect(rows.slice(1).every((row) => row.eliminated === true)).toBe(true);
    const mine = rows.find((row) => row.carId === me)!;
    expect(mine).toMatchObject({ position: 6, gapText: '淘汰', eliminated: true, status: 'retired', playerIndex: 0 });
  }, 60_000);

  test('a 2-car race: the car behind at the first elimination is out and the other wins there and then', () => {
    const r = start({ cars: 2, interval: 30 });
    let behind = -1;
    run(r, 200, (w) => {
      if (w.session.phase === 'running') behind = runningOrder(w).at(-1)!;
      return r.outs.length > 0;
    });
    run(r, 1);
    expect(isSessionOver(r.world)).toBe(true);
    expect(r.outs).toHaveLength(1);
    expect(r.outs[0]!.carId).toBe(behind);
    expect(r.outs[0]!.position).toBe(2);
    const rows = buildSessionResult(r.world).rows;
    expect(rows[0]).toMatchObject({ position: 1, status: 'finished', points: 25 });
    expect(rows[1]).toMatchObject({ carId: behind, position: 2, gapText: '淘汰', eliminated: true, points: 18 });
    expect(r.world.session.chequeredAt).toBeCloseTo(r.outs[0]!.time, 6);
  }, 60_000);
});

describe('the AI at risk', () => {
  test('the car last in the order with the countdown low holds the overtake mode on more of the lap', () => {
    const r = start({ cars: 8, interval: 30, grace: 900 });
    run(r, 30, (w) => w.session.phase === 'running');
    run(r, 40);
    const id = runningOrder(r.world).at(-1)!;
    /** seconds the car spends with its overtake mode on over the next 12 s, the countdown set to `secondsLeft` */
    const boost = (secondsLeft: number, charge?: number): number => {
      const w = snapshotWorld(r.world);
      w.session.elimination!.dueAt = w.time + secondsLeft;
      if (charge !== undefined) w.cars[id]!.phys.ers.charge = charge;
      const probe: Run = { world: w, track: r.track, events: [], outs: [], green: 0 };
      let on = 0;
      run(probe, 12, (pw) => {
        if (pw.cars[id]!.phys.ers.overtakeActive) on += SIM_DT;
        return false;
      });
      return on;
    };
    const calm = boost(600);
    const atRisk = boost(14);
    expect(atRisk).toBeGreaterThan(calm + 1);
    // and spends a battery a pushing car would keep (below half charge)
    expect(boost(14, 0.4)).toBeGreaterThan(boost(600, 0.4) + 1);
  }, 60_000);
});
