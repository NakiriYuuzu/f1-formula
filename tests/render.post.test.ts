/**
 * Post-processing look + adaptive resolution (pure helpers of src/render/core/post.ts) and the quality profile
 * post fields: bloom / grade selection by time of day, biome, weather and quality; ACES inverse; the frame-time
 * controller's steps, floor, ceiling, hysteresis, hitch rejection and anti-oscillation backoff.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import type { Biome, QualityLevel, TimeOfDay } from '../src/core/types';
import { sanitizeSettings } from '../src/meta/save';
import {
  ADAPTIVE_MIN_SCALE,
  AdaptiveResolution,
  BLOOM_OVERCAST_THRESHOLD,
  SPEED_BLUR_FULL_SPEED,
  SPEED_BLUR_MAX,
  SPEED_BLUR_MIN_SPEED,
  acesFilmic,
  acesFilmicInverse,
  bloomParams,
  createPostLook,
  gradeParams,
  showroomLook,
  speedBlurAmount,
} from '../src/render/core/post';
import { qualityProfile } from '../src/render/core/quality';

const TIMES: TimeOfDay[] = ['day', 'dusk', 'night'];
const BIOMES: Biome[] = ['temperate', 'autumn', 'desert', 'coastal', 'city', 'tropical'];
const LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
const luma = (t: [number, number, number]): number => t[0] * 0.2126 + t[1] * 0.7152 + t[2] * 0.0722;

/** Feed `seconds` of constant `frameMs` frames; returns the scale afterwards. */
function run(ctrl: AdaptiveResolution, frameMs: number, seconds: number): number {
  const n = Math.round((seconds * 1000) / frameMs);
  for (let i = 0; i < n; i++) ctrl.sample(frameMs / 1000);
  return ctrl.scale;
}

describe('quality profile post fields', () => {
  test('low renders directly, medium has half-resolution bloom, high / ultra the full chain', () => {
    expect(qualityProfile('low').post).toBe(false);
    expect(qualityProfile('low').vignette).toBe(false);
    expect(qualityProfile('medium').post).toBe(true);
    expect(qualityProfile('medium').bloomScale).toBe(0.5);
    for (const l of ['high', 'ultra'] as const) {
      expect(qualityProfile(l).post).toBe(true);
      expect(qualityProfile(l).bloomScale).toBe(1);
      expect(qualityProfile(l).vignette).toBe(true);
    }
    // existing budgets untouched
    expect(qualityProfile('high').shadowMapSize).toBe(2048);
    expect(qualityProfile('low').propDensity).toBe(0.25);
  });
});

describe('bloom parameters', () => {
  test('night strongest, day subtle; low quality has none; medium ≤ high ≤ ultra', () => {
    const s = (t: TimeOfDay, q: QualityLevel = 'high'): number => bloomParams(t, q, 0.12, 0).strength;
    expect(s('night')).toBeGreaterThan(s('dusk'));
    expect(s('dusk')).toBeGreaterThan(s('day'));
    for (const t of TIMES) {
      expect(s(t, 'low')).toBe(0);
      expect(s(t, 'medium')).toBeLessThan(s(t, 'high'));
      expect(s(t, 'high')).toBeLessThanOrEqual(s(t, 'ultra'));
    }
  });

  test('thresholds keep lit surfaces out: night ~0.95–1.05, day above sun-lit white; cloud lowers day, never night', () => {
    const night = bloomParams('night', 'high', 0, 0).threshold;
    expect(night).toBeGreaterThanOrEqual(0.95);
    expect(night).toBeLessThanOrEqual(1.05);
    const clearDay = bloomParams('day', 'high', 0, 0).threshold;
    expect(clearDay).toBeGreaterThan(1.3);
    const overcastDay = bloomParams('day', 'high', 1, 0).threshold;
    expect(overcastDay).toBeCloseTo(BLOOM_OVERCAST_THRESHOLD, 6);
    expect(bloomParams('night', 'high', 1, 0).threshold).toBeCloseTo(night, 6);
  });

  test('rain adds glare; radius stays in 0..1; garbage input is safe', () => {
    for (const t of TIMES) {
      expect(bloomParams(t, 'high', 1, 1).strength).toBeGreaterThan(bloomParams(t, 'high', 1, 0).strength);
      for (const q of LEVELS) {
        const p = bloomParams(t, q, 0.5, 0.5);
        expect(p.radius).toBeGreaterThanOrEqual(0);
        expect(p.radius).toBeLessThanOrEqual(1);
      }
    }
    const p = bloomParams('night', 'high', Number.NaN, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(p.strength) && Number.isFinite(p.threshold)).toBe(true);
  });

  test('writes into the provided object', () => {
    const look = createPostLook();
    const out = bloomParams('dusk', 'ultra', 0.3, 0.2, look.bloom);
    expect(out).toBe(look.bloom);
  });
});

describe('colour grade', () => {
  test('tint never changes exposure (luminance 1) and stays gentle everywhere', () => {
    for (const b of BIOMES) {
      for (const t of TIMES) {
        for (const rain of [0, 0.5, 1]) {
          const g = gradeParams(b, t, rain);
          expect(luma(g.tint)).toBeCloseTo(1, 6);
          for (const c of g.tint) expect(Math.abs(c - 1)).toBeLessThan(0.15);
          expect(g.saturation).toBeGreaterThan(0.7);
          expect(g.saturation).toBeLessThan(1.2);
          expect(g.contrast).toBeGreaterThan(0.9);
          expect(g.contrast).toBeLessThan(1.1);
          // lift only raises blacks, and only a little (never crushes, never washes out)
          expect(g.lift).toBeGreaterThanOrEqual(0);
          expect(g.lift).toBeLessThan(0.02);
        }
      }
    }
  });

  test('dusk warmer, night cooler, rain desaturated', () => {
    const dusk = gradeParams('temperate', 'dusk', 0);
    expect(dusk.tint[0]).toBeGreaterThan(dusk.tint[2]);
    const night = gradeParams('temperate', 'night', 0);
    expect(night.tint[2]).toBeGreaterThan(night.tint[0]);
    for (const b of BIOMES) {
      for (const t of TIMES) expect(gradeParams(b, t, 1).saturation).toBeLessThan(gradeParams(b, t, 0).saturation);
    }
  });

  test('showroom look: light bloom only with post quality, vignette follows the profile flag', () => {
    expect(showroomLook('low', false).bloom.strength).toBe(0);
    const high = showroomLook('high', true);
    expect(high.bloom.strength).toBeGreaterThan(0);
    expect(high.vignette).toBeGreaterThan(0);
    expect(showroomLook('medium', false).vignette).toBe(0);
  });
});

describe('speed blur', () => {
  test('none at strength 0, below the start speed, or for garbage input', () => {
    expect(speedBlurAmount(80, 0)).toBe(0);
    expect(speedBlurAmount(SPEED_BLUR_MIN_SPEED, 1)).toBe(0);
    expect(speedBlurAmount(20, 1)).toBe(0);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
      expect(speedBlurAmount(bad, 1)).toBe(0);
      expect(speedBlurAmount(80, bad)).toBe(0);
    }
  });

  test('grows with speed and saturates at SPEED_BLUR_MAX × strength', () => {
    let prev = 0;
    for (let v = SPEED_BLUR_MIN_SPEED + 5; v <= SPEED_BLUR_FULL_SPEED; v += 5) {
      const b = speedBlurAmount(v, 1);
      expect(b).toBeGreaterThan(prev);
      prev = b;
    }
    expect(speedBlurAmount(SPEED_BLUR_FULL_SPEED, 1)).toBeCloseTo(SPEED_BLUR_MAX, 9);
    expect(speedBlurAmount(120, 1)).toBeCloseTo(SPEED_BLUR_MAX, 9);
  });

  test('scales linearly with strength, clamped to 0..1', () => {
    for (const v of [60, 75, 90]) {
      expect(speedBlurAmount(v, 0.5)).toBeCloseTo(speedBlurAmount(v, 1) * 0.5, 9);
      expect(speedBlurAmount(v, 0.25)).toBeCloseTo(speedBlurAmount(v, 1) * 0.25, 9);
    }
    expect(speedBlurAmount(90, 3)).toBeCloseTo(SPEED_BLUR_MAX, 9);
  });

  test('neutral and showroom looks have none', () => {
    expect(createPostLook().speedBlur).toBe(0);
    const reused = createPostLook();
    reused.speedBlur = SPEED_BLUR_MAX;
    expect(showroomLook('high', true, reused).speedBlur).toBe(0);
  });

  test('strength setting defaults to 50 %, is clamped to 0..1 and survives sanitising', () => {
    expect(DEFAULT_SETTINGS.speedBlur).toBe(0.5);
    expect(sanitizeSettings({}).speedBlur).toBe(0.5);
    expect(sanitizeSettings({ speedBlur: 0 }).speedBlur).toBe(0);
    expect(sanitizeSettings({ speedBlur: 0.8 }).speedBlur).toBe(0.8);
    expect(sanitizeSettings({ speedBlur: 4 }).speedBlur).toBe(1);
    expect(sanitizeSettings({ speedBlur: -1 }).speedBlur).toBe(0);
    expect(sanitizeSettings({ speedBlur: 'off' }).speedBlur).toBe(0.5);
    // the earlier on/off toggle: off stays off, on becomes the default strength
    expect(sanitizeSettings({ speedBlur: false }).speedBlur).toBe(0);
    expect(sanitizeSettings({ speedBlur: true }).speedBlur).toBe(0.5);
  });
});

describe('ACES helpers', () => {
  test('inverse round-trips and lifts dark backdrop colours', () => {
    for (const exposure of [1, 1.18]) {
      for (const y of [0.001, 0.002, 0.01, 0.05, 0.2, 0.5, 0.9]) {
        expect(acesFilmic(acesFilmicInverse(y, exposure), exposure)).toBeCloseTo(y, 6);
      }
    }
    // ACES crushes very dark values, so the inverse must raise them
    expect(acesFilmicInverse(0.002, 1)).toBeGreaterThan(0.002);
    expect(acesFilmicInverse(0, 1)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(acesFilmicInverse(Number.NaN, 1))).toBe(true);
  });
});

describe('adaptive resolution', () => {
  test('steady 60 fps never changes the scale', () => {
    const c = new AdaptiveResolution();
    expect(run(c, 16.7, 30)).toBe(1);
    expect(c.lastAverageMs).toBeCloseTo(16.7, 1);
  });

  test('slow frames step down by 0.1 every other window and floor at 60 %', () => {
    const c = new AdaptiveResolution();
    expect(run(c, 25, 2.05)).toBe(0.9);
    // the window right after a change is discarded (reallocation hitch)
    expect(run(c, 25, 2)).toBe(0.9);
    expect(run(c, 25, 2)).toBe(0.8);
    expect(run(c, 25, 60)).toBe(ADAPTIVE_MIN_SCALE);
  });

  test('fast frames step back up after ~4 s, never above the user choice', () => {
    const c = new AdaptiveResolution();
    run(c, 25, 2.05);
    expect(c.scale).toBe(0.9);
    // settle window + 2 s fast: not yet
    expect(run(c, 8, 4)).toBe(0.9);
    expect(run(c, 8, 2.1)).toBe(1);
    expect(run(c, 8, 30)).toBe(1);
  });

  test('frame times inside the 17.5–19 ms band hold the current scale (hysteresis)', () => {
    const c = new AdaptiveResolution();
    run(c, 25, 6.1);
    expect(c.scale).toBe(0.8);
    expect(run(c, 18.5, 60)).toBe(0.8);
  });

  test('a vsync-locked 60 Hz frame rate (16.7 ms) is fast enough to restore the resolution', () => {
    const c = new AdaptiveResolution();
    run(c, 25, 2.05);
    expect(c.scale).toBe(0.9);
    expect(run(c, 1000 / 60, 30)).toBe(1);
  });

  test('hitches (tab switch, loading, shader compile) are ignored', () => {
    const c = new AdaptiveResolution();
    for (let k = 0; k < 20; k++) {
      run(c, 16.7, 1.5);
      c.sample(1.2);
    }
    expect(c.scale).toBe(1);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(c.sample(bad)).toBe(false);
  });

  test('an up-step that must be undone doubles the hold before the next one (no oscillation)', () => {
    const c = new AdaptiveResolution();
    run(c, 25, 2.05); // down to 0.9
    run(c, 8, 6.1); // settle + 4 s fast: back up to 1
    expect(c.scale).toBe(1);
    run(c, 25, 4.1); // settle + slow, within 10 s of the up-step: down again, hold now 8 s
    expect(c.scale).toBe(0.9);
    expect(run(c, 8, 6.1)).toBe(0.9); // settle + 4 s fast is no longer enough
    expect(run(c, 8, 4.1)).toBe(1); // 8 s fast in total
  });

  test('reset returns to the full resolution', () => {
    const c = new AdaptiveResolution();
    run(c, 30, 20);
    expect(c.scale).toBeLessThan(1);
    c.reset();
    expect(c.scale).toBe(1);
    expect(Number.isNaN(c.lastAverageMs)).toBe(true);
  });
});
