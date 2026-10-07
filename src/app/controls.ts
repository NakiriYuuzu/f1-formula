/**
 * Control-input plumbing for the fixed-step loop (pure). One-shot flags (shift, DRS, ERS cycle, limiter) must
 * reach the simulation exactly once: only the first sub-step of a frame gets them, later sub-steps get a copy
 * without them, and presses read on a frame that ran no sub-step are carried to the next one.
 */
import type { ControlInput } from '../core/types';

export const ONE_SHOT_KEYS = ['shiftUp', 'shiftDown', 'drsPressed', 'ersCycle', 'limiterToggle'] as const;

export type OneShotKey = (typeof ONE_SHOT_KEYS)[number];

/** Copy of `c` with every one-shot flag cleared (held inputs unchanged). */
export function withoutOneShots(c: ControlInput): ControlInput {
  return { ...c, shiftUp: false, shiftDown: false, drsPressed: false, ersCycle: false, limiterToggle: false };
}

/** Copy of `c` whose one-shot flags are OR-ed with the flags still pending from earlier frames. */
export function withPendingOneShots(c: ControlInput, pending: ControlInput | null): ControlInput {
  if (!pending) return { ...c };
  const out = { ...c };
  for (const k of ONE_SHOT_KEYS) out[k] = c[k] || pending[k];
  return out;
}

export function hasOneShot(c: ControlInput | null): boolean {
  return c !== null && ONE_SHOT_KEYS.some((k) => c[k]);
}

/**
 * Per-player input sets for `steps` sub-steps: index 0 carries the one-shots, the rest share one stripped copy.
 * `controls[playerIndex]` may be null (no human in that slot).
 */
export function substepInputs(controls: readonly (ControlInput | null)[]): { first: (ControlInput | null)[]; rest: (ControlInput | null)[] } {
  const first = controls.map((c) => (c ? { ...c } : null));
  const rest = controls.map((c) => (c ? withoutOneShots(c) : null));
  return { first, rest };
}
