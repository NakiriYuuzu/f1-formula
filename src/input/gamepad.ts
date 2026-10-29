/**
 * Gamepad mapping (pure, DOM-free). Works on any object shaped like the W3C Gamepad ("standard" mapping):
 * RT throttle, LT brake, left stick X steer, A DRS, X ERS cycle, B flashback, Y camera, LB/RB shift down/up,
 * Start pause, Back MFD, D-pad up Box, R3 look back. Extras: L3 overtake (held), D-pad down pit limiter.
 * Menu navigation (reported separately, e.g. for the pause menu): D-pad, A confirm, B back.
 */
import { clamp, clamp01 } from '../core/math';
import type { KeyAction } from '../core/types';

export interface GamepadButtonLike {
  pressed: boolean;
  value: number;
}

export interface GamepadLike {
  index: number;
  connected: boolean;
  buttons: readonly GamepadButtonLike[];
  axes: readonly number[];
}

/** Standard-mapping button index → action. Triggers (6/7) are analog and handled separately. */
export const PAD_BUTTON_ACTIONS: readonly (readonly [number, KeyAction])[] = [
  [0, 'drs'],
  [1, 'flashback'],
  [2, 'ersCycle'],
  [3, 'camera'],
  [4, 'shiftDown'],
  [5, 'shiftUp'],
  [8, 'mfd'],
  [9, 'pause'],
  [10, 'overtake'],
  [11, 'lookBack'],
  [12, 'pitRequest'],
  [13, 'limiter'],
];

/** Menu navigation from a pad (pause menu): D-pad directions, A confirm, B back. */
export type PadMenuInput = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';
export const PAD_MENU_BUTTONS: readonly (readonly [number, PadMenuInput])[] = [
  [12, 'up'],
  [13, 'down'],
  [14, 'left'],
  [15, 'right'],
  [0, 'confirm'],
  [1, 'back'],
];

/** D-pad left/right (unused while driving): step the tyre compound in an open MFD, per player. */
export const PAD_COMPOUND_BUTTONS: readonly (readonly [number, -1 | 1])[] = [
  [14, -1],
  [15, 1],
];

export const PAD_BUTTON_BRAKE = 6;
export const PAD_BUTTON_THROTTLE = 7;
export const PAD_AXIS_STEER = 0;
/** Fixed trigger deadzone (worn triggers rarely rest exactly at 0). */
export const TRIGGER_DEADZONE = 0.05;
const MAX_STICK_DEADZONE = 0.9;
const PRESS_THRESHOLD = 0.5;

/** Analog value (0..1) of a button; 0 for missing/invalid entries. */
export function buttonValue(pad: GamepadLike, index: number): number {
  const b = pad.buttons[index];
  if (!b) return 0;
  const v = Number.isFinite(b.value) ? b.value : 0;
  return clamp01(b.pressed && v === 0 ? 1 : v);
}

export function buttonPressed(pad: GamepadLike, index: number): boolean {
  const b = pad.buttons[index];
  if (!b) return false;
  return b.pressed || (Number.isFinite(b.value) && b.value > PRESS_THRESHOLD);
}

/** Trigger travel → 0..1 with a small fixed deadzone, rescaled so full travel still reaches 1. */
export function triggerToPedal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp01((value - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE));
}

/**
 * Response exponent for the steering curve. sensitivity 1 → 1.4 (slight non-linearity, finer centre control);
 * lower sensitivity softens the centre further, higher sensitivity makes it more direct.
 */
export function steerExponent(sensitivity: number): number {
  const s = Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : 1;
  return clamp(1.4 / s, 0.9, 2.5);
}

/** Stick X (-1..1) → steer (-1..1, + = right): axial deadzone, rescale, response curve, clamp. */
export function stickToSteer(x: number, deadzone: number, sensitivity: number): number {
  if (!Number.isFinite(x)) return 0;
  const dz = clamp(Number.isFinite(deadzone) ? deadzone : 0, 0, MAX_STICK_DEADZONE);
  const mag = Math.abs(clamp(x, -1, 1));
  if (mag <= dz) return 0;
  const t = (mag - dz) / (1 - dz);
  return Math.sign(x) * clamp01(Math.pow(t, steerExponent(sensitivity)));
}

/** One pad's driving reading. */
export interface PadReading {
  throttle: number;
  brake: number;
  steer: number;
  /** actions whose mapped button is currently down */
  held: KeyAction[];
}

export function readPad(pad: GamepadLike, deadzone: number, sensitivity: number): PadReading {
  const held: KeyAction[] = [];
  for (const [index, action] of PAD_BUTTON_ACTIONS) {
    if (buttonPressed(pad, index)) held.push(action);
  }
  return {
    throttle: triggerToPedal(buttonValue(pad, PAD_BUTTON_THROTTLE)),
    brake: triggerToPedal(buttonValue(pad, PAD_BUTTON_BRAKE)),
    steer: stickToSteer(pad.axes[PAD_AXIS_STEER] ?? 0, deadzone, sensitivity),
    held,
  };
}

/** Compound-step buttons currently down on a pad. */
export function readPadSteps(pad: GamepadLike): (-1 | 1)[] {
  const down: (-1 | 1)[] = [];
  for (const [index, step] of PAD_COMPOUND_BUTTONS) if (buttonPressed(pad, index)) down.push(step);
  return down;
}

/**
 * Which connected pads drive which player. Split-screen: 1st connected pad → player 0, 2nd → player 1.
 * Single player: every connected pad drives player 0 (so a controller that enumerated at index 1 still works).
 */
export function padsForPlayer<T extends GamepadLike>(
  pads: readonly (T | null | undefined)[],
  playerIndex: 0 | 1,
  splitScreen: boolean,
): T[] {
  const connected: T[] = [];
  for (const p of pads) if (p && p.connected !== false) connected.push(p);
  if (!splitScreen) return playerIndex === 0 ? connected : [];
  const pad = connected[playerIndex];
  return pad ? [pad] : [];
}
