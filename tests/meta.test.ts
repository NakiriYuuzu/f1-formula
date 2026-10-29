/**
 * Meta layer tests (pure logic only — no DOM): session building for every mode/kind, qualifying classification,
 * career / My Team progression, persistence fallbacks & corruption handling, story objectives, achievements.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ResultRow, SessionConfig, SessionKind, SessionResult } from '../src/core/types';
import { ASSIST_PRESETS, COMPOUNDS, DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETTINGS, DEFAULT_SETUP, POINTS_TABLE, STORAGE_PREFIX } from '../src/core/defaults';
import { TEAMS } from '../src/data/teams';
import {
  applyCareerQualifying,
  sanitizeHeadToHead,
  applyCareerRace,
  careerRequest,
  careerRoster,
  createCareer,
  isSeasonComplete,
  sanitizeCareer,
  startCareerProject,
  startNextCareerSeason,
  updateRating,
  INITIAL_RATING,
} from '../src/meta/career';
import {
  aiDevelopmentBudget,
  CAR_PARTS,
  careerRoundPoints,
  developmentFromRd,
  developmentGains,
  PART_COST_MONEY,
  PART_COST_POINTS,
  PART_MAX_LEVEL,
  rolloverDevelopment,
  totalLevel,
} from '../src/meta/development';
import {
  applyMyTeamRace,
  createMyTeam,
  departmentRating,
  myTeamDef,
  myTeamDevelopment,
  myTeamRequest,
  myTeamRating,
  myTeamRoster,
  POWER_UNITS,
  sanitizeMyTeam,
  startMyTeamProject,
  startNextMyTeamSeason,
  type MyTeamDraft,
  type MyTeamSave,
} from '../src/meta/myTeam';
import { detectAssistPreset, listLayouts, resolveLaps, weekendSessions, type LayoutMeta } from '../src/meta/options';
import { sanitizeAssists } from '../src/meta/guards';
import { applyProgress, withQualifyingPositions } from '../src/meta/progression';
import { MY_TEAM_ID, PLAYER_DRIVER_ID, standardRoster, type PlayerIdentity } from '../src/meta/roster';
import {
  KEY_ACTIONS,
  loadAchievements,
  loadCareer,
  loadGhost,
  loadMyTeam,
  loadProfile,
  loadSettings,
  loadSetup,
  loadStory,
  loadTimeTrialRecords,
  saveCareer,
  saveGhost,
  saveMyTeam,
  saveSettings,
  saveSetup,
} from '../src/meta/save';
import { createCalendar, DEFAULT_SEASON_SETTINGS, driverStandings, pointsForRow, recordRace, SEASON_ROUNDS, teamStandings } from '../src/meta/season';
import {
  buildQuickStart,
  buildSessionConfig,
  classifyQualifying,
  MAX_SPLIT_AI,
  requestForKind,
  requestFromConfig,
  validateSessionConfig,
  type QuickKind,
  type SessionRequest,
} from '../src/meta/sessionBuilder';
import { MemoryStore, setStore, storageKey, type KeyValueStore } from '../src/meta/storage';
import { useFictionalRoster } from './rosterFixture';
import {
  evaluateObjective,
  isChapterUnlocked,
  isStoryComplete,
  recordStoryAttempt,
  resolveObjective,
  STORY_CHALLENGES,
  STORY_CHAPTERS,
  storyRequest,
  emptyStoryProgress,
} from '../src/meta/story';
import { evaluateAchievements, emptyStats, updateStats } from '../src/meta/achievements';
import { addLapRecord, personalBest } from '../src/meta/timeTrial';

// ───────────────────────────── fixtures ─────────────────────────────

const LAYOUT: LayoutMeta = {
  id: 'test-loop',
  defId: 'test-loop',
  reverse: false,
  displayName: '測試環線',
  circuitName: '測試環線',
  location: '測試',
  country: '測試國',
  biome: 'temperate',
  timeOfDay: 'dusk',
  street: false,
  fullLaps: 60,
  description: '',
};

const SYNTH_LAYOUTS = ['a', 'b', 'c', 'd', 'e'].flatMap((id) => [
  { id, defId: id, reverse: false },
  { id: `${id}-rev`, defId: id, reverse: true },
]);

const IDENTITY: PlayerIdentity = {
  firstName: 'Test',
  lastName: 'Driver',
  abbr: 'TDR',
  number: 2,
  nationality: 'TWN',
  helmet: { primary: '#ff0000', secondary: '#00ff00', accent: '#0000ff' },
};

function gpRequest(kind: SessionKind, patch: Partial<SessionRequest> = {}): SessionRequest {
  return {
    mode: 'grandPrix',
    kind,
    layoutId: LAYOUT.id,
    raceLaps: 5,
    weather: 'clear',
    timeOfDay: 'auto',
    regulation: '2025',
    aiDifficulty: 90,
    qualifying: 'oneShot',
    rules: { ...DEFAULT_RULES },
    seed: 12345,
    players: [{ playerIndex: 0, driverId: 'hsu', teamId: 'nordlys', setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS }, startCompound: null }],
    roster: standardRoster(),
    aiCount: null,
    gridOrder: null,
    playerStartPosition: null,
    ghost: null,
    objective: null,
    ...patch,
  };
}

/** Structural validity shared by every config. */
function expectValid(config: SessionConfig): void {
  expect(validateSessionConfig(config)).toEqual([]);
  const numbers = config.drivers.map((d) => d.number);
  expect(new Set(numbers).size).toBe(numbers.length);
  for (const g of config.grid) {
    expect(config.drivers.some((d) => d.id === g.driverId)).toBe(true);
    expect(config.teams.some((t) => t.id === g.teamId)).toBe(true);
    expect(COMPOUNDS).toContain(g.startCompound);
  }
  for (const p of config.players) {
    expect(config.grid.find((g) => g.driverId === p.driverId)?.playerIndex).toBe(p.playerIndex);
  }
  expect(config.laps).toBeGreaterThanOrEqual(1);
  expect(Number.isInteger(config.seed)).toBe(true);
  // plain data (WorldState requirement)
  expect(structuredClone(config)).toEqual(config);
}

/** Race result where the grid order is the finishing order. */
function fakeRaceResult(config: SessionConfig, opts: { order?: string[]; weather?: SessionResult['weather']; retired?: string[] } = {}): SessionResult {
  const order = opts.order ?? config.grid.map((g) => g.driverId);
  const rows: ResultRow[] = order.map((driverId, i) => {
    const g = config.grid.find((x) => x.driverId === driverId);
    const retired = opts.retired?.includes(driverId) ?? false;
    return {
      carId: config.grid.findIndex((x) => x.driverId === driverId),
      driverId,
      teamId: g?.teamId ?? '',
      playerIndex: g?.playerIndex ?? -1,
      position: i + 1,
      gridPosition: config.grid.findIndex((x) => x.driverId === driverId) + 1,
      lapsCompleted: config.laps,
      time: 300 + i,
      gapText: i === 0 ? '' : `+${i}.000`,
      bestLap: 90 + i * 0.1,
      pitStops: 1,
      penaltySec: 0,
      points: retired ? 0 : (POINTS_TABLE[i] ?? 0),
      fastestLap: i === 0,
      status: retired ? 'retired' : 'finished',
    };
  });
  return {
    kind: 'race',
    mode: config.mode,
    layoutId: config.layoutId,
    rows,
    fastestLap: { carId: rows[0]?.carId ?? 0, time: 90, lap: 2 },
    weather: opts.weather ?? config.weather,
    objectiveMet: null,
  };
}

function singleRowResult(kind: SessionKind, mode: SessionResult['mode'], row: Partial<ResultRow>): SessionResult {
  return {
    kind,
    mode,
    layoutId: LAYOUT.id,
    rows: [
      {
        carId: 0,
        driverId: 'player',
        teamId: 'corvid',
        playerIndex: 0,
        position: 1,
        gridPosition: 1,
        lapsCompleted: 3,
        time: 95,
        gapText: '',
        bestLap: 95,
        pitStops: 0,
        penaltySec: 0,
        points: 0,
        fastestLap: false,
        status: 'finished',
        ...row,
      },
    ],
    fastestLap: null,
    weather: 'clear',
    objectiveMet: null,
  };
}

beforeEach(() => {
  setStore(new MemoryStore());
  useFictionalRoster();
});

// ───────────────────────────── session building ─────────────────────────────

describe('sessionBuilder', () => {
  test('grand prix race: full 20-car field, player present, timing consistent', () => {
    const config = buildSessionConfig(gpRequest('race'), LAYOUT);
    expectValid(config);
    expect(config.grid.length).toBe(20);
    expect(config.players).toHaveLength(1);
    expect(config.grid.filter((g) => g.playerIndex === 0).map((g) => g.driverId)).toEqual(['hsu']);
    expect(config.timeLimit).toBeNull();
    expect(config.qualifyingLaps).toBe(0);
    expect(config.timeOfDay).toBe('dusk'); // layout default
    expect(config.laps).toBe(5);
  });

  test('practice / qualifying run the whole field (player first); time trial is solo; time limits per SPEC', () => {
    const practice = buildSessionConfig(gpRequest('practice'), LAYOUT);
    expectValid(practice);
    expect(practice.grid).toHaveLength(20);
    expect(practice.grid[0]?.driverId).toBe('hsu');
    expect(practice.grid.filter((g) => g.playerIndex === -1)).toHaveLength(19);
    expect(practice.timeLimit).toBe(15 * 60);

    const oneShot = buildSessionConfig(gpRequest('qualifying'), LAYOUT);
    expectValid(oneShot);
    expect(oneShot.grid).toHaveLength(20);
    expect(oneShot.qualifyingLaps).toBe(1);
    expect(oneShot.timeLimit).toBeGreaterThan(0);

    const short = buildSessionConfig(gpRequest('qualifying', { qualifying: 'short' }), LAYOUT);
    expect(short.qualifyingLaps).toBe(3);
    expect(short.timeLimit ?? 0).toBeGreaterThan(oneShot.timeLimit ?? 0);

    const tt = buildSessionConfig(gpRequest('timeTrial', { mode: 'timeTrial', weather: 'heavyRain' }), LAYOUT);
    expectValid(tt);
    expect(tt.grid.map((g) => g.driverId)).toEqual(['hsu']);
    expect(tt.timeLimit).toBeNull();
    expect(tt.weather).toBe('clear');
    expect(tt.rules.tyreWear).toBe(false);
    expect(tt.rules.fuel).toBe(false);
    expect(tt.rules.collisions).toBe(false);
  });

  test('time trial ghost only kept for the same layout', () => {
    const ghost = { layoutId: LAYOUT.id, lapTime: 88, driverId: 'hsu', teamId: 'nordlys', dt: 0.1, samples: [0, 0, 0, 0, 1, 0, 1, 0] };
    expect(buildSessionConfig(gpRequest('timeTrial', { mode: 'timeTrial', ghost }), LAYOUT).ghost).toEqual(ghost);
    expect(buildSessionConfig(gpRequest('timeTrial', { mode: 'timeTrial', ghost: { ...ghost, layoutId: 'other' } }), LAYOUT).ghost).toBeNull();
    expect(buildSessionConfig(gpRequest('race', { ghost }), LAYOUT).ghost).toBeNull();
  });

  test('wet weather start compounds and dynamic weather', () => {
    const wet = buildSessionConfig(gpRequest('race', { weather: 'heavyRain' }), LAYOUT);
    expect(wet.grid.every((g) => g.startCompound === 'wet')).toBe(true);
    const light = buildSessionConfig(gpRequest('race', { weather: 'lightRain' }), LAYOUT);
    expect(light.grid.every((g) => g.startCompound === 'inter')).toBe(true);
    const dyn = buildSessionConfig(gpRequest('race', { weather: 'dynamic' }), LAYOUT);
    expect(dyn.dynamicWeather).toBe(true);
    expect(dyn.weather).toBe('overcast');
    const chosen = buildSessionConfig(
      gpRequest('race', { players: [{ ...gpRequest('race').players[0]!, startCompound: 'hard' }] }),
      LAYOUT,
    );
    expect(chosen.grid.find((g) => g.playerIndex === 0)?.startCompound).toBe('hard');
  });

  test('race grid follows qualifying order; without it, seeded rating order is deterministic', () => {
    const order = [...standardRoster().drivers.map((d) => d.id)].reverse();
    const config = buildSessionConfig(gpRequest('race', { gridOrder: order }), LAYOUT);
    expect(config.grid.map((g) => g.driverId)).toEqual(order);

    const a = buildSessionConfig(gpRequest('race', { seed: 7 }), LAYOUT).grid.map((g) => g.driverId);
    const b = buildSessionConfig(gpRequest('race', { seed: 7 }), LAYOUT).grid.map((g) => g.driverId);
    expect(a).toEqual(b);
    // strongest team should generally start near the front
    const vantaIndex = a.findIndex((id) => id === 'varga');
    expect(vantaIndex).toBeLessThan(8);
  });

  test('story start position places player 0', () => {
    const config = buildSessionConfig(gpRequest('race', { playerStartPosition: 18 }), LAYOUT);
    expect(config.grid.findIndex((g) => g.playerIndex === 0)).toBe(17);
    const clamped = buildSessionConfig(gpRequest('race', { playerStartPosition: 99 }), LAYOUT);
    expect(clamped.grid[clamped.grid.length - 1]?.playerIndex).toBe(0);
  });

  test('split-screen: P1 + P2 + AI count (0..MAX_SPLIT_AI = the 18 free seats of the field)', () => {
    const base = gpRequest('race', {
      mode: 'splitScreen',
      players: [
        { playerIndex: 0, driverId: 'hsu', teamId: 'nordlys', setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS }, startCompound: null },
        { playerIndex: 1, driverId: 'varga', teamId: 'vanta', setup: { ...DEFAULT_SETUP }, assists: { ...ASSIST_PRESETS.beginner }, startCompound: null },
      ],
    });
    for (const [count, expected] of [
      [0, 2],
      [6, 8],
      [MAX_SPLIT_AI, 20],
      [20, 20],
    ] as const) {
      const config = buildSessionConfig({ ...base, aiCount: count }, LAYOUT);
      expectValid(config);
      expect(config.grid).toHaveLength(expected);
      expect(config.players.map((p) => p.playerIndex)).toEqual([0, 1]);
      expect(config.grid.filter((g) => g.playerIndex >= 0)).toHaveLength(2);
    }
  });

  test('split-screen with the same driver twice keeps players distinct', () => {
    const p = gpRequest('race').players[0]!;
    const config = buildSessionConfig(gpRequest('race', { mode: 'splitScreen', aiCount: 2, players: [p, { ...p, playerIndex: 1 }] }), LAYOUT);
    expectValid(config);
    expect(new Set(config.players.map((x) => x.driverId)).size).toBe(2);
  });

  test('unknown driver / empty players fall back to a valid player 0', () => {
    const config = buildSessionConfig(gpRequest('race', { players: [] }), LAYOUT);
    expectValid(config);
    expect(config.players[0]?.playerIndex).toBe(0);
    const ghostDriver = buildSessionConfig(
      gpRequest('race', { players: [{ ...gpRequest('race').players[0]!, driverId: 'nobody', teamId: 'aurora' }] }),
      LAYOUT,
    );
    expectValid(ghostDriver);
    expect(ghostDriver.players[0]?.teamId).toBe('aurora');
  });

  test('car numbers are made unique (player keeps theirs)', () => {
    const career = createCareer({ ...IDENTITY, number: 8 }, 'corvid', DEFAULT_SEASON_SETTINGS, 1, SYNTH_LAYOUTS);
    const req = careerRequest(career, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null);
    expect(req).not.toBeNull();
    const config = buildSessionConfig({ ...req!, layoutId: LAYOUT.id }, LAYOUT);
    expectValid(config);
    expect(config.drivers.find((d) => d.id === PLAYER_DRIVER_ID)?.number).toBe(8);
    expect(config.drivers.find((d) => d.id === 'varga')?.number).not.toBe(8);
  });

  test('laps from distance percentage', () => {
    expect(resolveLaps('l3', 67)).toBe(3);
    expect(resolveLaps('l10', 67)).toBe(10);
    expect(resolveLaps('p25', 67)).toBe(17);
    expect(resolveLaps('p50', 67)).toBe(34);
    expect(resolveLaps('p100', 67)).toBe(67);
    expect(resolveLaps('p25', Number.NaN)).toBeGreaterThanOrEqual(1);
  });

  test('weekend formats and next-session requests', () => {
    expect(weekendSessions('raceOnly')).toEqual(['race']);
    expect(weekendSessions('qualiRace')).toEqual(['qualifying', 'race']);
    expect(weekendSessions('full')).toEqual(['practice', 'qualifying', 'race']);
    const order = ['varga', 'hsu'];
    const next = requestForKind(gpRequest('qualifying'), 'race', order);
    expect(next.kind).toBe('race');
    expect(next.gridOrder).toEqual(order);
    expect(requestForKind(gpRequest('race'), 'qualifying', order).gridOrder).toBeNull();
  });

  test('requestFromConfig rebuilds an equivalent session', () => {
    const config = buildSessionConfig(gpRequest('qualifying', { weather: 'dynamic', qualifying: 'short' }), LAYOUT);
    const req = requestFromConfig(config);
    expect(req.weather).toBe('dynamic');
    expect(req.qualifying).toBe('short');
    const race = buildSessionConfig(requestForKind(req, 'race', null), LAYOUT);
    expectValid(race);
    expect(race.grid).toHaveLength(20);
  });

  test('every quick-start kind builds a valid config with the real registry', () => {
    if (listLayouts().length === 0) throw new Error('track registry is empty');
    const kinds: QuickKind[] = ['race', 'quali', 'practice', 'tt', 'split'];
    for (const kind of kinds) {
      const { config, ctx } = buildQuickStart({ kind, layoutId: 'koyo-hills-rev', laps: 4, weather: 'lightRain', regulation: '2026', seed: 99 });
      expectValid(config);
      expect(config.layoutId).toBe('koyo-hills-rev');
      expect(config.regulation).toBe('2026');
      expect(ctx.plan?.request.raceLaps).toBe(4);
      if (kind === 'quali') expect(ctx.weekendQueue).toEqual(['race']);
      if (kind === 'split') expect(config.players).toHaveLength(2);
      if (kind === 'tt') expect(config.weather).toBe('clear');
    }
    const fallback = buildQuickStart({ kind: 'race', layoutId: 'does-not-exist', laps: Number.NaN, weather: 'snow', regulation: 'x' });
    expectValid(fallback.config);
    expect(fallback.config.laps).toBe(3);
    expect(fallback.config.weather).toBe('clear');
  });
});

describe('qualifying classification', () => {
  test('merges player times with simulated AI times; no-time drivers last', () => {
    const roster = standardRoster();
    const result: SessionResult = {
      ...singleRowResult('qualifying', 'grandPrix', { driverId: 'hsu', teamId: 'nordlys', time: 85.5, bestLap: 85.5 }),
    };
    const simulated: Record<string, number> = {};
    roster.drivers.forEach((d, i) => {
      if (d.id !== 'hsu' && d.id !== 'caldwell') simulated[d.id] = 85 + i * 0.1;
    });
    const entries = classifyQualifying(result, simulated, roster);
    expect(entries).toHaveLength(20);
    expect(entries[entries.length - 1]?.driverId).toBe('caldwell');
    const times = entries.map((e) => e.time).filter((t): t is number => t !== null);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(entries.find((e) => e.driverId === 'hsu')?.simulated).toBe(false);
  });
});

// ───────────────────────────── career & My Team ─────────────────────────────

describe('career', () => {
  test('roster: player replaces the second driver; calendar = 5 forward + 5 reverse', () => {
    const career = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 42, SYNTH_LAYOUTS);
    const { roster, replacedId } = careerRoster(career);
    expect(replacedId).toBe('okafor');
    expect(roster.drivers.some((d) => d.id === 'okafor')).toBe(false);
    expect(roster.teams.find((t) => t.id === 'kestrel')?.driverIds).toEqual(['bellandi', PLAYER_DRIVER_ID]);
    expect(career.calendar).toHaveLength(SEASON_ROUNDS);
    expect(career.calendar.filter((r) => r.layoutId.endsWith('-rev'))).toHaveLength(5);
    expect(new Set(career.calendar.map((r) => r.layoutId)).size).toBe(10);
    for (let i = 1; i < career.calendar.length; i++) {
      expect(career.calendar[i]?.layoutId.replace('-rev', '')).not.toBe(career.calendar[i - 1]?.layoutId.replace('-rev', ''));
    }
  });

  test('every career session kind builds a valid 20-car config', () => {
    const career = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 42, SYNTH_LAYOUTS);
    for (const kind of ['practice', 'qualifying', 'race'] as const) {
      const req = careerRequest(career, kind, 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!;
      const config = buildSessionConfig(req, LAYOUT);
      expectValid(config);
      expect(config.mode).toBe('career');
      expect(config.players[0]?.driverId).toBe(PLAYER_DRIVER_ID);
      expect(config.drivers.some((d) => d.id === 'okafor')).toBe(false);
      expect(config.grid).toHaveLength(20);
    }
  });

  test('points accumulate for every driver and team; season completes after 10 rounds', () => {
    let career = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 42, SYNTH_LAYOUTS);
    const req = careerRequest(career, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!;
    const config = buildSessionConfig(req, LAYOUT);
    const order = [PLAYER_DRIVER_ID, ...config.grid.map((g) => g.driverId).filter((id) => id !== PLAYER_DRIVER_ID)];
    const first = applyCareerRace(career, fakeRaceResult(config, { order }), 0);
    career = first.save;
    expect(career.results).toHaveLength(1);
    let drivers = driverStandings(career.results, careerRoster(career).roster.drivers.map((d) => d.id));
    expect(drivers[0]?.id).toBe(PLAYER_DRIVER_ID);
    expect(drivers[0]?.points).toBe(25);
    expect(drivers.reduce((acc, s) => acc + s.points, 0)).toBe(POINTS_TABLE.reduce((a, b) => a + b, 0));
    expect(career.teammate.raceAhead).toBe(1);
    expect(career.rating.pace).toBeGreaterThan(INITIAL_RATING.pace);

    for (let round = 1; round < SEASON_ROUNDS; round++) {
      const upd = applyCareerRace(career, fakeRaceResult(config, { order }), 0);
      career = upd.save;
      if (round < SEASON_ROUNDS - 1) expect(upd.summary).toBeNull();
      else {
        expect(upd.summary?.driverPosition).toBe(1);
        expect(upd.summary?.points).toBe(250);
      }
    }
    expect(isSeasonComplete(career)).toBe(true);
    expect(career.history).toHaveLength(1);
    drivers = driverStandings(career.results, careerRoster(career).roster.drivers.map((d) => d.id));
    expect(drivers[0]?.points).toBe(250);
    const teams = teamStandings(career.results, TEAMS.map((t) => t.id));
    expect(teams.reduce((acc, s) => acc + s.points, 0)).toBe(POINTS_TABLE.reduce((a, b) => a + b, 0) * SEASON_ROUNDS);
    expect(careerRequest(career, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)).toBeNull();

    const next = startNextCareerSeason(career, 7, SYNTH_LAYOUTS);
    expect(next.season).toBe(2);
    expect(next.results).toHaveLength(0);
    expect(next.history).toHaveLength(1);
  });

  test('qualifying head-to-head and rating bounds', () => {
    const career = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 42, SYNTH_LAYOUTS);
    expect(applyCareerQualifying(career, ['bellandi', PLAYER_DRIVER_ID]).teammate.qualiBehind).toBe(1);
    expect(applyCareerQualifying(career, [PLAYER_DRIVER_ID, 'bellandi']).teammate.qualiAhead).toBe(1);
    // re-running the same round's qualifying replaces its count instead of adding another
    const twice = applyCareerQualifying(applyCareerQualifying(career, ['bellandi', PLAYER_DRIVER_ID]), [PLAYER_DRIVER_ID, 'bellandi']);
    expect(twice.teammate.qualiAhead + twice.teammate.qualiBehind).toBe(1);
    expect(twice.teammate.qualiAhead).toBe(1);
    expect(sanitizeHeadToHead(JSON.parse(JSON.stringify(twice.teammate)))).toEqual(twice.teammate);
    let r = { ...INITIAL_RATING };
    for (let i = 0; i < 200; i++) r = updateRating(r, { position: 1, grid: 20, expected: 20, wet: true, penaltySec: 0, trackLimitWarnings: 0 });
    expect(Math.max(r.pace, r.racecraft, r.wet, r.awareness, r.consistency)).toBeLessThanOrEqual(99);
    for (let i = 0; i < 400; i++) r = updateRating(r, { position: null, grid: 1, expected: 1, wet: false, penaltySec: 10, trackLimitWarnings: 5 });
    expect(Math.min(r.pace, r.racecraft, r.wet, r.awareness, r.consistency)).toBeGreaterThanOrEqual(40);
  });

  test('rating growth measures the result against the developed field (expected position with part development)', () => {
    const career = createCareer(IDENTITY, 'corvid', DEFAULT_SEASON_SETTINGS, 42, SYNTH_LAYOUTS);
    const config = buildSessionConfig(careerRequest(career, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    const others = config.grid.map((g) => g.driverId).filter((id) => id !== PLAYER_DRIVER_ID);
    const p10 = fakeRaceResult(config, { order: [...others.slice(0, 9), PLAYER_DRIVER_ID, ...others.slice(9)] });
    const full = developmentFromRd({ aero: 5, power: 5, chassis: 5, reliability: 5 });
    const developed = { ...career, development: { ...career.development, teams: { ...career.development.teams, corvid: full } } };
    // P10 beats the slowest car's expectation (P19.5) but trails a fully developed corvid's (P1.5)
    expect(applyCareerRace(career, p10, 0).save.rating.pace).toBeGreaterThan(INITIAL_RATING.pace);
    expect(applyCareerRace(developed, p10, 0).save.rating.pace).toBeLessThan(INITIAL_RATING.pace);
  });

  test('R&D points per round pay for the team projects; every team develops; saved and carried into the next season', () => {
    let career = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 42, SYNTH_LAYOUTS);
    expect(career.rdPoints).toBe(0);
    expect(Object.keys(career.development.teams)).toEqual(TEAMS.map((t) => t.id));
    expect(Object.values(career.development.teams).every((t) => totalLevel(t) === 0)).toBe(true);
    expect(startCareerProject(career, 'floor')).toBeNull();
    const config = buildSessionConfig(careerRequest(career, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    expect(config.development).toEqual(developmentGains(career.development));
    const others = config.grid.map((g) => g.driverId).filter((id) => id !== PLAYER_DRIVER_ID && id !== 'bellandi');
    // P1 ahead of the team-mate: kestrel leads the constructors (leader budget 35.7) × (0.85 + 0.25 + 0.05)
    const win = applyCareerRace(career, fakeRaceResult(config, { order: [PLAYER_DRIVER_ID, 'bellandi', ...others] }), 0);
    expect(win.save.rdPoints).toBe(careerRoundPoints({ teamRank0: 0, teamCount: TEAMS.length, position: 1, fieldSize: 20, aheadOfTeammate: true }));
    expect(win.save.rdPoints).toBe(41);
    // retired behind the team-mate: 0.85 × the budget of kestrel's constructor place after the race
    const rank0 = (save: typeof career): number => teamStandings(save.results, TEAMS.map((t) => t.id)).findIndex((t) => t.id === 'kestrel');
    const dnf = applyCareerRace(career, fakeRaceResult(config, { order: ['bellandi', ...others, PLAYER_DRIVER_ID], retired: [PLAYER_DRIVER_ID] }), 0);
    expect(dnf.save.rdPoints).toBe(Math.round(aiDevelopmentBudget(rank0(dnf.save), TEAMS.length) * 0.85));
    // the same last place in a team at the back of the constructors earns more (like the AI budgets)
    const tail = applyCareerRace(career, fakeRaceResult(config, { order: [...others, 'bellandi', PLAYER_DRIVER_ID] }), 0);
    expect(rank0(tail.save)).toBe(TEAMS.length - 1);
    expect(tail.save.rdPoints).toBe(Math.round(aiDevelopmentBudget(TEAMS.length - 1, TEAMS.length) * 0.85));
    expect(tail.save.rdPoints).toBeGreaterThan(dnf.save.rdPoints);
    // AI teams banked their budget and started projects; the player's team waits for the player
    career = win.save;
    expect(career.development.teams.kestrel!.projects).toEqual([]);
    expect(career.development.teams.kestrel!.bank).toBe(0);
    for (const t of TEAMS.filter((x) => x.id !== 'kestrel')) expect(career.development.teams[t.id]!.projects).toHaveLength(1);
    expect(career.development.report).toEqual([]);
    // the player's projects cost R&D points
    career = startCareerProject(career, 'frontWing')!;
    expect(career.rdPoints).toBe(41 - PART_COST_POINTS[0]!);
    expect(career.development.teams.kestrel!.projects.map((q) => q.part)).toEqual(['frontWing']);
    expect(startCareerProject(career, 'frontWing')).toBeNull();
    expect(startCareerProject({ ...career, rdPoints: PART_COST_POINTS[0]! - 1 }, 'floor')).toBeNull();
    career = { ...career, rdPoints: 100 };
    career = startCareerProject(career, 'floor')!;
    expect(career.rdPoints).toBe(70);
    expect(startCareerProject(career, 'ers')).toBeNull();
    // saved and loaded unchanged
    saveCareer(career);
    expect(loadCareer()?.development).toEqual(career.development);
    expect(loadCareer()?.rdPoints).toBe(70);
    // the next race completes both level-1 projects (and the AI teams' ones)
    const next = applyCareerRace(career, fakeRaceResult(config, { order: [PLAYER_DRIVER_ID, 'bellandi', ...others] }), 0).save;
    const kestrel = next.development.teams.kestrel!;
    expect(kestrel.projects).toEqual([]);
    expect(kestrel.parts.frontWing.level).toBe(1);
    expect(kestrel.parts.floor.level).toBe(1);
    expect(next.development.report.filter((l) => l.teamId === 'kestrel').map((l) => l.part).sort()).toEqual(['floor', 'frontWing']);
    expect(next.development.report.length).toBe(TEAMS.length + 1);
    const nextConfig = buildSessionConfig(careerRequest(next, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    expect(nextConfig.development).toEqual(developmentGains(next.development));
    expect(nextConfig.development?.kestrel?.frontWing).toBeGreaterThan(0);
    // next season: points carry over; every part of every team drops a level (rule changes), the report starts empty
    const season2 = startNextCareerSeason(next, 9, SYNTH_LAYOUTS);
    expect(season2.development).toEqual(rolloverDevelopment(next.development, ['kestrel']));
    expect(season2.development.teams.kestrel!.parts.frontWing).toEqual({ level: 0, gain: 0 });
    expect(season2.development.report).toEqual([]);
    expect(season2.rdPoints).toBe(next.rdPoints);
    // a project still running at the rollover (here started after the last race) aims at the cheaper new level and
    // refunds the difference: the same as starting it in the new season
    const floor4 = { ...next, rdPoints: PART_COST_POINTS[4]! };
    floor4.development = { ...next.development, teams: { ...next.development.teams, kestrel: { ...next.development.teams.kestrel!, parts: { ...next.development.teams.kestrel!.parts, floor: { level: 4, gain: 4 } } } } };
    const late = startNextCareerSeason(startCareerProject(floor4, 'floor')!, 9, SYNTH_LAYOUTS);
    const waited = startCareerProject(startNextCareerSeason(floor4, 9, SYNTH_LAYOUTS), 'floor')!;
    expect(late.rdPoints).toBe(PART_COST_POINTS[4]! - PART_COST_POINTS[3]!);
    expect(late.rdPoints).toBe(waited.rdPoints);
    expect(late.development.teams.kestrel).toEqual(waited.development.teams.kestrel);
  });

  test('sprint position adds R&D points; old saves start with zero development and points', () => {
    const settings = { ...DEFAULT_SEASON_SETTINGS, sprintWeekends: true };
    const career = createCareer(IDENTITY, 'kestrel', settings, 42, SYNTH_LAYOUTS);
    const config = buildSessionConfig(careerRequest(career, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    const others = config.grid.map((g) => g.driverId).filter((id) => id !== PLAYER_DRIVER_ID && id !== 'bellandi');
    const sprintOrder = ['bellandi', ...others.slice(0, 2), PLAYER_DRIVER_ID, ...others.slice(2)];
    const withSprint = { ...career, pendingSprint: { round: 0, entries: recordRace(fakeRaceResult(config, { order: sprintOrder })).classification } };
    const order = [...others.slice(0, 9), PLAYER_DRIVER_ID, 'bellandi', ...others.slice(9)];
    const upd = applyCareerRace(withSprint, fakeRaceResult(config, { order }), 0);
    const rank0 = teamStandings(upd.save.results, TEAMS.map((t) => t.id)).findIndex((t) => t.id === 'kestrel');
    expect(upd.save.rdPoints).toBe(
      careerRoundPoints({ teamRank0: rank0, teamCount: TEAMS.length, position: 10, fieldSize: 20, aheadOfTeammate: true, sprintPosition: 4 }),
    );
    expect(upd.save.rdPoints).toBe(Math.round(aiDevelopmentBudget(rank0, TEAMS.length) * (0.85 + 0.25 * (10 / 19) + 0.05 + 0.05 * (16 / 19))));
    // the sprint P4 adds 0.05 · 16 / 19 of the team budget (at the same constructor place)
    expect(upd.save.rdPoints).toBeGreaterThan(
      careerRoundPoints({ teamRank0: rank0, teamCount: TEAMS.length, position: 10, fieldSize: 20, aheadOfTeammate: true }),
    );

    const { development: _d, rdPoints: _p, ...old } = career;
    const back = sanitizeCareer(JSON.parse(JSON.stringify(old)), SYNTH_LAYOUTS)!;
    expect(back.rdPoints).toBe(0);
    expect(back.development).toEqual(career.development);
    const broken = sanitizeCareer({ ...JSON.parse(JSON.stringify(career)), rdPoints: -5, development: { teams: { ghost: {} } } }, SYNTH_LAYOUTS)!;
    expect(broken.rdPoints).toBe(0);
    expect(Object.keys(broken.development.teams)).toEqual(TEAMS.map((t) => t.id));
  });

  test('points fallback uses POINTS_TABLE for invalid runtime points', () => {
    const config = buildSessionConfig(gpRequest('race'), LAYOUT);
    const result = fakeRaceResult(config, { retired: [config.grid[19]!.driverId] });
    const row = { ...result.rows[2]!, points: Number.NaN };
    expect(pointsForRow(row)).toBe(15);
    expect(pointsForRow({ ...row, status: 'retired' })).toBe(0);
    const rec = recordRace(result);
    expect(rec.classification).toHaveLength(20);
    expect(rec.fastestLapDriverId).toBe(result.rows[0]!.driverId);
  });
});

describe('my team', () => {
  const draft: MyTeamDraft = {
    name: 'Nova Works',
    shortName: 'NVW',
    livery: { primary: '#ff5a1f', secondary: '#111111', accent: '#ffffff', pattern: 'stripe' },
    powerUnit: 'Helion',
    identity: IDENTITY,
    teammateId: 'ishikawa',
    settings: DEFAULT_SEASON_SETTINGS,
  };

  test('11th team with 22 cars, valid configs for race and qualifying', () => {
    const team = createMyTeam(draft, 3, SYNTH_LAYOUTS);
    const roster = myTeamRoster(team);
    expect(roster.teams).toHaveLength(11);
    expect(roster.drivers).toHaveLength(22);
    expect(myTeamDef(team).driverIds).toEqual([PLAYER_DRIVER_ID, 'ishikawa']);
    const race = buildSessionConfig(myTeamRequest(team, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    expectValid(race);
    expect(race.grid).toHaveLength(22);
    expect(race.grid.filter((g) => g.teamId === MY_TEAM_ID)).toHaveLength(2);
    const quali = buildSessionConfig(myTeamRequest(team, 'qualifying', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    expectValid(quali);
    expect(quali.teams.some((t) => t.id === MY_TEAM_ID)).toBe(true);
  });

  test('R&D projects cost money and project slots; the team rating grows with the average part gain', () => {
    let team = { ...createMyTeam(draft, 3, SYNTH_LAYOUTS), budget: 10 };
    const rating = myTeamDef(team).rating;
    expect(rating).toEqual({ aero: 0.86, power: 0.94, chassis: 0.86, reliability: 0.94 });
    expect(Object.keys(team.development.teams)).toEqual([...TEAMS.map((t) => t.id), MY_TEAM_ID]);
    expect(Object.values(team.development.teams).every((t) => totalLevel(t) === 0)).toBe(true);
    team = startMyTeamProject(team, 'frontWing')!;
    expect(team.budget).toBe(10 - PART_COST_MONEY[0]!);
    expect(myTeamDevelopment(team).projects).toEqual([{ part: 'frontWing', level: 1, roundsLeft: 1, rounds: 1, chance: 0.95 }]);
    expect(startMyTeamProject(team, 'frontWing')).toBeNull();
    team = startMyTeamProject(team, 'powerUnit')!;
    expect(team.budget).toBe(8);
    // both project slots are taken
    expect(startMyTeamProject(team, 'floor')).toBeNull();
    // unaffordable
    expect(startMyTeamProject({ ...createMyTeam(draft, 3, SYNTH_LAYOUTS), budget: 0.9 }, 'floor')).toBeNull();
    // later levels cost more; a maxed part cannot be developed
    const developed = createMyTeam(draft, 3, SYNTH_LAYOUTS);
    developed.development.teams[MY_TEAM_ID]!.parts.floor = { level: 3, gain: 2.5 };
    developed.development.teams[MY_TEAM_ID]!.parts.weight = { level: PART_MAX_LEVEL, gain: PART_MAX_LEVEL };
    expect(startMyTeamProject({ ...developed, budget: 10 }, 'floor')?.budget).toBe(10 - PART_COST_MONEY[3]!);
    expect(startMyTeamProject({ ...developed, budget: 10 }, 'weight')).toBeNull();
    // projects only running: the rating is unchanged; achieved gains raise it by department average
    // (aero = front wing / rear wing / floor, power = power unit / ERS / gearbox, chassis = suspension / brakes / weight)
    expect(myTeamDef(team).rating).toEqual(rating);
    expect(myTeamDef(developed).rating).toEqual({
      aero: departmentRating('Helion', 'aero', 2.5 / 3),
      power: 0.94,
      chassis: departmentRating('Helion', 'chassis', 5 / 3),
      reliability: 0.94,
    });
    expect(myTeamDef(developed).rating.aero).toBeCloseTo(0.86 + 0.13 * (2.5 / 15), 4);
    expect(myTeamDef(developed).rating.chassis).toBeCloseTo(0.86 + 0.13 * (5 / 15), 4);
    // fully developed: every department at the 0.99 cap
    const full = createMyTeam(draft, 3, SYNTH_LAYOUTS);
    for (const p of CAR_PARTS) full.development.teams[MY_TEAM_ID]!.parts[p] = { level: 5, gain: 5 };
    expect(myTeamDef(full).rating).toEqual({ aero: 0.99, power: 0.99, chassis: 0.99, reliability: 0.99 });
    // AI development never touches My Team's rating
    const rivals = createMyTeam(draft, 3, SYNTH_LAYOUTS);
    rivals.development.teams.vanta = full.development.teams[MY_TEAM_ID]!;
    expect(myTeamDef(rivals).rating).toEqual(rating);
  });

  test('development reaches the session config of My Team and every AI team', () => {
    let team = { ...createMyTeam(draft, 3, SYNTH_LAYOUTS), budget: 100 };
    team = startMyTeamProject(team, 'frontWing')!;
    const config = buildSessionConfig(myTeamRequest(team, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    expectValid(config);
    expect(Object.keys(config.development ?? {}).sort()).toEqual(config.teams.map((t) => t.id).sort());
    expect(Object.values(config.development ?? {}).every((g) => Object.keys(g).length === 0)).toBe(true);
    const order = [PLAYER_DRIVER_ID, ...config.grid.map((g) => g.driverId).filter((id) => id !== PLAYER_DRIVER_ID)];
    let save = applyMyTeamRace(team, fakeRaceResult(config, { order })).save;
    for (let round = 1; round < 4; round++) save = applyMyTeamRace(save, fakeRaceResult(config, { order })).save;
    const quali = buildSessionConfig(myTeamRequest(save, 'qualifying', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    expect(quali.development).toEqual(developmentGains(save.development));
    expect(quali.development?.[MY_TEAM_ID]?.frontWing).toBeGreaterThan(0);
    // AI teams developed on their own budget
    for (const t of TEAMS) expect(Object.keys(quali.development?.[t.id] ?? {}).length).toBeGreaterThan(0);
  });

  test('development advances after each race (seeded), is saved and carries into the next season', () => {
    let team = { ...createMyTeam(draft, 3, SYNTH_LAYOUTS), budget: 100 };
    team = startMyTeamProject(startMyTeamProject(team, 'frontWing')!, 'floor')!;
    const config = buildSessionConfig(myTeamRequest(team, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    const order = [PLAYER_DRIVER_ID, ...config.grid.map((g) => g.driverId).filter((id) => id !== PLAYER_DRIVER_ID)];
    const result = fakeRaceResult(config, { order });
    const upd = applyMyTeamRace(team, result);
    const mine = myTeamDevelopment(upd.save);
    expect(mine.projects).toEqual([]);
    expect(mine.bank).toBe(0);
    for (const part of ['frontWing', 'floor'] as const) {
      expect(mine.parts[part].level).toBe(1);
      expect([0.5, 1]).toContain(mine.parts[part].gain);
    }
    expect(CAR_PARTS.filter((p) => mine.parts[p].level > 0)).toEqual(['frontWing', 'floor']);
    expect(upd.save.development.report.map((l) => `${l.teamId}:${l.part}`).sort()).toEqual([`${MY_TEAM_ID}:floor`, `${MY_TEAM_ID}:frontWing`]);
    // AI teams started a project with their first budget; it completes at a later round
    for (const t of TEAMS) expect(upd.save.development.teams[t.id]!.projects).toHaveLength(1);
    // deterministic: the same round gives the same development
    expect(applyMyTeamRace(team, result).save.development).toEqual(upd.save.development);
    // persisted
    saveMyTeam(upd.save);
    expect(loadMyTeam()?.development).toEqual(upd.save.development);
    // the next round completes the AI projects
    const second = applyMyTeamRace(upd.save, result).save;
    expect(second.development.report.filter((l) => l.teamId !== MY_TEAM_ID)).toHaveLength(TEAMS.length);
    // next season: every team's parts drop a level (rule changes); the report starts empty
    const next = startNextMyTeamSeason(second, 7, SYNTH_LAYOUTS);
    expect(next.development).toEqual(rolloverDevelopment(second.development, [MY_TEAM_ID]));
    expect(myTeamDevelopment(next).parts.frontWing).toEqual({ level: 0, gain: 0 });
    expect(next.development.report).toEqual([]);
    expect(next.lastIncome.map((l) => l.label)).toEqual(['車隊錦標獎金', '動力單元與車手合約']);
    // a project still running at the rollover aims at the cheaper new level and refunds the difference
    const floor4: MyTeamSave = { ...second, budget: 10 };
    floor4.development = { ...second.development, teams: { ...second.development.teams, [MY_TEAM_ID]: { ...myTeamDevelopment(second), parts: { ...myTeamDevelopment(second).parts, floor: { level: 4, gain: 4 } } } } };
    const late = startNextMyTeamSeason(startMyTeamProject(floor4, 'floor')!, 7, SYNTH_LAYOUTS);
    const waited = startMyTeamProject(startNextMyTeamSeason(floor4, 7, SYNTH_LAYOUTS), 'floor')!;
    expect(late.budget).toBe(waited.budget);
    expect(myTeamDevelopment(late)).toEqual(myTeamDevelopment(waited));
    expect(late.lastIncome.at(-1)).toEqual({ label: '研發專案降級退費', amount: 0.7 });
  });

  test('a save from before part-level R&D migrates its department levels onto parts', () => {
    const current = createMyTeam(draft, 3, SYNTH_LAYOUTS);
    const { development: _d, ...rest } = current;
    const legacy = JSON.parse(JSON.stringify({ ...rest, rd: { aero: 2, power: 5, chassis: 1, reliability: 3 } }));
    const migrated = sanitizeMyTeam(legacy, SYNTH_LAYOUTS)!;
    expect('rd' in migrated).toBe(false);
    const mine = myTeamDevelopment(migrated);
    const levels = Object.fromEntries(CAR_PARTS.map((p) => [p, mine.parts[p].level]));
    expect(levels).toEqual({ frontWing: 2, rearWing: 2, floor: 2, suspension: 1, powerUnit: 5, ers: 5, gearbox: 5, brakes: 1, weight: 1, reliability: 3 });
    expect(CAR_PARTS.every((p) => mine.parts[p].gain === mine.parts[p].level)).toBe(true);
    expect(mine.projects).toEqual([]);
    for (const t of TEAMS) expect(totalLevel(migrated.development.teams[t.id]!)).toBe(0);
    // the same rating as the old departments (Helion 0.94 / 0.94, cap 0.99): aero 2, power 5, chassis 1, reliability 3
    expect(myTeamDef(migrated).rating).toEqual({ aero: 0.912, power: 0.99, chassis: 0.886, reliability: 0.97 });
    const config = buildSessionConfig(myTeamRequest(migrated, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    expect(config.development?.[MY_TEAM_ID]).toEqual(levels);
    // a stored development wins over a stray legacy field and survives the round trip
    const stored = sanitizeMyTeam(JSON.parse(JSON.stringify({ ...migrated, rd: { aero: 0, power: 0, chassis: 0, reliability: 0 } })), SYNTH_LAYOUTS)!;
    expect(stored.development).toEqual(migrated.development);
  });

  test('every legacy department combination migrates to the old department rating, for every power unit', () => {
    // the department formula before part-level R&D (git HEAD myTeam.ts): base + (max(base, 0.99) − base) · L / 5
    const old = (base: number, level: number): number => Math.round((base + (Math.max(base, 0.99) - base) * (level / 5)) * 10000) / 10000;
    for (const pu of POWER_UNITS) {
      for (let aero = 0; aero <= 5; aero++) {
        for (let power = 0; power <= 5; power++) {
          for (let chassis = 0; chassis <= 5; chassis++) {
            for (let reliability = 0; reliability <= 5; reliability++) {
              const development = { teams: { [MY_TEAM_ID]: developmentFromRd({ aero, power, chassis, reliability }) }, report: [] };
              expect(myTeamRating({ powerUnit: pu.id, development })).toEqual({
                aero: old(0.86, aero),
                power: old(pu.power, power),
                chassis: old(0.86, chassis),
                reliability: old(pu.reliability, reliability),
              });
            }
          }
        }
      }
    }
  });

  test('race income adds budget and records the round', () => {
    const team = createMyTeam(draft, 3, SYNTH_LAYOUTS);
    const config = buildSessionConfig(myTeamRequest(team, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    const order = [PLAYER_DRIVER_ID, ...config.grid.map((g) => g.driverId).filter((id) => id !== PLAYER_DRIVER_ID)];
    const upd = applyMyTeamRace(team, fakeRaceResult(config, { order }));
    expect(upd.save.results).toHaveLength(1);
    expect(upd.save.budget).toBeGreaterThan(team.budget);
    expect(upd.save.lastIncome.length).toBeGreaterThan(0);
  });

  test('sanitizer rejects garbage and repairs fields', () => {
    expect(sanitizeMyTeam('nope', SYNTH_LAYOUTS)).toBeNull();
    expect(sanitizeMyTeam({ shortName: 'bad' }, SYNTH_LAYOUTS)).toBeNull();
    const repaired = sanitizeMyTeam({ shortName: 'ABC', rd: { aero: 99, power: -3 }, budget: 'x', calendar: 5 }, SYNTH_LAYOUTS)!;
    expect(myTeamDevelopment(repaired).parts.frontWing).toEqual({ level: PART_MAX_LEVEL, gain: PART_MAX_LEVEL });
    expect(myTeamDevelopment(repaired).parts.powerUnit).toEqual({ level: 0, gain: 0 });
    expect(Object.keys(repaired.development.teams)).toEqual([...TEAMS.map((t) => t.id), MY_TEAM_ID]);
    expect(Number.isFinite(repaired.budget)).toBe(true);
    expect(repaired.calendar).toHaveLength(SEASON_ROUNDS);
  });
});

// ───────────────────────────── persistence ─────────────────────────────

describe('save', () => {
  test('defaults when nothing is stored; round-trip; keys use STORAGE_PREFIX', () => {
    const store = new MemoryStore();
    setStore(store);
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    s.keyBindings.throttle.push('KeyZ');
    expect(DEFAULT_SETTINGS.keyBindings.throttle).not.toContain('KeyZ'); // defaults never aliased
    saveSettings({ ...s, fov: 80, units: 'mph' });
    const back = loadSettings();
    expect(back.fov).toBe(80);
    expect(back.units).toBe('mph');
    expect(storageKey('settings').startsWith(STORAGE_PREFIX)).toBe(true);
    expect(store.getItem(storageKey('settings'))).not.toBeNull();
  });

  test('car setups per layout: split-screen P2 has its own entry and starts from P1\'s', () => {
    setStore(new MemoryStore());
    expect(loadSetup('porto-lumen', 1)).toEqual(DEFAULT_SETUP);
    saveSetup('porto-lumen', { ...DEFAULT_SETUP, rearWing: 10 });
    expect(loadSetup('porto-lumen', 1).rearWing).toBe(10);
    saveSetup('porto-lumen', { ...DEFAULT_SETUP, rearWing: 50 }, 1);
    expect(loadSetup('porto-lumen').rearWing).toBe(10);
    expect(loadSetup('porto-lumen', 1).rearWing).toBe(50);
  });

  test('corrupt JSON, wrong schema and invalid fields fall back to defaults', () => {
    const store = new MemoryStore();
    setStore(store);
    store.setItem(storageKey('settings'), '{not json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    store.setItem(storageKey('settings'), JSON.stringify({ schema: 999, data: { fov: 70 } }));
    expect(loadSettings().fov).toBe(DEFAULT_SETTINGS.fov);
    store.setItem(
      storageKey('settings'),
      JSON.stringify({ schema: 1, data: { fov: 9999, quality: 'insane', masterVolume: Number.NaN, keyBindings: { throttle: 'KeyW', brake: ['KeyK'] }, hud: null } }),
    );
    const s = loadSettings();
    expect(s.fov).toBe(90);
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
    expect(s.keyBindings.throttle).toEqual(DEFAULT_SETTINGS.keyBindings.throttle);
    expect(s.keyBindings.brake).toEqual(['KeyK']);
    expect(Object.keys(s.keyBindings).sort()).toEqual([...KEY_ACTIONS].sort());
    expect(s.hud).toEqual(DEFAULT_SETTINGS.hud);
    store.setItem(storageKey('career'), JSON.stringify({ schema: 1, data: { teamId: 'not-a-team' } }));
    expect(loadCareer()).toBeNull();
    store.setItem(storageKey('story'), 'null');
    expect(loadStory()).toEqual(emptyStoryProgress());
    store.setItem(storageKey('profile'), JSON.stringify({ schema: 1, data: { gp: { laps: 'p999', aiDifficulty: 500 } } }));
    const profile = loadProfile();
    expect(profile.gp.laps).toBe('l5');
    expect(profile.gp.aiDifficulty).toBe(110);
  });

  test('a throwing store never throws and keeps values for the session', () => {
    const failing: KeyValueStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    setStore(failing);
    expect(() => saveSettings({ ...DEFAULT_SETTINGS, fov: 77 })).not.toThrow();
    expect(loadSettings().fov).toBe(77);
    expect(() => saveCareer(null)).not.toThrow();
    expect(loadAchievements()).toEqual({ unlocked: {} });
  });

  test('career survives a round trip and a lost calendar is regenerated', () => {
    const career = createCareer(IDENTITY, 'aurora', DEFAULT_SEASON_SETTINGS, 5, SYNTH_LAYOUTS);
    saveCareer(career);
    const back = loadCareer();
    expect(back?.teamId).toBe('aurora');
    expect(back?.driver.id).toBe(PLAYER_DRIVER_ID);
    const repaired = sanitizeCareer({ ...career, calendar: 'broken' }, SYNTH_LAYOUTS);
    expect(repaired?.calendar).toEqual(createCalendar(5, SYNTH_LAYOUTS));
  });

  test('ghost storage validates and compacts samples', () => {
    const samples = [1.23456, 0.5, -2.98765, 0.1234567, 2.5, 0.5, -3, 0.2];
    expect(saveGhost({ layoutId: 'koyo-hills', lapTime: 90, driverId: 'hsu', teamId: 'nordlys', dt: 0.05, samples }, '2025')).toBe(true);
    const g = loadGhost('koyo-hills', '2025');
    expect(g?.samples[0]).toBe(1.23);
    expect(g?.samples[3]).toBe(0.123);
    expect(loadGhost('koyo-hills', '2026')).toBeNull();
    expect(saveGhost({ layoutId: 'koyo-hills', lapTime: Number.NaN, driverId: '', teamId: '', dt: 0.05, samples }, '2025')).toBe(false);
  });
});

// ───────────────────────────── story & achievements ─────────────────────────────

describe('story', () => {
  test('6 chapters + 6 challenges build valid configs with resolved objectives', () => {
    expect(STORY_CHAPTERS).toHaveLength(6);
    expect(STORY_CHALLENGES).toHaveLength(6);
    for (const entry of [...STORY_CHAPTERS, ...STORY_CHALLENGES]) {
      const objective = resolveObjective(entry.objective, 80);
      expect(objective.text.length).toBeGreaterThan(0);
      const req = storyRequest(entry, objective, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, 11);
      const config = buildSessionConfig(req, { ...LAYOUT, id: entry.session.layoutId });
      expectValid(config);
      expect(config.mode).toBe('story');
      expect(config.objective).toEqual(objective);
      if (entry.objective.kind === 'beatDriver') expect(config.drivers.some((d) => d.id === entry.objective.driverId)).toBe(true);
      if (entry.session.kind === 'race' && entry.session.startPosition !== null) {
        expect(config.grid.findIndex((g) => g.playerIndex === 0)).toBe(entry.session.startPosition - 1);
      }
    }
  });

  test('objective resolution and evaluation', () => {
    const lap = resolveObjective({ kind: 'lapUnder', value: 0, lapFactor: 1.1 }, 80);
    expect(lap.value).toBe(88);
    expect(resolveObjective({ kind: 'lapUnder', value: 0, lapFactor: 1.1 }, null).value).toBeGreaterThan(0);
    expect(evaluateObjective(lap, singleRowResult('practice', 'story', { bestLap: 87.9 }))).toBe(true);
    expect(evaluateObjective(lap, singleRowResult('practice', 'story', { bestLap: 88.1 }))).toBe(false);
    expect(evaluateObjective(lap, singleRowResult('practice', 'story', { bestLap: null, time: null }))).toBe(false);

    const top3 = resolveObjective({ kind: 'finishAtOrAbove', value: 3 }, null);
    expect(evaluateObjective(top3, singleRowResult('race', 'story', { position: 3 }))).toBe(true);
    expect(evaluateObjective(top3, singleRowResult('race', 'story', { position: 4 }))).toBe(false);
    expect(evaluateObjective(top3, singleRowResult('race', 'story', { position: 2, status: 'retired' }))).toBe(false);

    const gain = resolveObjective({ kind: 'gainPositions', value: 8 }, null);
    expect(evaluateObjective(gain, singleRowResult('race', 'story', { gridPosition: 20, position: 12 }))).toBe(true);
    expect(evaluateObjective(gain, singleRowResult('race', 'story', { gridPosition: 20, position: 13 }))).toBe(false);

    const clean = resolveObjective({ kind: 'noPenalties', value: 0 }, null);
    expect(evaluateObjective(clean, singleRowResult('race', 'story', { penaltySec: 0 }))).toBe(true);
    expect(evaluateObjective(clean, singleRowResult('race', 'story', { penaltySec: 5 }))).toBe(false);

    const beat = resolveObjective({ kind: 'beatDriver', value: 0, driverId: 'brandt' }, null);
    const res = singleRowResult('race', 'story', { position: 5 });
    res.rows.push({ ...res.rows[0]!, carId: 1, driverId: 'brandt', playerIndex: -1, position: 6 });
    expect(evaluateObjective(beat, res)).toBe(true);
    res.rows[1]!.position = 4;
    expect(evaluateObjective(beat, res)).toBe(false);
  });

  test('chapters unlock sequentially and challenge records keep bests', () => {
    let progress = emptyStoryProgress();
    expect(isChapterUnlocked(progress, 0)).toBe(true);
    expect(isChapterUnlocked(progress, 1)).toBe(false);
    const res = singleRowResult('race', 'story', { position: 4, bestLap: 92 });
    progress = recordStoryAttempt(progress, 'ch1', false, res);
    expect(isChapterUnlocked(progress, 1)).toBe(false);
    for (const ch of STORY_CHAPTERS) progress = recordStoryAttempt(progress, ch.id, true, res);
    expect(isStoryComplete(progress)).toBe(true);
    progress = recordStoryAttempt(progress, 'c2', false, res);
    progress = recordStoryAttempt(progress, 'c2', true, singleRowResult('race', 'story', { position: 2, bestLap: 95 }));
    expect(progress.challenges.c2).toEqual({ completed: true, attempts: 2, bestPosition: 2, bestLap: 92 });
  });
});

describe('achievements & progression', () => {
  test('evaluation covers race facts', () => {
    const stats = updateStats(emptyStats(), singleRowResult('race', 'grandPrix', { position: 1, gridPosition: 14, fastestLap: true }));
    expect(stats.racesFinished).toBe(1);
    expect(stats.wins).toBe(1);
    const res = singleRowResult('race', 'grandPrix', { position: 1, gridPosition: 14, fastestLap: true });
    res.weather = 'heavyRain';
    const ids = evaluateAchievements({ result: res, trackLimitWarnings: 0, beatGhost: false, storyComplete: false, rdMaxed: false, champion: false, stats });
    expect(ids).toEqual(expect.arrayContaining(['firstWin', 'wetWin', 'firstPodium', 'cleanRace', 'comeback', 'fastestLap']));
    expect(ids).not.toContain('tenRaces');
    const dirty = evaluateAchievements({ result: res, trackLimitWarnings: 2, beatGhost: false, storyComplete: false, rdMaxed: false, champion: false, stats });
    expect(dirty).not.toContain('cleanRace');
  });

  test('time trial PB saves the record and ghost; beating the ghost unlocks an achievement', () => {
    const config = buildSessionConfig(
      gpRequest('timeTrial', {
        mode: 'timeTrial',
        ghost: { layoutId: LAYOUT.id, lapTime: 95, driverId: 'hsu', teamId: 'nordlys', dt: 0.1, samples: [0, 0, 0, 0, 1, 1, 1, 0] },
      }),
      LAYOUT,
    );
    const result = singleRowResult('timeTrial', 'timeTrial', { driverId: 'hsu', teamId: 'nordlys', bestLap: 91.5, time: 91.5 });
    const ghost = { layoutId: LAYOUT.id, lapTime: 91.5, driverId: 'hsu', teamId: 'nordlys', dt: 0.1, samples: [0, 0, 0, 0, 2, 2, 2, 0] };
    const out = applyProgress({
      result,
      config,
      ctx: { returnTo: 'timeTrial', weekendQueue: [], round: null, storyId: null },
      trackLimitWarnings: 0,
      ghost,
      qualifyingOrder: null,
      date: '2026-10-03T00:00:00.000Z',
    });
    expect(out.personalBest).toBe(true);
    expect(personalBest(loadTimeTrialRecords(), LAYOUT.id, '2025')?.lapTime).toBe(91.5);
    expect(loadGhost(LAYOUT.id, '2025')?.lapTime).toBe(91.5);
    expect(out.newAchievements).toContain('beatGhost');
    const slower = addLapRecord(loadTimeTrialRecords(), LAYOUT.id, '2025', { lapTime: 93, teamId: 'x', driverId: 'y', date: 'z' });
    expect(slower.isPersonalBest).toBe(false);
    expect(slower.rank).toBe(2);
  });

  test('qualifying pole is judged against the full classification (simulated AI included)', () => {
    const config = buildSessionConfig(gpRequest('qualifying'), LAYOUT);
    const result = singleRowResult('qualifying', 'grandPrix', { driverId: 'hsu', teamId: 'nordlys', position: 1, time: 86, bestLap: 86 });
    expect(withQualifyingPositions(result, ['varga', 'hsu']).rows[0]?.position).toBe(2);
    const ctx = { returnTo: 'grandPrix' as const, weekendQueue: ['race' as const], round: null, storyId: null };
    const p2 = applyProgress({ result, config, ctx, trackLimitWarnings: 0, ghost: null, qualifyingOrder: ['varga', 'hsu'], date: 'd' });
    expect(p2.newAchievements).not.toContain('firstPole');
    expect(loadProfile().stats.poles).toBe(0);
    const p1 = applyProgress({ result, config, ctx, trackLimitWarnings: 0, ghost: null, qualifyingOrder: ['hsu', 'varga'], date: 'd' });
    expect(p1.newAchievements).toContain('firstPole');
    expect(loadProfile().stats.poles).toBe(1);
  });

  test('career race via applyProgress advances the round exactly once per round index', () => {
    const career = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 42, SYNTH_LAYOUTS);
    saveCareer(career);
    const req = careerRequest(career, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!;
    const config = buildSessionConfig(req, LAYOUT);
    const result = fakeRaceResult(config);
    const ctx = { returnTo: 'career' as const, weekendQueue: [], round: 0, storyId: null };
    applyProgress({ result, config, ctx, trackLimitWarnings: 0, ghost: null, qualifyingOrder: null, date: 'd' });
    expect(loadCareer()?.results).toHaveLength(1);
    // the same result (round 0) again must not be applied twice
    applyProgress({ result, config, ctx, trackLimitWarnings: 0, ghost: null, qualifyingOrder: null, date: 'd' });
    expect(loadCareer()?.results).toHaveLength(1);
    expect(loadProfile().stats.sessions).toBe(2);
  });

  test('My Team race that completes the last level of a part unlocks 研發極限', () => {
    const team = createMyTeam(
      { name: 'Nova Works', shortName: 'NVW', livery: { primary: '#ff5a1f', secondary: '#111111', accent: '#ffffff', pattern: 'stripe' }, powerUnit: 'Helion', identity: IDENTITY, teammateId: 'ishikawa', settings: DEFAULT_SEASON_SETTINGS },
      3,
      SYNTH_LAYOUTS,
    );
    const mine = team.development.teams[MY_TEAM_ID]!;
    mine.parts.weight = { level: PART_MAX_LEVEL - 1, gain: PART_MAX_LEVEL - 1 };
    mine.projects = [{ part: 'weight', level: PART_MAX_LEVEL, roundsLeft: 1, rounds: 3, chance: 0.65 }];
    saveMyTeam(team);
    const config = buildSessionConfig(myTeamRequest(team, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!, LAYOUT);
    const ctx = { returnTo: 'myTeam' as const, weekendQueue: [], round: 0, storyId: null };
    const out = applyProgress({ result: fakeRaceResult(config), config, ctx, trackLimitWarnings: 0, ghost: null, qualifyingOrder: null, date: 'd' });
    expect(myTeamDevelopment(loadMyTeam()!).parts.weight.level).toBe(PART_MAX_LEVEL);
    expect(out.newAchievements).toContain('rdMaxed');
    expect(loadAchievements().unlocked.rdMaxed).toBe('d');
  });
});

describe('pit assist', () => {
  test('presets: beginner keeps the pit autopilot, intermediate / expert drive the pit lane', () => {
    expect(ASSIST_PRESETS.beginner.pitAssist).toBe(true);
    expect(ASSIST_PRESETS.intermediate.pitAssist).toBe(false);
    expect(ASSIST_PRESETS.expert.pitAssist).toBe(false);
    expect(DEFAULT_ASSISTS.pitAssist).toBe(false);
  });

  test('saves without the field: a beginner set gets the autopilot back and still reads as the beginner preset', () => {
    const strip = (a: typeof DEFAULT_ASSISTS): Record<string, unknown> => {
      const { pitAssist: _drop, ...rest } = a;
      return rest;
    };
    const beginner = sanitizeAssists(strip(ASSIST_PRESETS.beginner));
    expect(beginner.pitAssist).toBe(true);
    expect(detectAssistPreset(beginner)).toBe('beginner');
    const intermediate = sanitizeAssists(strip(ASSIST_PRESETS.intermediate));
    expect(intermediate.pitAssist).toBe(false);
    expect(detectAssistPreset(intermediate)).toBe('intermediate');
    expect(sanitizeAssists({ ...ASSIST_PRESETS.beginner, pitAssist: false }).pitAssist).toBe(false);
    expect(sanitizeAssists({ ...ASSIST_PRESETS.expert, pitAssist: true }).pitAssist).toBe(true);
  });
});
