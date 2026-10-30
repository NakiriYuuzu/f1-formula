/**
 * Materials shared by every car of a scene: per-compound wheel materials (tyre sidewall colour band from
 * COMPOUND_INFO), the livery-atlas surface map (clear coat / roughness / metalness), the damage scuff map over the
 * livery UVs, ghost wheel material and the rain-light lamp.
 * Per-car materials (livery body, brake glow) are created by carModel.ts.
 */
import * as THREE from 'three';
import type { TireCompound } from '../../core/types';
import { COMPOUNDS, COMPOUND_INFO } from '../../core/defaults';
import { canvasTexture, createCanvas, Rng } from '../core/canvas';
import { surfaceMapTexture } from './atlas';
import { TYRE_SURFACE } from './carQuality';

export class CarSharedResources {
  readonly surfaceMap: THREE.CanvasTexture;
  /** damage scuffs over the livery UVs (see scuffTexture) */
  readonly scuffMap: THREE.CanvasTexture;
  readonly wheelSurface: THREE.CanvasTexture;
  readonly wheelMaterials: Record<TireCompound, THREE.MeshStandardMaterial>;
  readonly ghostWheelMaterial: THREE.MeshStandardMaterial;
  readonly rainLightMaterial: THREE.MeshBasicMaterial;
  private readonly wheelMaps: THREE.CanvasTexture[] = [];

  constructor() {
    this.surfaceMap = surfaceMapTexture();
    this.scuffMap = scuffTexture();
    this.wheelSurface = wheelSurfaceTexture();
    const mats = {} as Record<TireCompound, THREE.MeshStandardMaterial>;
    for (const c of COMPOUNDS) {
      const map = wheelTexture(COMPOUND_INFO[c].color);
      this.wheelMaps.push(map);
      mats[c] = new THREE.MeshStandardMaterial({
        name: `wheel-${c}`,
        map,
        roughnessMap: this.wheelSurface,
        metalnessMap: this.wheelSurface,
        roughness: 1,
        metalness: 1,
      });
    }
    this.wheelMaterials = mats;
    const ghostMap = wheelTexture('#9fdcff');
    this.wheelMaps.push(ghostMap);
    this.ghostWheelMaterial = new THREE.MeshStandardMaterial({
      name: 'wheel-ghost',
      map: ghostMap,
      roughness: 0.6,
      metalness: 0.1,
      transparent: true,
      opacity: 0.35,
      depthWrite: true,
    });
    this.rainLightMaterial = new THREE.MeshBasicMaterial({ name: 'rain-light', color: new THREE.Color(1, 0.08, 0.06), toneMapped: false });
  }

  dispose(): void {
    for (const m of Object.values(this.wheelMaterials)) m.dispose();
    this.ghostWheelMaterial.dispose();
    this.rainLightMaterial.dispose();
    for (const t of this.wheelMaps) t.dispose();
    this.surfaceMap.dispose();
    this.scuffMap.dispose();
    this.wheelSurface.dispose();
  }
}

/** 4-column wheel atlas: rubber / compound band / rim / nut. */
function wheelTexture(band: string): THREE.CanvasTexture {
  const c = createCanvas(64, 16);
  const cols = ['#161618', band, '#2b2d32', '#c9ccd2'];
  cols.forEach((col, i) => {
    c.ctx.fillStyle = col;
    c.ctx.fillRect(i * 16, 0, 16, 16);
  });
  return canvasTexture(c, { nearest: true });
}

/** Roughness (G) / metalness (B) per wheel atlas column, from TYRE_SURFACE (matte rubber). */
function wheelSurfaceTexture(): THREE.CanvasTexture {
  const c = createCanvas(64, 16);
  const vals = [TYRE_SURFACE.rubber, TYRE_SURFACE.band, TYRE_SURFACE.rim, TYRE_SURFACE.nut];
  vals.forEach(([r, m], i) => {
    c.ctx.fillStyle = `rgb(0,${Math.round(r * 255)},${Math.round(m * 255)})`;
    c.ctx.fillRect(i * 16, 0, 16, 16);
  });
  return canvasTexture(c, { srgb: false, nearest: true });
}

/**
 * Scuff atlas over the livery UVs (data, not colour): R = priority (a mark shows once the car's scuff amount passes
 * 1 − R, so light damage shows a few marks and heavy damage many), G = kind (0 = black rubber / exposed carbon
 * smear, 1 = light scratch through the paint). Overlaps keep the higher priority ('lighten').
 */
function scuffTexture(seed = 7): THREE.CanvasTexture {
  const c = createCanvas(256, 256);
  const rng = new Rng(seed);
  const { ctx } = c;
  ctx.fillStyle = 'rgb(0,0,0)';
  ctx.fillRect(0, 0, c.w, c.h);
  ctx.globalCompositeOperation = 'lighten';
  ctx.lineCap = 'round';
  for (let i = 0; i < 110; i++) {
    const p = Math.round(rng.range(0.12, 1) * 255);
    const x = rng.next() * c.w;
    const y = rng.next() * c.h;
    if (rng.next() < 0.45) {
      // a few parallel scratches
      const a = rng.next() * Math.PI;
      const len = rng.range(8, 36);
      ctx.strokeStyle = `rgb(${p},255,0)`;
      for (let k = 0; k < rng.int(1, 4); k++) {
        const ox = Math.sin(a) * k * 2.2;
        const oy = -Math.cos(a) * k * 2.2;
        ctx.lineWidth = rng.range(0.6, 1.5);
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len);
        ctx.stroke();
      }
    } else {
      // smeared rubber / carbon showing through: a soft blotch of small ellipses
      ctx.fillStyle = `rgb(${p},0,0)`;
      const r = rng.range(2.5, 10);
      for (let k = 0; k < 5; k++) {
        ctx.beginPath();
        ctx.ellipse(x + rng.range(-r, r), y + rng.range(-r, r) * 0.5, r * rng.range(0.4, 1), r * rng.range(0.2, 0.5), rng.next() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  return canvasTexture(c, { srgb: false });
}
