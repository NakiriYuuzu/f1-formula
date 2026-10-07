/**
 * Local roster pack (meta/rosterPack.ts): validation, the active-roster switch for every mode except the story,
 * persistence, separate career / My Team save slots, and an 11-team pack + My Team = 12 teams / 24 cars with
 * 12 distinct pit boxes. The personal default pack (public/rosters/default.json, not part of the game) is checked when present.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import type { DriverDef, TeamDef } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_SETUP } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout, LAYOUTS } from '../src/data/tracks/index';
import { careerTeammateId, createCareer, sanitizeCareer } from '../src/meta/career';
import { createMyTeam, myTeamRequest, powerUnitOption, powerUnitOptions, sanitizeMyTeam } from '../src/meta/myTeam';
import { builtinRoster, reserveDrivers, rosterTeams, standardRoster, type PlayerIdentity } from '../src/meta/roster';
import {
  activeRosterPack,
  MAX_PACK_TEAMS,
  parseRosterPack,
  parseRosterPackText,
  resetRosterPackCache,
  ROSTER_PACK_FORMAT,
  rosterSource,
  setDefaultRosterPack,
  setRosterPack,
  useDefaultRosterPack,
  type RosterPack,
} from '../src/meta/rosterPack';
import { loadCareer, saveCareer } from '../src/meta/save';
import { DEFAULT_SEASON_SETTINGS } from '../src/meta/season';
import { buildQuickStart, buildSessionConfig, validateSessionConfig } from '../src/meta/sessionBuilder';
import { STORY_CHAPTERS, STORY_TEAM_ID, storyRoster } from '../src/meta/story';
import { MemoryStore, setStore } from '../src/meta/storage';
import { createWorld } from '../src/race/index';
import { BOX_SLOTS } from '../src/race/world';

const PLAYER = { assists: { ...DEFAULT_ASSISTS }, setup: { ...DEFAULT_SETUP }, startCompound: null };
const IDENTITY: PlayerIdentity = {
  firstName: 'Test',
  lastName: 'Driver',
  abbr: 'TST',
  number: 88,
  nationality: 'TWN',
  helmet: { primary: '#ff0000', secondary: '#ffffff', accent: '#000000' },
};

/** A valid pack with `teamCount` teams (2 drivers each) and 2 reserves; ids / codes / numbers derived from i. */
function packJson(teamCount: number): Record<string, unknown> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const code = (i: number, p: string): string => `${p}${letters[Math.floor(i / 26)]}${letters[i % 26]}`;
  const teams = Array.from({ length: teamCount }, (_, i) => ({
    id: `team-${i}`,
    name: `Team ${i}`,
    shortName: code(i, 'T'),
    livery: { primary: '#112233', secondary: '#445566', accent: '#778899' },
    base: '測試市',
    powerUnit: 'Test PU',
    rating: { aero: 0.98 - i * 0.01, power: 0.97, chassis: 0.96, reliability: 0.95 },
    driverIds: [`d-${i}-a`, `d-${i}-b`],
  }));
  const driver = (id: string, teamId: string, n: number): Record<string, unknown> => ({
    id,
    firstName: 'First',
    lastName: `Last ${n}`,
    abbr: code(n, 'D'),
    number: n,
    nationality: 'GBR',
    teamId,
    skill: { pace: 0.9, racecraft: 0.9, awareness: 0.9, wet: 0.9, consistency: 0.9 },
    helmet: { primary: '#ffffff', secondary: '#000000', accent: '#ff0000' },
  });
  const drivers = teams.flatMap((t, i) => [driver(`d-${i}-a`, t.id, i * 2 + 1), driver(`d-${i}-b`, t.id, i * 2 + 2)]);
  drivers.push(driver('res-1', '', 60), driver('res-2', '', 61));
  return {
    format: ROSTER_PACK_FORMAT,
    name: '測試名單',
    teams,
    drivers,
    powerUnits: [
      { id: 'Alpha', power: 0.96, reliability: 0.92, cost: 9, blurb: 'a' },
      { id: 'Beta', power: 0.9, reliability: 0.95, cost: 4, blurb: 'b' },
    ],
  };
}

function okPack(teamCount = 11): RosterPack {
  const r = parseRosterPack(packJson(teamCount));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.pack;
}

function errorsOf(mutate: (p: Record<string, unknown>) => void): string[] {
  const p = packJson(4);
  mutate(p);
  const r = parseRosterPack(p);
  return r.ok ? [] : r.errors;
}

const teamsOf = (p: Record<string, unknown>) => p.teams as Record<string, unknown>[];
const driversOf = (p: Record<string, unknown>) => p.drivers as Record<string, unknown>[];

beforeEach(() => {
  setStore(new MemoryStore());
  resetRosterPackCache();
});

afterEach(() => {
  setRosterPack(null);
  setDefaultRosterPack(null);
  resetRosterPackCache();
});

describe('parseRosterPack', () => {
  test('accepts a valid pack and derives each driver teamId from the teams', () => {
    const pack = okPack(11);
    expect(pack.name).toBe('測試名單');
    expect(pack.teams.length).toBe(11);
    expect(pack.drivers.length).toBe(24);
    expect(pack.drivers.filter((d) => d.teamId === '').map((d) => d.id)).toEqual(['res-1', 'res-2']);
    expect(pack.drivers.find((d) => d.id === 'd-3-b')?.teamId).toBe('team-3');
    expect(pack.powerUnits.map((p) => p.id)).toEqual(['Alpha', 'Beta']);
  });

  test('rejects malformed packs with zh-TW reasons', () => {
    expect(parseRosterPack(null).ok).toBe(false);
    expect(parseRosterPack({ ...packJson(2), format: 'other' }).ok).toBe(false);
    expect(parseRosterPackText('{ not json').ok).toBe(false);
    expect(parseRosterPack(packJson(MAX_PACK_TEAMS + 1)).ok).toBe(false);
    expect(errorsOf((p) => (p.teams = [])).some((e) => e.includes('車隊數'))).toBe(true);
    expect(errorsOf((p) => (driversOf(p)[1]!.number = 1)).some((e) => e.includes('車號 1 重複'))).toBe(true);
    expect(errorsOf((p) => (driversOf(p)[1]!.abbr = driversOf(p)[0]!.abbr)).some((e) => e.includes('縮寫'))).toBe(true);
    expect(errorsOf((p) => (teamsOf(p)[0]!.driverIds = ['d-0-a', 'nobody'])).some((e) => e.includes('nobody'))).toBe(true);
    expect(errorsOf((p) => (teamsOf(p)[0]!.livery = { primary: 'red', secondary: '#000000', accent: '#000000' })).length).toBeGreaterThan(0);
    expect(errorsOf((p) => (teamsOf(p)[1]!.id = 'myteam')).length).toBeGreaterThan(0);
    expect(errorsOf((p) => (driversOf(p)[0]!.teamId = 'team-2')).some((e) => e.includes('teamId'))).toBe(true);
    expect(errorsOf((p) => (p.drivers = driversOf(p).filter((d) => d.teamId !== ''))).some((e) => e.includes('候補'))).toBe(true);
  });

  test('clamps team ratings into the 0.8..1 band', () => {
    const p = packJson(2);
    teamsOf(p)[0]!.rating = { aero: 1.4, power: 0.2, chassis: 0.9, reliability: 0.9 };
    const r = parseRosterPack(p);
    expect(r.ok && r.pack.teams[0]!.rating).toEqual({ aero: 1, power: 0.8, chassis: 0.9, reliability: 0.9 });
  });
});

describe('active roster', () => {
  test('built-in by default; a pack replaces the standard field, reserves and power units', () => {
    expect(activeRosterPack()).toBeNull();
    expect(standardRoster().teams.map((t) => t.id)).toEqual(TEAMS.map((t) => t.id));
    expect(powerUnitOption('').id).toBe('Orion');

    const pack = okPack(11);
    setRosterPack(pack);
    expect(standardRoster().teams.map((t) => t.id)).toEqual(pack.teams.map((t) => t.id));
    expect(standardRoster().drivers.length).toBe(22);
    expect(reserveDrivers().map((d) => d.id)).toEqual(['res-1', 'res-2']);
    expect(powerUnitOptions().map((p) => p.id)).toEqual(['Alpha', 'Beta']);
    expect(powerUnitOption('nope').id).toBe('Beta');
    // the story keeps the built-in roster
    expect(builtinRoster().teams.map((t) => t.id)).toEqual(TEAMS.map((t) => t.id));
    expect(storyRoster(STORY_TEAM_ID).teams.map((t) => t.id)).toEqual(TEAMS.map((t) => t.id));

    setRosterPack(null);
    expect(standardRoster().teams.map((t) => t.id)).toEqual(TEAMS.map((t) => t.id));
  });

  test('default pack: active until a pack is imported or the built-in roster is chosen (remembered)', () => {
    const fallback = okPack(11);
    setDefaultRosterPack(fallback);
    expect(rosterSource()).toBe('default');
    expect(standardRoster().teams.length).toBe(11);
    const imported = okPack(3);
    setRosterPack(imported);
    expect(rosterSource()).toBe('imported');
    expect(standardRoster().teams.length).toBe(3);
    setRosterPack(null);
    expect(rosterSource()).toBe('builtin');
    expect(standardRoster().teams.map((t) => t.id)).toEqual(TEAMS.map((t) => t.id));
    // the built-in choice survives a reload
    resetRosterPackCache();
    expect(rosterSource()).toBe('builtin');
    useDefaultRosterPack();
    expect(rosterSource()).toBe('default');
    resetRosterPackCache();
    expect(activeRosterPack()).toBe(fallback);
    // a default pack shares the roster-pack save slot
    saveCareer(createCareer(IDENTITY, 'team-4', DEFAULT_SEASON_SETTINGS, 4, LAYOUTS));
    expect(loadCareer()?.teamId).toBe('team-4');
  });

  test('the pack persists and is read back after a reload', () => {
    const pack = okPack(3);
    expect(setRosterPack(pack)).toBe(true);
    resetRosterPackCache();
    expect(activeRosterPack()).toEqual(pack);
  });

  test('a corrupt stored pack falls back to the built-in roster', () => {
    setRosterPack(okPack(3));
    // a later version that no longer validates (here: tampered team count)
    setRosterPack({ ...okPack(3), teams: [] });
    resetRosterPackCache();
    expect(activeRosterPack()).toBeNull();
    expect(rosterTeams()).toBe(TEAMS);
  });

  test('careers of the built-in roster and of a pack are kept in separate slots', () => {
    const builtin = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 1, LAYOUTS);
    saveCareer(builtin);
    setRosterPack(okPack(4));
    expect(loadCareer()).toBeNull();
    const custom = createCareer(IDENTITY, 'team-2', DEFAULT_SEASON_SETTINGS, 2, LAYOUTS);
    expect(custom.teamId).toBe('team-2');
    expect(careerTeammateId(custom)).toBe('d-2-a');
    saveCareer(custom);
    expect(loadCareer()?.teamId).toBe('team-2');
    setRosterPack(null);
    expect(loadCareer()?.teamId).toBe('kestrel');
    // a pack career does not validate against the built-in roster
    expect(sanitizeCareer(custom, LAYOUTS)).toBeNull();
  });

  test('quick start falls back to a driver of the pack', () => {
    setRosterPack(okPack(5));
    const { config } = buildQuickStart({ kind: 'race', layoutId: 'porto-lumen', laps: 1, seed: 3 });
    expect(validateSessionConfig(config)).toEqual([]);
    expect(config.teams.length).toBe(5);
    const p0 = config.players.find((p) => p.playerIndex === 0)!;
    expect(config.teams.some((t) => t.id === p0.teamId)).toBe(true);
  });

  test('11-team pack + My Team: 12 teams, 24 cars, 12 distinct pit boxes', () => {
    setRosterPack(okPack(MAX_PACK_TEAMS));
    const save = createMyTeam(
      {
        name: '新星測試車隊',
        shortName: 'NTS',
        livery: { primary: '#2266ff', secondary: '#ffffff', accent: '#ff3300', pattern: 'chevron' },
        powerUnit: 'Alpha',
        identity: IDENTITY,
        teammateId: 'res-2',
        settings: DEFAULT_SEASON_SETTINGS,
      },
      5,
      LAYOUTS,
    );
    expect(save.powerUnit).toBe('Alpha');
    expect(sanitizeMyTeam(save, LAYOUTS)?.teammateId).toBe('res-2');
    const config = buildSessionConfig(myTeamRequest(save, 'race', 50, PLAYER, null)!);
    expect(validateSessionConfig(config)).toEqual([]);
    expect(config.teams.length).toBe(12);
    expect(config.grid.length).toBe(24);
    expect(new Set(config.drivers.map((d) => d.number)).size).toBe(24);
    const world = createWorld(config, getLayout(config.layoutId));
    expect(world.cars.length).toBe(24);
    expect(new Set(world.cars.map((c) => c.pit.boxS)).size).toBe(BOX_SLOTS);
  });
});

describe('story', () => {
  test('chapters still build on the built-in roster with a pack active', () => {
    setRosterPack(okPack(11));
    const roster = storyRoster(STORY_CHAPTERS[0]!.session.teamId);
    const ids = new Set<string>(DRIVERS.map((d: DriverDef) => d.id));
    expect(roster.drivers.filter((d) => d.id !== 'player').every((d) => ids.has(d.id))).toBe(true);
    expect(roster.teams.every((t: TeamDef) => TEAMS.some((x) => x.id === t.id))).toBe(true);
  });
});

const PACK_2026 = new URL('../public/rosters/default.json', import.meta.url);

describe.skipIf(!existsSync(PACK_2026))('personal 2026 roster file', () => {
  test('validates: 11 teams, 22 race drivers, 6 reserves, 5 power units', () => {
    const r = parseRosterPackText(readFileSync(PACK_2026, 'utf8'));
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(r.pack.teams.length).toBe(11);
    expect(r.pack.drivers.filter((d) => d.teamId !== '').length).toBe(22);
    expect(r.pack.drivers.filter((d) => d.teamId === '').length).toBe(6);
    expect(r.pack.powerUnits.length).toBe(5);
  });
});
