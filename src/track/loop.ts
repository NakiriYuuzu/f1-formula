/**
 * Distance-along-the-loop helpers for a BuiltTrack (wrap, forward/signed deltas, ranges, sampling).
 * Re-exported by track.ts — import them from there.
 */
import type { BuiltTrack } from '../core/types';

type LoopTrack = Pick<BuiltTrack, 'length' | 'count' | 'spacing'>;

/** Wrap s into [0, length). Non-finite input yields 0. */
export function wrapS(track: LoopTrack, s: number): number {
  const L = track.length;
  if (!Number.isFinite(s) || !(L > 0)) return 0;
  let r = s % L;
  if (r < 0) r += L;
  return r >= L ? 0 : r;
}

/** Distance travelling forward from `from` to `to`, in [0, length). */
export function forwardDistance(track: LoopTrack, from: number, to: number): number {
  return wrapS(track, to - from);
}

/** Shortest signed distance b - a along the loop, in (-length/2, length/2]. */
export function signedDeltaS(track: LoopTrack, a: number, b: number): number {
  const d = wrapS(track, b - a);
  return d > track.length / 2 ? d - track.length : d;
}

/** Sample index nearest to distance s. */
export function indexAtS(track: LoopTrack, s: number): number {
  if (track.count <= 0) return 0;
  const i = Math.round(wrapS(track, s) / track.spacing);
  return i >= track.count ? i - track.count : i;
}

/** True if s lies in the forward interval [start, end) (wrap-aware). An empty interval (start == end) is false. */
export function inRangeS(track: LoopTrack, s: number, start: number, end: number): boolean {
  return forwardDistance(track, start, s) < forwardDistance(track, start, end);
}

/**
 * Interpolated value of a per-sample array at distance s (wrap-aware linear interpolation).
 * Arrays whose length differs from track.count are treated as evenly spread over the lap.
 */
export function sampleAt(track: LoopTrack, arr: ArrayLike<number>, s: number): number {
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  const u = (wrapS(track, s) / track.length) * n;
  const i = Math.min(n - 1, Math.floor(u));
  const f = u - i;
  const j = i + 1 === n ? 0 : i + 1;
  return arr[i] + (arr[j] - arr[i]) * f;
}

/** Segment index i and fraction f in [0, 1) such that s lies between samples i and i+1. */
export function segmentAt(track: LoopTrack, s: number): { i: number; f: number } {
  const u = wrapS(track, s) / track.spacing;
  const i = Math.min(track.count - 1, Math.max(0, Math.floor(u)));
  return { i, f: Math.min(1, Math.max(0, u - i)) };
}
