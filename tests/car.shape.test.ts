/**
 * Car shape per regulation (src/render/car): real-world proportions (2025: 2.00 m wide, 3.60 m wheelbase, 305 / 405
 * 18" tyres; 2026: 1.90 m, 3.40 m, 280 / 375 with a smaller front radius), per-axle wheel geometry that still touches
 * the ground, wing spans, regulation-specific parts (beam wing, rear lights), triangle budgets against the pre-rework
 * model, and the livery wrap (no stretched triangles, swatches clear of the fin panel).
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { BODY_V0, FIN_U0, SWATCH_V0, SWATCH_V1, SWATCHES, swatchUV, wrapUV } from '../src/render/car/atlas';
import { buildCarGeometry } from '../src/render/car/carGeometry';
import { carDims } from '../src/render/car/dims';
import { bodyWrap, carBodyStations } from '../src/render/car/sharedParts';
import { loft } from '../src/render/car/shapes';

const REGS = ['2025', '2026'] as const;
const tris = (g: THREE.BufferGeometry | null): number => (g ? (g.index ? g.index.count : g.getAttribute('position').count) / 3 : 0);
const box = (g: THREE.BufferGeometry): THREE.Box3 => {
  g.computeBoundingBox();
  return (g.boundingBox ?? new THREE.Box3()).clone();
};

/** Triangle counts of the model before the realism rework (LOD0 / LOD1 / LOD2, summed like car.lod.test.ts). */
const BASELINE = { '2025': [12560, 2566, 372], '2026': [12408, 2510, 372] } as const;

describe('regulation dimensions', () => {
  test('2025: 2.00 m wide, 3.60 m wheelbase, nominal 305 / 405 mm tyres on one 0.36 m radius', () => {
    const d = carDims('2025');
    expect(d.width).toBe(2.0);
    expect(d.wheelbase).toBeCloseTo(3.6, 6);
    expect(d.frontAxleZ - d.rearAxleZ).toBeCloseTo(d.wheelbase, 6);
    expect(d.frontTyreWidth).toBeCloseTo(0.305, 6);
    expect(d.rearTyreWidth).toBeCloseTo(0.405, 6);
    expect(d.frontWheelRadius).toBeCloseTo(0.36, 6);
    expect(d.rearWheelRadius).toBeCloseTo(0.36, 6);
  });
  test('2026: 1.90 m wide, 3.40 m wheelbase, 280 / 375 mm tyres, front radius smaller than rear', () => {
    const d = carDims('2026');
    expect(d.width).toBe(1.9);
    expect(d.wheelbase).toBeCloseTo(3.4, 6);
    expect(d.frontAxleZ - d.rearAxleZ).toBeCloseTo(d.wheelbase, 6);
    expect(d.frontTyreWidth).toBeCloseTo(0.28, 6);
    expect(d.rearTyreWidth).toBeCloseTo(0.375, 6);
    expect(d.frontWheelRadius).toBeCloseTo(0.3525, 6);
    expect(d.rearWheelRadius).toBeCloseTo(0.355, 6);
  });
  test('tyres stay inside the maximum width and the spans follow the regulation', () => {
    for (const reg of REGS) {
      const d = carDims(reg);
      expect(d.frontHalfTrack + d.frontTyreWidth / 2).toBeLessThanOrEqual(d.width / 2);
      expect(d.rearHalfTrack + d.rearTyreWidth / 2).toBeLessThanOrEqual(d.width / 2);
      expect(d.frontWingHalfSpan).toBeLessThanOrEqual(d.width / 2);
      expect(d.rearWingHalfSpan).toBeLessThan(d.width / 4);
    }
    // 2026 front wing is ~0.1 m narrower than 2025 (and no longer the old 1.68 m)
    expect(carDims('2026').frontWingHalfSpan * 2).toBeGreaterThan(1.85);
    expect(carDims('2025').frontWingHalfSpan - carDims('2026').frontWingHalfSpan).toBeCloseTo(0.05, 2);
  });
});

describe('geometry extents', () => {
  for (const reg of REGS) {
    test(`${reg}: everything stays inside the width and length; floor off the ground, wheels on it`, () => {
      const s = buildCarGeometry(reg);
      const d = s.dims;
      const tol = 0.012;
      for (const g of [s.body, s.frontWing, s.frontWingDamaged, s.lod1.body, s.lod1.frontWing]) {
        const b = box(g);
        expect(b.max.x).toBeLessThanOrEqual(d.width / 2 + tol);
        expect(b.min.x).toBeGreaterThanOrEqual(-d.width / 2 - tol);
        expect(b.min.y).toBeGreaterThanOrEqual(0.025);
        expect(b.min.z).toBeGreaterThanOrEqual(-d.length / 2 - 1e-4);
        expect(b.max.z).toBeLessThanOrEqual(d.length / 2 + 1e-4);
        expect(b.max.y).toBeLessThan(1.1);
      }
      // front wing spans the regulation width; the damaged wing lost its +X half
      const fw = box(s.frontWing);
      expect(fw.max.x - fw.min.x).toBeGreaterThan(reg === '2025' ? 1.95 : 1.85);
      expect(box(s.frontWingDamaged).max.x).toBeLessThan(0.5);
      // per-axle wheels: radius, nominal width (+ drum behind the inner face) and the ground
      for (const [g, w, r] of [
        [s.wheelFront, d.frontTyreWidth, d.frontWheelRadius],
        [s.wheelRear, d.rearTyreWidth, d.rearWheelRadius],
        [s.lod1.wheelFront, d.frontTyreWidth, d.frontWheelRadius],
        [s.lod1.wheelRear, d.rearTyreWidth, d.rearWheelRadius],
      ] as [THREE.BufferGeometry, number, number][]) {
        const b = box(g);
        expect(b.max.y).toBeCloseTo(r, 3);
        expect(b.min.y).toBeCloseTo(-r, 3);
        expect(b.max.x).toBeGreaterThanOrEqual(w / 2 - 1e-3);
        expect(b.max.x).toBeLessThan(w / 2 + 0.01);
      }
      // the LOD0 wheel carries the brake-duct drum on its inner side
      expect(box(s.wheelFront).min.x).toBeLessThan(-d.frontTyreWidth / 2 - 0.08);
      // low-poly silhouette tyres touch the ground too
      expect(box(s.lod2).min.y).toBeCloseTo(0, 2);
    });
  }
  test('2026 front wheels are smaller than the rears; 2025 axles share one radius', () => {
    const a = buildCarGeometry('2025');
    expect(box(a.wheelFront).max.y).toBeCloseTo(box(a.wheelRear).max.y, 6);
    const b = buildCarGeometry('2026');
    expect(box(b.wheelFront).max.y).toBeLessThan(box(b.wheelRear).max.y);
  });
});

describe('regulation specific parts', () => {
  /** vertices of the body with |x| in [x0, x1], z in [z0, z1] and y in [y0, y1] */
  const count = (g: THREE.BufferGeometry, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): number => {
    const p = g.getAttribute('position');
    let n = 0;
    for (let i = 0; i < p.count; i++) {
      const x = Math.abs(p.getX(i));
      if (x >= x0 && x <= x1 && p.getZ(i) >= z0 && p.getZ(i) <= z1 && p.getY(i) >= y0 && p.getY(i) <= y1) n++;
    }
    return n;
  };
  test('beam wing only on 2025; 2026 has no wing between the rear tyres below the mainplane', () => {
    const a = buildCarGeometry('2025');
    const b = buildCarGeometry('2026');
    expect(count(a.body, 0.3, 0.46, a.dims.rearWingZ0, a.dims.rearWingZ1, 0.36, 0.56)).toBeGreaterThan(20);
    expect(count(b.body, 0.3, 0.46, b.dims.rearWingZ0, b.dims.rearWingZ1, 0.36, 0.56)).toBe(0);
  });
  test('2026 has three rear lights and two lateral lights, 2025 a single rain light', () => {
    const a = buildCarGeometry('2025').rainLight;
    const b = buildCarGeometry('2026').rainLight;
    expect(box(a).max.x).toBeLessThan(0.06);
    expect(tris(b)).toBe(5 * 12);
    expect(box(b).max.x).toBeGreaterThan(0.4);
    // two of them sit at the sides of the tail (x ~ 0.13)
    expect(count(b, 0.1, 0.15, -3, 0, 0, 1)).toBeGreaterThan(0);
  });
  test('2026 keeps active front flaps, 2025 has none; the rear flap exists in both', () => {
    expect(buildCarGeometry('2025').frontFlap).toBeNull();
    expect(buildCarGeometry('2026').frontFlap).not.toBeNull();
    expect(tris(buildCarGeometry('2025').rearFlap)).toBeGreaterThan(0);
  });
  test('2025 front wing has more elements than 2026 (4 vs 3 incl. active flaps)', () => {
    const a = buildCarGeometry('2025');
    const b = buildCarGeometry('2026');
    expect(tris(a.frontWing)).toBeGreaterThan(tris(b.frontWing));
  });
});

describe('triangle budgets', () => {
  for (const reg of REGS) {
    test(`${reg}: LOD0 <= +35 %, LOD1 <= +10 %, LOD2 <= 400 against the pre-rework model`, () => {
      const s = buildCarGeometry(reg);
      const lod0 = tris(s.body) + tris(s.frontWing) + tris(s.frontFlap) + tris(s.rearFlap) + 2 * tris(s.wheelFront) + 2 * tris(s.wheelRear);
      const lod1 = tris(s.lod1.body) + tris(s.lod1.frontWing) + 2 * tris(s.lod1.wheelFront) + 2 * tris(s.lod1.wheelRear);
      const [b0, b1] = BASELINE[reg];
      expect(lod0).toBeLessThanOrEqual(b0 * 1.35);
      expect(lod1).toBeLessThanOrEqual(b1 * 1.1);
      expect(tris(s.lod2)).toBeLessThanOrEqual(400);
    });
  }
});

describe('livery wrap', () => {
  for (const reg of REGS) {
    test(`${reg}: no stretched wrap triangles on the lofted body parts`, () => {
      const d = carDims(reg);
      const st = carBodyStations(d);
      const axis = (bodyWrap(d, st) as { axisY: (z: number) => number }).axisY;
      const parts: [string, THREE.BufferGeometry][] = [
        ['mono', loft(st.mono, { segments: 40, cutHalfWidth: 0.25, cutSegments: 10, capStart: true, capEnd: true })],
        ['cover', loft(st.cover, { segments: 36, capStart: true, capEnd: true })],
        ['airbox', loft(st.airbox, { segments: 28, capStart: true, capEnd: false })],
        ['pod', loft(st.pod, { segments: 32, capStart: true, capEnd: false })],
      ];
      const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      for (const [name, g] of parts) {
        const pos = g.getAttribute('position');
        const inner = g.getAttribute('inner');
        let stretched = 0;
        let seam = 0;
        for (let t = 0; t + 2 < pos.count; t += 3) {
          P.forEach((p, k) => p.fromBufferAttribute(pos, t + k));
          if (inner && [0, 1, 2].some((k) => inner.getX(t + k) > 0.5)) continue;
          if (Math.abs(P[0].z - P[1].z) < 1e-6 && Math.abs(P[0].z - P[2].z) < 1e-6) continue; // single-colour end cap
          const vs = P.map((p) => wrapUV(d, p.x, p.y, p.z, axis(p.z))[1]);
          const span = Math.max(...vs) - Math.min(...vs);
          if (span > (1 - BODY_V0) * 0.5) {
            seam++; // straddles the underside seam: painted carbon by the part mapper
            continue;
          }
          const edge = Math.max(P[0].distanceTo(P[1]), P[1].distanceTo(P[2]), P[0].distanceTo(P[2]));
          if ((span / (1 - BODY_V0)) * 360 > 60 && edge < 0.12) stretched++;
        }
        expect(stretched).toBe(0);
        // the seam stays on the monocoque underside only
        if (name !== 'mono') expect(seam).toBe(0);
        g.dispose();
      }
    });
  }
  test('swatch cells do not overlap the fin panel and stay distinct', () => {
    const uvs = SWATCHES.map((n) => swatchUV(n));
    expect(new Set(uvs.map(([u, v]) => `${u}:${v}`)).size).toBe(SWATCHES.length);
    for (const [u, v] of uvs) {
      expect(u).toBeLessThan(FIN_U0);
      expect(v).toBeGreaterThan(SWATCH_V0);
      expect(v).toBeLessThan(SWATCH_V1);
    }
    expect(SWATCHES).toContain('satin');
    // per-part swatches (LiveryParts) sit in their own row below the base swatches
    for (const part of ['halo', 'frontWing', 'rearWing', 'rearFlap'] as const) expect(swatchUV(part)[1]).toBeLessThan(swatchUV('primary')[1]);
  });
});
