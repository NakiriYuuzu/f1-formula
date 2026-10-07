/**
 * Contact shadows: a soft dark footprint under every visible car (and the safety car) with darker patches under the
 * four tyres, so the cars read as sitting on the road even where the sun's shadow falls to the side (or when shadows
 * are off). One InstancedMesh per footprint shape — race cars, safety car — i.e. two draw calls in total.
 */
import * as THREE from 'three';
import type { CarRenderState, SafetyCarRenderState } from '../../core/types';
import type { CarDims } from '../car/dims';
import { SC_AXLE_Z, SC_LENGTH, SC_WHEEL_WIDTH, SC_WHEEL_X, SC_WIDTH } from '../car/safetyCarGeometry';
import { clamp01, smoothstep } from '../../core/math';
import type { TimeOfDay } from '../../core/types';
import type { Disposer } from '../core/disposer';

/**
 * Height (m) of the footprint above the car's ground point. The footprint is tilted to the road grade like the car
 * (see groundPitchOf), so this only has to clear the road ribbon's chord error over the footprint length (~3 cm on a crest).
 */
export const CONTACT_LIFT = 0.04;
/** Overall darkness of the footprint (material opacity). */
export const CONTACT_OPACITY = 0.9;
/** Peak alpha of the floor shadow and of the tyre contact patches inside the texture. */
const FLOOR_ALPHA = 0.72;
/** Floor-shadow peak by time of day: under floodlights the road is bright and the sun's shadow weak, so the footprint is darker. */
const FLOOR_ALPHA_BY_TIME: Record<TimeOfDay, number> = { day: FLOOR_ALPHA, dusk: 0.8, night: 0.88 };
/** Footprints draw after the additive light pools / racing line (renderOrder 2): a pool must never wash the shadow out. */
const SHADOW_RENDER_ORDER = 3;
const TYRE_ALPHA = 0.95;
/** Margin (m) the soft edge extends beyond the car outline. */
const MARGIN = 0.55;
/**
 * Tyre contact patch (m): length along the car and how far it spreads beyond the tyre sides. It has to reach well past
 * the tyre (radius 0.36 m) so a dark rim is visible around every tyre foot, not just under it.
 */
const PATCH_LENGTH = 1.2;
const PATCH_SPREAD = 0.2;

export interface Footprint {
  length: number;
  width: number;
  /** floor shadow extent (m) */
  floorLength: number;
  floorWidth: number;
  axles: { z: number; halfTrack: number; tyreWidth: number }[];
}

export function raceFootprint(d: CarDims): Footprint {
  return {
    length: d.length,
    width: d.width,
    floorLength: d.length * 0.96,
    floorWidth: d.width * 0.86,
    axles: [
      { z: d.frontAxleZ, halfTrack: d.frontHalfTrack, tyreWidth: d.frontTyreWidth },
      { z: d.rearAxleZ, halfTrack: d.rearHalfTrack, tyreWidth: d.rearTyreWidth },
    ],
  };
}

const SAFETY_CAR_FOOTPRINT: Footprint = {
  length: SC_LENGTH,
  width: SC_WIDTH,
  floorLength: SC_LENGTH,
  floorWidth: SC_WIDTH,
  axles: [
    { z: SC_AXLE_Z, halfTrack: SC_WHEEL_X, tyreWidth: SC_WHEEL_WIDTH },
    { z: -SC_AXLE_Z, halfTrack: SC_WHEEL_X, tyreWidth: SC_WHEEL_WIDTH },
  ],
};

/** Texture resolution of a footprint (across × along the car). */
const TEX_W = 64;
const TEX_H = 128;

/** Alpha of a soft elliptical blob at normalised distance d (0 = centre, 1 = edge). */
/** Flat dark core up to FALLOFF_START, then a soft edge to 0 at the ellipse rim (keeps the shadow dark under the car). */
const FALLOFF_START = 0.55;
const blobAlpha = (d: number, peak: number): number => (d >= 1 ? 0 : peak * (1 - smoothstep(FALLOFF_START, 1, d)));

/**
 * Footprint alpha at a point of the car's ground plane (x across, z along; metres). Pure, for tests too.
 */
export function footprintAlpha(f: Footprint, x: number, z: number, floorAlpha = FLOOR_ALPHA): number {
  const fx = f.floorWidth / 2 + MARGIN;
  const fz = f.floorLength / 2 + MARGIN;
  // squarish (p = 4) rather than elliptical, so the shade covers the corners of the car outline too
  let a = blobAlpha(Math.sqrt(Math.sqrt((x / fx) ** 4 + (z / fz) ** 4)), floorAlpha);
  for (const ax of f.axles) {
    const rx = ax.tyreWidth / 2 + PATCH_SPREAD;
    const rz = PATCH_LENGTH / 2 + 0.08;
    for (const side of [-1, 1]) {
      a = Math.max(a, blobAlpha(Math.hypot((x - side * ax.halfTrack) / rx, (z - ax.z) / rz), TYRE_ALPHA));
    }
  }
  return a;
}

/**
 * Footprint as an alpha-only data texture (black RGB). Row 0 is v = 0, which buildPlane maps to the nose (+Z).
 */
function footprintTexture(f: Footprint, floorAlpha: number): THREE.DataTexture {
  const W = f.width + 2 * MARGIN;
  const H = f.length + 2 * MARGIN;
  const data = new Uint8Array(TEX_W * TEX_H * 4);
  for (let row = 0; row < TEX_H; row++) {
    const z = -((row + 0.5) / TEX_H - 0.5) * H;
    for (let col = 0; col < TEX_W; col++) {
      const x = ((col + 0.5) / TEX_W - 0.5) * W;
      data[(row * TEX_W + col) * 4 + 3] = Math.round(255 * clamp01(footprintAlpha(f, x, z, floorAlpha)));
    }
  }
  const tex = new THREE.DataTexture(data, TEX_W, TEX_H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Flat plane in the car's ground plane: +Z = nose. */
function buildPlane(f: Footprint): THREE.BufferGeometry {
  // PlaneGeometry lies in XY with v up along +Y; rotating −90° about X maps +Y → −Z: v = 1 is the rear, v = 0 the nose.
  return new THREE.PlaneGeometry(f.width + 2 * MARGIN, f.length + 2 * MARGIN).rotateX(-Math.PI / 2);
}

function shadowMesh(disposer: Disposer, f: Footprint, capacity: number, name: string, floorAlpha: number): THREE.InstancedMesh {
  const material = disposer.add(
    new THREE.MeshBasicMaterial({
      name,
      map: disposer.add(footprintTexture(f, floorAlpha)),
      color: 0x000000,
      transparent: true,
      opacity: CONTACT_OPACITY,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  const mesh = new THREE.InstancedMesh(disposer.add(buildPlane(f)), material, Math.max(1, capacity));
  mesh.name = name;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = SHADOW_RENDER_ORDER;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

/** Optional ground-plane pitch (rad, nose up) of a car: the road grade without the dynamic body pitch. */
export function groundPitchOf(c: CarRenderState): number {
  const gp = c.groundPitch;
  const p = gp !== undefined && Number.isFinite(gp) ? gp : c.pitch;
  return Number.isFinite(p) ? p : 0;
}

/** Footprint placement: on the ground plane under the car, yawed and tilted with the road grade (YXZ like the car). */
function place(m: THREE.Matrix4, x: number, y: number, z: number, yaw: number, pitch: number): void {
  _e.set(-pitch, Number.isFinite(yaw) ? yaw : 0, 0, 'YXZ');
  m.makeRotationFromEuler(_e);
  m.setPosition(x, (Number.isFinite(y) ? y : 0) + CONTACT_LIFT, z);
}

export class ContactShadows {
  readonly group = new THREE.Group();
  private readonly cars: THREE.InstancedMesh;
  private readonly safetyCar: THREE.InstancedMesh;

  constructor(disposer: Disposer, dims: CarDims, capacity: number, timeOfDay: TimeOfDay = 'day') {
    const floorAlpha = FLOOR_ALPHA_BY_TIME[timeOfDay] ?? FLOOR_ALPHA;
    this.cars = shadowMesh(disposer, raceFootprint(dims), capacity, 'contact-shadow-cars', floorAlpha);
    this.safetyCar = shadowMesh(disposer, SAFETY_CAR_FOOTPRINT, 1, 'contact-shadow-sc', floorAlpha);
    this.group.name = 'contactShadows';
    this.group.add(this.cars, this.safetyCar);
  }

  /** Place one footprint under every visible, non-ghost car and under the safety car when it is out. */
  update(cars: readonly CarRenderState[], safetyCar: SafetyCarRenderState | null | undefined): void {
    const max = this.cars.instanceMatrix.count;
    let n = 0;
    for (const c of cars) {
      if (n >= max) break;
      if (!c.visible || c.ghost || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
      place(_m, c.x, c.y, c.z, c.yaw, groundPitchOf(c));
      this.cars.setMatrixAt(n++, _m);
    }
    this.cars.count = n;
    this.cars.instanceMatrix.needsUpdate = true;

    const sc = safetyCar && Number.isFinite(safetyCar.x) && Number.isFinite(safetyCar.z) ? safetyCar : null;
    if (sc) {
      place(_m, sc.x, sc.y, sc.z, sc.yaw, Number.isFinite(sc.pitch) ? (sc.pitch as number) : 0);
      this.safetyCar.setMatrixAt(0, _m);
      this.safetyCar.instanceMatrix.needsUpdate = true;
    }
    this.safetyCar.count = sc ? 1 : 0;
  }
}
