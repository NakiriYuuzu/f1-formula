/**
 * Keyboard + Gamepad input (owner: audio/input agent).
 * Player 0 = keyboard (keyBindings) + gamepad #0. Player 1 (split-screen only) = keyBindingsP2 + gamepad #1.
 * In split-screen, keys listed in keyBindingsP2 are routed exclusively to player 1.
 *
 * This class is the thin browser adapter (listeners, navigator.getGamepads, haptics); all decisions live in
 * the DOM-free InputCore. Bound keys get preventDefault only while driving: getControl() was called within the
 * last DRIVING_WINDOW_MS, capture is not suspended and no text field / select / textarea has focus.
 */
import { clamp, clamp01 } from '../core/math';
import type { ControlInput, KeyAction, Settings } from '../core/types';
import type { InputAction } from './bindings';
import { InputCore } from './core';
import { padsForPlayer, type PadMenuInput } from './gamepad';

export type { InputAction } from './bindings';
export { ALL_KEY_ACTIONS, buildBindingTable, resolveKey, type BindingTable } from './bindings';
export { InputCore, MAX_QUEUED_ACTIONS, QUEUED_ACTIONS } from './core';
export {
  PAD_BUTTON_ACTIONS,
  PAD_MENU_BUTTONS,
  padsForPlayer,
  readPad,
  stickToSteer,
  triggerToPedal,
  type GamepadButtonLike,
  type GamepadLike,
  type PadMenuInput,
  type PadReading,
} from './gamepad';
export {
  STEER_RAMP_RATE,
  STEER_RAMP_RATE_HIGH,
  STEER_RAMP_RATE_LOW,
  STEER_RAMP_SPEED_HIGH,
  STEER_RAMP_SPEED_LOW,
  STEER_RETURN_RATE,
  digitalSteerTarget,
  stepDigitalSteer,
  stepPedal,
  steerRampRate,
} from './smoothing';

/** getControl() recency (ms) that counts as "driving" for preventDefault. */
export const DRIVING_WINDOW_MS = 250;
const MAX_RUMBLE_MS = 2000;

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'password',
  'tel',
  'url',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/** Text entry / select / textarea / contenteditable: keys belong to the element, never to driving. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  return false;
}

const MODIFIER_CODE = /^(Shift|Control|Alt|Meta|OS)(Left|Right)$/;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class InputManager {
  private readonly core: InputCore;
  private target: Window | null = null;
  private captureSuspended = false;
  private vibration: boolean;
  private lastControlAt = Number.NEGATIVE_INFINITY;
  private readonly rumbleState: { until: number; strength: number }[] = [
    { until: 0, strength: 0 },
    { until: 0, strength: 0 },
  ];

  constructor(settings: Settings) {
    this.core = new InputCore(settings);
    this.vibration = settings.vibration !== false;
  }

  attach(target: Window): void {
    if (this.target === target) return;
    this.detach();
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown, { capture: true });
    target.addEventListener('keyup', this.onKeyUp, { capture: true });
    target.addEventListener('blur', this.onBlur);
    target.document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  detach(): void {
    const target = this.target;
    if (!target) return;
    target.removeEventListener('keydown', this.onKeyDown, { capture: true });
    target.removeEventListener('keyup', this.onKeyUp, { capture: true });
    target.removeEventListener('blur', this.onBlur);
    target.document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.target = null;
    this.core.reset();
  }

  applySettings(settings: Settings): void {
    this.core.applySettings(settings);
    this.vibration = settings.vibration !== false;
  }

  /** Enable/disable player-2 routing. */
  setSplitScreen(enabled: boolean): void {
    this.core.setSplitScreen(enabled);
  }

  /** Poll gamepads and smooth digital steering/throttle. Call once per rendered frame with the frame dt. */
  update(dt: number): void {
    this.core.update(dt, this.readGamepads());
  }

  /**
   * Speed (m/s) of a player's car, e.g. once per frame: keyboard steering ramps out at ~6/s at low speed down to
   * ~2.5/s near 300 km/h. Never called / null = fixed ramp (unchanged behaviour).
   */
  setVehicleSpeed(playerIndex: 0 | 1, speedMs: number | null): void {
    this.core.setVehicleSpeed(playerIndex, speedMs);
  }

  /**
   * Current controls for a player. One-shot flags (shiftUp, shiftDown, drsPressed, ersCycle, limiterToggle) are latched
   * from key/button presses and returned true exactly once, then cleared.
   */
  getControl(playerIndex: 0 | 1): ControlInput {
    this.lastControlAt = now();
    return this.core.getControl(playerIndex);
  }

  /** Non-driving actions pressed since the last call (pause, camera, flashback, mfd, pitRequest, fullscreen, hud, ...). */
  consumeActions(): InputAction[] {
    return this.core.consumeActions();
  }

  /** Gamepad menu navigation (D-pad / A / B) pressed since the last call, e.g. for the pause menu. */
  consumeMenuInputs(): PadMenuInput[] {
    return this.core.consumeMenuInputs();
  }

  /** Held state of an action (e.g. lookBack). */
  isHeld(action: KeyAction, playerIndex: 0 | 1): boolean {
    return this.core.isHeld(action, playerIndex);
  }

  /** Clear all held/latched state (on pause, blur, session change). */
  reset(): void {
    this.core.reset();
  }

  rumble(playerIndex: 0 | 1, strength: number, durationMs: number): void {
    if (!this.vibration) return;
    const s = Number.isFinite(strength) ? clamp01(strength) : 0;
    const ms = Number.isFinite(durationMs) ? clamp(durationMs, 0, MAX_RUMBLE_MS) : 0;
    if (s <= 0 || ms <= 0) return;
    const t = now();
    const state = this.rumbleState[playerIndex];
    // A stronger-or-equal effect is still playing: skip to avoid re-issuing effects every frame.
    if (t < state.until && s <= state.strength) return;
    state.until = t + ms;
    state.strength = s;
    for (const pad of padsForPlayer(this.readGamepads(), playerIndex, this.core.isSplitScreen())) {
      const actuator: GamepadHapticActuator | null | undefined = pad.vibrationActuator;
      if (!actuator || typeof actuator.playEffect !== 'function') continue;
      try {
        actuator
          .playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: s, weakMagnitude: clamp01(s * 0.7 + 0.1) })
          .catch(() => undefined);
      } catch {
        // Haptics unsupported for this pad: ignore.
      }
    }
  }

  /** While true, keyboard events are ignored for driving (e.g. a text field in a menu is focused). */
  setCaptureSuspended(suspended: boolean): void {
    if (this.captureSuspended === suspended) return;
    this.captureSuspended = suspended;
    // Keyups may be swallowed while suspended; never leave keys stuck.
    this.core.releaseKeyboard();
  }

  /** True while the App is actively polling driving controls (bound keys are then preventDefault-ed). */
  isDriving(): boolean {
    return !this.captureSuspended && now() - this.lastControlAt < DRIVING_WINDOW_MS;
  }

  private readGamepads(): (Gamepad | null)[] {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
    try {
      return Array.from(navigator.getGamepads());
    } catch {
      // Blocked by permissions policy / insecure context.
      return [];
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.captureSuspended || e.isComposing || !e.code || isTextEntryTarget(e.target)) return;
    // Cmd/Win shortcuts: macOS drops the matching keyup, so never track them.
    if (e.metaKey && !MODIFIER_CODE.test(e.code)) return;
    const bound = this.core.keyDown(e.code, e.repeat);
    if (bound && e.cancelable && this.isDriving()) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!e.code) return;
    const bound = this.core.keyUp(e.code);
    if (bound && e.cancelable && this.isDriving() && !isTextEntryTarget(e.target)) e.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.core.reset();
  };

  private readonly onVisibilityChange = (): void => {
    if (this.target?.document.hidden) this.core.reset();
  };
}

