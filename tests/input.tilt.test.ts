/**
 * Tilt steering: device samples (recorded or synthetic) through InputManager, a synthetic pose grid, the lock and
 * deadzone settings, the gravity filter, and the motion status machine against a hand-written fake window.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import type { Settings } from '../src/core/types';
import { InputManager, TILT_FIRST_SAMPLE_MS } from '../src/input/index';
import {
  TILT_DEADZONE_DEG,
  TILT_MIN_G,
  TILT_TAU,
  deviceUp,
  filterUp,
  tiltRoll,
  tiltToSteer,
  toScreen,
  type GravitySign,
  type Vec3,
} from '../src/input/tilt';
import { TouchDriver, effectiveSteering } from '../src/input/touch';
import fixture from './fixtures/tilt-samples.json';
import { poseToSample } from './tiltPoses';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const FRAME = 1 / 60;

type Platform = 'android' | 'ios' | 'none';

/** A window with what the motion adapter reads: listeners, a manual clock for timers, the screen angle. */
function motionWindow(platform: Platform, opts: { secure?: boolean; answer?: 'granted' | 'denied' } = {}) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const timers = new Map<number, { due: number; fn: () => void }>();
  let clock = 0;
  let nextTimer = 1;
  let asked = 0;
  const orientation = { angle: 90 };
  const win: Record<string, unknown> = {
    isSecureContext: opts.secure ?? true,
    screen: { orientation },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn),
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(nextTimer, { due: clock + ms, fn });
      return nextTimer++;
    },
    clearTimeout: (id: number) => timers.delete(id),
    document: { hidden: false, addEventListener: () => undefined, removeEventListener: () => undefined, documentElement: { setAttribute: () => undefined } },
  };
  if (platform === 'android') win.DeviceMotionEvent = {};
  if (platform === 'ios') {
    win.DeviceMotionEvent = {
      requestPermission: () => {
        asked++;
        return Promise.resolve(opts.answer ?? 'granted');
      },
    };
  }
  return {
    win: win as unknown as Window,
    orientation,
    asked: () => asked,
    listening: () => (listeners.get('devicemotion')?.size ?? 0) > 0,
    sample: (a: Vec3 | { x: null; y: null; z: null }) => {
      for (const fn of listeners.get('devicemotion') ?? []) fn({ accelerationIncludingGravity: a });
    },
    advance: (ms: number) => {
      clock += ms;
      for (const [id, t] of [...timers]) {
        if (t.due > clock) continue;
        timers.delete(id);
        t.fn();
      }
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function tiltManager(platform: Platform, opts: { secure?: boolean; answer?: 'granted' | 'denied' } = {}) {
  const s = settings({ touchSteering: 'tilt' });
  const fake = motionWindow(platform, opts);
  const input = new InputManager(s);
  input.attach(fake.win, { initialMode: 'touch' });
  input.touch.setLive(true);
  const contract = (): void => expect(input.hudInput().steering).toBe(effectiveSteering(s.touchSteering, input.tiltStatus));
  return { input, fake, settings: s, contract };
}

/** The screen-axis up vector of an upright screen rolled `rollDeg` clockwise. */
function rolled(rollDeg: number, g = 9.81): Vec3 {
  const r = (rollDeg * Math.PI) / 180;
  return { x: -g * Math.sin(r), y: g * Math.cos(r), z: 0 };
}

describe('device samples through InputManager', () => {
  const rows = fixture.rows.map((row) => {
    const name = `${row.platform} ${row.screenAngle}° lean ${row.pose.leanDeg} roll ${row.pose.rollDeg}${row.synthetic ? ' (synthetic)' : ''}`;
    return [name, row] as const;
  });

  test.each(rows)('%s', async (_name, row) => {
    const { input, fake } = tiltManager(row.platform as Platform);
    if (row.platform === 'ios') {
      void input.requestTilt();
      await flush();
    }
    fake.orientation.angle = row.screenAngle;
    fake.sample(row.sample);
    input.update(FRAME);
    const steer = input.getControl(0).steer;
    expect(steer).toBeGreaterThanOrEqual(row.expect.steerMin);
    expect(steer).toBeLessThanOrEqual(row.expect.steerMax);
    expect(input.touch.view().flat).toBe(row.expect.flat);
  });

  test('every platform and landscape hold has rows', () => {
    const holds = new Set(fixture.rows.map((r) => `${r.platform} ${r.screenAngle}`));
    expect([...holds].sort()).toEqual(['android 270', 'android 90', 'ios 270', 'ios 90']);
  });

  test('the screen angle is read per sample: turning the device over mid-race keeps right as right', () => {
    const { input, fake } = tiltManager('android');
    fake.orientation.angle = 90;
    fake.sample(poseToSample({ leanDeg: 30, rollDeg: 20, screenAngleDeg: 90 }, 1));
    input.update(FRAME);
    const before = input.getControl(0).steer;
    expect(before).toBeGreaterThan(0.5);
    fake.orientation.angle = 270;
    for (let i = 0; i < 60; i++) {
      fake.sample(poseToSample({ leanDeg: 30, rollDeg: 20, screenAngleDeg: 270 }, 1));
      input.update(FRAME);
    }
    expect(input.getControl(0).steer).toBeCloseTo(before, 6);
  });
});

describe('synthetic pose grid', () => {
  const angles = [0, 90, 180, 270];
  const signs: GravitySign[] = [1, -1];
  const rolls = Array.from({ length: 19 }, (_, i) => -45 + i * 5);
  const screenUp = (leanDeg: number, rollDeg: number, angle: number, sign: GravitySign): Vec3 =>
    toScreen(deviceUp(poseToSample({ leanDeg, rollDeg, screenAngleDeg: angle }, sign), sign), angle);

  test('under a 65° lean the roll is recovered within 0.5° and steers its own way at full weight', () => {
    for (const angle of angles) {
      for (const sign of signs) {
        for (let lean = 0; lean < 65; lean += 5) {
          for (const roll of rolls) {
            const up = screenUp(lean, roll, angle, sign);
            expect(Math.abs(tiltRoll(up) - roll)).toBeLessThan(0.5);
            const { steer, flat } = tiltToSteer(up, 1);
            expect(flat).toBe(false);
            if (Math.abs(roll) <= TILT_DEADZONE_DEG) expect(steer).toBe(0);
            else expect(Math.sign(steer)).toBe(Math.sign(roll));
            if (Math.abs(roll) >= 30) expect(Math.abs(steer)).toBeCloseTo(1, 9);
          }
        }
      }
    }
  });

  test('between the flat thresholds the steer fades and reads flat; from 80° it is zero', () => {
    for (const angle of angles) {
      for (const sign of signs) {
        for (const roll of [-30, -10, 10, 30]) {
          const full = tiltToSteer(screenUp(0, roll, angle, sign), 1).steer;
          let previous = Math.abs(full);
          for (const lean of [70, 75]) {
            const { steer, flat } = tiltToSteer(screenUp(lean, roll, angle, sign), 1);
            expect(flat).toBe(true);
            expect(Math.sign(steer)).toBe(Math.sign(roll));
            expect(Math.abs(steer)).toBeLessThan(previous);
            previous = Math.abs(steer);
          }
          for (const lean of [80, 85, 90]) {
            expect(tiltToSteer(screenUp(lean, roll, angle, sign), 1)).toEqual({ steer: 0, flat: true });
          }
        }
      }
    }
  });
});

describe('tilt settings and filter', () => {
  test('full lock is 30° at sensitivity 1 and 20° at 1.5, clamped to 18°..50°', () => {
    expect(tiltToSteer(rolled(30), 1).steer).toBeCloseTo(1, 9);
    expect(tiltToSteer(rolled(29), 1).steer).toBeLessThan(0.99);
    expect(tiltToSteer(rolled(-20), 1.5).steer).toBeCloseTo(-1, 9);
    expect(tiltToSteer(rolled(-19), 1.5).steer).toBeGreaterThan(-0.99);
    expect(tiltToSteer(rolled(18), 3).steer).toBeCloseTo(1, 9);
    expect(tiltToSteer(rolled(17), 3).steer).toBeLessThan(0.99);
    expect(tiltToSteer(rolled(50), 0.5).steer).toBeCloseTo(1, 9);
    expect(tiltToSteer(rolled(49), 0.5).steer).toBeLessThan(0.99);
  });

  test('the deadzone is 2.5° and the curve exponent 1.2', () => {
    expect(tiltToSteer(rolled(2.4), 1).steer).toBe(0);
    expect(tiltToSteer(rolled(-2.4), 1).steer).toBe(0);
    expect(tiltToSteer(rolled(2.6), 1).steer).toBeGreaterThan(0);
    expect(tiltToSteer(rolled(16.25), 1).steer).toBeCloseTo(Math.pow(0.5, 1.2), 9);
  });

  test('a device held upside down clamps to full lock on its side', () => {
    expect(tiltToSteer(rolled(135), 1).steer).toBeCloseTo(1, 9);
    expect(tiltToSteer(rolled(-135), 1).steer).toBeCloseTo(-1, 9);
  });

  test('a reading under TILT_MIN_G, or not a number, reads flat and straight', () => {
    expect(tiltToSteer(rolled(30, TILT_MIN_G - 0.1), 1)).toEqual({ steer: 0, flat: true });
    expect(tiltToSteer({ x: Number.NaN, y: 9.81, z: 0 }, 1)).toEqual({ steer: 0, flat: true });
  });

  test('the filter step response follows τ; dt 0 holds, a huge dt jumps, null primes', () => {
    const from = { x: 0, y: 9.81, z: 0 };
    const to = { x: 9.81, y: 0, z: 0 };
    const k = 1 - Math.exp(-1);
    const step = filterUp(from, to, TILT_TAU);
    expect(step.x).toBeCloseTo(9.81 * k, 9);
    expect(step.y).toBeCloseTo(9.81 * (1 - k), 9);
    expect(filterUp(from, to, 0)).toEqual(from);
    const jump = filterUp(from, to, 100);
    expect(jump.x).toBeCloseTo(9.81, 9);
    expect(jump.y).toBeCloseTo(0, 9);
    expect(filterUp(null, to, FRAME)).toEqual(to);
  });
});

describe('InputManager motion status', () => {
  test('another scheme: off, no listener, drag', () => {
    const fake = motionWindow('android');
    const s = settings({ touchSteering: 'drag' });
    const input = new InputManager(s);
    input.attach(fake.win, { initialMode: 'touch' });
    expect(input.tiltStatus).toBe('off');
    expect(fake.listening()).toBe(false);
    expect(input.hudInput()).toEqual({ mode: 'touch', steering: 'drag', tiltPending: false, tiltProblem: null });
  });

  test('an insecure page: insecure, drag, the problem reported', () => {
    const { input, fake, contract } = tiltManager('android', { secure: false });
    expect(input.tiltStatus).toBe('insecure');
    expect(fake.listening()).toBe(false);
    expect(input.hudInput().tiltProblem).toBe('insecure');
    contract();
  });

  test('no motion API: unavailable', () => {
    const { input, contract } = tiltManager('none');
    expect(input.tiltStatus).toBe('unavailable');
    expect(input.hudInput().tiltProblem).toBe('unavailable');
    contract();
  });

  test('Android listens at once; no sample within TILT_FIRST_SAMPLE_MS is unavailable', async () => {
    const { input, fake, contract } = tiltManager('android');
    expect(input.tiltStatus).toBe('waiting');
    expect(fake.listening()).toBe(true);
    contract();
    const settled = input.requestTilt();
    fake.sample({ x: null, y: null, z: null });
    fake.advance(TILT_FIRST_SAMPLE_MS - 1);
    expect(input.tiltStatus).toBe('waiting');
    fake.advance(1);
    expect(input.tiltStatus).toBe('unavailable');
    expect(fake.listening()).toBe(false);
    expect(await settled).toBe('unavailable');
    contract();
  });

  test('Android: the first sample makes tilt active and steering; choosing drag stops listening', () => {
    const { input, fake, settings: s, contract } = tiltManager('android');
    fake.sample(poseToSample({ leanDeg: 20, rollDeg: -30, screenAngleDeg: 90 }, 1));
    expect(input.tiltStatus).toBe('active');
    expect(input.hudInput().steering).toBe('tilt');
    contract();
    input.update(FRAME);
    expect(input.getControl(0).steer).toBeCloseTo(-1, 9);
    fake.advance(TILT_FIRST_SAMPLE_MS);
    expect(input.tiltStatus).toBe('active');

    input.applySettings({ ...s, touchSteering: 'drag' });
    expect(input.tiltStatus).toBe('off');
    expect(fake.listening()).toBe(false);
    expect(input.hudInput().steering).toBe('drag');
  });

  test('iOS: needs a tap; requestTilt asks synchronously, then waits for a sample', async () => {
    const { input, fake, contract } = tiltManager('ios');
    expect(input.tiltStatus).toBe('needs-permission');
    expect(input.hudInput().tiltPending).toBe(true);
    expect(fake.listening()).toBe(false);
    contract();
    const settled = input.requestTilt();
    expect(fake.asked()).toBe(1);
    await flush();
    expect(input.tiltStatus).toBe('waiting');
    expect(fake.listening()).toBe(true);
    fake.sample(poseToSample({ leanDeg: 20, rollDeg: 30, screenAngleDeg: 90 }, -1));
    expect(await settled).toBe('active');
    expect(input.hudInput()).toEqual({ mode: 'touch', steering: 'tilt', tiltPending: false, tiltProblem: null });
    input.update(FRAME);
    expect(input.getControl(0).steer).toBeCloseTo(1, 9);
  });

  test('iOS: two calls in one click share one prompt and one promise', async () => {
    const { input, fake } = tiltManager('ios');
    const first = input.requestTilt();
    const second = input.requestTilt();
    expect(second).toBe(first);
    expect(fake.asked()).toBe(1);
    await flush();
    expect(input.requestTilt()).toBe(first);
    fake.sample(poseToSample({ leanDeg: 20, rollDeg: 0, screenAngleDeg: 90 }, -1));
    expect(await Promise.all([first, second])).toEqual(['active', 'active']);
    expect(await input.requestTilt()).toBe('active');
    expect(fake.asked()).toBe(1);
  });

  test('iOS denied: denied, drag, the problem reported; a retry asks again', async () => {
    const { input, fake, contract } = tiltManager('ios', { answer: 'denied' });
    expect(await input.requestTilt()).toBe('denied');
    expect(fake.listening()).toBe(false);
    expect(input.hudInput()).toEqual({ mode: 'touch', steering: 'drag', tiltPending: false, tiltProblem: 'denied' });
    contract();
    expect(await input.requestTilt()).toBe('denied');
    expect(fake.asked()).toBe(2);
  });

  for (const [status, platform, secure] of [
    ['insecure', 'android', false],
    ['unavailable', 'none', true],
  ] as const) {
    test(`tilt chosen in the settings on a page where it is ${status}: the ask that follows settles at once, and so does a later one`, async () => {
      const fake = motionWindow(platform, { secure });
      const input = new InputManager(settings({ touchSteering: 'drag' }));
      input.attach(fake.win, { initialMode: 'touch' });
      input.applySettings(settings({ touchSteering: 'tilt' }));
      expect(input.tiltStatus).toBe(status);
      const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 50));
      expect(await Promise.race([input.requestTilt(), hung])).toBe(status);
      expect(await Promise.race([input.requestTilt(), hung])).toBe(status);
    });
  }

  test('an answer that arrives after the scheme changed is dropped', async () => {
    const { input, fake, settings: s } = tiltManager('ios');
    const settled = input.requestTilt();
    input.applySettings({ ...s, touchSteering: 'drag' });
    expect(await settled).toBe('off');
    await flush();
    expect(input.tiltStatus).toBe('off');
    expect(fake.listening()).toBe(false);
  });

  test('samples only steer while the deck is live', () => {
    const { input, fake } = tiltManager('android');
    const right = poseToSample({ leanDeg: 20, rollDeg: 30, screenAngleDeg: 90 }, 1);
    input.touch.setLive(false);
    fake.sample(right);
    input.update(FRAME);
    expect(input.getControl(0).steer).toBe(0);
    input.touch.setLive(true);
    fake.sample(right);
    input.update(FRAME);
    expect(input.getControl(0).steer).toBeCloseTo(1, 9);
  });

  test('detach stops listening', () => {
    const { input, fake } = tiltManager('android');
    input.detach();
    expect(fake.listening()).toBe(false);
    expect(input.tiltStatus).toBe('off');
  });
});

describe('a half-turn error in the gravity sign or the screen angle', () => {
  function tiltDriver(): TouchDriver {
    const touch = new TouchDriver(() => undefined);
    touch.configure({ steering: 'tilt', sensitivity: 1 });
    touch.setLive(true);
    return touch;
  }
  const firstSteer = (sample: Vec3, angle: number, sign: GravitySign): number => {
    const touch = tiltDriver();
    touch.motion(sample, angle, sign);
    return touch.read(FRAME).steer;
  };
  const otherHold = (angle: number): number => (angle === 90 ? 270 : 90);
  const settle = (touch: TouchDriver): number => {
    for (let i = 0; i < 30; i++) touch.read(FRAME);
    return touch.read(FRAME).steer;
  };
  /** Android-signed samples in the 90° hold, leaned back 20°. */
  const held = (rollDeg: number, screenAngleDeg = 90): Vec3 => poseToSample({ leanDeg: 20, rollDeg, screenAngleDeg }, 1);

  test('every pose that starts roughly upright steers the same with the sign negated, 90 and 270 swapped, or both', () => {
    const rolls = Array.from({ length: 19 }, (_, i) => -45 + i * 5);
    for (const angle of [90, 270]) {
      for (const sign of [1, -1] as const) {
        for (let lean = 0; lean <= 60; lean += 15) {
          for (const roll of rolls) {
            const sample = poseToSample({ leanDeg: lean, rollDeg: roll, screenAngleDeg: angle }, sign);
            const steer = firstSteer(sample, angle, sign);
            if (Math.abs(roll) > TILT_DEADZONE_DEG) expect(Math.sign(steer)).toBe(Math.sign(roll));
            expect(firstSteer(sample, angle, -sign as GravitySign)).toBeCloseTo(steer, 9);
            expect(firstSteer(sample, otherHold(angle), sign)).toBeCloseTo(steer, 9);
            expect(firstSteer(sample, otherHold(angle), -sign as GravitySign)).toBeCloseTo(steer, 9);
          }
        }
      }
    }
  });

  test('the decision is latched: rolling past 90° mid-corner keeps full lock on the side the wheel turned', () => {
    for (const sign of [1, -1] as const) {
      const touch = tiltDriver();
      touch.motion(held(0), 90, sign);
      expect(touch.read(FRAME).steer).toBeCloseTo(0, 9);
      for (const roll of [60, 100, 120]) {
        touch.motion(held(roll), 90, sign);
        expect(settle(touch)).toBeCloseTo(1, 6);
      }
    }
  });

  test('a new screen angle decides again: a first sample taken before the screen turned over is not kept', () => {
    const touch = tiltDriver();
    touch.motion(held(0, 270), 90, 1);
    touch.read(FRAME);
    touch.motion(held(20, 270), 270, 1);
    expect(settle(touch)).toBeCloseTo(firstSteer(held(20, 270), 270, 1), 3);
  });

  test('hiding the deck or changing the scheme decides again on the next sample', () => {
    const resets: [string, (touch: TouchDriver) => void][] = [
      ['deck hidden and shown', (touch) => (touch.setLive(false), touch.setLive(true))],
      ['scheme drag and back', (touch) => (touch.configure({ steering: 'drag', sensitivity: 1 }), touch.configure({ steering: 'tilt', sensitivity: 1 }))],
    ];
    for (const [name, reset] of resets) {
      const touch = tiltDriver();
      touch.motion(held(0, 270), 90, 1);
      touch.read(FRAME);
      reset(touch);
      touch.motion(held(20), 90, 1);
      expect([name, touch.read(FRAME).steer]).toEqual([name, firstSteer(held(20), 90, 1)]);
    }
  });
});
