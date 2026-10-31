/**
 * Articulated pit crew bodies (medium quality and up): every person is ten rigid instanced segments (torso, head,
 * 2 × upper arm, forearm + glove, thigh, shin + boot) that pitCrew.ts positions each frame from the joints of
 * pitCrewPose.ts, so a walker swings legs and arms, a kneeling man really kneels and one stance flows into the next.
 * One InstancedMesh per segment type (6 draw calls for the whole garage row, like the three rigid poses they replace);
 * team colour reaches the overalls through the per-vertex tint mask (gloves, boots, helmet and neck keep their own).
 */
import * as THREE from 'three';
import type { QualityLevel } from '../../core/types';
import { smoothstep } from '../../core/math';
import { GeoBuilder, addBox, addGeometry } from '../core/geometry';
import type { Disposer } from '../core/disposer';
import { BONE, SHOULDER, type Joints, type V3 } from './pitCrewPose';
import { patchTintMask } from './sceneryMaterials';

/** Radial segments of the limb cylinders by quality (sphere segments follow). */
export const CREW_RADIAL: Record<QualityLevel, number> = { low: 0, medium: 6, high: 8, ultra: 10 };

/** Segments of a person, in instance-mesh order. Arms and legs have an instance per side (left = even index). */
export const SEGMENTS = ['torso', 'head', 'upperArm', 'foreArm', 'thigh', 'shin'] as const;
export type Segment = (typeof SEGMENTS)[number];
const PAIRED: Record<Segment, boolean> = { torso: false, head: false, upperArm: true, foreArm: true, thigh: true, shin: true };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _e = new THREE.Euler();
const _UP = new THREE.Vector3(0, 1, 0);

/** Builds one segment's geometry; `mask` follows the vertices (1 = takes the team colour). */
class PartBuilder {
  readonly b = new GeoBuilder(true);
  private readonly mask: number[] = [];

  constructor(private readonly radial: number) {}

  add(g: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.ColorRepresentation, mask: number): void {
    const from = this.b.vertexCount;
    this.b.setColor(new THREE.Color(color));
    addGeometry(this.b, g, matrix);
    g.dispose();
    for (let i = from; i < this.b.vertexCount; i++) this.mask.push(mask);
  }

  /** Tapered limb cylinder along +Y from y0 to y1 (open ends: joints, shoulders and the chest cap hide them). */
  tube(r0: number, r1: number, y0: number, y1: number, color: THREE.ColorRepresentation, mask: number, sx = 1, sz = 1, capped = false): void {
    const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, this.radial, 1, !capped);
    this.add(g, _m.compose(_p.set(0, (y0 + y1) / 2, 0), _q.identity(), _sc.set(sx, 1, sz)), color, mask);
  }

  /** Sphere; `fine` = the head-sized resolution of the quality level, else a coarse 6 × 4 (joints, gloves). */
  ball(x: number, y: number, z: number, r: number, color: THREE.ColorRepresentation, mask: number, sx = 1, sy = 1, sz = 1, fine = false): void {
    const g = new THREE.SphereGeometry(r, fine ? this.radial : 6, fine ? Math.max(4, Math.round(this.radial * 0.7)) : 4);
    this.add(g, _m.compose(_p.set(x, y, z), _q.identity(), _sc.set(sx, sy, sz)), color, mask);
  }

  box(x: number, y: number, z: number, w: number, h: number, l: number, color: THREE.ColorRepresentation, mask: number): void {
    const from = this.b.vertexCount;
    this.b.setColor(new THREE.Color(color));
    addBox(this.b, x, y, z, 0, w, h, l);
    for (let i = from; i < this.b.vertexCount; i++) this.mask.push(mask);
  }

  build(): THREE.BufferGeometry {
    const g = this.b.build();
    if (!g) throw new Error('render: pit crew rig geometry');
    g.setAttribute('tintMask', new THREE.Float32BufferAttribute(this.mask, 1));
    return g;
  }
}

const TROUSERS = '#8c8c8c';
const WHITE = '#ffffff';
const GLOVE = '#17181b';
const BOOT = '#1c1d20';

/** Geometry of every segment (bone along +Y from the joint, facing +Z). */
export function buildRigGeometry(level: QualityLevel): Record<Segment, THREE.BufferGeometry> {
  const radial = Math.max(5, CREW_RADIAL[level] || 6);
  const mk = (): PartBuilder => new PartBuilder(radial);
  const torso = mk();
  // origin at the pelvis: hips, belly / chest (wider than deep), shoulder caps, neck
  torso.tube(0.15, 0.14, -0.08, 0.12, TROUSERS, 1, 1.15, 0.8);
  torso.tube(0.135, 0.155, 0.1, 0.49, WHITE, 1, 1.3, 0.78, true);
  for (const side of [1, -1]) torso.ball(side * SHOULDER[0], SHOULDER[1], 0, 0.066, WHITE, 1);
  torso.tube(0.05, 0.05, 0.48, 0.6, '#26272b', 0);
  const head = mk();
  head.ball(0, 0, 0, 0.135, '#eceef0', 0, 1, 1.05, 1.08, true);
  head.ball(0, 0.005, 0.085, 0.1, '#14161a', 0, 1, 0.5, 0.75);
  const upper = mk();
  upper.tube(0.052, 0.047, 0, BONE.upperArm, WHITE, 1);
  upper.ball(0, BONE.upperArm, 0, 0.05, WHITE, 1);
  const fore = mk();
  fore.tube(0.047, 0.04, 0, BONE.foreArm - 0.02, WHITE, 1);
  fore.ball(0, BONE.foreArm + 0.04, 0.005, 0.052, GLOVE, 0, 0.95, 1.2, 0.95);
  const thigh = mk();
  thigh.tube(0.085, 0.066, 0, BONE.thigh, TROUSERS, 1);
  thigh.ball(0, BONE.thigh, 0, 0.067, TROUSERS, 1);
  const shin = mk();
  shin.tube(0.065, 0.05, 0, BONE.shin, TROUSERS, 1);
  shin.box(0, BONE.shin + 0.04, 0.065, 0.1, 0.11, 0.27, BOOT, 0);
  return { torso: torso.build(), head: head.build(), upperArm: upper.build(), foreArm: fore.build(), thigh: thigh.build(), shin: shin.build() };
}

/** The instanced segment meshes of all crews. */
export class CrewRig {
  readonly meshes: Record<Segment, THREE.InstancedMesh>;
  private readonly root = new THREE.Matrix4();

  constructor(
    level: QualityLevel,
    people: number,
    disposer: Disposer,
    make: (g: THREE.BufferGeometry, mat: THREE.Material, count: number, name: string) => THREE.InstancedMesh,
  ) {
    const geo = buildRigGeometry(level);
    const mat = disposer.add(new THREE.MeshStandardMaterial({ name: 'crew-rig', vertexColors: true, roughness: 0.75, metalness: 0.03 }));
    patchTintMask(mat);
    const out = {} as Record<Segment, THREE.InstancedMesh>;
    for (const seg of SEGMENTS) out[seg] = make(geo[seg], mat, people * (PAIRED[seg] ? 2 : 1), `crewRig-${seg}`);
    this.meshes = out;
  }

  /** Team colour of person `i` (all its segments). */
  setColor(i: number, color: THREE.Color): void {
    for (const seg of SEGMENTS) {
      const mesh = this.meshes[seg];
      if (PAIRED[seg]) {
        mesh.setColorAt(i * 2, color);
        mesh.setColorAt(i * 2 + 1, color);
      } else mesh.setColorAt(i, color);
    }
  }

  setCount(people: number): void {
    for (const seg of SEGMENTS) this.meshes[seg].count = people * (PAIRED[seg] ? 2 : 1);
  }

  markDirty(): void {
    for (const seg of SEGMENTS) {
      const mesh = this.meshes[seg];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Person-to-world transform for the segments written next (position, yaw, uniform scale). */
  beginPerson(x: number, y: number, z: number, yaw: number, scale: number): THREE.Matrix4 {
    return this.root.compose(_p.set(x, y, z), _q.setFromAxisAngle(_UP, yaw), _sc.set(scale, scale, scale));
  }

  /** Write all ten segments of person `i` from its joints (person frame → world through the matrix of beginPerson). */
  writePerson(i: number, j: Joints): void {
    const { torso, head } = this.meshes;
    _e.set(j.lean, 0, j.roll, 'XYZ');
    _m.makeRotationFromEuler(_e).setPosition(j.pelvis[0], j.pelvis[1], j.pelvis[2]);
    torso.setMatrixAt(i, _m.premultiply(this.root));
    _e.set(j.lean + j.headPitch, j.headYaw, j.roll * 0.5, 'YXZ');
    _m.makeRotationFromEuler(_e).setPosition(j.head[0], j.head[1], j.head[2]);
    head.setMatrixAt(i, _m.premultiply(this.root));
    for (let s = 0; s < 2; s++) {
      this.limb(this.meshes.upperArm, i * 2 + s, j.shoulder[s], j.elbow[s]);
      this.limb(this.meshes.foreArm, i * 2 + s, j.elbow[s], j.wrist[s]);
      this.limb(this.meshes.thigh, i * 2 + s, j.hip[s], j.knee[s]);
      this.limb(this.meshes.shin, i * 2 + s, j.knee[s], j.ankle[s]);
    }
  }

  /** Segment with its +Y along a → b; +Z kept as close to the person's forward as the bone allows (foot direction). */
  private limb(mesh: THREE.InstancedMesh, index: number, a: V3, b: V3): void {
    let yx = b[0] - a[0];
    let yy = b[1] - a[1];
    let yz = b[2] - a[2];
    const len = Math.hypot(yx, yy, yz) || 1;
    yx /= len;
    yy /= len;
    yz /= len;
    // a bone lying along ±Z (the kneeling shin) points its foot down instead
    const w = smoothstep(0.5, 0.95, Math.abs(yz));
    const hy = -w;
    const hz = 1 - w;
    const d = hy * yy + hz * yz;
    let zx = -yx * d;
    let zy = hy - yy * d;
    let zz = hz - yz * d;
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl;
    zy /= zl;
    zz /= zl;
    // x = y × z
    const xx = yy * zz - yz * zy;
    const xy = yz * zx - yx * zz;
    const xz = yx * zy - yy * zx;
    _m.set(xx, yx, zx, a[0], xy, yy, zy, a[1], xz, yz, zz, a[2], 0, 0, 0, 1);
    mesh.setMatrixAt(index, _m.premultiply(this.root));
  }
}
