/**
 * Damage rules.
 *
 * Terminal damage: a car whose suspension broke (DamageState.suspension 1; physics gives it no drive) is withdrawn
 * once it has stopped, or BROKEN_RETIRE_SEC after the break. A car abandoned on the circuit because of damage is
 * withdrawn, also when the race is then suspended (FIA B1.8.9): the red flag never repairs it. In a race with
 * incidents (race control) its incident retires it and decides the response (control.ts); otherwise it retires here.
 * An AI driver pulls over to the edge (the failure behaviour of the AI controller).
 *
 * Black-and-orange flag (races, FIA B1.8.7): a front / rear wing hanging off is a danger to the others. The car is
 * called in (pit request) and is shown the black flag — disqualified — at the BLACK_ORANGE_CROSSINGS-th crossing of
 * the control line without a pit visit (every pit stop repairs the wings). Not shown on the final lap.
 */
import type { BuiltTrack, CarEntry, TireCompound, WorldState } from '../core/types';
import { isBroken } from '../physics/index';
import { chooseDryCompound, weatherCompound } from '../ai/index';
import { emit, fin, isHuman, isRacing } from './events';
import { radioBlackOrange, radioBroken } from './radio';
import { disqualify, mandatoryStopOpen, retire } from './session';

/** Retirement reason of a car whose suspension broke. */
export const BROKEN_REASON = '懸吊損毀退賽';
/** Speed (m/s) below which a broken car counts as stopped, and the time (s) it must stand before it is withdrawn. */
const BROKEN_STOP_SPEED = 2;
const BROKEN_STOP_SEC = 1;
/** A broken car still rolling is withdrawn where it is after this long (s). */
const BROKEN_RETIRE_SEC = 8;
/** Wing damage that gets the black-and-orange flag. */
const BLACK_ORANGE_FRONT_WING = 0.6;
const BLACK_ORANGE_REAR_WING = 0.5;
/** Control-line crossings without a pit visit after the flag before the black flag (as for a drive-through, B1.9.6 c). */
export const BLACK_ORANGE_CROSSINGS = 2;

/** The broken car has come to rest (or rolled on for too long): time to withdraw it. */
export function brokenSettled(world: WorldState, car: CarEntry): boolean {
  const r = car.race;
  return r.brokenAt !== null && (r.brokenStill >= BROKEN_STOP_SEC || world.time - r.brokenAt >= BROKEN_RETIRE_SEC);
}

/** Race control is judging an incident of the car (its outcome withdraws a broken car: control.ts progressIncident). */
const judgedByRaceControl = (world: WorldState, car: CarEntry): boolean =>
  world.config.kind === 'race' && world.race.incidents.some((i) => !i.resolved && i.carId === car.id && i.response === null);

function stepBroken(world: WorldState, car: CarEntry, dt: number): void {
  const r = car.race;
  if (r.brokenAt === null) {
    r.brokenAt = world.time;
    r.brokenStill = 0;
    car.pit.requested = false;
    emit(world, { type: 'terminalDamage', carId: car.id });
    radioBroken(world, car);
    if (!isHuman(car)) {
      // coast off the road on the nearer side and stop there
      car.ai.failing = true;
      car.ai.failSide = car.phys.lateral >= 0 ? 1 : -1;
    }
  }
  r.brokenStill = car.phys.speed < BROKEN_STOP_SPEED ? r.brokenStill + dt : 0;
  // race control withdraws a car with an incident (and decides the response); otherwise it is withdrawn here
  if (!judgedByRaceControl(world, car) && brokenSettled(world, car)) retire(world, car, BROKEN_REASON);
}

/** A compound for a repair stop now: the driver's choice for a human, the strategy's pick for an AI car. */
function repairCompound(world: WorldState, track: BuiltTrack, car: CarEntry): TireCompound {
  if (isHuman(car)) return car.pit.nextCompound;
  const wet = weatherCompound(car.phys.tire.compound, world.weather.wetness);
  if (wet === 'inter' || wet === 'wet') return wet;
  const lapsLeft = Math.max(1, world.session.totalLaps - car.timing.lapsCompleted);
  return chooseDryCompound(car, track, lapsLeft, mandatoryStopOpen(world, car) ? car.race.usedCompounds : []);
}

const dangerous = (car: CarEntry): boolean =>
  fin(car.phys.damage.frontWing) >= BLACK_ORANGE_FRONT_WING || fin(car.phys.damage.rearWing) >= BLACK_ORANGE_REAR_WING;

function stepBlackOrange(world: WorldState, track: BuiltTrack, car: CarEntry): void {
  const r = car.race;
  const s = world.session;
  if (r.blackOrangeLaps >= 0) {
    // repaired (pit stop / red-flag regroup), or the car is out of the race
    if (!dangerous(car) || car.status === 'retired' || car.status === 'finished') {
      r.blackOrangeLaps = -1;
      car.flags.blackOrange = null;
      return;
    }
    // in the pit lane: the repair is coming (or it drives through and is still flagged at the exit)
    if (car.pit.phase !== 'none') return;
    const left = BLACK_ORANGE_CROSSINGS - (car.timing.lapsCompleted - r.blackOrangeLaps);
    if (left <= 0 && s.phase === 'running' && s.control.mode !== 'red') {
      r.blackOrangeLaps = -1;
      car.flags.blackOrange = null;
      disqualify(world, car, '黑旗：未依黑橘旗進站維修');
      return;
    }
    car.flags.blackOrange = { crossingsLeft: Math.max(1, left) };
    if (!car.pit.requested) car.pit.requested = true;
    return;
  }
  if (!dangerous(car) || car.status !== 'running' || car.pit.phase !== 'none' || isBroken(car.phys) || car.ai.failing) return;
  if (s.phase !== 'running' || s.control.mode === 'red' || s.leaderLap >= s.totalLaps) return;
  r.blackOrangeLaps = car.timing.lapsCompleted;
  car.flags.blackOrange = { crossingsLeft: BLACK_ORANGE_CROSSINGS };
  emit(world, { type: 'blackOrangeFlag', carId: car.id });
  radioBlackOrange(world, car);
  // box this lap for repairs
  const compound = repairCompound(world, track, car);
  car.pit.nextCompound = compound;
  if (!car.pit.requested) {
    car.pit.requested = true;
    emit(world, { type: 'pitRequested', carId: car.id, compound });
  }
}

/** Terminal damage (every session kind) and the black-and-orange flag (races). Call once per step after the contacts. */
export function stepDamageRules(world: WorldState, track: BuiltTrack, dt: number): void {
  if (world.config.kind === 'timeTrial') return;
  const race = world.config.kind === 'race';
  for (const car of world.cars) {
    if (car.status === 'retired' || car.status === 'finished') {
      car.race.blackOrangeLaps = -1;
      if (car.flags.blackOrange) car.flags.blackOrange = null;
      continue;
    }
    // online host: not on a guessed step (a replay may undo its damage), nor while the car is held
    if (car.race.netGuess || car.race.netHold) continue;
    if (isBroken(car.phys)) {
      // withdrawn for the damage, no longer called in for the wings
      car.race.blackOrangeLaps = -1;
      if (car.flags.blackOrange) car.flags.blackOrange = null;
      stepBroken(world, car, dt);
    } else if (race && isRacing(car)) stepBlackOrange(world, track, car);
  }
}
