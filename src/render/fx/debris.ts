/**
 * Crash debris: carbon shards that fly off a car on a hard impact (rising edge of CarRenderState.impact, as the
 * impact spark burst) and larger livery-coloured wing pieces when a front / rear wing breaks off (damage crossing the
 * carDamage break levels). Pieces tumble, bounce on the road (the height the car had when they came off), come to rest
 * and lie there for a while before shrinking away. One pooled InstancedMesh, integrated on the render step.
 */
import * as THREE from 'three';
import type { CarRenderState } from '../../core/types';
import { clamp, smoothstep } from '../../core/math';
import type { CarDims } from '../car/dims';
import { FRONT_WING_BREAK, REAR_WING_BREAK } from '../car/carDamage';
import { Rng } from '../core/canvas';

/** Impact impulse (and its rise within one frame) that throws debris; shards per impulse unit, min / max per hit. */
export const DEBRIS_IMPACT = { min: 500, rise: 300, perImpulse: 1 / 220, minCount: 4, maxCount: 16 } as const;
/** Seconds a shard / a wing piece stays (the last second it shrinks away). */
export const DEBRIS_LIFE = { shard: 9, piece: 24 } as const;
const GRAVITY = 9.81;
const BOUNCE = 0.3;
/** Horizontal speed kept per bounce, and the sliding deceleration rate (1/s) while a piece scrapes along the road. */
const GROUND_FRICTION = 0.5;
const SLIDE_DECAY = 3.5;
/** Share of shards in the livery colour (painted bodywork) rather than bare carbon. */
const LIVERY_SHARE = 0.35;
const CARBON = new THREE.Color('#202227');

interface CarMemory {
  impact: number;
  front: number;
  rear: number;
}

export class DebrisFx {
  readonly mesh: THREE.InstancedMesh;
  private readonly size: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly scale: Float32Array;
  private readonly floor: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly resting: Uint8Array;
  private next = 0;
  private active = 0;
  private readonly memory = new Map<number, CarMemory>();
  private readonly rng = new Rng(9091);
  private readonly colors: Map<number, THREE.Color>;
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly material = new THREE.MeshStandardMaterial({ name: 'debris', roughness: 0.42, metalness: 0.25 });
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  /** `liveries` = primary livery colour per car id (wing pieces). */
  constructor(poolSize: number, private readonly dims: CarDims, liveries: Map<number, string>) {
    this.size = Math.max(8, Math.floor(Number.isFinite(poolSize) ? poolSize : 64));
    const n = this.size;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.rot = new Float32Array(n * 3);
    this.spin = new Float32Array(n * 3);
    this.scale = new Float32Array(n * 3);
    this.floor = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.resting = new Uint8Array(n);
    this.colors = new Map([...liveries].map(([id, c]) => [id, new THREE.Color(c)]));
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, n);
    this.mesh.name = 'debris';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // pieces spread over the whole circuit: the pool is small, cull per instance is not worth a bounding sphere
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (let i = 0; i < n; i++) this.mesh.setColorAt(i, CARBON);
  }

  /** Watch every car for hard impacts / broken wings, then move the pieces (`dt` s). */
  update(cars: readonly CarRenderState[], dtIn: number): void {
    const dt = Number.isFinite(dtIn) ? clamp(dtIn, 0, 0.1) : 0;
    for (const c of cars) {
      if (c.ghost || c.carId < 0 || !Number.isFinite(c.x) || !Number.isFinite(c.z) || !Number.isFinite(c.yaw)) continue;
      const impact = Number.isFinite(c.impact) ? Math.max(0, c.impact) : 0;
      const front = Number.isFinite(c.damage?.frontWing) ? c.damage.frontWing : 0;
      const rear = Number.isFinite(c.damage?.rearWing) ? c.damage.rearWing : 0;
      const mem = this.memory.get(c.carId);
      if (!mem) {
        // first sight (scene start, joining online): no burst for damage the car already had
        this.memory.set(c.carId, { impact, front, rear });
        continue;
      }
      if (c.visible && dt > 0) {
        if (impact > DEBRIS_IMPACT.min && impact - mem.impact > DEBRIS_IMPACT.rise) {
          this.burst(c, Math.round(clamp(impact * DEBRIS_IMPACT.perImpulse, DEBRIS_IMPACT.minCount, DEBRIS_IMPACT.maxCount)), 0, 0.25);
        }
        if (front > FRONT_WING_BREAK && mem.front <= FRONT_WING_BREAK) this.wingBreak(c, this.dims.frontWingZ1 - 0.25, 0.12, this.dims.frontWingHalfSpan);
        if (rear > REAR_WING_BREAK && mem.rear <= REAR_WING_BREAK) this.wingBreak(c, this.dims.rearWingZ0 + 0.2, 0.85, this.dims.rearWingHalfSpan);
      }
      mem.impact = impact;
      mem.front = front;
      mem.rear = rear;
    }
    this.integrate(dt);
  }

  /** Remove every piece and forget the cars (flashback / replay seek). */
  reset(): void {
    this.memory.clear();
    this.age.fill(0);
    this.life.fill(0);
    this.active = 0;
    this.next = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }

  /** `count` shards (bare carbon, some painted) from around the car body (forward offset `along`, height `up`). */
  private burst(c: CarRenderState, count: number, along: number, up: number): void {
    const livery = this.colors.get(c.carId) ?? CARBON;
    for (let k = 0; k < count; k++) {
      const big = this.rng.next() < 0.25;
      const w = this.rng.range(0.08, big ? 0.42 : 0.2);
      const col = this.rng.next() < LIVERY_SHARE ? livery : CARBON;
      this.spawn(c, along + this.rng.range(-1.6, 1.6), this.rng.range(-0.8, 0.8), up + this.rng.range(0, 0.3), w, 0.015, w * this.rng.range(0.4, 0.9), col, DEBRIS_LIFE.shard, 0.45);
    }
  }

  /** A wing coming off: one large livery-coloured piece, an endplate and a handful of shards at that wing. */
  private wingBreak(c: CarRenderState, along: number, up: number, halfSpan: number): void {
    const col = this.colors.get(c.carId) ?? CARBON;
    const side = this.rng.next() < 0.5 ? 1 : -1;
    this.spawn(c, along, side * halfSpan * 0.55, up, halfSpan * 0.8, 0.025, 0.24, col, DEBRIS_LIFE.piece, 0.35);
    this.spawn(c, along, side * halfSpan * 0.95, up + 0.05, 0.03, 0.22, 0.3, CARBON, DEBRIS_LIFE.piece, 0.4);
    this.burst(c, 6, along, up);
  }

  private spawn(c: CarRenderState, along: number, right: number, up: number, sx: number, sy: number, sz: number, color: THREE.Color, life: number, carry: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.size;
    this.active = Math.max(this.active, i + 1);
    const fx = Math.sin(c.yaw);
    const fz = Math.cos(c.yaw);
    const rx = -fz;
    const rz = fx;
    const y = Number.isFinite(c.y) ? c.y : 0;
    const speed = Number.isFinite(c.speed) ? c.speed : 0;
    const o = i * 3;
    this.pos[o] = c.x + fx * along + rx * right;
    this.pos[o + 1] = y + up;
    this.pos[o + 2] = c.z + fz * along + rz * right;
    // keeps part of the car's speed, flung outward and up
    const a = this.rng.next() * Math.PI * 2;
    const out = this.rng.range(1.5, 6.5);
    this.vel[o] = fx * speed * carry + Math.cos(a) * out;
    this.vel[o + 1] = this.rng.range(1.2, 4.8);
    this.vel[o + 2] = fz * speed * carry + Math.sin(a) * out;
    for (let k = 0; k < 3; k++) {
      this.rot[o + k] = this.rng.next() * Math.PI * 2;
      this.spin[o + k] = this.rng.range(-14, 14);
    }
    this.scale[o] = sx;
    this.scale[o + 1] = sy;
    this.scale[o + 2] = sz;
    this.floor[i] = y + 0.01;
    this.age[i] = 0;
    this.life[i] = life;
    this.resting[i] = 0;
    this.mesh.setColorAt(i, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private integrate(dt: number): void {
    if (this.active === 0) return;
    let last = -1;
    for (let i = 0; i < this.active; i++) {
      const o = i * 3;
      if (this.life[i] <= 0) {
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
        continue;
      }
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
        continue;
      }
      last = i;
      if (!this.resting[i] && dt > 0) {
        this.vel[o + 1] -= GRAVITY * dt;
        for (let k = 0; k < 3; k++) {
          this.pos[o + k] += this.vel[o + k] * dt;
          this.rot[o + k] += this.spin[o + k] * dt;
        }
        // scraping along the road between bounces
        if (this.pos[o + 1] <= this.floor[i] + 0.02) {
          const k = Math.exp(-SLIDE_DECAY * dt);
          this.vel[o] *= k;
          this.vel[o + 2] *= k;
        }
        if (this.pos[o + 1] < this.floor[i]) {
          this.pos[o + 1] = this.floor[i];
          this.vel[o + 1] = -this.vel[o + 1] * BOUNCE;
          this.vel[o] *= GROUND_FRICTION;
          this.vel[o + 2] *= GROUND_FRICTION;
          for (let k = 0; k < 3; k++) this.spin[o + k] *= 0.5;
          if (Math.abs(this.vel[o + 1]) < 0.6 && Math.hypot(this.vel[o], this.vel[o + 2]) < 0.4) {
            // settle flat on the road
            this.resting[i] = 1;
            this.rot[o] = 0;
            this.rot[o + 2] = 0;
          }
        }
      }
      const fade = 1 - smoothstep(this.life[i] - 1, this.life[i], this.age[i]);
      this.e.set(this.rot[o], this.rot[o + 1], this.rot[o + 2]);
      this.q.setFromEuler(this.e);
      this.p.set(this.pos[o], this.pos[o + 1] + this.scale[o + 1] * 0.5, this.pos[o + 2]);
      this.s.set(this.scale[o] * fade, this.scale[o + 1] * fade, this.scale[o + 2] * fade);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.active = last + 1;
    if (this.active === 0) this.next = 0;
    this.mesh.count = this.active;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
