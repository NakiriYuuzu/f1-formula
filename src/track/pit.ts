/**
 * Pit-lane geometry helpers. The pit zone runs forward from pit.entry to pit.exit (through s = 0) on side
 * pit.side. The lane centre leaves the track edge at entry, blends to pit.laneOffset over a ramp
 * (≤ PIT_RAMP_LENGTH), runs straight (the "pit straight", where the pit wall at pit.wallOffset exists)
 * and blends back to the track edge before exit. Re-exported by track.ts — import from there.
 */
import type { BuiltTrack } from '../core/types';
import { smoothstep } from '../core/math';
import { forwardDistance, sampleAt } from './loop';

/** Nominal length (m) of the entry / exit ramps between track edge and lane centre. */
export const PIT_RAMP_LENGTH = 120;
/** Half length (m) of the garage row centred on pit.box: 12 boxes × 12.8 m = 153.6 m (render PIT_BOX_SPACING). */
export const PIT_BOX_ROW_HALF = 77;
/** Shortest pit zone (entry → exit, m) a layout may have: ramps (zone / 4) + the garage row (±95 m with the buildings) fit. */
export const MIN_PIT_ZONE = 380;
/**
 * Largest |curvature| (1/m) anywhere in the pit zone (R ≥ 250 m): the lane offset stays a clean parallel curve.
 * Also keep corners whose INSIDE is the pit side (R < ~25 m) at least 40 m outside the zone, otherwise the fold
 * limit of the barrier cuts the pit-side runoff below |laneOffset| + PIT_OUTER_CLEARANCE.
 */
export const MAX_PIT_CURVATURE = 1 / 250;
/** Lane centre offset beyond the half width (m): |laneOffset| = maxHalfWidth + PIT_LANE_EXTRA. */
export const PIT_LANE_EXTRA = 9;
/** Pit wall offset beyond the half width (m): |wallOffset| = maxHalfWidth + PIT_WALL_EXTRA. */
export const PIT_WALL_EXTRA = 3;
/** Pit-side runoff through the pit zone is at least |laneOffset| + this (m). */
export const PIT_OUTER_CLEARANCE = 5;
/**
 * Compact pit-lane extras for street circuits whose pit side has no room for the standard ones (another section runs
 * ~45 m away, e.g. Monaco): lane centre 8 m, pit wall 2.5 m beyond the half width, 1 m of clearance behind the lane band
 * (the renderer's lane band is ±PIT_LANE_HALF_WIDTH = 5 m, so wall face 2.75 m < band edge 3 m). buildTrack falls back to
 * these only for `def.street` layouts where the standard geometry does not fit; every other layout keeps the constants above.
 */
export const PIT_STREET = { laneExtra: 8, wallExtra: 2.5, outerClearance: 1 } as const;

/** Pit extras (lane, wall, outer clearance) in use on `track`: PIT_STREET if its laneOffset says so, else the standard ones. */
export function pitExtrasOf(track: Pick<BuiltTrack, 'pit' | 'count' | 'halfWidth' | 'spacing' | 'length'>): {
  laneExtra: number;
  wallExtra: number;
  outerClearance: number;
} {
  let zoneHw = 0;
  for (let i = 0; i < track.count; i++) if (isInPitZone(track, i * track.spacing)) zoneHw = Math.max(zoneHw, track.halfWidth[i]);
  const compact = Math.abs(Math.abs(track.pit.laneOffset) - (zoneHw + PIT_STREET.laneExtra)) < 1e-6;
  return compact
    ? { ...PIT_STREET }
    : { laneExtra: PIT_LANE_EXTRA, wallExtra: PIT_WALL_EXTRA, outerClearance: PIT_OUTER_CLEARANCE };
}

/** Half width (m) of the drivable lane band reported as 'pitlane' along the ramps. */
export const PIT_LANE_HALF_WIDTH = 5;
/** Where the lane centre starts / ends on the track: this far inside the road edge (m). */
const RAMP_EDGE_INSET = 1.5;

type PitTrack = Pick<BuiltTrack, 'length' | 'count' | 'spacing' | 'pit' | 'halfWidth' | 'runoffLeft' | 'runoffRight'>;

/** Length (m) of the pit zone, entry → exit along the track. */
export function pitZoneLength(track: Pick<BuiltTrack, 'length' | 'count' | 'spacing' | 'pit'>): number {
  return forwardDistance(track, track.pit.entry, track.pit.exit);
}

/** Actual ramp length used by this track (m): min(PIT_RAMP_LENGTH, zone / 4). */
export function pitRampLength(track: Pick<BuiltTrack, 'length' | 'count' | 'spacing' | 'pit'>): number {
  return Math.min(PIT_RAMP_LENGTH, pitZoneLength(track) / 4);
}

/** True if s is inside the pit zone [entry, exit). */
export function isInPitZone(track: Pick<BuiltTrack, 'length' | 'count' | 'spacing' | 'pit'>, s: number): boolean {
  return forwardDistance(track, track.pit.entry, s) < pitZoneLength(track);
}

/** True if s is on the straight part of the pit zone [entry + ramp, exit - ramp), where the pit wall stands. */
export function isInPitStraight(track: Pick<BuiltTrack, 'length' | 'count' | 'spacing' | 'pit'>, s: number): boolean {
  const zone = pitZoneLength(track);
  const ramp = pitRampLength(track);
  const d = forwardDistance(track, track.pit.entry, s);
  return d >= ramp && d < zone - ramp;
}

/** s range of the pit wall (straight part of the pit zone). */
export function pitWallRange(track: Pick<BuiltTrack, 'length' | 'count' | 'spacing' | 'pit'>): { start: number; end: number } {
  const ramp = pitRampLength(track);
  const L = track.length;
  return {
    start: (((track.pit.entry + ramp) % L) + L) % L,
    end: (((track.pit.exit - ramp) % L) + L) % L,
  };
}

/**
 * Signed lateral offset (m, + right) of the pit-lane centre line at s, or null outside the pit zone.
 * Smoothly goes from just inside the road edge at entry to pit.laneOffset and back at exit.
 */
export function pitLaneOffsetAt(track: PitTrack, s: number): number | null {
  const zone = pitZoneLength(track);
  const d = forwardDistance(track, track.pit.entry, s);
  if (d >= zone) return null;
  const ramp = pitRampLength(track);
  const full = Math.abs(track.pit.laneOffset);
  const edge = Math.max(0, sampleAt(track, track.halfWidth, s) - RAMP_EDGE_INSET);
  const t = Math.min(smoothstep(0, ramp, d), smoothstep(0, ramp, zone - d));
  return track.pit.side * (edge + (full - edge) * t);
}

/**
 * Distance (m, positive) from the centre line to the OUTER barrier on the pit side at s
 * (= halfWidth + runoff on the pit side). Through the pit zone this is the garage-side wall of the pit lane:
 * the pit-side runoff there is ≥ |laneOffset| + PIT_OUTER_CLEARANCE, so this is ≥ halfWidth + |laneOffset| + 5.
 * Cars driving in the pit lane are confined between |pit.wallOffset| (inner, pit straight only) and this value.
 */
export function pitLaneWallDistance(track: PitTrack, s: number): number {
  const runoff = track.pit.side === 1 ? track.runoffRight : track.runoffLeft;
  return sampleAt(track, track.halfWidth, s) + sampleAt(track, runoff, s);
}
