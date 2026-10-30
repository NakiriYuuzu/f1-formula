/**
 * Pit crews: 16 mechanics per team box in team-coloured overalls with helmets, gloves and boots (instanced in three
 * poses: standing, kneeling, crouching), with wheel guns, jacks and carried tyres, plus two blanket-wrapped spare
 * tyre stacks by every garage door. Each box follows pitCrewMath: waiting in front of the garage, out to their spots
 * when a team car comes down the pit lane, kneeling / crouching at the wheels while it stands in the box (jacks up,
 * old tyres off, new tyres on, jacks down), stepping back as it pulls away, then walking home.
 *
 * Driven only by the cars' render poses (works for live races, replays and online guests alike) on sim time, so
 * pausing freezes the crews and replay speed scales them. Car → box assignment comes from RaceSceneCar.pitBox
 * (race/world.ts boxSlot); without it any car standing in a box is serviced there.
 */
import * as THREE from 'three';
import type { CarRenderState } from '../../core/types';
import { forwardDistance, poseAt, wrapS } from '../../track/track';
import type { CarDims } from '../car/dims';
import { GeoBuilder, addBox, addGeometry } from '../core/geometry';
import type { SceneryContext } from './context';
import {
  CREW_BOX_ACROSS,
  CREW_BOX_ALONG,
  CREW_CALL_DISTANCE,
  CREW_DEPART_DISTANCE,
  CREW_SLOTS,
  CREW_STOPPED_SPEED,
  crewLift,
  crewTarget,
  gunWobble,
  nextBoxPhase,
  walkBob,
  walkToward,
  type BoxPhase,
  type CrewCarShape,
  type CrewPose,
  type CrewTarget,
} from './pitCrewMath';
import { PIT_BOX_COUNT, PIT_BOX_LATERAL, PIT_BOX_SPACING, PIT_LANE_HALF } from './trackFrame';

/** Crews are drawn (and their instances rebuilt) only while some camera is within this distance (m) of the pit boxes. */
const CREW_VIEW_DISTANCE = 420;
const POSES: readonly CrewPose[] = ['stand', 'kneel', 'crouch'];

type V3 = readonly [number, number, number];

/** Joint positions of one pose (metres, feet at y = 0, facing +Z, +X = the person's left). */
interface Skeleton {
  pelvis: V3;
  chest: V3;
  head: V3;
  /** [hip, knee, ankle] left then right */
  legs: [V3, V3, V3][];
  /** [shoulder, elbow, hand] left then right */
  arms: [V3, V3, V3][];
}

const SKELETONS: Record<CrewPose, Skeleton> = {
  stand: {
    pelvis: [0, 0.94, 0],
    chest: [0, 1.4, 0.01],
    head: [0, 1.66, 0.02],
    legs: [
      [[0.1, 0.92, 0], [0.11, 0.5, 0.03], [0.12, 0.1, 0]],
      [[-0.1, 0.92, 0], [-0.11, 0.5, 0.03], [-0.12, 0.1, 0]],
    ],
    arms: [
      [[0.21, 1.44, 0], [0.24, 1.17, 0.03], [0.2, 1.02, 0.32]],
      [[-0.21, 1.44, 0], [-0.24, 1.17, 0.03], [-0.2, 1.02, 0.32]],
    ],
  },
  kneel: {
    pelvis: [0, 0.56, -0.05],
    chest: [0, 1.02, 0.08],
    head: [0, 1.27, 0.15],
    legs: [
      [[0.1, 0.55, -0.05], [0.12, 0.52, 0.42], [0.12, 0.1, 0.44]],
      [[-0.1, 0.55, -0.05], [-0.12, 0.09, 0.02], [-0.12, 0.1, -0.42]],
    ],
    arms: [
      [[0.21, 1.05, 0.08], [0.23, 0.82, 0.25], [0.12, 0.74, 0.5]],
      [[-0.21, 1.05, 0.08], [-0.23, 0.82, 0.25], [-0.12, 0.74, 0.5]],
    ],
  },
  crouch: {
    pelvis: [0, 0.74, -0.14],
    chest: [0, 1.12, 0.2],
    head: [0, 1.32, 0.34],
    legs: [
      [[0.1, 0.74, -0.14], [0.13, 0.46, 0.2], [0.13, 0.1, 0.02]],
      [[-0.1, 0.74, -0.14], [-0.13, 0.46, 0.2], [-0.13, 0.1, 0.02]],
    ],
    arms: [
      [[0.21, 1.14, 0.2], [0.25, 0.92, 0.42], [0.19, 0.74, 0.62]],
      [[-0.21, 1.14, 0.2], [-0.25, 0.92, 0.42], [-0.19, 0.74, 0.62]],
    ],
  },
};

/** Where a carried item sits in each pose (local offset; jacks also a downward pitch toward the floor). */
const TYRE_HOLD: Record<CrewPose, V3> = { stand: [0, 1.0, 0.48], kneel: [0, 0.72, 0.62], crouch: [0, 0.66, 0.74] };
const GUN_HOLD: Record<CrewPose, V3> = { stand: [0.18, 1.0, 0.36], kneel: [0, 0.74, 0.56], crouch: [0, 0.76, 0.66] };
const JACK_HOLD: Record<CrewPose, { at: V3; pitch: number }> = {
  stand: { at: [0, 0.95, 0.34], pitch: 0.78 },
  kneel: { at: [0, 0.74, 0.5], pitch: 0.6 },
  crouch: { at: [0, 0.74, 0.62], pitch: 0.55 },
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

/** Capsule from `a` to `b` (radius r) appended to a builder. */
function limb(b: GeoBuilder, a: V3, c: V3, r: number): void {
  _a.set(a[0], a[1], a[2]);
  _b.set(c[0], c[1], c[2]);
  const len = Math.max(0.01, _a.distanceTo(_b));
  const g = new THREE.CapsuleGeometry(r, len, 2, 6);
  _q.setFromUnitVectors(_up, _b.clone().sub(_a).normalize());
  _m.compose(_a.add(_b).multiplyScalar(0.5), _q, _s);
  addGeometry(b, g, _m);
  g.dispose();
}

function sphere(b: GeoBuilder, p: V3, r: number, sx = 1, sy = 1, sz = 1, segments = 8): void {
  const g = new THREE.SphereGeometry(r, segments, Math.max(4, segments - 2));
  _m.compose(_a.set(p[0], p[1], p[2]), _q.identity(), _b.set(sx, sy, sz));
  addGeometry(b, g, _m);
  g.dispose();
}

/** Overalls (white = team colour via instance colour, trousers a darker shade) and the gear (helmet, visor, gloves, boots). */
function buildPerson(pose: CrewPose): { suit: THREE.BufferGeometry; gear: THREE.BufferGeometry } {
  const k = SKELETONS[pose];
  const suit = new GeoBuilder(true);
  const gear = new GeoBuilder(true);
  const white = new THREE.Color(1, 1, 1);
  const trousers = new THREE.Color(0.55, 0.55, 0.55);
  suit.setColor(white);
  limb(suit, k.pelvis, k.chest, 0.15);
  limb(suit, [0.2, k.chest[1] + 0.03, k.chest[2]], [-0.2, k.chest[1] + 0.03, k.chest[2]], 0.08);
  for (const [s, e, h] of k.arms) {
    limb(suit, s, e, 0.058);
    limb(suit, e, h, 0.05);
  }
  suit.setColor(trousers);
  for (const [hip, knee, ankle] of k.legs) {
    limb(suit, hip, knee, 0.078);
    limb(suit, knee, ankle, 0.064);
  }
  gear.setColor(new THREE.Color('#eceef0'));
  sphere(gear, k.head, 0.135, 1, 1.05, 1.08);
  gear.setColor(new THREE.Color('#14161a'));
  sphere(gear, [k.head[0], k.head[1] + 0.005, k.head[2] + 0.075], 0.1, 1.05, 0.55, 0.7);
  for (const [, , hand] of k.arms) sphere(gear, hand, 0.05, 1, 1, 1, 5);
  gear.setColor(new THREE.Color('#1c1d20'));
  for (const [, , ankle] of k.legs) addBox(gear, ankle[0], Math.max(0.05, ankle[1] - 0.045), ankle[2] + 0.06, 0, 0.11, 0.1, 0.27);
  const sg = suit.build();
  const gg = gear.build();
  if (!sg || !gg) throw new Error('render: pit crew geometry');
  return { suit: sg, gear: gg };
}

/** Bare tyre on a dark rim, axis along local Z (held facing its carrier). */
function buildTyre(): THREE.BufferGeometry {
  const b = new GeoBuilder(true);
  b.setColor(new THREE.Color('#121315'));
  const tyre = new THREE.CylinderGeometry(0.34, 0.34, 0.36, 22, 1, false);
  addGeometry(b, tyre, _m.makeRotationX(Math.PI / 2));
  tyre.dispose();
  b.setColor(new THREE.Color('#3a3d43'));
  const rim = new THREE.CylinderGeometry(0.22, 0.22, 0.37, 16, 1, false);
  addGeometry(b, rim, _m.makeRotationX(Math.PI / 2));
  rim.dispose();
  const g = b.build();
  if (!g) throw new Error('render: pit crew tyre');
  return g;
}

/** Wheel gun (body + nozzle along +Z) and trolley jack (bar along +Z from the handle, lifting head at the far end). */
function buildTools(): { gun: THREE.BufferGeometry; jack: THREE.BufferGeometry } {
  const gun = new GeoBuilder(true);
  gun.setColor(new THREE.Color('#2a2c30'));
  addBox(gun, 0, 0, 0, 0, 0.1, 0.13, 0.3);
  addBox(gun, 0, -0.1, -0.06, 0, 0.06, 0.14, 0.07);
  gun.setColor(new THREE.Color('#9aa0a8'));
  addBox(gun, 0, 0, 0.2, 0, 0.06, 0.06, 0.12);
  const jack = new GeoBuilder(true);
  jack.setColor(new THREE.Color('#2b2d31'));
  addBox(jack, 0, 0, 0.62, 0, 0.06, 0.06, 1.24);
  addBox(jack, 0, 0, 0.02, 0, 0.42, 0.05, 0.05);
  jack.setColor(new THREE.Color('#d6562a'));
  addBox(jack, 0, -0.02, 1.26, 0, 0.36, 0.12, 0.16);
  const g = gun.build();
  const j = jack.build();
  if (!g || !j) throw new Error('render: pit crew tools');
  return { gun: g, jack: j };
}

interface Member {
  f: number;
  r: number;
  yaw: number;
  walked: number;
  moving: boolean;
  target: CrewTarget;
}

interface Box {
  index: number;
  color: THREE.Color;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** forward / right unit vectors (x, z) */
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  s: number;
  garageR: number;
  garageSide: number;
  phase: BoxPhase;
  t: number;
  /** car being serviced / last serviced (-99 = none) */
  carId: number;
  members: Member[];
  /** observations of the current frame */
  stoppedCar: number;
  approaching: boolean;
}

export class PitCrew {
  readonly group = new THREE.Group();
  private readonly boxes: Box[] = [];
  private readonly suits: THREE.InstancedMesh[] = [];
  private readonly gears: THREE.InstancedMesh[] = [];
  private readonly tyres: THREE.InstancedMesh;
  private readonly guns: THREE.InstancedMesh;
  private readonly jacks: THREE.InstancedMesh;
  private readonly shape: CrewCarShape;
  private readonly ctx: SceneryContext;
  private readonly carBox: Map<number, number>;
  private readonly hints = new Map<number, number>();
  private readonly lifts = new Map<number, number>();
  private readonly centre = new THREE.Vector3();
  private lastTime = Number.NaN;
  private dirty = true;

  constructor(ctx: SceneryContext, dims: CarDims, carBox: Map<number, number>) {
    this.ctx = ctx;
    this.carBox = carBox;
    this.group.name = 'pitCrew';
    const { track: t, frame: f, disposer } = ctx;
    this.shape = {
      frontAxle: dims.frontAxleZ,
      rearAxle: dims.rearAxleZ,
      frontTrack: dims.frontHalfTrack + dims.frontTyreWidth / 2,
      rearTrack: dims.rearHalfTrack + dims.rearTyreWidth / 2,
      nose: Math.max(dims.noseTipZ, dims.frontWingZ1),
      tail: Math.min(dims.rearWingZ0, dims.rearWingZ1, dims.rearAxleZ - dims.rearWheelRadius),
      halfWidth: dims.width * 0.38,
    };
    const n = t.count;
    const ps = f.pitSign;
    const teams = Math.min(PIT_BOX_COUNT, ctx.teamColors.length);
    for (let b = 0; b < teams && n > 0; b++) {
      const s = wrapS(t, t.pit.box + (b - (PIT_BOX_COUNT - 1) / 2) * PIT_BOX_SPACING);
      const k = Math.round(s / Math.max(0.01, t.spacing)) % n;
      const lane = f.pitLane[k] || t.pit.laneOffset;
      const lat = lane + ps * PIT_BOX_LATERAL;
      const p = poseAt(t, s, lat);
      if (!Number.isFinite(p.x)) continue;
      const front = ps * (ps > 0 ? f.barrierR[k] : f.barrierL[k]);
      let garageR = front - lat;
      if (!Number.isFinite(garageR) || Math.abs(garageR) < 3) garageR = ps * 4;
      const box: Box = {
        index: b,
        color: new THREE.Color(ctx.teamColors[b]),
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        fx: Math.sin(p.yaw),
        fz: Math.cos(p.yaw),
        rx: -Math.cos(p.yaw),
        rz: Math.sin(p.yaw),
        s,
        garageR,
        garageSide: ps,
        phase: 'idle',
        t: 0,
        carId: -99,
        members: [],
        stoppedCar: -99,
        approaching: false,
      };
      for (let i = 0; i < CREW_SLOTS.length; i++) {
        const target = crewTarget(i, 'idle', 0, this.shape, garageR, ps);
        box.members.push({ f: target.f, r: target.r, yaw: target.yaw, walked: 0, moving: false, target });
      }
      this.boxes.push(box);
      this.centre.x += p.x;
      this.centre.y += p.y;
      this.centre.z += p.z;
    }
    if (this.boxes.length > 0) this.centre.multiplyScalar(1 / this.boxes.length);
    const people = Math.max(1, this.boxes.length * CREW_SLOTS.length);
    // one bounding sphere over the whole garage row: crews only move a few metres around their boxes
    const bounds = new THREE.Sphere(this.centre.clone(), (PIT_BOX_COUNT * PIT_BOX_SPACING) / 2 + 30);
    const mesh = (g: THREE.BufferGeometry, mat: THREE.Material, count: number, name: string): THREE.InstancedMesh => {
      const m = disposer.add(new THREE.InstancedMesh(disposer.add(g), mat, count));
      m.name = name;
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = 0;
      m.boundingSphere = bounds.clone();
      this.group.add(m);
      return m;
    };
    const suitMat = disposer.add(new THREE.MeshStandardMaterial({ name: 'crew-suit', vertexColors: true, roughness: 0.82 }));
    const gearMat = disposer.add(new THREE.MeshStandardMaterial({ name: 'crew-gear', vertexColors: true, roughness: 0.32, metalness: 0.05 }));
    const toolMat = disposer.add(new THREE.MeshStandardMaterial({ name: 'crew-tools', vertexColors: true, roughness: 0.55, metalness: 0.35 }));
    for (const pose of POSES) {
      const g = buildPerson(pose);
      this.suits.push(mesh(g.suit, suitMat, people, `crewSuit-${pose}`));
      this.gears.push(mesh(g.gear, gearMat, people, `crewGear-${pose}`));
    }
    const tools = buildTools();
    this.tyres = mesh(buildTyre(), toolMat, Math.max(1, this.boxes.length * 8), 'crewTyres');
    this.guns = mesh(tools.gun, toolMat, Math.max(1, this.boxes.length * 4), 'crewGuns');
    this.jacks = mesh(tools.jack, toolMat, Math.max(1, this.boxes.length * 2), 'crewJacks');
    this.buildSpareStacks(mesh);
    this.rebuild();
  }

  /** Two stacks of four blanket-wrapped tyres beside every garage door (static). */
  private buildSpareStacks(mesh: (g: THREE.BufferGeometry, mat: THREE.Material, count: number, name: string) => THREE.InstancedMesh): void {
    if (this.boxes.length === 0) return;
    const blanket = new THREE.CylinderGeometry(0.37, 0.37, 0.4, 18);
    const mat = this.ctx.disposer.add(new THREE.MeshStandardMaterial({ name: 'tyre-blankets', roughness: 0.92 }));
    const stacks = mesh(blanket, mat, this.boxes.length * 8, 'tyreBlankets');
    let i = 0;
    const dark = new THREE.Color('#2a2c31');
    for (const box of this.boxes) {
      const tint = box.color.clone().lerp(dark, 0.55);
      for (const side of [-1, 1]) {
        const fl = side * 5.2;
        const rl = box.garageR - box.garageSide * 0.75;
        for (let level = 0; level < 4; level++) {
          _a.set(box.x + box.fx * fl + box.rx * rl, box.y + 0.2 + level * 0.41, box.z + box.fz * fl + box.rz * rl);
          _m.compose(_a, _q.identity(), _s);
          stacks.setMatrixAt(i, _m);
          stacks.setColorAt(i, tint);
          i++;
        }
      }
    }
    stacks.count = i;
    stacks.instanceMatrix.needsUpdate = true;
    if (stacks.instanceColor) stacks.instanceColor.needsUpdate = true;
  }

  /** Crewed boxes (one per team, at most PIT_BOX_COUNT). */
  get boxCount(): number {
    return this.boxes.length;
  }

  /** A box's garage index, phase, centre and heading (tests / debugging). */
  boxInfo(i: number): { index: number; phase: BoxPhase; x: number; y: number; z: number; yaw: number } | null {
    const b = this.boxes[i];
    return b ? { index: b.index, phase: b.phase, x: b.x, y: b.y, z: b.z, yaw: b.yaw } : null;
  }

  /** Jack lift (m) of a car standing in its box (0 for every other car). */
  liftFor(carId: number): number {
    return this.lifts.get(carId) ?? 0;
  }

  /** Drop all motion (flashback / replay seek): every crew snaps to where its box phase puts it. */
  reset(): void {
    this.lastTime = Number.NaN;
  }

  /**
   * Observe the cars, advance every box phase and walk the crews (sim time `time`), then rebuild the instances when
   * a camera is near. `cams` = camera positions of the last frame.
   */
  update(cars: readonly CarRenderState[], time: number, cams: readonly THREE.Vector3[]): void {
    if (this.boxes.length === 0) return;
    const now = Number.isFinite(time) ? time : 0;
    const jump = !Number.isFinite(this.lastTime) || now < this.lastTime - 0.05 || now - this.lastTime > 2;
    const dt = jump ? 0 : Math.min(0.1, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    this.observe(cars);
    this.lifts.clear();
    for (const box of this.boxes) {
      const departing = this.departing(box, cars);
      const next = nextBoxPhase(box.phase, { stopped: box.stoppedCar !== -99, approaching: box.approaching, departing });
      if (next !== box.phase) {
        box.phase = next;
        box.t = 0;
        this.dirty = true;
      } else box.t += dt;
      if (next === 'service') box.carId = box.stoppedCar;
      const lift = box.phase === 'service' ? crewLift(box.phase, box.t) : 0;
      if (lift > 0) this.lifts.set(box.carId, lift);
      for (let i = 0; i < box.members.length; i++) {
        const m = box.members[i];
        m.target = crewTarget(i, box.phase, box.t, this.shape, box.garageR, box.garageSide);
        if (jump) {
          m.f = m.target.f;
          m.r = m.target.r;
          m.yaw = m.target.yaw;
          m.moving = false;
          this.dirty = true;
          continue;
        }
        const f0 = m.f;
        const r0 = m.r;
        const y0 = m.yaw;
        const wasMoving = m.moving;
        m.moving = walkToward(m, m.target, dt);
        m.walked += Math.hypot(m.f - f0, m.r - r0);
        if (m.f !== f0 || m.r !== r0 || m.yaw !== y0 || m.moving !== wasMoving) this.dirty = true;
      }
      if (box.phase === 'service') this.dirty = true;
    }
    let near = false;
    for (const c of cams) if (c.distanceToSquared(this.centre) < CREW_VIEW_DISTANCE * CREW_VIEW_DISTANCE) near = true;
    this.group.visible = near || cams.length === 0;
    if (this.group.visible && this.dirty) this.rebuild();
  }

  /** Which box has a car standing in it, and which boxes expect a team car coming down the pit lane. */
  private observe(cars: readonly CarRenderState[]): void {
    const { track: t, frame: f } = this.ctx;
    for (const box of this.boxes) {
      box.stoppedCar = -99;
      box.approaching = false;
    }
    const reach = (PIT_BOX_COUNT * PIT_BOX_SPACING) / 2 + CREW_CALL_DISTANCE + 60;
    for (const c of cars) {
      if (!c.visible || c.ghost || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
      if ((c.x - this.centre.x) ** 2 + (c.z - this.centre.z) ** 2 > reach * reach) continue;
      const own = this.carBox.get(c.carId);
      const speed = Number.isFinite(c.speed) ? Math.abs(c.speed) : 0;
      for (const box of this.boxes) {
        if (own !== undefined && own !== box.index) continue;
        const dx = c.x - box.x;
        const dz = c.z - box.z;
        const along = dx * box.fx + dz * box.fz;
        const across = dx * box.rx + dz * box.rz;
        if (speed < CREW_STOPPED_SPEED && Math.abs(along) < CREW_BOX_ALONG && Math.abs(across) < CREW_BOX_ACROSS) box.stoppedCar = c.carId;
      }
      // a team car in the pit lane short of its box calls its crew out
      if (own === undefined) continue;
      const box = this.boxes.find((b) => b.index === own);
      if (!box) continue;
      const near = f.nearest(c.x, c.z, this.hints.get(c.carId));
      this.hints.set(c.carId, near.index);
      if (f.inPit[near.index] !== 1 || Math.abs(near.lateral - f.pitLane[near.index]) > PIT_LANE_HALF + 1.5) continue;
      const toBox = forwardDistance(t, t.s[near.index], box.s);
      if (toBox > CREW_BOX_ALONG && toBox < CREW_CALL_DISTANCE) box.approaching = true;
    }
  }

  /** The car serviced last is still rolling out of the box (crew stays clear until it has gone). */
  private departing(box: Box, cars: readonly CarRenderState[]): boolean {
    if (box.carId === -99) return false;
    for (const c of cars) {
      if (c.carId !== box.carId || !c.visible) continue;
      const dx = c.x - box.x;
      const dz = c.z - box.z;
      const along = dx * box.fx + dz * box.fz;
      const across = dx * box.rx + dz * box.rz;
      return along > -CREW_BOX_ALONG && along < CREW_DEPART_DISTANCE && Math.abs(across) < 6;
    }
    return false;
  }

  /** Write every member / tool instance from the current positions. */
  private rebuild(): void {
    this.dirty = false;
    const counts = [0, 0, 0];
    let tyres = 0;
    let guns = 0;
    let jacks = 0;
    for (const box of this.boxes) {
      for (const m of box.members) {
        const pose: CrewPose = m.moving ? 'stand' : m.target.pose;
        const pi = POSES.indexOf(pose);
        const bob = m.moving ? walkBob(m.walked) : 0;
        _a.set(box.x + box.fx * m.f + box.rx * m.r, box.y + bob, box.z + box.fz * m.f + box.rz * m.r);
        _q.setFromAxisAngle(_up, box.yaw + m.yaw);
        _m.compose(_a, _q, _s);
        const idx = counts[pi]++;
        this.suits[pi].setMatrixAt(idx, _m);
        this.suits[pi].setColorAt(idx, box.color);
        this.gears[pi].setMatrixAt(idx, _m);
        const item = m.target.item;
        if (item === 'tyre') {
          const h = TYRE_HOLD[pose];
          _m2.makeTranslation(h[0], h[1], h[2]);
          this.tyres.setMatrixAt(tyres++, _m2.premultiply(_m));
        } else if (item === 'gun') {
          const h = GUN_HOLD[pose];
          _e.set(0, 0, gunWobble(box.phase, box.t));
          _m2.compose(_b.set(h[0], h[1], h[2]), _q.setFromEuler(_e), _s);
          this.guns.setMatrixAt(guns++, _m2.premultiply(_m));
        } else if (item === 'jack') {
          const h = JACK_HOLD[pose];
          _e.set(h.pitch, 0, 0);
          _m2.compose(_b.set(h.at[0], h.at[1], h.at[2]), _q.setFromEuler(_e), _s);
          this.jacks.setMatrixAt(jacks++, _m2.premultiply(_m));
        }
      }
    }
    POSES.forEach((_, i) => {
      for (const mesh of [this.suits[i], this.gears[i]]) {
        mesh.count = counts[i];
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    });
    for (const [mesh, count] of [
      [this.tyres, tyres],
      [this.guns, guns],
      [this.jacks, jacks],
    ] as const) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
