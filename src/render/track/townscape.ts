/**
 * Street-circuit townscape: continuous building frontage close behind the barriers, in a style picked per circuit
 * (data-driven by the track id; no brands). Monaco is a pastel Riviera townscape (cream / ochre / salmon facades,
 * terracotta hip roofs, balconies, rows that step up and grow taller inland, a low open harbour side), Singapore a
 * canyon of glass towers, Las Vegas wide resort blocks with neon accents at night. Circuits without a style keep the
 * generic scattered buildings of props.ts.
 *
 * Lots are laid along both sides in rows (front row hugging the barrier, further rows behind it separated by alleys),
 * merged into three meshes (windows, structure, neon glow). Lots avoid the road corridor, exclusions (landmarks, stands,
 * pit complex), tunnels / decks, water and each other.
 */
import * as THREE from 'three';
import type { QualityLevel } from '../../core/types';
import { Rng } from '../core/canvas';
import { GeoBuilder, addBox, addGeometry } from '../core/geometry';
import { windowTexture } from '../core/surfaceTextures';
import { blockedAt, sidePoint, wrapIndex, type SceneryContext } from './context';
import { patchWindowFade } from './sceneryMaterials';

export interface TownStyle {
  /** lot length along the street (m) */
  lot: readonly [number, number];
  /** depth of each row (m), front row first */
  rowDepth: readonly number[];
  /** building height range per row (m) */
  height: readonly (readonly [number, number])[];
  /** gap between the barrier / fence and the front row, and the alley between rows (m) */
  gap: number;
  alley: number;
  /** each further row stands on a terrace this much higher (m): reads as a hillside */
  terrace: number;
  /** facade tints (multiply the window texture) */
  palette: readonly string[];
  /** window texture tile (m horizontally, m vertically) */
  tile: readonly [number, number];
  roof: 'hip' | 'flat';
  roofColors: readonly string[];
  balconies: boolean;
  /** neon accent colours (night / dusk only), or empty */
  neon: readonly string[];
  /** the harbour side keeps one low row only */
  openSea: boolean;
}

export const TOWN_STYLES: Record<string, TownStyle> = {
  monaco: {
    lot: [14, 24],
    rowDepth: [13, 15, 17],
    height: [[13, 22], [17, 28], [22, 34]],
    gap: 4,
    alley: 6,
    terrace: 3.2,
    palette: ['#f4dcb6', '#ecc78f', '#f2b9a1', '#f6e7c8', '#e9a98a', '#dcbc8e', '#f7f0e1', '#d3b08d', '#e8cba3', '#f0cdb0'],
    tile: [18, 24],
    roof: 'hip',
    roofColors: ['#b5552f', '#a04a2c', '#c0643a', '#9c4a2a'],
    balconies: true,
    neon: [],
    openSea: true,
  },
  singapore: {
    lot: [26, 40],
    rowDepth: [24, 28],
    height: [[45, 110], [70, 190]],
    gap: 7,
    alley: 14,
    terrace: 0,
    palette: ['#a9bdd0', '#b9c6d3', '#93abc2', '#c7cfd8', '#8aa3bb', '#b2bec9'],
    tile: [14, 32],
    roof: 'flat',
    roofColors: ['#6d747d', '#868d96'],
    balconies: false,
    neon: ['#ffe2a8', '#bfe3ff'],
    openSea: false,
  },
  'las-vegas': {
    lot: [32, 54],
    rowDepth: [26, 32],
    height: [[28, 70], [55, 150]],
    gap: 9,
    alley: 16,
    terrace: 0,
    palette: ['#eadcb8', '#dcc18a', '#cfa970', '#f1e6cc', '#bfa57f', '#d9ccb4'],
    tile: [20, 28],
    roof: 'flat',
    roofColors: ['#8a8378', '#9b9488'],
    balconies: false,
    neon: ['#ff3fa4', '#35d6ff', '#ffb02e', '#a56bff'],
    openSea: false,
  },
};

/** The townscape style of this circuit, or null (generic scattered buildings). */
export function townStyleFor(ctx: Pick<SceneryContext, 'track'>): TownStyle | null {
  return TOWN_STYLES[ctx.track.def.id] ?? null;
}

/** Rows built and lot budget by quality. */
const ROWS_BY_LEVEL: Record<QualityLevel, number> = { low: 1, medium: 2, high: 3, ultra: 3 };
const LOT_CAP: Record<QualityLevel, number> = { low: 150, medium: 280, high: 520, ultra: 700 };
/** Floor height (m) used for balconies, and the share of lots left empty (gaps in the frontage). */
const FLOOR_H = 3;
const LOT_SKIP = 0.05;
/** Seaward test: this far (m) beyond a lot, ground below sea level + HARBOUR_DROP means the lot faces the harbour. */
const HARBOUR_PROBE = 110;
const HARBOUR_DROP = 6;
const HARBOUR_ROW_HEIGHT: readonly [number, number] = [8, 13];
const HIP = Math.SQRT1_2;
/** Lots on ground that falls more than SLOPE_STEP_MIN (m) across the footprint get a stepped foundation: step height, outset per step (m), most steps. */
const SLOPE_STEP_MIN = 0.7;
const STEP_RISE = 2.4;
const STEP_OUTSET = 0.4;
const STEP_MAX = 4;

interface Disc {
  x: number;
  z: number;
  r: number;
}

export function buildTownscape(
  ctx: SceneryContext,
  heightAtXZ: (x: number, z: number) => number,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  seaLevel: number | null,
): THREE.Group | null {
  const style = townStyleFor(ctx);
  if (!style) return null;
  const { track: t, frame: f, disposer } = ctx;
  const n = t.count;
  const level = ctx.quality.level;
  const rows = Math.min(style.rowDepth.length, ROWS_BY_LEVEL[level] ?? 2);
  const cap = LOT_CAP[level] ?? 300;
  const rng = new Rng(ctx.seed + 4242);
  const lit = ctx.timeOfDay !== 'day';
  const win = new GeoBuilder(true);
  const struct = new GeoBuilder(true);
  const glow = new GeoBuilder(true);
  const col = new THREE.Color();
  const roofGeo = new THREE.ConeGeometry(1, 1, 4, 1);
  roofGeo.rotateY(Math.PI / 4);
  roofGeo.translate(0, 0.5, 0);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const cell = 40;
  const hash = new Map<number, Disc[]>();
  const key = (x: number, z: number): number => Math.floor(x / cell) * 73856093 + Math.floor(z / cell) * 19349663;
  const overlaps = (x: number, z: number, r: number): boolean => {
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const list = hash.get(key(x + ix * cell, z + iz * cell));
        if (list && list.some((d) => (d.x - x) ** 2 + (d.z - z) ** 2 < (d.r + r) ** 2)) return true;
      }
    }
    return false;
  };
  const insert = (d: Disc): void => {
    const k = key(d.x, d.z);
    const list = hash.get(k);
    if (list) list.push(d);
    else hash.set(k, [d]);
  };
  const inBounds = (x: number, z: number): boolean => x > bounds.minX + 40 && x < bounds.maxX - 40 && z > bounds.minZ + 40 && z < bounds.maxZ - 40;
  const excluded = (x: number, z: number, r: number): boolean => ctx.exclusions.some((e) => (e.x - x) ** 2 + (e.z - z) ** 2 < (e.r + r * 0.5) ** 2);
  const idxAt = (s: number): number => wrapIndex(Math.round(s / Math.max(0.01, t.spacing)), n);
  /** per side and 10 m bin: the row in front stands here (rows behind need it, so no tower floats behind a gap) */
  const front: Record<number, Uint8Array[]> = { [-1]: [], [1]: [] };
  const bins = Math.ceil(t.length / 10) + 2;
  for (const side of [-1, 1]) for (let r = 0; r < rows; r++) front[side].push(new Uint8Array(bins));
  let lots = 0;

  // Lot frame: addBox's local X runs across the street and local Z along it, so a lot of frontage `w` (along the street) and
  // depth `d` (away from it) is a box of d × w; `nx / nz` point from the lot to the street, `ax / az` run along it.
  const addLot = (row: number, side: 1 | -1, kc: number, w: number, d: number, h: number, yaw: number, x: number, z: number, gMax: number, gMin: number, base: number, seaward: boolean): void => {
    const tint = col.set(rng.pick(style.palette));
    win.setColor(tint);
    const top = gMax + base + h;
    const nx = -side * t.rx[kc];
    const nz = -side * t.rz[kc];
    const ax = Math.sin(yaw);
    const az = Math.cos(yaw);
    // on a slope the facade starts at the highest ground (no windows buried in the hillside) and a stepped stucco foundation,
    // wider at each lower step, carries it down to the lowest ground; on flat ground the walls simply sink 0.6 m
    const slope = gMax - gMin;
    const stepped = slope > SLOPE_STEP_MIN;
    const bottom = stepped ? gMax - 0.1 : gMin - 0.6;
    if (stepped) {
      const steps = level === 'low' ? 1 : Math.min(STEP_MAX, Math.ceil(slope / STEP_RISE));
      const foot = col.set(rng.pick(style.palette)).multiplyScalar(0.62);
      struct.setColor(foot);
      for (let j = 0; j < steps; j++) {
        const stepTop = gMax - 0.1 - (j * (slope + 0.6)) / steps;
        const inset = (j + 1) * STEP_OUTSET;
        addBox(struct, x, (stepTop + gMin - 0.6) / 2, z, yaw, d + inset * 2, stepTop - (gMin - 0.6), w + inset * 2, 1);
      }
    }
    const before = win.vertexCount;
    addBox(win, x, (top + bottom) / 2, z, yaw, d, top - bottom, w, 1);
    const u0 = rng.next();
    const v0 = Math.floor(rng.next() * 8) / 8;
    for (let i = before; i < win.vertexCount; i++) {
      if (win.normals[i * 3 + 1] > 0.5) {
        win.uvs[i * 2] = 0.01;
        win.uvs[i * 2 + 1] = 0.01;
      } else {
        win.uvs[i * 2] = win.uvs[i * 2] / style.tile[0] + u0;
        win.uvs[i * 2 + 1] = win.uvs[i * 2 + 1] / style.tile[1] + v0;
      }
    }
    // roof
    const roofCol = col.set(rng.pick(style.roofColors));
    struct.setColor(roofCol);
    if (style.roof === 'hip') {
      const rh = Math.min(w, d) * rng.range(0.22, 0.34);
      q.setFromAxisAngle(up, yaw);
      m4.compose(new THREE.Vector3(x, top, z), q, new THREE.Vector3(((d / 2 + 0.45) / HIP) * 1, rh, ((w / 2 + 0.45) / HIP) * 1));
      addGeometry(struct, roofGeo, m4);
      // eaves band and a chimney
      struct.setColor(col.set('#efe6d4'));
      addBox(struct, x, top - 0.15, z, yaw, d + 0.5, 0.3, w + 0.5, 1);
      if (rng.next() < 0.6) {
        struct.setColor(col.set('#cdb89a'));
        addBox(struct, x + ax * w * 0.25, top + rh * 0.45, z + az * w * 0.25, yaw, 0.7, rh * 0.9, 0.7, 1);
      }
    } else {
      // flat roof: parapet band, roof plant, a stepped crown on the tall ones
      addBox(struct, x, top + 0.4, z, yaw, d + 0.4, 0.8, w + 0.4, 1);
      struct.setColor(col.set('#5d636b'));
      addBox(struct, x - nx * d * 0.2, top + 1.4, z - nz * d * 0.2, yaw, d * 0.4, 1.2, w * 0.35, 1);
      if (h > 60) {
        struct.setColor(col.set('#cfd5dc'));
        addBox(struct, x, top + 2.8 + h * 0.03, z, yaw, d * 0.62, 5.6 + h * 0.06, w * 0.62, 1);
      }
    }
    // balconies on the street face (every other floor: a slab on two corbels, a cream parapet, a thin dark handrail)
    if (style.balconies && level !== 'low' && row < (level === 'medium' ? 1 : 2) && !seaward) {
      const floors = Math.floor(h / FLOOR_H);
      const bw = w * 0.45;
      for (let fl = 1; fl < floors; fl += 2) {
        const y = top - h + fl * FLOOR_H;
        const bx = x + nx * (d / 2 + 0.55);
        const bz = z + nz * (d / 2 + 0.55);
        struct.setColor(col.set('#e9e1d2'));
        addBox(struct, bx, y, bz, yaw, 1.1, 0.18, bw, 1);
        for (const e of [-1, 1]) {
          const o = e * (bw / 2 - 0.3);
          addBox(struct, bx - nx * 0.25 + ax * o, y - 0.45, bz - nz * 0.25 + az * o, yaw, 0.55, 0.7, 0.25, 1);
        }
        addBox(struct, bx + nx * 0.5, y + 0.5, bz + nz * 0.5, yaw, 0.08, 0.8, bw, 1);
        struct.setColor(col.set('#5a5f66'));
        addBox(struct, bx + nx * 0.5, y + 0.94, bz + nz * 0.5, yaw, 0.14, 0.06, bw + 0.06, 1);
      }
    }
    // neon accents (night / dusk): edge strips on the street face and along the roof line
    if (lit && style.neon.length > 0 && h > 35) {
      const c = col.set(rng.pick(style.neon)).multiplyScalar(1.1);
      glow.setColor(c);
      // strips sit flush on the street facade (the facade is `d / 2` from the lot centre)
      const fx = x + nx * (d / 2 + 0.06);
      const fz = z + nz * (d / 2 + 0.06);
      addBox(glow, fx, top + 0.9, fz, yaw, 0.2, 0.45, w + 0.5, 1);
      if (rng.next() < 0.6) {
        for (const e of [-1, 1]) {
          const o = e * (w / 2 - 0.3);
          addBox(glow, fx + ax * o, top - h * 0.5, fz + az * o, yaw, 0.2, h * 0.8, 0.35, 1);
        }
      }
    } else if (lit && style.roof === 'flat' && h > 90) {
      glow.setColor(col.set('#ffe2b0').multiplyScalar(0.9));
      addBox(glow, x, top + 0.35, z, yaw, d + 0.5, 0.25, w + 0.5, 1);
    }
  };

  for (let row = 0; row < rows && lots < cap; row++) {
    for (const side of [-1, 1] as const) {
      let s = rng.range(0, 10);
      while (s < t.length && lots < cap) {
        const w = rng.range(style.lot[0], style.lot[1]);
        const sc = s + w / 2;
        const kc = idxAt(sc);
        s += w + (rng.next() < 0.1 ? style.alley * 0.5 : 0.6);
        const bin = Math.floor(sc / 10);
        if (rng.next() < LOT_SKIP || blockedAt(ctx, kc, 25) || (f.inPit[kc] && side === f.pitSign)) continue;
        if (row > 0 && !front[side][row - 1][bin]) continue;
        const yaw = Math.atan2(t.tx[kc], t.tz[kc]);
        const c = Math.cos(yaw);
        const sn = Math.sin(yaw);
        let off = f.occupiedTo(kc, side) + style.gap;
        for (let r = 0; r < row; r++) off += style.rowDepth[r] + style.alley;
        // the front row shrinks in depth where another road runs close behind it (narrow streets)
        let fit: { d: number; latC: number; x: number; z: number; gMin: number; gMax: number } | null = null;
        for (const sh of row === 0 ? [1, 0.7, 0.5] : [1]) {
          const d = style.rowDepth[row] * sh;
          const latC = off + d / 2;
          sidePoint(t, kc, side * latC, 0, _p);
          const x = _p.x;
          const z = _p.z;
          const rIn = Math.min(w, d) / 2;
          if (!inBounds(x, z) || excluded(x, z, rIn) || overlaps(x, z, rIn * 0.9)) continue;
          let ok = true;
          let gMin = Infinity;
          let gMax = -Infinity;
          for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
            const px = x + ((cx * d) / 2) * c + ((cz * w) / 2) * sn;
            const pz = z - ((cx * d) / 2) * sn + ((cz * w) / 2) * c;
            if (!f.isClear(px, pz, 1.5)) {
              ok = false;
              break;
            }
            const g = heightAtXZ(px, pz);
            gMin = Math.min(gMin, g);
            gMax = Math.max(gMax, g);
          }
          if (ok) {
            fit = { d, latC, x, z, gMin, gMax };
            break;
          }
        }
        if (!fit || (seaLevel !== null && fit.gMin < seaLevel + 0.8)) continue;
        const { d, latC, x, z, gMin, gMax } = fit;
        const rIn = Math.min(w, d) / 2;
        let seaward = false;
        if (style.openSea && seaLevel !== null) {
          sidePoint(t, kc, side * (latC + HARBOUR_PROBE), 0, _p);
          seaward = heightAtXZ(_p.x, _p.z) < seaLevel + HARBOUR_DROP;
        }
        if (seaward && row > 0) continue;
        const range = seaward ? HARBOUR_ROW_HEIGHT : style.height[row];
        const h = rng.range(range[0], range[1]);
        // the lot stands on the highest corner; terraces lift rows further from the street
        addLot(row, side, kc, w, d, h, yaw, x, z, gMax, gMin, row * style.terrace, seaward);
        insert({ x, z, r: rIn });
        ctx.exclusions.push({ x, z, r: Math.hypot(w, d) / 2 });
        front[side][row][bin] = 1;
        if (w > 20) front[side][row][Math.floor((sc + w / 2 - 1) / 10)] = 1;
        if (w > 20) front[side][row][Math.max(0, Math.floor((sc - w / 2 + 1) / 10))] = 1;
        lots++;
      }
    }
  }
  roofGeo.dispose();
  if (lots === 0) return null;

  const group = new THREE.Group();
  group.name = 'townscape';
  const wg = win.build();
  if (wg) {
    disposer.add(wg);
    const mat = new THREE.MeshStandardMaterial({ name: 'townscape-windows', map: disposer.add(windowTexture(false)), vertexColors: true, roughness: 0.8 });
    if (lit) {
      mat.emissiveMap = disposer.add(windowTexture(true));
      mat.emissive.setRGB(1, 1, 1);
      mat.emissiveIntensity = ctx.timeOfDay === 'night' ? 1.1 : 0.45;
    }
    patchWindowFade(mat);
    disposer.add(mat);
    const mesh = new THREE.Mesh(wg, mat);
    mesh.name = 'townscape';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const sg = struct.build();
  if (sg) {
    disposer.add(sg);
    const mat = disposer.add(new THREE.MeshStandardMaterial({ name: 'townscape-structure', vertexColors: true, roughness: 0.78 }));
    const mesh = new THREE.Mesh(sg, mat);
    mesh.name = 'townscape:structure';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const gg = glow.build();
  if (gg) {
    disposer.add(gg);
    const mat = disposer.add(new THREE.MeshBasicMaterial({ name: 'townscape-neon', vertexColors: true, toneMapped: false }));
    ctx.lampMaterials.push(mat);
    ctx.lampBase.push(new THREE.Color(1, 1, 1));
    const mesh = new THREE.Mesh(gg, mat);
    mesh.name = 'townscape:neon';
    group.add(mesh);
  }
  return group;
}

const _p = new THREE.Vector3();
