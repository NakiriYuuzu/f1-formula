/**
 * What the pit status pill says, and when (pure: timing.ts draws it). Called in, a driver driving the visit gets the
 * distance to the entry and a brake cue for the speed-limit line, then on the entry road and in the lane the speed
 * against the limit (warned over it), and a missed entry is called out; a stop reads as held (an unserved penalty,
 * repairs) before the tyre change.
 */
import type { PitPhase, SpeedUnit, TireCompound } from '../../core/types';
import { COMPOUND_INFO } from '../../core/defaults';
import { displaySpeed, fin, unitLabel } from './labels';

/** The approach cue shows within this distance (m) of the pit entry. */
export const PIT_APPROACH_CUE = 500;
/** Brake cue: braking at PIT_BRAKE_DECEL (m/s²) after PIT_BRAKE_REACTION (s) only just meets the limit at the line. */
export const PIT_BRAKE_DECEL = 24;
export const PIT_BRAKE_REACTION = 0.4;
/** Over the limit by more than this (m/s, ≈ 1 km/h; the penalty comes at 2 km/h): warned. */
export const PIT_OVER_WARN = 0.3;
/** A missed entry is called out from this share of the entry road (a driver still on the track there stays out) to
 * PIT_MISSED_SHOW m past its end. */
export const PIT_MISSED_FROM = 0.6;
export const PIT_MISSED_SHOW = 300;

export interface PitGuideInput {
  phase: PitPhase;
  requested: boolean;
  /** still racing (not finished, not retired) */
  active: boolean;
  /** the driver drives the car's visits (race drivesOwnPitVisit) */
  manual: boolean;
  /** the box autopilot has the car (CarRaceInternal.pitAuto) */
  auto: boolean;
  speed: number;
  limiter: boolean;
  /** metres to the pit entry ahead, and past it */
  toEntry: number;
  sinceEntry: number;
  /** entry road (m: the entry to the speed-limit line) and the limit (m/s) */
  ramp: number;
  limit: number;
  /** the stop: seconds left, its length, the part of it held before the tyre change, and whether repairs are in it */
  timer: number;
  stopTotal: number;
  hold: number;
  repair: boolean;
  compound: TireCompound;
}

export type PitGuide =
  | { kind: 'none' }
  /** called in for this lap */
  | { kind: 'called'; compound: TireCompound }
  /** a driver coming up to the entry: metres to it; brake now to meet the limit at the line */
  | { kind: 'approach'; distance: number; brake: boolean; compound: TireCompound }
  /** called in, still on the track past the entry */
  | { kind: 'missed' }
  /** a driver on the entry road: metres to the speed-limit line, the speed against the limit */
  | { kind: 'entryRoad'; toLine: number; speed: number; limit: number; brake: boolean; limiter: boolean }
  /** between the lines: the speed against the limit while the driver drives (over: warned), the limit otherwise */
  | { kind: 'lane'; speed: number; limit: number; driven: boolean; over: boolean }
  /** standing in the box, held before the tyre change: seconds left of the hold */
  | { kind: 'hold'; left: number; repair: boolean }
  /** the tyre change: seconds left */
  | { kind: 'service'; left: number }
  | { kind: 'exit' };

/** Would braking now only just meet the limit by `toLine` metres (after the reaction time)? */
function brakeNow(speed: number, limit: number, toLine: number): boolean {
  if (!(speed > limit)) return false;
  return toLine - speed * PIT_BRAKE_REACTION <= (speed * speed - limit * limit) / (2 * PIT_BRAKE_DECEL);
}

export function pitGuide(g: PitGuideInput): PitGuide {
  const speed = Math.max(0, fin(g.speed));
  switch (g.phase) {
    case 'entry':
      if (!g.manual || g.auto) return { kind: 'lane', speed, limit: g.limit, driven: false, over: false };
      return { kind: 'entryRoad', toLine: Math.max(0, g.ramp - g.sinceEntry), speed, limit: g.limit, brake: brakeNow(speed, g.limit, g.ramp - g.sinceEntry), limiter: g.limiter };
    case 'lane': {
      const driven = g.manual && !g.auto;
      return { kind: 'lane', speed, limit: g.limit, driven, over: driven && speed > g.limit + PIT_OVER_WARN };
    }
    case 'stopped': {
      const elapsed = g.stopTotal - g.timer;
      if (elapsed < g.hold) return { kind: 'hold', left: Math.max(0, g.hold - elapsed), repair: g.repair };
      return { kind: 'service', left: Math.max(0, g.timer) };
    }
    case 'exit':
      return { kind: 'exit' };
    default:
      break;
  }
  if (!g.requested || !g.active) return { kind: 'none' };
  if (g.sinceEntry >= g.ramp * PIT_MISSED_FROM && g.sinceEntry < g.ramp + PIT_MISSED_SHOW) return { kind: 'missed' };
  // turning in: the visit starts once the car is on the pit road
  if (g.manual && g.sinceEntry < g.ramp * PIT_MISSED_FROM) {
    return { kind: 'entryRoad', toLine: g.ramp - g.sinceEntry, speed, limit: g.limit, brake: brakeNow(speed, g.limit, g.ramp - g.sinceEntry), limiter: g.limiter };
  }
  if (g.manual && g.toEntry < PIT_APPROACH_CUE) {
    return { kind: 'approach', distance: g.toEntry, brake: brakeNow(speed, g.limit, g.toEntry + g.ramp), compound: g.compound };
  }
  return { kind: 'called', compound: g.compound };
}

/** Pill look: called in, on the pit lane, a warning (brake, over the limit, missed entry), held, the tyre change. */
export type PitPillState = 'box' | 'lane' | 'warn' | 'hold' | 'stop';

/** The pill's text and look (null: no pill). */
export function pitGuideLabel(g: PitGuide, units: SpeedUnit): { text: string; state: PitPillState } | null {
  const speedText = (v: number): string => `${displaySpeed(v, units)}`;
  const unit = unitLabel(units);
  const tyre = (c: TireCompound): string => COMPOUND_INFO[c]?.label ?? '';
  switch (g.kind) {
    case 'called':
      return { text: `本圈進站 · ${tyre(g.compound)}`, state: 'box' };
    case 'approach':
      if (g.brake) return { text: `減速進站 · 進站口 ${Math.round(g.distance)} m`, state: 'warn' };
      return { text: `進站口 ${Math.round(g.distance)} m · ${tyre(g.compound)}`, state: 'box' };
    case 'missed':
      return { text: '錯過進站口 · 下圈再進站', state: 'warn' };
    case 'entryRoad': {
      const line = `限速線 ${Math.round(g.toLine)} m`;
      if (g.brake) return { text: `減速 ${speedText(g.speed)}/${speedText(g.limit)} ${unit} · ${line}`, state: 'warn' };
      return { text: g.limiter ? `限速器已開 · ${line}` : `開啟限速器 · ${line}`, state: 'lane' };
    }
    case 'lane':
      if (!g.driven) return { text: `維修道限速 ${speedText(g.limit)} ${unit}`, state: 'lane' };
      return { text: `${g.over ? '超速 ' : ''}${speedText(g.speed)}/${speedText(g.limit)} ${unit}`, state: g.over ? 'warn' : 'lane' };
    case 'hold':
      return { text: `${g.repair ? '維修中' : '執行罰時'} ${g.left.toFixed(1)} 秒`, state: 'hold' };
    case 'service':
      return { text: `換胎中 ${g.left.toFixed(1)} 秒`, state: 'stop' };
    case 'exit':
      return { text: '駛出維修道', state: 'lane' };
    default:
      return null;
  }
}
