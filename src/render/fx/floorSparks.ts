/**
 * Floor (skid-block) spark rules, pure (no three.js): where the track has bumps (a fixed hashed world grid, so
 * every car sparks at the same spots), when a car bottoms out (very high speed over a kerb or a bump), how strong
 * the effect is per time of day (off in daylight), and a global burst budget (token bucket) that rate-limits
 * the whole field.
 */
import type { SurfaceKind, TimeOfDay } from '../../core/types';

export const FLOOR_SPARK = {
  /** speed (m/s) where floor sparks start (≈ 209 km/h) / reach full intensity (≈ 302 km/h) */
  minSpeed: 58,
  fullSpeed: 84,
  /** bump grid cell edge (m) and the fraction of cells that hold a bump */
  bumpCell: 7,
  bumpDensity: 0.06,
  /** minimum time between two bursts of one car (s) */
  carCooldown: 0.12,
  /** global budget: bursts refilled per second, and the largest bank of stored bursts */
  burstsPerSec: 14,
  burstBank: 4,
  /** sparks per burst at full intensity on a ≥ 192-spark pool (fewer on smaller pools, at dusk and in the wet) */
  perBurst: 9,
  /** cars farther than this from every camera emit none (m) */
  maxCameraDist: 150,
  /** spark life (s) and point size (m) ranges */
  life: [0.1, 0.28],
  size: [0.05, 0.11],
} as const;

/** Effect strength per time of day: off in daylight, bright at dusk / night. */
export const FLOOR_SPARK_LIGHT: Record<TimeOfDay, number> = { day: 0, dusk: 0.75, night: 1 };

/** HDR (> 1) linear colours: additive sparks clip to white-hot on screen and feed a bloom pass when present. */
export const FLOOR_SPARK_HOT: readonly [number, number, number] = [3.2, 2.3, 1.2];
export const FLOOR_SPARK_WARM: readonly [number, number, number] = [2.4, 0.95, 0.28];

/** Deterministic hash of an integer grid cell to [0, 1). */
export function bumpCellHash(cx: number, cz: number): number {
  let h = Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cz | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Grid cell index of a world coordinate. */
export function bumpCellOf(v: number): number {
  return Number.isFinite(v) ? Math.floor(v / FLOOR_SPARK.bumpCell) : 0;
}

export function isBumpCell(cx: number, cz: number): boolean {
  return bumpCellHash(cx, cz) < FLOOR_SPARK.bumpDensity;
}

/** 0..1 bottoming intensity from speed (smoothstep between minSpeed and fullSpeed). */
export function floorSparkIntensity(speed: number): number {
  if (!Number.isFinite(speed) || speed <= FLOOR_SPARK.minSpeed) return 0;
  const t = Math.min(1, (speed - FLOOR_SPARK.minSpeed) / (FLOOR_SPARK.fullSpeed - FLOOR_SPARK.minSpeed));
  return t * t * (3 - 2 * t);
}

/**
 * Does the floor strike the ground this frame? Kerbs always do at speed; on sealed surfaces only when the car
 * has just entered a bump cell. Grass / gravel (soft) and the speed-limited pit lane never do.
 */
export function floorStrikes(surface: SurfaceKind, speed: number, enteredCell: boolean, cx: number, cz: number): boolean {
  if (floorSparkIntensity(speed) <= 0) return false;
  if (surface === 'kerb') return true;
  if (surface !== 'asphalt' && surface !== 'runoff') return false;
  return enteredCell && isBumpCell(cx, cz);
}

export interface BurstBudget {
  tokens: number;
}

/** Refill the global burst budget for `dt` seconds (capped at FLOOR_SPARK.burstBank). */
export function refillBurstBudget(b: BurstBudget, dt: number): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  b.tokens = Math.min(FLOOR_SPARK.burstBank, b.tokens + FLOOR_SPARK.burstsPerSec * step);
}

/** Spend one burst if the budget allows it. */
export function takeBurst(b: BurstBudget): boolean {
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
