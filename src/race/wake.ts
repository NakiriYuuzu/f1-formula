/**
 * Aerodynamic wake (races, unless rules.aeroWake is false): a car close behind another, in line, runs in its tow (less drag) and in its dirty air (less
 * front downforce, so it understeers). Both fade with the gap and with the lateral offset
 * from the car ahead; the strongest wake counts. A much slower car ahead (being passed, crawling) leaves none. Pure.
 */
import type { AeroWake, BuiltTrack, CarEntry, WorldState } from '../core/types';
import { signedDeltaS } from '../track/track';

export const CLEAN_AIR: Readonly<AeroWake> = Object.freeze({ drag: 1, frontDownforce: 1, rearDownforce: 1 });

/**
 * Tow: drag reduction right behind a car, gone at TOW_RANGE (m, centre to centre). The tow is what closes a gap, so it
 * decides whether a faster car gets past a slower one. Tuned in headless races (20 cars, reverse grid, difficulty 90, 8
 * seeds; mean finish of the five fastest cars, which start 16th to 20th, Monza / Suzuka): 0.15 left them at 10.3 / 11.4;
 * 0.22 gives 8.6 / 10.8; 0.30 does no better (9.7 / 10.6) and doubles the contacts at Monza. A longer range (110, 120 m)
 * did not help, a shorter one (45 m) cost passes.
 */
export const TOW_DRAG = 0.22;
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
