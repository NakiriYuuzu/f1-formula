/**
 * Session option vocabulary shared by menus and session building: lap-distance choices, weather choices,
 * weekend formats, qualifying types, assist presets, and safe access to layout metadata from the track registry.
 */
import type {
  Assists,
  Biome,
  LayoutInfo,
  RealCircuitInfo,
  SessionKind,
  TimeOfDay,
  TrackDef,
  WeatherKind,
} from '../core/types';
import { ASSIST_PRESETS } from '../core/defaults';
import { LAYOUTS, TRACK_DEFS } from '../data/tracks';

export type LapsChoice = 'l3' | 'l5' | 'l10' | 'p25' | 'p50' | 'p100';
export const LAPS_CHOICES: readonly LapsChoice[] = ['l3', 'l5', 'l10', 'p25', 'p50', 'p100'];

/** Fallback full race distance when a layout reports none. */
const DEFAULT_FULL_LAPS = 50;

/** Race laps for a distance choice (always ≥ 1). */
export function resolveLaps(choice: LapsChoice, fullLaps: number): number {
  const full = Number.isFinite(fullLaps) && fullLaps >= 1 ? Math.round(fullLaps) : DEFAULT_FULL_LAPS;
  switch (choice) {
    case 'l3':
      return 3;
    case 'l5':
      return 5;
    case 'l10':
      return 10;
    case 'p25':
      return Math.max(1, Math.round(full * 0.25));
    case 'p50':
      return Math.max(1, Math.round(full * 0.5));
    case 'p100':
      return full;
  }
}

export type WeatherChoice = WeatherKind | 'dynamic';
export const WEATHER_CHOICES: readonly WeatherChoice[] = ['clear', 'overcast', 'lightRain', 'heavyRain', 'dynamic'];

/** Starting weather and dynamic flag for a menu weather choice. */
export function resolveWeather(choice: WeatherChoice): { weather: WeatherKind; dynamic: boolean } {
  return choice === 'dynamic' ? { weather: 'overcast', dynamic: true } : { weather: choice, dynamic: false };
}

export type TimeOfDayChoice = TimeOfDay | 'auto';
export const TIME_OF_DAY_CHOICES: readonly TimeOfDayChoice[] = ['auto', 'day', 'dusk', 'night'];

export type WeekendFormat = 'raceOnly' | 'qualiRace' | 'full' | 'sprint';
export const WEEKEND_FORMATS: readonly WeekendFormat[] = ['raceOnly', 'qualiRace', 'full', 'sprint'];

/** One step of a weekend queue: a session kind, or the sprint race (SessionKind 'race' with config.sprint). */
export type WeekendStep = SessionKind | 'sprint';

/** Ordered sessions of a race weekend. */
export function weekendSessions(format: WeekendFormat): WeekendStep[] {
  switch (format) {
    case 'raceOnly':
      return ['race'];
    case 'qualiRace':
      return ['qualifying', 'race'];
    case 'full':
      return ['practice', 'qualifying', 'race'];
    case 'sprint':
      return ['qualifying', 'sprint', 'race'];
  }
}

/** The same weekend with a sprint race inserted before the race (no-op when it already has one). */
export function withSprint(steps: readonly WeekendStep[]): WeekendStep[] {
  if (steps.includes('sprint')) return [...steps];
  const i = steps.indexOf('race');
  return i < 0 ? [...steps] : [...steps.slice(0, i), 'sprint', ...steps.slice(i)];
}

/** Sprint distance: a third of the chosen race distance, at least 2 laps. */
export function sprintLaps(raceLaps: number): number {
  const n = Number.isFinite(raceLaps) ? raceLaps : 3;
  return Math.max(2, Math.round(n / 3));
}

export type QualifyingType = 'oneShot' | 'short';
export const QUALIFYING_TYPES: readonly QualifyingType[] = ['oneShot', 'short'];

/** Practice length (s). */
export const PRACTICE_TIME_LIMIT = 15 * 60;

/** Qualifying time limit (s) and maximum timed laps. */
export function qualifyingFormat(type: QualifyingType): { timeLimit: number; timedLaps: number } {
  return type === 'oneShot' ? { timeLimit: 5 * 60, timedLaps: 1 } : { timeLimit: 10 * 60, timedLaps: 3 };
}

export type AssistPreset = 'beginner' | 'intermediate' | 'expert' | 'custom';
export const ASSIST_PRESET_IDS: readonly AssistPreset[] = ['beginner', 'intermediate', 'expert', 'custom'];

export function assistsEqual(a: Assists, b: Assists): boolean {
  return (
    a.steering === b.steering &&
    a.braking === b.braking &&
    a.abs === b.abs &&
    a.traction === b.traction &&
    a.gearbox === b.gearbox &&
    a.racingLine === b.racingLine &&
    a.ersAssist === b.ersAssist &&
    a.drsAssist === b.drsAssist &&
    a.scLimiter === b.scLimiter
  );
}

/** Which preset (if any) an assist set matches exactly. */
export function detectAssistPreset(assists: Assists): AssistPreset {
  if (assistsEqual(assists, ASSIST_PRESETS.beginner)) return 'beginner';
  if (assistsEqual(assists, ASSIST_PRESETS.intermediate)) return 'intermediate';
  if (assistsEqual(assists, ASSIST_PRESETS.expert)) return 'expert';
  return 'custom';
}

/** AI difficulty bounds (SessionConfig.aiDifficulty). */
export const AI_DIFFICULTY_MIN = 0;
export const AI_DIFFICULTY_MAX = 110;

// ───────────────────────────── layouts ─────────────────────────────

/** Everything menus / session building need to know about a layout without building it. */
export interface LayoutMeta {
  id: string;
  defId: string;
  reverse: boolean;
  displayName: string;
  /** circuit name (def.name) */
  circuitName: string;
  location: string;
  country: string;
  biome: Biome;
  timeOfDay: TimeOfDay;
  street: boolean;
  fullLaps: number;
  description: string;
  /** real-world circuit data (absent on the original circuits) */
  real?: RealCircuitInfo;
}

export function toLayoutMeta(info: LayoutInfo, def: TrackDef): LayoutMeta {
  return {
    id: info.id,
    defId: def.id,
    reverse: info.reverse,
    displayName: info.displayName || def.name,
    circuitName: def.name,
    location: def.location,
    country: def.country,
    biome: def.biome,
    timeOfDay: def.timeOfDay,
    street: def.street,
    fullLaps: Number.isFinite(def.fullLaps) && def.fullLaps >= 1 ? Math.round(def.fullLaps) : DEFAULT_FULL_LAPS,
    description: def.description,
    ...(def.real ? { real: def.real } : {}),
  };
}

/** Every registered layout (forward + reverse) in registry order. Empty while the registry is unavailable. */
export function listLayouts(): LayoutMeta[] {
  const out: LayoutMeta[] = [];
  for (const info of LAYOUTS) {
    const def = TRACK_DEFS.find((d) => d.id === info.defId);
    if (def) out.push(toLayoutMeta(info, def));
  }
  return out;
}

export function findLayout(layoutId: string): LayoutMeta | null {
  return listLayouts().find((l) => l.id === layoutId) ?? null;
}

/** The requested layout, or the first registered one. Throws only when no layout is registered at all. */
export function layoutOrDefault(layoutId: string): LayoutMeta {
  const all = listLayouts();
  const found = all.find((l) => l.id === layoutId) ?? all[0];
  if (!found) throw new Error('沒有可用的賽道佈局');
  return found;
}
