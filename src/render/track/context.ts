/**
 * Shared context passed to every trackside builder (road, terrain, barriers, pit, props ...), plus
 * helpers for walking the sampled track (runs of samples, local frames, wrapped indices).
 */
import * as THREE from 'three';
import type { Biome, BuiltTrack, TimeOfDay } from '../../core/types';
import type { Disposer } from '../core/disposer';
import type { QualityProfile } from '../core/quality';
import type { TrackFrame } from './trackFrame';

export interface Exclusion {
  x: number;
  z: number;
  r: number;
}

/**
 * Terrain reshaping requested by landmarks (planned before the terrain is built): a flat plateau (building pad, quay),
 * an optional water basin carved into it, or a hillside that rises away from the road.
 * Shapes are rectangles (hx × hz half extents, rotated by yaw: local +X = across / outward, local +Z = along the track)
 * or ellipses.
 */
export interface TerrainEdit {
  kind: 'pad' | 'hill';
  shape: 'rect' | 'ellipse';
  cx: number;
  cz: number;
  /** rotation about Y (same convention as boxes: local +Z = forward) */
  yaw: number;
  hx: number;
  hz: number;
  /** pad: plateau height; hill: unused */
  y: number;
  /** pad: water basin floor height (absent = plain plateau) inside the footprint inset by `basinInset` */
  basinY?: number;
  basinInset?: number;
  /** distance (m) over which the edit fades into the surrounding terrain */
  blend: number;
  /** hill: extra height (m) reached at the far (outward, local +X) edge; rises smoothly from the near edge */
  gain?: number;
}

/** A named grandstand requested by a 'grandstand' feature; trackside.ts builds it with seating and crowd. */
export interface FeatureStand {
  /** sample index the stand is anchored to */
  k: number;
  side: 1 | -1;
  /** distance (m) from the centre line to the stand's front edge */
  offset: number;
  length: number;
  rows: number;
}

export interface SceneryContext {
  track: BuiltTrack;
  frame: TrackFrame;
  biome: Biome;
  street: boolean;
  timeOfDay: TimeOfDay;
  quality: QualityProfile;
  disposer: Disposer;
  anisotropy: number;
  seed: number;
  /** areas kept free of scattered props (stands, TV cameras, buildings ...) */
  exclusions: Exclusion[];
  /** unlit lamp materials whose brightness follows the environment lamp level */
  lampMaterials: THREE.MeshBasicMaterial[];
  /** base colour of every lamp material (scaled by the lamp level each frame) */
  lampBase: THREE.Color[];
  /** terrain reshaping from landmarks (filled by planLandmarks before buildTerrain) */
  terrainEdits: TerrainEdit[];
  /** named grandstands from track features (consumed by buildTrackside) */
  featureStands: FeatureStand[];
  /** tunnel ranges [s0, s1] (m, driving direction, s0 > s1 when wrapping); cameras avoid / handle them */
  tunnels: { s0: number; s1: number }[];
  /** true when a 'pit-building-wing' feature asks for the wavy-roofed pit building */
  pitWing: boolean;
  /** session team colours in pit-box order (garage doors, box paint, fan blocks); never empty */
  teamColors: string[];
}

/**
 * Grid slot layout painted on the main straight, matching race/world.ts (GRID_FRONT / GRID_GAP / GRID_LATERAL):
 * slot k centre at s = -(firstSlot + k * spacing) with lateral = (k even ? poleSide : -poleSide) * lateral.
 * poleSide is relative to the pit lane: -1 = pole on the side away from the pit lane (lateral sign -pit.side).
 */
export const GRID_LAYOUT = { firstSlot: 8, spacing: 8, lateral: 2.4, poleSide: -1 } as const;

export function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/** Contiguous runs of segments i -> i+1 where `include(i)` holds (loop-aware). Returns [start, segmentCount]. */
export function segmentRuns(n: number, include: (i: number) => boolean): [number, number][] {
  if (n <= 0) return [];
  const flags = new Uint8Array(n);
  let any = false;
  let all = true;
  for (let i = 0; i < n; i++) {
    flags[i] = include(i) ? 1 : 0;
    if (flags[i]) any = true;
    else all = false;
  }
  if (!any) return [];
  if (all) return [[0, n]];
  // start just after a gap so wrapping runs stay contiguous
  let start = 0;
  while (flags[start] === 1) start++;
  const runs: [number, number][] = [];
  let i = 0;
  while (i < n) {
    const k = wrapIndex(start + i, n);
    if (flags[k]) {
      let len = 0;
      while (i + len < n && flags[wrapIndex(start + i + len, n)]) len++;
      runs.push([k, len]);
      i += len;
    } else i++;
  }
  return runs;
}

/** World point at sample i (wrapped) offset laterally by `lat` (+ right) and vertically by `dy`. */
export function sidePoint(t: BuiltTrack, i: number, lat: number, dy: number, out: THREE.Vector3): THREE.Vector3 {
  const k = wrapIndex(i, t.count);
  return out.set(t.px[k] + t.rx[k] * lat, t.py[k] + dy, t.pz[k] + t.rz[k] * lat);
}

/** Track yaw (heading) at sample i. */
export function headingAt(t: BuiltTrack, i: number): number {
  const k = wrapIndex(i, t.count);
  return Math.atan2(t.tx[k], t.tz[k]);
}

/** Cumulative distance for sample i of a run, continuous across the s = 0 wrap. */
export function runS(t: BuiltTrack, start: number, offset: number): number {
  return t.s[wrapIndex(start, t.count)] + offset * t.spacing;
}

/** True if distance `s` (m) lies inside a tunnel span (extended by `margin` m): nothing may be placed beside the road there. */
export function inTunnel(ctx: Pick<SceneryContext, 'tunnels' | 'track'>, s: number, margin = 0): boolean {
  const L = ctx.track.length;
  for (const tn of ctx.tunnels) {
    const rel = (((s - (tn.s0 - margin)) % L) + L) % L;
    const len = ((((tn.s1 - tn.s0) % L) + L) % L) + 2 * margin;
    if (rel <= len) return true;
  }
  return false;
}

/** True if roadside structures must not stand beside sample k: on a bridge deck or inside / next to a tunnel. */
export function blockedAt(ctx: SceneryContext, k: number, margin = 0): boolean {
  return ctx.track.deck[k] > 0 || inTunnel(ctx, ctx.track.s[k], margin);
}
