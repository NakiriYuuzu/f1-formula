/**
 * Car parts shared by the levels of detail: body loft stations, the livery wrap axis that follows them, flap
 * pivots / angles, wheel atlas UVs, and part builders with a detail parameter (floor, suspension, halo, fin,
 * wings, flaps). LOD0 (carGeometry) and LOD1 (carLodGeometry) build from the same numbers, so silhouettes and
 * paint line up when a car switches level.
 */
import * as THREE from 'three';
import type { CarDims } from './dims';
import { reflectX, type PartList, type UVMap } from './parts';
import { airfoil, blade, plateXZ, plateZY, rod, type LoftStation } from './shapes';

export interface BodyStations {
  /** monocoque + nose (open cockpit U-section between cockpitZ0 and cockpitZ1) */
  mono: LoftStation[];
  /** engine cover from the gearbox to the cockpit */
  cover: LoftStation[];
  /** airbox / roll hoop above the driver (front is the intake) */
  airbox: LoftStation[];
  /** left sidepod with undercut (mirror for the right one); the last station is the inlet */
  pod: LoftStation[];
}

export function carBodyStations(d: CarDims): BodyStations {
  const fz = d.frontAxleZ;
  const rz = d.rearAxleZ;
  const kx = d.width / 2.0;
  return {
    mono: [
      { z: d.cockpitZ0 - 0.02, hw: 0.4, yb: 0.1, yt: 0.7, cut: 0, n: 3 },
      { z: d.cockpitZ0 + 0.02, hw: 0.4, yb: 0.1, yt: 0.7, cut: 0.4, n: 3 },
      { z: 0.0, hw: 0.41, yb: 0.08, yt: 0.7, cut: 0.4, n: 3 },
      { z: 0.3, hw: 0.39, yb: 0.1, yt: 0.7, cut: 0.37, n: 3 },
      { z: d.cockpitZ1 - 0.04, hw: 0.37, yb: 0.12, yt: 0.7, cut: 0.33, n: 3 },
      { z: d.cockpitZ1, hw: 0.36, yb: 0.12, yt: 0.7, cut: 0, n: 3 },
      { z: 0.9, hw: 0.32, yb: 0.16, yt: 0.67, cut: 0, n: 2.8 },
      { z: fz - 0.5, hw: 0.26, yb: 0.2, yt: 0.62, n: 2.6 },
      { z: fz - 0.15, hw: 0.2, yb: 0.21, yt: 0.5, n: 2.5 },
      // raised nose that drops onto the front wing pylons (blunt tip, like the 2022+ noses)
      { z: fz + 0.35, hw: 0.135, yb: 0.2, yt: 0.4, n: 2.4 },
      { z: d.noseTipZ - 0.12, hw: 0.095, yb: 0.17, yt: 0.31, n: 2.3 },
      { z: d.noseTipZ, hw: 0.065, yb: 0.16, yt: 0.26, n: 2.2 },
    ],
    cover: [
      // slim tail between the rear wheels, then the coke-bottle spine widening towards the cockpit
      { z: rz - 0.35, hw: 0.09, yb: 0.2, yt: 0.4, n: 2.4 },
      { z: rz - 0.05, hw: 0.13, yb: 0.17, yt: 0.48, n: 2.4 },
      { z: -1.45, hw: 0.18, yb: 0.14, yt: 0.58, n: 2.4 },
      { z: -1.0, hw: 0.26, yb: 0.11, yt: 0.7, n: 2.5 },
      { z: -0.6, hw: 0.36, yb: 0.09, yt: 0.78, n: 2.6 },
      { z: d.cockpitZ0, hw: 0.4, yb: 0.1, yt: 0.72, n: 2.8 },
    ],
    airbox: [
      { z: -1.3, hw: 0.06, yb: 0.62, yt: 0.78, n: 2.6 },
      { z: -0.95, hw: 0.11, yb: 0.68, yt: 0.92, n: 2.8 },
      { z: -0.62, hw: 0.135, yb: 0.72, yt: 0.99, n: 3 },
      { z: -0.4, hw: 0.115, yb: 0.78, yt: 1.01, n: 3 },
    ],
    pod: [
      { z: -1.75, xc: 0.15, hw: 0.07, yb: 0.16, yt: 0.27, n: 2.4 },
      { z: -1.35, xc: 0.22, hw: 0.12, yb: 0.13, yt: 0.34, n: 2.6, tuck: 0.2 },
      { z: -0.9, xc: 0.32, hw: 0.17, yb: 0.11, yt: 0.47, n: 2.8, tuck: 0.4 },
      { z: -0.4, xc: 0.39, hw: 0.19, yb: 0.11, yt: 0.6, n: 3, tuck: 0.55 },
      { z: 0.1, xc: 0.42, hw: 0.19, yb: 0.13, yt: 0.66, n: 3.1, tuck: 0.6 },
      { z: 0.5, xc: 0.42, hw: 0.185, yb: 0.22, yt: 0.66, n: 3.3, tuck: 0.55 },
      { z: 0.8, xc: 0.41, hw: 0.165, yb: 0.34, yt: 0.62, n: 3.5, tuck: 0.3 },
    ].map((s) => ({ ...s, xc: s.xc * kx })),
  };
}

/**
 * Livery wrap axis height along z: the mid-height of the given centreline sections, linearly interpolated
 * (clamped at the ends). Keeps the wrap seam under the low nose and tail instead of across their top.
 */
export function wrapAxis(stations: readonly LoftStation[]): (z: number) => number {
  const pts = stations.map((s) => [s.z, (s.yb + s.yt) / 2] as const).sort((a, b) => a[0] - b[0]);
  return (z) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return 0.4;
    if (z <= first[0]) return first[1];
    if (z >= last[0]) return last[1];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1] as readonly [number, number];
      const q = pts[i] as readonly [number, number];
      if (z <= q[0]) return q[0] - p[0] < 1e-9 ? q[1] : p[1] + ((q[1] - p[1]) * (z - p[0])) / (q[0] - p[0]);
    }
    return last[1];
  };
}

/** One shared wrap mapping for every wrapped part so the paint lines up where parts (and levels) meet. */
export function bodyWrap(d: CarDims, st: BodyStations): UVMap {
  return { kind: 'wrap', axisY: wrapAxis([...st.cover, ...st.mono.filter((s) => s.z > d.cockpitZ0)]) };
}

/** Flap rotation.x when closed / open (rad). */
export const REAR_FLAP_CLOSED = 0.62;
export const REAR_FLAP_OPEN = 0.12;
export const FRONT_FLAP_CLOSED = 0.35;
export const FRONT_FLAP_OPEN = 0.08;

/** Front wing element half span and the leading z of its main plane. */
export function frontWingSpan(d: CarDims): { fs: number; fwz: number } {
  // 0.05 m in from the full width: endplate (0.02) + outboard footplate (0.03) fill the rest
  return { fs: d.frontWingHalfSpan - 0.05, fwz: d.frontWingZ1 - 0.02 };
}

/** Pivot of the rear DRS / active flap (flap geometry is pivot-local, chord towards -Z). */
export function rearFlapPivotOf(d: CarDims): THREE.Vector3 {
  return new THREE.Vector3(0, 0.9, d.rearWingZ1 - 0.2);
}

/** Pivot of the 2026 active-aero front flaps. */
export function frontFlapPivotOf(d: CarDims): THREE.Vector3 {
  return new THREE.Vector3(0, 0.115, frontWingSpan(d).fwz - 0.22);
}

/** Wheel atlas keys (4 columns of the per-compound wheel texture). */
export const WHEEL_KEYS = ['rubber', 'band', 'rim', 'nut'] as const;
export const WHEEL_UV: Record<string, [number, number]> = {
  rubber: [0.125, 0.5],
  band: [0.375, 0.5],
  rim: [0.625, 0.5],
  nut: [0.875, 0.5],
};

const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const CARBON: UVMap = { kind: 'swatch', name: 'carbon' };
const SATIN: UVMap = { kind: 'swatch', name: 'satin' };
const BLACK: UVMap = { kind: 'swatch', name: 'black' };
const WHITE: UVMap = { kind: 'swatch', name: 'white' };
const HALO: UVMap = { kind: 'swatch', name: 'halo' };
const FRONT_WING: UVMap = { kind: 'swatch', name: 'frontWing' };
const REAR_WING: UVMap = { kind: 'swatch', name: 'rearWing' };
const REAR_FLAP: UVMap = { kind: 'swatch', name: 'rearFlap' };

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Points of a quadratic Bezier (n + 1 points, both ends included). */
function quadCurve(p0: [number, number], p1: [number, number], p2: [number, number], n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]]);
  }
  return out;
}

/** Arc points (centre cz, cy; radius r; angles in rad), n + 1 points. */
function arcPoints(cz: number, cy: number, r: number, a0: number, a1: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cz + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Vertical (z, y) plate leaning outwards by `roll` (rad) about its bottom edge; built for the left (+X) side. */
function tiltedPlate(outline: [number, number][], x: number, y: number, roll: number, thickness: number): THREE.BufferGeometry {
  const g = plateZY(outline, 0, thickness);
  g.rotateZ(-roll);
  g.translate(x, y + thickness * Math.sin(roll), 0); // keep the lowest corner at y
  return g;
}

/** Add a part built for the car's left side to the left side, the right side or both. */
function addSides(list: PartList, build: () => THREE.BufferGeometry, map: UVMap, left: boolean, right: boolean): void {
  if (left && right) list.add(build(), map, true);
  else if (left) list.add(build(), map);
  else if (right) {
    const g = build();
    const flat = g.index ? g.toNonIndexed() : g;
    if (flat !== g) g.dispose();
    reflectX(flat);
    list.add(flat, map);
  }
}

/** Centre-line height of the engine cover top at z (linear between its stations, clamped). */
function coverTop(cover: readonly LoftStation[], z: number): number {
  const st = [...cover].sort((a, b) => a.z - b.z);
  if (z <= st[0].z) return st[0].yt;
  for (let i = 1; i < st.length; i++) {
    if (z <= st[i].z) return st[i - 1].yt + ((st[i].yt - st[i - 1].yt) * (z - st[i - 1].z)) / (st[i].z - st[i - 1].z);
  }
  return st[st.length - 1].yt;
}

/** Sidepod inlet: a slanted D-shaped opening (outboard top corner high, inboard low) just inside the pod mouth. */
export function addPodInlet(list: PartList, st: BodyStations, fine: boolean): void {
  const s = st.pod[st.pod.length - 1];
  const a = s.hw * 0.88;
  const b = ((s.yt - s.yb) / 2) * 0.84;
  const n = fine ? 16 : 8;
  const shape = new THREE.Shape();
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const cx = Math.sign(Math.cos(t)) * Math.pow(Math.abs(Math.cos(t)), 2 / 3);
    let sy = Math.sign(Math.sin(t)) * Math.pow(Math.abs(Math.sin(t)), 2 / 3);
    if (sy > 0) sy += 0.22 * cx; // mirrored lip
    else sy = sy * 0.9 - 0.1; // flatter, lower edge
    if (i === 0) shape.moveTo(cx * a, sy * b);
    else shape.lineTo(cx * a, sy * b);
  }
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape);
  g.translate(s.xc ?? 0, (s.yb + s.yt) / 2, s.z - 0.012);
  list.add(g, BLACK, true);
}

/**
 * Floor plate, edge wing / fence and diffuser. 2025: tunnel-inlet fences, a two-element curled edge wing, a tall
 * diffuser with strakes and a dark exit cavity. 2026: flatter, 150 mm narrower floor with a plain edge fence and a
 * smaller diffuser. `fine` adds the small parts (fences, second edge element, strakes, exit cavity).
 */
export function addFloor(list: PartList, d: CarDims, fine: boolean): void {
  const is26 = d.regulation === '2026';
  const fz = d.frontAxleZ;
  const rz = d.rearAxleZ;
  const kx = d.width / 2.0;
  const inset = is26 ? 0.03 : 0;
  const half: [number, number][] = [
    [0.3, fz - 0.5],
    [0.62, fz - 0.8],
    [0.78, 0.6],
    [0.8, -1.2],
    [0.56, rz + 0.3],
    [0.55, rz - 0.25],
  ];
  const outline: [number, number][] = [
    ...half.map(([x, z]) => [x * kx - inset, z] as [number, number]),
    ...[...half].reverse().map(([x, z]) => [-(x * kx - inset), z] as [number, number]),
  ];
  list.add(plateXZ(outline, 0.035, 0.03), SATIN);
  const ex = 0.78 * kx - inset - 0.01;
  if (is26) {
    // plain low edge fence
    list.add(plateZY([[0.6, 0.035], [0.6, 0.075], [-1.2, 0.085], [-1.2, 0.035]], ex, 0.012), SATIN, true);
  } else {
    // curled edge wing (outer element, plus a shorter inner one when fine)
    list.add(tiltedPlate([[0.55, 0], [0.55, 0.06], [-1.15, 0.11], [-1.15, 0]], ex, 0.035, 0.6, 0.01), SATIN, true);
    if (fine) {
      list.add(tiltedPlate([[0.25, 0], [0.25, 0.05], [-1.0, 0.1], [-1.0, 0]], ex - 0.05, 0.035, 0.42, 0.01), SATIN, true);
      // Venturi tunnel inlet fences ahead of the sidepod mouth
      for (let i = 0; i < 3; i++) {
        const z0 = 1.0 - 0.12 * i;
        const h = 0.12 + 0.03 * i;
        list.add(plateZY([[z0, 0.035], [z0 - 0.04, h], [z0 - 0.5, h + 0.04], [z0 - 0.5, 0.035]], (0.42 + 0.07 * i) * kx, 0.012), SATIN, true);
      }
    }
  }
  // diffuser ramp, upswept to the tail; when fine: side walls, vertical strakes that stand proud of a recessed dark exit
  // cavity and a lighter trailing-edge slab, so the rear reads as a tunnelled diffuser instead of one black box
  const dz0 = rz + 0.2;
  const dz1 = rz - (is26 ? 0.4 : 0.65);
  const top = is26 ? 0.24 : 0.3;
  list.add(plateZY([[dz0, 0.035], [dz1, top], [dz1, top + 0.03], [dz0, 0.065]], -0.5 * kx, 1.0 * kx), SATIN);
  if (!fine) return;
  const lip = 0.07;
  list.add(plateZY([[dz0, 0.035], [dz1, top + 0.03], [dz1 - lip, top + 0.03], [dz1 - lip, 0.03]], 0.5 * kx - 0.022, 0.022), SATIN, true);
  for (const x of is26 ? [0.16, 0.32] : [0.12, 0.3]) {
    list.add(plateZY([[dz0, 0.035], [dz1, top], [dz1 - lip, top], [dz1 - lip, 0.03]], x * kx - 0.011, 0.022), SATIN, true);
  }
  list.add(new THREE.BoxGeometry(1.0 * kx - 0.04, top - 0.07, 0.01).translate(0, 0.035 + (top - 0.07) / 2, dz1 + 0.05), CARBON);
  list.add(new THREE.BoxGeometry(1.0 * kx - 0.04, 0.012, 0.09).translate(0, 0.035 + (top - 0.07) * 0.55, dz1 - 0.005), SATIN);
  list.add(new THREE.BoxGeometry(1.0 * kx, 0.026, 0.1).translate(0, top + 0.017, dz1 - 0.02), SATIN);
}

/**
 * Tail: crash structure ending in the rain-light unit (white frame, black lens; the red lamp mesh sits on it) and,
 * when fine, a brake-duct fairing (louvres between cheeks) behind each rear wheel.
 */
export function addRearEnd(list: PartList, d: CarDims, fine: boolean): void {
  const rz = d.rearAxleZ;
  const zEnd = d.rainLightZ + 0.008;
  const zFront = rz - 0.33;
  list.add(new THREE.BoxGeometry(0.2, 0.16, zFront - zEnd).translate(0, 0.34, (zFront + zEnd) / 2), SATIN);
  list.add(new THREE.BoxGeometry(0.14, 0.078, 0.016).translate(0, d.rainLightY, d.rainLightZ), WHITE);
  list.add(new THREE.BoxGeometry(0.1, 0.05, 0.02).translate(0, d.rainLightY, d.rainLightZ), BLACK);
  if (!fine) return;
  const x = d.rearHalfTrack - d.rearTyreWidth / 2 - 0.08;
  const zc = rz - 0.23;
  for (const y of [0.2, 0.27, 0.34]) list.add(new THREE.BoxGeometry(0.13, 0.012, 0.14).translate(x, y, zc), CARBON, true);
  for (const dx of [-0.065, 0.065]) list.add(new THREE.BoxGeometry(0.012, 0.2, 0.14).translate(x + dx, 0.27, zc), SATIN, true);
}

/**
 * Suspension (mirrored): aero-faired wishbones, then (when `full`) push / pull rods and track rods, then
 * driveshafts. Outboard ends sit on the brake drum behind each wheel. `radial` = section segments.
 */
export function addSuspension(list: PartList, d: CarDims, full: boolean, radial: number): void {
  const fz = d.frontAxleZ;
  const rz = d.rearAxleZ;
  const r = 0.014;
  const arm = (a: THREE.Vector3, b: THREE.Vector3): void => list.add(blade(a, b, 0.055, 0.016, radial), CARBON, true);
  const hx = d.frontHalfTrack - d.frontTyreWidth / 2 - 0.09;
  const links: [THREE.Vector3, THREE.Vector3][] = [
    [v3(0.12, 0.38, fz + 0.25), v3(hx, 0.48, fz + 0.02)],
    [v3(0.18, 0.47, fz - 0.3), v3(hx, 0.48, fz - 0.02)],
    [v3(0.12, 0.22, fz + 0.3), v3(hx, 0.2, fz + 0.02)],
    [v3(0.19, 0.22, fz - 0.34), v3(hx, 0.2, fz - 0.02)],
  ];
  for (const [a, b] of links) arm(a, b);
  if (full) {
    // push rod and track rod
    list.add(rod(v3(hx - 0.01, 0.22, fz), v3(0.18, 0.47, fz - 0.08), r, radial), CARBON, true);
    arm(v3(0.15, 0.32, fz + 0.12), v3(hx, 0.34, fz + 0.12));
  }
  const rx = d.rearHalfTrack - d.rearTyreWidth / 2 - 0.09;
  const rear: [THREE.Vector3, THREE.Vector3][] = [
    [v3(0.14, 0.48, rz + 0.25), v3(rx, 0.5, rz + 0.02)],
    [v3(0.14, 0.46, rz - 0.25), v3(rx, 0.5, rz - 0.02)],
    [v3(0.14, 0.2, rz + 0.3), v3(rx, 0.18, rz)],
    [v3(0.14, 0.2, rz - 0.25), v3(rx, 0.18, rz)],
  ];
  for (const [a, b] of rear) arm(a, b);
  if (full) list.add(rod(v3(rx - 0.01, 0.48, rz), v3(0.14, 0.24, rz + 0.1), r, radial), CARBON, true);
  list.add(rod(v3(0.1, d.rearWheelRadius, rz), v3(rx, d.rearWheelRadius, rz), 0.024, radial), { kind: 'swatch', name: 'metal' }, true);
}

/**
 * Wheel aero (LOD0): 2025 over-tyre brake-duct deflector winglets above each front wheel; 2026 prescribed front
 * wheel bodywork (fairing behind the tyre) and in-washing boards ahead of the floor.
 */
export function addWheelAero(list: PartList, d: CarDims): void {
  const fz = d.frontAxleZ;
  const kx = d.width / 2.0;
  const inner = d.frontHalfTrack - d.frontTyreWidth / 2;
  if (d.regulation === '2026') {
    list.add(plateZY([[fz + 0.3, 0.12], [fz + 0.2, 0.48], [fz - 0.26, 0.48], [fz - 0.4, 0.12]], inner - 0.026, 0.014), CARBON, true);
    list.add(tiltedPlate([[1.15, 0], [1.15, 0.17], [0.8, 0.2], [0.8, 0]], 0.5 * kx, 0.035, 0.12, 0.012), SATIN, true);
    return;
  }
  for (let k = 0; k < 3; k++) {
    list.add(airfoil(inner - 0.24, inner - 0.04, 0.55 + 0.04 * k, fz + 0.1 - 0.015 * k, 0.12, 0.08, 0.12 + 0.18 * k, 0.03, 6), CARBON, true);
  }
  list.add(plateZY([[fz + 0.1, 0.5], [fz + 0.1, 0.66], [fz - 0.04, 0.66], [fz - 0.04, 0.5]], inner - 0.043, 0.012), CARBON, true);
}

/** Halo hoop + centre pillar tubes. */
export function addHalo(list: PartList, hoopSegments: number, pillarSegments: number, radial: number): void {
  const hoop = new THREE.CatmullRomCurve3([
    v3(0.3, 0.66, -0.3),
    v3(0.31, 0.82, -0.24),
    v3(0.29, 0.885, -0.02),
    v3(0.2, 0.9, 0.24),
    v3(0, 0.905, 0.38),
    v3(-0.2, 0.9, 0.24),
    v3(-0.29, 0.885, -0.02),
    v3(-0.31, 0.82, -0.24),
    v3(-0.3, 0.66, -0.3),
  ]);
  list.add(new THREE.TubeGeometry(hoop, hoopSegments, 0.028, radial, false), HALO);
  const pillar = new THREE.CatmullRomCurve3([v3(0, 0.905, 0.38), v3(0, 0.865, 0.5), v3(0, 0.77, 0.58), v3(0, 0.68, 0.63)]);
  list.add(new THREE.TubeGeometry(pillar, pillarSegments, 0.03, radial, false), HALO);
}

/** Small shark fin (livery panel): rises out of the airbox and tapers into the cover; no T-wing (banned since 2022). */
export function addFin(list: PartList, d: CarDims, st: BodyStations): void {
  const z0 = d.finZ0;
  const z1 = d.finZ1;
  const rz = d.rearAxleZ;
  const bottom = (z: number): number => coverTop(st.cover, z) - 0.03;
  list.add(
    plateZY(
      [
        [z1, d.finY1 - 0.04],
        [-1.3, d.finY1 - 0.12],
        [-1.7, d.finY1 - 0.34],
        [z0 + 0.1, bottom(z0) + 0.1],
        [z0, bottom(z0) + 0.02],
        [rz - 0.05, bottom(rz - 0.05)],
        [-1.45, bottom(-1.45)],
        [-1.0, bottom(-1.0)],
        [z1, bottom(z1)],
      ],
      -0.006,
      0.012,
    ),
    { kind: 'fin' },
  );
}

/** Rounded rear-wing endplate outline (z, y): integrated swept shape instead of a square plate. */
function rearEndplate(d: CarDims, is26: boolean, fine: boolean): [number, number][] {
  const z1 = d.rearWingZ1;
  const z0 = d.rearWingZ0;
  const bottom = is26 ? 0.52 : 0.38;
  const top = 1.045;
  const na = fine ? 4 : 2;
  return [
    [z1, bottom],
    ...arcPoints(z1 - 0.08, top - 0.08, 0.08, 0, Math.PI / 2, na),
    ...arcPoints(z0 + 0.1, top - 0.1, 0.1, Math.PI / 2, Math.PI, na),
    ...quadCurve([z0, 0.66], [z0 + 0.12, bottom], [z1 - 0.18, bottom], fine ? 4 : 2),
  ];
}

/**
 * Rear wing: rounded endplates, mainplane, swan-neck pylon, and (2025 only) a two-element beam wing
 * (one element when not `fine`).
 */
export function addRearWing(list: PartList, d: CarDims, is26: boolean, foil: number, fine: boolean): void {
  const rs = d.rearWingHalfSpan;
  const z1 = d.rearWingZ1;
  list.add(plateZY(rearEndplate(d, is26, fine), rs, 0.02), REAR_WING, true);
  list.add(airfoil(-rs, rs, 0.8, z1 - 0.04, 0.3, 0.1, 0.22, 0.06, foil), CARBON);
  if (!is26) {
    const bw = rs - 0.03;
    list.add(airfoil(-bw, bw, 0.4, z1 - 0.06, 0.17, 0.1, 0.12, 0.04, foil), SATIN);
    if (fine) list.add(airfoil(-bw, bw, 0.5, z1 - 0.15, 0.13, 0.1, 0.35, 0.04, foil), SATIN);
  }
  // swan-neck pylon: leans forward from the crash structure, then curves back under the mainplane
  const n = fine ? 5 : 2;
  const spine = quadCurve([z1 + 0.04, 0.38], [z1 + 0.04, 0.78], [z1 - 0.14, 0.79], n);
  const pylon: [number, number][] = [
    ...spine.map(([z, y]) => [z + 0.02, y] as [number, number]),
    ...[...spine].reverse().map(([z, y]) => [z - 0.025, y - 0.012] as [number, number]),
  ];
  list.add(plateZY(pylon, -0.01, 0.02), CARBON);
}

/** Rear DRS / active flap: pivot-local, or (`closedInPlace`) rotated closed and moved to its pivot. */
export function addRearFlap(list: PartList, d: CarDims, foil: number, closedInPlace: boolean): void {
  const rs = d.rearWingHalfSpan;
  const g = airfoil(-rs + 0.005, rs - 0.005, 0, 0, 0.22, 0.09, 0, 0.05, foil);
  if (closedInPlace) {
    const p = rearFlapPivotOf(d);
    g.rotateX(REAR_FLAP_CLOSED).translate(p.x, p.y, p.z);
  }
  list.add(g, REAR_FLAP);
}

/** Wing element split into spanwise pieces whose height and pitch rise towards the endplates (curved look). */
function curvedElement(
  list: PartList,
  x0: number,
  x1: number,
  breaks: readonly number[],
  y: number,
  zLead: number,
  chord: number,
  pitch: number,
  map: UVMap,
  foil: number,
): void {
  const cuts = [x0, ...breaks.filter((b) => b > x0 + 0.02 && b < x1 - 0.02), x1].sort((a, b) => a - b);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const e = smooth((Math.abs(cuts[i] + cuts[i + 1]) / 2 - 0.35) / 0.55);
    list.add(airfoil(cuts[i], cuts[i + 1], y + 0.03 * e, zLead, chord, 0.1, pitch + 0.1 * e, 0.04, foil), map);
  }
}

/** One front endplate built for the left (+X) side at x: plate, outboard curl, footplate. */
function frontEndplateParts(d: CarDims, fs: number, fine: boolean): [() => THREE.BufferGeometry, UVMap][] {
  const z1 = d.frontWingZ1;
  const z0 = d.frontWingZ0;
  const plate: [number, number][] = [[z1, 0.03], [z1, 0.17], [z1 - 0.1, 0.27], [z1 - 0.3, 0.3], [z0 + 0.12, 0.3], [z0, 0.22], [z0, 0.03]];
  const parts: [() => THREE.BufferGeometry, UVMap][] = [
    [() => plateZY(plate, fs, 0.02), FRONT_WING],
    // upper edge curls outboard
    [() => tiltedPlate([[z1 - 0.16, 0], [z1 - 0.3, 0.06], [z0 + 0.12, 0.06], [z0 + 0.04, 0]], fs + 0.005, 0.292, 0.7, 0.008), FRONT_WING],
    [() => new THREE.BoxGeometry(0.05, 0.012, z1 - z0 - 0.04).translate(fs + 0.025, 0.036, (z1 + z0) / 2), CARBON],
  ];
  return fine ? parts : [parts[0], parts[2]];
}

/**
 * Front wing: mainplane, fixed flaps (when `includeFlaps`: 3 curved flaps in 2025, 2 in 2026), nose pylons and
 * curled endplates with footplates; damaged = the +X half missing. Without `fine` (LOD1) every element is one piece
 * and 2025 keeps two flaps.
 */
export function addFrontWing(list: PartList, d: CarDims, damaged: boolean, includeFlaps: boolean, foil: number, fine = true): void {
  const is26 = d.regulation === '2026';
  const { fs, fwz } = frontWingSpan(d);
  const mainX1 = damaged ? 0.3 : fs;
  const mainBreaks = fine ? [-0.4, 0.4] : [];
  curvedElement(list, -fs, mainX1, mainBreaks, 0.075, fwz, 0.3, 0.08, CARBON, foil);
  if (includeFlaps) {
    const elements: { y: number; dz: number; chord: number; pitch: number; map: UVMap }[] = [
      { y: 0.115, dz: 0.22, chord: 0.2, pitch: 0.32, map: CARBON },
      { y: 0.165, dz: 0.36, chord: 0.17, pitch: 0.55, map: FRONT_WING },
      { y: 0.215, dz: 0.47, chord: 0.13, pitch: 0.75, map: FRONT_WING },
    ];
    const count = fine && !is26 ? 3 : 2;
    const sides: [number, number][] = damaged ? [[-fs, -0.22], [0.22, 0.4]] : [[-fs, -0.22], [0.22, fs]];
    const breaks = fine ? [-0.62, 0.62] : [];
    sides.forEach(([x0, x1], i) => {
      elements.slice(0, count).forEach((el, k) => {
        if (damaged && i === 1 && k > 0) return;
        curvedElement(list, x0, x1, breaks, el.y, fwz - el.dz, el.chord, el.pitch, el.map, foil);
      });
    });
  }
  // nose pylons (mainplane to nose)
  const tip = d.noseTipZ;
  list.add(plateZY([[tip + 0.01, 0.19], [tip - 0.04, 0.075], [tip - 0.22, 0.075], [tip - 0.26, 0.19]], 0.05, 0.02), CARBON, true);
  for (const [build, map] of frontEndplateParts(d, fs, fine)) addSides(list, build, map, !damaged, true);
}

/** 2026 active-aero front flaps: pivot-local, or (`closedInPlace`) rotated closed and moved to their pivot. */
export function addFrontFlaps(list: PartList, d: CarDims, foil: number, closedInPlace: boolean): void {
  const { fs } = frontWingSpan(d);
  const p = frontFlapPivotOf(d);
  const place = (g: THREE.BufferGeometry): THREE.BufferGeometry => (closedInPlace ? g.rotateX(FRONT_FLAP_CLOSED).translate(p.x, p.y, p.z) : g);
  for (const [x0, x1] of [[-fs, -0.22], [0.22, fs]] as [number, number][]) {
    // flaps in pivot-local space (leading edge of the first flap at the origin)
    list.add(place(airfoil(x0, x1, 0, 0, 0.2, 0.1, 0, 0.04, foil)), CARBON);
    list.add(place(airfoil(x0, x1, 0.05, -0.14, 0.17, 0.1, 0.23, 0.04, foil)), FRONT_WING);
  }
}
