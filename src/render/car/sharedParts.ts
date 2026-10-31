/**
 * Car parts shared by the levels of detail: body loft stations, the livery wrap axis that follows them, flap
 * pivots / angles, wheel atlas UVs, and part builders with a detail parameter (floor, suspension, halo, fin,
 * wings, flaps). LOD0 (carGeometry) and LOD1 (carLodGeometry) build from the same numbers, so silhouettes and
 * paint line up when a car switches level.
 */
import * as THREE from 'three';
import type { CarDims } from './dims';
import { BASE_DESIGN, type CarDesign, type FrontEndplate, type PodInlet } from './designs';
import { reflectX, type PartList, type UVMap } from './parts';
import { airfoil, blade, loft, plateXZ, plateZY, rod, type LoftStation } from './shapes';

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

export function carBodyStations(d: CarDims, design: CarDesign = BASE_DESIGN): BodyStations {
  const fz = d.frontAxleZ;
  const rz = d.rearAxleZ;
  const kx = d.width / 2.0;
  const { nose, pod: P, cover: C } = design;
  // nose: width blends in ahead of the front bulkhead, lift (high nose) from behind the front axle
  const noseW = (z: number): number => 1 + (nose.width - 1) * smooth((z - (fz - 0.5)) / 0.85);
  const noseL = (z: number): number => nose.lift * smooth((z - 0.9) / (fz + 0.35 - 0.9));
  const ns = (z: number, hw: number, yb: number, yt: number, n: number): LoftStation => ({ z, hw: hw * noseW(z), yb: yb + noseL(z), yt: yt + noseL(z), n });
  // sidepod top: level shoulder (downwash 0) → steep ramp (1); pods narrower / wider about a fixed inboard edge
  const top = P.inletTop;
  const dw = P.downwash;
  const tuck = (t: number): number => Math.min(0.85, t * P.undercut);
  const podSt = (z: number, xc: number, hw: number, yb: number, level: number, steep: number, n: number, t = 0): LoftStation => ({
    z,
    xc: (xc + hw * (P.width - 1)) * kx,
    hw: hw * P.width,
    yb,
    yt: level + (steep - level) * dw,
    n,
    tuck: tuck(t),
  });
  const zi = 0.8 + P.inletShift;
  // inlet mouth: oval (D-shape), letterbox (wide low slot over a sloping chin), overbite (upper lip ahead of a
  // receding lower edge) or tall (narrow and deep)
  const mouth = (): LoftStation[] => {
    const shoulder = podSt(0.5 + P.inletShift * 0.6, 0.42, 0.185, 0.22, top, top - 0.03, 3.3, 0.55);
    switch (P.inlet) {
      case 'letterbox':
        return [shoulder, { ...podSt(zi, 0.41, 0.17, top - 0.16, top - 0.03, top - 0.03, 3.8, 0.1), tuck: 0 }];
      case 'overbite':
        return [{ ...shoulder, yb: 0.3 }, { ...podSt(zi + 0.04, 0.41, 0.16, top - 0.2, top - 0.03, top - 0.03, 3.4, 0), tuck: 0 }];
      case 'tall':
        return [shoulder, podSt(zi, 0.4, 0.12, 0.3, top - 0.02, top - 0.02, 3.2, 0.25)];
      default:
        return [shoulder, podSt(zi, 0.41, 0.165, 0.34, top - 0.04, top - 0.04, 3.5, 0.3)];
    }
  };
  const ab = design.airbox;
  return {
    mono: [
      { z: d.cockpitZ0 - 0.02, hw: 0.4, yb: 0.1, yt: 0.7, cut: 0, n: 3 },
      { z: d.cockpitZ0 + 0.02, hw: 0.4, yb: 0.1, yt: 0.7, cut: 0.4, n: 3 },
      { z: 0.0, hw: 0.41, yb: 0.08, yt: 0.7, cut: 0.4, n: 3 },
      { z: 0.3, hw: 0.39, yb: 0.1, yt: 0.7, cut: 0.37, n: 3 },
      { z: d.cockpitZ1 - 0.04, hw: 0.37, yb: 0.12, yt: 0.7, cut: 0.33, n: 3 },
      { z: d.cockpitZ1, hw: 0.36, yb: 0.12, yt: 0.7, cut: 0, n: 3 },
      ns(0.9, 0.32, 0.16, 0.67, 2.8),
      ns(fz - 0.5, 0.26, 0.2, 0.62, 2.6),
      ns(fz - 0.15, 0.2, 0.21, 0.5, 2.5),
      // raised nose that drops onto the front wing pylons (blunt tip, like the 2022+ noses)
      ns(Math.min(fz + 0.35, d.noseTipZ - 0.24), 0.135, 0.2, 0.4, 2.4),
      ns(d.noseTipZ - 0.12, 0.095, 0.17, 0.31, 2.3),
      ns(d.noseTipZ, 0.065, 0.16, 0.26, 2.2),
    ],
    cover: [
      // slim tail between the rear wheels, then the coke-bottle spine widening towards the cockpit; a saddle cooler
      // bulges the shoulders above the power unit
      { z: rz - 0.35, hw: 0.09, yb: 0.2, yt: 0.4, n: 2.4 },
      { z: rz - 0.05, hw: 0.13, yb: 0.17, yt: 0.48, n: 2.4 },
      { z: -1.45, hw: 0.18 + C.saddle * 0.4, yb: 0.14, yt: 0.58 + C.saddle * 0.3, n: 2.4 },
      { z: -1.0, hw: 0.26 + C.saddle * 1.2, yb: 0.11, yt: 0.7 + C.saddle * 0.6, n: 2.5 + C.saddle * 6 },
      { z: -0.6, hw: 0.36 + C.saddle * 0.8, yb: 0.09, yt: 0.78 + C.saddle * 0.3, n: 2.6 + C.saddle * 4 },
      { z: d.cockpitZ0, hw: 0.4, yb: 0.1, yt: 0.72, n: 2.8 },
    ],
    airbox: [
      { z: -1.3, hw: 0.06, yb: 0.62, yt: 0.78, n: 2.6 },
      { z: -0.95, hw: 0.11 * Math.sqrt(ab), yb: 0.68, yt: 0.92, n: 2.8 },
      { z: -0.62, hw: 0.135 * Math.sqrt(ab), yb: 0.72, yt: 0.99, n: 3 },
      { z: -0.4, hw: 0.115 * ab, yb: 1.01 - 0.23 * ab, yt: 1.01, n: 3 },
    ],
    pod: [
      podSt(-1.75, 0.15, 0.07, 0.16, 0.3, 0.24, 2.4),
      podSt(-1.35, 0.22, 0.12, 0.13, 0.4, 0.29, 2.6, 0.2),
      podSt(-0.9, 0.32, 0.17, 0.11, 0.56, 0.38, 2.8, 0.4),
      podSt(-0.4, 0.39, 0.19, 0.11, top, 0.5, 3, 0.55),
      podSt(0.1, 0.42, 0.19, 0.13, top, top - 0.07, 3.1, 0.6),
      ...mouth(),
    ],
  };
}

/** Airbox intake ellipse (radii, centre height) inside the front airbox station. */
export function airboxIntake(st: BodyStations): { rx: number; ry: number; y: number; z: number } {
  const s = st.airbox[st.airbox.length - 1];
  return { rx: s.hw * 0.91, ry: ((s.yt - s.yb) / 2) * 0.95, y: (s.yt + s.yb) / 2, z: s.z - 0.01 };
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
  return new THREE.Vector3(0, 0.88, d.rearWingZ1 - 0.2);
}

/** Pivot of the active-aero front flaps. */
export function frontFlapPivotOf(d: CarDims): THREE.Vector3 {
  return new THREE.Vector3(0, 0.115, frontWingSpan(d).fwz - 0.22);
}

/**
 * Wheel atlas rows (top to bottom) of the per-compound wheel texture: rubber, solid compound band, the 2026 sidewall
 * chequer (compound colour / black squares, tiled around the tyre), rim, nut / lip, brake disc.
 */
export const WHEEL_KEYS = ['rubber', 'band', 'chequer', 'rim', 'nut', 'disc'] as const;
export const WHEEL_ROWS = 8;
/** v range of an atlas row (inset half a texel row so filtering stays inside it) */
export function wheelRowV(row: number): [number, number] {
  const inset = 0.5 / (WHEEL_ROWS * 16);
  return [1 - (row + 1) / WHEEL_ROWS + inset, 1 - row / WHEEL_ROWS - inset];
}
export const WHEEL_UV: Record<string, [number, number]> = Object.fromEntries(
  WHEEL_KEYS.map((k, i) => [k, [0.5, 1 - (i + 0.5) / WHEEL_ROWS] as [number, number]]),
);
/** Sidewall chequer: two rows of squares, the atlas tile (WHEEL_CHEQUER.columns squares) repeated around the tyre. */
export const WHEEL_CHEQUER = { columns: 16, repeats: 8 } as const;

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

/** Mouth rake per inlet type: z shift per metre of height above the mouth centre (overbite: upper lip ahead). */
const POD_RAKE: Record<PodInlet, number> = { oval: 0.12, letterbox: 0.2, overbite: 0.55, tall: 0.15 };

/** Sidepod loft (left side) with the mouth raked back from its upper lip as the design's inlet asks. */
export function podLoft(st: BodyStations, design: CarDesign, segments: number): THREE.BufferGeometry {
  const g = loft(st.pod, { segments, capStart: true, capEnd: false });
  const s = st.pod[st.pod.length - 1];
  const rake = POD_RAKE[design.pod.inlet];
  const yc = (s.yb + s.yt) / 2;
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getZ(i) - s.z) < 1e-6) p.setZ(i, s.z + rake * (p.getY(i) - yc));
  }
  // (normals stay those of the unraked loft: the merged loft is non-indexed, recomputing would facet it)
  return g;
}

/** Sidepod inlet: a slanted D-shaped opening (outboard top corner high, inboard low) just inside the raked pod mouth. */
export function addPodInlet(list: PartList, st: BodyStations, design: CarDesign, fine: boolean): void {
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
  const rake = Math.atan(POD_RAKE[design.pod.inlet]);
  g.scale(1, 1 / Math.cos(rake), 1).rotateX(rake);
  g.translate(s.xc ?? 0, (s.yb + s.yt) / 2, s.z - 0.012);
  list.add(g, BLACK, true);
}

/** Interpolated loft section at z (stations sorted by z, clamped at the ends). */
function sectionAt(stations: readonly LoftStation[], z: number): LoftStation {
  const st = [...stations].sort((a, b) => a.z - b.z);
  if (z <= st[0].z) return st[0];
  for (let i = 1; i < st.length; i++) {
    const p = st[i - 1];
    const q = st[i];
    if (z <= q.z) {
      const t = (z - p.z) / (q.z - p.z);
      const m = (a: number | undefined, b: number | undefined): number => (a ?? 0) + ((b ?? 0) - (a ?? 0)) * t;
      return { z, xc: m(p.xc, q.xc), hw: m(p.hw, q.hw), yb: m(p.yb, q.yb), yt: m(p.yt, q.yt), n: m(p.n ?? 2.6, q.n ?? 2.6) };
    }
  }
  return st[st.length - 1];
}

/** Height of a loft's upper surface at (x, z). */
function loftTop(stations: readonly LoftStation[], x: number, z: number): number {
  const s = sectionAt(stations, z);
  const n = s.n ?? 2.6;
  const u = Math.min(1, Math.abs(x - (s.xc ?? 0)) / s.hw);
  return (s.yb + s.yt) / 2 + ((s.yt - s.yb) / 2) * Math.pow(Math.max(0, 1 - Math.pow(u, n)), 1 / n);
}

/** Sidepod louvre panel: slats (count), their spacing along z, the first slat z, panel spacing across x. */
const POD_LOUVRES = { slats: 5, pitch: 0.07, z0: -0.38, panelGap: 0.075 } as const;

/**
 * Design details on the body (LOD0, mirrored): louvre panels on each sidepod top, and a serrated cooling spine either
 * side of the engine cover running into the fin.
 */
export function addDesignDetails(list: PartList, st: BodyStations, design: CarDesign): void {
  const L = POD_LOUVRES;
  for (let i = 0; i < design.louvres; i++) {
    for (let k = 0; k < L.slats; k++) {
      const z = L.z0 - k * L.pitch;
      const s = sectionAt(st.pod, z);
      const x = (s.xc ?? 0) + (i - (design.louvres - 1) / 2) * L.panelGap;
      const y = loftTop(st.pod, x, z);
      const slope = Math.atan2(loftTop(st.pod, x, z + 0.02) - loftTop(st.pod, x, z - 0.02), 0.04);
      list.add(new THREE.BoxGeometry(0.058, 0.007, 0.024).rotateX(-slope - 0.25).translate(x, y + 0.002, z), BLACK, true);
    }
  }
  if (design.cover.serrated) {
    for (let k = 0; k < 7; k++) {
      const z = -1.08 - k * 0.075;
      const s = sectionAt(st.cover, z);
      const x = s.hw * 0.5;
      const y = loftTop(st.cover, x, z) - 0.006;
      list.add(plateZY([[z + 0.03, y], [z - 0.025, y + 0.026], [z - 0.035, y]], x - 0.003, 0.006), CARBON, true);
    }
  }
}

/**
 * Floor plate, edge fence and diffuser: the flatter, narrower 2026 floor with a plain low edge fence and a smaller
 * diffuser. `fine` adds the small parts (side walls, strakes, exit cavity).
 */
export function addFloor(list: PartList, d: CarDims, fine: boolean): void {
  const fz = d.frontAxleZ;
  const rz = d.rearAxleZ;
  const kx = d.width / 2.0;
  const inset = 0.03;
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
  // plain low edge fence
  list.add(plateZY([[0.6, 0.035], [0.6, 0.075], [-1.2, 0.085], [-1.2, 0.035]], ex, 0.012), SATIN, true);
  // diffuser ramp, upswept to the tail; when fine: side walls, vertical strakes that stand proud of a recessed dark exit
  // cavity and a lighter trailing-edge slab, so the rear reads as a tunnelled diffuser instead of one black box
  const dz0 = rz + 0.2;
  const dz1 = rz - 0.4;
  const top = 0.24;
  list.add(plateZY([[dz0, 0.035], [dz1, top], [dz1, top + 0.03], [dz0, 0.065]], -0.5 * kx, 1.0 * kx), SATIN);
  if (!fine) return;
  const lip = 0.07;
  list.add(plateZY([[dz0, 0.035], [dz1, top + 0.03], [dz1 - lip, top + 0.03], [dz1 - lip, 0.03]], 0.5 * kx - 0.022, 0.022), SATIN, true);
  for (const x of [0.16, 0.32]) {
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

/** In-wash boards ahead of the sidepods: element count, toe-in (rad), length (m), element height / pitch (m). */
const INWASH = { elements: 3, toe: (15 * Math.PI) / 180, length: 0.36, height: 0.04, pitch: 0.065, lead: 1.18 } as const;

/**
 * Wheel aero (LOD0): the prescribed 2026 front wheel bodywork (fairing behind the tyre) and the in-wash boards on the
 * floor ahead of each sidepod: three slotted horizontal elements on a leading strut, toed in 15° to turn the front
 * wheel wake inboard.
 */
export function addWheelAero(list: PartList, d: CarDims): void {
  const fz = d.frontAxleZ;
  const kx = d.width / 2.0;
  const inner = d.frontHalfTrack - d.frontTyreWidth / 2;
  list.add(plateZY([[fz + 0.3, 0.12], [fz + 0.2, 0.48], [fz - 0.26, 0.48], [fz - 0.4, 0.12]], inner - 0.026, 0.014), CARBON, true);
  const W = INWASH;
  const x = 0.5 * kx;
  const place = (g: THREE.BufferGeometry): THREE.BufferGeometry => g.rotateY(W.toe).translate(x, 0, W.lead);
  const top = 0.07 + (W.elements - 1) * W.pitch + W.height;
  list.add(place(plateZY([[0, 0.035], [0, top], [-0.035, top], [-0.035, 0.035]], -0.005, 0.01)), SATIN, true);
  for (let k = 0; k < W.elements; k++) {
    const y = 0.07 + k * W.pitch;
    const rise = 0.012 + k * 0.006;
    list.add(place(plateZY([[0, y], [0, y + W.height], [-W.length, y + W.height + rise], [-W.length, y + rise]], -0.004, 0.008)), CARBON, true);
  }
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
function rearEndplate(d: CarDims, fine: boolean): [number, number][] {
  const z1 = d.rearWingZ1;
  const z0 = d.rearWingZ0;
  const bottom = 0.52;
  const top = 1.045;
  const na = fine ? 4 : 2;
  return [
    [z1, bottom],
    ...arcPoints(z1 - 0.08, top - 0.08, 0.08, 0, Math.PI / 2, na),
    ...arcPoints(z0 + 0.1, top - 0.1, 0.1, Math.PI / 2, Math.PI, na),
    ...quadCurve([z0, 0.66], [z0 + 0.12, bottom], [z1 - 0.18, bottom], fine ? 4 : 2),
  ];
}

/** Rear endplate louvres (LOD0): count, spacing (m), slat chord (m), drop towards the trailing edge (rad). */
const REAR_LOUVRES = { count: 4, pitch: 0.034, chord: 0.15, drop: 0.12 } as const;

/** Rear wing pylons: two swan necks (mandatory double mounts) at ±x, plate thickness. */
const REAR_PYLON = { x: 0.055, thickness: 0.016 } as const;

/**
 * Rear wing (no beam wing under 2026 rules): rounded endplates, mainplane, twin swan-neck pylons; LOD0 adds louvre
 * slats at the top of the endplates, a trailing-edge strip and, on 'swage' designs, the steep upwash crease on the
 * outer face of each endplate. The two flaps (Corner / Straight mode) are the separate rear-flap part.
 */
export function addRearWing(list: PartList, d: CarDims, design: CarDesign, foil: number, fine: boolean): void {
  const rs = d.rearWingHalfSpan;
  const z1 = d.rearWingZ1;
  const z0 = d.rearWingZ0;
  list.add(plateZY(rearEndplate(d, fine), rs, 0.02), REAR_WING, true);
  list.add(airfoil(-rs, rs, 0.8, z1 - 0.04, 0.3, 0.1, 0.22, 0.06, foil), CARBON);
  // swan-neck pylons: lean forward from the crash structure, then curve back over the mainplane
  const n = fine ? 5 : 2;
  const spine = quadCurve([z1 + 0.04, 0.38], [z1 + 0.04, 0.78], [z1 - 0.14, 0.79], n);
  const pylon: [number, number][] = [
    ...spine.map(([z, y]) => [z + 0.02, y] as [number, number]),
    ...[...spine].reverse().map(([z, y]) => [z - 0.025, y - 0.012] as [number, number]),
  ];
  // (LOD1: one centre pylon stands in for the pair)
  if (fine) list.add(plateZY(pylon, REAR_PYLON.x - REAR_PYLON.thickness / 2, REAR_PYLON.thickness), CARBON, true);
  else list.add(plateZY(pylon, -0.01, 0.02), CARBON);
  if (fine) {
    const L = REAR_LOUVRES;
    const x = rs + 0.02 + 0.003;
    for (let i = 0; i < L.count; i++) {
      const y = 0.975 - i * L.pitch;
      list.add(new THREE.BoxGeometry(0.006, 0.008, L.chord).rotateX(-L.drop).translate(x, y, z1 - 0.05 - L.chord / 2), CARBON, true);
    }
    list.add(new THREE.BoxGeometry(0.008, 0.3, 0.012).translate(rs + 0.02 + 0.004, 0.8, z0 + 0.012), CARBON, true);
    if (design.rearEndplate === 'swage') {
      // crease rising steeply towards the trailing edge, from the foot of the plate to under the louvres
      const [za, ya, zb, yb] = [z1 - 0.06, 0.56, z0 + 0.1, 0.9];
      const len = Math.hypot(zb - za, yb - ya);
      list.add(
        new THREE.BoxGeometry(0.008, 0.014, len).rotateX(Math.atan2(yb - ya, za - zb)).translate(x + 0.001, (ya + yb) / 2, (za + zb) / 2),
        CARBON,
        true,
      );
    }
  }
}

/**
 * Rear active flaps: two elements (Corner mode stacked steep behind the mainplane, Straight mode laid flat) on one
 * pivot, with the actuator pod on the top flap; pivot-local. `closedInPlace` (LOD1): one element of the pair's
 * chord, rotated closed and moved to its pivot.
 */
export function addRearFlap(list: PartList, d: CarDims, foil: number, closedInPlace: boolean): void {
  const rs = d.rearWingHalfSpan;
  if (closedInPlace) {
    const p = rearFlapPivotOf(d);
    list.add(airfoil(-rs + 0.005, rs - 0.005, 0, 0, 0.24, 0.09, 0.1, 0.06, foil).rotateX(REAR_FLAP_CLOSED).translate(p.x, p.y, p.z), REAR_FLAP);
    return;
  }
  list.add(airfoil(-rs + 0.005, rs - 0.005, 0, 0, 0.14, 0.09, 0, 0.05, foil), REAR_FLAP);
  list.add(airfoil(-rs + 0.005, rs - 0.005, 0.015, -0.125, 0.11, 0.09, 0.2, 0.05, foil), REAR_FLAP);
  // actuator pod: a slim bullet fairing on the top flap's centre
  list.add(new THREE.CapsuleGeometry(0.018, 0.08, 3, 8).rotateX(Math.PI / 2 + 0.2).translate(0, 0.042, -0.169), CARBON);
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

/**
 * Front endplate detail (LOD0): outboard dive plane (chord, span out of the plate — no wider than the footplate, so
 * within the car width —, height, pitch) and an inboard fence; 'winglet' endplates carry two stacked, longer planes.
 */
const FRONT_DIVE_PLANE = { chord: 0.16, span: 0.03, y: 0.205, pitch: 0.2 } as const;
const FRONT_WINGLETS = [
  { chord: 0.22, span: 0.03, y: 0.19, pitch: 0.24 },
  { chord: 0.15, span: 0.03, y: 0.25, pitch: 0.34 },
] as const;

/**
 * One front endplate built for the left (+X) side at x: plate, footplate and, per style, the outboard curl ('diveplane'
 * / 'winglet') or a squared plate with a ridged footplate and twin vanes ('squared'); LOD0 adds the planes on the
 * outside and a low fence on the inside.
 */
function frontEndplateParts(d: CarDims, fs: number, style: FrontEndplate, fine: boolean): [() => THREE.BufferGeometry, UVMap][] {
  const z1 = d.frontWingZ1;
  const z0 = d.frontWingZ0;
  const squared = style === 'squared';
  const plate: [number, number][] = squared
    ? [[z1, 0.03], [z1, 0.24], [z1 - 0.05, 0.3], [z0, 0.3], [z0, 0.03]]
    : [[z1, 0.03], [z1, 0.17], [z1 - 0.1, 0.27], [z1 - 0.3, 0.3], [z0 + 0.12, 0.3], [z0, 0.22], [z0, 0.03]];
  const parts: [() => THREE.BufferGeometry, UVMap][] = [
    [() => plateZY(plate, fs, 0.02), FRONT_WING],
    [() => new THREE.BoxGeometry(0.05, 0.012, z1 - z0 - 0.04).translate(fs + 0.025, 0.036, (z1 + z0) / 2), CARBON],
  ];
  if (!fine) return parts;
  if (squared) {
    // ridgeline along the footplate and two small vanes standing on it
    parts.push([() => new THREE.BoxGeometry(0.008, 0.016, z1 - z0 - 0.1).translate(fs + 0.03, 0.05, (z1 + z0) / 2), CARBON]);
    for (const z of [z1 - 0.12, z1 - 0.26]) {
      parts.push([() => plateZY([[z, 0.042], [z - 0.02, 0.1], [z - 0.1, 0.1], [z - 0.11, 0.042]], fs + 0.036, 0.006), CARBON]);
    }
  } else {
    // upper edge curls outboard
    parts.push([() => tiltedPlate([[z1 - 0.16, 0], [z1 - 0.3, 0.06], [z0 + 0.12, 0.06], [z0 + 0.04, 0]], fs + 0.005, 0.292, 0.7, 0.008), FRONT_WING]);
    const planes = style === 'winglet' ? FRONT_WINGLETS : [FRONT_DIVE_PLANE];
    for (const dp of planes) {
      parts.push([() => new THREE.BoxGeometry(dp.span, 0.006, dp.chord).rotateX(dp.pitch).translate(fs + 0.02 + dp.span / 2, dp.y, z1 - 0.06 - dp.chord / 2), CARBON]);
    }
  }
  parts.push([() => plateZY([[z0 + 0.28, 0.04], [z0 + 0.26, 0.15], [z0 + 0.06, 0.13], [z0 + 0.04, 0.04]], fs - 0.01, 0.01), CARBON]);
  return parts;
}

/**
 * Front wing: mainplane, the two flap elements fixed in place (when `includeFlaps`: the damaged wing, which drops its
 * active flaps), nose pylons and the design's endplates with footplates; damaged = the +X half missing. A short nose
 * rests on a fixed centre piece of the middle element. Without `fine` (LOD1) every element is one piece.
 */
export function addFrontWing(list: PartList, d: CarDims, design: CarDesign, damaged: boolean, includeFlaps: boolean, foil: number, fine = true): void {
  const { fs, fwz } = frontWingSpan(d);
  const mainX1 = damaged ? 0.3 : fs;
  const mainBreaks = fine ? [-0.4, 0.4] : [];
  curvedElement(list, -fs, mainX1, mainBreaks, 0.075, fwz, 0.3, 0.08, CARBON, foil);
  if (includeFlaps) {
    const elements: { y: number; dz: number; chord: number; pitch: number; map: UVMap }[] = [
      { y: 0.115, dz: 0.22, chord: 0.2, pitch: 0.32, map: CARBON },
      { y: 0.165, dz: 0.36, chord: 0.17, pitch: 0.55, map: FRONT_WING },
    ];
    const sides: [number, number][] = damaged ? [[-fs, -0.22], [0.22, 0.4]] : [[-fs, -0.22], [0.22, fs]];
    const breaks = fine ? [-0.62, 0.62] : [];
    sides.forEach(([x0, x1], i) => {
      elements.forEach((el, k) => {
        if (damaged && i === 1 && k > 0) return;
        curvedElement(list, x0, x1, breaks, el.y, fwz - el.dz, el.chord, el.pitch, el.map, foil);
      });
    });
  }
  // nose pylons: from the nose down to the mainplane, or (short nose) onto the fixed middle-element centre piece
  const tip = d.noseTipZ;
  const top = 0.19 + design.nose.lift;
  const px = 0.05 * Math.min(1, design.nose.width);
  if (design.nose.tip === 'middle') {
    curvedElement(list, -0.22, 0.22, [], 0.115, fwz - 0.22, 0.2, 0.32, CARBON, foil);
    // (LOD1: the nose simply rests on the centre piece)
    if (fine) list.add(plateZY([[tip + 0.01, top], [tip + 0.01, 0.15], [tip - 0.12, 0.17], [tip - 0.18, top]], px, 0.02), CARBON, true);
  } else {
    list.add(plateZY([[tip + 0.01, top], [tip - 0.04, 0.075], [tip - 0.22, 0.075], [tip - 0.26, top]], px, 0.02), CARBON, true);
  }
  for (const [build, map] of frontEndplateParts(d, fs, design.frontEndplate, fine)) addSides(list, build, map, !damaged, true);
}

/** Active-aero front flaps: pivot-local, or (`closedInPlace`) rotated closed and moved to their pivot. */
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
