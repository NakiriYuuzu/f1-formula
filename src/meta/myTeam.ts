/**
 * My Team (pure logic): the player's own extra team 'myteam' — name, livery, power-unit supplier, signed reserve
 * teammate, budget, and R&D departments whose levels raise the team rating and the createCarSpec `upgrade` bonus.
 */
import type {
  Assists,
  CarSetup,
  DriverDef,
  Livery,
  SessionKind,
  SessionResult,
  TeamDef,
  TireCompound,
} from '../core/types';
import { clamp } from '../core/math';
import { asRecord, int, isRecord, num, sanitizeDriver, sanitizeLivery, str } from './guards';
import {
  cloneDriver,
  cloneLivery,
  createPlayerDriver,
  MY_TEAM_ID,
  PLAYER_DRIVER_ID,
  reserveDrivers,
  rosterDrivers,
  rosterTeams,
  rosterWithExtraTeam,
  teamStrength,
  type PlayerIdentity,
  type Roster,
} from './roster';
import { activeRosterPack } from './rosterPack';
import {
  attachSprint,
  createCalendar,
  type LayoutLike,
  recordRace,
  roundRequest,
  sanitizeCalendar,
  sanitizePendingSprint,
  sanitizeRoundRecords,
  sanitizeSeasonSettings,
  teamStandings,
  standingPosition,
  withPendingSprint,
  type CalendarRound,
  type PendingSprint,
  type RoundRecord,
  type SeasonSettings,
} from './season';
import {
  INITIAL_RATING,
  isSeasonComplete,
  ratingToSkill,
  roundSeed,
  sanitizeHistory,
  seasonSummary,
  type SeasonSummary,
} from './career';
import type { SessionRequest } from './sessionBuilder';

export type RdDepartment = 'aero' | 'power' | 'chassis' | 'reliability';
export const RD_DEPARTMENTS: readonly RdDepartment[] = ['aero', 'power', 'chassis', 'reliability'];
export const RD_MAX_LEVEL = 5;
/** Cost (M) of upgrading FROM level i to i + 1. */
export const RD_COSTS: readonly number[] = [3, 4.5, 6, 8, 10];
/** Rating a fully developed department reaches (each level closes 1/5 of the gap from the base). */
export const RD_CAP = 0.99;
/** createCarSpec `upgrade` range is 0..0.1. */
export const MAX_UPGRADE_BONUS = 0.1;

export const START_BUDGET = 40;
const BASE_AERO = 0.86;
const BASE_CHASSIS = 0.86;

export interface PowerUnitOption {
  /** supplier name written to TeamDef.powerUnit */
  id: string;
  power: number;
  reliability: number;
  /** yearly cost (M) */
  cost: number;
  /** zh-TW blurb */
  blurb: string;
}

/** Fictional suppliers already used by the field (see data/teams.ts). */
export const POWER_UNITS: readonly PowerUnitOption[] = [
  { id: 'Kairos', power: 0.95, reliability: 0.91, cost: 9, blurb: '最強輸出，但價格高昂、耐久性普通' },
  { id: 'Helion', power: 0.94, reliability: 0.94, cost: 8, blurb: '輸出與可靠度均衡的頂級動力' },
  { id: 'Orion', power: 0.91, reliability: 0.93, cost: 6, blurb: '中段班常見選擇，性價比佳' },
  { id: 'Volta', power: 0.89, reliability: 0.95, cost: 4.5, blurb: '最便宜、最可靠，但極速吃虧' },
];

export type RdLevels = Record<RdDepartment, number>;

export interface IncomeLine {
  label: string;
  amount: number;
}

export interface MyTeamSave {
  name: string;
  /** 3 uppercase letters */
  shortName: string;
  livery: Livery;
  powerUnit: string;
  driver: DriverDef;
  teammateId: string;
  /** M (millions) */
  budget: number;
  rd: RdLevels;
  season: number;
  seed: number;
  calendar: CalendarRound[];
  results: RoundRecord[];
  history: SeasonSummary[];
  settings: SeasonSettings;
  /** income breakdown of the latest round */
  lastIncome: IncomeLine[];
  /** sprint of the current round already raced (its points join the round record at the race) */
  pendingSprint?: PendingSprint | null;
}

export interface MyTeamDraft {
  name: string;
  shortName: string;
  livery: Livery;
  powerUnit: string;
  identity: PlayerIdentity;
  teammateId: string;
  settings: SeasonSettings;
}

/** Suppliers on offer: the active roster pack's, else the built-in ones. */
export function powerUnitOptions(): readonly PowerUnitOption[] {
  const fromPack = activeRosterPack()?.powerUnits ?? [];
  return fromPack.length > 0 ? fromPack : POWER_UNITS;
}

export function powerUnitOption(id: string): PowerUnitOption {
  const options = powerUnitOptions();
  return options.find((p) => p.id === id) ?? (options[Math.min(2, options.length - 1)] as PowerUnitOption);
}

/** Signing fee / salary (M) of a reserve driver: better drivers cost more. */
export function reserveSalary(driver: DriverDef): number {
  const s = driver.skill;
  const avg = (s.pace + s.racecraft + s.awareness + s.wet + s.consistency) / 5;
  return Math.round(clamp(1.5 + (avg - 0.83) * 60, 1, 4) * 10) / 10;
}

export function reserveById(id: string): DriverDef | undefined {
  return reserveDrivers().find((d) => d.id === id);
}

/** zh-TW validation messages for team name / short name. */
export function teamNameProblems(name: string, shortName: string): string[] {
  const problems: string[] = [];
  if (name.trim().length < 2) problems.push('車隊名稱至少 2 個字');
  if (!/^[A-Z]{3}$/.test(shortName)) problems.push('車隊縮寫需為 3 個英文大寫字母');
  else if (rosterTeams().some((t) => t.shortName === shortName)) problems.push(`縮寫 ${shortName} 已被其他車隊使用`);
  return problems;
}

/** Starting budget after the power-unit contract and the teammate's salary. */
export function startingBudget(powerUnit: string, teammateId: string): number {
  const mate = reserveById(teammateId);
  return Math.round((START_BUDGET - powerUnitOption(powerUnit).cost - (mate ? reserveSalary(mate) : 0)) * 10) / 10;
}

export function createMyTeam(
  draft: MyTeamDraft,
  seed: number,
  layouts: readonly LayoutLike[],
): MyTeamSave {
  const reserves = reserveDrivers();
  const mate = reserves.find((d) => d.id === draft.teammateId) ?? reserves[0];
  return {
    name: draft.name.trim().slice(0, 24),
    shortName: draft.shortName,
    livery: cloneLivery(draft.livery),
    powerUnit: powerUnitOption(draft.powerUnit).id,
    driver: createPlayerDriver(draft.identity, MY_TEAM_ID, ratingToSkill(INITIAL_RATING)),
    teammateId: mate ? mate.id : '',
    budget: startingBudget(draft.powerUnit, mate ? mate.id : ''),
    rd: { aero: 0, power: 0, chassis: 0, reliability: 0 },
    season: 1,
    seed: Math.floor(Math.abs(seed)) >>> 0,
    calendar: createCalendar(seed, layouts, sanitizeSeasonSettings(draft.settings).calendar),
    results: [],
    history: [],
    settings: sanitizeSeasonSettings(draft.settings),
    lastIncome: [],
  };
}

/** Department rating before any R&D (car base / power-unit values). */
function departmentBase(powerUnit: string, dept: RdDepartment): number {
  const pu = powerUnitOption(powerUnit);
  switch (dept) {
    case 'aero':
      return BASE_AERO;
    case 'chassis':
      return BASE_CHASSIS;
    case 'power':
      return pu.power;
    case 'reliability':
      return pu.reliability;
  }
}

/** Rating of a department at an R&D level (0..RD_MAX_LEVEL), always ≤ RD_CAP. */
export function departmentRating(powerUnit: string, dept: RdDepartment, level: number): number {
  const base = departmentBase(powerUnit, dept);
  const l = clamp(Number.isFinite(level) ? Math.round(level) : 0, 0, RD_MAX_LEVEL);
  return Math.round((base + (Math.max(base, RD_CAP) - base) * (l / RD_MAX_LEVEL)) * 10000) / 10000;
}

/** Team rating from the base car, power unit and R&D levels. */
export function myTeamRating(save: Pick<MyTeamSave, 'powerUnit' | 'rd'>): TeamDef['rating'] {
  return {
    aero: departmentRating(save.powerUnit, 'aero', save.rd.aero),
    power: departmentRating(save.powerUnit, 'power', save.rd.power),
    chassis: departmentRating(save.powerUnit, 'chassis', save.rd.chassis),
    reliability: departmentRating(save.powerUnit, 'reliability', save.rd.reliability),
  };
}

function bonusFromTotal(totalLevels: number): number {
  const t = clamp(totalLevels, 0, RD_DEPARTMENTS.length * RD_MAX_LEVEL) / (RD_DEPARTMENTS.length * RD_MAX_LEVEL);
  return Math.round(t * MAX_UPGRADE_BONUS * 1000) / 1000;
}

/** createCarSpec `upgrade` argument (0..0.1) from the total R&D progress. */
export function upgradeBonus(save: Pick<MyTeamSave, 'rd'>): number {
  return bonusFromTotal(RD_DEPARTMENTS.reduce((acc, k) => acc + clamp(save.rd[k], 0, RD_MAX_LEVEL), 0));
}

/**
 * createCarSpec `upgrade` (0..0.1) for any team of a SessionConfig: 0 for every team except 'myteam', whose R&D
 * levels are recovered from its ratings. Lets the race runtime call
 * `createCarSpec(team, setup, regulation, teamUpgradeBonus(team))` without access to the save.
 */
export function teamUpgradeBonus(team: TeamDef): number {
  if (team.id !== MY_TEAM_ID) return 0;
  let total = 0;
  for (const dept of RD_DEPARTMENTS) {
    const actual = team.rating[dept];
    if (!Number.isFinite(actual)) continue;
    let best = 0;
    let bestErr = Infinity;
    for (let level = 0; level <= RD_MAX_LEVEL; level++) {
      const err = Math.abs(departmentRating(team.powerUnit, dept, level) - actual);
      if (err < bestErr) {
        bestErr = err;
        best = level;
      }
    }
    total += best;
  }
  return bonusFromTotal(total);
}

export function myTeamDef(save: MyTeamSave): TeamDef {
  return {
    id: MY_TEAM_ID,
    name: save.name,
    shortName: save.shortName,
    livery: cloneLivery(save.livery),
    base: '新星工坊',
    powerUnit: powerUnitOption(save.powerUnit).id,
    rating: myTeamRating(save),
    driverIds: [PLAYER_DRIVER_ID, save.teammateId],
  };
}

export function myTeamRoster(save: MyTeamSave): Roster {
  const mate = rosterDrivers().find((d) => d.id === save.teammateId);
  const drivers: DriverDef[] = [{ ...cloneDriver(save.driver), id: PLAYER_DRIVER_ID, teamId: MY_TEAM_ID }];
  if (mate) drivers.push({ ...cloneDriver(mate), teamId: MY_TEAM_ID });
  return rosterWithExtraTeam(myTeamDef(save), drivers);
}

/** Cost (M) of the next level of a department, or null when maxed. */
export function rdUpgradeCost(level: number): number | null {
  if (!Number.isFinite(level) || level < 0 || level >= RD_MAX_LEVEL) return null;
  return RD_COSTS[Math.floor(level)] ?? null;
}

/** Buy one R&D level; null when maxed or unaffordable. */
export function purchaseUpgrade(save: MyTeamSave, dept: RdDepartment): MyTeamSave | null {
  const cost = rdUpgradeCost(save.rd[dept]);
  if (cost === null || save.budget + 1e-9 < cost) return null;
  return {
    ...save,
    budget: Math.round((save.budget - cost) * 10) / 10,
    rd: { ...save.rd, [dept]: save.rd[dept] + 1 },
  };
}

export function isAnyDepartmentMaxed(save: Pick<MyTeamSave, 'rd'>): boolean {
  return RD_DEPARTMENTS.some((k) => save.rd[k] >= RD_MAX_LEVEL);
}

/** Sign a different reserve as teammate (pays the salary as signing fee); null when unaffordable / invalid. */
export function signTeammate(save: MyTeamSave, reserveId: string): MyTeamSave | null {
  if (reserveId === save.teammateId) return null;
  const mate = reserveById(reserveId);
  if (!mate) return null;
  const fee = reserveSalary(mate);
  if (save.budget + 1e-9 < fee) return null;
  return { ...save, teammateId: mate.id, budget: Math.round((save.budget - fee) * 10) / 10 };
}

/** Sponsor target: best car should finish at or above this position. */
export function sponsorTarget(save: MyTeamSave): number {
  const roster = myTeamRoster(save);
  const ranked = [...roster.teams].sort((a, b) => teamStrength(b) - teamStrength(a));
  const rank = Math.max(0, ranked.findIndex((t) => t.id === MY_TEAM_ID));
  return clamp(rank * 2 + 1, 1, 20);
}

/** Income of one race: base payment, points bonus, sponsor target bonus. */
export function raceIncome(save: MyTeamSave, record: RoundRecord): IncomeLine[] {
  const mine = record.classification.filter((e) => e.teamId === MY_TEAM_ID);
  const points = mine.reduce((acc, e) => acc + e.points, 0) + (record.sprint ?? []).filter((e) => e.teamId === MY_TEAM_ID).reduce((acc, e) => acc + e.points, 0);
  const finished = mine.filter((e) => e.status !== 'retired' && e.position > 0);
  const best = finished.length > 0 ? Math.min(...finished.map((e) => e.position)) : 99;
  const target = sponsorTarget(save);
  const lines: IncomeLine[] = [{ label: '參賽獎金', amount: 2 }];
  if (points > 0) lines.push({ label: `積分獎金（${points} 分）`, amount: Math.round(points * 0.15 * 10) / 10 });
  if (best <= target) lines.push({ label: `贊助商目標達成（前 ${target} 名）`, amount: 1.5 });
  return lines;
}

export interface MyTeamRaceUpdate {
  save: MyTeamSave;
  record: RoundRecord;
  summary: SeasonSummary | null;
}

/** Apply a sprint result: its points wait in the save until the round's race is recorded. */
export function applyMyTeamSprint(save: MyTeamSave, result: SessionResult): MyTeamSave {
  return { ...save, pendingSprint: withPendingSprint(save.results.length, result) };
}

export function applyMyTeamRace(save: MyTeamSave, result: SessionResult): MyTeamRaceUpdate {
  const record = attachSprint(recordRace(result), save.pendingSprint, save.results.length);
  const income = raceIncome(save, record);
  const total = income.reduce((acc, l) => acc + l.amount, 0);
  const results = [...save.results, record].slice(0, save.calendar.length);
  const { pendingSprint: _spent, ...rest } = save;
  const next: MyTeamSave = {
    ...rest,
    results,
    budget: Math.round((save.budget + total) * 10) / 10,
    lastIncome: income,
  };
  let summary: SeasonSummary | null = null;
  if (isSeasonComplete(next)) {
    summary = seasonSummary(next.results, next.season, PLAYER_DRIVER_ID, MY_TEAM_ID, myTeamRoster(save));
    next.history = [...save.history, summary].slice(-20);
  }
  return { save: next, record, summary };
}

/** Constructor prize (M) for a final championship position. */
export function seasonPrize(teamPosition: number): number {
  return teamPosition >= 1 ? Math.max(1, 12 - teamPosition) : 0;
}

/** Next season: prize money in, power-unit and teammate contracts paid, new calendar. */
export function startNextMyTeamSeason(
  save: MyTeamSave,
  seed: number,
  layouts: readonly LayoutLike[],
): MyTeamSave {
  const teams = teamStandings(save.results, myTeamRoster(save).teams.map((t) => t.id));
  const prize = seasonPrize(standingPosition(teams, MY_TEAM_ID));
  const mate = reserveById(save.teammateId);
  const costs = powerUnitOption(save.powerUnit).cost + (mate ? reserveSalary(mate) : 0);
  const { pendingSprint: _spent, ...rest } = save;
  return {
    ...rest,
    season: save.season + 1,
    seed: Math.floor(Math.abs(seed)) >>> 0,
    calendar: createCalendar(seed, layouts, save.settings.calendar),
    results: [],
    budget: Math.round((save.budget + prize - costs) * 10) / 10,
    lastIncome: [
      { label: '車隊錦標獎金', amount: prize },
      { label: '動力單元與車手合約', amount: -costs },
    ],
  };
}

export function myTeamRequest(
  save: MyTeamSave,
  kind: SessionKind,
  fullLaps: number,
  player: { assists: Assists; setup: CarSetup; startCompound: TireCompound | null },
  gridOrder: string[] | null,
): SessionRequest | null {
  const round = save.calendar[save.results.length];
  if (!round || isSeasonComplete(save)) return null;
  return roundRequest({
    mode: 'myTeam',
    kind,
    round,
    fullLaps,
    settings: save.settings,
    roster: myTeamRoster(save),
    seed: roundSeed(save),
    assists: player.assists,
    setup: player.setup,
    startCompound: player.startCompound,
    gridOrder,
  });
}

// ───────────────────────────── sanitizer ─────────────────────────────

function sanitizeIncome(v: unknown): IncomeLine[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 8).map((item) => {
    const r = asRecord(item);
    return { label: str(r.label, '收入', 40), amount: num(r.amount, -100, 100, 0) };
  });
}

export function sanitizeMyTeam(
  v: unknown,
  layouts: readonly LayoutLike[],
): MyTeamSave | null {
  if (!isRecord(v)) return null;
  const shortName = typeof v.shortName === 'string' && /^[A-Z]{3}$/.test(v.shortName) ? v.shortName : null;
  if (!shortName) return null;
  const reserves = reserveDrivers();
  const teammateId = reserves.some((d) => d.id === v.teammateId) ? String(v.teammateId) : (reserves[0]?.id ?? '');
  const seed = int(v.seed, 0, 0xffffffff, 1);
  let calendar = sanitizeCalendar(v.calendar);
  const settings = sanitizeSeasonSettings(v.settings);
  if (calendar.length === 0) calendar = createCalendar(seed, layouts, settings.calendar);
  const rdRaw = asRecord(v.rd);
  const fallbackDriver = createPlayerDriver(
    { firstName: '新星', lastName: '車手', abbr: 'NOV', number: 2, nationality: 'TWN', helmet: { primary: '#ff5a1f', secondary: '#ffffff', accent: '#111111' } },
    MY_TEAM_ID,
    ratingToSkill(INITIAL_RATING),
  );
  const driver = sanitizeDriver(v.driver, fallbackDriver);
  const results = sanitizeRoundRecords(v.results, calendar.length);
  const pending = sanitizePendingSprint(v.pendingSprint);
  return {
    name: str(v.name, '新星車隊', 24),
    shortName,
    livery: sanitizeLivery(v.livery, { primary: '#ff5a1f', secondary: '#111111', accent: '#ffffff', pattern: 'classic' }),
    powerUnit: powerUnitOption(typeof v.powerUnit === 'string' ? v.powerUnit : '').id,
    driver: { ...driver, id: PLAYER_DRIVER_ID, teamId: MY_TEAM_ID },
    teammateId,
    budget: num(v.budget, -999, 9999, START_BUDGET),
    rd: {
      aero: int(rdRaw.aero, 0, RD_MAX_LEVEL, 0),
      power: int(rdRaw.power, 0, RD_MAX_LEVEL, 0),
      chassis: int(rdRaw.chassis, 0, RD_MAX_LEVEL, 0),
      reliability: int(rdRaw.reliability, 0, RD_MAX_LEVEL, 0),
    },
    season: int(v.season, 1, 999, 1),
    seed,
    calendar,
    results,
    history: sanitizeHistory(v.history),
    settings,
    lastIncome: sanitizeIncome(v.lastIncome),
    ...(pending && pending.round === results.length ? { pendingSprint: pending } : {}),
  };
}
