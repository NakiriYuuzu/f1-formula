/**
 * Digital (keyboard) axis smoothing (pure). Keys are on/off; these ramps turn them into progressive inputs.
 * Steering: ramps toward ±1 at ~4/s (speed-dependent when the vehicle speed is known: ~6/s at low speed down to
 * ~2.5/s near 300 km/h), returns to centre faster (~6/s at any speed), and snaps through zero on reversal.
 * Pedals: ramp toward 0/1 at ~8/s.
 */
import { clamp, clamp01, invLerp, lerp, moveToward } from '../core/math';

/** Steering ramp-out rate (1/s) when the vehicle speed is unknown. */
export const STEER_RAMP_RATE = 4;
export const STEER_RETURN_RATE = 6;
export const PEDAL_RAMP_RATE = 8;
/** Speed-dependent ramp-out: STEER_RAMP_RATE_LOW up to STEER_RAMP_SPEED_LOW, linear down to STEER_RAMP_RATE_HIGH at STEER_RAMP_SPEED_HIGH. */
export const STEER_RAMP_RATE_LOW = 6;
export const STEER_RAMP_RATE_HIGH = 2.5;
/** m/s (40 km/h) */
export const STEER_RAMP_SPEED_LOW = 40 / 3.6;
/** m/s (300 km/h) */
export const STEER_RAMP_SPEED_HIGH = 300 / 3.6;

function safeSensitivity(sensitivity: number): number {
  return Number.isFinite(sensitivity) && sensitivity > 0 ? clamp(sensitivity, 0.25, 3) : 1;
}

function safeDt(dt: number): number {
  return Number.isFinite(dt) && dt > 0 ? dt : 0;
}

/** Target steer from held keys: -1 left, +1 right, 0 none / both. */
export function digitalSteerTarget(left: boolean, right: boolean): number {
  return (right ? 1 : 0) - (left ? 1 : 0);
}

/** Ramp-out rate (1/s) for a vehicle speed (m/s); STEER_RAMP_RATE when the speed is unknown (null / not finite). */
export function steerRampRate(speedMs: number | null): number {
  if (speedMs === null || !Number.isFinite(speedMs)) return STEER_RAMP_RATE;
  const t = clamp01(invLerp(STEER_RAMP_SPEED_LOW, STEER_RAMP_SPEED_HIGH, Math.abs(speedMs)));
  return lerp(STEER_RAMP_RATE_LOW, STEER_RAMP_RATE_HIGH, t);
}

/**
 * Advance a smoothed digital steering value toward `target` (-1, 0 or +1).
 * `sensitivity` (Settings.steeringSensitivity) scales both rates; `rampRate` (see steerRampRate) replaces the
 * ramp-out rate only — returning toward centre always uses STEER_RETURN_RATE.
 */
export function stepDigitalSteer(current: number, target: number, dt: number, sensitivity = 1, rampRate = STEER_RAMP_RATE): number {
  const cur = Number.isFinite(current) ? clamp(current, -1, 1) : 0;
  const tgt = Number.isFinite(target) ? clamp(target, -1, 1) : 0;
  const step = safeDt(dt);
  const s = safeSensitivity(sensitivity);
  if (tgt === 0) return moveToward(cur, 0, STEER_RETURN_RATE * s * step);
  // Reversal help: crossing over starts from centre instead of unwinding the old lock first.
  const start = cur !== 0 && Math.sign(cur) !== Math.sign(tgt) ? 0 : cur;
  // Moving back toward centre while still on the same side (e.g. target 0.5 from 1) uses the return rate.
  const ramp = Number.isFinite(rampRate) && rampRate > 0 ? rampRate : STEER_RAMP_RATE;
  const rate = Math.abs(tgt) < Math.abs(start) ? STEER_RETURN_RATE : ramp;
  return clamp(moveToward(start, tgt, rate * s * step), -1, 1);
}

/** Advance a smoothed pedal (0..1) toward pressed (1) / released (0). */
export function stepPedal(current: number, pressed: boolean, dt: number): number {
  const cur = Number.isFinite(current) ? clamp01(current) : 0;
  return clamp01(moveToward(cur, pressed ? 1 : 0, PEDAL_RAMP_RATE * safeDt(dt)));
}
