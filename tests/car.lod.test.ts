/**
 * Car level of detail + paint parameters (pure helpers of src/render/car/carQuality.ts) and the LOD geometry
 * budgets (deterministic, DOM-free builders): level selection with hysteresis and FOV scaling, quality-scaled
 * distances, the quality inference fallback, the clear-coat / surface tables, LOD2 ≤ 400 triangles and LOD
 * silhouettes that match LOD0.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { QualityLevel } from '../src/core/types';
import { buildCarGeometry } from '../src/render/car/carGeometry';
import {
  carLodDistances,
  inferCarQuality,
  lodFovScale,
  selectLodLevel,
  usesClearcoatPaint,
  CAR_LOD_DISTANCES,
  CAR_LOD_HYSTERESIS,
  CAR_LOD_REFERENCE_FOV,
  CAR_PAINT,
  CAR_SURFACE,
  TYRE_SURFACE,
} from '../src/render/car/carQuality';
import { qualityProfile } from '../src/render/core/quality';

const LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
const tris = (g: THREE.BufferGeometry | null): number => (g ? (g.index ? g.index.count : g.getAttribute('position').count) / 3 : 0);

describe('LOD level selection', () => {
  const th = [60, 180];
  test('picks the level whose band contains the distance', () => {
    expect(selectLodLevel(0, th, 0, 0)).toBe(0);
    expect(selectLodLevel(59.9, th, 0, 0)).toBe(0);
    expect(selectLodLevel(60, th, 0, 0)).toBe(1);
    expect(selectLodLevel(179, th, 0, 0)).toBe(1);
    expect(selectLodLevel(180, th, 0, 0)).toBe(2);
    expect(selectLodLevel(5000, th, 1, 0.1)).toBe(2);
  });
  test('hysteresis keeps the current level until clearly inside the finer band', () => {
    const h = 0.1;
    expect(selectLodLevel(57, th, 1, h)).toBe(1);
    expect(selectLodLevel(53, th, 1, h)).toBe(0);
    expect(selectLodLevel(57, th, 0, h)).toBe(0);
    expect(selectLodLevel(170, th, 2, h)).toBe(2);
    expect(selectLodLevel(160, th, 2, h)).toBe(1);
    expect(selectLodLevel(170, th, 1, h)).toBe(1);
  });
  test('a sweep out and back never flickers', () => {
    let level = 0;
    let switches = 0;
    const path = [...Array.from({ length: 400 }, (_, i) => i * 0.6), ...Array.from({ length: 400 }, (_, i) => 240 - i * 0.6)];
    for (const dist of path) {
      // ±2 m jitter on top of the sweep (cars bobbing in a pack)
      for (const j of [-2, 2, -2]) {
        const next = selectLodLevel(dist + j, th, level, CAR_LOD_HYSTERESIS);
        if (next !== level) switches++;
        level = next;
      }
    }
    expect(switches).toBe(4);
  });
  test('non-finite distances keep the current level', () => {
    expect(selectLodLevel(Number.NaN, th, 1, 0.1)).toBe(1);
    expect(selectLodLevel(Number.POSITIVE_INFINITY, th, 2, 0.1)).toBe(2);
  });
});

describe('LOD distances', () => {
  test('grow with quality and stay ordered', () => {
    for (let i = 0; i < LEVELS.length; i++) {
      const [a, b] = carLodDistances(LEVELS[i]);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a * 2);
      if (i > 0) {
        const [pa, pb] = CAR_LOD_DISTANCES[LEVELS[i - 1]];
        expect(a).toBeGreaterThan(pa);
        expect(b).toBeGreaterThan(pb);
      }
    }
  });
  test('the followed car never leaves LOD0 in chase / chase-far views, even at the widest FOV', () => {
    // chaseFar: 11 m back + 0.6 m speed pull, 3.6 m up; FOV up to 100° + 8° speed widening
    const camDist = Math.hypot(11.6, 3.6);
    for (const q of LEVELS) {
      const [first] = carLodDistances(q);
      expect(camDist * lodFovScale(108)).toBeLessThan(first * (1 - CAR_LOD_HYSTERESIS));
    }
  });
  test('FOV scaling: 1 at the reference, smaller for zoomed lenses', () => {
    expect(lodFovScale(CAR_LOD_REFERENCE_FOV)).toBeCloseTo(1, 10);
    expect(lodFovScale(8)).toBeLessThan(0.15);
    expect(lodFovScale(90)).toBeGreaterThan(1);
    expect(lodFovScale(Number.NaN)).toBeCloseTo(1, 10);
    // a tv camera zoomed to 8° on a car 150 m away still shows full detail on 'high'
    expect(150 * lodFovScale(8)).toBeLessThan(carLodDistances('high')[0]);
  });
});

describe('quality-dependent paint', () => {
  test('inferCarQuality recovers every quality from the scene texture size / anisotropy', () => {
    for (const q of LEVELS) {
      const p = qualityProfile(q);
      expect(inferCarQuality(p.liveryTexSize, p.anisotropy)).toBe(q);
    }
  });
  test('clear coat only on high / ultra', () => {
    expect(LEVELS.filter(usesClearcoatPaint)).toEqual(['high', 'ultra']);
    expect(CAR_PAINT.clearcoat).toBeCloseTo(1, 5);
    expect(CAR_PAINT.clearcoatRoughness).toBeGreaterThan(0.03);
    expect(CAR_PAINT.clearcoatRoughness).toBeLessThan(0.15);
  });
  test('surface tables: glossy coated paint, rougher darker carbon, matte uncoated rubber', () => {
    const [paintR, paintM, paintC] = CAR_SURFACE.paint;
    const [carbonR, carbonM, carbonC] = CAR_SURFACE.carbon;
    expect(paintC).toBe(1);
    expect(carbonR).toBeGreaterThan(paintR);
    expect(carbonC).toBeLessThan(paintC);
    expect(carbonM).toBeGreaterThanOrEqual(paintM);
    expect(CAR_SURFACE.black[2]).toBe(0);
    expect(CAR_SURFACE.black[0]).toBeGreaterThan(0.8);
    expect(TYRE_SURFACE.rubber[0]).toBeGreaterThanOrEqual(0.9);
    expect(TYRE_SURFACE.rubber[1]).toBe(0);
    for (const v of [...Object.values(CAR_SURFACE), ...Object.values(TYRE_SURFACE)]) for (const x of v) expect(x >= 0 && x <= 1).toBe(true);
  });
});

describe('LOD geometry budgets', () => {
  for (const reg of ['2025', '2026'] as const) {
    test(`${reg}: LOD1 ≤ 25 % and LOD2 ≤ 400 triangles; silhouettes match LOD0`, () => {
      const s = buildCarGeometry(reg);
      const d = s.dims;
      const lod0 = tris(s.body) + tris(s.frontWing) + tris(s.frontFlap) + tris(s.rearFlap) + 2 * tris(s.wheelFront) + 2 * tris(s.wheelRear);
      const lod1 = tris(s.lod1.body) + tris(s.lod1.frontWing) + 2 * tris(s.lod1.wheelFront) + 2 * tris(s.lod1.wheelRear);
      const lod2 = tris(s.lod2);
      expect(lod1).toBeLessThan(lod0 * 0.25);
      expect(lod2).toBeLessThanOrEqual(400);
      expect(tris(s.lod1.frontWingDamaged)).toBeLessThan(tris(s.lod1.frontWing));

      const box = (g: THREE.BufferGeometry): THREE.Box3 => {
        g.computeBoundingBox();
        return (g.boundingBox ?? new THREE.Box3()).clone();
      };
      const wheels = (front: THREE.BufferGeometry, rear: THREE.BufferGeometry): THREE.Box3 => {
        const out = new THREE.Box3();
        for (const [x, z, g, r] of [
          [d.frontHalfTrack, d.frontAxleZ, front, d.frontWheelRadius],
          [-d.frontHalfTrack, d.frontAxleZ, front, d.frontWheelRadius],
          [d.rearHalfTrack, d.rearAxleZ, rear, d.rearWheelRadius],
          [-d.rearHalfTrack, d.rearAxleZ, rear, d.rearWheelRadius],
        ] as [number, number, THREE.BufferGeometry, number][]) {
          const b = box(g);
          if (x < 0) b.set(new THREE.Vector3(-b.max.x, b.min.y, b.min.z), new THREE.Vector3(-b.min.x, b.max.y, b.max.z));
          out.union(b.translate(new THREE.Vector3(x, r, z)));
        }
        return out;
      };
      const b0 = box(s.body).union(box(s.frontWing)).union(wheels(s.wheelFront, s.wheelRear));
      const b1 = box(s.lod1.body).union(box(s.lod1.frontWing)).union(wheels(s.lod1.wheelFront, s.lod1.wheelRear));
      const b2 = box(s.lod2);
      for (const [b, tol] of [
        [b1, 0.03],
        [b2, 0.05],
      ] as [THREE.Box3, number][]) {
        expect(b.min.distanceTo(b0.min)).toBeLessThan(tol);
        expect(b.max.distanceTo(b0.max)).toBeLessThan(tol);
      }
      for (const g of [s.lod1.body, s.lod1.frontWing, s.lod1.wheelFront, s.lod2]) {
        const pos = g.getAttribute('position').array as Float32Array;
        expect(pos.every((v) => Number.isFinite(v))).toBe(true);
        expect(g.getAttribute('uv')).toBeDefined();
        expect(g.getAttribute('normal')).toBeDefined();
      }
    });
  }
});
