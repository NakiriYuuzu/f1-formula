/**
 * Touch as a third input device: the TouchDriver's finger ownership and its one reading per frame, merged by InputCore
 * like a pad poll (presses as key presses, held actions through the keyboard ramps, steer by largest magnitude).
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { kmhToMs } from '../src/core/math';
import type { KeyAction, Settings, TouchSteering } from '../src/core/types';
import { InputCore } from '../src/input/core';
import { stickToSteer, type GamepadLike } from '../src/input/gamepad';
import { InputManager } from '../src/input/index';
import { PEDAL_RAMP_RATE, STEER_RAMP_RATE_HIGH } from '../src/input/smoothing';
import {
  NO_TOUCH,
  STEER_CONTROL,
  TOUCH_STEER_DEADZONE,
  TouchDriver,
  effectiveSteering,
  pedalAt,
  tiltProblem,
  type PedalSpan,
  type TiltStatus,
  type TouchContact,
  type TouchReading,
} from '../src/input/touch';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const FRAME = 1 / 60;

function driver(steering: TouchSteering = 'drag', sensitivity = 1): TouchDriver {
  const touch = new TouchDriver(() => undefined);
  touch.configure({ steering, sensitivity });
  touch.setLive(true);
  return touch;
}

const button = (control: string, action: KeyAction, hold = false): TouchContact => ({ kind: 'button', control, action, hold });
const BRAKE: PedalSpan = { control: 'brake', action: 'brake', left: 600, right: 680 };
const THROTTLE: PedalSpan = { control: 'throttle', action: 'throttle', left: 690, right: 780 };
const pedal = (x: number): TouchContact => ({ kind: 'pedal', x, spans: [BRAKE, THROTTLE] });
const steerAt = (x: number, travel = 50): TouchContact => ({ kind: 'steer', x, travel });
const reading = (patch: Partial<TouchReading>): TouchReading => ({ ...NO_TOUCH, ...patch });

function fakePad(x = 0): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  return { index: 0, connected: true, buttons, axes: [x, 0, 0, 0] };
}

describe('InputCore with touch', () => {
  test('a DRS tap latches drsPressed exactly once while the finger stays down', () => {
    const core = new InputCore(settings());
    const touch = driver();
    touch.down(1, button('drs', 'drs'));
    core.update(FRAME, [], touch.read(FRAME));
    expect(core.getControl(0).drsPressed).toBe(true);
    core.update(FRAME, [], touch.read(FRAME));
    expect(core.getControl(0).drsPressed).toBe(false);
  });

  test('a tap shorter than a frame still presses', () => {
    const core = new InputCore(settings());
    const touch = driver();
    touch.down(1, button('drs', 'drs'));
    touch.up(1);
    core.update(FRAME, [], touch.read(FRAME));
    expect(core.getControl(0).drsPressed).toBe(true);
  });

  test('a 下一台 or pedal tap shorter than a frame reads as held on the next frame, and only that frame', () => {
    for (const [contact, action] of [
      [button('nextCar', 'steerRight', true), 'steerRight'],
      [pedal(700), 'throttle'],
    ] as const) {
      const input = new InputManager(settings());
      input.touch.setLive(true);
      input.touch.down(1, contact);
      input.touch.up(1);
      input.update(FRAME);
      expect([action, input.isHeld(action, 0)]).toEqual([action, true]);
      input.update(FRAME);
      expect([action, input.isHeld(action, 0)]).toEqual([action, false]);
    }
  });

  test('a hold over several frames is held while the finger is down and lets go on the frame after it lifts', () => {
    const input = new InputManager(settings());
    input.touch.setLive(true);
    input.touch.down(1, button('nextCar', 'steerRight', true));
    for (let i = 0; i < 3; i++) {
      input.update(FRAME);
      expect(input.isHeld('steerRight', 0)).toBe(true);
    }
    input.touch.up(1);
    input.update(FRAME);
    expect(input.isHeld('steerRight', 0)).toBe(false);
  });

  test('a pause tap queues pause for player 0, once', () => {
    const core = new InputCore(settings());
    const touch = driver();
    touch.down(1, button('pause', 'pause'));
    core.update(FRAME, [], touch.read(FRAME));
    core.update(FRAME, [], touch.read(FRAME));
    expect(core.consumeActions()).toEqual([{ action: 'pause', playerIndex: 0 }]);
  });

  test('a held throttle ramps at the pedal rate, exactly like the key', () => {
    const byFinger = new InputCore(settings());
    const byKey = new InputCore(settings());
    const touch = driver();
    touch.down(1, pedal(700));
    byKey.keyDown('KeyW');
    byFinger.update(0.05, [], touch.read(0.05));
    byKey.update(0.05);
    const throttle = byFinger.getControl(0).throttle;
    expect(throttle).toBeCloseTo(PEDAL_RAMP_RATE * 0.05, 9);
    expect(throttle).toBe(byKey.getControl(0).throttle);
    touch.up(1);
    byFinger.update(0.05, [], touch.read(0.05));
    expect(byFinger.getControl(0).throttle).toBe(0);
  });

  test('◀ held follows the speed-sensitive steering ramp', () => {
    const core = new InputCore(settings());
    core.setVehicleSpeed(0, kmhToMs(300));
    const touch = driver('buttons');
    touch.down(1, button('steerLeft', 'steerLeft', true));
    core.update(0.1, [], touch.read(0.1));
    expect(core.getControl(0).steer).toBeCloseTo(-STEER_RAMP_RATE_HIGH * 0.1, 9);
  });

  test('steer is the largest magnitude of pad, keyboard and touch', () => {
    const touchWins = new InputCore(settings());
    touchWins.keyDown('KeyD');
    touchWins.update(0.1, [fakePad(0.3)], reading({ steer: -0.8 }));
    expect(touchWins.getControl(0).steer).toBe(-0.8);

    const padWins = new InputCore(settings());
    padWins.update(0.1, [fakePad(1)], reading({ steer: 0.1 }));
    expect(padWins.getControl(0).steer).toBe(1);

    const keyWins = new InputCore(settings());
    keyWins.keyDown('KeyA');
    keyWins.update(0.1, [], reading({ steer: 0.1 }));
    expect(keyWins.getControl(0).steer).toBeCloseTo(-0.4, 9);
  });

  test('a non-finite or out-of-range touch steer is clamped, never passed on', () => {
    const core = new InputCore(settings());
    core.update(FRAME, [], reading({ steer: Number.NaN }));
    expect(core.getControl(0).steer).toBe(0);
    core.update(FRAME, [], reading({ steer: 3 }));
    expect(core.getControl(0).steer).toBe(1);
  });

  test('look back held by a finger reads as held, and overtake held reaches the control', () => {
    const core = new InputCore(settings());
    const touch = driver();
    touch.down(1, button('lookBack', 'lookBack', true));
    touch.down(2, button('overtake', 'overtake', true));
    core.update(FRAME, [], touch.read(FRAME));
    expect(core.isHeld('lookBack', 0)).toBe(true);
    expect(core.getControl(0).overtakeHeld).toBe(true);
    touch.up(1);
    touch.up(2);
    core.update(FRAME, [], touch.read(FRAME));
    expect(core.isHeld('lookBack', 0)).toBe(false);
    expect(core.getControl(0).overtakeHeld).toBe(false);
  });

  test('reset(true) and reset() drop queued presses but keep the fingers', () => {
    const input = new InputManager(settings());
    input.touch.setLive(true);
    input.touch.down(1, pedal(700));
    input.touch.down(2, button('pause', 'pause'));
    input.reset(true);
    input.update(0.1);
    expect(input.consumeActions()).toEqual([]);
    expect(input.isHeld('throttle', 0)).toBe(true);
    expect(input.getControl(0).throttle).toBeGreaterThan(0);

    input.touch.down(3, button('camera', 'camera'));
    input.reset();
    input.update(0.1);
    expect(input.consumeActions()).toEqual([]);
    expect(input.isHeld('throttle', 0)).toBe(true);
  });

  test('InputCore.reset clears the frame\'s touch state like the keyboard ramps; the next reading brings it back', () => {
    const core = new InputCore(settings());
    const held = reading({ steer: 0.7, held: new Set<KeyAction>(['throttle']) });
    core.update(0.1, [], held);
    core.reset(true);
    const after = core.getControl(0);
    expect(after.steer).toBe(0);
    expect(after.throttle).toBe(0);
    expect(core.isHeld('throttle', 0)).toBe(false);
    core.update(0.1, [], held);
    expect(core.getControl(0).steer).toBe(0.7);
    expect(core.isHeld('throttle', 0)).toBe(true);
  });

  test('in split screen, touch drives player 0 only', () => {
    const core = new InputCore(settings());
    core.setSplitScreen(true);
    core.update(0.1, [], reading({ steer: 0.7, held: new Set<KeyAction>(['throttle', 'lookBack']), presses: ['drs', 'pause'] }));
    const p0 = core.getControl(0);
    const p1 = core.getControl(1);
    expect(p0.steer).toBe(0.7);
    expect(p0.throttle).toBeGreaterThan(0);
    expect(p0.drsPressed).toBe(true);
    expect(core.isHeld('lookBack', 0)).toBe(true);
    expect(p1.steer).toBe(0);
    expect(p1.throttle).toBe(0);
    expect(p1.drsPressed).toBe(false);
    expect(core.isHeld('lookBack', 1)).toBe(false);
    expect(core.consumeActions()).toEqual([{ action: 'pause', playerIndex: 0 }]);
  });

  test('no touch reading and an idle touch device give the same controls as before', () => {
    const before = new InputCore(settings());
    const idle = new InputCore(settings());
    for (const core of [before, idle]) {
      core.keyDown('KeyW');
      core.keyDown('KeyD');
    }
    for (let i = 0; i < 20; i++) {
      const pads = [fakePad(i % 2 === 0 ? 0.5 : -0.2)];
      before.update(FRAME, pads);
      idle.update(FRAME, pads, driver().read(FRAME));
      expect(idle.getControl(0)).toEqual(before.getControl(0));
    }
  });
});

describe('TouchDriver', () => {
  test('two fingers on two pedals hold both', () => {
    const touch = driver();
    touch.down(1, pedal(640));
    touch.down(2, pedal(700));
    expect([...touch.read(FRAME).held].sort()).toEqual(['brake', 'throttle']);
  });

  test('a pedal finger rolls to the pedal under it and presses that pedal', () => {
    const touch = driver();
    touch.down(1, pedal(640));
    expect(touch.read(FRAME)).toEqual({ steer: 0, held: new Set<KeyAction>(['brake']), presses: ['brake'] });
    touch.move(1, 660);
    expect(touch.read(FRAME).presses).toEqual([]);
    touch.move(1, 720);
    expect(touch.read(FRAME)).toEqual({ steer: 0, held: new Set<KeyAction>(['throttle']), presses: ['throttle'] });
  });

  test('pedalAt: the span under x, else the nearest edge', () => {
    const spans = [BRAKE, THROTTLE];
    expect(pedalAt(spans, 650)).toBe(BRAKE);
    expect(pedalAt(spans, 700)).toBe(THROTTLE);
    expect(pedalAt(spans, 683)).toBe(BRAKE);
    expect(pedalAt(spans, 688)).toBe(THROTTLE);
    expect(pedalAt(spans, 0)).toBe(BRAKE);
    expect(pedalAt(spans, 2000)).toBe(THROTTLE);
  });

  test('a pedal contact with no spans is refused', () => {
    expect(driver().down(1, { kind: 'pedal', x: 0, spans: [] })).toBe(false);
  });

  test('the first finger on the surface owns the wheel; a second is refused', () => {
    const touch = driver();
    expect(touch.down(1, steerAt(100))).toBe(true);
    expect(touch.down(2, steerAt(300))).toBe(false);
    touch.up(1);
    expect(touch.down(3, steerAt(300))).toBe(true);
  });

  test('the surface takes no finger outside the drag scheme', () => {
    expect(driver('tilt').down(1, steerAt(100))).toBe(false);
    expect(driver('buttons').down(1, steerAt(100))).toBe(false);
  });

  test('drag steer goes through the pad stick curve with the touch deadzone', () => {
    const touch = driver('drag', 1.5);
    touch.down(1, steerAt(100, 50));
    touch.move(1, 70);
    expect(touch.read(FRAME).steer).toBe(stickToSteer(-0.6, TOUCH_STEER_DEADZONE, 1.5));
    touch.move(1, 102);
    expect(touch.read(FRAME).steer).toBe(0);
  });

  test('after an overshoot the leash unwinds at once', () => {
    const touch = driver();
    touch.down(1, steerAt(100, 50));
    touch.move(1, 200);
    expect(touch.read(FRAME).steer).toBe(1);
    touch.move(1, 190);
    const unwound = touch.read(FRAME).steer;
    expect(unwound).toBe(stickToSteer(0.8, TOUCH_STEER_DEADZONE, 1));
    expect(unwound).toBeLessThan(1);
    touch.move(1, 150);
    expect(touch.read(FRAME).steer).toBe(0);
    expect(touch.view().drag).toEqual({ origin: 150, x: 150, travel: 50 });
  });

  test('releaseControl lets go of the fingers on that control only, with no press', () => {
    const touch = driver();
    touch.down(1, button('lookBack', 'lookBack', true));
    touch.down(2, pedal(700));
    touch.down(3, steerAt(100));
    touch.move(3, 150);
    touch.read(FRAME);

    touch.releaseControl('lookBack');
    let r = touch.read(FRAME);
    expect([...r.held]).toEqual(['throttle']);
    expect(r.steer).toBe(1);
    expect(r.presses).toEqual([]);

    touch.releaseControl('brake');
    r = touch.read(FRAME);
    expect([...r.held]).toEqual(['throttle']);
    touch.move(2, 640);
    r = touch.read(FRAME);
    expect([...r.held]).toEqual(['throttle']);
    expect(r.presses).toEqual([]);

    touch.releaseControl('throttle');
    r = touch.read(FRAME);
    expect(r.held.size).toBe(0);
    expect(r.steer).toBe(1);

    touch.releaseControl(STEER_CONTROL);
    expect(touch.read(FRAME).steer).toBe(0);
    expect(touch.view().drag).toBeNull();
  });

  test('setLive(false) lets every finger go and refuses new ones; released fingers are never adopted again', () => {
    const touch = driver();
    touch.down(1, pedal(700));
    touch.down(2, button('pause', 'pause'));
    touch.setLive(false);
    expect(touch.read(FRAME)).toEqual(NO_TOUCH);
    expect(touch.down(3, pedal(700))).toBe(false);
    touch.setLive(true);
    touch.move(1, 720);
    expect(touch.read(FRAME)).toEqual({ steer: 0, held: new Set(), presses: [] });
  });

  test('an unknown pointer up or move is a no-op', () => {
    const touch = driver();
    touch.down(1, pedal(700));
    touch.read(FRAME);
    touch.up(99);
    touch.move(99, 10);
    expect(touch.read(FRAME)).toEqual({ steer: 0, held: new Set<KeyAction>(['throttle']), presses: [] });
  });

  test('a tap finger never presses again while it stays down', () => {
    const touch = driver();
    touch.down(1, button('drs', 'drs'));
    expect(touch.read(FRAME).presses).toEqual(['drs']);
    touch.move(1, 500);
    expect(touch.down(1, button('drs', 'drs'))).toBe(false);
    expect(touch.read(FRAME).presses).toEqual([]);
    expect(touch.read(FRAME).held.size).toBe(0);
    touch.up(1);
    touch.down(1, button('drs', 'drs'));
    expect(touch.read(FRAME).presses).toEqual(['drs']);
  });

  test('a steering scheme change lets the steering finger go', () => {
    const touch = driver();
    touch.down(1, steerAt(100));
    touch.move(1, 150);
    touch.configure({ steering: 'tilt', sensitivity: 1 });
    touch.configure({ steering: 'drag', sensitivity: 1 });
    expect(touch.read(FRAME).steer).toBe(0);
    expect(touch.view()).toEqual({ steering: 'drag', steer: 0, drag: null, flat: false });
  });

  test('tilt samples count only while live and the scheme is tilt', () => {
    // upright, screen angle 0, rolled 30° clockwise: full lock at sensitivity 1
    const rolledRight = { x: -9.81 * Math.sin(Math.PI / 6), y: 9.81 * Math.cos(Math.PI / 6), z: 0 };

    const drag = driver('drag');
    drag.motion(rolledRight, 0, 1);
    expect(drag.read(FRAME).steer).toBe(0);

    const hidden = new TouchDriver(() => undefined);
    hidden.configure({ steering: 'tilt', sensitivity: 1 });
    hidden.motion(rolledRight, 0, 1);
    hidden.setLive(true);
    expect(hidden.read(FRAME).steer).toBe(0);

    hidden.motion(rolledRight, 0, 1);
    expect(hidden.read(FRAME).steer).toBeCloseTo(1, 9);
    expect(hidden.view().steer).toBeCloseTo(1, 9);

    hidden.setLive(false);
    hidden.setLive(true);
    expect(hidden.read(FRAME).steer).toBe(0);
  });

  test('enableTilt asks the adapter for the motion permission', () => {
    let asked = 0;
    const touch = new TouchDriver(() => asked++);
    touch.enableTilt();
    expect(asked).toBe(1);
  });
});

describe('steering scheme tables', () => {
  const statuses: TiltStatus[] = ['off', 'needs-permission', 'waiting', 'active', 'denied', 'unavailable', 'insecure'];

  test('effectiveSteering: tilt only once samples arrive, otherwise drag; the other schemes as chosen', () => {
    for (const status of statuses) {
      expect(effectiveSteering('drag', status)).toBe('drag');
      expect(effectiveSteering('buttons', status)).toBe('buttons');
      expect(effectiveSteering('tilt', status)).toBe(status === 'active' ? 'tilt' : 'drag');
    }
  });

  test('tiltProblem: denied, unavailable and insecure, only while tilt is chosen', () => {
    for (const status of statuses) {
      const problem = status === 'denied' || status === 'unavailable' || status === 'insecure' ? status : null;
      expect(tiltProblem('tilt', status)).toBe(problem);
      expect(tiltProblem('drag', status)).toBeNull();
      expect(tiltProblem('buttons', status)).toBeNull();
    }
  });
});
