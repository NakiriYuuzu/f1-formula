/**
 * Meta layer: real-circuit support (fake defs / layouts, independent of the registered track data):
 * real / original season calendars, sprint venues, old-save sanitising, track filter, real facts, credits list.
 */
import { describe, expect, test } from 'bun:test';
import type { RealCircuitInfo } from '../src/core/types';
import { createCareer, isSeasonComplete, sanitizeCareer } from '../src/meta/career';
import { circuitCredits, directionLabel, featureLabels, filterLayouts, formatKm, realFacts } from '../src/meta/circuits';
import { createMyTeam, sanitizeMyTeam, startNextMyTeamSeason } from '../src/meta/myTeam';
import {
  createCalendar,
  DEFAULT_SEASON_SETTINGS,
  isSprintRound,
  realCalendarLayouts,
  REAL_CALENDAR_ORDER,
  REAL_SPRINT_VENUES,
  sanitizeCalendar,
  sanitizeSeasonSettings,
  seasonWeekend,
  SEASON_ROUNDS,
} from '../src/meta/season';
import type { PlayerIdentity } from '../src/meta/roster';

const REAL = { length: 5412, turns: 16, direction: 'clockwise', firstGrandPrix: 1950, source: 'Test source' } as const;

const fake = (id: string, real = false) => [
  { id, defId: id, reverse: false, ...(real ? { real: REAL } : {}) },
  { id: `${id}-rev`, defId: id, reverse: true, ...(real ? { real: REAL } : {}) },
];
const ORIGINALS = ['a', 'b', 'c', 'd', 'e'].flatMap((id) => fake(id));
/** Registry order: originals first, real circuits after (deliberately not in calendar order). */
const REAL_IDS = ['monza', 'bahrain', 'shanghai', 'spa', 'suzuka'];
const WITH_REAL = [...ORIGINALS, ...REAL_IDS.flatMap((id) => fake(id, true))];

const IDENTITY: PlayerIdentity = {
  firstName: 'Test',
  lastName: 'Driver',
  abbr: 'TDR',
  number: 2,
  nationality: 'TWN',
  helmet: { primary: '#ff5a1f', secondary: '#ffffff', accent: '#111111' },
};

describe('real calendar', () => {
  test('forward layouts of registered real circuits in 2025 order; unregistered ids are skipped', () => {
    const cal = createCalendar(7, WITH_REAL, 'real');
    expect(cal.map((r) => r.layoutId)).toEqual(['shanghai', 'suzuka', 'bahrain', 'spa', 'monza']);
    expect(cal.every((r) => !r.layoutId.endsWith('-rev'))).toBe(true);
    expect(realCalendarLayouts(WITH_REAL).map((l) => l.id)).toEqual(cal.map((r) => r.layoutId));
  });

  test('all twelve ids in the declared 2025 order', () => {
    expect(REAL_CALENDAR_ORDER).toHaveLength(12);
    const all = REAL_CALENDAR_ORDER.flatMap((id) => fake(id, true)).reverse();
    expect(createCalendar(1, all, 'real').map((r) => r.layoutId)).toEqual([...REAL_CALENDAR_ORDER]);
  });

  test('weather is seeded (same seed = same calendar)', () => {
    expect(createCalendar(5, WITH_REAL, 'real')).toEqual(createCalendar(5, WITH_REAL, 'real'));
  });

  test('falls back to the original calendar when no real circuit is registered', () => {
    const cal = createCalendar(3, ORIGINALS, 'real');
    expect(cal).toEqual(createCalendar(3, ORIGINALS, 'original'));
    expect(cal).toHaveLength(SEASON_ROUNDS);
  });

  test('original calendar ignores real layouts', () => {
    const cal = createCalendar(9, WITH_REAL, 'original');
    expect(cal).toHaveLength(SEASON_ROUNDS);
    expect(cal.every((r) => /^[a-e](-rev)?$/.test(r.layoutId))).toBe(true);
  });

  test('default kind is the original calendar; calendars longer than 10 rounds survive sanitising', () => {
    expect(createCalendar(1, WITH_REAL)).toHaveLength(SEASON_ROUNDS);
    const long = REAL_CALENDAR_ORDER.map((layoutId) => ({ layoutId, weather: 'clear' }));
    expect(sanitizeCalendar(long)).toHaveLength(12);
  });
});

describe('sprint venues', () => {
  const on = { ...DEFAULT_SEASON_SETTINGS, sprintWeekends: true };
  const all = REAL_CALENDAR_ORDER.flatMap((id) => fake(id, true));
  const real = createCalendar(1, all, 'real');

  test('real calendar: shanghai, spa, cota, interlagos', () => {
    expect(REAL_SPRINT_VENUES).toEqual(['shanghai', 'spa', 'cota', 'interlagos']);
    const idx = real.map((_, i) => i).filter((i) => isSprintRound(on, i, real));
    expect(idx.map((i) => real[i]?.layoutId)).toEqual(['shanghai', 'spa', 'cota', 'interlagos']);
    expect(seasonWeekend(on, 0, real)).toEqual(['qualifying', 'sprint', 'race']);
    expect(seasonWeekend(on, 1, real)).toEqual(['qualifying', 'race']);
  });

  test('original calendar: rounds 3 / 6 / 9', () => {
    const orig = createCalendar(1, ORIGINALS, 'original');
    const idx = orig.map((_, i) => i).filter((i) => isSprintRound(on, i, orig));
    expect(idx).toEqual([2, 5, 8]);
    expect(isSprintRound(on, 2)).toBe(true);
  });

  test('off by default', () => {
    expect(real.some((_, i) => isSprintRound(DEFAULT_SEASON_SETTINGS, i, real))).toBe(false);
  });
});

describe('season settings calendar & old saves', () => {
  test('new seasons default to the real calendar', () => {
    expect(DEFAULT_SEASON_SETTINGS.calendar).toBe('real');
    expect(sanitizeSeasonSettings({ ...DEFAULT_SEASON_SETTINGS }).calendar).toBe('real');
  });

  test('settings without the field (old saves) become original; junk too', () => {
    expect(sanitizeSeasonSettings({}).calendar).toBe('original');
    expect(sanitizeSeasonSettings(undefined).calendar).toBe('original');
    expect(sanitizeSeasonSettings({ calendar: 'nope' }).calendar).toBe('original');
    expect(sanitizeSeasonSettings({ calendar: 'original' }).calendar).toBe('original');
  });

  test('createCareer builds the calendar from settings.calendar', () => {
    const real = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 4, WITH_REAL);
    expect(real.calendar).toHaveLength(5);
    expect(real.calendar[0]?.layoutId).toBe('shanghai');
    const orig = createCareer(IDENTITY, 'kestrel', { ...DEFAULT_SEASON_SETTINGS, calendar: 'original' }, 4, WITH_REAL);
    expect(orig.calendar).toHaveLength(SEASON_ROUNDS);
  });

  test('old career save keeps its stored 10-round calendar and is original', () => {
    const career = createCareer(IDENTITY, 'kestrel', { ...DEFAULT_SEASON_SETTINGS, calendar: 'original' }, 4, ORIGINALS);
    const { calendar: _drop, ...oldSettings } = career.settings;
    const stored = JSON.parse(JSON.stringify({ ...career, settings: oldSettings }));
    const back = sanitizeCareer(stored, WITH_REAL);
    expect(back?.settings.calendar).toBe('original');
    expect(back?.calendar).toEqual(career.calendar);
    expect(back?.calendar).toHaveLength(SEASON_ROUNDS);
  });

  test('a stored real calendar of any length is kept and completes by its own length', () => {
    const career = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 4, WITH_REAL);
    const back = sanitizeCareer(JSON.parse(JSON.stringify(career)), WITH_REAL);
    expect(back?.calendar).toHaveLength(5);
    const done = {
      calendar: career.calendar,
      results: career.calendar.map((r) => ({ layoutId: r.layoutId, weather: 'clear' as const, classification: [], fastestLapDriverId: null })),
    };
    expect(isSeasonComplete(done)).toBe(true);
    const full = sanitizeCareer(JSON.parse(JSON.stringify({ ...career, results: done.results })), WITH_REAL);
    expect(full?.results).toHaveLength(5);
  });

  test('a lost calendar is regenerated according to the settings; next season keeps the choice', () => {
    const career = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 4, WITH_REAL);
    const lost = sanitizeCareer({ ...JSON.parse(JSON.stringify(career)), calendar: [] }, WITH_REAL);
    expect(lost?.calendar.map((r) => r.layoutId)).toEqual(career.calendar.map((r) => r.layoutId));
  });

  test('My Team follows the same rules', () => {
    const draft = {
      name: 'Test Team',
      shortName: 'TST',
      livery: { primary: '#ff5a1f', secondary: '#111111', accent: '#ffffff', pattern: 'classic' as const },
      powerUnit: 'Orion',
      identity: IDENTITY,
      teammateId: '',
      settings: DEFAULT_SEASON_SETTINGS,
    };
    const save = createMyTeam(draft, 3, WITH_REAL);
    expect(save.calendar.map((r) => r.layoutId)).toEqual(['shanghai', 'suzuka', 'bahrain', 'spa', 'monza']);
    expect(startNextMyTeamSeason(save, 9, WITH_REAL).calendar).toHaveLength(5);
    const { calendar: _c, ...old } = save.settings;
    const back = sanitizeMyTeam(JSON.parse(JSON.stringify({ ...save, settings: old, calendar: [] })), ORIGINALS);
    expect(back?.settings.calendar).toBe('original');
    expect(back?.calendar).toHaveLength(SEASON_ROUNDS);
  });
});

describe('track filter, facts and credits', () => {
  const metas = [{ id: 'a' }, { id: 'a-rev' }, { id: 'x', real: REAL }, { id: 'x-rev', real: REAL }];

  test('filterLayouts splits real / original and keeps order', () => {
    expect(filterLayouts(metas, 'all').map((l) => l.id)).toEqual(['a', 'a-rev', 'x', 'x-rev']);
    expect(filterLayouts(metas, 'real').map((l) => l.id)).toEqual(['x', 'x-rev']);
    expect(filterLayouts(metas, 'original').map((l) => l.id)).toEqual(['a', 'a-rev']);
    expect(filterLayouts([], 'real')).toEqual([]);
  });

  test('formatKm / directionLabel', () => {
    expect(formatKm(5412)).toBe('5.412 km');
    expect(formatKm(7004.4)).toBe('7.004 km');
    expect(directionLabel('clockwise')).toBe('順時針');
    expect(directionLabel('anticlockwise')).toBe('逆時針');
  });

  test('realFacts: length, turns, direction (flipped when reversed), first GP, feature labels', () => {
    const info: RealCircuitInfo = {
      ...REAL,
      features: [
        { kind: 'tunnel', at: 0.3, end: 0.35, name: 'tunnel', label: '隧道' },
        { kind: 'bridge', at: 0.5, name: 'bridge' },
        { kind: 'landmark', at: 0.6, name: 'marina', label: '碼頭' },
        { kind: 'landmark', at: 0.7, name: 'marina2', label: '碼頭' },
      ],
    };
    expect(featureLabels(info)).toEqual(['隧道', '碼頭']);
    const fwd = realFacts(info);
    expect(fwd.map((r) => r.label)).toEqual(['官方長度', '彎道數', '行車方向', '首屆大獎賽', '特色']);
    expect(fwd[0]?.value).toBe('5.412 km');
    expect(fwd[2]?.value).toBe('順時針');
    expect(realFacts(info, true)[2]?.value).toBe('逆時針');
    expect(realFacts(REAL).some((r) => r.label === '特色')).toBe(false);
  });

  test('circuitCredits lists only real defs with their source attribution', () => {
    const defs = [
      { name: '原創', location: '某處' },
      { name: '鈴鹿賽道', location: '鈴鹿', real: { ...REAL, source: 'OSM' } },
      { name: '蒙札賽道', location: '蒙札', real: { ...REAL, source: 'OSM 2' } },
    ];
    expect(circuitCredits(defs)).toEqual([
      { name: '鈴鹿賽道', location: '鈴鹿', source: 'OSM' },
      { name: '蒙札賽道', location: '蒙札', source: 'OSM 2' },
    ]);
    expect(circuitCredits([{ name: 'x', location: 'y' }])).toEqual([]);
  });
});
