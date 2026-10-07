/**
 * Procedural open-wheel race car geometry (shared by every car of one regulation). Builds the merged
 * static body (monocoque + nose, engine cover, airbox, sidepods with undercut, floor + edges, diffuser,
 * faired suspension, wheel aero, halo, driver, mirrors, rear wing, fin, crash structure), the front wing (intact + damaged),
 * movable flaps, wheels, steering wheel, brake-glow rings and the rain light, plus the simplified LOD1 / LOD2
 * sets (carLodGeometry; shared numbers live in sharedParts). Geometry is cached per regulation with reference
 * counting (acquireCarGeometry / releaseCarGeometry).
 */
import * as THREE from 'three';
import type { Regulation } from '../../core/types';
import { buildCarLod1, buildCarLod2, type CarLodGeometry } from './carLodGeometry';
import { carDims, type CarDims } from './dims';
import { PartList } from './parts';
import { loft, mergeNonIndexed, revolve, rod, type RevolveStrip } from './shapes';
import {
  addPodInlet,
  addWheelAero,
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
  carBodyStations,
  frontFlapPivotOf,
  rearFlapPivotOf,
  FRONT_FLAP_CLOSED,
  FRONT_FLAP_OPEN,
  REAR_FLAP_CLOSED,
  REAR_FLAP_OPEN,
  WHEEL_UV,
} from './sharedParts';

export { WHEEL_KEYS, WHEEL_UV } from './sharedParts';

export interface CarGeometrySet {
  dims: CarDims;
  body: THREE.BufferGeometry;
  frontWing: THREE.BufferGeometry;
  frontWingDamaged: THREE.BufferGeometry;
  /** 2026 only: active-aero front flaps (pivot at frontFlapPivot) */
  frontFlap: THREE.BufferGeometry | null;
  frontFlapPivot: THREE.Vector3;
  rearFlap: THREE.BufferGeometry;
  rearFlapPivot: THREE.Vector3;
  /** flap rotation.x when closed / open (rad) */
  rearFlapClosed: number;
  rearFlapOpen: number;
  frontFlapClosed: number;
  frontFlapOpen: number;
  wheelFront: THREE.BufferGeometry;
  wheelRear: THREE.BufferGeometry;
  glowFront: THREE.BufferGeometry;
  glowRear: THREE.BufferGeometry;
  steeringWheel: THREE.BufferGeometry;
  steeringPivot: THREE.Vector3;
  steeringTilt: number;
  rainLight: THREE.BufferGeometry;
  /** LOD1 (simplified body, flaps merged closed, low-segment wheels) */
  lod1: CarLodGeometry;
  /** LOD2: single low-poly silhouette in the livery colours */
  lod2: THREE.BufferGeometry;
}

const cache = new Map<Regulation, { set: CarGeometrySet; refs: number }>();

export function acquireCarGeometry(regulation: Regulation): CarGeometrySet {
  const hit = cache.get(regulation);
  if (hit) {
    hit.refs++;
    return hit.set;
  }
  const set = buildCarGeometry(regulation);
  cache.set(regulation, { set, refs: 1 });
  return set;
}

export function releaseCarGeometry(regulation: Regulation): void {
  const hit = cache.get(regulation);
  if (!hit) return;
  hit.refs--;
  if (hit.refs > 0) return;
  cache.delete(regulation);
  const s = hit.set;
  const l1 = s.lod1;
  for (const g of [s.body, s.frontWing, s.frontWingDamaged, s.frontFlap, s.rearFlap, s.wheelFront, s.wheelRear, s.glowFront, s.glowRear, s.steeringWheel, s.rainLight]) {
    g?.dispose();
  }
  for (const g of [l1.body, l1.frontWing, l1.frontWingDamaged, l1.wheelFront, l1.wheelRear, s.lod2]) g.dispose();
}

const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

export function buildCarGeometry(regulation: Regulation): CarGeometrySet {
  const d = carDims(regulation);
  const is26 = regulation === '2026';
  const rz = d.rearAxleZ;
  const kx = d.width / 2.0;
  const body = new PartList(d);

  // ── monocoque + nose (open cockpit U-section) ──
  const st = carBodyStations(d);
  const { mono, cover } = st;
  // one shared axis for every wrapped part so the paint lines up where parts meet
  const wrap = bodyWrap(d, st);
  body.add(loft(mono, { segments: 40, cutHalfWidth: 0.25, cutSegments: 10, capStart: true, capEnd: true }), wrap);

  // ── engine cover ──
  body.add(loft(cover, { segments: 36, capStart: true, capEnd: true }), wrap);

  // ── airbox / roll hoop above the driver (front is the intake) ──
  body.add(loft(st.airbox, { segments: 28, capStart: true, capEnd: false }), wrap);
  {
    const intake = new THREE.CircleGeometry(1, 20);
    intake.scale(0.105, 0.11, 1);
    intake.translate(0, 0.9, -0.41);
    body.add(intake, { kind: 'swatch', name: 'black' });
  }

  // ── sidepods with undercut (left built, mirrored to the right) + slanted mirrored inlet ──
  body.add(loft(st.pod, { segments: 32, capStart: true, capEnd: false }), wrap, true);
  addPodInlet(body, st, true);

  // ── floor, edges, diffuser ──
  addFloor(body, d, true);

  // ── gearbox + rear crash structure + exhaust + rain light housing ──
  body.add(new THREE.BoxGeometry(0.22, 0.22, 0.7).translate(0, 0.3, rz - 0.1), { kind: 'swatch', name: 'carbon' });
  addRearEnd(body, d, true);
  body.add(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 10).rotateX(Math.PI / 2).translate(0, 0.47, rz - 0.42), { kind: 'swatch', name: 'black' });

  // ── suspension: wishbones, push / pull rods, track rods, driveshafts ──
  addSuspension(body, d, true, 6);
  addWheelAero(body, d);

  // ── halo + centre pillar, pitot on the halo apex ──
  addHalo(body, 64, 16, 8);
  body.add(rod(v3(0, 0.91, 0.37), v3(0, 0.92, 0.52), 0.006, 5), { kind: 'swatch', name: 'metal' });

  // ── airbox: camera pod on the top, radio antenna behind ──
  body.add(new THREE.BoxGeometry(0.085, 0.05, 0.12).translate(0, 0.985, -0.78), { kind: 'swatch', name: 'carbon' });
  body.add(new THREE.BoxGeometry(0.04, 0.025, 0.01).translate(0, 0.985, -0.84), { kind: 'swatch', name: 'black' });
  body.add(rod(v3(0, 0.74, -1.38), v3(0, 0.88, -1.43), 0.005, 4), { kind: 'swatch', name: 'black' });

  // ── driver: helmet, visor, shoulders, neck, headrest; steering column ──
  {
    const hc = v3(0, d.helmetY, d.helmetZ);
    body.add(new THREE.SphereGeometry(d.helmetR, 24, 16).translate(hc.x, hc.y, hc.z), { kind: 'helmet', centre: hc });
    const visor = new THREE.SphereGeometry(d.helmetR * 1.018, 20, 6, Math.PI / 2 - 0.85, 1.7, 1.28, 0.42);
    visor.translate(hc.x, hc.y, hc.z);
    body.add(visor, { kind: 'swatch', name: 'visor' });
    const shoulders = new THREE.CapsuleGeometry(0.075, 0.22, 4, 10);
    shoulders.rotateZ(Math.PI / 2);
    shoulders.translate(0, 0.56, d.helmetZ - 0.02);
    body.add(shoulders, { kind: 'swatch', name: 'primary' });
    body.add(new THREE.CylinderGeometry(0.05, 0.055, 0.14, 10).translate(0, 0.64, d.helmetZ), { kind: 'swatch', name: 'black' });
    body.add(new THREE.BoxGeometry(0.46, 0.1, 0.08).translate(0, 0.665, d.cockpitZ0 + 0.02), { kind: 'swatch', name: 'black' });
    // headrest side pads + cockpit rim
    body.add(new THREE.BoxGeometry(0.06, 0.16, 0.2).translate(0.185, 0.74, d.helmetZ - 0.02), { kind: 'swatch', name: 'black' }, true);
    body.add(new THREE.BoxGeometry(0.035, 0.03, d.cockpitZ1 - d.cockpitZ0).translate(0.262, 0.678, (d.cockpitZ0 + d.cockpitZ1) / 2), { kind: 'swatch', name: 'carbon' }, true);
    body.add(new THREE.BoxGeometry(0.5, 0.03, 0.04).translate(0, 0.688, d.cockpitZ1), { kind: 'swatch', name: 'carbon' });
    body.add(rod(v3(0, 0.56, d.cockpitZ1 + 0.02), v3(0, d.wheelHubY - 0.02, d.wheelHubZ + 0.04), 0.018), { kind: 'swatch', name: 'carbon' });
  }

  // ── mirrors: oval housing on two stalks above the sidepod front ──
  {
    const housing = new THREE.SphereGeometry(1, 10, 6);
    housing.scale(0.09, 0.034, 0.026).translate(0.52 * kx, 0.76, 0.6);
    body.add(housing, { kind: 'swatch', name: 'primary' }, true);
    // mirror glass: the dark glossy visor swatch (reflects the sky) instead of flat grey metal
    body.add(new THREE.BoxGeometry(0.13, 0.045, 0.006).translate(0.52 * kx, 0.76, 0.572), { kind: 'swatch', name: 'visor' }, true);
    body.add(rod(v3(0.32, 0.66, 0.64), v3(0.46 * kx, 0.75, 0.61), 0.01, 5), { kind: 'swatch', name: 'carbon' }, true);
    body.add(rod(v3(0.34, 0.64, 0.7), v3(0.5 * kx, 0.745, 0.62), 0.008, 5), { kind: 'swatch', name: 'carbon' }, true);
  }

  // ── shark fin + T-wing ──
  addFin(body, d, st);

  // ── rear wing: rounded endplates, mainplane, beam wing (2025), swan-neck pylon ──
  addRearWing(body, d, is26, 10, true);

  // ── front wing (intact / damaged) + 2026 active flaps ──
  const frontFlapPivot = frontFlapPivotOf(d);
  const buildFrontWing = (damaged: boolean, includeFlaps: boolean): THREE.BufferGeometry => {
    const w = new PartList(d);
    addFrontWing(w, d, damaged, includeFlaps, 8);
    return w.build();
  };
  const frontWing = buildFrontWing(false, !is26);
  const frontWingDamaged = buildFrontWing(true, true);
  let frontFlap: THREE.BufferGeometry | null = null;
  if (is26) {
    const f = new PartList(d);
    addFrontFlaps(f, d, 8, false);
    frontFlap = f.build();
  }

  // ── rear DRS / active flap (pivot-local, chord towards -Z) ──
  const rearFlapPivot = rearFlapPivotOf(d);
  const rf = new PartList(d);
  addRearFlap(rf, d, 10, false);
  const rearFlap = rf.build();

  // ── steering wheel (local: face towards -Z, column along +Z) ──
  const sw = new PartList(d);
  {
    const shape = new THREE.Shape();
    const w = 0.13;
    const h = 0.065;
    const r = 0.028;
    shape.moveTo(-w + r, -h);
    shape.lineTo(w - r, -h);
    shape.quadraticCurveTo(w, -h, w, -h + r);
    shape.lineTo(w, h - r);
    shape.quadraticCurveTo(w, h, w - r, h);
    shape.lineTo(-w + r, h);
    shape.quadraticCurveTo(-w, h, -w, h - r);
    shape.lineTo(-w, -h + r);
    shape.quadraticCurveTo(-w, -h, -w + r, -h);
    const plate = new THREE.ExtrudeGeometry(shape, { depth: 0.022, bevelEnabled: false, curveSegments: 4 });
    plate.translate(0, 0, -0.011);
    sw.add(plate, { kind: 'swatch', name: 'carbon' });
    for (const x of [-0.118, 0.118]) {
      sw.add(new THREE.CapsuleGeometry(0.024, 0.07, 3, 8).translate(x, -0.005, -0.012), { kind: 'swatch', name: 'black' });
    }
    sw.add(new THREE.BoxGeometry(0.085, 0.045, 0.006).translate(0, 0.012, -0.014), { kind: 'swatch', name: 'visor' });
    for (let i = 0; i < 9; i++) {
      const name = i < 3 ? 'secondary' : i < 6 ? 'accent' : 'white';
      sw.add(new THREE.BoxGeometry(0.007, 0.007, 0.004).translate(-0.04 + i * 0.01, 0.048, -0.013), { kind: 'swatch', name });
    }
    for (const [x, y] of [[-0.075, 0.03], [0.075, 0.03], [-0.075, -0.025], [0.075, -0.025]] as [number, number][]) {
      sw.add(new THREE.CylinderGeometry(0.008, 0.008, 0.008, 8).rotateX(Math.PI / 2).translate(x, y, -0.015), { kind: 'swatch', name: 'white' });
    }
  }
  const steeringWheel = sw.build();

  // ── wheels & glow rings ──
  const wheelFront = buildWheel(d, d.frontTyreWidth, d.frontWheelRadius);
  const wheelRear = buildWheel(d, d.rearTyreWidth, d.rearWheelRadius);
  const glowFront = buildGlow(d.frontTyreWidth);
  const glowRear = buildGlow(d.rearTyreWidth);

  // rain light; 2026 adds two more rear lights (rear-wing endplates) and two lateral safety lights (tail sides)
  const rainParts = [new THREE.BoxGeometry(0.085, 0.036, 0.01).translate(0, d.rainLightY, d.rainLightZ - 0.012)];
  if (is26) {
    const rs = d.rearWingHalfSpan;
    for (const sx of [1, -1]) {
      rainParts.push(new THREE.BoxGeometry(0.022, 0.1, 0.01).translate(sx * (rs + 0.01), 0.8, d.rearWingZ0 - 0.004));
      rainParts.push(new THREE.BoxGeometry(0.01, 0.04, 0.07).translate(sx * 0.13, 0.45, rz - 0.12));
    }
  }
  const rainLight = rainParts.length > 1 ? mergeNonIndexed(rainParts) : (rainParts[0] as THREE.BufferGeometry);

  return {
    dims: d,
    body: body.build(),
    frontWing,
    frontWingDamaged,
    frontFlap,
    frontFlapPivot,
    rearFlap,
    rearFlapPivot,
    rearFlapClosed: REAR_FLAP_CLOSED,
    rearFlapOpen: REAR_FLAP_OPEN,
    frontFlapClosed: FRONT_FLAP_CLOSED,
    frontFlapOpen: FRONT_FLAP_OPEN,
    wheelFront,
    wheelRear,
    glowFront,
    glowRear,
    steeringWheel,
    steeringPivot: v3(0, d.wheelHubY, d.wheelHubZ),
    steeringTilt: 0.35,
    rainLight,
    lod1: buildCarLod1(d, st),
    lod2: buildCarLod2(d, st),
  };
}

/**
 * 18" tyre (low-profile sidewall with the compound band) + rim lip + rim cover, and a brake-duct drum behind it, built
 * around the local X axle; the outer (cover) face points +X. UVs index the 4-column per-compound wheel atlas
 * (rubber / compound band / rim / nut). The drum is axisymmetric, so it can live in the spinning wheel mesh.
 */
function buildWheel(d: CarDims, width: number, R: number): THREE.BufferGeometry {
  const hw = width / 2;
  const sh = 0.03;
  const rimR = 0.2286;
  const bandOut = R - 0.05;
  const bandIn = R - 0.07;
  const strips: RevolveStrip[] = [];
  const pt = (r: number, a: number, nr: number, na: number): { r: number; a: number; nr: number; na: number } => ({ r, a, nr, na });
  // tread
  strips.push({ key: 'rubber', points: [pt(R, -hw + sh, 1, 0), pt(R, hw - sh, 1, 0)] });
  // shoulders (quarter rounds)
  for (const side of [1, -1]) {
    const pts: { r: number; a: number; nr: number; na: number }[] = [];
    for (let i = 0; i <= 3; i++) {
      const t = (i / 3) * (Math.PI / 2);
      pts.push(pt(R - sh + Math.cos(t) * sh, side * (hw - sh + Math.sin(t) * sh), Math.cos(t), side * Math.sin(t)));
    }
    if (side < 0) pts.reverse();
    strips.push({ key: 'rubber', points: pts });
  }
  // sidewalls: rubber / compound band / rubber down to the rim, both faces
  for (const side of [1, -1]) {
    const a = side * hw;
    strips.push({ key: 'rubber', points: [pt(R - sh, a, 0, side), pt(bandOut, a + side * 0.006, 0.15, side)] });
    strips.push({ key: 'band', points: [pt(bandOut, a + side * 0.006, 0.1, side), pt(bandIn, a + side * 0.008, 0, side)] });
    strips.push({ key: 'rubber', points: [pt(bandIn, a + side * 0.008, 0, side), pt(rimR + 0.01, a, -0.15, side)] });
  }
  // outer face: bright rim lip, rim well, dark rim cover with a bolt-circle ring, hub nut
  const cover = hw - 0.06;
  strips.push({ key: 'nut', points: [pt(rimR + 0.01, hw + 0.002, 0, 1), pt(rimR - 0.006, hw + 0.002, 0, 1)] });
  strips.push({ key: 'rim', points: [pt(rimR - 0.006, hw + 0.002, -1, 0), pt(rimR - 0.006, cover, -1, 0)] });
  strips.push({ key: 'rim', points: [pt(rimR - 0.006, cover, 0, 1), pt(0.06, cover, 0, 1)] });
  strips.push({ key: 'nut', points: [pt(0.172, cover + 0.003, 0, 1), pt(0.166, cover + 0.003, 0, 1)] });
  strips.push({ key: 'nut', points: [pt(0.06, cover + 0.012, 0, 1), pt(0.001, cover + 0.012, 0, 1)] });
  strips.push({ key: 'nut', points: [pt(0.06, cover, 1, 0), pt(0.06, cover + 0.012, 1, 0)] });
  // inner face: lip, well and disc, then the brake-duct drum (dark, with a closed end)
  strips.push({ key: 'rim', points: [pt(rimR + 0.01, -hw - 0.002, 0, -1), pt(rimR - 0.006, -hw - 0.002, 0, -1)] });
  strips.push({ key: 'rim', points: [pt(rimR - 0.006, -hw - 0.002, 1, 0), pt(rimR - 0.006, -cover, 1, 0)] });
  strips.push({ key: 'rim', points: [pt(rimR - 0.006, -cover, 0, -1), pt(0.15, -cover, 0, -1)] });
  const drumEnd = -hw - 0.11;
  strips.push({ key: 'rim', points: [pt(0.15, -cover, 1, 0), pt(0.15, drumEnd, 1, 0)] });
  strips.push({ key: 'rim', points: [pt(0.15, drumEnd, 0, -1), pt(0.001, drumEnd, 0, -1)] });
  const { geometry, keys } = revolve(strips, 32);
  const list = new PartList(d);
  list.add(geometry, { kind: 'keyed', keys, uv: WHEEL_UV });
  // five radial markers on the cover so rotation is visible at low speed
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    const g = new THREE.BoxGeometry(0.008, 0.11, 0.022);
    g.translate(0, 0.115, 0);
    g.rotateX(ang);
    g.translate(cover + 0.004, 0, 0);
    const keyAttr = new THREE.Float32BufferAttribute(new Array(g.getAttribute('position').count).fill(0), 1);
    g.setAttribute('key', keyAttr);
    list.add(g, { kind: 'keyed', keys: ['nut'], uv: WHEEL_UV });
  }
  return list.build();
}

/** Brake-glow ring pair (outer + inner face), rendered additively when the discs are hot. */
function buildGlow(width: number): THREE.BufferGeometry {
  const hw = width / 2;
  const a = new THREE.RingGeometry(0.075, 0.2, 28);
  a.rotateY(Math.PI / 2);
  a.translate(hw - 0.054, 0, 0);
  const b = new THREE.RingGeometry(0.075, 0.2, 28);
  b.rotateY(-Math.PI / 2);
  b.translate(-hw + 0.054, 0, 0);
  const g = new THREE.BufferGeometry();
  const ap = a.toNonIndexed();
  const bp = b.toNonIndexed();
  const merge = (name: string, size: number): THREE.BufferAttribute => {
    const x = ap.getAttribute(name).array as Float32Array;
    const y = bp.getAttribute(name).array as Float32Array;
    const out = new Float32Array(x.length + y.length);
    out.set(x, 0);
    out.set(y, x.length);
    return new THREE.BufferAttribute(out, size);
  };
  g.setAttribute('position', merge('position', 3));
  g.setAttribute('normal', merge('normal', 3));
  g.setAttribute('uv', merge('uv', 2));
  for (const x of [a, b, ap, bp]) x.dispose();
  g.computeBoundingSphere();
  return g;
}
