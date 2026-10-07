/**
 * Per-view camera rig. Modes: chase (≈7 m behind, 2.2 m up, damped), chaseFar, tcam (above the airbox),
 * cockpit (driver eye: halo + steering wheel visible), nose, tv (nearest trackside spot ahead of the
 * target, zoomed to frame the car) and lookBack. Speed-dependent FOV (+≤ 8°), optional shake, and a hard
 * snap whenever the target jumps > 30 m, the target / mode changes (flashback, pit, replay seek).
 *
 * Driving feel (all frame-rate independent, reset on every snap): longitudinal / lateral g are estimated from the
 * target's speed and yaw over simulation time and filtered by critically damped springs. Chase cams move the car a
 * few % within the frame under hard acceleration / braking (the follow distance only grows while the camera stays
 * inside the barrier), look slightly into the corner (yaw rate + steer) and roll ≤ 2° with lateral g. Cockpit /
 * T-cam get a small head movement (≤ 3 cm, ≤ 1.5°).
 */
import * as THREE from 'three';
import type { BuiltTrack, CameraMode, CarRenderState, Settings, SurfaceKind } from '../core/types';
import { G, angleDiff, clamp, damp, smoothstep } from '../core/math';
import type { CarDims } from './car/dims';
import { CAMERA_FAR } from './core/quality';
import type { TvSpot } from './track/trackside';
import type { TrackFrame } from './track/trackFrame';

export interface RigContext {
  settings: Settings;
  time: number;
  dims: CarDims;
  track: BuiltTrack | null;
  frame: TrackFrame | null;
  tvSpots: TvSpot[];
  /** tunnel spans [s0, s1] (m); a car inside one is covered from inside the tunnel, never by an outside TV spot */
  tunnels?: { s0: number; s1: number }[];
}

// ───────────── tunables: driving feel ─────────────
/** Chase follow distance change per g of longitudinal acceleration (fraction of the distance; + = farther). */
export const CHASE_SPRING_PER_G = 0.02;
/** Largest chase distance change (fraction of the follow distance), soft-saturated. */
export const CHASE_SPRING_MAX = 0.05;
/** Natural frequency (rad/s) of the critically damped chase-cam g springs (higher = snappier). */
export const CHASE_SPRING_OMEGA = 6;
/** Largest chase look-ahead rotation toward the corner (degrees). */
export const CHASE_LOOK_AHEAD_MAX_DEG = 4.5;
/** Yaw rate (rad/s) that gives the full look-ahead. */
export const CHASE_LOOK_AHEAD_FULL_YAW_RATE = 0.8;
/** Front-wheel steer angle (rad) that gives the full steer share of the look-ahead. */
export const CHASE_LOOK_AHEAD_FULL_STEER = 0.2;
/** Share (0..1) of the look-ahead driven by steer instead of yaw rate (steer leads the yaw slightly). */
export const CHASE_LOOK_AHEAD_STEER_MIX = 0.3;
/** Exponential smoothing rate (1/s) of the look-ahead. */
export const CHASE_LOOK_AHEAD_RATE = 2.5;
/** Chase-cam roll per g of lateral acceleration (degrees; + = lean to the outside like body roll). */
export const CHASE_ROLL_PER_G = 0.6;
/** Largest chase-cam roll (degrees), soft-saturated. */
export const CHASE_ROLL_MAX_DEG = 2;
/** Cockpit / T-cam head translation per g (m) and its soft-saturated maximum (m). */
export const HEAD_OFFSET_PER_G = 0.008;
export const HEAD_MAX_OFFSET = 0.03;
/** Cockpit / T-cam head pitch / roll per g (degrees) and its soft-saturated maximum (degrees). */
export const HEAD_ANGLE_PER_G = 0.4;
export const HEAD_MAX_ANGLE_DEG = 1.5;
/** Natural frequency (rad/s) of the critically damped in-car g springs. */
export const HEAD_SPRING_OMEGA = 10;
/** Raw g estimates are clamped to this before filtering (collisions produce huge one-step spikes). */
const G_ESTIMATE_LIMIT = 6;
const YAW_RATE_LIMIT = 3;
/** Simulation-time gaps above this (s) are not differentiated (seek / stall): the estimate is held. */
const MAX_SIM_GAP = 0.5;
/** The chase spring may only lengthen the follow distance while the camera stays this far (m) inside the barrier. */
const CHASE_WALL_MARGIN = 0.4;

const NEAR: Record<CameraMode, number> = { chase: 0.2, chaseFar: 0.25, tcam: 0.08, cockpit: 0.04, nose: 0.03, tv: 0.5 };
/**
 * Nose camera mount height: ~10–12 cm above the nose skin under it (skin ≈ 0.62–0.63 m at z 1.2–1.25), so neither
 * the near plane nor the in-car shake (≤ ±5 cm on gravel) can put the camera inside the nose.
 */
const NOSE_CAM_Y = 0.74;
const SURFACE_SHAKE: Record<SurfaceKind, number> = { asphalt: 0, pitlane: 0, kerb: 0.022, runoff: 0.006, grass: 0.03, gravel: 0.05 };
const DEG = Math.PI / 180;

/** State of a critically damped spring (value + velocity). */
export interface Spring {
  x: number;
  v: number;
}

/** Exact critically damped spring step toward a target held constant over `dt` (frame-rate independent, never rings). */
export function springStep(s: Spring, target: number, omega: number, dt: number): void {
  if (!(dt > 0) || !(omega > 0) || !Number.isFinite(target)) return;
  const c0 = s.x - target;
  const k = s.v + omega * c0;
  const e = Math.exp(-omega * dt);
  s.x = target + (c0 + k * dt) * e;
  s.v = (s.v - omega * k * dt) * e;
}

/** Soft saturation: ≈ value·perUnit for small values, never beyond ±max. */
export function saturate(value: number, perUnit: number, max: number): number {
  if (!Number.isFinite(value) || !(max > 0)) return 0;
  return max * Math.tanh((value * perUnit) / max);
}

/** Look-ahead turn signal −1..1 (+ = the car is turning right), from yaw rate (rad/s) and front-wheel steer (rad, + right). */
export function lookAheadSignal(yawRate: number, steerAngle: number, speed: number): number {
  const rate = Number.isFinite(yawRate) ? clamp(-yawRate / CHASE_LOOK_AHEAD_FULL_YAW_RATE, -1, 1) : 0;
  const steer = Number.isFinite(steerAngle) ? clamp(steerAngle / CHASE_LOOK_AHEAD_FULL_STEER, -1, 1) : 0;
  const mix = clamp(CHASE_LOOK_AHEAD_STEER_MIX, 0, 1);
  // no looking around while stationary on the grid / in the pit box
  return (rate * (1 - mix) + steer * mix) * smoothstep(3, 15, Number.isFinite(speed) ? speed : 0);
}

const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3();
const _look = new THREE.Vector3();

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** world-space camera velocity (m/s), for rain slant / audio */
  readonly velocity = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly lastTarget = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private camYaw = 0;
  private fov = 68;
  private hasState = false;
  private mode: CameraMode = 'chase';
  private lookBack = false;
  private carId = Number.NaN;
  private hint = -1;
  private wallHint = -1;
  private tvIndex = -1;
  /** target speed / yaw at the previous simulation time, for the g estimate */
  private prevSimTime = Number.NaN;
  private prevSpeed = 0;
  private prevYaw = 0;
  private rawGLong = 0;
  private rawGLat = 0;
  private yawRate = 0;
  /** spring-filtered g (long + = accelerating, lat + = toward the right) */
  private readonly gLong: Spring = { x: 0, v: 0 };
  private readonly gLat: Spring = { x: 0, v: 0 };
  /** smoothed look-ahead turn signal (+ = right) */
  private lookTurn = 0;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.2, CAMERA_FAR);
    this.camera.rotation.order = 'YXZ';
  }

  /** Force the next update to snap instead of smoothing. */
  reset(): void {
    this.hasState = false;
    this.tvIndex = -1;
  }

  update(mode: CameraMode, lookBack: boolean, carId: number, target: CarRenderState | null, aspect: number, dtIn: number, ctx: RigContext): void {
    const cam = this.camera;
    const dt = Number.isFinite(dtIn) ? clamp(dtIn, 0, 0.1) : 0;
    const a = Number.isFinite(aspect) && aspect > 0.05 ? aspect : 16 / 9;
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.z)) {
      if (Math.abs(cam.aspect - a) > 1e-4) {
        cam.aspect = a;
        cam.updateProjectionMatrix();
      }
      return;
    }
    const tx = target.x;
    const ty = Number.isFinite(target.y) ? target.y : 0;
    const tz = target.z;
    const yaw = Number.isFinite(target.yaw) ? target.yaw : 0;
    const jump = _v.set(tx, ty, tz).distanceTo(this.lastTarget) > 30;
    let snap = !this.hasState || jump || mode !== this.mode || lookBack !== this.lookBack || carId !== this.carId;
    if (carId !== this.carId || jump) {
      this.hint = -1;
      this.wallHint = -1;
    }
    this.mode = mode;
    this.lookBack = lookBack;
    this.carId = carId;
    this.lastTarget.set(tx, ty, tz);
    const speed = Number.isFinite(target.speed) ? Math.max(0, target.speed) : 0;
    const baseFov = clamp(Number.isFinite(ctx.settings.fov) ? ctx.settings.fov : 68, 40, 100);
    const speedFov = 8 * smoothstep(25, 92, speed);
    let desiredFov = baseFov + speedFov;
    const d = ctx.dims;
    const effMode: CameraMode | 'back' = lookBack && mode !== 'tv' ? 'back' : mode;
    const inCar = effMode === 'cockpit' || effMode === 'tcam';
    this.trackDynamics(target, speed, yaw, ctx.time, snap, dt, inCar ? HEAD_SPRING_OMEGA : CHASE_SPRING_OMEGA);
    /** camera roll applied after lookAt (rad, + = right side down) and in-car head pitch (rad, + = nose up) */
    let roll = 0;
    let headPitch = 0;
    let lookYaw = 0;

    if (effMode === 'chase' || effMode === 'chaseFar' || effMode === 'back') {
      const far = effMode === 'chaseFar';
      const back = effMode === 'back';
      if (snap) this.camYaw = yaw;
      else this.camYaw += angleDiff(this.camYaw, yaw) * (1 - Math.exp(-(far ? 5 : 6.5) * dt));
      // distance is held in the car frame (no positional lag); the swing comes from the smoothed yaw
      const pull = back ? 0 : 0.6 * smoothstep(30, 90, speed);
      const baseDist = back ? -3.9 : (far ? 11 : 7) + pull;
      const height = back ? 1.9 : far ? 3.6 : 2.2;
      _f.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
      let dist = baseDist;
      if (!back) {
        dist = baseDist * (1 + saturate(this.gLong.x, CHASE_SPRING_PER_G, CHASE_SPRING_MAX));
        // a shorter distance stays on the car→camera segment; a longer one may only use the room the rest position
        // has inside the barrier (continuous, so the camera never pops at the limit)
        if (dist > baseDist) dist = Math.min(dist, baseDist + this.barrierRoom(tx - _f.x * baseDist, tz - _f.z * baseDist, ctx.frame));
        lookYaw = -this.lookTurn * CHASE_LOOK_AHEAD_MAX_DEG * DEG;
        roll = -saturate(this.gLat.x, CHASE_ROLL_PER_G * DEG, CHASE_ROLL_MAX_DEG * DEG);
      }
      this.pos.x = tx - _f.x * dist;
      this.pos.z = tz - _f.z * dist;
      this.pos.y = snap ? ty + height : damp(this.pos.y, ty + height, 9, dt);
      this.pos.y = Math.max(this.pos.y, ty + 0.6);
      const ahead = back ? -14 : far ? 6 : 5;
      const lookH = back ? 0.8 : far ? 1.2 : 1.0;
      _w.set(tx + Math.sin(yaw) * ahead, ty + lookH, tz + Math.cos(yaw) * ahead);
      if (snap) this.look.copy(_w);
      else this.look.lerp(_w, 1 - Math.exp(-16 * dt));
      if (back) desiredFov = baseFov;
      cam.up.set(0, 1, 0);
    } else if (effMode === 'tcam' || effMode === 'cockpit' || effMode === 'nose') {
      const pitch = Number.isFinite(target.pitch) ? target.pitch : 0;
      const carRoll = Number.isFinite(target.roll) ? target.roll : 0;
      const k = effMode === 'tcam' ? 0.5 : 1;
      _e.set(-pitch * k, yaw, carRoll * k, 'YXZ');
      _q.setFromEuler(_e);
      const local =
        effMode === 'cockpit' ? _w.set(0, d.eyeY, d.eyeZ) : effMode === 'nose' ? _w.set(0, NOSE_CAM_Y, Math.min(1.25, d.frontAxleZ - 0.5)) : _w.set(0, 1.2, -0.62);
      if (inCar) {
        // head pushed back under acceleration / forward under braking, to the outside in corners (local +X = car's left)
        const hx = saturate(this.gLat.x, HEAD_OFFSET_PER_G, HEAD_MAX_OFFSET);
        const hz = -saturate(this.gLong.x, HEAD_OFFSET_PER_G, HEAD_MAX_OFFSET);
        const scale = Math.min(1, HEAD_MAX_OFFSET / Math.max(1e-9, Math.hypot(hx, hz)));
        local.x += hx * scale;
        local.z += hz * scale;
        headPitch = saturate(this.gLong.x, HEAD_ANGLE_PER_G * DEG, HEAD_MAX_ANGLE_DEG * DEG);
        roll = -saturate(this.gLat.x, HEAD_ANGLE_PER_G * DEG, HEAD_MAX_ANGLE_DEG * DEG);
      }
      this.pos.copy(local.applyQuaternion(_q)).add(_v.set(tx, ty, tz));
      const lookLocal = effMode === 'cockpit' ? _w.set(0, d.eyeY - 0.12, 12) : effMode === 'nose' ? _w.set(0, 0.45, 14) : _w.set(0, 0.95, 14);
      this.look.copy(lookLocal.applyQuaternion(_q)).add(_v.set(tx, ty, tz));
      cam.up.copy(_up.set(0, 1, 0).applyQuaternion(_q));
      if (effMode === 'cockpit') desiredFov += 2;
      this.camYaw = yaw;
    } else {
      // tv: trackside cameras
      const covered = this.inTunnel(tx, tz, ctx);
      const spot = covered ? null : this.pickTvSpot(tx, tz, ctx, snap);
      if (spot) {
        if (this.pos.distanceToSquared(spot.position) > 1) snap = true;
        this.pos.copy(spot.position);
      } else if (covered) {
        // inside the tunnel box (ceiling ≈ 7 m): low, close follow position
        this.pos.set(tx - Math.sin(yaw) * 14 + Math.cos(yaw) * 2, ty + 3.4, tz - Math.cos(yaw) * 14 - Math.sin(yaw) * 2);
      } else {
        _w.set(tx - Math.sin(yaw) * 18 + Math.cos(yaw) * 10, ty + 9, tz - Math.cos(yaw) * 18 - Math.sin(yaw) * 10);
        this.pos.copy(_w);
      }
      _w.set(tx + Math.sin(yaw) * Math.min(6, speed * 0.08), ty + 0.6, tz + Math.cos(yaw) * Math.min(6, speed * 0.08));
      if (snap) this.look.copy(_w);
      else this.look.lerp(_w, 1 - Math.exp(-12 * dt));
      const dist = Math.max(1, this.pos.distanceTo(this.look));
      desiredFov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(5.5 / dist)), 5, 55);
      cam.up.set(0, 1, 0);
      this.camYaw = yaw;
    }

    // optional shake (speed, surface, impacts); never for tv
    if (ctx.settings.cameraShake && mode !== 'tv') {
      const surf = SURFACE_SHAKE[target.surface] ?? 0;
      const imp = Number.isFinite(target.impact) ? clamp(target.impact / 3000, 0, 1) * 0.1 : 0;
      const shakeInCar = effMode === 'cockpit' || effMode === 'nose' || effMode === 'tcam';
      const amp = (smoothstep(55, 92, speed) * (shakeInCar ? 0.006 : 0.012) + surf * smoothstep(3, 20, speed) + imp) * (shakeInCar ? 0.6 : 1);
      if (amp > 1e-5) {
        const t = ctx.time;
        this.pos.x += amp * (Math.sin(t * 37.1) + 0.5 * Math.sin(t * 71.3 + 1.3));
        this.pos.y += amp * (Math.sin(t * 43.7 + 0.7) + 0.5 * Math.sin(t * 89.1 + 2.1));
        this.pos.z += amp * (Math.sin(t * 29.3 + 2.9) + 0.5 * Math.sin(t * 67.9 + 0.4));
      }
    }

    if (snap) this.fov = desiredFov;
    else this.fov = damp(this.fov, desiredFov, mode === 'tv' ? 5 : 3, dt);
    const near = NEAR[mode] ?? 0.2;
    if (cam.fov !== this.fov || cam.aspect !== a || cam.near !== near) {
      cam.fov = this.fov;
      cam.aspect = a;
      cam.near = near;
      cam.far = CAMERA_FAR;
      cam.updateProjectionMatrix();
    }
    cam.position.copy(this.pos);
    cam.lookAt(this.lookTarget(lookYaw));
    if (headPitch !== 0) cam.rotateX(headPitch);
    if (roll !== 0) cam.rotateZ(-roll);
    cam.updateMatrixWorld();
    if (snap || dt <= 0) this.velocity.set(0, 0, 0);
    else this.velocity.subVectors(this.pos, this.prevPos).divideScalar(dt).clampLength(0, 150);
    this.prevPos.copy(this.pos);
    this.hasState = true;
  }

  /**
   * g estimate from the target's speed / yaw over SIMULATION time (exact for any number of sim steps per frame;
   * held while paused), then critically damped springs over render time. Snaps reset everything to rest.
   */
  private trackDynamics(target: CarRenderState, speed: number, yaw: number, simTime: number, snap: boolean, dt: number, omega: number): void {
    const time = Number.isFinite(simTime) ? simTime : 0;
    if (snap) {
      this.rawGLong = 0;
      this.rawGLat = 0;
      this.yawRate = 0;
      this.gLong.x = this.gLong.v = 0;
      this.gLat.x = this.gLat.v = 0;
      this.lookTurn = 0;
    } else {
      const simDt = time - this.prevSimTime;
      if (simDt > 1e-6 && simDt <= MAX_SIM_GAP) {
        this.yawRate = clamp(angleDiff(this.prevYaw, yaw) / simDt, -YAW_RATE_LIMIT, YAW_RATE_LIMIT);
        this.rawGLong = clamp((speed - this.prevSpeed) / simDt / G, -G_ESTIMATE_LIMIT, G_ESTIMATE_LIMIT);
        // centripetal acceleration v·ω points to the right when turning right (yaw rate < 0)
        this.rawGLat = clamp((-this.yawRate * speed) / G, -G_ESTIMATE_LIMIT, G_ESTIMATE_LIMIT);
      }
      springStep(this.gLong, this.rawGLong, omega, dt);
      springStep(this.gLat, this.rawGLat, omega, dt);
      this.lookTurn = damp(this.lookTurn, lookAheadSignal(this.yawRate, target.steerAngle, speed), CHASE_LOOK_AHEAD_RATE, dt);
    }
    this.prevSimTime = time;
    this.prevSpeed = speed;
    this.prevYaw = yaw;
  }

  /** Distance (m) the point lies inside the visual barrier, minus CHASE_WALL_MARGIN; 0 when outside or no track frame. */
  private barrierRoom(x: number, z: number, frame: TrackFrame | null): number {
    if (!frame || frame.n === 0) return 0;
    const near = frame.nearest(x, z, this.wallHint >= 0 ? this.wallHint : undefined);
    this.wallHint = near.index;
    return Math.max(0, frame.barrierAt(near.index, near.lateral) - Math.abs(near.lateral) - CHASE_WALL_MARGIN);
  }

  /** The smoothed look point, turned about the camera by `yawOffset` (rad, − = to the right) for the chase look-ahead. */
  private lookTarget(yawOffset: number): THREE.Vector3 {
    if (yawOffset === 0) return _look.copy(this.look);
    const dx = this.look.x - this.pos.x;
    const dz = this.look.z - this.pos.z;
    const c = Math.cos(yawOffset);
    const s = Math.sin(yawOffset);
    return _look.set(this.pos.x + dx * c + dz * s, this.look.y, this.pos.z + dz * c - dx * s);
  }

  /** True when the car is inside a tunnel: the fixed outside spots would film the roof, so the tv view falls back to a close follow cam. */
  private inTunnel(x: number, z: number, ctx: RigContext): boolean {
    const tunnels = ctx.tunnels;
    const t = ctx.track;
    const f = ctx.frame;
    if (!tunnels || tunnels.length === 0 || !t || !f || t.length <= 0) return false;
    const near = f.nearest(x, z, this.hint >= 0 ? this.hint : undefined);
    this.hint = near.index;
    const s = t.s[near.index] ?? 0;
    return tunnels.some((tn) => (((s - tn.s0) % t.length) + t.length) % t.length <= (((tn.s1 - tn.s0) % t.length) + t.length) % t.length);
  }

  private pickTvSpot(x: number, z: number, ctx: RigContext, snap: boolean): TvSpot | null {
    const spots = ctx.tvSpots;
    const t = ctx.track;
    const f = ctx.frame;
    if (!t || !f || spots.length === 0 || t.length <= 0) return null;
    const near = f.nearest(x, z, this.hint >= 0 ? this.hint : undefined);
    this.hint = near.index;
    const carS = t.s[near.index] ?? 0;
    const L = t.length;
    const ahead = (from: number, to: number): number => (((to - from) % L) + L) % L;
    if (snap || this.tvIndex < 0 || this.tvIndex >= spots.length) {
      let best = 0;
      let bestD = Infinity;
      spots.forEach((sp, i) => {
        const dd = ahead(carS, sp.s);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      });
      // prefer the spot just passed if the next one is very far away
      const prev = (best - 1 + spots.length) % spots.length;
      if (bestD > 420 && ahead(spots[prev].s, carS) < 120) best = prev;
      this.tvIndex = best;
    } else {
      const cur = spots[this.tvIndex];
      const past = ahead(cur.s, carS);
      if (past > 60 && past < L / 2) this.tvIndex = (this.tvIndex + 1) % spots.length;
    }
    return spots[this.tvIndex] ?? null;
  }
}
