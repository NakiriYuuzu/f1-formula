/**
 * Runtime validation helpers for persisted / untrusted data. Every helper returns a valid value
 * (falling back to the provided default) and never throws.
 */
import type { Assists, CarSetup, DriverDef, GhostData, Livery, LiveryPattern, SessionRules } from '../core/types';
import { ASSIST_PRESETS, DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SETUP_RANGES } from '../core/defaults';
import { clamp } from '../core/math';

export type PlainRecord = Record<string, unknown>;

export function isRecord(v: unknown): v is PlainRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asRecord(v: unknown): PlainRecord {
  return isRecord(v) ? v : {};
}

/** Finite number clamped to [lo, hi], else fallback. */
export function num(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}

/** Finite integer clamped to [lo, hi], else fallback. */
export function int(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : fallback;
}

export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Trimmed string limited to maxLen, else fallback (also when empty and allowEmpty is false). */
export function str(v: unknown, fallback: string, maxLen = 64, allowEmpty = false): string {
  if (typeof v !== 'string') return fallback;
  const s = v.trim().slice(0, maxLen);
  return s.length > 0 || allowEmpty ? s : fallback;
}

export function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

export function color(v: unknown, fallback: string): string {
  return isHexColor(v) ? v.toLowerCase() : fallback;
}

export function stringArray(v: unknown, maxItems: number, fallback: string[]): string[] {
  if (!Array.isArray(v)) return [...fallback];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 32 && !out.includes(item)) out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Record<string, number> with finite values only. */
export function numberRecord(v: unknown, lo: number, hi: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(asRecord(v))) {
    if (typeof val === 'number' && Number.isFinite(val)) out[k] = clamp(val, lo, hi);
  }
  return out;
}

export const LIVERY_PATTERNS: readonly LiveryPattern[] = ['classic', 'stripe', 'chevron', 'split', 'fade'];

export function sanitizeLivery(v: unknown, fallback: Livery): Livery {
  const r = asRecord(v);
  return {
    primary: color(r.primary, fallback.primary),
    secondary: color(r.secondary, fallback.secondary),
    accent: color(r.accent, fallback.accent),
    pattern: oneOf(r.pattern, LIVERY_PATTERNS, fallback.pattern ?? 'classic'),
  };
}

export function sanitizeAssists(v: unknown, fallback: Assists = DEFAULT_ASSISTS): Assists {
  const r = asRecord(v);
  const out: Assists = {
    steering: bool(r.steering, fallback.steering),
    braking: oneOf(r.braking, ['off', 'low', 'high'] as const, fallback.braking),
    abs: bool(r.abs, fallback.abs),
    traction: oneOf(r.traction, ['off', 'medium', 'full'] as const, fallback.traction),
    gearbox: oneOf(r.gearbox, ['auto', 'manual'] as const, fallback.gearbox),
    racingLine: oneOf(r.racingLine, ['off', 'corners', 'full'] as const, fallback.racingLine),
    ersAssist: bool(r.ersAssist, fallback.ersAssist),
    drsAssist: bool(r.drsAssist, fallback.drsAssist),
    scLimiter: bool(r.scLimiter, fallback.scLimiter),
    pitAssist: bool(r.pitAssist, fallback.pitAssist),
  };
  // saves from before the pit assist: a beginner set keeps the full pit autopilot it always had
  if (typeof r.pitAssist !== 'boolean') {
    const beginner = ASSIST_PRESETS.beginner;
    const keys = Object.keys(beginner).filter((k) => k !== 'pitAssist') as (keyof Assists)[];
    if (keys.every((k) => out[k] === beginner[k])) out.pitAssist = true;
  }
  return out;
}

/** Incident-frequency settings in menu order. */
export const SAFETY_CAR_SETTINGS = ['off', 'reduced', 'standard', 'increased'] as const;

export function sanitizeRules(v: unknown, fallback: SessionRules = DEFAULT_RULES): SessionRules {
  const r = asRecord(v);
  return {
    tyreWear: bool(r.tyreWear, fallback.tyreWear),
    fuel: bool(r.fuel, fallback.fuel),
    damage: oneOf(r.damage, ['off', 'reduced', 'full'] as const, fallback.damage),
    trackLimits: bool(r.trackLimits, fallback.trackLimits),
    mandatoryPitStop: bool(r.mandatoryPitStop, fallback.mandatoryPitStop),
    flashbacks: int(r.flashbacks, -1, 99, fallback.flashbacks),
    collisions: bool(r.collisions, fallback.collisions),
    // race-control fields: missing in old saves → merged from the fallback, then DEFAULT_RULES
    safetyCar: oneOf(r.safetyCar, SAFETY_CAR_SETTINGS, fallback.safetyCar ?? DEFAULT_RULES.safetyCar ?? 'standard'),
    redFlags: bool(r.redFlags, fallback.redFlags ?? DEFAULT_RULES.redFlags ?? true),
    formationLap: bool(r.formationLap, fallback.formationLap ?? DEFAULT_RULES.formationLap ?? false),
    aeroWake: bool(r.aeroWake, fallback.aeroWake ?? DEFAULT_RULES.aeroWake ?? true),
  };
}

/** Setup values clamped to SETUP_RANGES and snapped to each range's step. */
export function sanitizeSetup(v: unknown, fallback: CarSetup = DEFAULT_SETUP): CarSetup {
  const r = asRecord(v);
  const out: CarSetup = { ...fallback };
  for (const range of SETUP_RANGES) {
    const raw = num(r[range.key], range.min, range.max, fallback[range.key]);
    const snapped = range.min + Math.round((raw - range.min) / range.step) * range.step;
    out[range.key] = clamp(snapped, range.min, range.max);
  }
  return out;
}

/** A 0..1 skill block. */
function sanitizeSkill(v: unknown, fallback: DriverDef['skill']): DriverDef['skill'] {
  const r = asRecord(v);
  return {
    pace: num(r.pace, 0, 1, fallback.pace),
    racecraft: num(r.racecraft, 0, 1, fallback.racecraft),
    awareness: num(r.awareness, 0, 1, fallback.awareness),
    wet: num(r.wet, 0, 1, fallback.wet),
    consistency: num(r.consistency, 0, 1, fallback.consistency),
  };
}

export function sanitizeDriver(v: unknown, fallback: DriverDef): DriverDef {
  const r = asRecord(v);
  const abbr = typeof r.abbr === 'string' && /^[A-Z]{3}$/.test(r.abbr) ? r.abbr : fallback.abbr;
  const nationality =
    typeof r.nationality === 'string' && /^[A-Z]{3}$/.test(r.nationality) ? r.nationality : fallback.nationality;
  return {
    id: str(r.id, fallback.id, 32),
    firstName: str(r.firstName, fallback.firstName, 20),
    lastName: str(r.lastName, fallback.lastName, 20),
    abbr,
    number: int(r.number, 1, 99, fallback.number),
    nationality,
    teamId: str(r.teamId, fallback.teamId, 32, true),
    skill: sanitizeSkill(r.skill, fallback.skill),
    helmet: sanitizeLivery(r.helmet, fallback.helmet),
  };
}

export function sanitizeGhost(v: unknown): GhostData | null {
  if (!isRecord(v)) return null;
  const { layoutId, lapTime, driverId, teamId, dt, samples } = v;
  if (typeof layoutId !== 'string' || layoutId.length === 0) return null;
  if (typeof lapTime !== 'number' || !Number.isFinite(lapTime) || lapTime <= 0) return null;
  if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) return null;
  if (!Array.isArray(samples) || samples.length < 8 || samples.length % 4 !== 0) return null;
  const clean: number[] = new Array<number>(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s: unknown = samples[i];
    if (typeof s !== 'number' || !Number.isFinite(s)) return null;
    clean[i] = s;
  }
  return {
    layoutId,
    lapTime,
    driverId: typeof driverId === 'string' ? driverId : '',
    teamId: typeof teamId === 'string' ? teamId : '',
    dt,
    samples: clean,
  };
}
