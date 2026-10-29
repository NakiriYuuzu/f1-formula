/**
 * Frame timing (pure): the fixed-step accumulator that turns real frame time into SIM_DT simulation steps
 * (bounded per frame so a slow frame never spirals), and a windowed FPS meter for the HUD. Offline a slow frame
 * drops what it cannot run; an online session keeps it and catches up over the next frames instead (ONLINE_*): the
 * host's world is everyone's clock and a guest's steps are its inputs, so dropped time would make the host skip a
 * guest's inputs (its car jumps back on the guest's screen) or guess them.
 */
import { clamp } from '../core/math';

/** Longest real frame delta (s) fed into the simulation; longer gaps (tab switch, debugger) are clamped. */
export const MAX_FRAME_DT = 0.1;
/** Most simulation steps run in one rendered frame. */
export const MAX_SUBSTEPS = 8;
/** Online: longest real frame delta taken in (s), steps per frame, and the most time carried over to later frames. */
export const ONLINE_MAX_FRAME_DT = 0.5;
export const ONLINE_MAX_SUBSTEPS = 24;
export const ONLINE_MAX_BACKLOG = 0.5;

export interface ClockOptions {
  /** longest frame delta (s) taken in (default MAX_FRAME_DT) */
  maxFrameDt?: number;
  /** time (s) beyond maxSteps a frame keeps for the next frames instead of dropping it (default 0: dropped) */
  maxBacklog?: number;
}

/** Sanitize a real frame delta: finite, ≥ 0, ≤ MAX_FRAME_DT. */
export function clampFrameDt(dt: number): number {
  return Number.isFinite(dt) ? clamp(dt, 0, MAX_FRAME_DT) : 0;
}

export class FixedStepClock {
  private acc = 0;
  private readonly maxFrameDt: number;
  private readonly maxBacklog: number;

  constructor(
    readonly step: number,
    readonly maxSteps: number = MAX_SUBSTEPS,
    opts: ClockOptions = {},
  ) {
    if (!(step > 0) || !Number.isFinite(step)) throw new Error('FixedStepClock: step must be a positive number');
    this.maxFrameDt = opts.maxFrameDt ?? MAX_FRAME_DT;
    this.maxBacklog = Math.max(0, opts.maxBacklog ?? 0);
  }

  /** Add one frame of real time; returns how many fixed steps to simulate now (0..maxSteps). */
  advance(dt: number): number {
    this.acc += Number.isFinite(dt) ? clamp(dt, 0, this.maxFrameDt) : 0;
    // tiny epsilon so 1/120 s accumulated 120 times yields exactly 120 steps despite rounding
    let steps = Math.floor((this.acc + 1e-9) / this.step);
    if (steps > this.maxSteps) {
      steps = this.maxSteps;
      const rest = this.acc - steps * this.step;
      // the backlog: kept for the next frames up to maxBacklog, else dropped (the sub-step remainder kept)
      this.acc = this.maxBacklog > 0 ? Math.min(rest, this.maxBacklog) : rest % this.step;
    } else {
      this.acc -= steps * this.step;
    }
    if (this.acc < 0) this.acc = 0;
    return steps;
  }

  /**
   * Real time (s) this clock will still simulate if a frame of `dt` came now: the backlog plus that frame, as
   * advance() keeps them (online at most maxSteps + maxBacklog; offline at most maxSteps — the rest is dropped).
   */
  owed(dt: number): number {
    const acc = this.acc + (Number.isFinite(dt) ? clamp(dt, 0, this.maxFrameDt) : 0);
    return Math.min(acc, this.maxSteps * this.step + this.maxBacklog);
  }

  /** Real time waiting in the accumulator (s): < one step after advance(), unless a backlog is carried over. */
  get pending(): number {
    return this.acc;
  }

  reset(): void {
    this.acc = 0;
  }
}

/** Frames-per-second averaged over a short window of real time. */
export class FpsMeter {
  private frames = 0;
  private elapsed = 0;
  private value = 0;

  constructor(private readonly window = 0.5) {}

  /** Count one rendered frame that took `dt` seconds of real time (unclamped). */
  tick(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) return;
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed >= this.window) {
      this.value = this.frames / this.elapsed;
      this.frames = 0;
      this.elapsed = 0;
    }
  }

  get fps(): number {
    return this.value;
  }
}
