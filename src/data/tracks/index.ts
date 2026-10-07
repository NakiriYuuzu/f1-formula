/**
 * Track registry (owner: track agent). Contract used by menus, App, HUD, tests.
 * Five original circuits plus the real-world circuits (src/data/tracks/real), each driven forward and in reverse
 * (`${id}-rev`).
 *
 * Outline / minimap space: x = normalised world X (screen right), y = normalised world Z (screen DOWN).
 * This is the un-mirrored top view for the core/math yaw convention (right = (-cos yaw, sin yaw)): a car
 * turning right on track also turns clockwise on the map. Use worldToOutline() for car markers.
 */
import type { BuiltTrack, LayoutInfo, TrackDef } from '../../core/types';
import { buildTrack } from '../../track/track';
import { HIGHLAND_RIDGE } from './highland-ridge';
import { ISOLA_VERDE } from './isola-verde';
import { KOYO_HILLS } from './koyo-hills';
import { MIRAGE_SANDS } from './mirage-sands';
import { PORTO_LUMEN } from './porto-lumen';
import { ASIA_CIRCUITS } from './real/asia';
import { EU_CIRCUITS } from './real/eu';
import { MEAM_CIRCUITS } from './real/meam';

/** The original fictional circuits (5). */
export const ORIGINAL_TRACK_DEFS: TrackDef[] = [PORTO_LUMEN, MIRAGE_SANDS, HIGHLAND_RIDGE, KOYO_HILLS, ISOLA_VERDE];

/** Real circuits in 2025 calendar order, then former venues (ids not listed sort last). */
const REAL_ORDER = [
  'shanghai', 'suzuka', 'bahrain', 'monaco', 'silverstone', 'spa',
  'monza', 'singapore', 'cota', 'interlagos', 'las-vegas', 'yas-marina',
  // former calendar venues
  'sepang',
];
const realRank = (def: TrackDef): number => {
  const i = REAL_ORDER.indexOf(def.id);
  return i < 0 ? REAL_ORDER.length : i;
};

/** Real-world circuits recreated from their real layouts. */
export const REAL_TRACK_DEFS: TrackDef[] = [...EU_CIRCUITS, ...ASIA_CIRCUITS, ...MEAM_CIRCUITS].sort(
  (a, b) => realRank(a) - realRank(b),
);

/** All circuits: originals first, then the real circuits. */
export const TRACK_DEFS: TrackDef[] = [...ORIGINAL_TRACK_DEFS, ...REAL_TRACK_DEFS];

const REVERSE_SUFFIX = '-rev';

/** Every layout: each def forward + reverse (`${id}-rev`), interleaved in TRACK_DEFS order. */
export const LAYOUTS: LayoutInfo[] = TRACK_DEFS.flatMap((def) => [
  { id: def.id, defId: def.id, reverse: false, displayName: def.name },
  { id: `${def.id}${REVERSE_SUFFIX}`, defId: def.id, reverse: true, displayName: `${def.name}（反向）` },
]);

const layoutById = new Map<string, LayoutInfo>(LAYOUTS.map((l) => [l.id, l]));
const defById = new Map<string, TrackDef>(TRACK_DEFS.map((d) => [d.id, d]));
const builtCache = new Map<string, BuiltTrack>();

/** True if `layoutId` names a registered layout (any circuit, forward or reverse). */
export function hasLayout(layoutId: string): boolean {
  return layoutById.has(layoutId);
}

export function getLayoutInfo(layoutId: string): LayoutInfo {
  const info = layoutById.get(layoutId);
  if (!info) throw new Error(`未知的賽道佈局：${layoutId}`);
  return info;
}

/** The TrackDef of a circuit id (not a layout id). Throws on unknown id. */
export function getTrackDef(defId: string): TrackDef {
  const def = defById.get(defId);
  if (!def) throw new Error(`未知的賽道：${defId}`);
  return def;
}

/** Build (and cache) a layout by id. Throws on unknown id. The returned track is shared: never mutate it. */
export function getLayout(layoutId: string): BuiltTrack {
  const cached = builtCache.get(layoutId);
  if (cached) return cached;
  const info = getLayoutInfo(layoutId);
  const track = buildTrack(getTrackDef(info.defId), { reverse: info.reverse });
  builtCache.set(layoutId, track);
  return track;
}

interface OutlineFrame {
  cx: number;
  cz: number;
  /** world metres per normalised unit (the larger of the X / Z extents) */
  scale: number;
}

const frameCache = new Map<string, OutlineFrame>();

function outlineFrame(layoutId: string): OutlineFrame {
  const cached = frameCache.get(layoutId);
  if (cached) return cached;
  const t = getLayout(layoutId);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < t.count; i++) {
    if (t.px[i] < minX) minX = t.px[i];
    if (t.px[i] > maxX) maxX = t.px[i];
    if (t.pz[i] < minZ) minZ = t.pz[i];
    if (t.pz[i] > maxZ) maxZ = t.pz[i];
  }
  const frame: OutlineFrame = {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    scale: Math.max(maxX - minX, maxZ - minZ, 1),
  };
  frameCache.set(layoutId, frame);
  return frame;
}

/**
 * Map a world XZ position into the outline space of getLayoutOutline (x right, y down; the centre line spans
 * [0,1] on its longer axis and is centred on the other). Points off the circuit may fall outside [0,1].
 */
export function worldToOutline(layoutId: string, x: number, z: number): { x: number; y: number } {
  const f = outlineFrame(layoutId);
  const wx = Number.isFinite(x) ? x : f.cx;
  const wz = Number.isFinite(z) ? z : f.cz;
  return { x: 0.5 + (wx - f.cx) / f.scale, y: 0.5 + (wz - f.cz) / f.scale };
}

/**
 * Normalized centre-line polyline for minimap / menu previews: points in [0,1]² (x right, y down),
 * aspect preserved, centred, start/finish at index 0, evenly spaced along the lap in driving order.
 * Open polyline (the first point is not repeated) — draw it closed. maxPoints is clamped to [8, track.count].
 */
export function getLayoutOutline(layoutId: string, maxPoints = 256): { x: number; y: number }[] {
  const t = getLayout(layoutId);
  const wanted = Number.isFinite(maxPoints) ? Math.floor(maxPoints) : 256;
  const m = Math.min(t.count, Math.max(8, wanted));
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < m; k++) {
    const i = Math.min(t.count - 1, Math.round((k * t.count) / m));
    out.push(worldToOutline(layoutId, t.px[i], t.pz[i]));
  }
  return out;
}
