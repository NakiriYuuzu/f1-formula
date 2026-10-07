/**
 * Aerodynamic wake (races, unless rules.aeroWake is false): a car close behind another, in line, runs in its tow (less drag) and in its dirty air (less
 * front downforce, so it understeers). Both fade with the gap and with the lateral offset
 * from the car ahead; the strongest wake counts. A much slower car ahead (being passed, crawling) leaves none. Pure.
 */
import type { AeroWake, BuiltTrack, CarEntry, WorldState } from '../core/types';
import { signedDeltaS } from '../track/track';

export const CLEAN_AIR: Readonly<AeroWake> = Object.freeze({ drag: 1, frontDownforce: 1, rearDownforce: 1 });

/**
 * Tow: drag reduction right behind a car, gone at TOW_RANGE (m, centre to centre). Tuned in headless races (about
 * +8 km/h at the end of a straight in 2025, +4 in 2026): a stronger tow brought followers into the braking zones so fast
 * and close that the AI's battles ended in spins and contacts far more often.
 */
export const TOW_DRAG = 0.15;
const TOW_RANGE = 80;
/**
 * Dirty air: front / rear downforce loss right behind a car, gone at DIRTY_RANGE (m). It is the front wing that loses
 * its air (the follower understeers and drops back in fast corners); a rear loss as well made followers snap into spins
 * when they closed in mid-corner.
 */
export const DIRTY_FRONT = 0.15;
export const DIRTY_REAR = 0;
const DIRTY_RANGE = 40;
/** Wake half width (m): full within WAKE_CORE of the car ahead's line, none beyond WAKE_HALF. */
const WAKE_CORE = 1.4;
const WAKE_HALF = 3.6;
/** A car ahead slower than this fraction of our speed leaves no wake worth counting. */
const MIN_SPEED_RATIO = 0.5;

export function aeroWake(world: WorldState, track: BuiltTrack, car: CarEntry): AeroWake {
  if (world.config.kind !== 'race' || world.config.rules.aeroWake === false) return CLEAN_AIR;
  const p = car.phys;
  let tow = 0;
  let dirty = 0;
  for (const o of world.cars) {
    if (o === car || o.status === 'retired' || o.pit.phase !== 'none') continue;
    const ds = signedDeltaS(track, p.s, o.phys.s);
    if (ds < car.spec.length || ds > TOW_RANGE) continue;
    const off = Math.abs(o.phys.lateral - p.lateral);
    if (off >= WAKE_HALF || o.phys.speed < MIN_SPEED_RATIO * p.speed) continue;
    const inLine = Math.min(1, (WAKE_HALF - off) / (WAKE_HALF - WAKE_CORE));
    tow = Math.max(tow, (1 - ds / TOW_RANGE) * inLine);
    if (ds < DIRTY_RANGE) dirty = Math.max(dirty, (1 - ds / DIRTY_RANGE) * inLine);
  }
  if (tow === 0 && dirty === 0) return CLEAN_AIR;
  return { drag: 1 - TOW_DRAG * tow, frontDownforce: 1 - DIRTY_FRONT * dirty, rearDownforce: 1 - DIRTY_REAR * dirty };
}
