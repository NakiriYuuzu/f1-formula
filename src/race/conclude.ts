/**
 * Fast-forward fallback for a race that cannot be simulated to the flag in time (e.g. the player retired early in
 * a long race): every car still racing is classified where its average pace so far takes it — the projected
 * leader completes the distance, the others finish on their next line crossing after that, and a car that still
 * owes the mandatory stop loses a typical stop. Cars without racing pace stay unclassified. Ends the session.
 */
import type { BuiltTrack, WorldState } from '../core/types';
import { updateClassification } from './classification';
import { isRacing } from './events';
import { chequer, finishCar, mandatoryStopOpen, requestEnd } from './session';

/** Time (s) a projected car that still owes the mandatory stop loses to it. */
const PROJECTED_STOP_LOSS = 24;
/** Slowest average speed (m/s) that still counts as racing pace. */
const MIN_PACE = 5;

export function concludeRace(world: WorldState, track: BuiltTrack): void {
  const s = world.session;
  const start = s.startTime;
  const L = track.length;
  const now = world.time;
  const elapsed = start === null ? 0 : now - start;
  if (s.kind !== 'race' || s.phase === 'finished' || !(elapsed > 0) || !(L > 0)) {
    requestEnd(world);
    return;
  }
  const runs = world.cars
    .filter(isRacing)
    .map((car) => ({ car, pace: car.timing.progress / elapsed, loss: mandatoryStopOpen(world, car) ? PROJECTED_STOP_LOSS : 0 }))
    .filter((r) => Number.isFinite(r.pace) && r.pace >= MIN_PACE);
  type Run = (typeof runs)[number];
  const reachAt = (r: Run, distance: number): number => now + r.loss + Math.max(0, distance - r.car.timing.progress) / r.pace;

  let flag = s.chequeredAt ?? Infinity;
  if (s.chequeredAt === null) for (const r of runs) flag = Math.min(flag, reachAt(r, s.totalLaps * L));
  const finishes = runs
    .map((r) => {
      const atFlag = r.car.timing.progress + r.pace * Math.max(0, flag - now - r.loss);
      const laps = Math.min(s.totalLaps, Math.max(r.car.timing.lapsCompleted + 1, Math.floor(atFlag / L) + 1));
      return { r, laps, time: reachAt(r, laps * L) };
    })
    .sort((a, b) => a.time - b.time || a.r.car.id - b.r.car.id);

  if (finishes.length > 0) {
    chequer(world);
    if (Number.isFinite(flag)) s.chequeredAt = Math.min(s.chequeredAt ?? flag, flag);
    for (const f of finishes) {
      const car = f.r.car;
      // the projected stop is already part of its time
      if (f.r.loss > 0) car.race.mandatoryPenaltyApplied = true;
      car.timing.lapsCompleted = f.laps;
      car.timing.lap = f.laps;
      car.timing.progress = Math.max(car.timing.progress, f.laps * L);
      finishCar(world, car, f.time);
    }
    updateClassification(world, track);
  }
  requestEnd(world);
}
