/**
 * Tilt steering, pure: the gravity vector from `devicemotion` plus the screen angle → a steer value. The device is
 * a wheel turned in the screen plane, so the roll does not depend on how far the player leans the screen back.
 */
import { clamp, clamp01 } from '../core/math';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * WebKit reports `accelerationIncludingGravity` negated against the spec and Blink. The engine that has
 * `DeviceMotionEvent.requestPermission` is the engine that negates, so the adapter derives the sign from that one
 * feature test. A wrong guess here turns the reading half a turn, which readsHalfTurned catches.
 */
export type GravitySign = 1 | -1;

/** In-plane roll (degrees) that gives full lock at steeringSensitivity 1; the lock is TILT_LOCK_DEG / sensitivity. */
export const TILT_LOCK_DEG = 30;
export const TILT_LOCK_MIN_DEG = 18;
export const TILT_LOCK_MAX_DEG = 50;
/** Roll under this reads as straight ahead (hand tremor and a slightly crooked hold). */
export const TILT_DEADZONE_DEG = 2.5;
/** Finer control near centre, like the pad curve at sensitivity 1. */
export const TILT_EXPONENT = 1.2;
/** Low-pass time constant of the gravity vector (s): kills hand shake and road bumps for about 50 ms of lag. */
export const TILT_TAU = 0.05;
/**
 * Share of gravity lying in the screen plane (the cosine of how far the screen leans back from vertical). Above FULL
 * the roll counts fully; below OFF the device is flat and steer is 0; between, it fades linearly. 0.42 is about a 65°
 * lean and 0.21 about 78°, so the player may hold the device well tilted back without losing the wheel.
 */
export const TILT_FLAT_FULL = 0.42;
export const TILT_FLAT_OFF = 0.21;
/** A reading under this many m/s² is not gravity (free fall, a broken sensor): treated as flat. */
export const TILT_MIN_G = 3;

/** Raw `accelerationIncludingGravity` (device axes, m/s²) → the "up" vector (reaction to gravity) in device axes. */
export function deviceUp(sample: Vec3, sign: GravitySign): Vec3 {
  return { x: sign * sample.x, y: sign * sample.y, z: sign * sample.z };
}

/** cos θ, sin θ for θ = 0, 90, 180, 270 degrees. */
const QUARTER_TURNS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * Device axes → screen axes (+x screen right, +y screen up, +z out of the glass). `screenAngleDeg` is
 * `screen.orientation.angle`: the device turned that many degrees counter-clockwise from its natural orientation,
 * snapped to a quarter turn. θ = 90 (top of a phone to the left): screen right = device −y, screen up = device +x.
 * This is the one place the screen-angle convention lives. A platform that reads 90 and 270 the other way round (iOS
 * 16.4 did) turns the result half a turn, which readsHalfTurned catches; a quarter-turn error is not caught.
 */
export function toScreen(up: Vec3, screenAngleDeg: number): Vec3 {
  const turns = Number.isFinite(screenAngleDeg) ? Math.round(screenAngleDeg / 90) : 0;
  const [c, s] = QUARTER_TURNS[((turns % 4) + 4) % 4];
  return { x: up.x * c - up.y * s, y: up.x * s + up.y * c, z: up.z };
}

/** One frame of the exponential low-pass on the device-axis up vector; `prev` null primes with `next`. */
export function filterUp(prev: Vec3 | null, next: Vec3, dt: number): Vec3 {
  if (!prev) return next;
  const k = dt > 0 ? 1 - Math.exp(-dt / TILT_TAU) : 0;
  return { x: prev.x + (next.x - prev.x) * k, y: prev.y + (next.y - prev.y) * k, z: prev.z + (next.z - prev.z) * k };
}

export interface TiltSteer {
  /** -1..1, + = right */
  steer: number;
  /** the screen lies too flat for a reliable roll (steer faded or zero): the deck says 「請將裝置立起」 */
  flat: boolean;
}

/** The screen's roll in its own plane (degrees, + = the wheel turned clockwise as the player sees it = right). */
export function tiltRoll(screenUp: Vec3): number {
  return (Math.atan2(-screenUp.x, screenUp.y) * 180) / Math.PI;
}

/**
 * A wrong gravity sign or a 90 / 270 screen angle read the other way round turns the in-plane gravity half a turn,
 * so a level wheel reads as full lock. The player starts with the screen roughly upright, so a sample that reads more
 * than 90° of roll is taken as that error. null while the sample cannot tell: exactly when tiltToSteer would not steer
 * on it (flat, or not gravity).
 */
export function readsHalfTurned(screenUp: Vec3): boolean | null {
  const g = Math.hypot(screenUp.x, screenUp.y, screenUp.z);
  if (!(g >= TILT_MIN_G) || Math.hypot(screenUp.x, screenUp.y) / g <= TILT_FLAT_OFF) return null;
  return Math.abs(tiltRoll(screenUp)) > 90;
}

/** The screen-axis up vector turned half a turn in the screen plane. */
export function halfTurn(screenUp: Vec3): Vec3 {
  return { x: -screenUp.x, y: -screenUp.y, z: screenUp.z };
}

/** Roll (degrees) for full lock: TILT_LOCK_DEG / sensitivity within TILT_LOCK_MIN_DEG..TILT_LOCK_MAX_DEG. */
export function tiltLockDeg(sensitivity: number): number {
  const s = Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : 1;
  return clamp(TILT_LOCK_DEG / s, TILT_LOCK_MIN_DEG, TILT_LOCK_MAX_DEG);
}

/**
 * Screen-axis up vector → steer. Neutral is the screen level with the horizon (no calibration step).
 * `sensitivity` = Settings.steeringSensitivity and only scales the full-lock angle.
 *
 *   g     = |up|;                                   g < TILT_MIN_G        → { steer: 0, flat: true }
 *   share = hypot(up.x, up.y) / g;                  weight = clamp01((share − OFF) / (FULL − OFF))
 *   weight = 0                                       → { steer: 0, flat: true }
 *   roll  = tiltRoll(up)
 *   |roll| ≤ DEADZONE                                → steer 0
 *   t     = clamp01((|roll| − DEADZONE) / (lock − DEADZONE))
 *   steer = sign(roll) · t^TILT_EXPONENT · weight,   flat = share < FULL
 * A device held upside down (up.y < 0) reads |roll| > 90 and clamps to full lock on that side.
 */
export function tiltToSteer(screenUp: Vec3, sensitivity: number): TiltSteer {
  const g = Math.hypot(screenUp.x, screenUp.y, screenUp.z);
  if (!(g >= TILT_MIN_G)) return { steer: 0, flat: true };
  const share = Math.hypot(screenUp.x, screenUp.y) / g;
  const weight = clamp01((share - TILT_FLAT_OFF) / (TILT_FLAT_FULL - TILT_FLAT_OFF));
  if (weight === 0) return { steer: 0, flat: true };
  const roll = tiltRoll(screenUp);
  const t = clamp01((Math.abs(roll) - TILT_DEADZONE_DEG) / (tiltLockDeg(sensitivity) - TILT_DEADZONE_DEG));
  return { steer: t > 0 ? Math.sign(roll) * Math.pow(t, TILT_EXPONENT) * weight : 0, flat: share < TILT_FLAT_FULL };
}
