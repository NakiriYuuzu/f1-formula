/**
 * Meta layer: race-control rules (sanitiser merge), sprint weekends (queue, laps, config, results flow,
 * career rounds and standings), loading tips and URL quick start parameters.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ResultRow, SessionConfig, SessionKind, SessionResult } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, POINTS_TABLE, SPRINT_POINTS } from '../src/core/defaults';
import { parseQuickStart } from '../src/app/quickStart';
import { applyCareerRace, applyCareerSprint, careerRequest, careerRoster, createCareer, sanitizeCareer } from '../src/meta/career';
import { aiDevelopmentBudget } from '../src/meta/development';
import { sanitizeRules } from '../src/meta/guards';
import { sprintLaps, weekendSessions, withSprint, WEEKEND_FORMATS, type LayoutMeta } from '../src/meta/options';
import { applyProgress } from '../src/meta/progression';
import { defaultProfile, sanitizeProfile } from '../src/meta/prefs';
import { PLAYER_DRIVER_ID, standardRoster, type PlayerIdentity } from '../src/meta/roster';
import { loadCareer, saveCareer } from '../src/meta/save';
import {
  createCalendar,
  DEFAULT_SEASON_SETTINGS,
  driverStandings,
  isSprintRound,
  sanitizeSeasonSettings,
  seasonWeekend,
  teamStandings,
  pointsForRow,
} from '../src/meta/season';
import {
  buildQuickStart,
  buildSessionConfig,
  requestForKind,
  requestFromConfig,
  validateSessionConfig,
  type SessionRequest,
} from '../src/meta/sessionBuilder';
import { MemoryStore, setStore } from '../src/meta/storage';
import { LOADING_TIPS } from '../src/meta/tips';
import { useFictionalRoster } from './rosterFixture';

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
    raceLaps: 15,
    weather: 'clear',
    timeOfDay: 'auto',
    regulation: '2025',
    aiDifficulty: 90,
    qualifying: 'oneShot',
    rules: { ...DEFAULT_RULES, mandatoryPitStop: true },
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

function raceResult(config: SessionConfig, order: string[], table: readonly number[]): SessionResult {
  const rows: ResultRow[] = order.map((driverId, i) => {
    const g = config.grid.find((x) => x.driverId === driverId);
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
      pitStops: 0,
      penaltySec: 0,
      points: table[i] ?? 0,
      fastestLap: i === 0,
      status: 'finished',
    };
  });
  return {
    kind: 'race',
    mode: config.mode,
    layoutId: config.layoutId,
    rows,
    fastestLap: null,
    weather: config.weather,
    objectiveMet: null,
    ...(config.sprint ? { sprint: true } : {}),
  };
}

beforeEach(() => {
  setStore(new MemoryStore());
  useFictionalRoster();
});

describe('race-control rules', () => {
  test('old rules without the new fields merge from DEFAULT_RULES', () => {
    const old = { tyreWear: false, fuel: true, damage: 'full', trackLimits: true, mandatoryPitStop: true, flashbacks: 3, collisions: false };
    const r = sanitizeRules(old);
    expect(r.tyreWear).toBe(false);
    expect(r.flashbacks).toBe(3);
    expect(r.safetyCar).toBe('standard');
    expect(r.redFlags).toBe(true);
    expect(r.formationLap).toBe(false);
  });

  test('new fields are validated; invalid values fall back', () => {
    expect(sanitizeRules({ safetyCar: 'increased', redFlags: false, formationLap: true })).toMatchObject({ safetyCar: 'increased', redFlags: false, formationLap: true });
    expect(sanitizeRules({ safetyCar: 'bogus', redFlags: 'x', formationLap: 1 })).toMatchObject({ safetyCar: 'standard', redFlags: true, formationLap: false });
    expect(sanitizeRules(null)).toEqual(DEFAULT_RULES);
    // a legacy fallback without the optional fields still resolves to DEFAULT_RULES values
    const { safetyCar: _a, redFlags: _b, formationLap: _c, ...legacy } = DEFAULT_RULES;
    expect(sanitizeRules({}, legacy)).toEqual(DEFAULT_RULES);
  });

  test('profile, split prefs and season settings from old saves gain the new fields', () => {
    const oldRules = { tyreWear: true, fuel: true, damage: 'reduced', trackLimits: true, mandatoryPitStop: false, flashbacks: -1, collisions: true };
    const p = sanitizeProfile({ gp: { rules: oldRules }, split: {} });
    expect(p.gp.rules).toEqual(DEFAULT_RULES);
    expect(p.split.rules).toEqual(DEFAULT_RULES);
    expect(defaultProfile().split.rules).toEqual(DEFAULT_RULES);
    const s = sanitizeSeasonSettings({ rules: oldRules });
    expect(s.rules).toEqual(DEFAULT_RULES);
    expect(s.sprintWeekends).toBe(false);
    const saved = sanitizeProfile({ gp: { rules: { ...oldRules, safetyCar: 'reduced', formationLap: true } } });
    expect(saved.gp.rules.safetyCar).toBe('reduced');
    expect(saved.gp.rules.formationLap).toBe(true);
  });

  test('session config carries the rules through', () => {
    const config = buildSessionConfig(gpRequest('race', { rules: { ...DEFAULT_RULES, safetyCar: 'off', redFlags: false, formationLap: true } }), LAYOUT);
    expect(config.rules).toMatchObject({ safetyCar: 'off', redFlags: false, formationLap: true });
  });
});

describe('sprint weekend', () => {
  test('format and queue: qualifying → sprint → race', () => {
    expect(WEEKEND_FORMATS).toContain('sprint');
    expect(weekendSessions('sprint')).toEqual(['qualifying', 'sprint', 'race']);
    expect(weekendSessions('qualiRace')).toEqual(['qualifying', 'race']);
    expect(withSprint(['practice', 'qualifying', 'race'])).toEqual(['practice', 'qualifying', 'sprint', 'race']);
    expect(withSprint(['qualifying', 'sprint', 'race'])).toEqual(['qualifying', 'sprint', 'race']);
  });

  test('sprint laps = max(2, round(raceLaps / 3))', () => {
    expect(sprintLaps(60)).toBe(20);
    expect(sprintLaps(15)).toBe(5);
    expect(sprintLaps(5)).toBe(2);
    expect(sprintLaps(3)).toBe(2);
    expect(sprintLaps(1)).toBe(2);
    expect(sprintLaps(10)).toBe(3);
  });

  test('sprint config is valid: race kind, short, no mandatory stop, qualifying grid', () => {
    const base = gpRequest('race');
    const order = standardRoster().drivers.map((d) => d.id).reverse();
    const sprintReq = requestForKind(base, 'sprint', order);
    expect(sprintReq.kind).toBe('race');
    expect(sprintReq.sprint).toBe(true);
    const config = buildSessionConfig(sprintReq, LAYOUT);
    expect(validateSessionConfig(config)).toEqual([]);
    expect(config.kind).toBe('race');
    expect(config.sprint).toBe(true);
    expect(config.laps).toBe(5);
    expect(config.rules.mandatoryPitStop).toBe(false);
    expect(config.grid.map((g) => g.driverId)).toEqual(order);
    expect(structuredClone(config)).toEqual(config);

    const raceReq = requestForKind({ ...base, sprint: true }, 'race', order);
    expect(raceReq.sprint).toBe(false);
    const race = buildSessionConfig(raceReq, LAYOUT);
    expect(validateSessionConfig(race)).toEqual([]);
    expect(race.sprint).toBeUndefined();
    expect(race.laps).toBe(15);
    expect(race.rules.mandatoryPitStop).toBe(true);
    expect(race.grid.map((g) => g.driverId)).toEqual(order);
  });

  test('validateSessionConfig rejects a sprint outside a race', () => {
    const q = buildSessionConfig(gpRequest('qualifying'), LAYOUT);
    expect(validateSessionConfig({ ...q, sprint: true })).toContain('sprint on a non-race session');
  });

  test('restarting the weekend from a sprint config keeps the sprint distance', () => {
    const config = buildSessionConfig(requestForKind(gpRequest('race'), 'sprint', null), LAYOUT);
    const req = requestFromConfig(config);
    expect(req.sprint).toBe(true);
    expect(buildSessionConfig(req, LAYOUT).laps).toBe(config.laps);
    // the next step (race) from that request is a full-distance race again
    const next = buildSessionConfig(requestForKind(req, 'race', null), LAYOUT);
    expect(next.sprint).toBeUndefined();
    expect(next.laps).toBeGreaterThanOrEqual(config.laps * 3 - 1);
  });

  test('sprint points table is used for fallback points', () => {
    const config = buildSessionConfig(requestForKind(gpRequest('race'), 'sprint', null), LAYOUT);
    const rows = raceResult(config, config.grid.map((g) => g.driverId), SPRINT_POINTS).rows;
    expect(rows.reduce((a, r) => a + pointsForRow(r), 0)).toBe(SPRINT_POINTS.reduce((a, b) => a + b, 0));
    const row = { ...(rows[0] as ResultRow), points: Number.NaN };
    expect(pointsForRow(row, true)).toBe(8);
    expect(pointsForRow(row)).toBe(25);
  });
});

describe('career sprint rounds', () => {
  test('rounds 3, 6 and 9 are sprint weekends only when enabled', () => {
    const on = { ...DEFAULT_SEASON_SETTINGS, sprintWeekends: true };
    const sprintIdx = Array.from({ length: 10 }, (_, i) => i).filter((i) => isSprintRound(on, i));
    expect(sprintIdx).toEqual([2, 5, 8]);
    expect(Array.from({ length: 10 }, (_, i) => i).some((i) => isSprintRound(DEFAULT_SEASON_SETTINGS, i))).toBe(false);
    expect(seasonWeekend(on, 2)).toEqual(['qualifying', 'sprint', 'race']);
    expect(seasonWeekend(on, 1)).toEqual(['qualifying', 'race']);
    expect(seasonWeekend({ ...on, format: 'full' }, 5)).toEqual(['practice', 'qualifying', 'sprint', 'race']);
    expect(seasonWeekend(DEFAULT_SEASON_SETTINGS, 2)).toEqual(['qualifying', 'race']);
  });

  test('season settings never keep the sprint format and persist the toggle', () => {
    expect(sanitizeSeasonSettings({ format: 'sprint' }).format).toBe(DEFAULT_SEASON_SETTINGS.format);
    expect(sanitizeSeasonSettings({ sprintWeekends: true }).sprintWeekends).toBe(true);
  });

  test('sprint points join the round record and the standings; the round does not advance', () => {
    const settings = { ...DEFAULT_SEASON_SETTINGS, sprintWeekends: true };
    let career = createCareer(IDENTITY, 'kestrel', settings, 42, SYNTH_LAYOUTS);
    const base = careerRequest(career, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!;
    const sprintConfig = buildSessionConfig(requestForKind(base, 'sprint', null), LAYOUT);
    const raceConfig = buildSessionConfig(requestForKind(base, 'race', null), LAYOUT);
    const ids = sprintConfig.grid.map((g) => g.driverId);
    const sprintOrder = [PLAYER_DRIVER_ID, ...ids.filter((id) => id !== PLAYER_DRIVER_ID)];
    const raceOrder = [...ids.filter((id) => id !== PLAYER_DRIVER_ID), PLAYER_DRIVER_ID];

    career = applyCareerSprint(career, raceResult(sprintConfig, sprintOrder, SPRINT_POINTS));
    expect(career.results).toHaveLength(0);
    expect(career.pendingSprint?.entries.find((e) => e.driverId === PLAYER_DRIVER_ID)?.points).toBe(8);

    const upd = applyCareerRace(career, raceResult(raceConfig, raceOrder, POINTS_TABLE), 0);
    expect(upd.save.results).toHaveLength(1);
    expect(upd.save.pendingSprint).toBeUndefined();
    const drivers = driverStandings(upd.save.results, careerRoster(upd.save).roster.drivers.map((d) => d.id));
    const me = drivers.find((d) => d.id === PLAYER_DRIVER_ID)!;
    expect(me.points).toBe(8 + (POINTS_TABLE[19] ?? 0));
    expect(me.wins).toBe(0);
    const total = drivers.reduce((a, d) => a + d.points, 0);
    expect(total).toBe(POINTS_TABLE.reduce((a, b) => a + b, 0) + SPRINT_POINTS.reduce((a, b) => a + b, 0));
    const teams = teamStandings(upd.save.results, careerRoster(upd.save).roster.teams.map((t) => t.id));
    expect(teams.reduce((a, t) => a + t.points, 0)).toBe(total);
    // R&D points: the team's budget × (0.85 + 0.05 sprint win) (P20 behind the team-mate adds nothing for the race); both
    // sessions carry the development
    const rank0 = teams.findIndex((t) => t.id === 'kestrel');
    expect(upd.save.rdPoints).toBe(Math.round(aiDevelopmentBudget(rank0, teams.length) * (0.85 + 0.05)));
    expect(sprintConfig.development).toEqual(raceConfig.development);
    expect(Object.keys(sprintConfig.development ?? {}).sort()).toEqual(sprintConfig.teams.map((t) => t.id).sort());
  });

  test('applyProgress stores a sprint without advancing the round, then the race consumes it', () => {
    const settings = { ...DEFAULT_SEASON_SETTINGS, sprintWeekends: true };
    let career = createCareer(IDENTITY, 'kestrel', settings, 42, SYNTH_LAYOUTS);
    saveCareer(career);
    const base = careerRequest(career, 'race', 60, { assists: DEFAULT_ASSISTS, setup: DEFAULT_SETUP, startCompound: null }, null)!;
    const sprintConfig = buildSessionConfig(requestForKind(base, 'sprint', null), LAYOUT);
    const ids = sprintConfig.grid.map((g) => g.driverId);
    const ctx = { returnTo: 'career' as const, weekendQueue: ['race' as const], round: 0, storyId: null };
    const out = applyProgress({
      result: raceResult(sprintConfig, ids, SPRINT_POINTS),
      config: sprintConfig,
      ctx,
      trackLimitWarnings: 0,
      ghost: null,
      qualifyingOrder: null,
      date: '2026-01-01T00:00:00.000Z',
    });
    expect(out.notes.some((n) => n.includes('衝刺賽'))).toBe(true);
    const stored = loadCareer();
    expect(stored?.results).toHaveLength(0);
    expect(stored?.pendingSprint?.round).toBe(0);
    expect(sanitizeCareer(JSON.parse(JSON.stringify(stored)), SYNTH_LAYOUTS)?.pendingSprint?.entries.length).toBeGreaterThan(0);
  });

  test('calendar helpers keep ten rounds', () => {
    expect(createCalendar(1, SYNTH_LAYOUTS)).toHaveLength(10);
  });
});

describe('loading tips', () => {
  test('cover the race-control topics', () => {
    const all = LOADING_TIPS.join('\n');
    for (const kw of ['安全車期間', '虛擬安全車', '藍旗', '暖胎圈', '進站']) expect(all).toContain(kw);
    expect(new Set(LOADING_TIPS).size).toBe(LOADING_TIPS.length);
  });
});

describe('quick start race-control parameters', () => {
  const anyLayout = (): boolean => true;

  test('parseQuickStart reads sc, redflag, formation and sprint', () => {
    const q = parseQuickStart('?quick=race&sc=increased&redflag=0&formation=1&sprint=1', anyLayout)!;
    expect(q).toMatchObject({ kind: 'race', safetyCar: 'increased', redFlags: false, formationLap: true, sprint: true });
    for (const sc of ['off', 'reduced', 'standard', 'increased']) {
      expect(parseQuickStart(`?quick=race&sc=${sc}`, anyLayout)?.safetyCar).toBe(sc);
    }
  });

  test('invalid values are dropped', () => {
    const q = parseQuickStart('?quick=race&sc=lots&redflag=2&formation=yes&sprint=0', anyLayout)!;
    expect(q.safetyCar).toBeUndefined();
    expect(q.redFlags).toBeUndefined();
    expect(q.formationLap).toBeUndefined();
    expect(q.sprint).toBeUndefined();
  });

  test('buildQuickStart defaults to DEFAULT_RULES and applies the parameters', () => {
    const plain = buildQuickStart({ kind: 'race', seed: 1 });
    expect(plain.config.rules).toEqual(DEFAULT_RULES);
    expect(plain.config.sprint).toBeUndefined();
    const custom = buildQuickStart({ kind: 'race', seed: 1, laps: 9, safetyCar: 'off', redFlags: false, formationLap: true, sprint: true });
    expect(custom.config.rules).toMatchObject({ safetyCar: 'off', redFlags: false, formationLap: true });
    expect(custom.config.sprint).toBe(true);
    expect(custom.config.laps).toBe(3);
    expect(validateSessionConfig(custom.config)).toEqual([]);
    expect(custom.ctx.weekendQueue).toEqual([]);
    // sprint only applies to the race kind
    expect(buildQuickStart({ kind: 'practice', seed: 1, sprint: true }).config.sprint).toBeUndefined();
  });
});
