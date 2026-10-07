/**
 * AI unit tests: brain creation (determinism, difficulty / skill mapping), capability-based speed planning
 * (corner speeds, look-ahead braking, off-line path curvature), steering sign convention, pit / weather strategy
 * helpers and the controller's behaviour on the grid.
 */
import { describe, expect, test } from 'bun:test';
import {
  SPEED_CAP,
  capability,
  chooseDryCompound,
  computeAIInput,
  cornerSpeed,
  createAIState,
  lookaheadDistance,
  neutralInput,
  paceParams,
  steerToward,
  targetSpeedAt,
  weatherCompound,
  wetPaceFactor,
} from '../src/ai/index';
import { offsetPathCurvature, lineData } from '../src/ai/profile';
import { createWorld, stepWorld } from '../src/race/index';
import { createCarSpec, maxCornerSpeed } from '../src/physics/index';
import { DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import type { SessionConfig } from '../src/core/types';

const varga = DRIVERS.find((d) => d.id === 'varga')!;
const caldwell = DRIVERS.find((d) => d.id === 'caldwell')!;
const spec = createCarSpec(TEAMS[0], DEFAULT_SETUP, '2025');

describe('createAIState', () => {
  test('deterministic per seed, plain data, finite', () => {
    const a = createAIState(varga, 90, 1234);
    const b = createAIState(varga, 90, 1234);
    expect(a).toEqual(b);
    expect(structuredClone(a)).toEqual(a);
    for (const [k, v] of Object.entries(a)) {
      if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
    }
    expect(a.mode).toBe('race');
    expect(a.skill).toBeGreaterThan(0.8);
    expect(a.skill).toBeLessThanOrEqual(1);
    const c = createAIState(varga, 90, 4321);
    expect(c.aggression === a.aggression && c.reaction === a.reaction).toBe(false);
  });

  test('difficulty and driver pace raise the share of the car used', () => {
    const easy = createAIState(varga, 0, 1);
    const mid = createAIState(varga, 90, 1);
    const hard = createAIState(varga, 110, 1);
    expect(easy.latFactor).toBeLessThan(mid.latFactor);
    expect(mid.latFactor).toBeLessThan(hard.latFactor);
    expect(easy.brakeFactor).toBeLessThan(hard.brakeFactor);
    expect(easy.performance).toBeLessThan(hard.performance);
    expect(hard.latFactor).toBeLessThanOrEqual(1);
    expect(createAIState(caldwell, 90, 1).latFactor).toBeLessThan(mid.latFactor);
    const clamped = createAIState(varga, Number.NaN, Number.NaN);
    expect(Number.isFinite(clamped.latFactor)).toBe(true);
    expect(paceParams(500, 0.9).latFactor).toBe(paceParams(110, 0.9).latFactor);
  });

  test('wet skill matters in the wet only', () => {
    expect(wetPaceFactor(0, 0.5)).toBe(1);
    expect(wetPaceFactor(0.9, 0.95)).toBeGreaterThan(wetPaceFactor(0.9, 0.8));
    expect(wetPaceFactor(0.9, 0.95)).toBeLessThan(1);
  });
});

describe('speed planning', () => {
  test('corner speed from the capability model tracks the physics corner limit', () => {
    const cap = capability(spec, 1, 50, 1, 1);
    for (const radius of [20, 50, 100, 150]) {
      const mine = cornerSpeed(cap, 1 / radius);
      // physics caps at MAX_CORNER_SPEED (120 m/s), the planner at SPEED_CAP (100 m/s)
      const physics = Math.min(SPEED_CAP, maxCornerSpeed(spec, 1 / radius));
      expect(Math.abs(mine / physics - 1)).toBeLessThan(0.03);
    }
    expect(cornerSpeed(cap, 0)).toBe(SPEED_CAP);
    expect(cornerSpeed(cap, 1 / 20)).toBeLessThan(cornerSpeed(cap, 1 / 60));
    const careful = capability(spec, 1, 50, 0.8, 0.8);
    expect(cornerSpeed(careful, 1 / 50)).toBeLessThan(cornerSpeed(cap, 1 / 50));
  });

  test('look-ahead braking: slower approaching a slow corner, finite everywhere', () => {
    const track = getLayout('mirage-sands');
    const cap = capability(spec, 1, 50, 0.95, 0.88);
    const slowest = [...track.corners].sort((a, b) => a.minSpeed - b.minSpeed)[0];
    const atApex = targetSpeedAt(track, cap, slowest.apexS, 30);
    const before = targetSpeedAt(track, cap, slowest.apexS - 150, 80);
    const further = targetSpeedAt(track, cap, slowest.apexS - 400, 80);
    expect(atApex).toBeLessThan(before);
    expect(before).toBeLessThanOrEqual(further + 1e-9);
    expect(atApex).toBeGreaterThan(10);
    expect(atApex).toBeLessThan(45);
    for (const s of [Number.NaN, -50, 0, track.length - 1, track.length * 3.5]) {
      const v = targetSpeedAt(track, cap, s, 50);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(Number.isFinite(targetSpeedAt(track, cap, 100, Number.POSITIVE_INFINITY))).toBe(true);
  });

  test('an off-line path pinned to the road edge is tighter than the racing line', () => {
    const track = getLayout('porto-lumen');
    const line = lineData(track);
    let i = 0;
    for (let k = 0; k < track.count; k++) if (Math.abs(line.curv[k]) > Math.abs(line.curv[i])) i = k;
    const inside = Math.sign(line.curv[i]) * 6;
    expect(Math.abs(offsetPathCurvature(track, i, 0) - line.curv[i])).toBeLessThan(Math.abs(line.curv[i]) * 0.35);
    expect(Math.abs(offsetPathCurvature(track, i, inside))).toBeGreaterThan(Math.abs(line.curv[i]));
    const cap = capability(spec, 1, 50, 0.95, 0.88);
    expect(targetSpeedAt(track, cap, track.s[i], 30, 1, inside)).toBeLessThan(targetSpeedAt(track, cap, track.s[i], 30, 1, 0));
  });
});

describe('strategy helpers', () => {
  test('weather crossover thresholds with hysteresis', () => {
    expect(weatherCompound('soft', 0.2)).toBeNull();
    expect(weatherCompound('medium', 0.4)).toBe('inter');
    expect(weatherCompound('hard', 0.8)).toBe('wet');
    expect(weatherCompound('inter', 0.5)).toBeNull();
    expect(weatherCompound('inter', 0.75)).toBe('wet');
    expect(weatherCompound('inter', 0.1)).toBe('dry');
    expect(weatherCompound('wet', 0.6)).toBeNull();
    expect(weatherCompound('wet', 0.4)).toBe('inter');
    expect(weatherCompound('wet', 0.1)).toBe('dry');
  });

  test('dry compound choice by remaining distance and mandatory exclusion', () => {
    const track = getLayout('highland-ridge');
    const cfg: SessionConfig = {
      mode: 'grandPrix', kind: 'race', layoutId: track.id, laps: 30, timeLimit: null, qualifyingLaps: 0, weather: 'clear',
      dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
      grid: [{ driverId: 'varga', teamId: 'vanta', playerIndex: -1, startCompound: 'medium' }], teams: TEAMS, drivers: DRIVERS,
      rules: { ...DEFAULT_RULES, safetyCar: 'off' }, seed: 1, ghost: null, objective: null,
    };
    const car = createWorld(cfg, track).cars[0];
    expect(chooseDryCompound(car, track, 2)).toBe('soft');
    expect(chooseDryCompound(car, track, 25)).toBe('hard');
    expect(chooseDryCompound(car, track, 2, ['soft'])).toBe('medium');
    expect(chooseDryCompound(car, track, 2, ['soft', 'medium', 'hard'])).toBe('soft');
  });
});

describe('controller', () => {
  test('neutral input, look-ahead and steering sign (+ = right)', () => {
    expect(neutralInput()).toEqual({
      throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false, drsPressed: false, ersCycle: false, limiterToggle: false, overtakeHeld: false,
    });
    expect(lookaheadDistance(0)).toBeGreaterThanOrEqual(8);
    expect(lookaheadDistance(90)).toBeGreaterThan(lookaheadDistance(30));
    const track = getLayout('mirage-sands');
    const cfg: SessionConfig = {
      mode: 'grandPrix', kind: 'practice', layoutId: track.id, laps: 1, timeLimit: 600, qualifyingLaps: 0, weather: 'clear',
      dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
      grid: [{ driverId: 'varga', teamId: 'vanta', playerIndex: -1, startCompound: 'soft' }], teams: TEAMS, drivers: DRIVERS,
      rules: { ...DEFAULT_RULES, safetyCar: 'off' }, seed: 1, ghost: null, objective: null,
    };
    const world = createWorld(cfg, track);
    const car = world.cars[0];
    const right = steerToward(car, track, car.phys.lateral + 5, 30);
    const left = steerToward(car, track, car.phys.lateral - 5, 30);
    expect(right).toBeGreaterThan(0);
    expect(left).toBeLessThan(0);
    const input = computeAIInput(world, car, track, SIM_DT);
    expect(input.throttle).toBeGreaterThan(0);
    for (const v of [input.throttle, input.brake, input.steer]) expect(Number.isFinite(v)).toBe(true);
  });

  test('revs on the grid during the lights, waits its reaction time, then launches', () => {
    const track = getLayout('isola-verde');
    const cfg: SessionConfig = {
      mode: 'grandPrix', kind: 'race', layoutId: track.id, laps: 1, timeLimit: null, qualifyingLaps: 0, weather: 'clear',
      dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
      grid: [{ driverId: 'varga', teamId: 'vanta', playerIndex: -1, startCompound: 'soft' }], teams: TEAMS, drivers: DRIVERS,
      rules: { ...DEFAULT_RULES, safetyCar: 'off' }, seed: 1, ghost: null, objective: null,
    };
    const world = createWorld(cfg, track);
    const car = world.cars[0];
    while (world.session.phase !== 'lights') stepWorld(world, track, [], SIM_DT);
    for (let i = 0; i < 120; i++) stepWorld(world, track, [], SIM_DT);
    expect(car.phys.speed).toBe(0);
    expect(car.phys.rpm).toBeGreaterThan(car.spec.idleRpm + 1000);
    while (world.session.phase === 'lights') stepWorld(world, track, [], SIM_DT);
    const outAt = world.time;
    while (car.phys.speed < 0.5 && world.time < outAt + 2) stepWorld(world, track, [], SIM_DT);
    const reaction = world.time - outAt;
    expect(reaction).toBeGreaterThanOrEqual(car.ai.reaction - 2 * SIM_DT);
    expect(reaction).toBeLessThan(1.2);
    for (let i = 0; i < 240; i++) stepWorld(world, track, [], SIM_DT);
    expect(car.phys.speed).toBeGreaterThan(15);
    expect(car.phys.gear).toBeGreaterThanOrEqual(1);
    expect(car.status).toBe('running');
  });
});
