/**
 * Biome scenery scattered around the circuit: instanced vegetation — 3–4 species per biome (temperate pine /
 * spruce / oak / bush, autumn maple / ginkgo / cedar / shrub, desert palm / cactus / agave / boulder, coastal palm /
 * stone pine / cypress / bush, city palm / plane tree / hedge), each one merged trunk + crown mesh with per-instance
 * crown colour (tint mask), scale / height / lean jitter. Crowns follow napali's plants: broadleaf crowns are lobed
 * envelopes of leaf clumps (crown-scale normals, baked interior occlusion), conifers stack drooping star-shaped branch
 * tiers, palms carry V-folded pinnate fronds in a rising and a drooping whorl; patchFoliage lights them (wrap,
 * translucency, wind sway), placed near the track, uniformly and in denser forest
 * clusters away from it (never inside the track corridor); shadow-casting species are split into spatial chunks so
 * views and the ±70 m shadow pass cull them. Plus merged city / coastal buildings with window textures (lit at
 * night) and harbour cranes near the water. Density scales with quality (low ≈ 25 %).
 */
import * as THREE from 'three';
import type { Biome, QualityLevel } from '../../core/types';
import { Rng } from '../core/canvas';
import { GeoBuilder, addBox, addGeometry } from '../core/geometry';
import { FOLIAGE_UV, foliageAtlasTexture, windowTexture } from '../core/surfaceTextures';
import { sidePoint, wrapIndex, type SceneryContext } from './context';
import { patchFoliage, patchWindowFade } from './sceneryMaterials';
import { chunkKey } from './sceneryMath';
import { townStyleFor } from './townscape';

/** Vegetation per km of track (before quality density) by biome. */
export const VEGETATION_PER_KM: Record<Biome, number> = { temperate: 420, autumn: 400, desert: 150, coastal: 240, city: 80, tropical: 460 };
/** Lusher planting on the richer qualities (multiplier of VEGETATION_PER_KM; woods instead of single trees on a lawn). */
export const VEGETATION_LUSH: Record<QualityLevel, number> = { low: 1, medium: 1.15, high: 1.5, ultra: 1.6 };
/** Most instanced plants per scene by quality: long circuits (7 km) would otherwise plant thousands more than a view can use. */
export const VEGETATION_MAX: Record<QualityLevel, number> = { low: 500, medium: 1500, high: 3600, ultra: 5200 };
/** Share of vegetation planted in forest clusters away from the track, by quality. */
export const CLUSTER_SHARE: Record<QualityLevel, number> = { low: 0.4, medium: 0.5, high: 0.55, ultra: 0.55 };
/** Trees per cluster (range) and cluster spread σ (m). */
export const CLUSTER_SIZE: readonly [number, number] = [18, 48];
export const CLUSTER_SPREAD: readonly [number, number] = [16, 46];
/** Cluster centres keep at least this far (m) beyond the occupied track corridor. */
export const CLUSTER_CLEARANCE = 25;
/**
 * Plants farther than this (m) beyond the occupied track corridor get the lighter build (one crown core, half the leaf
 * cards / frond pieces): no camera comes that close to them, and the scene keeps its triangle budget.
 */
export const VEGETATION_DETAIL_MARGIN = 60;
/** Spatial chunk edge (m) for shadow-casting species (0 = one mesh per species). */
export const VEGETATION_CHUNK: Record<QualityLevel, number> = { low: 0, medium: 1300, high: 1100, ultra: 950 };

export interface Species {
  name: string;
  /** relative frequency (track-side + uniform scatter) */
  weight: number;
  /** relative frequency inside forest clusters (0 = never) */
  cluster: number;
  build: (b: TintBuilder) => void;
  /** per-instance crown colours (tint-masked vertices) */
  crown: readonly string[];
  scale: readonly [number, number];
  /** keep this far from the occupied corridor (m) */
  clearance: number;
  shadow: boolean;
}

const TRUNK = '#5a3f2a';
const _col = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _x = new THREE.Vector3(1, 0, 0);
const _y = new THREE.Vector3(0, 1, 0);

/** Geometry builder with a per-vertex tint mask (1 = takes the instance colour) and crown shading gradient. */
export class TintBuilder {
  readonly geo = new GeoBuilder(true);
  readonly mask: number[] = [];

  /** `lite` = low quality, far plants and dense stands: crowns / tiers / fronds with roughly half the pieces */
  constructor(readonly lite = false) {}

  /** Tint mask `tint` for the vertices added directly to `geo` since `start` (the mask then covers every vertex). */
  mark(start: number, tint: number): void {
    for (let i = Math.max(start, this.mask.length); i < this.geo.vertexCount; i++) this.mask.push(tint);
  }

  /** Append `geom` (disposed) placed at (x, y, z) with optional Euler rotation and scale. */
  add(geom: THREE.BufferGeometry, color: string, tint: number, x: number, y: number, z: number, rot?: [number, number, number], scale?: [number, number, number]): void {
    const start = this.geo.vertexCount;
    this.geo.setColor(_col.set(color));
    _q.setFromEuler(_e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0));
    _m.compose(_v.set(x, y, z), _q, _s.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1));
    addGeometry(this.geo, geom, _m);
    geom.dispose();
    solidUv(this.geo, start);
    for (let i = start; i < this.geo.vertexCount; i++) this.mask.push(tint);
    if (tint >= 1) this.shade(start);
  }

  /** Darker underside → lighter top over the vertices added since `start` (cheap ambient occlusion). */
  private shade(start: number): void {
    const g = this.geo;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < g.vertexCount; i++) {
      lo = Math.min(lo, g.positions[i * 3 + 1]);
      hi = Math.max(hi, g.positions[i * 3 + 1]);
    }
    const span = Math.max(1e-3, hi - lo);
    for (let i = start; i < g.vertexCount; i++) {
      const k = 0.74 + 0.32 * ((g.positions[i * 3 + 1] - lo) / span);
      g.colors[i * 3] *= k;
      g.colors[i * 3 + 1] *= k;
      g.colors[i * 3 + 2] *= k;
    }
  }

  build(): THREE.BufferGeometry {
    const g = this.geo.build() ?? new THREE.BufferGeometry();
    g.setAttribute('tintMask', new THREE.Float32BufferAttribute(this.mask, 1));
    return g;
  }
}

const _hsl = { h: 0, s: 0, l: 0 };

/**
 * Per-instance colour jitter in sRGB lightness. (offsetHSL works in the linear working space, where a dark conifer green has
 * L ≈ 0.03: a −0.05 lightness offset pushed it below zero and the whole tree rendered pure black.)
 */
export function jitterColor(hex: string | THREE.Color, dh: number, ds: number, dl: number, out = new THREE.Color()): THREE.Color {
  out.set(hex as THREE.ColorRepresentation);
  out.getHSL(_hsl, THREE.SRGBColorSpace);
  return out.setHSL((_hsl.h + dh + 1) % 1, Math.min(1, Math.max(0, _hsl.s + ds)), Math.min(1, Math.max(0.04, _hsl.l + dl)), THREE.SRGBColorSpace);
}

const cyl = (rt: number, rb: number, h: number, seg: number, open = true): THREE.BufferGeometry => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
const ico = (r: number): THREE.BufferGeometry => new THREE.IcosahedronGeometry(r, 0);

/** Baked crown occlusion: brightness deep inside the crown and at its surface, and the underside darkening. */
export const CROWN_AO: readonly [number, number] = [0.42, 1.02];
export const CROWN_UNDERSIDE = 0.24;
/** Leaf cards per clump of the crown shape and their edge relative to the clump size. */
export const CROWN_CARDS_PER_CLUMP = 2.6;
export const CROWN_CARD_SCALE = 2.3;

/** A crown: leaf cards (`clumps` × CROWN_CARDS_PER_CLUMP, edge from `size`) in an ellipsoid at `c` with radii `r`. */
export interface CrownShape {
  c: readonly [number, number, number];
  r: readonly [number, number, number];
  clumps: number;
  size: readonly [number, number];
  /** lowest card direction (−1..1 of the envelope height below its centre): flat-bottomed crowns */
  under?: number;
  /** vertical squash of the dense core (tufted / umbrella crowns < 1) */
  flat?: number;
  /** atlas cell of the cards (needle sprays for pines) */
  cell?: 'leaf' | 'needle';
  seed: number;
}

/** Point every vertex added since `start` at the atlas's opaque block (trunks, tiers; the shadow pass samples it too). */
function solidUv(g: GeoBuilder, start: number): void {
  for (let i = start; i < g.vertexCount; i++) {
    g.uvs[i * 2] = FOLIAGE_UV.solid[0];
    g.uvs[i * 2 + 1] = FOLIAGE_UV.solid[1];
  }
}

/**
 * Crown of alpha-tested leaf cards around a small dense core (napali's broadleaf crowns: lobed envelopes of leaf
 * clusters with gaps between them). Every normal is the envelope's outward normal, so the crown lights as one soft
 * volume (patchFoliage keeps it on both card sides); vertex colours bake the interior and underside occlusion.
 * Lite (low quality) builds half the cards.
 */
export function addCrown(b: TintBuilder, s: CrownShape): void {
  const rng = new Rng(s.seed);
  const g = b.geo;
  const start = g.vertexCount;
  g.setColor(_col.set('#ffffff'));
  // dense core: the middle of the crown is never see-through
  const cores = b.lite ? 1 : 3;
  for (let i = 0; i < cores; i++) {
    const core = new THREE.IcosahedronGeometry(1, 0);
    _v.set(s.c[0] + rng.range(-0.25, 0.25) * s.r[0], s.c[1] + rng.range(-0.15, 0.2) * s.r[1], s.c[2] + rng.range(-0.25, 0.25) * s.r[2]);
    _q.setFromEuler(_e.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)));
    _m.compose(_v, _q, _s.set(s.r[0] * 0.6, s.r[1] * 0.6 * (s.flat ?? 1), s.r[2] * 0.6));
    addGeometry(g, core, _m);
    core.dispose();
  }
  solidUv(g, start);
  const cell = s.cell === 'needle' ? FOLIAGE_UV.needle : FOLIAGE_UV.leaf;
  const aspect = s.cell === 'needle' ? 2.3 : 1;
  const n = Math.max(4, Math.round(s.clumps * CROWN_CARDS_PER_CLUMP * (b.lite ? 0.5 : 1)));
  for (let i = 0; i < n; i++) {
    const u = Math.max(rng.range(-1, 1), -(s.under ?? 0.75));
    const th = rng.range(0, Math.PI * 2);
    const ring = Math.sqrt(Math.max(0, 1 - u * u));
    const radial = 0.35 + 0.65 * Math.sqrt(rng.next());
    _v.set(s.c[0] + Math.cos(th) * ring * s.r[0] * radial, s.c[1] + u * s.r[1] * radial, s.c[2] + Math.sin(th) * ring * s.r[2] * radial);
    const size = rng.range(s.size[0], s.size[1]) * CROWN_CARD_SCALE;
    // card plane: random, leaning toward facing outward (fewer edge-on cards seen from outside)
    _n.set(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize().lerp(_t.set(Math.cos(th) * ring, u, Math.sin(th) * ring), 0.5);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    const ax = Math.abs(_n.y) < 0.9 ? _y : _x;
    const t1 = _a.crossVectors(_n, ax).normalize();
    const t2 = _b.crossVectors(_n, t1).normalize();
    const rot = rng.range(0, Math.PI * 2);
    const ca = Math.cos(rot);
    const sa = Math.sin(rot);
    const hw = (size * aspect) / 2;
    const hh = size / 2;
    const flip = rng.next() < 0.5;
    const corners: [number, number, number, number][] = [
      [-1, -1, flip ? cell[2] : cell[0], cell[1]],
      [1, -1, flip ? cell[0] : cell[2], cell[1]],
      [1, 1, flip ? cell[0] : cell[2], cell[3]],
      [-1, 1, flip ? cell[2] : cell[0], cell[3]],
    ];
    const idx = corners.map(([x, y, cu, cv]) => {
      const lx = x * hw * ca - y * hh * sa;
      const ly = x * hw * sa + y * hh * ca;
      return g.vertex(_v.x + t1.x * lx + t2.x * ly, _v.y + t1.y * lx + t2.y * ly, _v.z + t1.z * lx + t2.z * ly, 0, 1, 0, cu, cv);
    });
    g.quad(idx[0], idx[1], idx[2], idx[3]);
  }
  shadeCrown(b, start, s.c, s.r);
  b.mark(start, 1);
}

/** Envelope normals and baked occlusion for the crown vertices from `start` (see addCrown). */
function shadeCrown(b: TintBuilder, start: number, c: readonly [number, number, number], r: readonly [number, number, number]): void {
  const g = b.geo;
  for (let i = start; i < g.vertexCount; i++) {
    const qx = (g.positions[i * 3] - c[0]) / r[0];
    const qy = (g.positions[i * 3 + 1] - c[1]) / r[1];
    const qz = (g.positions[i * 3 + 2] - c[2]) / r[2];
    const d = Math.hypot(qx, qy, qz);
    _n.set(qx / r[0], qy / r[1], qz / r[2]);
    if (_n.lengthSq() < 1e-9) _n.set(0, 1, 0);
    _n.normalize();
    g.normals[i * 3] = _n.x;
    g.normals[i * 3 + 1] = _n.y;
    g.normals[i * 3 + 2] = _n.z;
    const depth = THREE.MathUtils.smoothstep(d, 0.35, 1.0);
    const under = Math.min(1, Math.max(0, (qy + 1) / 2));
    const k = (CROWN_AO[0] + (CROWN_AO[1] - CROWN_AO[0]) * depth) * (1 - CROWN_UNDERSIDE + CROWN_UNDERSIDE * under);
    g.colors[i * 3] *= k;
    g.colors[i * 3 + 1] *= k;
    g.colors[i * 3 + 2] *= k;
  }
}

/**
 * Conifer branch tiers: star-shaped drooping skirts (`points` branch tips, notched between them) from `y0` up to the
 * spire at `top`, radius shrinking from `r0` to `r1`, closed underneath. Normals lean outward from the stem.
 */
export function addConiferTiers(b: TintBuilder, y0: number, top: number, r0: number, r1: number, tiers: number, points: number, seed: number): void {
  const rng = new Rng(seed);
  const g = b.geo;
  const start = g.vertexCount;
  const n = Math.max(2, b.lite ? Math.ceil(tiers / 2) : tiers);
  const step = (top - y0) / (n + 0.6);
  for (let t = 0; t < n; t++) {
    const k = t / Math.max(1, n - 1);
    const rad = (r0 + (r1 - r0) * k) * (b.lite ? 1.1 : 1);
    const base = y0 + t * step;
    const h = step * 1.9;
    const droop = rad * 0.32;
    const rot = rng.range(0, Math.PI * 2);
    const apex = g.vertex(0, base + h, 0, 0, 1, 0, FOLIAGE_UV.solid[0], FOLIAGE_UV.solid[1]);
    g.colors[apex * 3] = g.colors[apex * 3 + 1] = g.colors[apex * 3 + 2] = 0.62;
    const ring: number[] = [];
    const m = points * 2;
    for (let i = 0; i < m; i++) {
      const tip = i % 2 === 0;
      const a = rot + (i / m) * Math.PI * 2 + rng.range(-0.08, 0.08);
      const rr = rad * (tip ? rng.range(0.9, 1.08) : 0.58);
      const y = base - (tip ? droop : droop * 0.35);
      _n.set(Math.cos(a), 0.55, Math.sin(a)).normalize();
      const v = g.vertex(Math.cos(a) * rr, y, Math.sin(a) * rr, _n.x, _n.y, _n.z, FOLIAGE_UV.solid[0], FOLIAGE_UV.solid[1]);
      const shade = tip ? 1.02 : 0.74;
      g.colors[v * 3] = g.colors[v * 3 + 1] = g.colors[v * 3 + 2] = shade;
      ring.push(v);
    }
    for (let i = 0; i < m; i++) g.tri(apex, ring[(i + 1) % m], ring[i]);
    // underside: a shallow dark cone back to the stem
    const under = g.vertex(0, base + h * 0.22, 0, 0, -1, 0, FOLIAGE_UV.solid[0], FOLIAGE_UV.solid[1]);
    g.colors[under * 3] = g.colors[under * 3 + 1] = g.colors[under * 3 + 2] = 0.34;
    const ringU: number[] = [];
    for (let i = 0; i < m; i++) {
      const src = ring[i];
      const v = g.vertex(g.positions[src * 3], g.positions[src * 3 + 1], g.positions[src * 3 + 2], 0, -1, 0, FOLIAGE_UV.solid[0], FOLIAGE_UV.solid[1]);
      g.colors[v * 3] = g.colors[v * 3 + 1] = g.colors[v * 3 + 2] = 0.5;
      ringU.push(v);
    }
    for (let i = 0; i < m; i++) g.tri(under, ringU[i], ringU[(i + 1) % m]);
    // needle sprays hanging along every branch tip (feathery silhouette)
    if (!b.lite) {
      const [u0, v0, u1, v1] = FOLIAGE_UV.needle;
      const sprayFrom = g.vertexCount;
      for (let i = 0; i < m; i += 2) {
        const tip = ring[i];
        const tx = g.positions[tip * 3];
        const ty = g.positions[tip * 3 + 1];
        const tz = g.positions[tip * 3 + 2];
        const len = Math.hypot(tx, tz);
        if (len < 1e-3) continue;
        const dx = tx / len;
        const dz = tz / len;
        const w = rad * 0.32;
        const r0 = rad * 0.12;
        const r1 = len * 1.12;
        const y0 = base + h * 0.35;
        const y1 = ty - droop * 0.25;
        _n.set(dx, 0.7, dz).normalize();
        const a = g.vertex(dx * r0 - dz * w * 0.5, y0, dz * r0 + dx * w * 0.5, _n.x, _n.y, _n.z, u0, v1);
        const b2 = g.vertex(dx * r1 - dz * w, y1, dz * r1 + dx * w, _n.x, _n.y, _n.z, u1, v1);
        const c2 = g.vertex(dx * r1 + dz * w, y1, dz * r1 - dx * w, _n.x, _n.y, _n.z, u1, v0);
        const d = g.vertex(dx * r0 + dz * w * 0.5, y0, dz * r0 - dx * w * 0.5, _n.x, _n.y, _n.z, u0, v0);
        g.quad(a, b2, c2, d);
      }
      for (let i = sprayFrom; i < g.vertexCount; i++) g.colors[i * 3] = g.colors[i * 3 + 1] = g.colors[i * 3 + 2] = 0.95;
    }
  }
  b.mark(start, 1);
}

/** Frond layout of a palm crown. */
export interface FrondShape {
  /** crown point the fronds radiate from */
  top: readonly [number, number, number];
  /** fronds per whorl: [rising, drooping] */
  count: readonly [number, number];
  /** frond length (m) and the widest leaflet span each side (m) */
  length: number;
  width: number;
  /** start elevation (rad) and droop (curvature) of the rising / drooping whorl */
  rise: readonly [number, number];
  droop: readonly [number, number];
  seed: number;
}

/**
 * Pinnate fronds (napali's palms: parabolic rachis, leaflets hanging in a V, upper whorl rising, lower hanging): each
 * frond is a V-folded strip along a curved rachis, widest mid-way, the leaflet edges hanging below it, with a slightly
 * notched outline. Double-sided material. Older (lower) fronds are a touch yellower.
 */
export function addFronds(b: TintBuilder, s: FrondShape): void {
  const rng = new Rng(s.seed);
  const g = b.geo;
  const start = g.vertexCount;
  const seg = b.lite ? 3 : 5;
  for (let whorl = 0; whorl < 2; whorl++) {
    const count = Math.max(2, Math.round(s.count[whorl] * (b.lite ? 0.6 : 1)));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + whorl * (Math.PI / count) + rng.range(-0.15, 0.15);
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const sx = -dz;
      const sz = dx;
      const len = s.length * rng.range(0.85, 1.1) * (whorl === 1 ? 1.08 : 1);
      const e0 = s.rise[whorl] + rng.range(-0.12, 0.12);
      const dr = s.droop[whorl] * rng.range(0.85, 1.15);
      const twist = rng.range(-0.25, 0.25);
      const tone = whorl === 1 ? [1.06, 1.0, 0.78] : [1, 1, 1];
      const rows: number[][] = [];
      for (let j = 0; j <= seg; j++) {
        const t = j / seg;
        const hd = len * t * Math.cos(e0 * (1 - 0.5 * t));
        const y = len * (Math.sin(e0) * t - dr * t * t);
        const px = s.top[0] + dx * hd;
        const py = s.top[1] + y;
        const pz = s.top[2] + dz * hd;
        // the atlas frond carries the leaflet outline: the strip only tapers gently toward root and tip
        const w = s.width * (0.35 + 0.65 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + t * 0.92)), 0.5));
        const fu = FOLIAGE_UV.frond[0] + (FOLIAGE_UV.frond[2] - FOLIAGE_UV.frond[0]) * (0.01 + 0.98 * t);
        const fv = (FOLIAGE_UV.frond[1] + FOLIAGE_UV.frond[3]) / 2;
        const fs = (FOLIAGE_UV.frond[3] - FOLIAGE_UV.frond[1]) * 0.47;
        const hang = w * 0.48;
        const tw = twist * t;
        const shade = 0.68 + 0.36 * t;
        const col = (v: number): void => {
          g.colors[v * 3] = shade * tone[0];
          g.colors[v * 3 + 1] = shade * tone[1];
          g.colors[v * 3 + 2] = shade * tone[2];
        };
        const mid = g.vertex(px, py, pz, 0, 1, 0, fu, fv);
        const left = g.vertex(px + sx * w, py - hang + tw * w, pz + sz * w, 0, 1, 0, fu, fv + fs);
        const right = g.vertex(px - sx * w, py - hang - tw * w, pz - sz * w, 0, 1, 0, fu, fv - fs);
        col(mid);
        col(left);
        col(right);
        rows.push([mid, left, right]);
      }
      for (let j = 0; j < seg; j++) {
        const [m0, l0, r0] = rows[j];
        const [m1, l1, r1] = rows[j + 1];
        g.quad(m0, l0, l1, m1);
        g.quad(m0, m1, r1, r0);
      }
    }
  }
  // face normals of the strips, then lean them toward the crown's outward direction (soft crown lighting)
  smoothNormals(g, start);
  for (let i = start; i < g.vertexCount; i++) {
    _n.set(g.positions[i * 3] - s.top[0], (g.positions[i * 3 + 1] - s.top[1]) * 0.6 + 0.6, g.positions[i * 3 + 2] - s.top[2]).normalize();
    _t.set(g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]);
    // double-sided: keep the strip normal's side, lean it outward
    if (_t.dot(_n) < 0) _t.negate();
    _t.lerp(_n, 0.45).normalize();
    g.normals[i * 3] = _t.x;
    g.normals[i * 3 + 1] = _t.y;
    g.normals[i * 3 + 2] = _t.z;
  }
  b.mark(start, 1);
}

/** Area-weighted vertex normals for the triangles indexing vertices from `start`. */
function smoothNormals(g: GeoBuilder, start: number): void {
  for (let i = start * 3; i < g.normals.length; i++) g.normals[i] = 0;
  const p = g.positions;
  for (let i = 0; i < g.indices.length; i += 3) {
    const a = g.indices[i];
    const c1 = g.indices[i + 1];
    const c2 = g.indices[i + 2];
    if (a < start) continue;
    const ux = p[c1 * 3] - p[a * 3];
    const uy = p[c1 * 3 + 1] - p[a * 3 + 1];
    const uz = p[c1 * 3 + 2] - p[a * 3 + 2];
    const vx = p[c2 * 3] - p[a * 3];
    const vy = p[c2 * 3 + 1] - p[a * 3 + 1];
    const vz = p[c2 * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const k of [a, c1, c2]) {
      g.normals[k * 3] += nx;
      g.normals[k * 3 + 1] += ny;
      g.normals[k * 3 + 2] += nz;
    }
  }
  for (let i = start; i < g.vertexCount; i++) {
    _t.set(g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]);
    if (_t.lengthSq() < 1e-12) _t.set(0, 1, 0);
    _t.normalize();
    g.normals[i * 3] = _t.x;
    g.normals[i * 3 + 1] = _t.y;
    g.normals[i * 3 + 2] = _t.z;
  }
}

/** A few bare limbs from the trunk top into the crown (seen through the gaps between clumps). */
function addLimbs(b: TintBuilder, color: string, from: number, to: number, spread: number, n: number, seed: number): void {
  const rng = new Rng(seed);
  for (let i = 0; i < (b.lite ? 0 : n); i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const len = (to - from) * rng.range(0.9, 1.2);
    const tilt = Math.atan2(spread, to - from) * rng.range(0.8, 1.15);
    const g = cyl(0.05, 0.12, len, 4).translate(0, len / 2, 0);
    b.add(g, color, 0, 0, from, 0, [Math.sin(a) * tilt, 0, -Math.cos(a) * tilt]);
  }
}

function pine(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'pine',
    weight,
    cluster,
    crown,
    scale: [0.8, 1.35],
    clearance: 4,
    shadow: true,
    build: (b) => {
      // tall bare trunk, a high tufted crown of flattened needle clumps (Scots / maritime pine)
      b.add(cyl(0.13, 0.24, 6.2, 6), '#6a4a34', 0, 0, 3.1, 0);
      addLimbs(b, '#5e4330', 4.4, 6.6, 1.6, 4, 31);
      addCrown(b, { c: [0, 7.2, 0], r: [2.3, 1.7, 2.3], clumps: 20, size: [0.7, 1.0], under: 0.45, flat: 0.55, cell: 'needle', seed: 32 });
    },
  };
}

function spruce(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'spruce',
    weight,
    cluster,
    crown,
    scale: [0.85, 1.45],
    clearance: 4,
    shadow: true,
    build: (b) => {
      b.add(cyl(0.1, 0.22, 2.0, 6), TRUNK, 0, 0, 1.0, 0);
      addConiferTiers(b, 0.7, 9.4, 2.2, 0.45, 7, 7, 41);
    },
  };
}

function broadleaf(name: string, crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name,
    weight,
    cluster,
    crown,
    scale: [0.8, 1.3],
    clearance: 5,
    shadow: true,
    build: (b) => {
      b.add(cyl(0.18, 0.32, 3.4, 6), TRUNK, 0, 0, 1.7, 0);
      addLimbs(b, '#4f3826', 2.8, 5.2, 2.0, 4, hashName(name));
      addCrown(b, { c: [0, 5.4, 0], r: [3.0, 2.5, 3.0], clumps: 18, size: [0.9, 1.45], under: 0.6, seed: hashName(name) + 1 });
    },
  };
}

function ginkgo(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'ginkgo',
    weight,
    cluster,
    crown,
    scale: [0.85, 1.3],
    clearance: 4,
    shadow: true,
    build: (b) => {
      b.add(cyl(0.15, 0.26, 3.6, 6), '#6b5440', 0, 0, 1.8, 0);
      addLimbs(b, '#5e4a38', 3.0, 5.4, 1.2, 3, 51);
      addCrown(b, { c: [0, 5.6, 0], r: [1.9, 2.7, 1.9], clumps: 14, size: [0.7, 1.1], under: 0.7, seed: 52 });
    },
  };
}

function bush(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'bush',
    weight,
    cluster,
    crown,
    scale: [0.6, 1.4],
    clearance: 3,
    shadow: false,
    build: (b) => addCrown(b, { c: [0, 0.75, 0], r: [1.35, 0.85, 1.15], clumps: 8, size: [0.45, 0.75], under: 0.35, seed: 61 }),
  };
}

function boulder(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'boulder',
    weight,
    cluster,
    crown,
    scale: [0.5, 2.2],
    clearance: 3,
    shadow: true,
    build: (b) => b.add(ico(1.2), '#ffffff', 1, 0, 0.3, 0, [0.2, 0, 0.1], [1.3, 0.62, 1.0]),
  };
}

/** Curved palm trunk: stacked tapering segments with darker leaf-scar rings. */
function palmTrunk(b: TintBuilder, height: number, r0: number, r1: number, lean: number, color: string): readonly [number, number, number] {
  const n = b.lite ? 2 : 5;
  let x = 0;
  let y = 0;
  const seg = height / n;
  const ring = new THREE.Color(color).multiplyScalar(0.72).getHexString();
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const r = r0 + (r1 - r0) * t;
    const tilt = lean * (0.4 + t);
    b.add(cyl(r * 0.96, r, seg * 1.02, 7), i % 2 === 0 ? color : `#${ring}`, 0, x + Math.sin(tilt) * seg * 0.5, y + seg * 0.5, 0, [0, 0, -tilt]);
    x += Math.sin(tilt) * seg;
    y += Math.cos(tilt) * seg;
  }
  return [x, y, 0];
}

function palm(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'palm',
    weight,
    cluster,
    crown,
    scale: [0.85, 1.25],
    clearance: 4,
    shadow: true,
    build: (b) => {
      const top = palmTrunk(b, 8.2, 0.26, 0.17, 0.06, '#7a6248');
      b.add(new THREE.IcosahedronGeometry(0.32, 0), '#4a3a22', 0, top[0], top[1] - 0.15, top[2], [0, 0, 0], [1.2, 0.8, 1.2]);
      addFronds(b, { top, count: [8, 7], length: 3.6, width: 0.8, rise: [0.85, 0.3], droop: [0.55, 1.05], seed: 71 });
    },
  };
}

/** Oil palm: stout ringed trunk, dense crown of long arching pinnate fronds, fruit bunch under the crown. */
export function oilPalm(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'oilPalm',
    weight,
    cluster,
    crown,
    scale: [0.9, 1.2],
    clearance: 4,
    shadow: true,
    build: (b) => {
      const top = palmTrunk(b, 7.6, 0.42, 0.32, 0.02, '#6f5a44');
      b.add(new THREE.ConeGeometry(0.62, 0.9, 6, 1, true), '#7a4a2a', 0, top[0] + 0.05, top[1] - 0.4, top[2], [Math.PI, 0, 0]);
      addFronds(b, { top: [top[0], top[1] + 0.2, top[2]], count: [10, 9], length: 4.6, width: 1.0, rise: [0.95, 0.35], droop: [0.6, 1.0], seed: 81 });
    },
  };
}

/** Rainforest emergent tree: tall buttressed trunk and a wide, flat, layered crown. */
function rainTree(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'rainTree',
    weight,
    cluster,
    crown,
    scale: [0.85, 1.35],
    clearance: 6,
    shadow: true,
    build: (b) => {
      b.add(cyl(0.32, 0.75, 7.0, 7), '#6b5646', 0, 0, 3.5, 0);
      addLimbs(b, '#5b4838', 6.0, 8.6, 3.4, 5, 91);
      addCrown(b, { c: [0, 8.9, 0], r: [4.6, 1.7, 4.6], clumps: 22, size: [1.0, 1.7], under: 0.25, seed: 92 });
    },
  };
}

/** Banana-like broad-leaf shrub: a fan of big V-folded leaves. */
function broadLeafShrub(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'broadLeafShrub',
    weight,
    cluster,
    crown,
    scale: [0.7, 1.3],
    clearance: 3,
    shadow: false,
    build: (b) => {
      b.add(cyl(0.08, 0.12, 0.9, 5), '#6a7a3a', 0, 0, 0.45, 0);
      addFronds(b, { top: [0, 0.85, 0], count: [4, 4], length: 1.9, width: 0.5, rise: [1.1, 0.6], droop: [0.9, 1.1], seed: 101 });
    },
  };
}

function stonePine(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'stonePine',
    weight,
    cluster,
    crown,
    scale: [0.85, 1.25],
    clearance: 5,
    shadow: true,
    build: (b) => {
      b.add(cyl(0.16, 0.28, 6.4, 6), '#6a4a34', 0, 0.26, 3.2, 0, [0, 0, -0.08]);
      addLimbs(b, '#5e4330', 5.2, 6.9, 2.6, 4, 111);
      addCrown(b, { c: [0.5, 7.2, 0], r: [3.6, 1.15, 3.6], clumps: 16, size: [0.9, 1.4], under: 0.3, flat: 0.6, seed: 112 });
    },
  };
}

function cypress(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'cypress',
    weight,
    cluster,
    crown,
    scale: [0.85, 1.35],
    clearance: 3,
    shadow: true,
    build: (b) => {
      b.add(cyl(0.12, 0.16, 1.2, 5), TRUNK, 0, 0, 0.6, 0);
      addCrown(b, { c: [0, 4.4, 0], r: [1.0, 3.7, 1.0], clumps: 14, size: [0.5, 0.8], under: 0.95, seed: 121 });
    },
  };
}

function hashName(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003;
  return h;
}

function cactus(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'cactus',
    weight,
    cluster,
    crown,
    scale: [0.7, 1.3],
    clearance: 3,
    shadow: true,
    build: (b) => {
      b.add(cyl(0.3, 0.34, 4.0, 7), '#ffffff', 1, 0, 2.0, 0);
      b.add(new THREE.ConeGeometry(0.3, 0.3, 7, 1, true), '#ffffff', 1, 0, 4.15, 0);
      b.add(cyl(0.17, 0.17, 0.55, 5), '#ffffff', 1, 0.45, 2.1, 0, [0, 0, Math.PI / 2]);
      b.add(cyl(0.17, 0.17, 1.3, 5), '#ffffff', 1, 0.72, 2.7, 0);
      b.add(new THREE.ConeGeometry(0.17, 0.2, 5, 1, true), '#ffffff', 1, 0.72, 3.45, 0);
      b.add(cyl(0.15, 0.15, 0.45, 5), '#ffffff', 1, -0.4, 1.6, 0, [0, 0, Math.PI / 2]);
      b.add(cyl(0.15, 0.15, 1.0, 5), '#ffffff', 1, -0.62, 2.05, 0);
      b.add(new THREE.ConeGeometry(0.15, 0.18, 5, 1, true), '#ffffff', 1, -0.62, 2.64, 0);
    },
  };
}

function agave(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'agave',
    weight,
    cluster,
    crown,
    scale: [0.7, 1.4],
    clearance: 3,
    shadow: false,
    build: (b) => {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const tilt = 0.45 + (i % 3) * 0.18;
        const len = 1.3 + (i % 2) * 0.35;
        const g = new THREE.ConeGeometry(0.12, len, 3, 1, true).translate(0, len / 2, 0);
        b.add(g, '#ffffff', 1, 0, 0, 0, [Math.cos(a) * tilt, 0, -Math.sin(a) * tilt]);
      }
    },
  };
}

export function speciesFor(biome: Biome): Species[] {
  switch (biome) {
    case 'desert':
      return [
        palm(['#3f7a2e', '#4c8a33', '#5a8f3a'], 0.6, 0.8),
        cactus(['#4f7a3a', '#5d8a43', '#466b33', '#57803d'], 1.2, 0.4),
        agave(['#7d8f5a', '#6f8452', '#8a9a62'], 0.9, 0.5),
        boulder(['#a8784f', '#b98a5e', '#94693f', '#b07f55'], 1.3, 0.6),
      ];
    case 'autumn':
      return [
        broadleaf('maple', ['#c0392b', '#d35400', '#e67e22', '#a93226', '#b9472a', '#d4692a'], 1.6, 1.0),
        ginkgo(['#e2b23a', '#d9a72e', '#f1c40f', '#caa036', '#e8c25a'], 0.9, 0.6),
        spruce(['#244a2e', '#2a4f30', '#1f4228'], 0.8, 1.2),
        bush(['#9a5b2a', '#b5651d', '#6e7a33', '#8a4a2a'], 0.8, 0.3),
      ];
    case 'coastal':
      return [
        palm(['#3f7a2e', '#4c8a33', '#356b29', '#5a8f3a'], 1.1, 0.6),
        stonePine(['#3d5f2c', '#46682f', '#355426'], 1.0, 1.0),
        cypress(['#2b4a2a', '#2f5230', '#263f25'], 0.8, 1.2),
        bush(['#5e7f3a', '#6f8f45', '#7d8f4a'], 0.9, 0.3),
      ];
    case 'tropical':
      return [
        oilPalm(['#3f7a2e', '#4a8a30', '#356b29', '#5a9a3a'], 1.5, 0.6),
        rainTree(['#2f6a26', '#3a7a2c', '#2a5e24', '#46862f'], 1.1, 1.3),
        broadleaf('mangosteen', ['#3a7a2a', '#4a8a32', '#2f6a25', '#5a9038'], 0.9, 0.9),
        broadLeafShrub(['#4f9a35', '#5aa83c', '#3f8a30'], 0.8, 0.5),
      ];
    case 'city':
      return [
        palm(['#3f7a2e', '#4c8a33', '#356b29'], 0.7, 0.5),
        broadleaf('planeTree', ['#4f7d33', '#5d8c3a', '#6b8f3d'], 0.6, 0.5),
        bush(['#4b7330', '#5e7f3a'], 0.4, 0.3),
      ];
    default:
      return [
        pine(['#2f5a32', '#2a5230', '#36643a', '#2d4f2c', '#3b6a3c'], 1.0, 1.2),
        spruce(['#244a2e', '#28512f', '#1f4228', '#2d5634'], 0.8, 1.4),
        broadleaf('oak', ['#3f6f2a', '#4d7f31', '#5a8a3a', '#355f25', '#45752f'], 1.3, 0.8),
        bush(['#4b7330', '#5a8038', '#3f6a2a'], 0.9, 0.25),
      ];
  }
}

const atlases = new WeakMap<SceneryContext, THREE.Texture>();

/** The scene's foliage atlas (built once per scenery context, disposed with it). */
export function foliageAtlas(ctx: SceneryContext): THREE.Texture {
  let tex = atlases.get(ctx);
  if (!tex) {
    tex = ctx.disposer.add(foliageAtlasTexture(ctx.anisotropy));
    atlases.set(ctx, tex);
  }
  return tex;
}

/**
 * Vegetation material: the foliage atlas (alpha-tested leaf cards, alpha to coverage under MSAA) × vertex colours ×
 * tint-masked instance colour, double-sided, with the canopy light model (patchFoliage).
 */
export function foliageMaterial(name: string, atlas: THREE.Texture): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ name, vertexColors: true, side: THREE.DoubleSide, map: atlas, alphaTest: 0.5, alphaToCoverage: true });
  patchFoliage(mat);
  return mat;
}

function buildingsFor(biome: Biome): number {
  return biome === 'city' ? 140 : biome === 'coastal' ? 40 : biome === 'desert' ? 10 : 6;
}

export function pickWeighted<T>(rng: Rng, items: readonly T[], weight: (t: T) => number): number {
  const total = items.reduce((a, t) => a + Math.max(0, weight(t)), 0);
  let r = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weight(items[i]));
    if (r <= 0) return i;
  }
  return items.length - 1;
}

export function buildProps(
  ctx: SceneryContext,
  heightAtXZ: (x: number, z: number) => number,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  seaLevel: number | null,
): THREE.Group {
  const { track: t, frame: f, disposer } = ctx;
  const group = new THREE.Group();
  group.name = 'props';
  const rng = new Rng(ctx.seed + 9001);
  const species = speciesFor(ctx.biome);
  const buildings = buildingsFor(ctx.biome);
  const density = Math.max(0.05, ctx.quality.propDensity);
  const total = Math.min(VEGETATION_MAX[ctx.quality.level] ?? 2200, Math.round((t.length / 1000) * (VEGETATION_PER_KM[ctx.biome] ?? 300) * (VEGETATION_LUSH[ctx.quality.level] ?? 1) * density));
  const excluded = (x: number, z: number, r: number): boolean => ctx.exclusions.some((e) => (e.x - x) ** 2 + (e.z - z) ** 2 < (e.r + r) ** 2);
  const inBounds = (x: number, z: number): boolean => x > bounds.minX + 30 && x < bounds.maxX - 30 && z > bounds.minZ + 30 && z < bounds.maxZ - 30;

  // ── buildings (merged, vertex-tinted, windows) ──
  const bld = new GeoBuilder(true);
  const placed: { x: number; z: number; r: number }[] = [];
  // (circuits with a townscape style get their continuous frontage from townscape.ts instead)
  const nB = townStyleFor(ctx) ? 0 : Math.round(buildings * (0.4 + 0.6 * density));
  const tint = new THREE.Color();
  for (let attempt = 0; attempt < nB * 6 && placed.length < nB; attempt++) {
    const k = rng.int(0, t.count - 1);
    const side = rng.next() < 0.5 ? -1 : 1;
    if (f.inPit[k] && side === f.pitSign) continue;
    const city = ctx.biome === 'city';
    const w = city ? rng.range(12, 34) : rng.range(8, 16);
    const d = city ? rng.range(12, 30) : rng.range(8, 14);
    const h = city ? rng.range(10, 58) : rng.range(5, 11);
    const r = Math.hypot(w, d) / 2;
    const dist = f.occupiedTo(k, side) + r + (city ? rng.range(4, 50) : rng.range(25, 140));
    const _p = sidePoint(t, k, side * dist, 0, new THREE.Vector3());
    if (!inBounds(_p.x, _p.z) || excluded(_p.x, _p.z, r)) continue;
    if (placed.some((p) => (p.x - _p.x) ** 2 + (p.z - _p.z) ** 2 < (p.r + r + 3) ** 2)) continue;
    const yaw = Math.atan2(t.tx[k], t.tz[k]) + (rng.next() < 0.3 ? rng.range(-0.3, 0.3) : 0);
    let clear = true;
    for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
      const lx = (cx * w) / 2;
      const lz = (cz * d) / 2;
      const x = _p.x + lx * Math.cos(yaw) + lz * Math.sin(yaw);
      const z = _p.z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
      if (!f.isClear(x, z, 3)) clear = false;
    }
    if (!clear) continue;
    const g = heightAtXZ(_p.x, _p.z);
    if (seaLevel !== null && g < seaLevel + 0.8) continue;
    tint.set(rng.pick(city ? ['#d9d6cf', '#b8bcc4', '#e8e2d4', '#a7b0bb', '#cfc6b8'] : ['#f4f1ea', '#efe6d6', '#f7f4ee']));
    bld.setColor(tint);
    // UVs in metres: 16 m per window-texture tile horizontally, 24 m vertically
    const before = bld.vertexCount;
    addBox(bld, _p.x, g - 1 + (h + 1) / 2, _p.z, yaw, w, h + 1, d, 1);
    for (let i = before; i < bld.vertexCount; i++) {
      const ny = bld.normals[i * 3 + 1];
      if (ny > 0.5) {
        bld.uvs[i * 2] = 0.01;
        bld.uvs[i * 2 + 1] = 0.01;
      } else {
        bld.uvs[i * 2] /= 16;
        bld.uvs[i * 2 + 1] /= 24;
      }
    }
    placed.push({ x: _p.x, z: _p.z, r });
    ctx.exclusions.push({ x: _p.x, z: _p.z, r: r + 2 });
  }
  const bg = bld.build();
  if (bg) {
    disposer.add(bg);
    const day = disposer.add(windowTexture(false));
    const mat = new THREE.MeshStandardMaterial({ name: 'buildings', map: day, vertexColors: true, roughness: 0.8 });
    if (ctx.timeOfDay !== 'day') {
      mat.emissiveMap = disposer.add(windowTexture(true));
      mat.emissive.setRGB(1, 1, 1);
      mat.emissiveIntensity = ctx.timeOfDay === 'night' ? 1.1 : 0.45;
    }
    patchWindowFade(mat);
    disposer.add(mat);
    const mesh = new THREE.Mesh(bg, mat);
    mesh.name = 'buildings';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ── harbour cranes on the shoreline (city / coastal) ──
  if (seaLevel !== null && ctx.biome === 'city') {
    const cranes = new GeoBuilder(true);
    const spots: { x: number; z: number }[] = [];
    for (let a = 0; a < 600 && spots.length < 5; a++) {
      const x = rng.range(bounds.minX + 60, bounds.maxX - 60);
      const z = rng.range(bounds.minZ + 60, bounds.maxZ - 60);
      const g = heightAtXZ(x, z);
      if (g < seaLevel + 0.6 || g > seaLevel + 4) continue;
      if (!f.isClear(x, z, 30) || excluded(x, z, 12)) continue;
      if (spots.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 70 * 70)) continue;
      spots.push({ x, z });
      const yaw = rng.range(0, Math.PI * 2);
      const c = new THREE.Color(rng.next() < 0.5 ? '#d23c2c' : '#e8b923');
      const white = new THREE.Color('#e9e9e9');
      cranes.setColor(c);
      for (const [lx, lz] of [[-5, -5], [5, -5], [5, 5], [-5, 5]]) {
        const px = x + lx * Math.cos(yaw) + lz * Math.sin(yaw);
        const pz = z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
        addBox(cranes, px, g + 9, pz, yaw, 0.9, 18, 0.9, 1);
      }
      addBox(cranes, x, g + 19, z, yaw, 12, 2.2, 12, 1);
      cranes.setColor(white);
      addBox(cranes, x, g + 27, z, yaw, 3, 14, 3, 1);
      cranes.setColor(c);
      addBox(cranes, x + Math.sin(yaw) * 16, g + 34, z + Math.cos(yaw) * 16, yaw, 2.2, 2.2, 56, 1);
      cranes.setColor(new THREE.Color('#3a3d42'));
      addBox(cranes, x - Math.sin(yaw) * 14, g + 33, z - Math.cos(yaw) * 14, yaw, 4, 4, 5, 1);
      ctx.exclusions.push({ x, z, r: 14 });
    }
    const cg = cranes.build();
    if (cg) {
      disposer.add(cg);
      const mat = disposer.add(new THREE.MeshStandardMaterial({ name: 'cranes', vertexColors: true, roughness: 0.6, metalness: 0.3 }));
      const mesh = new THREE.Mesh(cg, mat);
      mesh.name = 'cranes';
      mesh.castShadow = true;
      group.add(mesh);
    }
  }

  // ── instanced vegetation ──
  // keys: spatial chunk × 2 + 1 for the lighter far build
  const instances: { matrices: THREE.Matrix4[]; colors: THREE.Color[]; keys: number[] }[] = species.map(() => ({ matrices: [], colors: [], keys: [] }));
  const lite = ctx.quality.level === 'low';
  const chunk = VEGETATION_CHUNK[ctx.quality.level] ?? 0;
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const tryPlant = (si: number, x: number, z: number): boolean => {
    const sp = species[si];
    if (!inBounds(x, z) || excluded(x, z, 2)) return false;
    if (!f.isClear(x, z, sp.clearance)) return false;
    const g = heightAtXZ(x, z);
    if (!Number.isFinite(g)) return false;
    if (seaLevel !== null && g < seaLevel + 0.6) return false;
    const s = rng.range(sp.scale[0], sp.scale[1]);
    const q = new THREE.Quaternion().setFromAxisAngle(up, rng.range(0, Math.PI * 2));
    // slight lean for trees (not for boulders / shrubs that hug the ground)
    if (sp.shadow) q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.05, 0.05), 0, rng.range(-0.05, 0.05))));
    const list = instances[si];
    list.matrices.push(new THREE.Matrix4().compose(pos.set(x, g - 0.15, z), q, new THREE.Vector3(s, s * rng.range(0.88, 1.15), s)));
    list.colors.push(jitterColor(rng.pick(sp.crown), rng.range(-0.015, 0.015), rng.range(-0.06, 0.06), rng.range(-0.05, 0.05)));
    const far = !lite && f.isClear(x, z, VEGETATION_DETAIL_MARGIN);
    list.keys.push((sp.shadow ? chunkKey(x, z, bounds.minX, bounds.minZ, chunk) : 0) * 2 + (far ? 1 : 0));
    return true;
  };
  // forest clusters away from the track
  const clustered = Math.round(total * (CLUSTER_SHARE[ctx.quality.level] ?? 0.4));
  let planted = 0;
  if (species.some((sp) => sp.cluster > 0)) {
    for (let attempt = 0; attempt < 400 && planted < clustered; attempt++) {
      const cx = rng.range(bounds.minX + 60, bounds.maxX - 60);
      const cz = rng.range(bounds.minZ + 60, bounds.maxZ - 60);
      if (!f.isClear(cx, cz, CLUSTER_CLEARANCE) || excluded(cx, cz, 10)) continue;
      const dominant = pickWeighted(rng, species, (sp) => sp.cluster);
      const size = rng.int(CLUSTER_SIZE[0], CLUSTER_SIZE[1]);
      const spread = rng.range(CLUSTER_SPREAD[0], CLUSTER_SPREAD[1]);
      let got = 0;
      for (let i = 0; i < size * 2 && got < size && planted < clustered; i++) {
        // gaussian offset (Box–Muller radius)
        const r = spread * Math.sqrt(-2 * Math.log(Math.max(1e-6, rng.next())));
        const a = rng.range(0, Math.PI * 2);
        const si = rng.next() < 0.7 ? dominant : pickWeighted(rng, species, (sp) => sp.cluster);
        if (tryPlant(si, cx + Math.cos(a) * r, cz + Math.sin(a) * r)) {
          got++;
          planted++;
        }
      }
    }
  }
  // track-side and uniform scatter
  for (let attempts = 0; planted < total && attempts < total * 5; attempts++) {
    const si = pickWeighted(rng, species, (sp) => sp.weight);
    const sp = species[si];
    let x: number;
    let z: number;
    if (rng.next() < 0.7) {
      const k = rng.int(0, t.count - 1);
      const side = rng.next() < 0.5 ? -1 : 1;
      const dist = f.occupiedTo(k, side) + sp.clearance + 2 - Math.log(1 - rng.next() * 0.995) * 38;
      sidePoint(t, wrapIndex(k, t.count), side * dist, 0, pos);
      x = pos.x + rng.range(-3, 3);
      z = pos.z + rng.range(-3, 3);
    } else {
      x = rng.range(bounds.minX, bounds.maxX);
      z = rng.range(bounds.minZ, bounds.maxZ);
    }
    if (tryPlant(si, x, z)) planted++;
  }
  species.forEach((sp, si) => {
    const list = instances[si];
    if (list.matrices.length === 0) return;
    const geos: (THREE.BufferGeometry | undefined)[] = [];
    const geoFor = (far: boolean): THREE.BufferGeometry => {
      const k = far ? 1 : 0;
      if (!geos[k]) {
        const b = new TintBuilder(lite || far);
        sp.build(b);
        geos[k] = disposer.add(b.build());
      }
      return geos[k];
    };
    const mat = disposer.add(foliageMaterial(sp.name, foliageAtlas(ctx)));
    const byKey = new Map<number, number[]>();
    list.keys.forEach((key, i) => {
      const arr = byKey.get(key);
      if (arr) arr.push(i);
      else byKey.set(key, [i]);
    });
    for (const [key, idx] of byKey) {
      const mesh = disposer.add(new THREE.InstancedMesh(geoFor((key & 1) === 1), mat, idx.length));
      mesh.name = sp.name;
      idx.forEach((src, i) => {
        mesh.setMatrixAt(i, list.matrices[src]);
        mesh.setColorAt(i, list.colors[src]);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = sp.shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  });
  return group;
}
