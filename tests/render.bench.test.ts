/**
 * Benchmark mode (src/app/bench): URL parsing, tier-field overrides, frame-time statistics, the scenario sessions
 * (20 cars, fixed seed, the player on its grid slot) and the panel's text / window-title encodings.
 */
import { describe, expect, test } from 'bun:test';
import { titleLine, rowsToText } from '../src/app/bench/benchPanel';
import { buildBenchSession } from '../src/app/bench/benchSession';
import { BENCH_SCENARIOS, BENCH_SEED, isSoftwareRenderer, parseBench, parseTune, summarize, type BenchResult, type BenchRow } from '../src/app/bench/benchSpec';
import { baseQualityProfile, qualityProfile, resetQualityTuning, tuneQuality } from '../src/render/core/quality';

describe('parseBench', () => {
  test('absent or 0 means no benchmark', () => {
    expect(parseBench('')).toBeNull();
    expect(parseBench('?quick=race')).toBeNull();
    expect(parseBench('?bench=0')).toBeNull();
  });

  test('defaults cover every tier and scenario on the display pixel ratio', () => {
    const p = parseBench('?bench=1');
    expect(p).not.toBeNull();
    expect(p?.qualities).toEqual(['low', 'medium', 'high', 'ultra']);
    expect(p?.scenarios.map((s) => s.id)).toEqual(BENCH_SCENARIOS.map((s) => s.id));
    expect(p?.dprs).toEqual([null]);
    expect(p?.width).toBe(1280);
    expect(p?.height).toBe(720);
    expect(p?.autorun).toBe(false);
    expect(p?.antialias).toBeNull();
  });

  test('lists, size, bounds and invalid values', () => {
    const p = parseBench('?bench=1&quality=low,high,bogus,low&scenario=rain-spa,nope&dpr=1,device,2,x&size=1366x768&frames=9999&warmup=-3&runs=0&scale=0.2&aa=0&autorun=1');
    expect(p?.qualities).toEqual(['low', 'high']);
    expect(p?.scenarios.map((s) => s.id)).toEqual(['rain-spa']);
    expect(p?.dprs).toEqual([1, null, 2]);
    expect(p?.width).toBe(1366);
    expect(p?.height).toBe(768);
    expect(p?.frames).toBe(5000);
    expect(p?.warmup).toBe(0);
    expect(p?.runs).toBe(1);
    expect(p?.scale).toBe(1);
    expect(p?.antialias).toBe(false);
    expect(p?.autorun).toBe(true);
  });

  test('aa forces the canvas MSAA either way; without it the first tier decides', () => {
    expect(parseBench('?bench=1&aa=1')?.antialias).toBe(true);
    expect(parseBench('?bench=1&aa=0')?.antialias).toBe(false);
    expect(parseBench('?bench=1&aa=maybe')?.antialias).toBeNull();
  });

  test('A/B alternation needs a tuned field', () => {
    expect(parseBench('?bench=1&ab=1')?.ab).toBe(false);
    expect(parseBench('?bench=1&ab=1&tune=post:0')?.ab).toBe(true);
  });
});

describe('parseTune and the tier overrides', () => {
  test('keeps known fields of the right type only', () => {
    expect(parseTune('shadowMapSize:0,post:0,sceneProbe:true,lampLights:2,level:low,nope:1,propDensity:abc,smaa:maybe')).toEqual({
      shadowMapSize: 0,
      post: false,
      sceneProbe: true,
      lampLights: 2,
    });
    expect(parseTune(null)).toEqual({});
  });

  test('tuneQuality changes one level until reset, never the shipped table', () => {
    const shipped = baseQualityProfile('low').propDensity;
    tuneQuality('low', { propDensity: 0.01 });
    expect(qualityProfile('low').propDensity).toBe(0.01);
    expect(qualityProfile('low').level).toBe('low');
    expect(qualityProfile('high').propDensity).toBe(baseQualityProfile('high').propDensity);
    resetQualityTuning();
    expect(qualityProfile('low').propDensity).toBe(shipped);
    expect(baseQualityProfile('low').propDensity).toBe(shipped);
  });
});

describe('summarize', () => {
  test('nearest-rank percentiles of an unsorted sample', () => {
    const d = summarize(Array.from({ length: 100 }, (_, i) => 100 - i));
    expect(d.median).toBe(50);
    expect(d.p95).toBe(95);
    expect(d.p99).toBe(99);
    expect(d.min).toBe(1);
    expect(d.max).toBe(100);
    expect(d.mean).toBe(50.5);
  });

  test('an empty sample is all zeros', () => {
    expect(summarize([]).median).toBe(0);
  });
});

describe('scenarios', () => {
  test('each builds a 20-car session on its layout, weather and time of day, player on its slot', () => {
    for (const sc of BENCH_SCENARIOS) {
      const { config } = buildBenchSession(sc);
      expect(config.layoutId).toBe(sc.layoutId);
      expect(config.weather).toBe(sc.weather);
      expect(config.timeOfDay).toBe(sc.timeOfDay);
      expect(config.seed).toBe(BENCH_SEED);
      expect(config.grid.length).toBeGreaterThanOrEqual(20);
      expect(config.grid.findIndex((g) => g.playerIndex === 0)).toBe(sc.startPosition - 1);
    }
  });

  test('the standing-grid scenario ends before the lights could go out', () => {
    const grid = BENCH_SCENARIOS.find((s) => s.runUpSeconds === 0);
    expect(grid).toBeDefined();
    expect((grid?.maxFrames ?? 0) / 60).toBeLessThan(6);
  });
});

describe('panel encodings', () => {
  const row = (over: Partial<BenchRow>): BenchRow => ({
    run: 1,
    variant: 'base',
    quality: 'low',
    dpr: 1,
    pixelRatio: 1,
    scenario: 'grid-monza',
    frames: 300,
    frameMs: { median: 2.8, p95: 3.6, p99: 3.8, mean: 2.9, min: 2.1, max: 5 },
    cpuMs: { median: 0.9, p95: 1, p99: 1.2, mean: 0.9, min: 0.7, max: 2 },
    gpuWaitMs: { median: 1.9, p95: 2.6, p99: 2.8, mean: 2, min: 1.2, max: 3 },
    counters: {
      drawCalls: 157, triangles: 522484, programs: 35, canvasWidth: 1280, canvasHeight: 720, canvasPixels: 921600,
      canvasSamples: 4, sceneSamples: 4, fullscreenPasses: 0, postFillMpx: 0, shadowRenders: 0, lights: 3, shadowLights: 0, ibl: true,
    },
    phaseEnd: 'pre',
    errors: 0,
    ...over,
  });
  const result: BenchResult = {
    version: 1,
    env: { userAgent: 'x', gpu: 'SwiftShader', software: true, deviceDpr: 2, maxSamples: 4, startedAt: '' },
    params: { qualities: ['low'], scenarios: ['grid-monza'], dprs: [1], scale: 1, cssWidth: 1280, cssHeight: 720, frames: 300, warmup: 45, runs: 1, antialias: true, tune: {}, ab: false },
    rows: [row({}), row({ variant: 'tuned', frameMs: { median: 1.5, p95: 2, p99: 2.2, mean: 1.6, min: 1, max: 3 } })],
    done: true,
  };

  test('the title carries quality.scenario.dpr and the three percentiles', () => {
    expect(titleLine(result, true)).toBe('NB DONE low.grid-monza.1.r1=2.8/3.6/3.8 low.grid-monza.1t.r1=1.5/2/2.2');
    expect(titleLine(result, false).startsWith('NB RUN ')).toBe(true);
  });

  test('the raw text has a header and one line per row with the same column count', () => {
    const lines = rowsToText(result).split('\n');
    expect(lines.length).toBe(3);
    const width = (lines[0] ?? '').split('\t').length;
    for (const l of lines) expect(l.split('\t').length).toBe(width);
  });

  test('software renderers are recognised by name', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)')).toBe(false);
    expect(isSoftwareRenderer('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)')).toBe(false);
  });
});
