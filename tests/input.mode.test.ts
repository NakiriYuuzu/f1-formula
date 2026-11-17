/**
 * The input mode (last deliberate input): pad rising edges in InputCore, keys and pointers through InputManager, and
 * html[data-input-mode] written once per change.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import type { Settings } from '../src/core/types';
import { InputCore } from '../src/input/core';
import type { GamepadLike } from '../src/input/gamepad';
import { InputManager } from '../src/input/index';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const FRAME = 1 / 60;

function fakePad(opts: { pressed?: number[]; rt?: number; x?: number } = {}): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const pressed = opts.pressed?.includes(i) ?? false;
    return { pressed, value: pressed ? 1 : 0 };
  });
  buttons[7] = { pressed: (opts.rt ?? 0) > 0.5, value: opts.rt ?? 0 };
  return { index: 0, connected: true, buttons, axes: [opts.x ?? 0, 0, 0, 0] };
}

function touchCore(): InputCore {
  const core = new InputCore(settings());
  core.noteDevice('touch');
  return core;
}

describe('gamepad mode from rising edges only', () => {
  test('a mapped button pressed flips to gamepad; one already down when the pad is first seen does not', () => {
    const core = touchCore();
    core.update(FRAME, [fakePad({ pressed: [0] })]);
    core.update(FRAME, [fakePad({ pressed: [0] })]);
    expect(core.mode).toBe('touch');
    core.update(FRAME, [fakePad()]);
    expect(core.mode).toBe('touch');
    core.update(FRAME, [fakePad({ pressed: [0] })]);
    expect(core.mode).toBe('gamepad');
  });

  test('a D-pad step flips to gamepad', () => {
    const core = touchCore();
    core.update(FRAME, [fakePad()]);
    core.update(FRAME, [fakePad({ pressed: [14] })]);
    expect(core.mode).toBe('gamepad');
  });

  test('a trigger crossing 0.5 flips; a resting trigger and stick drift do not', () => {
    const core = touchCore();
    core.update(FRAME, [fakePad({ rt: 0.3, x: 0.3 })]);
    core.update(FRAME, [fakePad({ rt: 0.4, x: 0.45 })]);
    core.update(FRAME, [fakePad({ rt: 0.3, x: -0.45 })]);
    expect(core.mode).toBe('touch');
    core.update(FRAME, [fakePad({ rt: 0.9 })]);
    expect(core.mode).toBe('gamepad');
  });

  test('a stick pushed past 0.5 flips; a trigger held through the first sighting does not', () => {
    const held = touchCore();
    held.update(FRAME, [fakePad({ rt: 1 })]);
    held.update(FRAME, [fakePad({ rt: 1 })]);
    expect(held.mode).toBe('touch');

    const stick = touchCore();
    stick.update(FRAME, [fakePad()]);
    stick.update(FRAME, [fakePad({ x: -0.95 })]);
    expect(stick.mode).toBe('gamepad');
  });
});

class FakeHTMLElement {
  isContentEditable = false;
}
class FakeInputElement extends FakeHTMLElement {
  constructor(readonly type: string) {
    super();
  }
}

/** isTextEntryTarget checks DOM classes; bun has none, so the text-field case installs stand-ins for its duration. */
function withDomClasses(run: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const names = ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'];
  const saved = names.map((n) => [n, g[n]] as const);
  Object.assign(g, {
    HTMLElement: FakeHTMLElement,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: class extends FakeHTMLElement {},
    HTMLSelectElement: class extends FakeHTMLElement {},
  });
  try {
    run();
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete g[n];
      else g[n] = v;
    }
  }
}

function modeWindow() {
  const listeners = new Map<string, (e: unknown) => void>();
  const writes: string[] = [];
  const win = {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: () => undefined,
    document: {
      hidden: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      documentElement: { setAttribute: (name: string, value: string) => writes.push(`${name}=${value}`) },
    },
  };
  const emit = (type: string, e: Record<string, unknown>): void => listeners.get(type)?.(e);
  return {
    win: win as unknown as Window,
    writes,
    key: (code: string, target: unknown = null) =>
      emit('keydown', { code, repeat: false, metaKey: false, isComposing: false, cancelable: false, target }),
    pointer: (type: 'pointerdown' | 'pointermove', pointerType: string, movementX = 0) =>
      emit(type, { pointerType, movementX, movementY: 0 }),
  };
}

describe('InputManager mode listeners', () => {
  test('a key typed into a text field keeps touch; a key elsewhere flips to keyboard', () => {
    withDomClasses(() => {
      const fake = modeWindow();
      const input = new InputManager(settings());
      input.attach(fake.win, { initialMode: 'touch' });
      fake.key('KeyA', new FakeInputElement('text'));
      expect(input.mode).toBe('touch');
      fake.key('KeyA', new FakeInputElement('range'));
      expect(input.mode).toBe('keyboard');
    });
  });

  test('a key while capture is suspended still counts as the keyboard', () => {
    const fake = modeWindow();
    const input = new InputManager(settings());
    input.attach(fake.win, { initialMode: 'touch' });
    input.setCaptureSuspended(true);
    fake.key('KeyW');
    expect(input.mode).toBe('keyboard');
    expect(input.isHeld('throttle', 0)).toBe(false);
  });

  test('a touch or pen pointer flips to touch; a moving mouse flips back, a still one does not', () => {
    const fake = modeWindow();
    const input = new InputManager(settings());
    input.attach(fake.win, { initialMode: 'keyboard' });
    fake.pointer('pointerdown', 'touch');
    expect(input.mode).toBe('touch');
    fake.pointer('pointermove', 'mouse', 0);
    expect(input.mode).toBe('touch');
    fake.pointer('pointermove', 'touch', 12);
    expect(input.mode).toBe('touch');
    fake.pointer('pointermove', 'mouse', 3);
    expect(input.mode).toBe('keyboard');
    fake.pointer('pointerdown', 'pen');
    expect(input.mode).toBe('touch');
    fake.pointer('pointerdown', 'mouse');
    expect(input.mode).toBe('keyboard');
  });

  test('html[data-input-mode] is written at attach and then once per change', () => {
    const fake = modeWindow();
    const input = new InputManager(settings());
    input.attach(fake.win, { initialMode: 'touch' });
    expect(input.mode).toBe('touch');
    fake.pointer('pointerdown', 'touch');
    fake.pointer('pointermove', 'mouse', 4);
    fake.pointer('pointermove', 'mouse', 4);
    fake.key('KeyW');
    fake.pointer('pointerdown', 'touch');
    expect(fake.writes).toEqual(['data-input-mode=touch', 'data-input-mode=keyboard', 'data-input-mode=touch']);
  });

  test('attached as keyboard (desktop), the attribute says keyboard from the start', () => {
    const fake = modeWindow();
    const input = new InputManager(settings());
    input.attach(fake.win, { initialMode: 'keyboard' });
    fake.key('KeyW');
    expect(fake.writes).toEqual(['data-input-mode=keyboard']);
  });

  test('a pad press seen by update writes the attribute', () => {
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    let pads = [fakePad()];
    Object.defineProperty(nav, 'getGamepads', { value: () => pads, configurable: true });
    try {
      const fake = modeWindow();
      const input = new InputManager(settings());
      input.attach(fake.win, { initialMode: 'touch' });
      input.update(FRAME);
      pads = [fakePad({ pressed: [9] })];
      input.update(FRAME);
      input.update(FRAME);
      expect(input.mode).toBe('gamepad');
      expect(fake.writes).toEqual(['data-input-mode=touch', 'data-input-mode=gamepad']);
    } finally {
      delete nav.getGamepads;
    }
  });
});
