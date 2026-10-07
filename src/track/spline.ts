/**
 * Closed centripetal Catmull-Rom spline through track control points, resampled to uniform arc length.
 * The spline (alpha = 0.5) is reversal-symmetric, so a reversed point order traces the identical curve.
 */

export interface SplinePoint {
  x: number;
  z: number;
  y: number;
  width: number;
}

export interface SplineSamples {
  count: number;
  /** actual uniform spacing (m) = length / count */
  spacing: number;
  length: number;
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  width: Float64Array;
}

/** Dense evaluation step along each spline segment (m). */
const DENSE_STEP = 0.4;
const MIN_KNOT = 1e-3;

/**
 * Sample the closed spline through `pts` (driving order, pts[0] = s 0) every ~`spacing` metres.
 * Throws if the loop is degenerate.
 */
export function sampleClosedSpline(pts: readonly SplinePoint[], spacing: number): SplineSamples {
  const n = pts.length;
  if (n < 4) throw new Error(`track spline needs at least 4 control points (got ${n})`);

  const dense: number[] = [];
  const cum: number[] = [];
  let total = 0;
  let lastX = pts[0].x;
  let lastZ = pts[0].z;

  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const chord = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(4, Math.ceil(chord / DENSE_STEP));
    for (let k = 0; k < steps; k++) {
      const u = k / steps;
      const t = t1 + (t2 - t1) * u;
      const x = barryGoldman(p0.x, p1.x, p2.x, p3.x, t0, t1, t2, t3, t);
      const z = barryGoldman(p0.z, p1.z, p2.z, p3.z, t0, t1, t2, t3, t);
      const y = barryGoldman(p0.y, p1.y, p2.y, p3.y, t0, t1, t2, t3, t);
      const su = u * u * (3 - 2 * u);
      const w = p1.width + (p2.width - p1.width) * su;
      if (dense.length > 0) total += Math.hypot(x - lastX, z - lastZ);
      dense.push(x, z, y, w);
      cum.push(total);
      lastX = x;
      lastZ = z;
    }
  }
  // closing segment back to the first dense point
  total += Math.hypot(dense[0] - lastX, dense[1] - lastZ);
  if (!Number.isFinite(total) || total < 100) throw new Error(`track spline length invalid (${total})`);

  const count = Math.max(16, Math.round(total / spacing));
  const step = total / count;
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const pz = new Float64Array(count);
  const width = new Float64Array(count);
  const m = cum.length;
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (j + 1 < m && cum[j + 1] <= target) j++;
    const a = j;
    const b = (j + 1) % m;
    const segStart = cum[a];
    const segEnd = b === 0 ? total : cum[b];
    const span = segEnd - segStart;
    const f = span > 1e-12 ? (target - segStart) / span : 0;
    px[k] = dense[a * 4] + (dense[b * 4] - dense[a * 4]) * f;
    pz[k] = dense[a * 4 + 1] + (dense[b * 4 + 1] - dense[a * 4 + 1]) * f;
    py[k] = dense[a * 4 + 2] + (dense[b * 4 + 2] - dense[a * 4 + 2]) * f;
    width[k] = dense[a * 4 + 3] + (dense[b * 4 + 3] - dense[a * 4 + 3]) * f;
  }
  return { count, spacing: step, length: total, px, py, pz, width };
}

function knot(a: SplinePoint, b: SplinePoint): number {
  return Math.max(MIN_KNOT, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)));
}

/** Barry–Goldman pyramidal evaluation of one Catmull-Rom component at parameter t ∈ [t1, t2]. */
function barryGoldman(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t0: number,
  t1: number,
  t2: number,
  t3: number,
  t: number,
): number {
  const a1 = ((t1 - t) * p0 + (t - t0) * p1) / (t1 - t0);
  const a2 = ((t2 - t) * p1 + (t - t1) * p2) / (t2 - t1);
  const a3 = ((t3 - t) * p2 + (t - t2) * p3) / (t3 - t2);
  const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0);
  const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
  return ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1);
}
