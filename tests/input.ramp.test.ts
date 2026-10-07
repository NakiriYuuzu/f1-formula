/**
 * Speed-dependent keyboard steering ramp: ~6/s at low speed down to ~2.5/s near 300 km/h, return-to-centre stays at
 * STEER_RETURN_RATE, and nothing changes while the vehicle speed was never reported.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { kmhToMs } from '../src/core/math';
import { InputCore } from '../src/input/core';
import {
  STEER_RAMP_RATE,
  STEER_RAMP_RATE_HIGH,
  STEER_RAMP_RATE_LOW,
  STEER_RETURN_RATE,
  stepDigitalSteer,
  steerRampRate,
} from '../src/input/smoothing';

describe('steerRampRate curve', () => {
  test('unknown speed keeps the fixed ramp', () => {
    expect(steerRampRate(null)).toBe(STEER_RAMP_RATE);
    expect(steerRampRate(Number.NaN)).toBe(STEER_RAMP_RATE);
    expect(steerRampRate(Number.POSITIVE_INFINITY)).toBe(STEER_RAMP_RATE);
  });

  test('fast at low speed, slow near 300 km/h, clamped beyond', () => {
    expect(steerRampRate(0)).toBeCloseTo(STEER_RAMP_RATE_LOW, 9);
    expect(steerRampRate(kmhToMs(40))).toBeCloseTo(STEER_RAMP_RATE_LOW, 9);
    expect(steerRampRate(kmhToMs(300))).toBeCloseTo(STEER_RAMP_RATE_HIGH, 9);
    expect(steerRampRate(kmhToMs(380))).toBeCloseTo(STEER_RAMP_RATE_HIGH, 9);
    expect(steerRampRate(kmhToMs(170))).toBeCloseTo((STEER_RAMP_RATE_LOW + STEER_RAMP_RATE_HIGH) / 2, 9);
    expect(STEER_RAMP_RATE_LOW).toBeCloseTo(6, 9);
    expect(STEER_RAMP_RATE_HIGH).toBeCloseTo(2.5, 9);
  });

  test('monotonically non-increasing with speed; reversing speed counts as its magnitude', () => {
    let prev = Infinity;
    for (let kmh = 0; kmh <= 360; kmh += 5) {
      const r = steerRampRate(kmhToMs(kmh));
      expect(r).toBeLessThanOrEqual(prev + 1e-12);
      expect(r).toBeGreaterThanOrEqual(STEER_RAMP_RATE_HIGH - 1e-12);
      expect(r).toBeLessThanOrEqual(STEER_RAMP_RATE_LOW + 1e-12);
      prev = r;
    }
    expect(steerRampRate(-kmhToMs(200))).toBe(steerRampRate(kmhToMs(200)));
  });
});

describe('stepDigitalSteer with a ramp rate', () => {
  test('ramp-out uses the given rate; default argument keeps STEER_RAMP_RATE', () => {
    expect(stepDigitalSteer(0, 1, 0.1)).toBeCloseTo(STEER_RAMP_RATE * 0.1, 9);
    expect(stepDigitalSteer(0, 1, 0.1, 1, 2.5)).toBeCloseTo(0.25, 9);
    expect(stepDigitalSteer(0, -1, 0.1, 1, 6)).toBeCloseTo(-0.6, 9);
    expect(stepDigitalSteer(0, 1, 0.1, 1, Number.NaN)).toBeCloseTo(STEER_RAMP_RATE * 0.1, 9);
    expect(stepDigitalSteer(0, 1, 0.1, 1, -3)).toBeCloseTo(STEER_RAMP_RATE * 0.1, 9);
  });

  test('return to centre stays at STEER_RETURN_RATE whatever the ramp rate', () => {
    expect(1 - stepDigitalSteer(1, 0, 0.1, 1, 2.5)).toBeCloseTo(STEER_RETURN_RATE * 0.1, 9);
    expect(1 - stepDigitalSteer(1, 0, 0.1, 1, 6)).toBeCloseTo(STEER_RETURN_RATE * 0.1, 9);
  });

  test('reversal snaps through centre and then uses the ramp rate', () => {
    expect(stepDigitalSteer(0.9, -1, 0.05, 1, 2.5)).toBeCloseTo(-0.125, 9);
  });
});

describe('InputCore.setVehicleSpeed', () => {
  const core = (): InputCore => new InputCore({ ...DEFAULT_SETTINGS });

  test('never set: unchanged 4/s ramp', () => {
    const c = core();
    c.keyDown('KeyD');
    c.update(0.1);
    expect(c.getControl(0).steer).toBeCloseTo(STEER_RAMP_RATE * 0.1, 9);
  });

  test('low speed ramps faster, high speed slower; return stays fast', () => {
    const slow = core();
    slow.setVehicleSpeed(0, kmhToMs(20));
    slow.keyDown('KeyD');
    slow.update(0.1);
    expect(slow.getControl(0).steer).toBeCloseTo(0.6, 9);

    const fast = core();
    fast.setVehicleSpeed(0, kmhToMs(300));
    fast.keyDown('KeyA');
    fast.update(0.1);
    expect(fast.getControl(0).steer).toBeCloseTo(-0.25, 9);
    for (let i = 0; i < 10; i++) fast.update(0.1);
    expect(fast.getControl(0).steer).toBe(-1);
    fast.keyUp('KeyA');
    fast.update(0.1);
    expect(fast.getControl(0).steer).toBeCloseTo(-1 + STEER_RETURN_RATE * 0.1, 9);
  });

  test('per player; null / NaN restore the fixed ramp; kept across reset()', () => {
    const c = core();
    c.setSplitScreen(true);
    c.setVehicleSpeed(0, kmhToMs(300));
    c.keyDown('KeyD'); // P1
    c.keyDown('ArrowRight'); // P2 (no speed reported)
    c.update(0.1);
    expect(c.getControl(0).steer).toBeCloseTo(0.25, 9);
    expect(c.getControl(1).steer).toBeCloseTo(STEER_RAMP_RATE * 0.1, 9);

    c.reset();
    c.keyDown('KeyD');
    c.update(0.1);
    expect(c.getControl(0).steer).toBeCloseTo(0.25, 9);

    c.reset();
    c.setVehicleSpeed(0, Number.NaN);
    c.keyDown('KeyD');
    c.update(0.1);
    expect(c.getControl(0).steer).toBeCloseTo(STEER_RAMP_RATE * 0.1, 9);

    c.reset();
    c.setVehicleSpeed(0, kmhToMs(300));
    c.setVehicleSpeed(0, null);
    c.keyDown('KeyD');
    c.update(0.1);
    expect(c.getControl(0).steer).toBeCloseTo(STEER_RAMP_RATE * 0.1, 9);
  });

  test('gamepad steering is not affected by the keyboard ramp', () => {
    const c = core();
    c.setVehicleSpeed(0, kmhToMs(300));
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    c.update(1 / 60, [{ index: 0, connected: true, buttons, axes: [1, 0, 0, 0] }]);
    expect(c.getControl(0).steer).toBe(1);
  });
});
