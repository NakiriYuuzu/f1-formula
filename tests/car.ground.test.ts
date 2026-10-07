/**
 * Ground contact and rear-end details of the car (src/render/car, src/render/fx): tyres stay within 1 cm of the
 * ground plane while the body pitches / rolls, the contact footprint follows the road grade and reaches past the car
 * outline, LOD1 suspension blades have no inverted faces, and the launch smoke stays a light haze.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { CarRenderState } from '../src/core/types';
import { buildCarGeometry } from '../src/render/car/carGeometry';
import { createCarModel } from '../src/render/car/carModel';
import { carDims } from '../src/render/car/dims';
import { blade } from '../src/render/car/shapes';
import { Disposer } from '../src/render/core/disposer';
import { CarEffects, TYRE_SMOKE } from '../src/render/fx/carEffects';
import { ContactShadows, CONTACT_LIFT, footprintAlpha, raceFootprint } from '../src/render/fx/contactShadows';
import { installFakeDom } from './renderHarness';

installFakeDom();

const REGS = ['2025', '2026'] as const;
const LIVERY = { primary: '#d6222a', secondary: '#f2c200', accent: '#ffffff' } as never;

function state(over: Partial<CarRenderState> & { groundPitch?: number }): CarRenderState {
  return {
    carId: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 50, steerAngle: 0, wheelSpin: 0, throttle: 0, brake: 0, rpm: 9000, gear: 5,
    drsOpen: false, compound: 'medium', rainLight: false, limiter: false, damage: { frontWing: 0, rearWing: 0 }, slip: 0, lockup: 0, impact: 0,
    surface: 'asphalt', boost: false, visible: true, ghost: false, ...over,
  } as CarRenderState;
}

/** Lowest height (m) of the four tyres above the ground plane (grade `gp`, nose up) through the root origin; per wheel. */
function tyreClearances(model: ReturnType<typeof createCarModel>, gp: number): number[] {
  model.root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  return model.nodes.wheels.map((w) => {
    const pos = (w.geometry as THREE.BufferGeometry).getAttribute('position');
    let low = Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(w.matrixWorld);
      low = Math.min(low, (v.y - v.z * Math.tan(gp)) * Math.cos(gp));
    }
    return low;
  });
}

describe('tyres on the ground', () => {
  for (const reg of REGS) {
    const model = createCarModel({ livery: LIVERY, number: 7, teamShort: 'TST', helmet: LIVERY, regulation: reg, quality: 'low' });
    const poses: [string, number, number, number][] = [
      ['level', 0, 0, 0],
      ['braking pitch', -0.035, 0, 0],
      ['launch pitch', 0.035, 0, 0],
      ['roll', 0, 0.03, 0],
      ['9 % grade + braking + roll', 0.09 - 0.035, -0.025, 0.09],
      ['-6 % grade + launch', -0.06 + 0.03, 0.02, -0.06],
    ];
    for (const [name, pitchDyn, roll, grade] of poses) {
      test(`${reg}: ${name}: every tyre bottom within 1 cm of the ground plane`, () => {
        model.apply(state({ pitch: grade + pitchDyn, roll, groundPitch: grade }), 0.016);
        for (const c of tyreClearances(model, grade)) expect(Math.abs(c)).toBeLessThan(0.01);
      });
    }
    test(`${reg}: roll alone is compensated without the optional groundPitch`, () => {
      model.apply(state({ pitch: 0, roll: 0.03 }), 0.016);
      for (const c of tyreClearances(model, 0)) expect(Math.abs(c)).toBeLessThan(0.01);
    });
    test(`${reg}: lowest car geometry is the tyres, floor plank 3 cm above the ground`, () => {
      const s = buildCarGeometry(reg);
      s.body.computeBoundingBox();
      expect(s.body.boundingBox?.min.y).toBeCloseTo(0.03, 3);
      model.apply(state({}), 0.016);
      for (const c of tyreClearances(model, 0)) expect(Math.abs(c)).toBeLessThan(0.002);
    });
  }
});

describe('contact footprint', () => {
  for (const reg of REGS) {
    const d = carDims(reg);
    const f = raceFootprint(d);
    test(`${reg}: extends beyond the car outline (tyre outer edges, wing tips, nose and tail) and shades around each tyre`, () => {
      for (const [z, track, w] of [[d.frontAxleZ, d.frontHalfTrack, d.frontTyreWidth], [d.rearAxleZ, d.rearHalfTrack, d.rearTyreWidth]] as const) {
        const outer = track + w / 2;
        // beside the tyre foot and ahead of / behind it, where the road is visible
        expect(footprintAlpha(f, outer + 0.12, z)).toBeGreaterThan(0.3);
        expect(footprintAlpha(f, track, z + 0.36 + 0.12)).toBeGreaterThan(0.4);
        expect(footprintAlpha(f, track, z - 0.36 - 0.12)).toBeGreaterThan(0.4);
      }
      expect(footprintAlpha(f, 0, -d.length / 2 + 0.1)).toBeGreaterThan(0.1);
      expect(footprintAlpha(f, d.rearAxleZ > 0 ? 0 : d.rearHalfTrack + d.rearTyreWidth / 2, d.rearAxleZ)).toBeGreaterThan(0.6);
    });
  }

  test('is tilted with the road grade, lifted CONTACT_LIFT above the car ground point', () => {
    const cs = new ContactShadows(new Disposer(), carDims('2025'), 2);
    const grade = Math.atan(0.095);
    cs.update([state({ y: 10, pitch: grade + 0.03, groundPitch: grade })], null);
    const mesh = cs.group.children[0] as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    const nose = new THREE.Vector3(0, 0, 3).applyMatrix4(m);
    const tail = new THREE.Vector3(0, 0, -3).applyMatrix4(m);
    expect(nose.y - 10 - CONTACT_LIFT).toBeCloseTo(3 * Math.sin(grade), 3);
    expect(tail.y - 10 - CONTACT_LIFT).toBeCloseTo(-3 * Math.sin(grade), 3);
    // without a ground pitch the car's own pitch is used (the grade is part of it)
    cs.update([state({ y: 10, pitch: grade })], null);
    mesh.getMatrixAt(0, m);
    expect(new THREE.Vector3(0, 0, 3).applyMatrix4(m).y - 10 - CONTACT_LIFT).toBeCloseTo(3 * Math.sin(grade), 3);
  });
});

describe('LOD1 suspension blades', () => {
  const faceVsNormal = (src: THREE.BufferGeometry): number => {
    const g = src.index ? src.toNonIndexed() : src;
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    let inverted = 0;
    for (let i = 0; i + 2 < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      const fn = b.clone().sub(a).cross(c.clone().sub(a));
      if (fn.lengthSq() < 1e-14) continue;
      n.set(0, 0, 0);
      for (let k = 0; k < 3; k++) n.add(new THREE.Vector3(nor.getX(i + k), nor.getY(i + k), nor.getZ(i + k)));
      if (fn.normalize().dot(n.normalize()) < -0.2) inverted++;
    }
    return inverted;
  };
  test('a flattened blade never has fewer than 4 sides, so its smooth normals agree with its faces', () => {
    for (const radial of [3, 4, 6]) {
      const g = blade(new THREE.Vector3(0.1, 0.2, 1.7), new THREE.Vector3(0.7, 0.3, 1.5), 0.055, 0.016, radial);
      expect(faceVsNormal(g)).toBe(0);
    }
  });
  for (const reg of REGS) {
    test(`${reg}: LOD1 body has no inverted triangles`, () => {
      const s = buildCarGeometry(reg);
      expect(faceVsNormal(s.lod1.body)).toBe(0);
      expect(faceVsNormal(s.body)).toBe(0);
    });
  }
});

describe('tyre smoke', () => {
  test('is a thin short-lived haze', () => {
    expect(TYRE_SMOKE.alphaBase + TYRE_SMOKE.alphaSlip).toBeLessThanOrEqual(0.2);
    expect(TYRE_SMOKE.size + TYRE_SMOKE.growth * TYRE_SMOKE.lifeMax).toBeLessThanOrEqual(2);
    expect(TYRE_SMOKE.lifeMax).toBeLessThanOrEqual(1);
  });
  test('a 20-car launch with full wheelspin keeps the number of live puffs low, and more slip means more smoke', () => {
    const run = (slip: number): number => {
      const fx = new CarEffects(768, 128, 'temperate', carDims('2025'));
      const cars = Array.from({ length: 20 }, (_, i) => state({ carId: i, x: (i % 2) * 8, z: -Math.floor(i / 2) * 8, speed: 10, slip, lockup: 0 }));
      for (let t = 0; t < 120; t++) fx.update(cars, [], 0, 1 / 60);
      const n = fx.smoke.activeCount;
      fx.dispose();
      return n;
    };
    expect(run(1)).toBeLessThan(300);
    expect(run(1)).toBeGreaterThan(run(0.6));
    expect(run(0.3)).toBe(0);
  });
});

describe('explicit quality level', () => {
  const mat = (m: ReturnType<typeof createCarModel>): THREE.Material => m.nodes.body.material as THREE.Material;
  test('CarModelOptions.quality wins over the texture size / anisotropy inference', () => {
    const base = { livery: LIVERY, number: 1, teamShort: 'TST', helmet: LIVERY, regulation: '2025' as const, textureSize: 256, anisotropy: 1 };
    expect((mat(createCarModel({ ...base, quality: 'ultra' })) as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial).toBe(true);
    expect((mat(createCarModel({ ...base, quality: 'low' })) as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial).toBeUndefined();
    // fallback: tiny atlas + anisotropy 1 is inferred as low (standard material)
    expect((mat(createCarModel(base)) as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial).toBeUndefined();
  });
});
