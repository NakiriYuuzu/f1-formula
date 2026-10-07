/**
 * Closed-loop (periodic) signal helpers for per-sample track arrays: smoothing, dilation, slope limiting.
 * Every function treats index n-1 as the neighbour of index 0.
 */

/** Wrap an integer index into [0, n). */
export function wrapIndex(i: number, n: number): number {
  const r = i % n;
  return r < 0 ? r + n : r;
}

/** Circular moving average with a box of ±`radius` samples, applied `passes` times. */
export function smoothClosed(src: ArrayLike<number>, radius: number, passes = 1): Float64Array {
  const n = src.length;
  let cur = Float64Array.from(src);
  const r = Math.max(0, Math.floor(radius));
  if (n === 0 || r === 0 || passes <= 0) return cur;
  const span = Math.min(2 * r + 1, n);
  const half = Math.floor((span - 1) / 2);
  for (let p = 0; p < passes; p++) {
    const next = new Float64Array(n);
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += cur[wrapIndex(k, n)];
    for (let i = 0; i < n; i++) {
      next[i] = sum / (2 * half + 1);
      sum += cur[wrapIndex(i + half + 1, n)] - cur[wrapIndex(i - half, n)];
    }
    cur = next;
  }
  return cur;
}

/** Circular running maximum over ±`radius` samples. */
export function maxFilterClosed(src: ArrayLike<number>, radius: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  const r = Math.min(Math.max(0, Math.floor(radius)), Math.floor(n / 2));
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = -r; k <= r; k++) {
      const v = src[wrapIndex(i + k, n)];
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}

/**
 * Enforce |a[i+1] - a[i]| <= maxStep around the loop by only LOWERING values (in place).
 * The result is the largest such function that never exceeds the input.
 */
export function slopeLimitClosed(arr: Float64Array, maxStep: number): void {
  const n = arr.length;
  if (n < 2) return;
  for (let k = 1; k <= 2 * n; k++) {
    const i = k % n;
    const prev = arr[(k - 1) % n] + maxStep;
    if (arr[i] > prev) arr[i] = prev;
  }
  for (let k = 2 * n - 1; k >= 0; k--) {
    const i = k % n;
    const next = arr[(k + 1) % n] + maxStep;
    if (arr[i] > next) arr[i] = next;
  }
}
