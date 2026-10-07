/**
 * Track-space queries: world ↔ (s, lateral) mapping, surfaces, wall distances and barrier limits.
 *
 * Between samples i and i+1 the track is the ruled surface P(f) + lat · R̂(f), where P and R are linearly
 * interpolated and R̂ is normalised. poseAt evaluates it; projectToTrack inverts it exactly (closed-form
 * quadratic per segment), so round trips are exact up to floating point and s / lateral are continuous.
 */
import type { BuiltTrack, SurfaceKind, TrackProjection } from '../core/types';
import { yawFromDir } from '../core/math';
import { GRADE_CLEARANCE } from './crossings';
import { segmentAt, wrapS } from './loop';
import { PIT_LANE_HALF_WIDTH, isInPitStraight, isInPitZone, pitLaneOffsetAt, pitLaneWallDistance } from './pit';
import { wrapIndex } from './signal';
import { SampleGrid } from './spatial';

/** Half size of the hinted local search window (samples). */
const HINT_WINDOW = 40;
const PROJECTION_CELL = 16;
/** Hinted results farther than this beyond the local barrier (m) are treated as a stale hint. */
const STALE_HINT_MARGIN = 25;

const gridCache = new WeakMap<BuiltTrack, SampleGrid>();
const deckCache = new WeakMap<BuiltTrack, boolean>();

function projectionGrid(track: BuiltTrack): SampleGrid {
  let grid = gridCache.get(track);
  if (!grid) {
    grid = new SampleGrid(track.px, track.pz, PROJECTION_CELL);
    gridCache.set(track, grid);
  }
  return grid;
}

/** True if the track has any grade-separated crossing (deck samples), cached. */
function hasCrossing(track: BuiltTrack): boolean {
  let has = deckCache.get(track);
  if (has === undefined) {
    has = false;
    for (let i = 0; i < track.count && !has; i++) has = track.deck[i] !== 0;
    deckCache.set(track, has);
  }
  return has;
}

/**
 * Global (no usable hint) nearest-sample search. On a track with a crossing the point may lie on two roads at
 * once (one above the other); among the samples whose road covers the point the level is chosen by `y` (the
 * road whose elevation is within GRADE_CLEARANCE / 2 of it) or, without `y`, the LOWER road. The nearest sample
 * of that level wins. Elsewhere this is the plain nearest sample.
 */
function globalNearest(track: BuiltTrack, x: number, z: number, y: number | undefined): number {
  const grid = projectionGrid(track);
  const nearest = grid.nearest(x, z);
  if (nearest < 0 || !hasCrossing(track)) return nearest;
  const cover: number[] = [];
  let lowest = Infinity;
  grid.forEachInRadius(x, z, 2 * track.halfWidth[nearest] + 2 * track.spacing + 16, (i, d2) => {
    const reach = track.halfWidth[i] + track.spacing;
    if (d2 > reach * reach) return;
    cover.push(i);
    if (track.py[i] < lowest) lowest = track.py[i];
  });
  const ref = y !== undefined && Number.isFinite(y) ? y : lowest;
  let best = nearest;
  let bestD = Infinity;
  for (const i of cover) {
    if (Math.abs(track.py[i] - ref) > GRADE_CLEARANCE / 2) continue;
    const d2 = (track.px[i] - x) ** 2 + (track.pz[i] - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  return best;
}

/** World pose at distance s (wrapped) and lateral offset (+ right). y = centre-line height, yaw = track heading. */
export function poseAt(track: BuiltTrack, s: number, lateral: number): { x: number; y: number; z: number; yaw: number } {
  const { i, f } = segmentAt(track, s);
  const j = i + 1 === track.count ? 0 : i + 1;
  const lat = Number.isFinite(lateral) ? lateral : 0;
  let nx = track.rx[i] + (track.rx[j] - track.rx[i]) * f;
  let nz = track.rz[i] + (track.rz[j] - track.rz[i]) * f;
  const len = Math.hypot(nx, nz) || 1;
  nx /= len;
  nz /= len;
  const tx = track.tx[i] + (track.tx[j] - track.tx[i]) * f;
  const tz = track.tz[i] + (track.tz[j] - track.tz[i]) * f;
  return {
    x: track.px[i] + (track.px[j] - track.px[i]) * f + lat * nx,
    y: track.py[i] + (track.py[j] - track.py[i]) * f,
    z: track.pz[i] + (track.pz[j] - track.pz[i]) * f + lat * nz,
    yaw: yawFromDir(tx, tz),
  };
}

interface SegmentHit {
  i: number;
  f: number;
  lat: number;
}

/** Exact inverse of the ruled surface on segment i → i+1; null if no preimage with f in [0, 1]. */
function solveSegment(track: BuiltTrack, i: number, x: number, z: number): SegmentHit | null {
  const j = i + 1 === track.count ? 0 : i + 1;
  const p0x = track.px[i];
  const p0z = track.pz[i];
  const dx = track.px[j] - p0x;
  const dz = track.pz[j] - p0z;
  const r0x = track.rx[i];
  const r0z = track.rz[i];
  const drx = track.rx[j] - r0x;
  const drz = track.rz[j] - r0z;
  const ax = x - p0x;
  const az = z - p0z;
  // cross(a - f d, r0 + f dr) = 0 with cross(u, v) = u.x v.z - u.z v.x
  const A = -(dx * drz - dz * drx);
  const B = ax * drz - az * drx - (dx * r0z - dz * r0x);
  const C = ax * r0z - az * r0x;
  const roots: number[] = [];
  const scale = Math.abs(B) + Math.abs(C) + 1e-12;
  if (Math.abs(A) < 1e-12 * scale) {
    if (Math.abs(B) > 1e-15) roots.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const q = -0.5 * (B + (B >= 0 ? sq : -sq));
      roots.push(q / A);
      if (Math.abs(q) > 1e-300) roots.push(C / q);
    }
  }
  let best: SegmentHit | null = null;
  for (const root of roots) {
    if (!(root >= -1e-9 && root <= 1 + 1e-9)) continue;
    const f = Math.min(1, Math.max(0, root));
    const nx = r0x + drx * f;
    const nz = r0z + drz * f;
    const len = Math.hypot(nx, nz) || 1;
    const lat = ((ax - f * dx) * nx + (az - f * dz) * nz) / len;
    if (!best || Math.abs(lat) < Math.abs(best.lat)) best = { i, f, lat };
  }
  return best;
}

/** Index of the closest sample, walking from `hint` within ±HINT_WINDOW and beyond while still improving. */
function localNearest(track: BuiltTrack, x: number, z: number, hint: number): number {
  const n = track.count;
  const d2 = (i: number): number => {
    const ex = track.px[i] - x;
    const ez = track.pz[i] - z;
    return ex * ex + ez * ez;
  };
  const w = Math.min(HINT_WINDOW, Math.floor((n - 1) / 2));
  let bestOff = 0;
  let bestD = d2(hint);
  for (let o = -w; o <= w; o++) {
    const v = d2(wrapIndex(hint + o, n));
    if (v < bestD) {
      bestD = v;
      bestOff = o;
    }
  }
  if (bestOff === w || bestOff === -w) {
    const dir = bestOff > 0 ? 1 : -1;
    for (let steps = 0; steps < n; steps++) {
      const v = d2(wrapIndex(hint + bestOff + dir, n));
      if (v >= bestD) break;
      bestD = v;
      bestOff += dir;
    }
  }
  return wrapIndex(hint + bestOff, n);
}

/** Closest point on the centre-line polyline near sample k (fallback when the exact inverse fails). */
function chordFallback(track: BuiltTrack, k: number, x: number, z: number): SegmentHit {
  const n = track.count;
  let best: SegmentHit = { i: k, f: 0, lat: 0 };
  let bestD = Infinity;
  for (const i of [wrapIndex(k - 1, n), k]) {
    const j = (i + 1) % n;
    const dx = track.px[j] - track.px[i];
    const dz = track.pz[j] - track.pz[i];
    const len2 = dx * dx + dz * dz || 1;
    const f = Math.min(1, Math.max(0, ((x - track.px[i]) * dx + (z - track.pz[i]) * dz) / len2));
    const cx = track.px[i] + dx * f;
    const cz = track.pz[i] + dz * f;
    const d = Math.hypot(x - cx, z - cz);
    if (d < bestD) {
      bestD = d;
      const nx = track.rx[i] + (track.rx[j] - track.rx[i]) * f;
      const nz = track.rz[i] + (track.rz[j] - track.rz[i]) * f;
      best = { i, f, lat: (x - cx) * nx + (z - cz) * nz >= 0 ? d : -d };
    }
  }
  return best;
}

/**
 * Project a world XZ point onto the track. With `hintIndex` (the car's last trackIndex) only a ±40-sample
 * window around it is searched (extended while the distance keeps falling), so parallel sections are never
 * confused; without a hint the nearest sample is found globally via a spatial hash. A hinted result lying
 * more than 25 m beyond the local barriers is treated as a stale hint and re-searched globally.
 *
 * Grade separation: the hinted search is local (±40 samples), so a car stays on its own level at a crossing. The
 * optional `y` (the car's elevation) makes the stale-hint check and the global search level-aware: a hint whose
 * road is more than GRADE_CLEARANCE / 2 away in height is stale, and a global search picks the road at that
 * level. Without `y` the global search resolves a crossing to the lower road (see globalNearest).
 *
 * Result fields: s / lateral are continuous (exact inverse of poseAt). surface: |lat| ≤ halfWidth 'asphalt';
 * pit-lane band 'pitlane'; ≤ halfWidth + kerb 'kerb'; beyond: runoff material ('grass' | 'gravel' | 'runoff').
 * wallDistance: halfWidth + runoff on the point's side, EXCEPT on the pit side along the pit straight
 * (isInPitStraight) where it is |pit.wallOffset| (the pit wall). Cars in the pit lane must use
 * pitLaneWallDistance / barrierLimits for their outer wall.
 */
export function projectToTrack(track: BuiltTrack, x: number, z: number, hintIndex?: number, y?: number): TrackProjection {
  const n = track.count;
  const hasHint = hintIndex !== undefined && Number.isFinite(hintIndex);
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    const i = hasHint ? wrapIndex(Math.round(hintIndex as number), n) : 0;
    return buildProjection(track, { i, f: 0, lat: 0 });
  }
  let k = -1;
  if (hasHint) {
    k = localNearest(track, x, z, wrapIndex(Math.round(hintIndex as number), n));
    // a stale hint (teleport, flashback) can settle on a far section: legitimate positions are inside the
    // barriers, so anything well beyond them falls back to the global search
    const reach = track.halfWidth[k] + Math.max(track.runoffLeft[k], track.runoffRight[k]) + STALE_HINT_MARGIN;
    if (Math.hypot(track.px[k] - x, track.pz[k] - z) > reach) k = -1;
    else if (y !== undefined && Number.isFinite(y) && Math.abs(track.py[k] - y) > GRADE_CLEARANCE / 2 && hasCrossing(track)) k = -1;
  }
  if (k < 0) {
    k = globalNearest(track, x, z, y);
    if (k < 0) k = 0;
  }
  let hit: SegmentHit | null = null;
  for (let o = -2; o <= 1; o++) {
    const cand = solveSegment(track, wrapIndex(k + o, n), x, z);
    if (cand && (!hit || Math.abs(cand.lat) < Math.abs(hit.lat))) hit = cand;
  }
  return buildProjection(track, hit ?? chordFallback(track, k, x, z));
}

function buildProjection(track: BuiltTrack, hit: SegmentHit): TrackProjection {
  const n = track.count;
  const { i, f, lat } = hit;
  const j = i + 1 === n ? 0 : i + 1;
  const s = wrapS(track, (i + f) * track.spacing);
  const hw = track.halfWidth[i] + (track.halfWidth[j] - track.halfWidth[i]) * f;
  const tx = track.tx[i] + (track.tx[j] - track.tx[i]) * f;
  const tz = track.tz[i] + (track.tz[j] - track.tz[i]) * f;
  const { surface, wallDistance } = classify(track, s, i, j, f, lat, hw);
  return {
    index: f < 0.5 ? i : j,
    s,
    lateral: lat,
    halfWidth: hw,
    surface,
    height: track.py[i] + (track.py[j] - track.py[i]) * f,
    wallDistance,
    heading: yawFromDir(tx, tz),
  };
}

function classify(
  track: BuiltTrack,
  s: number,
  i: number,
  j: number,
  f: number,
  lat: number,
  hw: number,
): { surface: SurfaceKind; wallDistance: number } {
  const side = lat >= 0 ? 1 : -1;
  const kerbArr = side === 1 ? track.kerbRight : track.kerbLeft;
  const runoffArr = side === 1 ? track.runoffRight : track.runoffLeft;
  const surfArr = side === 1 ? track.runoffSurfaceRight : track.runoffSurfaceLeft;
  const kerb = kerbArr[i] + (kerbArr[j] - kerbArr[i]) * f;
  const runoff = runoffArr[i] + (runoffArr[j] - runoffArr[i]) * f;
  const a = Math.abs(lat);
  const pitSide = side === track.pit.side && isInPitZone(track, s);
  const pitStraight = pitSide && isInPitStraight(track, s);
  const wallDistance = pitStraight ? Math.abs(track.pit.wallOffset) : hw + runoff;

  let surface: SurfaceKind;
  if (a <= hw) surface = 'asphalt';
  else if (pitSide && inPitLaneBand(track, s, lat, a, pitStraight)) surface = 'pitlane';
  else if (a <= hw + kerb) surface = 'kerb';
  else {
    const code = f < 0.5 ? surfArr[i] : surfArr[j];
    surface = code === 1 ? 'gravel' : code === 2 ? 'runoff' : 'grass';
  }
  return { surface, wallDistance };
}

function inPitLaneBand(track: BuiltTrack, s: number, lat: number, absLat: number, straight: boolean): boolean {
  if (straight) return absLat >= Math.abs(track.pit.wallOffset);
  const centre = pitLaneOffsetAt(track, s);
  return centre !== null && Math.abs(lat - centre) <= PIT_LANE_HALF_WIDTH;
}

/**
 * Signed lateral interval [min, max] (+ right) a car at (s, lateral) is confined to by barriers:
 * normally [-(halfWidth + runoffLeft), halfWidth + runoffRight]. Along the pit straight the pit wall
 * (pit.wallOffset) splits it: track side → bounded by the pit wall; pit-lane side → between the pit wall and
 * the pit-lane outer wall (pitLaneWallDistance).
 */
export function barrierLimits(track: BuiltTrack, s: number, lateral: number): { min: number; max: number } {
  const { i, f } = segmentAt(track, s);
  const j = i + 1 === track.count ? 0 : i + 1;
  const hw = track.halfWidth[i] + (track.halfWidth[j] - track.halfWidth[i]) * f;
  const left = -(hw + track.runoffLeft[i] + (track.runoffLeft[j] - track.runoffLeft[i]) * f);
  const right = hw + track.runoffRight[i] + (track.runoffRight[j] - track.runoffRight[i]) * f;
  if (!isInPitStraight(track, s)) return { min: left, max: right };
  const wall = track.pit.wallOffset;
  const outer = track.pit.side * pitLaneWallDistance(track, s);
  if (track.pit.side === 1) return lateral < wall ? { min: left, max: wall } : { min: wall, max: outer };
  return lateral > wall ? { min: wall, max: right } : { min: outer, max: wall };
}
