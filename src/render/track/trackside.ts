/**
 * Trackside structures: broadcast camera spots (with scaffold towers), grandstands (stepped rows, back and sloped
 * end walls, cantilevered roof canopies with a fascia) with an instanced seated crowd (low-poly spectators: shirt
 * colour per instance from a muted palette sprinkled with team colours, per-instance skin tone), marshal posts and
 * lamp posts / floodlight towers (lamp heads glow with the environment lamp level). Structures share one
 * vertex-coloured material.
 */
import * as THREE from 'three';
import type { QualityLevel } from '../../core/types';
import { lerp, smoothstep } from '../../core/math';
import { Rng } from '../core/canvas';
import { GeoBuilder, addBox, addCylinderY, addGeometry } from '../core/geometry';
import type { Disposer } from '../core/disposer';
import { blockedAt, headingAt, sidePoint, wrapIndex, type SceneryContext } from './context';
import type { MarshalSite } from './marshalPanels';
import { jitterColor } from './props';
import { patchTintMask } from './sceneryMaterials';

export interface TvSpot {
  /** sample index the spot looks after */
  index: number;
  s: number;
  position: THREE.Vector3;
}

export interface TracksideParts {
  group: THREE.Group;
  tvSpots: TvSpot[];
  /** marshal posts (the flag light panels are built from these) */
  marshalPosts: MarshalSite[];
  /** named grandstands (features) that were built, of ctx.featureStands.length requested */
  featureStandsBuilt: number;
}

const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _white = new THREE.Color(1, 1, 1);
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/** Seat pitch (m) along a grandstand row. */
export const CROWD_SEAT_PITCH = 0.62;
/** Seat occupancy = base + density × quality.propDensity (never above the previous crowd count). */
export const CROWD_OCCUPANCY: readonly [number, number] = [0.17, 0.7];
/** Share of spectators wearing a team colour (each stand favours two teams); the rest use the muted palette. */
export const CROWD_TEAM_SHARE = 0.3;
/** Spectator mesh detail: 'simple' = 12 triangles (torso + head), 'full' = 20 (+ legs, rounder head). */
export const CROWD_DETAIL: Record<QualityLevel, 'simple' | 'full'> = { low: 'simple', medium: 'full', high: 'full', ultra: 'full' };
/** One instanced mesh per grandstand (view culling) from this quality up; 'low' merges all stands into one. */
const CROWD_PER_STAND: Record<QualityLevel, boolean> = { low: false, medium: true, high: true, ultra: true };
const CROWD_MUTED = ['#2f3440', '#4a5160', '#6f7682', '#a7a9ad', '#d9d6cf', '#ece9e2', '#2c4a6b', '#5a3e33', '#4a6347', '#8a3b34', '#c9a66b', '#1f2a36'];

/** Flat quad p0..p3 wound so its face normal points along `facing`. */
function quadFacing(b: GeoBuilder, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, facing: THREE.Vector3): void {
  _n.crossVectors(_e1.subVectors(p1, p0), _e2.subVectors(p3, p0));
  if (_n.dot(facing) >= 0) b.flatQuad(p0, p1, p2, p3);
  else b.flatQuad(p0, p3, p2, p1);
}

/** Seated spectator facing local +Z, origin on the seat: shirt torso (tint 1), skin head (tint 2), legs (tint 0.3). */
function spectatorGeometry(detail: 'simple' | 'full'): THREE.BufferGeometry {
  const b = new GeoBuilder(true);
  const mask: number[] = [];
  const mark = (from: number, m: number): void => {
    for (let i = from; i < b.vertexCount; i++) mask.push(m);
  };
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  // torso: tapered, open back / bottom (hidden by the row behind and the seat)
  let from = b.vertexCount;
  b.setColor(_white);
  const hip = 0.18;
  const sh = 0.22;
  const zf = 0.11;
  const zb = -0.11;
  const top = 0.6;
  quadFacing(b, v(-hip, 0, zf), v(hip, 0, zf), v(sh, top, zf - 0.02), v(-sh, top, zf - 0.02), new THREE.Vector3(0, 0, 1));
  quadFacing(b, v(hip, 0, zf), v(hip, 0, zb), v(sh, top, zb), v(sh, top, zf - 0.02), new THREE.Vector3(1, 0, 0));
  quadFacing(b, v(-hip, 0, zb), v(-hip, 0, zf), v(-sh, top, zf - 0.02), v(-sh, top, zb), new THREE.Vector3(-1, 0, 0));
  quadFacing(b, v(-sh, top, zf - 0.02), v(sh, top, zf - 0.02), v(sh, top, zb), v(-sh, top, zb), _up);
  mark(from, 1);
  // head
  from = b.vertexCount;
  const head = detail === 'full' ? new THREE.OctahedronGeometry(0.12, 0) : new THREE.TetrahedronGeometry(0.14, 0);
  addGeometry(b, head, new THREE.Matrix4().compose(v(0, 0.76, 0), new THREE.Quaternion(), v(1, 1.15, 1)));
  head.dispose();
  mark(from, 2);
  if (detail === 'full') {
    // thighs on the seat, pointing at the track
    from = b.vertexCount;
    b.setColor(new THREE.Color('#34405a'));
    quadFacing(b, v(-0.17, 0.15, 0.46), v(0.17, 0.15, 0.46), v(0.17, 0.15, 0.08), v(-0.17, 0.15, 0.08), _up);
    quadFacing(b, v(-0.17, 0, 0.46), v(0.17, 0, 0.46), v(0.17, 0.15, 0.46), v(-0.17, 0.15, 0.46), new THREE.Vector3(0, 0, 1));
    mark(from, 0.3);
  }
  const g = b.build() ?? new THREE.BufferGeometry();
  g.setAttribute('tintMask', new THREE.Float32BufferAttribute(mask, 1));
  return g;
}

/** Collects spectator instances per grandstand and builds the instanced crowd mesh(es). */
class CrowdBuilder {
  private readonly stands: { matrices: THREE.Matrix4[]; colors: THREE.Color[] }[] = [];
  private current: { matrices: THREE.Matrix4[]; colors: THREE.Color[] } | null = null;
  private home: string[] = [];
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();

  constructor(
    private readonly level: QualityLevel,
    private readonly rng: Rng,
    private readonly team: readonly string[],
  ) {}

  beginStand(): void {
    this.current = { matrices: [], colors: [] };
    this.stands.push(this.current);
    // each stand favours two teams (fan blocks) but every team shows up somewhere
    this.home = [this.rng.pick(this.team), this.rng.pick(this.team)];
  }

  add(position: THREE.Vector3, yaw: number): void {
    if (!this.current) return;
    const rng = this.rng;
    this.q.setFromAxisAngle(_up, yaw);
    const k = rng.range(0.9, 1.08);
    this.s.set(k, k * rng.range(0.92, 1.08), k);
    this.current.matrices.push(new THREE.Matrix4().compose(position, this.q, this.s));
    let hex: string;
    const pick = rng.next();
    if (pick < CROWD_TEAM_SHARE * 0.65) hex = rng.pick(this.home);
    else if (pick < CROWD_TEAM_SHARE) hex = rng.pick(this.team);
    else hex = rng.pick(CROWD_MUTED);
    this.current.colors.push(jitterColor(hex, 0, rng.range(-0.05, 0.05), rng.range(-0.04, 0.04)));
  }

  build(disposer: Disposer): THREE.InstancedMesh[] {
    const groups = CROWD_PER_STAND[this.level] ? this.stands : [this.merged()];
    const meshes: THREE.InstancedMesh[] = [];
    if (!groups.some((g) => g.matrices.length > 0)) return meshes;
    const geo = disposer.add(spectatorGeometry(CROWD_DETAIL[this.level] ?? 'full'));
    const mat = disposer.add(new THREE.MeshLambertMaterial({ name: 'crowd', vertexColors: true }));
    patchTintMask(mat, true);
    for (const grp of groups) {
      if (grp.matrices.length === 0) continue;
      const mesh = disposer.add(new THREE.InstancedMesh(geo, mat, grp.matrices.length));
      mesh.name = 'crowd';
      grp.matrices.forEach((m, i) => {
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, grp.colors[i]);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      meshes.push(mesh);
    }
    return meshes;
  }

  private merged(): { matrices: THREE.Matrix4[]; colors: THREE.Color[] } {
    return { matrices: this.stands.flatMap((s) => s.matrices), colors: this.stands.flatMap((s) => s.colors) };
  }
}

/** ~12 broadcast camera positions outside the barriers, on the outside of nearby corners, 6–12 m up. */
export function computeTvSpots(ctx: SceneryContext, heightAtXZ: (x: number, z: number) => number, count = 12): TvSpot[] {
  const { track: t, frame: f } = ctx;
  const n = t.count;
  const spots: TvSpot[] = [];
  if (n < 8) return spots;
  const rng = new Rng(ctx.seed + 404);
  for (let c = 0; c < count; c++) {
    // a spot never stands beside a bridge deck or a tunnel: slide it ahead to the first free stretch
    let k = wrapIndex(Math.round((((c + 0.5) / count) * t.length) / Math.max(0.01, t.spacing)), n);
    for (let tries = 0; tries < 24 && blockedAt(ctx, k, 40); tries++) k = wrapIndex(k + Math.round(50 / Math.max(0.01, t.spacing)), n);
    let curv = 0;
    const win = Math.round(70 / Math.max(0.5, t.spacing));
    for (let j = 0; j <= win; j++) curv += t.curvature[wrapIndex(k + j, n)] || 0;
    let side = Math.abs(curv) * t.spacing > 0.15 ? (curv > 0 ? -1 : 1) : -f.pitSign;
    let placed: THREE.Vector3 | null = null;
    for (let attempt = 0; attempt < 4 && !placed; attempt++) {
      if (attempt === 2) side = -side;
      const extra = attempt % 2 === 0 ? 8 : 18;
      const lat = side * (f.occupiedTo(k, side) + extra);
      sidePoint(t, k, lat, 0, _p);
      if (!f.isClear(_p.x, _p.z, 3) || ctx.exclusions.some((e) => (e.x - _p.x) ** 2 + (e.z - _p.z) ** 2 < (e.r + 4) ** 2)) continue;
      const g = heightAtXZ(_p.x, _p.z);
      placed = new THREE.Vector3(_p.x, Math.max(g, t.py[k]) + rng.range(6, 12), _p.z);
    }
    if (!placed) {
      sidePoint(t, k, side * (f.occupiedTo(k, side) + 25), 0, _p);
      placed = new THREE.Vector3(_p.x, t.py[k] + 14, _p.z);
    }
    spots.push({ index: k, s: t.s[k], position: placed });
    ctx.exclusions.push({ x: placed.x, z: placed.z, r: 9 });
  }
  return spots;
}

/** Roof of a grandstand: cantilever canopy, saw-tooth ridges, a low canopy or an open scaffold frame without roof. */
type StandStyle = 'canopy' | 'sawtooth' | 'low' | 'open';

interface Stand {
  centre: THREE.Vector3;
  yaw: number;
  length: number;
  rows: number;
  roof: boolean;
  style: StandStyle;
  /** concourse aisle half-way up (named big stands) */
  tiered: boolean;
  seat: THREE.Color;
}

/** Spectator instances per scene by quality: stands share the budget by lowering their occupancy. */
export const CROWD_MAX_INSTANCES: Record<QualityLevel, number> = { low: 2300, medium: 3500, high: 5000, ultra: 6000 };
/** Terrain may rise this far (m) above a stand's front ground under it (plus half a metre at the back), and up to the seat-top height just behind it, within STAND_BACK_CLEAR (m). */
const STAND_GROUND_RISE = 0.6;
const STAND_BACK_CLEAR = 4;
/** Saw-tooth roof pitch (m) and rise (m). */
const SAWTOOTH_PITCH = 9;
const SAWTOOTH_RISE = 1.7;
/** Spacing (m) of the vertical ribs on a grandstand's rear face. */
const STAND_RIB_PITCH = 5;
/** Floodlight pool on the road under a tower: length along the track (m), row step (m), peak strength and lift above the road (m). */
const LIGHT_POOL_LENGTH = 76;
const LIGHT_POOL_STEP = 4;
const LIGHT_POOL_STRENGTH = 0.1;
/** Pool mesh columns across the road (a coarse grid showed its triangles as hard-edged wedges). */
const LIGHT_POOL_COLS = 10;
const LIGHT_POOL_LIFT = 0.07;
/** Shifts (m) along the track tried for a named grandstand whose requested spot is taken. */
const FEATURE_STAND_SLIDES = [0, 40, -40, 90, -90, 150, -150, 250, -250];

export function buildTrackside(ctx: SceneryContext, heightAtXZ: (x: number, z: number) => number, tvSpots: TvSpot[]): TracksideParts {
  const { track: t, frame: f, disposer } = ctx;
  const n = t.count;
  const group = new THREE.Group();
  group.name = 'trackside';
  const rng = new Rng(ctx.seed + 77);
  const struct = new GeoBuilder(true);
  const lampHeads = new GeoBuilder();
  /** lamp frames, catwalks and arms: no shadow casting, so the heads never throw a detached rectangle on the road */
  const lampFrames = new GeoBuilder(true);
  /** floodlight tower positions (sample indices) that get a soft pool of light on the road */
  const poolSites: number[] = [];
  const col = new THREE.Color();

  // ── TV camera towers ──
  for (const spot of tvSpots) {
    const g = heightAtXZ(spot.position.x, spot.position.z);
    const h = Math.max(1, spot.position.y - g - 1.2);
    struct.setColor(col.set('#8a8f96'));
    addBox(struct, spot.position.x, g + h / 2, spot.position.z, 0, 0.9, h, 0.9, 1);
    struct.setColor(col.set('#2c2f34'));
    addBox(struct, spot.position.x, g + h + 0.3, spot.position.z, 0, 1.8, 0.6, 1.8, 1);
  }

  // ── grandstands ──
  const stands: Stand[] = [];
  const tryStand = (k: number, side: number, lengths: number[], rows: number, roof: boolean, opts: { offset?: number; tiered?: boolean; relaxed?: boolean } = {}): boolean => {
    if (blockedAt(ctx, k, 40)) return false;
    // depth direction (away from the track) = side * R
    const ax = side * t.rx[k];
    const az = side * t.rz[k];
    const fx = t.tx[k];
    const fz = t.tz[k];
    const depth = rows * 0.85 + 1;
    const lat = side * Math.max(f.occupiedTo(k, side) + 5, opts.offset ?? 0);
    sidePoint(t, k, lat, 0, _p);
    for (const len of lengths) {
      let ok = true;
      // the stand stands on the ground at its front centre: terrain that rises past the seats / canopy behind it (rock
      // slopes) would swallow it, so such spots are skipped (the callers slide along the track or try shorter stands)
      const gFront = heightAtXZ(_p.x, _p.z);
      for (const al of [-0.5, -0.25, 0, 0.25, 0.5]) {
        for (const dd of [0, depth * 0.5, depth, depth + STAND_BACK_CLEAR]) {
          const x = _p.x + fx * len * al + ax * dd;
          const z = _p.z + fz * len * al + az * dd;
          if (!f.isClear(x, z, 1.5) || ctx.exclusions.some((e) => (e.x - x) ** 2 + (e.z - z) ** 2 < e.r * e.r)) ok = false;
          const limit = dd > depth ? rows * 0.5 : STAND_GROUND_RISE + (dd / depth) * 0.5;
          if (!opts.relaxed && heightAtXZ(x, z) - gFront > limit) ok = false;
        }
      }
      if (!ok) continue;
      const seat = new THREE.Color(rng.pick(['#1f4fa8', '#c8102e', '#e8e8e8', '#1b7f4a', '#f2c230']));
      const style: StandStyle = roof ? 'canopy' : rng.pick<StandStyle>(['low', 'sawtooth', 'open', 'low']);
      stands.push({ centre: _p.clone(), yaw: Math.atan2(ax, az), length: len, rows, roof, style, tiered: opts.tiered === true, seat });
      for (const al of [-0.5, 0, 0.5]) {
        ctx.exclusions.push({ x: _p.x + fx * len * al + ax * depth * 0.5, z: _p.z + fz * len * al + az * depth * 0.5, r: Math.max(depth, len * 0.3) + 4 });
      }
      return true;
    }
    return false;
  };
  // main stand opposite the pits, around the start line
  tryStand(wrapIndex(Math.round(-30 / Math.max(0.01, t.spacing)), n), -f.pitSign, [180, 140, 100, 60], 14, true);
  // named big stands requested by the track's features (side / offset from the data)
  // (slid along the track when the requested spot is taken, so every stand the menus list exists)
  let featureStandsBuilt = 0;
  for (const fs of ctx.featureStands) {
    // clear ground first; a stand the menus list is still built on the nearest fit when every spot has a rising hillside behind it
    for (const relaxed of [false, true]) {
      let built = false;
      for (const slide of FEATURE_STAND_SLIDES) {
        const k = wrapIndex(fs.k + Math.round(slide / Math.max(0.01, t.spacing)), n);
        if (tryStand(k, fs.side, [fs.length, 160, 120, 80, 60], Math.min(fs.rows, 16), true, { offset: fs.offset, tiered: true, relaxed })) {
          built = true;
          break;
        }
      }
      if (built) {
        featureStandsBuilt++;
        break;
      }
    }
  }
  // corner stands at the heaviest braking corners
  const corners = [...t.corners]
    .map((c) => ({ c, drop: Math.max(0, (t.speedProfile[wrapIndex(Math.round((c.startS - 150) / Math.max(0.01, t.spacing)), n)] ?? 0) - c.minSpeed) }))
    .sort((a, b) => b.drop - a.drop)
    .slice(0, 4);
  for (const { c } of corners) {
    const k = wrapIndex(Math.round(c.apexS / Math.max(0.01, t.spacing)), n);
    tryStand(k, -c.direction, [80, 60, 40], 10, false);
  }

  // stand geometry + crowd instances
  const crowd = new CrowdBuilder(ctx.quality.level, rng, ctx.teamColors);
  const occupancy = CROWD_OCCUPANCY[0] + CROWD_OCCUPANCY[1] * ctx.quality.propDensity;
  const seatTotal = stands.reduce((a, stand) => a + stand.rows * Math.floor(stand.length / CROWD_SEAT_PITCH), 0);
  const occupancyScale = Math.min(1, CROWD_MAX_INSTANCES[ctx.quality.level] / Math.max(1, seatTotal * occupancy));
  for (const st of stands) {
    const g = heightAtXZ(st.centre.x, st.centre.z) - 0.4;
    const ax = Math.sin(st.yaw);
    const az = Math.cos(st.yaw);
    // local X of the stand frame (along the stand) = (cos yaw, 0, -sin yaw); depth axis = (ax, 0, az)
    const along = (a: number, d: number, y: number, out: THREE.Vector3): THREE.Vector3 =>
      out.set(st.centre.x + Math.cos(st.yaw) * a + ax * d, y, st.centre.z - Math.sin(st.yaw) * a + az * d);
    const rise = 0.5;
    const rowD = 0.85;
    crowd.beginStand();
    for (let r = 0; r < st.rows; r++) {
      const h = (r + 1) * rise + 0.6;
      const off = r * rowD + rowD / 2;
      const aisle = st.tiered && r === Math.floor(st.rows / 2);
      struct.setColor(aisle ? col.set('#d9dbe0') : r % 2 === 0 ? st.seat : col.copy(st.seat).multiplyScalar(0.8));
      addBox(struct, st.centre.x + ax * off, g + h / 2, st.centre.z + az * off, st.yaw, st.length, h, rowD, 1);
      // seated spectators on this row (the concourse aisle of a tiered stand stays empty)
      const seats = aisle ? 0 : Math.floor(st.length / CROWD_SEAT_PITCH);
      for (let i = 0; i < seats; i++) {
        if (rng.next() > occupancy * occupancyScale) continue;
        const a = -st.length / 2 + (i + 0.5) * CROWD_SEAT_PITCH + rng.range(-0.08, 0.08);
        along(a, off + 0.12 + rng.range(-0.05, 0.05), g + h, _p);
        crowd.add(_p, st.yaw + Math.PI + rng.range(-0.25, 0.25));
      }
    }
    const backOff = st.rows * rowD + 0.2;
    const backH = st.rows * rise + 1.8;
    const frontH = rise + 0.6;
    // back wall
    struct.setColor(col.set('#9a9da3'));
    addBox(struct, st.centre.x + ax * backOff, g + backH / 2, st.centre.z + az * backOff, st.yaw, st.length, backH, 0.4, 1);
    // rear face: vertical ribs, two belt courses and a coping band, so the back reads as a framed concrete structure
    struct.setColor(col.set('#7b7f86'));
    for (let a = -st.length / 2 + 2.5; a < st.length / 2 - 1; a += STAND_RIB_PITCH) {
      along(a, backOff + 0.2 + 0.2, 0, _p);
      addBox(struct, _p.x, g + backH / 2, _p.z, st.yaw, 0.55, backH, 0.4, 1);
    }
    for (const [frac, tone] of [[0.3, '#8a8e95'], [0.64, '#b4b7bd']] as const) {
      struct.setColor(col.set(tone));
      along(0, backOff + 0.2 + 0.07, 0, _p);
      addBox(struct, _p.x, g + backH * frac, _p.z, st.yaw, st.length + 0.2, 0.5, 0.14, 1);
    }
    struct.setColor(col.set('#c4c7cc'));
    along(0, backOff + 0.2 + 0.1, 0, _p);
    addBox(struct, _p.x, g + backH + 0.1, _p.z, st.yaw, st.length + 0.4, 0.3, 0.3, 1);
    // sloped end walls (hide the stepped profile from the side)
    struct.setColor(col.set('#8e9197'));
    for (const end of [-1, 1]) {
      const aOut = end * (st.length / 2 + 0.35);
      const aIn = end * (st.length / 2);
      const prof: [number, number][] = [
        [-0.05, 0],
        [-0.05, frontH + 0.25],
        [backOff + 0.2, backH],
        [backOff + 0.2, 0],
      ];
      const pt = (a: number, i: number): THREE.Vector3 => along(a, prof[i][0], g + prof[i][1], new THREE.Vector3());
      const outward = new THREE.Vector3(Math.cos(st.yaw) * end, 0, -Math.sin(st.yaw) * end);
      quadFacing(struct, pt(aOut, 0), pt(aOut, 1), pt(aOut, 2), pt(aOut, 3), outward);
      quadFacing(struct, pt(aIn, 0), pt(aIn, 1), pt(aIn, 2), pt(aIn, 3), outward.clone().negate());
      quadFacing(struct, pt(aIn, 1), pt(aOut, 1), pt(aOut, 2), pt(aIn, 2), _up);
      quadFacing(struct, pt(aIn, 0), pt(aOut, 0), pt(aOut, 1), pt(aIn, 1), new THREE.Vector3(-ax, 0, -az));
    }
    // cantilevered roof canopy, rising slightly towards the track, with a fascia strip
    const roofBack = g + backH + (st.roof ? 3.2 : 2.4);
    const roofFront = roofBack + (st.roof ? 1.1 : 0.8);
    const dFront = -1.6;
    const dBack = backOff + 0.6;
    const half = st.length / 2 + 1;
    const thick = 0.32;
    const c = (a: number, d: number, top: boolean): THREE.Vector3 => {
      const y = lerp(roofFront, roofBack, (d - dFront) / (dBack - dFront)) + (top ? thick : 0);
      return along(a, d, y, new THREE.Vector3());
    };
    if (st.style === 'open') {
      // scaffold stand: no roof, a rail along the top of the back frame
      struct.setColor(col.set('#8a8f96'));
      along(0, backOff + 0.4, 0, _p);
      addBox(struct, _p.x, g + backH + 1.1, _p.z, st.yaw, st.length, 0.14, 0.14, 1);
    } else {
      struct.setColor(col.set(st.roof ? '#dfe1e5' : '#cfd2d6'));
      if (st.style === 'sawtooth') {
        const tooth = (a: number, d: number, lift: number): THREE.Vector3 => {
          const v = c(a, d, true);
          v.y += lift;
          return v;
        };
        const along1 = new THREE.Vector3(Math.cos(st.yaw), 0, -Math.sin(st.yaw));
        for (let a0 = -half; a0 < half - 0.1; a0 += SAWTOOTH_PITCH) {
          const a1 = Math.min(half, a0 + SAWTOOTH_PITCH);
          struct.setColor(col.set('#dfe1e5'));
          quadFacing(struct, tooth(a0, dFront, 0), tooth(a1, dFront, SAWTOOTH_RISE), tooth(a1, dBack, SAWTOOTH_RISE), tooth(a0, dBack, 0), _up);
          struct.setColor(col.set('#8fb4c8'));
          quadFacing(struct, tooth(a1, dFront, SAWTOOTH_RISE), tooth(a1, dFront, 0), tooth(a1, dBack, 0), tooth(a1, dBack, SAWTOOTH_RISE), along1);
        }
      } else quadFacing(struct, c(-half, dFront, true), c(half, dFront, true), c(half, dBack, true), c(-half, dBack, true), _up);
      struct.setColor(col.set('#b9bcc2'));
      quadFacing(struct, c(-half, dFront, false), c(half, dFront, false), c(half, dBack, false), c(-half, dBack, false), _down);
      for (const end of [-1, 1]) {
        const a = end * half;
        quadFacing(struct, c(a, dFront, false), c(a, dBack, false), c(a, dBack, true), c(a, dFront, true), new THREE.Vector3(Math.cos(st.yaw) * end, 0, -Math.sin(st.yaw) * end));
      }
      struct.setColor(col.copy(st.seat).lerp(_white, 0.15));
      const fasciaBottom = (a: number): THREE.Vector3 => along(a, dFront - 0.02, roofFront - 0.6, new THREE.Vector3());
      const fasciaTop = (a: number): THREE.Vector3 => along(a, dFront - 0.02, roofFront + thick + 0.05, new THREE.Vector3());
      quadFacing(struct, fasciaBottom(-half), fasciaBottom(half), fasciaTop(half), fasciaTop(-half), new THREE.Vector3(-ax, 0, -az));
    }
    // back columns + lamps under the canopy
    for (let i = 0; i <= Math.floor(st.length / 20); i++) {
      const a = -st.length / 2 + i * 20;
      along(a, backOff + 0.5, 0, _p);
      struct.setColor(col.set('#5b5f66'));
      addBox(struct, _p.x, (g + roofBack) / 2, _p.z, st.yaw, 0.4, roofBack - g, 0.4, 1);
      if (st.roof && ctx.timeOfDay !== 'day') addBox(lampHeads, _p.x - ax * 1.5, roofBack - 0.4, _p.z - az * 1.5, st.yaw, 2.2, 0.25, 0.8, 1);
    }
  }
  for (const mesh of crowd.build(disposer)) group.add(mesh);

  // ── marshal posts ──
  const marshalPosts: MarshalSite[] = [];
  {
    let side = 1;
    for (let s = 150; s < t.length - 100; s += 360) {
      const k = wrapIndex(Math.round(s / Math.max(0.01, t.spacing)), n);
      side = -side;
      if (f.inPit[k] && side === f.pitSign) side = -side;
      sidePoint(t, k, side * (f.occupiedTo(k, side) + 3.5), 0, _p);
      if (!f.isClear(_p.x, _p.z, 1.5) || blockedAt(ctx, k, 12)) continue;
      const g = heightAtXZ(_p.x, _p.z);
      const yaw = headingAt(t, k);
      struct.setColor(col.set('#f07a2a'));
      addBox(struct, _p.x, g + 1.2, _p.z, yaw, 2.2, 2.4, 2.2, 1);
      struct.setColor(col.set('#f4f4f4'));
      addBox(struct, _p.x, g + 2.5, _p.z, yaw, 2.6, 0.2, 2.6, 1);
      addCylinderY(struct, _p.x + 1.4, g, _p.z, 0.04, 4.2, 6);
      struct.setColor(col.set('#2fa84f'));
      addBox(struct, _p.x + 1.85, g + 3.8, _p.z, yaw, 0.85, 0.55, 0.02, 1);
      ctx.exclusions.push({ x: _p.x, z: _p.z, r: 4 });
      marshalPosts.push({ s, k, side });
    }
  }

  // ── lamp posts / floodlight towers ──
  const lit = ctx.timeOfDay !== 'day' || ctx.street;
  if (lit) {
    const tower = ctx.timeOfDay === 'night';
    const every = tower ? 70 : 50;
    const height = tower ? 22 : 10;
    for (let s = 10; s < t.length; s += every) {
      for (const side of [-1, 1]) {
        if ((Math.round(s / every) + (side > 0 ? 1 : 0)) % 2 === 1 && tower) continue;
        const k = wrapIndex(Math.round(s / Math.max(0.01, t.spacing)), n);
        if (f.inPit[k] && side === f.pitSign && f.pitStraight[k]) continue;
        if (blockedAt(ctx, k, 8)) continue;
        sidePoint(t, k, side * (f.occupiedTo(k, side) + (tower ? 5 : 2.5)), 0, _p);
        if (!f.isClear(_p.x, _p.z, 1) || ctx.exclusions.some((e) => (e.x - _p.x) ** 2 + (e.z - _p.z) ** 2 < e.r * e.r)) continue;
        const g = heightAtXZ(_p.x, _p.z);
        struct.setColor(col.set('#4a4e55'));
        addCylinderY(struct, _p.x, g - 0.3, _p.z, tower ? 0.28 : 0.12, height + 0.3, 8);
        const yaw = headingAt(t, k);
        // head leans over towards the track
        const hx = _p.x - side * t.rx[k] * (tower ? 0.6 : 1.4);
        const hz = _p.z - side * t.rz[k] * (tower ? 0.6 : 1.4);
        if (tower) {
          poolSites.push(k);
          lampFrames.setColor(col.set('#30333a'));
          // local X of a track-aligned box is lateral, local Z is along the track
          addBox(lampFrames, hx, g + height + 1.1, hz, yaw, 0.5, 2.6, 4.6, 1);
          // 3 × 3 lamp panels facing the track, catwalk under the frame
          for (let row = 0; row < 3; row++) {
            for (let c = 0; c < 3; c++) {
              const al = (c - 1) * 1.5;
              // (0.3 m deep, in front of the frame: a paper-thin panel seen edge-on from down the road left only the dark frame)
              addBox(lampHeads, hx - side * t.rx[k] * 0.38 + t.tx[k] * al, g + height + 0.3 + row * 0.82, hz - side * t.rz[k] * 0.38 + t.tz[k] * al, yaw, 0.3, 0.7, 1.3, 1);
            }
          }
          addBox(lampFrames, hx, g + height - 0.15, hz, yaw, 1.4, 0.12, 4.8, 1);
        } else {
          // arm from the pole top to the head, so the head never floats
          const armLen = 1.4 + 0.2;
          lampFrames.setColor(col.set('#4a4e55'));
          addBox(lampFrames, _p.x - side * t.rx[k] * (armLen / 2 - 0.12), g + height - 0.04, _p.z - side * t.rz[k] * (armLen / 2 - 0.12), yaw, armLen, 0.1, 0.1, 1);
          addBox(lampHeads, hx, g + height - 0.14, hz, yaw, 1.1, 0.18, 0.5, 1);
        }
        ctx.exclusions.push({ x: _p.x, z: _p.z, r: 2 });
      }
    }
  }

  const sg = struct.build();
  if (sg) {
    disposer.add(sg);
    const mat = disposer.add(new THREE.MeshStandardMaterial({ name: 'structures', vertexColors: true, roughness: 0.75, metalness: 0.1 }));
    const mesh = new THREE.Mesh(sg, mat);
    mesh.name = 'structures';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  // soft additive pools of floodlight on the road under every tower (vertex-shaded, one draw call)
  if (poolSites.length > 0) {
    const pools = new GeoBuilder(true);
    const step = Math.max(1, Math.round(LIGHT_POOL_STEP / Math.max(0.01, t.spacing)));
    // the last row sits at (or beyond) the pool end, where the falloff is exactly 0: no residual hard edge
    const rows = Math.ceil(LIGHT_POOL_LENGTH / 2 / (step * t.spacing));
    const cols = LIGHT_POOL_COLS;
    const c = new THREE.Color();
    for (const k0 of poolSites) {
      const base = pools.vertexCount;
      for (let r = -rows; r <= rows; r++) {
        const k = wrapIndex(k0 + r * step, n);
        const da = Math.min(1, Math.abs((r * step * t.spacing) / (LIGHT_POOL_LENGTH / 2)));
        for (let q = 0; q <= cols; q++) {
          const u = q / cols;
          const lat = -f.barrierL[k] + u * (f.barrierL[k] + f.barrierR[k]);
          const dl = (u - 0.5) * 2;
          // smoothstep windows: zero value and zero slope at the pool rim and at both barriers
          const v = (1 - smoothstep(0, 1, da)) ** 1.5 * (1 - smoothstep(0.1, 1, Math.abs(dl))) * LIGHT_POOL_STRENGTH;
          c.setRGB(v, v * 0.9, v * 0.72);
          pools.setColor(c);
          sidePoint(t, k, lat, LIGHT_POOL_LIFT, _p);
          pools.vertex(_p.x, _p.y, _p.z, 0, 1, 0, 0, 0);
        }
      }
      for (let r = 0; r < 2 * rows; r++) {
        for (let q = 0; q < cols; q++) {
          const a = base + r * (cols + 1) + q;
          // rows run ahead, columns to the right (-X for yaw 0): counter-clockwise seen from above
          pools.quad(a, a + 1, a + cols + 2, a + cols + 1);
        }
      }
    }
    const pg = pools.build();
    if (pg) {
      disposer.add(pg);
      const mat = disposer.add(
        new THREE.MeshBasicMaterial({ name: 'light-pools', vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      );
      ctx.lampMaterials.push(mat);
      ctx.lampBase.push(new THREE.Color(1, 1, 1));
      const mesh = new THREE.Mesh(pg, mat);
      mesh.name = 'lightPools';
      mesh.renderOrder = 2;
      group.add(mesh);
    }
  }
  const fg = lampFrames.build();
  if (fg) {
    disposer.add(fg);
    const mat = disposer.add(new THREE.MeshStandardMaterial({ name: 'lamp-frames', vertexColors: true, roughness: 0.75, metalness: 0.1 }));
    const mesh = new THREE.Mesh(fg, mat);
    mesh.name = 'lampFrames';
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const lg = lampHeads.build();
  if (lg) {
    disposer.add(lg);
    const base = new THREE.Color(1.0, 0.93, 0.8);
    const mat = disposer.add(new THREE.MeshBasicMaterial({ name: 'lamp-heads', color: base.clone(), toneMapped: false }));
    ctx.lampMaterials.push(mat);
    ctx.lampBase.push(base);
    const mesh = new THREE.Mesh(lg, mat);
    mesh.name = 'lampHeads';
    group.add(mesh);
  }
  return { group, tvSpots, marshalPosts, featureStandsBuilt };
}
