/**
 * AI race strategy, decided once per lap 120–700 m before the pit entry: whether the car boxes and on which compound,
 * its pace mode for the coming lap and team orders.
 * - Weather: the crossover (inters > 0.35 wetness, wets > 0.7, slicks < 0.2, debounced) read against the forecast —
 *   rain tyres a lap early when they will be quicker over the lap after the stop, no new rain tyre when the track dries
 *   within two laps, never a compound the next lap would not suit. Front-wing repair.
 * - Race-time model (dry): remaining race time of no stop / one stop / two stops over the dry compounds (mandatory
 *   different-compound stop; no stint past the wear limits) from the measured wear rate and wearGrip → when to stop and
 *   on what. The wear and mandatory backstops of the earlier fixed rules stay.
 * - Undercut / overcut / cover against the cars around it; the cheaper stop under a (virtual) safety car (not stacked
 *   behind a team-mate in the box unless the tyres are gone).
 * - Pace mode (push / standard / conserve) and team orders (let a quicker team-mate by; hold position late on).
 * The model costs O(laps²) once per car and lap. Pure logic on WorldState; mutates only `car.ai`.
 */
import type { BuiltTrack, CarEntry, TireCompound, WeatherKind, WorldState } from '../core/types';
import type { AIPaceMode, AIPitCall } from './types';
import { DRY_COMPOUNDS } from '../core/defaults';
import { clamp, clamp01 } from '../core/math';
import { COMPOUND_PARAMS, wearGrip, wetGrip } from '../physics/index';
import { predictWetness } from '../race/weather';
import { forwardDistance } from '../track/track';
import { estimatedPace } from './traffic';

/** Wear level the strategy aims to pit before (just ahead of the grip cliff at 0.7). */
export const PIT_WEAR = 0.72;
/** A last stint may run to this wear (backstop: a car projected beyond it boxes once its next lap passes PIT_WEAR). */
export const FINISH_WEAR = 0.82;
/** No plan takes a set beyond this wear (grip cliff: −14.5 % grip at 0.85). */
export const CLIFF_WEAR = 0.85;
/**
 * Lap-time sensitivity to tyre grip (relative lap time per unit of grip lost): lap time ≈ reference × (1 +
 * GRIP_SENSITIVITY × (1 − compound grip × wearGrip)). Measured with one AI car on frozen wear (soft at 0 / 0.35 / 0.7 /
 * 0.8 wear, fresh medium and hard): 0.43–0.55 at Silverstone, Koyo Hills, Porto Lumen, Suzuka and Monaco, 0.28 at
 * Monza (most of the lap at full throttle) — below a first guess of 0.6–0.8, since only corners and braking zones are
 * grip-limited.
 */
export const GRIP_SENSITIVITY = 0.45;
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
/** Pit loss (s) when the race runtime gives none. */
const DEFAULT_PIT_LOSS = 22;
/** The race-time model plans up to four stops (planRace; under a safety car a stop now may be worth one more). */
const MAX_STOPS = 4;

/**
 * Undercut: the car ahead within UNDERCUT_GAP s on a set no fresher than ours (SIMILAR_WEAR), and it must stop too —
 * box now when the fresh-set gain over UNDERCUT_LAPS laps (model), less what stopping now costs over the best plan,
 * beats the gap by UNDERCUT_MARGIN s.
 */
const UNDERCUT_GAP: readonly [number, number] = [1, 2.5];
const SIMILAR_WEAR = 0.03;
const UNDERCUT_LAPS = 2;
const UNDERCUT_MARGIN = 0.4;
/**
 * Overcut: the car ahead (within OVERCUT_GAP s) has just pitted, we have clean air (no car within CLEAN_AIR s) and a lap
 * on our old set is no slower than its out-lap (fresh set + OUTLAP_WARMUP s off the blankets): stay out up to
 * OVERCUT_MAX laps, costing at most OVERCUT_SLACK s a lap over stopping now in the model.
 */
const OVERCUT_GAP = 3;
const CLEAN_AIR = 1.5;
const OUTLAP_WARMUP = 0.3;
const OVERCUT_MAX = 3;
const OVERCUT_SLACK = 1;
/** Cover: the car behind (within COVER_GAP s) has just pitted and its fresh set would take the place — box now if that
 * costs at most COVER_SLACK s over the best plan. */
const COVER_GAP = 2;
const COVER_SLACK = 3;
/**
 * (Virtual) safety car: the model again with the cheaper stop, on a set worn beyond NEUTRAL_MIN_WEAR with at least
 * NEUTRAL_MIN_LAPS laps left (the earlier fixed rule, kept as the lower bound: a fresh set is not thrown away on a
 * measured rate that is still settling) — or for the stop the plan makes within NEUTRAL_SOON laps anyway. Without a
 * plan the earlier fixed rule itself.
 */
const NEUTRAL_MIN_LAPS = 3;
const NEUTRAL_MIN_WEAR = 0.3;
const NEUTRAL_SOON = 2;
/** Waiting behind the team-mate in the shared box (s): its service plus the gap. Taken anyway past BAD_WEAR. */
const QUEUE_LOSS = 4;
const BAD_WEAR = 0.6;
/**
 * Forecast: rain falling or due within FORECAST_RAIN s — rain tyres a lap early once the track at our pit exit nears the
 * crossover (NEAR_CROSSOVER wetness) and they are quicker over the lap after the stop; no dry stop while the track is
 * to cross to rain tyres within RAIN_HOLD_LAPS laps of the pit exit (a new slick set would be changed again at once —
 * only the wear backstop overrides). No new rain tyre when the track dries below DRY_WETNESS within DRYING_LAPS laps.
 * WINDOW_SAMPLES predictions over the lap after a stop.
 */
const FORECAST_RAIN = 180;
const NEAR_CROSSOVER = 0.1;
const RAIN_HOLD_LAPS = 2;
const DRY_WETNESS = 0.2;
const DRYING_LAPS = 2;
const WINDOW_SAMPLES = 5;
/** Pace mode: conserve when the planned stint ends within STRETCH_MARGIN of its wear limit, or the fuel left is below
 * the measured burn × laps to go × (1 + FUEL_MARGIN). */
const STRETCH_MARGIN = 0.06;
const FUEL_MARGIN = 0.02;
/**
 * Pace mode push in the last PUSH_FINAL_LAPS laps (at most the last PUSH_FINAL_SHARE of the race, at least one) when
 * the set reaches the flag under PIT_WEAR at PUSH_WEAR × the wear rate and the fuel at PUSH_FUEL × the burn; only on a
 * dry track (below PUSH_WET wetness). The controller applies it in clean air only. Pushing while attacking is the
 * controller's chase push, step by step: a lap-long push mode set for an attack outlasts it (−6 % overtakes in 32
 * races), and both at once brake into the car ahead.
 */
const PUSH_FINAL_LAPS = 3;
const PUSH_FINAL_SHARE = 0.2;
const PUSH_WEAR = 1.1;
const PUSH_FUEL = 1.03;
const PUSH_WET = 0.15;
/**
 * Team orders: the team-mate right behind within TEAM_GAP s, quicker by TEAM_PACE s a lap (an AI team-mate: the pace
 * estimates on the current tyres; a human: its measured clean laps — AIState.cleanLap — and its estimate, the slower,
 * against our quicker of estimate / clean laps) at TEAM_LAPS evaluations in a row once TEAM_MIN_LAPS laps are done (the
 * standing-start lap tells nothing), on another strategy (compound / stops) or with a car ahead of us within TEAM_CHASE s → let it by within
 * YIELD_TIME s (traffic.ts), then not race it for YIELD_HOLD evaluations (no swapping straight back). Hold position: the
 * last HOLD_LAPS laps (in a short race its last HOLD_SHARE — a 5-lap race is not all "late"), two AI team-mates in the
 * points (top POINTS_PLACES) within HOLD_GAP s of each other.
 */
const TEAM_GAP = 1.5;
const TEAM_PACE = 0.35;
const TEAM_LAPS = 2;
const TEAM_MIN_LAPS = 1;
const TEAM_CHASE = 2;
export const YIELD_TIME = 60;
const YIELD_HOLD = 3;
const HOLD_LAPS = 5;
const HOLD_SHARE = 0.2;
const POINTS_PLACES = 10;
const HOLD_GAP = 1.5;

const fin = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

export const isDry = (c: TireCompound): boolean => c === 'soft' || c === 'medium' || c === 'hard';

const rainy = (k: WeatherKind): boolean => k === 'lightRain' || k === 'heavyRain';

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

/**
 * Per-lap wear estimate for the car's current set: measured over the distance driven on it once that is a lap (the
 * strategy decides late in a lap — counting completed laps only overstated the rate by the part lap: 1.8× a lap into
 * a stint).
 */
export function wearPerLap(car: CarEntry, track: BuiltTrack): number {
  const ai = car.ai;
  const laps = (car.timing.progress - ai.stintStartProgress) / Math.max(1, track.length);
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

// ───────────────────────────── race-time model (C1) ─────────────────────────────

/** Relative lap time on a dry compound at a wear level (1 = fresh softs). */
export function tyreLapFactor(compound: TireCompound, wear: number): number {
  return 1 + GRIP_SENSITIVITY * (1 - COMPOUND_PARAMS[compound].dryGrip * wearGrip(wear));
}

export interface PlanInput {
  /** laps still to drive after the current one */
  laps: number;
  /** lap time (s) on fresh softs */
  base: number;
  /** current (dry) compound and its wear at the end of the current lap */
  compound: TireCompound;
  wear: number;
  /** wear a lap of a set with wearRate 1 (each compound: × COMPOUND_PARAMS wearRate) */
  rate: number;
  /** time lost by a stop (s), and by one at the end of the current lap (SC / VSC, queueing; default pitLoss) */
  pitLoss: number;
  nowLoss?: number;
  /** mandatory different-compound stop still open: the plan must fit a dry compound not in `used` */
  mandatory: boolean;
  used: readonly TireCompound[];
}

export interface RacePlan {
  /** remaining race time (s) after the current lap: stints + stops */
  cost: number;
  /** laps the current set still runs after this one before the first stop (all laps left: no stop) */
  stay: number;
  /** compounds fitted at the stops, in order (empty: no stop), and the laps run on each */
  stints: TireCompound[];
  stintLaps: number[];
}

export interface PlanResult {
  best: RacePlan | null;
  /** best plan stopping at the end of the current lap / best plan stopping later or not at all */
  now: RacePlan | null;
  later: RacePlan | null;
  /** best cost for each number of laps the current set still runs (Infinity: no plan) */
  byStay: number[];
}

/** Prefix sums of a stint's lap times [0, lap 1, laps 1–2, …] for `laps` laps from `wear` at `rate` a lap. */
function stintTimes(base: number, compound: TireCompound, wear: number, rate: number, laps: number): Float64Array {
  const out = new Float64Array(laps + 1);
  for (let j = 1; j <= laps; j++) out[j] = out[j - 1] + base * tyreLapFactor(compound, wear + rate * (j - 0.5));
  return out;
}

/** Laps a set at `wear` may still run at `rate` a lap without passing `limit` (-1: already past it). */
function lapsTo(wear: number, rate: number, limit: number): number {
  if (wear > limit) return -1;
  return rate > 0 ? Math.floor((limit - wear) / rate + 1e-9) : Infinity;
}

/** a beats b: quicker; on a tie the later first stop, then fewer stops */
function beats(cost: number, stay: number, stops: number, b: RacePlan | null): boolean {
  if (!b) return true;
  if (cost < b.cost - 1e-9) return true;
  if (cost > b.cost + 1e-9) return false;
  return stay > b.stay || (stay === b.stay && stops < b.stints.length);
}

/**
 * C1: remaining race time after the current lap for every plan of no stop / one stop / two stops over the dry
 * compounds, the stop after any number of laps on the current set: a lap costs base × tyreLapFactor at its mid-lap
 * wear, a stop pitLoss. A set that stops runs at most to PIT_WEAR, the last stint to FINISH_WEAR (both short of
 * CLIFF_WEAR — the backstop rules' limits); with the mandatory stop open a compound not yet used must be fitted.
 */
export function planRace(input: PlanInput): PlanResult {
  const n = Math.max(0, Math.floor(fin(input.laps, 0)));
  const res: PlanResult = { best: null, now: null, later: null, byStay: new Array<number>(n + 1).fill(Infinity) };
  const base = fin(input.base, 0);
  if (!(base > 0) || !isDry(input.compound)) return res;
  const unit = Math.max(0, fin(input.rate, 0));
  const rateOf = (c: TireCompound): number => unit * COMPOUND_PARAMS[c].wearRate;
  const w0 = clamp01(fin(input.wear, 0));
  const rc = rateOf(input.compound);
  const loss = Math.max(0, fin(input.pitLoss, DEFAULT_PIT_LOSS));
  const lossNow = Math.max(0, fin(input.nowLoss ?? loss, loss));
  const dry = DRY_COMPOUNDS;
  const cur = stintTimes(base, input.compound, w0, rc, n);
  const fresh = dry.map((c) => stintTimes(base, c, 0, rateOf(c), n));
  const toStop = dry.map((c) => lapsTo(0, rateOf(c), PIT_WEAR));
  const toEnd = dry.map((c) => lapsTo(0, rateOf(c), FINISH_WEAR));
  const isNew = dry.map((c) => !input.mandatory || !input.used.includes(c));

  const offer = (cost: number, stay: number, c1: number, c2: number, m = 0): void => {
    if (cost < res.byStay[stay]) res.byStay[stay] = cost;
    const stops = c1 < 0 ? 0 : c2 < 0 ? 1 : 2;
    const now = stay === 0 && stops > 0;
    const winBest = beats(cost, stay, stops, res.best);
    const winSlot = beats(cost, stay, stops, now ? res.now : res.later);
    if (!winBest && !winSlot) return;
    const rest = n - stay;
    const plan: RacePlan =
      c1 < 0
        ? { cost, stay, stints: [], stintLaps: [] }
        : c2 < 0
          ? { cost, stay, stints: [dry[c1]], stintLaps: [rest] }
          : { cost, stay, stints: [dry[c1], dry[c2]], stintLaps: [m, rest - m] };
    if (winBest) res.best = plan;
    if (winSlot) {
      if (now) res.now = plan;
      else res.later = plan;
    }
  };

  if (!input.mandatory && lapsTo(w0, rc, FINISH_WEAR) >= n) offer(cur[n], n, -1, -1);
  const maxStay = Math.min(n - 1, Math.max(0, lapsTo(w0, rc, PIT_WEAR)));
  for (let k = 0; k <= maxStay; k++) {
    const stop = k === 0 ? lossNow : loss;
    const rest = n - k;
    for (let i = 0; i < dry.length; i++) {
      if (toEnd[i] >= rest && isNew[i]) offer(cur[k] + stop + fresh[i][rest], k, i, -1);
      const m1 = Math.min(rest - 1, toStop[i]);
      for (let m = 1; m <= m1; m++) {
        const head = cur[k] + stop + fresh[i][m] + loss;
        for (let j = 0; j < dry.length; j++) {
          if (toEnd[j] < rest - m || !(isNew[i] || isNew[j])) continue;
          offer(head + fresh[j][rest - m], k, i, j, m);
        }
      }
    }
  }
  morePlans(res, n, cur, fresh, toStop, toEnd, isNew, input.mandatory, maxStay, loss, lossNow);
  return res;
}

/**
 * Plans of three and four stops (a long race on sets that wear quickly: two fresh sets may not reach the flag, or not
 * after a stop now; a cheap stop under a safety car may be worth one more). The stints after the first stop come from
 * tables of the quickest finish over r laps in s stints from a fresh set of each compound (with / without one not used
 * yet): O(laps²) a level, ≈ 0.1–0.3 ms a call for 50–78 laps.
 */
function morePlans(
  res: PlanResult,
  n: number,
  cur: Float64Array,
  fresh: Float64Array[],
  toStop: number[],
  toEnd: number[],
  isNew: boolean[],
  mandatory: boolean,
  maxStay: number,
  loss: number,
  lossNow: number,
): void {
  const C = fresh.length;
  const dry = DRY_COMPOUNDS;
  const size = (n + 1) * C;
  // level s: [cost, laps of the first stint, compound after it] for any compounds ('any') / with a new one ('add')
  interface Level {
    any: Float64Array;
    anyM: Int32Array;
    anyJ: Int32Array;
    add: Float64Array;
    addM: Int32Array;
    addJ: Int32Array;
  }
  const level = (): Level => ({
    any: new Float64Array(size).fill(Infinity),
    anyM: new Int32Array(size),
    anyJ: new Int32Array(size),
    add: new Float64Array(size).fill(Infinity),
    addM: new Int32Array(size),
    addJ: new Int32Array(size),
  });
  const first = level();
  for (let r = 1; r <= n; r++) {
    for (let i = 0; i < C; i++) {
      if (toEnd[i] < r) continue;
      first.any[r * C + i] = fresh[i][r];
      first.anyM[r * C + i] = r;
      if (isNew[i]) {
        first.add[r * C + i] = fresh[i][r];
        first.addM[r * C + i] = r;
      }
    }
  }
  const levels: Level[] = [first];
  for (let s = 2; s <= MAX_STOPS; s++) {
    const prev = levels[s - 2];
    const lv = level();
    for (let r = s; r <= n; r++) {
      for (let i = 0; i < C; i++) {
        const m1 = Math.min(r - (s - 1), toStop[i]);
        for (let m = 1; m <= m1; m++) {
          const head = fresh[i][m] + loss;
          const q = (r - m) * C;
          for (let j = 0; j < C; j++) {
            const a = head + prev.any[q + j];
            if (a < lv.any[r * C + i]) {
              lv.any[r * C + i] = a;
              lv.anyM[r * C + i] = m;
              lv.anyJ[r * C + i] = j;
            }
            // a new compound: this set, or one in the rest
            const b = head + (isNew[i] ? prev.any[q + j] : prev.add[q + j]);
            if (b < lv.add[r * C + i]) {
              lv.add[r * C + i] = b;
              lv.addM[r * C + i] = m;
              lv.addJ[r * C + i] = j;
            }
          }
        }
      }
    }
    levels.push(lv);
    if (s < 3) continue;
    // s stops: the current set k more laps, then the s stints
    for (let k = 0; k <= maxStay; k++) {
      const rest = n - k;
      for (let i = 0; i < C; i++) {
        const tail = (mandatory ? lv.add : lv.any)[rest * C + i];
        if (tail === Infinity) continue;
        const cost = cur[k] + (k === 0 ? lossNow : loss) + tail;
        if (cost < res.byStay[k]) res.byStay[k] = cost;
        const now = k === 0;
        const winBest = beats(cost, k, s, res.best);
        const winSlot = beats(cost, k, s, now ? res.now : res.later);
        if (!winBest && !winSlot) continue;
        // follow the back-pointers down the levels
        const stints: TireCompound[] = [];
        const stintLaps: number[] = [];
        let r = rest;
        let c = i;
        let needNew = mandatory;
        for (let l = s; l >= 1; l--) {
          const t = levels[l - 1];
          const at = r * C + c;
          const m = needNew ? t.addM[at] : t.anyM[at];
          const next = needNew ? t.addJ[at] : t.anyJ[at];
          stints.push(dry[c]);
          stintLaps.push(m);
          if (isNew[c]) needNew = false;
          r -= m;
          c = next;
        }
        const plan: RacePlan = { cost, stay: k, stints, stintLaps };
        if (winBest) res.best = plan;
        if (winSlot) {
          if (now) res.now = plan;
          else res.later = plan;
        }
      }
    }
  }
}

/** The model wants the stop at the end of this lap. */
const stopsNow = (r: PlanResult): boolean => r.now !== null && (r.later === null || r.now.cost < r.later.cost);

// ───────────────────────────── decision ─────────────────────────────

export interface StrategyContext {
  /** dry compounds this car has used so far (race runtime bookkeeping) */
  usedCompounds: readonly TireCompound[];
  /** mandatory-stop rule applies to this car right now */
  mandatoryOpen: boolean;
  /** green-flag pit-stop loss (s) on this track (race/pitlane estimatePitLoss) */
  pitLoss?: number;
  /** share of that loss a stop right now costs (< 1 under a safety car / VSC; race/pitlane pitLossFactor) */
  lossFactor?: number;
  /** the mandatory-stop rule is still open for another car (must a rival stop too) */
  mandatoryFor?: (car: CarEntry) => boolean;
}

interface Call {
  compound: TireCompound;
  reason: AIPitCall;
}

interface Evaluation {
  call: Call | null;
  /** race-time model (dry races; null when not run) */
  plan: PlanResult | null;
  /** current set: wear a lap and wear at the end of this lap */
  rate: number;
  wearEnd: number;
  /** staying out on an overcut */
  overcut: boolean;
}

/** Expected flying lap (s) of a car on fresh softs: the AI estimate (a human's best lap when known). */
function basePace(car: CarEntry, track: BuiltTrack): number {
  if (car.playerIndex !== -1 && car.timing.bestLap !== null && car.timing.bestLap > 0) return car.timing.bestLap;
  return car.ai.paceTime > 0 ? car.ai.paceTime : track.referenceLapTime;
}

/** The car `offset` places ahead (-1) / behind (+1) in the classification, on the same lap. */
function neighbour(world: WorldState, car: CarEntry, offset: -1 | 1): CarEntry | null {
  const order = world.race.order;
  const i = order.indexOf(car.id);
  const o = i >= 0 ? world.cars[order[i + offset]] : undefined;
  return o && o.status !== 'retired' && o.timing.lapsDown === car.timing.lapsDown ? o : null;
}

/** Stops made, counting one requested or under way. */
const stopsOf = (o: CarEntry): number => o.pit.stops + (o.pit.requested || o.pit.phase !== 'none' ? 1 : 0);

/** Compound a car that is stopping (or just stopped) leaves on. */
const newSet = (o: CarEntry): TireCompound => (o.pit.requested || o.pit.phase !== 'none' ? o.pit.nextCompound : o.phys.tire.compound);

const teammateBusy = (world: WorldState, car: CarEntry): boolean =>
  world.cars.some((o) => o !== car && o.teamId === car.teamId && (o.pit.requested || o.pit.phase !== 'none'));

/** Time (s) a fresh `fresh` set gains over the worn `old` one in the next UNDERCUT_LAPS laps. */
function freshGain(base: number, old: TireCompound, oldWear: number, oldRate: number, fresh: TireCompound, freshRate: number): number {
  let gain = 0;
  for (let j = 1; j <= UNDERCUT_LAPS; j++) {
    gain += base * (tyreLapFactor(old, oldWear + oldRate * (j - 0.5)) - tyreLapFactor(fresh, freshRate * (j - 0.5)));
  }
  return gain;
}

/** Laps a race car still drives after the current one, by its own count: a lapped car takes the flag lapsDown laps early. */
function lapsAfter(world: WorldState, car: CarEntry): number {
  return Math.max(0, world.session.totalLaps - car.timing.lapsDown - car.timing.lapsCompleted - 1);
}

/** A rival still has to stop: the mandatory stop, or its set will not reach the flag. */
function mustStop(world: WorldState, o: CarEntry, track: BuiltTrack, ctx: StrategyContext): boolean {
  if (ctx.mandatoryFor?.(o)) return true;
  const left = lapsAfter(world, o) + 1;
  return o.phys.tire.wear + wearPerLap(o, track) * left > FINISH_WEAR;
}

/** Wetness predicted over the lap after a stop now (from the pit exit ≈ the entry + the pit loss). */
function wetWindow(world: WorldState, car: CarEntry, toEntry: number, lapTime: number, loss: number): number[] {
  const t0 = toEntry / Math.max(20, car.phys.speed) + loss;
  const out: number[] = [];
  for (let i = 0; i < WINDOW_SAMPLES; i++) out.push(predictWetness(world.weather, world.time, t0 + (lapTime * i) / (WINDOW_SAMPLES - 1)));
  return out;
}

/**
 * Compound for a weather stop: the most grip over the lap after it among `cands`, leaving out one that the wetness at
 * the end of that lap would already call to change (the quickest anyway if none qualifies).
 */
function weatherPick(cands: readonly TireCompound[], ws: readonly number[]): TireCompound {
  const end = ws[ws.length - 1] ?? 0;
  let any = cands[0];
  let anyGrip = -Infinity;
  let suited: TireCompound | null = null;
  let suitedGrip = -Infinity;
  for (const c of cands) {
    let g = 0;
    for (const w of ws) g += wetGrip(c, w);
    if (g > anyGrip) {
      anyGrip = g;
      any = c;
    }
    if (weatherCompound(c, end) === null && g > suitedGrip) {
      suitedGrip = g;
      suited = c;
    }
  }
  return suited ?? any;
}

/** weatherCall: rain tyres are due soon after a stop now — no dry stop this lap (the backstops still may). */
const HOLD_DRY = 'holdDry';

/**
 * Weather (C4): a Call, null (hold: no stop this lap), HOLD_DRY (on slicks: no dry stop, the track crosses to rain tyres
 * within RAIN_HOLD_LAPS laps of the pit exit) or undefined (not a weather matter: the dry strategy decides). The
 * debounced crossover picks the compound from the predicted wetness; on slicks the forecast brings rain tyres a lap
 * early; on rain tyres a drying track within DRYING_LAPS laps means no new rain tyre.
 */
function weatherCall(
  world: WorldState,
  car: CarEntry,
  track: BuiltTrack,
  ctx: StrategyContext,
  want: 'inter' | 'wet' | 'dry' | null,
  after: number,
  toEntry: number,
  loss: number,
): Call | null | undefined | typeof HOLD_DRY {
  const w = world.weather;
  const cur = car.phys.tire.compound;
  const dry = isDry(cur);
  const now = world.time;
  const rainAhead = rainy(w.kind) || w.forecast.some((f) => rainy(f.kind) && f.time - now <= FORECAST_RAIN);
  if (dry && !want && !rainAhead && !(w.wetness > 0)) return undefined;
  const lap = basePace(car, track);
  const debounced = want !== null && car.ai.weatherTimer >= WEATHER_DEBOUNCE;
  const dryPick = (): TireCompound => chooseDryCompound(car, track, after, ctx.mandatoryOpen ? ctx.usedCompounds : []);
  if (debounced) {
    if (!dry && want !== 'dry' && predictWetness(w, now, DRYING_LAPS * lap) < DRY_WETNESS) return null;
    const ws = wetWindow(world, car, toEntry, lap, loss);
    const c = weatherPick(['inter', 'wet', dry ? cur : dryPick()], ws);
    if (c === cur || (dry && isDry(c))) return dry ? undefined : null;
    return { compound: c, reason: 'weather' };
  }
  if (dry && rainAhead) {
    const ws = wetWindow(world, car, toEntry, lap, loss);
    if (ws[0] >= NEAR_CROSSOVER) {
      const c = weatherPick(['inter', 'wet', cur], ws);
      if (!isDry(c)) return { compound: c, reason: 'forecast' };
    }
    // a new slick set now would be changed for rain tyres again at once
    const exit = toEntry / Math.max(20, car.phys.speed) + loss;
    for (let i = 0; i <= RAIN_HOLD_LAPS * 2; i++) {
      if (weatherCompound(cur, predictWetness(w, now, exit + (lap * i) / 2)) !== null) return HOLD_DRY;
    }
  }
  return dry ? undefined : null;
}

/**
 * Overcut (C2): the car ahead has just pitted (or is boxing this lap) — laps (0–OVERCUT_MAX) to stay out while clean
 * air and our old set are worth it.
 */
function overcutLaps(world: WorldState, car: CarEntry, track: BuiltTrack, plan: PlanResult, ev: Evaluation, base: number): number {
  const ai = car.ai;
  const rival = ai.aheadId >= 0 ? world.cars[ai.aheadId] : undefined;
  if (!rival || !plan.now || ai.aheadGap > OVERCUT_GAP || stopsOf(rival) <= ai.aheadStops) return 0;
  if (!cleanAir(world, car)) return 0;
  const theirs = newSet(rival);
  if (!isDry(theirs)) return 0;
  const ours = base * tyreLapFactor(car.phys.tire.compound, ev.wearEnd + ev.rate * 0.5);
  const outLap = basePace(rival, track) * tyreLapFactor(theirs, 0) + OUTLAP_WARMUP;
  if (ours > outLap) return 0;
  // the longest stay out that the model prices within the slack (a plan's cost is lumpy: one lap more can force an
  // extra stop where two laps more do not)
  let d = 0;
  for (let k = 1; k <= OVERCUT_MAX; k++) if ((plan.byStay[k] ?? Infinity) - plan.now.cost <= OVERCUT_SLACK * k) d = k;
  return d;
}

/** No car within CLEAN_AIR s ahead on the road (cars boxing this lap do not count). */
function cleanAir(world: WorldState, car: CarEntry): boolean {
  let gap = fin(car.timing.interval, Infinity);
  let o = neighbour(world, car, -1);
  while (o && (o.pit.requested || o.pit.phase !== 'none')) {
    gap += fin(o.timing.interval, Infinity);
    o = neighbour(world, o, -1);
  }
  return o === null || !(gap > 0) || gap > CLEAN_AIR;
}

/** C1–C3 in a dry race (and damage in any session): the call, with the model kept for the pace mode. */
function evaluate(
  world: WorldState,
  car: CarEntry,
  track: BuiltTrack,
  ctx: StrategyContext,
  want: 'inter' | 'wet' | 'dry' | null,
  after: number,
  toEntry: number,
): Evaluation {
  const ai = car.ai;
  const p = car.phys;
  const cur = p.tire.compound;
  const rate = wearPerLap(car, track);
  const ev: Evaluation = { call: null, plan: null, rate, wearEnd: p.tire.wear + rate * clamp01(toEntry / Math.max(1, track.length)), overcut: false };
  const loss = Math.max(0, fin(ctx.pitLoss ?? DEFAULT_PIT_LOSS, DEFAULT_PIT_LOSS));
  const stop = (compound: TireCompound, reason: AIPitCall): Evaluation => {
    ev.call = { compound, reason };
    return ev;
  };

  const weather = weatherCall(world, car, track, ctx, want, after, toEntry, loss);
  // rain tyres due soon after a stop now: only the backstops (damage, wear, mandatory) may stop on slicks
  const rainHold = weather === HOLD_DRY;
  if (weather !== undefined && weather !== HOLD_DRY) {
    ev.call = weather;
    return ev;
  }
  if (!isDry(cur)) return ev;
  const exclude = ctx.mandatoryOpen ? ctx.usedCompounds : [];
  // the repair stop also serves the mandatory stop (a compound not used yet)
  if (p.damage.frontWing > 0.4 && after >= 2) return stop(chooseDryCompound(car, track, after, exclude), 'damage');
  if (world.config.kind !== 'race') return ev;

  const busy = teammateBusy(world, car);
  const base = basePace(car, track);
  const input: PlanInput = {
    laps: after,
    base,
    compound: cur,
    wear: ev.wearEnd,
    rate: rate / COMPOUND_PARAMS[cur].wearRate,
    pitLoss: loss,
    // queueing behind the team-mate in the shared box
    nowLoss: loss + (busy ? QUEUE_LOSS : 0),
    mandatory: ctx.mandatoryOpen,
    used: ctx.usedCompounds,
  };
  const plan = planRace(input);
  ev.plan = plan;
  ai.planStops = plan.best ? plan.best.stints.length : -1;
  ai.planStay = plan.best && plan.best.stints.length > 0 ? plan.best.stay : -1;
  const pick = (r: PlanResult): TireCompound => r.now?.stints[0] ?? chooseDryCompound(car, track, after, exclude);

  // backstops of the fixed rules: never into the cliff; the mandatory stop with two laps to go at the latest
  const wear = p.tire.wear;
  if (wear + rate * (after + 1) > FINISH_WEAR && wear + rate > PIT_WEAR) {
    if (busy && wear + rate < CLIFF_WEAR) return ev;
    return stop(pick(plan), 'wear');
  }
  // a lapped car may take the flag a lap early again (its own count shrinks): by half distance at the latest; the same
  // when the model has no plan at all
  const half = car.timing.lapsCompleted >= world.session.totalLaps / 2;
  if (ctx.mandatoryOpen && (after <= 2 || (half && (car.timing.lapsDown > 0 || !plan.best)))) {
    // this stop has to be the one on a compound not used yet
    const c = pick(plan);
    return stop(ctx.usedCompounds.includes(c) ? chooseDryCompound(car, track, after, exclude) : c, 'mandatory');
  }
  if (rainHold) return ev;

  // C3: under a (virtual) safety car the model again with the cheaper stop
  const factor = clamp(fin(ctx.lossFactor ?? 1, 1), 0, 1);
  if (factor < 1) {
    const worn = wear > NEUTRAL_MIN_WEAR;
    if (!plan.best) {
      // no plan (sets that wear too quickly even for MAX_STOPS): the earlier fixed rule
      return worn && after >= NEUTRAL_MIN_LAPS ? stop(chooseDryCompound(car, track, after, exclude), 'neutral') : ev;
    }
    // the lower bound: a stop the race needs anyway on a worn set or within NEUTRAL_SOON laps; an extra one on a worn
    // set with NEUTRAL_MIN_LAPS laps left — a fresh set is not thrown away on a wear rate that is still settling
    const needed = plan.best.stints.length > 0;
    const soon = needed && plan.best.stay <= NEUTRAL_SOON;
    if (!(worn && (needed || after >= NEUTRAL_MIN_LAPS)) && !soon) return ev;
    const cheap = planRace({ ...input, nowLoss: loss * factor + (busy ? QUEUE_LOSS : 0) });
    if (stopsNow(cheap)) return stop(pick(cheap), 'neutral');
    // stacked behind the team-mate it does not pay — unless the tyres are gone
    if (busy && wear > BAD_WEAR) {
      const alone = planRace({ ...input, nowLoss: loss * factor });
      if (stopsNow(alone)) return stop(pick(alone), 'neutral');
    }
    return ev;
  }

  // C2 overcut: staying out after the car ahead pitted
  if (ai.overcutLaps > 0) {
    ai.overcutLaps--;
    if (plan.byStay[1] !== undefined && plan.byStay[1] < Infinity && cleanAir(world, car)) {
      ev.overcut = true;
      return ev;
    }
    ai.overcutLaps = 0;
  }
  if (stopsNow(plan)) {
    const d = overcutLaps(world, car, track, plan, ev, base);
    if (d > 0) {
      ai.overcutLaps = d - 1;
      ai.overcuts++;
      ev.overcut = true;
      return ev;
    }
    return stop(pick(plan), 'plan');
  }
  if (!plan.now || !plan.best || plan.best.stints.length === 0) return ev;
  const extra = plan.now.cost - plan.best.cost;
  const next = plan.now.stints[0];
  const nextRate = input.rate * COMPOUND_PARAMS[next].wearRate;

  // C2 undercut: the car ahead within reach, on a set as old as ours, and it has to stop too
  const a = neighbour(world, car, -1);
  const gap = car.timing.interval;
  if (a && a.status === 'running' && a.pit.phase === 'none' && !a.pit.requested && gap >= UNDERCUT_GAP[0] && gap <= UNDERCUT_GAP[1]) {
    const t = a.phys.tire;
    if (isDry(t.compound) && wear >= t.wear - SIMILAR_WEAR && mustStop(world, a, track, ctx)) {
      const gain = freshGain(base, t.compound, t.wear, wearPerLap(a, track), next, nextRate);
      if (gain - extra > gap + UNDERCUT_MARGIN) return stop(next, 'undercut');
    }
  }
  // C2 cover: the car behind has just pitted and its fresh set would take the place (if it has not already: still
  // behind us now)
  const b = ai.behindId >= 0 ? world.cars[ai.behindId] : undefined;
  const stillBehind = b !== undefined && b.timing.position > car.timing.position && b.timing.lapsDown === car.timing.lapsDown;
  if (b && stillBehind && ai.behindGap <= COVER_GAP && stopsOf(b) > ai.behindStops && extra <= COVER_SLACK) {
    const theirs = newSet(b);
    if (isDry(theirs)) {
      const threat = freshGain(base, cur, ev.wearEnd, ev.rate, theirs, input.rate * COMPOUND_PARAMS[theirs].wearRate);
      if (threat > ai.behindGap) return stop(next, 'cover');
    }
  }
  return ev;
}

/** The fuel left is short of the measured burn (× `factor`) to the flag. */
function fuelShort(world: WorldState, car: CarEntry, track: BuiltTrack, after: number, factor: number): boolean {
  const ai = car.ai;
  if (!world.config.rules.fuel || !(ai.fuelPerLap > 0)) return false;
  const left = after + forwardDistance(track, car.phys.s, 0) / Math.max(1, track.length);
  return car.phys.fuelKg < ai.fuelPerLap * factor * left * (1 + FUEL_MARGIN);
}

/** Fuel burnt a lap, from the fuel at consecutive green-flag evaluations. */
function measureFuel(world: WorldState, car: CarEntry): void {
  const ai = car.ai;
  const lap = car.timing.lap;
  const green = world.session.control.mode === 'green';
  if (green && ai.fuelMarkLap >= 0 && lap > ai.fuelMarkLap) {
    const burn = (ai.fuelMark - car.phys.fuelKg) / (lap - ai.fuelMarkLap);
    if (burn > 0 && Number.isFinite(burn)) ai.fuelPerLap = ai.fuelPerLap > 0 ? 0.5 * (ai.fuelPerLap + burn) : burn;
  }
  ai.fuelMark = car.phys.fuelKg;
  ai.fuelMarkLap = green ? lap : -1;
}

/**
 * A3 pace mode for the coming lap: conserve when short of fuel or the set must stretch to its planned stop; push on the
 * in- and out-lap of an undercut / cover, while overcutting and in the last laps when the tyres and fuel allow;
 * otherwise standard (always under a neutralisation). The controller applies push only in clean air.
 */
function paceModeFor(world: WorldState, car: CarEntry, track: BuiltTrack, ev: Evaluation, after: number): AIPaceMode {
  if (world.session.control.mode !== 'green') return 'standard';
  if (fuelShort(world, car, track, after, 1)) return 'conserve';
  const reason = ev.call?.reason;
  if (reason === 'undercut' || reason === 'cover' || ev.overcut) return 'push';
  if (ev.call) return 'standard';
  const best = ev.plan?.best;
  if (best) {
    const limit = best.stints.length > 0 ? PIT_WEAR : FINISH_WEAR;
    if (ev.wearEnd + ev.rate * best.stay > limit - STRETCH_MARGIN) return 'conserve';
  }
  const w = world.weather.wetness;
  if (!isDry(car.phys.tire.compound) || w > PUSH_WET) return 'standard';
  const finalLaps = Math.min(PUSH_FINAL_LAPS, Math.max(1, Math.floor(world.session.totalLaps * PUSH_FINAL_SHARE)));
  if (after <= finalLaps && ev.wearEnd + ev.rate * PUSH_WEAR * after <= PIT_WEAR && !fuelShort(world, car, track, after, PUSH_FUEL)) {
    return 'push';
  }
  return 'standard';
}

/**
 * C5 team orders (AI cars only; a human is never asked to do anything): let the quicker team-mate right behind by —
 * it has been quicker by TEAM_PACE s a lap at TEAM_LAPS evaluations in a row and runs another strategy, or a car ahead of
 * us is within reach — and in the last laps two AI team-mates in the points hold position.
 */
function teamOrders(world: WorldState, car: CarEntry): void {
  const ai = car.ai;
  if (ai.noRaceLaps > 0) ai.noRaceLaps--;
  if (ai.noRaceLaps <= 0) ai.noRaceFor = -1;
  const mate = world.cars.find((o) => o !== car && o.teamId === car.teamId && o.status !== 'retired');
  if (!mate) {
    ai.teamFaster = 0;
    ai.holdFor = -1;
    return;
  }
  const t = car.timing;
  const m = mate.timing;
  const total = world.session.totalLaps;
  const racing = (o: CarEntry): boolean => o.status === 'running' && o.pit.phase === 'none';
  const sameLap = m.lapsDown === t.lapsDown;
  const gap = m.position === t.position + 1 ? m.interval : m.position === t.position - 1 ? t.interval : Infinity;
  // the order given at the evaluation before the last holdLaps laps
  const holdLaps = Math.min(HOLD_LAPS, Math.floor(total * HOLD_SHARE));
  const late = holdLaps > 0 && total - t.lapsCompleted - 1 <= holdLaps;
  const hold =
    mate.playerIndex === -1 && late && sameLap && racing(car) && racing(mate) && t.position <= POINTS_PLACES && m.position <= POINTS_PLACES && gap > 0 && gap < HOLD_GAP;

  const behind = m.position === t.position + 1 && sameLap && racing(car) && racing(mate) && m.interval > 0 && m.interval <= TEAM_GAP;
  if (behind) {
    const w = world.weather.wetness;
    let mine = estimatedPace(car, w);
    let theirs = estimatedPace(mate, w);
    if (mate.playerIndex !== -1) {
      // a human behind: quicker only on its measured clean laps and by what its car does on its tyres (a fast estimate
      // never makes a slow human look fast; no clean lap yet: no order) — against our best of estimate / clean laps
      const lap = mate.ai.cleanLap;
      theirs = lap > 0 ? Math.max(lap, theirs) : 0;
      if (ai.cleanLap > 0) mine = mine > 0 ? Math.min(mine, ai.cleanLap) : ai.cleanLap;
    }
    // the standing-start lap tells nothing about pace
    const counts = t.lapsCompleted >= TEAM_MIN_LAPS && m.lapsCompleted >= TEAM_MIN_LAPS;
    ai.teamFaster = counts && mine > 0 && theirs > 0 && mine - theirs > TEAM_PACE ? ai.teamFaster + 1 : 0;
    const ahead = neighbour(world, car, -1);
    const chasing = ahead !== null && t.interval > 0 && t.interval < TEAM_CHASE;
    const differs = mate.phys.tire.compound !== car.phys.tire.compound || mate.pit.stops !== car.pit.stops;
    if (ai.teamFaster >= TEAM_LAPS && ai.yieldFor < 0 && (chasing || (differs && !hold))) {
      ai.yieldFor = mate.id;
      ai.yieldTimer = YIELD_TIME;
      ai.teamFaster = 0;
      // once by, it is not raced straight back
      ai.noRaceFor = mate.id;
      ai.noRaceLaps = YIELD_HOLD;
    }
  } else {
    ai.teamFaster = 0;
  }
  ai.holdFor = hold && ai.yieldFor !== mate.id && mate.ai.yieldFor !== car.id ? mate.id : -1;
}

/** The cars around at this evaluation (for the next one: has the one ahead / behind pitted since?). */
function rememberRivals(world: WorldState, car: CarEntry): void {
  const ai = car.ai;
  const a = neighbour(world, car, -1);
  const b = neighbour(world, car, 1);
  ai.aheadId = a ? a.id : -1;
  ai.aheadStops = a ? stopsOf(a) : 0;
  ai.aheadGap = a ? fin(car.timing.interval, Infinity) : Infinity;
  ai.behindId = b ? b.id : -1;
  ai.behindStops = b ? stopsOf(b) : 0;
  ai.behindGap = b ? fin(b.timing.interval, Infinity) : Infinity;
}

/**
 * Decide whether an AI car boxes at the coming pit entry. Returns the compound to fit, or null.
 * Updates the weather debounce every call; the decision (with the pace mode and team orders) happens once per lap,
 * 120–700 m before the entry.
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
  // laps still to drive after this stop (the current lap ends in the pit lane), by the car's own count
  const after = race ? lapsAfter(world, car) : 99;
  const ev: Evaluation =
    after >= 1 ? evaluate(world, car, track, ctx, want, after, toEntry) : { call: null, plan: null, rate: 0, wearEnd: p.tire.wear, overcut: false };
  if (race) {
    measureFuel(world, car);
    ai.paceMode = paceModeFor(world, car, track, ev, Math.max(0, after));
    teamOrders(world, car);
    rememberRivals(world, car);
  }
  if (!ev.call) return null;
  ai.pitCall = ev.call.reason;
  return ev.call.compound;
}
