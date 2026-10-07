/**
 * Simplified car levels of detail, built from the same sections / outlines as LOD0 (sharedParts) so the
 * silhouette and livery do not jump on a switch:
 *   LOD1 — one merged body (fewer loft / airfoil / tube segments, flaps merged closed, main suspension links
 *          only, low-poly driver), a separate front wing (intact / damaged) and low-segment wheels that still
 *          steer and spin.
 *   LOD2 — a single ≤ 400-triangle silhouette (body, sidepods, airbox, helmet, floor, wings, wheels) mapped onto
 *          the livery atlas, so it renders with the car's own livery material in one draw call.
 */
import * as THREE from 'three';
import type { CarDims } from './dims';
import { PartList, type UVMap } from './parts';
import { loft, revolve, type LoftStation, type RevolveStrip } from './shapes';
import {
  addPodInlet,
  addFin,
  addFloor,
  addFrontFlaps,
  addFrontWing,
  addHalo,
  addRearEnd,
  addRearFlap,
  addRearWing,
  addSuspension,
  bodyWrap,
  frontWingSpan,
  WHEEL_UV,
  type BodyStations,
} from './sharedParts';

export interface CarLodGeometry {
  /** merged body incl. rear wing (flap closed), fin, floor, main suspension links, halo and driver */
  body: THREE.BufferGeometry;
  /** front wing incl. its flaps (2026 active flaps merged closed) */
  frontWing: THREE.BufferGeometry;
  frontWingDamaged: THREE.BufferGeometry;
  /** wheels around the local X axle, outer face +X (same convention as LOD0) */
  wheelFront: THREE.BufferGeometry;
  wheelRear: THREE.BufferGeometry;
}

/** LOD1 tessellation: loft contour points, airfoil outline points, rod / tube sides, helmet and wheel segments. */
export const LOD1_DETAIL = {
  mono: 16,
  monoCut: 4,
  cover: 12,
  airbox: 10,
  pod: 12,
  intake: 8,
  foil: 4,
  rod: 3,
  haloHoop: 16,
  haloPillar: 4,
  tube: 4,
  helmetW: 8,
  helmetH: 6,
  wheel: 12,
} as const;

/** LOD2 tessellation (keeps the whole silhouette ≤ 400 triangles). */
export const LOD2_DETAIL = { body: 8, pod: 6, wheel: 6 } as const;

const BLACK: UVMap = { kind: 'swatch', name: 'black' };
const CARBON: UVMap = { kind: 'swatch', name: 'carbon' };
const PRIMARY: UVMap = { kind: 'swatch', name: 'primary' };

export function buildCarLod1(d: CarDims, st: BodyStations): CarLodGeometry {
  const D = LOD1_DETAIL;
  const is26 = d.regulation === '2026';
  const rz = d.rearAxleZ;
  const kx = d.width / 2.0;
  const wrap = bodyWrap(d, st);
  const body = new PartList(d);

  body.add(loft(st.mono, { segments: D.mono, cutHalfWidth: 0.25, cutSegments: D.monoCut, capStart: true, capEnd: true }), wrap);
  body.add(loft(st.cover, { segments: D.cover, capStart: true, capEnd: true }), wrap);
  body.add(loft(st.airbox, { segments: D.airbox, capStart: true, capEnd: false }), wrap);
  body.add(new THREE.CircleGeometry(1, D.intake).scale(0.105, 0.11, 1).translate(0, 0.9, -0.41), BLACK);
  body.add(loft(st.pod, { segments: D.pod, capStart: true, capEnd: false }), wrap, true);
  addPodInlet(body, st, false);

  addFloor(body, d, false);
  body.add(new THREE.BoxGeometry(0.22, 0.22, 0.7).translate(0, 0.3, rz - 0.1), CARBON);
  addRearEnd(body, d, false);
  addSuspension(body, d, false, D.rod);
  addHalo(body, D.haloHoop, D.haloPillar, D.tube);

  // driver: helmet, shoulders, headrest
  const hc = new THREE.Vector3(0, d.helmetY, d.helmetZ);
  body.add(new THREE.SphereGeometry(d.helmetR, D.helmetW, D.helmetH).translate(hc.x, hc.y, hc.z), { kind: 'helmet', centre: hc });
  body.add(new THREE.BoxGeometry(0.37, 0.15, 0.15).translate(0, 0.56, d.helmetZ - 0.02), PRIMARY);
  body.add(new THREE.BoxGeometry(0.46, 0.1, 0.08).translate(0, 0.665, d.cockpitZ0 + 0.02), BLACK);
  // mirror housings
  body.add(new THREE.BoxGeometry(0.17, 0.065, 0.05).translate(0.52 * kx, 0.76, 0.6), PRIMARY, true);

  addFin(body, d, st);
  addRearWing(body, d, is26, D.foil, false);
  addRearFlap(body, d, D.foil, true);

  const wing = (damaged: boolean): THREE.BufferGeometry => {
    const w = new PartList(d);
    // same element set as LOD0: 2025 wings carry fixed flaps; 2026 intact wings get their active flaps (closed)
    addFrontWing(w, d, damaged, damaged || !is26, D.foil, false);
    if (is26 && !damaged) addFrontFlaps(w, d, D.foil, true);
    return w.build();
  };

  return {
    body: body.build(),
    frontWing: wing(false),
    frontWingDamaged: wing(true),
    wheelFront: buildWheelLite(d, d.frontTyreWidth, d.frontWheelRadius, D.wheel),
    wheelRear: buildWheelLite(d, d.rearTyreWidth, d.rearWheelRadius, D.wheel),
  };
}

/**
 * Low-segment tyre + flush wheel cover (outer face +X: rubber / compound band / rubber / rim rings), plain inner
 * face. Indexes the same per-compound wheel atlas as LOD0, so compound colours still match.
 */
function buildWheelLite(d: CarDims, width: number, R: number, segments: number): THREE.BufferGeometry {
  const hw = width / 2;
  const rimR = 0.2286;
  const bandOut = R - 0.05;
  const bandIn = R - 0.07;
  const pt = (r: number, a: number, nr: number, na: number): { r: number; a: number; nr: number; na: number } => ({ r, a, nr, na });
  const strips: RevolveStrip[] = [
    { key: 'rubber', points: [pt(R, -hw, 1, 0), pt(R, hw, 1, 0)] },
    { key: 'rubber', points: [pt(R, hw, 0, 1), pt(bandOut, hw, 0, 1)] },
    { key: 'band', points: [pt(bandOut, hw, 0, 1), pt(bandIn, hw, 0, 1)] },
    { key: 'rubber', points: [pt(bandIn, hw, 0, 1), pt(rimR, hw, 0, 1)] },
    { key: 'rim', points: [pt(rimR, hw, 0, 1), pt(0.001, hw, 0, 1)] },
    { key: 'rubber', points: [pt(R, -hw, 0, -1), pt(0.001, -hw, 0, -1)] },
  ];
  const { geometry, keys } = revolve(strips, segments);
  const list = new PartList(d);
  list.add(geometry, { kind: 'keyed', keys, uv: WHEEL_UV });
  return list.build();
}

/** Copy of selected stations with the cockpit opening removed (LOD2 body is closed; the helmet sits on top). */
function pick(stations: readonly LoftStation[], indices: readonly number[]): LoftStation[] {
  const out: LoftStation[] = [];
  for (const i of indices) {
    const s = stations[i];
    if (s) out.push({ ...s, cut: 0 });
  }
  return out;
}

export function buildCarLod2(d: CarDims, st: BodyStations): THREE.BufferGeometry {
  const D = LOD2_DETAIL;
  const wrap = bodyWrap(d, st);
  const list = new PartList(d);
  const { fs, fwz } = frontWingSpan(d);
  const rs = d.rearWingHalfSpan;

  // engine cover + monocoque + nose as one closed loft, sidepods (mirrored), airbox, helmet, floor
  list.add(loft([...pick(st.cover, [0, 2, 4]), ...pick(st.mono, [2, 6, 8, 11])], { segments: D.body, capStart: true, capEnd: true }), wrap);
  list.add(loft(pick(st.pod, [2, 4, 6]), { segments: D.pod, capStart: true, capEnd: true }), wrap, true);
  list.add(new THREE.BoxGeometry(0.24, 0.3, 0.85).translate(0, 0.85, -0.825), wrap);
  const hc = new THREE.Vector3(0, d.helmetY, d.helmetZ);
  list.add(new THREE.IcosahedronGeometry(d.helmetR, 0).translate(hc.x, hc.y, hc.z), { kind: 'helmet', centre: hc });
  list.add(new THREE.BoxGeometry(1.56 * (d.width / 2), 0.03, 2.1).translate(0, 0.05, -0.45), CARBON);

  // front wing (endplate to endplate), rear wing block + endplates
  list.add(new THREE.BoxGeometry(2 * fs + 0.04, 0.05, 0.55).translate(0, 0.1, fwz - 0.27), CARBON);
  list.add(new THREE.BoxGeometry(2 * rs, 0.12, 0.42).translate(0, 0.86, d.rearWingZ1 - 0.22), CARBON);
  const epH = 1.045 - 0.3;
  const epL = d.rearWingZ1 - d.rearWingZ0;
  list.add(new THREE.BoxGeometry(0.02, epH, epL).translate(rs + 0.01, 0.3 + epH / 2, (d.rearWingZ0 + d.rearWingZ1) / 2), { kind: 'swatch', name: 'rearWing' }, true);

  // wheels (static: at this distance spin / steer are invisible)
  const corners: [number, number, number, number][] = [
    [d.frontHalfTrack, d.frontAxleZ, d.frontTyreWidth, d.frontWheelRadius],
    [d.rearHalfTrack, d.rearAxleZ, d.rearTyreWidth, d.rearWheelRadius],
  ];
  for (const [x, z, w, R] of corners) {
    const g = new THREE.CylinderGeometry(R, R, w, D.wheel, 1, false);
    // turn a rim vertex to angle 3π/2 (straight down once the axle is along X) so the low-poly tyre touches the ground
    g.rotateY((Math.PI * 1.5) % ((Math.PI * 2) / D.wheel)).rotateZ(Math.PI / 2).translate(x, R, z);
    list.add(g, BLACK, true);
  }
  return list.build();
}
