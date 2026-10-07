/**
 * Floor-spark rules (pure helpers of src/render/fx/floorSparks.ts): deterministic bump grid with the configured
 * density, speed threshold, which surfaces strike, time-of-day gating, HDR (bloom-friendly) colours and the
 * global burst budget that rate-limits the field.
 */
import { describe, expect, test } from 'bun:test';
import {
  bumpCellHash,
  bumpCellOf,
  floorSparkIntensity,
  floorStrikes,
  isBumpCell,
  refillBurstBudget,
  takeBurst,
  FLOOR_SPARK,
  FLOOR_SPARK_HOT,
  FLOOR_SPARK_LIGHT,
  FLOOR_SPARK_WARM,
  type BurstBudget,
} from '../src/render/fx/floorSparks';

describe('bump grid', () => {
  test('hash is deterministic, in [0, 1) and handles negative cells', () => {
    for (const [x, z] of [[0, 0], [-3, 7], [123456, -98765], [-1, -1]]) {
      const h = bumpCellHash(x, z);
      expect(h).toBe(bumpCellHash(x, z));
      expect(h >= 0 && h < 1).toBe(true);
    }
    expect(bumpCellHash(1, 2)).not.toBe(bumpCellHash(2, 1));
  });
  test('bump cells appear at the configured density', () => {
    let bumps = 0;
    const n = 200;
    for (let x = -n / 2; x < n / 2; x++) for (let z = -n / 2; z < n / 2; z++) if (isBumpCell(x, z)) bumps++;
    expect(bumps / (n * n)).toBeCloseTo(FLOOR_SPARK.bumpDensity, 2);
  });
  test('cell index follows the cell size and survives NaN', () => {
    expect(bumpCellOf(0)).toBe(0);
    expect(bumpCellOf(FLOOR_SPARK.bumpCell * 3 + 0.1)).toBe(3);
    expect(bumpCellOf(-0.1)).toBe(-1);
    expect(bumpCellOf(Number.NaN)).toBe(0);
  });
});

describe('floor strikes', () => {
  let bump: [number, number] = [0, 0];
  let flat: [number, number] = [0, 0];
  for (let x = 0; x < 500; x++) {
    if (isBumpCell(x, 3)) bump = [x, 3];
    else flat = [x, 3];
  }
  const fast = FLOOR_SPARK.fullSpeed;
  test('only at very high speed', () => {
    expect(floorSparkIntensity(FLOOR_SPARK.minSpeed - 1)).toBe(0);
    expect(floorSparkIntensity(Number.NaN)).toBe(0);
    expect(floorSparkIntensity(FLOOR_SPARK.fullSpeed)).toBeCloseTo(1, 10);
    expect(floorStrikes('kerb', FLOOR_SPARK.minSpeed - 1, true, ...bump)).toBe(false);
  });
  test('kerbs always strike; sealed surfaces only on entering a bump cell; soft surfaces / pit lane never', () => {
    expect(floorStrikes('kerb', fast, false, ...flat)).toBe(true);
    expect(floorStrikes('asphalt', fast, true, ...bump)).toBe(true);
    expect(floorStrikes('runoff', fast, true, ...bump)).toBe(true);
    expect(floorStrikes('asphalt', fast, false, ...bump)).toBe(false);
    expect(floorStrikes('asphalt', fast, true, ...flat)).toBe(false);
    for (const s of ['grass', 'gravel', 'pitlane'] as const) expect(floorStrikes(s, fast, true, ...bump)).toBe(false);
  });
  test('dusk / night only, night brightest; colours are HDR for bloom', () => {
    expect(FLOOR_SPARK_LIGHT.day).toBe(0);
    expect(FLOOR_SPARK_LIGHT.dusk).toBeGreaterThan(0);
    expect(FLOOR_SPARK_LIGHT.night).toBeGreaterThanOrEqual(FLOOR_SPARK_LIGHT.dusk);
    expect(Math.max(...FLOOR_SPARK_HOT)).toBeGreaterThan(1);
    expect(Math.max(...FLOOR_SPARK_WARM)).toBeGreaterThan(1);
    expect(FLOOR_SPARK.life[1]).toBeLessThan(0.5);
  });
});

describe('burst budget', () => {
  test('rate-limits bursts to burstsPerSec with a bounded bank', () => {
    const b: BurstBudget = { tokens: 0 };
    let bursts = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) {
      refillBurstBudget(b, dt);
      // a whole field asking for bursts every frame
      for (let k = 0; k < 20; k++) if (takeBurst(b)) bursts++;
    }
    expect(bursts).toBeLessThanOrEqual(FLOOR_SPARK.burstsPerSec * 10 + FLOOR_SPARK.burstBank);
    expect(bursts).toBeGreaterThanOrEqual(FLOOR_SPARK.burstsPerSec * 10 - 1);
    refillBurstBudget(b, 100);
    expect(b.tokens).toBe(FLOOR_SPARK.burstBank);
    refillBurstBudget(b, Number.NaN);
    expect(b.tokens).toBe(FLOOR_SPARK.burstBank);
  });
});
