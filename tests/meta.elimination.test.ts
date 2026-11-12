/**
 * Elimination race in the menus' model: the Grand Prix preference (old saves load as standard), the quick race and
 * the session config it builds (the format on race sessions only, a standard race built exactly as before), and the
 * profile statistics counting an eliminated player at its place.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETUP } from '../src/core/defaults';
import type { ResultRow, SessionResult } from '../src/core/types';
import { emptyStats, evaluateAchievements, updateStats } from '../src/meta/achievements';
import { DEFAULT_ELIMINATION_INTERVAL } from '../src/meta/options';
import { defaultProfile, sanitizeProfile } from '../src/meta/prefs';
import { quickRacePlan } from '../src/meta/quickRace';
import { builtinRoster } from '../src/meta/roster';
import { buildSessionConfig, requestForKind, requestFromConfig, validateSessionConfig } from '../src/meta/sessionBuilder';
import { START_SETTLE } from '../src/race/elimination';

const setup = () => ({ ...DEFAULT_SETUP });

describe('Grand Prix preference', () => {
  test('a save from before the format loads as a standard race with the default interval', () => {
    const old = JSON.parse(JSON.stringify(defaultProfile())) as { gp: Record<string, unknown> };
    delete old.gp.raceFormat;
    delete old.gp.eliminationInterval;
    const loaded = sanitizeProfile(old);
    expect(loaded.gp.raceFormat).toBe('standard');
    expect(loaded.gp.eliminationInterval).toBe(DEFAULT_ELIMINATION_INTERVAL);
  });

  test('a saved elimination choice is kept; an unknown format or interval falls back', () => {
    const p = defaultProfile();
    Object.assign(p.gp, { raceFormat: 'elimination', eliminationInterval: 90 });
    expect(sanitizeProfile(JSON.parse(JSON.stringify(p))).gp).toMatchObject({ raceFormat: 'elimination', eliminationInterval: 90 });
    Object.assign(p.gp, { raceFormat: 'marathon', eliminationInterval: 37 });
    expect(sanitizeProfile(JSON.parse(JSON.stringify(p))).gp).toMatchObject({ raceFormat: 'standard', eliminationInterval: DEFAULT_ELIMINATION_INTERVAL });
  });
});

describe('quick race and session building', () => {
  test('a standard choice builds the race exactly as before: no format anywhere', () => {
    const plan = quickRacePlan(defaultProfile(), builtinRoster(), setup, 42)!;
    expect('raceFormat' in plan.request).toBe(false);
    expect('raceFormat' in buildSessionConfig(plan.request)).toBe(false);
  });

  test('an elimination choice builds a valid elimination race; its grace covers the start', () => {
    const profile = defaultProfile();
    Object.assign(profile.gp, { raceFormat: 'elimination', eliminationInterval: 60 });
    const plan = quickRacePlan(profile, builtinRoster(), setup, 42)!;
    const config = buildSessionConfig(plan.request);
    expect(validateSessionConfig(config)).toEqual([]);
    expect(config.raceFormat).toEqual({ kind: 'elimination', interval: 60, grace: 60 + START_SETTLE });
    // rebuilt from the config (no weekend plan carried): the same format
    expect(buildSessionConfig(requestFromConfig(config)).raceFormat).toEqual(config.raceFormat);
  });

  test('a weekend with qualifying: the format applies to the race only', () => {
    const profile = defaultProfile();
    Object.assign(profile.gp, { raceFormat: 'elimination' });
    const base = quickRacePlan(profile, builtinRoster(), setup, 5)!.ctx.plan!.request;
    const quali = buildSessionConfig(requestForKind(base, 'qualifying', null));
    expect(quali.raceFormat).toBeUndefined();
    expect(validateSessionConfig(quali)).toEqual([]);
    expect(buildSessionConfig(requestForKind(base, 'race', null)).raceFormat?.kind).toBe('elimination');
    expect(validateSessionConfig({ ...quali, raceFormat: { kind: 'elimination', interval: 45, grace: 65 } })).toContain('race format on a non-race session');
  });
});

describe('statistics and achievements', () => {
  const row = (patch: Partial<ResultRow>): ResultRow => ({
    carId: 0,
    driverId: 'me',
    teamId: 't',
    playerIndex: 0,
    position: 3,
    gridPosition: 15,
    lapsCompleted: 6,
    time: null,
    gapText: '淘汰',
    bestLap: 80,
    pitStops: 0,
    penaltySec: 0,
    points: 15,
    fastestLap: false,
    status: 'retired',
    ...patch,
  });
  const result = (r: ResultRow): SessionResult => ({ kind: 'race', mode: 'grandPrix', layoutId: 'monza', rows: [r], fastestLap: null, weather: 'clear', objectiveMet: null });

  test('eliminated third counts as a race finished and a podium; a DNF does not', () => {
    const out = updateStats(emptyStats(), result(row({ eliminated: true })));
    expect(out).toMatchObject({ racesFinished: 1, podiums: 1, wins: 0 });
    const dnf = updateStats(emptyStats(), result(row({ gapText: '退賽' })));
    expect(dnf).toMatchObject({ racesFinished: 0, podiums: 0 });
    const ids = evaluateAchievements({ result: result(row({ eliminated: true })), trackLimitWarnings: 0, beatGhost: false, storyComplete: false, rdMaxed: false, champion: false, stats: out });
    expect(ids).toContain('firstPodium');
    expect(ids).toContain('comeback');
  });
});
