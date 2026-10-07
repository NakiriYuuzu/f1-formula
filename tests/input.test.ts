/**
 * Input logic tests: binding routing (incl. split-screen exclusivity), one-shot latches, smoothing ramps,
 * gamepad axis/trigger mapping, action queue and reset. Pure modules only (no DOM).
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import type { Settings } from '../src/core/types';
import { buildBindingTable, resolveKey } from '../src/input/bindings';
import { InputCore, MAX_QUEUED_ACTIONS } from '../src/input/core';
import { padsForPlayer, readPad, stickToSteer, triggerToPedal, type GamepadLike } from '../src/input/gamepad';
import { STEER_RAMP_RATE, digitalSteerTarget, stepDigitalSteer, stepPedal } from '../src/input/smoothing';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

function fakePad(index: number, opts: { pressed?: number[]; lt?: number; rt?: number; x?: number } = {}): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const pressed = opts.pressed?.includes(i) ?? false;
    return { pressed, value: pressed ? 1 : 0 };
  });
  buttons[6] = { pressed: (opts.lt ?? 0) > 0.5, value: opts.lt ?? 0 };
  buttons[7] = { pressed: (opts.rt ?? 0) > 0.5, value: opts.rt ?? 0 };
  return { index, connected: true, buttons, axes: [opts.x ?? 0, 0, 0, 0] };
}

/** Run n updates of dt. */
function run(core: InputCore, n: number, dt: number, pads: (GamepadLike | null)[] = []): void {
  for (let i = 0; i < n; i++) core.update(dt, pads);
}

describe('binding routing', () => {
  const table = buildBindingTable(DEFAULT_SETTINGS);

  test('single player: arrows and WASD both drive player 0', () => {
    expect(resolveKey(table, 'ArrowUp', false)).toEqual([{ action: 'throttle', playerIndex: 0 }]);
    expect(resolveKey(table, 'KeyW', false)).toEqual([{ action: 'throttle', playerIndex: 0 }]);
    expect(resolveKey(table, 'Slash', false)).toEqual([]);
    expect(resolveKey(table, 'KeyZ', false)).toEqual([]);
  });

  test('split-screen: P2 keys are routed exclusively to player 1', () => {
    expect(resolveKey(table, 'ArrowUp', true)).toEqual([{ action: 'throttle', playerIndex: 1 }]);
    expect(resolveKey(table, 'Slash', true)).toEqual([{ action: 'drs', playerIndex: 1 }]);
    expect(resolveKey(table, 'KeyW', true)).toEqual([{ action: 'throttle', playerIndex: 0 }]);
    expect(resolveKey(table, 'Escape', true)).toEqual([{ action: 'pause', playerIndex: 0 }]);
  });

  test('a code bound to several actions resolves to all of them; malformed entries are ignored', () => {
    const custom = buildBindingTable({
      keyBindings: { ...DEFAULT_SETTINGS.keyBindings, drs: ['KeyE'], camera: ['', 'KeyC'] },
      keyBindingsP2: { brake: 'oops' as unknown as string[] },
    });
    const actions = resolveKey(custom, 'KeyE', false).map((r) => r.action);
    expect(actions).toContain('shiftUp');
    expect(actions).toContain('drs');
    expect(resolveKey(custom, '', false)).toEqual([]);
    expect(resolveKey(custom, 'ArrowDown', true)).toEqual([{ action: 'brake', playerIndex: 0 }]);
  });

  test('InputCore split routing: P2 throttle does not leak into player 0', () => {
    const core = new InputCore(settings());
    core.setSplitScreen(true);
    core.keyDown('ArrowUp');
    run(core, 30, 1 / 60);
    expect(core.getControl(1).throttle).toBe(1);
    expect(core.getControl(0).throttle).toBe(0);
    core.keyUp('ArrowUp');
    core.setSplitScreen(false);
    core.keyDown('ArrowUp');
    run(core, 30, 1 / 60);
    expect(core.getControl(0).throttle).toBe(1);
    expect(core.getControl(1).throttle).toBe(0);
  });
});

describe('one-shot latches', () => {
  test('shift press is true exactly once', () => {
    const core = new InputCore(settings());
    core.keyDown('KeyE');
    expect(core.getControl(0).shiftUp).toBe(true);
    expect(core.getControl(0).shiftUp).toBe(false);
    // still held, key repeat must not re-latch
    core.keyDown('KeyE', true);
    core.keyDown('KeyE');
    expect(core.getControl(0).shiftUp).toBe(false);
    core.keyUp('KeyE');
    core.keyDown('KeyE');
    expect(core.getControl(0).shiftUp).toBe(true);
  });

  test('press + release before the next read is still delivered once', () => {
    const core = new InputCore(settings());
    core.keyDown('Space');
    core.keyUp('Space');
    core.keyDown('KeyX');
    core.keyUp('KeyX');
    core.keyDown('KeyL');
    core.keyUp('KeyL');
    const c = core.getControl(0);
    expect(c.drsPressed).toBe(true);
    expect(c.ersCycle).toBe(true);
    expect(c.limiterToggle).toBe(true);
    const c2 = core.getControl(0);
    expect(c2.drsPressed || c2.ersCycle || c2.limiterToggle).toBe(false);
  });

  test('gamepad buttons latch on the rising edge only', () => {
    const core = new InputCore(settings());
    core.update(1 / 60, [fakePad(0)]);
    core.update(1 / 60, [fakePad(0, { pressed: [5] })]); // RB = shift up
    expect(core.getControl(0).shiftUp).toBe(true);
    core.update(1 / 60, [fakePad(0, { pressed: [5] })]);
    expect(core.getControl(0).shiftUp).toBe(false);
    core.update(1 / 60, [fakePad(0)]);
    core.update(1 / 60, [fakePad(0, { pressed: [4] })]); // LB = shift down
    expect(core.getControl(0).shiftDown).toBe(true);
  });

  test('buttons already held when a pad first appears are not presses', () => {
    const core = new InputCore(settings());
    core.update(1 / 60, [fakePad(0, { pressed: [5, 9] })]);
    expect(core.getControl(0).shiftUp).toBe(false);
    expect(core.consumeActions()).toEqual([]);
  });

  test('overtake is a held flag, not a latch', () => {
    const core = new InputCore(settings());
    core.keyDown('ShiftLeft');
    expect(core.getControl(0).overtakeHeld).toBe(true);
    expect(core.getControl(0).overtakeHeld).toBe(true);
    core.keyUp('ShiftLeft');
    expect(core.getControl(0).overtakeHeld).toBe(false);
  });
});

describe('action queue', () => {
  test('non-driving presses are queued once and drained', () => {
    const core = new InputCore(settings());
    core.keyDown('Escape');
    core.keyDown('Escape', true);
    core.keyDown('KeyC');
    core.keyDown('KeyV');
    core.keyDown('KeyW');
    expect(core.consumeActions()).toEqual([
      { action: 'pause', playerIndex: 0 },
      { action: 'camera', playerIndex: 0 },
      { action: 'lookBack', playerIndex: 0 },
    ]);
    expect(core.consumeActions()).toEqual([]);
    expect(core.isHeld('lookBack', 0)).toBe(true);
  });

  test('gamepad Start / Y / D-pad up / Back / B / R3 map to actions', () => {
    const core = new InputCore(settings());
    core.update(1 / 60, [fakePad(0)]);
    core.update(1 / 60, [fakePad(0, { pressed: [9, 3, 12, 8, 1, 11] })]);
    const actions = core.consumeActions().map((a) => a.action).sort();
    expect(actions).toEqual(['camera', 'flashback', 'lookBack', 'mfd', 'pause', 'pitRequest']);
    expect(core.isHeld('lookBack', 0)).toBe(true);
  });

  test('gamepad D-pad / A / B also report menu navigation on the rising edge (any pad)', () => {
    const core = new InputCore(settings());
    core.update(1 / 60, [fakePad(0), fakePad(1)]);
    core.update(1 / 60, [fakePad(0, { pressed: [12, 15, 0] }), fakePad(1, { pressed: [13, 1] })]);
    expect(core.consumeMenuInputs().sort()).toEqual(['back', 'confirm', 'down', 'right', 'up']);
    core.update(1 / 60, [fakePad(0, { pressed: [12, 15, 0] }), fakePad(1, { pressed: [13, 1] })]);
    expect(core.consumeMenuInputs()).toEqual([]);
    core.update(1 / 60, [fakePad(0, { pressed: [14] }), fakePad(1)]);
    core.reset();
    expect(core.consumeMenuInputs()).toEqual([]);
  });

  test('queue is bounded', () => {
    const core = new InputCore(settings());
    for (let i = 0; i < MAX_QUEUED_ACTIONS * 3; i++) {
      core.keyDown('KeyC');
      core.keyUp('KeyC');
    }
    expect(core.consumeActions().length).toBe(MAX_QUEUED_ACTIONS);
  });
});

describe('smoothing', () => {
  test('digital steer target', () => {
    expect(digitalSteerTarget(true, false)).toBe(-1);
    expect(digitalSteerTarget(false, true)).toBe(1);
    expect(digitalSteerTarget(true, true)).toBe(0);
  });

  test('ramps toward lock at ~4/s and clamps at 1', () => {
    let v = 0;
    v = stepDigitalSteer(v, 1, 0.1);
    expect(v).toBeCloseTo(STEER_RAMP_RATE * 0.1, 6);
    for (let i = 0; i < 50; i++) v = stepDigitalSteer(v, 1, 0.1);
    expect(v).toBe(1);
  });

  test('returns to centre faster than it ramps out', () => {
    const out = stepDigitalSteer(0, 1, 0.1);
    const back = 1 - stepDigitalSteer(1, 0, 0.1);
    expect(back).toBeGreaterThan(out);
    let v = 1;
    for (let i = 0; i < 20; i++) v = stepDigitalSteer(v, 0, 0.05);
    expect(v).toBe(0);
  });

  test('reversal snaps through centre', () => {
    const v = stepDigitalSteer(0.9, -1, 0.05);
    expect(v).toBeLessThan(0);
    expect(v).toBeCloseTo(-STEER_RAMP_RATE * 0.05, 6);
  });

  test('pedal ramps at ~8/s and stays in 0..1; bad numbers are safe', () => {
    expect(stepPedal(0, true, 0.05)).toBeCloseTo(0.4, 6);
    expect(stepPedal(0.95, true, 0.1)).toBe(1);
    expect(stepPedal(0.05, false, 0.1)).toBe(0);
    expect(stepPedal(Number.NaN, true, 0.05)).toBeCloseTo(0.4, 6);
    expect(stepDigitalSteer(Number.NaN, 1, Number.POSITIVE_INFINITY)).toBe(0);
    expect(stepPedal(0, true, -1)).toBe(0);
  });

  test('InputCore keyboard steer follows held keys and recentres', () => {
    const core = new InputCore(settings());
    core.keyDown('KeyD');
    run(core, 60, 1 / 60);
    expect(core.getControl(0).steer).toBe(1);
    core.keyUp('KeyD');
    core.keyDown('KeyA');
    core.update(1 / 60);
    expect(core.getControl(0).steer).toBeLessThan(0);
    core.keyUp('KeyA');
    run(core, 60, 1 / 60);
    expect(core.getControl(0).steer).toBe(0);
  });

  test('a huge dt (tab switch) is clamped', () => {
    const core = new InputCore(settings());
    core.keyDown('KeyD');
    core.update(10);
    const steer = core.getControl(0).steer;
    expect(steer).toBeGreaterThan(0);
    expect(steer).toBeLessThan(1);
  });
});

describe('gamepad mapping', () => {
  test('stick deadzone, rescale and clamp', () => {
    expect(stickToSteer(0.05, 0.08, 1)).toBe(0);
    expect(stickToSteer(-0.08, 0.08, 1)).toBe(0);
    expect(stickToSteer(1, 0.08, 1)).toBe(1);
    expect(stickToSteer(-1.4, 0.08, 1)).toBe(-1);
    const half = stickToSteer(0.54, 0.08, 1);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(0.5); // slight non-linearity: finer centre
    expect(stickToSteer(-0.54, 0.08, 1)).toBeCloseTo(-half, 9);
    expect(stickToSteer(Number.NaN, 0.08, 1)).toBe(0);
    expect(stickToSteer(0.5, 5, 1)).toBe(0); // absurd deadzone is clamped, no NaN
    expect(Number.isFinite(stickToSteer(0.95, 5, 1))).toBe(true);
  });

  test('higher sensitivity responds more near centre', () => {
    expect(stickToSteer(0.4, 0.08, 1.5)).toBeGreaterThan(stickToSteer(0.4, 0.08, 0.5));
  });

  test('triggers map to pedals with a small deadzone', () => {
    expect(triggerToPedal(0.03)).toBe(0);
    expect(triggerToPedal(1)).toBe(1);
    expect(triggerToPedal(0.525)).toBeCloseTo(0.5, 6);
    expect(triggerToPedal(Number.NaN)).toBe(0);
  });

  test('readPad maps RT/LT/stick and held buttons', () => {
    const r = readPad(fakePad(0, { rt: 1, lt: 0.525, x: -1, pressed: [0, 10] }), 0.08, 1);
    expect(r.throttle).toBe(1);
    expect(r.brake).toBeCloseTo(0.5, 6);
    expect(r.steer).toBe(-1);
    expect(r.held).toContain('drs');
    expect(r.held).toContain('overtake');
  });

  test('readPad tolerates short button/axis arrays', () => {
    const r = readPad({ index: 0, connected: true, buttons: [], axes: [] }, 0.1, 1);
    expect(r).toEqual({ throttle: 0, brake: 0, steer: 0, held: [] });
  });

  test('pad assignment: split = 1st/2nd connected pad, single = all pads to player 0', () => {
    const a = fakePad(0);
    const b = fakePad(2);
    const pads = [a, null, b];
    expect(padsForPlayer(pads, 0, true)).toEqual([a]);
    expect(padsForPlayer(pads, 1, true)).toEqual([b]);
    expect(padsForPlayer(pads, 0, false)).toEqual([a, b]);
    expect(padsForPlayer(pads, 1, false)).toEqual([]);
    expect(padsForPlayer([{ ...a, connected: false }], 0, false)).toEqual([]);
  });

  test('InputCore merges pad and keyboard; split-screen pad 1 drives player 1', () => {
    const core = new InputCore(settings());
    core.setSplitScreen(true);
    const pads = [fakePad(0, { rt: 0.5 }), fakePad(1, { lt: 1, x: 1 })];
    core.update(1 / 60, pads);
    const p0 = core.getControl(0);
    const p1 = core.getControl(1);
    expect(p0.throttle).toBeCloseTo(triggerToPedal(0.5), 6);
    expect(p0.brake).toBe(0);
    expect(p1.brake).toBe(1);
    expect(p1.steer).toBe(1);
    expect(p1.throttle).toBe(0);
  });
});

describe('reset', () => {
  test('clears held keys, latches, smoothing, pad state and queue', () => {
    const core = new InputCore(settings());
    core.keyDown('KeyW');
    core.keyDown('KeyD');
    core.keyDown('KeyE');
    core.keyDown('Escape');
    run(core, 30, 1 / 60, [fakePad(0, { rt: 1 })]);
    core.reset();
    const c = core.getControl(0);
    expect(c).toEqual({
      throttle: 0,
      brake: 0,
      steer: 0,
      shiftUp: false,
      shiftDown: false,
      drsPressed: false,
      ersCycle: false,
      limiterToggle: false,
      overtakeHeld: false,
    });
    expect(core.consumeActions()).toEqual([]);
    expect(core.isHeld('throttle', 0)).toBe(false);
    run(core, 30, 1 / 60);
    expect(core.getControl(0).throttle).toBe(0);
  });

  test('a key still held after reset is re-registered by its auto-repeat without a press', () => {
    const core = new InputCore(settings());
    core.keyDown('KeyW');
    core.reset();
    core.keyDown('KeyW', true);
    run(core, 30, 1 / 60);
    expect(core.getControl(0).throttle).toBe(1);
    core.keyDown('KeyE');
    core.reset();
    core.keyDown('KeyE', true);
    expect(core.getControl(0).shiftUp).toBe(false);
  });

  test('pad buttons held across a reset do not fire', () => {
    const core = new InputCore(settings());
    core.update(1 / 60, [fakePad(0)]);
    core.update(1 / 60, [fakePad(0, { pressed: [9] })]);
    core.reset();
    core.update(1 / 60, [fakePad(0, { pressed: [9] })]);
    expect(core.consumeActions()).toEqual([]);
  });
});
