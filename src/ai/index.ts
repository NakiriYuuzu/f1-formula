/**
 * AI drivers (owner: race/AI agent). Pure logic — must NOT import three.js.
 * createAIState builds the plain-data brain; computeAIInput drives (racing line, racecraft, speed control);
 * decidePitStop is the strategy hook the race runtime calls for AI cars.
 */
import type { AIState, BuiltTrack, CarEntry, ControlInput, DriverDef, WorldState } from '../core/types';
import { clamp, clamp01, nextRandom } from '../core/math';
import { driveAI } from './controller';
import { RACE_FORM, kerbSkill, paceParams, skillBlend, trailBraking } from './pace';

export type { AIMode, AIPaceMode, AIMistake, AIAttackPhase, AIPitCall } from './types';
export { neutralInput, lookaheadDistance, steerToward, pursuitAngle, carGripScale } from './controller';
export {
  paceParams,
  wetPaceFactor,
  wetBrakeFactor,
  wetTechnique,
  wetMistakeFactor,
  trailBraking,
  kerbSkill,
  difficulty01,
  aiCarTeam,
  AI_CAR_GAP,
  RACE_FORM,
  DIFFICULTY_MAX,
  PACE_MODE_FACTOR,
  TRAIL_MAX,
  type PaceParams,
} from './pace';
export { capability, cornerSpeed, brakingDecel, targetSpeedAt, lineCurvatureAt, kerbLineAt, kerbReachAt, KERB_REACH, SPEED_CAP, type Capability } from './profile';
export { naturalMistakeChance, drawNaturalMistake } from './controller';
export {
  decidePitStop,
  chooseDryCompound,
  weatherCompound,
  wearPerLap,
  isDry,
  planRace,
  tyreLapFactor,
  PIT_WEAR,
  FINISH_WEAR,
  CLIFF_WEAR,
  GRIP_SENSITIVITY,
  YIELD_TIME,
  type StrategyContext,
  type PlanInput,
  type PlanResult,
  type RacePlan,
} from './strategy';
export { alongSpeed, isObstacle, paceOf } from './traffic';
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
  const driverPace = fin(sk.pace, 0.88);
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
    trail: trailBraking(difficulty, driverPace, consistency),
    kerbSkill: kerbSkill(difficulty, driverPace, consistency),
    rng,
    offset: 0,
    lineNoise: 0,
    lineNoiseTarget: 0,
    noiseTimer: 0,
    brakeNoise: 1,
    noiseCorner: -1,
    mistakeTimer: 0,
    mistakeKind: 'none',
    mistakeCorner: -1,
    mistakeActive: 0,
    mistakeCount: 0,
    integral: 0,
    mode: 'race',
    attackSide: 0,
    attackTarget: -1,
    attackTimer: 0,
    attackPhase: 'none',
    phaseTimer: 0,
    attackCooldown: 0,
    trickCooldown: 0,
    feintSide: 0,
    feintRef: 0,
    switchCorner: -1,
    trickTarget: -1,
    trickKind: 'feint',
    trickTimer: 0,
    inTrain: false,
    closing: 0,
    gapTime: 0,
    gapAt: 0,
    gapCar: -1,
    followTimer: 0,
    paceTime: 0,
    paceMode: 'standard',
    defendOffset: 0,
    defendTimer: 0,
    defendCooldown: 0,
    defendCorner: -1,
    defendSide: 0,
    feints: 0,
    feintPasses: 0,
    switchbacks: 0,
    switchbackPasses: 0,
    defendViolations: 0,
    stuckTimer: 0,
    recoverTimer: 0,
    recoverDist: 0,
    launchTimer: 0,
    strategyLap: -1,
    stintWear: 0,
    stintStartProgress: 0,
    plannedCompound: 'medium',
    weatherTimer: 0,
    pitCall: 'none',
    planStops: -1,
    planStay: -1,
    overcutLaps: 0,
    overcuts: 0,
    aheadId: -1,
    aheadStops: 0,
    aheadGap: 0,
    behindId: -1,
    behindStops: 0,
    behindGap: 0,
    fuelMark: 0,
    fuelMarkLap: -1,
    fuelPerLap: 0,
    teamFaster: 0,
    yieldFor: -1,
    yieldTimer: 0,
    holdFor: -1,
    noRaceFor: -1,
    noRaceLaps: 0,
    cleanLap: 0,
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
  // ≈ 0.37 % lap time per 1 % of both factors (point-mass model, 0.26 % Monza … 0.46 % Monaco)
  if (ai.paceTime > 0) ai.paceTime *= 1 - 0.37 * (form - 1);
}

/** Compute this step's controls for an AI car (racing line following, overtaking, defending, avoidance, DRS/ERS use). */
export function computeAIInput(world: WorldState, car: CarEntry, track: BuiltTrack, dt: number): ControlInput {
  return driveAI(world, car, track, dt);
}
