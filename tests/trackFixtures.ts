/**
 * Synthetic real-style TrackDefs for the track tests (no real circuit data needed): a figure-8 with a grade-separated
 * crossover, a Monaco-style street circuit (R = 10 m hairpin, curved pit straight, 14 % grades, two sections 3.5 m
 * apart edge to edge) and a 7 km, 2.4 × 1.6 km layout (2.2 km DRS straight, 17 % climb, ~100 m elevation range).
 * Lap fractions come from the generator's own distances, and `real.length` is the built lap length.
 */
import type { TrackControlPoint, TrackDef } from '../src/core/types';
import { buildTrack } from '../src/track/track';

const DEG = Math.PI / 180;

type Seg = { line: number } | { r: number; deg: number };
interface Marked {
  points: TrackControlPoint[];
  /** distance (m) along the path at each segment start, plus the total as the last entry */
  marks: number[];
}

/** Elevation node: [segment index, metres into that segment, y]; smoothstep between nodes. */
type Node = [number, number, number];

/** Turtle path (yaw: forward = (sin, cos); deg > 0 turns right) with an elevation profile. */
function turtle(segs: Seg[], profile: Node[], width: number, yaw0 = 90 * DEG): Marked & { end: { x: number; z: number; yaw: number } } {
  const raw: { x: number; z: number; d: number }[] = [];
  const marks: number[] = [];
  let x = 0;
  let z = 0;
  let yaw = yaw0;
  let d = 0;
  for (const seg of segs) {
    marks.push(d);
    if ('line' in seg) {
      const steps = Math.max(1, Math.ceil(seg.line / 30));
      for (let k = 0; k < steps; k++) raw.push({ x: x + (Math.sin(yaw) * seg.line * k) / steps, z: z + (Math.cos(yaw) * seg.line * k) / steps, d: d + (seg.line * k) / steps });
      x += Math.sin(yaw) * seg.line;
      z += Math.cos(yaw) * seg.line;
      d += seg.line;
    } else {
      const sign = Math.sign(seg.deg);
      const total = Math.abs(seg.deg) * DEG;
      const len = seg.r * total;
      const steps = Math.max(2, Math.ceil(Math.max(total / (15 * DEG), len / 25)));
      const cx = x + sign * -Math.cos(yaw) * seg.r;
      const cz = z + sign * Math.sin(yaw) * seg.r;
      for (let k = 0; k < steps; k++) {
        const y2 = yaw - sign * (total * k) / steps;
        raw.push({ x: cx - sign * -Math.cos(y2) * seg.r, z: cz - sign * Math.sin(y2) * seg.r, d: d + (len * k) / steps });
      }
      yaw -= sign * total;
      x = cx - sign * -Math.cos(yaw) * seg.r;
      z = cz - sign * Math.sin(yaw) * seg.r;
      d += len;
    }
  }
  marks.push(d);
  const nodes = profile.map(([k, off, y]) => ({ d: marks[k] + Math.min(off, marks[k + 1] - marks[k]), y }));
  const elevation = (dist: number): number => {
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      if (dist >= a.d && dist <= b.d) {
        const u = b.d > a.d ? (dist - a.d) / (b.d - a.d) : 1;
        return a.y + (b.y - a.y) * u * u * (3 - 2 * u);
      }
    }
    return nodes[dist < nodes[0].d ? 0 : nodes.length - 1].y;
  };
  const points = raw.map((p) => ({ x: p.x, z: p.z, y: elevation(p.d), width }));
  return { points, marks, end: { x, z, yaw } };
}

/** Adjust the lengths of the straights `a` and `b` so the turtle path closes on its start (headings must close). */
function closed(segs: Seg[], a: number, b: number, profile: Node[], width: number): Marked {
  const first = turtle(segs, profile, width);
  const heads: number[] = [];
  let h = 90 * DEG;
  for (const s of segs) {
    heads.push(h);
    if (!('line' in s)) h -= s.deg * DEG;
  }
  const turned = (((h - 90 * DEG) / DEG) % 360);
  if (Math.abs(turned) > 1e-6) throw new Error(`fixture does not close in heading (${turned.toFixed(2)} deg off)`);
  const ua = { x: Math.sin(heads[a]), z: Math.cos(heads[a]) };
  const ub = { x: Math.sin(heads[b]), z: Math.cos(heads[b]) };
  const det = ua.x * ub.z - ua.z * ub.x;
  const rx = -first.end.x;
  const rz = -first.end.z;
  const da = (rx * ub.z - rz * ub.x) / det;
  const db = (ua.x * rz - ua.z * rx) / det;
  const fixed = segs.map((s, i) => (i === a && 'line' in s ? { line: s.line + da } : i === b && 'line' in s ? { line: s.line + db } : s));
  return turtle(fixed, profile, width);
}

function finish(def: Omit<TrackDef, 'real'> & { real?: TrackDef['real'] }, source = 'synthetic test fixture'): TrackDef {
  const length = buildTrack(def as TrackDef).length;
  return { ...def, real: { length: Math.round(length), turns: 12, direction: 'clockwise', firstGrandPrix: 1950, source, ...def.real } };
}

const BASE = {
  location: 'test',
  country: 'test',
  timeOfDay: 'day' as const,
  fullLaps: 10,
  description: 'synthetic fixture',
};

/**
 * Figure-8 (Gerono lemniscate 2 km × 1 km with a wobble for corners): the crossing at the origin is grade-separated
 * by 8 m (upper road y = +4, lower y = −4). The pit straight is the right tip (R ≈ 1000 m, no wobble).
 */
export function figureEightDef(): TrackDef {
  const A = 1000;
  const B = 1000;
  const N = 150;
  const t0 = Math.PI / 2;
  const points: TrackControlPoint[] = [];
  for (let k = 0; k < N; k++) {
    const t = t0 + (k / N) * Math.PI * 2;
    const vx = A * Math.cos(t);
    const vz = B * Math.cos(2 * t);
    const vl = Math.hypot(vx, vz);
    const wobble = 75 * (0.5 - 0.5 * Math.cos(t - t0)) * Math.sin(11 * t);
    points.push({
      x: A * Math.sin(t) - (vz / vl) * wobble,
      z: (B / 2) * Math.sin(2 * t) + (vx / vl) * wobble,
      y: 4 * Math.cos(t) + 10 * Math.sin(2 * t),
    });
  }
  return finish({
    ...BASE,
    id: 'fixture-figure8',
    name: '測試八字',
    biome: 'temperate',
    street: false,
    width: 12,
    points,
    sectors: [0.33, 0.66],
    drsZones: [{ detection: 0.9, activation: 0.94, end: 0.04 }],
    pit: { side: 'right', entry: 0.93, exit: 0.07, box: 0 },
  });
}

/**
 * Monaco-style street circuit (~3.4 km): the pit straight curves (R = 400 m), an R = 10 m hairpin, 14 % grades,
 * 11 m road width, street walls.
 */
export function streetDef(): TrackDef {
  // right 12 + 90 + 180 + 135 + 66 + 30 + 12 = 525, left 75 + 90 = 165: net 360° of right turn
  const segs: Seg[] = [
    { r: 400, deg: 12 }, // second half of the curved pit straight (the line is its middle)
    { line: 340 },
    { r: 22, deg: 90 },
    { line: 260 },
    { r: 38, deg: -75 },
    { line: 140 },
    { r: 10, deg: 180 },
    { line: 220 },
    { r: 28, deg: -90 },
    { line: 150 },
    { r: 30, deg: 135 },
    { line: 330 },
    { r: 45, deg: 66 },
    { line: 180 },
    { r: 400, deg: 30 },
    { line: 330 },
    { r: 400, deg: 12 },
  ];
  // climbs of ~14 % (peak of the smoothstep ≈ 1.5 × the mean grade, so mean ≈ 9 %)
  const profile: Node[] = [
    [0, 0, 0],
    [2, 0, 2],
    [3, 0, 2],
    [3, 150, 16],
    [5, 0, 18],
    [6, 0, 18],
    [7, 220, 4],
    [10, 0, 4],
    [11, 0, 4],
    [11, 330, 16],
    [13, 0, 3],
    [16, 0, 2],
  ];
  const { points, marks } = closed(segs, 3, 11, profile, 11);
  const zone = 340 / marks[marks.length - 1];
  return finish({
    ...BASE,
    id: 'fixture-street',
    name: '測試街道',
    biome: 'city',
    street: true,
    width: 11,
    points,
    sectors: [0.31, 0.66],
    drsZones: [{ detection: 0.9, activation: 0.94, end: 0.05 }],
    pit: { side: 'right', entry: 1 - zone, exit: zone, box: 0 },
  });
}

/**
 * Stadium with a pinch: two 1.8 km straights 400 m apart that dip towards each other (Gaussian, σ = 120 m) until their
 * road edges are 3.5 m apart. Width 11 m, street walls. Pit straight on the bottom leg, away from the pinch.
 */
export function pinchDef(gap = 3.5): TrackDef {
  const half = 200;
  const centre = (11 + gap) / 2;
  const dip = (x: number): number => centre + (half - centre) * (1 - Math.exp(-(((x + 500) / 120) ** 2)));
  const points: TrackControlPoint[] = [];
  const rise = (x: number): number => 12 * Math.exp(-(((x + 500) / 250) ** 2));
  // bottom leg east (z < 0) from the pit straight, right-hand end arc, top leg west (dips), left-hand end arc back
  for (let x = 0; x <= 900; x += 60) points.push({ x, z: -dip(x), y: rise(x) });
  for (let a = 15; a < 180; a += 15) points.push({ x: 900 + half * Math.sin(a * DEG), z: -half * Math.cos(a * DEG), y: rise(900) });
  for (let x = 900; x >= -900; x -= x > -750 && x < -250 ? 25 : 60) points.push({ x, z: dip(x), y: rise(x) });
  for (let a = 15; a < 180; a += 15) points.push({ x: -900 - half * Math.sin(a * DEG), z: half * Math.cos(a * DEG), y: rise(-900) });
  for (let x = -900; x < 0; x += x > -750 && x < -250 ? 25 : 60) points.push({ x, z: -dip(x), y: rise(x) });
  // start (s = 0) in the middle of the bottom leg east of the pinch (x = 420)
  const i0 = points.findIndex((p) => p.x === 420 && p.z < 0);
  const shifted = points.slice(i0).concat(points.slice(0, i0));
  return finish({
    ...BASE,
    id: 'fixture-pinch',
    name: '測試窄縫',
    biome: 'city',
    street: true,
    width: 11,
    points: shifted.map((p) => ({ ...p, width: 11 })),
    sectors: [0.34, 0.68],
    drsZones: [{ detection: 0.9, activation: 0.94, end: 0.08 }],
    pit: { side: 'right', entry: 0.93, exit: 0.07, box: 0 },
  });
}

/**
 * Long layout (~7.3 km, about 2.5 × 1.0 km): 2.2 km main straight with a DRS zone wrapping through the line, a spike
 * with a 17 % climb (Eau-Rouge style) and a 13 m hairpin, ~104 m elevation range. Width 15 m, temperate run-off.
 */
export function longDef(): TrackDef {
  const segs: Seg[] = [
    { line: 1100 },
    { r: 150, deg: 90 },
    { line: 300 },
    { r: 250, deg: -40 },
    { r: 250, deg: 40 },
    { line: 200 },
    { r: 150, deg: 90 },
    { line: 500 },
    { r: 40, deg: 90 },
    { line: 250 },
    { r: 13, deg: -180 },
    { line: 250 },
    { r: 40, deg: 90 },
    { line: 700 },
    { r: 300, deg: -30 },
    { r: 300, deg: 30 },
    { line: 400 },
    { r: 150, deg: 90 },
    { line: 200 },
    { r: 150, deg: 90 },
    { line: 1100 },
  ];
  const profile: Node[] = [
    [0, 0, 5],
    [2, 0, 5],
    [5, 200, 45],
    [7, 0, 48],
    [7, 500, 100],
    [9, 40, 100],
    [9, 120, 109],
    [9, 250, 109],
    [11, 250, 95],
    [13, 0, 90],
    [13, 700, 40],
    [16, 400, 12],
    [19, 0, 8],
    [20, 1100, 5],
  ];
  const { points, marks } = closed(segs, 13, 18, profile, 15);
  const total = marks[marks.length - 1];
  const main = 1100 / total;
  return finish({
    ...BASE,
    id: 'fixture-long',
    name: '測試長賽道',
    biome: 'temperate',
    street: false,
    width: 15,
    points,
    sectors: [0.3, 0.62],
    // 2.2 km zone from the end of the last corner to the first one, wrapping through the line
    drsZones: [{ detection: 1 - main - 0.012, activation: 1 - main + 0.005, end: main - 0.01 }],
    pit: { side: 'left', entry: 1 - 400 / total, exit: 400 / total, box: 0 },
  });
}
