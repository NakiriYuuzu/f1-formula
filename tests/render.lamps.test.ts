/**
 * Pooled lamp lights (pure src/render/core/lampLights.ts): nearest-site assignment, the fade towards the cut so a
 * site entering or leaving the pool never pops, the fixed pool size, broken input, and the tiers that get lights.
 */
import { describe, expect, test } from 'bun:test';
import type { QualityLevel } from '../src/core/types';
import { LAMP_LIGHT_FADE, pickLampLights, type LampSite, type LampSlot } from '../src/render/core/lampLights';
import { qualityProfile } from '../src/render/core/quality';

const site = (x: number, z: number, tower = true): LampSite => ({ x, y: 22, z, ax: x, ay: 0, az: z + 10, tower });
/** towers every 70 m along a straight */
const row = Array.from({ length: 40 }, (_, i) => site(0, i * 70));
const slots = (n: number): LampSlot[] => Array.from({ length: n }, () => ({ site: -1, weight: 0 }));

describe('pooled lamp lights', () => {
  test('the pool takes the nearest sites, nearest first', () => {
    const s = pickLampLights(row, 0, 700, slots(4));
    expect(s.map((x) => x.site).sort((a, b) => a - b)).toEqual([9, 10, 11, 8].sort((a, b) => a - b));
    expect(s[0].site).toBe(10);
    expect(s[0].weight).toBe(1);
  });

  test('weights are continuous along a drive: no light pops on or off', () => {
    const n = 4;
    const out = slots(n);
    const scratch: number[] = [];
    // total light (sum of weights per site) as the focus moves 1 m at a time
    let prev: Map<number, number> | null = null;
    for (let z = 0; z <= 2000; z += 1) {
      pickLampLights(row, 3, z, out, scratch);
      const now = new Map<number, number>();
      for (const s of out) if (s.site >= 0) now.set(s.site, s.weight);
      if (prev) {
        for (const id of new Set([...prev.keys(), ...now.keys()])) {
          // both the site's distance and the cut move at most 1 m per metre driven
          expect(Math.abs((now.get(id) ?? 0) - (prev.get(id) ?? 0))).toBeLessThanOrEqual(2 / LAMP_LIGHT_FADE + 1e-9);
        }
      }
      prev = now;
    }
  });

  test('fewer sites than lights: all lit at full weight, the rest unused', () => {
    const s = pickLampLights([site(0, 0), site(5, 5)], 0, 0, slots(4));
    expect(s.filter((x) => x.site >= 0).length).toBe(2);
    expect(s.filter((x) => x.site >= 0).every((x) => x.weight === 1)).toBe(true);
    expect(s.filter((x) => x.site < 0).every((x) => x.weight === 0)).toBe(true);
  });

  test('no sites, no slots or a broken focus light nothing', () => {
    expect(pickLampLights([], 0, 0, slots(3)).every((x) => x.site === -1)).toBe(true);
    expect(pickLampLights(row, Number.NaN, 0, slots(3)).every((x) => x.weight === 0)).toBe(true);
    expect(pickLampLights(row, 0, 0, [])).toEqual([]);
  });

  test('tiers: real lamp lights on high / ultra only, a fixed pool', () => {
    const levels: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
    const counts = levels.map((l) => qualityProfile(l).lampLights);
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBe(0);
    expect(counts[2]).toBeGreaterThan(0);
    expect(counts[3]).toBeGreaterThanOrEqual(counts[2]);
    for (const c of counts) expect(Number.isInteger(c)).toBe(true);
  });
});
