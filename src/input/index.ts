/**
 * Keyboard, gamepad and touch input (owner: audio/input agent).
 * Player 0 = keyboard (keyBindings) + gamepad #0 + touch. Player 1 (split-screen only) = keyBindingsP2 + gamepad #1.
 * In split-screen, keys listed in keyBindingsP2 are routed exclusively to player 1.
 *
 * This class is the thin browser adapter (listeners, navigator.getGamepads, devicemotion, haptics); all decisions live
 * in the DOM-free InputCore and TouchDriver. Bound keys get preventDefault only while driving: getControl() was called
 * within the last DRIVING_WINDOW_MS, capture is not suspended and no text field / select / textarea has focus.
 */
import { clamp, clamp01 } from '../core/math';
import type { ControlInput, KeyAction, Settings, TouchSteering } from '../core/types';
import type { InputAction } from './bindings';
import { InputCore, type InputMode } from './core';
import { padsForPlayer, type PadMenuInput } from './gamepad';
import type { GravitySign } from './tilt';
import {
  TouchDriver,
  effectiveSteering,
  tiltProblem,
  type EffectiveSteering,
  type TiltProblem,
  type TiltStatus,
  type TouchPort,
} from './touch';

export type { InputAction } from './bindings';
export { ALL_KEY_ACTIONS, buildBindingTable, resolveKey, type BindingTable } from './bindings';
export { InputCore, MAX_QUEUED_ACTIONS, QUEUED_ACTIONS, type InputMode } from './core';
export {
  PAD_BUTTON_ACTIONS,
  PAD_COMPOUND_BUTTONS,
  PAD_MENU_BUTTONS,
  padsForPlayer,
  readPad,
  readPadSteps,
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

/** What the HUD needs to know about input, per frame (HudFrameInfo.input). */
export interface HudInput {
  mode: InputMode;
  steering: EffectiveSteering;
  /** tilt chosen, not granted yet in this page: the deck shows 「啟用體感轉向」 over the drag surface */
  tiltPending: boolean;
  /** tilt chosen but unusable: the HUD toasts this once per session and the deck uses drag */
  tiltProblem: TiltProblem | null;
}

export const TILT_PROBLEM_TEXT: Record<TiltProblem, string> = {
  denied: '未允許使用動作感測器（可在設定中重試）',
  unavailable: '此裝置沒有可用的動作感測器',
  insecure: '體感轉向需要 HTTPS 連線',
};

/** Ms to wait for a first motion sample before calling the sensor unavailable (desktop Chrome defines the event). */
export const TILT_FIRST_SAMPLE_MS = 1500;

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

/** TiltStatus plus the moment iOS's motion prompt is open (reported as needs-permission). */
type MotionState = TiltStatus | 'asking';

/** The devicemotion listener is attached exactly in these states. */
const listens = (s: MotionState): boolean => s === 'waiting' || s === 'active';
/** A requestTilt promise resolves on the first state outside these. */
const unsettled = (s: MotionState): boolean => s === 'waiting' || s === 'asking' || s === 'needs-permission';

interface MotionApi {
  requestPermission?: () => Promise<string>;
}

function motionApi(win: Window): MotionApi | undefined {
  return (win as unknown as { DeviceMotionEvent?: MotionApi }).DeviceMotionEvent;
}

function motionProblem(win: Window): 'insecure' | 'unavailable' | null {
  if (!win.isSecureContext) return 'insecure';
  return motionApi(win) ? null : 'unavailable';
}

/** See GravitySign: the engine with the permission prompt is the engine that negates gravity. */
function gravitySign(win: Window): GravitySign {
  return typeof motionApi(win)?.requestPermission === 'function' ? -1 : 1;
}

/** Read per sample: the player may turn the device over between two landscape holds mid-race. */
function screenAngle(win: Window): number {
  const w = win as unknown as { screen?: { orientation?: { angle?: number } }; orientation?: number | string };
  return w.screen?.orientation?.angle ?? (Number(w.orientation) || 0);
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
  private readonly driver = new TouchDriver(() => void this.requestTilt());
  /** the deck's handle on the touch device */
  readonly touch: TouchPort = this.driver;
  private chosen: TouchSteering;
  private sensitivity: number;
  private motion: MotionState = 'off';
  /** runs only while waiting: no sample within TILT_FIRST_SAMPLE_MS means no sensor */
  private sampleTimer: number | null = null;
  /** the one requestTilt promise until the status settles: several callers in one click share one iOS prompt */
  private pendingTilt: { promise: Promise<TiltStatus>; resolve: (status: TiltStatus) => void } | null = null;
  /** what html[data-input-mode] shows (no attribute reads as keyboard); null = write on the next sync */
  private shownMode: InputMode | null = 'keyboard';

  constructor(settings: Settings) {
    this.core = new InputCore(settings);
    this.vibration = settings.vibration !== false;
    this.chosen = settings.touchSteering;
    this.sensitivity = settings.steeringSensitivity;
    this.configureDriver();
  }

  get mode(): InputMode {
    return this.core.mode;
  }

  get tiltStatus(): TiltStatus {
    return this.motion === 'asking' ? 'needs-permission' : this.motion;
  }

  hudInput(): HudInput {
    const status = this.tiltStatus;
    return {
      mode: this.mode,
      steering: effectiveSteering(this.chosen, status),
      tiltPending: this.chosen === 'tilt' && status === 'needs-permission',
      tiltProblem: tiltProblem(this.chosen, status),
    };
  }

  /**
   * Call synchronously inside a click / pointerup / keyup handler: iOS grants the motion prompt to a user activation
   * only. Resolves once the status settles (active, denied, unavailable, insecure, or off when the scheme changed).
   * Every call until then gets the same promise, and iOS is asked once.
   */
  requestTilt(): Promise<TiltStatus> {
    const win = this.target;
    if (!win || this.motion === 'active') return Promise.resolve(this.tiltStatus);
    if (this.pendingTilt) return this.pendingTilt.promise;
    // a problem is settled the moment it is known, and may already be the status (then setMotion settles nothing)
    const problem = motionProblem(win);
    if (problem) {
      this.setMotion(problem);
      return Promise.resolve(problem);
    }
    let resolve: (status: TiltStatus) => void = () => undefined;
    const promise = new Promise<TiltStatus>((r) => (resolve = r));
    this.pendingTilt = { promise, resolve };
    if (this.motion === 'waiting') return promise;
    const api = motionApi(win);
    const ask = api?.requestPermission;
    if (typeof ask !== 'function') this.setMotion('waiting');
    else {
      this.setMotion('asking');
      // an answer that arrives after the scheme changed (state no longer asking) is dropped
      const answered = (answer: string): void => {
        if (this.motion === 'asking') this.setMotion(answer === 'granted' ? 'waiting' : 'denied');
      };
      try {
        ask.call(api).then(answered, () => answered('denied'));
      } catch {
        answered('denied');
      }
    }
    return promise;
  }

  /** `initialMode`: 'touch' on a phone or tablet, else 'keyboard'; written to html at once. */
  attach(target: Window, opts?: { initialMode: InputMode }): void {
    if (this.target === target) return;
    this.detach();
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown, { capture: true });
    target.addEventListener('keyup', this.onKeyUp, { capture: true });
    target.addEventListener('pointerdown', this.onPointerDown, { capture: true, passive: true });
    target.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: true });
    target.addEventListener('blur', this.onBlur);
    target.document.addEventListener('visibilitychange', this.onVisibilityChange);
    if (opts) {
      this.core.noteDevice(opts.initialMode);
      this.shownMode = null;
    }
    this.syncModeAttr();
    this.syncTilt();
  }

  detach(): void {
    const target = this.target;
    if (!target) return;
    this.setMotion('off');
    target.removeEventListener('keydown', this.onKeyDown, { capture: true });
    target.removeEventListener('keyup', this.onKeyUp, { capture: true });
    target.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    target.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    target.removeEventListener('blur', this.onBlur);
    target.document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.target = null;
    this.core.reset();
    this.driver.setLive(false);
  }

  applySettings(settings: Settings): void {
    this.core.applySettings(settings);
    this.vibration = settings.vibration !== false;
    this.chosen = settings.touchSteering;
    this.sensitivity = settings.steeringSensitivity;
    this.syncTilt();
    this.configureDriver();
  }

  /** Enable/disable player-2 routing. */
  setSplitScreen(enabled: boolean): void {
    this.core.setSplitScreen(enabled);
  }

  /** Poll gamepads and the touch device, smooth digital steering/throttle. Call once per rendered frame with the frame dt. */
  update(dt: number): void {
    this.core.update(dt, this.readGamepads(), this.driver.read(dt));
    this.syncModeAttr();
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

  /** D-pad left/right presses per player (tyre compound in an open MFD) since the last call. */
  consumePadSteps(): { playerIndex: 0 | 1; step: -1 | 1 }[] {
    return this.core.consumePadSteps();
  }

  /** Held state of an action (e.g. lookBack). */
  isHeld(action: KeyAction, playerIndex: 0 | 1): boolean {
    return this.core.isHeld(action, playerIndex);
  }

  /**
   * Clear all held/latched state (on pause, blur, session change). `keepKeyboard`: keys physically held stay held.
   * Fingers stay either way: their ups are never lost (pointer capture delivers them), so a thumb on the throttle
   * through a flashback stays on the throttle. Hiding the deck is what lets every finger go.
   */
  reset(keepKeyboard = false): void {
    this.core.reset(keepKeyboard);
    this.driver.dropPresses();
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

  private configureDriver(): void {
    this.driver.configure({ steering: effectiveSteering(this.chosen, this.tiltStatus), sensitivity: this.sensitivity });
  }

  /** The motion listener policy: off unless tilt is chosen; Android starts at once, iOS waits for a tap to ask. */
  private syncTilt(): void {
    if (this.chosen !== 'tilt') {
      this.setMotion('off');
      return;
    }
    const win = this.target;
    if (!win || this.motion !== 'off') return;
    const problem = motionProblem(win);
    if (problem) this.setMotion(problem);
    else this.setMotion(typeof motionApi(win)?.requestPermission === 'function' ? 'needs-permission' : 'waiting');
  }

  /** The one transition of the tilt status: listener, first-sample timer, driver scheme and requestTilt promises. */
  private setMotion(next: MotionState): void {
    const prev = this.motion;
    if (next === prev) return;
    this.motion = next;
    const win = this.target;
    if (win && listens(next) !== listens(prev)) {
      if (listens(next)) win.addEventListener('devicemotion', this.onMotion);
      else win.removeEventListener('devicemotion', this.onMotion);
    }
    if (this.sampleTimer !== null) {
      win?.clearTimeout(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (next === 'waiting' && win) {
      this.sampleTimer = win.setTimeout(() => {
        this.sampleTimer = null;
        this.setMotion('unavailable');
      }, TILT_FIRST_SAMPLE_MS);
    }
    this.configureDriver();
    const pending = this.pendingTilt;
    if (unsettled(next) || !pending) return;
    this.pendingTilt = null;
    pending.resolve(this.tiltStatus);
  }

  private noteMode(mode: InputMode): void {
    this.core.noteDevice(mode);
    this.syncModeAttr();
  }

  /** The only writer of html[data-input-mode]; writes once per change. */
  private syncModeAttr(): void {
    const mode = this.core.mode;
    if (mode === this.shownMode || !this.target) return;
    this.shownMode = mode;
    this.target.document.documentElement.setAttribute('data-input-mode', mode);
  }

  private readonly onMotion = (e: DeviceMotionEvent): void => {
    const a = e.accelerationIncludingGravity;
    const win = this.target;
    if (!win || !a || a.x === null || a.y === null || a.z === null) return;
    if (this.motion === 'waiting') this.setMotion('active');
    this.driver.motion({ x: a.x, y: a.y, z: a.z }, screenAngle(win), gravitySign(win));
  };

  /** Pointer events only: iOS's compatibility mouse events after a tap never carry pointerType 'mouse'. */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') this.noteMode('touch');
    else if (e.pointerType === 'mouse') this.noteMode('keyboard');
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && (e.movementX || e.movementY)) this.noteMode('keyboard');
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing || !e.code || isTextEntryTarget(e.target)) return;
    // noted while capture is suspended too (typing in the settings overlay is still the keyboard); soft keyboards only
    // type into text fields, so they never flip touch to keyboard
    this.noteMode('keyboard');
    if (this.captureSuspended) return;
    // Cmd/Win shortcuts: macOS drops the matching keyup, so never track them.
    if (e.metaKey && !MODIFIER_CODE.test(e.code)) return;
    const bound = this.core.keyDown(e.code, e.repeat);
    if (bound && e.cancelable && this.isDriving()) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!e.code) return;
    // macOS sends no keyup for other keys while Cmd is down: a driving key released under Cmd would stay stuck
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.core.releaseKeyboard();
    const bound = this.core.keyUp(e.code);
    if (bound && e.cancelable && this.isDriving() && !isTextEntryTarget(e.target)) e.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.core.reset();
    this.driver.setLive(false);
  };

  private readonly onVisibilityChange = (): void => {
    if (!this.target?.document.hidden) return;
    this.core.reset();
    this.driver.setLive(false);
  };
}

