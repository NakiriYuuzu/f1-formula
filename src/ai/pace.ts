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

/** Pace skill the pace terms are anchored to: the best possible driver. */
const PACE_TOP = 1;
/**
 * A generational talent — pace above ELITE_PACE (Verstappen; the rest of the 2026 grid tops out at 0.965) — finds
 * grip and drive others do not: ELITE_PERF × its pace beyond ELITE_PACE on the physics performanceScale (power fully,
 * grip at 60 %), on top of the lateral / braking factors, so the edge stands at every difficulty, also where those
 * factors reach the limit. Pace 1: +1.75 % — simulated qualifying ≈ 1.0 % ahead of Antonelli / Hamilton at every
 * difficulty (0.33 % with the factors alone); 8-lap races on equal tyres, difficulty 85 / 100: average finish 1.05 / 1.0
 * from pole (with 0.3: 1.2).
 */
const ELITE_PACE = 0.965;
const ELITE_PERF = 0.5;

/**
 * Pace parameters for a driver pace skill (0..1, ≈ 0.85..1) at a difficulty. The driver's share is wide enough that
 * a top driver is clearly quicker than the midfield in the same car (≈ 0.9 % lap time from pace 0.91 to 1), more than
 * its race-day form (RACE_FORM) usually takes away. Anchored to PACE_TOP: a driver of pace 1 reaches the limit (lateral
 * 1, braking 0.94) at high difficulty and everyone else stays its pace gap below — a plain clamp at the limit gave
 * the whole top half the same factors from difficulty ≈ 95 on (below that the two are identical).
 */
export function paceParams(difficulty: number, driverPace: number): PaceParams {
  const d = difficulty01(difficulty);
  const pace = clamp(fin(driverPace, 0.9), 0.5, 1);
  const gap = PACE_TOP - pace;
  return {
    latFactor: clamp(Math.min(1, 0.782 + 0.26 * d) - 0.3 * gap, 0.6, 1.0),
    brakeFactor: clamp(Math.min(0.94, 0.688 + 0.27 * d) - 0.2 * gap, 0.55, 0.94),
    performance: clamp(0.96 + 0.06 * d, 0.9, 1.03) + ELITE_PERF * Math.max(0, pace - ELITE_PACE),
  };
}

/**
 * Attack / defence skill 0..1 from racecraft and awareness, scaled by difficulty (0.35 at 0, 1 at 110): how soon a
 * driver covers a car behind, how often it can do so again, how small a move it reads and how little closing speed
 * it needs to try a pass (traffic.ts). ≈ 0.85 for the best racer at difficulty 85, 0.3 for the midfield, 0.1 for the
 * weakest.
 */
export function racecraftSkill(difficulty: number, racecraft: number, awareness: number): number {
  const skill = clamp01((0.65 * fin(racecraft, 0.88) + 0.35 * fin(awareness, 0.88) - 0.83) / 0.14);
  return skill * (0.35 + 0.65 * difficulty01(difficulty));
}

/**
 * Race-day form: an AI driver finds up to ± this share of its corner / braking factors on the day (races only),
 * scaled by its volatility (raceFormRange): a steady star stays close to its pace, an erratic driver has days out.
 */
export const RACE_FORM = 0.02;

/**
 * Share of RACE_FORM a driver of this volatility (0..1) can swing on the day: 0.25 (steady) … 1 (erratic). (From
 * 0.45, a steady star still lost ± 0.9 % on a bad day — as much as its edge on the next best driver.)
 */
export function raceFormRange(volatility: number): number {
  return 0.25 + 0.75 * clamp01(fin(volatility, 0.4));
}

/**
 * Driving-style multipliers on the capability (personality.ts), shared by the on-track AI and the qualifying
 * simulation: `low` on the speed-independent (mechanical) lateral grip, `high` on its aero (speed²) part — a
 * slow-corner specialist gains in hairpins what it gives away in fast sweepers — and `brake` on the braking factor
 * (a late braker gives a little mid-corner speed back). Both traits are lap-time neutral over a season (point-mass
 * laps on 8 circuits: corners ±1 → ±0.003 %, braking ±1 → −0.01 / +0.03 %); what changes is where a driver is quick —
 * a slow-corner specialist ±0.14 % at Monaco / Silverstone — so cars close up in one sector and pull away in the next.
 * Mechanical grip is worth ≈ 2.7 × as much lap time per percent as aero grip, hence STYLE_HIGH = 2.7 × STYLE_LOW (an
 * equal ±2 % made every slow-corner specialist 0.28 % quicker on every circuit, Monza included).
 */
export interface StyleFactors {
  low: number;
  high: number;
  brake: number;
}

const STYLE_LOW = 0.01;
const STYLE_HIGH = 0.027;
const STYLE_BRAKE = 0.04;
const STYLE_BRAKE_LAT = 0.006;

export function styleFactors(style: DriverStyle): StyleFactors {
  const c = clamp(fin(style.corners, 0), -1, 1);
  const b = clamp(fin(style.braking, 0), -1, 1);
  return {
    low: 1 + STYLE_LOW * c - STYLE_BRAKE_LAT * b,
    high: 1 - STYLE_HIGH * c - STYLE_BRAKE_LAT * b,
    brake: 1 + STYLE_BRAKE * b,
  };
}

/**
 * A style's lateral-grip gain must keep the driver's share of the grip ≤ STYLE_LAT_CEIL (at 0.997 of the grip through
 * Monaco's slow corners a slow-corner specialist ran over the track limits on every lap). Where the gain does not fit,
 * the whole style shrinks with it — gain, loss and braking trade alike — so it stays neutral: a driver already at the
 * limit (top skill, high difficulty) drives without one. (Cutting only the gain left the stars just the weak side of
 * their style: Verstappen −1 % in slow corners, Antonelli 0.8 % slower at Monaco.)
 */
const STYLE_LAT_CEIL = 0.98;

/** The style factors a driver using `latFactor` of the grip can carry (fitted to STYLE_LAT_CEIL). */
export function fitStyle(sf: StyleFactors, latFactor: number): StyleFactors {
  const lf = clamp(fin(latFactor, 0.9), 0.3, 1);
  const gain = Math.max(sf.low - 1, sf.high - 1, 0);
  const room = Math.max(0, STYLE_LAT_CEIL / lf - 1);
  const k = gain > room ? room / gain : 1;
  return { low: 1 + k * (sf.low - 1), high: 1 + k * (sf.high - 1), brake: 1 + k * (sf.brake - 1) };
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
