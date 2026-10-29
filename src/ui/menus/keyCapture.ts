/**
 * Key-rebinding capture rules (pure, DOM-free): which key events may become a binding, and which bindings are
 * refused. Pad presses reach the menus as synthetic key events (see MenuManager.navigate); they never bind.
 */
import type { KeyAction } from '../../core/types';

const padEvents = new WeakSet<object>();

/** Mark a key event as synthesised from a gamepad press. */
export function markPadEvent(e: object): void {
  padEvents.add(e);
}

export function isPadEvent(e: object): boolean {
  return padEvents.has(e);
}

export type CaptureStep = { kind: 'ignore' } | { kind: 'cancel' } | { kind: 'clear' } | { kind: 'bind'; code: string };

/** What a key event does while a binding slot is waiting for a key. */
export function captureStep(e: { code: string; repeat: boolean }, action: KeyAction, fromPad: boolean): CaptureStep {
  if (e.repeat) return { kind: 'ignore' };
  // pad B (synthetic Esc) cancels; any other pad press is ignored (A would otherwise bind Enter)
  if (fromPad) return e.code === 'Escape' ? { kind: 'cancel' } : { kind: 'ignore' };
  // Esc cancels the capture, except on 暫停 where it is the natural key (otherwise it could never be bound back)
  if (e.code === 'Escape' && action !== 'pause') return { kind: 'cancel' };
  if (e.code === 'Backspace' || e.code === 'Delete') return { kind: 'clear' };
  if (!e.code) return { kind: 'ignore' };
  return { kind: 'bind', code: e.code };
}

/** Split-screen routes P2 codes over P1's: a P2 key that is P1's pause key would make keyboard pause impossible. */
export function clashesWithP1Pause(player: 'p1' | 'p2', p1Pause: readonly string[] | undefined, code: string): boolean {
  return player === 'p2' && (p1Pause ?? []).includes(code);
}
