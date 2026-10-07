/**
 * AI pit strategy: decides once per lap (before the pit entry) whether an AI car boxes and on which compound —
 * expected tyre life vs. remaining race distance, the mandatory different-compound stop, weather crossover
 * (inters > 0.35 wetness, wets > 0.7, slicks < 0.2, debounced) and front-wing repair. Pure logic on WorldState.
 */
import type { BuiltTrack, CarEntry, TireCompound, WorldState } from '../core/types';
import { DRY_COMPOUNDS } from '../core/defaults';
import { COMPOUND_PARAMS } from '../physics/index';
import { forwardDistance } from '../track/track';

/** Wear level the strategy aims to pit before (just ahead of the grip cliff at 0.7). */
export const PIT_WEAR = 0.72;
/** Approximate wear per metre at race pace for each compound (fresh estimate before any lap data). */
const WEAR_PER_METER: Record<TireCompound, number> = {
  soft: 1.15e-5,
  medium: 0.75e-5,
  hard: 0.53e-5,
  inter: 0.8e-5,
  wet: 0.75e-5,
};
/** Weather mismatch must persist this long (s) before an AI reacts. */
const WEATHER_DEBOUNCE = 5;

export const isDry = (c: TireCompound): boolean => c === 'soft' || c === 'medium' || c === 'hard';

/** Compound the weather calls for, or null if the current one is still right (with hysteresis). */
export function weatherCompound(current: TireCompound, wetness: number): 'inter' | 'wet' | 'dry' | null {
  const w = Number.isFinite(wetness) ? wetness : 0;
  if (isDry(current)) {
    if (w > 0.7) return 'wet';
    if (w > 0.35) return 'inter';
    return null;
  }
  if (current === 'inter') {
    if (w > 0.7) return 'wet';
    if (w < 0.2) return 'dry';
    return null;
  }
  if (w < 0.2) return 'dry';
  if (w < 0.5) return 'inter';
  return null;
}

/** Per-lap wear estimate for the car's current set (measured once a lap has been driven). */
export function wearPerLap(car: CarEntry, track: BuiltTrack): number {
  const ai = car.ai;
  const laps = car.timing.lapsCompleted - ai.stintStartLap;
  const measured = laps >= 1 ? (car.phys.tire.wear - ai.stintWear) / laps : NaN;
  const estimate = WEAR_PER_METER[car.phys.tire.compound] * track.length;
  return Number.isFinite(measured) && measured > 0 ? Math.max(measured, estimate * 0.4) : estimate;
}

/** Softest dry compound expected to last `laps` laps (given the current per-lap wear), avoiding `exclude`. */
export function chooseDryCompound(
  car: CarEntry,
  track: BuiltTrack,
  laps: number,
  exclude: readonly TireCompound[] = [],
): TireCompound {
  const current = car.phys.tire.compound;
  const base = isDry(current)
    ? wearPerLap(car, track) / COMPOUND_PARAMS[current].wearRate
    : WEAR_PER_METER.soft * track.length / COMPOUND_PARAMS.soft.wearRate;
  const options = DRY_COMPOUNDS.filter((c) => !exclude.includes(c));
  const pool = options.length > 0 ? options : DRY_COMPOUNDS;
  for (const c of pool) {
    const rate = base * COMPOUND_PARAMS[c].wearRate;
    if (rate <= 0 || PIT_WEAR / rate >= laps + 0.5) return c;
  }
  return pool[pool.length - 1] ?? 'hard';
}

export interface StrategyContext {
  /** dry compounds this car has used so far (race runtime bookkeeping) */
  usedCompounds: readonly TireCompound[];
  /** mandatory-stop rule applies to this car right now */
  mandatoryOpen: boolean;
}

/**
 * Decide whether an AI car boxes at the coming pit entry. Returns the compound to fit, or null.
 * Updates the weather debounce every call; the actual decision happens once per lap, 120–700 m before the entry.
 */
export function decidePitStop(
  world: WorldState,
  car: CarEntry,
  track: BuiltTrack,
  dt: number,
  ctx: StrategyContext,
): TireCompound | null {
  const ai = car.ai;
  const p = car.phys;
  if (car.playerIndex !== -1 || car.status !== 'running' || car.pit.phase !== 'none' || car.pit.requested) return null;
  if (world.config.kind === 'timeTrial' || world.session.phase !== 'running') return null;
  const want = weatherCompound(p.tire.compound, world.weather.wetness);
  ai.weatherTimer = want ? ai.weatherTimer + (Number.isFinite(dt) ? dt : 0) : 0;

  const toEntry = forwardDistance(track, p.s, track.pit.entry);
  if (toEntry > 700 || toEntry < 120 || ai.strategyLap === car.timing.lap) return null;
  ai.strategyLap = car.timing.lap;

  const race = world.config.kind === 'race';
  // laps still to drive after this stop (the current lap ends in the pit lane)
  const after = race ? world.session.totalLaps - car.timing.lapsCompleted - 1 : 99;
  if (after < 1) return null;

  if (want && ai.weatherTimer >= WEATHER_DEBOUNCE) {
    if (want === 'dry') return chooseDryCompound(car, track, after, ctx.mandatoryOpen ? ctx.usedCompounds : []);
    return want;
  }
  if (!isDry(p.tire.compound)) return null;

  if (p.damage.frontWing > 0.4 && after >= 2) return chooseDryCompound(car, track, after);
  if (!race) return null;

  // a stop under the (virtual) safety car costs far less time
  const mode = world.session.control.mode;
  if ((mode === 'sc' || mode === 'vsc') && after >= 3 && p.tire.wear > 0.3) {
    return chooseDryCompound(car, track, after, ctx.mandatoryOpen ? ctx.usedCompounds : []);
  }

  const rate = wearPerLap(car, track);
  const wear = p.tire.wear;
  const finishWear = wear + rate * (after + 1);
  const teammateBusy = world.cars.some(
    (o) => o !== car && o.teamId === car.teamId && (o.pit.requested || o.pit.phase !== 'none'),
  );
  if (finishWear > 0.82 && wear + rate > PIT_WEAR) {
    if (teammateBusy && wear + rate < 0.85) return null;
    return chooseDryCompound(car, track, after, ctx.mandatoryOpen ? ctx.usedCompounds : []);
  }
  if (ctx.mandatoryOpen) {
    const total = world.session.totalLaps;
    const half = car.timing.lapsCompleted + 1 >= Math.floor(total / 2);
    if ((half || after <= 2) && !(teammateBusy && after > 2)) return chooseDryCompound(car, track, after, ctx.usedCompounds);
  }
  return null;
}
