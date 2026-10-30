/**
 * HUD mirror (docs/plans/phase3-online.md §2): the part of the host's WorldState a client's HUD, tower, minimap,
 * results and audio read — session, weather, race order / best sectors and per car timing, pit, penalties, status,
 * flags, control mode and a physics subset — as plain JSON, sent as patches (only the leaves that changed since the
 * previous one; arrays replace whole) on the reliable channel, and applied onto the client's mirror world.
 * Each receiver gets its own view (mirrorView's `ownCarId`) holding only what it reads, so a patch carries few of the
 * values that change every step: its own car's physics comes whole with each snapshot (the own-state datagram), the
 * other cars' motion with every snapshot (ClientSession.syncOthers, which also works out their race distance from the
 * mirrored laps), and their live lap time is read for no car but its own (which it moves on between patches).
 */
import type { CarEntry, CarPhysicsState, WorldState } from '../core/types';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Physics fields of the other cars (speed, gear, rpm, pedals, s, lateral come with every snapshot instead). */
const PHYS_KEYS = ['fuelKg', 'limiter', 'surface', 'tire', 'ers', 'drs', 'damage'] as const;
/** Timing sent for the receiver's own car only (its HUD lap timer; the others' race distance it works out itself). */
const OWN_TIMING_KEYS = ['currentLapTime', 'progress'] as const;

const round = (v: number, k: number): number => Math.round(v * k) / k;

/** Plain-JSON copy (non-finite numbers → 0), numbers rounded to keep patches small. */
function plain(v: unknown, digits = 1000): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? round(v, digits) : 0;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => plain(x, digits));
  if (typeof v === 'object') {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === 'function') continue;
      out[k] = plain(x, digits);
    }
    return out;
  }
  return null;
}

/**
 * Another car's physics subset. Continuous values the guest shows for no car but its own come in coarse steps (fuel
 * 0.1 kg, tyre temperature 1 °C, battery 10 %), so they change now and then instead of in every patch; the per-lap ERS
 * energy counters (that car's own physics' business) not at all.
 */
function otherPhys(p: CarPhysicsState): { [k: string]: Json } {
  const phys: { [k: string]: Json } = {};
  for (const k of PHYS_KEYS) phys[k] = plain(p[k]);
  phys.fuelKg = plain(p.fuelKg, 10);
  (phys.tire as { [k: string]: Json }).temp = plain(p.tire.temp, 1);
  const ers = phys.ers as { [k: string]: Json };
  ers.charge = plain(p.ers.charge, 10);
  delete ers.deployedLap;
  delete ers.harvestedLap;
  return phys;
}

function carView(c: CarEntry, own: boolean): { [k: string]: Json } {
  const timing = plain(c.timing) as { [k: string]: Json };
  if (!own) {
    for (const k of OWN_TIMING_KEYS) delete timing[k];
    // (read on no guest: whole m/s, not a change for every patch of each car still speeding up)
    timing.topSpeed = plain(c.timing.topSpeed, 1);
  }
  return {
    playerIndex: c.playerIndex,
    displayName: c.displayName,
    status: c.status,
    timing,
    pit: plain(c.pit),
    penalties: plain(c.penalties),
    flags: plain(c.flags),
    // (the receiver's own car: its physics is the own-state datagram's)
    ...(own ? {} : { phys: otherPhys(c.phys) }),
    assists: plain(c.assists),
    // timing tower / pit HUD read these race internals; the client's prediction checks who drives (pit / formation)
    race: plain({
      usedCompounds: c.race.usedCompounds,
      pitManual: c.race.pitManual,
      pitAuto: c.race.pitAuto,
      pitSpeeding: c.race.pitSpeeding,
      parking: c.race.parking,
      formationAuto: c.race.formationAuto,
      retiredAt: c.race.retiredAt,
    }),
  };
}

/** The mirrored part of a world as the receiver driving car `ownCarId` reads it (-1: none, every car another's). */
export function mirrorView(world: WorldState, ownCarId = -1): { [k: string]: Json } {
  return {
    time: round(world.time, 1000),
    tick: world.tick,
    session: plain(world.session),
    weather: plain(world.weather),
    flashbacksUsed: world.flashbacksUsed,
    race: plain({ order: world.race.order, bestSectors: world.race.bestSectors, benchLap: world.race.benchLap }),
    cars: world.cars.map((c) => carView(c, c.id === ownCarId)),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function same(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i] as Json));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => k in b && same(a[k] as Json, b[k] as Json));
  }
  return false;
}

/**
 * Patch turning `prev` into `next` (null prev: the whole of next). Objects recurse; arrays and leaves replace.
 * Returns null when nothing changed. Arrays of objects of equal length (cars) recurse by index as `{ "#i": … }`.
 */
export function diffMirror(prev: Json | undefined, next: Json): Json | undefined {
  if (prev === undefined) return next;
  if (isObj(prev) && isObj(next)) {
    const out: { [k: string]: Json } = {};
    let any = false;
    for (const k of Object.keys(next)) {
      const d = diffMirror(prev[k] as Json | undefined, next[k] as Json);
      if (d !== undefined) {
        out[k] = d;
        any = true;
      }
    }
    return any ? out : undefined;
  }
  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && next.every(isObj)) {
    const out: { [k: string]: Json } = {};
    let any = false;
    next.forEach((x, i) => {
      const d = diffMirror(prev[i] as Json, x);
      if (d !== undefined) {
        out[`#${i}`] = d;
        any = true;
      }
    });
    return any ? { '#arr': true, ...out } : undefined;
  }
  return same(prev, next) ? undefined : next;
}

/** Apply a diffMirror patch onto plain state (returns the new value; objects are updated in place). */
export function applyMirrorPatch(target: unknown, patch: unknown): unknown {
  if (isObj(patch) && patch['#arr'] === true && Array.isArray(target)) {
    for (const [k, v] of Object.entries(patch)) {
      if (!k.startsWith('#') || k === '#arr') continue;
      const i = Number(k.slice(1));
      if (Number.isInteger(i) && i >= 0 && i < target.length) target[i] = applyMirrorPatch(target[i], v);
    }
    return target;
  }
  if (isObj(patch) && isObj(target)) {
    for (const [k, v] of Object.entries(patch)) target[k] = applyMirrorPatch(target[k], v);
    return target;
  }
  return clone(patch);
}

function clone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out;
  }
  return v;
}

/**
 * Copy an applied mirror state into a client's mirror world (the world's own objects are updated in place, so the
 * HUD keeps its references). Unknown car indices are ignored.
 */
export function applyMirrorToWorld(world: WorldState, state: Record<string, unknown>, skipPhysFor = -1): void {
  if (typeof state.time === 'number') world.time = state.time;
  if (typeof state.tick === 'number') world.tick = state.tick;
  if (isObj(state.session)) assignDeep(world.session as unknown as Record<string, unknown>, state.session);
  if (isObj(state.weather)) assignDeep(world.weather as unknown as Record<string, unknown>, state.weather);
  if (typeof state.flashbacksUsed === 'number') world.flashbacksUsed = state.flashbacksUsed;
  if (isObj(state.race)) {
    const r = state.race;
    if (Array.isArray(r.order)) world.race.order = r.order.filter((x): x is number => typeof x === 'number');
    if (Array.isArray(r.bestSectors)) world.race.bestSectors = r.bestSectors as (number | null)[];
    if (typeof r.benchLap === 'number' || r.benchLap === null) world.race.benchLap = r.benchLap as number | null;
  }
  if (!Array.isArray(state.cars)) return;
  state.cars.forEach((cv, i) => {
    const car = world.cars[i];
    if (!car || !isObj(cv)) return;
    if (cv.playerIndex === -1 || cv.playerIndex === 0 || cv.playerIndex === 1 || cv.playerIndex === 2 || cv.playerIndex === 3) car.playerIndex = cv.playerIndex;
    if (typeof cv.displayName === 'string') car.displayName = cv.displayName;
    if (typeof cv.status === 'string') car.status = cv.status as CarEntry['status'];
    for (const k of ['timing', 'pit', 'penalties', 'flags', 'assists'] as const) {
      if (isObj(cv[k])) assignDeep(car[k] as unknown as Record<string, unknown>, cv[k] as Record<string, unknown>);
    }
    if (isObj(cv.race)) assignDeep(car.race as unknown as Record<string, unknown>, cv.race);
    if (i !== skipPhysFor && isObj(cv.phys)) assignDeep(car.phys as unknown as Record<string, unknown>, cv.phys);
  });
}

/** Copy `src` into `target` (nested objects in place, the rest cloned). */
export function assignDeep(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const cur = target[k];
    if (isObj(v) && isObj(cur)) assignDeep(cur, v);
    else target[k] = clone(v);
  }
}
