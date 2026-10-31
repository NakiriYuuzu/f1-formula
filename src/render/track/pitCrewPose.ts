/**
 * Pit crew body pose (pure, no three.js): from a member's blended stance (stand / kneel / crouch), gait phase, idle
 * motion and carried item to the joints of a person with fixed bone lengths (two-bone IK for knees and elbows), so the
 * renderer can draw every limb as a rigid segment and one pose melts into the next instead of popping.
 *
 * Person-local frame: feet at y = 0, facing +Z, +X = the person's left. Index 0 = left, 1 = right.
 */
import type { CrewItem, CrewPose } from './pitCrewMath';

export type V3 = [number, number, number];

/** Bone lengths (m): hip → knee, knee → ankle, shoulder → elbow, elbow → wrist, pelvis → neck base, pelvis → head centre. */
export const BONE = { thigh: 0.44, shin: 0.42, upperArm: 0.3, foreArm: 0.29, spine: 0.5, head: 0.66 } as const;
/** Ankle joint height above the sole (m) and the shoulder offset on the torso (x, y). */
export const ANKLE_HEIGHT = 0.095;
export const SHOULDER: readonly [number, number] = [0.2, 0.45];
/** Hip joint offset from the pelvis (x). */
export const HIP_X = 0.1;
/** Head centre in front of the spine line (m). */
const HEAD_FORWARD = 0.025;

/** Stance weights are blended by exponential approach at this rate (1/s): a change of stance takes about a quarter second. */
export const POSE_RATE = 9;
/** The walking amount follows the same rule (a bit slower, so the legs settle instead of freezing). */
export const WALK_RATE = 10;
/** Gait: radians of gait phase per metre walked (one stride pair = 1.9 m), foot swing (m) and lift (m) at full pace. */
export const GAIT_RATE = 3.3;
export const GAIT_SWING = 0.3;
export const GAIT_LIFT = 0.14;

/** Per-stance keyframes: pelvis, spine lean (rad, forward), ankles (left then right) and the free hands (left; right mirrors x). */
interface Stance {
  pelvis: V3;
  lean: number;
  ankles: [V3, V3];
  hand: V3;
}
const STANCES: Record<CrewPose, Stance> = {
  stand: { pelvis: [0, 0.93, 0], lean: 0.04, ankles: [[0.11, ANKLE_HEIGHT, 0], [-0.11, ANKLE_HEIGHT, 0]], hand: [0.26, 0.83, 0.05] },
  // right knee on the floor, left foot flat ahead of it
  kneel: { pelvis: [0, 0.56, -0.05], lean: 0.3, ankles: [[0.12, ANKLE_HEIGHT, 0.42], [-0.12, ANKLE_HEIGHT, -0.4]], hand: [0.12, 0.74, 0.5] },
  crouch: { pelvis: [0, 0.72, -0.14], lean: 0.7, ankles: [[0.14, ANKLE_HEIGHT, 0.02], [-0.14, ANKLE_HEIGHT, 0.02]], hand: [0.19, 0.74, 0.62] },
};
/** Idle arm habits of a standing member without an item (left hand; right mirrors): hanging, clasped, hands on hips. */
const IDLE_HANDS: readonly V3[] = [
  [0.26, 0.83, 0.05],
  [0.05, 1.02, 0.22],
  [0.23, 0.97, 0],
];
/** Free hand while running (left hand, mid-swing) and its fore / aft swing (m). */
const RUN_HAND: V3 = [0.2, 1.02, 0.15];
const RUN_ARM_SWING = 0.28;

export interface Joints {
  pelvis: V3;
  /** torso pitch (rad, forward) and roll (rad) about the pelvis; the torso frame is Rx(lean) · Rz(roll) */
  lean: number;
  roll: number;
  headYaw: number;
  headPitch: number;
  head: V3;
  shoulder: [V3, V3];
  elbow: [V3, V3];
  wrist: [V3, V3];
  hip: [V3, V3];
  knee: [V3, V3];
  ankle: [V3, V3];
}

export function createJoints(): Joints {
  const v = (): V3 => [0, 0, 0];
  return {
    pelvis: v(),
    lean: 0,
    roll: 0,
    headYaw: 0,
    headPitch: 0,
    head: v(),
    shoulder: [v(), v()],
    elbow: [v(), v()],
    wrist: [v(), v()],
    hip: [v(), v()],
    knee: [v(), v()],
    ankle: [v(), v()],
  };
}

/** Smoothed state of one member. */
export interface PoseState {
  kneel: number;
  crouch: number;
  /** 0 = standing still, 1 = running */
  walk: number;
  /** 0 = hands free, 1 = hands on the carried item */
  grip: number;
}

export function createPoseState(): PoseState {
  return { kneel: 0, crouch: 0, walk: 0, grip: 0 };
}

/** Exponential approach factor for `dt` seconds at `rate` 1/s. */
function approach(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * Math.max(0, Number.isFinite(dt) ? dt : 0));
}

/** Move the state toward the stance / gait / grip a member should have (dt = 0 changes nothing, `snap` jumps). */
export function approachPose(s: PoseState, pose: CrewPose, moving: boolean, holding: boolean, dt: number, snap = false): void {
  const kp = approach(POSE_RATE, dt);
  const kw = approach(WALK_RATE, dt);
  const k = snap ? 1 : kp;
  const kv = snap ? 1 : kw;
  s.kneel += ((pose === 'kneel' ? 1 : 0) - s.kneel) * k;
  s.crouch += ((pose === 'crouch' ? 1 : 0) - s.crouch) * k;
  s.walk += ((moving ? 1 : 0) - s.walk) * kv;
  s.grip += ((holding ? 1 : 0) - s.grip) * k;
}

/** Two-bone IK: the joint between `root` and `target` (bones l1, l2) bending toward `pole`; returns the reached end in `end`. */
export function solveTwoBone(root: V3, target: V3, l1: number, l2: number, pole: V3, joint: V3, end: V3): void {
  let dx = target[0] - root[0];
  let dy = target[1] - root[1];
  let dz = target[2] - root[2];
  const raw = Math.hypot(dx, dy, dz);
  if (raw < 1e-6) {
    dx = 0;
    dy = -1;
    dz = 0;
  } else {
    dx /= raw;
    dy /= raw;
    dz /= raw;
  }
  const d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 0.02, raw));
  const a = (d * d + l1 * l1 - l2 * l2) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // pole direction made perpendicular to the root → target axis
  const dot = pole[0] * dx + pole[1] * dy + pole[2] * dz;
  let px = pole[0] - dx * dot;
  let py = pole[1] - dy * dot;
  let pz = pole[2] - dz * dot;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-5) {
    // pole parallel to the axis: bend forward
    px = 0;
    py = -dz * dy;
    pz = 1 - dz * dz;
    pl = Math.hypot(px, py, pz) || 1;
  }
  px /= pl;
  py /= pl;
  pz /= pl;
  joint[0] = root[0] + dx * a + px * h;
  joint[1] = root[1] + dy * a + py * h;
  joint[2] = root[2] + dz * a + pz * h;
  end[0] = root[0] + dx * d;
  end[1] = root[1] + dy * d;
  end[2] = root[2] + dz * d;
}

/** Point `p` of the torso frame (origin at the pelvis) in the person frame: Rx(lean) · Rz(roll) applied to p, plus the pelvis. */
export function torsoPoint(j: Joints, x: number, y: number, z: number, out: V3): void {
  const cr = Math.cos(j.roll);
  const sr = Math.sin(j.roll);
  const cl = Math.cos(j.lean);
  const sl = Math.sin(j.lean);
  const x1 = x * cr - y * sr;
  const y1 = x * sr + y * cr;
  out[0] = j.pelvis[0] + x1;
  out[1] = j.pelvis[1] + y1 * cl - z * sl;
  out[2] = j.pelvis[2] + y1 * sl + z * cl;
}

export interface PoseInput {
  state: PoseState;
  /** gait phase (rad) from the distance walked */
  phase: number;
  /** sim time (s) and the member's random seed (0..1) for idle motion */
  time: number;
  seed: number;
  item: CrewItem;
  /** where the carried item sits in the person frame and, for a jack, its pitch (rad) */
  hold: V3;
  pitch: number;
}

const _t: V3 = [0, 0, 0];
const _hand: V3 = [0, 0, 0];
const LEG_POLE: V3 = [0, 0, 1];
const _pole: V3 = [0, 0, 0];

/** Hand grip target (person frame) of side `i` for a carried item at `hold`. */
function gripTarget(item: CrewItem, hold: V3, pitch: number, i: number, out: V3): void {
  const side = i === 0 ? 1 : -1;
  switch (item) {
    case 'tyre':
      // both palms on the tread at the tyre's sides
      out[0] = hold[0] + side * 0.31;
      out[1] = hold[1];
      out[2] = hold[2];
      break;
    case 'gun':
      // left hand under the body, right hand on the grip behind the trigger
      out[0] = hold[0] + side * 0.04;
      out[1] = hold[1] + (i === 0 ? 0.02 : -0.1);
      out[2] = hold[2] + (i === 0 ? 0.1 : -0.06);
      break;
    default:
      // jack: both hands on the cross handle (pitched about X with the jack)
      out[0] = hold[0] + side * 0.17;
      out[1] = hold[1] + Math.sin(pitch) * 0.02;
      out[2] = hold[2];
      break;
  }
}

/** Solve every joint of a member (allocation-free). */
export function solvePose(j: Joints, inp: PoseInput): void {
  const { state: s } = inp;
  const kneel = Math.min(1, Math.max(0, s.kneel));
  const crouch = Math.min(1, Math.max(0, s.crouch));
  const sw = Math.max(0, 1 - kneel - crouch);
  const stand = STANCES.stand;
  const kn = STANCES.kneel;
  const cr = STANCES.crouch;
  const walk = Math.min(1, Math.max(0, s.walk)) * sw;
  const idle = (1 - Math.min(1, s.walk)) * sw;
  const t = Number.isFinite(inp.time) ? inp.time : 0;
  const seed = inp.seed;

  // idle: weight shifts from foot to foot, the head looks around
  const shift = Math.sin(t * 0.55 + seed * 6.28) * 0.6 + Math.sin(t * 0.23 + seed * 17.3) * 0.4;
  const look = Math.sin(t * 0.37 + seed * 41.0) * Math.sin(t * 0.11 + seed * 9.0);

  // pelvis, lean
  for (let a = 0; a < 3; a++) j.pelvis[a] = stand.pelvis[a] * sw + kn.pelvis[a] * kneel + cr.pelvis[a] * crouch;
  j.lean = stand.lean * sw + kn.lean * kneel + cr.lean * crouch + 0.1 * walk;
  const cyc = Math.cos(inp.phase);
  j.pelvis[1] += -0.035 * walk + 0.03 * walk * Math.abs(cyc);
  j.pelvis[0] += 0.03 * shift * idle;
  j.roll = 0.03 * shift * idle + 0.03 * walk * Math.sin(inp.phase);
  j.headYaw = 0.75 * look * idle + 0.15 * Math.sin(t * 0.6 + seed * 3.0) * (1 - idle);
  j.headPitch = -j.lean * 0.7 + 0.05 * Math.sin(t * 0.43 + seed * 11.0) * idle;

  // legs: stance targets, gait swing, weight shift
  for (let i = 0; i < 2; i++) {
    const a = j.ankle[i];
    for (let c = 0; c < 3; c++) a[c] = stand.ankles[i][c] * sw + kn.ankles[i][c] * kneel + cr.ankles[i][c] * crouch;
    const ph = inp.phase + (i === 0 ? 0 : Math.PI);
    a[2] += GAIT_SWING * Math.sin(ph) * walk;
    a[1] += GAIT_LIFT * Math.max(0, Math.cos(ph)) * walk;
    // the unloaded foot steps out a little
    a[2] += 0.06 * Math.max(0, i === 0 ? -shift : shift) * idle;
    j.hip[i][0] = j.pelvis[0] + (i === 0 ? HIP_X : -HIP_X);
    j.hip[i][1] = j.pelvis[1];
    j.hip[i][2] = j.pelvis[2];
    solveTwoBone(j.hip[i], a, BONE.thigh, BONE.shin, LEG_POLE, j.knee[i], j.ankle[i]);
  }

  // torso-borne points
  torsoPoint(j, 0, BONE.head, HEAD_FORWARD, j.head);
  for (let i = 0; i < 2; i++) torsoPoint(j, i === 0 ? SHOULDER[0] : -SHOULDER[0], SHOULDER[1], 0, j.shoulder[i]);

  // arms: free hands (habit / run swing / forward reach) blended toward the item grip
  const style = Math.min(IDLE_HANDS.length - 1, Math.floor(seed * IDLE_HANDS.length));
  const grip = Math.min(1, Math.max(0, s.grip));
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;
    const ph = inp.phase + (i === 0 ? Math.PI : 0);
    const habit = IDLE_HANDS[style];
    // free hand: stand (habit ↔ run swing) / kneel / crouch reach
    const swingZ = RUN_HAND[2] + RUN_ARM_SWING * Math.sin(ph);
    const swingY = RUN_HAND[1] + 0.06 * Math.max(0, Math.sin(ph));
    const w = Math.min(1, Math.max(0, s.walk));
    for (let c = 0; c < 3; c++) {
      const base = c === 0 ? habit[0] * (1 - w) + RUN_HAND[0] * w : c === 1 ? habit[1] * (1 - w) + swingY * w : habit[2] * (1 - w) + swingZ * w;
      _hand[c] = base * sw + kn.hand[c] * kneel + cr.hand[c] * crouch;
    }
    _hand[0] *= side;
    if (grip > 0.001) {
      gripTarget(inp.item === 'none' ? 'tyre' : inp.item, inp.hold, inp.pitch, i, _t);
      for (let c = 0; c < 3; c++) _hand[c] += (_t[c] - _hand[c]) * grip;
    }
    // elbows down, back and out
    _pole[0] = 0.4 * side;
    _pole[1] = -1;
    _pole[2] = -0.5;
    solveTwoBone(j.shoulder[i], _hand, BONE.upperArm, BONE.foreArm, _pole, j.elbow[i], j.wrist[i]);
  }
}

/** Item hold point: weights over the stance tables (stand / kneel / crouch). */
export function blendHold(table: Record<CrewPose, V3>, s: PoseState, out: V3): void {
  const kneel = Math.min(1, Math.max(0, s.kneel));
  const crouch = Math.min(1, Math.max(0, s.crouch));
  const sw = Math.max(0, 1 - kneel - crouch);
  for (let c = 0; c < 3; c++) out[c] = table.stand[c] * sw + table.kneel[c] * kneel + table.crouch[c] * crouch;
}

/** Cheap 0..1 hash of an integer (member seeds). */
export function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
