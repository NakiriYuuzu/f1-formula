/**
 * DOM-free input brain: held keys, one-shot latches, non-driving action queue, keyboard smoothing and
 * gamepad merging for players 0 and 1. InputManager feeds it browser events; tests drive it directly.
 */
import type { ControlInput, KeyAction, Settings } from '../core/types';
import { buildBindingTable, resolveKey, type BindingTable, type InputAction } from './bindings';
import { PAD_MENU_BUTTONS, buttonPressed, padsForPlayer, readPad, readPadSteps, type GamepadLike, type PadMenuInput } from './gamepad';
import { digitalSteerTarget, stepDigitalSteer, stepPedal, steerRampRate } from './smoothing';

/** Driving one-shots: key action → ControlInput flag. */
type LatchFlag = 'shiftUp' | 'shiftDown' | 'drsPressed' | 'ersCycle' | 'limiterToggle';
const LATCH_FOR_ACTION: Partial<Record<KeyAction, LatchFlag>> = {
  shiftUp: 'shiftUp',
  shiftDown: 'shiftDown',
  drs: 'drsPressed',
  ersCycle: 'ersCycle',
  limiter: 'limiterToggle',
};

/** Non-driving actions reported by consumeActions() on press. */
export const QUEUED_ACTIONS: ReadonlySet<KeyAction> = new Set<KeyAction>([
  'pause',
  'camera',
  'flashback',
  'mfd',
  'pitRequest',
  'fullscreen',
  'hud',
  'lookBack',
]);

/** Upper bound for unconsumed actions (e.g. presses while a menu is shown and nobody drains the queue). */
export const MAX_QUEUED_ACTIONS = 32;
/** Longest frame step used for smoothing (s); larger gaps (tab switches) are clamped. */
const MAX_UPDATE_DT = 0.1;
/** Analog → "held" threshold for isHeld on throttle/brake/steer. */
const ANALOG_HELD = 0.5;

interface PadState {
  throttle: number;
  brake: number;
  steer: number;
  held: Set<KeyAction>;
}

interface PlayerState {
  steerKb: number;
  throttleKb: number;
  brakeKb: number;
  /** vehicle speed (m/s) reported by the App for the speed-dependent keyboard steering ramp; null = unknown */
  speed: number | null;
  pad: PadState;
  latches: Record<LatchFlag, boolean>;
}

function emptyLatches(): Record<LatchFlag, boolean> {
  return { shiftUp: false, shiftDown: false, drsPressed: false, ersCycle: false, limiterToggle: false };
}

function emptyPad(): PadState {
  return { throttle: 0, brake: 0, steer: 0, held: new Set() };
}

function createPlayer(): PlayerState {
  return { steerKb: 0, throttleKb: 0, brakeKb: 0, speed: null, pad: emptyPad(), latches: emptyLatches() };
}

export type InputCoreSettings = Pick<Settings, 'keyBindings' | 'keyBindingsP2' | 'deadzone' | 'steeringSensitivity'>;

export class InputCore {
  private table: BindingTable;
  private splitScreen = false;
  private deadzone = 0;
  private sensitivity = 1;
  /** currently held key codes → the routes they were pressed with (keyup releases exactly those) */
  private readonly activeKeys = new Map<string, readonly InputAction[]>();
  private readonly players: [PlayerState, PlayerState] = [createPlayer(), createPlayer()];
  private queue: InputAction[] = [];
  /** previous held actions per pad index, for rising-edge detection */
  private padPrev = new Map<number, Set<KeyAction>>();
  /** menu-navigation presses from any pad (D-pad / A / B) and the previous held set per pad */
  private menuQueue: PadMenuInput[] = [];
  private menuPrev = new Map<number, Set<PadMenuInput>>();
  /** D-pad left/right presses per player (tyre compound in the MFD) and the previous held set per pad */
  private stepQueue: { playerIndex: 0 | 1; step: -1 | 1 }[] = [];
  private stepPrev = new Map<number, Set<-1 | 1>>();

  constructor(settings: InputCoreSettings) {
    this.table = buildBindingTable(settings);
    this.applyTuning(settings);
  }

  /** Rebuild bindings and tuning. Keys held right now keep the routes they were pressed with until released. */
  applySettings(settings: InputCoreSettings): void {
    this.table = buildBindingTable(settings);
    this.applyTuning(settings);
  }

  setSplitScreen(enabled: boolean): void {
    if (this.splitScreen === enabled) return;
    this.splitScreen = enabled;
    // Routing changed: held keys/latches belong to the old routing.
    this.reset();
  }

  isSplitScreen(): boolean {
    return this.splitScreen;
  }

  /** True when the code is bound under the current routing. */
  isBound(code: string): boolean {
    return resolveKey(this.table, code, this.splitScreen).length > 0;
  }

  /**
   * Key pressed. Repeats never re-trigger presses, but a repeat for a key we do not track (e.g. held through a
   * reset) re-registers it as held. Returns true when the key is bound.
   */
  keyDown(code: string, repeat = false): boolean {
    const routes = resolveKey(this.table, code, this.splitScreen);
    if (routes.length === 0) return false;
    if (this.activeKeys.has(code)) return true;
    this.activeKeys.set(code, routes);
    if (!repeat) for (const r of routes) this.press(r.action, r.playerIndex);
    return true;
  }

  /** Key released. Returns true when the key was held or is bound. */
  keyUp(code: string): boolean {
    const wasHeld = this.activeKeys.delete(code);
    return wasHeld || this.isBound(code);
  }

  /** Forget every held key (keyups may be lost, e.g. while capture is suspended). */
  releaseKeyboard(): void {
    this.activeKeys.clear();
  }

  /** Poll pads + advance keyboard smoothing. `pads` = navigator.getGamepads() or fakes. */
  update(dt: number, pads: readonly (GamepadLike | null | undefined)[] = []): void {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_UPDATE_DT) : 0;
    this.pollPads(pads);
    this.pollMenuButtons(pads);
    for (const playerIndex of [0, 1] as const) {
      const p = this.players[playerIndex];
      const target = digitalSteerTarget(this.isKeyHeld('steerLeft', playerIndex), this.isKeyHeld('steerRight', playerIndex));
      p.steerKb = stepDigitalSteer(p.steerKb, target, step, this.sensitivity, steerRampRate(p.speed));
      p.throttleKb = stepPedal(p.throttleKb, this.isKeyHeld('throttle', playerIndex), step);
      p.brakeKb = stepPedal(p.brakeKb, this.isKeyHeld('brake', playerIndex), step);
    }
  }

  /**
   * Vehicle speed (m/s) of a player's car: keyboard steering then ramps out faster at low speed and slower at high
   * speed (see steerRampRate). null / non-finite = unknown (fixed STEER_RAMP_RATE). Kept across reset().
   */
  setVehicleSpeed(playerIndex: 0 | 1, speedMs: number | null): void {
    const p = this.players[playerIndex];
    if (p) p.speed = speedMs !== null && Number.isFinite(speedMs) ? Math.abs(speedMs) : null;
  }

  /** Controls for a player; one-shot flags are returned true once per press, then cleared. */
  getControl(playerIndex: 0 | 1): ControlInput {
    const p = this.players[playerIndex];
    const latches = p.latches;
    const pad = p.pad;
    const control: ControlInput = {
      throttle: Math.max(p.throttleKb, pad.throttle),
      brake: Math.max(p.brakeKb, pad.brake),
      steer: Math.abs(pad.steer) > Math.abs(p.steerKb) ? pad.steer : p.steerKb,
      shiftUp: latches.shiftUp,
      shiftDown: latches.shiftDown,
      drsPressed: latches.drsPressed,
      ersCycle: latches.ersCycle,
      limiterToggle: latches.limiterToggle,
      overtakeHeld: this.isKeyHeld('overtake', playerIndex) || pad.held.has('overtake'),
    };
    p.latches = emptyLatches();
    return control;
  }

  consumeActions(): InputAction[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** Pad menu-navigation presses since the last call (any connected pad). */
  consumeMenuInputs(): PadMenuInput[] {
    const out = this.menuQueue;
    this.menuQueue = [];
    return out;
  }

  /** D-pad left/right presses (-1 / +1) per player since the last call; the player's pad only. */
  consumePadSteps(): { playerIndex: 0 | 1; step: -1 | 1 }[] {
    const out = this.stepQueue;
    this.stepQueue = [];
    return out;
  }

  isHeld(action: KeyAction, playerIndex: 0 | 1): boolean {
    if (this.isKeyHeld(action, playerIndex)) return true;
    const pad = this.players[playerIndex].pad;
    if (pad.held.has(action)) return true;
    switch (action) {
      case 'throttle':
        return pad.throttle > ANALOG_HELD;
      case 'brake':
        return pad.brake > ANALOG_HELD;
      case 'steerLeft':
        return pad.steer < -ANALOG_HELD;
      case 'steerRight':
        return pad.steer > ANALOG_HELD;
      default:
        return false;
    }
  }

  /**
   * Drop latches, queues, smoothing and pad history. `keepKeyboard`: keep the held keys (a pause: keyups are still
   * tracked meanwhile, and the OS stops auto-repeating a held key once another key is pressed, so a key held
   * through the pause would otherwise stay dead after resume).
   */
  reset(keepKeyboard = false): void {
    if (!keepKeyboard) this.activeKeys.clear();
    this.queue = [];
    this.stepQueue = [];
    this.stepPrev.clear();
    // Dropping the pad history makes still-held buttons count as "already down" on the next poll (no fake presses).
    this.padPrev.clear();
    this.menuQueue = [];
    this.menuPrev.clear();
    for (const p of this.players) {
      p.steerKb = 0;
      p.throttleKb = 0;
      p.brakeKb = 0;
      p.pad = emptyPad();
      p.latches = emptyLatches();
    }
  }

  private applyTuning(settings: InputCoreSettings): void {
    this.deadzone = Number.isFinite(settings.deadzone) ? settings.deadzone : 0;
    this.sensitivity = Number.isFinite(settings.steeringSensitivity) ? settings.steeringSensitivity : 1;
  }

  private isKeyHeld(action: KeyAction, playerIndex: 0 | 1): boolean {
    for (const routes of this.activeKeys.values()) {
      for (const r of routes) if (r.action === action && r.playerIndex === playerIndex) return true;
    }
    return false;
  }

  private press(action: KeyAction, playerIndex: 0 | 1): void {
    const latch = LATCH_FOR_ACTION[action];
    if (latch) {
      this.players[playerIndex].latches[latch] = true;
      return;
    }
    if (!QUEUED_ACTIONS.has(action)) return;
    if (this.queue.length >= MAX_QUEUED_ACTIONS) this.queue.shift();
    this.queue.push({ action, playerIndex });
  }

  private pollMenuButtons(pads: readonly (GamepadLike | null | undefined)[]): void {
    const next = new Map<number, Set<PadMenuInput>>();
    pads.forEach((pad, i) => {
      if (!pad || pad.connected === false) return;
      const key = Number.isInteger(pad.index) ? pad.index : i;
      const prev = this.menuPrev.get(key);
      const held = new Set<PadMenuInput>();
      for (const [index, input] of PAD_MENU_BUTTONS) {
        if (!buttonPressed(pad, index)) continue;
        held.add(input);
        if (prev && !prev.has(input) && this.menuQueue.length < MAX_QUEUED_ACTIONS) this.menuQueue.push(input);
      }
      next.set(key, held);
    });
    this.menuPrev = next;
  }

  private pollPads(pads: readonly (GamepadLike | null | undefined)[]): void {
    const nextPrev = new Map<number, Set<KeyAction>>();
    const nextStepPrev = new Map<number, Set<-1 | 1>>();
    for (const playerIndex of [0, 1] as const) {
      const merged = emptyPad();
      // two pads pressing the same action in one poll count once
      const pressed = new Set<KeyAction>();
      const stepped = new Set<-1 | 1>();
      for (const pad of padsForPlayer(pads, playerIndex, this.splitScreen)) {
        const reading = readPad(pad, this.deadzone, this.sensitivity);
        merged.throttle = Math.max(merged.throttle, reading.throttle);
        merged.brake = Math.max(merged.brake, reading.brake);
        if (Math.abs(reading.steer) > Math.abs(merged.steer)) merged.steer = reading.steer;
        const key = Number.isInteger(pad.index) ? pad.index : pads.indexOf(pad);
        const prev = this.padPrev.get(key);
        const held = new Set(reading.held);
        for (const action of held) {
          merged.held.add(action);
          // First sighting of a pad: buttons already down are not presses.
          if (prev && !prev.has(action) && !pressed.has(action)) {
            pressed.add(action);
            this.press(action, playerIndex);
          }
        }
        nextPrev.set(key, held);
        const prevSteps = this.stepPrev.get(key);
        const heldSteps = new Set(readPadSteps(pad));
        for (const step of heldSteps) {
          if (prevSteps && !prevSteps.has(step) && !stepped.has(step) && this.stepQueue.length < MAX_QUEUED_ACTIONS) {
            stepped.add(step);
            this.stepQueue.push({ playerIndex, step });
          }
        }
        nextStepPrev.set(key, heldSteps);
      }
      this.players[playerIndex].pad = merged;
    }
    this.padPrev = nextPrev;
    this.stepPrev = nextStepPrev;
  }
}
