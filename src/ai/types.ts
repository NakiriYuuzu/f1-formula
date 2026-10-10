/**
 * AI-owned types (owner: race/AI agent). Plain data only (lives inside WorldState).
 * Other modules must treat AIState as opaque; only `skill` and `targetLateral` are meant for display/debug.
 */
import type { RngState } from '../core/math';
import type { TireCompound } from '../core/types';

/** Tactical mode of the AI driver. */
export type AIMode = 'race' | 'attack' | 'defend' | 'recover';

/** Pace mode (set by the strategy): push harder, standard, or conserve the tyres / fuel. */
export type AIPaceMode = 'push' | 'standard' | 'conserve';

/** Natural driving mistake planned / in progress: braking too late (runs wide), or on the throttle too early. */
export type AIMistake = 'none' | 'lateBrake' | 'earlyThrottle';

/**
 * Phase of an attack: closing in the tow (stalk) → a dummy to one side (feint) → pulled out alongside (commit) →
 * dropping back on a corner entry to cut back under the defender on the exit (switchback).
 */
export type AIAttackPhase = 'none' | 'stalk' | 'feint' | 'commit' | 'switchback';

/**
 * Why the strategy called the latest stop: the race-time model's plan, the wear backstop, the mandatory-stop backstop,
 * an undercut, covering a car behind that stopped, a cheaper stop under the (virtual) safety car, the weather
 * crossover, the forecast (a lap early), front-wing repair.
 */
export type AIPitCall = 'none' | 'plan' | 'wear' | 'mandatory' | 'undercut' | 'cover' | 'neutral' | 'weather' | 'forecast' | 'damage';

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
  /** trail-braking coefficient 0..TRAIL_MAX (braking under lateral load; pace.ts trailBraking) */
  trail: number;
  /** 0..1 share of KERB_REACH the driver's path may use over a kerb (pace.ts kerbSkill) */
  kerbSkill: number;
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
  /** natural mistake planned for corner `mistakeCorner` (index into track.corners, -1 none) */
  mistakeKind: AIMistake;
  mistakeCorner: number;
  /** > 0 while that natural mistake plays out (s) */
  mistakeActive: number;
  /** natural mistakes made so far (statistics / tests) */
  mistakeCount: number;
  /** speed PI integral term */
  integral: number;
  mode: AIMode;
  /** attack: side (-1 left, +1 right), target car id, remaining commitment (s) */
  attackSide: number;
  attackTarget: number;
  attackTimer: number;
  /** attack phase and seconds spent in it */
  attackPhase: AIAttackPhase;
  phaseTimer: number;
  /** seconds before a new attack (set when one is given up) / a new feint or switchback may start */
  attackCooldown: number;
  trickCooldown: number;
  /** feint: side shown (-1 left, +1 right) and the defender's offset (m) from the racing line when it was shown */
  feintSide: number;
  feintRef: number;
  /** switchback: corner (index into track.corners) it is made on, -1 none */
  switchCorner: number;
  /** last feint / switchback that worked: target car id (-1 none), kind and seconds left in which passing it counts */
  trickTarget: number;
  trickKind: 'feint' | 'switchback';
  trickTimer: number;
  /** following a DRS train without the pace to pass it: no forced attack, conserve within DRS range */
  inTrain: boolean;
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
  /** pace mode: push = +1.2 % corner / braking use and eager ERS, conserve = −1.5 % and gentler traction */
  paceMode: AIPaceMode;
  /** defend: offset (m) held for defendTimer seconds; cooldown before the next move */
  defendOffset: number;
  defendTimer: number;
  defendCooldown: number;
  /** corner (index into track.corners) the last defensive move was made for: one move per straight (-1 none) */
  defendCorner: number;
  /** side the cover is for (+1 right / -1 left: the inside of the corner ahead, or the side the attacker showed) */
  defendSide: number;
  /**
   * racecraft statistics: feints that drew the defender across / switchbacks made, passes of that car completed
   * after them, and defensive moves started while braking (a rule violation — must stay 0)
   */
  feints: number;
  feintPasses: number;
  switchbacks: number;
  switchbackPasses: number;
  defendViolations: number;
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
  /** tyre wear at the start of the current stint and the race distance (timing.progress, m) it started at */
  stintWear: number;
  stintStartProgress: number;
  /** compound planned for the next stop */
  plannedCompound: TireCompound;
  /** seconds the weather has suggested a tyre change (debounce) */
  weatherTimer: number;
  /** why the latest stop was called ('none' before the first) */
  pitCall: AIPitCall;
  /** race-time model at the last evaluation: stops still planned and laps on the current set before the next (-1 none) */
  planStops: number;
  planStay: number;
  /** overcut: further evaluations to stay out after the car ahead pitted; overcuts made (statistics) */
  overcutLaps: number;
  overcuts: number;
  /**
   * the cars ahead / behind in the classification at the last evaluation (-1 none / not on the same lap), their stops
   * then and the gap (s) — to notice that one has just pitted (overcut, cover)
   */
  aheadId: number;
  aheadStops: number;
  aheadGap: number;
  behindId: number;
  behindStops: number;
  behindGap: number;
  /** fuel (kg) at the last green-flag evaluation and its lap (-1 none); measured burn per lap (kg, 0 = not yet) */
  fuelMark: number;
  fuelMarkLap: number;
  fuelPerLap: number;
  /** team orders: evaluations in a row the team-mate right behind was clearly quicker */
  teamFaster: number;
  /** team orders: team-mate (car id) to let by on the next straight (-1 none) and seconds left to do so */
  yieldFor: number;
  yieldTimer: number;
  /** team orders: team-mate (car id) not to race — hold position (-1 none) */
  holdFor: number;
  /** team orders: the team-mate just let by (car id, -1 none) is not attacked for noRaceLaps more evaluations */
  noRaceFor: number;
  noRaceLaps: number;
  /**
   * measured race pace (s, 0 = none yet): the better of the last two clean green-flag laps — not lap 1, not an in / out
   * lap, no (virtual) safety car, valid. Kept for every car, human ones too.
   */
  cleanLap: number;

  // ── race-control incidents (set by the race runtime) ──
  /** mechanical failure: pull over toward failSide (-1 left, +1 right) and stop */
  failing: boolean;
  failSide: number;
  /** > 0 while a forced spin plays out (s): no throttle, no counter-steer */
  crashTimer: number;
}
