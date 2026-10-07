/**
 * Shared math + coordinate helpers. EVERY module must use these instead of re-deriving conventions.
 *
 * World: Three.js space, Y up, meters. Simulation runs on the XZ plane.
 *   yaw (rad): forward = (sin(yaw), cos(yaw)) on (x, z)
 *              right   = (-cos(yaw), sin(yaw)) on (x, z)
 *   Turning RIGHT makes yaw DECREASE (yawRate < 0).
 *   A mesh modelled facing +Z with mesh.rotation.y = yaw matches the simulation.
 *   In such a model's LOCAL space: +Z = nose/forward, +Y = up, -X = the car's RIGHT side, +X = its LEFT side.
 */

export const TAU = Math.PI * 2;
export const G = 9.81;
export const AIR_DENSITY = 1.225;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01(invLerp(e0, e1, x));
  return t * t * (3 - 2 * t);
};
export const moveToward = (current: number, target: number, maxDelta: number): number =>
  Math.abs(target - current) <= maxDelta ? target : current + Math.sign(target - current) * maxDelta;
/** Frame-rate independent exponential smoothing factor for rate `k` (1/s). */
export const damp = (current: number, target: number, k: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-k * dt));

/** Wrap angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a <= 0) a += TAU;
  return a - Math.PI;
}
/** Smallest signed difference b - a, in (-PI, PI]. */
export const angleDiff = (a: number, b: number): number => wrapAngle(b - a);

export const forwardX = (yaw: number): number => Math.sin(yaw);
export const forwardZ = (yaw: number): number => Math.cos(yaw);
export const rightX = (yaw: number): number => -Math.cos(yaw);
export const rightZ = (yaw: number): number => Math.sin(yaw);
/** yaw whose forward vector points along (dx, dz). */
export const yawFromDir = (dx: number, dz: number): number => Math.atan2(dx, dz);

/** Convert a car-local offset (right, forward) in meters to a world XZ offset. */
export function localToWorld(yaw: number, right: number, forward: number): { x: number; z: number } {
  return {
    x: rightX(yaw) * right + forwardX(yaw) * forward,
    z: rightZ(yaw) * right + forwardZ(yaw) * forward,
  };
}
/** Project a world XZ vector onto a car's local axes. */
export function worldToLocal(yaw: number, x: number, z: number): { right: number; forward: number } {
  return {
    right: x * rightX(yaw) + z * rightZ(yaw),
    forward: x * forwardX(yaw) + z * forwardZ(yaw),
  };
}

export const msToKmh = (v: number): number => v * 3.6;
export const msToMph = (v: number): number => v * 2.2369362921;
export const kmhToMs = (v: number): number => v / 3.6;

/** 83.456 -> "1:23.456"; null/NaN -> "--:--.---" */
export function formatLapTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--:--.---';
  const totalMs = Math.round(sec * 1000);
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
/** 1.2345 -> "+1.235", -0.4 -> "-0.400" */
export function formatGap(sec: number): string {
  if (!Number.isFinite(sec)) return '--';
  const sign = sec < 0 ? '-' : '+';
  return `${sign}${Math.abs(sec).toFixed(3)}`;
}

/**
 * Deterministic RNG (mulberry32) operating on plain data so it can live in WorldState.
 * Usage: const rng = { s: seed >>> 0 }; const r = nextRandom(rng); // [0,1)
 */
export interface RngState {
  s: number;
}
export function nextRandom(rng: RngState): number {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export const randRange = (rng: RngState, lo: number, hi: number): number => lo + (hi - lo) * nextRandom(rng);
