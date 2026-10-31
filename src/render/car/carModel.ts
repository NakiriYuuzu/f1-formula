/**
 * Car model instance: root group + movable nodes (front-wheel steering pivots, wheel spinners, DRS /
 * active-aero flaps, steering wheel) driven by CarRenderState via apply(). Geometry is shared per
 * regulation; only the livery material (canvas atlas) and the brake-glow material are per car.
 *
 * Levels of detail (THREE.LOD inside the root, picked per camera at render time, so every split-screen view
 * chooses its own): LOD0 = the full model, LOD1 = simplified merged body + front wing + low-segment wheels that
 * still steer / spin, LOD2 = one low-poly silhouette. Switch distances follow the quality (CAR_LOD_DISTANCES)
 * and are scaled by the camera FOV, so zoomed tv shots keep full detail. The rain light hangs off the root and
 * shows at every level. The ghost car is LOD0 only. Paint: clear-coated MeshPhysicalMaterial on high / ultra,
 * MeshStandardMaterial below (CAR_PAINT / CAR_SURFACE); carbon weave, metallic flakes and paint flop on top
 * (applySurfaceDetail, carSurfaceDetail per quality).
 *
 * Damage (carDamage.ts): the front wing bends then breaks off, the rear flap droops and twists, bent / broken
 * suspension splays the wheel at the corner that was hit and sags the body onto it, and scuffs (shared scuff map, per-car amount)
 * spread over the paint with damage and hard impacts.
 *
 * Conventions: model faces +Z; local -X is the car's RIGHT. rotation order 'YXZ': y = yaw,
 * x = -pitch (+pitch = nose up), z = +roll (+roll = right side down). A RIGHT steer angle s gives the
 * front pivots rotation.y = -s. Wheels roll forward with rotation.x = +wheelSpin.
 */
import * as THREE from 'three';
import type { CarRenderState, Livery, LiveryFinish, QualityLevel, Regulation, TireCompound } from '../../core/types';
import { clamp, clamp01, damp } from '../../core/math';
import { liveryTexture, paintLiveryCanvas, type LiveryPaint } from './atlas';
import { acquireCarGeometry, releaseCarGeometry, type CarGeometrySet } from './carGeometry';
import { createDamageLook, damageLook, scuffAfterImpact } from './carDamage';
import { CarSharedResources } from './carMaterials';
import {
  carLodDistances,
  carSurfaceDetail,
  inferCarQuality,
  lodFovScale,
  selectLodLevel,
  usesClearcoatPaint,
  CARBON_WEAVE,
  CAR_FINISH,
  CAR_LOD_HYSTERESIS,
  CAR_PAINT,
  CAR_SURFACE,
  PAINT_FLAKE,
  PAINT_FLOP,
  SURFACE_DETAIL_MIN_PX,
} from './carQuality';

export interface CarModelOptions {
  livery: Livery;
  number: number;
  teamShort: string;
  helmet: Livery;
  regulation: Regulation;
  /** translucent time-trial ghost (no shadows) */
  ghost?: boolean;
  /** livery atlas size (px), default 1024 */
  textureSize?: number;
  anisotropy?: number;
  /** shared wheel / surface materials; created (and owned) by the model when omitted */
  shared?: CarSharedResources;
  castShadow?: boolean;
  /**
   * Render quality: LOD switch distances and the paint material (clear coat on high / ultra). When omitted it is
   * inferred from textureSize / anisotropy (inferCarQuality), which matches how the scenes size them.
   */
  quality?: QualityLevel;
}

export interface CarApplyContext {
  /** scene time (s) for light blinking */
  time?: number;
  /** current rain intensity 0..1 */
  rain?: number;
}

export interface CarNodes {
  body: THREE.Mesh;
  frontWing: THREE.Mesh;
  frontWingDamaged: THREE.Mesh;
  frontFlapPivot: THREE.Group | null;
  rearFlapPivot: THREE.Group;
  steeringGroup: THREE.Group;
  steeringWheel: THREE.Mesh;
  rainLight: THREE.Mesh;
  /** order: FL, FR, RL, RR */
  wheelPivots: THREE.Group[];
  wheelSpinners: THREE.Group[];
  wheels: THREE.Mesh[];
  glows: THREE.Mesh[];
  /** level-of-detail switch (null for the ghost, which is LOD0 only); getCurrentLevel() = level of the last view drawn */
  lod: THREE.LOD | null;
}

export interface CarModel {
  root: THREE.Group;
  nodes: CarNodes;
  regulation: Regulation;
  ghost: boolean;
  apply(state: CarRenderState, dt: number, ctx?: CarApplyContext): void;
  /** repaint livery / number / code / helmet */
  setLivery(livery: Livery, number: number, teamShort: string, helmet: Livery): void;
  /** show small interior details (steering wheel) — enable for cars near a camera */
  setDetail(near: boolean): void;
  /** current brake-disc heat 0..1 and drs flap blend 0..1 (for effects / tests) */
  readonly heat: number;
  readonly flapOpen: number;
  dispose(): void;
}

const STEER_RATIO = 5;

/** Four wheels of one level of detail, order FL, FR, RL, RR (glows: LOD0 brake-glow rings only). */
interface WheelSet {
  pivots: THREE.Group[];
  spinners: THREE.Group[];
  wheels: THREE.Mesh[];
  glows: THREE.Mesh[];
}

function poseWheels(set: WheelSet, steer: number, spin: number): void {
  set.pivots[0].rotation.y = -steer;
  set.pivots[1].rotation.y = -steer;
  for (const s of set.spinners) s.rotation.x = spin;
}

/**
 * Keep the tyres on the road while the body pitches / rolls: the root rotation lifts one axle (up to ~6 cm at the
 * +-0.035 rad braking / launch pitch) and sinks the other, so each wheel pivot is moved along the car's local up
 * axis until its centre is at tyre-radius height above the ground plane again. `dynPitch` = body pitch relative to
 * the ground plane (rad, nose up), `roll` as in CarRenderState. Exact for the wheel centre (world height of a local
 * point = x cos p sin r + y cos p cos r + z sin p for the 'YXZ' root), tyre-bottom error is O(R * angle^2).
 */
function seatWheels(set: WheelSet, radii: readonly number[], dynPitch: number, roll: number): void {
  const sp = Math.sin(dynPitch);
  const cp = Math.cos(dynPitch);
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  for (let i = 0; i < set.pivots.length; i++) {
    const p = set.pivots[i].position;
    p.y = (radii[i] - p.x * cp * sr - p.z * sp) / (cp * cr);
  }
}

/** Optional ground-plane pitch (the road grade without the dynamic body pitch); see CarRenderState.groundPitch. */
function groundPitchOf(state: CarRenderState): number {
  const gp = state.groundPitch;
  return gp !== undefined && Number.isFinite(gp) ? gp : fin(state.pitch);
}

const _camPos = new THREE.Vector3();
const _lodPos = new THREE.Vector3();

/** THREE.LOD whose camera distance is scaled by the vertical FOV (and zoom), i.e. switches on projected size. */
class CarLOD extends THREE.LOD {
  private readonly thresholds: number[];
  private readonly hysteresis: number;
  private level = 0;

  constructor(objects: THREE.Object3D[], distances: readonly number[], hysteresis: number) {
    super();
    this.name = 'carLod';
    this.hysteresis = hysteresis;
    objects.forEach((o, i) => this.addLevel(o, i === 0 ? 0 : (distances[i - 1] ?? Infinity), hysteresis));
    this.thresholds = this.levels.slice(1).map((l) => l.distance);
  }

  override getCurrentLevel(): number {
    return this.level;
  }

  override update(camera: THREE.Camera): void {
    const levels = this.levels;
    if (levels.length < 2) return;
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    _lodPos.setFromMatrixPosition(this.matrixWorld);
    const persp = camera as THREE.PerspectiveCamera;
    const scale = persp.isPerspectiveCamera === true ? lodFovScale(persp.fov) / Math.max(1e-3, persp.zoom) : 1;
    this.level = selectLodLevel(_camPos.distanceTo(_lodPos) * scale, this.thresholds, this.level, this.hysteresis);
    for (let i = 0; i < levels.length; i++) levels[i].object.visible = i === this.level;
  }
}

/** Gloss / satin / matte: scales the material's roughness and clear coat (the ghost keeps its look). */
function applyFinish(mat: THREE.MeshStandardMaterial, finish: LiveryFinish | undefined, ghost: boolean): void {
  if (ghost) return;
  const f = CAR_FINISH[finish ?? 'gloss'] ?? CAR_FINISH.gloss;
  mat.roughness = f.roughness;
  if (mat instanceof THREE.MeshPhysicalMaterial) mat.clearcoat = CAR_PAINT.clearcoat * f.clearcoat;
}

/**
 * Scuffs on the livery material: the shared scuff map (R priority, G kind) sampled with the livery UVs; marks whose
 * priority passes 1 − amount turn the paint into black smears / light scratches, rougher and without clear coat.
 */
function applyScuffShader(mat: THREE.MeshStandardMaterial, scuffMap: THREE.Texture, amount: THREE.IUniform<number>): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.scuffMap = { value: scuffMap };
    sh.uniforms.scuffAmount = amount;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D scuffMap;\nuniform float scuffAmount;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  float scuffK = 0.0;
  #ifdef USE_MAP
  if (scuffAmount > 0.001) {
    vec2 scuff = texture2D(scuffMap, vMapUv).rg;
    scuffK = smoothstep(1.0 - scuffAmount, 1.06 - scuffAmount, scuff.r);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.022, 0.023, 0.026), vec3(0.6, 0.6, 0.58), scuff.g), scuffK * 0.88);
  }
  #endif`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.72, scuffK);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n  #ifdef USE_CLEARCOAT\n  material.clearcoat *= 1.0 - scuffK;\n  #endif');
  };
  mat.customProgramCacheKey = () => 'car-scuff';
}

const glslNum = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${+v.toFixed(6)}`);
/** Surface-map texel (R clear coat, G roughness, B metalness) of an atlas region, as a GLSL vec3. */
const surfaceKey = (k: keyof typeof CAR_SURFACE): string => {
  const [r, m, cc] = CAR_SURFACE[k];
  return `vec3( ${glslNum(Math.round(cc * 255) / 255)}, ${glslNum(Math.round(r * 255) / 255)}, ${glslNum(Math.round(m * 255) / 255)} )`;
};

/**
 * Surface detail on the livery material (chains behind the scuff shader). Regions are told apart by their texel in
 * the shared surface map. Carbon and satin carbon get a 2 × 2 twill weave, tri-planar in car space: the two tow
 * directions in different shades with dark gaps between the tows, normalised so the far average is the plain colour.
 * With `full` (high / ultra) every tow is also rounded in the normal, so the weave catches the light under the smooth
 * clear coat; the painted regions get metallic flakes (a random normal tilt per cell, visible up close) and a colour
 * flop (deeper towards grazing angles). Detail finer than SURFACE_DETAIL_MIN_PX pixels fades to its average.
 */
function applySurfaceDetail(mat: THREE.MeshStandardMaterial, full: boolean): void {
  const prev = mat.onBeforeCompile;
  const w = CARBON_WEAVE;
  // mean of the weave shade (tow directions average out; the gaps darken ~1/7 of each tow)
  const gapShare = 0.14;
  const mean = 1 - gapShare * (1 - w.gap);
  const fadeA = glslNum(0.5 / SURFACE_DETAIL_MIN_PX);
  const fadeB = glslNum(1 / SURFACE_DETAIL_MIN_PX);
  mat.onBeforeCompile = (sh, renderer) => {
    prev.call(mat, sh, renderer);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;\nvarying vec3 vCarNrm;\nvarying vec3 vCarAxX;\nvarying vec3 vCarAxY;\nvarying vec3 vCarAxZ;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vCarPos = transformed;
vCarNrm = objectNormal;
vCarAxX = normalize( ( modelViewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
vCarAxY = normalize( ( modelViewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
vCarAxZ = normalize( ( modelViewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;\nvarying vec3 vCarNrm;\nvarying vec3 vCarAxX;\nvarying vec3 vCarAxY;\nvarying vec3 vCarAxZ;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
#ifdef USE_ROUGHNESSMAP
{
  vec3 cSurf = texture2D( roughnessMap, vRoughnessMapUv ).rgb;
  float cCarbon = max( 1.0 - smoothstep( 0.03, 0.08, distance( cSurf, ${surfaceKey('carbon')} ) ), 1.0 - smoothstep( 0.03, 0.08, distance( cSurf, ${surfaceKey('satin')} ) ) );
  // weave plane: the car-space plane facing the surface (u, v and their view-space directions)
  vec3 cAbs = abs( vCarNrm );
  vec2 cP = vCarPos.xy;
  vec3 cU = vCarAxX;
  vec3 cV = vCarAxY;
  if ( cAbs.y >= cAbs.x && cAbs.y >= cAbs.z ) {
    cP = vCarPos.xz;
    cV = vCarAxZ;
  } else if ( cAbs.x >= cAbs.z ) {
    cP = vCarPos.zy;
    cU = vCarAxZ;
  }
  cP *= ${glslNum(1 / w.tow)};
  float cFade = 1.0 - smoothstep( ${fadeA}, ${fadeB}, length( fwidth( cP ) ) );
  vec2 cC = floor( cP );
  vec2 cF = fract( cP );
  // twill: the tow direction alternates along diagonal steps of two cells
  float cDir = step( 2.0, mod( cC.x + cC.y, 4.0 ) );
  float cA = mix( cF.y, cF.x, cDir );
  float cGap = smoothstep( 0.0, ${glslNum(gapShare)}, cA ) * ( 1.0 - smoothstep( ${glslNum(1 - gapShare)}, 1.0, cA ) );
  float cShade = mix( ${glslNum(1 - w.contrast)}, ${glslNum(1 + w.contrast)}, cDir ) * mix( ${glslNum(w.gap)}, 1.0, cGap ) * ${glslNum(1 / mean)};
  diffuseColor.rgb *= mix( 1.0, cShade, cCarbon * cFade );
${
  full
    ? `  // rounded tows: the normal tilts across each tow
  normal = normalize( normal - mix( cV, cU, cDir ) * ( cos( cA * PI ) * ${glslNum(w.bump)} * cCarbon * cFade ) );
  float cPaint = 1.0 - smoothstep( 0.03, 0.08, distance( cSurf, ${surfaceKey('paint')} ) );
  // paint flop: deeper colour towards grazing angles
  float cNv = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
  diffuseColor.rgb *= mix( 1.0, mix( ${glslNum(PAINT_FLOP[0])}, ${glslNum(PAINT_FLOP[1])}, pow( cNv, 0.7 ) ), cPaint );
  // metallic flakes: a random tilt per cell under the clear coat (which keeps the smooth normal)
  vec3 cQ = vCarPos * ${glslNum(1 / PAINT_FLAKE.size)};
  vec3 cCell = floor( cQ );
  vec2 cR = fract( sin( vec2( dot( cCell, vec3( 127.1, 311.7, 74.7 ) ), dot( cCell, vec3( 269.5, 183.3, 246.1 ) ) ) ) * 43758.5453 ) - 0.5;
  float cFl = 1.0 - smoothstep( ${fadeA}, ${fadeB}, length( fwidth( cQ ) ) );
  normal = normalize( normal + ( cU * cR.x + cV * cR.y ) * ( ${glslNum(PAINT_FLAKE.tilt * 2)} * cPaint * cFl ) );`
    : ''
}
}
#endif`,
      );
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => `${prevKey.call(mat)}|car-detail-${full ? 1 : 0}`;
}

/** Livery material: clear-coated physical paint, or standard (low / medium quality and the translucent ghost). */
function createLiveryMaterial(map: THREE.Texture, shared: CarSharedResources, ghost: boolean, clearcoat: boolean): THREE.MeshStandardMaterial {
  const params: THREE.MeshStandardMaterialParameters = {
    name: ghost ? 'car-ghost' : 'car-livery',
    map,
    roughnessMap: shared.surfaceMap,
    metalnessMap: shared.surfaceMap,
    roughness: 1,
    metalness: 1,
    envMapIntensity: CAR_PAINT.envMapIntensity,
    transparent: ghost,
    opacity: ghost ? 0.38 : 1,
    depthWrite: true,
  };
  if (ghost || !clearcoat) return new THREE.MeshStandardMaterial(params);
  return new THREE.MeshPhysicalMaterial({
    ...params,
    clearcoat: CAR_PAINT.clearcoat,
    clearcoatRoughness: CAR_PAINT.clearcoatRoughness,
    // R channel of the shared surface map scales the coat per region (paint 1, carbon thin, tyres / metal none)
    clearcoatMap: shared.surfaceMap,
  });
}

export function createCarModel(opts: CarModelOptions): CarModel {
  const geo: CarGeometrySet = acquireCarGeometry(opts.regulation);
  const ownShared = !opts.shared;
  const shared = opts.shared ?? new CarSharedResources();
  const ghost = opts.ghost === true;
  const d = geo.dims;
  const size = opts.textureSize ?? 1024;
  const aniso = opts.anisotropy ?? 4;

  const quality = opts.quality ?? inferCarQuality(size, aniso);

  const paint: LiveryPaint = { livery: opts.livery, helmet: opts.helmet, number: opts.number, teamShort: opts.teamShort };
  let livTex = liveryTexture(size, d, paint, aniso);
  const bodyMat = createLiveryMaterial(livTex, shared, ghost, usesClearcoatPaint(quality));
  applyFinish(bodyMat, opts.livery.finish, ghost);
  const scuffAmount: THREE.IUniform<number> = { value: 0 };
  if (!ghost) applyScuffShader(bodyMat, shared.scuffMap, scuffAmount);
  const surfaceDetail = carSurfaceDetail(quality);
  if (!ghost && surfaceDetail !== 'off') applySurfaceDetail(bodyMat, surfaceDetail === 'full');
  if (ghost) {
    bodyMat.color.setRGB(0.75, 0.95, 1.25);
    bodyMat.emissive.setRGB(0.05, 0.12, 0.18);
  }
  const glowMat = new THREE.MeshBasicMaterial({
    name: 'brake-glow',
    color: new THREE.Color(1, 0.35, 0.08),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const castShadow = !ghost && opts.castShadow !== false;
  const mk = (g: THREE.BufferGeometry, m: THREE.Material, name: string): THREE.Mesh => {
    const mesh = new THREE.Mesh(g, m);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = !ghost;
    return mesh;
  };

  const root = new THREE.Group();
  root.name = 'car';
  root.rotation.order = 'YXZ';
  const level0 = new THREE.Group();
  level0.name = 'lod0';

  const body = mk(geo.body, bodyMat, 'body');
  const frontWing = mk(geo.frontWing, bodyMat, 'frontWing');
  const frontWingDamaged = mk(geo.frontWingDamaged, bodyMat, 'frontWingDamaged');
  frontWingDamaged.visible = false;
  level0.add(body, frontWing, frontWingDamaged);

  let frontFlapPivot: THREE.Group | null = null;
  if (geo.frontFlap) {
    frontFlapPivot = new THREE.Group();
    frontFlapPivot.position.copy(geo.frontFlapPivot);
    frontFlapPivot.add(mk(geo.frontFlap, bodyMat, 'frontFlap'));
    level0.add(frontFlapPivot);
  }
  const rearFlapPivot = new THREE.Group();
  rearFlapPivot.position.copy(geo.rearFlapPivot);
  rearFlapPivot.add(mk(geo.rearFlap, bodyMat, 'rearFlap'));
  level0.add(rearFlapPivot);

  const steeringGroup = new THREE.Group();
  steeringGroup.position.copy(geo.steeringPivot);
  steeringGroup.rotation.x = geo.steeringTilt;
  const steeringWheel = mk(geo.steeringWheel, bodyMat, 'steeringWheel');
  steeringWheel.castShadow = false;
  steeringGroup.add(steeringWheel);
  level0.add(steeringGroup);

  const rainLight = new THREE.Mesh(geo.rainLight, shared.rainLightMaterial);
  rainLight.name = 'rainLight';
  rainLight.visible = false;
  root.add(rainLight);

  const corners: [number, number, boolean][] = [
    [d.frontHalfTrack, d.frontAxleZ, true],
    [-d.frontHalfTrack, d.frontAxleZ, true],
    [d.rearHalfTrack, d.rearAxleZ, false],
    [-d.rearHalfTrack, d.rearAxleZ, false],
  ];
  let compound: TireCompound = 'medium';
  const wheelMat = (c: TireCompound): THREE.Material => (ghost ? shared.ghostWheelMaterial : shared.wheelMaterials[c] ?? shared.wheelMaterials.medium);
  /** Four steerable / spinning wheels under `parent` (order FL, FR, RL, RR); brake-glow rings when `glow` is set. */
  const buildWheels = (parent: THREE.Object3D, front: THREE.BufferGeometry, rear: THREE.BufferGeometry, glow: boolean): WheelSet => {
    const out: WheelSet = { pivots: [], spinners: [], wheels: [], glows: [] };
    for (const [x, z, isFront] of corners) {
      const pivot = new THREE.Group();
      pivot.position.set(x, isFront ? d.frontWheelRadius : d.rearWheelRadius, z);
      const spinner = new THREE.Group();
      const wheel = mk(isFront ? front : rear, wheelMat(compound), 'wheel');
      if (x < 0) wheel.rotation.y = Math.PI; // outer cover face towards the car's right (-X)
      spinner.add(wheel);
      pivot.add(spinner);
      if (glow) {
        const ring = new THREE.Mesh(isFront ? geo.glowFront : geo.glowRear, glowMat);
        ring.name = 'brakeGlow';
        ring.visible = false;
        if (x < 0) ring.rotation.y = Math.PI;
        pivot.add(ring);
        out.glows.push(ring);
      }
      parent.add(pivot);
      out.pivots.push(pivot);
      out.spinners.push(spinner);
      out.wheels.push(wheel);
    }
    return out;
  };
  const wheelRadii = [d.frontWheelRadius, d.frontWheelRadius, d.rearWheelRadius, d.rearWheelRadius];
  const w0 = buildWheels(level0, geo.wheelFront, geo.wheelRear, true);
  const wheelPivots = w0.pivots;
  const wheelSpinners = w0.spinners;
  const wheels = w0.wheels;
  const glows = w0.glows;

  // ── LOD1 (simplified body / front wing / wheels) + LOD2 (silhouette); the ghost stays LOD0 only ──
  let lod: CarLOD | null = null;
  let frontWing1: THREE.Mesh | null = null;
  let frontWingDamaged1: THREE.Mesh | null = null;
  let w1: WheelSet | null = null;
  if (ghost) root.add(level0);
  else {
    const level1 = new THREE.Group();
    level1.name = 'lod1';
    frontWing1 = mk(geo.lod1.frontWing, bodyMat, 'frontWing');
    frontWingDamaged1 = mk(geo.lod1.frontWingDamaged, bodyMat, 'frontWingDamaged');
    frontWingDamaged1.visible = false;
    level1.add(mk(geo.lod1.body, bodyMat, 'body'), frontWing1, frontWingDamaged1);
    w1 = buildWheels(level1, geo.lod1.wheelFront, geo.lod1.wheelRear, false);
    const level2 = mk(geo.lod2, bodyMat, 'lod2');
    lod = new CarLOD([level0, level1, level2], carLodDistances(quality), CAR_LOD_HYSTERESIS);
    root.add(lod);
  }

  let heat = 0;
  let flap = 0;
  let localTime = 0;
  let detail = true;
  let disposed = false;

  const nodes: CarNodes = {
    body,
    frontWing,
    frontWingDamaged,
    frontFlapPivot,
    rearFlapPivot,
    steeringGroup,
    steeringWheel,
    rainLight,
    wheelPivots,
    wheelSpinners,
    wheels,
    glows,
    lod,
  };

  const setFlap = (open: number, droop: number, twist: number): void => {
    rearFlapPivot.rotation.x = geo.rearFlapClosed + (geo.rearFlapOpen - geo.rearFlapClosed) * open - droop;
    rearFlapPivot.rotation.z = twist;
    if (frontFlapPivot) frontFlapPivot.rotation.x = geo.frontFlapClosed + (geo.frontFlapOpen - geo.frontFlapClosed) * open;
  };
  setFlap(0, 0, 0);

  // damage presentation state: impact scuffs accumulated over the session
  const look = createDamageLook();
  let impactScuff = 0;
  let prevImpact = 0;
  const frontFlapBaseY = frontFlapPivot ? frontFlapPivot.position.y : 0;
  /** Splay the damaged corner's wheel (camber / toe / pushed out); the other three keep their base pose. */
  const deformWheels = (set: WheelSet): void => {
    for (let i = 0; i < set.pivots.length; i++) {
      const pivot = set.pivots[i];
      const side = corners[i][0] > 0 ? 1 : -1;
      const hit = i === look.corner;
      pivot.position.x = corners[i][0] + (hit ? side * look.wheelOut : 0);
      pivot.rotation.z = hit ? -side * look.camber : 0;
      // front pivots carry this frame's steer (poseWheels runs first), rear pivots none
      pivot.rotation.y = (i < 2 ? pivot.rotation.y : 0) + (hit ? side * look.toe : 0);
    }
  };

  const model: CarModel = {
    root,
    nodes,
    regulation: opts.regulation,
    ghost,
    get heat() {
      return heat;
    },
    get flapOpen() {
      return flap;
    },
    apply(state: CarRenderState, dtIn: number, ctx?: CarApplyContext): void {
      if (disposed) return;
      const dt = Number.isFinite(dtIn) ? clamp(dtIn, 0, 0.25) : 0;
      localTime = ctx?.time !== undefined && Number.isFinite(ctx.time) ? ctx.time : localTime + dt;
      const ok = Number.isFinite(state.x) && Number.isFinite(state.y) && Number.isFinite(state.z) && Number.isFinite(state.yaw);
      root.visible = state.visible !== false && ok;
      if (!root.visible) return;
      // damage: wing bend / flap hang / splayed wheel / body sag / scuffs
      if (!ghost) {
        impactScuff = scuffAfterImpact(impactScuff, fin(state.impact), prevImpact);
        prevImpact = fin(state.impact);
        damageLook(state.damage, fin(state.damage?.corner ?? 0), impactScuff, look);
        scuffAmount.value = look.scuff;
      }
      const pitch = fin(state.pitch) + look.sagPitch;
      const roll = fin(state.roll) + look.sagRoll;
      root.position.set(state.x, state.y, state.z);
      root.rotation.set(-pitch, state.yaw, roll, 'YXZ');

      // LOD0 and LOD1 are both kept current: in split-screen each view may show a different level
      const steer = clamp(fin(state.steerAngle), -0.7, 0.7);
      const spin = fin(state.wheelSpin) % (Math.PI * 2);
      poseWheels(w0, steer, spin);
      if (w1) poseWheels(w1, steer, spin);
      deformWheels(w0);
      if (w1) deformWheels(w1);
      const dynPitch = pitch - groundPitchOf(state);
      seatWheels(w0, wheelRadii, dynPitch, roll);
      if (w1) seatWheels(w1, wheelRadii, dynPitch, roll);
      steeringWheel.rotation.z = clamp(steer * STEER_RATIO, -2.4, 2.4);

      // tyre compound (sidewall band)
      if (state.compound !== compound && !ghost) {
        compound = state.compound in shared.wheelMaterials ? state.compound : 'medium';
        for (const w of wheels) w.material = wheelMat(compound);
        if (w1) for (const w of w1.wheels) w.material = wheelMat(compound);
      }

      // DRS / active aero flaps
      flap = damp(flap, state.drsOpen ? 1 : 0, 14, dt);
      setFlap(flap, look.rearFlapDroop, look.rearFlapTwist);

      // front wing damage: bent (rolled / sagging on the hit side), then broken off
      const broken = look.frontWingBroken;
      for (const w of [frontWing, frontWing1]) {
        if (!w) continue;
        w.rotation.z = look.frontWingRoll;
        w.position.y = -look.frontWingDrop;
      }
      if (frontFlapPivot) {
        frontFlapPivot.rotation.z = look.frontWingRoll;
        frontFlapPivot.position.y = frontFlapBaseY - look.frontWingDrop;
      }
      frontWing.visible = !broken;
      frontWingDamaged.visible = broken;
      if (frontFlapPivot) frontFlapPivot.visible = !broken;
      if (frontWing1) frontWing1.visible = !broken;
      if (frontWingDamaged1) frontWingDamaged1.visible = broken;

      // brake discs: heat builds with brake * speed, cools slowly
      const target = clamp01(fin(state.brake)) * clamp01(fin(state.speed) / 45);
      heat = damp(heat, target, target > heat ? 2.2 : 0.45, dt);
      const glowOn = !ghost && heat > 0.04;
      glowMat.opacity = clamp01(heat * 1.25);
      glowMat.color.setRGB(1, 0.18 + 0.4 * heat, 0.05 + 0.1 * heat);
      for (const g of glows) g.visible = glowOn;

      // rain / limiter light: 4 Hz blink
      const rain = fin(ctx?.rain);
      const lit = state.rainLight || state.limiter || rain > 0.1;
      rainLight.visible = !ghost && lit && Math.floor(localTime * 8) % 2 === 0;

      steeringGroup.visible = detail;
    },
    setLivery(livery: Livery, number: number, teamShort: string, helmet: Livery): void {
      if (disposed) return;
      const canvas = paintLiveryCanvas(size, d, { livery, number, teamShort, helmet });
      const next = new THREE.CanvasTexture(canvas.canvas);
      next.colorSpace = livTex.colorSpace;
      next.anisotropy = livTex.anisotropy;
      next.needsUpdate = true;
      bodyMat.map = next;
      applyFinish(bodyMat, livery.finish, ghost);
      bodyMat.needsUpdate = true;
      livTex.dispose();
      livTex = next;
    },
    setDetail(near: boolean): void {
      detail = near;
      steeringGroup.visible = near;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      livTex.dispose();
      bodyMat.dispose();
      glowMat.dispose();
      releaseCarGeometry(opts.regulation);
      if (ownShared) shared.dispose();
    },
  };
  return model;
}

function fin(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) ? v : 0;
}
