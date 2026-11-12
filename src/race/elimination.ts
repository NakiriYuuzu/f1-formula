/**
 * Elimination race (SessionConfig.raceFormat 'elimination'). A countdown runs on green-flag racing only: it is frozen
 * before lights out and while the race is neutralised (SC, VSC, red flag). Each time it runs out the car last in the
 * running order is out, wherever it is (the pit lane included), and the countdown starts again. The last car left
 * wins. A car out for another reason leaves the order as in any race and the countdown carries on. The cars out by
 * the countdown are classified last out first, ahead of any retirement (classification.ts, results.ts). There is no
 * lap target: the session's laps are the race's horizon (fuel, the AI's strategy, race control), kept ahead of the
 * leader by the green-flag racing still to come, so a neutralised race running long never reads as at its end.
 */
import type { BuiltTrack, CarEntry, EliminationFormat, EliminationState, SessionConfig, WorldState } from '../core/types';
import { emit, isRacing } from './events';
import { chequer, finishCar, retire } from './session';

/**
 * Seconds after lights out the field takes to sort out the start: in 20-car races at Monza, Silverstone, Monaco,
 * Suzuka and Spa (3 seeds each) the overtakes come 5–20 s after lights out and almost none after that.
 */
export const START_SETTLE = 20;
/** Retirement reason of an eliminated car (the 'retired' event that follows 'eliminated'). */
export const ELIMINATED_REASON = '淘汰';
/** Laps beyond the green-flag racing still to come at reference pace (the horizon never closer than this). */
const SPARE_LAPS = 2;

/** Laps for `seconds` more of green-flag racing at reference pace, plus the spare. */
const lapsFor = (seconds: number, referenceLapTime: number): number => Math.ceil(seconds / Math.max(30, referenceLapTime)) + SPARE_LAPS;

/** The format for a countdown of `interval` seconds; the first one also covers the start. */
export function eliminationFormat(interval: number): EliminationFormat {
  return { kind: 'elimination', interval, grace: interval + START_SETTLE };
}

export const eliminationOf = (config: SessionConfig): EliminationFormat | null =>
  config.kind === 'race' && config.raceFormat?.kind === 'elimination' ? config.raceFormat : null;

/** Laps at the start (the fuel load): the longest race the countdown allows (`cars` − 1 eliminations). */
export function plannedLaps(format: EliminationFormat, cars: number, referenceLapTime: number): number {
  return lapsFor(format.grace + Math.max(0, cars - 2) * format.interval, referenceLapTime);
}

export function newElimination(format: EliminationFormat): EliminationState {
  return { dueAt: 0, held: format.grace, out: [] };
}

/**
 * Seconds left at world time `time`. A mirrored state the host has already moved past (its next due time not in yet)
 * reads as the next countdown, an interval later.
 */
export function eliminationLeft(e: EliminationState, interval: number, time: number): number {
  if (e.held !== null) return Math.max(0, e.held);
  let left = e.dueAt - time;
  if (left < 0 && interval > 0) left += Math.ceil(-left / interval) * interval;
  return Math.max(0, left);
}

/** The car last in the running order: the next one out (null when none is racing). */
export function lastRunning(world: WorldState): CarEntry | null {
  const order = world.race.order;
  for (let i = order.length - 1; i >= 0; i--) {
    const car = world.cars[order[i]];
    if (car && isRacing(car)) return car;
  }
  return null;
}

/** The car at risk and the seconds left, while an elimination race is running (null otherwise). */
export function eliminationRisk(world: WorldState): { car: CarEntry; left: number } | null {
  const e = world.session.elimination;
  const format = world.config.raceFormat;
  if (!e || format?.kind !== 'elimination' || world.session.phase !== 'running') return null;
  const car = lastRunning(world);
  return car ? { car, left: eliminationLeft(e, format.interval, world.time) } : null;
}

/** Countdown, eliminations, the win and the race's horizon (step.ts, after race control has set this step's mode). */
export function stepElimination(world: WorldState, track: BuiltTrack): void {
  const e = world.session.elimination;
  const format = world.config.raceFormat;
  const s = world.session;
  if (!e || format?.kind !== 'elimination' || s.phase === 'chequered' || s.phase === 'finished') return;
  // the leader's laps plus the green-flag racing still to come: on under a neutralisation (the countdown waits, the
  // laps go on), back by an interval when a retirement saves an elimination
  const ahead = (e.held ?? Math.max(0, e.dueAt - world.time)) + Math.max(0, world.cars.filter(isRacing).length - 2) * format.interval;
  s.totalLaps = Math.max(0, s.leaderLap - 1) + lapsFor(ahead, track.referenceLapTime);
  if (s.phase !== 'running' || s.control.mode !== 'green') {
    if (e.held === null) e.held = Math.max(0, e.dueAt - world.time);
    return;
  }
  if (e.held !== null) {
    e.dueAt = world.time + e.held;
    e.held = null;
  }
  if (world.time >= e.dueAt) {
    const car = lastRunning(world);
    if (car && world.cars.filter(isRacing).length > 1) eliminate(world, e, car);
    e.dueAt += format.interval;
  }
  const racing = world.cars.filter(isRacing);
  if (racing.length === 1) {
    chequer(world);
    finishCar(world, racing[0], world.time);
  }
}

function eliminate(world: WorldState, e: EliminationState, car: CarEntry): void {
  e.out.push(car.id);
  emit(world, { type: 'eliminated', carId: car.id, position: world.cars.filter(isRacing).length });
  retire(world, car, ELIMINATED_REASON);
}

/**
 * Fast-forward fallback (concludeRace): the cars still racing go out from the back of the running order, as the
 * countdown would take them if the order held, until one is left; it wins.
 */
export function concludeElimination(world: WorldState): void {
  const e = world.session.elimination;
  if (!e) return;
  for (let car = lastRunning(world); car && world.cars.filter(isRacing).length > 1; car = lastRunning(world)) eliminate(world, e, car);
  const winner = world.cars.find(isRacing);
  if (winner) {
    chequer(world);
    finishCar(world, winner, world.time);
  }
}
