/**
 * AI drivers (owner: race/AI agent). Pure logic — must NOT import three.js.
 * createAIState builds the plain-data brain; computeAIInput drives (racing line, racecraft, speed control);
 * decidePitStop is the strategy hook the race runtime calls for AI cars.
 */
import type { AIState, BuiltTrack, CarEntry, ControlInput, DriverDef, WorldState } from '../core/types';
import { clamp, clamp01, nextRandom } from '../core/math';
import { driveAI } from './controller';
import { RACE_FORM, paceParams, skillBlend } from './pace';

export type { AIMode } from './types';
export { neutralInput, lookaheadDistance, steerToward, pursuitAngle, carGripScale } from './controller';
export { paceParams, wetPaceFactor, difficulty01, aiCarTeam, AI_CAR_GAP, RACE_FORM, DIFFICULTY_MAX, type PaceParams } from './pace';
export { capability, cornerSpeed, brakingDecel, targetSpeedAt, lineCurvatureAt, SPEED_CAP, type Capability } from './profile';
export { decidePitStop, chooseDryCompound, weatherCompound, wearPerLap, isDry, PIT_WEAR, type StrategyContext } from './strategy';
export { alongSpeed, isObstacle } from './traffic';
export { safetyCarCap } from './neutral';

const fin = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** Create the AI brain for a driver at a difficulty (0..110). Deterministic for a given seed. */
export function createAIState(driver: DriverDef, difficulty: number, seed: number): AIState {
  const sk = driver.skill;
  const pace = paceParams(difficulty, fin(sk.pace, 0.88));
  const rng = { s: (Math.floor(Math.abs(fin(seed, 1))) >>> 0) ^ 0x6a09e667 };
  const racecraft = clamp01(fin(sk.racecraft, 0.88));
  const awareness = clamp01(fin(sk.awareness, 0.88));
  const consistency = clamp01(fin(sk.consistency, 0.88));
  // derive personality numbers from the seeded stream (one draw each, fixed order)
  const r1 = nextRandom(rng);
  const r2 = nextRandom(rng);
  return {
    skill: skillBlend(driver),
    targetLateral: 0,
    difficulty: clamp(fin(difficulty, 90), 0, 110),
    latFactor: pace.latFactor,
    brakeFactor: pace.brakeFactor,
    performance: pace.performance,
    racecraft,
    awareness,
    wetSkill: clamp01(fin(sk.wet, 0.88)),
    consistency,
    aggression: clamp01(0.55 + (racecraft - 0.85) * 2 + (r1 - 0.5) * 0.3),
    reaction: 0.16 + (1 - awareness) * 0.8 + r2 * 0.12,
    rng,
    offset: 0,
    lineNoise: 0,
    lineNoiseTarget: 0,
    noiseTimer: 0,
    brakeNoise: 1,
    noiseCorner: -1,
    mistakeTimer: 0,
    integral: 0,
    mode: 'race',
    attackSide: 0,
    attackTarget: -1,
    attackTimer: 0,
    closing: 0,
    gapTime: 0,
    gapAt: 0,
    gapCar: -1,
    followTimer: 0,
    paceTime: 0,
    defendOffset: 0,
    defendTimer: 0,
    defendCooldown: 0,
    stuckTimer: 0,
    recoverTimer: 0,
    recoverDist: 0,
    launchTimer: 0,
    strategyLap: -1,
    stintWear: 0,
    stintStartLap: 0,
    plannedCompound: 'medium',
    weatherTimer: 0,
    failing: false,
    failSide: 1,
    crashTimer: 0,
  };
}

/**
 * Race-day form (races only, after paceTime is set): the driver finds up to ± RACE_FORM of its corner / braking
 * factors on the day, so the race order is not just the grid order. Seeded from the car's own stream.
 */
export function applyRaceForm(ai: AIState): void {
  const form = 1 + (nextRandom(ai.rng) * 2 - 1) * RACE_FORM;
  ai.latFactor = Math.min(1, ai.latFactor * form);
  ai.brakeFactor = Math.min(0.97, ai.brakeFactor * form);
  // ≈ 0.44 % lap time per 1 % of both factors
  if (ai.paceTime > 0) ai.paceTime *= 1 - 0.44 * (form - 1);
}

/** Compute this step's controls for an AI car (racing line following, overtaking, defending, avoidance, DRS/ERS use). */
export function computeAIInput(world: WorldState, car: CarEntry, track: BuiltTrack, dt: number): ControlInput {
  return driveAI(world, car, track, dt);
}
