/**
 * AI-owned types (owner: race/AI agent). Plain data only (lives inside WorldState).
 * Other modules must treat AIState as opaque; only `skill` and `targetLateral` are meant for display/debug.
 */
import type { RngState } from '../core/math';
import type { TireCompound } from '../core/types';

/** Tactical mode of the AI driver. */
export type AIMode = 'race' | 'attack' | 'defend' | 'recover';

export interface AIState {
  /** 0..1 driver skill blend used by the controller */
  skill: number;
  /** current target lateral offset (m, + right) relative to the centre line */
  targetLateral: number;

  // ── static personality (derived from driver skills + difficulty at creation) ──
  /** difficulty 0..110 the brain was created with */
  difficulty: number;
  /** fraction (≈ 0.7..1) of the car's steady-state lateral grip used for corner speeds */
  latFactor: number;
  /** fraction (≈ 0.7..0.95) of the car's straight-line braking capability used for braking points */
  brakeFactor: number;
  /** physics performanceScale for this AI (power fully, grip 60 %) */
  performance: number;
  /** 0..1 skills (copied from the driver) */
  racecraft: number;
  awareness: number;
  wetSkill: number;
  consistency: number;
  /** 0..1 willingness to attack / defend */
  aggression: number;
  /** launch reaction time (s) after lights out */
  reaction: number;
  /** per-car deterministic RNG */
  rng: RngState;

  // ── dynamic controller state ──
  /** smoothed tactical offset (m) from the racing line */
  offset: number;
  /** slowly varying line noise (m) and its current target */
  lineNoise: number;
  lineNoiseTarget: number;
  noiseTimer: number;
  /** per-corner braking multiplier (consistency noise / mistakes), 1 = nominal */
  brakeNoise: number;
  /** index of the corner the current brake noise was rolled for (-1 none) */
  noiseCorner: number;
  /** > 0 while a driving mistake is in progress (s) */
  mistakeTimer: number;
  /** speed PI integral term */
  integral: number;
  mode: AIMode;
  /** attack: side (-1 left, +1 right), target car id, remaining commitment (s) */
  attackSide: number;
  attackTarget: number;
  attackTimer: number;
  /** smoothed closing rate (m/s) on the car ahead in the driving path, from the time gap at the 50 m checkpoints */
  closing: number;
  /** time gap (s) to that car at our last checkpoint, when we crossed it (s) and its id (-1 none) */
  gapTime: number;
  gapAt: number;
  gapCar: number;
  /** seconds spent following closely (held up) */
  followTimer: number;
  /** expected flying-lap time (s) of this car + driver, for judging pace advantage (0 = unknown) */
  paceTime: number;
  /** defend: offset (m) held for defendTimer seconds; cooldown before the next move */
  defendOffset: number;
  defendTimer: number;
  defendCooldown: number;
  /** stuck detection / recovery */
  stuckTimer: number;
  recoverTimer: number;
  /** distance reversed during the current recovery (m) */
  recoverDist: number;
  /** time since lights out (s), for the launch reaction */
  launchTimer: number;

  // ── strategy ──
  /** lap number the strategy was last evaluated on (-1 = never) */
  strategyLap: number;
  /** tyre wear at the start of the current stint and laps driven on it */
  stintWear: number;
  stintStartLap: number;
  /** compound planned for the next stop */
  plannedCompound: TireCompound;
  /** seconds the weather has suggested a tyre change (debounce) */
  weatherTimer: number;

  // ── race-control incidents (set by the race runtime) ──
  /** mechanical failure: pull over toward failSide (-1 left, +1 right) and stop */
  failing: boolean;
  failSide: number;
  /** > 0 while a forced spin plays out (s): no throttle, no counter-steer */
  crashTimer: number;
}
