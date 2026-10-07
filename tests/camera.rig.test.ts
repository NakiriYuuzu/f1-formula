/**
 * Camera rig driving feel: critically damped springs (no ringing, frame-rate independent), chase distance spring
 * bounded to a few % and only lengthened inside the barrier, look-ahead toward the corner, roll ≤ 2°, in-car head
 * movement ≤ 3 cm / ≤ 1.5°, and a clean snap on teleports.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { G, smoothstep, yawFromDir } from '../src/core/math';
import type { CameraMode, CarRenderState } from '../src/core/types';
import { getLayout } from '../src/data/tracks/index';
import { carDims } from '../src/render/car/dims';
import {
  CHASE_LOOK_AHEAD_MAX_DEG,
  CHASE_LOOK_AHEAD_STEER_MIX,
  CHASE_ROLL_MAX_DEG,
  CHASE_SPRING_MAX,
  CameraRig,
  HEAD_MAX_ANGLE_DEG,
  HEAD_MAX_OFFSET,
  lookAheadSignal,
  saturate,
  springStep,
  type RigContext,
  type Spring,
} from '../src/render/cameras';
import { TrackFrame } from '../src/render/track/trackFrame';

const DEG = 180 / Math.PI;
const dims = carDims('2025');
const track = getLayout('mirage-sands');
const trackFrame = new TrackFrame(track);

function ctx(withTrack: boolean): RigContext {
  return {
    settings: { ...DEFAULT_SETTINGS, cameraShake: false },
    time: 0,
    dims,
    track: withTrack ? track : null,
    frame: withTrack ? trackFrame : null,
    tvSpots: [],
  };
}

function car(p: Partial<CarRenderState>): CarRenderState {
  return {
    carId: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    steerAngle: 0,
    wheelSpin: 0,
    throttle: 0,
    brake: 0,
    rpm: 0,
    gear: 1,
    drsOpen: false,
    compound: 'soft',
    rainLight: false,
    limiter: false,
    damage: { frontWing: 0, rearWing: 0 },
    slip: 0,
    lockup: 0,
    impact: 0,
    surface: 'asphalt',
    boost: false,
    visible: true,
    ghost: false,
    ...p,
  };
}

/** Straight-line motion from (x0, z0) along `yaw` with speed v(t); returns per-frame samples. */
interface Run {
  rig: CameraRig;
  c: RigContext;
  state: CarRenderState;
}

function drive(
  run: Run,
  mode: CameraMode,
  duration: number,
  fps: number,
  pose: (t: number) => Partial<CarRenderState>,
  t0 = 0,
  each?: (t: number) => void,
): void {
  const dt = 1 / fps;
  const n = Math.round(duration * fps);
  for (let k = 1; k <= n; k++) {
    const t = t0 + k * dt;
    run.c.time = t;
    run.state = car(pose(t));
    run.rig.update(mode, false, 0, run.state, 16 / 9, dt, run.c);
    each?.(t);
  }
}

/** Horizontal camera → car distance. */
const flatDist = (rig: CameraRig, s: CarRenderState): number => Math.hypot(rig.camera.position.x - s.x, rig.camera.position.z - s.z);
const chaseBase = (speed: number): number => 7 + 0.6 * smoothstep(30, 90, speed);

/** Main straight of mirage-sands: start at sample 0 heading along the track. */
const sx = track.px[0];
const sz = track.pz[0];
const fx = track.tx[0];
const fz = track.tz[0];
const straightYaw = yawFromDir(fx, fz);
/** pose along the straight at distance s(t), speed v(t) */
const along = (s: number, v: number): Partial<CarRenderState> => ({ x: sx + fx * s, z: sz + fz * s, y: track.py[0], yaw: straightYaw, speed: v });

/** Speed profile with constant acceleration `a` from v0 (clamped ≥ 0) and its distance. */
const kin = (v0: number, a: number, t: number): { v: number; s: number } => ({ v: Math.max(0, v0 + a * t), s: v0 * t + 0.5 * a * t * t });

describe('springs and shaping', () => {
  test('critically damped step response rises monotonically and never overshoots', () => {
    const s: Spring = { x: 0, v: 0 };
    let prev = 0;
    for (let i = 0; i < 240; i++) {
      springStep(s, 1, 6, 1 / 60);
      expect(s.x).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(s.x).toBeLessThanOrEqual(1 + 1e-12);
      prev = s.x;
    }
    expect(s.x).toBeGreaterThan(0.999);
  });

  test('spring steps are frame-rate independent for a held target', () => {
    const a: Spring = { x: 0, v: 0 };
    const b: Spring = { x: 0, v: 0 };
    for (let i = 0; i < 15; i++) springStep(a, 1, 6, 1 / 30);
    for (let i = 0; i < 72; i++) springStep(b, 1, 6, 1 / 144);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9);
    expect(Math.abs(a.v - b.v)).toBeLessThan(1e-9);
  });

  test('bad inputs leave the spring untouched; saturation never exceeds its max', () => {
    const s: Spring = { x: 0.3, v: 0.1 };
    springStep(s, Number.NaN, 6, 1 / 60);
    springStep(s, 1, 6, 0);
    springStep(s, 1, 6, -1);
    expect(s).toEqual({ x: 0.3, v: 0.1 });
    expect(Math.abs(saturate(1e9, 1, 0.05))).toBeLessThanOrEqual(0.05);
    expect(saturate(-1e9, 1, 0.05)).toBeGreaterThanOrEqual(-0.05);
    expect(saturate(0.001, 0.02, 0.05)).toBeCloseTo(0.00002, 8);
    expect(saturate(Number.NaN, 1, 1)).toBe(0);
  });

  test('look-ahead signal: + when turning right (yaw rate < 0), bounded, silent when stopped', () => {
    expect(lookAheadSignal(-0.5, 0, 40)).toBeGreaterThan(0);
    expect(lookAheadSignal(0.5, 0, 40)).toBeLessThan(0);
    expect(lookAheadSignal(0, 0.1, 40)).toBeGreaterThan(0);
    expect(Math.abs(lookAheadSignal(-50, 5, 90))).toBeLessThanOrEqual(1);
    expect(lookAheadSignal(-0.5, 0.3, 0)).toBe(0);
    expect(lookAheadSignal(Number.NaN, Number.NaN, 40)).toBe(0);
  });
});

describe('chase camera', () => {
  test('hard braking pulls the camera in by a few %, and it settles back without oscillating', () => {
    const run: Run = { rig: new CameraRig(), c: ctx(true), state: car({}) };
    // 1 s cruise at 80 m/s, 1.2 s of 4 g braking, then 2 s cruise
    drive(run, 'chase', 1, 60, (t) => along(80 * t, 80));
    expect(flatDist(run.rig, run.state)).toBeCloseTo(chaseBase(80), 6);
    let minRatio = 1;
    drive(run, 'chase', 1.2, 60, (t) => {
      const k = kin(80, -4 * G, t - 1);
      return along(80 + k.s, k.v);
    }, 1, () => {
      minRatio = Math.min(minRatio, flatDist(run.rig, run.state) / chaseBase(run.state.speed));
    });
    expect(minRatio).toBeLessThan(1 - 0.02);
    expect(minRatio).toBeGreaterThanOrEqual(1 - CHASE_SPRING_MAX - 1e-9);
    const end = kin(80, -4 * G, 1.2);
    let prevOffset = -Infinity;
    drive(run, 'chase', 2, 60, (t) => along(80 + end.s + end.v * (t - 2.2), end.v), 2.2, () => {
      const offset = flatDist(run.rig, run.state) - chaseBase(run.state.speed);
      expect(offset).toBeLessThanOrEqual(1e-9); // never swings past the rest distance
      expect(offset).toBeGreaterThanOrEqual(prevOffset - 1e-9); // monotonic return
      prevOffset = offset;
    });
    expect(Math.abs(prevOffset)).toBeLessThan(0.01);
  });

  test('hard acceleration lets the car pull away a little (inside the barrier)', () => {
    const run: Run = { rig: new CameraRig(), c: ctx(true), state: car({}) };
    let maxRatio = 0;
    drive(run, 'chase', 1.5, 60, (t) => {
      const k = kin(20, 1.4 * G, t);
      return along(k.s, k.v);
    }, 0, () => {
      maxRatio = Math.max(maxRatio, flatDist(run.rig, run.state) / chaseBase(run.state.speed));
    });
    expect(maxRatio).toBeGreaterThan(1.01);
    expect(maxRatio).toBeLessThanOrEqual(1 + CHASE_SPRING_MAX + 1e-9);
  });

  test('the distance never grows when the camera would end up beyond the barrier', () => {
    const run: Run = { rig: new CameraRig(), c: ctx(true), state: car({}) };
    // car parked 1 m inside the right barrier, nose pointing across the track to the left: the camera sits outside the
    // wall. Only the reported speed rises (the g estimate uses speed, not position), so the geometry stays put.
    const lat = trackFrame.barrierR[0] - 1;
    const x0 = sx + track.rx[0] * lat;
    const z0 = sz + track.rz[0] * lat;
    const yaw = yawFromDir(-track.rx[0], -track.rz[0]);
    let maxRatio = 0;
    drive(run, 'chase', 1.2, 60, (t) => ({ x: x0, z: z0, yaw, speed: kin(5, 1.4 * G, t).v }), 0, () => {
      maxRatio = Math.max(maxRatio, flatDist(run.rig, run.state) / chaseBase(run.state.speed));
    });
    expect(maxRatio).toBeLessThanOrEqual(1 + 1e-9);
  });

  test('near the barrier the extension is limited to the room left (continuous, no pop)', () => {
    const run: Run = { rig: new CameraRig(), c: ctx(true), state: car({}) };
    // rest camera position 0.1 m inside the barrier + 0.4 m margin; speed stays < 30 m/s so the rest distance is 7 m
    const lat = trackFrame.barrierR[0] - 0.4 - 0.1 - 7;
    const x0 = sx + track.rx[0] * lat;
    const z0 = sz + track.rz[0] * lat;
    const yaw = yawFromDir(-track.rx[0], -track.rz[0]);
    let maxExt = 0;
    let maxStep = 0;
    let prev = 7;
    drive(run, 'chase', 1.2, 60, (t) => ({ x: x0, z: z0, yaw, speed: kin(5, 1.4 * G, t).v }), 0, () => {
      const d = flatDist(run.rig, run.state);
      maxExt = Math.max(maxExt, d - 7);
      maxStep = Math.max(maxStep, Math.abs(d - prev));
      prev = d;
    });
    expect(maxExt).toBeGreaterThan(0.05);
    expect(maxExt).toBeLessThanOrEqual(0.1 + 1e-6);
    expect(maxStep).toBeLessThan(0.02);
  });

  test('without a track frame the distance is never lengthened', () => {
    const run: Run = { rig: new CameraRig(), c: ctx(false), state: car({}) };
    let maxRatio = 0;
    drive(run, 'chase', 1.5, 60, (t) => {
      const k = kin(20, 1.4 * G, t);
      return { z: k.s, speed: k.v };
    }, 0, () => {
      maxRatio = Math.max(maxRatio, flatDist(run.rig, run.state) / chaseBase(run.state.speed));
    });
    expect(maxRatio).toBeLessThanOrEqual(1 + 1e-9);
  });

  test('frame-rate independent: 30 fps and 144 fps give the same distance', () => {
    const at = (fps: number): number => {
      const run: Run = { rig: new CameraRig(), c: ctx(false), state: car({}) };
      drive(run, 'chase', 1, fps, (t) => {
        const k = kin(80, -4 * G, t);
        return { z: k.s, speed: k.v };
      });
      return flatDist(run.rig, run.state);
    };
    expect(Math.abs(at(30) - at(144))).toBeLessThan(0.002);
  });

  test('look-ahead turns the view toward the steered side', () => {
    const heading = (steer: number): number => {
      const run: Run = { rig: new CameraRig(), c: ctx(false), state: car({}) };
      drive(run, 'chase', 3, 60, (t) => ({ z: 40 * t, speed: 40, steerAngle: steer }));
      const dir = run.rig.camera.getWorldDirection(new THREE.Vector3());
      return Math.atan2(dir.x, dir.z) * DEG;
    };
    const straight = heading(0);
    const right = heading(0.3);
    const left = heading(-0.3);
    // turning right = yaw decreasing; only the steer share of the look-ahead acts on a straight path
    const expected = CHASE_LOOK_AHEAD_MAX_DEG * CHASE_LOOK_AHEAD_STEER_MIX;
    expect(straight - right).toBeGreaterThan(expected * 0.8);
    expect(straight - right).toBeLessThan(expected * 1.3);
    expect(left - straight).toBeCloseTo(straight - right, 6);
  });

  test('roll from lateral g leans outward and stays within 2°', () => {
    const run: Run = { rig: new CameraRig(), c: ctx(false), state: car({}) };
    // violent right-hand rotation at speed (spin-like): the g estimate saturates
    let maxRoll = 0;
    drive(run, 'chase', 2, 60, (t) => ({ x: 0, z: 80 * t, yaw: -1.5 * t, speed: 80 }), 0, () => {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(run.rig.camera.quaternion);
      maxRoll = Math.max(maxRoll, Math.abs(Math.asin(right.y) * DEG));
    });
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(run.rig.camera.quaternion);
    expect(right.y).toBeGreaterThan(0); // right turn: camera's right side up, left side down (outward lean)
    expect(maxRoll).toBeGreaterThan(1);
    expect(maxRoll).toBeLessThanOrEqual(CHASE_ROLL_MAX_DEG + 1e-6);
  });

  test('teleports snap cleanly: rest distance, no roll', () => {
    const run: Run = { rig: new CameraRig(), c: ctx(false), state: car({}) };
    drive(run, 'chase', 1, 60, (t) => {
      const k = kin(80, -4 * G, t);
      return { z: k.s, yaw: -0.6 * t, speed: k.v };
    });
    expect(flatDist(run.rig, run.state)).toBeLessThan(chaseBase(run.state.speed) - 0.05);
    run.c.time += 1 / 60;
    run.state = car({ x: 500, z: 500, yaw: 1, speed: 30 });
    run.rig.update('chase', false, 0, run.state, 16 / 9, 1 / 60, run.c);
    expect(flatDist(run.rig, run.state)).toBeCloseTo(chaseBase(30), 9);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(run.rig.camera.quaternion);
    expect(Math.abs(right.y)).toBeLessThan(1e-9);
  });
});

describe('in-car cameras', () => {
  /** Eye position with no head movement for a car at the origin, yaw 0. */
  const restEye = (mode: CameraMode): THREE.Vector3 => (mode === 'cockpit' ? new THREE.Vector3(0, dims.eyeY, dims.eyeZ) : new THREE.Vector3(0, 1.2, -0.62));

  for (const mode of ['cockpit', 'tcam'] as const) {
    test(`${mode}: head moves ≤ 3 cm and tilts ≤ 1.5° under extreme g, forward + down when braking`, () => {
      const run: Run = { rig: new CameraRig(), c: ctx(false), state: car({}) };
      let maxOffset = 0;
      let maxPitch = 0;
      let maxRoll = 0;
      // 6 g braking while rotating hard to the right; the car is re-centred so only the head offset remains
      drive(run, mode, 1.5, 60, (t) => ({ speed: Math.max(0, 90 - 6 * G * t), yaw: -1.2 * t }), 0, () => {
        const yaw = run.state.yaw;
        const local = run.rig.camera.position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
        maxOffset = Math.max(maxOffset, local.distanceTo(restEye(mode)));
        const q = run.rig.camera.quaternion.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw));
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        const restPitch = mode === 'cockpit' ? Math.atan2(-0.12, 12 - dims.eyeZ) : Math.atan2(0.95 - 1.2, 14 + 0.62);
        maxPitch = Math.max(maxPitch, Math.abs(Math.asin(fwd.y) - restPitch) * DEG);
        maxRoll = Math.max(maxRoll, Math.abs(Math.asin(right.y)) * DEG);
      });
      expect(maxOffset).toBeGreaterThan(0.01);
      expect(maxOffset).toBeLessThanOrEqual(HEAD_MAX_OFFSET + 0.002);
      expect(maxPitch).toBeGreaterThan(0.5);
      expect(maxPitch).toBeLessThanOrEqual(HEAD_MAX_ANGLE_DEG + 0.05);
      expect(maxRoll).toBeGreaterThan(0.5);
      expect(maxRoll).toBeLessThanOrEqual(HEAD_MAX_ANGLE_DEG + 0.05);
    });
  }

  test('cockpit head goes forward under braking (along the nose)', () => {
    const run: Run = { rig: new CameraRig(), c: ctx(false), state: car({}) };
    drive(run, 'cockpit', 1, 60, (t) => ({ speed: Math.max(0, 90 - 4 * G * t) }));
    expect(run.rig.camera.position.z).toBeGreaterThan(dims.eyeZ + 0.01);
  });

  test('nose camera has no head movement', () => {
    const run: Run = { rig: new CameraRig(), c: ctx(false), state: car({}) };
    drive(run, 'nose', 0.5, 60, () => ({ speed: 50 }));
    const rest = run.rig.camera.position.clone();
    drive(run, 'nose', 1, 60, (t) => ({ speed: Math.max(0, 50 - 5 * G * (t - 0.5)) }), 0.5);
    expect(run.rig.camera.position.distanceTo(rest)).toBeLessThan(1e-9);
  });
});
