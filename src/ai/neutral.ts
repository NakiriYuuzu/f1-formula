/**
 * AI behaviour under race control (reads world.session.control and car.flags): speed caps for the formation lap
 * and the safety-car queue (follow the car / safety car ahead at a fixed gap, catch up when far back), the VSC delta
 * and the red flag, caution in yellow sectors, yielding to blue flags and easing off to give a place back.
 */
import type { BuiltTrack, CarEntry, WorldState } from '../core/types';
import { clamp } from '../core/math';
import { forwardDistance, sampleAt } from '../track/track';
import { sectorOf } from '../race/legality';
import {
  FORMATION_MAX_SPEED,
  FORMATION_SPEED_FACTOR,
  SC_MAX_SPEED,
  SC_SPEED_FACTOR,
  VSC_MAX_SPEED,
  VSC_SPEED_FACTOR,
  pacedSpeedAhead,
} from '../race/neutralPace';

export interface NeutralPlan {
  /** speed cap (m/s); Infinity = none */
  cap: number;
  /** multiplier on the racing target speed */
  scale: number;
  /** no attacking / defending moves */
  noOvertake: boolean;
  /** move toward this side (-1 left, +1 right) to let a faster car through; 0 = no */
  yieldSide: number;
}

/** Queue gap (m) behind the car / safety car ahead: safety car, formation lap. */
const SC_QUEUE_GAP = 15;
const FORMATION_GAP = 20;
/** Beyond this gap (m) the car catches up at near racing pace. */
const CATCH_UP_GAP = 150;
/** Speed (m/s) gained per metre of excess gap while queuing. */
const FOLLOW_GAIN = 0.5;
/** Only cars / the safety car within this distance (m) ahead form the queue target. */
const QUEUE_RANGE = 400;
/** Restart: the leader may accelerate within this distance (m) of the line once the safety car has gone in. */
const RESTART_RUN = 600;
/** Catch-up pace: fraction of the reference profile. */
const CATCH_UP_FACTOR = 0.85;
/** VSC: delta the AI aims for and the speed gain per second of delta. */
const VSC_DELTA_TARGET = 0.4;
const VSC_DELTA_GAIN = 0.3;
const YELLOW_SCALE = 0.9;
const BLUE_SCALE = 0.95;
const GIVE_BACK_SCALE = 0.85;

/** A car in trouble (pulling over, spinning, stopped off the road) is passed, not queued behind. */
function inTrouble(track: BuiltTrack, o: CarEntry): boolean {
  if (o.ai.failing || o.ai.crashTimer > 0) return true;
  return o.phys.speed < 5 && Math.abs(o.phys.lateral) > sampleAt(track, track.halfWidth, o.phys.s) + 0.5;
}

/**
 * Nearest car physically ahead within `range` (grid / formation cars included, pit-lane cars excluded). A car that
 * owes this car a place is not a queue target: it is letting us by.
 */
function carAhead(world: WorldState, track: BuiltTrack, car: CarEntry, range: number, formation: boolean): { gap: number; speed: number } | null {
  let best: { gap: number; speed: number } | null = null;
  for (const o of world.cars) {
    if (o === car || o.status === 'retired' || o.status === 'finished' || o.pit.phase !== 'none') continue;
    if (!formation && inTrouble(track, o)) continue;
    if (o.flags.giveBack?.carId === car.id) continue;
    const gap = forwardDistance(track, car.phys.s, o.phys.s);
    if (gap > 0.5 && gap < range && (!best || gap < best.gap)) best = { gap, speed: Math.max(0, o.phys.speed) };
  }
  return best;
}

/** First car still racing in classification order (the one the safety car picks up). */
function isRaceLeader(world: WorldState, car: CarEntry): boolean {
  for (const id of world.race.order) {
    const o = world.cars[id];
    if (o && (o.status === 'running' || o.status === 'pitting')) return o === car;
  }
  return false;
}

function queuePlan(world: WorldState, track: BuiltTrack, car: CarEntry, formation: boolean): NeutralPlan {
  const c = world.session.control;
  const s = car.phys.s;
  const pace = formation
    ? pacedSpeedAhead(track, s, FORMATION_SPEED_FACTOR, FORMATION_MAX_SPEED)
    : pacedSpeedAhead(track, s, SC_SPEED_FACTOR, SC_MAX_SPEED);
  const catchUp = pacedSpeedAhead(track, s, CATCH_UP_FACTOR, 90);
  const gapWanted = formation ? FORMATION_GAP : SC_QUEUE_GAP;
  const sc = c.safetyCar;
  let target = carAhead(world, track, car, QUEUE_RANGE, formation);
  const scInPits = world.race.scPitDist >= 0;
  // on the road the safety car heads the queue once it has the race leader; until then only the leader follows it and the
  // cars before it are waved past
  const scLeads = world.race.scExitDist < 0 && (world.race.scPickedUp || isRaceLeader(world, car));
  if (!formation && sc.onTrack && !scInPits && scLeads) {
    const scGap = forwardDistance(track, s, sc.s);
    if (scGap < QUEUE_RANGE && (!target || scGap < target.gap)) target = { gap: scGap, speed: sc.speed };
  }
  let cap: number;
  if (target) {
    const desired = target.speed + FOLLOW_GAIN * (target.gap - gapWanted);
    const ceiling = target.gap > CATCH_UP_GAP ? catchUp : Math.max(pace * 1.3, target.speed + 8);
    cap = clamp(desired, 0, ceiling);
  } else if (formation) cap = pace;
  else if ((sc.onTrack && !scInPits) || world.race.scHeld) cap = catchUp;
  else cap = forwardDistance(track, s, 0) < RESTART_RUN ? Infinity : pace;
  return giveBackPlan(car, { cap, scale: 1, noOvertake: true, yieldSide: 0 });
}

/**
 * Giving a place back while neutralised: the cap (not the racing target, which is far above it) is lowered, so the car
 * it passed (which no longer queues behind it and may attack it, see traffic.ts) can go by.
 */
function giveBackPlan(car: CarEntry, plan: NeutralPlan): NeutralPlan {
  if (!car.flags.giveBack) return plan;
  return { ...plan, cap: plan.cap * GIVE_BACK_SCALE, scale: GIVE_BACK_SCALE };
}

/** Safety-car limiter assist for a human car: the queue speed cap while the safety car is out, else Infinity. */
export function safetyCarCap(world: WorldState, track: BuiltTrack, car: CarEntry): number {
  const mode = world.session.control.mode;
  if (world.config.kind !== 'race' || world.session.phase === 'formation' || (mode !== 'sc' && mode !== 'scEnding')) return Infinity;
  return queuePlan(world, track, car, false).cap;
}

/** Side away from the racing line (the lapping car takes the line). */
function yieldSide(track: BuiltTrack, car: CarEntry): number {
  return sampleAt(track, track.racingLine, car.phys.s) >= 0 ? -1 : 1;
}

export function neutralPlan(world: WorldState, track: BuiltTrack, car: CarEntry): NeutralPlan {
  const plan: NeutralPlan = { cap: Infinity, scale: 1, noOvertake: false, yieldSide: 0 };
  if (world.config.kind !== 'race') return plan;
  const s = world.session;
  const mode = s.control.mode;
  if (s.phase === 'formation') return queuePlan(world, track, car, true);
  if (mode === 'sc' || mode === 'scEnding') return queuePlan(world, track, car, false);
  if (mode === 'vsc' || mode === 'vscEnding' || mode === 'red') {
    const ref = pacedSpeedAhead(track, car.phys.s, VSC_SPEED_FACTOR, VSC_MAX_SPEED);
    const delta = car.flags.delta;
    // no delta catch-up while giving a place back (it would undo the lift)
    const f = delta === null || car.flags.giveBack ? 1 : clamp(1 + VSC_DELTA_GAIN * (delta - VSC_DELTA_TARGET), 0.8, 1.15);
    return giveBackPlan(car, { cap: ref * f, scale: 1, noOvertake: true, yieldSide: 0 });
  }
  if ((s.control.sectorFlags[sectorOf(track, car.phys.s)] ?? 0) > 0) {
    plan.scale = YELLOW_SCALE;
    plan.noOvertake = true;
  }
  if (car.flags.shown === 'blue') {
    plan.scale = Math.min(plan.scale, BLUE_SCALE);
    plan.noOvertake = true;
    plan.yieldSide = yieldSide(track, car);
  }
  if (car.flags.giveBack) {
    plan.scale = Math.min(plan.scale, GIVE_BACK_SCALE);
    plan.noOvertake = true;
  }
  return plan;
}
