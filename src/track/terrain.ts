/**
 * Terrain height field around a built track: a smooth inverse-distance blend of nearby centre-line
 * elevations (≈ exact on the road) that fades to the circuit's average elevation ~100–160 m away.
 * Deck samples (the upper road of a grade-separated crossing) are left out, so the terrain follows the lower road
 * under a bridge; the upper road's approaches blend normally.
 */
import type { BuiltTrack } from '../core/types';
import { SampleGrid } from './spatial';

/** Samples farther than this (m) do not influence the height. */
const INFLUENCE_RADIUS = 160;
/** Distance (m) at which the average-height term carries the weight of a single nearby sample. */
const AVERAGE_RADIUS = 105;
/** Softening (m²) of the inverse-distance kernel so weights stay finite on the centre line. */
const SOFTEN = 4;
/** Target spacing (m) of samples used for blending. */
const BLEND_SPACING = 4;

interface TerrainIndex {
  grid: SampleGrid;
  average: number;
}

const terrainCache = new WeakMap<BuiltTrack, TerrainIndex>();

function terrainIndex(track: BuiltTrack): TerrainIndex {
  let idx = terrainCache.get(track);
  if (!idx) {
    let sum = 0;
    for (let i = 0; i < track.count; i++) sum += track.py[i];
    const stride = Math.max(1, Math.round(BLEND_SPACING / track.spacing));
    idx = {
      grid: new SampleGrid(track.px, track.pz, 32, stride, track.deck),
      average: track.count > 0 ? sum / track.count : 0,
    };
    terrainCache.set(track, idx);
  }
  return idx;
}

/** Terrain height for any world XZ (smoothly blended from nearby centre-line elevation; far away → average). */
export function heightAt(track: BuiltTrack, x: number, z: number): number {
  const idx = terrainIndex(track);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return idx.average;
  const r2max = INFLUENCE_RADIUS * INFLUENCE_RADIUS;
  const w0Base = AVERAGE_RADIUS * AVERAGE_RADIUS + SOFTEN;
  const w0 = 1 / (w0Base * w0Base);
  let wSum = w0;
  let hSum = w0 * idx.average;
  idx.grid.forEachInRadius(x, z, INFLUENCE_RADIUS, (i, d2) => {
    const fall = 1 - d2 / r2max;
    const base = d2 + SOFTEN;
    const w = (fall * fall) / (base * base);
    wSum += w;
    hSum += w * track.py[i];
  });
  return hSum / wSum;
}
