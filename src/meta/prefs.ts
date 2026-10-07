/**
 * Player profile & per-mode preferences (pure logic): assists, statistics and the last options used in
 * Grand Prix, Time Trial and split-screen, with defaults and sanitizers.
 */
import type { Assists, CarSetup, Regulation, SessionRules } from '../core/types';
import { ASSIST_PRESETS, DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP } from '../core/defaults';
import { emptyStats, sanitizeStats, type ProfileStats } from './achievements';
import { asRecord, bool, int, oneOf, sanitizeAssists, sanitizeRules, sanitizeSetup, str } from './guards';
import {
  AI_DIFFICULTY_MAX,
  AI_DIFFICULTY_MIN,
  LAPS_CHOICES,
  QUALIFYING_TYPES,
  TIME_OF_DAY_CHOICES,
  WEATHER_CHOICES,
  WEEKEND_FORMATS,
  type LapsChoice,
  type QualifyingType,
  type TimeOfDayChoice,
  type WeatherChoice,
  type WeekendFormat,
} from './options';
import { DEFAULT_PLAYER_DRIVER, DEFAULT_PLAYER_TEAM, MAX_SPLIT_AI } from './sessionBuilder';

export interface SeatChoice {
  teamId: string;
  driverId: string;
}

export interface GrandPrixPrefs extends SeatChoice {
  /** '' = first available layout */
  layoutId: string;
  laps: LapsChoice;
  aiDifficulty: number;
  weather: WeatherChoice;
  timeOfDay: TimeOfDayChoice;
  regulation: Regulation;
  format: WeekendFormat;
  qualifying: QualifyingType;
  rules: SessionRules;
}

export interface TimeTrialPrefs extends SeatChoice {
  layoutId: string;
  regulation: Regulation;
  ghost: boolean;
}

export interface SplitPrefs {
  layoutId: string;
  laps: LapsChoice;
  weather: WeatherChoice;
  regulation: Regulation;
  aiCount: number;
  aiDifficulty: number;
  p1: SeatChoice;
  p2: SeatChoice;
  p2Assists: Assists;
  /** race control (safety car / red flags / formation lap); the other rules stay at their defaults */
  rules: SessionRules;
}

export interface ProfileSave {
  /** player 1 assists used by every mode */
  assists: Assists;
  /** the first-run 選擇駕駛經驗 screen was completed (false = show it after the title) */
  onboarded: boolean;
  stats: ProfileStats;
  gp: GrandPrixPrefs;
  tt: TimeTrialPrefs;
  split: SplitPrefs;
}

const REGULATIONS = ['2025', '2026'] as const;

export function defaultProfile(): ProfileSave {
  return {
    assists: { ...DEFAULT_ASSISTS },
    onboarded: false,
    stats: emptyStats(),
    gp: {
      layoutId: '',
      teamId: DEFAULT_PLAYER_TEAM,
      driverId: DEFAULT_PLAYER_DRIVER,
      laps: 'l5',
      aiDifficulty: 80,
      weather: 'clear',
      timeOfDay: 'auto',
      regulation: '2025',
      format: 'qualiRace',
      qualifying: 'oneShot',
      rules: { ...DEFAULT_RULES },
    },
    tt: { layoutId: '', regulation: '2025', ghost: true, teamId: DEFAULT_PLAYER_TEAM, driverId: DEFAULT_PLAYER_DRIVER },
    split: {
      layoutId: '',
      laps: 'l3',
      weather: 'clear',
      regulation: '2025',
      aiCount: 6,
      aiDifficulty: 70,
      p1: { teamId: DEFAULT_PLAYER_TEAM, driverId: DEFAULT_PLAYER_DRIVER },
      p2: { teamId: 'aurora', driverId: 'lindqvist' },
      p2Assists: { ...DEFAULT_ASSISTS },
      rules: { ...DEFAULT_RULES },
    },
  };
}

/** Driving-experience choices of the first-run screen (ids = ASSIST_PRESETS keys). */
export type ExperienceLevel = 'beginner' | 'intermediate' | 'expert';

export const EXPERIENCE_LEVELS: readonly ExperienceLevel[] = ['beginner', 'intermediate', 'expert'];

/** Default assists of every mode's new sessions become the chosen preset; the rest of the profile (stats, prefs) is kept. */
export function applyExperience(profile: ProfileSave, level: ExperienceLevel): ProfileSave {
  return { ...profile, assists: { ...ASSIST_PRESETS[level] }, onboarded: true };
}

export function needsOnboarding(profile: ProfileSave): boolean {
  return !profile.onboarded;
}

function seat(v: unknown, fallback: SeatChoice): SeatChoice {
  const r = asRecord(v);
  return { teamId: str(r.teamId, fallback.teamId, 32), driverId: str(r.driverId, fallback.driverId, 32) };
}

export function sanitizeProfile(v: unknown): ProfileSave {
  const d = defaultProfile();
  const r = asRecord(v);
  const gp = asRecord(r.gp);
  const tt = asRecord(r.tt);
  const sp = asRecord(r.split);
  return {
    assists: sanitizeAssists(r.assists, d.assists),
    onboarded: bool(r.onboarded, d.onboarded),
    stats: sanitizeStats(r.stats),
    gp: {
      ...seat(gp, d.gp),
      layoutId: str(gp.layoutId, '', 64, true),
      laps: oneOf(gp.laps, LAPS_CHOICES, d.gp.laps),
      aiDifficulty: int(gp.aiDifficulty, AI_DIFFICULTY_MIN, AI_DIFFICULTY_MAX, d.gp.aiDifficulty),
      weather: oneOf(gp.weather, WEATHER_CHOICES, d.gp.weather),
      timeOfDay: oneOf(gp.timeOfDay, TIME_OF_DAY_CHOICES, d.gp.timeOfDay),
      regulation: oneOf(gp.regulation, REGULATIONS, d.gp.regulation),
      format: oneOf(gp.format, WEEKEND_FORMATS, d.gp.format),
      qualifying: oneOf(gp.qualifying, QUALIFYING_TYPES, d.gp.qualifying),
      rules: sanitizeRules(gp.rules, d.gp.rules),
    },
    tt: {
      ...seat(tt, d.tt),
      layoutId: str(tt.layoutId, '', 64, true),
      regulation: oneOf(tt.regulation, REGULATIONS, d.tt.regulation),
      ghost: bool(tt.ghost, d.tt.ghost),
    },
    split: {
      layoutId: str(sp.layoutId, '', 64, true),
      laps: oneOf(sp.laps, LAPS_CHOICES, d.split.laps),
      weather: oneOf(sp.weather, WEATHER_CHOICES, d.split.weather),
      regulation: oneOf(sp.regulation, REGULATIONS, d.split.regulation),
      aiCount: int(sp.aiCount, 0, MAX_SPLIT_AI, d.split.aiCount),
      aiDifficulty: int(sp.aiDifficulty, AI_DIFFICULTY_MIN, AI_DIFFICULTY_MAX, d.split.aiDifficulty),
      p1: seat(sp.p1, d.split.p1),
      p2: seat(sp.p2, d.split.p2),
      p2Assists: sanitizeAssists(sp.p2Assists, d.split.p2Assists),
      rules: sanitizeRules(sp.rules, d.split.rules),
    },
  };
}

/** layoutId → saved car setup */
export type SetupBook = Record<string, CarSetup>;

export function sanitizeSetupBook(v: unknown): SetupBook {
  const out: SetupBook = {};
  for (const [key, raw] of Object.entries(asRecord(v))) {
    if (/^[a-z0-9-]{1,64}$/.test(key)) out[key] = sanitizeSetup(raw, DEFAULT_SETUP);
  }
  return out;
}
