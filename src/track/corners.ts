/**
 * Corner detection: runs of significant, same-signed (smoothed) centre-line curvature with enough total
 * heading change; apex at the speed-profile minimum (or peak curvature for flat-out bends).
 */
import type { TrackCorner } from '../core/types';
import { smoothClosed, wrapIndex } from './signal';

/** |curvature| (1/m) above which the centre line counts as cornering (R ≤ 400 m). */
const CORNER_CURVATURE = 1 / 400;
/** minimum heading change for a corner to be numbered (rad, ≈ 25°) */
const MIN_HEADING_CHANGE = 0.44;
/** same-direction runs closer than this are one corner (m) */
const MERGE_GAP = 20;

export interface CornerInfo {
  corner: TrackCorner;
  startIdx: number;
  apexIdx: number;
  endIdx: number;
  /** peak |smoothed curvature| (1/m) */
  peakCurvature: number;
  /** highest reference speed within 400 m before the corner (m/s) */
  entrySpeed: number;
}

interface Run {
  /** scan-order positions (k), end inclusive */
  k0: number;
  k1: number;
  sign: 1 | -1;
}

export function smoothedCurvature(curvature: Float64Array, spacing: number): Float64Array {
  return smoothClosed(curvature, Math.max(1, Math.round(6 / spacing)), 2);
}

export function detectCorners(curvature: Float64Array, speed: Float64Array, spacing: number): CornerInfo[] {
  const n = curvature.length;
  if (n === 0) return [];
  const ks = smoothedCurvature(curvature, spacing);
  let origin = 0;
  for (let k = 0; k < n; k++) {
    if (Math.abs(ks[k]) < CORNER_CURVATURE) {
      origin = k;
      break;
    }
  }

  const runs: Run[] = [];
  let open: Run | null = null;
  for (let k = 0; k < n; k++) {
    const v = ks[(origin + k) % n];
    const sign: 1 | -1 = v >= 0 ? 1 : -1;
    if (Math.abs(v) >= CORNER_CURVATURE) {
      if (open && open.sign === sign && open.k1 === k - 1) open.k1 = k;
      else {
        if (open) runs.push(open);
        open = { k0: k, k1: k, sign };
      }
    } else if (open) {
      runs.push(open);
      open = null;
    }
  }
  if (open) runs.push(open);

  const gap = Math.max(1, Math.round(MERGE_GAP / spacing));
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.sign === r.sign && r.k0 - last.k1 <= gap) last.k1 = r.k1;
    else merged.push({ ...r });
  }

  const out: CornerInfo[] = [];
  const lookBack = Math.round(400 / spacing);
  for (const r of merged) {
    let heading = 0;
    let peak = 0;
    let peakK = r.k0;
    let minV = Infinity;
    let maxV = -Infinity;
    let minK = r.k0;
    for (let k = r.k0; k <= r.k1; k++) {
      const i = (origin + k) % n;
      heading += ks[i] * spacing;
      if (Math.abs(ks[i]) > peak) {
        peak = Math.abs(ks[i]);
        peakK = k;
      }
      if (speed[i] < minV) {
        minV = speed[i];
        minK = k;
      }
      if (speed[i] > maxV) maxV = speed[i];
    }
    if (Math.abs(heading) < MIN_HEADING_CHANGE) continue;
    // a genuine speed valley inside the run marks the apex; flat-out or monotonic runs use peak curvature
    const valley = maxV - minV >= 0.5 && minK > r.k0 && minK < r.k1;
    const apexK = valley ? minK : peakK;
    const startIdx = (origin + r.k0) % n;
    const endIdx = (origin + r.k1) % n;
    const apexIdx = (origin + apexK) % n;
    let entrySpeed = speed[startIdx];
    for (let b = 0; b <= lookBack; b++) entrySpeed = Math.max(entrySpeed, speed[wrapIndex(startIdx - b, n)]);
    out.push({
      corner: {
        number: 0,
        startS: startIdx * spacing,
        apexS: apexIdx * spacing,
        endS: endIdx * spacing,
        direction: r.sign,
        minSpeed: speed[apexIdx],
      },
      startIdx,
      apexIdx,
      endIdx,
      peakCurvature: peak,
      entrySpeed,
    });
  }
  out.sort((a, b) => a.corner.startS - b.corner.startS);
  out.forEach((c, i) => {
    c.corner.number = i + 1;
  });
  return out;
}
