/**
 * AI pace model: maps difficulty (0..110) and driver skills to how much of the car's capability the AI uses
 * (lateral / braking factors), its physics performanceScale, trail braking and kerb use, the pace mode multipliers
 * and the wet-weather factors. Shared by the on-track AI and the qualifying lap-time simulation so both agree.
 */
import type { AIPaceMode } from './types';
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

/**
 * Wet-weather multiplier on the lateral / braking factors (wet skill matters more the wetter it is): at full
 * wetness −4 % for a perfect wet driver, −15 % at wet skill 0.84 (the field spans ≈ 0.83–0.95).
 */
export function wetPaceFactor(wetness: number, wetSkill: number): number {
  const w = clamp01(fin(wetness, 0));
  const skill = clamp01(fin(wetSkill, 0.88));
  return 1 - w * (0.04 + 0.7 * (1 - skill));
}

/** Extra wet braking caution per unit of wetness × (1 − wet skill) (on top of wetPaceFactor). */
const WET_BRAKE_CAUTION = 0.3;

/** Extra multiplier on the braking factor in the wet: a poor wet driver brakes earlier still (−4.8 % at wet skill 0.84, full wetness). */
export function wetBrakeFactor(wetness: number, wetSkill: number): number {
  const w = clamp01(fin(wetness, 0));
  const skill = clamp01(fin(wetSkill, 0.88));
  return 1 - w * WET_BRAKE_CAUTION * (1 - skill);
}

/**
 * Share of the trail-braking / kerb technique still used on a wet track (kerbs and a loaded rear are treacherous in
 * the wet; a poor wet driver backs off more): full wetness → 0.26 at wet skill 0.84, 0.46 at 0.95.
 */
export function wetTechnique(wetness: number, wetSkill: number): number {
  const w = clamp01(fin(wetness, 0));
  const skill = clamp01(fin(wetSkill, 0.88));
  return clamp01(1 - w * (0.5 + 2 * (1 - skill)));
}

/** Natural-mistake multiplier in the wet for a driver's wet skill (1 + 2·wet·(1 − wetSkill)). */
export function wetMistakeFactor(wetness: number, wetSkill: number): number {
  const w = clamp01(fin(wetness, 0));
  const skill = clamp01(fin(wetSkill, 0.88));
  return 1 + 2 * w * (1 - skill);
}

/** Upper bound of the trail-braking coefficient (brakingDecel: share of the way from 1 − r² toward √(1 − r²)). */
export const TRAIL_MAX = 0.85;
/**
 * Kerb use (share of KERB_REACH): KERB_BASE for the least technical driver, + KERB_TECH × technique (× difficulty
 * scale) — ≈ 0.26–0.39 at difficulty 90, i.e. the car centre runs 0.95–1.07 m inside the white line on a kerb (was
 * 1.3 m). Kept well short of the line: the physics takes the surface under the car centre, and in traffic the AI
 * tracks its line within ≈ 0.5 m — with 0.9 m of reach (centre 0.4–0.6 m from the line) cars slid on the kerb at
 * the apex and heavy contacts / spins rose sharply in multi-seed headless races (Silverstone T10).
 */
const KERB_BASE = 0.3;
const KERB_TECH = 0.25;

/**
 * 0..1 car-control technique from pace and consistency: 0 for the field's slowest (≈ 0.85), ≈ 0.63 for the best
 * (varga 0.97 / 0.95). Kept moderate: trail braking widens the qualifying spread by roughly 1 % × technique.
 */
function technique(driverPace: number, consistency: number): number {
  return clamp01((0.5 * fin(driverPace, 0.88) + 0.5 * fin(consistency, 0.88) - 0.86) / 0.16);
}

/** How much of its technique the AI shows at a difficulty (0.2 at 0, 0.85 at 90, 1 at 110). */
function techniqueScale(difficulty: number): number {
  return 0.2 + 0.8 * difficulty01(difficulty);
}

/**
 * Trail-braking coefficient 0..TRAIL_MAX for a driver at a difficulty: ≈ 0.45 for the best driver at difficulty 90
 * (≈ 0.3–0.6 % lap time on the point-mass model), 0 for the least technical.
 */
export function trailBraking(difficulty: number, driverPace: number, consistency: number): number {
  return clamp(TRAIL_MAX * technique(driverPace, consistency) * techniqueScale(difficulty), 0, TRAIL_MAX);
}

/** Kerb use 0..1 (share of KERB_REACH over a kerb the AI path may use) for a driver at a difficulty. */
export function kerbSkill(difficulty: number, driverPace: number, consistency: number): number {
  return clamp01((KERB_BASE + KERB_TECH * technique(driverPace, consistency)) * techniqueScale(difficulty));
}

/** Pace mode multipliers on the corner / braking factors: push +1.2 %, conserve −1.5 %. */
export const PACE_MODE_FACTOR: Readonly<Record<AIPaceMode, number>> = { push: 1.012, standard: 1, conserve: 0.985 };

/** Overall 0..1 skill blend used for display and small behaviour tweaks. */
export function skillBlend(driver: DriverDef): number {
  const s = driver.skill;
  return clamp01(
    (fin(s.pace, 0.88) * 0.4 + fin(s.racecraft, 0.88) * 0.2 + fin(s.awareness, 0.88) * 0.15 + fin(s.consistency, 0.88) * 0.25),
  );
}
