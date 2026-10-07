/**
 * Trackside signage from one canvas atlas: original fictional advertising hoardings, braking distance
 * boards (200 / 150 / 100) before heavy-braking corners, DRS detection / activation boards, corner
 * numbers and pit entry signs. All boards (faces, backs, legs) are merged into a single mesh.
 */
import * as THREE from 'three';
import { forwardDistance, poseAt, sampleAt, wrapS } from '../../track/track';
import { canvasTexture, createCanvas, fitFont, UI_FONT, type Canvas2D } from '../core/canvas';
import { GeoBuilder } from '../core/geometry';
import { inTunnel, type SceneryContext } from './context';

/** Original, fictional brands only. */
export const AD_BRANDS: { name: string; tag: string; bg: string; fg: string; accent: string }[] = [
  { name: 'NOVA FUEL', tag: '新星能源', bg: '#0f2a5c', fg: '#ffffff', accent: '#ffb000' },
  { name: 'KAIROS', tag: 'POWER UNITS', bg: '#111111', fg: '#e8c25a', accent: '#e8c25a' },
  { name: 'HELION', tag: 'HYBRID SYSTEMS', bg: '#f4f4f4', fg: '#d12f2f', accent: '#222222' },
  { name: 'ORBIT LINK', tag: '星環通訊', bg: '#1b8f8a', fg: '#ffffff', accent: '#b8fff6' },
  { name: 'ZEPHYRA', tag: 'AIRWAYS', bg: '#2a1e5c', fg: '#ffffff', accent: '#ff7ac8' },
  { name: 'TERRAGRIP', tag: 'RACING TYRES', bg: '#f2c230', fg: '#111111', accent: '#111111' },
  { name: 'AERILUX', tag: 'TIMEPIECES', bg: '#0b0b0b', fg: '#f4f1e8', accent: '#9ad1ff' },
  { name: 'PULSARO', tag: '極速飲料', bg: '#e8322f', fg: '#ffffff', accent: '#ffe066' },
  { name: 'LUMIQA', tag: 'DISPLAYS', bg: '#ffffff', fg: '#2b59c3', accent: '#2b59c3' },
  { name: 'VOLTARIS', tag: 'CHARGING', bg: '#103b2c', fg: '#a6f05a', accent: '#a6f05a' },
  { name: '晨曦銀行', tag: 'DAWNBRIDGE BANK', bg: '#5b1d1d', fg: '#ffe7c2', accent: '#ffcf6b' },
  { name: 'FORMULA NOVA', tag: '新星方程式 25', bg: '#121a33', fg: '#ffffff', accent: '#ff3b5c' },
];

const COLS = 8;
const ROWS = 16;
/** Board legs reach this far below the ground height they are given (the terrain is lowered around the corridor). */
const LEG_FOOT_Y = -1.2;
export const CELL = {
  adFirst: 0,
  brake200: 12,
  brake150: 13,
  brake100: 14,
  drsDetect: 15,
  drsZone: 16,
  pitIn: 17,
  back: 18,
  leg: 19,
  cornerFirst: 24,
  cornerCount: 40,
} as const;

function cellRect(c: Canvas2D, idx: number): { x: number; y: number; w: number; h: number } {
  const w = c.w / COLS;
  const h = c.h / ROWS;
  return { x: (idx % COLS) * w, y: Math.floor(idx / COLS) * h, w, h };
}

/** UV rectangle of a cell (inset to avoid mip bleeding). */
function cellUV(idx: number): { u0: number; v0: number; u1: number; v1: number } {
  const col = idx % COLS;
  const row = Math.floor(idx / COLS);
  const iu = 0.012 / COLS;
  const iv = 0.02 / ROWS;
  const u0 = col / COLS + iu;
  const u1 = (col + 1) / COLS - iu;
  // canvas row 0 is the top -> highest v
  const v1 = 1 - row / ROWS - iv;
  const v0 = 1 - (row + 1) / ROWS + iv;
  return { u0, v0, u1, v1 };
}

export function paintBoardAtlas(size: number): Canvas2D {
  const c = createCanvas(size, size);
  const { ctx } = c;
  ctx.fillStyle = '#555';
  ctx.fillRect(0, 0, c.w, c.h);
  AD_BRANDS.forEach((b, i) => {
    const r = cellRect(c, CELL.adFirst + i);
    ctx.fillStyle = b.bg;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = b.accent;
    ctx.fillRect(r.x, r.y + r.h * 0.84, r.w, r.h * 0.08);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = b.fg;
    fitFont(ctx, b.name, '900', r.h * 0.42, r.w * 0.9);
    ctx.fillText(b.name, r.x + r.w / 2, r.y + r.h * 0.4);
    ctx.fillStyle = b.accent;
    fitFont(ctx, b.tag, '700', r.h * 0.17, r.w * 0.8);
    ctx.fillText(b.tag, r.x + r.w / 2, r.y + r.h * 0.7);
  });
  const sign = (idx: number, text: string, bg: string, fg: string, border: string, sizeK = 0.62): void => {
    const r = cellRect(c, idx);
    ctx.fillStyle = border;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = bg;
    ctx.fillRect(r.x + r.w * 0.05, r.y + r.h * 0.08, r.w * 0.9, r.h * 0.84);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, text, '900', r.h * sizeK, r.w * 0.82);
    ctx.fillText(text, r.x + r.w / 2, r.y + r.h * 0.53);
  };
  sign(CELL.brake200, '200', '#ffffff', '#111111', '#1a3f9e', 0.66);
  sign(CELL.brake150, '150', '#ffffff', '#111111', '#1a3f9e', 0.66);
  sign(CELL.brake100, '100', '#ffffff', '#111111', '#1a3f9e', 0.66);
  sign(CELL.drsDetect, 'DRS 偵測點', '#ffffff', '#111111', '#2fa84f', 0.4);
  sign(CELL.drsZone, 'DRS 啟用區', '#2fa84f', '#ffffff', '#ffffff', 0.4);
  sign(CELL.pitIn, '維修區入口 PIT', '#ffffff', '#d12f2f', '#d12f2f', 0.34);
  {
    const r = cellRect(c, CELL.back);
    ctx.fillStyle = '#6d7076';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const l = cellRect(c, CELL.leg);
    ctx.fillStyle = '#2a2b2e';
    ctx.fillRect(l.x, l.y, l.w, l.h);
  }
  for (let i = 0; i < CELL.cornerCount; i++) {
    const r = cellRect(c, CELL.cornerFirst + i);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#111111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.floor(r.h * 0.52)}px ${UI_FONT}`;
    ctx.fillText(`T${i + 1}`, r.x + r.w / 2, r.y + r.h * 0.42);
    ctx.font = `700 ${Math.floor(r.h * 0.2)}px ${UI_FONT}`;
    ctx.fillText(`第 ${i + 1} 彎`, r.x + r.w / 2, r.y + r.h * 0.8);
  }
  return c;
}

const _n = new THREE.Vector3();
const _u = new THREE.Vector3();

/** Board helper: front face (cell) facing `normal`, plain back, two legs. */
function addBoard(b: GeoBuilder, cx: number, cy0: number, cz: number, nx: number, nz: number, w: number, h: number, cell: number, legs: boolean): void {
  _n.set(nx, 0, nz);
  if (_n.lengthSq() < 1e-8) _n.set(0, 0, 1);
  _n.normalize();
  // U = Y x N (reads left-to-right for a viewer in front of the board)
  _u.set(_n.z, 0, -_n.x);
  const face = (normalSign: number, idx: number, offset: number): void => {
    const nX = _n.x * normalSign;
    const nZ = _n.z * normalSign;
    const ux = _u.x * normalSign;
    const uz = _u.z * normalSign;
    const ox = cx + _n.x * offset;
    const oz = cz + _n.z * offset;
    const uv = cellUV(idx);
    const a = b.vertex(ox - ux * (w / 2), cy0, oz - uz * (w / 2), nX, 0, nZ, uv.u0, uv.v0);
    b.vertex(ox + ux * (w / 2), cy0, oz + uz * (w / 2), nX, 0, nZ, uv.u1, uv.v0);
    b.vertex(ox + ux * (w / 2), cy0 + h, oz + uz * (w / 2), nX, 0, nZ, uv.u1, uv.v1);
    b.vertex(ox - ux * (w / 2), cy0 + h, oz - uz * (w / 2), nX, 0, nZ, uv.u0, uv.v1);
    b.quad(a, a + 1, a + 2, a + 3);
  };
  face(1, cell, 0.02);
  face(-1, CELL.back, -0.02);
  if (legs && cy0 > 0.05) {
    for (const s of [-0.42, 0.42]) {
      const lx = cx + _u.x * w * s;
      const lz = cz + _u.z * w * s;
      // a two-sided thin leg (front + back quads)
      for (const sign of [1, -1]) {
        const uv = cellUV(CELL.leg);
        const nX = _n.x * sign;
        const nZ = _n.z * sign;
        const ux = _u.x * sign;
        const uz = _u.z * sign;
        const ox = lx - _n.x * 0.03 * sign;
        const oz = lz - _n.z * 0.03 * sign;
        const a = b.vertex(ox - ux * 0.06, LEG_FOOT_Y, oz - uz * 0.06, nX, 0, nZ, uv.u0, uv.v0);
        b.vertex(ox + ux * 0.06, LEG_FOOT_Y, oz + uz * 0.06, nX, 0, nZ, uv.u1, uv.v0);
        b.vertex(ox + ux * 0.06, cy0, oz + uz * 0.06, nX, 0, nZ, uv.u1, uv.v1);
        b.vertex(ox - ux * 0.06, cy0, oz - uz * 0.06, nX, 0, nZ, uv.u0, uv.v1);
        b.quad(a, a + 1, a + 2, a + 3);
      }
    }
  }
}

export function buildBoards(ctx: SceneryContext): THREE.Mesh | null {
  const { track: t, frame: f, disposer } = ctx;
  const n = t.count;
  if (n < 4) return null;
  const b = new GeoBuilder();
  const place = (s: number, lat: number, y0: number, w: number, h: number, cell: number, facing: 'track' | 'oncoming'): void => {
    const p = poseAt(t, wrapS(t, s), lat);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    // nothing beside a bridge deck (the board would float beyond the parapet) or inside a tunnel's walls
    if (sampleAt(t, t.deck, wrapS(t, s)) > 0.5 || inTunnel(ctx, wrapS(t, s), 6)) return;
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    const rx = -fz;
    const rz = fx;
    let nx: number;
    let nz: number;
    if (facing === 'oncoming') {
      nx = -fx;
      nz = -fz;
    } else {
      const sg = lat >= 0 ? -1 : 1;
      nx = rx * sg;
      nz = rz * sg;
    }
    // keep clear of other track sections
    const ux = nz;
    const uz = -nx;
    if (!f.isClear(p.x + ux * w * 0.5, p.z + uz * w * 0.5, 0.3) || !f.isClear(p.x - ux * w * 0.5, p.z - uz * w * 0.5, 0.3)) {
      if (facing === 'track') return;
    }
    addBoardAbs(b, p.x, p.y + y0, p.z, p.y, nx, nz, w, h, cell);
  };
  const barrierAt = (s: number, side: number): number => {
    const k = Math.round(wrapS(t, s) / Math.max(0.01, t.spacing)) % n;
    return f.occupiedTo(k, side);
  };

  // advertising hoardings behind the barriers (skip the pit side in the pit zone)
  const spacing = ctx.street ? 45 : 70;
  let ad = 0;
  for (let s = 20; s < t.length - 20; s += spacing) {
    for (const side of [-1, 1]) {
      const k = Math.round(s / Math.max(0.01, t.spacing)) % n;
      if (f.inPit[k] && side === f.pitSign) continue;
      if ((Math.floor(s / spacing) + (side > 0 ? 1 : 0)) % 2 === 1) continue;
      const lat = side * (barrierAt(s, side) + 2.2);
      place(s, lat, 0.45, 7, 1.75, CELL.adFirst + (ad++ % AD_BRANDS.length), 'track');
    }
  }

  // braking boards before heavy-braking corners
  for (const c of t.corners) {
    let approach = 0;
    for (let d = 40; d <= 320; d += 20) approach = Math.max(approach, sampleAt(t, t.speedProfile, wrapS(t, c.startS - d)));
    if (!(approach - c.minSpeed > 18)) continue;
    const side = -c.direction;
    [200, 150, 100].forEach((dist, i) => {
      const s = c.startS - dist;
      const k = Math.round(wrapS(t, s) / Math.max(0.01, t.spacing)) % n;
      const hw = t.halfWidth[k];
      const kerb = side > 0 ? t.kerbRight[k] : t.kerbLeft[k];
      const bar = side > 0 ? f.barrierR[k] : f.barrierL[k];
      let lat = hw + kerb + 2.4;
      if (lat > bar - 0.8) lat = bar + 1.4;
      place(s, side * lat, 0.3, 1.1, 1.2, CELL.brake200 + i, 'oncoming');
    });
  }

  // DRS detection / activation boards (left side of the track)
  for (const z of t.drsZones) {
    const side = f.pitSign === -1 ? 1 : -1;
    place(z.detection - 5, side * (barrierAt(z.detection, side) + 1.6), 0.6, 2.4, 1.2, CELL.drsDetect, 'oncoming');
    place(z.activation - 5, side * (barrierAt(z.activation, side) + 1.6), 0.6, 2.4, 1.2, CELL.drsZone, 'oncoming');
  }

  // corner numbers on the outside of each corner
  t.corners.slice(0, CELL.cornerCount).forEach((c, i) => {
    const side = -c.direction;
    place(c.apexS, side * (barrierAt(c.apexS, side) + 2.6), 0.8, 1.5, 0.75, CELL.cornerFirst + i, 'track');
  });

  // pit entry sign
  {
    const s = t.pit.entry - 90;
    const side = f.pitSign;
    if (forwardDistance(t, wrapS(t, s), t.pit.entry) < 200) place(s, side * (barrierAt(s, side) + 1.8), 0.5, 2.6, 1.3, CELL.pitIn, 'oncoming');
  }

  const g = b.build();
  if (!g) return null;
  disposer.add(g);
  const tex = disposer.add(canvasTexture(paintBoardAtlas(ctx.quality.boardTexSize), { anisotropy: ctx.anisotropy }));
  const mat = disposer.add(new THREE.MeshStandardMaterial({ name: 'boards', map: tex, roughness: 0.6, side: THREE.FrontSide }));
  if (ctx.timeOfDay !== 'day') {
    mat.emissive.setRGB(1, 1, 1);
    mat.emissiveMap = tex;
    mat.emissiveIntensity = ctx.timeOfDay === 'night' ? 0.35 : 0.15;
  }
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'boards';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Absolute placement: ground height gy (legs reach down to it), bottom edge at y0. */
function addBoardAbs(b: GeoBuilder, x: number, y0: number, z: number, gy: number, nx: number, nz: number, w: number, h: number, cell: number): void {
  const before = b.vertexCount;
  addBoard(b, x, y0 - gy, z, nx, nz, w, h, cell, true);
  // shift the board vertically: addBoard works relative to ground 0
  for (let i = before; i < b.vertexCount; i++) b.positions[i * 3 + 1] += gy;
}
