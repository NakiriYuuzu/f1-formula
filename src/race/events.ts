/**
 * Small shared helpers for the race runtime: event emission, safe numbers, car-state predicates,
 * projection write-back and the crossing-time interpolation used by timing.
 */
import type { CarEntry, GameEvent, TrackProjection, WorldState } from '../core/types';

/** Cap on undrained events kept in the world (protects memory if a consumer never drains). */
const MAX_PENDING_EVENTS = 20_000;

export function emit(world: WorldState, event: GameEvent): void {
  if (world.events.length >= MAX_PENDING_EVENTS) world.events.splice(0, world.events.length - MAX_PENDING_EVENTS + 1);
  world.events.push(event);
}

export const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

export const isHuman = (car: CarEntry): boolean => car.playerIndex >= 0;

/** Practice / qualifying: an AI car that has finished its run is back in the garage (parked, not drawn). */
export const inGarage = (world: WorldState, car: CarEntry): boolean =>
  world.config.kind !== 'race' && car.playerIndex === -1 && car.status === 'finished';

/** Car is still racing (may still cross lines / finish). */
export const isRacing = (car: CarEntry): boolean =>
  car.status === 'running' || car.status === 'pitting' || car.status === 'grid';

/** Write the runtime-owned projection fields into the physics state. */
export function applyProjection(car: CarEntry, proj: TrackProjection): void {
  const p = car.phys;
  p.s = proj.s;
  p.lateral = proj.lateral;
  p.trackIndex = proj.index;
  p.surface = proj.surface;
  p.y = proj.height;
}

/** Time at which a linearly moving quantity crossed `boundary` within the step [t0, t0 + dt]. */
export function crossingTime(t0: number, dt: number, from: number, to: number, boundary: number): number {
  const span = to - from;
  const f = Math.abs(span) > 1e-9 ? (boundary - from) / span : 1;
  return t0 + dt * Math.min(1, Math.max(0, f));
}

/** Positive modulo. */
export function mod(a: number, n: number): number {
  const r = a % n;
  return r < 0 ? r + n : r;
}
