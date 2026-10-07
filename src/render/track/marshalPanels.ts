/**
 * Marshal LED flag panels: one panel on a mast next to every marshal post (plus extra masts where posts are far
 * apart), angled towards approaching traffic. Panels are grouped per sector (BuiltTrack.sectorStarts): one merged
 * mesh per sector sharing ONE material / texture atlas (dark, yellow, VSC, SC, red, green cells). A state change
 * only rewrites that sector's small UV buffer, so a frame costs nothing unless a cell flips. Draw calls: 1 static
 * (masts + frames) + 1 per sector = 4. See flagPanelState.ts for the state logic.
 */
import * as THREE from 'three';
import { canvasTexture, createCanvas, UI_FONT, type Canvas2D } from '../core/canvas';
import { GeoBuilder, addBox, addCylinderY } from '../core/geometry';
import { sidePoint, wrapIndex, type SceneryContext } from './context';
import { FlagPanelState, PANEL_CELL, PANEL_CELL_COUNT, sectorOfS, type RaceControlInput } from './flagPanelState';

/** A marshal post the panel belongs to (reported by buildTrackside). */
export interface MarshalSite {
  s: number;
  /** sample index */
  k: number;
  /** +1 / -1: side of the track (lateral sign) */
  side: number;
}

/** Panel face size (m), mast height to the panel centre (m). */
export const PANEL_SIZE: readonly [number, number] = [1.3, 0.9];
export const PANEL_CENTRE_Y = 3.0;
/** Distance (m) the panel stands upstream of the post, so approaching cars read it before the post. */
export const PANEL_UPSTREAM = 5;
/** 0..1: how much the face turns towards approaching traffic (0 = faces the track, 1 = faces the cars head on). */
export const PANEL_TURN = 0.8;
/** Extra masts are added when two panels are further apart than this (m). */
export const PANEL_MAX_GAP = 450;
/** LED brightness (colour multiplier; day bloom threshold 1.6, dusk 1.1, night 1.0). */
export const PANEL_GAIN = 1.3;

const CELL_W = 128;
const CELL_H = 96;
const INSET = 1 / CELL_W;

function paintAtlas(): Canvas2D {
  const c = createCanvas(CELL_W * PANEL_CELL_COUNT, CELL_H);
  const g = c.ctx;
  const fills: Record<number, string> = {
    [PANEL_CELL.dark]: '#14161a',
    [PANEL_CELL.yellow]: '#ffc400',
    [PANEL_CELL.vsc]: '#ffc400',
    [PANEL_CELL.sc]: '#ffc400',
    [PANEL_CELL.red]: '#ff2a1c',
    [PANEL_CELL.green]: '#18e04a',
  };
  for (let i = 0; i < PANEL_CELL_COUNT; i++) {
    const x0 = i * CELL_W;
    g.fillStyle = fills[i];
    g.fillRect(x0, 0, CELL_W, CELL_H);
    // LED dot grid
    g.fillStyle = i === PANEL_CELL.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.22)';
    for (let y = 0; y < CELL_H; y += 6) g.fillRect(x0, y, CELL_W, 1.5);
    for (let x = 0; x < CELL_W; x += 6) g.fillRect(x0 + x, 0, 1.5, CELL_H);
    if (i === PANEL_CELL.vsc || i === PANEL_CELL.sc) {
      g.fillStyle = '#16120a';
      g.font = `bold ${i === PANEL_CELL.vsc ? 58 : 66}px ${UI_FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(i === PANEL_CELL.vsc ? 'VSC' : 'SC', x0 + CELL_W / 2, CELL_H / 2 + 3);
    }
  }
  return c;
}

interface SectorMesh {
  mesh: THREE.Mesh;
  uv: Float32Array;
  /** local u (0..1, inset) per vertex */
  localU: Float32Array;
  cell: number;
}

export class MarshalPanels {
  readonly group = new THREE.Group();
  private readonly state: FlagPanelState;
  private readonly sectors: (SectorMesh | null)[] = [];
  /** panels per sector index (diagnostics) */
  readonly panelCount: number[];
  constructor(ctx: SceneryContext, heightAtXZ: (x: number, z: number) => number, posts: MarshalSite[]) {
    const { track: t, frame: f, disposer } = ctx;
    this.group.name = 'marshalPanels';
    const starts = t.sectorStarts;
    const nSectors = starts.length;
    this.state = new FlagPanelState(nSectors);
    this.panelCount = new Array(nSectors).fill(0);

    // sites: every post + extra masts on long gaps
    const sites = posts.map((p) => ({ s: p.s, k: p.k, side: p.side }));
    sites.sort((a, b) => a.s - b.s);
    const extra: typeof sites = [];
    for (let i = 0; i < sites.length; i++) {
      const a = sites[i].s;
      const b = i + 1 < sites.length ? sites[i + 1].s : sites[0].s + t.length;
      const gap = b - a;
      if (gap > PANEL_MAX_GAP) {
        const n = Math.ceil(gap / PANEL_MAX_GAP) - 1;
        for (let j = 1; j <= n; j++) {
          const s = (a + (gap * j) / (n + 1)) % t.length;
          const k = wrapIndex(Math.round(s / Math.max(0.01, t.spacing)), t.count);
          const side = j % 2 === 1 ? -sites[i].side : sites[i].side;
          const sd = f.inPit[k] && side === f.pitSign ? -side : side;
          extra.push({ s, k, side: sd });
        }
      }
    }
    if (sites.length === 0) {
      // no posts at all: a panel every PANEL_MAX_GAP m
      for (let s = 100; s < t.length - 50; s += PANEL_MAX_GAP) {
        const k = wrapIndex(Math.round(s / Math.max(0.01, t.spacing)), t.count);
        extra.push({ s, k, side: extra.length % 2 === 0 ? 1 : -1 });
      }
    }
    const all = [...sites, ...extra];

    const frames = new GeoBuilder(true);
    const perSector: { pos: number[]; u: number[]; v: number[]; idx: number[] }[] = [];
    for (let i = 0; i < nSectors; i++) perSector.push({ pos: [], u: [], v: [], idx: [] });
    const p = new THREE.Vector3();
    const [pw, ph] = PANEL_SIZE;
    for (const site of all) {
      const k = wrapIndex(site.k - Math.round(PANEL_UPSTREAM / Math.max(0.01, t.spacing)), t.count);
      sidePoint(t, k, site.side * (f.occupiedTo(k, site.side) + 3.5), 0, p);
      const g = heightAtXZ(p.x, p.z);
      // face normal: towards the track, turned back along the track (towards approaching cars)
      let nx = -site.side * t.rx[k] - PANEL_TURN * t.tx[k];
      let nz = -site.side * t.rz[k] - PANEL_TURN * t.tz[k];
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl;
      nz /= nl;
      const yaw = Math.atan2(nx, nz);
      const rvx = Math.cos(yaw);
      const rvz = -Math.sin(yaw);
      frames.setColor(new THREE.Color('#2a2d33'));
      addCylinderY(frames, p.x, g - 0.2, p.z, 0.06, PANEL_CENTRE_Y - ph / 2 + 0.2, 6);
      addBox(frames, p.x, g + PANEL_CENTRE_Y, p.z, yaw, pw + 0.16, ph + 0.16, 0.14, 1);
      const cy = g + PANEL_CENTRE_Y;
      const fx = p.x + nx * 0.075;
      const fz = p.z + nz * 0.075;
      const sec = perSector[sectorOfS(site.s, starts)];
      const base = sec.pos.length / 3;
      // bl, br, tr, tl seen from the front (screen right = +rv)
      const corners: [number, number, number, number][] = [
        [-1, -1, INSET, 0],
        [1, -1, 1 - INSET, 0],
        [1, 1, 1 - INSET, 1],
        [-1, 1, INSET, 1],
      ];
      for (const [cx, cyy, u, v] of corners) {
        sec.pos.push(fx + rvx * cx * (pw / 2), cy + cyy * (ph / 2), fz + rvz * cx * (pw / 2));
        sec.u.push(u);
        sec.v.push(v);
      }
      sec.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      this.panelCount[sectorOfS(site.s, starts)]++;
      ctx.exclusions.push({ x: p.x, z: p.z, r: 2 });
    }

    const fg = frames.build();
    if (fg) {
      disposer.add(fg);
      const fm = disposer.add(new THREE.MeshStandardMaterial({ name: 'panel-frames', vertexColors: true, roughness: 0.6, metalness: 0.3 }));
      const mesh = new THREE.Mesh(fg, fm);
      mesh.name = 'panelFrames';
      mesh.castShadow = true;
      this.group.add(mesh);
    }

    const tex = disposer.add(canvasTexture(paintAtlas(), { mipmaps: false, anisotropy: 1 }));
    const mat = disposer.add(new THREE.MeshBasicMaterial({ name: 'panel-leds', map: tex, toneMapped: false }));
    mat.color.setScalar(PANEL_GAIN);
    for (const sec of perSector) {
      if (sec.idx.length === 0) {
        this.sectors.push(null);
        continue;
      }
      const geo = disposer.add(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(sec.pos, 3));
      const uv = new THREE.Float32BufferAttribute(sec.u.length * 2, 2);
      uv.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('uv', uv);
      geo.setIndex(sec.idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'panelLeds';
      const entry: SectorMesh = { mesh, uv: uv.array as Float32Array, localU: Float32Array.from(sec.u), cell: -1 };
      for (let i = 0; i < sec.v.length; i++) entry.uv[i * 2 + 1] = sec.v[i];
      this.setCell(entry, PANEL_CELL.dark);
      this.group.add(mesh);
      this.sectors.push(entry);
    }
  }

  private setCell(sec: SectorMesh, cell: number): void {
    if (sec.cell === cell) return;
    sec.cell = cell;
    for (let i = 0; i < sec.localU.length; i++) sec.uv[i * 2] = (cell + sec.localU[i]) / PANEL_CELL_COUNT;
    (sec.mesh.geometry.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Per frame: race-control state at scene time `time` (absent = all green / dark). */
  update(rc: RaceControlInput | undefined, time: number): void {
    if (!this.state.update(rc, time)) return;
    for (let i = 0; i < this.sectors.length; i++) {
      const sec = this.sectors[i];
      if (sec) this.setCell(sec, this.state.cells[i]);
    }
  }
}
