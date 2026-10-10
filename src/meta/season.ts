/**
 * Season bookkeeping shared by Driver Career and My Team: the calendar (real 2025-order circuits, the original
 * 10 rounds = 5 layouts forward + 5 reverse, or a seeded random draw from every layout), per-round race records, points (POINTS_TABLE) and driver / constructor standings with countback tie-breaks.
 */
import type {
  Assists,
  CarSetup,
  CarStatus,
  LayoutInfo,
  Regulation,
  ResultRow,
  SessionKind,
  SessionResult,
  SessionRules,
  TireCompound,
  WeatherKind,
} from '../core/types';
import { DEFAULT_RULES, POINTS_TABLE, SPRINT_POINTS } from '../core/defaults';
import { nextRandom, type RngState } from '../core/math';
import { asRecord, bool, int, isRecord, oneOf, sanitizeRules, str } from './guards';
import {
  AI_DIFFICULTY_MAX,
  AI_DIFFICULTY_MIN,
  LAPS_CHOICES,
  QUALIFYING_TYPES,
  resolveLaps,
  WEATHER_CHOICES,
  WEEKEND_FORMATS,
  weekendSessions,
  withSprint,
  type LapsChoice,
  type QualifyingType,
  type WeatherChoice,
  type WeekendFormat,
  type WeekendStep,
} from './options';
import { PLAYER_DRIVER_ID, type Roster } from './roster';
import type { SessionRequest } from './sessionBuilder';
import { developmentGains, type SeasonDevelopment } from './development';

/** Rounds of the original-circuit calendar. The real calendar has one round per registered real circuit. */
export const SEASON_ROUNDS = 10;

/** Upper bound of a stored calendar (save validation). */
export const MAX_CALENDAR_ROUNDS = 30;

/** Rounds of a random calendar (as many as the real calendar). */
export const RANDOM_ROUNDS = 12;

/** Chance that a random-calendar circuit is visited in its reverse layout. */
const RANDOM_REVERSE_CHANCE = 0.3;

/** Which circuits a season calendar is made of. */
export type CalendarKind = 'real' | 'original' | 'random';
export const CALENDAR_KINDS: readonly CalendarKind[] = ['real', 'original', 'random'];

/** Real circuit def ids in 2025 calendar order (only registered ones are used). */
export const REAL_CALENDAR_ORDER: readonly string[] = [
  'shanghai',
  'suzuka',
  'bahrain',
  'monaco',
  'silverstone',
  'spa',
  'monza',
  'singapore',
  'cota',
  'interlagos',
  'las-vegas',
  'yas-marina',
];

/** Real circuits that host a sprint weekend in the real calendar (2025 sprint venues). */
export const REAL_SPRINT_VENUES: readonly string[] = ['shanghai', 'spa', 'cota', 'interlagos'];

export interface CalendarRound {
  layoutId: string;
  /** forecast chosen when the calendar is created */
  weather: WeatherChoice;
}

/** What a calendar needs to know of a layout (`real` marks real-world circuits). */
export type LayoutLike = Pick<LayoutInfo, 'id' | 'defId' | 'reverse'> & { real?: unknown };

function seededWeather(rng: RngState): WeatherChoice {
  const r = nextRandom(rng);
  if (r < 0.62) return 'clear';
  if (r < 0.8) return 'overcast';
  if (r < 0.88) return 'lightRain';
  if (r < 0.94) return 'dynamic';
  return 'heavyRain';
}

/** Forward layouts of the registered real circuits in 2025 calendar order (unregistered ids are skipped). */
export function realCalendarLayouts<T extends LayoutLike>(layouts: readonly T[]): T[] {
  const out: T[] = [];
  for (const defId of REAL_CALENDAR_ORDER) {
    const l = layouts.find((x) => x.defId === defId && !x.reverse);
    if (l) out.push(l);
  }
  return out;
}

/**
 * Random calendar: RANDOM_ROUNDS distinct circuits (real and original mixed) in a seeded order, each run forward or (by
 * RANDOM_REVERSE_CHANCE) reverse. With fewer circuits than rounds the list repeats in the same order with the other
 * direction, so a circuit never runs twice in a row unless only one is registered.
 */
function randomCalendarPool(layouts: readonly LayoutLike[], rng: RngState): LayoutLike[] {
  const byCircuit = new Map<string, LayoutLike[]>();
  for (const l of layouts) byCircuit.set(l.defId, [...(byCircuit.get(l.defId) ?? []), l]);
  const circuits = [...byCircuit.values()];
  for (let i = circuits.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(rng) * (i + 1));
    const tmp = circuits[i] as LayoutLike[];
    circuits[i] = circuits[j] as LayoutLike[];
    circuits[j] = tmp;
  }
  // per circuit: [direction of its first visit, the other direction]
  const picks = circuits.map((variants) => {
    const fwd = variants.find((l) => !l.reverse) ?? (variants[0] as LayoutLike);
    const rev = variants.find((l) => l.reverse);
    if (!rev) return [fwd];
    return nextRandom(rng) < RANDOM_REVERSE_CHANCE ? [rev, fwd] : [fwd, rev];
  });
  const pool: LayoutLike[] = [];
  for (let i = 0; pool.length < RANDOM_ROUNDS; i++) {
    const p = picks[i % picks.length] as LayoutLike[];
    pool.push(p[Math.floor(i / picks.length) % p.length] as LayoutLike);
  }
  return pool;
}

/**
 * Original calendar: 10 rounds: 5 forward layouts + 5 reverse layouts in a seeded order where the same circuit never runs twice in a
 * row (when avoidable). Missing layouts are filled by cycling the available ones; no layouts → empty calendar.
 * kind 'real' = forward layouts of the registered real circuits in 2025 order (falls back to the original logic
 * when none is registered). kind 'random' = see randomCalendarPool (every registered layout is a candidate).
 */
export function createCalendar(seed: number, layouts: readonly LayoutLike[], kind: CalendarKind = 'original'): CalendarRound[] {
  if (layouts.length === 0) return [];
  if (kind === 'real') {
    const real = realCalendarLayouts(layouts);
    if (real.length > 0) {
      const rng: RngState = { s: (Math.floor(Math.abs(seed)) ^ 0x2545f491) >>> 0 };
      return real.map((l) => ({ layoutId: l.id, weather: seededWeather(rng) }));
    }
  }
  if (kind === 'random') {
    const rng: RngState = { s: (Math.floor(Math.abs(seed)) ^ 0x2545f491) >>> 0 };
    return randomCalendarPool(layouts, rng).map((l) => ({ layoutId: l.id, weather: seededWeather(rng) }));
  }
  // original circuits only (real defs carry `real`); fall back to everything when nothing else is registered
  const originals = layouts.filter((l) => !l.real);
  layouts = originals.length > 0 ? originals : layouts;
  const forward = layouts.filter((l) => !l.reverse).slice(0, SEASON_ROUNDS / 2);
  const reverse = layouts.filter((l) => l.reverse).slice(0, SEASON_ROUNDS / 2);
  const pool: LayoutLike[] = [...forward, ...reverse];
  for (let i = 0; pool.length < SEASON_ROUNDS; i++) pool.push(layouts[i % layouts.length] as LayoutLike);

  const rng: RngState = { s: (Math.floor(Math.abs(seed)) ^ 0x2545f491) >>> 0 };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(rng) * (i + 1));
    const tmp = pool[i] as LayoutLike;
    pool[i] = pool[j] as LayoutLike;
    pool[j] = tmp;
  }
  // avoid back-to-back rounds on the same circuit (greedy: swap with the next different circuit; later
  // indices are re-checked as the loop advances)
  for (let i = 1; i < pool.length; i++) {
    const prev = pool[i - 1] as LayoutLike;
    if ((pool[i] as LayoutLike).defId !== prev.defId) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const cand = pool[j] as LayoutLike;
      if (cand.defId !== prev.defId) {
        pool[j] = pool[i] as LayoutLike;
        pool[i] = cand;
        break;
      }
    }
  }
  return pool.map((l) => ({ layoutId: l.id, weather: seededWeather(rng) }));
}

/** One classified car of a round. */
export interface RoundEntry {
  driverId: string;
  teamId: string;
  position: number;
  gridPosition: number;
  points: number;
  status: CarStatus;
}

export interface RoundRecord {
  layoutId: string;
  weather: WeatherKind;
  classification: RoundEntry[];
  fastestLapDriverId: string | null;
  /** sprint race of the weekend (points only count towards the standings; no win / podium credit) */
  sprint?: RoundEntry[];
}

/** A sprint already raced for `round` whose race is still to come (stored in the career / My Team save). */
export interface PendingSprint {
  round: number;
  entries: RoundEntry[];
}

/** Points of a result row: the runtime's value when valid, else the points table by position (finishers only). */
export function pointsForRow(row: ResultRow, sprint = false): number {
  if (typeof row.points === 'number' && Number.isFinite(row.points) && row.points >= 0) return row.points;
  if (row.status === 'retired') return 0;
  return (sprint ? SPRINT_POINTS : POINTS_TABLE)[row.position - 1] ?? 0;
}

/** Classification of a sprint race (points from the sprint table). */
export function recordSprint(result: SessionResult): RoundEntry[] {
  return [...result.rows]
    .sort((a, b) => a.position - b.position)
    .map((r) => ({
      driverId: r.driverId,
      teamId: r.teamId,
      position: r.position,
      gridPosition: r.gridPosition,
      points: pointsForRow(r, true),
      status: r.status,
    }));
}

/** Store the sprint of the current round; the following race record picks it up. */
export function withPendingSprint(round: number, result: SessionResult): PendingSprint {
  return { round, entries: recordSprint(result) };
}

/** Attach a pending sprint to the race record of the same round. */
export function attachSprint(record: RoundRecord, pending: PendingSprint | null | undefined, round: number): RoundRecord {
  return pending && pending.round === round && pending.entries.length > 0 ? { ...record, sprint: pending.entries.map((e) => ({ ...e })) } : record;
}

/** Turn a race result into a round record. */
export function recordRace(result: SessionResult): RoundRecord {
  const rows = [...result.rows].sort((a, b) => a.position - b.position);
  const fastest = result.fastestLap ? rows.find((r) => r.carId === result.fastestLap?.carId) : undefined;
  return {
    layoutId: result.layoutId,
    weather: result.weather,
    classification: rows.map((r) => ({
      driverId: r.driverId,
      teamId: r.teamId,
      position: r.position,
      gridPosition: r.gridPosition,
      points: pointsForRow(r),
      status: r.status,
    })),
    fastestLapDriverId: fastest ? fastest.driverId : null,
  };
}

export interface StandingEntry {
  id: string;
  points: number;
  wins: number;
  podiums: number;
  /** best finishing position (Infinity-free: 0 = none yet) */
  best: number;
  /** finishes per position (index 0 = P1) for countback */
  finishes: number[];
}

function compareStanding(a: StandingEntry, b: StandingEntry): number {
  if (b.points !== a.points) return b.points - a.points;
  const n = Math.max(a.finishes.length, b.finishes.length);
  for (let i = 0; i < n; i++) {
    const d = (b.finishes[i] ?? 0) - (a.finishes[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function emptyEntry(id: string): StandingEntry {
  return { id, points: 0, wins: 0, podiums: 0, best: 0, finishes: [] };
}

/** Sprint points only: sprint wins / podiums are not counted. */
function addSprint(e: StandingEntry, entry: RoundEntry): void {
  e.points += entry.points;
}

function addFinish(e: StandingEntry, entry: RoundEntry): void {
  e.points += entry.points;
  if (entry.status === 'retired' || entry.position < 1) return;
  if (entry.position === 1) e.wins++;
  if (entry.position <= 3) e.podiums++;
  if (e.best === 0 || entry.position < e.best) e.best = entry.position;
  while (e.finishes.length < entry.position) e.finishes.push(0);
  e.finishes[entry.position - 1] = (e.finishes[entry.position - 1] ?? 0) + 1;
}

/** Driver standings over the given rounds; `driverIds` are always listed (0 points if absent). */
export function driverStandings(records: readonly RoundRecord[], driverIds: readonly string[]): StandingEntry[] {
  const map = new Map<string, StandingEntry>();
  for (const id of driverIds) map.set(id, emptyEntry(id));
  for (const rec of records) {
    for (const entry of rec.classification) {
      let e = map.get(entry.driverId);
      if (!e) {
        e = emptyEntry(entry.driverId);
        map.set(entry.driverId, e);
      }
      addFinish(e, entry);
    }
    for (const entry of rec.sprint ?? []) {
      let e = map.get(entry.driverId);
      if (!e) {
        e = emptyEntry(entry.driverId);
        map.set(entry.driverId, e);
      }
      addSprint(e, entry);
    }
  }
  return [...map.values()].sort(compareStanding);
}

/** Constructor standings: sum of both cars' points; countback uses each car's finishes. */
export function teamStandings(records: readonly RoundRecord[], teamIds: readonly string[]): StandingEntry[] {
  const map = new Map<string, StandingEntry>();
  for (const id of teamIds) map.set(id, emptyEntry(id));
  for (const rec of records) {
    for (const entry of rec.classification) {
      let e = map.get(entry.teamId);
      if (!e) {
        e = emptyEntry(entry.teamId);
        map.set(entry.teamId, e);
      }
      addFinish(e, entry);
    }
    for (const entry of rec.sprint ?? []) {
      let e = map.get(entry.teamId);
      if (!e) {
        e = emptyEntry(entry.teamId);
        map.set(entry.teamId, e);
      }
      addSprint(e, entry);
    }
  }
  return [...map.values()].sort(compareStanding);
}

/** 1-based standing position of an id (0 when absent). */
export function standingPosition(standings: readonly StandingEntry[], id: string): number {
  return standings.findIndex((s) => s.id === id) + 1;
}

// ───────────────────────────── sanitizers ─────────────────────────────

const CAR_STATUSES: readonly CarStatus[] = ['grid', 'running', 'pitting', 'finished', 'retired'];
const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'overcast', 'lightRain', 'heavyRain'];

export function sanitizeCalendar(v: unknown): CalendarRound[] {
  if (!Array.isArray(v)) return [];
  const out: CalendarRound[] = [];
  for (const item of v.slice(0, MAX_CALENDAR_ROUNDS)) {
    const r = asRecord(item);
    const layoutId = str(r.layoutId, '', 64);
    if (!layoutId) return [];
    out.push({ layoutId, weather: oneOf(r.weather, WEATHER_CHOICES, 'clear') });
  }
  return out;
}

function sanitizeEntries(v: unknown): RoundEntry[] {
  const out: RoundEntry[] = [];
  if (!Array.isArray(v)) return out;
  for (const raw of v.slice(0, 30)) {
    const e = asRecord(raw);
    const driverId = str(e.driverId, '', 32);
    const teamId = str(e.teamId, '', 32);
    if (!driverId || !teamId) continue;
    out.push({
      driverId,
      teamId,
      position: int(e.position, 0, 30, 0),
      gridPosition: int(e.gridPosition, 0, 30, 0),
      points: int(e.points, 0, 50, 0),
      status: oneOf(e.status, CAR_STATUSES, 'finished'),
    });
  }
  return out;
}

export function sanitizeRoundRecords(v: unknown, maxRounds: number): RoundRecord[] {
  if (!Array.isArray(v)) return [];
  const out: RoundRecord[] = [];
  for (const item of v.slice(0, maxRounds)) {
    if (!isRecord(item) || !Array.isArray(item.classification)) break;
    const sprint = sanitizeEntries(item.sprint);
    out.push({
      layoutId: str(item.layoutId, '', 64),
      weather: oneOf(item.weather, WEATHER_KINDS, 'clear'),
      classification: sanitizeEntries(item.classification),
      fastestLapDriverId: typeof item.fastestLapDriverId === 'string' ? item.fastestLapDriverId : null,
      ...(sprint.length > 0 ? { sprint } : {}),
    });
  }
  return out;
}

export function sanitizePendingSprint(v: unknown): PendingSprint | null {
  if (!isRecord(v)) return null;
  const entries = sanitizeEntries(v.entries);
  return entries.length > 0 ? { round: int(v.round, 0, 99, 0), entries } : null;
}

// ───────────────────────────── season settings & round requests ─────────────────────────────

/** Weekend settings of a career / My Team season (chosen in the wizard, editable in the hub). */
export interface SeasonSettings {
  aiDifficulty: number;
  laps: LapsChoice;
  format: WeekendFormat;
  qualifying: QualifyingType;
  regulation: Regulation;
  rules: SessionRules;
  /** sprint weekends: real calendar = the 2025 sprint venues, original / random calendar = rounds 3, 6 and 9 */
  sprintWeekends: boolean;
  /** which circuits the calendar of a NEW season uses (stored calendars are never rewritten) */
  calendar: CalendarKind;
}

/** 1-based rounds that are sprint weekends on an original calendar when SeasonSettings.sprintWeekends is on. */
export const SPRINT_ROUNDS: readonly number[] = [3, 6, 9];

/** Circuit (def) id of a layout id (`${defId}-rev` → defId). */
function defIdOfLayout(layoutId: string): string {
  return layoutId.endsWith('-rev') ? layoutId.slice(0, -4) : layoutId;
}

/**
 * Is the 0-based round index a sprint weekend under these settings? When the round list is a real calendar
 * (every round is a real circuit) the real sprint venues apply; otherwise (or without a calendar) rounds 3 / 6 / 9.
 */
export function isSprintRound(
  settings: Pick<SeasonSettings, 'sprintWeekends'>,
  roundIndex: number,
  calendar: readonly Pick<CalendarRound, 'layoutId'>[] = [],
): boolean {
  if (!settings.sprintWeekends) return false;
  if (calendar.length > 0 && calendar.every((r) => REAL_CALENDAR_ORDER.includes(defIdOfLayout(r.layoutId)))) {
    const round = calendar[roundIndex];
    return round !== undefined && REAL_SPRINT_VENUES.includes(defIdOfLayout(round.layoutId));
  }
  return SPRINT_ROUNDS.includes(roundIndex + 1);
}

/** Sessions of a season round: the chosen format, with a sprint before the race on sprint rounds. */
export function seasonWeekend(settings: SeasonSettings, roundIndex: number, calendar: readonly Pick<CalendarRound, 'layoutId'>[] = []): WeekendStep[] {
  const steps = weekendSessions(settings.format);
  return isSprintRound(settings, roundIndex, calendar) ? withSprint(steps) : steps;
}

/** Weekend formats selectable for a season. */
export const SEASON_FORMATS: readonly WeekendFormat[] = WEEKEND_FORMATS.filter((f) => f !== 'sprint');

export const DEFAULT_SEASON_SETTINGS: SeasonSettings = {
  aiDifficulty: 80,
  laps: 'l5',
  format: 'qualiRace',
  qualifying: 'oneShot',
  regulation: '2025',
  rules: { ...DEFAULT_RULES },
  sprintWeekends: false,
  calendar: 'real',
};

export function sanitizeSeasonSettings(v: unknown): SeasonSettings {
  const r = asRecord(v);
  const d = DEFAULT_SEASON_SETTINGS;
  return {
    aiDifficulty: int(r.aiDifficulty, AI_DIFFICULTY_MIN, AI_DIFFICULTY_MAX, d.aiDifficulty),
    laps: oneOf(r.laps, LAPS_CHOICES, d.laps),
    // a season has no sprint *format*: sprint weekends come from `sprintWeekends`
    format: oneOf(r.format, SEASON_FORMATS, d.format),
    qualifying: oneOf(r.qualifying, QUALIFYING_TYPES, d.qualifying),
    regulation: oneOf(r.regulation, ['2025', '2026'] as const, d.regulation),
    rules: sanitizeRules(r.rules, d.rules),
    sprintWeekends: bool(r.sprintWeekends, d.sprintWeekends),
    // saves without the field predate the real calendar: their calendar stays the original one
    calendar: oneOf(r.calendar, CALENDAR_KINDS, 'original'),
  };
}

export interface RoundRequestArgs {
  mode: 'career' | 'myTeam';
  kind: SessionKind;
  round: CalendarRound;
  /** full race distance of the round's layout (TrackDef.fullLaps) */
  fullLaps: number;
  settings: SeasonSettings;
  roster: Roster;
  seed: number;
  assists: Assists;
  setup: CarSetup;
  startCompound: TireCompound | null;
  gridOrder: string[] | null;
  /** part development of every team (its gains go to SessionConfig.development) */
  development?: SeasonDevelopment;
}

/** Session request for a season round; the human always drives the custom 'player' driver. */
export function roundRequest(a: RoundRequestArgs): SessionRequest {
  const player = a.roster.drivers.find((d) => d.id === PLAYER_DRIVER_ID);
  const request: SessionRequest = {
    mode: a.mode,
    kind: a.kind,
    layoutId: a.round.layoutId,
    raceLaps: resolveLaps(a.settings.laps, a.fullLaps),
    weather: a.round.weather,
    timeOfDay: 'auto',
    regulation: a.settings.regulation,
    aiDifficulty: a.settings.aiDifficulty,
    qualifying: a.settings.qualifying,
    rules: { ...a.settings.rules },
    seed: a.seed,
    players: [
      {
        playerIndex: 0,
        driverId: PLAYER_DRIVER_ID,
        teamId: player ? player.teamId : '',
        setup: { ...a.setup },
        assists: { ...a.assists },
        startCompound: a.startCompound,
      },
    ],
    roster: a.roster,
    aiCount: null,
    gridOrder: a.kind === 'race' ? a.gridOrder : null,
    playerStartPosition: null,
    ghost: null,
    objective: null,
  };
  if (a.development) request.development = developmentGains(a.development);
  return request;
}
