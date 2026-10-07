/**
 * Neutralised paces shared by race control and the AI: VSC reference speed, safety-car pace and formation-lap pace,
 * each derived from the track's reference speed profile, plus a look-ahead version that brakes in time for the
 * slower paced speed of the next corner. Pure functions (no world state).
 */
import type { BuiltTrack } from '../core/types';
import { clamp } from '../core/math';
import { sampleAt } from '../track/track';

/** VSC reference speed: fraction of the reference profile, clamped (m/s). */
export const VSC_SPEED_FACTOR = 0.6;
export const VSC_MIN_SPEED = 12;
export const VSC_MAX_SPEED = 50;
/** Safety-car pace: fraction of the reference profile and cap (m/s). */
export const SC_SPEED_FACTOR = 0.58;
export const SC_MAX_SPEED = 52;
/** Formation-lap pace: fraction of the reference profile and cap (m/s). */
export const FORMATION_SPEED_FACTOR = 0.62;
export const FORMATION_MAX_SPEED = 55;
/** Minimum paced speed (m/s) and the deceleration (m/s²) assumed when looking ahead. */
const MIN_PACE = 10;
const PACE_DECEL = 7;
/** Look-ahead sample distances (m). */
const LOOK_AHEAD = [0, 25, 50, 80, 120, 170, 230];

/** Paced speed exactly at s. */
export function pacedSpeedAt(track: BuiltTrack, s: number, factor: number, maxSpeed: number): number {
  return clamp(sampleAt(track, track.speedProfile, s) * factor, MIN_PACE, maxSpeed);
}

/** Paced speed at s that also allows braking (PACE_DECEL) down to the paced speed of the next ~230 m. */
export function pacedSpeedAhead(track: BuiltTrack, s: number, factor: number, maxSpeed: number): number {
  let v = Infinity;
  for (const d of LOOK_AHEAD) {
    const t = pacedSpeedAt(track, s + d, factor, maxSpeed);
    v = Math.min(v, Math.sqrt(t * t + 2 * PACE_DECEL * d));
  }
  return v;
}

/** VSC reference speed at s (the delta is measured against it). */
export const vscRefSpeed = (track: BuiltTrack, s: number): number => pacedSpeedAt(track, s, VSC_SPEED_FACTOR, VSC_MAX_SPEED);
