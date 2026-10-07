/**
 * AI pace model: maps difficulty (0..110) and driver skills to how much of the car's capability the AI uses
 * (lateral / braking factors) and its physics performanceScale. Shared by the on-track AI and the qualifying
 * lap-time simulation so both agree.
 */
import type { DriverDef, TeamDef } from '../core/types';
import { clamp, clamp01 } from '../core/math';

export const DIFFICULTY_MAX = 110;

export interface PaceParams {
  /** fraction of the steady-state lateral grip used for corner speeds */
  latFactor: number;
  /** fraction of the straight-line braking capability used for braking points */
  brakeFactor: number;
  /** physics performanceScale (power fully, grip at 60 %) */
  performance: number;
}

const fin = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** Normalised difficulty 0..1 (110 → 1). */
export function difficulty01(difficulty: number): number {
  return clamp01(fin(difficulty, 90) / DIFFICULTY_MAX);
}

/** Pace parameters for a driver pace skill (0..1, ≈ 0.85..0.97) at a difficulty. */
export function paceParams(difficulty: number, driverPace: number): PaceParams {
  const d = difficulty01(difficulty);
  const p = clamp(fin(driverPace, 0.9), 0.5, 1) - 0.91;
  return {
    latFactor: clamp(0.755 + 0.26 * d + 0.15 * p, 0.6, 1.0),
    brakeFactor: clamp(0.67 + 0.27 * d + 0.1 * p, 0.55, 0.94),
    performance: clamp(0.96 + 0.06 * d, 0.9, 1.03),
  };
}

/** Race-day form: an AI driver finds up to ± this share of its corner / braking factors on the day (races only). */
export const RACE_FORM = 0.02;

/** Share of a team's aero / power / chassis gap to a rating of 1 that an AI-driven car keeps (closer field). */
export const AI_CAR_GAP = 0.4;

/**
 * Team ratings an AI-driven car runs with: gaps to the best rating shrunk to AI_CAR_GAP. Not for a team a human
 * drives for (the AI team-mate keeps the player's car).
 */
export function aiCarTeam(team: TeamDef): TeamDef {
  const r = team.rating;
  const lift = (v: number): number => (v < 1 ? 1 - (1 - v) * AI_CAR_GAP : v);
  return { ...team, rating: { ...r, aero: lift(r.aero), power: lift(r.power), chassis: lift(r.chassis) } };
}

/** Wet-weather multiplier on the lateral / braking factors (wet skill matters more the wetter it is). */
export function wetPaceFactor(wetness: number, wetSkill: number): number {
  const w = clamp01(fin(wetness, 0));
  const skill = clamp01(fin(wetSkill, 0.88));
  return 1 - w * (0.05 + 0.5 * (1 - skill));
}

/** Overall 0..1 skill blend used for display and small behaviour tweaks. */
export function skillBlend(driver: DriverDef): number {
  const s = driver.skill;
  return clamp01(
    (fin(s.pace, 0.88) * 0.4 + fin(s.racecraft, 0.88) * 0.2 + fin(s.awareness, 0.88) * 0.15 + fin(s.consistency, 0.88) * 0.25),
  );
}
