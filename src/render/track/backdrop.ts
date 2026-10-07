/**
 * Distant backdrop: a low-poly ring of scenery just outside the terrain rectangle, per biome —
 * temperate: layered green hills with forest patches + a blue-grey mountain range with snow caps;
 * autumn: hills with a red / orange / gold forest band + violet-grey mountains;
 * desert: rolling dunes, flat-topped banded mesas and a hazy far ridge;
 * coastal: open sea to the horizon with a few rocky islands, land (shelf, village, hills, mountains) only inland;
 * city: dense skyline of towers with lit window facades (emissive, blooms at night), a harbour breakwater with a
 * lighthouse, moored ships and harbour / street / beacon lights, dark hills behind.
 * Everything is merged per material (≤ 3 draw calls), shadowless, inside the camera far plane, never inside the
 * terrain rectangle, and uses a capped scene fog (sceneryMaterials.patchBackdropFog) so it reads as distance.
 */
import * as THREE from 'three';
import type { Biome, QualityLevel, TimeOfDay } from '../../core/types';
import { clamp01, lerp, smoothstep, TAU } from '../../core/math';
import { Rng } from '../core/canvas';
import { CAMERA_FAR } from '../core/quality';
import { GeoBuilder, addBox } from '../core/geometry';
import { SKYLINE_WINDOW_GRID, skylineTexture } from '../core/surfaceTextures';
import type { SceneryContext } from './context';
import { BACKDROP_FOG_CAP, patchBackdropFog, patchWindowFade } from './sceneryMaterials';
import { backdropMaxRadius, landEdgeBlend, landWeight, rectDistance, rectRayDistance, ridged, ringFbm } from './sceneryMath';

export interface BackdropFrame {
  /** centre of the terrain rectangle */
  cx: number;
  cz: number;
  /** half extents of the terrain rectangle (m) */
  hx: number;
  hz: number;
  /** far ground plane height outside the terrain */
  farY: number;
  /** sea level for water biomes, else null */
  seaLevel: number | null;
  /** inland edge / shelf height for water biomes (= farY otherwise) */
  landY: number;
  /** unit vector (x, z) pointing out to sea */
  seaDirX: number;
  seaDirZ: number;
  /** farthest distance (m) from the centre a camera can be */
  reach: number;
}

/** Angular resolution of the ring layers per quality. */
export const BACKDROP_SEGMENTS: Record<QualityLevel, number> = { low: 128, medium: 288, high: 512, ultra: 640 };
/** Gap (m) between the terrain rectangle and the first backdrop layer. */
export const BACKDROP_GAP = 60;
/** Free-standing shapes (mesas, islands, towers, ships, houses) keep at least this far (m) from the terrain. */
const RECT_CLEARANCE = 20;
/** Rock shapes are drawn up to this factor beyond their nominal radius (vertex wobble × base flare). */
const ROCK_EXTENT = 1.36;
/** Every backdrop vertex stays within this distance (m) of any camera (camera far plane minus margin). */
export const BACKDROP_VIEW_FAR = CAMERA_FAR - 200;
/** Albedo multiplier per time of day (night: dark silhouettes under the floodlit key light). */
export const BACKDROP_ALBEDO: Record<TimeOfDay, number> = { day: 1, dusk: 0.82, night: 0.38 };
/** The backdrop skyline blends its window grid into the facade average between these view distances (m). */
const SKYLINE_WINDOW_FADE: readonly [number, number] = [380, 1000];

/** Skyline window emissive intensity per time of day (night > bloom threshold). */
export const SKYLINE_GLOW: Record<TimeOfDay, number> = { day: 0, dusk: 0.5, night: 1.4 };
/** Fog cap of the skyline (lower = towers stand out more) and of the point lights. */
export const SKYLINE_FOG_CAP = 0.74;
export const BACKDROP_LIGHT_FOG_CAP = 0.5;
/** Point-light brightness (linear multiplier of the light colours). */
export const BACKDROP_LIGHT_GAIN = 2.6;
/** Number of skyline towers (city) per quality; 75 % inland, 25 % on the far shore across the harbour. */
export const SKYLINE_TOWERS: Record<QualityLevel, number> = { low: 110, medium: 300, high: 420, ultra: 520 };
/** Real street circuits (Singapore, Las Vegas): denser skyline (multiplier of SKYLINE_TOWERS). */
export const SKYLINE_REAL_DENSITY = 1.35;
/** Metres per skyline facade texture repeat (horizontal, vertical): 4 m window bays, 3.6 m floors. */
export const SKYLINE_TILE: readonly [number, number] = [SKYLINE_WINDOW_GRID.cols * 4, SKYLINE_WINDOW_GRID.rows * 3.6];

type Rgb = string;

interface RidgeLayer {
  /** radial start / end (m) measured from the ring inner radius, clamped to the view-far radius */
  r0: number;
  r1: number;
  /** crest height range (m above the layer base) */
  h: readonly [number, number];
  /** ring-noise base period (cells per turn) */
  period: number;
  ridged?: boolean;
  /** per-face normals (rocky facets) instead of smooth shading */
  faceted?: boolean;
  /** [radial fraction, height fraction] from the sunk foot (-1) to the back of the crest */
  rows: readonly (readonly [number, number])[];
  palette: { foot: Rgb; low: Rgb; mid: Rgb; crest: Rgb };
  /** patchwork colours over the lower slopes (forest band) and how strongly they replace the base */
  band?: readonly Rgb[];
  bandAmount?: number;
  /** snow above this height (m above base) */
  snow?: number;
  /** heights fade to nothing towards the sea (water biomes) */
  landOnly?: boolean;
  seed: number;
}

const HILL_ROWS = [[0, -1], [0.16, 0.14], [0.38, 0.48], [0.62, 0.82], [0.8, 1], [1, 0.88]] as const;
const PEAK_ROWS = [[0, -1], [0.3, 0.36], [0.62, 0.8], [0.78, 1], [1, 0.74]] as const;
const DUNE_ROWS = [[0, -1], [0.25, 0.22], [0.55, 0.76], [0.7, 1], [1, 0.42]] as const;
const SNOW = '#e9eef4';

const LAYERS: Record<Biome, RidgeLayer[]> = {
  temperate: [
    { r0: 0, r1: 560, h: [28, 88], period: 12, rows: HILL_ROWS, palette: { foot: '#5a7e39', low: '#4b7131', mid: '#557a3a', crest: '#6c8c4d' }, band: ['#2e5127', '#385d2b', '#436a32'], bandAmount: 0.6, seed: 1 },
    { r0: 360, r1: 1000, h: [70, 165], period: 8, rows: HILL_ROWS, palette: { foot: '#4d6d47', low: '#496946', mid: '#557459', crest: '#6a846f' }, band: ['#33523a', '#3d5e42'], bandAmount: 0.45, seed: 2 },
    { r0: 1000, r1: 1750, h: [150, 400], period: 7, ridged: true, faceted: false, rows: PEAK_ROWS, palette: { foot: '#5b6676', low: '#586373', mid: '#66717e', crest: '#7b8593' }, snow: 390, seed: 3 },
  ],
  autumn: [
    { r0: 0, r1: 560, h: [30, 92], period: 12, rows: HILL_ROWS, palette: { foot: '#6a6834', low: '#6c5d2f', mid: '#785c2d', crest: '#887040' }, band: ['#b3442a', '#c7682c', '#d19834', '#8d3923', '#3e5932'], bandAmount: 0.78, seed: 4 },
    { r0: 360, r1: 1000, h: [70, 170], period: 8, rows: HILL_ROWS, palette: { foot: '#685944', low: '#745f49', mid: '#7d6954', crest: '#8b7965' }, band: ['#9c4931', '#b1743b', '#49593f'], bandAmount: 0.55, seed: 5 },
    { r0: 1000, r1: 1750, h: [140, 370], period: 7, ridged: true, faceted: false, rows: PEAK_ROWS, palette: { foot: '#5e5965', low: '#605b68', mid: '#6d6876', crest: '#817c89' }, snow: 450, seed: 6 },
  ],
  desert: [
    { r0: 0, r1: 700, h: [12, 48], period: 18, rows: DUNE_ROWS, palette: { foot: '#c8a36a', low: '#cea76b', mid: '#d7b379', crest: '#e5c58f' }, seed: 11 },
    { r0: 1150, r1: 1750, h: [90, 230], period: 7, ridged: true, faceted: true, rows: PEAK_ROWS, palette: { foot: '#9a6c54', low: '#91644e', mid: '#88685d', crest: '#9a7e72' }, seed: 12 },
  ],
  coastal: [
    { r0: 220, r1: 760, h: [40, 120], period: 11, landOnly: true, rows: HILL_ROWS, palette: { foot: '#6b8943', low: '#5e7c3b', mid: '#698445', crest: '#859459' }, band: ['#4a6932', '#557339', '#98985f'], bandAmount: 0.5, seed: 21 },
    { r0: 600, r1: 1250, h: [100, 230], period: 8, landOnly: true, rows: HILL_ROWS, palette: { foot: '#5d7555', low: '#5a7256', mid: '#657a61', crest: '#798973' }, seed: 22 },
    { r0: 1200, r1: 1800, h: [180, 400], period: 6, ridged: true, faceted: true, landOnly: true, rows: PEAK_ROWS, palette: { foot: '#65707c', low: '#626d7a', mid: '#6f7984', crest: '#838c97' }, seed: 23 },
  ],
  tropical: [
    { r0: 0, r1: 520, h: [14, 46], period: 14, rows: HILL_ROWS, palette: { foot: '#3f7a2e', low: '#357028', mid: '#3d7a2c', crest: '#52913a' }, band: ['#2a5e24', '#33702a', '#3d7f2e', '#58802a', '#8a6a3a'], bandAmount: 0.72, seed: 41 },
    { r0: 340, r1: 980, h: [34, 95], period: 9, rows: HILL_ROWS, palette: { foot: '#3b6f3a', low: '#376a38', mid: '#44784a', crest: '#5a8f5c' }, band: ['#2c5a30', '#356638', '#4a7a30'], bandAmount: 0.55, seed: 42 },
    { r0: 900, r1: 1750, h: [60, 150], period: 7, rows: HILL_ROWS, palette: { foot: '#55806c', low: '#52796a', mid: '#628a7c', crest: '#7ca293' }, seed: 43 },
  ],
  city: [
    { r0: 1150, r1: 1800, h: [50, 140], period: 10, landOnly: true, rows: HILL_ROWS, palette: { foot: '#3c493d', low: '#39453a', mid: '#44503e', crest: '#535e4b' }, seed: 31 },
  ],
};

/** Land shelf (water biomes): flat inland ground from the terrain edge to the hills. */
const SHELF: Partial<Record<Biome, { depth: number; colors: readonly [Rgb, Rgb] }>> = {
  coastal: { depth: 260, colors: ['#6e8944', '#86904f'] },
  city: { depth: 1250, colors: ['#45474b', '#55565a'] },
};

const MESA_STRATA = ['#a85c38', '#c27a4c', '#93512f', '#b86e43'] as const;
const TOWER_TINTS = ['#5d6b7a', '#7a8796', '#4c5866', '#8d9399', '#6b6158', '#9aa3ad'] as const;

/** Per-angle ring frame: unit directions, inner radius just outside the terrain, land weight. */
class Ring {
  readonly n: number;
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  /** rectangle edge distance (m) */
  readonly edge: Float64Array;
  /** inner radius of the backdrop (edge + gap) */
  readonly inner: Float64Array;
  /** 1 = land, 0 = sea (always 1 without water) */
  readonly land: Float64Array;

  constructor(
    readonly frame: BackdropFrame,
    n: number,
    readonly maxR: number,
  ) {
    this.n = n;
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    this.edge = new Float64Array(n);
    this.inner = new Float64Array(n);
    this.land = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      const c = Math.cos(a);
      const s = Math.sin(a);
      this.cos[k] = c;
      this.sin[k] = s;
      this.edge[k] = rectRayDistance(c, s, frame.hx, frame.hz);
      this.inner[k] = this.edge[k] + BACKDROP_GAP;
      this.land[k] = frame.seaLevel === null ? 1 : landWeight(c, s, frame.seaDirX, frame.seaDirZ);
    }
  }

  theta(k: number): number {
    return (k / this.n) * TAU;
  }

  /** Ground height under the ring at sample k: far plane, or the land shelf sinking into the sea. */
  baseY(k: number): number {
    const f = this.frame;
    return f.seaLevel === null ? f.farY : lerp(f.farY, f.landY, landEdgeBlend(this.land[k]));
  }

  radius(k: number, offset: number): number {
    return Math.min(this.inner[k] + offset, this.maxR);
  }

  x(k: number, r: number): number {
    return this.frame.cx + this.cos[k] * r;
  }

  z(k: number, r: number): number {
    return this.frame.cz + this.sin[k] * r;
  }
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();

/** Build the backdrop group (null when the track is empty). */
export function buildBackdrop(ctx: SceneryContext, frame: BackdropFrame): THREE.Group | null {
  if (ctx.track.count < 2) return null;
  const { disposer } = ctx;
  const level = ctx.quality.level;
  const n = Math.max(48, BACKDROP_SEGMENTS[level] ?? 256);
  const minInner = Math.min(frame.hx, frame.hz) + BACKDROP_GAP;
  const ring = new Ring(frame, n, backdropMaxRadius(frame.reach, BACKDROP_VIEW_FAR, minInner + 200));
  const albedo = BACKDROP_ALBEDO[ctx.timeOfDay] ?? 1;
  const rng = new Rng(ctx.seed + 31337);
  const land = new GeoBuilder(true);
  const towers = new GeoBuilder(true);
  const lights = new GeoBuilder(true);
  // distant point lights after dusk (skipped on 'low': one draw call less)
  const lit = ctx.timeOfDay !== 'day' && level !== 'low';

  const shelf = SHELF[ctx.biome];
  if (shelf && frame.seaLevel !== null) addShelf(land, ring, shelf.depth, shelf.colors, albedo, ctx.seed);
  for (const layer of LAYERS[ctx.biome] ?? []) addRidge(land, ring, layer, albedo, ctx.seed);
  if (ctx.biome === 'desert') addMesas(land, ring, rng, albedo);
  if (ctx.biome === 'coastal') {
    addIslands(land, ring, rng, albedo);
    addVillage(land, lit ? lights : null, ring, rng, albedo);
  }
  if (ctx.biome === 'city') {
    addFarShore(land, ring, albedo);
    addSkyline(towers, lit ? lights : null, ring, rng, Math.round((SKYLINE_TOWERS[level] ?? 320) * (ctx.track.def.real ? SKYLINE_REAL_DENSITY : 1)), albedo);
    addHarbour(land, lit ? lights : null, ring, rng, albedo);
  }

  const group = new THREE.Group();
  group.name = 'backdrop';
  const landGeo = land.build(true);
  if (landGeo) {
    disposer.add(landGeo);
    const mat = disposer.add(new THREE.MeshLambertMaterial({ name: 'backdrop-land', vertexColors: true }));
    patchBackdropFog(mat, BACKDROP_FOG_CAP, false);
    group.add(backdropMesh(landGeo, mat, 'backdrop-land'));
  }
  const towerGeo = towers.build();
  if (towerGeo) {
    disposer.add(towerGeo);
    const glow = SKYLINE_GLOW[ctx.timeOfDay] ?? 0;
    const mat = disposer.add(new THREE.MeshLambertMaterial({ name: 'backdrop-towers', vertexColors: true, map: disposer.add(skylineTexture(false)) }));
    if (glow > 0) {
      mat.emissiveMap = disposer.add(skylineTexture(true));
      mat.emissive.setRGB(1, 1, 1);
      mat.emissiveIntensity = glow;
    }
    patchBackdropFog(mat, SKYLINE_FOG_CAP, glow > 0);
    patchWindowFade(mat, SKYLINE_WINDOW_FADE);
    group.add(backdropMesh(towerGeo, mat, 'backdrop-towers'));
  }
  const lightGeo = lights.build();
  if (lightGeo) {
    disposer.add(lightGeo);
    const mat = disposer.add(new THREE.MeshBasicMaterial({ name: 'backdrop-lights', vertexColors: true }));
    mat.color.setScalar(BACKDROP_LIGHT_GAIN);
    patchBackdropFog(mat, BACKDROP_LIGHT_FOG_CAP, false);
    group.add(backdropMesh(lightGeo, mat, 'backdrop-lights'));
  }
  return group.children.length > 0 ? group : null;
}

function backdropMesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function setColor(b: GeoBuilder, hex: Rgb, albedo: number): void {
  b.setColor(_c.set(hex).multiplyScalar(albedo));
}

/** Colour of a ridge vertex from its height fraction, forest band patchwork and snow. */
function ridgeColor(layer: RidgeLayer, theta: number, row: number, hf: number, yRel: number, out: THREE.Color): THREE.Color {
  const p = layer.palette;
  if (hf < 0.25) out.set(p.foot).lerp(_c2.set(p.low), clamp01(hf / 0.25));
  else if (hf < 0.6) out.set(p.low).lerp(_c2.set(p.mid), (hf - 0.25) / 0.35);
  else out.set(p.mid).lerp(_c2.set(p.crest), clamp01((hf - 0.6) / 0.4));
  if (layer.band && layer.band.length > 0 && hf < 0.78) {
    const pick = ringFbm(theta, 90, 2, layer.seed * 13 + row * 7);
    const color = layer.band[Math.min(layer.band.length - 1, Math.floor(pick * layer.band.length * 1.2) % layer.band.length)];
    out.lerp(_c2.set(color), (layer.bandAmount ?? 0.5) * (1 - smoothstep(0.5, 0.78, hf)));
  }
  if (layer.snow !== undefined && yRel > layer.snow) out.lerp(_c2.set(SNOW), smoothstep(layer.snow, layer.snow + 70, yRel) * 0.92);
  return out;
}

/** One ring layer: rows of vertices from the sunk foot over the crest, smooth (shared) or faceted. */
function addRidge(b: GeoBuilder, ring: Ring, layer: RidgeLayer, albedo: number, seed: number): void {
  const n = ring.n;
  const rows = layer.rows;
  const R = rows.length;
  const s = (seed % 9973) + layer.seed * 1009;
  // vertex grid (row-major) of positions + colours
  const px = new Float64Array(R * n);
  const py = new Float64Array(R * n);
  const pz = new Float64Array(R * n);
  const col = new Float32Array(R * n * 3);
  for (let k = 0; k < n; k++) {
    const theta = ring.theta(k);
    const base = layer.landOnly ? ring.baseY(k) : ring.frame.farY;
    let shape = ringFbm(theta, layer.period, 4, s);
    if (layer.ridged) shape = 0.35 * shape + 0.65 * Math.pow(ridged(ringFbm(theta, layer.period * 1.5, 4, s + 1)), 1.4);
    let H = lerp(layer.h[0], layer.h[1], shape);
    if (layer.landOnly) H *= smoothstep(0.05, 0.65, ring.land[k]);
    for (let j = 0; j < R; j++) {
      const [rf, hfRow] = rows[j];
      const r = ring.radius(k, lerp(layer.r0, layer.r1, rf));
      const jitter = j === 0 ? 0 : 0.16 * (ringFbm(theta, layer.period * 3, 2, s + 17 * j) - 0.5);
      const hf = hfRow < 0 ? 0 : clamp01(hfRow * (1 + jitter));
      const y = hfRow < 0 ? base - 3 : base + H * hf;
      const v = j * n + k;
      px[v] = ring.x(k, r);
      py[v] = y;
      pz[v] = ring.z(k, r);
      ridgeColor(layer, theta, j, hf, y - base, _c).multiplyScalar(albedo);
      col[v * 3] = _c.r;
      col[v * 3 + 1] = _c.g;
      col[v * 3 + 2] = _c.b;
    }
  }
  const vert = (v: number): number => {
    b.setColor(_c.setRGB(col[v * 3], col[v * 3 + 1], col[v * 3 + 2]));
    return b.vertex(px[v], py[v], pz[v], 0, 1, 0, 0, 0);
  };
  if (layer.faceted) {
    for (let j = 0; j < R - 1; j++) {
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        const a = j * n + k;
        const bb = j * n + k1;
        const c = (j + 1) * n + k1;
        const d = (j + 1) * n + k;
        b.tri(vert(a), vert(bb), vert(c));
        b.tri(vert(a), vert(c), vert(d));
      }
    }
    return;
  }
  const first = b.vertexCount;
  for (let v = 0; v < R * n; v++) vert(v);
  for (let j = 0; j < R - 1; j++) {
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      b.quad(first + j * n + k, first + j * n + k1, first + (j + 1) * n + k1, first + (j + 1) * n + k);
    }
  }
}

/** Flat inland shelf (water biomes) from just inside the terrain edge out to `depth` beyond the gap. */
function addShelf(b: GeoBuilder, ring: Ring, depth: number, colors: readonly [Rgb, Rgb], albedo: number, seed: number): void {
  const n = ring.n;
  const first = b.vertexCount;
  const rows: [(k: number) => number, number][] = [
    [(k) => ring.edge[k] - 8, -0.6],
    [(k) => ring.inner[k], -0.15],
    [(k) => ring.radius(k, depth), -0.15],
    [(k) => ring.radius(k, depth + 60), -4],
  ];
  for (const [radius, dy] of rows) {
    for (let k = 0; k < n; k++) {
      const r = Math.min(radius(k), ring.maxR);
      b.setColor(_c.set(colors[0]).lerp(_c2.set(colors[1]), ringFbm(ring.theta(k), 40, 3, seed + 5)).multiplyScalar(albedo));
      b.vertex(ring.x(k, r), ring.baseY(k) + dy, ring.z(k, r), 0, 1, 0, 0, 0);
    }
  }
  for (let j = 0; j < rows.length - 1; j++) {
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      b.quad(first + j * n + k, first + j * n + k1, first + (j + 1) * n + k1, first + (j + 1) * n + k);
    }
  }
}

/** Faceted vertical prism / cone stack: rings of (radius scale, height) around a centre, closed on top. */
function addRock(
  b: GeoBuilder,
  cx: number,
  cz: number,
  baseY: number,
  radius: number,
  sides: number,
  levels: readonly (readonly [number, number])[],
  colors: readonly Rgb[],
  albedo: number,
  rng: Rng,
): void {
  const wobble: number[] = [];
  const rot = rng.range(0, TAU);
  for (let i = 0; i < sides; i++) wobble.push(rng.range(0.8, 1.2));
  const ringAt = (li: number, i: number): THREE.Vector3 => {
    const [rs, h] = levels[li];
    const a = rot + (i / sides) * TAU;
    const r = radius * rs * wobble[i % sides];
    return new THREE.Vector3(cx + Math.cos(a) * r, baseY + h, cz + Math.sin(a) * r);
  };
  for (let li = 0; li < levels.length - 1; li++) {
    setColor(b, colors[li % colors.length], albedo);
    for (let i = 0; i < sides; i++) {
      const p0 = ringAt(li, i);
      const p1 = ringAt(li, i + 1);
      const p2 = ringAt(li + 1, i + 1);
      const p3 = ringAt(li + 1, i);
      // (p1 - p0) × (p3 - p0) points inwards, so wind p0, p3, p2 / p0, p2, p1 to face outwards
      b.tri(b.vertex(p0.x, p0.y, p0.z, 0, 1, 0, 0, 0), b.vertex(p3.x, p3.y, p3.z, 0, 1, 0, 0, 0), b.vertex(p2.x, p2.y, p2.z, 0, 1, 0, 0, 0));
      b.tri(b.vertex(p0.x, p0.y, p0.z, 0, 1, 0, 0, 0), b.vertex(p2.x, p2.y, p2.z, 0, 1, 0, 0, 0), b.vertex(p1.x, p1.y, p1.z, 0, 1, 0, 0, 0));
    }
  }
  // top cap (fan around the centre of the last ring)
  const top = levels.length - 1;
  setColor(b, colors[colors.length - 1], albedo);
  const cy = baseY + levels[top][1];
  for (let i = 0; i < sides; i++) {
    const p0 = ringAt(top, i);
    const p1 = ringAt(top, i + 1);
    b.tri(b.vertex(cx, cy, cz, 0, 1, 0, 0, 0), b.vertex(p1.x, p1.y, p1.z, 0, 1, 0, 0, 0), b.vertex(p0.x, p0.y, p0.z, 0, 1, 0, 0, 0));
  }
}

/** True if a disc of `radius` around (x, z) stays clear of the terrain rectangle. */
function outsideTerrain(ring: Ring, x: number, z: number, radius: number): boolean {
  const f = ring.frame;
  return rectDistance(x, z, f.cx, f.cz, f.hx, f.hz) >= radius + RECT_CLEARANCE;
}

/** Random polar spot at `offset` beyond the ring inner radius, with room for `radius`; null when it does not fit. */
function polarSpot(ring: Ring, theta: number, offset: number, radius: number): { x: number; z: number; k: number } | null {
  const k = Math.round((theta / TAU) * ring.n) % ring.n;
  const r = ring.inner[k] + offset;
  if (r - radius < ring.inner[k] || r + radius > ring.maxR) return null;
  const x = ring.frame.cx + Math.cos(theta) * r;
  const z = ring.frame.cz + Math.sin(theta) * r;
  if (!outsideTerrain(ring, x, z, radius)) return null;
  return { x, z, k };
}

function overlaps(list: { x: number; z: number; r: number }[], x: number, z: number, r: number, factor: number): boolean {
  return list.some((o) => (o.x - x) ** 2 + (o.z - z) ** 2 < ((o.r + r) * factor) ** 2);
}

/** Flat-topped banded mesas (desert). */
function addMesas(b: GeoBuilder, ring: Ring, rng: Rng, albedo: number): void {
  const placed: { x: number; z: number; r: number }[] = [];
  for (let attempt = 0; attempt < 200 && placed.length < 14; attempt++) {
    const radius = rng.range(70, 240);
    const spot = polarSpot(ring, rng.range(0, TAU), rng.range(450, 1450), radius * ROCK_EXTENT);
    if (!spot || overlaps(placed, spot.x, spot.z, radius, 1.1)) continue;
    placed.push({ x: spot.x, z: spot.z, r: radius });
    const h = rng.range(60, 190);
    const strata = [MESA_STRATA[rng.int(0, 3)], MESA_STRATA[rng.int(0, 3)], MESA_STRATA[rng.int(0, 3)], '#c4895a'];
    addRock(b, spot.x, spot.z, ring.frame.farY, radius, rng.int(7, 10), [[1.12, -4], [1.04, h * 0.32], [0.97, h * 0.64], [0.9, h]], strata, albedo, rng);
  }
}

/** Rocky green islands out at sea (coastal). */
function addIslands(b: GeoBuilder, ring: Ring, rng: Rng, albedo: number): void {
  const sea = ring.frame.seaLevel ?? ring.frame.farY;
  const placed: { x: number; z: number; r: number }[] = [];
  for (let attempt = 0; attempt < 240 && placed.length < 6; attempt++) {
    const theta = rng.range(0, TAU);
    if (landWeight(Math.cos(theta), Math.sin(theta), ring.frame.seaDirX, ring.frame.seaDirZ) > 0.1) continue;
    const radius = rng.range(120, 420);
    const spot = polarSpot(ring, theta, rng.range(300, 1600), radius * ROCK_EXTENT);
    if (!spot || overlaps(placed, spot.x, spot.z, radius, 1.25)) continue;
    placed.push({ x: spot.x, z: spot.z, r: radius });
    const h = rng.range(30, 150) * (0.6 + radius / 700);
    addRock(b, spot.x, spot.z, sea, radius, rng.int(9, 12), [[1.05, -3], [0.82, h * 0.18], [0.55, h * 0.62], [0.2, h]], ['#bfae84', '#5f7f3d', '#4c6b33', '#56703a'], albedo, rng);
  }
}

/** Low far shore across the harbour (city, sea side only) for the distant skyline to stand on. */
function addFarShore(b: GeoBuilder, ring: Ring, albedo: number): void {
  const sea = ring.frame.seaLevel ?? ring.frame.farY;
  const n = ring.n;
  const rows: [number, number][] = [
    [1180, -3],
    [1225, 1.5],
    [100000, 1.5],
  ];
  const first = b.vertexCount;
  for (const [offset, dy] of rows) {
    for (let k = 0; k < n; k++) {
      const sink = smoothstep(0.3, 0.6, ring.land[k]);
      const r = ring.radius(k, offset);
      setColor(b, '#3e4044', albedo);
      b.vertex(ring.x(k, r), sea + lerp(dy, -6, sink), ring.z(k, r), 0, 1, 0, 0, 0);
    }
  }
  for (let j = 0; j < rows.length - 1; j++) {
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      b.quad(first + j * n + k, first + j * n + k1, first + (j + 1) * n + k1, first + (j + 1) * n + k);
    }
  }
}

/** Whitewashed village on the inland shelf near the hill foot (coastal), warm window lights after dusk. */
function addVillage(b: GeoBuilder, lights: GeoBuilder | null, ring: Ring, rng: Rng, albedo: number): void {
  const y0 = ring.frame.landY;
  for (let v = 0; v < 4; v++) {
    let theta = 0;
    let found = false;
    for (let a = 0; a < 60 && !found; a++) {
      theta = rng.range(0, TAU);
      found = landWeight(Math.cos(theta), Math.sin(theta), ring.frame.seaDirX, ring.frame.seaDirZ) > 0.95;
    }
    if (!found) continue;
    const centre = polarSpot(ring, theta, rng.range(110, 180), 100);
    if (!centre) continue;
    const yaw = rng.range(0, TAU);
    for (let i = 0; i < 26; i++) {
      const x = centre.x + rng.range(-70, 70);
      const z = centre.z + rng.range(-70, 70);
      if (!outsideTerrain(ring, x, z, 10)) continue;
      const w = rng.range(7, 14);
      const d = rng.range(7, 12);
      const h = rng.range(5, 9);
      setColor(b, rng.pick(['#efe8da', '#f3eee4', '#e8dcc6', '#f1e3c8']), albedo);
      addBox(b, x, y0 - 1 + (h + 1) / 2, z, yaw, w, h + 1, d, 1);
      setColor(b, rng.pick(['#b5573a', '#a64c33', '#c06a45']), albedo);
      addBox(b, x, y0 + h + 0.6, z, yaw, w + 0.6, 1.2, d + 0.6, 1);
      if (lights && rng.next() < 0.45) addLight(lights, x, y0 + h * 0.5, z, 2.2, '#ffc57a');
    }
  }
}

/** A small glowing box (night / dusk point light seen from afar). */
function addLight(b: GeoBuilder, x: number, y: number, z: number, size: number, color: Rgb): void {
  b.setColor(_c.set(color));
  addBox(b, x, y, z, 0, size, size, size, 1, false);
}

/** City skyline: towers inland (downtown cluster facing the sea) + a lower far shore across the harbour. */
function addSkyline(b: GeoBuilder, lights: GeoBuilder | null, ring: Ring, rng: Rng, count: number, albedo: number): void {
  const f = ring.frame;
  const y0 = f.landY;
  const downtown = Math.atan2(-f.seaDirZ, -f.seaDirX);
  const gridYaw = rng.range(0, Math.PI / 2);
  const placed: { x: number; z: number; r: number }[] = [];
  const [tileW, tileH] = SKYLINE_TILE;
  const inlandTarget = Math.round(count * 0.75);
  let inland = 0;
  let shore = 0;
  for (let attempt = 0; attempt < count * 12 && inland + shore < count; attempt++) {
    const theta = rng.range(0, TAU);
    const w = landWeight(Math.cos(theta), Math.sin(theta), f.seaDirX, f.seaDirZ);
    const farShore = inland >= inlandTarget || (w < 0.25 && rng.next() < 0.5);
    if (farShore ? w > 0.25 : rng.next() > smoothstep(0.45, 0.9, w)) continue;
    const width = rng.range(18, 46);
    const depth = rng.range(18, 46);
    const radius = Math.hypot(width, depth) / 2;
    const offset = farShore ? rng.range(1250, 1900) : 25 + 1000 * Math.pow(rng.next(), 1.3);
    const spot = polarSpot(ring, theta, offset, radius);
    if (!spot || overlaps(placed, spot.x, spot.z, radius, 0.75)) continue;
    placed.push({ x: spot.x, z: spot.z, r: radius });
    if (farShore) shore++;
    else inland++;
    let dTheta = Math.abs(theta - downtown) % TAU;
    if (dTheta > Math.PI) dTheta = TAU - dTheta;
    const core = Math.exp(-((dTheta / 0.5) ** 2));
    const h = farShore ? rng.range(18, 80) : rng.range(28, 95) + core * rng.range(40, 190) * (0.5 + 0.5 * clamp01(offset / 600));
    const yaw = rng.next() < 0.8 ? gridYaw + rng.range(-0.05, 0.05) : rng.range(0, TAU);
    const baseY = farShore ? (f.seaLevel ?? y0) + 1 : y0;
    setColor(b, rng.pick(TOWER_TINTS), albedo);
    const offU = rng.next();
    const offV = rng.next();
    towerBox(b, spot.x, baseY - 2, spot.z, yaw, width, h + 2, depth, tileW, tileH, offU, offV, true);
    const style = rng.next();
    let top = baseY + h;
    if (h > 70 && style < 0.35) {
      const sh = h * rng.range(0.12, 0.22);
      towerBox(b, spot.x, top, spot.z, yaw, width * 0.66, sh, depth * 0.66, tileW, tileH, offU + 0.5, offV, true);
      top += sh;
    } else if (h > 110 && style < 0.5) {
      const sh = h * rng.range(0.1, 0.18);
      towerBox(b, spot.x, top, spot.z, yaw, 1.4, sh, 1.4, tileW, tileH, 0, 0, false);
      top += sh;
    }
    if (lights) {
      if (h > 110) addLight(lights, spot.x, top + 1, spot.z, 2.6, '#ff3a2a');
      if (!farShore && rng.next() < 0.6) addLight(lights, spot.x + rng.range(-25, 25), y0 + rng.range(4, 9), spot.z + rng.range(-25, 25), 3.4, rng.pick(['#ffd08a', '#ffe2b0', '#cfe0ff']));
    }
  }
}

/** Box with window UVs (metres / tile + per-tower offset); roofs and `windows = false` boxes use the dark texel. */
function towerBox(
  b: GeoBuilder,
  x: number,
  y0: number,
  z: number,
  yaw: number,
  w: number,
  h: number,
  d: number,
  tileW: number,
  tileH: number,
  offU: number,
  offV: number,
  windows: boolean,
): void {
  const before = b.vertexCount;
  addBox(b, x, y0 + h / 2, z, yaw, w, h, d, 1);
  for (let i = before; i < b.vertexCount; i++) {
    if (!windows || b.normals[i * 3 + 1] > 0.5) {
      b.uvs[i * 2] = 0.01;
      b.uvs[i * 2 + 1] = 0.01;
    } else {
      b.uvs[i * 2] = b.uvs[i * 2] / tileW + offU;
      b.uvs[i * 2 + 1] = b.uvs[i * 2 + 1] / tileH + offV;
    }
  }
}

/** Harbour on the sea side (city): breakwater arm with a lighthouse, moored / anchored ships, harbour lights. */
function addHarbour(b: GeoBuilder, lights: GeoBuilder | null, ring: Ring, rng: Rng, albedo: number): void {
  const f = ring.frame;
  const sea = f.seaLevel ?? f.farY;
  // breakwater: from the coast (land weight ≈ 0.5) along an arc into the sea
  let start = -1;
  for (let k = 0; k < ring.n; k++) {
    const k1 = (k + 1) % ring.n;
    if (ring.land[k] >= 0.5 && ring.land[k1] < 0.5) {
      start = k;
      break;
    }
  }
  if (start >= 0) {
    const arcLen = Math.round(ring.n * 0.07);
    for (let j = 0; j < arcLen; j++) {
      const k = (start + j) % ring.n;
      const k1 = (start + j + 1) % ring.n;
      const r0 = ring.radius(k, 240);
      const r1 = ring.radius(k1, 240);
      const x0 = ring.x(k, r0);
      const z0 = ring.z(k, r0);
      const x1 = ring.x(k1, r1);
      const z1 = ring.z(k1, r1);
      const len = Math.hypot(x1 - x0, z1 - z0) + 2;
      const yaw = Math.atan2(x1 - x0, z1 - z0);
      setColor(b, '#7c7b78', albedo);
      addBox(b, (x0 + x1) / 2, sea + 0.5, (z0 + z1) / 2, yaw, 10, 6, len, 1);
      if (lights && j % 3 === 0) addLight(lights, x0, sea + 6, z0, 2.4, '#ffcf87');
      if (j === arcLen - 1) {
        setColor(b, '#efefef', albedo);
        addBox(b, x1, sea + 11, z1, yaw, 4.5, 20, 4.5, 1);
        setColor(b, '#c83a2c', albedo);
        addBox(b, x1, sea + 22.5, z1, yaw, 5.5, 3, 5.5, 1);
        if (lights) addLight(lights, x1, sea + 25.5, z1, 3.2, '#fff2c8');
      }
    }
  }
  // ships
  const placed: { x: number; z: number; r: number }[] = [];
  for (let attempt = 0; attempt < 120 && placed.length < 6; attempt++) {
    const theta = rng.range(0, TAU);
    if (landWeight(Math.cos(theta), Math.sin(theta), f.seaDirX, f.seaDirZ) > 0.08) continue;
    const len = rng.range(70, 150);
    const spot = polarSpot(ring, theta, rng.range(380, 1150), len / 2);
    if (!spot || overlaps(placed, spot.x, spot.z, len / 2, 1.2)) continue;
    placed.push({ x: spot.x, z: spot.z, r: len / 2 });
    const yaw = rng.range(0, TAU);
    const beam = len * rng.range(0.13, 0.17);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    setColor(b, rng.pick(['#7a2f2a', '#26344a', '#2b2b2e', '#3d4f3a']), albedo);
    addBox(b, spot.x, sea + 2, spot.z, yaw, beam, 8, len, 1);
    setColor(b, '#e9e9e6', albedo);
    const bridgeX = spot.x - fx * len * 0.38;
    const bridgeZ = spot.z - fz * len * 0.38;
    addBox(b, bridgeX, sea + 10, bridgeZ, yaw, beam * 0.9, 9, len * 0.14, 1);
    if (rng.next() < 0.7) {
      const rows = Math.floor(len / 14);
      for (let i = 0; i < rows; i++) {
        const along = -len * 0.25 + (i / Math.max(1, rows - 1)) * len * 0.62;
        setColor(b, rng.pick(['#b8432f', '#2f6aa8', '#d0a32a', '#4b8a4a', '#8d8f93']), albedo);
        addBox(b, spot.x + fx * along, sea + 7.5, spot.z + fz * along, yaw, beam * 0.86, rng.range(2.6, 5.2), 11, 1);
      }
    }
    if (lights) {
      addLight(lights, bridgeX, sea + 15.5, bridgeZ, 2.2, '#fff0d0');
      addLight(lights, spot.x + fx * len * 0.48, sea + 7, spot.z + fz * len * 0.48, 1.8, '#ffffff');
    }
  }
}
