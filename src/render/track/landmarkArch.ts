/**
 * Landmark architecture: one drawer per registry name (see /tmp/nova-real/landmarks.md and features.ts). Everything is
 * generic, fictional architecture built from boxes, frusta, beams and lathes into per-feature GeoBuilder channels
 * (struct / window facades / glass / emissive / water), placed in a frame whose local +X points away from the road
 * (+Z runs along the track) and whose origin sits on the near edge at the raw ground height.
 */
import * as THREE from 'three';
import type { Biome, QualityLevel } from '../../core/types';
import { Rng } from '../core/canvas';
import { GeoBuilder, addBox, addCylinderY } from '../core/geometry';
import { beam, frustum, icosphere, lathe, quadAway } from './shapes';

/** One feature's geometry, split by material channel. All builders carry vertex colours. */
export interface Channels {
  struct: GeoBuilder;
  /** facade with the window texture (UV in metres: 16 × 24 m per tile), emissive windows after dusk */
  win: GeoBuilder;
  glass: GeoBuilder;
  /** emissive (follows the environment lamp level) */
  glow: GeoBuilder;
  water: GeoBuilder;
}

export function newChannels(): Channels {
  return { struct: new GeoBuilder(true), win: new GeoBuilder(true), glass: new GeoBuilder(true), glow: new GeoBuilder(true), water: new GeoBuilder(true) };
}

/** Local frame: world = origin + X·x + Z·z (+ gy + y); X = (cos yaw, 0, -sin yaw), Z = (sin yaw, 0, cos yaw). */
export class Frame {
  private readonly c: number;
  private readonly s: number;
  constructor(
    readonly ox: number,
    readonly oz: number,
    readonly yaw: number,
    readonly gy: number,
  ) {
    this.c = Math.cos(yaw);
    this.s = Math.sin(yaw);
  }
  w(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.ox + x * this.c + z * this.s, this.gy + y, this.oz - x * this.s + z * this.c);
  }
}

export interface ArchEnv {
  rng: Rng;
  level: QualityLevel;
  biome: Biome;
  /** circuit id: Monaco's skyline is terraced Riviera apartments, not towers */
  trackId?: string;
  night: boolean;
  /** final terrain height at a world point */
  ground: (x: number, z: number) => number;
}

const _col = new THREE.Color();
const FOUNDATION = '#7d8087';
const GLASS = '#26364a';
const LED_WARM = '#ffd9a0';
const LED_COOL = '#9fd2ff';

/** Drawing helper bound to one channel builder and frame (all heights relative to the frame's ground). */
export class Draw {
  constructor(
    readonly b: GeoBuilder,
    readonly fr: Frame,
    readonly e: ArchEnv,
  ) {}
  col(hex: string): this {
    this.b.setColor(_col.set(hex));
    return this;
  }
  /** Axis-aligned (in the frame) box: x/z centre, y0 bottom. */
  box(x: number, y0: number, z: number, w: number, h: number, d: number): void {
    const c = this.fr.w(x, y0 + h / 2, z);
    addBox(this.b, c.x, c.y, c.z, this.fr.yaw, w, h, d, 1);
  }
  /** Facade box with window-texture UVs (16 × 24 m per tile; roofs take one texel). */
  wbox(x: number, y0: number, z: number, w: number, h: number, d: number): void {
    const before = this.b.vertexCount;
    this.box(x, y0, z, w, h, d);
    for (let i = before; i < this.b.vertexCount; i++) {
      if (this.b.normals[i * 3 + 1] > 0.5) {
        this.b.uvs[i * 2] = 0.01;
        this.b.uvs[i * 2 + 1] = 0.01;
      } else {
        this.b.uvs[i * 2] /= 16;
        this.b.uvs[i * 2 + 1] /= 24;
      }
    }
  }
  p(x: number, y: number, z: number): THREE.Vector3 {
    return this.fr.w(x, y, z);
  }
  /** Box-like solid between a bottom rectangle (x0..x1, z0..z1 at y0) and a top rectangle (scaled about its centre by `taper`). */
  frus(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, taper = 1, lift = 0): void {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const tx = ((x1 - x0) / 2) * taper;
    const tz = ((z1 - z0) / 2) * taper;
    frustum(
      this.b,
      [this.p(x0, y0, z0), this.p(x1, y0, z0), this.p(x1, y0, z1), this.p(x0, y0, z1)],
      [this.p(cx - tx, y1 + lift, cz - tz), this.p(cx + tx, y1 + lift, cz - tz), this.p(cx + tx, y1 + lift, cz + tz), this.p(cx - tx, y1 + lift, cz + tz)],
    );
  }
  cyl(x: number, y0: number, z: number, r: number, h: number, seg = 10): void {
    const c = this.fr.w(x, y0, z);
    addCylinderY(this.b, c.x, c.y, c.z, r, h, seg);
  }
  lathe(x: number, y0: number, z: number, profile: readonly (readonly [number, number])[], seg = 12): void {
    const c = this.fr.w(x, y0, z);
    lathe(this.b, c.x, c.y, c.z, profile, seg);
  }
  beam(a: THREE.Vector3, c: THREE.Vector3, w: number, h = w): void {
    beam(this.b, a, c, w, h);
  }
  /** Horizontal up-facing rectangle (water, grass, paving). */
  flat(x0: number, x1: number, z0: number, z1: number, y: number): void {
    const centre = this.p((x0 + x1) / 2, y - 10, (z0 + z1) / 2);
    quadAway(this.b, this.p(x0, y, z0), this.p(x1, y, z0), this.p(x1, y, z1), this.p(x0, y, z1), centre);
  }
  /** Up-facing ellipse (fan), irregular outline when `wobble` > 0. */
  ellipse(cx: number, cz: number, rx: number, rz: number, y: number, seg = 28, wobble = 0): void {
    const n = this.b.vertexCount;
    this.b.vertex(...this.arr(this.p(cx, y, cz)), 0, 1, 0, 0.5, 0.5);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const k = 1 + wobble * Math.sin(a * 3 + 1.3) * 0.5 + wobble * 0.5 * Math.sin(a * 5 + 0.4);
      this.b.vertex(...this.arr(this.p(cx + Math.cos(a) * rx * k, y, cz + Math.sin(a) * rz * k)), 0, 1, 0, 0.5, 0.5);
    }
    // the frame's X / Z axes are a rotation of the world's: orient by the up normal
    for (let i = 0; i < seg; i++) {
      const a = n + 1 + i;
      const c = n + 1 + ((i + 1) % seg);
      const pa = this.p(cx + Math.cos((i / seg) * 6.2832), y, cz + Math.sin((i / seg) * 6.2832));
      const pc = this.p(cx + Math.cos(((i + 1) / seg) * 6.2832), y, cz + Math.sin(((i + 1) / seg) * 6.2832));
      const o = this.p(cx, y, cz);
      const up = (pa.x - o.x) * (pc.z - o.z) - (pa.z - o.z) * (pc.x - o.x);
      if (up < 0) this.b.tri(n, a, c);
      else this.b.tri(n, c, a);
    }
  }
  private arr(v: THREE.Vector3): [number, number, number] {
    return [v.x, v.y, v.z];
  }
}

/** Min / max terrain height over a frame-local footprint (3 × 3 samples). */
export function groundRange(fr: Frame, e: ArchEnv, x0: number, x1: number, z0: number, z1: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const p = fr.w(x0 + ((x1 - x0) * i) / 2, 0, z0 + ((z1 - z0) * j) / 2);
      const g = e.ground(p.x, p.z);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
  }
  return [lo, hi];
}

/** Foundation block under a footprint: returns the floor height (frame-local) buildings should start at. */
export function plinth(d: Draw, x0: number, x1: number, z0: number, z1: number): number {
  const [lo, hi] = groundRange(d.fr, d.e, x0, x1, z0, z1);
  const base = hi - d.fr.gy;
  const bottom = lo - d.fr.gy - 1.2;
  d.col(FOUNDATION).box((x0 + x1) / 2, bottom, (z0 + z1) / 2, x1 - x0, base - bottom + 0.05, z1 - z0);
  return base + 0.05;
}

/** Window-facade tower with a crown, optional antenna and a lit top ring. */
function tower(sc: Channels, fr: Frame, e: ArchEnv, x: number, z: number, w: number, dp: number, h: number, tint: string, crown = true, ring: string | null = null): void {
  const win = new Draw(sc.win, fr, e);
  const st = new Draw(sc.struct, fr, e);
  const yb = plinth(st, x - w / 2, x + w / 2, z - dp / 2, z + dp / 2);
  win.col(tint).wbox(x, yb, z, w, h, dp);
  if (crown) {
    st.col('#9aa0a8').box(x, yb + h, z, w * 0.7, 3, dp * 0.7);
    if (h > 80) st.col('#c8ccd2').box(x, yb + h + 3, z, 0.8, Math.min(30, h * 0.12), 0.8);
  }
  if (ring) new Draw(sc.glow, fr, e).col(ring).box(x, yb + h - 1.2, z, w + 0.5, 0.7, dp + 0.5);
}

const TOWER_TINTS = ['#c2c9d2', '#a9b4c0', '#d7d3c8', '#9aa6b3', '#bdbab2', '#8e9aa6'];
const HOUSE_WALLS = ['#f1ece0', '#e9d9b8', '#e6c9a0', '#f4e3d3', '#d9d4c7', '#efe7d6'];
const ROOFS = ['#b5552f', '#a04a2c', '#c0643a', '#6c6f75'];

/** Cluster of high-rises (city: CBD / strip towers; elsewhere mid-rise). Coastal = terraced apartments on the hill. */
export function skyline(sc: Channels, fr: Frame, e: ArchEnv, depth: number, length: number): void {
  if (e.biome === 'coastal' || e.trackId === 'monaco') return houses(sc, fr, e, depth, length, { cap: { low: 28, medium: 48, high: 72, ultra: 90 }, wall: [9, 26], dx: 20, dz: 19, size: [14, 24] });
  const count = { low: 5, medium: 8, high: 11, ultra: 14 }[e.level];
  const tall: [number, number] = e.biome === 'city' ? [95, 230] : [42, 100];
  const cols = Math.ceil(count / 2);
  const cell = length / cols;
  const lit = e.night ? LED_COOL : null;
  for (let i = 0; i < count; i++) {
    const row = i % 2;
    const col = Math.floor(i / 2);
    const w = Math.min(cell - 6, e.rng.range(22, 38));
    const dp = Math.min(depth / 2 - 8, e.rng.range(22, 36));
    const x = (row === 0 ? 0.27 : 0.74) * depth + e.rng.range(-4, 4);
    const z = -length / 2 + (col + 0.5) * cell + e.rng.range(-3, 3) + (row ? cell * 0.18 : 0);
    const h = tall[0] + (tall[1] - tall[0]) * Math.pow(e.rng.next(), 1.2) + row * 22;
    tower(sc, fr, e, x, z, w, dp, h, e.rng.pick(TOWER_TINTS), true, h > 140 ? lit : null);
  }
}

interface HouseParams {
  cap: Record<QualityLevel, number>;
  wall: [number, number];
  dx: number;
  dz: number;
  size: [number, number];
}

/**
 * Dense houses / apartment blocks on a hillside (the terrain edit raises the ground; each block stands on its own ground).
 * Rows are irregular: per-row offset and stagger, clumps and gaps, mixed block sizes. Each house is cut into the slope: its
 * floor sits slightly above the mean ground and a short stucco foundation (the wall colour, darkened) only fills the
 * downhill side, instead of one tall grey plinth reaching up to the highest ground under the footprint.
 */
export function houses(sc: Channels, fr: Frame, e: ArchEnv, depth: number, length: number, p: HouseParams): void {
  const win = new Draw(sc.win, fr, e);
  const st = new Draw(sc.struct, fr, e);
  const cols = Math.max(1, Math.floor(length / p.dz));
  const rows = Math.max(1, Math.floor((depth - 8) / p.dx));
  const cap = p.cap[e.level];
  const keep = Math.min(1, cap / (cols * rows));
  const phase = e.rng.range(0, 6.28);
  const wall = new THREE.Color();
  for (let r = 0; r < rows; r++) {
    const rowX = e.rng.range(-2.2, 2.2);
    const stagger = (r % 2 ? 0.5 : 0) * p.dz + e.rng.range(-0.25, 0.25) * p.dz;
    for (let c = 0; c < cols; c++) {
      // clumps and gaps: a slow wave across the row (phase shifts per row) thins whole stretches out
      const clump = 0.62 + 0.38 * Math.sin(c * 0.55 + r * 2.1 + phase);
      if (e.rng.next() > keep * 0.95 * clump) continue;
      const big = e.rng.next() < 0.14;
      const w = e.rng.range(p.size[0] * 0.65, p.size[0]) * (big ? 1.45 : 1);
      const dp = e.rng.range(p.size[0] * 0.6, p.size[1]) * (big ? 1.2 : 1);
      const x = 6 + r * p.dx + rowX + e.rng.range(-3, 3);
      const z = -length / 2 + (c + 0.5) * p.dz + stagger + e.rng.range(-0.3, 0.3) * p.dz;
      if (Math.abs(z) + w / 2 > length / 2) continue;
      const h = e.rng.range(p.wall[0], p.wall[1]) * (0.8 + 0.4 * (r / rows)) * (big ? 1.25 : 1);
      const [lo, hi] = groundRange(fr, e, x - dp / 2, x + dp / 2, z - w / 2, z + w / 2);
      const yb = lo - fr.gy + (hi - lo) * 0.45 + 0.2;
      wall.set(e.rng.pick(HOUSE_WALLS));
      st.col('#' + wall.clone().multiplyScalar(0.62).getHexString(THREE.SRGBColorSpace)).box(x, lo - fr.gy - 1.2, z, dp + 0.3, yb - (lo - fr.gy - 1.2) + 0.05, w + 0.3);
      win.col('#' + wall.getHexString(THREE.SRGBColorSpace)).wbox(x, yb, z, dp, h, w);
      st.col(e.rng.pick(ROOFS)).frus(x - dp / 2 - 0.3, x + dp / 2 + 0.3, z - w / 2 - 0.3, z + w / 2 + 0.3, yb + h, yb + h + 1.4, 0.55);
    }
  }
}

export function hillsideHouses(sc: Channels, fr: Frame, e: ArchEnv, depth: number, length: number): void {
  houses(sc, fr, e, depth, length, { cap: { low: 40, medium: 80, high: 150, ultra: 220 }, wall: [3.5, 6.5], dx: 15, dz: 13, size: [7, 11] });
}

/** Belle-époque casino square: domed casino between two mansard hotels, gardens, a round fountain and park trees. */
export function casinoSquare(sc: Channels, fr: Frame, e: ArchEnv, depth: number, length: number): void {
  const st = new Draw(sc.struct, fr, e);
  const win = new Draw(sc.win, fr, e);
  const dome = '#6aa391';
  const cream = '#e6d9bd';
  const slate = '#4b4f58';
  const building = (x: number, z: number, w: number, dp: number, h: number, towerH: number): void => {
    const yb = plinth(st, x - dp / 2, x + dp / 2, z - w / 2, z + w / 2);
    win.col(cream).wbox(x, yb, z, dp, h, w);
    // cornice, mansard roof, balustrade
    st.col('#f3ead2').box(x, yb + h - 0.4, z, dp + 1.2, 0.9, w + 1.2);
    st.col(slate).frus(x - dp / 2, x + dp / 2, z - w / 2, z + w / 2, yb + h + 0.5, yb + h + 5, 0.82);
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) {
        st.col(cream).box(x + sx * (dp / 2 - 3), yb + h, z + sz * (w / 2 - 3), 5, 4, 5);
        st.col(dome).lathe(x + sx * (dp / 2 - 3), yb + h + 4, z + sz * (w / 2 - 3), [[2.4, 0], [2.4, 0.6], [1.9, 2.2], [1, 3.4], [0, 4.2]], 10);
      }
    }
    if (towerH > 0) {
      st.col(cream).box(x, yb + h, z, 8, towerH, 8);
      st.col(dome).lathe(x, yb + h + towerH, z, [[5.4, 0], [5.4, 0.8], [4.6, 3.6], [2.6, 6.4], [0.9, 8.6], [0, 9.6]], 12);
      st.col('#d8b45a').box(x, yb + h + towerH + 9.4, z, 0.35, 5, 0.35);
    }
  };
  // layout along local X (away from the road): gardens first, the casino and its two hotels behind them
  const garden = depth * 0.35;
  building(garden + 20, 0, 34, 36, 18, 14);
  building(garden + 18, -length * 0.36, 28, 32, 21, 0);
  building(garden + 18, length * 0.36, 28, 32, 21, 0);
  const base = plinth(st, 2, garden, -length * 0.3, length * 0.3) - 0.04;
  st.col('#5f8f45').box((2 + garden) / 2, base - 0.08, 0, garden - 2, 0.1, length * 0.6);
  st.col('#d8d2c4').lathe(garden * 0.5, base, 0, [[4.6, 0], [4.6, 0.9], [3.8, 0.9], [3.8, 0.5], [0.4, 0.5], [0.4, 2.8], [1.2, 3.4], [0, 3.4]], 14);
  const trees = e.level === 'low' ? 6 : 14;
  for (let i = 0; i < trees; i++) {
    const x = e.rng.range(4, garden - 3);
    const z = e.rng.range(-length * 0.28, length * 0.28);
    if (Math.hypot(x - garden * 0.5, z) < 8) continue;
    const wp = fr.w(x, 0, z);
    const g = e.ground(wp.x, wp.z) - fr.gy;
    st.col('#5c4630').cyl(x, g, z, 0.25, 3.2, 6);
    st.col(e.rng.pick(['#4f7d33', '#5d8c3a', '#44702d'])).lathe(x, g + 2.4, z, [[0.1, 0], [2.2, 1.2], [2.6, 2.8], [1.2, 4.6], [0, 5.2]], 7);
  }
}

/** Open-air swimming pool complex: pool, paving, loungers, parasols and a clubhouse. */
export function swimmingPool(sc: Channels, fr: Frame, e: ArchEnv, depth: number, length: number, level: number): void {
  const st = new Draw(sc.struct, fr, e);
  const wt = new Draw(sc.water, fr, e);
  const win = new Draw(sc.win, fr, e);
  // the basin (terrain edit) and the quay slab (landmarks.ts) share this rectangle
  const px0 = 12;
  const px1 = depth - 12;
  const hz = length / 2 - 12;
  wt.col('#38b6d4').flat(px0 - 2, px1 + 2, -hz - 2, hz + 2, level - 0.1);
  // loungers and parasols on the road side of the pool, clubhouse behind it
  for (let i = 0; i < 12; i++) st.col('#f4f4f4').box(7, level + 0.1, -hz + 4 + i * ((2 * hz - 8) / 11), 0.8, 0.28, 2);
  for (let i = 0; i < 6; i++) {
    const z = -hz + 8 + i * ((2 * hz - 16) / 5);
    st.col('#c9c2b4').cyl(4.5, level, z, 0.05, 2.6, 5);
    st.col(e.rng.pick(['#e8322f', '#f2c230', '#ffffff', '#1f6fae'])).lathe(4.5, level + 2.4, z, [[0.1, 0.4], [1.8, 0], [1.8, -0.15]], 8);
  }
  const yb = level + 0.1;
  win.col('#efe9db').wbox(depth - 5, yb, 0, 8, 6, 22);
  st.col('#8a8f96').box(depth - 5, yb + 6, 0, 9, 0.5, 23);
}

/** Harbour basin: quay, pontoons and moored yachts (the terrain edit carves the basin, water sits at `water`). */
export function marina(sc: Channels, fr: Frame, e: ArchEnv, depth: number, length: number, level: number, water: number): void {
  const st = new Draw(sc.struct, fr, e);
  const wt = new Draw(sc.water, fr, e);
  const inset = 12;
  const x0 = inset;
  const x1 = depth - inset;
  const hz = length / 2 - inset;
  wt.col('#1f5f78').flat(x0 - 4, x1 + 4, -hz - 4, hz + 4, water);
  // quay edge (concrete coping + paving strip)
  st.col('#cfcac0');
  st.box((x0 + x1) / 2, level - 0.15, -hz - 0.5, x1 - x0 + 2, 0.3 + (level - water), 1);
  st.box((x0 + x1) / 2, level - 0.15, hz + 0.5, x1 - x0 + 2, 0.3 + (level - water), 1);
  st.box(x0 - 0.5, level - 0.15, 0, 1, 0.3 + (level - water), 2 * hz);
  st.box(x1 + 0.5, level - 0.15, 0, 1, 0.3 + (level - water), 2 * hz);
  const boats = { low: 8, medium: 14, high: 20, ultra: 26 }[e.level];
  const hulls = ['#f4f4f2', '#e8e6df', '#1e2a44', '#f4f4f2', '#d9d5c9'];
  for (let i = 0; i < boats; i++) {
    const rowB = i % 2;
    const z = -hz + 8 + Math.floor(i / 2) * ((2 * hz - 16) / Math.max(1, Math.ceil(boats / 2) - 1));
    const len = e.rng.range(9, 20);
    const beam = len * 0.28;
    const x = rowB === 0 ? x0 + 2 + len / 2 : x1 - 2 - len / 2;
    const hull = e.rng.pick(hulls);
    // hull (keel narrower than the deck), deck house, mast; bows point at the quay
    const y = water;
    const ring = (hw: number, hl: number, yy: number): THREE.Vector3[] => [st.p(x - hl, yy, z - hw), st.p(x + hl, yy, z - hw), st.p(x + hl, yy, z + hw), st.p(x - hl, yy, z + hw)];
    st.col(hull);
    frustum(st.b, ring(beam * 0.28, len * 0.4, y - 0.7), ring(beam / 2, len / 2, y + 0.9));
    st.col('#9c7a4a').box(x, y + 0.88, z, len * 0.84, 0.1, beam * 0.9);
    st.col('#ffffff').box(x - len * 0.08, y + 0.95, z, len * 0.4, 1.2, beam * 0.62);
    st.col('#26364a').box(x - len * 0.08, y + 1.35, z, len * 0.38, 0.4, beam * 0.64);
    if (len > 13) st.col('#d8dce2').cyl(x + len * 0.05, y + 1.4, z, 0.07, len * 0.55, 5);
  }
  // pontoons between the rows
  st.col('#9c8a6a').box((x0 + x1) / 2, water + 0.05, 0, 1.4, 0.2, 2 * hz - 8);
  st.col('#cfcac0').box(x0 + 8, level, hz + 5, 14, 3, 8);
}

/** Lake with a reed fringe (the terrain edit carves it; the water polygon sits slightly beyond the waterline). */
export function lake(sc: Channels, fr: Frame, _e: ArchEnv, depth: number, length: number, water: number): void {
  const wt = new Draw(sc.water, fr, _e);
  wt.col('#2f6f7a').ellipse(depth / 2, 0, depth / 2 - 2, length / 2 - 2, water, 32, 0.12);
}

/** Ornamental lake with fountain jets and a promenade. */
export function fountainLake(sc: Channels, fr: Frame, e: ArchEnv, depth: number, length: number, level: number, water: number): void {
  const st = new Draw(sc.struct, fr, e);
  const wt = new Draw(sc.water, fr, e);
  const gl = new Draw(sc.glow, fr, e);
  const inset = 10;
  wt.col('#2d7f93').flat(inset - 4, depth - inset + 4, -length / 2 + inset - 4, length / 2 - inset + 4, water);
  st.col('#d9d1bf');
  st.box(depth / 2, level - 0.2, -length / 2 + inset - 3, depth - 2 * inset + 8, 0.5, 6);
  st.box(depth / 2, level - 0.2, length / 2 - inset + 3, depth - 2 * inset + 8, 0.5, 6);
  const jets = { low: 3, medium: 5, high: 7, ultra: 9 }[e.level];
  for (let i = 0; i < jets; i++) {
    const z = -length / 2 + inset + 14 + (i * (length - 2 * inset - 28)) / Math.max(1, jets - 1);
    const x = depth / 2 + (i % 2 ? 6 : -6);
    const h = e.rng.range(14, 28);
    st.col('#eef6ff').lathe(x, water - 0.2, z, [[0.35, 0], [0.35, h], [1.3, h + 0.6], [2.4, h - 1.5], [0.2, h - 3.5]], 8);
    st.col('#e6eef7').lathe(x, water - 0.1, z, [[3.2, 0], [3.2, 0.6], [0.3, 0.6]], 12);
    gl.col('#bfe0ff').box(x, water + 0.1, z - 3.6, 0.5, 0.4, 0.5);
    gl.box(x, water + 0.1, z + 3.6, 0.5, 0.4, 0.5);
  }
}

/** Observation wheel whose axle runs along local X, so the wheel faces the road. */
export function ferrisWheel(sc: Channels, fr: Frame, e: ArchEnv, radius: number): void {
  const st = new Draw(sc.struct, fr, e);
  const gl = new Draw(sc.glow, fr, e);
  const hub = radius + 6;
  const seg = e.level === 'low' ? 24 : 36;
  const half = Math.max(0.6, radius * 0.025);
  // wheel plane = (Z, Y); two rims a little apart along X
  const rim = (a: number, r: number, x: number): THREE.Vector3 => st.p(x, hub + Math.sin(a) * r, Math.cos(a) * r);
  const rimW = Math.max(0.35, radius * 0.012);
  st.col('#e9ecef');
  for (const x of [-half, half]) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      st.beam(rim(a0, radius, x), rim(a1, radius, x), rimW);
    }
  }
  const spokes = e.level === 'low' ? 12 : 24;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    st.beam(rim(a, 0, -half), rim(a, radius, -half), rimW * 0.35);
    st.beam(rim(a, 0, half), rim(a, radius, half), rimW * 0.35);
  }
  for (let i = 0; i < seg; i += 1) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    gl.col(i % 2 ? LED_COOL : LED_WARM).beam(rim(a0, radius - rimW * 1.2, 0), rim(a1, radius - rimW * 1.2, 0), rimW * 0.8);
  }
  const pods = e.level === 'low' ? 12 : 24;
  const cab = Math.max(1.4, radius * 0.07);
  const cabColors = ['#e8322f', '#f2c230', '#1f6fae', '#ffffff', '#2fa84f'];
  for (let i = 0; i < pods; i++) {
    const a = (i / pods) * Math.PI * 2;
    // cabin hangs below the rim point (frame-local centre)
    const lz = Math.cos(a) * radius;
    const ly = hub + Math.sin(a) * radius - cab * 1.1;
    st.col(e.rng.pick(cabColors)).box(0, ly, lz, cab * 1.2, cab, cab);
  }
  // hub + A-frame legs
  st.col('#cfd3d8').cyl(0, hub - 0.8, 0, radius * 0.045, 1.6, 10);
  const foot = (z: number, x: number): THREE.Vector3 => st.p(x, -1.5, z);
  for (const x of [-half * 1.6, half * 1.6]) {
    st.beam(foot(-radius * 0.55, x), st.p(x, hub, 0), rimW * 1.6);
    st.beam(foot(radius * 0.55, x), st.p(x, hub, 0), rimW * 1.6);
  }
  st.col('#8d9096').box(0, -1.5, 0, half * 5, 1.6, radius * 1.4);
}

/** Slim concrete observation tower with a viewing pod. */
export function observationTower(sc: Channels, fr: Frame, e: ArchEnv, height: number): void {
  const st = new Draw(sc.struct, fr, e);
  const gl = new Draw(sc.glass, fr, e);
  const beacon = new Draw(sc.glow, fr, e);
  const x = 0;
  const k = height / 77;
  st.col('#8d9096').cyl(x, -2, 0, 9, 3, 12);
  st.col('#d2d0ca').lathe(x, 0, 0, [[5.2 * k, 0], [3.3 * k, 6 * k], [2.7 * k, 40 * k], [2.4 * k, 61 * k]], 14);
  const y = 61 * k;
  st.col('#c9c8c2').lathe(x, y, 0, [[2.4 * k, 0], [9 * k, 2.2 * k], [9.4 * k, 4.2 * k], [3 * k, 4.4 * k]], 20);
  gl.col(GLASS).lathe(x, y + 4.2 * k, 0, [[9.5 * k, 0], [9.5 * k, 3.2 * k]], 20);
  st.col('#c9c8c2').lathe(x, y + 7.4 * k, 0, [[9.6 * k, 0], [8 * k, 0.9 * k], [2.4 * k, 1.8 * k], [1.5 * k, 3 * k], [0.4 * k, height - y - 7.4 * k]], 14);
  beacon.col('#ff5b3c').box(x, height - 0.6, 0, 0.7, 0.9, 0.7);
}

/** Circuit control / VIP tower: podium, glazed tower, cantilevered observation deck with a blade roof, antenna. */
export function controlTower(sc: Channels, fr: Frame, e: ArchEnv): void {
  const st = new Draw(sc.struct, fr, e);
  const gl = new Draw(sc.glass, fr, e);
  const win = new Draw(sc.win, fr, e);
  const yb = plinth(st, 4, 46, -26, 26);
  win.col('#d9d5cc').wbox(22, yb, 0, 36, 8, 46);
  st.col('#8a8f96').box(22, yb + 8, 0, 38, 0.5, 48);
  const tx = 24;
  gl.col(GLASS).box(tx, yb + 8.5, 0, 14, 30, 14);
  for (let i = 0; i <= 7; i++) st.col('#d9d5cc').box(tx, yb + 8.5 + i * 4.2, 0, 14.6, 0.5, 14.6);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) st.col('#d9d5cc').box(tx + sx * 7.2, yb + 8.5, sz * 7.2, 0.8, 30, 0.8);
  st.col('#c4c8ce').box(tx - 2, yb + 38.5, 0, 22, 4, 20);
  gl.box(tx - 3.5, yb + 38.8, 0, 19, 3.2, 17.5);
  st.col('#f2f3f5').frus(tx - 15, tx + 12, -17, 17, yb + 42.7, yb + 43.8, 0.9, 1.2);
  st.col('#cfd3d8').box(tx + 4, yb + 44, 4, 0.5, 18, 0.5);
}

/** Three towers joined by a long ship-like sky park deck on top. */
export function skyParkHotel(sc: Channels, fr: Frame, e: ArchEnv, depth: number, length: number): void {
  const st = new Draw(sc.struct, fr, e);
  const win = new Draw(sc.win, fr, e);
  const gl = new Draw(sc.glow, fr, e);
  const wt = new Draw(sc.water, fr, e);
  const h = 190;
  const x = depth / 2;
  const span = (length - 84) / 2;
  let top = 0;
  for (const z of [-span, 0, span]) {
    const yb = plinth(st, x - 20, x + 20, z - 16, z + 16);
    top = Math.max(top, yb);
    win.col('#b9c4d0').wbox(x, yb, z, 40, h, 32);
    gl.col(LED_WARM).box(x, yb + h - 1.5, z, 40.4, 0.5, 32.4);
  }
  // the deck: a boat-shaped slab that overhangs the outer towers, pointed at the front end
  const y0 = top + h;
  st.col('#d8dce2').frus(x - 17, x + 17, -length / 2, length / 2, y0, y0 + 6, 0.92);
  st.col('#4f8b3a').box(x, y0 + 6.05, 0, 24, 0.5, length * 0.7);
  wt.col('#3fb7d4').flat(x - 6, x + 6, -length * 0.22, length * 0.22, y0 + 6.5);
  gl.col(LED_COOL).box(x - 16, y0 + 5.8, 0, 0.5, 0.6, length - 6);
  gl.box(x + 16, y0 + 5.8, 0, 0.5, 0.6, length - 6);
  // slim pylons under the overhang
  st.col('#9aa0a8').box(x, y0 - 10, -length / 2 + 14, 14, 10, 6);
  st.box(x, y0 - 10, length / 2 - 14, 14, 10, 6);
}

/** Giant LED sphere venue on a podium. */
export function ledSphere(sc: Channels, fr: Frame, e: ArchEnv, depth: number): void {
  const st = new Draw(sc.struct, fr, e);
  const r = 56;
  const x = depth / 2;
  const yb = plinth(st, x - 38, x + 38, -38, 38);
  st.col('#6d7279').box(x, yb, 0, 76, 7, 76);
  st.col('#4a4e55').box(x, yb + 7, 0, 40, 18, 40);
  const detail = e.level === 'low' || e.level === 'medium' ? 2 : 3;
  const c = st.p(x, yb + 25 + r * 0.55, 0);
  const rng = new Rng(7);
  const palette = ['#2f6cff', '#ff3b8d', '#ffb02e', '#35e0b0', '#8a5bff', '#ffffff'];
  const base = new THREE.Color();
  icosphere(sc.glow, c.x, c.y, c.z, r, detail, (cen, face) => {
    // a slow colour field across the surface with pixel-like noise
    const k = (Math.sin(cen.x * 0.07) + Math.cos(cen.y * 0.09 + cen.z * 0.05)) * 0.5 + 0.5;
    base.set(palette[Math.min(palette.length - 1, Math.floor(k * palette.length))]);
    return base.multiplyScalar(0.55 + 0.45 * rng.next() + (face % 7 === 0 ? 0.3 : 0));
  });
}

// ───────────────────────────── leaf grandstand ─────────────────────────────

const LEAF_ROW_RISE = 0.46;
const LEAF_ROW_RUN = 0.85;
const LEAF_ROWS: readonly [number, number] = [5, 26];
/** Spine (concourse block) width between the two banks (m) and the wall height it keeps above the top row. */
const LEAF_SPINE: readonly [number, number] = [8, 14];
const LEAF_WALL_ABOVE = 4;
/** Mast height (m) above the spine roof and the canopy's slope-down at its two ends. */
const LEAF_MAST = 9;
const LEAF_PITCH = 54;
const LEAF_CREAM = '#f1ecdf';
const LEAF_UNDER = '#d8d1c0';
const SEAT_COLORS = ['#c8352b', '#1f5fa8', '#e8b230', '#2a8f84', '#d9d9d4', '#6a3d8c'];
const CROWD_COLORS = ['#2b3a55', '#a8412f', '#d9c9a8', '#3f6f5a', '#e8e4dc', '#7a5a8a', '#c9a23a'];
/** Spectator block length along the stand (m) by quality: coarser blocks keep 'low' light. */
const LEAF_BLOCK: Record<QualityLevel, number> = { low: 14, medium: 8, high: 6, ultra: 4.5 };

/** Seat rows, spine, rails and canopy-leaf count of a leaf grandstand of this footprint (also used by the tests). */
export function leafStandLayout(depth: number, double: boolean): { core: number; bank: number; rows: number; run: number; top: number } {
  const core = double ? Math.min(LEAF_SPINE[1], Math.max(LEAF_SPINE[0], depth * 0.2)) : 4;
  const bank = double ? (depth - core) / 2 : depth - core;
  const rows = Math.min(LEAF_ROWS[1], Math.max(LEAF_ROWS[0], Math.floor(bank / LEAF_ROW_RUN)));
  return { core, bank, rows, run: bank / rows, top: rows * LEAF_ROW_RISE };
}

/**
 * Signature leaf grandstand: a double-sided raked stand (seats facing the near road at x = 0 and the far road at
 * x = depth, or just the near road when `double` is false) around a concourse spine, shaded by a row of big
 * hibiscus-leaf canopies (cream membranes on slender masts with stays). Everything stays inside depth × length,
 * `base` = floor height (frame-local).
 */
export function leafGrandstand(sc: Channels, fr: Frame, e: ArchEnv, depth: number, length: number, base: number, double: boolean): void {
  const st = new Draw(sc.struct, fr, e);
  const win = new Draw(sc.win, fr, e);
  const glow = new Draw(sc.glow, fr, e);
  const L = leafStandLayout(depth, double);
  const rng = e.rng;
  const foot = base - 1.4;
  const block = LEAF_BLOCK[e.level] ?? 8;
  const nb = Math.max(1, Math.round(length / block));
  const bl = length / nb;
  const section = Math.max(2, Math.round(24 / bl));
  const sectionColor: string[] = [];
  for (let i = 0; i < Math.ceil(nb / section) + 1; i++) sectionColor.push(rng.pick(SEAT_COLORS));
  // raked banks: one concrete box per row (closed ends), spectator / seat blocks on the treads
  const bank = (far: boolean): void => {
    for (let r = 0; r < L.rows; r++) {
      const x0 = far ? depth - (r + 1) * L.run : r * L.run;
      const top = base + (r + 1) * LEAF_ROW_RISE;
      st.col('#a9aaae').box(x0 + L.run / 2, foot, 0, L.run, top - foot, length);
      for (let j = 0; j < nb; j++) {
        const aisle = j % section === 0;
        const crowd = !aisle && rng.next() < 0.6;
        st.col(aisle ? '#c4c6c9' : crowd ? rng.pick(CROWD_COLORS) : sectionColor[Math.floor(j / section)]);
        st.flat(x0 + 0.05, x0 + L.run - 0.05, -length / 2 + j * bl + 0.03, -length / 2 + (j + 1) * bl - 0.03, top + 0.03);
      }
    }
    // front rail with abstract coloured panels and an LED line
    const fx = far ? depth - 0.15 : 0.15;
    st.col('#d6d8dc').box(fx, base, 0, 0.3, 1.15, length);
    for (let z = -length / 2 + 6; z < length / 2 - 6; z += 12) st.col(rng.pick(PANEL_COLORS)).box(far ? fx - 0.1 : fx + 0.1, base + 0.2, z, 0.12, 0.7, 9);
    glow.col(LED_COOL).box(far ? fx - 0.05 : fx + 0.05, base + 1.15, 0, 0.14, 0.12, length - 2);
  };
  bank(false);
  if (double) bank(true);
  // spine: concourse wall above the top rows, lit band under the parapet
  const wallTop = L.top + LEAF_WALL_ABOVE;
  const sx0 = double ? L.bank : depth - L.core;
  win.col('#e6e0d2').wbox(sx0 + L.core / 2, base - 0.2, 0, L.core, wallTop + 0.2, length);
  st.col('#cfc9bc').box(sx0 + L.core / 2, base + wallTop, 0, L.core + 0.6, 0.5, length + 0.6);
  glow.col(LED_WARM).box(sx0 + 0.05, base + wallTop - 0.9, 0, 0.1, 0.35, length - 4);
  if (double) glow.box(sx0 + L.core - 0.05, base + wallTop - 0.9, 0, 0.1, 0.35, length - 4);
  // canopy leaves
  const n = Math.max(2, Math.round(length / LEAF_PITCH));
  const pitch = length / n;
  const xa = 0.4;
  const xb = depth - 0.4;
  const xm = double ? depth / 2 : depth - L.core / 2;
  const hc = base + wallTop + LEAF_MAST;
  const drop = Math.min(9, Math.max(3, depth * 0.1));
  const hw = pitch * 0.47;
  const cu = 10;
  const cv = 6;
  const thick = 0.35;
  const below = new THREE.Vector3();
  const above = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const zc = -length / 2 + pitch * (i + 0.5);
    const yAt = (u: number): number => hc - drop * (2 * u - 1) ** 2;
    const P = (iu: number, iv: number, off: number): THREE.Vector3 => {
      const u = iu / cu;
      const v = (iv / cv) * 2 - 1;
      const halfW = hw * Math.sin(Math.PI * (0.04 + 0.92 * u)) ** 0.55;
      return fr.w(xa + (xb - xa) * u, yAt(u) + 1.6 * (1 - v * v) + off, zc + v * halfW);
    };
    fr.w(xm, base + wallTop, zc, below);
    fr.w(xm, -50, zc, above);
    for (let a = 0; a < cu; a++) {
      for (let b = 0; b < cv; b++) {
        st.col(LEAF_CREAM);
        quadAway(st.b, P(a, b, thick), P(a + 1, b, thick), P(a + 1, b + 1, thick), P(a, b + 1, thick), above);
        st.col(LEAF_UNDER);
        quadAway(st.b, P(a, b, 0), P(a + 1, b, 0), P(a + 1, b + 1, 0), P(a, b + 1, 0), new THREE.Vector3(0, 100, 0));
      }
    }
    // mast + stays to the leaf's two ends
    st.col('#e9e7e1').beam(below, fr.w(xm, yAt(0.5) - 0.1, zc), 1.1);
    const stay = (u: number): void => {
      const tip = fr.w(xa + (xb - xa) * u, yAt(u) - 0.1, zc);
      st.beam(fr.w(xm, yAt(0.5) - 2.2, zc), tip, 0.3);
    };
    stay(0.12);
    stay(0.88);
  }
}

/** Wing roof / bridge geometry shared by the spanning structures: lofted roof surface between two edges across the road. */
export function loftRoof(
  b: GeoBuilder,
  fr: Frame,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  height: (u: number, v: number) => number,
  thick: number,
  cu: number,
  cv: number,
): void {
  const centre = fr.w((x0 + x1) / 2, -50, (z0 + z1) / 2);
  const P = (i: number, j: number, off: number): THREE.Vector3 => {
    const u = i / cu;
    const v = j / cv;
    return fr.w(x0 + (x1 - x0) * u, height(u, v) + off, z0 + (z1 - z0) * v);
  };
  const top = new THREE.Vector3(0, 100, 0);
  for (let i = 0; i < cu; i++) {
    for (let j = 0; j < cv; j++) {
      quadAway(b, P(i, j, thick), P(i + 1, j, thick), P(i + 1, j + 1, thick), P(i, j + 1, thick), centre);
      quadAway(b, P(i, j, 0), P(i + 1, j, 0), P(i + 1, j + 1, 0), P(i, j + 1, 0), top);
    }
  }
}

/** Colours for fictional signage panels. */
export const PANEL_COLORS = ['#0f2a5c', '#e8322f', '#f2c230', '#1b8f8a', '#ffffff', '#2a1e5c', '#111111'];
