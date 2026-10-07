/**
 * Frame timing (pure): the fixed-step accumulator that turns real frame time into SIM_DT simulation steps
 * (bounded per frame so a slow frame never spirals), and a windowed FPS meter for the HUD.
 */
import { clamp } from '../core/math';

/** Longest real frame delta (s) fed into the simulation; longer gaps (tab switch, debugger) are clamped. */
export const MAX_FRAME_DT = 0.1;
/** Most simulation steps run in one rendered frame. */
export const MAX_SUBSTEPS = 8;

/** Sanitize a real frame delta: finite, ≥ 0, ≤ MAX_FRAME_DT. */
export function clampFrameDt(dt: number): number {
  return Number.isFinite(dt) ? clamp(dt, 0, MAX_FRAME_DT) : 0;
}

export class FixedStepClock {
  private acc = 0;

  constructor(
    readonly step: number,
    readonly maxSteps: number = MAX_SUBSTEPS,
  ) {
    if (!(step > 0) || !Number.isFinite(step)) throw new Error('FixedStepClock: step must be a positive number');
  }

  /** Add one frame of real time; returns how many fixed steps to simulate now (0..maxSteps). */
  advance(dt: number): number {
    this.acc += clampFrameDt(dt);
    // tiny epsilon so 1/120 s accumulated 120 times yields exactly 120 steps despite rounding
    let steps = Math.floor((this.acc + 1e-9) / this.step);
    if (steps > this.maxSteps) {
      steps = this.maxSteps;
      // drop the backlog we cannot catch up on, keep the sub-step remainder
      this.acc = (this.acc - steps * this.step) % this.step;
    } else {
      this.acc -= steps * this.step;
    }
    if (this.acc < 0) this.acc = 0;
    return steps;
  }

  /** Real time waiting in the accumulator (s), < one step after advance(). */
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
