/**
 * Car-driven effects: tyre smoke on wheelspin / lockups, wet-road spray behind fast cars, off-track
 * dust, impact spark bursts, skid-block sparks at very high speed and (dusk / night) bright floor-spark bursts
 * when a very fast car strikes a kerb or a track bump. Emission is budgeted by pool size, limited to cars near a
 * camera, and allocation-free per frame (one reused EmitParams, inline car-to-world transforms).
 */
import * as THREE from 'three';
import type { Biome, CarRenderState, TimeOfDay } from '../../core/types';
import { clamp01, smoothstep } from '../../core/math';
import { Rng } from '../core/canvas';
import type { CarDims } from '../car/dims';
import {
  bumpCellOf,
  floorSparkIntensity,
  floorStrikes,
  refillBurstBudget,
  takeBurst,
  FLOOR_SPARK,
  FLOOR_SPARK_HOT,
  FLOOR_SPARK_LIGHT,
  FLOOR_SPARK_WARM,
  type BurstBudget,
} from './floorSparks';
import { ParticlePool, type EmitParams } from './particles';

interface Accum {
  smoke: number;
  spray: number;
  dust: number;
  skid: number;
  prevImpact: number;
  /** time until this car may emit its next floor-spark burst (s) */
  floorCd: number;
  /** bump grid cell the car was in last frame */
  cellX: number;
  cellZ: number;
}

const SMOKE = new THREE.Color(0.8, 0.8, 0.82);
const SPRAY = new THREE.Color(0.66, 0.69, 0.74);
/** Wet-road spray: particles per second at full wetness / speed, per-particle opacity (base + wetness share), growth. */
const SPRAY_RATE = 58;
const SPRAY_ALPHA_BASE = 0.07;
const SPRAY_ALPHA_WET = 0.12;
const SPRAY_GROWTH = 3.6;
/**
 * Tyre smoke (wheelspin / lock-up): real F1 starts and lock-ups leave only a thin, short-lived haze, so the cloud
 * stays light enough to see the cars ahead through it (the grid launch used to hide them in one white mass).
 */
export const TYRE_SMOKE = { slipMin: 0.45, rate: 16, size: 0.45, growth: 1.3, lifeMin: 0.5, lifeMax: 0.95, alphaBase: 0.05, alphaSlip: 0.1 } as const;
const SPARK = new THREE.Color(1.0, 0.62, 0.22);
const SPARK_HOT = new THREE.Color(1.0, 0.85, 0.5);
/** cars farther than this from every camera emit nothing (m) */
const EMIT_RANGE = 260;
/** spark pool size at which floor bursts reach FLOOR_SPARK.perBurst */
const FLOOR_SPARK_FULL_POOL = 192;

export class CarEffects {
  readonly smoke: ParticlePool;
  readonly sparks: ParticlePool;
  private readonly acc = new Map<number, Accum>();
  private readonly rng = new Rng(4242);
  private readonly dust: THREE.Color;
  private readonly gravelDust = new THREE.Color(0.72, 0.68, 0.6);
  private readonly tmpColor = new THREE.Color();
  /** reused for every emission (emit() copies the values) */
  private readonly ep: EmitParams = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0, growth: 0, life: 0, alpha: 0, color: SMOKE, gravity: 0, drag: 0 };
  /** floor-spark strength for this scene's time of day (0 = off) */
  private readonly floorLight: number;
  private readonly floorBudget: BurstBudget = { tokens: FLOOR_SPARK.burstBank };

  constructor(
    smokeCount: number,
    sparkCount: number,
    biome: Biome,
    private readonly dims: CarDims,
    timeOfDay: TimeOfDay = 'day',
  ) {
    this.smoke = new ParticlePool(smokeCount, false, 'smoke');
    this.sparks = new ParticlePool(sparkCount, true, 'sparks');
    this.dust = biome === 'desert' ? new THREE.Color(0.78, 0.64, 0.44) : biome === 'tropical' ? new THREE.Color(0.55, 0.38, 0.28) : new THREE.Color(0.5, 0.46, 0.36);
    this.floorLight = FLOOR_SPARK_LIGHT[timeOfDay] ?? 0;
  }

  /** Emit for every visible, non-ghost car within range of a camera, then integrate the pools. */
  update(cars: readonly CarRenderState[], cameras: readonly THREE.Vector3[], wetness: number, dtIn: number): void {
    const dt = Number.isFinite(dtIn) ? Math.max(0, Math.min(dtIn, 0.1)) : 0;
    let active = 0;
    for (let i = 0; i < cars.length; i++) if (cars[i].visible && !cars[i].ghost) active++;
    const budget = clamp01(this.smoke.poolSize / Math.max(1, Math.min(active, 8) * 70));
    const wet = clamp01(Number.isFinite(wetness) ? wetness : 0);
    refillBurstBudget(this.floorBudget, dt);
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.visible || c.ghost || c.carId < 0) continue;
      if (!Number.isFinite(c.x) || !Number.isFinite(c.z) || !Number.isFinite(c.yaw)) continue;
      let camD2 = Infinity;
      for (let k = 0; k < cameras.length; k++) {
        const dx = cameras[k].x - c.x;
        const dz = cameras[k].z - c.z;
        camD2 = Math.min(camD2, dx * dx + dz * dz);
      }
      const near = cameras.length === 0 || camD2 < EMIT_RANGE * EMIT_RANGE;
      let a = this.acc.get(c.carId);
      if (!a) {
        a = { smoke: 0, spray: 0, dust: 0, skid: 0, prevImpact: 0, floorCd: 0, cellX: bumpCellOf(c.x), cellZ: bumpCellOf(c.z) };
        this.acc.set(c.carId, a);
      }
      const impact = Number.isFinite(c.impact) ? Math.max(0, c.impact) : 0;
      const rising = impact - a.prevImpact;
      a.prevImpact = impact;
      const cellX = bumpCellOf(c.x);
      const cellZ = bumpCellOf(c.z);
      const enteredCell = cellX !== a.cellX || cellZ !== a.cellZ;
      a.cellX = cellX;
      a.cellZ = cellZ;
      a.floorCd = Math.max(0, a.floorCd - dt);
      if (!near || dt <= 0) continue;
      const speed = Number.isFinite(c.speed) ? Math.max(0, c.speed) : 0;
      // car axes on XZ: forward (fx, fz), right (rx, rz) = (-cos yaw, sin yaw)
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      const rx = -fz;
      const rz = fx;
      const y = Number.isFinite(c.y) ? c.y : 0;
      const ep = this.ep;

      // tyre smoke (wheelspin -> rear wheels, lockup -> front wheels)
      const onTarmac = c.surface === 'asphalt' || c.surface === 'kerb' || c.surface === 'pitlane' || c.surface === 'runoff';
      const slip = clamp01(Math.max(fin(c.slip), fin(c.lockup)));
      if (onTarmac && slip > TYRE_SMOKE.slipMin && speed > 3 && wet < 0.5) {
        a.smoke += TYRE_SMOKE.rate * ((slip - TYRE_SMOKE.slipMin) / (1 - TYRE_SMOKE.slipMin)) * budget * dt;
        const front = fin(c.lockup) > fin(c.slip);
        while (a.smoke >= 1) {
          a.smoke -= 1;
          const side = this.rng.next() < 0.5 ? 1 : -1;
          const lz = front ? this.dims.frontAxleZ : this.dims.rearAxleZ;
          // model +X is the car's left: right offset = -lx
          const right = -(front ? this.dims.frontHalfTrack : this.dims.rearHalfTrack) * side;
          ep.x = c.x + rx * right + fx * lz;
          ep.y = y + 0.18;
          ep.z = c.z + rz * right + fz * lz;
          ep.vx = fx * speed * 0.2 + this.rng.range(-0.8, 0.8);
          ep.vy = this.rng.range(0.3, 1.1);
          ep.vz = fz * speed * 0.2 + this.rng.range(-0.8, 0.8);
          ep.size = TYRE_SMOKE.size;
          ep.growth = TYRE_SMOKE.growth;
          ep.life = this.rng.range(TYRE_SMOKE.lifeMin, TYRE_SMOKE.lifeMax);
          ep.alpha = TYRE_SMOKE.alphaBase + TYRE_SMOKE.alphaSlip * slip;
          ep.color = SMOKE;
          ep.gravity = -0.35;
          ep.drag = 1.5;
          this.smoke.emit(ep);
        }
      } else a.smoke = 0;

      // spray on a wet track
      if (wet > 0.12 && speed > 15 && onTarmac) {
        a.spray += SPRAY_RATE * wet * smoothstep(15, 70, speed) * budget * dt;
        const back = this.dims.rearAxleZ - 0.5;
        while (a.spray >= 1) {
          a.spray -= 1;
          const lat = this.rng.range(-0.75, 0.75);
          ep.x = c.x + rx * lat + fx * back;
          ep.y = y + this.rng.range(0.2, 0.6);
          ep.z = c.z + rz * lat + fz * back;
          ep.vx = fx * speed * 0.55 + this.rng.range(-2, 2);
          ep.vy = this.rng.range(0.6, 2.2);
          ep.vz = fz * speed * 0.55 + this.rng.range(-2, 2);
          ep.size = 1.1;
          ep.growth = SPRAY_GROWTH;
          ep.life = this.rng.range(0.7, 1.15);
          ep.alpha = SPRAY_ALPHA_BASE + SPRAY_ALPHA_WET * wet;
          ep.color = SPRAY;
          ep.gravity = 1.2;
          ep.drag = 2.4;
          this.smoke.emit(ep);
        }
      } else a.spray = 0;

      // dust when running on grass / gravel
      if ((c.surface === 'grass' || c.surface === 'gravel') && speed > 6) {
        a.dust += 45 * smoothstep(6, 40, speed) * budget * (1 - wet * 0.8) * dt;
        const col = c.surface === 'gravel' ? this.gravelDust : this.dust;
        const lz = this.dims.rearAxleZ;
        while (a.dust >= 1) {
          a.dust -= 1;
          const side = this.rng.next() < 0.5 ? 1 : -1;
          const right = -this.dims.rearHalfTrack * side;
          ep.x = c.x + rx * right + fx * lz;
          ep.y = y + 0.25;
          ep.z = c.z + rz * right + fz * lz;
          ep.vx = fx * speed * 0.3 + this.rng.range(-1.5, 1.5);
          ep.vy = this.rng.range(0.8, 2.4);
          ep.vz = fz * speed * 0.3 + this.rng.range(-1.5, 1.5);
          ep.size = 0.8;
          ep.growth = 3;
          ep.life = this.rng.range(1.0, 1.6);
          ep.alpha = 0.32;
          ep.color = col;
          ep.gravity = 0.5;
          ep.drag = 1.3;
          this.smoke.emit(ep);
        }
      } else a.dust = 0;

      // impact spark burst (rising edge of the impact impulse)
      if (rising > 300 && impact > 500) {
        const count = Math.round(Math.min(40, Math.max(10, impact / 150)));
        for (let k = 0; k < count; k++) this.spark(c.x + fx * 1.6, y + 0.3, c.z + fz * 1.6, fx * speed * 0.5, fz * speed * 0.5, 4, 12);
      }
      // skid-block sparks at very high speed (dusk / night only: in daylight they were just pale dots over the road)
      if (speed > 74 && onTarmac && this.floorLight > 0) {
        a.skid += 22 * smoothstep(74, 92, speed) * this.floorLight * dt;
        const lz = this.dims.rearAxleZ + 0.3;
        while (a.skid >= 1) {
          a.skid -= 1;
          const lat = this.rng.range(-0.3, 0.3);
          this.spark(c.x + rx * lat + fx * lz, y + 0.04, c.z + rz * lat + fz * lz, fx * speed * 0.15, fz * speed * 0.15, 1.5, 5);
        }
      } else a.skid = 0;

      // floor sparks (dusk / night): the plank strikes a kerb or a bump at very high speed; rate-limited per car
      // (cooldown) and for the whole field (burst budget)
      if (this.floorLight > 0 && a.floorCd <= 0 && camD2 < FLOOR_SPARK.maxCameraDist * FLOOR_SPARK.maxCameraDist) {
        if (floorStrikes(c.surface, speed, enteredCell, cellX, cellZ) && takeBurst(this.floorBudget)) {
          a.floorCd = FLOOR_SPARK.carCooldown;
          const k = floorSparkIntensity(speed);
          const pool = clamp01(this.sparks.poolSize / FLOOR_SPARK_FULL_POOL);
          const n = Math.max(2, Math.round(FLOOR_SPARK.perBurst * this.floorLight * pool * (0.5 + 0.5 * k) * (1 - 0.6 * wet)));
          for (let s = 0; s < n; s++) this.floorSpark(c.x, y, c.z, fx, fz, rx, rz, speed);
        }
      }
    }
    this.smoke.update(dt);
    this.sparks.update(dt);
  }

  private spark(x: number, y: number, z: number, bvx: number, bvz: number, vMin: number, vMax: number): void {
    const v = this.rng.range(vMin, vMax);
    const th = this.rng.range(0, Math.PI * 2);
    const up = this.rng.range(0.15, 0.9);
    const ep = this.ep;
    ep.x = x;
    ep.y = y;
    ep.z = z;
    ep.vx = bvx + Math.cos(th) * v * (1 - up * 0.5);
    ep.vy = up * v;
    ep.vz = bvz + Math.sin(th) * v * (1 - up * 0.5);
    ep.size = this.rng.range(0.06, 0.13);
    ep.growth = -0.05;
    ep.life = this.rng.range(0.22, 0.55);
    ep.alpha = 1;
    ep.color = this.tmpColor.copy(SPARK).lerp(SPARK_HOT, this.rng.next());
    ep.gravity = 9.8;
    ep.drag = 0.7;
    this.sparks.emit(ep);
  }

  /**
   * One floor spark from under the plank: keeps part of the car's speed (so it streams back past the gearbox in
   * the car's frame), stays low, short-lived and HDR-bright.
   */
  private floorSpark(x: number, y: number, z: number, fx: number, fz: number, rx: number, rz: number, speed: number): void {
    const r = this.rng;
    const lat = r.range(-0.35, 0.35);
    const fwd = r.range(this.dims.rearAxleZ + 0.3, 0.4);
    const carry = speed * r.range(0.3, 0.7);
    const side = r.range(-2.5, 2.5);
    const t = r.next();
    const ep = this.ep;
    ep.x = x + rx * lat + fx * fwd;
    ep.y = y + 0.03;
    ep.z = z + rz * lat + fz * fwd;
    ep.vx = fx * carry + rx * side;
    ep.vy = r.range(0.4, 2.2);
    ep.vz = fz * carry + rz * side;
    ep.size = r.range(FLOOR_SPARK.size[0], FLOOR_SPARK.size[1]);
    ep.growth = -0.12;
    ep.life = r.range(FLOOR_SPARK.life[0], FLOOR_SPARK.life[1]);
    ep.alpha = 1;
    ep.color = this.tmpColor.setRGB(
      FLOOR_SPARK_HOT[0] + (FLOOR_SPARK_WARM[0] - FLOOR_SPARK_HOT[0]) * t,
      FLOOR_SPARK_HOT[1] + (FLOOR_SPARK_WARM[1] - FLOOR_SPARK_HOT[1]) * t,
      FLOOR_SPARK_HOT[2] + (FLOOR_SPARK_WARM[2] - FLOOR_SPARK_HOT[2]) * t,
    );
    ep.gravity = 9.8;
    ep.drag = 3.2;
    this.sparks.emit(ep);
  }

  /** Forget per-car state (e.g. after a flashback). */
  reset(): void {
    this.acc.clear();
    this.smoke.clear();
    this.sparks.clear();
  }

  dispose(): void {
    this.smoke.dispose();
    this.sparks.dispose();
    this.acc.clear();
  }
}

function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}
