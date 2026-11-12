/**
 * Endurance race in the menus' model: the Grand Prix preference (old saves load as standard, the default 40 minutes),
 * the quick race and the session config it builds, a sprint weekend (the format is the main race's for both formats,
 * the sprint stays standard), the longest race against the lap caps, and the profile statistics counting an endurance
 * race as any race.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETUP } from '../src/core/defaults';
import type { ResultRow, SessionResult } from '../src/core/types';
import { LAYOUTS, getLayout } from '../src/data/tracks/index';
import { emptyStats, updateStats } from '../src/meta/achievements';
import { DEFAULT_ENDURANCE_DURATION, ENDURANCE_DURATIONS } from '../src/meta/options';
import { defaultProfile, sanitizeProfile } from '../src/meta/prefs';
import { quickRacePlan } from '../src/meta/quickRace';
import { builtinRoster } from '../src/meta/roster';
import { buildSessionConfig, requestForKind, requestFromConfig, validateSessionConfig } from '../src/meta/sessionBuilder';
import { plannedLaps } from '../src/race/endurance';
import { createWorld } from '../src/race/index';

const setup = () => ({ ...DEFAULT_SETUP });

describe('Grand Prix preference', () => {
  test('a save from before the format loads as a standard race and the default 40 minutes', () => {
    const old = JSON.parse(JSON.stringify(defaultProfile())) as { gp: Record<string, unknown> };
    delete old.gp.raceFormat;
    delete old.gp.enduranceDuration;
    const loaded = sanitizeProfile(old);
    expect(loaded.gp.raceFormat).toBe('standard');
    expect(loaded.gp.enduranceDuration).toBe(DEFAULT_ENDURANCE_DURATION);
    expect(DEFAULT_ENDURANCE_DURATION).toBe(40);
    expect(ENDURANCE_DURATIONS).toEqual([20, 40, 60, 90]);
  });

  test('a saved endurance choice is kept; an unknown duration falls back', () => {
    const p = defaultProfile();
    Object.assign(p.gp, { raceFormat: 'endurance', enduranceDuration: 90 });
    expect(sanitizeProfile(JSON.parse(JSON.stringify(p))).gp).toMatchObject({ raceFormat: 'endurance', enduranceDuration: 90 });
    Object.assign(p.gp, { enduranceDuration: 45 });
    expect(sanitizeProfile(JSON.parse(JSON.stringify(p))).gp).toMatchObject({ raceFormat: 'endurance', enduranceDuration: DEFAULT_ENDURANCE_DURATION });
  });
});

describe('quick race and session building', () => {
  test('an endurance choice builds a valid endurance race, the same rebuilt from its config', () => {
    const profile = defaultProfile();
    Object.assign(profile.gp, { raceFormat: 'endurance', enduranceDuration: 60 });
    const plan = quickRacePlan(profile, builtinRoster(), setup, 42)!;
    const config = buildSessionConfig(plan.request);
    expect(validateSessionConfig(config)).toEqual([]);
    expect(config.raceFormat).toEqual({ kind: 'endurance', duration: 3600 });
    expect(buildSessionConfig(requestFromConfig(config)).raceFormat).toEqual(config.raceFormat);
  });

  for (const raceFormat of ['elimination', 'endurance'] as const) {
    test(`a sprint weekend (${raceFormat}): the sprint is a standard race, the main race has the format`, () => {
      const profile = defaultProfile();
      Object.assign(profile.gp, { raceFormat, format: 'sprint' });
      const base = quickRacePlan(profile, builtinRoster(), setup, 5)!.ctx.plan!.request;
      const sprint = buildSessionConfig(requestForKind(base, 'sprint', null));
      expect(sprint.sprint).toBe(true);
      expect('raceFormat' in sprint).toBe(false);
      expect(validateSessionConfig(sprint)).toEqual([]);
      expect(buildSessionConfig(requestForKind(base, 'race', null)).raceFormat?.kind).toBe(raceFormat);
      expect(validateSessionConfig({ ...sprint, raceFormat: { kind: 'endurance', duration: 1200 } })).toContain('race format on a sprint');
    });
  }

  test('the longest race (90 min) on the quickest lap stays well inside the lap caps (200 a request, 500 a world)', () => {
    const quickest = LAYOUTS.filter((l) => !l.reverse)
      .map((l) => getLayout(l.id))
      .reduce((a, b) => (b.referenceLapTime < a.referenceLapTime ? b : a));
    const laps = plannedLaps({ kind: 'endurance', duration: 90 * 60 }, quickest);
    expect(laps).toBeLessThan(120);
    const profile = defaultProfile();
    Object.assign(profile.gp, { raceFormat: 'endurance', enduranceDuration: 90, layoutId: quickest.id });
    const config = buildSessionConfig(quickRacePlan(profile, builtinRoster(), setup, 1)!.request);
    expect(createWorld(config, quickest).session.totalLaps).toBe(laps);
  });
});

describe('statistics', () => {
  test('an endurance race counts as any race: a finish, a podium, a win', () => {
    const row: ResultRow = {
      carId: 0,
      driverId: 'me',
      teamId: 't',
      playerIndex: 0,
      position: 1,
      gridPosition: 4,
      lapsCompleted: 27,
      time: 2433.4,
      gapText: '40:33.400',
      bestLap: 86.2,
      pitStops: 2,
      penaltySec: 0,
      points: 25,
      fastestLap: false,
      status: 'finished',
    };
    const result: SessionResult = { kind: 'race', mode: 'grandPrix', layoutId: 'monza', rows: [row], fastestLap: null, weather: 'clear', objectiveMet: null };
    expect(updateStats(emptyStats(), result)).toMatchObject({ racesFinished: 1, podiums: 1, wins: 1 });
  });
});
