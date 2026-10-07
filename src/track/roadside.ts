/**
 * Roadside layout: kerbs, runoff widths and runoff surfaces per side, then automatic barrier clamping so no
 * barrier crosses the midline towards another part of the circuit (spatial grid) or folds inside a tight
 * corner, followed by a slope limit for smooth barrier lines. Where two sections are so close that the normal
 * clearance does not fit, the barrier sits midway between the two road edges and the kerbs shrink to fit.
 * Grade-separated pairs (crossings, see crossings.ts) are ignored; deck samples get close parapet walls.
 * Surface codes: 0 grass, 1 gravel, 2 asphalt runoff.
 */
import type { Biome } from '../core/types';
import type { CornerInfo } from './corners';
import { isCrossingPair } from './crossings';
import { PIT_OUTER_CLEARANCE } from './pit';
import { maxFilterClosed, slopeLimitClosed, wrapIndex } from './signal';
import { SampleGrid } from './spatial';

type SurfaceCode = 0 | 1 | 2;
const GRASS: SurfaceCode = 0;
const GRAVEL: SurfaceCode = 1;
const ASPHALT: SurfaceCode = 2;

interface RunoffStyle {
  /** straights (m from road edge to barrier) */
  base: number;
  /** inside of corners */
  inside: number;
  /** outside of slow / fast corners */
  outsideSlow: number;
  outsideFast: number;
  /** outside escape area at heavy-braking corners */
  braking: number;
  surface: SurfaceCode;
  fastSurface: SurfaceCode;
  brakingSurface: SurfaceCode;
}

const STREET_STYLE: RunoffStyle = {
  base: 2.5,
  inside: 2.5,
  outsideSlow: 3.5,
  outsideFast: 4,
  braking: 4,
  surface: ASPHALT,
  fastSurface: ASPHALT,
  brakingSurface: ASPHALT,
};

const BIOME_STYLE: Record<Biome, RunoffStyle> = {
  desert: { base: 14, inside: 12, outsideSlow: 17, outsideFast: 24, braking: 24, surface: ASPHALT, fastSurface: GRAVEL, brakingSurface: ASPHALT },
  temperate: { base: 13, inside: 11, outsideSlow: 15, outsideFast: 25, braking: 22, surface: GRASS, fastSurface: GRAVEL, brakingSurface: ASPHALT },
  autumn: { base: 11, inside: 10, outsideSlow: 14, outsideFast: 22, braking: 20, surface: GRASS, fastSurface: GRAVEL, brakingSurface: ASPHALT },
  coastal: { base: 11, inside: 10, outsideSlow: 13, outsideFast: 20, braking: 20, surface: GRASS, fastSurface: GRAVEL, brakingSurface: ASPHALT },
  tropical: { base: 13, inside: 11, outsideSlow: 15, outsideFast: 24, braking: 22, surface: GRASS, fastSurface: GRAVEL, brakingSurface: ASPHALT },
  city: { base: 11, inside: 10, outsideSlow: 13, outsideFast: 20, braking: 20, surface: GRASS, fastSurface: GRAVEL, brakingSurface: ASPHALT },
};

/** Apex speed (m/s) from which a corner's outside gets gravel (≈ 130 km/h). */
const FAST_CORNER_SPEED = 36;
/** Speed loss (m/s) that makes a braking zone "heavy" (asphalt runoff). */
const HEAVY_BRAKING_DROP = 30;
/** Each barrier stays at least this far from the midline between two road edges (m, total gap = 2×). */
const BARRIER_GAP = 2;
/** Barrier offset change per metre along the track. */
const BARRIER_SLOPE = 0.4;
/** Inside a corner the barrier stays within this fraction of the local radius (no folding offset curve). */
const FOLD_FRACTION = 0.85;
/** Minimum clearance (m) between kerb and barrier. */
const MIN_CLEAR = 0.8;
/** Walls closer than this to the road edge are only used when the space between two roads is smaller (m). */
const MIN_WALL = 1.5;
/** Smallest barrier distance (m) from the road edge when sections are too close for MIN_WALL (< 3 m gaps). */
const MIN_TIGHT_RUNOFF = 0.6;
/** Kerb stays at least this far (m) short of any barrier / other road edge in tight spots. */
const KERB_BARRIER_GAP = 0.55;
/** Runoff (m) on a deck: close concrete parapets. */
const DECK_RUNOFF = 2.5;

export interface RoadsideInput {
  count: number;
  spacing: number;
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  rx: Float64Array;
  rz: Float64Array;
  halfWidth: Float64Array;
  /** 1 on the upper road of a grade-separated crossing (parapet walls) */
  deck: Uint8Array;
  /** smoothed centre-line curvature (+ right) */
  smoothCurvature: Float64Array;
  /** track curvature (+ right, lightly smoothed): catches tight apexes the smoothed curvature underestimates */
  curvature: Float64Array;
  speed: Float64Array;
  corners: CornerInfo[];
  street: boolean;
  biome: Biome;
  pit: { side: 1 | -1; entryIdx: number; exitIdx: number; laneOffset: number; outerClearance?: number };
}

export interface Roadside {
  kerbLeft: Float64Array;
  kerbRight: Float64Array;
  runoffLeft: Float64Array;
  runoffRight: Float64Array;
  runoffSurfaceLeft: Uint8Array;
  runoffSurfaceRight: Uint8Array;
}

/** Visit sample indices from a to b inclusive, moving forward around the loop. */
function forEachForward(a: number, b: number, n: number, visit: (i: number) => void): void {
  const from = wrapIndex(a, n);
  const len = wrapIndex(b - a, n);
  for (let k = 0; k <= len; k++) visit((from + k) % n);
}

export function computeRoadside(inp: RoadsideInput): Roadside {
  const { count: n, spacing } = inp;
  const style = inp.street ? STREET_STYLE : BIOME_STYLE[inp.biome];
  const m = (meters: number): number => Math.round(meters / spacing);

  const kerb = { [-1]: new Float64Array(n), [1]: new Float64Array(n) } as Record<-1 | 1, Float64Array>;
  const want = { [-1]: new Float64Array(n).fill(style.base), [1]: new Float64Array(n).fill(style.base) } as Record<-1 | 1, Float64Array>;
  const surf = {
    [-1]: new Uint8Array(n).fill(style.surface),
    [1]: new Uint8Array(n).fill(style.surface),
  } as Record<-1 | 1, Uint8Array>;

  // ── corners: kerbs, inside / outside runoff, gravel traps, heavy-braking escape areas
  for (const c of inp.corners) {
    const dir = c.corner.direction;
    const inSide = dir;
    const outSide = (-dir) as -1 | 1;
    const kerbW = 1.2 + 0.4 * clamp01((c.peakCurvature - 1 / 400) / (1 / 25 - 1 / 400));
    forEachForward(c.startIdx - m(4), c.endIdx + m(4), n, (i) => {
      kerb[inSide][i] = Math.max(kerb[inSide][i], kerbW);
    });
    forEachForward(c.apexIdx, c.endIdx + m(18), n, (i) => {
      kerb[outSide][i] = Math.max(kerb[outSide][i], kerbW);
    });

    const fast = clamp01((c.corner.minSpeed - 18) / (65 - 18));
    forEachForward(c.startIdx, c.endIdx, n, (i) => {
      want[inSide][i] = Math.min(want[inSide][i], style.inside);
    });
    const outStart = c.apexIdx - Math.round(0.5 * wrapIndex(c.apexIdx - c.startIdx, n));
    const outWidth = style.outsideSlow + (style.outsideFast - style.outsideSlow) * fast;
    const outSurface = c.corner.minSpeed >= FAST_CORNER_SPEED ? style.fastSurface : style.surface;
    forEachForward(outStart, c.endIdx + m(30 + 40 * fast), n, (i) => {
      want[outSide][i] = Math.max(want[outSide][i], outWidth);
      if (outSurface !== style.surface) surf[outSide][i] = outSurface;
    });

    if (c.entrySpeed - c.corner.minSpeed >= HEAVY_BRAKING_DROP) {
      // braking starts where the speed profile last peaked before the apex
      let b = c.apexIdx;
      for (let k = 0; k < m(600); k++) {
        const prev = wrapIndex(b - 1, n);
        if (inp.speed[prev] + 1e-9 < inp.speed[b]) break;
        b = prev;
      }
      const brakeLen = wrapIndex(c.apexIdx - b, n);
      const zoneStart = b + Math.round(0.4 * brakeLen);
      forEachForward(zoneStart, c.apexIdx + m(15), n, (i) => {
        surf[-1][i] = style.brakingSurface;
        surf[1][i] = style.brakingSurface;
      });
      forEachForward(c.startIdx - m(60), c.apexIdx, n, (i) => {
        want[outSide][i] = Math.max(want[outSide][i], style.braking);
      });
    }
  }

  // ── pit zone: paved apron and wide runoff on the pit side, no kerbs there
  const pitSide = inp.pit.side;
  const pitReq = Math.abs(inp.pit.laneOffset) + (inp.pit.outerClearance ?? PIT_OUTER_CLEARANCE);
  const zoneLen = wrapIndex(inp.pit.exitIdx - inp.pit.entryIdx, n);
  forEachForward(inp.pit.entryIdx, inp.pit.exitIdx, n, (i) => {
    want[pitSide][i] = Math.max(want[pitSide][i], pitReq);
    surf[pitSide][i] = ASPHALT;
    kerb[pitSide][i] = 0;
  });
  const taper = Math.ceil(pitReq / (BARRIER_SLOPE * spacing)) + 1;
  for (let k = 1; k <= taper && 2 * k < n - zoneLen; k++) {
    const v = pitReq - BARRIER_SLOPE * spacing * k;
    const before = wrapIndex(inp.pit.entryIdx - k, n);
    const after = wrapIndex(inp.pit.exitIdx + k, n);
    want[pitSide][before] = Math.max(want[pitSide][before], v);
    want[pitSide][after] = Math.max(want[pitSide][after], v);
  }

  // ── deck: close parapets, plain asphalt apron
  for (let i = 0; i < n; i++) {
    if (!inp.deck[i]) continue;
    for (const side of [-1, 1] as const) {
      want[side][i] = Math.min(want[side][i], DECK_RUNOFF);
      surf[side][i] = ASPHALT;
    }
  }

  // ── barrier clamping
  const grid = new SampleGrid(inp.px, inp.pz, 20);
  const out = {
    [-1]: clampBarriers(inp, grid, -1, want[-1], kerb[-1]),
    [1]: clampBarriers(inp, grid, 1, want[1], kerb[1]),
  } as Record<-1 | 1, Float64Array>;
  for (const side of [-1, 1] as const) {
    slopeLimitClosed(out[side], BARRIER_SLOPE * spacing);
  }
  shrinkKerbs(inp, grid, out, kerb);

  return {
    kerbLeft: kerb[-1],
    kerbRight: kerb[1],
    runoffLeft: out[-1],
    runoffRight: out[1],
    runoffSurfaceLeft: surf[-1],
    runoffSurfaceRight: surf[1],
  };
}

/**
 * Largest runoff ≤ desired on `side` such that the barrier point stays closer (by BARRIER_GAP) to its own road
 * edge than to the road edge of any non-local track sample, and never folds inside a tight corner. When that
 * leaves less than max(kerb + MIN_CLEAR, MIN_WALL) (sections very close together, hairpins) the barrier moves to the midline
 * between the two road edges instead (shrinkKerbs then trims the kerbs to fit).
 */
function clampBarriers(
  inp: RoadsideInput,
  grid: SampleGrid,
  side: -1 | 1,
  desired: Float64Array,
  kerb: Float64Array,
): Float64Array {
  const { count: n, spacing, px, py, pz, rx, rz, halfWidth: hw } = inp;
  let maxHw = 0;
  for (let i = 0; i < n; i++) maxHw = Math.max(maxHw, hw[i]);

  // inside-of-corner curvature (positive when `side` is the inside), dilated so the fold check sees ahead; the
  // track curvature is included so a tight apex (e.g. a 25 m hairpin) keeps the wall short of its centre of
  // curvature (the drawn barrier follows the same limit, so physics and visuals agree)
  const insideK = new Float64Array(n);
  for (let i = 0; i < n; i++) insideK[i] = Math.max(0, side * inp.smoothCurvature[i], side * inp.curvature[i]);
  const foldK = maxFilterClosed(insideK, Math.round(40 / spacing));

  const L = n * spacing;
  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const want = hw[i] + desired[i];
    let limit = want;
    if (foldK[i] > 1e-9) limit = Math.min(limit, FOLD_FRACTION / foldK[i]);
    let midLimit = limit;
    const nx = side * rx[i];
    const nz = side * rz[i];
    const radius = 2 * want + BARRIER_GAP + maxHw;
    grid.forEachInRadius(px[i], pz[i], radius, (j, d2) => {
      const ds = Math.abs(i - j) * spacing;
      const loop = Math.min(ds, L - ds);
      const chord = Math.sqrt(d2);
      if (loop <= 1.3 * chord + 4) return;
      if (isCrossingPair(inp.deck, i, j, py[i] - py[j], chord, hw[i] + hw[j])) return;
      const vx = px[j] - px[i];
      const vz = pz[j] - pz[i];
      const a = vx * nx + vz * nz;
      const c = BARRIER_GAP - hw[i] + hw[j];
      if (a + c > 0) {
        const bound = (d2 - c * c) / (2 * (a + c));
        if (bound < limit) limit = bound;
      }
      // midline between the road edges (no gap)
      const c0 = hw[j] - hw[i];
      if (a + c0 > 0) {
        const bound = (d2 - c0 * c0) / (2 * (a + c0));
        if (bound < midLimit) midLimit = bound;
      }
    });
    const floor = Math.max(kerb[i] + MIN_CLEAR, MIN_WALL);
    result[i] =
      limit - hw[i] >= floor
        ? Math.min(desired[i], limit - hw[i])
        : Math.min(desired[i], Math.max(MIN_TIGHT_RUNOFF, midLimit - hw[i]));
  }
  return result;
}

/**
 * Trim kerbs so every kerb ends at least KERB_BARRIER_GAP short of its own barrier and of any barrier that sits
 * beside another (non-local, not grade-separated) part of the road. A no-op wherever the runoff is generous.
 */
function shrinkKerbs(inp: RoadsideInput, grid: SampleGrid, runoff: Record<-1 | 1, Float64Array>, kerb: Record<-1 | 1, Float64Array>): void {
  const { count: n, spacing, px, py, pz, rx, rz, halfWidth: hw } = inp;
  let maxHw = 0;
  for (let i = 0; i < n; i++) maxHw = Math.max(maxHw, hw[i]);
  const L = n * spacing;
  const cap = new Float64Array(n).fill(Infinity);
  for (const side of [-1, 1] as const) {
    const k = kerb[side];
    for (let i = 0; i < n; i++) {
      if (runoff[side][i] - KERB_BARRIER_GAP < k[i]) k[i] = Math.max(0, runoff[side][i] - KERB_BARRIER_GAP);
      const d = hw[i] + runoff[side][i];
      const bx = px[i] + side * d * rx[i];
      const bz = pz[i] + side * d * rz[i];
      grid.forEachInRadius(bx, bz, maxHw + 3, (j, d2) => {
        const ds = Math.abs(i - j) * spacing;
        const loop = Math.min(ds, L - ds);
        const chord = Math.hypot(px[i] - px[j], pz[i] - pz[j]);
        if (loop <= 1.3 * chord + 4) return;
        if (isCrossingPair(inp.deck, i, j, py[i] - py[j], chord, hw[i] + hw[j])) return;
        const room = Math.sqrt(d2) - hw[j] - KERB_BARRIER_GAP;
        if (room < cap[j]) cap[j] = room;
      });
    }
  }
  for (const side of [-1, 1] as const) {
    const k = kerb[side];
    for (let i = 0; i < n; i++) if (cap[i] < k[i]) k[i] = Math.max(0, cap[i]);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
