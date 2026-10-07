/**
 * Safety car geometry (pure, DOM-free builders): an original GT coupé ≈ 4.6 m × 1.95 m × 1.25 m, origin at ground
 * level midway between the axles, facing +Z, local +X = left. Static parts are merged per material:
 *   body   (vertex coloured: graphite paint, silver trim, carbon, mirrors, wing)
 *   glass  (glasshouse)
 *   decals (livery stripes / lettering / wheel-arch shadows, projected onto the body surface; UVs into the atlas)
 *   lamps  (head / tail lamps, vertex coloured)
 *   wheel  (tyre + rim + spokes, outboard face towards +X, one geometry shared by four spinners)
 *   bar    (roof light bar housing), podLeft / podRight (amber lenses), centre (white / green segment)
 */
import * as THREE from 'three';
import { loft, mergeNonIndexed, type LoftStation } from './shapes';

export const SC_LENGTH = 4.6;
export const SC_WIDTH = 1.95;
export const SC_HEIGHT = 1.25;
export const SC_WHEEL_RADIUS = 0.34;
export const SC_WHEEL_WIDTH = 0.27;
/** Axle z (m) and wheel centre |x| (m). */
export const SC_AXLE_Z = 1.35;
export const SC_WHEEL_X = 0.86;
/** Light bar: base height, pod centre |x| and z (m). */
export const SC_BAR_Y = 1.165;
export const SC_BAR_Z = -0.35;

/** Livery atlas (px) and the metre → pixel scale of every decal rectangle. */
export const SC_ATLAS = { w: 1024, h: 512, pxPerM: 256 } as const;
export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Side decal: z ∈ [-1.9, 1.9], y ∈ [0.26, 0.81]. Viewed from outside, reads left→right towards the nose. */
export const SC_SIDE_RECT: AtlasRect = { x: 0, y: 0, w: 973, h: 141 };
export const SC_SIDE_Z: readonly [number, number] = [-1.9, 1.9];
export const SC_SIDE_Y: readonly [number, number] = [0.26, 0.81];
/** Bonnet decal: x ∈ ±0.45, z ∈ [0.95, 2.05]; read from behind (text up = +Z). */
export const SC_BONNET_RECT: AtlasRect = { x: 0, y: 150, w: 230, h: 282 };
export const SC_BONNET_Z: readonly [number, number] = [0.95, 2.05];
/** Rear deck decal: x ∈ ±0.45, z ∈ [-1.95, -1.45]. */
export const SC_REAR_RECT: AtlasRect = { x: 240, y: 150, w: 230, h: 128 };
export const SC_REAR_Z: readonly [number, number] = [-1.95, -1.45];
/** Solid black swatch used by the wheel-arch discs. */
export const SC_BLACK_RECT: AtlasRect = { x: 500, y: 150, w: 8, h: 8 };
/** Wheel arch shadow disc radius / centre height (m). */
export const SC_ARCH_RADIUS = 0.4;
export const SC_ARCH_Y = 0.34;

interface Section {
  z: number;
  hw: number;
  yb: number;
  yt: number;
  n: number;
}

const BODY: Section[] = [
  { z: -2.3, hw: 0.8, yb: 0.38, yt: 0.98, n: 3 },
  { z: -2.1, hw: 0.92, yb: 0.26, yt: 1.0, n: 3 },
  { z: -1.5, hw: 0.97, yb: 0.24, yt: 1.04, n: 3 },
  { z: -0.6, hw: 0.97, yb: 0.22, yt: 0.98, n: 3 },
  { z: 0.6, hw: 0.95, yb: 0.22, yt: 0.9, n: 3 },
  { z: 1.5, hw: 0.92, yb: 0.2, yt: 0.76, n: 3 },
  { z: 2.1, hw: 0.84, yb: 0.18, yt: 0.6, n: 3 },
  { z: 2.3, hw: 0.66, yb: 0.2, yt: 0.52, n: 3 },
];
const GLASS: Section[] = [
  { z: -1.25, hw: 0.62, yb: 0.93, yt: 0.99, n: 2.6 },
  { z: -0.85, hw: 0.72, yb: 0.9, yt: 1.12, n: 2.6 },
  { z: -0.1, hw: 0.74, yb: 0.88, yt: 1.15, n: 2.6 },
  { z: 0.45, hw: 0.72, yb: 0.86, yt: 1.1, n: 2.6 },
  { z: 0.85, hw: 0.64, yb: 0.84, yt: 0.94, n: 2.6 },
];
const ROOF: Section[] = [
  { z: -0.75, hw: 0.56, yb: 1.115, yt: 1.145, n: 3 },
  { z: -0.1, hw: 0.58, yb: 1.135, yt: 1.165, n: 3 },
  { z: 0.35, hw: 0.56, yb: 1.12, yt: 1.15, n: 3 },
];
const BODY_SEGMENTS = 28;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function sectionAt(stas: Section[], z: number): { hw: number; yc: number; hh: number; n: number } {
  const zc = clamp(z, stas[0].z, stas[stas.length - 1].z);
  let i = 0;
  while (i < stas.length - 2 && zc > stas[i + 1].z) i++;
  const a = stas[i];
  const b = stas[i + 1];
  const t = clamp((zc - a.z) / Math.max(1e-6, b.z - a.z), 0, 1);
  const L = (p: number, q: number): number => p + (q - p) * t;
  const yb = L(a.yb, b.yb);
  const yt = L(a.yt, b.yt);
  return { hw: L(a.hw, b.hw), yc: (yb + yt) / 2, hh: (yt - yb) / 2, n: L(a.n, b.n) };
}

/** Body half-width (m) at height y and z (the surface decals are projected onto). */
export function bodySideX(z: number, y: number): number {
  const s = sectionAt(BODY, z);
  const t = clamp(Math.abs(y - s.yc) / s.hh, 0, 0.999);
  return s.hw * Math.pow(1 - Math.pow(t, s.n), 1 / s.n);
}

/** Body top surface height (m) at lateral x and z. */
export function bodyTopY(x: number, z: number): number {
  const s = sectionAt(BODY, z);
  const t = clamp(Math.abs(x) / s.hw, 0, 0.999);
  return s.yc + s.hh * Math.pow(1 - Math.pow(t, s.n), 1 / s.n);
}

const stations = (list: Section[]): LoftStation[] => list.map((s) => ({ z: s.z, hw: s.hw, yb: s.yb, yt: s.yt, n: s.n }));

/** Adds a flat colour attribute and returns the geometry (shapes.mergeNonIndexed keeps common attributes only). */
function tint(g: THREE.BufferGeometry, hex: string, m?: THREE.Matrix4): THREE.BufferGeometry {
  if (m) g.applyMatrix4(m);
  g.deleteAttribute('uv');
  g.deleteAttribute('inner');
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function box(hex: string, cx: number, cy: number, cz: number, w: number, h: number, d: number): THREE.BufferGeometry {
  return tint(new THREE.BoxGeometry(w, h, d), hex, new THREE.Matrix4().makeTranslation(cx, cy, cz));
}

const PAINT = '#2f3338';
const SILVER = '#aeb5bd';
const CARBON = '#15171a';

function buildBody(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tint(loft(stations(BODY), { segments: BODY_SEGMENTS, capStart: true, capEnd: true }), PAINT));
  parts.push(tint(loft(stations(ROOF), { segments: 14, capStart: true, capEnd: true }), CARBON));
  // splitter, side skirts, diffuser lip
  parts.push(box(SILVER, 0, 0.12, 2.14, 1.7, 0.035, 0.42));
  for (const sx of [-1, 1]) {
    parts.push(box(SILVER, sx * 0.87, 0.23, 0, 0.1, 0.12, 1.9));
    parts.push(box(CARBON, sx * 0.6, 0.3, -2.25, 0.5, 0.1, 0.1));
    // mirrors
    parts.push(box(PAINT, sx * 0.84, 0.99, 0.55, 0.14, 0.08, 0.1));
    // wing end plates + stands
    parts.push(box(CARBON, sx * 0.86, 1.15, -2.14, 0.03, 0.13, 0.36));
    parts.push(box(CARBON, sx * 0.5, 1.07, -2.13, 0.05, 0.2, 0.08));
  }
  // rear wing blade + front grille
  parts.push(box(CARBON, 0, 1.2, -2.14, 1.7, 0.03, 0.34));
  parts.push(box(CARBON, 0, 0.3, 2.29, 0.5, 0.1, 0.04));
  return mergeNonIndexed(parts);
}

function buildWheel(): THREE.BufferGeometry {
  const R = SC_WHEEL_RADIUS;
  const W = SC_WHEEL_WIDTH;
  const toX = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tint(new THREE.CylinderGeometry(R, R, W, 20, 1), '#1a1b1e', toX));
  parts.push(tint(new THREE.CylinderGeometry(R * 0.7, R * 0.7, W + 0.012, 16, 1), '#2b2e33', toX));
  parts.push(tint(new THREE.CylinderGeometry(0.045, 0.045, W + 0.04, 8, 1), SILVER, toX));
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Matrix4()
      .makeRotationX((i / 5) * Math.PI * 2)
      .multiply(new THREE.Matrix4().makeTranslation(W / 2 + 0.008, 0.12, 0));
    parts.push(tint(new THREE.BoxGeometry(0.016, 0.2, 0.045), SILVER, m));
  }
  return mergeNonIndexed(parts);
}

/** Position-only quad geometry with a flat vertex colour (lamps). */
function lampQuad(hex: string, p: [number, number, number][]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p.flat(), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const c = new THREE.Color(hex);
  g.setAttribute('color', new THREE.Float32BufferAttribute([c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b], 3));
  return g;
}

function buildLamps(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const zf = 2.304;
  for (const sx of [-1, 1]) {
    // narrow LED headlamp strip on the nose face
    parts.push(lampQuad('#fff1d6', [[sx * 0.24, 0.34, zf], [sx * 0.58, 0.34, zf], [sx * 0.58, 0.44, zf], [sx * 0.24, 0.44, zf]]));
  }
  // full-width tail light bar
  const zr = -2.304;
  parts.push(lampQuad('#ff1a10', [[-0.7, 0.74, zr], [0.7, 0.74, zr], [0.7, 0.8, zr], [-0.7, 0.8, zr]]));
  // quads share the position / colour attribute set; mergeNonIndexed keeps the two common attributes
  return mergeNonIndexed(parts);
}

/** Roof light bar: dark housing, two amber pods, small white + green centre segment. */
function buildBar(): { bar: THREE.BufferGeometry; podLeft: THREE.BufferGeometry; podRight: THREE.BufferGeometry; centre: THREE.BufferGeometry } {
  const y = SC_BAR_Y;
  const z = SC_BAR_Z;
  const bar = tint(new THREE.BoxGeometry(1.14, 0.035, 0.32), CARBON, new THREE.Matrix4().makeTranslation(0, y + 0.0175, z));
  const pod = (sx: number): THREE.BufferGeometry => new THREE.BoxGeometry(0.34, 0.06, 0.26).translate(sx * 0.37, y + 0.035 + 0.03, z);
  const c1 = tint(new THREE.BoxGeometry(0.15, 0.045, 0.2), '#ffffff', new THREE.Matrix4().makeTranslation(-0.08, y + 0.035 + 0.0225, z));
  const c2 = tint(new THREE.BoxGeometry(0.15, 0.045, 0.2), '#55ff7a', new THREE.Matrix4().makeTranslation(0.08, y + 0.035 + 0.0225, z));
  return { bar, podLeft: pod(1), podRight: pod(-1), centre: mergeNonIndexed([c1, c2]) };
}

/** Accumulates decal grids / fans into one indexed geometry. */
class DecalBuilder {
  private readonly pos: number[] = [];
  private readonly uv: number[] = [];
  private readonly idx: number[] = [];

  private uvOf(r: AtlasRect, a: number, b: number, out: [number, number]): void {
    out[0] = (r.x + a * r.w) / SC_ATLAS.w;
    out[1] = 1 - (r.y + (1 - b) * r.h) / SC_ATLAS.h;
  }

  /** (a, b) ∈ [0,1]² grid; `at` returns the world point. a = rect left → right, b = rect bottom → top. */
  grid(r: AtlasRect, nu: number, nv: number, at: (a: number, b: number) => [number, number, number]): void {
    const base = this.pos.length / 3;
    const t: [number, number] = [0, 0];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const a = i / nu;
        const b = j / nv;
        const p = at(a, b);
        this.pos.push(p[0], p[1], p[2]);
        this.uvOf(r, a, b, t);
        this.uv.push(t[0], t[1]);
      }
    }
    const row = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const q = base + j * row + i;
        this.idx.push(q, q + 1, q + row + 1, q, q + row + 1, q + row);
      }
    }
  }

  fan(r: AtlasRect, segs: number, centre: [number, number, number], rim: (k: number) => [number, number, number]): void {
    const base = this.pos.length / 3;
    const t: [number, number] = [0, 0];
    this.uvOf(r, 0.5, 0.5, t);
    this.pos.push(centre[0], centre[1], centre[2]);
    this.uv.push(t[0], t[1]);
    for (let k = 0; k < segs; k++) {
      const p = rim(k);
      this.pos.push(p[0], p[1], p[2]);
      this.uv.push(t[0], t[1]);
    }
    for (let k = 0; k < segs; k++) this.idx.push(base, base + 1 + k, base + 1 + ((k + 1) % segs));
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const DECAL_EPS = 0.012;

function buildDecals(): THREE.BufferGeometry {
  const d = new DecalBuilder();
  const [z0, z1] = SC_SIDE_Z;
  const [y0, y1] = SC_SIDE_Y;
  // wheel arch shadows first (fan on the body side)
  for (const sx of [-1, 1]) {
    for (const az of [-SC_AXLE_Z, SC_AXLE_Z]) {
      const at = (ang: number, k: number): [number, number, number] => {
        const z = az + Math.cos(ang) * SC_ARCH_RADIUS * k;
        const y = Math.max(0.27, SC_ARCH_Y + Math.sin(ang) * SC_ARCH_RADIUS * k);
        return [sx * (bodySideX(z, y) + DECAL_EPS * 0.5), y, z];
      };
      d.fan(SC_BLACK_RECT, 18, at(0, 0), (k) => at((k / 18) * Math.PI * 2, 1));
    }
    // livery side decal: viewed from outside it reads towards the nose (right side: u grows with z, left side: mirrored)
    d.grid(SC_SIDE_RECT, 28, 6, (a, b) => {
      const z = z0 + (sx < 0 ? a : 1 - a) * (z1 - z0);
      const y = y0 + b * (y1 - y0);
      return [sx * (bodySideX(z, y) + DECAL_EPS), y, z];
    });
  }
  // top decals: read from behind, so a runs towards -X (the viewer's right) and b towards +Z
  const top = (rect: AtlasRect, zr: readonly [number, number], nv: number): void =>
    d.grid(rect, 6, nv, (a, b) => {
      const x = 0.45 - a * 0.9;
      const z = zr[0] + b * (zr[1] - zr[0]);
      return [x, bodyTopY(x, z) + DECAL_EPS, z];
    });
  top(SC_BONNET_RECT, SC_BONNET_Z, 8);
  top(SC_REAR_RECT, SC_REAR_Z, 4);
  return d.build();
}

export interface SafetyCarGeometries {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  decals: THREE.BufferGeometry;
  lamps: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  bar: THREE.BufferGeometry;
  podLeft: THREE.BufferGeometry;
  podRight: THREE.BufferGeometry;
  centre: THREE.BufferGeometry;
}

/** All safety-car geometries (caller owns / disposes them). */
export function buildSafetyCarGeometry(): SafetyCarGeometries {
  const glass = loft(stations(GLASS), { segments: 18, capStart: true, capEnd: true });
  glass.deleteAttribute('inner');
  const bar = buildBar();
  const out: SafetyCarGeometries = {
    body: buildBody(),
    glass,
    decals: buildDecals(),
    lamps: buildLamps(),
    wheel: buildWheel(),
    ...bar,
  };
  for (const g of Object.values(out)) {
    g.computeBoundingSphere();
    g.computeBoundingBox();
  }
  return out;
}

export function triangleCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}
