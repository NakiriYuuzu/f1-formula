/**
 * AI race strategy (docs/plans/phase2-ai.md §C): the shared pit-loss estimate and its SC / VSC shares (C0), the
 * race-time model — no / one / two stops, the mandatory different-compound stop, never into the tyre cliff (C1) —,
 * undercut / overcut / cover (C2), stops under a safety car / VSC and not double-stacking team-mates (C3), the weather
 * forecast (C4), team orders — AI → AI, AI → human, never asking the human, hold position (C5) — and the strategy side
 * of the pace modes (A3). Constructed scenarios on decidePitStop / planRace / planTraffic, plus short races at Monaco
 * for the team orders.
 */
import { describe, expect, test } from 'bun:test';
import {
  CLIFF_WEAR,
  FINISH_WEAR,
  PIT_WEAR,
  SPEED_CAP,
  computeAIInput,
  decidePitStop,
  isDry,
  planRace,
  tyreLapFactor,
  type PlanInput,
  type RacePlan,
} from '../src/ai/index';
import { estimatedPace, planTraffic, type TrafficContext } from '../src/ai/traffic';
import {
  SC_ENDING_PIT_LOSS_FACTOR,
  SC_PIT_LOSS_FACTOR,
  VSC_PIT_LOSS_FACTOR,
  createWorld,
  estimatePitLoss,
  forceIncident,
  getPlayerCarId,
  isSessionOver,
  mandatoryStopOpen,
  pitLossFactor,
  stepWorld,
} from '../src/race/index';
import { radioTeamYield } from '../src/race/radio';
import { predictWetness } from '../src/race/weather';
import { forwardDistance, indexAtS, poseAt, sampleAt, wrapS } from '../src/track/track';
import { forwardX, forwardZ } from '../src/core/math';
import { COMPOUND_PARAMS } from '../src/physics/index';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { LAYOUTS, getLayout } from '../src/data/tracks/index';
import type { BuiltTrack, CarEntry, ControlInput, GameEvent, SessionConfig, TireCompound, WeatherState, WorldState } from '../src/core/types';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');
const teamOf = (id: string): string => RACERS.find((d) => d.id === id)!.teamId;

interface Entry {
  driver: string;
  compound?: TireCompound;
  human?: boolean;
}

function config(layoutId: string, laps: number, grid: Entry[], o: { mandatory?: boolean; seed?: number } = {}): SessionConfig {
  const human = grid.find((g) => g.human);
  return {
    mode: 'grandPrix',
    kind: 'race',
    layoutId,
    laps,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 90,
    players: human
      ? [{ playerIndex: 0, driverId: human.driver, teamId: teamOf(human.driver), setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } }]
      : [],
    grid: grid.map((g) => ({ driverId: g.driver, teamId: teamOf(g.driver), playerIndex: g.human ? 0 : -1, startCompound: g.compound ?? 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off', mandatoryPitStop: o.mandatory ?? false },
    seed: o.seed ?? 3,
    ghost: null,
    objective: null,
  };
}

/** A race world frozen mid-race: running, every car on track (state set by `setup`, nothing is simulated). */
function frozenRace(layoutId: string, laps: number, grid: Entry[], o: { mandatory?: boolean } = {}): { world: WorldState; track: BuiltTrack } {
  const track = getLayout(layoutId);
  const world = createWorld(config(layoutId, laps, grid, o), track);
  world.session.phase = 'running';
  world.session.startTime = 0;
  for (const c of world.cars) c.status = 'running';
  return { world, track };
}

interface CarSetup {
  /** current lap (1-based) */
  lap: number;
  /** tyre wear now and the measured wear a lap of this set */
  wear: number;
  rate: number;
  position: number;
  /** gap (s) to the car directly ahead */
  interval: number;
  compound?: TireCompound;
  /** distance (m) to the pit entry: inside the 120–700 m window where the strategy decides */
  toEntry?: number;
}

/** Put a car mid-race: lap, classification, tyre set with a measured wear rate, position before the pit entry. */
function setup(world: WorldState, track: BuiltTrack, car: CarEntry, o: CarSetup): void {
  const t = car.timing;
  t.lap = o.lap;
  t.lapsCompleted = o.lap - 1;
  t.position = o.position;
  t.interval = o.interval;
  t.lapsDown = 0;
  if (o.compound) {
    car.phys.tire.compound = o.compound;
    car.race.usedCompounds = isDry(o.compound) ? [o.compound] : [];
  }
  car.phys.tire.wear = o.wear;
  car.phys.s = wrapS(track, track.pit.entry - (o.toEntry ?? 400));
  t.progress = t.lapsCompleted * track.length + car.phys.s;
  // the stint so far (distance driven on the set), so that wearPerLap measures `rate`
  const laps = Math.max(1, Math.min(o.lap - 1, Math.floor(o.wear / o.rate)));
  car.ai.stintStartProgress = t.progress - laps * track.length;
  car.ai.stintWear = o.wear - o.rate * laps;
  car.ai.strategyLap = -1;
  world.race.order = [...world.cars].sort((a, b) => a.timing.position - b.timing.position).map((c) => c.id);
}

/** The strategy call the race runtime makes (step.ts runStrategies). */
function decide(world: WorldState, track: BuiltTrack, car: CarEntry): TireCompound | null {
  return decidePitStop(world, car, track, SIM_DT, {
    usedCompounds: car.race.usedCompounds,
    mandatoryOpen: mandatoryStopOpen(world, car),
    pitLoss: estimatePitLoss(track),
    lossFactor: pitLossFactor(world.session.control.mode),
    mandatoryFor: (o) => mandatoryStopOpen(world, o),
  });
}

/** Wear at the end of every stint of a plan: [current set, fresh sets…]. */
function stintEnds(input: PlanInput, plan: RacePlan): number[] {
  const unit = input.rate;
  const ends = [input.wear + unit * COMPOUND_PARAMS[input.compound].wearRate * plan.stay];
  plan.stints.forEach((c, i) => ends.push(unit * COMPOUND_PARAMS[c].wearRate * plan.stintLaps[i]));
  return ends;
}

describe('C0 pit loss', () => {
  test('one estimate in the race contract (the HUD imports it); SC / VSC shares', async () => {
    for (const id of ['monaco', 'silverstone', 'monza', 'porto-lumen']) {
      const track = getLayout(id);
      const loss = estimatePitLoss(track);
      expect(loss).toBeGreaterThanOrEqual(8);
      expect(loss).toBeLessThanOrEqual(45);
      expect(estimatePitLoss(track)).toBe(loss);
    }
    // a short, quick pit lane against a long one
    expect(estimatePitLoss(getLayout('monaco'))).toBeLessThan(estimatePitLoss(getLayout('monza')));
    expect(LAYOUTS.length).toBeGreaterThan(10);
    expect(pitLossFactor('green')).toBe(1);
    expect(pitLossFactor('sc')).toBe(SC_PIT_LOSS_FACTOR);
    // the lap the safety car comes in: the field is released while the car is in the lane (near a green stop)
    expect(pitLossFactor('scEnding')).toBe(SC_ENDING_PIT_LOSS_FACTOR);
    expect(SC_ENDING_PIT_LOSS_FACTOR).toBeGreaterThan(SC_PIT_LOSS_FACTOR);
    expect(SC_ENDING_PIT_LOSS_FACTOR).toBeLessThan(1);
    expect(pitLossFactor('vsc')).toBe(VSC_PIT_LOSS_FACTOR);
    expect(pitLossFactor('vscEnding')).toBe(1);
    expect(SC_PIT_LOSS_FACTOR).toBeLessThan(VSC_PIT_LOSS_FACTOR);
    expect(VSC_PIT_LOSS_FACTOR).toBeLessThan(1);
    const mfd = await Bun.file(new URL('../src/ui/hud/mfd.ts', import.meta.url)).text();
    const hud = await Bun.file(new URL('../src/ui/hud/index.ts', import.meta.url)).text();
    expect(mfd).not.toContain('function estimatePitLoss');
    expect(hud).toMatch(/import \{ estimatePitLoss \} from '\.\.\/\.\.\/race\/index'/);
  });
});

describe('C1 race-time model', () => {
  const base: PlanInput = { laps: 4, base: 90, compound: 'medium', wear: 0.05, rate: 0.05, pitLoss: 20, mandatory: false, used: ['medium'] };

  test('a short race on a fresh set: no stop; a long one: one stop near the end of the set', () => {
    const short = planRace(base);
    expect(short.best?.stints).toEqual([]);
    expect(short.now).not.toBeNull();
    expect(short.later?.cost).toBeLessThan(short.now!.cost);

    const long = planRace({ ...base, laps: 30, wear: 0.3 });
    const best = long.best!;
    expect(best.stints.length).toBeGreaterThanOrEqual(1);
    expect(best.stintLaps.reduce((a, b) => a + b, 0) + best.stay).toBe(30);
    // a dearer stop (pit loss) never makes the model stop more often
    const dear = planRace({ ...base, laps: 30, wear: 0.3, pitLoss: 40 }).best!;
    expect(dear.stints.length).toBeLessThanOrEqual(best.stints.length);
  });

  test('no plan takes a set past its wear limit (stop: PIT_WEAR, flag: FINISH_WEAR, both short of the cliff)', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 4294967296;
    };
    const compounds: TireCompound[] = ['soft', 'medium', 'hard'];
    let plans = 0;
    for (let i = 0; i < 300; i++) {
      const input: PlanInput = {
        laps: 1 + Math.floor(rnd() * 45),
        base: 75 + rnd() * 25,
        compound: compounds[Math.floor(rnd() * 3)],
        wear: rnd() * 0.75,
        rate: 0.01 + rnd() * 0.08,
        pitLoss: 12 + rnd() * 20,
        nowLoss: rnd() < 0.3 ? 5 + rnd() * 10 : undefined,
        mandatory: rnd() < 0.3,
        used: [],
      };
      input.used = [input.compound];
      const res = planRace(input);
      for (const plan of [res.best, res.now, res.later]) {
        if (!plan) continue;
        plans++;
        const ends = stintEnds(input, plan);
        // the current set: up to the stop (it may already be past PIT_WEAR when stopping now) / to the flag
        if (plan.stints.length === 0) expect(ends[0]).toBeLessThanOrEqual(FINISH_WEAR + 1e-9);
        else if (plan.stay > 0) expect(ends[0]).toBeLessThanOrEqual(PIT_WEAR + 1e-9);
        for (let k = 1; k < ends.length; k++) expect(ends[k]).toBeLessThanOrEqual((k === ends.length - 1 ? FINISH_WEAR : PIT_WEAR) + 1e-9);
        for (const w of ends.slice(1)) expect(w).toBeLessThan(CLIFF_WEAR);
        if (input.mandatory) expect(plan.stints.some((c) => c !== input.compound)).toBe(true);
      }
    }
    expect(plans).toBeGreaterThan(300);
  });

  test('the tyre cliff: a set that would reach the flag past 0.85 stops, though staying out would be quicker', () => {
    // soft at 0.6, 0.1 a lap, 3 laps to go: no stop ends at 0.9 and the time model alone would still prefer it
    const input: PlanInput = { laps: 3, base: 90, compound: 'soft', wear: 0.6, rate: 0.1, pitLoss: 22, mandatory: false, used: ['soft'] };
    let stayOut = 0;
    for (let j = 1; j <= 3; j++) stayOut += 90 * tyreLapFactor('soft', 0.6 + 0.1 * (j - 0.5));
    const res = planRace(input);
    expect(0.6 + 0.1 * 3).toBeGreaterThan(CLIFF_WEAR);
    expect(stayOut).toBeLessThan(res.best!.cost);
    expect(res.best!.stints.length).toBeGreaterThanOrEqual(1);
    expect(res.best!.stay).toBe(0);

    // in a race: the car boxes now
    const { world, track } = frozenRace('silverstone', 12, [{ driver: 'varga', compound: 'soft' }, { driver: 'marchand' }]);
    const car = world.cars[0];
    setup(world, track, car, { lap: 9, wear: 0.62, rate: 0.08, position: 1, interval: 0, compound: 'soft' });
    expect(decide(world, track, car)).not.toBeNull();
    expect(['wear', 'plan']).toContain(car.ai.pitCall);
  });

  test('the mandatory stop: always planned, with a compound not used yet, and served two laps from the end at the latest', () => {
    const res = planRace({ ...base, laps: 3, mandatory: true });
    expect(res.best!.stints.length).toBeGreaterThanOrEqual(1);
    expect(res.best!.stints.some((c) => c !== 'medium')).toBe(true);
    expect(res.later!.stints.length).toBeGreaterThanOrEqual(1);

    // a long race on a set that would last: the stop is in the plan, the car stays out for now…
    const long = frozenRace('silverstone', 20, [{ driver: 'varga' }, { driver: 'marchand' }], { mandatory: true });
    const car = long.world.cars[0];
    setup(long.world, long.track, car, { lap: 4, wear: 0.06, rate: 0.02, position: 1, interval: 0, compound: 'hard' });
    expect(mandatoryStopOpen(long.world, car)).toBe(true);
    expect(decide(long.world, long.track, car)).toBeNull();
    expect(car.ai.planStops).toBeGreaterThanOrEqual(1);
    // …and two laps from the end it boxes for a compound it has not used
    setup(long.world, long.track, car, { lap: 18, wear: 0.36, rate: 0.02, position: 1, interval: 0 });
    const next = decide(long.world, long.track, car);
    expect(next).not.toBeNull();
    expect(next).not.toBe('hard');
    expect(isDry(next!)).toBe(true);
  });
});

describe('C2 undercut / overcut / cover', () => {
  /** Two cars on the same worn mediums, `gap` s apart, mid-way through a 30-lap Silverstone race. */
  function pair(gap: number, wear = 0.5, ids = ['varga', 'marchand']): { world: WorldState; track: BuiltTrack; a: CarEntry; b: CarEntry } {
    const third = ['okafor', 'dahl'].find((d) => !ids.includes(d))!;
    const { world, track } = frozenRace('silverstone', 30, [{ driver: ids[0] }, { driver: ids[1] }, { driver: third }]);
    const [a, b, c] = world.cars;
    setup(world, track, a, { lap: 11, wear, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
    setup(world, track, b, { lap: 11, wear, rate: 0.03, position: 2, interval: gap, compound: 'medium' });
    setup(world, track, c, { lap: 11, wear, rate: 0.03, position: 3, interval: 20, compound: 'medium' });
    return { world, track, a, b };
  }

  test('undercut: 1–2.5 s behind a car on as old a set that must stop too → box now, pushing', () => {
    const near = pair(1.8);
    expect(decide(near.world, near.track, near.b)).not.toBeNull();
    expect(near.b.ai.pitCall).toBe('undercut');
    expect(near.b.ai.paceMode).toBe('push');
    // its own plan would stop later
    expect(near.b.ai.planStay).toBeGreaterThan(0);

    // too far back to jump it
    const far = pair(4);
    expect(decide(far.world, far.track, far.b)).toBeNull();
    // the car ahead reaches the flag without a stop: nothing to undercut
    const noStop = pair(1.8);
    setup(noStop.world, noStop.track, noStop.a, { lap: 11, wear: 0.05, rate: 0.01, position: 1, interval: 0, compound: 'hard' });
    expect(decide(noStop.world, noStop.track, noStop.b)).toBeNull();
    expect(noStop.b.ai.pitCall).not.toBe('undercut');
  });

  test('overcut: the car ahead boxes this lap → stay out (clean air, the old set still as quick as its out-lap)', () => {
    // a quicker car behind a slower one; its own plan says box now
    const run = (rivalBoxes: boolean): CarEntry => {
      const { world, track, a, b } = pair(1.2, 0.64, ['caldwell', 'varga']);
      b.ai.aheadId = a.id;
      b.ai.aheadStops = 0;
      b.ai.aheadGap = 1.2;
      if (rivalBoxes) {
        a.pit.requested = true;
        a.pit.nextCompound = 'hard';
      }
      expect(decide(world, track, b) === null).toBe(rivalBoxes);
      return b;
    };
    const stays = run(true);
    expect(stays.ai.overcuts).toBe(1);
    expect(stays.ai.paceMode).toBe('push');
    const boxes = run(false);
    expect(boxes.ai.pitCall).toBe('plan');
    expect(boxes.ai.overcuts).toBe(0);
  });

  test('cover: the car behind (within 2 s) has just stopped → follow it in on the next lap', () => {
    const run = (rivalStopped: boolean): CarEntry => {
      const { world, track, a, b } = pair(21, 0.45);
      a.ai.behindId = b.id;
      a.ai.behindStops = 0;
      a.ai.behindGap = 1.5;
      if (rivalStopped) {
        b.pit.stops = 1;
        setup(world, track, b, { lap: 11, wear: 0.02, rate: 0.03, position: 2, interval: 21, compound: 'soft' });
      }
      decide(world, track, a);
      return a;
    };
    const covers = run(true);
    expect(covers.ai.pitCall).toBe('cover');
    expect(covers.ai.paceMode).toBe('push');
    expect(run(false).ai.pitCall).toBe('none');
  });
});

describe('C3 safety car / VSC', () => {
  test('a stop planned a few laps on is taken now under the SC / VSC; not under green', () => {
    for (const mode of ['green', 'sc', 'vsc'] as const) {
      const { world, track } = frozenRace('silverstone', 30, [{ driver: 'varga' }, { driver: 'marchand' }]);
      const car = world.cars[0];
      setup(world, track, car, { lap: 11, wear: 0.45, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
      world.session.control.mode = mode;
      const call = decide(world, track, car);
      if (mode === 'green') {
        expect(call).toBeNull();
        expect(car.ai.planStay).toBeGreaterThan(0);
      } else {
        expect(call).not.toBeNull();
        expect(car.ai.pitCall).toBe('neutral');
      }
    }
  });

  test('lower bound: no extra stop on a fresh set or with too few laps left', () => {
    const { world, track } = frozenRace('silverstone', 8, [{ driver: 'varga' }, { driver: 'marchand' }]);
    const car = world.cars[0];
    setup(world, track, car, { lap: 5, wear: 0.1, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
    world.session.control.mode = 'sc';
    expect(decide(world, track, car)).toBeNull();
    setup(world, track, car, { lap: 7, wear: 0.5, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
    expect(decide(world, track, car)).toBeNull();
  });

  test('team-mates: not stacked in the box under the SC for a marginal stop — unless the tyres are gone', () => {
    const run = (wear: number, mateBoxing: boolean): TireCompound | null => {
      const { world, track } = frozenRace('silverstone', 14, [{ driver: 'varga' }, { driver: 'morioka' }, { driver: 'marchand' }]);
      const [car, mate] = world.cars;
      expect(mate.teamId).toBe(car.teamId);
      setup(world, track, car, { lap: 10, wear, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
      world.session.control.mode = 'sc';
      mate.pit.requested = mateBoxing;
      return decide(world, track, car);
    };
    expect(run(0.35, false)).not.toBeNull();
    expect(run(0.35, true)).toBeNull();
    expect(run(0.62, true)).not.toBeNull();
  });
});

describe('C4 weather forecast', () => {
  function wetRace(compound: TireCompound, weather: Partial<WeatherState>): { world: WorldState; track: BuiltTrack; car: CarEntry } {
    const { world, track } = frozenRace('silverstone', 20, [{ driver: 'varga' }, { driver: 'marchand' }]);
    world.time = 0;
    Object.assign(world.weather, { forecast: [], trackTemp: 18, ...weather });
    const car = world.cars[0];
    setup(world, track, car, { lap: 6, wear: 0.15, rate: 0.03, position: 1, interval: 0, compound });
    car.ai.weatherTimer = 10;
    return { world, track, car };
  }

  test('the forecast is read forward: rain to come wets the track, a stopped shower dries it', () => {
    const w = wetRace('soft', { kind: 'overcast', rain: 0, wetness: 0, forecast: [{ time: 30, kind: 'heavyRain' }] }).world.weather;
    expect(predictWetness(w, 0, 20)).toBe(0);
    expect(predictWetness(w, 0, 200)).toBeGreaterThan(0.6);
    const drying = wetRace('wet', { kind: 'overcast', rain: 0, wetness: 0.45 }).world.weather;
    expect(predictWetness(drying, 0, 190)).toBeLessThan(0.2);
  });

  test('rain coming and the track near the crossover: inters a lap early; no rain about: stay on slicks', () => {
    const early = wetRace('soft', { kind: 'lightRain', rain: 0.3, wetness: 0.22 });
    expect(decide(early.world, early.track, early.car)).toBe('inter');
    expect(early.car.ai.pitCall).toBe('forecast');
    const dry = wetRace('soft', { kind: 'overcast', rain: 0, wetness: 0.22 });
    expect(decide(dry.world, dry.track, dry.car)).toBeNull();
  });

  test('drying within two laps: no new rain tyre on the way to slicks; steady rain: the inter swap', () => {
    const drying = wetRace('wet', { kind: 'overcast', rain: 0, wetness: 0.45 });
    expect(decide(drying.world, drying.track, drying.car)).toBeNull();
    const steady = wetRace('wet', { kind: 'lightRain', rain: 0.42, wetness: 0.41 });
    expect(decide(steady.world, steady.track, steady.car)).toBe('inter');
    expect(steady.car.ai.pitCall).toBe('weather');
    // at the crossover to slicks they go on…
    const dryOut = wetRace('inter', { kind: 'overcast', rain: 0, wetness: 0.15 });
    expect(isDry(decide(dryOut.world, dryOut.track, dryOut.car) ?? 'inter')).toBe(true);
    // …unless the forecast brings the rain back
    const back = wetRace('inter', { kind: 'overcast', rain: 0, wetness: 0.15, forecast: [{ time: 5, kind: 'lightRain' }] });
    expect(decide(back.world, back.track, back.car)).toBeNull();
  });

  test('never a compound the next lap would not suit: heavy rain building → wets, not inters', () => {
    const heavy = wetRace('soft', { kind: 'heavyRain', rain: 0.6, wetness: 0.4 });
    expect(decide(heavy.world, heavy.track, heavy.car)).toBe('wet');
    const light = wetRace('soft', { kind: 'lightRain', rain: 0.42, wetness: 0.4 });
    expect(decide(light.world, light.track, light.car)).toBe('inter');
  });
});

describe('A3 pace mode (strategy side)', () => {
  test('conserve to stretch the set to its stop; push in the last laps; standard otherwise', () => {
    const { world, track } = frozenRace('silverstone', 30, [{ driver: 'varga' }, { driver: 'marchand' }]);
    const car = world.cars[0];
    // the set must stretch to its planned stop 3 laps on (ending within 0.06 of PIT_WEAR); at 0.6 wear the real-lap-scale
    // paceTime makes the model stop at once instead (the stretch / stop-now tie moves with the degradation cost in seconds)
    setup(world, track, car, { lap: 11, wear: 0.58, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
    decide(world, track, car);
    expect(car.ai.paceMode).toBe('conserve');
    setup(world, track, car, { lap: 11, wear: 0.2, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
    decide(world, track, car);
    expect(car.ai.paceMode).toBe('standard');
    // the last laps (a fifth of the race, at most three) with tyres to spare
    setup(world, track, car, { lap: 28, wear: 0.2, rate: 0.02, position: 1, interval: 0, compound: 'medium' });
    decide(world, track, car);
    expect(car.ai.paceMode).toBe('push');
    // neutralised: standard
    setup(world, track, car, { lap: 28, wear: 0.2, rate: 0.02, position: 1, interval: 0, compound: 'medium' });
    world.session.control.mode = 'vsc';
    decide(world, track, car);
    expect(car.ai.paceMode).toBe('standard');
  });

  test('conserve when the fuel will not last at the measured burn', () => {
    const { world, track } = frozenRace('silverstone', 30, [{ driver: 'varga' }, { driver: 'marchand' }]);
    const car = world.cars[0];
    setup(world, track, car, { lap: 11, wear: 0.2, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
    car.ai.fuelPerLap = 2;
    car.ai.fuelMarkLap = -1;
    car.phys.fuelKg = 2 * 19 * 0.97;
    decide(world, track, car);
    expect(car.ai.paceMode).toBe('conserve');
    setup(world, track, car, { lap: 12, wear: 0.2, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
    car.ai.fuelPerLap = 2;
    car.ai.fuelMarkLap = -1;
    car.phys.fuelKg = 2 * 18 * 1.2;
    decide(world, track, car);
    expect(car.ai.paceMode).toBe('standard');
  });
});

describe('C5 team orders', () => {
  /** okafor leads; varga (slower, worn hards) with its team-mate morioka right behind on fresh softs; marchand last. */
  function teamWorld(o: { laps?: number; humanBehind?: boolean; humanAhead?: boolean; mateCompound?: TireCompound } = {}) {
    const laps = o.laps ?? 25;
    const { world, track } = frozenRace('silverstone', laps, [
      { driver: 'okafor' },
      { driver: 'varga', human: o.humanAhead },
      { driver: 'morioka', human: o.humanBehind },
      { driver: 'marchand' },
    ]);
    const [lead, front, rear, last] = world.cars;
    const at = (lap: number, rearGap = 1, leadGap = 3): void => {
      setup(world, track, lead, { lap, wear: 0.3, rate: 0.02, position: 1, interval: 0 });
      setup(world, track, front, { lap, wear: 0.5, rate: 0.02, position: 2, interval: leadGap, compound: 'hard' });
      setup(world, track, rear, { lap, wear: 0.1, rate: 0.03, position: 3, interval: rearGap, compound: o.mateCompound ?? 'soft' });
      setup(world, track, last, { lap, wear: 0.3, rate: 0.02, position: 4, interval: 5 });
    };
    return { world, track, lead, front, rear, at };
  }

  test('AI → AI: a team-mate quicker by > 0.35 s a lap for two laps on another strategy is let by', () => {
    const { world, track, front, rear, at } = teamWorld();
    expect(front.teamId).toBe(rear.teamId);
    at(8);
    decide(world, track, front);
    expect(front.ai.yieldFor).toBe(-1);
    at(9);
    decide(world, track, front);
    expect(front.ai.yieldFor).toBe(rear.id);
    expect(front.ai.yieldTimer).toBeGreaterThan(0);

    // too far back, or not quicker: no order
    const far = teamWorld();
    far.at(8, 2.5);
    decide(far.world, far.track, far.front);
    far.at(9, 2.5);
    decide(far.world, far.track, far.front);
    expect(far.front.ai.yieldFor).toBe(-1);
  });

  test('AI → human: the AI lets a quicker human team-mate by (and tells it); a human is never asked', () => {
    const behind = teamWorld({ humanBehind: true });
    const ref = behind.track.referenceLapTime;
    // the human's measured clean laps are clearly quicker than the AI ahead
    behind.at(8);
    behind.rear.ai.cleanLap = behind.front.ai.paceTime - 1.5;
    decide(behind.world, behind.track, behind.front);
    behind.at(9);
    decide(behind.world, behind.track, behind.front);
    expect(behind.front.ai.yieldFor).toBe(behind.rear.id);
    // once by, the AI does not race it straight back
    expect(behind.front.ai.noRaceFor).toBe(behind.rear.id);
    expect(ref).toBeGreaterThan(0);
    behind.world.events.length = 0;
    radioTeamYield(behind.world, behind.front, behind.rear);
    const lines = behind.world.events.filter((e): e is Extract<GameEvent, { type: 'radio' }> => e.type === 'radio');
    expect(lines.some((e) => e.carId === behind.rear.id && e.text.includes('讓你通過'))).toBe(true);

    // the human ahead, an AI team-mate quicker behind: nothing is decided for the human, the AI holds no order on it
    const ahead = teamWorld({ humanAhead: true });
    for (const lap of [8, 9, 10]) {
      ahead.at(lap);
      expect(decide(ahead.world, ahead.track, ahead.front)).toBeNull();
      decide(ahead.world, ahead.track, ahead.rear);
    }
    expect(ahead.front.ai.yieldFor).toBe(-1);
    expect(ahead.front.ai.teamFaster).toBe(0);
    expect(ahead.rear.ai.holdFor).toBe(-1);
    ahead.world.events.length = 0;
    radioTeamYield(ahead.world, ahead.front, ahead.rear);
    expect(ahead.world.events).toHaveLength(0);
  });

  test('AI → human: a fast estimate never makes a slow human look fast; no clean lap or the opening laps: no order', () => {
    // the human on fresh softs (its car estimated quicker), but its real clean laps 2.5 s slower than the AI ahead
    const slow = teamWorld({ humanBehind: true });
    for (const lap of [8, 9, 10]) {
      slow.at(lap);
      const theirs = estimatedPace(slow.front, 0) + 2.5;
      slow.rear.ai.cleanLap = theirs;
      slow.rear.timing.lastLap = theirs;
      decide(slow.world, slow.track, slow.front);
    }
    expect(slow.front.ai.yieldFor).toBe(-1);
    // the AI's own clean laps quicker than the human's, though its estimate is slower
    const real = teamWorld({ humanBehind: true });
    for (const lap of [8, 9, 10]) {
      real.at(lap);
      const est = estimatedPace(real.front, 0);
      real.rear.ai.cleanLap = est - 0.6;
      real.front.ai.cleanLap = est - 1.2;
      decide(real.world, real.track, real.front);
    }
    expect(real.front.ai.yieldFor).toBe(-1);
    // no clean lap measured yet
    const none = teamWorld({ humanBehind: true });
    for (const lap of [8, 9, 10]) {
      none.at(lap);
      decide(none.world, none.track, none.front);
    }
    expect(none.front.ai.yieldFor).toBe(-1);
    // the lap-1 evaluation does not count toward "two evaluations in a row" (the standing start tells nothing)
    const early = teamWorld();
    early.at(1);
    decide(early.world, early.track, early.front);
    expect(early.front.ai.teamFaster).toBe(0);
    early.at(2);
    decide(early.world, early.track, early.front);
    expect(early.front.ai.teamFaster).toBe(1);
    expect(early.front.ai.yieldFor).toBe(-1);
  });

  test('cleanLap: the better of the last two clean green-flag laps — not lap 1, not a pit lap, not under a neutralisation', () => {
    const track = getLayout('monaco');
    const world = createWorld(config('monaco', 6, [{ driver: 'okafor' }, { driver: 'varga' }]), track);
    const car = world.cars[0];
    const laps: { lap: number; time: number; pit: boolean; neutral: boolean }[] = [];
    let pitLap = false;
    let neutral = false;
    let last = 0;
    while (!isSessionOver(world) && world.time < 900) {
      stepWorld(world, track, [], SIM_DT);
      if (car.pit.phase !== 'none') pitLap = true;
      if (world.session.control.mode !== 'green') neutral = true;
      if (car.timing.lapsCompleted > last) {
        laps.push({ lap: last + 1, time: car.timing.lastLap ?? 0, pit: pitLap, neutral });
        last = car.timing.lapsCompleted;
        pitLap = car.pit.phase !== 'none';
        neutral = world.session.control.mode !== 'green';
        const clean = laps.filter((l) => l.lap > 1 && !l.pit && !l.neutral).map((l) => l.time);
        const want = clean.length === 0 ? 0 : clean.length === 1 ? clean[0] : Math.min(clean[clean.length - 1], clean[clean.length - 2]);
        expect(car.ai.cleanLap).toBeCloseTo(want, 6);
      }
      if (last >= 4) break;
    }
    expect(last).toBeGreaterThanOrEqual(4);
    expect(car.ai.cleanLap).toBeGreaterThan(0);
    // lap 1 (standing start) never counts
    expect(car.ai.cleanLap).toBeLessThan(laps[0].time);
  });

  test('hold position: the last laps, both AI team-mates in the points and close → neither races the other', () => {
    const { world, track, front, rear, at } = teamWorld({ laps: 25, mateCompound: 'hard' });
    at(15, 0.6);
    decide(world, track, front);
    decide(world, track, rear);
    expect(front.ai.holdFor).toBe(-1);
    at(21, 0.6);
    decide(world, track, front);
    decide(world, track, rear);
    expect(front.ai.holdFor).toBe(rear.id);
    expect(rear.ai.holdFor).toBe(front.id);
    // a short race is not "the last five laps" throughout
    const short = teamWorld({ laps: 5, mateCompound: 'hard' });
    short.at(2, 0.6);
    decide(short.world, short.track, short.rear);
    expect(short.rear.ai.holdFor).toBe(-1);
  });

  describe('on track (planTraffic)', () => {
    const track = getLayout('monza');
    /** The middle of the longest straight. */
    const straight = ((): number => {
      const c = track.corners;
      let best = 0;
      let at = 0;
      for (let i = 0; i < c.length; i++) {
        const d = forwardDistance(track, c[i].endS, c[(i + 1) % c.length].startS);
        if (d > best) {
          best = d;
          at = i;
        }
      }
      return wrapS(track, c[at].endS + best / 2);
    })();
    const put = (car: CarEntry, s: number, v: number): void => {
      const at = wrapS(track, s);
      const lat = sampleAt(track, track.racingLine, at);
      const pose = poseAt(track, at, lat);
      const p = car.phys;
      Object.assign(p, { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, speed: v, vLong: v, vLat: 0, brake: 0, s: at, lateral: lat });
      p.vx = forwardX(pose.yaw) * v;
      p.vz = forwardZ(pose.yaw) * v;
      p.trackIndex = indexAtS(track, at);
      car.status = 'running';
    };
    const ctx = (car: CarEntry): TrafficContext => ({
      plannedLateral: car.phys.lateral,
      lookahead: 38,
      trackSpeed: SPEED_CAP,
      brakeDecel: 40,
      dt: SIM_DT,
      openingLap: false,
      openingLapStart: false,
    });
    /** varga 20 m ahead of its team-mate morioka down the main straight, held up long enough to try a move. */
    function duel(): { world: WorldState; front: CarEntry; rear: CarEntry } {
      const world = createWorld(config('monza', 10, [{ driver: 'varga' }, { driver: 'morioka' }]), track);
      const [front, rear] = world.cars;
      put(front, straight + 20, 75);
      put(rear, straight, 75);
      front.timing.position = 1;
      rear.timing.position = 2;
      rear.timing.interval = 0.3;
      rear.ai.followTimer = 10;
      return { world, front, rear };
    }

    test('hold position: no attack on the team-mate; let by: the yielding car moves off line and lifts, no defence', () => {
      const free = duel();
      planTraffic(free.world, free.rear, track, ctx(free.rear));
      expect(free.rear.ai.mode).toBe('attack');

      const held = duel();
      held.rear.ai.holdFor = held.front.id;
      planTraffic(held.world, held.rear, track, ctx(held.rear));
      expect(held.rear.ai.mode).toBe('race');
      expect(held.rear.ai.attackTimer).toBe(0);

      const yielding = duel();
      yielding.front.ai.yieldFor = yielding.rear.id;
      yielding.front.ai.yieldTimer = 30;
      const plan = planTraffic(yielding.world, yielding.front, track, ctx(yielding.front));
      expect(plan.lateral).not.toBeNull();
      expect(Math.abs(plan.lateral! - yielding.rear.phys.lateral)).toBeGreaterThan(2);
      expect(plan.speedLimit).toBeLessThan(SPEED_CAP);
      expect(yielding.front.ai.mode).not.toBe('defend');
      // the team-mate passes it like a car owing it the place, even in a DRS train
      yielding.world.session.drsEnabled = true;
      yielding.front.timing.interval = 0.5;
      yielding.front.timing.position = 2;
      planTraffic(yielding.world, yielding.rear, track, ctx(yielding.rear));
      expect(yielding.rear.ai.inTrain).toBe(false);
      expect(yielding.rear.ai.mode).toBe('attack');
    });
  });

  /**
   * A 6-lap Monaco race: morioka (hards) leads its quicker team-mate varga (mediums: ~2.5 s a lap, not enough to pass
   * at Monaco before the order from the lap-3 evaluation); `human` drives one of them. A human
   * behind cannot show its pace stuck in the AI's dirty air at Monaco: its measured clean pace is set 1.5 s quicker than
   * the AI's estimate (as if it had lapped that fast before catching up).
   */
  function monaco(human: 'none' | 'front' | 'rear'): { world: WorldState; radio: Extract<GameEvent, { type: 'radio' }>[]; passed: boolean } {
    const track = getLayout('monaco');
    const world = createWorld(
      config('monaco', 6, [
        { driver: 'morioka', compound: 'hard', human: human === 'front' },
        { driver: 'varga', compound: 'medium', human: human === 'rear' },
      ], { seed: 4 }),
      track,
    );
    const radio: Extract<GameEvent, { type: 'radio' }>[] = [];
    let passed = false;
    while (!isSessionOver(world) && world.time < 900) {
      const id = getPlayerCarId(world, 0);
      const inputs: (ControlInput | null)[] = id >= 0 ? [computeAIInput(world, world.cars[id], track, SIM_DT)] : [];
      stepWorld(world, track, inputs, SIM_DT);
      if (human === 'rear' && world.cars[1].timing.lapsCompleted >= 2) {
        world.cars[1].ai.cleanLap = estimatedPace(world.cars[0], world.weather.wetness) - 1.5;
      }
      for (const e of world.events) {
        if (e.type === 'radio') radio.push(e);
        if (e.type === 'overtake' && e.carId === 1 && e.passedCarId === 0) passed = true;
      }
      world.events.length = 0;
    }
    return { world, radio, passed };
  }

  test(
    'in a race: the AI lets its quicker team-mate by on a straight (AI or human); a human ahead is never asked',
    () => {
      const ai = monaco('none');
      expect(ai.radio.some((e) => e.carId === 0 && e.text.includes('讓隊友'))).toBe(true);
      expect(ai.passed).toBe(true);

      const toHuman = monaco('rear');
      expect(toHuman.radio.some((e) => e.carId === 1 && e.text.includes('讓你通過'))).toBe(true);
      expect(toHuman.passed).toBe(true);

      const humanAhead = monaco('front');
      expect(humanAhead.radio.filter((e) => e.carId === 0 && e.text.includes('車隊指令'))).toHaveLength(0);
      expect(humanAhead.world.cars[1].ai.yieldFor).toBe(-1);
      expect(humanAhead.world.cars[1].ai.holdFor).toBe(-1);
    },
    60_000,
  );
});

describe('review fixes', () => {
  test('a full-distance race has a plan on quickly wearing softs (up to four stops); without one the SC rule of old', () => {
    // Silverstone 52 laps: soft at ~0.079 a lap — two fresh sets do not reach the flag after a stop now
    const input: PlanInput = { laps: 45, base: 90, compound: 'soft', wear: 0.45, rate: 0.079 / COMPOUND_PARAMS.soft.wearRate, pitLoss: 16.6, mandatory: false, used: ['soft'] };
    const plan = planRace(input);
    expect(plan.best).not.toBeNull();
    expect(plan.best!.stints.length).toBeGreaterThanOrEqual(3);
    for (const end of stintEnds(input, plan.best!).slice(0, -1)) expect(end).toBeLessThanOrEqual(PIT_WEAR + 1e-9);
    // in the race: a plan after lap 2, and the worn soft starters take the cheap stop under the SC at lap 6
    const { world, track } = frozenRace('silverstone', 52, [{ driver: 'varga' }, { driver: 'marchand' }]);
    const car = world.cars[0];
    setup(world, track, car, { lap: 3, wear: 0.16, rate: 0.079, position: 1, interval: 0, compound: 'soft' });
    decide(world, track, car);
    expect(car.ai.planStops).toBeGreaterThanOrEqual(1);
    setup(world, track, car, { lap: 6, wear: 0.45, rate: 0.079, position: 1, interval: 0, compound: 'soft' });
    world.session.control.mode = 'sc';
    expect(decide(world, track, car)).not.toBeNull();
    expect(car.ai.pitCall).toBe('neutral');
  });

  test('a fresh set is not thrown away under an early SC on a wear rate that is still settling', () => {
    // a lap into the stint the rate reads high (soft 0.105 at lap 2): the plan says one stop, but not soon
    const { world, track } = frozenRace('silverstone', 10, [{ driver: 'varga' }, { driver: 'marchand' }]);
    const car = world.cars[0];
    setup(world, track, car, { lap: 2, wear: 0.105, rate: 0.105, position: 1, interval: 0, compound: 'soft' });
    for (const mode of ['sc', 'scEnding', 'vsc'] as const) {
      world.session.control.mode = mode;
      car.ai.strategyLap = -1;
      expect(decide(world, track, car)).toBeNull();
    }
  });

  test('in a race: an SC on lap 1 brings in no car on a fresh set', () => {
    const track = getLayout('silverstone');
    const grid = ['okafor', 'varga', 'marchand', 'dahl', 'morioka', 'caldwell', 'lindqvist', 'costa', 'takeda', 'brandt'].map((driver) => ({
      driver,
      compound: 'soft' as TireCompound,
    }));
    const world = createWorld(config('silverstone', 10, grid, { seed: 5 }), track);
    let forced = false;
    const stops: { wear: number; reason: string }[] = [];
    const before = new Map<number, number>();
    while (!isSessionOver(world) && world.session.leaderLap < 5 && world.time < 900) {
      for (const c of world.cars) before.set(c.id, c.pit.stops);
      stepWorld(world, track, [], SIM_DT);
      world.events.length = 0;
      if (!forced && world.session.phase === 'running' && world.session.leaderLap >= 1 && world.time > 20) forced = forceIncident(world, track, 'sc');
      for (const c of world.cars) if (c.pit.requested && c.ai.pitCall !== 'none' && !stops.some((x) => x.reason === `${c.id}`)) {
        stops.push({ wear: c.phys.tire.wear, reason: `${c.id}` });
      }
    }
    expect(forced).toBe(true);
    expect(world.session.leaderLap).toBeGreaterThanOrEqual(4);
    // nobody boxed a set worn below the SC lower bound
    for (const s of stops) expect(s.wear).toBeGreaterThan(0.3);
  }, 60_000);

  test('rain due within two laps of the pit exit: no new slick set (only the wear backstop still stops)', () => {
    const run = (forecast: boolean, wear: number): CarEntry => {
      const { world, track } = frozenRace('silverstone', 30, [{ driver: 'varga' }, { driver: 'marchand' }]);
      world.time = 0;
      Object.assign(world.weather, { kind: 'overcast', rain: 0, wetness: 0, trackTemp: 18, forecast: forecast ? [{ time: 60, kind: 'lightRain' }] : [] });
      const car = world.cars[0];
      setup(world, track, car, { lap: 11, wear, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
      decide(world, track, car);
      return car;
    };
    // the plan boxes now in the dry (the overcut test's car)
    expect(run(false, 0.64).ai.pitCall).toBe('plan');
    // light rain in a minute: inters by two laps after the stop — hold
    expect(run(true, 0.64).ai.pitCall).toBe('none');
    // the set is gone: the backstop stops anyway
    expect(run(true, 0.74).ai.pitCall).toBe('wear');
  });

  test('the repair stop serves the mandatory stop; a lapped car serves it by half distance', () => {
    const { world, track } = frozenRace('monza', 14, [{ driver: 'varga' }, { driver: 'marchand' }], { mandatory: true });
    const car = world.cars[0];
    setup(world, track, car, { lap: 3, wear: 0.06, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
    car.phys.damage.frontWing = 0.6;
    expect(decide(world, track, car)).not.toBe('medium');
    expect(car.ai.pitCall).toBe('damage');

    // lap 8 of 14 on softs that last: the leader may still wait, a car 3 laps down (its flag at its own lap 11) may not
    const lapped = (down: number): CarEntry => {
      const r = frozenRace('monza', 14, [{ driver: 'varga' }, { driver: 'marchand' }], { mandatory: true });
      const c = r.world.cars[1];
      setup(r.world, r.track, r.world.cars[0], { lap: 8, wear: 0.2, rate: 0.03, position: 1, interval: 0, compound: 'soft' });
      setup(r.world, r.track, c, { lap: 8, wear: 0.2, rate: 0.03, position: 2, interval: 30, compound: 'soft' });
      c.timing.lapsDown = down;
      decide(r.world, r.track, c);
      return c;
    };
    expect(lapped(0).ai.pitCall).toBe('none');
    const down = lapped(3);
    expect(down.ai.pitCall).toBe('mandatory');
  });

  test('cover: not after a car that has already passed us', () => {
    const { world, track } = frozenRace('silverstone', 30, [{ driver: 'varga' }, { driver: 'marchand' }, { driver: 'okafor' }]);
    const [a, b, c] = world.cars;
    // remembered behind us at the last evaluation; it has since passed and is boxing for softs
    setup(world, track, b, { lap: 11, wear: 0.45, rate: 0.03, position: 1, interval: 0, compound: 'medium' });
    setup(world, track, a, { lap: 11, wear: 0.45, rate: 0.03, position: 2, interval: 1.2, compound: 'medium' });
    setup(world, track, c, { lap: 11, wear: 0.45, rate: 0.03, position: 3, interval: 20, compound: 'medium' });
    a.ai.behindId = b.id;
    a.ai.behindStops = 0;
    a.ai.behindGap = 1.5;
    b.pit.requested = true;
    b.pit.nextCompound = 'soft';
    decide(world, track, a);
    expect(a.ai.pitCall).not.toBe('cover');
  });
});
