/**
 * Materials shared by every car of a scene: per-compound wheel materials (tyre sidewall colour band from
 * COMPOUND_INFO), the livery-atlas surface map (clear coat / roughness / metalness), ghost wheel material and the
 * rain-light lamp.
 * Per-car materials (livery body, brake glow) are created by carModel.ts.
 */
import * as THREE from 'three';
import type { TireCompound } from '../../core/types';
import { COMPOUNDS, COMPOUND_INFO } from '../../core/defaults';
import { canvasTexture, createCanvas } from '../core/canvas';
import { surfaceMapTexture } from './atlas';
import { TYRE_SURFACE } from './carQuality';

export class CarSharedResources {
  readonly surfaceMap: THREE.CanvasTexture;
  readonly wheelSurface: THREE.CanvasTexture;
  readonly wheelMaterials: Record<TireCompound, THREE.MeshStandardMaterial>;
  readonly ghostWheelMaterial: THREE.MeshStandardMaterial;
  readonly rainLightMaterial: THREE.MeshBasicMaterial;
  private readonly wheelMaps: THREE.CanvasTexture[] = [];

  constructor() {
    this.surfaceMap = surfaceMapTexture();
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
