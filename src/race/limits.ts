/**
 * Track limits: a car with all four wheels beyond the white line (road edge; kerbs are outside it) — i.e. the
 * inner wheels' inner edges past it — in a corner (|curvature| > 1/400) for more than 0.25 s gets a warning and
 * the lap is invalidated. Warnings 1–3 are warnings (the third is the final warning); in races every further
 * offence adds a 5 s time penalty.
 */
import type { BuiltTrack, CarEntry, WorldState } from '../core/types';
import { isInPitZone, sampleAt } from '../track/track';
import { emit } from './events';
import { radioPenalty, radioTrackLimits } from './radio';

/** Half a tyre's width (m): wheel centre to its inner edge. */
const TYRE_HALF_WIDTH = 0.2;
/** Centre-line curvature (1/m) above which a section counts as a corner. */
const CORNER_CURVATURE = 1 / 400;
/** Time (s) beyond the limits before the offence counts. */
const LIMIT_TIME = 0.25;
/** Warnings before time penalties start (race). */
export const FREE_WARNINGS = 3;
export const TRACK_LIMIT_PENALTY = 5;

export function updateTrackLimits(world: WorldState, track: BuiltTrack, car: CarEntry, dt: number): void {
  const r = car.race;
  const s = world.session;
  if (!world.config.rules.trackLimits || car.status !== 'running' || car.pit.phase !== 'none') {
    r.limitTimer = 0;
    r.limitFlagged = false;
    return;
  }
  if ((s.phase !== 'running' && s.phase !== 'chequered') || r.netGuess) return;
  const p = car.phys;
  const lat = p.lateral;
  const side = lat >= 0 ? 1 : -1;
  const hw = sampleAt(track, track.halfWidth, p.s);
  const beyond = Math.abs(lat) > hw + car.spec.trackWidth / 2 + TYRE_HALF_WIDTH;
  if (!beyond) {
    r.limitTimer = 0;
    r.limitFlagged = false;
    return;
  }
  const inCorner = Math.abs(sampleAt(track, track.curvature, p.s)) > CORNER_CURVATURE;
  const pitSide = side === track.pit.side && isInPitZone(track, p.s);
  if (!inCorner || pitSide || p.speed < 12) return;
  r.limitTimer += dt;
  if (r.limitTimer <= LIMIT_TIME || r.limitFlagged) return;
  r.limitFlagged = true;
  const pen = car.penalties;
  pen.trackLimitWarnings += 1;
  car.timing.lapValid = false;
  emit(world, { type: 'trackLimits', carId: car.id, warnings: pen.trackLimitWarnings });
  if (s.kind === 'race' && pen.trackLimitWarnings > FREE_WARNINGS) {
    const reason = '多次超出賽道界線';
    pen.timeSec += TRACK_LIMIT_PENALTY;
    pen.log.push(`+${TRACK_LIMIT_PENALTY} 秒：${reason}（第 ${pen.trackLimitWarnings} 次）`);
    emit(world, { type: 'penalty', carId: car.id, seconds: TRACK_LIMIT_PENALTY, reason });
    radioPenalty(world, car, TRACK_LIMIT_PENALTY, reason);
  } else {
    radioTrackLimits(world, car, pen.trackLimitWarnings);
  }
}
