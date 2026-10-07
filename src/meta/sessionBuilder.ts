/**
 * Session building (pure logic): turns a menu-level SessionRequest into a VALID SessionConfig for every
 * mode/kind — grid composition and order, unique car numbers, start compounds, laps / time limits, rules,
 * ghost and story objective. Also builds URL quick-start sessions and classifies qualifying (player times +
 * simulated AI times) into the race grid order.
 */
import type {
  Assists,
  CarSetup,
  DriverDef,
  GameMode,
  GhostData,
  GridEntry,
  PlayerSlot,
  Regulation,
  SafetyCarSetting,
  SessionConfig,
  SessionKind,
  SessionResult,
  SessionRules,
  StoryObjective,
  TeamDef,
  TireCompound,
  WeatherKind,
} from '../core/types';
import { COMPOUNDS, DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP } from '../core/defaults';
import { clamp, nextRandom, type RngState } from '../core/math';
import type { MenuHome, SessionContext } from './context';
import { SAFETY_CAR_SETTINGS, sanitizeAssists, sanitizeRules, sanitizeSetup } from './guards';
import {
  AI_DIFFICULTY_MAX,
  AI_DIFFICULTY_MIN,
  PRACTICE_TIME_LIMIT,
  layoutOrDefault,
  qualifyingFormat,
  resolveWeather,
  sprintLaps,
  WEATHER_CHOICES,
  type LayoutMeta,
  type QualifyingType,
  type TimeOfDayChoice,
  type WeatherChoice,
  type WeekendStep,
} from './options';
import { cloneDriver, cloneTeam, ensureUniqueNumbers, rosterDrivers, standardRoster, teamStrength, type Roster } from './roster';

/** One human player's choices. */
export interface PlayerChoice {
  playerIndex: 0 | 1;
  driverId: string;
  teamId: string;
  setup: CarSetup;
  assists: Assists;
  /** null = automatic for the weather */
  startCompound: TireCompound | null;
}

/** Menu-level description of one session. Plain data (lives in SessionContext.plan). */
export interface SessionRequest {
  mode: GameMode;
  kind: SessionKind;
  layoutId: string;
  /** planned race distance in laps (≥ 1), carried through the whole weekend */
  raceLaps: number;
  weather: WeatherChoice;
  timeOfDay: TimeOfDayChoice;
  regulation: Regulation;
  aiDifficulty: number;
  qualifying: QualifyingType;
  rules: SessionRules;
  seed: number;
  players: PlayerChoice[];
  roster: Roster;
  /** split-screen: number of AI cars (0..20); null = the full roster */
  aiCount: number | null;
  /** race: driverIds in starting order (from qualifying); null = rating order with a seeded shuffle */
  gridOrder: string[] | null;
  /** story: forced 1-based start position of player 0 (race only) */
  playerStartPosition: number | null;
  /** time trial ghost to race against */
  ghost: GhostData | null;
  objective: StoryObjective | null;
  /** race kind only: this race is a sprint (raceLaps is the full race distance; the sprint runs a third of it) */
  sprint?: boolean;
}

/** Rules forced in time trial: no wear / fuel / damage / collisions. */
export const TIME_TRIAL_RULES: SessionRules = {
  tyreWear: false,
  fuel: false,
  damage: 'off',
  trackLimits: true,
  mandatoryPitStop: false,
  flashbacks: -1,
  collisions: false,
};

/** Maximum AI cars in split-screen: the 20-driver field minus the two human players' seats. */
export const MAX_SPLIT_AI = 18;

// ───────────────────────────── helpers ─────────────────────────────

function isCompound(v: unknown): v is TireCompound {
  return typeof v === 'string' && (COMPOUNDS as readonly string[]).includes(v);
}

function normalizeSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.floor(Math.abs(seed)) >>> 0 : 1;
}

/** Deterministic Fisher–Yates-free jitter: one random number per item from a seeded stream. */
function seededJitter(ids: readonly string[], seed: number): Map<string, number> {
  const rng: RngState = { s: seed ^ 0x9e3779b9 };
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, nextRandom(rng));
  return out;
}

/**
 * Keep only teams whose two drivers resolve; every driver gets its team's id. Players' drivers are always
 * kept; car numbers are made unique with players taking priority.
 */
function normalizeRoster(roster: Roster, playerDriverIds: readonly string[]): Roster {
  const teams: TeamDef[] = [];
  const drivers: DriverDef[] = [];
  const seenTeams = new Set<string>();
  const seenDrivers = new Set<string>();
  for (const raw of roster.teams) {
    if (!raw || typeof raw.id !== 'string' || seenTeams.has(raw.id)) continue;
    const ids = Array.isArray(raw.driverIds) ? raw.driverIds : [];
    const defs: DriverDef[] = [];
    for (const id of ids.slice(0, 2)) {
      if (seenDrivers.has(id)) break;
      const def = roster.drivers.find((d) => d.id === id) ?? rosterDrivers().find((d) => d.id === id);
      if (!def) break;
      defs.push(def);
    }
    if (defs.length !== 2) continue;
    const team = cloneTeam(raw);
    seenTeams.add(team.id);
    teams.push(team);
    for (const def of defs) {
      seenDrivers.add(def.id);
      drivers.push({ ...cloneDriver(def), teamId: team.id });
    }
  }
  return { teams, drivers: ensureUniqueNumbers(drivers, playerDriverIds) };
}

/** Resolve human players against the roster: valid, distinct drivers; P1 always present. */
function resolvePlayers(choices: readonly PlayerChoice[], roster: Roster): PlayerChoice[] {
  const sorted = [...choices]
    .filter((c) => c && (c.playerIndex === 0 || c.playerIndex === 1))
    .sort((a, b) => a.playerIndex - b.playerIndex);
  const used = new Set<string>();
  const out: PlayerChoice[] = [];
  const seenIndex = new Set<number>();
  for (const choice of sorted) {
    if (seenIndex.has(choice.playerIndex)) continue;
    let driver = roster.drivers.find((d) => d.id === choice.driverId && !used.has(d.id));
    if (!driver) {
      const team = roster.teams.find((t) => t.id === choice.teamId);
      driver =
        roster.drivers.find((d) => team !== undefined && d.teamId === team.id && !used.has(d.id)) ??
        roster.drivers.find((d) => !used.has(d.id));
    }
    if (!driver) continue;
    used.add(driver.id);
    seenIndex.add(choice.playerIndex);
    out.push({
      playerIndex: choice.playerIndex,
      driverId: driver.id,
      teamId: driver.teamId,
      setup: sanitizeSetup(choice.setup),
      assists: sanitizeAssists(choice.assists),
      startCompound: isCompound(choice.startCompound) ? choice.startCompound : null,
    });
  }
  if (!out.some((p) => p.playerIndex === 0)) {
    const driver = roster.drivers.find((d) => !used.has(d.id));
    if (driver) {
      out.unshift({
        playerIndex: 0,
        driverId: driver.id,
        teamId: driver.teamId,
        setup: { ...DEFAULT_SETUP },
        assists: { ...DEFAULT_ASSISTS },
        startCompound: null,
      });
    }
  }
  return out.sort((a, b) => a.playerIndex - b.playerIndex);
}

/** Strength of a driver in its car (for ordering). */
function entryStrength(driver: DriverDef, roster: Roster): number {
  const team = roster.teams.find((t) => t.id === driver.teamId);
  const pace = Number.isFinite(driver.skill.pace) ? driver.skill.pace : 0.85;
  return (team ? teamStrength(team) : 0.85) + pace * 0.35;
}

/** Rating order with a seeded shuffle (race without qualifying). */
export function ratingGridOrder(driverIds: readonly string[], roster: Roster, seed: number): string[] {
  const jitter = seededJitter(driverIds, seed);
  const score = new Map<string, number>();
  for (const id of driverIds) {
    const d = roster.drivers.find((x) => x.id === id);
    score.set(id, (d ? entryStrength(d, roster) : 0) + ((jitter.get(id) ?? 0.5) - 0.5) * 0.04);
  }
  return [...driverIds].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
}

/** AI start tyre: wet weather → rain tyres; dry race → seeded medium/soft mix; other sessions → soft. */
function aiCompound(weather: WeatherKind, kind: SessionKind, rng: RngState): TireCompound {
  if (weather === 'heavyRain') return 'wet';
  if (weather === 'lightRain') return 'inter';
  if (kind !== 'race') return 'soft';
  return nextRandom(rng) < 0.55 ? 'medium' : 'soft';
}

/** Player 'auto' start tyre. */
export function autoCompound(weather: WeatherKind, kind: SessionKind): TireCompound {
  if (weather === 'heavyRain') return 'wet';
  if (weather === 'lightRain') return 'inter';
  return kind === 'race' ? 'medium' : 'soft';
}

// ───────────────────────────── main builder ─────────────────────────────

/**
 * Build a valid SessionConfig. `layout` defaults to the registry entry for `req.layoutId` (first layout when
 * unknown); tests may pass synthetic metadata.
 */
export function buildSessionConfig(req: SessionRequest, layout: LayoutMeta = layoutOrDefault(req.layoutId)): SessionConfig {
  const seed = normalizeSeed(req.seed);
  const kind = req.kind;
  const choiceIds = req.players.map((p) => p.driverId);
  const roster = normalizeRoster(req.roster.teams.length > 0 ? req.roster : standardRoster(), choiceIds);
  const players = resolvePlayers(req.players, roster);
  const playerIds = players.map((p) => p.driverId);

  const weatherChoice: WeatherChoice =
    kind === 'timeTrial' ? 'clear' : (WEATHER_CHOICES as readonly string[]).includes(req.weather) ? req.weather : 'clear';
  const { weather, dynamic } = resolveWeather(weatherChoice);
  const timeOfDay = req.timeOfDay === 'auto' || kind === 'timeTrial' ? layout.timeOfDay : req.timeOfDay;
  const raceLaps = Number.isFinite(req.raceLaps) ? clamp(Math.round(req.raceLaps), 1, 200) : 3;
  const sprint = kind === 'race' && req.sprint === true;

  // ── grid composition
  let fieldIds: string[];
  if (kind === 'race') {
    const all = roster.drivers.map((d) => d.id);
    if (req.aiCount !== null && Number.isFinite(req.aiCount)) {
      const count = clamp(Math.round(req.aiCount), 0, MAX_SPLIT_AI);
      const ai = all
        .filter((id) => !playerIds.includes(id))
        .map((id) => roster.drivers.find((d) => d.id === id))
        .filter((d): d is DriverDef => d !== undefined)
        .sort((a, b) => entryStrength(b, roster) - entryStrength(a, roster))
        .slice(0, count)
        .map((d) => d.id);
      fieldIds = [...playerIds, ...ai];
    } else {
      fieldIds = all;
    }
  } else if (kind === 'practice' || kind === 'qualifying') {
    // the whole field runs on track; humans first (they take the flying-lap slots)
    fieldIds = [...playerIds, ...roster.drivers.map((d) => d.id).filter((id) => !playerIds.includes(id))];
  } else {
    fieldIds = [...playerIds];
  }

  // ── grid order
  let order: string[];
  if (kind === 'race') {
    const rated = ratingGridOrder(fieldIds, roster, seed);
    if (req.gridOrder && req.gridOrder.length > 0) {
      const fromQuali = req.gridOrder.filter((id, i, arr) => fieldIds.includes(id) && arr.indexOf(id) === i);
      order = [...fromQuali, ...rated.filter((id) => !fromQuali.includes(id))];
    } else {
      order = rated;
    }
    const p0 = players.find((p) => p.playerIndex === 0);
    if (p0 && req.playerStartPosition !== null && Number.isFinite(req.playerStartPosition)) {
      const target = clamp(Math.round(req.playerStartPosition) - 1, 0, order.length - 1);
      order = order.filter((id) => id !== p0.driverId);
      order.splice(target, 0, p0.driverId);
    }
  } else {
    order = fieldIds;
  }

  // ── grid entries
  const rng: RngState = { s: seed ^ 0x5bd1e995 };
  const grid: GridEntry[] = [];
  for (const id of order) {
    const driver = roster.drivers.find((d) => d.id === id);
    if (!driver) continue;
    const player = players.find((p) => p.driverId === id);
    grid.push({
      driverId: id,
      teamId: driver.teamId,
      playerIndex: player ? player.playerIndex : -1,
      startCompound: player ? (player.startCompound ?? autoCompound(weather, kind)) : aiCompound(weather, kind, rng),
    });
  }

  // ── timing
  let timeLimit: number | null = null;
  let qualifyingLaps = 0;
  if (kind === 'practice') timeLimit = PRACTICE_TIME_LIMIT;
  if (kind === 'qualifying') {
    const fmt = qualifyingFormat(req.qualifying);
    timeLimit = fmt.timeLimit;
    qualifyingLaps = fmt.timedLaps;
  }

  // ── rules
  let rules: SessionRules = sanitizeRules(req.rules, DEFAULT_RULES);
  if (kind === 'timeTrial') rules = { ...TIME_TRIAL_RULES };
  else if (kind !== 'race' || sprint) rules = { ...rules, mandatoryPitStop: false };

  const slots: PlayerSlot[] = players.map((p) => ({
    playerIndex: p.playerIndex,
    driverId: p.driverId,
    teamId: p.teamId,
    setup: { ...p.setup },
    assists: { ...p.assists },
  }));

  return {
    mode: req.mode,
    kind,
    layoutId: layout.id,
    laps: kind === 'timeTrial' ? 1 : sprint ? sprintLaps(raceLaps) : raceLaps,
    timeLimit,
    qualifyingLaps,
    weather,
    dynamicWeather: dynamic,
    timeOfDay,
    regulation: req.regulation === '2026' ? '2026' : '2025',
    aiDifficulty: Number.isFinite(req.aiDifficulty)
      ? clamp(Math.round(req.aiDifficulty), AI_DIFFICULTY_MIN, AI_DIFFICULTY_MAX)
      : 90,
    players: slots,
    grid,
    teams: roster.teams.map(cloneTeam),
    drivers: roster.drivers.map(cloneDriver),
    rules,
    seed,
    ghost: kind === 'timeTrial' && req.ghost && req.ghost.layoutId === layout.id ? req.ghost : null,
    objective: req.objective ? { ...req.objective } : null,
    ...(sprint ? { sprint: true } : {}),
  };
}

/** Problems that make a config unusable (empty = valid). Used by tests and as a runtime sanity check. */
export function validateSessionConfig(config: SessionConfig): string[] {
  const problems: string[] = [];
  if (config.grid.length === 0) problems.push('grid is empty');
  const numbers = new Set<number>();
  for (const d of config.drivers) {
    if (numbers.has(d.number)) problems.push(`duplicate car number ${d.number}`);
    numbers.add(d.number);
    if (!Number.isInteger(d.number) || d.number < 1 || d.number > 99) problems.push(`invalid number ${d.number}`);
  }
  const gridIds = new Set<string>();
  for (const g of config.grid) {
    if (gridIds.has(g.driverId)) problems.push(`driver ${g.driverId} on the grid twice`);
    gridIds.add(g.driverId);
    const driver = config.drivers.find((d) => d.id === g.driverId);
    if (!driver) problems.push(`grid driver ${g.driverId} missing from drivers`);
    if (!config.teams.some((t) => t.id === g.teamId)) problems.push(`grid team ${g.teamId} missing from teams`);
    if (driver && driver.teamId !== g.teamId) problems.push(`driver ${g.driverId} team mismatch`);
    if (!isCompound(g.startCompound)) problems.push(`invalid compound for ${g.driverId}`);
  }
  for (const t of config.teams) {
    for (const id of t.driverIds) {
      if (!config.drivers.some((d) => d.id === id)) problems.push(`team ${t.id} driver ${id} missing`);
    }
  }
  if (config.players.length === 0) problems.push('no human player');
  for (const p of config.players) {
    const entry = config.grid.find((g) => g.driverId === p.driverId);
    if (!entry) problems.push(`player ${p.playerIndex} not on the grid`);
    else if (entry.playerIndex !== p.playerIndex) problems.push(`player ${p.playerIndex} grid index mismatch`);
    if (entry && entry.teamId !== p.teamId) problems.push(`player ${p.playerIndex} team mismatch`);
  }
  if (!(config.laps >= 1)) problems.push('laps < 1');
  if (config.sprint === true && config.kind !== 'race') problems.push('sprint on a non-race session');
  if (config.sprint === true && config.rules.mandatoryPitStop) problems.push('sprint with a mandatory pit stop');
  if (config.kind === 'race' && config.timeLimit !== null) problems.push('race must not have a time limit');
  if ((config.kind === 'practice' || config.kind === 'qualifying') && !(config.timeLimit !== null && config.timeLimit > 0)) {
    problems.push('timed session without a time limit');
  }
  if (config.kind === 'qualifying' && !(config.qualifyingLaps >= 1)) problems.push('qualifying without timed laps');
  if (config.kind === 'timeTrial' && config.timeLimit !== null) problems.push('time trial must be unlimited');
  if (config.kind === 'timeTrial' && config.grid.some((g) => g.playerIndex === -1)) problems.push('AI on track in a time trial');
  if (!(config.aiDifficulty >= AI_DIFFICULTY_MIN && config.aiDifficulty <= AI_DIFFICULTY_MAX)) problems.push('difficulty');
  return problems;
}

// ───────────────────────────── weekend helpers ─────────────────────────────

/**
 * Request for the next step of a weekend. Sprint and race both start in qualifying order when known; the
 * 'sprint' step is a race-kind request with `sprint` set (every other step clears it).
 */
export function requestForKind(base: SessionRequest, step: WeekendStep, qualifyingOrder: string[] | null): SessionRequest {
  const kind: SessionKind = step === 'sprint' ? 'race' : step;
  return {
    ...base,
    kind,
    sprint: step === 'sprint',
    gridOrder: kind === 'race' ? (qualifyingOrder ?? base.gridOrder) : null,
  };
}

/** Rebuild a request from an existing config (when no weekend plan was carried). */
export function requestFromConfig(config: SessionConfig): SessionRequest {
  return {
    mode: config.mode,
    kind: config.kind,
    layoutId: config.layoutId,
    // a sprint config carries a third of the distance: scale back so the rebuilt sprint has the same laps
    raceLaps: Math.max(1, config.sprint ? config.laps * 3 : config.laps),
    weather: config.dynamicWeather ? 'dynamic' : config.weather,
    timeOfDay: config.timeOfDay,
    regulation: config.regulation,
    aiDifficulty: config.aiDifficulty,
    qualifying: config.qualifyingLaps >= 3 ? 'short' : 'oneShot',
    rules: { ...config.rules },
    seed: config.seed,
    players: config.players.map((p) => ({
      playerIndex: p.playerIndex,
      driverId: p.driverId,
      teamId: p.teamId,
      setup: { ...p.setup },
      assists: { ...p.assists },
      startCompound: config.grid.find((g) => g.driverId === p.driverId)?.startCompound ?? null,
    })),
    roster: { teams: config.teams.map(cloneTeam), drivers: config.drivers.map(cloneDriver) },
    aiCount: config.mode === 'splitScreen' ? Math.max(0, config.grid.length - config.players.length) : null,
    gridOrder: null,
    playerStartPosition: null,
    ghost: null,
    objective: config.objective ? { ...config.objective } : null,
    ...(config.sprint ? { sprint: true } : {}),
  };
}

export interface QualifyingEntry {
  driverId: string;
  teamId: string;
  /** best lap (s); null = no time set */
  time: number | null;
  /** world car id, -1 for simulated entries */
  carId: number;
  playerIndex: -1 | 0 | 1;
  simulated: boolean;
}

/**
 * Full qualifying classification: lap times from the session result (humans, plus AI if the runtime ran them)
 * merged with simulated AI times for the rest of the field. Drivers without a time go last by car strength.
 */
export function classifyQualifying(
  result: SessionResult,
  simulated: Readonly<Record<string, number>>,
  roster: Roster,
): QualifyingEntry[] {
  const valid = (t: number | null | undefined): number | null =>
    typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
  const entries: QualifyingEntry[] = [];
  for (const d of roster.drivers) {
    const row = result.rows.find((r) => r.driverId === d.id);
    const ranTime = row ? (valid(row.time) ?? valid(row.bestLap)) : null;
    if (row && (ranTime !== null || row.playerIndex !== -1)) {
      entries.push({ driverId: d.id, teamId: d.teamId, time: ranTime, carId: row.carId, playerIndex: row.playerIndex, simulated: false });
    } else if (row) {
      entries.push({ driverId: d.id, teamId: d.teamId, time: valid(simulated[d.id]), carId: row.carId, playerIndex: -1, simulated: true });
    } else {
      entries.push({ driverId: d.id, teamId: d.teamId, time: valid(simulated[d.id]), carId: -1, playerIndex: -1, simulated: true });
    }
  }
  const strength = new Map(roster.drivers.map((d) => [d.id, entryStrength(d, roster)]));
  return entries.sort((a, b) => {
    if (a.time !== null && b.time !== null) return a.time - b.time;
    if (a.time !== null) return -1;
    if (b.time !== null) return 1;
    return (strength.get(b.driverId) ?? 0) - (strength.get(a.driverId) ?? 0);
  });
}

// ───────────────────────────── quick start ─────────────────────────────

export type QuickKind = 'race' | 'quali' | 'practice' | 'tt' | 'split';

export interface QuickStartParams {
  kind: QuickKind;
  /** unknown / missing → first layout */
  layoutId?: string | null;
  /** race laps; missing / invalid → 3 */
  laps?: number | null;
  /** 'clear' | 'overcast' | 'lightRain' | 'heavyRain' | 'dynamic'; invalid → 'clear' */
  weather?: string | null;
  /** '2025' | '2026'; invalid → '2025' */
  regulation?: string | null;
  /** incident frequency; invalid / missing → DEFAULT_RULES */
  safetyCar?: string | null;
  redFlags?: boolean | null;
  formationLap?: boolean | null;
  aeroWake?: boolean | null;
  /** race kind only: run it as a sprint race */
  sprint?: boolean;
  seed?: number;
  /** player assists (default: intermediate preset) */
  assists?: Assists;
  aiDifficulty?: number;
}

/** Default human seat for quick starts and fresh preferences (built-in roster; with a roster pack the session
 * builder falls back to the pack's first free driver). */
export const DEFAULT_PLAYER_TEAM = 'nordlys';
export const DEFAULT_PLAYER_DRIVER = 'hsu';
const DEFAULT_P2_DRIVER = 'dahl';

const QUICK: Record<QuickKind, { mode: GameMode; kind: SessionKind; queue: SessionKind[]; home: MenuHome }> = {
  race: { mode: 'grandPrix', kind: 'race', queue: [], home: 'grandPrix' },
  quali: { mode: 'grandPrix', kind: 'qualifying', queue: ['race'], home: 'grandPrix' },
  practice: { mode: 'grandPrix', kind: 'practice', queue: [], home: 'grandPrix' },
  tt: { mode: 'timeTrial', kind: 'timeTrial', queue: [], home: 'timeTrial' },
  split: { mode: 'splitScreen', kind: 'race', queue: [], home: 'splitScreen' },
};

function quickRules(params: QuickStartParams): SessionRules {
  const rules: SessionRules = { ...DEFAULT_RULES };
  const sc = (SAFETY_CAR_SETTINGS as readonly string[]).find((s) => s === params.safetyCar);
  if (sc) rules.safetyCar = sc as SafetyCarSetting;
  if (typeof params.redFlags === 'boolean') rules.redFlags = params.redFlags;
  if (typeof params.formationLap === 'boolean') rules.formationLap = params.formationLap;
  if (typeof params.aeroWake === 'boolean') rules.aeroWake = params.aeroWake;
  return rules;
}

/** Build a ready-to-start session for `?quick=...` URLs. Throws only when no layout is registered. */
export function buildQuickStart(params: QuickStartParams): { config: SessionConfig; ctx: SessionContext } {
  const spec = QUICK[params.kind] ?? QUICK.race;
  const layout = layoutOrDefault(params.layoutId ?? '');
  const weather: WeatherChoice =
    typeof params.weather === 'string' && (WEATHER_CHOICES as readonly string[]).includes(params.weather)
      ? (params.weather as WeatherChoice)
      : 'clear';
  const laps = typeof params.laps === 'number' && Number.isFinite(params.laps) ? clamp(Math.round(params.laps), 1, 200) : 3;
  const assists = params.assists ? sanitizeAssists(params.assists) : { ...DEFAULT_ASSISTS };
  const players: PlayerChoice[] = [
    { playerIndex: 0, driverId: DEFAULT_PLAYER_DRIVER, teamId: DEFAULT_PLAYER_TEAM, setup: { ...DEFAULT_SETUP }, assists, startCompound: null },
  ];
  if (params.kind === 'split') {
    players.push({
      playerIndex: 1,
      driverId: DEFAULT_P2_DRIVER,
      teamId: DEFAULT_PLAYER_TEAM,
      setup: { ...DEFAULT_SETUP },
      assists: { ...DEFAULT_ASSISTS },
      startCompound: null,
    });
  }
  const request: SessionRequest = {
    mode: spec.mode,
    kind: spec.kind,
    layoutId: layout.id,
    raceLaps: laps,
    weather,
    timeOfDay: 'auto',
    regulation: params.regulation === '2026' ? '2026' : '2025',
    aiDifficulty: typeof params.aiDifficulty === 'number' ? params.aiDifficulty : 85,
    qualifying: 'oneShot',
    rules: quickRules(params),
    seed: normalizeSeed(params.seed ?? Date.now()),
    players,
    roster: standardRoster(),
    aiCount: params.kind === 'split' ? 8 : null,
    gridOrder: null,
    playerStartPosition: null,
    ghost: null,
    objective: null,
    ...(params.sprint === true && spec.kind === 'race' ? { sprint: true } : {}),
  };
  const config = buildSessionConfig(request, layout);
  return {
    config,
    ctx: {
      returnTo: spec.home,
      weekendQueue: [...spec.queue],
      round: null,
      storyId: null,
      plan: { request, qualifyingOrder: null },
    },
  };
}
