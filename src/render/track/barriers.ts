/**
 * Trackside barriers along both sides at the visual barrier line: concrete walls with debris fences
 * (street circuits, asphalt run-off, main straight), Armco steel rails on posts (grass run-off), tyre
 * walls with belt facing (gravel traps / tight corners), and the pit-lane outer wall in the pit ramps.
 */
import * as THREE from 'three';
import type { QualityLevel } from '../../core/types';
import { GeoBuilder, addBox } from '../core/geometry';
import { concreteTexture, fenceTexture, tyreWallTexture } from '../core/surfaceTextures';
import { headingAt, segmentRuns, sidePoint, wrapIndex, type SceneryContext } from './context';
import { DECK_SLAB } from './deck';

const enum Kind {
  None = -1,
  Concrete = 0,
  Armco = 1,
  Tyres = 2,
}

const WALL_H = 1.05;
const FENCE_H = 3.2;
/** Debris fences and their posts stop where a crossing deck's underside is lower than this above the road (m). */
const FENCE_TOP = WALL_H + FENCE_H + 0.35;
/**
 * Bottom (m, relative to the road) of walls, posts, tyre walls and debris fences: the terrain around the corridor sits
 * 0.35–0.8 m below the road (lowered under the run-off) and lower on embankments, so they reach into the ground.
 */
const FOOT_Y = -1.2;
/** Walls reach at most this much deeper (m) than FOOT_Y to meet a falling terrain. */
const MAX_EXTRA_FOOT = 12;
/** Armco post spacing (m): thin posts, so every 4 m keeps the look at half the triangles (main + shadow pass). */
const ARMCO_POST_SPACING: Record<QualityLevel, number> = { low: 8, medium: 6, high: 4, ultra: 4 };
/** Armco rail rows are emitted every N samples (straight rails between them): the rails are most of a lap's barrier triangles. */
const ARMCO_RAIL_STRIDE: Record<QualityLevel, number> = { low: 4, medium: 2, high: 1, ultra: 1 };
/** Tyre wall texture: one tile (v 0..1) per this many metres of height. */
const TYRE_TILE_H = 1.2;
/** TecPro stacks: only at corners whose entry speed drops by more than this (m/s, as the braking boards), block size (m). */
const TECPRO_MIN_DROP = 18;
const TECPRO_BLOCK = 1.65;
const TECPRO_DEPTH = 0.95;
const TECPRO_TOP = 1.3;
/** Stack runs from this far before the apex to this far after it (m); needs this much room between kerb and wall (m). */
const TECPRO_LEAD = 12;
const TECPRO_TRAIL = 48;
const TECPRO_MIN_SPACE = 2;
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/**
 * Rows (bottom, top) along samples; quads wound so the face looks towards +R (facingRight) or -R. `y0` may vary per sample
 * (a foot that follows the terrain on embankments): the v coordinate then keeps the texture scale of the FOOT_Y wall.
 */
function vface(
  b: GeoBuilder,
  ctx: SceneryContext,
  i0: number,
  len: number,
  lat: (k: number) => number,
  y0: number | ((k: number) => number),
  y1: number,
  facingRight: boolean,
  uTile: number,
  v0 = 0,
  v1 = 1,
  stride = 1,
): void {
  const t = ctx.track;
  const n = t.count;
  let prev = -1;
  const sgn = facingRight ? 1 : -1;
  for (let j = 0; j <= len; j = j === len ? len + 1 : Math.min(len, j + stride)) {
    const k = wrapIndex(i0 + j, n);
    const u = (t.s[wrapIndex(i0, n)] + j * t.spacing) / uTile;
    const nx = t.rx[k] * sgn;
    const nz = t.rz[k] * sgn;
    const yb = typeof y0 === 'number' ? y0 : y0(k);
    sidePoint(t, k, lat(k), yb, _p);
    sidePoint(t, k, lat(k), y1, _q);
    const vb = typeof y0 === 'number' ? v0 : v1 - ((v1 - v0) * (y1 - yb)) / (y1 - FOOT_Y);
    const row = b.vertex(_p.x, _p.y, _p.z, nx, 0, nz, u, vb);
    b.vertex(_q.x, _q.y, _q.z, nx, 0, nz, u, v1);
    if (prev >= 0) {
      if (facingRight) b.quad(prev, row, row + 1, prev + 1);
      else b.quad(prev, prev + 1, row + 1, row);
    }
    prev = row;
  }
}

/** Horizontal strip at height y between two signed laterals. */
function hface(b: GeoBuilder, ctx: SceneryContext, i0: number, len: number, latA: (k: number) => number, latB: (k: number) => number, y: number, uTile: number, v: number): void {
  const t = ctx.track;
  const n = t.count;
  let prev = -1;
  for (let j = 0; j <= len; j++) {
    const k = wrapIndex(i0 + j, n);
    const a = latA(k);
    const c = latB(k);
    const u = (t.s[wrapIndex(i0, n)] + j * t.spacing) / uTile;
    sidePoint(t, k, Math.min(a, c), y, _p);
    sidePoint(t, k, Math.max(a, c), y, _q);
    const row = b.vertex(_p.x, _p.y, _p.z, 0, 1, 0, u, v);
    b.vertex(_q.x, _q.y, _q.z, 0, 1, 0, u, v);
    if (prev >= 0) b.quad(prev, prev + 1, row + 1, row);
    prev = row;
  }
}

/** `ground` (final terrain height) lets walls, tyre stacks and posts reach down to the terrain on embankments. */
export function buildBarriers(ctx: SceneryContext, ground?: (x: number, z: number) => number): THREE.Group {
  const { track: t, frame: f, disposer } = ctx;
  const n = t.count;
  const group = new THREE.Group();
  group.name = 'barriers';
  const concrete = new GeoBuilder();
  const fence = new GeoBuilder();
  const metal = new GeoBuilder();
  const tyres = new GeoBuilder();
  const tecpro = new GeoBuilder(true);
  const _c = new THREE.Color();

  for (const side of [-1, 1] as const) {
    const L = side > 0 ? f.barrierR : f.barrierL;
    const kinds = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      if (f.inPit[i] && side === f.pitSign) {
        // pit-side outer wall of the pit lane; the garage block replaces it where it stands
        kinds[i] = f.garage[i] ? Kind.None : Kind.Concrete;
        continue;
      }
      const surf = side > 0 ? t.runoffSurfaceRight[i] : t.runoffSurfaceLeft[i];
      const nearStart = Math.min(t.s[i], t.length - t.s[i]) < 260;
      if (ctx.street || nearStart || surf === 2) kinds[i] = Kind.Concrete;
      else if (surf === 1) kinds[i] = Kind.Tyres;
      else kinds[i] = Kind.Armco;
    }
    // majority filter to avoid flickering type changes
    const filtered = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      if (kinds[i] === Kind.None) {
        filtered[i] = Kind.None;
        continue;
      }
      const votes = [0, 0, 0];
      for (let k = -6; k <= 6; k++) {
        const v = kinds[wrapIndex(i + k, n)];
        if (v >= 0) votes[v]++;
      }
      filtered[i] = votes[2] >= votes[0] && votes[2] >= votes[1] ? Kind.Tyres : votes[0] >= votes[1] ? Kind.Concrete : Kind.Armco;
      // parapets of a bridge deck are always concrete (the engine keeps the wall within DECK_RUNOFF there)
      if (f.deck[i]) filtered[i] = Kind.Concrete;
    }
    const lat = (extra: number) => (k: number): number => side * (L[k] + extra);
    // bottom of a wall at lateral `extra`: FOOT_Y, or lower where the terrain falls away below the road (never floating)
    const foot = (extra: number) => (k: number): number => {
      if (!ground) return FOOT_Y;
      sidePoint(t, k, side * (L[k] + extra), 0, _p);
      return Math.max(FOOT_Y - MAX_EXTRA_FOOT, Math.min(FOOT_Y, ground(_p.x, _p.z) - _p.y - 0.3));
    };
    // fences stay out from under a crossing deck (the wall itself is low enough to pass beneath it)
    const underDeck = new Uint8Array(n);
    if (f.hasDeck) {
      for (let i = 0; i < n; i++) {
        if (f.deck[i]) continue;
        sidePoint(t, i, lat(0.3)(i), 0, _p);
        if (f.deckUnderside(_p.x, _p.z, DECK_SLAB, 1) - t.py[i] < FENCE_TOP) underDeck[i] = 1;
      }
    }
    /** Sub-runs [start, segments] of a barrier run that are not under a deck. */
    const fenceRuns = (i0: number, len: number): [number, number][] => {
      if (!f.hasDeck) return [[i0, len]];
      const out: [number, number][] = [];
      let from = -1;
      for (let j = 0; j <= len; j++) {
        const open = j < len && !underDeck[wrapIndex(i0 + j, n)] && !underDeck[wrapIndex(i0 + j + 1, n)];
        if (open && from < 0) from = j;
        else if (!open && from >= 0) {
          out.push([wrapIndex(i0 + from, n), j - from]);
          from = -1;
        }
      }
      return out;
    };
    for (const kind of [Kind.Concrete, Kind.Armco, Kind.Tyres]) {
      for (const [i0, len] of segmentRuns(n, (i) => filtered[i] === kind)) {
        if (kind === Kind.Concrete) {
          // inner face (towards the track), top, outer face
          const wallV0 = 1 - (WALL_H - FOOT_Y) / (WALL_H + 0.4);
          vface(concrete, ctx, i0, len, lat(0), foot(0), WALL_H, side < 0, 8, wallV0, 1);
          hface(concrete, ctx, i0, len, lat(0), lat(0.35), WALL_H, 8, 0.95);
          vface(concrete, ctx, i0, len, lat(0.35), foot(0.35), WALL_H, side > 0, 8, wallV0, 1);
          for (const [j0, jl] of fenceRuns(i0, len)) {
            vface(fence, ctx, j0, jl, lat(0.2), WALL_H, WALL_H + FENCE_H, side < 0, 2, 0, FENCE_H / 2);
            posts(metal, ctx, j0, jl, lat(0.25), WALL_H, FENCE_H + 0.15, 4);
          }
        } else if (kind === Kind.Armco) {
          for (const [y0, y1] of [[0.42, 0.72], [0.8, 1.08]]) {
            const stride = ARMCO_RAIL_STRIDE[ctx.quality.level] ?? 1;
            vface(metal, ctx, i0, len, lat(0), y0, y1, side < 0, 4, 0, 1, stride);
            vface(metal, ctx, i0, len, lat(0.04), y0, y1, side > 0, 4, 0, 1, stride);
          }
          posts(metal, ctx, i0, len, lat(0.12), foot(0.12), 1.1, ARMCO_POST_SPACING[ctx.quality.level] ?? 4);
        } else {
          const tyreV0 = 1 - (1.0 - FOOT_Y) / TYRE_TILE_H;
          vface(tyres, ctx, i0, len, lat(0), foot(0), 1.0, side < 0, 2, tyreV0, 1);
          hface(tyres, ctx, i0, len, lat(0), lat(1.0), 1.0, 2, 0.02);
          vface(tyres, ctx, i0, len, lat(1.0), foot(1.0), 1.0, side > 0, 2, tyreV0, 1);
          for (const [j0, jl] of fenceRuns(i0, len)) {
            vface(fence, ctx, j0, jl, lat(1.6), FOOT_Y, FENCE_H + 0.6, side < 0, 2, FOOT_Y / 2, (FENCE_H + 0.6) / 2);
            posts(metal, ctx, j0, jl, lat(1.65), FOOT_Y, FENCE_H + 0.6 - FOOT_Y, 4);
          }
        }
      }
    }
    // TecPro block stacks on the outside of heavy-braking corners where the wall is concrete
    for (const c of t.corners) {
      if (-c.direction !== side) continue;
      const approach = t.speedProfile[wrapIndex(Math.round((c.startS - 150) / t.spacing), n)] ?? 0;
      if (!(approach - c.minSpeed > TECPRO_MIN_DROP)) continue;
      const first = Math.round((c.apexS - TECPRO_LEAD) / t.spacing);
      const count = Math.floor((TECPRO_LEAD + TECPRO_TRAIL) / TECPRO_BLOCK);
      for (let m = 0; m < count; m++) {
        const k = wrapIndex(first + Math.round((m * TECPRO_BLOCK) / t.spacing), n);
        if (filtered[k] !== Kind.Concrete || f.inPit[k] || f.deck[k]) continue;
        const space = L[k] - t.halfWidth[k] - (side > 0 ? t.kerbRight[k] : t.kerbLeft[k]);
        if (space < TECPRO_MIN_SPACE) continue;
        sidePoint(t, k, side * (L[k] + TECPRO_DEPTH / 2 - 0.03), 0, _p);
        const yaw = headingAt(t, k);
        // body alternates white / blue, with a red cap strip; the foot reaches into the lowered ground
        tecpro.setColor(_c.set(m % 2 === 0 ? '#e9ecf0' : '#2a5db0'));
        addBox(tecpro, _p.x, _p.y + (TECPRO_TOP + FOOT_Y) / 2, _p.z, yaw, TECPRO_DEPTH, TECPRO_TOP - FOOT_Y, TECPRO_BLOCK - 0.08, 1);
        tecpro.setColor(_c.set('#d22a22'));
        addBox(tecpro, _p.x, _p.y + TECPRO_TOP + 0.07, _p.z, yaw, TECPRO_DEPTH + 0.02, 0.14, TECPRO_BLOCK - 0.06, 1);
      }
    }
  }

  const add = (b: GeoBuilder, mat: THREE.Material, name: string, cast: boolean): void => {
    const g = b.build();
    if (!g) {
      mat.dispose();
      return;
    }
    disposer.add(g);
    disposer.add(mat);
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = true;
    group.add(m);
  };
  const concreteTint = ctx.street ? '#d8d6d0' : '#c9c8c2';
  add(concrete, new THREE.MeshStandardMaterial({ name: 'concrete', map: disposer.add(concreteTexture(ctx.anisotropy, concreteTint)), roughness: 0.9 }), 'concrete', true);
  add(
    fence,
    new THREE.MeshStandardMaterial({
      name: 'fence',
      map: disposer.add(fenceTexture(ctx.anisotropy)),
      // blended, not cut out: mip-averaged wire alpha fades the mesh out smoothly at distance instead of breaking into dots
      alphaTest: 0.04,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      roughness: 0.5,
      metalness: 0.5,
    }),
    'fence',
    false,
  );
  add(metal, new THREE.MeshStandardMaterial({ name: 'steel', color: '#b8bec6', roughness: 0.42, metalness: 0.75 }), 'steel', true);
  const belt: [string, string] = ctx.biome === 'coastal' ? ['#1f5fc4', '#f2f2f2'] : ['#d22a22', '#f2f2f2'];
  add(tecpro, new THREE.MeshStandardMaterial({ name: 'tecpro', vertexColors: true, roughness: 0.55 }), 'tecpro', true);
  add(tyres, new THREE.MeshStandardMaterial({ name: 'tyre-wall', map: disposer.add(tyreWallTexture(ctx.anisotropy, belt[0], belt[1])), roughness: 0.8 }), 'tyreWall', true);
  return group;
}

/** Thin posts every `every` metres along a lateral line. */
/** `y0` / `h` = bottom and height; with a per-sample bottom `h` is the height of the top above the road. */
function posts(b: GeoBuilder, ctx: SceneryContext, i0: number, len: number, lat: (k: number) => number, y0: number | ((k: number) => number), h: number, every: number): void {
  const t = ctx.track;
  const step = Math.max(1, Math.round(every / Math.max(0.1, t.spacing)));
  for (let j = 0; j <= len; j += step) {
    const k = wrapIndex(i0 + j, t.count);
    const bottom = typeof y0 === 'number' ? y0 : y0(k);
    const height = typeof y0 === 'number' ? h : h - bottom;
    sidePoint(t, k, lat(k), bottom + height / 2, _p);
    addBox(b, _p.x, _p.y, _p.z, headingAt(t, k), 0.08, height, 0.08, 1);
  }
}
