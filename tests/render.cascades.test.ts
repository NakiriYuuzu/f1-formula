/**
 * Sun shadow cascades (pure maths of src/render/core/shadowCascades.ts) and the quality tiers that size them: near /
 * far box and texel sizes, the near-cascade fade weight, the far cascade's re-render rule, the shader patch.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { QualityLevel } from '../src/core/types';
import {
  CASCADE_FADE_START,
  FAR_CASCADE_HALF,
  FAR_CASCADE_RECENTRE,
  FAR_SHADOW,
  NEAR_CASCADE_HALF,
  cascadeTexel,
  farCascadeStale,
  nearCascadeWeight,
} from '../src/render/core/shadowCascades';
import { installSunCascadeShader } from '../src/render/core/sunCascadeShader';
import { qualityProfile } from '../src/render/core/quality';

const LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

describe('cascade layout', () => {
  test('the near cascade is finer than the old single ±70 m box on every shadowed tier; the far one reaches ~4× further', () => {
    for (const l of LEVELS) {
      const q = qualityProfile(l);
      if (q.shadowMapSize === 0) {
        expect(q.shadowFarMapSize).toBe(0);
        continue;
      }
      expect(cascadeTexel(NEAR_CASCADE_HALF, q.shadowMapSize)).toBeLessThan(cascadeTexel(70, q.shadowMapSize));
      expect(q.shadowFarMapSize).toBeGreaterThan(0);
      // far texels stay well under a metre
      expect(cascadeTexel(FAR_CASCADE_HALF, q.shadowFarMapSize)).toBeLessThan(0.65);
    }
    expect(FAR_CASCADE_HALF).toBeGreaterThanOrEqual(NEAR_CASCADE_HALF * 4);
    expect(cascadeTexel(NEAR_CASCADE_HALF, 2048)).toBeCloseTo(100 / 2048, 9);
    expect(cascadeTexel(10, 0)).toBe(20);
  });

  test('far shadow depth range covers the light distance; its bias stays under half a metre', () => {
    expect(FAR_SHADOW.near).toBeLessThan(FAR_SHADOW.distance);
    expect(FAR_SHADOW.far).toBeGreaterThan(FAR_SHADOW.distance);
    expect(Math.abs(FAR_SHADOW.bias) * (FAR_SHADOW.far - FAR_SHADOW.near)).toBeLessThan(0.5);
  });

  test('low has neither cascade; medium is the cheapest shadowed tier', () => {
    expect(qualityProfile('low').shadowMapSize).toBe(0);
    expect(qualityProfile('medium').shadowFarMapSize).toBeLessThanOrEqual(qualityProfile('high').shadowFarMapSize);
  });
});

describe('near cascade weight', () => {
  test('1 inside the inner square, 0 at and past the edge, monotonic across the band', () => {
    expect(nearCascadeWeight(0.5, 0.5)).toBe(1);
    const inner = 0.5 + CASCADE_FADE_START / 2 - 1e-6;
    expect(nearCascadeWeight(inner, 0.5)).toBe(1);
    expect(nearCascadeWeight(1, 0.5)).toBe(0);
    expect(nearCascadeWeight(0.5, -0.2)).toBe(0);
    let prev = 1;
    for (let u = 0.5; u <= 1.0001; u += 0.01) {
      const w = nearCascadeWeight(u, 0.5);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
    expect(nearCascadeWeight(Number.NaN, 0.5)).toBe(0);
  });
});

describe('far cascade re-render rule', () => {
  const lim = FAR_CASCADE_RECENTRE * FAR_CASCADE_HALF;
  test('renders when never rendered, then only after moving past the recentre distance', () => {
    expect(farCascadeStale(null, { x: 0, z: 0 })).toBe(true);
    expect(farCascadeStale({ x: 0, z: 0 }, { x: lim * 0.99, z: 0 })).toBe(false);
    expect(farCascadeStale({ x: 0, z: 0 }, { x: lim * 0.8, z: lim * 0.8 })).toBe(true);
    expect(farCascadeStale({ x: 10, z: -5 }, { x: 10, z: -5 - lim * 1.01 })).toBe(true);
  });
  test('a turning sun forces a render; garbage focus never does', () => {
    expect(farCascadeStale({ x: 0, z: 0 }, { x: 0, z: 0 }, 0.01)).toBe(true);
    expect(farCascadeStale({ x: 0, z: 0 }, { x: Number.NaN, z: 0 })).toBe(false);
    expect(farCascadeStale(null, { x: 0, z: Number.POSITIVE_INFINITY })).toBe(false);
  });
  test('a lap re-renders the far map only every recentre distance (~110 m), not every frame', () => {
    let centre: { x: number; z: number } | null = null;
    let renders = 0;
    // 5 km straight at 1 m steps
    for (let x = 0; x <= 5000; x++) {
      if (farCascadeStale(centre, { x, z: 0 })) {
        centre = { x, z: 0 };
        renders++;
      }
    }
    expect(renders).toBe(1 + Math.floor(5000 / (Math.floor(lim) + 1)));
  });
});

describe('cascade shader patch', () => {
  test('installs into three r186 chunks once and keeps single-light scenes untouched', () => {
    expect(installSunCascadeShader()).toBe(true);
    expect(installSunCascadeShader()).toBe(true);
    const lights = THREE.ShaderChunk.lights_fragment_begin;
    expect(lights).toContain('sunCascadeShadow');
    // the original single-light lookup survives in the #else branch
    expect(lights).toContain('getShadow( directionalShadowMap[ i ]');
    expect(lights.match(/sunCascadeShadow/g)?.length).toBe(1);
    expect(THREE.ShaderChunk.shadowmap_pars_fragment).toContain('float sunCascadeShadow(');
    expect(THREE.ShaderChunk.shadowmap_pars_fragment).toContain(CASCADE_FADE_START.toFixed(4));
  });
});
