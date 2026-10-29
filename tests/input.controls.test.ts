/**
 * Input fixes: a key held through a pause survives the resume, Cmd release frees stuck keys, one press per action per
 * poll with two pads, and per-player D-pad compound steps (MFD).
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import type { Settings } from '../src/core/types';
import { InputManager } from '../src/input/index';
import { InputCore } from '../src/input/core';
import type { GamepadLike } from '../src/input/gamepad';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

function fakePad(index: number, pressed: number[] = []): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 }));
  return { index, connected: true, buttons, axes: [0, 0, 0, 0] };
}

describe('keys held through a pause', () => {
  test('reset(keepKeyboard) keeps held keys; a plain reset drops them', () => {
    const core = new InputCore(settings());
    core.keyDown('KeyW');
    core.keyDown('Escape'); // the pause key itself
    core.reset(true);
    expect(core.isHeld('throttle', 0)).toBe(true);
    expect(core.consumeActions()).toEqual([]); // queued presses are still dropped
    core.update(0.1);
    expect(core.getControl(0).throttle).toBeGreaterThan(0);
    core.keyUp('KeyW'); // released during the pause: gone after the resume
    core.reset(true);
    expect(core.isHeld('throttle', 0)).toBe(false);

    core.keyDown('KeyW');
    core.reset();
    expect(core.isHeld('throttle', 0)).toBe(false);
  });
});

describe('Cmd release (macOS drops the keyups of other keys while Cmd is down)', () => {
  test('keyup of a Meta key releases every held key', () => {
    const listeners = new Map<string, (e: unknown) => void>();
    const win = {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      removeEventListener: () => undefined,
      document: { addEventListener: () => undefined, removeEventListener: () => undefined },
    };
    const input = new InputManager(settings());
    input.attach(win as unknown as Window);
    const key = (type: 'keydown' | 'keyup', code: string): void =>
      listeners.get(type)?.({ code, repeat: false, metaKey: code.startsWith('Meta') && type === 'keydown', isComposing: false, cancelable: false, target: null });
    key('keydown', 'KeyW');
    expect(input.isHeld('throttle', 0)).toBe(true);
    key('keydown', 'MetaLeft');
    key('keyup', 'KeyW'); // swallowed by the OS in a real browser: never delivered
    key('keyup', 'MetaLeft');
    expect(input.isHeld('throttle', 0)).toBe(false);
    input.detach();
  });
});

describe('two pads in single player', () => {
  test('the same queued action pressed on both pads in one poll is queued once', () => {
    const core = new InputCore(settings());
    core.update(0.016, [fakePad(0), fakePad(1)]);
    core.update(0.016, [fakePad(0, [3]), fakePad(1, [3])]); // Y = camera
    expect(core.consumeActions()).toEqual([{ action: 'camera', playerIndex: 0 }]);
  });
});

describe('D-pad compound steps', () => {
  test('left/right presses are reported per player, once per press, from that player\'s pad only', () => {
    const core = new InputCore(settings());
    core.setSplitScreen(true);
    core.update(0.016, [fakePad(0), fakePad(1)]);
    core.update(0.016, [fakePad(0, [15]), fakePad(1, [14])]);
    expect(core.consumePadSteps()).toEqual([
      { playerIndex: 0, step: 1 },
      { playerIndex: 1, step: -1 },
    ]);
    core.update(0.016, [fakePad(0, [15]), fakePad(1, [14])]); // still held: no repeat
    expect(core.consumePadSteps()).toEqual([]);
    expect(core.consumeActions()).toEqual([]); // not a driving action
  });

  test('two single-player pads pressing the same side count once; reset drops pending steps', () => {
    const core = new InputCore(settings());
    core.update(0.016, [fakePad(0), fakePad(1)]);
    core.update(0.016, [fakePad(0, [15]), fakePad(1, [15])]);
    expect(core.consumePadSteps()).toEqual([{ playerIndex: 0, step: 1 }]);
    core.update(0.016, [fakePad(0), fakePad(1)]);
    core.update(0.016, [fakePad(0, [14]), fakePad(1)]);
    core.reset();
    expect(core.consumePadSteps()).toEqual([]);
  });
});
