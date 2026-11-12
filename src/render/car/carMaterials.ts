/**
 * Materials shared by every car of a scene: per-compound wheel materials (tyre sidewall band and the 2026 chequered
 * sidewall marking in the COMPOUND_INFO colour, open rims, brake discs; on high / ultra physical rubber with sheen and
 * graining, see TYRE_RUBBER), the livery-atlas surface
 * map (clear coat / roughness / metalness), the damage scuff map over the livery UVs, ghost wheel material and the
 * rain-light lamp.
 * Per-car materials (livery body, brake glow) are created by carModel.ts. Cars that cross-fade their LOD levels
 * (high / ultra) take cross-faded wheel materials, one set per wheel level (fadedWheelMaterials, applyLodFade).
 */
import * as THREE from 'three';
import type { LiveryPattern, QualityLevel, TireCompound } from '../../core/types';
import { COMPOUNDS, COMPOUND_INFO } from '../../core/defaults';
import { canvasTexture, createCanvas, Rng } from '../core/canvas';
import { carbonZones, surfaceMapTexture } from './atlas';
import { carSurfaceDetail, lodFadeWindow, CAR_LOD_REFERENCE_FOV, TYRE_RUBBER, TYRE_SURFACE } from './carQuality';
import { carDims } from './dims';
import { WHEEL_CHEQUER, WHEEL_KEYS, WHEEL_ROWS } from './sharedParts';

/**
 * LOD cross-fade (usesLodCrossFade) on a car material: the vertex shader takes the mesh's FOV-scaled camera distance
 * from its origin and the projection (as CarLOD does), the fragment shader keeps the level's share of the pixels
 * (lodFadeShare, `window` = lodFadeWindow) against interleaved gradient noise, so neighbouring levels keep
 * complementary pixels. One program for every level (the window is a uniform).
 */
export function applyLodFade(mat: THREE.Material, window: THREE.IUniform<THREE.Vector4>): void {
  const prev = mat.onBeforeCompile;
  // the key of the patches below this one (the default key reads onBeforeCompile, so take it before replacing it)
  const prevKey = mat.customProgramCacheKey();
  const refTan = Math.tan((CAR_LOD_REFERENCE_FOV * Math.PI) / 360).toFixed(6);
  mat.onBeforeCompile = (sh, renderer) => {
    prev.call(mat, sh, renderer);
    sh.uniforms.lodWindow = window;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec4 lodWindow;\nvarying vec2 vLodFade;').replace(
      '#include <project_vertex>',
      `#include <project_vertex>
{
  float lodD = length( ( modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz );
  if ( ! isOrthographic ) lodD /= projectionMatrix[ 1 ][ 1 ] * ${refTan};
  vLodFade = vec2( smoothstep( lodWindow.x, lodWindow.y, lodD ), smoothstep( lodWindow.z, lodWindow.w, lodD ) );
}`,
    );
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vLodFade;').replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
{
  float lodH = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  if ( lodH >= vLodFade.x || lodH < vLodFade.y ) discard;
}`,
    );
  };
  mat.customProgramCacheKey = () => `${prevKey}|lod-fade`;
}

/** lodFadeWindow as a shader uniform. */
export function lodFadeUniform(thresholds: readonly number[], level: number): THREE.IUniform<THREE.Vector4> {
  return { value: new THREE.Vector4(...lodFadeWindow(thresholds, level)) };
}

/** Red level of the lit rain light (scene-referred HDR; post.ts keeps the other emissives at 1.0). */
export const RAIN_LIGHT_HDR = 2.5;

export class CarSharedResources {
  /** surface map of the layouts without bare carbon (see surfaceMapFor) */
  readonly surfaceMap: THREE.CanvasTexture;
  /** damage scuffs over the livery UVs (see scuffTexture) */
  readonly scuffMap: THREE.CanvasTexture;
  readonly wheelSurface: THREE.CanvasTexture;
  readonly wheelMaterials: Record<TireCompound, THREE.MeshStandardMaterial>;
  readonly ghostWheelMaterial: THREE.MeshStandardMaterial;
  readonly rainLightMaterial: THREE.MeshBasicMaterial;
  private readonly wheelMaps: THREE.CanvasTexture[] = [];
  private readonly wheelParams = {} as Record<TireCompound, THREE.MeshStandardMaterialParameters>;
  private readonly rubber: boolean;
  /** cross-faded wheel sets per switch distances and level (fadedWheelMaterials) */
  private readonly fadedWheels = new Map<string, Record<TireCompound, THREE.MeshStandardMaterial>>();
  /** per 2026 livery layout: its bare-carbon zones baked in (created on first use) */
  private readonly layoutMaps = new Map<LiveryPattern, THREE.CanvasTexture>();

  /** `quality` picks the tyre material (physical rubber on high / ultra); default high */
  constructor(quality: QualityLevel = 'high') {
    this.rubber = carSurfaceDetail(quality) === 'full';
    this.surfaceMap = surfaceMapTexture(carDims());
    this.scuffMap = scuffTexture();
    this.wheelSurface = wheelSurfaceTexture();
    const mats = {} as Record<TireCompound, THREE.MeshStandardMaterial>;
    for (const c of COMPOUNDS) {
      const map = wheelTexture(COMPOUND_INFO[c].color);
      this.wheelMaps.push(map);
      this.wheelParams[c] = {
        name: `wheel-${c}`,
        map,
        roughnessMap: this.wheelSurface,
        metalnessMap: this.wheelSurface,
        roughness: 1,
        metalness: 1,
      };
      mats[c] = this.wheelMaterial(c);
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
    // above the bloom threshold of the post chain; direct rendering clamps it to the old full red
    this.rainLightMaterial = new THREE.MeshBasicMaterial({ name: 'rain-light', color: new THREE.Color(RAIN_LIGHT_HDR, 0.08, 0.06), toneMapped: false });
  }

  private wheelMaterial(c: TireCompound): THREE.MeshStandardMaterial {
    const params = this.wheelParams[c];
    return this.rubber ? rubberMaterial(params) : new THREE.MeshStandardMaterial(params);
  }

  /** Wheel materials of LOD `level`, cross-faded for the switch distances `thresholds` (created on first use). */
  fadedWheelMaterials(thresholds: readonly number[], level: number): Record<TireCompound, THREE.MeshStandardMaterial> {
    const key = `${thresholds.join(',')}|${level}`;
    let set = this.fadedWheels.get(key);
    if (!set) {
      set = {} as Record<TireCompound, THREE.MeshStandardMaterial>;
      for (const c of COMPOUNDS) {
        const m = this.wheelMaterial(c);
        applyLodFade(m, lodFadeUniform(thresholds, level));
        set[c] = m;
      }
      this.fadedWheels.set(key, set);
    }
    return set;
  }

  /** Surface map for a livery layout (shared by every car painted in it). */
  surfaceMapFor(pattern: LiveryPattern | undefined): THREE.CanvasTexture {
    if (!pattern || carbonZones(carDims(), pattern).length === 0) return this.surfaceMap;
    let map = this.layoutMaps.get(pattern);
    if (!map) {
      map = surfaceMapTexture(carDims(), pattern);
      this.layoutMaps.set(pattern, map);
    }
    return map;
  }

  dispose(): void {
    for (const m of Object.values(this.wheelMaterials)) m.dispose();
    for (const set of this.fadedWheels.values()) for (const m of Object.values(set)) m.dispose();
    for (const t of this.layoutMaps.values()) t.dispose();
    this.ghostWheelMaterial.dispose();
    this.rainLightMaterial.dispose();
    for (const t of this.wheelMaps) t.dispose();
    this.surfaceMap.dispose();
    this.scuffMap.dispose();
    this.wheelSurface.dispose();
  }
}

/**
 * Physical tyre material: sheen for the soft lustre of rubber at grazing angles, and on the rubber row of the
 * wheel atlas (the top row) a lighter worn-grey albedo with fine graining (value noise in wheel space, faded once the
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
  tyreRub = step( ${f(1 - 1 / WHEEL_ROWS)}, vMapUv.y );
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

/** Atlas row height (px); the atlas is 256 px wide (u repeats, for the chequer tiled around the tyre). */
const WHEEL_ROW_PX = 16;

/** Row of each wheel key, filled by `paint` (rows past the keys stay rubber). */
function wheelAtlas(paint: (key: (typeof WHEEL_KEYS)[number], ctx: CanvasRenderingContext2D, y: number, w: number) => void, srgb: boolean): THREE.CanvasTexture {
  const c = createCanvas(256, WHEEL_ROWS * WHEEL_ROW_PX);
  for (let r = 0; r < WHEEL_ROWS; r++) paint(WHEEL_KEYS[r] ?? 'rubber', c.ctx, r * WHEEL_ROW_PX, c.w);
  const tex = canvasTexture(c, { srgb });
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/**
 * Wheel atlas rows: rubber / solid compound band / sidewall chequer (two rows of compound-colour and black squares) /
 * rim (dark graphite) / nut and rim lip / brake disc.
 */
function wheelTexture(band: string): THREE.CanvasTexture {
  const fills: Record<(typeof WHEEL_KEYS)[number], string> = { rubber: '#161618', band, chequer: band, rim: '#1f2125', nut: '#c9ccd2', disc: '#3b3735' };
  return wheelAtlas((key, ctx, y, w) => {
    ctx.fillStyle = key === 'chequer' ? '#161618' : fills[key];
    ctx.fillRect(0, y, w, WHEEL_ROW_PX);
    if (key !== 'chequer') return;
    const sq = w / WHEEL_CHEQUER.columns;
    const h = WHEEL_ROW_PX / 2;
    ctx.fillStyle = band;
    for (let i = 0; i < WHEEL_CHEQUER.columns; i++) ctx.fillRect(i * sq, y + (i % 2) * h, sq, h);
  }, true);
}

/** Roughness (G) / metalness (B) per wheel atlas row, from TYRE_SURFACE (matte rubber). */
function wheelSurfaceTexture(): THREE.CanvasTexture {
  return wheelAtlas((key, ctx, y, w) => {
    const [r, m] = TYRE_SURFACE[key];
    ctx.fillStyle = `rgb(0,${Math.round(r * 255)},${Math.round(m * 255)})`;
    ctx.fillRect(0, y, w, WHEEL_ROW_PX);
  }, false);
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
