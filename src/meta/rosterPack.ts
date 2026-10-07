/**
 * Local roster pack (user content, never bundled with the game): an imported JSON file that replaces the built-in
 * fictional teams / drivers for every mode except the story (新星之路 keeps the built-in roster). Strict validation
 * with zh-TW messages, persistence (record 'rosterPack'), the optional default pack and the active-pack switch read by
 * meta/roster.ts.
 */
import type { DriverDef, LiveryFinish, LiveryParts, TeamDef } from '../core/types';
import { asRecord, isHexColor, isRecord, LIVERY_PATTERNS, num, oneOf, sanitizeDriver, str } from './guards';
import type { PowerUnitOption } from './myTeam';
import { readRecord, removeRecord, writeRecord } from './storage';

/** Value of the pack's `format` field. */
export const ROSTER_PACK_FORMAT = 'formula-nova-roster';
/** Teams a pack may hold: the 12 pit boxes (race/world.ts BOX_SLOTS) minus one for My Team. */
export const MAX_PACK_TEAMS = 11;
const MAX_PACK_RESERVES = 12;
const MAX_PACK_POWER_UNITS = 8;
const MAX_ERRORS = 8;
const ID_RE = /^[a-z0-9-]{1,32}$/;
const CODE_RE = /^[A-Z]{3}$/;
/** ids the game uses for the career player and the My Team entry */
const RESERVED_IDS = ['player', 'myteam'];

export interface RosterPack {
  name: string;
  teams: TeamDef[];
  /** race drivers plus reserves (teamId '') */
  drivers: DriverDef[];
  /** My Team suppliers; empty = the built-in ones */
  powerUnits: PowerUnitOption[];
}

export type RosterPackResult = { ok: true; pack: RosterPack } | { ok: false; errors: string[] };

const FALLBACK_SKILL: DriverDef['skill'] = { pace: 0.85, racecraft: 0.85, awareness: 0.85, wet: 0.85, consistency: 0.85 };

const PART_KEYS: readonly (keyof LiveryParts)[] = ['nose', 'engineCover', 'sidepods', 'lower', 'halo', 'frontWing', 'rearWing', 'rearFlap'];
const FINISHES: readonly LiveryFinish[] = ['gloss', 'satin', 'matte'];

function liveryErrors(v: unknown, where: string): string[] {
  const r = asRecord(v);
  const bad = (['primary', 'secondary', 'accent'] as const).filter((k) => !isHexColor(r[k]));
  return bad.length > 0 ? [`${where}的顏色需為 #rrggbb 格式（${bad.join('、')}）`] : [];
}

/** Team-only livery extras: `parts` colours and `finish`. */
function liveryExtraErrors(v: unknown, where: string): string[] {
  const r = asRecord(v);
  const errors: string[] = [];
  if (r.parts !== undefined) {
    const parts = asRecord(r.parts);
    const bad = PART_KEYS.filter((k) => parts[k] !== undefined && !isHexColor(parts[k]));
    const unknown = Object.keys(parts).filter((k) => !(PART_KEYS as readonly string[]).includes(k));
    if (!isRecord(r.parts)) errors.push(`${where}的 livery.parts 需為物件`);
    if (bad.length > 0) errors.push(`${where}的部位顏色需為 #rrggbb 格式（${bad.join('、')}）`);
    if (unknown.length > 0) errors.push(`${where}的 livery.parts 有不認得的部位：${unknown.join('、')}（可用 ${PART_KEYS.join('、')}）`);
  }
  if (r.finish !== undefined && !(FINISHES as readonly unknown[]).includes(r.finish)) errors.push(`${where}的 livery.finish 需為 gloss／satin／matte`);
  return errors;
}

function liveryParts(v: unknown): LiveryParts | undefined {
  if (!isRecord(v)) return undefined;
  const out: LiveryParts = {};
  for (const k of PART_KEYS) if (isHexColor(v[k])) out[k] = String(v[k]).toLowerCase();
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseTeam(v: unknown, index: number, errors: string[]): TeamDef | null {
  const where = `第 ${index + 1} 支車隊`;
  if (!isRecord(v)) {
    errors.push(`${where}不是物件`);
    return null;
  }
  const before = errors.length;
  const id = typeof v.id === 'string' ? v.id : '';
  if (!ID_RE.test(id) || RESERVED_IDS.includes(id)) errors.push(`${where}的 id 需為 1–32 個小寫英數字或 -（不可用 player／myteam）`);
  const name = str(v.name, '', 32);
  if (name.length === 0) errors.push(`${where}缺少名稱`);
  const shortName = typeof v.shortName === 'string' ? v.shortName : '';
  if (!CODE_RE.test(shortName)) errors.push(`${where}的縮寫需為 3 個英文大寫字母`);
  const powerUnit = str(v.powerUnit, '', 24);
  if (powerUnit.length === 0) errors.push(`${where}缺少動力單元`);
  errors.push(...liveryErrors(v.livery, where), ...liveryExtraErrors(v.livery, where));
  const rating = asRecord(v.rating);
  const ratingKeys = ['aero', 'power', 'chassis', 'reliability'] as const;
  if (ratingKeys.some((k) => typeof rating[k] !== 'number' || !Number.isFinite(rating[k]))) {
    errors.push(`${where}的 rating 需有 aero／power／chassis／reliability 四個數字`);
  }
  const ids = Array.isArray(v.driverIds) ? v.driverIds : [];
  if (ids.length !== 2 || ids.some((x) => typeof x !== 'string') || ids[0] === ids[1]) {
    errors.push(`${where}的 driverIds 需為 2 位不同車手的 id`);
  }
  if (errors.length > before) return null;
  const livery = asRecord(v.livery);
  const parts = liveryParts(livery.parts);
  const finish = oneOf(livery.finish, FINISHES, 'gloss');
  return {
    id,
    name,
    shortName,
    livery: {
      primary: String(livery.primary).toLowerCase(),
      secondary: String(livery.secondary).toLowerCase(),
      accent: String(livery.accent).toLowerCase(),
      pattern: oneOf(livery.pattern, LIVERY_PATTERNS, 'classic'),
      ...(parts ? { parts } : {}),
      ...(finish !== 'gloss' ? { finish } : {}),
    },
    base: str(v.base, '', 32, true),
    powerUnit,
    // the menus draw 0.8..1 and the car model is tuned for that band
    rating: {
      aero: num(rating.aero, 0.8, 1, 0.9),
      power: num(rating.power, 0.8, 1, 0.9),
      chassis: num(rating.chassis, 0.8, 1, 0.9),
      reliability: num(rating.reliability, 0.8, 1, 0.9),
    },
    driverIds: [String(ids[0]), String(ids[1])],
  };
}

function parseDriver(v: unknown, index: number, errors: string[]): DriverDef | null {
  const where = `第 ${index + 1} 位車手`;
  if (!isRecord(v)) {
    errors.push(`${where}不是物件`);
    return null;
  }
  const before = errors.length;
  const id = typeof v.id === 'string' ? v.id : '';
  if (!ID_RE.test(id) || RESERVED_IDS.includes(id)) errors.push(`${where}的 id 需為 1–32 個小寫英數字或 -（不可用 player／myteam）`);
  if (str(v.lastName, '', 20).length === 0) errors.push(`${where}缺少姓氏`);
  if (typeof v.abbr !== 'string' || !CODE_RE.test(v.abbr)) errors.push(`${where}的縮寫需為 3 個英文大寫字母`);
  if (typeof v.nationality !== 'string' || !CODE_RE.test(v.nationality)) errors.push(`${where}的國籍需為 3 個英文大寫字母（ISO 3166-1 alpha-3）`);
  if (typeof v.number !== 'number' || !Number.isInteger(v.number) || v.number < 1 || v.number > 99) errors.push(`${where}的車號需為 1–99 的整數`);
  if (v.teamId !== undefined && typeof v.teamId !== 'string') errors.push(`${where}的 teamId 需為字串（候補車手留空）`);
  errors.push(...liveryErrors(v.helmet, `${where}的頭盔`));
  if (errors.length > before) return null;
  const fallback: DriverDef = {
    id,
    firstName: '',
    lastName: '',
    abbr: String(v.abbr),
    number: Number(v.number),
    nationality: String(v.nationality),
    teamId: '',
    skill: FALLBACK_SKILL,
    helmet: { primary: '#ffffff', secondary: '#111111', accent: '#888888', pattern: 'classic' },
  };
  return { ...sanitizeDriver(v, fallback), firstName: str(v.firstName, '', 20, true) };
}

function parsePowerUnits(v: unknown, errors: string[]): PowerUnitOption[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PACK_POWER_UNITS) {
    errors.push(`powerUnits 需為 1–${MAX_PACK_POWER_UNITS} 個動力單元（不需要可整個省略）`);
    return [];
  }
  const out: PowerUnitOption[] = [];
  v.forEach((item, i) => {
    const r = asRecord(item);
    const id = str(r.id, '', 24);
    if (id.length === 0 || out.some((p) => p.id === id)) {
      errors.push(`第 ${i + 1} 個動力單元的 id 空白或重複`);
      return;
    }
    out.push({
      id,
      power: num(r.power, 0.85, 0.97, 0.92),
      reliability: num(r.reliability, 0.85, 0.97, 0.93),
      cost: num(r.cost, 1, 15, 6),
      blurb: str(r.blurb, '', 40, true),
    });
  });
  return out;
}

/** Validate an imported roster pack (already JSON-parsed). Any problem rejects the whole pack. */
export function parseRosterPack(v: unknown): RosterPackResult {
  const errors: string[] = [];
  if (!isRecord(v)) return { ok: false, errors: ['檔案內容不是 JSON 物件'] };
  if (v.format !== ROSTER_PACK_FORMAT) return { ok: false, errors: [`不是名單檔（format 需為 "${ROSTER_PACK_FORMAT}"）`] };
  const rawTeams = Array.isArray(v.teams) ? v.teams : [];
  const rawDrivers = Array.isArray(v.drivers) ? v.drivers : [];
  if (rawTeams.length < 1 || rawTeams.length > MAX_PACK_TEAMS) errors.push(`車隊數需為 1–${MAX_PACK_TEAMS} 支`);
  const teams = rawTeams.slice(0, MAX_PACK_TEAMS).map((t, i) => parseTeam(t, i, errors)).filter((t): t is TeamDef => t !== null);
  const drivers = rawDrivers.map((d, i) => parseDriver(d, i, errors)).filter((d): d is DriverDef => d !== null);
  const powerUnits = parsePowerUnits(v.powerUnits, errors);

  const dupes = (values: string[]): string[] => values.filter((x, i) => values.indexOf(x) !== i);
  for (const id of new Set(dupes(teams.map((t) => t.id)))) errors.push(`車隊 id「${id}」重複`);
  for (const code of new Set(dupes(teams.map((t) => t.shortName)))) errors.push(`車隊縮寫 ${code} 重複`);
  for (const id of new Set(dupes(drivers.map((d) => d.id)))) errors.push(`車手 id「${id}」重複`);
  for (const code of new Set(dupes(drivers.map((d) => d.abbr)))) errors.push(`車手縮寫 ${code} 重複`);
  for (const n of new Set(dupes(drivers.map((d) => String(d.number))))) errors.push(`車號 ${n} 重複`);

  // team.driverIds is authoritative; a driver's teamId must agree with it
  const seat = new Map<string, string>();
  for (const team of teams) {
    for (const id of team.driverIds) {
      const driver = drivers.find((d) => d.id === id);
      if (!driver) errors.push(`${team.name} 的車手「${id}」不在 drivers 裡`);
      else if (seat.has(id)) errors.push(`車手「${id}」同時列在兩支車隊`);
      else seat.set(id, team.id);
    }
  }
  for (const d of drivers) {
    const teamId = seat.get(d.id) ?? '';
    if (d.teamId !== '' && d.teamId !== teamId) errors.push(`車手「${d.id}」的 teamId 與車隊的 driverIds 不符`);
    d.teamId = teamId;
  }
  const reserves = drivers.filter((d) => d.teamId === '').length;
  if (reserves < 1) errors.push('至少需要 1 位候補車手（teamId 留空）：我的車隊要從候補簽第二車手');
  if (reserves > MAX_PACK_RESERVES) errors.push(`候補車手最多 ${MAX_PACK_RESERVES} 位`);

  if (errors.length > 0) {
    const shown = errors.slice(0, MAX_ERRORS);
    if (errors.length > MAX_ERRORS) shown.push(`……另有 ${errors.length - MAX_ERRORS} 個問題`);
    return { ok: false, errors: shown };
  }
  return { ok: true, pack: { name: str(v.name, '自訂名單', 40), teams, drivers, powerUnits } };
}

/** JSON text → pack (file import). */
export function parseRosterPackText(text: string): RosterPackResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['無法解析 JSON（請確認檔案是 UTF-8 的 .json）'] };
  }
  return parseRosterPack(data);
}

// ───────────────────────────── active pack ─────────────────────────────

const RECORD = 'rosterPack';
/** 'builtin' once the player restored the built-in roster (wins over the default pack) */
const CHOICE_RECORD = 'rosterChoice';
/** undefined = not read from storage yet */
let stored: RosterPack | null | undefined;
let builtinChosen: boolean | undefined;
/** the optional default pack (app/defaultRoster.ts loads public/rosters/default.json at boot); never persisted */
let fallback: RosterPack | null = null;

function loadStoredPack(): RosterPack | null {
  const raw = readRecord(RECORD);
  if (raw === undefined) return null;
  const result = parseRosterPack(raw);
  return result.ok ? result.pack : null;
}

function storedPack(): RosterPack | null {
  if (stored === undefined) stored = loadStoredPack();
  return stored;
}

function chosenBuiltin(): boolean {
  if (builtinChosen === undefined) builtinChosen = readRecord(CHOICE_RECORD) === 'builtin';
  return builtinChosen;
}

/** Where the active roster comes from: an imported pack, the default pack, or the built-in fictional roster. */
export type RosterSource = 'imported' | 'default' | 'builtin';

export function rosterSource(): RosterSource {
  if (storedPack()) return 'imported';
  return fallback && !chosenBuiltin() ? 'default' : 'builtin';
}

/** The pack in use (imported, else the default one unless the built-in roster was chosen), or null for built-in. */
export function activeRosterPack(): RosterPack | null {
  return storedPack() ?? (chosenBuiltin() ? null : fallback);
}

export function defaultRosterPack(): RosterPack | null {
  return fallback;
}

/** Install the default pack (boot); it applies while nothing was imported and the built-in roster was not chosen. */
export function setDefaultRosterPack(pack: RosterPack | null): void {
  fallback = pack;
}

/**
 * Import a pack (persisted), or null = choose the built-in roster (remembered, so a default pack no longer applies).
 * Returns false if it could only be kept in memory.
 */
export function setRosterPack(pack: RosterPack | null): boolean {
  stored = pack;
  if (pack === null) {
    removeRecord(RECORD);
    builtinChosen = true;
    return writeRecord(CHOICE_RECORD, 'builtin');
  }
  builtinChosen = false;
  removeRecord(CHOICE_RECORD);
  return writeRecord(RECORD, { format: ROSTER_PACK_FORMAT, ...pack });
}

/** Drop the imported pack and the built-in choice: back to the default pack (built-in when there is none). */
export function useDefaultRosterPack(): void {
  stored = null;
  builtinChosen = false;
  removeRecord(RECORD);
  removeRecord(CHOICE_RECORD);
}

/** Forget the cached state so the next read goes to storage again (tests swap the store). */
export function resetRosterPackCache(): void {
  stored = undefined;
  builtinChosen = undefined;
}

/** Save-slot suffix: careers / My Team seasons of a roster pack are kept apart from the built-in ones. */
export function rosterSaveSuffix(): string {
  return activeRosterPack() ? '@custom' : '';
}
