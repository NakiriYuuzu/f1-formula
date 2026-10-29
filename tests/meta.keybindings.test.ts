/**
 * Key-binding migration (old saves gain the P2 actions added later) and the settings key-capture rules.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_KEY_BINDINGS, DEFAULT_KEY_BINDINGS_P2 } from '../src/core/defaults';
import { sanitizeSettings } from '../src/meta/save';
import { captureStep, clashesWithP1Pause, isPadEvent, markPadEvent } from '../src/ui/menus/keyCapture';

/** A P2 record as written before ersCycle / pitRequest / mfd existed. */
const OLD_P2 = {
  throttle: ['ArrowUp'],
  brake: ['ArrowDown'],
  steerLeft: ['ArrowLeft'],
  steerRight: ['ArrowRight'],
  shiftUp: ['Period'],
  shiftDown: ['Comma'],
  drs: ['Slash'],
  overtake: ['ShiftRight'],
  camera: ['Backslash'],
  lookBack: ['Quote'],
};

describe('P2 key binding migration', () => {
  test('actions absent from an old save get their default codes', () => {
    const p2 = sanitizeSettings({ keyBindings: DEFAULT_KEY_BINDINGS, keyBindingsP2: OLD_P2 }).keyBindingsP2;
    expect(p2.ersCycle).toEqual(DEFAULT_KEY_BINDINGS_P2.ersCycle ?? []);
    expect(p2.pitRequest).toEqual(DEFAULT_KEY_BINDINGS_P2.pitRequest ?? []);
    expect(p2.mfd).toEqual(DEFAULT_KEY_BINDINGS_P2.mfd ?? []);
    expect(p2.throttle).toEqual(['ArrowUp']);
  });

  test('an explicitly saved empty array stays empty; a code used elsewhere is skipped', () => {
    const p2 = sanitizeSettings({
      keyBindings: { ...DEFAULT_KEY_BINDINGS, flashback: ['BracketRight'] }, // P1 took P2's default MFD key
      keyBindingsP2: { ...OLD_P2, ersCycle: [], pitRequest: ['Semicolon'] }, // Semicolon is P2's own default ersCycle key
    }).keyBindingsP2;
    expect(p2.ersCycle).toEqual([]);
    expect(p2.pitRequest).toEqual(['Semicolon']);
    expect(p2.mfd).toBeUndefined();
  });

  test('a saved P2 code is not duplicated by a default for another action', () => {
    const p2 = sanitizeSettings({ keyBindings: DEFAULT_KEY_BINDINGS, keyBindingsP2: { ...OLD_P2, shiftUp: ['BracketLeft'] } }).keyBindingsP2;
    expect(p2.pitRequest).toBeUndefined();
    expect(p2.mfd).toEqual(['BracketRight']);
  });
});

describe('key capture', () => {
  const key = (code: string, repeat = false): { code: string; repeat: boolean } => ({ code, repeat });

  test('pad presses never bind: B cancels, A / D-pad are ignored', () => {
    const a = {};
    markPadEvent(a);
    expect(isPadEvent(a)).toBe(true);
    expect(isPadEvent({})).toBe(false);
    expect(captureStep(key('Enter'), 'drs', true)).toEqual({ kind: 'ignore' });
    expect(captureStep(key('ArrowLeft'), 'drs', true)).toEqual({ kind: 'ignore' });
    expect(captureStep(key('Escape'), 'drs', true)).toEqual({ kind: 'cancel' });
    expect(captureStep(key('Escape'), 'pause', true)).toEqual({ kind: 'cancel' });
  });

  test('keyboard capture is unchanged', () => {
    expect(captureStep(key('Enter'), 'drs', false)).toEqual({ kind: 'bind', code: 'Enter' });
    expect(captureStep(key('Escape'), 'drs', false)).toEqual({ kind: 'cancel' });
    expect(captureStep(key('Escape'), 'pause', false)).toEqual({ kind: 'bind', code: 'Escape' });
    expect(captureStep(key('Delete'), 'drs', false)).toEqual({ kind: 'clear' });
    expect(captureStep(key('KeyZ', true), 'drs', false)).toEqual({ kind: 'ignore' });
  });

  test('P2 may not take P1\'s pause key', () => {
    expect(clashesWithP1Pause('p2', ['Escape', 'KeyP'], 'KeyP')).toBe(true);
    expect(clashesWithP1Pause('p2', ['Escape', 'KeyP'], 'KeyZ')).toBe(false);
    expect(clashesWithP1Pause('p1', ['Escape', 'KeyP'], 'KeyP')).toBe(false);
  });
});
