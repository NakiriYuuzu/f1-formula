/**
 * Display LUT grade per time of day (pure src/render/core/lutGrade.ts): subtle, keeps black and white, monotonic
 * along the grey axis, the LUT data layout, the rain fade.
 */
import { describe, expect, test } from 'bun:test';
import type { TimeOfDay } from '../src/core/types';
import { buildLutData, gradeDisplay, lutAmount, LUT_BY_TIME, LUT_RAIN_AMOUNT, LUT_SIZE } from '../src/render/core/lutGrade';
import type { Rgb } from '../src/render/core/post';

const TIMES: TimeOfDay[] = ['day', 'dusk', 'night'];

describe('display LUT grade', () => {
  test('black and white stay put on every look', () => {
    for (const t of TIMES) {
      const look = LUT_BY_TIME[t];
      for (const v of gradeDisplay([0, 0, 0], look)) expect(v).toBeCloseTo(0, 6);
      for (const v of gradeDisplay([1, 1, 1], look)) expect(v).toBeCloseTo(1, 6);
    }
  });

  test('subtle: no channel moves more than 8 % anywhere in the cube', () => {
    for (const t of TIMES) {
      const look = LUT_BY_TIME[t];
      const out: Rgb = [0, 0, 0];
      for (let r = 0; r <= 1; r += 0.125) {
        for (let g = 0; g <= 1; g += 0.125) {
          for (let b = 0; b <= 1; b += 0.125) {
            gradeDisplay([r, g, b], look, out);
            expect(Math.abs(out[0] - r)).toBeLessThan(0.08);
            expect(Math.abs(out[1] - g)).toBeLessThan(0.08);
            expect(Math.abs(out[2] - b)).toBeLessThan(0.08);
          }
        }
      }
    }
  });

  test('greys stay ordered (no tone reversal) and shadows lean cool, highlights warm', () => {
    for (const t of TIMES) {
      const look = LUT_BY_TIME[t];
      let prev = -1;
      for (let v = 0; v <= 1.0001; v += 1 / 64) {
        const o = gradeDisplay([v, v, v], look);
        const l = 0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2];
        expect(l).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = l;
      }
      const shadow = gradeDisplay([0.15, 0.15, 0.15], look);
      const high = gradeDisplay([0.75, 0.75, 0.75], look);
      expect(shadow[2]).toBeGreaterThan(shadow[0]);
      expect(high[0]).toBeGreaterThan(high[2]);
    }
  });

  test('LUT data: size³ RGBA, red fastest, identity-like corners', () => {
    const n = 4;
    const data = buildLutData(LUT_BY_TIME.day, n);
    expect(data.length).toBe(n * n * n * 4);
    // (r = 1, g = 0, b = 0) is the n − 1-th texel
    const i = (n - 1) * 4;
    expect(data[i]).toBeGreaterThan(240);
    expect(data[i + 1]).toBeLessThan(15);
    expect(data[i + 3]).toBe(255);
    expect(buildLutData(LUT_BY_TIME.night).length).toBe(LUT_SIZE ** 3 * 4);
  });

  test('rain fades the look; broken input keeps it full', () => {
    expect(lutAmount(0)).toBe(1);
    expect(lutAmount(1)).toBeCloseTo(LUT_RAIN_AMOUNT, 9);
    expect(lutAmount(Number.NaN)).toBe(1);
    expect(lutAmount(5)).toBeCloseTo(LUT_RAIN_AMOUNT, 9);
  });
});
