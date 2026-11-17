/**
 * The touch device, DOM-free: fingers on the HUD deck plus tilt → one TouchReading per frame, which InputCore.update
 * merges like a pad poll. Two writers on disjoint state: the deck writes fingers through TouchPort, InputManager writes
 * motion samples. One reader: InputManager.update → read(dt).
 */
import { clamp } from '../core/math';
import type { KeyAction, TouchSteering } from '../core/types';
import { MAX_QUEUED_ACTIONS } from './core';
import { stickToSteer } from './gamepad';
import { deviceUp, filterUp, halfTurn, readsHalfTurned, tiltToSteer, toScreen, type GravitySign, type TiltSteer, type Vec3 } from './tilt';

/** The scheme actually in use: the chosen one, unless tilt is not usable yet (then drag). */
export type EffectiveSteering = TouchSteering;

/**
 * off: the scheme is not tilt (no listener, no battery cost). needs-permission: iOS, no grant yet in this page (a tap
 * must ask). waiting: listener attached, no sample yet. active: samples arriving. The last three fall back to drag and
 * say why.
 */
export type TiltStatus = 'off' | 'needs-permission' | 'waiting' | 'active' | 'denied' | 'unavailable' | 'insecure';
export type TiltProblem = Extract<TiltStatus, 'denied' | 'unavailable' | 'insecure'>;

export function effectiveSteering(chosen: TouchSteering, status: TiltStatus): EffectiveSteering {
  return chosen === 'tilt' && status !== 'active' ? 'drag' : chosen;
}

export function tiltProblem(chosen: TouchSteering, status: TiltStatus): TiltProblem | null {
  return chosen === 'tilt' && (status === 'denied' || status === 'unavailable' || status === 'insecure') ? status : null;
}

/** A pedal's horizontal span (CSS px), measured once by the deck at finger-down. */
export interface PedalSpan {
  control: string;
  action: 'brake' | 'throttle';
  left: number;
  right: number;
}

/**
 * What a finger landed on. Self-describing so the driver never imports the UI table (src/input stays below src/ui).
 * steer: the drag surface; `travel` = px of drag for full stick before the curve (see steerTravel).
 * pedal: a pedal with the pedals beside it in the same thumb zone; the finger may roll from one to the next.
 * button: everything else; `hold` false = a tap (press only), true = held until the finger lifts.
 */
export type TouchContact =
  | { kind: 'steer'; x: number; travel: number }
  | { kind: 'pedal'; x: number; spans: readonly PedalSpan[] }
  | { kind: 'button'; control: string; action: KeyAction; hold: boolean };

/** One poll of the touch device (InputCore.update reads it like a pad). */
export interface TouchReading {
  /** analog steer -1..1 (drag surface or tilt); 0 with the buttons scheme (◀ ▶ arrive as held steerLeft/steerRight) */
  steer: number;
  /**
   * actions held by fingers: pedals and hold buttons; they go through the keyboard ramps in InputCore. A finger that
   * went down and up since the last read counts once, so a tap shorter than a frame still reaches a held-state edge.
   */
  held: ReadonlySet<KeyAction>;
  /** one entry per finger-down on an action control since the last read (a tap shorter than a frame is not lost) */
  presses: readonly KeyAction[];
}

export const NO_TOUCH: TouchReading = { steer: 0, held: new Set(), presses: [] };

/** For the deck's indicators only (never fed back into input). */
export interface TouchView {
  steering: EffectiveSteering;
  steer: number;
  /** the drag finger: where the stick's centre is and where the finger is (px), null when no finger steers */
  drag: { origin: number; x: number; travel: number } | null;
  flat: boolean;
}

/** The deck's handle on the touch device (InputManager.touch). */
export interface TouchPort {
  /** Claims the finger (true: the deck takes pointer capture). Refused while not live, or a second steering finger. */
  down(pointerId: number, contact: TouchContact): boolean;
  /** Steer and pedal fingers follow x; button fingers ignore moves (a held button stays held while the thumb drifts). */
  move(pointerId: number, x: number): void;
  /** pointerup, pointercancel and lostpointercapture all land here; unknown ids are ignored (idempotent). */
  up(pointerId: number): void;
  /**
   * A control went off screen: every finger on it lets go (no press, no stuck hold). A thumb on the pedal beside it
   * stays on its own pedal and can no longer roll onto the one that went.
   */
  releaseControl(control: string): void;
  /** The deck is on screen (true) or hidden (false: every finger lets go and tilt stops counting). */
  setLive(live: boolean): void;
  view(): TouchView;
  /** Call only from a click / pointerup handler: iOS grants the motion prompt to a user activation only. */
  enableTilt(): void;
}

/** Half-width of the drag for full stick: a fifth of the steer surface, kept in a thumb's comfortable reach. */
export function steerTravel(surfaceWidthPx: number): number {
  return clamp(surfaceWidthPx * 0.2, 44, 96);
}

/**
 * The drag stick with a leash: the centre is where the finger landed, and it is dragged along once the finger goes
 * past full travel, so moving back always unwinds from full lock at once (no dead travel after an overshoot).
 * Returns the new origin.
 */
export function leashOrigin(origin: number, x: number, travel: number): number {
  return clamp(origin, x - travel, x + travel);
}

/**
 * The pedal under x: the span containing it, else the one with the nearest edge (the finger stays on a pedal while it
 * drifts). `spans` is never empty: it holds at least the pedal the finger landed on.
 */
export function pedalAt(spans: readonly PedalSpan[], x: number): PedalSpan {
  let best = spans[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const gap = x < span.left ? span.left - x : x > span.right ? x - span.right : 0;
    if (gap < bestGap) {
      best = span;
      bestGap = gap;
    }
  }
  return best;
}

/** The drag stick's offset → steer goes through the pad's stick curve with this deadzone. */
export const TOUCH_STEER_DEADZONE = 0.06;

/** The TOUCH_CONTROLS id of the drag surface: releaseControl(STEER_CONTROL) lets the steering finger go. */
export const STEER_CONTROL = 'steer';

type Owner =
  | { kind: 'steer'; origin: number; x: number; travel: number }
  | { kind: 'pedal'; spans: readonly PedalSpan[]; current: PedalSpan }
  | { kind: 'button'; control: string; action: KeyAction; hold: boolean };

const STILL: TiltSteer = { steer: 0, flat: false };

export class TouchDriver implements TouchPort {
  private live = false;
  private steering: EffectiveSteering = 'drag';
  private sensitivity = 1;
  /** the only finger state: which finger owns which control */
  private readonly owners = new Map<number, Owner>();
  private presses: KeyAction[] = [];
  /** pedals and hold buttons a finger took since the last read, whether or not it is still down */
  private taken = new Set<KeyAction>();
  /** latest motion sample: up vector in device axes and the screen angle it was taken at */
  private motionUp: { up: Vec3; angle: number } | null = null;
  /** tilt low-pass state (device axes); null until the first read with a sample */
  private filtered: Vec3 | null = null;
  /**
   * Whether the axes read half a turn off (readsHalfTurned), decided by the first sample that can tell after tilt goes
   * live or the screen angle changes, then kept: a roll past 90° mid-corner must not flip the steering.
   */
  private halfTurned: boolean | null = null;
  /** the last read's steer, and whether tilt read the device as flat (for view) */
  private last: TiltSteer = STILL;

  constructor(private readonly requestTilt: () => void) {}

  configure(c: { steering: EffectiveSteering; sensitivity: number }): void {
    this.sensitivity = c.sensitivity;
    if (c.steering === this.steering) return;
    this.steering = c.steering;
    // a scheme change mid-race lets the steering finger go: drag → tilt → drag must not revive an old drag
    for (const [id, o] of this.owners) if (o.kind === 'steer') this.owners.delete(id);
    this.clearTilt();
  }

  setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    if (live) return;
    this.owners.clear();
    this.presses = [];
    this.taken.clear();
    this.clearTilt();
  }

  down(pointerId: number, contact: TouchContact): boolean {
    if (!this.live || this.owners.has(pointerId)) return false;
    switch (contact.kind) {
      case 'steer':
        if (this.steering !== 'drag' || this.steerOwner()) return false;
        this.owners.set(pointerId, { kind: 'steer', origin: contact.x, x: contact.x, travel: contact.travel });
        return true;
      case 'pedal': {
        if (contact.spans.length === 0) return false;
        const current = pedalAt(contact.spans, contact.x);
        this.owners.set(pointerId, { kind: 'pedal', spans: contact.spans, current });
        this.pushPress(current.action);
        this.taken.add(current.action);
        return true;
      }
      case 'button':
        // a tap stays owned until its finger lifts, so a resting thumb never presses it again
        this.owners.set(pointerId, contact);
        this.pushPress(contact.action);
        if (contact.hold) this.taken.add(contact.action);
        return true;
    }
  }

  move(pointerId: number, x: number): void {
    const o = this.owners.get(pointerId);
    if (o?.kind === 'steer') {
      o.x = x;
      o.origin = leashOrigin(o.origin, x, o.travel);
    } else if (o?.kind === 'pedal') {
      const next = pedalAt(o.spans, x);
      if (next.control === o.current.control) return;
      o.current = next;
      this.pushPress(next.action);
      this.taken.add(next.action);
    }
  }

  up(pointerId: number): void {
    this.owners.delete(pointerId);
  }

  releaseControl(control: string): void {
    for (const [id, o] of this.owners) {
      const on = o.kind === 'steer' ? control === STEER_CONTROL : o.kind === 'pedal' ? o.current.control === control : o.control === control;
      if (on) this.owners.delete(id);
      else if (o.kind === 'pedal') o.spans = o.spans.filter((s) => s.control !== control);
    }
  }

  /** Called by InputManager's devicemotion listener (only while the scheme is tilt). */
  motion(sample: Vec3, screenAngleDeg: number, sign: GravitySign): void {
    if (!this.live || this.steering !== 'tilt') return;
    const up = deviceUp(sample, sign);
    if (this.motionUp?.angle !== screenAngleDeg) this.halfTurned = null;
    this.halfTurned ??= readsHalfTurned(toScreen(up, screenAngleDeg));
    this.motionUp = { up, angle: screenAngleDeg };
  }

  /** Once per InputManager.update. Drains presses; steps the tilt filter by the frame dt. */
  read(dt: number): TouchReading {
    if (!this.live) return NO_TOUCH;
    const presses = this.presses;
    this.presses = [];
    const held = this.taken;
    this.taken = new Set();
    for (const o of this.owners.values()) {
      if (o.kind === 'pedal') held.add(o.current.action);
      else if (o.kind === 'button' && o.hold) held.add(o.action);
    }
    this.last = this.steer(dt);
    return { steer: this.last.steer, held, presses };
  }

  view(): TouchView {
    const s = this.steerOwner();
    return {
      steering: this.steering,
      steer: this.last.steer,
      drag: s ? { origin: s.origin, x: s.x, travel: s.travel } : null,
      flat: this.last.flat,
    };
  }

  /** InputManager.reset: queued presses go the way of InputCore's queue, and so do lifted fingers; fingers down stay. */
  dropPresses(): void {
    this.presses = [];
    this.taken.clear();
  }

  enableTilt(): void {
    this.requestTilt();
  }

  private steer(dt: number): TiltSteer {
    if (this.steering === 'drag') {
      const s = this.steerOwner();
      return s ? { steer: stickToSteer((s.x - s.origin) / s.travel, TOUCH_STEER_DEADZONE, this.sensitivity), flat: false } : STILL;
    }
    if (this.steering === 'tilt' && this.motionUp) {
      this.filtered = filterUp(this.filtered, this.motionUp.up, dt);
      const screenUp = toScreen(this.filtered, this.motionUp.angle);
      return tiltToSteer(this.halfTurned ? halfTurn(screenUp) : screenUp, this.sensitivity);
    }
    return STILL;
  }

  private steerOwner(): Extract<Owner, { kind: 'steer' }> | null {
    for (const o of this.owners.values()) if (o.kind === 'steer') return o;
    return null;
  }

  private pushPress(action: KeyAction): void {
    if (this.presses.length < MAX_QUEUED_ACTIONS) this.presses.push(action);
  }

  private clearTilt(): void {
    this.motionUp = null;
    this.filtered = null;
    this.halfTurned = null;
    this.last = STILL;
  }
}
