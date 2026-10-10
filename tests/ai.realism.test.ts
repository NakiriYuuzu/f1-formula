/**
 * AI driving realism (docs/plans/phase2-ai.md §A): trail braking (A1), kerb use (A2), pace modes (A3), natural
 * self-correcting mistakes (A4) and wet-weather differentiation (A5) — unit checks on the planning model, solo
 * headless laps / stints and 20-car headless races (dry and heavy rain, difficulty 90, several seeds).
 */
import { describe, expect, test } from 'bun:test';
import {
  KERB_REACH,
  PACE_MODE_FACTOR,
  TRAIL_MAX,
  brakingDecel,
  capability,
  createAIState,
  drawNaturalMistake,
  kerbLineAt,
  kerbReachAt,
  kerbSkill,
  lineCurvatureAt,
  naturalMistakeChance,
  targetSpeedAt,
  trailBraking,
  wetBrakeFactor,
  wetMistakeFactor,
  wetPaceFactor,
  wetTechnique,
} from '../src/ai/index';
import { PATH_EDGE_MARGIN } from '../src/ai/profile';
import { createWorld, isSessionOver, stepWorld } from '../src/race/index';
import { createCarSpec } from '../src/physics/index';
import { RACING_LINE_MARGIN, sampleAt } from '../src/track/track';
import { DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import type { AIPaceMode } from '../src/ai/index';
import type { CarEntry, SessionConfig, TireCompound, WeatherKind, WorldState } from '../src/core/types';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');
const driver = (id: string) => RACERS.find((d) => d.id === id)!;
const varga = driver('varga');
const caldwell = driver('caldwell');
const spec = createCarSpec(TEAMS[0], DEFAULT_SETUP, '2025');

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** One AI car alone: a qualifying session (2 timed laps, no fuel) or a race stint. */
function soloConfig(layoutId: string, driverId: string, kind: 'qualifying' | 'race', laps: number, compound: TireCompound): SessionConfig {
  const d = driver(driverId);
  return {
    mode: 'grandPrix',
    kind,
    layoutId,
    laps: kind === 'race' ? laps : 0,
    timeLimit: kind === 'race' ? null : 900,
    qualifyingLaps: kind === 'race' ? 0 : 2,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 90,
    players: [],
    grid: [{ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: compound }],
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off', fuel: kind === 'race' },
    seed: 42,
    ghost: null,
    objective: null,
  };
}

/** The 20-car grid of the phase-2 metrics (car strength + driver pace, seeded tyres), difficulty 90, 5 laps. */
function raceConfig(layoutId: string, weather: WeatherKind, seed: number): SessionConfig {
  const strength = (id: string): number => {
    const d = driver(id);
    const t = TEAMS.find((x) => x.id === d.teamId)!;
    return (t.rating.aero + t.rating.power + t.rating.chassis) / 3 + d.skill.pace * 0.35 + (hash(`${id}${seed}`) - 0.5) * 0.04;
  };
  const order = RACERS.map((d) => d.id).sort((a, b) => strength(b) - strength(a));
  return {
    mode: 'grandPrix',
    kind: 'race',
    layoutId,
    laps: 5,
    timeLimit: null,
    qualifyingLaps: 0,
    weather,
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 90,
    players: [],
    grid: order.map((id, i) => {
      let compound: TireCompound = weather === 'heavyRain' ? 'wet' : hash(`${id}tyre${seed}`) < 0.55 ? 'medium' : 'soft';
      if (weather === 'heavyRain' && i % 4 === 0) compound = 'soft';
      return { driverId: id, teamId: driver(id).teamId, playerIndex: -1, startCompound: compound };
    }),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed,
    ghost: null,
    objective: null,
  };
}

interface SoloRun {
  laps: number[];
  maxRearSlip: number;
  maxSideslip: number;
  offRoad: number;
  trackLimits: number;
  /** seconds beyond the old path edge (halfWidth − PATH_EDGE_MARGIN) on a side with a kerb */
  overEdgeOnKerb: number;
  wearAfterLap1: number;
  wear: number;
  overtakeTime: number;
}

/** Run a solo session; `tweak` adjusts the AI brain before the start. */
function runSolo(config: SessionConfig, tweak: (car: CarEntry) => void = () => {}, each?: (car: CarEntry) => void): SoloRun {
  const track = getLayout(config.layoutId);
  const world = createWorld(config, track);
  const car = world.cars[0];
  tweak(car);
  const out: SoloRun = { laps: [], maxRearSlip: 0, maxSideslip: 0, offRoad: 0, trackLimits: 0, overEdgeOnKerb: 0, wearAfterLap1: 0, wear: 0, overtakeTime: 0 };
  while (!isSessionOver(world) && world.time < 900) {
    each?.(car);
    stepWorld(world, track, [], SIM_DT);
    for (const e of world.events) {
      if (e.type === 'lapComplete') {
        out.laps.push(e.time);
        if (out.laps.length === 1) out.wearAfterLap1 = car.phys.tire.wear;
      } else if (e.type === 'trackLimits') out.trackLimits++;
    }
    world.events.length = 0;
    const p = car.phys;
    if (car.status !== 'running' || car.pit.phase !== 'none') continue;
    if (p.speed > 10) {
      out.maxRearSlip = Math.max(out.maxRearSlip, Math.abs(p.slipAngleRear));
      out.maxSideslip = Math.max(out.maxSideslip, Math.abs(Math.atan2(p.vLat, p.vLong)));
    }
    if (p.surface !== 'asphalt' && p.surface !== 'kerb' && p.surface !== 'pitlane') out.offRoad += SIM_DT;
    if (p.ers.overtakeActive) out.overtakeTime += SIM_DT;
    const kerb = sampleAt(track, p.lateral >= 0 ? track.kerbRight : track.kerbLeft, p.s);
    if (kerb > 0 && Math.abs(p.lateral) > sampleAt(track, track.halfWidth, p.s) - PATH_EDGE_MARGIN) out.overEdgeOnKerb += SIM_DT;
  }
  out.wear = car.phys.tire.wear;
  return out;
}

const best = (r: SoloRun): number => Math.min(...r.laps);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('A1 trail braking', () => {
  test('brakingDecel: a trail-braking driver keeps more braking under lateral load, never beyond the true circle', () => {
    const plain = capability(spec, 1, 50, 0.95, 0.88);
    const trail = capability(spec, 1, 50, 0.95, 0.88, undefined, TRAIL_MAX);
    expect(plain.trail).toBe(0);
    expect(trail.trail).toBe(TRAIL_MAX);
    const v = 60;
    const total = plain.brkA + plain.brkB * v * v;
    const latMax = plain.latA + plain.latB * v * v;
    // straight line: identical
    expect(brakingDecel(trail, v, 0)).toBe(brakingDecel(plain, v, 0));
    for (const r of [0.3, 0.5, 0.7, 0.9]) {
      const k = (r * latMax) / (v * v);
      const q = 1 - r * r;
      // trail 0 = the conservative combination it always used
      expect(brakingDecel(plain, v, k)).toBeCloseTo(total * Math.max(0.1, q), 9);
      expect(brakingDecel(trail, v, k)).toBeGreaterThan(brakingDecel(plain, v, k));
      expect(brakingDecel(trail, v, k)).toBeLessThanOrEqual(total * Math.sqrt(q) + 1e-9);
    }
    // at / beyond the lateral limit: the 0.1 floor
    expect(brakingDecel(trail, v, (1.2 * latMax) / (v * v))).toBeCloseTo(total * 0.1, 9);
  });

  test('targetSpeedAt: the same car brakes later for a corner with trail braking', () => {
    const track = getLayout('silverstone');
    const plain = capability(spec, 1, 50, 0.95, 0.88);
    const trail = capability(spec, 1, 50, 0.95, 0.88, undefined, TRAIL_MAX);
    const corner = [...track.corners].sort((a, b) => a.minSpeed - b.minSpeed)[0];
    // braking point: the last position before the apex still allowing 75 m/s
    const brakePoint = (cap: typeof plain): number => {
      let at = -1;
      for (let d = 400; d >= 0; d -= 1) {
        const s = corner.apexS - d;
        expect(targetSpeedAt(track, trail, s, 80)).toBeGreaterThanOrEqual(targetSpeedAt(track, plain, s, 80) - 1e-9);
        if (targetSpeedAt(track, cap, s, 80) >= 75) at = s;
      }
      return at;
    };
    const late = brakePoint(trail);
    const early = brakePoint(plain);
    expect(early).toBeGreaterThan(corner.apexS - 400);
    expect(late).toBeGreaterThan(early);
  });

  test('trail coefficient from pace, consistency and difficulty; the least technical drivers barely use it', () => {
    const top = trailBraking(90, varga.skill.pace, varga.skill.consistency);
    expect(top).toBeGreaterThan(0.3);
    expect(top).toBeLessThanOrEqual(TRAIL_MAX);
    expect(trailBraking(90, caldwell.skill.pace, caldwell.skill.consistency)).toBeLessThan(0.05);
    expect(trailBraking(110, varga.skill.pace, varga.skill.consistency)).toBeGreaterThan(top);
    expect(trailBraking(30, varga.skill.pace, varga.skill.consistency)).toBeLessThan(top);
    expect(trailBraking(110, 1, 1)).toBeLessThanOrEqual(TRAIL_MAX);
    expect(createAIState(varga, 90, 7).trail).toBe(top);
    expect(Number.isFinite(trailBraking(Number.NaN, Number.NaN, Number.NaN))).toBe(true);
  });

  test(
    'solo flying lap: 0.3–1.2 % quicker for the best driver, no extra rear slip, no loss of control',
    () => {
      const config = soloConfig('silverstone', 'varga', 'qualifying', 0, 'soft');
      const withTrail = runSolo(config);
      const without = runSolo(config, (car) => {
        car.ai.trail = 0;
      });
      const gain = 1 - best(withTrail) / best(without);
      expect(gain).toBeGreaterThan(0.003);
      expect(gain).toBeLessThan(0.012);
      for (const r of [withTrail, without]) {
        expect(r.laps).toHaveLength(2);
        expect(r.maxRearSlip).toBeLessThan(0.08);
        expect(r.maxSideslip).toBeLessThan(0.15);
        expect(r.offRoad).toBe(0);
        expect(r.trackLimits).toBe(0);
      }
      expect(withTrail.maxRearSlip).toBeLessThanOrEqual(without.maxRearSlip + 0.005);
    },
    60_000,
  );
});

describe('A2 kerb use', () => {
  test('kerb-use line: reaches over the kerbs, never past them nor near the track-limit line', () => {
    const track = getLayout('silverstone');
    const n = track.count;
    let beyondOldEdge = 0;
    for (let i = 0; i < n; i++) {
      const s = track.s[i];
      const hw = track.halfWidth[i];
      const line = kerbLineAt(track, s, 1);
      const kerb = Math.min(KERB_REACH, line >= 0 ? track.kerbRight[i] : track.kerbLeft[i]);
      expect(Math.abs(line)).toBeLessThanOrEqual(hw - RACING_LINE_MARGIN + kerb + 1e-6);
      // track limits (src/race/limits.ts): the car centre stays inside halfWidth + half track − tyre half width − 0.25
      expect(Math.abs(line)).toBeLessThan(hw + 0.8 - 0.2 - 0.25);
      if (kerb > 0 && Math.abs(line) > hw - PATH_EDGE_MARGIN + 0.1) beyondOldEdge++;
      const reach = kerbReachAt(track, s, 0.5);
      expect(reach.left).toBeLessThanOrEqual(0.5 * KERB_REACH + 1e-6);
      expect(reach.right).toBeLessThanOrEqual(0.5 * KERB_REACH + 1e-6);
      if (track.kerbLeft[i] === 0 && track.kerbRight[i] === 0) expect(reach.left + reach.right).toBe(0);
    }
    expect(beyondOldEdge).toBeGreaterThan(20);
    // no kerb use = the plain racing line and its curvature
    for (const s of [0, 1234.5, track.length * 0.7]) {
      expect(kerbLineAt(track, s, 0)).toBe(sampleAt(track, track.racingLine, s));
      expect(lineCurvatureAt(track, s, 0)).toBe(lineCurvatureAt(track, s));
      expect(kerbReachAt(track, s, 0)).toEqual({ left: 0, right: 0 });
    }
    const cap = capability(spec, 1, 50, 0.95, 0.88);
    expect(targetSpeedAt(track, cap, 3000, 60, 1, 0, 0)).toBe(targetSpeedAt(track, cap, 3000, 60));
  });

  test('kerb skill: every driver uses some kerb, the technical ones more, all well short of the full reach', () => {
    const top = kerbSkill(90, varga.skill.pace, varga.skill.consistency);
    const low = kerbSkill(90, caldwell.skill.pace, caldwell.skill.consistency);
    expect(low).toBeGreaterThan(0.2);
    expect(top).toBeGreaterThan(low);
    expect(kerbSkill(110, 1, 1)).toBeLessThanOrEqual(0.6);
    expect(createAIState(varga, 90, 7).kerbSkill).toBe(top);
  });

  test(
    'solo lap: the car runs over the old path edge at kerbed corners, no track-limit warning, not slower',
    () => {
      const config = soloConfig('silverstone', 'varga', 'qualifying', 0, 'soft');
      const kerbs = runSolo(config, (car) => {
        car.ai.trail = 0;
      });
      const plain = runSolo(config, (car) => {
        car.ai.trail = 0;
        car.ai.kerbSkill = 0;
      });
      expect(kerbs.overEdgeOnKerb).toBeGreaterThan(plain.overEdgeOnKerb + 1);
      expect(kerbs.trackLimits).toBe(0);
      expect(kerbs.offRoad).toBe(0);
      expect(kerbs.maxRearSlip).toBeLessThan(0.08);
      expect(best(kerbs)).toBeLessThanOrEqual(best(plain));
    },
    60_000,
  );
});

describe('A3 pace modes', () => {
  test('push / conserve multipliers; a new brain runs standard', () => {
    expect(PACE_MODE_FACTOR.push).toBeCloseTo(1.012, 9);
    expect(PACE_MODE_FACTOR.standard).toBe(1);
    expect(PACE_MODE_FACTOR.conserve).toBeCloseTo(0.985, 9);
    expect(createAIState(varga, 90, 1).paceMode).toBe('standard');
  });

  test(
    'a stint: conserve wears the tyres clearly less and laps slower; push laps quicker and deploys the overtake mode',
    () => {
      const config = soloConfig('silverstone', 'marchand', 'race', 4, 'medium');
      // the mode held for the whole stint (in a race the strategy picks it lap by lap)
      const hold = (mode: AIPaceMode) => (car: CarEntry): void => {
        car.ai.paceMode = mode;
      };
      const run = (mode: AIPaceMode): SoloRun => runSolo(config, hold(mode), hold(mode));
      const standard = run('standard');
      const conserve = run('conserve');
      const push = run('push');
      // laps 2–4 (the first one starts from the grid)
      const pace = (r: SoloRun): number => mean(r.laps.slice(1));
      const stint = (r: SoloRun): number => r.wear - r.wearAfterLap1;
      for (const r of [standard, conserve, push]) {
        expect(r.laps).toHaveLength(4);
        expect(r.maxRearSlip).toBeLessThan(0.08);
        expect(r.offRoad).toBe(0);
      }
      expect(stint(conserve)).toBeLessThan(stint(standard) * 0.97);
      expect(pace(conserve)).toBeGreaterThan(pace(standard));
      expect(pace(conserve)).toBeLessThan(pace(standard) * 1.015);
      expect(pace(push)).toBeLessThan(pace(standard));
      expect(push.overtakeTime).toBeGreaterThan(5);
      expect(standard.overtakeTime).toBe(0);
    },
    60_000,
  );
});

describe('A5 wet differentiation', () => {
  test('wet pace, braking, technique and mistake factors widen with poor wet skill (dry: no effect)', () => {
    expect(wetPaceFactor(0.9, 0.84)).toBeCloseTo(1 - 0.9 * (0.04 + 0.7 * 0.16), 9);
    expect(wetPaceFactor(0, 0.84)).toBe(1);
    expect(wetPaceFactor(0.9, 0.95) - wetPaceFactor(0.9, 0.84)).toBeGreaterThan(0.06);
    expect(wetBrakeFactor(0, 0.8)).toBe(1);
    expect(wetBrakeFactor(0.9, 0.84)).toBeLessThan(wetBrakeFactor(0.9, 0.95));
    expect(wetTechnique(0, 0.84)).toBe(1);
    expect(wetTechnique(0.9, 0.84)).toBeLessThan(wetTechnique(0.9, 0.95));
    expect(wetTechnique(0.9, 0.95)).toBeLessThan(0.6);
    expect(wetMistakeFactor(0.9, 0.84)).toBeCloseTo(1 + 2 * 0.9 * 0.16, 9);
    expect(wetMistakeFactor(0, 0.5)).toBe(1);
  });
});

describe('A4 natural mistakes', () => {
  test('chance: consistency, difficulty, pressure, wetness and wet skill', () => {
    const ai = createAIState(driver('marchand'), 90, 3);
    const base = naturalMistakeChance(ai, 0);
    expect(base).toBeGreaterThan(0.002);
    expect(base).toBeLessThan(0.02);
    expect(naturalMistakeChance(ai, 0, 1.5)).toBeCloseTo(base * 1.5, 12);
    expect(naturalMistakeChance(ai, 0.9)).toBeGreaterThan(base * 2);
    expect(naturalMistakeChance({ ...ai, consistency: 1 }, 0.9)).toBe(0);
    expect(naturalMistakeChance({ ...ai, consistency: 0.95 }, 0)).toBeLessThan(base);
    expect(naturalMistakeChance({ ...ai, difficulty: 110 }, 0)).toBeLessThan(base);
    expect(naturalMistakeChance({ ...ai, wetSkill: 0.84 }, 0)).toBe(naturalMistakeChance({ ...ai, wetSkill: 0.95 }, 0));
  });

  test('fixed-seed statistics: in heavy rain a poor wet driver errs clearly more often than a good one', () => {
    const count = (wetSkill: number, wetness: number): number => {
      const ai = { ...createAIState(driver('marchand'), 90, 12345), wetSkill };
      let n = 0;
      for (let i = 0; i < 20000; i++) if (drawNaturalMistake(ai, naturalMistakeChance(ai, wetness)).kind !== 'none') n++;
      return n;
    };
    const poor = count(0.84, 0.9);
    const good = count(0.95, 0.9);
    expect(good).toBeGreaterThan(200);
    expect(poor).toBeGreaterThan(good * 1.15);
    expect(count(0.84, 0)).toBe(count(0.95, 0));
    expect(count(0.95, 0)).toBeLessThan(good);
    // both kinds occur, late braking more often
    const ai = createAIState(driver('marchand'), 90, 99);
    const kinds = { lateBrake: 0, earlyThrottle: 0, none: 0 };
    for (let i = 0; i < 4000; i++) kinds[drawNaturalMistake(ai, 0.2).kind]++;
    expect(kinds.lateBrake).toBeGreaterThan(kinds.earlyThrottle);
    expect(kinds.earlyThrottle).toBeGreaterThan(200);
  });

  interface RaceStats {
    world: WorldState;
    heavy: number;
    trackLimits: number;
    /** wall hits / off-road seconds of a car while its natural mistake plays out (and 2 s after) */
    mistakeWall: number;
    mistakeOffRoad: number;
    played: number;
  }

  function runRace(config: SessionConfig): RaceStats {
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const out: RaceStats = { world, heavy: 0, trackLimits: 0, mistakeWall: 0, mistakeOffRoad: 0, played: 0 };
    const until = world.cars.map(() => -1);
    while (!isSessionOver(world) && world.time < 1500) {
      stepWorld(world, track, [], SIM_DT);
      for (const c of world.cars) {
        if (c.ai.mistakeActive > 0) {
          if (until[c.id] < world.time - SIM_DT) out.played++;
          until[c.id] = world.time + 2;
        }
        const off = c.phys.surface !== 'asphalt' && c.phys.surface !== 'kerb' && c.phys.surface !== 'pitlane';
        if (until[c.id] >= world.time && off && c.pit.phase === 'none') out.mistakeOffRoad += SIM_DT;
      }
      for (const e of world.events) {
        if (e.type === 'collision') {
          if (e.otherCarId !== null && e.impulse > 5000) out.heavy++;
          if (e.otherCarId === null && until[e.carId] >= world.time) out.mistakeWall++;
        } else if (e.type === 'trackLimits') out.trackLimits++;
      }
      world.events.length = 0;
    }
    expect(isSessionOver(world)).toBe(true);
    expect(world.cars.every((c) => c.status === 'finished')).toBe(true);
    return out;
  }

  test(
    'headless races: mistakes happen (more in the rain), correct themselves, no more heavy contacts / track-limit warnings than before',
    () => {
      // single races are chaotic (one pile-up decides them): sums over seeds. Baseline before phase 2 (difficulty 90,
      // 5 laps): silverstone seeds 42 / 1 / 2 → 4 heavy contacts, 4 track-limit warnings; heavy rain at
      // highland-ridge seeds 42 / 2 → 10 heavy contacts, 2 warnings
      const dry = [42, 1, 2].map((seed) => runRace(raceConfig('silverstone', 'clear', seed)));
      const wet = [42, 2].map((seed) => runRace(raceConfig('highland-ridge', 'heavyRain', seed)));
      const sum = (rs: RaceStats[], f: (r: RaceStats) => number): number => rs.reduce((a, r) => a + f(r), 0);
      expect(sum(dry, (r) => r.heavy)).toBeLessThanOrEqual(4);
      expect(sum(dry, (r) => r.trackLimits)).toBeLessThanOrEqual(4);
      expect(sum(wet, (r) => r.heavy)).toBeLessThanOrEqual(10);
      expect(sum(wet, (r) => r.trackLimits)).toBeLessThanOrEqual(2);
      const rolled = (r: RaceStats): number => r.world.cars.reduce((a, c) => a + c.ai.mistakeCount, 0);
      expect(sum(dry, rolled)).toBeGreaterThan(10);
      expect(sum(dry, (r) => r.played)).toBeGreaterThan(10);
      // per car, lap (after the first) and corner
      const rate = (rs: RaceStats[]): number =>
        sum(rs, rolled) /
        sum(rs, (r) => r.world.cars.length * (r.world.session.totalLaps - 1) * getLayout(r.world.config.layoutId).corners.length);
      expect(rate(wet)).toBeGreaterThan(rate(dry) * 1.5);
      for (const r of [...dry, ...wet]) {
        expect(r.mistakeWall).toBe(0);
        expect(r.mistakeOffRoad).toBe(0);
      }
    },
    240_000,
  );
});
