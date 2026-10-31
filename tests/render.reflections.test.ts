/**
 * Reflections that follow the race: the probe refresh throttle (src/render/core/probeRefresh.ts), the wet-road
 * screen-space reflection strength (post.ts wetReflectionStrength) and the quality tiers that switch them.
 */
import { describe, expect, test } from 'bun:test';
import type { QualityLevel } from '../src/core/types';
import {
  PROBE_CLOUD_DELTA,
  PROBE_LAMP_DELTA,
  PROBE_RAIN_DELTA,
  PROBE_REFRESH_MIN_SEC,
  probeRefreshDue,
  probeStaleness,
  type ProbeSignature,
} from '../src/render/core/probeRefresh';
import { SSR_STRENGTH, wetReflectionStrength } from '../src/render/core/post';
import { qualityProfile } from '../src/render/core/quality';

const LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
const DRY: ProbeSignature = { cloud: 0.2, rain: 0, lamps: 0 };

describe('probe refresh', () => {
  test('never captured → due at once', () => {
    expect(probeRefreshDue(null, DRY, 0)).toBe(true);
  });

  test('small drift keeps the map; each field past its threshold makes it stale', () => {
    expect(probeStaleness(DRY, DRY)).toBe(0);
    expect(probeStaleness(DRY, { ...DRY, cloud: DRY.cloud + PROBE_CLOUD_DELTA * 0.5 })).toBeLessThan(1);
    expect(probeStaleness(DRY, { ...DRY, cloud: DRY.cloud + PROBE_CLOUD_DELTA })).toBeGreaterThanOrEqual(1);
    expect(probeStaleness(DRY, { ...DRY, rain: PROBE_RAIN_DELTA })).toBeGreaterThanOrEqual(1);
    expect(probeStaleness(DRY, { ...DRY, lamps: PROBE_LAMP_DELTA })).toBeGreaterThanOrEqual(1);
  });

  test('a stale map waits for the minimum interval', () => {
    const wet: ProbeSignature = { cloud: 0.9, rain: 0.8, lamps: 0 };
    expect(probeRefreshDue(DRY, wet, PROBE_REFRESH_MIN_SEC - 0.01)).toBe(false);
    expect(probeRefreshDue(DRY, wet, PROBE_REFRESH_MIN_SEC)).toBe(true);
    // a fresh map is never re-captured, however long ago
    expect(probeRefreshDue(DRY, DRY, 1e6)).toBe(false);
  });

  test('a dry → wet transition over two minutes costs only a handful of captures', () => {
    let captured: ProbeSignature = { ...DRY };
    let since = 0;
    let captures = 0;
    const dt = 1 / 60;
    for (let t = 0; t <= 120; t += dt) {
      const k = Math.min(1, t / 120);
      const now: ProbeSignature = { cloud: 0.2 + 0.75 * k, rain: k, lamps: 0 };
      since += dt;
      if (probeRefreshDue(captured, now, since)) {
        captured = now;
        since = 0;
        captures++;
      }
    }
    expect(captures).toBeGreaterThanOrEqual(3);
    expect(captures).toBeLessThanOrEqual(120 / PROBE_REFRESH_MIN_SEC);
  });

  test('broken inputs neither throw nor trigger endless captures', () => {
    const bad: ProbeSignature = { cloud: Number.NaN, rain: Number.POSITIVE_INFINITY, lamps: 0 };
    expect(Number.isFinite(probeStaleness(DRY, bad))).toBe(true);
    expect(probeRefreshDue(DRY, DRY, Number.NaN)).toBe(false);
    expect(probeRefreshDue({ ...DRY, cloud: 0.9 }, DRY, Number.NaN)).toBe(true);
  });
});

describe('wet-road reflections', () => {
  test('off when the tier has none, on a dry track or with broken input', () => {
    expect(wetReflectionStrength(1, false)).toBe(0);
    expect(wetReflectionStrength(0, true)).toBe(0);
    expect(wetReflectionStrength(0.05, true)).toBe(0);
    expect(wetReflectionStrength(Number.NaN, true)).toBe(0);
  });

  test('grows with wetness up to full strength', () => {
    let prev = 0;
    for (let w = 0; w <= 1.0001; w += 0.05) {
      const s = wetReflectionStrength(w, true);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(wetReflectionStrength(1, true)).toBeCloseTo(SSR_STRENGTH, 6);
  });

  test('tiers: only ultra traces wet reflections; SMAA from high up; low stays cheap', () => {
    const q = Object.fromEntries(LEVELS.map((l) => [l, qualityProfile(l)]));
    expect(LEVELS.filter((l) => q[l].wetReflections)).toEqual(['ultra']);
    expect(LEVELS.filter((l) => q[l].smaa)).toEqual(['high', 'ultra']);
    expect(q.low.shadowFarMapSize).toBe(0);
    expect(q.low.smaa).toBe(false);
    expect(q.low.wetReflections).toBe(false);
  });
});
