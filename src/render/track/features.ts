/**
 * TrackFeature resolution (pure, no three.js): the forward-lap fractions of a real circuit's features are mapped to the
 * driven layout with the same rule as track/layoutMeta.ts (reverse layouts mirror a fraction f to 1 - f, ranges swap
 * ends, sides flip), converted to metres and validated against the renderer's name registry. Unknown names, bad
 * numbers and out-of-range spans are dropped silently.
 */
import type { BuiltTrack, TrackFeature } from '../../core/types';
import { wrapFraction } from '../../track/layoutMeta';

/** Bridge-kind names (a structure spanning the road at `at`). */
export const BRIDGE_NAMES = ['footbridge', 'hotel-bridge', 'wing-grandstand', 'banking-bridge'] as const;
/** Landmark-kind names (scenery next to the road). 'pit-building-wing' and 'grandstand' extend existing builders. */
export const LANDMARK_NAMES = [
  'marina',
  'ferris-wheel',
  'observation-tower',
  'control-tower',
  'skyline',
  'sky-park-hotel',
  'led-sphere',
  'fountain-lake',
  'old-banking',
  'forest',
  'grandstand',
  'casino-square',
  'swimming-pool',
  'lake',
  'hillside-houses',
  'pit-building-wing',
  'palm-plantation',
  'leaf-grandstand',
] as const;

/** Longest tunnel / forest belt (m) the renderer builds; longer spans are truncated from the start. */
export const MAX_TUNNEL_LENGTH = 900;
export const MIN_TUNNEL_LENGTH = 40;
export const MAX_FOREST_LENGTH = 1800;

export interface LayoutFeature {
  kind: TrackFeature['kind'];
  name: string;
  label?: string;
  /** start / end distance (m) in driving direction; s1 < s0 when the span wraps through the line; s1 === s0 for points */
  s0: number;
  s1: number;
  /** span length (m) along the lap (0 for points) */
  length: number;
  /** +1 right, -1 left in the driving direction of this layout, 0 = unspecified */
  side: 1 | -1 | 0;
  /** distance (m) from the centre line to the near edge, or null = renderer default */
  offset: number | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Feature list of a built track mapped to its layout direction (forward or reverse). */
export function layoutFeatures(track: Pick<BuiltTrack, 'def' | 'reverse' | 'length'>): LayoutFeature[] {
  const list = track.def?.real?.features;
  if (!Array.isArray(list) || !(track.length > 0)) return [];
  const out: LayoutFeature[] = [];
  const L = track.length;
  for (const f of list) {
    if (!f || typeof f.name !== 'string' || !isNum(f.at)) continue;
    const kind = f.kind;
    const known =
      kind === 'tunnel' ? f.name === 'tunnel' : kind === 'bridge' ? (BRIDGE_NAMES as readonly string[]).includes(f.name) : kind === 'landmark' && (LANDMARK_NAMES as readonly string[]).includes(f.name);
    if (!known) continue;
    const span = kind === 'tunnel' || (kind === 'landmark' && isNum(f.end));
    if (kind === 'tunnel' && !isNum(f.end)) continue;
    const a = wrapFraction(f.at);
    const b = span && isNum(f.end) ? wrapFraction(f.end) : a;
    // reverse layouts keep s = 0 at points[0]: fraction f of the forward lap becomes 1 - f, ends swap
    const start = track.reverse ? wrapFraction(1 - b) : a;
    const end = track.reverse ? wrapFraction(1 - a) : b;
    let length = span ? wrapFraction(end - start) * L : 0;
    if (kind === 'tunnel' && length < MIN_TUNNEL_LENGTH) continue;
    length = Math.min(length, kind === 'tunnel' ? MAX_TUNNEL_LENGTH : MAX_FOREST_LENGTH);
    const s0 = start * L;
    const fwd: 1 | -1 | 0 = f.side === 'right' ? 1 : f.side === 'left' ? -1 : 0;
    out.push({
      kind,
      name: f.name,
      label: f.label,
      s0,
      s1: length > 0 ? (s0 + length) % L : s0,
      length,
      side: fwd === 0 ? 0 : ((track.reverse ? -fwd : fwd) as 1 | -1),
      offset: isNum(f.offset) && f.offset >= 0 ? f.offset : null,
    });
  }
  return out;
}

/** Tunnel spans of the layout (for camera handling and prop exclusion). */
export function tunnelRanges(features: readonly LayoutFeature[]): { s0: number; s1: number }[] {
  return features.filter((f) => f.kind === 'tunnel').map((f) => ({ s0: f.s0, s1: f.s1 }));
}

/** True if distance `s` lies within [s0, s1] (wrapping through the line when s1 < s0) extended by `margin` metres. */
export function inSpan(s: number, s0: number, s1: number, L: number, margin = 0): boolean {
  if (!(L > 0)) return false;
  const rel = (((s - (s0 - margin)) % L) + L) % L;
  const len = ((((s1 - s0) % L) + L) % L) + 2 * margin;
  return rel <= len;
}
