/**
 * Materials shared by every car of a scene: per-compound wheel materials (tyre sidewall colour band from
 * COMPOUND_INFO; on high / ultra physical rubber with sheen and graining, see TYRE_RUBBER), the livery-atlas surface
 * map (clear coat / roughness / metalness), the damage scuff map over the livery UVs, ghost wheel material and the
 * rain-light lamp.
 * Per-car materials (livery body, brake glow) are created by carModel.ts.
 */
import * as THREE from 'three';
import type { QualityLevel, TireCompound } from '../../core/types';
import { COMPOUNDS, COMPOUND_INFO } from '../../core/defaults';
import { canvasTexture, createCanvas, Rng } from '../core/canvas';
import { surfaceMapTexture } from './atlas';
import { carSurfaceDetail, TYRE_RUBBER, TYRE_SURFACE } from './carQuality';

export class CarSharedResources {
  readonly surfaceMap: THREE.CanvasTexture;
  /** damage scuffs over the livery UVs (see scuffTexture) */
  readonly scuffMap: THREE.CanvasTexture;
  readonly wheelSurface: THREE.CanvasTexture;
  readonly wheelMaterials: Record<TireCompound, THREE.MeshStandardMaterial>;
  readonly ghostWheelMaterial: THREE.MeshStandardMaterial;
  readonly rainLightMaterial: THREE.MeshBasicMaterial;
  private readonly wheelMaps: THREE.CanvasTexture[] = [];

  /** `quality` picks the tyre material (physical rubber on high / ultra); default high */
  constructor(quality: QualityLevel = 'high') {
    const rubber = carSurfaceDetail(quality) === 'full';
    this.surfaceMap = surfaceMapTexture();
    this.scuffMap = scuffTexture();
    this.wheelSurface = wheelSurfaceTexture();
    const mats = {} as Record<TireCompound, THREE.MeshStandardMaterial>;
    for (const c of COMPOUNDS) {
      const map = wheelTexture(COMPOUND_INFO[c].color);
      this.wheelMaps.push(map);
      const params: THREE.MeshStandardMaterialParameters = {
        name: `wheel-${c}`,
        map,
        roughnessMap: this.wheelSurface,
        metalnessMap: this.wheelSurface,
        roughness: 1,
        metalness: 1,
      };
      mats[c] = rubber ? rubberMaterial(params) : new THREE.MeshStandardMaterial(params);
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

/**
 * Physical tyre material: sheen for the soft lustre of rubber at grazing angles, and on the rubber column of the
 * wheel atlas (u < 0.25) a lighter worn-grey albedo with fine graining (value noise in wheel space, faded once the
 * grains are sub-pixel) that also varies the roughness.
 */
function rubberMaterial(params: THREE.MeshStandardMaterialParameters): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    ...params,
    sheen: TYRE_RUBBER.sheen,
    sheenRoughness: TYRE_RUBBER.sheenRoughness,
    sheenColor: new THREE.Color().setScalar(TYRE_RUBBER.sheenColor),
  });
  const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTyrePos;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvTyrePos = transformed * ${f(+(1 / TYRE_RUBBER.grainSize).toFixed(3))};`);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vTyrePos;
float tyreHash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float tyreNoise( vec3 x ) {
  vec3 i = floor( x );
  vec3 u = fract( x );
  u = u * u * ( 3.0 - 2.0 * u );
  return mix(
    mix( mix( tyreHash( i ), tyreHash( i + vec3( 1.0, 0.0, 0.0 ) ), u.x ), mix( tyreHash( i + vec3( 0.0, 1.0, 0.0 ) ), tyreHash( i + vec3( 1.0, 1.0, 0.0 ) ), u.x ), u.y ),
    mix( mix( tyreHash( i + vec3( 0.0, 0.0, 1.0 ) ), tyreHash( i + vec3( 1.0, 0.0, 1.0 ) ), u.x ), mix( tyreHash( i + vec3( 0.0, 1.0, 1.0 ) ), tyreHash( i + vec3( 1.0 ) ), u.x ), u.y ),
    u.z );
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float tyreRub = 0.0;
float tyreGrain = 0.5;
#ifdef USE_MAP
  tyreRub = 1.0 - step( 0.25, vMapUv.x );
  tyreGrain = mix( 0.5, tyreNoise( vTyrePos ) * 0.65 + tyreNoise( vTyrePos * 2.7 + 3.1 ) * 0.35, 1.0 - smoothstep( 0.25, 0.6, length( fwidth( vTyrePos ) ) ) );
  diffuseColor.rgb *= mix( 1.0, ${f(TYRE_RUBBER.albedo)} * ( 1.0 + ${f(TYRE_RUBBER.grain * 2)} * ( tyreGrain - 0.5 ) ), tyreRub );
#endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor *= mix( 1.0, 0.86 + 0.28 * tyreGrain, tyreRub );',
      );
  };
  mat.customProgramCacheKey = () => 'car-tyre-rubber';
  return mat;
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
