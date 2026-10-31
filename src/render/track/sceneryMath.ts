/**
 * Pure scenery math shared by the track-scene builders, the sky and the tests (no three.js, no DOM): integer
 * hashing, periodic / tileable value noise, the backdrop ring around the terrain rectangle (ray distance, land /
 * sea weighting, view-distance cap), terrain macro tints and the instanced-mesh chunk grid.
 */
import type { Biome } from '../../core/types';
import { clamp01, smoothstep, TAU } from '../../core/math';

/** Deterministic hash of two integers + seed -> [0, 1). */
export function hash3(i: number, j: number, seed: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Smooth 1D value noise in [0, 1], periodic with `period` lattice cells (integer). */
export function periodicNoise1D(x: number, period: number, seed: number): number {
  const p = Math.max(1, Math.round(period));
  const i = Math.floor(x);
  const a = hash3(mod(i, p), 0, seed);
  const b = hash3(mod(i + 1, p), 0, seed);
  return a + (b - a) * fade(x - i);
}

/**
 * Fractal noise around a circle: `theta` in radians, `basePeriod` lattice cells per full turn (coarsest octave),
 * each further octave doubles the frequency at half the amplitude. Result in [0, 1], continuous across 2π.
 */
export function ringFbm(theta: number, basePeriod: number, octaves: number, seed: number): number {
  const x = theta / TAU;
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let period = Math.max(1, Math.round(basePeriod));
  for (let o = 0; o < Math.max(1, octaves); o++) {
    sum += amp * periodicNoise1D(x * period, period, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

/** Ridged transform of a [0, 1] noise value: sharp crests where the noise crosses 0.5. */
export function ridged(n: number): number {
  return 1 - Math.abs(2 * n - 1);
}

/** Smooth 2D value noise in [0, 1] (unbounded, not periodic). */
export function valueNoise2D(x: number, z: number, seed: number): number {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const u = fade(x - i);
  const v = fade(z - j);
  const a = hash3(i, j, seed);
  const b = hash3(i + 1, j, seed);
  const c = hash3(i, j + 1, seed);
  const d = hash3(i + 1, j + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** 2D fractal value noise in [0, 1]. */
export function fbm2D(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < Math.max(1, octaves); o++) {
    sum += amp * valueNoise2D(x * f, z * f, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Smooth 2D value noise in [0, 1], periodic with `period` lattice cells on both axes. */
export function tileableNoise2D(x: number, y: number, period: number, seed: number): number {
  const p = Math.max(1, Math.round(period));
  const i = Math.floor(x);
  const j = Math.floor(y);
  const u = fade(x - i);
  const v = fade(y - j);
  const i0 = mod(i, p);
  const j0 = mod(j, p);
  const i1 = mod(i + 1, p);
  const j1 = mod(j + 1, p);
  const a = hash3(i0, j0, seed);
  const b = hash3(i1, j0, seed);
  const c = hash3(i0, j1, seed);
  const d = hash3(i1, j1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/**
 * Seamlessly tileable fractal noise image (row-major, size × size) normalised to the full [0, 1] range.
 * `basePeriod` lattice cells across the image for the coarsest octave; `gain` = amplitude ratio per octave.
 */
export function tileableFbm(size: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): Float32Array {
  const n = Math.max(1, Math.floor(size));
  const out = new Float32Array(n * n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      let amp = 1;
      let period = Math.max(1, Math.round(basePeriod));
      for (let o = 0; o < Math.max(1, octaves); o++) {
        sum += amp * tileableNoise2D((x / n) * period, (y / n) * period, period, seed + o * 977);
        amp *= gain;
        period *= 2;
      }
      out[y * n + x] = sum;
      if (sum < lo) lo = sum;
      if (sum > hi) hi = sum;
    }
  }
  const span = hi - lo > 1e-9 ? hi - lo : 1;
  for (let k = 0; k < out.length; k++) out[k] = (out[k] - lo) / span;
  return out;
}

/** Distance from the centre of an axis-aligned rectangle (half extents hx, hz) to its edge along (dx, dz). */
export function rectRayDistance(dx: number, dz: number, hx: number, hz: number): number {
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return Math.min(hx, hz);
  const ux = Math.abs(dx / len);
  const uz = Math.abs(dz / len);
  const tx = ux > 1e-9 ? hx / ux : Infinity;
  const tz = uz > 1e-9 ? hz / uz : Infinity;
  return Math.min(tx, tz);
}

/** Directions whose cosine with the sea direction is below `from` are land (1), above `to` sea (0). */
export const LAND_SEA_BLEND: readonly [number, number] = [-0.3, 0.15];
/** Land weight at which the inland edge / shelf reaches its full height (it sinks into the sea below that). */
export const LAND_EDGE_FULL = 0.6;

/** 1 = land side, 0 = sea side, smooth in between (water biomes; (seaX, seaZ) is a unit vector). */
export function landWeight(dx: number, dz: number, seaX: number, seaZ: number): number {
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return 1;
  const c = (dx * seaX + dz * seaZ) / len;
  return 1 - smoothstep(LAND_SEA_BLEND[0], LAND_SEA_BLEND[1], c);
}

/** Height blend (0 = sea floor, 1 = inland shelf) of the terrain edge and backdrop shelf for a land weight. */
export function landEdgeBlend(w: number): number {
  return smoothstep(0, LAND_EDGE_FULL, w);
}

/** Distance (m) from a point to an axis-aligned rectangle (centre cx, cz; half extents hx, hz); 0 inside. */
export function rectDistance(x: number, z: number, cx: number, cz: number, hx: number, hz: number): number {
  const dx = Math.max(Math.abs(x - cx) - hx, 0);
  const dz = Math.max(Math.abs(z - cz) - hz, 0);
  return Math.hypot(dx, dz);
}

/**
 * Largest backdrop radius (from the scenery centre) that stays inside the camera far plane for any camera within
 * `reach` metres of the centre: viewFar − reach, never below `minRadius`.
 */
export function backdropMaxRadius(reach: number, viewFar: number, minRadius = 0): number {
  return Math.max(minRadius, viewFar - Math.max(0, reach));
}

/** Ground albedo saturation per biome (terrain and verge turf: painted greens muted toward real grass seen from a distance). */
export const GROUND_SATURATION: Record<Biome, number> = { temperate: 0.76, autumn: 0.88, desert: 1, coastal: 0.84, city: 0.95, tropical: 0.74 };
/** Ground albedo brightness per biome (same surfaces): real turf is darker than the painted greens. */
export const GROUND_VALUE: Record<Biome, number> = { temperate: 0.82, autumn: 0.9, desert: 1, coastal: 0.88, city: 1, tropical: 0.85 };

/**
 * Low-frequency terrain colour multiplier per biome from two noise values in [0, 1] (n1 broad patches, n2 finer
 * mottling). Returned linear RGB factors stay within 0.7..1.2 so the ground texture keeps its character.
 */
export function groundTint(biome: Biome, n1: number, n2: number): [number, number, number] {
  const a = clamp01(n1);
  const b = clamp01(n2);
  const patch = smoothstep(0.35, 0.75, a);
  const mottle = (b - 0.5) * 0.16;
  let r = 1;
  let g = 1;
  let bl = 1;
  switch (biome) {
    case 'desert':
      // pale wind-swept sand <-> darker damp / stony patches
      r = 1.06 - 0.16 * patch;
      g = 1.04 - 0.17 * patch;
      bl = 1.0 - 0.18 * patch;
      break;
    case 'autumn':
      // olive grass <-> fallen-leaf rust patches
      r = 0.94 + 0.2 * patch;
      g = 1.0 - 0.06 * patch;
      bl = 0.98 - 0.16 * patch;
      break;
    case 'city':
      r = 0.96 + 0.1 * patch;
      g = 0.96 + 0.08 * patch;
      bl = 0.98 + 0.06 * patch;
      break;
    case 'coastal':
      // lush green <-> sun-dried yellow
      r = 0.92 + 0.22 * patch;
      g = 1.02 + 0.04 * patch;
      bl = 0.96 - 0.12 * patch;
      break;
    case 'tropical':
      // saturated rainforest green <-> red-brown laterite patches
      r = 0.9 + 0.3 * patch;
      g = 1.02 - 0.12 * patch;
      bl = 0.92 - 0.12 * patch;
      break;
    default:
      // lush dark green <-> lighter dry meadow
      r = 0.88 + 0.24 * patch;
      g = 0.96 + 0.12 * patch;
      bl = 0.9 - 0.04 * patch;
  }
  const k = 1 + mottle;
  const c = (v: number): number => Math.min(1.2, Math.max(0.7, v * k));
  return [c(r), c(g), c(bl)];
}

/** Square grid cell index of a point for spatially chunked instanced meshes (cellSize ≤ 0 = one chunk). */
export function chunkKey(x: number, z: number, originX: number, originZ: number, cellSize: number): number {
  if (!(cellSize > 0)) return 0;
  const cx = Math.max(0, Math.floor((x - originX) / cellSize));
  const cz = Math.max(0, Math.floor((z - originZ) / cellSize));
  return cz * 4096 + cx;
}
