/**
 * AI pace model: maps difficulty (0..110) and driver skills to how much of the car's capability the AI uses
 * (lateral / braking factors), its physics performanceScale, trail braking and kerb use, the pace mode multipliers
 * and the wet-weather factors. Shared by the on-track AI and the qualifying lap-time simulation so both agree.
 */
import type { AIPaceMode } from './types';
import type { DriverDef, TeamDef } from '../core/types';
import type { DriverStyle } from './personality';
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

/**
 * Pace parameters for a driver pace skill (0..1, ≈ 0.85..0.98) at a difficulty. The driver's share is wide enough
 * that a top driver is clearly quicker than the midfield in the same car (≈ 0.7 % lap time from pace 0.91 to 0.98),
 * more than its race-day form (RACE_FORM) usually takes away.
 */
export function paceParams(difficulty: number, driverPace: number): PaceParams {
  const d = difficulty01(difficulty);
  const p = clamp(fin(driverPace, 0.9), 0.5, 1) - 0.91;
  return {
    latFactor: clamp(0.755 + 0.26 * d + 0.3 * p, 0.6, 1.0),
    brakeFactor: clamp(0.67 + 0.27 * d + 0.2 * p, 0.55, 0.94),
    performance: clamp(0.96 + 0.06 * d, 0.9, 1.03),
  };
}

/**
 * Race-day form: an AI driver finds up to ± this share of its corner / braking factors on the day (races only),
 * scaled by its volatility (raceFormRange): a steady star stays close to its pace, an erratic driver has days out.
 */
export const RACE_FORM = 0.02;

/** Share of RACE_FORM a driver of this volatility (0..1) can swing on the day: 0.45 (steady) … 1 (erratic). */
export function raceFormRange(volatility: number): number {
  return 0.45 + 0.55 * clamp01(fin(volatility, 0.4));
}

/**
 * Driving-style multipliers on the capability (personality.ts), shared by the on-track AI and the qualifying
 * simulation: `low` on the speed-independent (mechanical) lateral grip, `high` on its aero (speed²) part — a
 * slow-corner specialist gains in hairpins what it gives away in fast sweepers — and `brake` on the braking factor
 * (a late braker gives a little mid-corner speed back). Each trait shifts the lap time by only a few tenths of a
 * percent; what changes is where on the lap a driver is quick, so cars close up in one sector and pull away in the
 * next instead of running in a fixed line.
 */
export interface StyleFactors {
  low: number;
  high: number;
  brake: number;
}

const STYLE_CORNER = 0.02;
const STYLE_BRAKE = 0.04;
const STYLE_BRAKE_LAT = 0.006;

/**
 * A style's lateral-grip gain is taken only where the driver still has headroom: a factor above 1 is cut so its share
 * of the grip stays ≤ STYLE_LAT_CEIL (or its own share when that is higher). A driver already near the limit (top
 * skill, high difficulty) keeps just the weak side of its style — at 0.997 of the grip through Monaco's slow corners a
 * slow-corner specialist ran over the track limits on every lap.
 */
const STYLE_LAT_CEIL = 0.98;

/** A style grip factor (StyleFactors low / high) for a driver using `latFactor` of the grip. */
export function styleGrip(factor: number, latFactor: number): number {
  if (!(factor > 1)) return factor;
  const lf = clamp(fin(latFactor, 0.9), 0.3, 1);
  return Math.min(factor, Math.max(1, STYLE_LAT_CEIL / lf));
}

export function styleFactors(style: DriverStyle): StyleFactors {
  const c = clamp(fin(style.corners, 0), -1, 1);
  const b = clamp(fin(style.braking, 0), -1, 1);
  return {
    low: 1 + STYLE_CORNER * c - STYLE_BRAKE_LAT * b,
    high: 1 - STYLE_CORNER * c - STYLE_BRAKE_LAT * b,
    brake: 1 + STYLE_BRAKE * b,
  };
}

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
