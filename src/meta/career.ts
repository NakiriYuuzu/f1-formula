/**
 * Driver Career (pure logic): custom 'player' driver replaces the chosen team's second driver for a full
 * season (real or original calendar, see season.ts); points for every classified driver; driver rating growth; teammate head-to-head; season history;
 * part-level R&D of every team (meta/development.ts), the player's team paying with R&D points earned each round.
 */
import type { Assists, CarPartId, CarSetup, DriverDef, SessionKind, SessionResult, TireCompound } from '../core/types';
import { clamp } from '../core/math';
import { asRecord, bool, int, isRecord, num, sanitizeDriver, str } from './guards';
import {
  advanceDevelopment,
  canStartProject,
  careerRoundPoints,
  createSeasonDevelopment,
  nextProject,
  projectCost,
  rolloverDevelopment,
  rolloverRefund,
  sanitizeDevelopment,
  startProject,
  teamsByStrength,
  type SeasonDevelopment,
} from './development';
import {
  createPlayerDriver,
  PLAYER_DRIVER_ID,
  rosterDrivers,
  rosterTeams,
  rosterWithReplacement,
  usedNumbers,
  type PlayerIdentity,
  type Roster,
} from './roster';
import {
  attachSprint,
  createCalendar,
  type LayoutLike,
  driverStandings,
  recordRace,
  roundRequest,
  sanitizeCalendar,
  sanitizePendingSprint,
  sanitizeRoundRecords,
  sanitizeSeasonSettings,
  standingPosition,
  teamStandings,
  withPendingSprint,
  type CalendarRound,
  type PendingSprint,
  type RoundRecord,
  type SeasonSettings,
} from './season';
import type { SessionRequest } from './sessionBuilder';

/** Driver rating attributes, 0..100. */
export interface DriverRating {
  pace: number;
  racecraft: number;
  awareness: number;
  wet: number;
  consistency: number;
}

export const RATING_KEYS: readonly (keyof DriverRating)[] = ['pace', 'racecraft', 'awareness', 'wet', 'consistency'];
export const INITIAL_RATING: DriverRating = { pace: 72, racecraft: 70, awareness: 74, wet: 68, consistency: 72 };
const RATING_MIN = 40;
const RATING_MAX = 99;

export interface HeadToHead {
  qualiAhead: number;
  qualiBehind: number;
  raceAhead: number;
  raceBehind: number;
  /** round whose qualifying is already counted (-1 = none) and its outcome: a re-run replaces it */
  qualiRound: number;
  qualiRoundAhead: boolean;
}

const EMPTY_HEAD_TO_HEAD: HeadToHead = { qualiAhead: 0, qualiBehind: 0, raceAhead: 0, raceBehind: 0, qualiRound: -1, qualiRoundAhead: false };

export interface SeasonSummary {
  season: number;
  /** player's final championship position (0 = unclassified) */
  driverPosition: number;
  points: number;
  wins: number;
  podiums: number;
  /** player's team final constructor position */
  teamPosition: number;
  championId: string;
}

export interface CareerSave {
  driver: DriverDef;
  teamId: string;
  season: number;
  seed: number;
  calendar: CalendarRound[];
  /** one record per completed round (index = round) */
  results: RoundRecord[];
  rating: DriverRating;
  teammate: HeadToHead;
  history: SeasonSummary[];
  settings: SeasonSettings;
  /** part development of every roster team (the player's team is developed with rdPoints) */
  development: SeasonDevelopment;
  /** unspent R&D points (careerRoundPoints per round, spent by startCareerProject) */
  rdPoints: number;
  /** sprint of the current round already raced (its points join the round record at the race) */
  pendingSprint?: PendingSprint | null;
}

export function ratingOverall(r: DriverRating): number {
  const sum = RATING_KEYS.reduce((acc, k) => acc + r[k], 0);
  return Math.round(sum / RATING_KEYS.length);
}

/** DriverDef skill block (0..1) from a 0..100 rating. */
export function ratingToSkill(r: DriverRating): DriverDef['skill'] {
  const f = (v: number): number => clamp(v / 100, 0.4, 0.99);
  return { pace: f(r.pace), racecraft: f(r.racecraft), awareness: f(r.awareness), wet: f(r.wet), consistency: f(r.consistency) };
}

/** zh-TW validation messages for a custom driver identity (empty = valid). */
export function identityProblems(identity: PlayerIdentity, takenNumbers: ReadonlySet<number>): string[] {
  const problems: string[] = [];
  if (identity.firstName.trim().length === 0) problems.push('請輸入名字');
  if (identity.lastName.trim().length === 0) problems.push('請輸入姓氏');
  if (!/^[A-Z]{3}$/.test(identity.abbr)) problems.push('縮寫需為 3 個英文大寫字母');
  if (!Number.isInteger(identity.number) || identity.number < 1 || identity.number > 99) problems.push('車號需介於 1–99');
  else if (takenNumbers.has(identity.number)) problems.push(`車號 ${identity.number} 已被其他車手使用`);
  if (!/^[A-Z]{3}$/.test(identity.nationality)) problems.push('請選擇國籍');
  return problems;
}

/** Numbers unavailable to a career player joining `teamId` (the replaced driver's number becomes free). */
export function careerTakenNumbers(teamId: string): Set<number> {
  const team = rosterTeams().find((t) => t.id === teamId);
  const roster: Roster = { teams: [], drivers: rosterDrivers().filter((d) => d.teamId !== '') };
  return usedNumbers(roster, team ? [team.driverIds[1]] : []);
}

export function createCareer(
  identity: PlayerIdentity,
  teamId: string,
  settings: SeasonSettings,
  seed: number,
  layouts: readonly LayoutLike[],
): CareerSave {
  const team = rosterTeams().find((t) => t.id === teamId) ?? rosterTeams()[0];
  const id = team ? team.id : '';
  const rating = { ...INITIAL_RATING };
  return {
    driver: createPlayerDriver(identity, id, ratingToSkill(rating)),
    teamId: id,
    season: 1,
    seed: Math.floor(Math.abs(seed)) >>> 0,
    calendar: createCalendar(seed, layouts, sanitizeSeasonSettings(settings).calendar),
    results: [],
    rating,
    teammate: { ...EMPTY_HEAD_TO_HEAD },
    history: [],
    settings: sanitizeSeasonSettings(settings),
    development: createSeasonDevelopment(rosterTeams().map((t) => t.id)),
    rdPoints: 0,
  };
}

/** Session roster: standard field with the player in the team's second seat. */
export function careerRoster(save: CareerSave): { roster: Roster; replacedId: string } {
  const driver = { ...save.driver, skill: ratingToSkill(save.rating), teamId: save.teamId };
  return rosterWithReplacement(save.teamId, driver);
}

export function careerTeammateId(save: CareerSave): string {
  const team = rosterTeams().find((t) => t.id === save.teamId);
  return team ? team.driverIds[0] : '';
}

export function isSeasonComplete(save: Pick<CareerSave, 'calendar' | 'results'>): boolean {
  return save.calendar.length > 0 && save.results.length >= save.calendar.length;
}

export function currentRound(save: Pick<CareerSave, 'calendar' | 'results'>): CalendarRound | null {
  return isSeasonComplete(save) ? null : (save.calendar[save.results.length] ?? null);
}

/** Per-round seed (same for every session of the weekend). */
export function roundSeed(save: Pick<CareerSave, 'seed' | 'season' | 'results'>): number {
  return (save.seed + save.season * 7919 + save.results.length * 104729) >>> 0;
}

export function careerRequest(
  save: CareerSave,
  kind: SessionKind,
  fullLaps: number,
  player: { assists: Assists; setup: CarSetup; startCompound: TireCompound | null },
  gridOrder: string[] | null,
): SessionRequest | null {
  const round = currentRound(save);
  if (!round) return null;
  return roundRequest({
    mode: 'career',
    kind,
    round,
    fullLaps,
    settings: save.settings,
    roster: careerRoster(save).roster,
    seed: roundSeed(save),
    assists: player.assists,
    setup: player.setup,
    startCompound: player.startCompound,
    gridOrder,
    development: save.development,
  });
}

/** Expected finishing position of a car from its team's rank in the field (1-based): rating plus part development. */
export function expectedPosition(teamId: string, roster: Roster, development?: SeasonDevelopment): number {
  const ranked = teamsByStrength(roster.teams, development);
  const rank = Math.max(0, ranked.findIndex((t) => t.id === teamId));
  return rank * 2 + 1.5;
}

export interface RaceOutcome {
  /** null = did not finish */
  position: number | null;
  grid: number;
  expected: number;
  wet: boolean;
  penaltySec: number;
  trackLimitWarnings: number;
}

/** Rating growth after a race (bounded per race, attributes clamped to 40..99). */
export function updateRating(r: DriverRating, o: RaceOutcome): DriverRating {
  const next = { ...r };
  const round1 = (v: number): number => Math.round(clamp(v, RATING_MIN, RATING_MAX) * 10) / 10;
  if (o.position !== null) {
    next.pace = round1(r.pace + clamp((o.expected - o.position) * 0.35, -1.5, 2));
    next.racecraft = round1(r.racecraft + clamp((o.grid - o.position) * 0.25, -1.5, 2));
    if (o.wet) next.wet = round1(r.wet + clamp((o.expected - o.position) * 0.4 + 0.3, -1.5, 2.5));
    next.consistency = round1(r.consistency + 0.6);
  } else {
    next.consistency = round1(r.consistency - 2);
    next.pace = round1(r.pace - 0.3);
  }
  const clean = o.penaltySec <= 0 && o.trackLimitWarnings < 3;
  next.awareness = round1(r.awareness + (clean ? 0.8 : -1.2));
  return next;
}

/** Record the qualifying head-to-head with the teammate (once per round: re-running it replaces the count). */
export function applyCareerQualifying(save: CareerSave, order: readonly string[]): CareerSave {
  const me = order.indexOf(PLAYER_DRIVER_ID);
  const mate = order.indexOf(careerTeammateId(save));
  if (me < 0 || mate < 0) return save;
  const teammate = { ...save.teammate };
  const round = save.results.length;
  if (teammate.qualiRound === round) {
    if (teammate.qualiRoundAhead) teammate.qualiAhead = Math.max(0, teammate.qualiAhead - 1);
    else teammate.qualiBehind = Math.max(0, teammate.qualiBehind - 1);
  }
  const ahead = me < mate;
  if (ahead) teammate.qualiAhead++;
  else teammate.qualiBehind++;
  teammate.qualiRound = round;
  teammate.qualiRoundAhead = ahead;
  return { ...save, teammate };
}

export interface CareerRaceUpdate {
  save: CareerSave;
  record: RoundRecord;
  /** set when this race completed the season */
  summary: SeasonSummary | null;
}

/** Apply a sprint result: its points wait in the save until the round's race is recorded. */
export function applyCareerSprint(save: CareerSave, result: SessionResult): CareerSave {
  return { ...save, pendingSprint: withPendingSprint(save.results.length, result) };
}

/**
 * Apply a race result: round record (all drivers' points), rating, head-to-head, R&D points (careerRoundPoints), one
 * round of development for every team (seeded by the round, AI budgets by the constructor standings after this race),
 * season completion.
 */
export function applyCareerRace(save: CareerSave, result: SessionResult, trackLimitWarnings: number): CareerRaceUpdate {
  const record = attachSprint(recordRace(result), save.pendingSprint, save.results.length);
  const roster = careerRoster(save).roster;
  const mine = result.rows.find((r) => r.driverId === PLAYER_DRIVER_ID);
  const mateRow = result.rows.find((r) => r.driverId === careerTeammateId(save));
  let rating = save.rating;
  const teammate = { ...save.teammate };
  if (mine) {
    rating = updateRating(save.rating, {
      position: mine.status === 'retired' ? null : mine.position,
      grid: mine.gridPosition > 0 ? mine.gridPosition : mine.position,
      expected: expectedPosition(save.teamId, roster, save.development),
      wet: result.weather === 'lightRain' || result.weather === 'heavyRain',
      penaltySec: mine.penaltySec,
      trackLimitWarnings,
    });
    if (mateRow) {
      if (mine.position < mateRow.position) teammate.raceAhead++;
      else teammate.raceBehind++;
    }
  }
  const results = [...save.results, record].slice(0, save.calendar.length);
  const standings = teamStandings(results, roster.teams.map((t) => t.id)).map((s) => s.id);
  const sprintEntry = record.sprint?.find((e) => e.driverId === PLAYER_DRIVER_ID);
  const teamRank0 = standings.indexOf(save.teamId);
  const earned = careerRoundPoints({
    teamRank0: teamRank0 >= 0 ? teamRank0 : standings.length - 1,
    teamCount: standings.length,
    position: mine && mine.status !== 'retired' ? mine.position : null,
    fieldSize: result.rows.length,
    aheadOfTeammate: mine !== undefined && mateRow !== undefined && mine.position < mateRow.position,
    sprintPosition: sprintEntry && sprintEntry.status !== 'retired' ? sprintEntry.position : null,
  });
  const { pendingSprint: _spent, ...rest } = save;
  const next: CareerSave = {
    ...rest,
    results,
    rating,
    teammate,
    driver: { ...save.driver, skill: ratingToSkill(rating) },
    rdPoints: save.rdPoints + earned,
    // roundSeed(save) = this round (results not yet extended): save seed, season and round index
    development: advanceDevelopment(save.development, { seed: roundSeed(save), playerTeamIds: [save.teamId], standings }),
  };
  let summary: SeasonSummary | null = null;
  if (isSeasonComplete(next)) {
    summary = seasonSummary(next.results, next.season, PLAYER_DRIVER_ID, save.teamId, roster);
    next.history = [...save.history, summary].slice(-20);
  }
  return { save: next, record, summary };
}

export function seasonSummary(
  records: readonly RoundRecord[],
  season: number,
  driverId: string,
  teamId: string,
  roster: Roster,
): SeasonSummary {
  const drivers = driverStandings(records, roster.drivers.map((d) => d.id));
  const teams = teamStandings(records, roster.teams.map((t) => t.id));
  const me = drivers.find((s) => s.id === driverId);
  return {
    season,
    driverPosition: standingPosition(drivers, driverId),
    points: me ? me.points : 0,
    wins: me ? me.wins : 0,
    podiums: me ? me.podiums : 0,
    teamPosition: standingPosition(teams, teamId),
    championId: drivers[0] ? drivers[0].id : '',
  };
}

/** Start the player's team's next-level project of a part, paid with R&D points (PART_COST_POINTS); null when unaffordable / not startable. */
export function startCareerProject(save: CareerSave, part: CarPartId): CareerSave | null {
  const team = save.development.teams[save.teamId];
  const project = team && canStartProject(team, part) ? nextProject(team, part) : null;
  if (!project) return null;
  const cost = projectCost(project.level, 'points');
  if (save.rdPoints < cost) return null;
  const development = startProject(save.development, save.teamId, part);
  if (!development) return null;
  return { ...save, rdPoints: save.rdPoints - cost, development };
}

/**
 * Start the next season: new calendar, cleared results & head-to-head; rating, history and R&D points persist; every
 * part drops a level (rolloverDevelopment) and a running project re-targeted at a cheaper level refunds the difference
 * in R&D points (rolloverRefund).
 */
export function startNextCareerSeason(
  save: CareerSave,
  seed: number,
  layouts: readonly LayoutLike[],
): CareerSave {
  const { pendingSprint: _spent, ...rest } = save;
  const own = save.development.teams[save.teamId];
  return {
    ...rest,
    season: save.season + 1,
    seed: Math.floor(Math.abs(seed)) >>> 0,
    calendar: createCalendar(seed, layouts, save.settings.calendar),
    results: [],
    teammate: { ...EMPTY_HEAD_TO_HEAD },
    rdPoints: save.rdPoints + (own ? rolloverRefund(own, 'points') : 0),
    development: rolloverDevelopment(save.development, [save.teamId]),
  };
}

// ───────────────────────────── sanitizer ─────────────────────────────

const FALLBACK_PLAYER: DriverDef = {
  id: PLAYER_DRIVER_ID,
  firstName: '新星',
  lastName: '車手',
  abbr: 'NOV',
  number: 2,
  nationality: 'TWN',
  teamId: '',
  skill: ratingToSkill(INITIAL_RATING),
  helmet: { primary: '#ff5a1f', secondary: '#ffffff', accent: '#111111', pattern: 'classic' },
};

function sanitizeRating(v: unknown): DriverRating {
  const r = asRecord(v);
  return {
    pace: num(r.pace, RATING_MIN, RATING_MAX, INITIAL_RATING.pace),
    racecraft: num(r.racecraft, RATING_MIN, RATING_MAX, INITIAL_RATING.racecraft),
    awareness: num(r.awareness, RATING_MIN, RATING_MAX, INITIAL_RATING.awareness),
    wet: num(r.wet, RATING_MIN, RATING_MAX, INITIAL_RATING.wet),
    consistency: num(r.consistency, RATING_MIN, RATING_MAX, INITIAL_RATING.consistency),
  };
}

export function sanitizeHeadToHead(v: unknown): HeadToHead {
  const r = asRecord(v);
  return {
    qualiAhead: int(r.qualiAhead, 0, 999, 0),
    qualiBehind: int(r.qualiBehind, 0, 999, 0),
    raceAhead: int(r.raceAhead, 0, 999, 0),
    raceBehind: int(r.raceBehind, 0, 999, 0),
    qualiRound: int(r.qualiRound, -1, 999, -1),
    qualiRoundAhead: bool(r.qualiRoundAhead, false),
  };
}

export function sanitizeHistory(v: unknown): SeasonSummary[] {
  if (!Array.isArray(v)) return [];
  return v.slice(-20).map((item) => {
    const r = asRecord(item);
    return {
      season: int(r.season, 1, 999, 1),
      driverPosition: int(r.driverPosition, 0, 30, 0),
      points: int(r.points, 0, 9999, 0),
      wins: int(r.wins, 0, 99, 0),
      podiums: int(r.podiums, 0, 99, 0),
      teamPosition: int(r.teamPosition, 0, 30, 0),
      championId: str(r.championId, '', 32, true),
    };
  });
}

/**
 * Validate a stored career against the active roster. Unknown team → null (no career). A lost calendar is regenerated from the seed.
 * Development follows the roster (saves from before part-level R&D start every team at zero, with 0 R&D points).
 */
export function sanitizeCareer(
  v: unknown,
  layouts: readonly LayoutLike[],
): CareerSave | null {
  if (!isRecord(v)) return null;
  const teamId = str(v.teamId, '', 32);
  if (!rosterTeams().some((t) => t.id === teamId)) return null;
  const seed = int(v.seed, 0, 0xffffffff, 1);
  let calendar = sanitizeCalendar(v.calendar);
  const settings = sanitizeSeasonSettings(v.settings);
  if (calendar.length === 0) calendar = createCalendar(seed, layouts, settings.calendar);
  const rating = sanitizeRating(v.rating);
  const driver = sanitizeDriver(v.driver, FALLBACK_PLAYER);
  const results = sanitizeRoundRecords(v.results, calendar.length);
  const pending = sanitizePendingSprint(v.pendingSprint);
  return {
    driver: { ...driver, id: PLAYER_DRIVER_ID, teamId, skill: ratingToSkill(rating) },
    teamId,
    season: int(v.season, 1, 999, 1),
    seed,
    calendar,
    results,
    rating,
    teammate: sanitizeHeadToHead(v.teammate),
    history: sanitizeHistory(v.history),
    settings,
    development: sanitizeDevelopment(v.development, rosterTeams().map((t) => t.id)),
    rdPoints: int(v.rdPoints, 0, 1e6, 0),
    ...(pending && pending.round === results.length ? { pendingSprint: pending } : {}),
  };
}
