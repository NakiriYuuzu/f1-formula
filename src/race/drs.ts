/**
 * DRS / active aero and ERS overtake eligibility (runs after timing recorded this step's crossings):
 * - race 2025: DRS enabled once the leader starts lap 3; a car is eligible for a zone if another car crossed the
 *   zone's detection point less than 1.0 s before it; available inside the activation zone.
 * - race 2026: straight mode for everyone in the zones from lights out; overtake boost for the following lap
 *   when the car crossed the control line within 1.0 s of another car.
 * - practice / qualifying / time trial: zones always available; overtake boost always available.
 * - everything disabled while track wetness > 0.4. Events (drsAvailable / drsOpen) are emitted for human cars only.
 */
import type { BuiltTrack, CarEntry, WorldState } from '../core/types';
import { isCarHeld } from '../physics/index';
import { inRangeS } from '../track/track';
import { emit, isHuman } from './events';
import { radioDrsEnabled } from './radio';

/** Detection gap (s) for DRS / overtake eligibility. */
export const DRS_GAP = 1.0;
/** Wetness above which DRS / active aero is disabled. */
export const DRS_WET_LIMIT = 0.4;

const canUseAero = (car: CarEntry): boolean => car.status === 'running' && car.pit.phase === 'none' && !isCarHeld(car.phys);

/** Did another eligible car pass the same timing point less than DRS_GAP before `time`? */
function hadCarWithin(world: WorldState, car: CarEntry, time: number, pick: (o: CarEntry) => number): boolean {
  for (const o of world.cars) {
    if (o === car || o.status === 'retired' || o.pit.phase !== 'none') continue;
    const t = pick(o);
    if (t < time && time - t <= DRS_GAP) return true;
  }
  return false;
}

export function updateDrs(world: WorldState, track: BuiltTrack, t0: number): void {
  const s = world.session;
  const cfg = world.config;
  const race = s.kind === 'race';
  const reg26 = cfg.regulation === '2026';
  const live = s.phase === 'running' || s.phase === 'chequered';
  const dry = world.weather.wetness <= DRS_WET_LIMIT;
  let enabled: boolean;
  if (!live) enabled = false;
  else if (race) enabled = dry && (reg26 || s.leaderLap >= 3) && s.control.mode === 'green' && s.leaderLap >= s.control.drsLockUntilLap;
  else enabled = dry;
  // race control: no DRS / straight mode / overtake boost while neutralised
  const neutral = race && s.control.mode !== 'green';
  if (enabled && !s.drsEnabled && live) {
    emit(world, { type: 'drsEnabled' });
    radioDrsEnabled(world);
  }
  s.drsEnabled = enabled;

  const zones = track.drsZones;
  for (const car of world.cars) {
    const p = car.phys;
    const r = car.race;
    const usable = canUseAero(car);
    // ERS overtake boost
    if (!usable || neutral) p.ers.overtakeAvailable = false;
    else if (!reg26 || !race) p.ers.overtakeAvailable = true;
    else if (r.lineTime >= t0 - 1e-9) p.ers.overtakeAvailable = live && hadCarWithin(world, car, r.lineTime, (o) => o.race.lineTime);

    if (!usable || !enabled || zones.length === 0) {
      p.drs.available = false;
      p.drs.eligible = false;
      r.drsZone = -1;
      trackDrsEvents(world, car);
      continue;
    }
    for (let z = 0; z < zones.length; z++) {
      const det = r.drsDetTimes[z];
      if (det === undefined || det < t0 - 1e-9) continue;
      const eligible = !race || reg26 || hadCarWithin(world, car, det, (o) => o.race.drsDetTimes[z] ?? -1e9);
      p.drs.eligible = eligible;
      r.drsZone = eligible ? z : -1;
    }
    // eligibility lasts from the detection point to the end of its zone
    if (r.drsZone >= 0) {
      const zone = zones[r.drsZone];
      if (!zone || !inRangeS(track, p.s, zone.detection, zone.end)) {
        r.drsZone = -1;
        p.drs.eligible = false;
      }
    }
    // free use outside races: eligible in every zone
    if (!race || reg26) {
      p.drs.eligible = true;
      r.drsZone = -1;
    }
    let available = false;
    for (let z = 0; z < zones.length; z++) {
      const zone = zones[z];
      if (!inRangeS(track, p.s, zone.activation, zone.end)) continue;
      available = !race || reg26 || (p.drs.eligible && r.drsZone === z);
      break;
    }
    p.drs.available = available;
    trackDrsEvents(world, car);
  }
}

function trackDrsEvents(world: WorldState, car: CarEntry): void {
  const r = car.race;
  const p = car.phys;
  if (isHuman(car)) {
    if (p.drs.available && !r.drsWasAvailable) emit(world, { type: 'drsAvailable', carId: car.id });
    if (p.drs.open && !r.drsWasOpen) emit(world, { type: 'drsOpen', carId: car.id });
  }
  r.drsWasAvailable = p.drs.available;
  r.drsWasOpen = p.drs.open;
}
