/**
 * buildTrack: TrackDef → BuiltTrack. Samples the closed centripetal Catmull-Rom spline at uniform arc length,
 * derives frames / curvature / elevation / widths, the minimum-curvature racing line and reference speed
 * profile, corners, roadside (kerbs, runoff, surfaces, barrier clamping), pit geometry and lap metadata.
 */
import type { BuiltTrack, TrackDef } from '../core/types';
import { REFERENCE_CAR } from '../core/defaults';
import { angleDiff } from '../core/math';
import { detectCorners, smoothedCurvature } from './corners';
import { detectDeck } from './crossings';
import { layoutFractions } from './layoutMeta';
import { wrapS } from './loop';
import { PIT_LANE_EXTRA, PIT_OUTER_CLEARANCE, PIT_STREET, PIT_WALL_EXTRA, pitLaneOffsetAt } from './pit';
import { poseAt } from './project';
import { computeRacingLine } from './racingLine';
import { computeRoadside } from './roadside';
import { smoothClosed, wrapIndex } from './signal';
import { computeSpeedProfile, lapTime, linePath } from './speedProfile';
import { sampleClosedSpline, type SplinePoint } from './spline';

const DEFAULT_SPACING = 2;
/** Elevation smoothing (box radius m, passes): original circuits are flattened, real profiles keep their grades. */
const HEIGHT_SMOOTH_ORIGINAL = { radius: 12, passes: 3 };
const HEIGHT_SMOOTH_REAL = { radius: 6, passes: 2 };

export interface BuildOptions {
  /** drive the circuit in the opposite direction (s = 0 stays at points[0]) */
  reverse?: boolean;
  /** sample spacing (m), default 2, clamped to [0.5, 10] */
  spacing?: number;
}

export function buildTrack(def: TrackDef, opts?: BuildOptions): BuiltTrack {
  const reverse = opts?.reverse === true;
  const spacingWanted = clampNum(opts?.spacing ?? DEFAULT_SPACING, 0.5, 10, DEFAULT_SPACING);
  const ordered = orderedPoints(def, reverse);

  // ── centre line
  const spline = sampleClosedSpline(ordered, spacingWanted);
  const { count: n, spacing, length, px, pz } = spline;
  const hs = def.real ? HEIGHT_SMOOTH_REAL : HEIGHT_SMOOTH_ORIGINAL;
  const py = smoothClosed(spline.py, Math.round(hs.radius / spacing), hs.passes);
  const halfWidth = smoothClosed(spline.width, Math.round(10 / spacing), 2).map((w) => w / 2);

  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  const rx = new Float64Array(n);
  const rz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const dx = px[b] - px[a];
    const dz = pz[b] - pz[a];
    const len = Math.hypot(dx, dz) || 1;
    tx[i] = dx / len;
    tz[i] = dz / len;
    rx[i] = -tz[i];
    rz[i] = tx[i];
  }
  const rawCurvature = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const yawIn = Math.atan2(px[i] - px[a], pz[i] - pz[a]);
    const yawOut = Math.atan2(px[b] - px[i], pz[b] - pz[i]);
    const ds = 0.5 * (Math.hypot(px[i] - px[a], pz[i] - pz[a]) + Math.hypot(px[b] - px[i], pz[b] - pz[i]));
    // + = turns right; turning right decreases yaw
    rawCurvature[i] = -angleDiff(yawIn, yawOut) / Math.max(1e-6, ds);
  }
  const curvature = smoothClosed(rawCurvature, 1, 2);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = i * spacing;

  const deck = detectDeck(px, py, pz, halfWidth, spacing);

  // ── racing line & reference speed
  const racingLine = computeRacingLine(px, pz, rx, rz, halfWidth);
  const path = linePath(px, pz, rx, rz, racingLine);
  const speedProfile = computeSpeedProfile(path.curvature, path.ds);
  const referenceLapTime = lapTime(speedProfile, path.ds);

  // ── corners & lap metadata
  const cornerInfo = detectCorners(curvature, speedProfile, spacing);
  const frac = layoutFractions(def, reverse);
  const loop = { length, count: n, spacing };
  const toS = (f: number): number => wrapS(loop, f * length);
  const pitEntry = toS(frac.pit.entry);
  const pitExit = toS(frac.pit.exit);
  const entryIdx = Math.round(pitEntry / spacing) % n;
  const exitIdx = Math.round(pitExit / spacing) % n;
  let zoneHw = 0;
  for (let k = 0, len = wrapIndex(exitIdx - entryIdx, n); k <= len; k++) {
    zoneHw = Math.max(zoneHw, halfWidth[(entryIdx + k) % n]);
  }
  const side = frac.pit.side;
  const roadsideInput = {
    count: n,
    spacing,
    px,
    pz,
    py,
    deck,
    rx,
    rz,
    halfWidth,
    smoothCurvature: smoothedCurvature(curvature, spacing),
    curvature,
    speed: speedProfile,
    corners: cornerInfo,
    street: def.street,
    biome: def.biome,
  };
  const withPit = (laneExtra: number, outerClearance: number) => {
    const laneOffset = side * (zoneHw + laneExtra);
    return { laneOffset, outerClearance, roadside: computeRoadside({ ...roadsideInput, pit: { side, entryIdx, exitIdx, laneOffset, outerClearance } }) };
  };
  let extras: { wallExtra: number; laneOffset: number; roadside: ReturnType<typeof computeRoadside> } = {
    wallExtra: PIT_WALL_EXTRA,
    ...withPit(PIT_LANE_EXTRA, PIT_OUTER_CLEARANCE),
  };
  // Street circuits whose pit side has no room for the standard lane (the barrier is clamped below
  // |laneOffset| + PIT_OUTER_CLEARANCE) get the compact street pit lane; all other layouts keep the standard geometry.
  if (def.street) {
    const runoff = side === 1 ? extras.roadside.runoffRight : extras.roadside.runoffLeft;
    const need = Math.abs(extras.laneOffset) + PIT_OUTER_CLEARANCE;
    let fits = true;
    for (let k = 0, len = wrapIndex(exitIdx - entryIdx, n); k <= len && fits; k++) fits = runoff[(entryIdx + k) % n] >= need - 1e-9;
    if (!fits) extras = { wallExtra: PIT_STREET.wallExtra, ...withPit(PIT_STREET.laneExtra, PIT_STREET.outerClearance) };
  }
  const { laneOffset, roadside } = extras;
  const wallOffset = side * (zoneHw + extras.wallExtra);

  const track: BuiltTrack = {
    id: reverse ? `${def.id}-rev` : def.id,
    def,
    reverse,
    displayName: reverse ? `${def.name}（反向）` : def.name,
    length,
    count: n,
    spacing,
    px,
    py,
    pz,
    tx,
    tz,
    rx,
    rz,
    s,
    curvature,
    halfWidth,
    kerbLeft: roadside.kerbLeft,
    kerbRight: roadside.kerbRight,
    runoffLeft: roadside.runoffLeft,
    runoffRight: roadside.runoffRight,
    runoffSurfaceLeft: roadside.runoffSurfaceLeft,
    runoffSurfaceRight: roadside.runoffSurfaceRight,
    racingLine,
    speedProfile,
    deck,
    sectorStarts: [0, toS(frac.sectors[0]), toS(frac.sectors[1])],
    drsZones: frac.drsZones.map((z) => ({ detection: toS(z.detection), activation: toS(z.activation), end: toS(z.end) })),
    pit: {
      side,
      entry: pitEntry,
      exit: pitExit,
      box: toS(frac.pit.box),
      laneOffset,
      wallOffset,
      speedLimit: REFERENCE_CAR.pitSpeed,
      laneLength: 0,
    },
    corners: cornerInfo.map((c) => c.corner),
    referenceLapTime,
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
  };
  track.pit.laneLength = measurePitLane(track);
  track.bounds = computeBounds(track);
  return track;
}

function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Control points in driving order (reverse keeps points[0] first), defaults applied, duplicates removed. */
function orderedPoints(def: TrackDef, reverse: boolean): SplinePoint[] {
  const src = def.points;
  if (!Array.isArray(src) || src.length < 4) throw new Error(`track ${def.id}: needs ≥ 4 control points`);
  const width = clampNum(def.width, 6, 30, 12);
  const list = reverse ? [src[0], ...src.slice(1).reverse()] : src.slice();
  const out: SplinePoint[] = [];
  for (const p of list) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) throw new Error(`track ${def.id}: non-finite control point`);
    const q: SplinePoint = {
      x: p.x,
      z: p.z,
      y: Number.isFinite(p.y) ? (p.y as number) : 0,
      width: p.width !== undefined && Number.isFinite(p.width) ? clampNum(p.width, 6, 30, width) : width,
    };
    const prev = out[out.length - 1];
    if (prev && Math.hypot(prev.x - q.x, prev.z - q.z) < 0.05) continue;
    out.push(q);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) < 0.05) {
    out.pop();
  }
  if (out.length < 4) throw new Error(`track ${def.id}: too few distinct control points`);
  return out;
}

/** Path length of the pit-lane centre line from entry to exit. */
function measurePitLane(track: BuiltTrack): number {
  const zone = wrapS(track, track.pit.exit - track.pit.entry);
  const steps = Math.max(1, Math.ceil(zone / track.spacing));
  let total = 0;
  let last = poseAt(track, track.pit.entry, pitLaneOffsetAt(track, track.pit.entry) ?? 0);
  for (let k = 1; k <= steps; k++) {
    const at = track.pit.entry + Math.min(zone - 1e-6, (zone * k) / steps);
    const p = poseAt(track, at, pitLaneOffsetAt(track, at) ?? 0);
    total += Math.hypot(p.x - last.x, p.z - last.z);
    last = p;
  }
  return total;
}

/** Bounds of everything inside the barriers (centre line ± (halfWidth + runoff)) plus elevation range. */
function computeBounds(track: BuiltTrack): BuiltTrack['bounds'] {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < track.count; i++) {
    const left = track.halfWidth[i] + track.runoffLeft[i];
    const right = track.halfWidth[i] + track.runoffRight[i];
    for (const off of [-left, right]) {
      const x = track.px[i] + off * track.rx[i];
      const z = track.pz[i] + off * track.rz[i];
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (z < b.minZ) b.minZ = z;
      if (z > b.maxZ) b.maxZ = z;
    }
    if (track.py[i] < b.minY) b.minY = track.py[i];
    if (track.py[i] > b.maxY) b.maxY = track.py[i];
  }
  return b;
}
