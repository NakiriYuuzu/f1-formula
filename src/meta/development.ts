/**
 * Part-level car development (pure logic) shared by Driver Career and My Team: 10 car parts with 0..5 levels, each
 * level a project that runs PROJECT_ROUNDS rounds and succeeds with PROJECT_CHANCE (a failure still takes the level
 * but adds only PARTIAL_GAIN). AI teams fund projects from a per-round points budget by constructor standing and pick
 * parts by value (PART_AI_WEIGHT). Every part drops a level at each new season, keeping its efficiency
 * (rolloverDevelopment). The achieved gains reach createCarSpec through SessionConfig.development (developmentGains).
 * Career R&D points per round: careerRoundPoints (the AI budget of the player's team, scaled by the result). All
 * randomness is seeded (core/math nextRandom).
 */
import type { CarPartGains, CarPartId, TeamDef } from '../core/types';
import { clamp, nextRandom, type RngState } from '../core/math';
import { asRecord, int, isRecord, num } from './guards';
import { teamStrength } from './roster';

/** Every developable part, in the design table order (docs/plans/phase1-rnd.md §2). */
export const CAR_PARTS: readonly CarPartId[] = [
  'frontWing',
  'rearWing',
  'floor',
  'suspension',
  'powerUnit',
  'ers',
  'gearbox',
  'brakes',
  'weight',
  'reliability',
];
export const PART_MAX_LEVEL = 5;

export type PartGroup = 'aero' | 'power' | 'chassis';
export const PART_GROUP: Record<CarPartId, PartGroup> = {
  frontWing: 'aero',
  rearWing: 'aero',
  floor: 'aero',
  suspension: 'chassis',
  powerUnit: 'power',
  ers: 'power',
  gearbox: 'power',
  brakes: 'chassis',
  weight: 'chassis',
  reliability: 'chassis',
};

/** Rounds a project needs to complete, by target level L (index L − 1). */
export const PROJECT_ROUNDS: readonly number[] = [1, 1, 2, 2, 3];
/** Success chance of a project, by target level L (index L − 1). */
export const PROJECT_CHANCE: readonly number[] = [0.95, 0.9, 0.82, 0.74, 0.65];
/** Gain of a failed project: the level is still taken (no retry) but only half of it works. */
export const PARTIAL_GAIN = 0.5;
/** My Team project cost (M), by target level L (index L − 1). */
export const PART_COST_MONEY: readonly number[] = [1.0, 1.5, 2.0, 2.7, 3.4];
/** Project cost in R&D points (career player and AI teams), by target level L (index L − 1). */
export const PART_COST_POINTS: readonly number[] = [30, 45, 60, 80, 100];
/** Projects a team can run at the same time (one per part). */
export const MAX_PROJECTS = 2;

/** Average AI R&D points per round (aiDevelopmentBudget scales it by standing). */
const AI_BASE_BUDGET = 42;
/**
 * AI part value (docs/plans/phase1-rnd.md §10 D5): a part's score is weight / (1 + AI_LEVEL_DECAY · level) ×
 * (0.9 + 0.2 · random); the best startable part is developed next. Weights follow the measured lap time per gain
 * (predictLapTime, 8 layouts × 2 regulations), compressed to 0.4–1.6; reliability (no lap time) keeps a small share.
 */
export const PART_AI_WEIGHT: Readonly<Record<CarPartId, number>> = {
  frontWing: 1.6,
  rearWing: 0.8,
  floor: 1.3,
  suspension: 1.5,
  powerUnit: 1.3,
  ers: 1.1,
  gearbox: 0.8,
  brakes: 0.5,
  weight: 0.7,
  reliability: 0.4,
};
/** How much a part's AI score falls per level already developed (spreads the work over the parts). */
const AI_LEVEL_DECAY = 0.35;
/** Levels every part loses at a new season (rule changes; rolloverDevelopment). */
export const SEASON_LEVEL_LOSS = 1;
/**
 * teamStrength (meta/roster) worth of 1.0 part gain: predictLapTime puts every part at Lv5 (50 gain) 3.1–4.9 % faster
 * (≈ 0.08 % a gain) and, on a car running its team's own ratings, 0.01 of every rating ≈ 0.2 % (2025 / 2026, 4 circuits).
 */
export const GAIN_STRENGTH = 0.004;
/** Upper bound of a stored AI bank (save validation). */
const MAX_BANK = 1_000_000;

export interface PartProgress {
  /** completed levels, integer 0..PART_MAX_LEVEL */
  level: number;
  /** achieved gain 0..level in 0.5 steps (a partly successful level adds PARTIAL_GAIN) */
  gain: number;
}

export interface DevProject {
  part: CarPartId;
  /** target level (current level + 1) */
  level: number;
  /** rounds until completion (≥ 1 while running) */
  roundsLeft: number;
  /** total rounds (PROJECT_ROUNDS) */
  rounds: number;
  /** success chance 0..1 (PROJECT_CHANCE) */
  chance: number;
}

export interface TeamDevelopment {
  parts: Record<CarPartId, PartProgress>;
  /** running projects: at most MAX_PROJECTS, one per part */
  projects: DevProject[];
  /** AI teams: unspent R&D points (human teams pay from their budget / career points instead) */
  bank: number;
}

export interface DevReportLine {
  teamId: string;
  part: CarPartId;
  /** level the project reached */
  level: number;
  /** false = partly successful (PARTIAL_GAIN) */
  success: boolean;
}

export interface SeasonDevelopment {
  teams: Record<string, TeamDevelopment>;
  /** projects completed in the latest round (every team, AI included) */
  report: DevReportLine[];
}

// ───────────────────────────── helpers ─────────────────────────────

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

function isPart(v: unknown): v is CarPartId {
  return typeof v === 'string' && (CAR_PARTS as readonly string[]).includes(v);
}

function cloneTeamDevelopment(team: TeamDevelopment): TeamDevelopment {
  const parts = {} as Record<CarPartId, PartProgress>;
  for (const p of CAR_PARTS) parts[p] = { ...team.parts[p] };
  return { parts, projects: team.projects.map((q) => ({ ...q })), bank: team.bank };
}

/** Seeded stream for one decision: FNV-1a over the seed and the keys (team, part, level, ...). */
function seededRng(seed: number, ...keys: readonly (string | number)[]): RngState {
  const s = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) >>> 0 : 1;
  const text = `${s}|${keys.join('|')}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return { s: h >>> 0 };
}


// ───────────────────────────── creation / queries ─────────────────────────────

export function emptyTeamDevelopment(): TeamDevelopment {
  const parts = {} as Record<CarPartId, PartProgress>;
  for (const p of CAR_PARTS) parts[p] = { level: 0, gain: 0 };
  return { parts, projects: [], bank: 0 };
}

/** Fresh development (every part 0, no projects) for each team id. */
export function createSeasonDevelopment(teamIds: readonly string[]): SeasonDevelopment {
  const ids = teamIds.filter((id, i) => teamIds.indexOf(id) === i);
  return { teams: Object.fromEntries(ids.map((id) => [id, emptyTeamDevelopment()])), report: [] };
}

/** createCarSpec part gains of one team (only parts with gain > 0). */
export function teamGains(team: TeamDevelopment | undefined): CarPartGains {
  const out: CarPartGains = {};
  if (!team) return out;
  for (const p of CAR_PARTS) {
    const gain = team.parts[p]?.gain ?? 0;
    if (gain > 0) out[p] = gain;
  }
  return out;
}

/** Part gains per team id for SessionConfig.development. */
export function developmentGains(dev: SeasonDevelopment | undefined): Record<string, CarPartGains> {
  if (!dev) return {};
  return Object.fromEntries(Object.entries(dev.teams).map(([id, team]) => [id, teamGains(team)]));
}

/** Preview of the next level's project of a part; null when maxed or already in development. */
export function nextProject(team: TeamDevelopment, part: CarPartId): DevProject | null {
  const level = team.parts[part].level + 1;
  if (level > PART_MAX_LEVEL || team.projects.some((q) => q.part === part)) return null;
  const rounds = PROJECT_ROUNDS[level - 1];
  return { part, level, roundsLeft: rounds, rounds, chance: PROJECT_CHANCE[level - 1] };
}

/** Not maxed, no project on this part yet, and a free project slot. */
export function canStartProject(team: TeamDevelopment, part: CarPartId): boolean {
  return team.projects.length < MAX_PROJECTS && nextProject(team, part) !== null;
}

/** Start the next level's project of a part (costs are the caller's business); null when it cannot start. */
export function startProject(dev: SeasonDevelopment, teamId: string, part: CarPartId): SeasonDevelopment | null {
  const team = hasOwn(dev.teams, teamId) ? dev.teams[teamId] : undefined;
  const project = team && canStartProject(team, part) ? nextProject(team, part) : null;
  if (!team || !project) return null;
  const next = cloneTeamDevelopment(team);
  next.projects.push(project);
  return { teams: { ...dev.teams, [teamId]: next }, report: [...dev.report] };
}

/** Cost of a project for target `level` (1..PART_MAX_LEVEL, clamped): M ('money') or R&D points ('points'). */
export function projectCost(level: number, currency: 'money' | 'points'): number {
  const i = clamp(Number.isFinite(level) ? Math.round(level) : 1, 1, PART_MAX_LEVEL) - 1;
  return (currency === 'money' ? PART_COST_MONEY : PART_COST_POINTS)[i];
}

export function isAnyPartMaxed(team: TeamDevelopment): boolean {
  return CAR_PARTS.some((p) => team.parts[p].level >= PART_MAX_LEVEL);
}

export function totalLevel(team: TeamDevelopment): number {
  return CAR_PARTS.reduce((acc, p) => acc + team.parts[p].level, 0);
}

export function totalGain(team: TeamDevelopment): number {
  return CAR_PARTS.reduce((acc, p) => acc + team.parts[p].gain, 0);
}

/**
 * Part gains as teamStrength (meta/roster) for rankings by expected car performance — race grid without qualifying,
 * sponsor target, expected position: Σ gain × GAIN_STRENGTH, the same for every team (a gain is worth the same lap
 * time on any car). 0 without development, so those rankings stay the plain rating order.
 */
export function developmentStrength(gains: CarPartGains | undefined): number {
  if (!gains) return 0;
  let total = 0;
  for (const p of CAR_PARTS) {
    const v = gains[p];
    if (typeof v === 'number' && Number.isFinite(v)) total += clamp(v, 0, PART_MAX_LEVEL);
  }
  return total * GAIN_STRENGTH;
}

/** Teams by expected car performance, strongest first: teamStrength plus developmentStrength. */
export function teamsByStrength(teams: readonly TeamDef[], development: SeasonDevelopment | undefined): TeamDef[] {
  const gains = developmentGains(development);
  const strength = (t: TeamDef): number => teamStrength(t) + developmentStrength(hasOwn(gains, t.id) ? gains[t.id] : undefined);
  return [...teams].sort((a, b) => strength(b) - strength(a));
}

// ───────────────────────────── season flow ─────────────────────────────

/**
 * AI R&D points per round by constructor standing (rank0 0 = leader): the leader gets ×0.85 and the last team ×1.15
 * of the average, like the real wind-tunnel allocation.
 */
export function aiDevelopmentBudget(rank0: number, teamCount: number): number {
  const span = Math.max(1, (Number.isFinite(teamCount) ? Math.round(teamCount) : 1) - 1);
  const rank = clamp(Number.isFinite(rank0) ? rank0 : span, 0, span);
  return AI_BASE_BUDGET * (0.85 + (0.3 * rank) / span);
}

/**
 * AI planning on a cloned team: score every startable part (PART_AI_WEIGHT / (1 + AI_LEVEL_DECAY · level), ±10 %
 * seeded noise) and start the best one while the bank pays for it; when it cannot, save up (no cheaper fallback).
 */
function planAiProjects(team: TeamDevelopment, rng: RngState): void {
  while (team.projects.length < MAX_PROJECTS) {
    let best: CarPartId | null = null;
    let bestScore = -Infinity;
    for (const p of CAR_PARTS) {
      if (!canStartProject(team, p)) continue;
      const score = (PART_AI_WEIGHT[p] / (1 + AI_LEVEL_DECAY * team.parts[p].level)) * (0.9 + 0.2 * nextRandom(rng));
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    const project = best ? nextProject(team, best) : null;
    if (!project) return;
    const cost = projectCost(project.level, 'points');
    if (team.bank + 1e-9 < cost) return;
    team.bank = Math.max(0, team.bank - cost);
    team.projects.push(project);
  }
}

/**
 * One round of development after a race:
 * 1. every team's projects advance a round; a finished project rolls (seeded by seed / team / part / level) for
 *    success (+1 gain) or partial success (+PARTIAL_GAIN), the level always rises, and it joins the report;
 * 2. non-player teams bank aiDevelopmentBudget for their place in `standings` (team ids in constructor order; teams
 *    missing from it rank after the listed ones) and start projects with it by part value (planAiProjects) — a new
 *    project finishes at the next round at the earliest.
 */
export function advanceDevelopment(
  dev: SeasonDevelopment,
  args: { seed: number; playerTeamIds: readonly string[]; standings: readonly string[] },
): SeasonDevelopment {
  const ids = Object.keys(dev.teams);
  const teams: Record<string, TeamDevelopment> = Object.fromEntries(ids.map((id) => [id, cloneTeamDevelopment(dev.teams[id])]));
  const report: DevReportLine[] = [];
  for (const id of ids) {
    const team = teams[id];
    const running: DevProject[] = [];
    for (const q of team.projects) {
      if (q.roundsLeft > 1) {
        running.push({ ...q, roundsLeft: q.roundsLeft - 1 });
        continue;
      }
      const success = nextRandom(seededRng(args.seed, id, q.part, q.level)) < q.chance;
      const cur = team.parts[q.part];
      const level = Math.min(PART_MAX_LEVEL, cur.level + 1);
      team.parts[q.part] = { level, gain: Math.min(level, cur.gain + (success ? 1 : PARTIAL_GAIN)) };
      report.push({ teamId: id, part: q.part, level, success });
    }
    team.projects = running;
  }
  const order = args.standings.filter((id, i, arr) => hasOwn(teams, id) && arr.indexOf(id) === i);
  for (const id of ids) if (!order.includes(id)) order.push(id);
  for (const id of ids) {
    if (args.playerTeamIds.includes(id)) continue;
    const team = teams[id];
    team.bank += aiDevelopmentBudget(order.indexOf(id), order.length);
    planAiProjects(team, seededRng(args.seed, id, 'plan'));
  }
  return { teams, report };
}

/**
 * What a team gets back at the season rollover: a running project whose part drops a level now aims at a cheaper
 * level (rolloverDevelopment), so the difference of the two levels' costs is refunded (0 while the part stays at 0).
 */
export function rolloverRefund(team: TeamDevelopment, currency: 'money' | 'points'): number {
  let refund = 0;
  for (const q of team.projects) {
    const level = Math.max(0, team.parts[q.part].level - SEASON_LEVEL_LOSS) + 1;
    refund += projectCost(q.level, currency) - projectCost(level, currency);
  }
  return Math.round(refund * 10) / 10;
}

/**
 * Next season (rule changes): every part of every team drops SEASON_LEVEL_LOSS level(s) and keeps its efficiency —
 * level − 1 (≥ 0), gain × new level ÷ old level rounded to 0.5 (0..level) — so the shortfall of partly successful
 * levels shrinks with the level instead of piling up season after season. A running project now aims at the part's
 * new next level (its rounds / chance, roundsLeft no longer than the new level's PROJECT_ROUNDS) and AI teams (not in
 * `playerTeamIds`) get the cost difference back into their bank (rolloverRefund; the caller refunds player teams).
 * Banks carry over; the report is cleared.
 */
export function rolloverDevelopment(dev: SeasonDevelopment, playerTeamIds: readonly string[] = []): SeasonDevelopment {
  const teams: Record<string, TeamDevelopment> = {};
  for (const [id, team] of Object.entries(dev.teams)) {
    const next = cloneTeamDevelopment(team);
    if (!playerTeamIds.includes(id)) next.bank += rolloverRefund(team, 'points');
    for (const p of CAR_PARTS) {
      const { level: old, gain } = next.parts[p];
      const level = Math.max(0, old - SEASON_LEVEL_LOSS);
      next.parts[p] = { level, gain: old > 0 ? clamp(Math.round(((gain * level) / old) * 2) / 2, 0, level) : 0 };
    }
    next.projects = next.projects.map((q) => {
      const level = next.parts[q.part].level + 1;
      const rounds = PROJECT_ROUNDS[level - 1];
      return { part: q.part, level, roundsLeft: Math.min(q.roundsLeft, rounds), rounds, chance: PROJECT_CHANCE[level - 1] };
    });
    teams[id] = next;
  }
  return { teams, report: [] };
}

/**
 * Old My Team R&D departments → parts (each `{ level: L, gain: L }`), the same groups My Team's rating averages
 * (myTeamRating): aero → front wing / rear wing / floor, power → power unit / ERS / gearbox, chassis → suspension /
 * brakes / weight, reliability → reliability.
 */
export function developmentFromRd(rd: { aero: number; power: number; chassis: number; reliability: number }): TeamDevelopment {
  const team = emptyTeamDevelopment();
  const from: Record<CarPartId, number> = {
    frontWing: rd.aero,
    rearWing: rd.aero,
    floor: rd.aero,
    suspension: rd.chassis,
    powerUnit: rd.power,
    ers: rd.power,
    gearbox: rd.power,
    brakes: rd.chassis,
    weight: rd.chassis,
    reliability: rd.reliability,
  };
  for (const p of CAR_PARTS) {
    const level = int(from[p], 0, PART_MAX_LEVEL, 0);
    team.parts[p] = { level, gain: level };
  }
  return team;
}

// ───────────────────────────── save validation ─────────────────────────────

/** A stored project, or null when broken (unknown part, wrong target level, maxed, finished). */
function sanitizeProject(v: unknown, parts: Record<CarPartId, PartProgress>): DevProject | null {
  if (!isRecord(v) || !isPart(v.part)) return null;
  const level = parts[v.part].level + 1;
  if (level > PART_MAX_LEVEL || v.level !== level) return null;
  if (typeof v.roundsLeft !== 'number' || !Number.isFinite(v.roundsLeft) || v.roundsLeft < 1) return null;
  const rounds = PROJECT_ROUNDS[level - 1];
  return { part: v.part, level, roundsLeft: clamp(Math.round(v.roundsLeft), 1, rounds), rounds, chance: PROJECT_CHANCE[level - 1] };
}

function sanitizeTeamDevelopment(v: unknown): TeamDevelopment {
  const raw = asRecord(v);
  const rawParts = asRecord(raw.parts);
  const parts = {} as Record<CarPartId, PartProgress>;
  for (const p of CAR_PARTS) {
    const r = asRecord(rawParts[p]);
    const level = int(r.level, 0, PART_MAX_LEVEL, 0);
    parts[p] = { level, gain: clamp(Math.round(num(r.gain, 0, PART_MAX_LEVEL, 0) * 2) / 2, 0, level) };
  }
  const projects: DevProject[] = [];
  for (const item of Array.isArray(raw.projects) ? raw.projects : []) {
    if (projects.length >= MAX_PROJECTS) break;
    const project = sanitizeProject(item, parts);
    if (project && !projects.some((q) => q.part === project.part)) projects.push(project);
  }
  return { parts, projects, bank: num(raw.bank, 0, MAX_BANK, 0) };
}

/**
 * Valid development for exactly `teamIds` (stored teams outside it are dropped, missing ones start empty): integer
 * levels 0..5, gains 0..level in 0.5 steps, valid projects only (no duplicate part, ≤ MAX_PROJECTS), bank ≥ 0.
 */
export function sanitizeDevelopment(v: unknown, teamIds: readonly string[]): SeasonDevelopment {
  const raw = asRecord(v);
  const rawTeams = asRecord(raw.teams);
  const ids = teamIds.filter((id, i) => typeof id === 'string' && teamIds.indexOf(id) === i);
  const teams = Object.fromEntries(ids.map((id) => [id, sanitizeTeamDevelopment(hasOwn(rawTeams, id) ? rawTeams[id] : undefined)]));
  const report: DevReportLine[] = [];
  for (const item of Array.isArray(raw.report) ? raw.report : []) {
    if (report.length >= ids.length * MAX_PROJECTS) break;
    if (!isRecord(item) || typeof item.teamId !== 'string' || !ids.includes(item.teamId) || !isPart(item.part)) continue;
    if (typeof item.level !== 'number' || !Number.isInteger(item.level) || item.level < 1 || item.level > PART_MAX_LEVEL) continue;
    if (typeof item.success !== 'boolean') continue;
    report.push({ teamId: item.teamId, part: item.part, level: item.level, success: item.success });
  }
  return { teams, report };
}

// ───────────────────────────── career R&D points ─────────────────────────────

/**
 * Career R&D points earned in a round: the AI budget of the player's team (aiDevelopmentBudget for its constructor
 * place after this race — leaders get less, like the AI) × (0.85 + 0.25 · finishing score + 0.05 for beating the
 * team-mate + 0.05 · sprint score), rounded. Scores run 1 (P1) .. 0 (last of `fieldSize`); positions are 1-based and
 * null = DNF / not classified (score 0). A result moves the points between 0.85× and 1.2× of the team's AI budget.
 */
export function careerRoundPoints(args: {
  teamRank0: number;
  teamCount: number;
  position: number | null;
  fieldSize: number;
  aheadOfTeammate: boolean;
  sprintPosition?: number | null;
}): number {
  const field = Number.isFinite(args.fieldSize) ? Math.max(1, Math.round(args.fieldSize)) : 1;
  const score = (p: number | null | undefined): number =>
    typeof p === 'number' && Number.isFinite(p) && p >= 1 ? clamp((field - Math.round(p)) / Math.max(1, field - 1), 0, 1) : 0;
  const factor = 0.85 + 0.25 * score(args.position) + (args.aheadOfTeammate ? 0.05 : 0) + 0.05 * score(args.sprintPosition);
  return Math.round(aiDevelopmentBudget(args.teamRank0, args.teamCount) * factor);
}
