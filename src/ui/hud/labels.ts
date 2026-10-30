/**
 * zh-TW labels and pure formatting / classification helpers for the HUD (no DOM, no three.js).
 */
import type {
  CameraMode,
  DamageState,
  ErsMode,
  RacingLineMode,
  SessionKind,
  SpeedUnit,
  TireCompound,
  WeatherKind,
} from '../../core/types';
import { msToKmh, msToMph } from '../../core/math';
import { COMPOUNDS } from '../../core/defaults';

export const SESSION_LABEL: Record<SessionKind, string> = {
  practice: '練習賽',
  qualifying: '排位賽',
  race: '正賽',
  timeTrial: '計時賽',
};

/** Session name; a sprint race is 衝刺賽 instead of 正賽. */
export function sessionLabel(kind: SessionKind, sprint?: boolean): string {
  return kind === 'race' && sprint ? '衝刺賽' : (SESSION_LABEL[kind] ?? '');
}

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: '晴天',
  overcast: '陰天',
  lightRain: '小雨',
  heavyRain: '大雨',
};

export const ERS_MODES: readonly ErsMode[] = ['none', 'medium', 'hotlap', 'overtake'];
export const ERS_LABEL: Record<ErsMode, string> = {
  none: '關閉',
  medium: '中等',
  hotlap: '飛馳圈',
  overtake: '超車',
};

export const CAMERA_ORDER: readonly CameraMode[] = ['chase', 'chaseFar', 'tcam', 'cockpit', 'nose', 'tv'];
export const CAMERA_LABEL: Record<CameraMode, string> = {
  chase: '追焦',
  chaseFar: '遠追焦',
  tcam: 'T 字鏡頭',
  cockpit: '座艙',
  nose: '鼻錐',
  tv: '電視轉播',
};

export const RACING_LINE_ORDER: readonly RacingLineMode[] = ['off', 'corners', 'full'];
export const RACING_LINE_LABEL: Record<RacingLineMode, string> = {
  off: '關閉',
  corners: '僅彎道',
  full: '完整',
};

export const DAMAGE_PART_LABEL: Record<keyof DamageState, string> = {
  frontWing: '前翼',
  rearWing: '尾翼',
  floor: '底板',
  suspension: '懸吊',
};

export const REPLAY_SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

export const ALL_COMPOUNDS: readonly TireCompound[] = COMPOUNDS;

/** Finite number or fallback. */
export const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/** Online round trip (ms) from which the HUD's ping turns amber / red. */
export const PING_WARN_MS = 100;
export const PING_BAD_MS = 200;

/** One online link's round trip: `name` null = the own link to the host; `ms` null = not measured yet. */
export interface PingItem {
  name: string | null;
  ms: number | null;
}

/** 「延遲 32 ms」, 「延遲 Ann 32 ms・Bo —」; '' with nothing to show. */
export function pingText(items: readonly PingItem[]): string {
  if (items.length === 0) return '';
  const part = (i: PingItem): string => {
    const ms = i.ms !== null && Number.isFinite(i.ms) ? `${Math.max(0, Math.round(i.ms))} ms` : '—';
    return i.name ? `${i.name} ${ms}` : ms;
  };
  return `延遲 ${items.map(part).join('・')}`;
}

/** 'warn' / 'bad' by the worst measured round trip; null when all are fine (or none is measured). */
export function pingLevel(items: readonly PingItem[]): 'warn' | 'bad' | null {
  let worst = 0;
  for (const i of items) if (i.ms !== null && Number.isFinite(i.ms)) worst = Math.max(worst, i.ms);
  return worst >= PING_BAD_MS ? 'bad' : worst >= PING_WARN_MS ? 'warn' : null;
}

/** Speed for display in the selected unit, rounded, never negative. */
export function displaySpeed(ms: number, units: SpeedUnit): number {
  const v = Math.max(0, fin(ms));
  return Math.round(units === 'mph' ? msToMph(v) : msToKmh(v));
}

export const unitLabel = (units: SpeedUnit): string => (units === 'mph' ? 'mph' : 'km/h');

/** -1 → R, 0 → N, 1..8 → digit. */
export function gearLabel(gear: number): string {
  if (!Number.isFinite(gear)) return 'N';
  const g = Math.round(gear);
  if (g < 0) return 'R';
  if (g === 0) return 'N';
  return String(g);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Clock style m:ss (h:mm:ss above an hour). `ceil` rounds up (countdowns). */
export function formatClock(sec: number | null | undefined, ceil = false): string {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const total = Math.max(0, ceil ? Math.ceil(sec - 1e-6) : Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Live delta: "+0.123", "-0.456", "±0.000". */
export function formatDelta(sec: number): string {
  if (!Number.isFinite(sec)) return '--';
  const ms = Math.round(sec * 1000);
  if (ms === 0) return '±0.000';
  const abs = Math.min(Math.abs(ms), 599_999) / 1000;
  return `${ms < 0 ? '-' : '+'}${abs.toFixed(3)}`;
}

/** Unsigned seconds with 3 decimals, e.g. gap to the car ahead. */
export function formatSeconds(sec: number, digits = 3): string {
  if (!Number.isFinite(sec)) return '--';
  return Math.abs(sec).toFixed(digits);
}

/** Sector time "28.341" (or m:ss.mmm above a minute). */
export function formatSectorTime(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--.---';
  if (sec < 60) return sec.toFixed(3);
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(3).padStart(6, '0')}`;
}

export type SectorState = 'pending' | 'live' | 'overall' | 'personal' | 'slower' | 'invalid';

const BEST_EPS = 0.0005;

/** Timing colour convention: purple = overall best, green = personal best, yellow = slower. */
export function classifySector(time: number | null, personalBest: number | null, overallBest: number | null): SectorState {
  if (time == null || !Number.isFinite(time)) return 'pending';
  if (overallBest != null && Number.isFinite(overallBest) && time <= overallBest + BEST_EPS) return 'overall';
  if (personalBest != null && Number.isFinite(personalBest) && time <= personalBest + BEST_EPS) return 'personal';
  return 'slower';
}

/** '#rrggbb' or a neutral fallback (never lets arbitrary strings into styles). */
export function safeColor(c: unknown, fallback = '#8a93a3'): string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}

export type DamageBand = 'ok' | 'minor' | 'major' | 'severe';
export function damageBand(level: number): DamageBand {
  const v = fin(level);
  if (v < 0.05) return 'ok';
  if (v < 0.35) return 'minor';
  if (v < 0.7) return 'major';
  return 'severe';
}

export type TempBand = 'cold' | 'cool' | 'optimal' | 'warm' | 'hot';
/** Classify a tyre temperature against an optimal window. */
export function tempBand(temp: number, window: { lo: number; hi: number }): TempBand {
  if (!Number.isFinite(temp)) return 'optimal';
  if (temp < window.lo - 15) return 'cold';
  if (temp < window.lo) return 'cool';
  if (temp <= window.hi) return 'optimal';
  if (temp <= window.hi + 12) return 'warm';
  return 'hot';
}

/** Next element in a cyclic list (unknown current → first). */
export function cycle<T>(list: readonly T[], current: T, step: 1 | -1): T {
  const n = list.length;
  const i = list.indexOf(current);
  if (i < 0) return list[0];
  return list[(((i + step) % n) + n) % n];
}

/** Seconds between two repeats of the same HUD notice (a key held / mashed must not spam toasts). */
export const NOTICE_GAP = 3;

/** Per-key rate limiter driven by frame time: `fire(key)` is true at most once per `gap` seconds of `tick`ed time. */
export class NoticeGate {
  private readonly wait = new Map<number, number>();
  constructor(private readonly gap = NOTICE_GAP) {}
  tick(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const [key, left] of this.wait) {
      if (left <= step) this.wait.delete(key);
      else this.wait.set(key, left - step);
    }
  }
  fire(key: number): boolean {
    if (this.wait.has(key)) return false;
    this.wait.set(key, this.gap);
    return true;
  }
}

/**
 * What the pause key / pad B does: while paused it first closes the 操作說明 panel (`closeHelp` true = something
 * was closed) and only resumes when nothing was.
 */
export function pauseKeyOutcome(paused: boolean, closeHelp: () => boolean): 'pause' | 'resume' | 'stay' {
  if (!paused) return 'pause';
  return closeHelp() ? 'stay' : 'resume';
}
