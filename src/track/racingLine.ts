/**
 * Minimum-curvature racing line: lateral offsets n[i] (+ right) within ±(halfWidth - margin) that minimise
 * Σ |q[i-1] - 2 q[i] + q[i+1]|² for q = p + n·right. Solved by projected Gauss-Seidel (exact coordinate
 * minimisation, box constraints) on a coarse-to-fine hierarchy so long wavelengths converge quickly.
 */

/** Car-body margin kept from each road edge (m). */
export const RACING_LINE_MARGIN = 1.3;

const LEVELS: readonly { stride: number; iterations: number }[] = [
  { stride: 8, iterations: 1600 },
  { stride: 4, iterations: 700 },
  { stride: 2, iterations: 300 },
  { stride: 1, iterations: 160 },
];
const RELAXATION = 1.6;
const TOLERANCE = 2e-5;

export function computeRacingLine(
  px: Float64Array,
  pz: Float64Array,
  rx: Float64Array,
  rz: Float64Array,
  halfWidth: Float64Array,
  margin = RACING_LINE_MARGIN,
): Float64Array {
  const count = px.length;
  let prevIdx: Int32Array | null = null;
  let prevOff: Float64Array | null = null;

  for (const level of LEVELS) {
    const m = Math.floor(count / level.stride);
    if (m < 8) continue;
    const idx = new Int32Array(m);
    for (let k = 0; k < m; k++) idx[k] = Math.floor((k * count) / m);
    const bx = new Float64Array(m);
    const bz = new Float64Array(m);
    const nx = new Float64Array(m);
    const nz = new Float64Array(m);
    const lim = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      const i = idx[k];
      bx[k] = px[i];
      bz[k] = pz[i];
      nx[k] = rx[i];
      nz[k] = rz[i];
      lim[k] = Math.max(0, halfWidth[i] - margin);
    }
    const off: Float64Array = prevIdx && prevOff ? resampleOffsets(prevIdx, prevOff, idx, count) : new Float64Array(m);
    for (let k = 0; k < m; k++) off[k] = clampAbs(off[k], lim[k]);
    relax(bx, bz, nx, nz, lim, off, level.iterations);
    prevIdx = idx;
    prevOff = off;
  }

  const out = new Float64Array(count);
  if (prevIdx && prevOff) {
    const full = resampleOffsets(prevIdx, prevOff, Int32Array.from({ length: count }, (_, i) => i), count);
    for (let i = 0; i < count; i++) out[i] = clampAbs(full[i], Math.max(0, halfWidth[i] - margin));
  }
  return out;
}

function clampAbs(v: number, lim: number): number {
  return v > lim ? lim : v < -lim ? -lim : v;
}

function relax(
  bx: Float64Array,
  bz: Float64Array,
  nx: Float64Array,
  nz: Float64Array,
  lim: Float64Array,
  off: Float64Array,
  iterations: number,
): void {
  const m = bx.length;
  const qx = new Float64Array(m);
  const qz = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    qx[k] = bx[k] + off[k] * nx[k];
    qz[k] = bz[k] + off[k] * nz[k];
  }
  for (let it = 0; it < iterations; it++) {
    let maxChange = 0;
    for (let k = 0; k < m; k++) {
      const a = k >= 2 ? k - 2 : k - 2 + m;
      const b = k >= 1 ? k - 1 : k - 1 + m;
      const c = k + 1 < m ? k + 1 : k + 1 - m;
      const d = k + 2 < m ? k + 2 : k + 2 - m;
      // minimiser of the three second differences touching q[k], restricted to the normal direction
      const tx = (4 * (qx[b] + qx[c]) - qx[a] - qx[d]) / 6;
      const tz = (4 * (qz[b] + qz[c]) - qz[a] - qz[d]) / 6;
      const target = (tx - bx[k]) * nx[k] + (tz - bz[k]) * nz[k];
      const next = clampAbs(off[k] + RELAXATION * (target - off[k]), lim[k]);
      const change = Math.abs(next - off[k]);
      if (change > maxChange) maxChange = change;
      off[k] = next;
      qx[k] = bx[k] + next * nx[k];
      qz[k] = bz[k] + next * nz[k];
    }
    if (maxChange < TOLERANCE) break;
  }
}

/** Linear (wrap-aware) interpolation of offsets known at sample indices `from` onto indices `to`. */
function resampleOffsets(from: Int32Array, values: Float64Array, to: Int32Array, count: number): Float64Array {
  const out = new Float64Array(to.length);
  const m = from.length;
  let j = 0;
  for (let k = 0; k < to.length; k++) {
    const i = to[k];
    while (j + 1 < m && from[j + 1] <= i) j++;
    const a = from[j];
    const nextJ = (j + 1) % m;
    const b = nextJ === 0 ? from[0] + count : from[nextJ];
    const span = b - a;
    const f = span > 0 ? (i - a) / span : 0;
    out[k] = values[j] + (values[nextJ] - values[j]) * f;
  }
  return out;
}
