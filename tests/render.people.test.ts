/**
 * People in the race scene: the articulated pit crew (pose solver, rig geometry, instances on a built track, quality
 * tiers) and the animated grandstand crowd (motion constants, cheering car pick, crowd geometry and shader patch).
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { CarRenderState, QualityLevel } from '../src/core/types';
import { buildTrack } from '../src/track/track';
import { carDims } from '../src/render/car/dims';
import { PitCrew, RIG_GUN_HOLD, RIG_JACK_HOLD, RIG_JACK_PITCH, RIG_TYRE_HOLD } from '../src/render/track/pitCrew';
import { CREW_SLOTS } from '../src/render/track/pitCrewMath';
import {
  ANKLE_HEIGHT,
  BONE,
  GAIT_RATE,
  approachPose,
  blendHold,
  createJoints,
  createPoseState,
  solvePose,
  solveTwoBone,
  type Joints,
  type PoseInput,
  type V3,
} from '../src/render/track/pitCrewPose';
import { SEGMENTS, buildRigGeometry } from '../src/render/track/pitCrewRig';
import { baseQualityProfile } from '../src/render/core/quality';
import { CHEER_CARS, SEAT_HEIGHT, THIGH, selectCheerCars, standingLegs } from '../src/render/track/crowdMotion';
import { CROWD_DETAIL, CROWD_MOTION } from '../src/render/track/trackside';
import { CROWD_CARS, patchCrowd } from '../src/render/track/sceneryMaterials';
import { buildStatic, installFakeDom, makeContext } from './renderHarness';
import { longDef } from './trackFixtures';

installFakeDom();

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function inputFor(state: ReturnType<typeof createPoseState>, over: Partial<PoseInput> = {}): PoseInput {
  return { state, phase: 0, time: 3, seed: 0.37, item: 'none', hold: [0, 1, 0.4], pitch: 0, ...over };
}

function stateOf(kneel: number, crouch: number, walk = 0, grip = 0): ReturnType<typeof createPoseState> {
  return { kneel, crouch, walk, grip };
}

describe('pose solver', () => {
  test('two-bone IK keeps bone lengths and stays finite, also for unreachable and degenerate targets', () => {
    const joint: V3 = [0, 0, 0];
    const end: V3 = [0, 0, 0];
    for (const target of [[0.2, -0.5, 0.3], [0, -2, 0], [0, 0, 0], [0.1, 0.1, 0.1], [0, -0.8, 0]] as V3[]) {
      solveTwoBone([0, 1, 0], [target[0], 1 + target[1], target[2]], 0.44, 0.42, [0, 0, 1], joint, end);
      expect(dist([0, 1, 0], joint)).toBeCloseTo(0.44, 5);
      expect(dist(joint, end)).toBeCloseTo(0.42, 5);
      for (const v of [...joint, ...end]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  const check = (j: Joints): void => {
    for (let i = 0; i < 2; i++) {
      expect(dist(j.hip[i], j.knee[i])).toBeCloseTo(BONE.thigh, 4);
      expect(dist(j.knee[i], j.ankle[i])).toBeCloseTo(BONE.shin, 4);
      expect(dist(j.shoulder[i], j.elbow[i])).toBeCloseTo(BONE.upperArm, 4);
      expect(dist(j.elbow[i], j.wrist[i])).toBeCloseTo(BONE.foreArm, 4);
      // feet stay on or above the floor, knees never sink through it
      expect(j.ankle[i][1]).toBeGreaterThan(ANKLE_HEIGHT - 0.02);
      expect(j.knee[i][1]).toBeGreaterThan(0.05);
    }
    expect(j.head[1]).toBeGreaterThan(1.1);
    expect(j.head[1]).toBeLessThan(1.8);
  };

  test('every stance, gait phase and item keeps limb lengths and the feet above the floor', () => {
    const j = createJoints();
    for (const [k, c] of [[0, 0], [1, 0], [0, 1], [0.5, 0.3]] as const) {
      for (const walk of [0, 1]) {
        for (let phase = 0; phase < 6.4; phase += 0.8) {
          for (const item of ['none', 'tyre', 'gun', 'jack'] as const) {
            const st = stateOf(k, c, walk, item === 'none' ? 0 : 1);
            const table = item === 'tyre' ? RIG_TYRE_HOLD : item === 'gun' ? RIG_GUN_HOLD : RIG_JACK_HOLD;
            const hold: V3 = [0, 0, 0];
            blendHold(table, st, hold);
            solvePose(j, inputFor(st, { phase, item, hold, pitch: RIG_JACK_PITCH.stand }));
            check(j);
          }
        }
      }
    }
  });

  test('a kneeling man has one knee on the floor, a crouching man both feet flat, a standing man is tall', () => {
    const j = createJoints();
    solvePose(j, inputFor(stateOf(1, 0)));
    expect(Math.min(j.knee[0][1], j.knee[1][1])).toBeLessThan(0.2);
    expect(Math.max(j.knee[0][1], j.knee[1][1])).toBeGreaterThan(0.4);
    solvePose(j, inputFor(stateOf(0, 1)));
    expect(j.ankle[0][1]).toBeCloseTo(ANKLE_HEIGHT, 3);
    expect(j.ankle[1][1]).toBeCloseTo(ANKLE_HEIGHT, 3);
    expect(j.pelvis[1]).toBeLessThan(0.8);
    solvePose(j, inputFor(stateOf(0, 0)));
    expect(j.head[1]).toBeGreaterThan(1.55);
  });

  test('walking swings the legs against each other and the arms against the legs; standing still does not', () => {
    const j = createJoints();
    const spread: number[] = [];
    const armSpread: number[] = [];
    for (let phase = 0; phase < 6.3; phase += 0.3) {
      solvePose(j, inputFor(stateOf(0, 0, 1), { phase }));
      spread.push(j.ankle[0][2] - j.ankle[1][2]);
      armSpread.push(j.wrist[0][2] - j.wrist[1][2]);
      // arm opposite to its leg: left leg forward → left arm back
      const legSign = Math.sign(j.ankle[0][2] - j.ankle[1][2]);
      const armSign = Math.sign(j.wrist[0][2] - j.wrist[1][2]);
      if (Math.abs(j.ankle[0][2] - j.ankle[1][2]) > 0.2 && Math.abs(j.wrist[0][2] - j.wrist[1][2]) > 0.2) expect(armSign).toBe(-legSign);
    }
    expect(Math.max(...spread)).toBeGreaterThan(0.4);
    expect(Math.min(...spread)).toBeLessThan(-0.4);
    expect(Math.max(...armSpread)).toBeGreaterThan(0.3);
    solvePose(j, inputFor(stateOf(0, 0, 0)));
    expect(Math.abs(j.ankle[0][2] - j.ankle[1][2])).toBeLessThan(0.15);
    // stride matches the gait rate: the foot swing speed equals the walking speed
    expect(GAIT_RATE * 0.3).toBeGreaterThan(0.9);
  });

  test('idle members shift weight and turn the head over time, each differently', () => {
    const j = createJoints();
    const yaws: number[] = [];
    const rolls: number[] = [];
    for (let t = 0; t < 60; t += 1) {
      solvePose(j, inputFor(stateOf(0, 0), { time: t }));
      yaws.push(j.headYaw);
      rolls.push(j.roll);
    }
    expect(Math.max(...yaws) - Math.min(...yaws)).toBeGreaterThan(0.3);
    expect(Math.max(...rolls) - Math.min(...rolls)).toBeGreaterThan(0.02);
    solvePose(j, inputFor(stateOf(0, 0), { time: 20, seed: 0.1 }));
    const a = j.headYaw;
    solvePose(j, inputFor(stateOf(0, 0), { time: 20, seed: 0.8 }));
    expect(j.headYaw).not.toBe(a);
  });

  test('hands reach the tyre and the jack handle in every stance', () => {
    const j = createJoints();
    for (const [k, c] of [[0, 0], [1, 0], [0, 1]] as const) {
      const st = stateOf(k, c, 0, 1);
      const hold: V3 = [0, 0, 0];
      blendHold(RIG_TYRE_HOLD, st, hold);
      solvePose(j, inputFor(st, { item: 'tyre', hold }));
      expect(dist(j.wrist[0], [hold[0] + 0.31, hold[1], hold[2]])).toBeLessThan(0.08);
      expect(dist(j.wrist[1], [hold[0] - 0.31, hold[1], hold[2]])).toBeLessThan(0.08);
      blendHold(RIG_JACK_HOLD, st, hold);
      solvePose(j, inputFor(st, { item: 'jack', hold }));
      expect(dist(j.wrist[0], [hold[0] + 0.17, hold[1], hold[2]])).toBeLessThan(0.08);
    }
  });

  test('stance changes are smooth: no joint jumps more than a few cm per frame (60 fps) while kneeling down and getting up', () => {
    const j = createJoints();
    const prev = createJoints();
    const s = createPoseState();
    let first = true;
    for (let frame = 0; frame < 90; frame++) {
      const down = frame < 45;
      approachPose(s, down ? 'kneel' : 'stand', false, false, 1 / 60);
      solvePose(j, inputFor(s, { time: 5 }));
      if (!first) {
        for (let i = 0; i < 2; i++) for (const key of ['knee', 'ankle', 'wrist', 'elbow'] as const) expect(dist(j[key][i], prev[key][i])).toBeLessThan(0.09);
        expect(dist(j.head, prev.head)).toBeLessThan(0.09);
      }
      for (const key of ['knee', 'ankle', 'wrist', 'elbow', 'shoulder', 'hip'] as const) for (let i = 0; i < 2; i++) prev[key][i] = [...j[key][i]] as V3;
      prev.head = [...j.head] as V3;
      first = false;
    }
    expect(s.kneel).toBeGreaterThan(0);
    expect(s.kneel).toBeLessThan(0.2);
    // snapping jumps straight to the target
    approachPose(s, 'crouch', true, true, 0, true);
    expect(s).toEqual({ kneel: 0, crouch: 1, walk: 1, grip: 1 });
  });
});

describe('rig geometry', () => {
  for (const level of ['medium', 'high', 'ultra'] as QualityLevel[]) {
    test(`${level}: ten segments per person stay within the triangle budget and carry a tint mask`, () => {
      const geo = buildRigGeometry(level);
      let tris = 0;
      for (const seg of SEGMENTS) {
        const g = geo[seg];
        const count = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        const per = seg === 'torso' || seg === 'head' ? 1 : 2;
        tris += count * per;
        expect(g.getAttribute('tintMask').count).toBe(g.getAttribute('position').count);
        expect(g.getAttribute('color')).toBeDefined();
        g.dispose();
      }
      expect(tris).toBeLessThan(level === 'medium' ? 600 : level === 'high' ? 720 : 800);
    });
  }
  test('radial detail grows with quality', () => {
    const radial = (level: QualityLevel): number => baseQualityProfile(level).crewRadial;
    expect(radial('low')).toBeLessThan(radial('medium'));
    expect(radial('medium')).toBeLessThan(radial('high'));
    expect(radial('high')).toBeLessThan(radial('ultra'));
  });
});

function carState(over: Partial<CarRenderState> = {}): CarRenderState {
  return {
    carId: 3, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, wheelSpin: 0, throttle: 0, brake: 0, rpm: 0, gear: 1,
    drsOpen: false, compound: 'medium', rainLight: false, limiter: false, damage: { frontWing: 0, rearWing: 0 }, slip: 0, lockup: 0, impact: 0,
    surface: 'asphalt', boost: false, visible: true, ghost: false,
    ...over,
  };
}

function meshNames(root: THREE.Object3D): string[] {
  const out: string[] = [];
  root.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) out.push(o.name);
  });
  return out;
}

describe('crews by quality', () => {
  test('low keeps the three rigid poses, medium and up use the articulated rig with the same number of people', () => {
    const track = buildTrack(longDef());
    const low = makeContext(track, { level: 'low' });
    const crewLow = new PitCrew(low.ctx, carDims(), new Map());
    expect(meshNames(crewLow.group).filter((n) => n.startsWith('crewSuit')).length).toBe(3);
    expect(meshNames(crewLow.group).some((n) => n.startsWith('crewRig'))).toBe(false);
    low.disposer.dispose();
    for (const level of ['medium', 'high', 'ultra'] as QualityLevel[]) {
      const { ctx, disposer } = makeContext(track, { level });
      const crew = new PitCrew(ctx, carDims(), new Map());
      const names = meshNames(crew.group);
      expect(names.filter((n) => n.startsWith('crewRig')).length).toBe(SEGMENTS.length);
      expect(names.some((n) => n.startsWith('crewSuit'))).toBe(false);
      const torsos = crew.group.children.find((c) => c.name === 'crewRig-torso') as THREE.InstancedMesh;
      expect(torsos.count).toBe(crew.boxCount * CREW_SLOTS.length);
      const arms = crew.group.children.find((c) => c.name === 'crewRig-upperArm') as THREE.InstancedMesh;
      expect(arms.count).toBe(torsos.count * 2);
      disposer.dispose();
    }
  });

  test('low: a rigid person costs a fraction of its old 840 triangles and less than half a medium rig person', () => {
    const track = buildTrack(longDef());
    const { ctx, disposer } = makeContext(track, { level: 'low' });
    const crew = new PitCrew(ctx, carDims(), new Map());
    const tris = (m: THREE.Mesh): number => (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
    const meshes = crew.group.children.filter((c) => c.name.startsWith('crewSuit') || c.name.startsWith('crewGear')) as THREE.Mesh[];
    expect(meshes.length).toBe(6);
    const rig = buildRigGeometry('medium');
    let rigTris = 0;
    for (const seg of SEGMENTS) rigTris += ((rig[seg].index?.count ?? 0) / 3) * (seg === 'torso' || seg === 'head' ? 1 : 2);
    for (const pose of ['stand', 'kneel', 'crouch']) {
      const person = meshes.filter((m) => m.name.endsWith(pose)).reduce((n, m) => n + tris(m), 0);
      expect(person).toBeLessThan(280);
      expect(person).toBeLessThan(rigTris / 2);
    }
    disposer.dispose();
  });

  test('a waiting crew is drawn only while a camera is within crewDrawDistance; a crew at work always is (rigid poses and rig)', () => {
    const track = buildTrack(longDef());
    for (const level of ['low', 'high'] as QualityLevel[]) {
      const base = makeContext(track, { level });
      const crew = new PitCrew({ ...base.ctx, quality: { ...base.ctx.quality, crewDrawDistance: 30 } }, carDims(), new Map([[7, 5]]));
      const people = (): number => {
        let n = 0;
        crew.group.traverse((o) => {
          if ((o as THREE.InstancedMesh).isInstancedMesh && (o.name.startsWith('crewSuit') || o.name === 'crewRig-torso')) n += (o as THREE.InstancedMesh).count;
        });
        return n;
      };
      const first = crew.boxInfo(0);
      if (!first) throw new Error('no box 0');
      const cam = new THREE.Vector3(first.x, first.y + 2, first.z);
      let within = 0;
      for (let b = 0; b < crew.boxCount; b++) {
        const info = crew.boxInfo(b);
        if (info && Math.hypot(info.x - cam.x, info.y - cam.y, info.z - cam.z) < 30) within++;
      }
      expect(within).toBeGreaterThan(0);
      expect(within).toBeLessThan(crew.boxCount - 1);
      crew.update([], 1, [cam]);
      crew.update([], 1.1, [cam]);
      expect(people()).toBe(within * CREW_SLOTS.length);
      // no camera at all (replay seek, tests): everyone is drawn
      crew.update([], 1.2, []);
      expect(people()).toBe(crew.boxCount * CREW_SLOTS.length);
      crew.update([], 1.3, [cam]);
      expect(people()).toBe(within * CREW_SLOTS.length);
      // a car stands in box 5, out of the camera's reach: that crew is at work and joins the picture
      const far = crew.boxInfo(5);
      if (!far) throw new Error('no box 5');
      expect(Math.hypot(far.x - cam.x, far.y - cam.y, far.z - cam.z)).toBeGreaterThan(30);
      let time = 2;
      for (let i = 0; i < 30; i++) {
        time += 1 / 30;
        crew.update([carState({ carId: 7, x: far.x, y: far.y, z: far.z, yaw: far.yaw })], time, [cam]);
      }
      expect(crew.boxInfo(5)?.phase).toBe('service');
      expect(people()).toBe((within + 1) * CREW_SLOTS.length);
      base.disposer.dispose();
    }
  });

  test('waiting crews move on their own (idle motion); a paused clock freezes them; a serviced stop kneels the gun men', () => {
    const track = buildTrack(longDef());
    const { ctx, disposer } = makeContext(track, { level: 'high' });
    const crew = new PitCrew(ctx, carDims(), new Map([[7, 2]]));
    const torso = crew.group.children.find((c) => c.name === 'crewRig-head') as THREE.InstancedMesh;
    const snap = (): number[] => Array.from(torso.instanceMatrix.array.slice(0, 16 * 16));
    crew.update([], 1, []);
    crew.update([], 1.1, []);
    const a = snap();
    crew.update([], 1.1, []);
    expect(snap()).toEqual(a);
    crew.update([], 4, []);
    crew.update([], 4.1, []);
    expect(snap()).not.toEqual(a);
    // service: the box-2 gun men end up lower than the waiting ones
    const box = crew.boxInfo(2);
    if (!box) throw new Error('no box 2');
    const gunIndex = 2 * CREW_SLOTS.length + CREW_SLOTS.findIndex((s) => s.role === 'gun');
    const headY = (): number => torso.instanceMatrix.array[gunIndex * 16 + 13];
    const standing = headY();
    let time = 10;
    const car = carState({ carId: 7, x: box.x, y: box.y, z: box.z, yaw: box.yaw });
    for (let i = 0; i < 120; i++) {
      time += 1 / 30;
      crew.update([car], time, []);
    }
    expect(crew.boxInfo(2)?.phase).toBe('service');
    expect(headY()).toBeLessThan(standing - 0.25);
    disposer.dispose();
  });
});

describe('crowd motion', () => {
  test('a standing spectator is about 0.9 m hip height, its feet on the floor, the knee under the shin', () => {
    const s = standingLegs();
    expect(s.hipHeight).toBeGreaterThan(0.8);
    expect(s.hipHeight).toBeLessThan(1.0);
    // standing knee is as high as the seated one (feet flat on the same floor), and the shin follows it forward
    expect(s.kneeY).toBeCloseTo(0.08, 3);
    expect(Math.abs(s.shinDz)).toBeLessThan(0.15);
    expect(THIGH).toBeGreaterThan(SEAT_HEIGHT * 0.8);
  });

  test('cheer cars: the four nearest to a camera, speed-weighted, far and hidden cars ignored', () => {
    const out = new Float32Array(CHEER_CARS * 4);
    const cars = [
      { x: 10, z: 0, speed: 60 },
      { x: 20, z: 0, speed: 30 },
      { x: 30, z: 0, speed: 0 },
      { x: 40, z: 0, speed: 60 },
      { x: 50, z: 0, speed: 60 },
      { x: 5000, z: 0, speed: 60 },
      { x: 1, z: 0, speed: 60, visible: false },
      { x: 2, z: 0, speed: 60, ghost: true },
    ];
    expect(selectCheerCars(cars, [{ x: 0, z: 0 }], out)).toBe(4);
    const picked = [0, 1, 2, 3].map((i) => out[i * 4]).sort((a, b) => a - b);
    expect(picked).toEqual([10, 20, 30, 40]);
    for (let i = 0; i < 4; i++) {
      if (out[i * 4] === 10) expect(out[i * 4 + 2]).toBe(1);
      if (out[i * 4] === 30) expect(out[i * 4 + 2]).toBe(0);
    }
    expect(selectCheerCars(cars, [], out)).toBe(0);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  test('PitCrew hands the cars to the crowd shader uniform only where the crowd cheers', () => {
    const track = buildTrack(longDef());
    for (const level of ['low', 'medium', 'high'] as QualityLevel[]) {
      for (const v of CROWD_CARS.value) v.set(0, 0, 0, 0);
      const { ctx, disposer } = makeContext(track, { level });
      const crew = new PitCrew(ctx, carDims(), new Map());
      crew.update([carState({ x: 100, z: 50, speed: 60 })], 1, [new THREE.Vector3(90, 5, 40)]);
      const w = Math.max(...CROWD_CARS.value.map((v) => v.z));
      expect(w).toBe(CROWD_MOTION[level] === 'cheer' ? 1 : 0);
      disposer.dispose();
    }
  });

  test('tiers: low static and simple, medium idle, high / ultra cheer; crowd parts are labelled', () => {
    expect(CROWD_MOTION.low).toBe('none');
    expect(CROWD_DETAIL.low).toBe('simple');
    expect(CROWD_MOTION.medium).toBe('idle');
    expect(CROWD_MOTION.high).toBe('cheer');
    const track = buildTrack(longDef());
    for (const level of ['low', 'medium', 'high'] as QualityLevel[]) {
      const s = buildStatic(track, { level });
      let found = 0;
      s.root.traverse((o) => {
        const m = o as THREE.InstancedMesh;
        if (!m.isInstancedMesh || m.name !== 'crowd') return;
        found++;
        const parts = m.geometry.getAttribute('crowdPart');
        const mask = m.geometry.getAttribute('tintMask');
        expect(parts.count).toBe(m.geometry.getAttribute('position').count);
        expect(mask.count).toBe(parts.count);
        const set = new Set(Array.from(parts.array));
        if (level === 'high') for (const id of [1, 2, 3, 4, 5, 6]) expect(set.has(id)).toBe(true);
        if (level === 'medium') expect(set.has(3)).toBe(false);
        if (level !== 'low') expect(new Set(Array.from(mask.array)).has(4)).toBe(true);
      });
      expect(found).toBeGreaterThan(0);
      s.dispose();
    }
  });

  test('the crowd shader patch applies to three\'s lambert shader (motion, cheer cars, hair / trousers variety)', () => {
    for (const motion of ['idle', 'cheer'] as const) {
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      patchCrowd(mat, motion);
      const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
      (mat.onBeforeCompile as (s: unknown, r: unknown) => void)(shader, null);
      expect(shader.vertexShader).toContain('attribute float crowdPart');
      expect(shader.vertexShader).toContain('crowdHair');
      expect(shader.vertexShader).toContain('foliageTime');
      expect(shader.vertexShader.includes('crowdCars[ i ]')).toBe(motion === 'cheer');
      expect(shader.uniforms.crowdCars).toBe(CROWD_CARS);
      expect(mat.customProgramCacheKey()).toBe(`nova-crowd-${motion}`);
      // no unreplaced placeholders / NaN literals in the injected code
      expect(shader.vertexShader).not.toContain('NaN');
      expect(shader.vertexShader).not.toContain('undefined');
      mat.dispose();
    }
  });
});
