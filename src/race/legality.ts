/**
 * Overtaking legality under race control: a pass during the formation lap, under the (virtual) safety car or inside
 * a yellow-flag sector must be undone within GIVE_BACK_SEC (car.flags.giveBack + 'controlWarning'), otherwise the
 * passer gets a time penalty. Passes of cars in the pit lane, retired / stopped cars or much slower cars are legal, and
 * so is taking back a place from a car that still owes it.
 */
import type { BuiltTrack, CarEntry, RaceControlMode, WorldState } from '../core/types';
import { fin, emit } from './events';
import { radioPenalty } from './radio';

/** Seconds to give an illegally gained position back. */
export const GIVE_BACK_SEC = 10;
/** Time penalty (s) for not giving it back. */
export const ILLEGAL_PASS_PENALTY = 5;

const NO_PASS_MODES: readonly RaceControlMode[] = ['formation', 'sc', 'scEnding', 'vsc', 'vscEnding', 'red'];

export function sectorOf(track: BuiltTrack, s: number): number {
  const st = track.sectorStarts;
  return s >= st[2] ? 2 : s >= st[1] ? 1 : 0;
}

/** Overtaking is not allowed for this car right now (neutralisation or yellow flag in its sector). */
export function overtakingBanned(world: WorldState, track: BuiltTrack, car: CarEntry): boolean {
  const c = world.session.control;
  if (NO_PASS_MODES.includes(c.mode)) return true;
  return (c.sectorFlags[sectorOf(track, car.phys.s)] ?? 0) > 0;
}

export function applyTimePenalty(world: WorldState, car: CarEntry, seconds: number, reason: string): void {
  car.penalties.timeSec += seconds;
  car.penalties.log.push(`+${seconds} 秒：${reason}`);
  emit(world, { type: 'penalty', carId: car.id, seconds, reason });
  radioPenalty(world, car, seconds, reason);
}

/** Called for every classification swap (passer moved ahead of passed). */
export function notePass(world: WorldState, track: BuiltTrack, passer: CarEntry, passed: CarEntry): void {
  if (world.config.kind !== 'race' || passer.flags.giveBack) return;
  // taking back a place the other car owes us (it passed illegally) restores the order
  if (passed.flags.giveBack?.carId === passer.id) return;
  if (!overtakingBanned(world, track, passer)) return;
  if (passed.pit.phase !== 'none' || passed.status === 'retired' || passed.status === 'finished') return;
  const vA = Math.max(0, fin(passer.phys.speed));
  if (fin(passed.phys.speed) < vA * 0.5) return;
  // a car pulling over with a failure or spinning may be passed
  if (passed.ai.failing || passed.ai.crashTimer > 0) return;
  passer.flags.giveBack = { carId: passed.id, timeLeft: GIVE_BACK_SEC };
  emit(world, { type: 'controlWarning', carId: passer.id, reason: `請讓回位置給 ${passed.abbr}` });
}

/** Count down / resolve pending give-backs (race running). */
export function stepGiveBack(world: WorldState, dt: number): void {
  for (const car of world.cars) {
    const gb = car.flags.giveBack;
    if (!gb) continue;
    const other = world.cars[gb.carId];
    const done =
      !other ||
      other.status === 'retired' ||
      other.status === 'finished' ||
      other.pit.phase !== 'none' ||
      car.status === 'retired' ||
      car.status === 'finished' ||
      // behind again in the classification (its hysteresis), so the pass back is still seen as owed by notePass
      car.timing.position > other.timing.position;
    if (done) {
      car.flags.giveBack = null;
      continue;
    }
    gb.timeLeft -= dt;
    if (gb.timeLeft <= 0) {
      car.flags.giveBack = null;
      applyTimePenalty(world, car, ILLEGAL_PASS_PENALTY, '安全車／黃旗期間超車');
    }
  }
}

/**
 * Formation lap: progress is frozen, so compare the distance driven with the car ahead on the grid. A car that got
 * ahead must drop back before the give-back time runs out (parking into the grid slot also resolves it).
 */
export function checkFormationOrder(world: WorldState, dt: number): void {
  const byGrid = world.cars
    .filter((c) => c.status !== 'retired')
    .sort((a, b) => a.timing.gridPosition - b.timing.gridPosition);
  for (let i = 1; i < byGrid.length; i++) {
    const car = byGrid[i];
    const ahead = byGrid[i - 1];
    const gb = car.flags.giveBack;
    if (car.race.parking || car.race.parked) {
      car.flags.giveBack = null;
      continue;
    }
    if (gb) {
      if (car.race.formationDist < ahead.race.formationDist - 2) {
        car.flags.giveBack = null;
        continue;
      }
      gb.timeLeft -= dt;
      if (gb.timeLeft <= 0) {
        car.flags.giveBack = null;
        applyTimePenalty(world, car, ILLEGAL_PASS_PENALTY, '暖胎圈超車');
      }
    } else if (car.race.formationDist > ahead.race.formationDist + 6 && !ahead.race.parked && !ahead.race.parking) {
      car.flags.giveBack = { carId: ahead.id, timeLeft: GIVE_BACK_SEC };
      emit(world, { type: 'controlWarning', carId: car.id, reason: `暖胎圈不得超車：請讓回位置給 ${ahead.abbr}` });
    }
  }
}
