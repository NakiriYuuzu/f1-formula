/**
 * Biome scenery scattered around the circuit: instanced vegetation — 3–4 species per biome (temperate pine /
 * spruce / oak / bush, autumn maple / ginkgo / cedar / shrub, desert palm / cactus / agave / boulder, coastal palm /
 * stone pine / cypress / bush, city palm / plane tree / hedge), each one merged trunk + crown mesh with per-instance
 * crown colour (tint mask), scale / height / lean jitter, placed near the track, uniformly and in denser forest
 * clusters away from it (never inside the track corridor); shadow-casting species are split into spatial chunks so
 * views and the ±70 m shadow pass cull them. Plus merged city / coastal buildings with window textures (lit at
 * night) and harbour cranes near the water. Density scales with quality (low ≈ 25 %).
 */
import * as THREE from 'three';
import type { Biome, QualityLevel } from '../../core/types';
import { Rng } from '../core/canvas';
import { GeoBuilder, addBox, addGeometry } from '../core/geometry';
import { windowTexture } from '../core/surfaceTextures';
import { sidePoint, wrapIndex, type SceneryContext } from './context';
import { patchTintMask, patchWindowFade } from './sceneryMaterials';
import { chunkKey } from './sceneryMath';
import { townStyleFor } from './townscape';

/** Vegetation per km of track (before quality density) by biome. */
export const VEGETATION_PER_KM: Record<Biome, number> = { temperate: 420, autumn: 400, desert: 150, coastal: 240, city: 80, tropical: 460 };
/** Most instanced plants per scene by quality: long circuits (7 km) would otherwise plant thousands more than a view can use. */
export const VEGETATION_MAX: Record<QualityLevel, number> = { low: 500, medium: 1300, high: 2200, ultra: 3200 };
/** Share of vegetation planted in forest clusters away from the track. */
export const CLUSTER_SHARE = 0.4;
/** Trees per cluster (range) and cluster spread σ (m). */
export const CLUSTER_SIZE: readonly [number, number] = [12, 32];
export const CLUSTER_SPREAD: readonly [number, number] = [14, 40];
/** Cluster centres keep at least this far (m) beyond the occupied track corridor. */
export const CLUSTER_CLEARANCE = 25;
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
  doubleSided?: boolean;
}

const TRUNK = '#5a3f2a';
const _col = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Geometry builder with a per-vertex tint mask (1 = takes the instance colour) and crown shading gradient. */
export class TintBuilder {
  readonly geo = new GeoBuilder(true);
  readonly mask: number[] = [];

  /** Append `geom` (disposed) placed at (x, y, z) with optional Euler rotation and scale. */
  add(geom: THREE.BufferGeometry, color: string, tint: number, x: number, y: number, z: number, rot?: [number, number, number], scale?: [number, number, number]): void {
    const start = this.geo.vertexCount;
    this.geo.setColor(_col.set(color));
    _q.setFromEuler(_e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0));
    _m.compose(_v.set(x, y, z), _q, _s.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1));
    addGeometry(this.geo, geom, _m);
    geom.dispose();
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
      b.add(cyl(0.14, 0.22, 2.6, 5), TRUNK, 0, 0, 1.3, 0);
      b.add(new THREE.ConeGeometry(2.2, 3.8, 7, 1, false), '#ffffff', 1, 0, 3.9, 0);
      b.add(new THREE.ConeGeometry(1.5, 3.2, 7, 1, true), '#ffffff', 1, 0, 6.2, 0);
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
      b.add(cyl(0.12, 0.2, 2.2, 5), TRUNK, 0, 0, 1.1, 0);
      b.add(new THREE.ConeGeometry(1.6, 3.0, 6, 1, false), '#ffffff', 1, 0, 3.1, 0);
      b.add(new THREE.ConeGeometry(1.25, 2.7, 6, 1, true), '#ffffff', 1, 0, 4.75, 0);
      b.add(new THREE.ConeGeometry(0.85, 2.4, 6, 1, true), '#ffffff', 1, 0, 6.3, 0);
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
      b.add(cyl(0.2, 0.3, 3.2, 5), TRUNK, 0, 0, 1.6, 0);
      b.add(ico(2.5), '#ffffff', 1, 0, 4.6, 0, [0, 0.3, 0], [1.1, 0.85, 1.1]);
      b.add(ico(1.7), '#ffffff', 1, 0.9, 5.5, -0.5, [0.4, 0, 0.2]);
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
      b.add(cyl(0.16, 0.26, 3.4, 5), '#6b5440', 0, 0, 1.7, 0);
      b.add(ico(1.7), '#ffffff', 1, 0, 5.4, 0, [0, 0.5, 0], [0.95, 1.6, 0.95]);
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
    build: (b) => b.add(ico(1.1), '#ffffff', 1, 0, 0.55, 0, [0, 0, 0], [1.3, 0.75, 1.1]),
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

function palm(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'palm',
    weight,
    cluster,
    crown,
    scale: [0.85, 1.25],
    clearance: 4,
    shadow: true,
    doubleSided: true,
    build: (b) => {
      b.add(cyl(0.2, 0.27, 4.2, 5), '#7a6248', 0, 0.04, 2.1, 0, [0, 0, -0.04]);
      b.add(cyl(0.15, 0.2, 4.0, 5), '#7a6248', 0, 0.2, 6.1, 0, [0, 0, -0.08]);
      // drooping fronds: two-segment strips radiating from the crown (double-sided material)
      const f = new GeoBuilder();
      const top = new THREE.Vector3(0.36, 8.1, 0);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.3;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        const px = -dz;
        const pz = dx;
        const mid = new THREE.Vector3(top.x + dx * 1.8, top.y + 0.45, top.z + dz * 1.8);
        const tip = new THREE.Vector3(top.x + dx * 3.3, top.y - 0.9, top.z + dz * 3.3);
        const w0 = 0.12;
        const w1 = 0.36;
        const v = [
          [top.x - px * w0, top.y, top.z - pz * w0],
          [top.x + px * w0, top.y, top.z + pz * w0],
          [mid.x + px * w1, mid.y, mid.z + pz * w1],
          [mid.x - px * w1, mid.y, mid.z - pz * w1],
          [tip.x, tip.y, tip.z],
        ];
        const base = f.vertexCount;
        for (const p of v) f.vertex(p[0], p[1], p[2], 0, 1, 0, 0, 0);
        f.quad(base, base + 3, base + 2, base + 1);
        f.tri(base + 3, base + 4, base + 2);
      }
      const fronds = f.build(true);
      if (fronds) b.add(fronds, '#ffffff', 1, 0, 0, 0);
    },
  };
}

/** Oil palm: stout ringed trunk, dense crown of long arching pinnate fronds (strips with a drooping tip), fruit bunch under the crown. */
export function oilPalm(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'oilPalm',
    weight,
    cluster,
    crown,
    scale: [0.9, 1.2],
    clearance: 4,
    shadow: true,
    doubleSided: true,
    build: (b) => {
      b.add(cyl(0.3, 0.42, 7.6, 5), '#6f5a44', 0, 0.02, 3.8, 0, [0, 0, -0.02]);
      b.add(new THREE.ConeGeometry(0.62, 0.9, 5, 1, true), '#7a4a2a', 0, 0.05, 7.4, 0, [Math.PI, 0, 0]);
      const f = new GeoBuilder();
      const top = new THREE.Vector3(0, 8.0, 0);
      const n = 12;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (i % 2) * 0.2;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        const px = -dz;
        const pz = dx;
        // older fronds (odd index) hang lower and longer; young ones stand up
        const old = i % 2;
        const m2 = new THREE.Vector3(top.x + dx * 3.2, top.y + (old ? 0.7 : 1.4), top.z + dz * 3.2);
        const tip = new THREE.Vector3(top.x + dx * (old ? 4.6 : 4.0), top.y + (old ? -1.0 : 0.2), top.z + dz * (old ? 4.6 : 4.0));
        const w0 = 0.1;
        const w1 = 0.42;
        // three points along the frond (root, mid, tip): a quad to the middle and a tapering tip triangle
        const v = [
          [top.x - px * w0, top.y, top.z - pz * w0],
          [top.x + px * w0, top.y, top.z + pz * w0],
          [m2.x + px * w1, m2.y, m2.z + pz * w1],
          [m2.x - px * w1, m2.y, m2.z - pz * w1],
          [tip.x, tip.y, tip.z],
        ];
        const base = f.vertexCount;
        for (const q of v) f.vertex(q[0], q[1], q[2], 0, 1, 0, 0, 0);
        f.quad(base, base + 3, base + 2, base + 1);
        f.tri(base + 3, base + 4, base + 2);
      }
      const fronds = f.build(true);
      if (fronds) b.add(fronds, '#ffffff', 1, 0, 0, 0);
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
      b.add(cyl(0.34, 0.7, 6.5, 5), '#6b5646', 0, 0, 3.25, 0);
      b.add(ico(3.6), '#ffffff', 1, 0, 8.0, 0, [0, 0.2, 0], [1.35, 0.55, 1.35]);
      b.add(ico(2.5), '#ffffff', 1, 1.8, 9.2, -1.0, [0.3, 0, 0.2], [1.2, 0.6, 1.2]);
    },
  };
}

/** Banana-like broad-leaf shrub: a fan of big drooping leaves on short stems. */
function broadLeafShrub(crown: readonly string[], weight: number, cluster: number): Species {
  return {
    name: 'broadLeafShrub',
    weight,
    cluster,
    crown,
    scale: [0.7, 1.3],
    clearance: 3,
    shadow: false,
    doubleSided: true,
    build: (b) => {
      const f = new GeoBuilder();
      const n = 7;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        const px = -dz;
        const pz = dx;
        const mid = [dx * 0.9, 1.5, dz * 0.9];
        const tip = [dx * 1.9, 1.0, dz * 1.9];
        const base = f.vertexCount;
        for (const q of [[0, 0.3, 0], [mid[0] + px * 0.5, mid[1], mid[2] + pz * 0.5], [mid[0] - px * 0.5, mid[1], mid[2] - pz * 0.5], tip]) f.vertex(q[0], q[1], q[2], 0, 1, 0, 0, 0);
        f.tri(base, base + 2, base + 1);
        f.tri(base + 1, base + 2, base + 3);
      }
      const geo = f.build(true);
      if (geo) b.add(geo, '#ffffff', 1, 0, 0, 0);
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
      b.add(cyl(0.18, 0.28, 6.4, 5), '#6a4a34', 0, 0.26, 3.2, 0, [0, 0, -0.08]);
      b.add(ico(3.0), '#ffffff', 1, 0.5, 7.0, 0, [0, 0.4, 0], [1.3, 0.4, 1.3]);
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
      b.add(cyl(0.12, 0.16, 1.2, 4), TRUNK, 0, 0, 0.6, 0);
      b.add(cyl(0.95, 0.4, 1.6, 6), '#ffffff', 1, 0, 1.7, 0);
      b.add(cyl(0, 0.95, 5.2, 6), '#ffffff', 1, 0, 5.1, 0);
    },
  };
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
  const total = Math.min(VEGETATION_MAX[ctx.quality.level] ?? 2200, Math.round((t.length / 1000) * (VEGETATION_PER_KM[ctx.biome] ?? 300) * density));
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
  const instances: { matrices: THREE.Matrix4[]; colors: THREE.Color[]; keys: number[] }[] = species.map(() => ({ matrices: [], colors: [], keys: [] }));
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
    list.keys.push(sp.shadow ? chunkKey(x, z, bounds.minX, bounds.minZ, chunk) : 0);
    return true;
  };
  // forest clusters away from the track
  const clustered = Math.round(total * CLUSTER_SHARE);
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
    const geo = (() => {
      const b = new TintBuilder();
      sp.build(b);
      return disposer.add(b.build());
    })();
    const mat = disposer.add(new THREE.MeshLambertMaterial({ name: sp.name, vertexColors: true, side: sp.doubleSided ? THREE.DoubleSide : THREE.FrontSide }));
    patchTintMask(mat);
    const byKey = new Map<number, number[]>();
    list.keys.forEach((key, i) => {
      const arr = byKey.get(key);
      if (arr) arr.push(i);
      else byKey.set(key, [i]);
    });
    for (const idx of byKey.values()) {
      const mesh = disposer.add(new THREE.InstancedMesh(geo, mat, idx.length));
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
