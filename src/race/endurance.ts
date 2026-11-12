/**
 * Endurance race (SessionConfig.raceFormat 'endurance'). A clock runs from lights out for the format's duration: on
 * under the safety car and the VSC, stopped under a red flag. Once it has run out the leader's lap is the last: the
 * leader takes the flag at its next crossing of the line and every other car at its own next one (session.ts,
 * timing.ts), so the race is classified by laps, then time, as any race. The session's laps are the race's horizon
 * (raceClock.ts): the leader's laps plus the laps the time left takes at the leader's latest clean lap, at least the
 * leader's lap, and the leader's lap once the time is up. While the clock runs no car takes the flag on that count, and
 * the final lap is called when the time is up, not from the count.
 *
 * Fuel: the tank holds TANK_SECONDS of racing at the car's nominal use, so cars refuel at their stops, a full tank in
 * FULL_FILL seconds; a stop lasts the longer of the tyre change and the fill (pitlane.ts). The fill takes the tank to
 * PitState.fuelTarget (the driver's choice, the AI strategy's plan) or else to fuelFor: the laps to go over the fewest
 * tanks, evenly. Fuel use is not saved toward the flag (env.ts): a car is refuelled instead.
 */
import type { BuiltTrack, CarEntry, CarSpec, EnduranceFormat, RaceClock, SessionConfig, WorldState } from '../core/types';
import { fuelPerKm } from '../physics/index';
import { emit } from './events';
import { radioFinalLap } from './radio';
import { clockLeft, lapsAhead, runClock } from './raceClock';

/**
 * Racing time (s) a full tank lasts at the car's nominal use (physics fuelPerKm) and the reference lap time. In 20-car
 * races a lap takes 1.08–1.14 × the reference lap and burns 0.95–1.17 × the nominal use (15 layouts), so a tank lasts
 * 13–16 min of racing: a 40-minute race needs three tanks — two stops, three for a car that stops once more.
 */
export const TANK_SECONDS = 960;
/** Seconds to fill an empty tank; an even share of a 40-minute race (0.8–0.9 of a tank) takes 7–8 s. */
export const FULL_FILL = 10;
/** Fuel use a lap against the nominal use when the car's own is not known: the highest measured (Monaco, 1.17). */
export const BURN_FACTOR = 1.17;
/** Fuel planned on top of the laps to go: this share of it, and this many laps for the line after the pit entry and the projection's error. */
export const FILL_MARGIN = 0.03;
export const FILL_RESERVE_LAPS = 0.5;
/** A lap of racing against the reference lap until the leader has a clean lap (measured 1.08–1.14 in 20-car races). */
const RACE_PACE = 1.1;

export function enduranceFormat(minutes: number): EnduranceFormat {
  return { kind: 'endurance', duration: minutes * 60 };
}

export const enduranceOf = (config: SessionConfig): EnduranceFormat | null =>
  config.kind === 'race' && config.raceFormat?.kind === 'endurance' ? config.raceFormat : null;

/** The race's laps before the start (the weather's span, the AI's first plans). */
export function plannedLaps(format: EnduranceFormat, track: BuiltTrack): number {
  return lapsAhead(0, format.duration, track.referenceLapTime * RACE_PACE);
}

export function newEndurance(format: EnduranceFormat): RaceClock {
  return { dueAt: 0, held: format.duration };
}

/** Seconds of racing left (null outside an endurance race). */
export function enduranceLeft(world: WorldState): number | null {
  const c = world.session.endurance;
  return c ? clockLeft(c, world.time) : null;
}

/** The clock, the race's horizon and the final-lap call (step.ts, after race control has set this step's mode). */
export function stepEndurance(world: WorldState, track: BuiltTrack): void {
  const c = world.session.endurance;
  const s = world.session;
  if (!c || s.phase === 'chequered' || s.phase === 'finished') return;
  runClock(c, world.time, s.phase === 'running' && s.control.mode !== 'red');
  const left = clockLeft(c, world.time);
  if (s.phase === 'running' && left <= 0) {
    s.totalLaps = s.leaderLap;
    if (!world.race.finalLapAnnounced) {
      world.race.finalLapAnnounced = true;
      emit(world, { type: 'finalLap' });
      radioFinalLap(world);
    }
    return;
  }
  const leader = world.cars[world.race.order[0] ?? -1];
  // the leader's latest clean lap (the better of its last two reads 3–4 % quick: a race a lap too long near the end)
  const clean = leader ? leader.race.lastCleanLap : 0;
  const lap = clean > 0 ? clean : track.referenceLapTime * RACE_PACE;
  const into = leader && s.leaderLap >= 1 ? Math.max(0, leader.timing.progress / track.length - (s.leaderLap - 1)) : 0;
  s.totalLaps = Math.max(s.leaderLap, lapsAhead(s.leaderLap, left + into * lap, lap));
}

/** Fuel (kg) a full tank holds. */
export function fuelTank(spec: CarSpec, track: BuiltTrack): number {
  return ((fuelPerKm(spec) * track.length) / 1000) * (TANK_SECONDS / Math.max(30, track.referenceLapTime));
}

/** Seconds a fill of `kg` takes. */
export const fillTime = (kg: number, tank: number): number => (Math.max(0, kg) / tank) * FULL_FILL;

/**
 * Fuel (kg) to carry for `laps` more laps at `perLap` a lap (with FILL_MARGIN and FILL_RESERVE_LAPS): all of it when one
 * tank holds it, else an even share over the fewest tanks that do.
 */
export function fuelFor(laps: number, perLap: number, tank: number): number {
  const reserve = FILL_RESERVE_LAPS * perLap;
  const need = Math.max(0, laps) * perLap * (1 + FILL_MARGIN);
  const tanks = Math.max(1, Math.ceil(need / Math.max(1e-6, tank - reserve)));
  return Math.min(tank, need / tanks + reserve);
}

/** Laps the car still drives from where it is to its flag (the race's horizon; a lapped car's comes a lap early). */
export function lapsToGo(world: WorldState, track: BuiltTrack, car: CarEntry): number {
  return Math.max(0, (world.session.totalLaps - car.timing.lapsDown) * track.length - car.timing.progress) / track.length;
}

/** The automatic fill's tank (kg) for a car stopping now: the laps to go at BURN_FACTOR × its nominal use. */
export function autoFuel(world: WorldState, track: BuiltTrack, car: CarEntry): number {
  const tank = fuelTank(car.spec, track);
  return fuelFor(lapsToGo(world, track, car), (fuelPerKm(car.spec) * track.length * BURN_FACTOR) / 1000, tank);
}

/** Seconds of refuelling in a stop starting now (0 outside an endurance race, or with the tank already at its target). */
export function stopFill(world: WorldState, track: BuiltTrack, car: CarEntry): number {
  if (!world.session.endurance) return 0;
  const tank = fuelTank(car.spec, track);
  const target = Math.min(tank, car.pit.fuelTarget ?? autoFuel(world, track, car));
  return fillTime(target - car.phys.fuelKg, tank);
}
