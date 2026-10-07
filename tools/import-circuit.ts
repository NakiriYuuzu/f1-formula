/**
 * Real-circuit importer: OpenStreetMap centre line + DEM elevation -> TrackControlPoint[].
 *
 * Usage (from the repo root, bun only, built-in fetch, no dependencies):
 *   bun tools/import-circuit.ts <id>|all     build tools/out/<id>.points.ts and print a summary
 *   bun tools/import-circuit.ts find <id>    list OSM circuit relations / raceway ways in the config bbox
 *
 * Config: tools/circuits.json (per circuit: OSM relation / way include+exclude or a street `route`, start line,
 * official direction + length, DEM datasets, forced straights, elevation overrides). Raw API responses are cached
 * in /tmp/nova-real/cache, so re-runs are offline. Distances in config ("s") are metres from the start line along
 * the driving direction; negative values wrap (e.g. -400 = 400 m before the line).
 *
 * Pipeline: Overpass ways -> chain into one closed loop -> local equirectangular metres (x = east, z = -north,
 * so a clockwise lap on the north-up map has positive signed area) -> orient by official direction -> start at the
 * line -> 1 m resample -> denoise in the heading domain (preserves corner radii) -> DEM along the loop, smooth,
 * overrides, bridge separation, start = 0 m -> adaptive control points refined against the real spline.
 * Data © OpenStreetMap contributors (ODbL); elevation via OpenTopoData.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import type { TrackControlPoint, TrackDef } from '../src/core/types';
import { sampleClosedSpline } from '../src/track/spline';
import { buildTrack } from '../src/track/track';

// ───────────────────────────── config ─────────────────────────────

interface ElevationOverride {
  s0: number;
  s1: number;
  /** absolute DEM-frame heights at the range ends; default = DEM value there */
  y0?: number;
  y1?: number;
  /** extra height (m) added in the middle of the range (sin^2 shape) */
  bump?: number;
}

interface CircuitConfig {
  name: string;
  official: number;
  direction: 'clockwise' | 'anticlockwise';
  /** [south, west, north, east] */
  bbox: [number, number, number, number];
  relation?: number;
  ways?: { include?: number[]; exclude?: number[] };
  /** street circuits: waypoints [lat, lon] routed over the OSM highway graph, closed back to the first */
  route?: [number, number][];
  /** way ids ignored by `route` */
  avoid?: number[];
  start: [number, number];
  /** shift the start line along the lap direction after snapping `start` to the loop (m) */
  startOffset?: number;
  dem: string[];
  /** decide orientation from the sign of the first corner within `within` m after the line instead of the signed area (figure-8) */
  firstTurn?: { within: number; turn: 'left' | 'right' };
  straights?: [number, number][];
  elevation?: ElevationOverride[];
  /** minimum height difference at self-crossings (m), default 7.5; which pass is upper: auto | earlier | later */
  bridgeMinSep?: number;
  bridgeUpper?: 'auto' | 'earlier' | 'later';
  /** bridge gaps in the OSM way chain shorter than this (m), default 40 */
  bridgeGap?: number;
  /** heading-domain smoothing sigma (m), default 5 */
  sigma?: number;
  /** scale of the DEM relief about its mean (flat street circuits where the DEM sees buildings), default 1 */
  elevScale?: number;
  /** elevation smoothing sigma (m), default 40 */
  elevSigma?: number;
}

type LL = { lat: number; lon: number };
type V = { x: number; z: number };

const CACHE = '/tmp/nova-real/cache';
const UA = 'formula-nova-circuit-import/1.0 (hobby game; offline cached; contact via repo)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 20);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const wrapAngle = (a: number): number => a - TWO_PI * Math.round(a / TWO_PI);

// ───────────────────────────── network (cached, rate limited) ─────────────────────────────

async function readCache(key: string): Promise<string | null> {
  try {
    return await readFile(`${CACHE}/${key}.json`, 'utf8');
  } catch {
    return null;
  }
}

/** Wait until `gapMs` has passed since the shared stamp file was last touched (also serialises sibling scouts). */
async function throttle(stamp: string, gapMs: number): Promise<void> {
  const path = `${CACHE}/${stamp}`;
  let last = 0;
  try {
    last = (await stat(path)).mtimeMs;
  } catch {
    await writeFile(path, '');
  }
  const wait = last + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  const now = Date.now() / 1000;
  await utimes(path, now, now);
}

interface OsmElement {
  type: string;
  id: number;
  nodes?: number[];
  geometry?: LL[];
  tags?: Record<string, string>;
  members?: { type: string; ref: number; role: string }[];
}

async function overpass(query: string): Promise<OsmElement[]> {
  const key = `op-${hash(query)}`;
  const cached = await readCache(key);
  if (cached) return JSON.parse(cached).elements as OsmElement[];
  for (let attempt = 0; attempt < 8; attempt++) {
    await throttle('.overpass-stamp', 5500);
    const url = OVERPASS[attempt >= 2 ? attempt % OVERPASS.length : 0];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }).toString(),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) {
        await writeFile(`${CACHE}/${key}.json`, text);
        return JSON.parse(text).elements as OsmElement[];
      }
      console.error(`  overpass ${url} -> ${res.status}, retrying`);
    } catch (e) {
      console.error(`  overpass error ${String(e)}, retrying`);
    }
    await sleep(15000 * 2 ** Math.min(attempt, 3));
  }
  throw new Error('Overpass unavailable after retries');
}

/** Elevation (m) per location; datasets are tried in order for locations a dataset has no data for. */
async function elevations(pts: LL[], datasets: string[]): Promise<number[]> {
  const out: (number | null)[] = pts.map(() => null);
  for (const ds of datasets) {
    const todo = out.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
    for (let b = 0; b < todo.length; b += 100) {
      const idx = todo.slice(b, b + 100);
      const locs = idx.map((i) => `${pts[i].lat.toFixed(6)},${pts[i].lon.toFixed(6)}`).join('|');
      const url = `https://api.opentopodata.org/v1/${ds}?locations=${locs}`;
      const key = `dem-${ds}-${hash(locs)}`;
      let text = await readCache(key);
      for (let attempt = 0; text === null && attempt < 6; attempt++) {
        await throttle('.opentopo-stamp', 1200);
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        const body = await res.text();
        if (res.ok) {
          text = body;
          await writeFile(`${CACHE}/${key}.json`, body);
        } else {
          console.error(`  opentopodata ${ds} -> ${res.status}, backing off`);
          await sleep(10000 * (attempt + 1));
        }
      }
      if (text === null) throw new Error(`OpenTopoData ${ds} unavailable`);
      const results = JSON.parse(text).results as { elevation: number | null }[];
      idx.forEach((i, k) => (out[i] = results[k]?.elevation ?? null));
    }
  }
  const known = out.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (known.length === 0) throw new Error('no DEM coverage');
  return out.map((v, i) => {
    if (v !== null) return v;
    const near = known.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a));
    return out[near] as number; // isolated holes: nearest known sample
  });
}

// ───────────────────────────── OSM -> closed loop ─────────────────────────────

interface Edge {
  id: number;
  a: number;
  b: number;
  pts: LL[];
  len: number;
}

const flatDist = (p: LL, q: LL): number =>
  Math.hypot((p.lon - q.lon) * Math.cos(p.lat * DEG), p.lat - q.lat) * DEG * R_EARTH;
const polyLen = (pts: LL[]): number => pts.reduce((s, p, i) => (i ? s + flatDist(pts[i - 1], p) : 0), 0);

function isPitWay(tags: Record<string, string> = {}): boolean {
  return tags.service === 'pit_lane' || /pit ?lane|pit exit|pit entry|stands/i.test(`${tags.name ?? ''} ${tags['name:en'] ?? ''}`);
}

/** Closed trail through the way graph whose length is closest to `target` (official lap length). Returns ordered polyline. */
function chainWays(ways: OsmElement[], target: number, gap: number, log: string[]): { pts: LL[]; used: number[]; left: number[] } {
  const verts: { node?: number; p: LL }[] = [];
  const vertexOf = (node: number | undefined, p: LL): number => {
    let i = verts.findIndex((v) => (node !== undefined && v.node === node) || flatDist(v.p, p) < 3);
    if (i < 0) i = verts.push({ node, p }) - 1;
    return i;
  };
  const edges: Edge[] = ways
    .filter((w) => w.geometry && w.geometry.length >= 2)
    .map((w) => {
      const g = w.geometry as LL[];
      const n = w.nodes;
      return {
        id: w.id,
        a: vertexOf(n?.[0], g[0]),
        b: vertexOf(n?.[n.length - 1], g[g.length - 1]),
        pts: g,
        len: polyLen(g),
      };
    });
  // relations are sometimes incomplete: bridge gaps shorter than `gap` m with straight virtual edges (id < 0)
  const real = edges.length;
  for (let u = 0; u < verts.length; u++) {
    for (let v = u + 1; v < verts.length; v++) {
      const d = flatDist(verts[u].p, verts[v].p);
      const linked = edges.some((e) => (e.a === u && e.b === v) || (e.a === v && e.b === u));
      if (d < gap && !linked) edges.push({ id: -edges.length, a: u, b: v, pts: [verts[u].p, verts[v].p], len: d });
    }
  }
  const adj: Edge[][] = verts.map(() => []);
  for (const e of edges) {
    adj[e.a].push(e);
    if (e.b !== e.a) adj[e.b].push(e);
  }
  let best: { len: number; cost: number; seq: { e: Edge; fwd: boolean }[] } = { len: -1, cost: Infinity, seq: [] };
  let budget = 6e6;
  for (const e0 of edges.slice(0, real)) {
    const used = new Set<Edge>([e0]);
    const seq = [{ e: e0, fwd: true }];
    const dfs = (v: number, len: number, virt: number): void => {
      const cost = Math.abs(len - target) + 60 * virt;
      if (budget-- < 0 || len > target * 1.3 || best.cost < target * 0.005) return;
      if (v === e0.a) {
        if (cost < best.cost) best = { len, cost, seq: seq.slice() };
        return;
      }
      for (const e of adj[v]) {
        if (used.has(e)) continue;
        const fwd = e.a === v;
        used.add(e);
        seq.push({ e, fwd });
        dfs(fwd ? e.b : e.a, len + e.len, virt + (e.id < 0 ? 1 : 0));
        seq.pop();
        used.delete(e);
      }
    };
    dfs(e0.b, e0.len, 0);
  }
  if (best.len < 0) throw new Error('ways do not form a closed loop (check include/exclude)');
  const pts: LL[] = [];
  for (const { e, fwd } of best.seq) {
    const g = fwd ? e.pts : e.pts.slice().reverse();
    pts.push(...(pts.length ? g.slice(1) : g));
  }
  const usedIds = best.seq.map((s) => s.e.id);
  const left = edges.slice(0, real).map((e) => e.id).filter((id) => !usedIds.includes(id));
  log.push(`chain: ${usedIds.filter((i) => i > 0).length}/${real} ways, ${usedIds.filter((i) => i < 0).length} bridged gaps, ${best.len.toFixed(0)} m`);
  return { pts, used: usedIds, left };
}

/** Shortest road path (Dijkstra over the OSM highway graph) through waypoints, closed back to the first. */
function routeLoop(ways: OsmElement[], waypoints: [number, number][], avoid: number[]): LL[] {
  const pos = new Map<number, LL>();
  const adj = new Map<number, { to: number; w: number }[]>();
  for (const w of ways) {
    if (!w.nodes || !w.geometry || avoid.includes(w.id)) continue;
    for (let i = 0; i < w.nodes.length; i++) pos.set(w.nodes[i], w.geometry[i]);
    for (let i = 1; i < w.nodes.length; i++) {
      const d = flatDist(w.geometry[i - 1], w.geometry[i]);
      for (const [a, b] of [[w.nodes[i - 1], w.nodes[i]], [w.nodes[i], w.nodes[i - 1]]]) {
        const l = adj.get(a) ?? [];
        l.push({ to: b, w: d });
        adj.set(a, l);
      }
    }
  }
  const snap = (wp: [number, number]): number => {
    let best = -1;
    let bd = Infinity;
    for (const [id, p] of pos) {
      if (!adj.has(id)) continue;
      const d = flatDist(p, { lat: wp[0], lon: wp[1] });
      if (d < bd) [bd, best] = [d, id];
    }
    if (bd > 60) throw new Error(`waypoint ${wp} is ${bd.toFixed(0)} m from any road`);
    return best;
  };
  const ids = waypoints.map(snap);
  const out: LL[] = [];
  for (let k = 0; k < ids.length; k++) {
    const src = ids[k];
    const dst = ids[(k + 1) % ids.length];
    const dist = new Map<number, number>([[src, 0]]);
    const prev = new Map<number, number>();
    const heap: [number, number][] = [[0, src]]; // simple binary heap on [dist, node]
    const push = (it: [number, number]): void => {
      heap.push(it);
      for (let i = heap.length - 1; i > 0; ) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop() as [number, number];
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, u] = pop();
      if (u === dst) break;
      if (d > (dist.get(u) ?? Infinity)) continue;
      for (const { to, w } of adj.get(u) ?? []) {
        if (d + w < (dist.get(to) ?? Infinity)) {
          dist.set(to, d + w);
          prev.set(to, u);
          push([d + w, to]);
        }
      }
    }
    if (!dist.has(dst)) throw new Error(`no road path between waypoints ${k} and ${(k + 1) % ids.length}`);
    const seg: number[] = [];
    for (let n: number | undefined = dst; n !== undefined; n = prev.get(n)) seg.push(n);
    seg.reverse();
    for (const n of seg.slice(out.length ? 1 : 0)) out.push(pos.get(n) as LL);
  }
  return out;
}

// ───────────────────────────── geometry helpers ─────────────────────────────

/** Signed area of the (x, z) loop; > 0 means clockwise on the north-up map (x right, z down). */
function signedArea(p: V[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.z - q.x * p[i].z;
  }
  return a / 2;
}

/** Resample a closed polyline to n uniform samples starting at arc position `s0`. */
function resampleClosed(poly: V[], n: number, s0: number): V[] {
  const m = poly.length;
  const cum = [0];
  for (let i = 0; i < m; i++) cum.push(cum[i] + Math.hypot(poly[(i + 1) % m].x - poly[i].x, poly[(i + 1) % m].z - poly[i].z));
  const total = cum[m];
  const out: V[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = (s0 + (k * total) / n) % total;
    if (k === 0 || t < cum[j]) j = 0;
    while (j + 1 < m && cum[j + 1] <= t) j++;
    const f = (t - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
    const a = poly[j];
    const b = poly[(j + 1) % m];
    out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
  }
  return out;
}

/** Arc position (m) of the closest point on the closed polyline to `p`. */
function arcOfNearest(poly: V[], p: V): number {
  let cum = 0;
  let best = { d: Infinity, s: 0 };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const t = len > 0 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (len * len), 0, 1) : 0;
    const d = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
    if (d < best.d) best = { d, s: cum + t * len };
    cum += len;
  }
  return best.s;
}

/** Circular gaussian blur of a scalar series (sigma in samples). */
function gaussClosed(a: ArrayLike<number>, sigma: number): number[] {
  const n = a.length;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const w: number[] = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const sum = w.reduce((x, y) => x + y, 0);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += w[k + r] * a[(((i + k) % n) + n) % n];
    out[i] = s / sum;
  }
  return out;
}

/** Circular range test for s in [s0, s1] (metres, may be negative to wrap), loop length L. */
function inRange(s: number, s0: number, s1: number, L: number): boolean {
  const a = ((s0 % L) + L) % L;
  const len = ((s1 - s0) % L + L) % L;
  return (((s - a) % L) + L) % L <= len;
}

/**
 * Denoise the 1 m loop. Turning angles (curvature) are blurred and re-integrated, which keeps corner radii far
 * better than blurring positions; the low-frequency drift from the original is then added back.
 * Forced straights get zero curvature, then are blended exactly onto their chord.
 */
function smoothPath(p: V[], ds: number, sigmaM: number, straights: [number, number][]): { path: V[]; kappa: number[] } {
  const n = p.length;
  const L = n * ds;
  const turn: number[] = new Array(n); // turning angle at vertex i (+ = right)
  const heading = (i: number): number => {
    const q = p[(i + 1) % n];
    return Math.atan2(q.z - p[i].z, q.x - p[i].x);
  };
  for (let i = 0; i < n; i++) turn[i] = wrapAngle(heading(i) - heading((i - 1 + n) % n));
  let k = gaussClosed(turn, sigmaM / ds);
  k = k.map((v, i) => (straights.some(([a, b]) => inRange(i * ds, a, b, L)) ? 0 : v));
  // re-integrate headings from the original start heading
  const out: V[] = [{ x: p[0].x, z: p[0].z }];
  let th = heading(n - 1) + k[0];
  for (let i = 1; i <= n; i++) {
    const last = out[i - 1];
    out.push({ x: last.x + ds * Math.cos(th), z: last.z + ds * Math.sin(th) });
    th += k[i % n];
  }
  const closure = { x: out[n].x - out[0].x, z: out[n].z - out[0].z };
  const shear = out.slice(0, n).map((q, i) => ({ x: q.x - (closure.x * i) / n, z: q.z - (closure.z * i) / n }));
  const ex = gaussClosed(shear.map((q, i) => p[i].x - q.x), 120 / ds);
  const ez = gaussClosed(shear.map((q, i) => p[i].z - q.z), 120 / ds);
  const path = shear.map((q, i) => ({ x: q.x + ex[i], z: q.z + ez[i] }));
  // blend forced straights onto their chord: C2 ramps over the first/last `ramp` m, exactly straight in between
  for (const [a, b] of straights) {
    const i0 = Math.round((((a % L) + L) % L) / ds);
    const len = Math.round((((b - a) % L + L) % L) / ds);
    const ramp = Math.min(60 / ds, Math.floor(len / 4));
    const pa = path[i0 % n];
    const pb = path[(i0 + len) % n];
    const orig = path.slice();
    for (let j = 0; j <= len; j++) {
      const u = clamp(Math.min(j, len - j) / ramp, 0, 1);
      const w = u * u * u * (u * (u * 6 - 15) + 10);
      const f = j / len;
      const q = orig[(i0 + j) % n];
      path[(i0 + j) % n] = { x: q.x + w * (pa.x + (pb.x - pa.x) * f - q.x), z: q.z + w * (pa.z + (pb.z - pa.z) * f - q.z) };
    }
  }
  const kappa = path.map((_, i) => {
    const a = path[(i - 1 + n) % n];
    const b = path[(i + 1) % n];
    return wrapAngle(Math.atan2(b.z - path[i].z, b.x - path[i].x) - Math.atan2(path[i].z - a.z, path[i].x - a.x)) / ds;
  });
  return { path, kappa };
}

/** Self-crossings of the closed path as arc positions (sA < sB) in metres. */
function findCrossings(path: V[], ds: number): { sA: number; sB: number; at: V }[] {
  const step = 4;
  const pts = path.filter((_, i) => i % step === 0);
  const m = pts.length;
  const L = path.length * ds;
  const out: { sA: number; sB: number; at: V }[] = [];
  for (let i = 0; i < m; i++) {
    for (let j = i + 3; j < m; j++) {
      if (i === 0 && j >= m - 2) continue;
      const a = pts[i];
      const b = pts[(i + 1) % m];
      const c = pts[j];
      const d = pts[(j + 1) % m];
      const r = { x: b.x - a.x, z: b.z - a.z };
      const q = { x: d.x - c.x, z: d.z - c.z };
      const den = r.x * q.z - r.z * q.x;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((c.x - a.x) * q.z - (c.z - a.z) * q.x) / den;
      const u = ((c.x - a.x) * r.z - (c.z - a.z) * r.x) / den;
      if (t >= 0 && t < 1 && u >= 0 && u < 1) {
        out.push({ sA: ((i + t) * step * ds) % L, sB: ((j + u) * step * ds) % L, at: { x: a.x + r.x * t, z: a.z + r.z * t } });
      }
    }
  }
  return out;
}

/** Stretches >= 100 m with radius > 600 m: candidates for `straights` (reported with max chord deviation). */
function listStraights(path: V[], kappa: number[], ds: number): string {
  const n = path.length;
  const k = gaussClosed(kappa, 10 / ds);
  const calm = k.map((v) => Math.abs(v) < 1 / 600);
  const start = calm.indexOf(false);
  const out: string[] = [];
  if (start < 0) return 'all straight?';
  for (let i = 0; i < n; ) {
    if (!calm[(start + i) % n]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && calm[(start + j) % n]) j++;
    if ((j - i) * ds >= 100) {
      const a = path[(start + i) % n];
      const b = path[(start + j - 1) % n];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      let dev = 0;
      for (let q = i; q < j; q++) {
        const p = path[(start + q) % n];
        dev = Math.max(dev, Math.abs((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / len);
      }
      const s0 = (((start + i) * ds + 25) % (n * ds));
      const wrap = s0 > (n * ds) / 2 ? s0 - n * ds : s0;
      out.push(`[${wrap.toFixed(0)},${(wrap + (j - i) * ds - 50).toFixed(0)}] dev ${dev.toFixed(2)}m`);
    }
    i = j;
  }
  return out.join(' ');
}

// ───────────────────────────── elevation ─────────────────────────────

const lerpCyclic = (a: number[], s: number, L: number): number => {
  const n = a.length;
  const f = (((s % L) + L) % L) / (L / n);
  const i = Math.floor(f);
  return a[i % n] + (a[(i + 1) % n] - a[i % n]) * (f - i);
};

/** Circular running median (window 5) to kill single-sample DEM spikes (trees, buildings). */
function medianClosed(a: number[]): number[] {
  const n = a.length;
  return a.map((_, i) => [-2, -1, 0, 1, 2].map((k) => a[(i + k + n) % n]).sort((x, y) => x - y)[2]);
}

/** Smooth elevation at `m` uniform samples over loop length L; returns heights with the start line at 0. */
function buildElevation(raw: number[], L: number, cfg: CircuitConfig, crossings: { sA: number; sB: number }[], log: string[]): number[] {
  const m = raw.length;
  const du = L / m;
  const y = raw.slice();
  for (const o of cfg.elevation ?? []) {
    const idx = y.map((_, i) => i).filter((i) => inRange(i * du, o.s0, o.s1, L));
    if (!idx.length) continue;
    const len = (((o.s1 - o.s0) % L) + L) % L;
    const ya = o.y0 ?? lerpCyclic(raw, o.s0, L);
    const yb = o.y1 ?? lerpCyclic(raw, o.s1, L);
    for (const i of idx) {
      const t = len > 0 ? ((((i * du - o.s0) % L) + L) % L) / len : 0;
      y[i] = ya + (yb - ya) * t + (o.bump ?? 0) * Math.sin(Math.PI * t) ** 2;
    }
  }
  const sm = gaussClosed(medianClosed(y), (cfg.elevSigma ?? 40) / du);
  const mean = sm.reduce((a, b) => a + b, 0) / m;
  const scale = cfg.elevScale ?? 1;
  for (let i = 0; i < m; i++) sm[i] = mean + (sm[i] - mean) * scale;
  // self-crossings: force the upper road at least bridgeMinSep above the lower one (Hann bump, +/-150 m)
  const minSep = cfg.bridgeMinSep ?? 7.5;
  for (const c of crossings) {
    const yA = lerpCyclic(sm, c.sA, L);
    const yB = lerpCyclic(sm, c.sB, L);
    const mode = cfg.bridgeUpper ?? 'auto';
    const upperIsB = mode === 'later' ? true : mode === 'earlier' ? false : yB >= yA;
    const [sU, sL, diff] = upperIsB ? [c.sB, c.sA, yB - yA] : [c.sA, c.sB, yA - yB];
    const deficit = minSep + 0.5 - diff;
    log.push(`crossing at s=${c.sA.toFixed(0)}/${c.sB.toFixed(0)}: DEM gap ${diff.toFixed(1)} m, upper s=${sU.toFixed(0)}, added ${Math.max(0, deficit).toFixed(1)} m`);
    if (deficit <= 0) continue;
    const half = 150;
    for (let i = 0; i < m; i++) {
      const bump = (center: number, amp: number): void => {
        const d = Math.abs((((i * du - center + L / 2) % L) + L) % L - L / 2);
        if (d < half) sm[i] += amp * 0.5 * (1 + Math.cos((Math.PI * d) / half));
      };
      bump(sU, deficit * 0.6);
      bump(sL, -deficit * 0.4);
    }
  }
  return sm.map((v) => v - sm[0]);
}

// ───────────────────────────── control points ─────────────────────────────

const TOL = 0.12; // max distance (m) between the control-point spline and the smoothed path
const MIN_SEG = 5;

function pickControlIndices(path: V[], kappa: number[], ds: number): number[] {
  const n = path.length;
  const idx: number[] = [];
  for (let i = 0; i < n; ) {
    idx.push(i);
    let kmax = 0;
    for (let j = 0; j <= 25 / ds; j++) kmax = Math.max(kmax, Math.abs(kappa[(i + j) % n]));
    const radius = 1 / Math.max(kmax, 1e-4);
    i += Math.round(clamp((radius * 0.35) / ds, 8 / ds, 25 / ds));
  }
  if (n - idx[idx.length - 1] < 8 / ds) idx.pop();
  return idx;
}

/** Insert control points where the Catmull-Rom spline strays from the smoothed path by more than TOL. */
function refineControls(path: V[], z: number[], idx: number[], ds: number): { idx: number[]; maxDev: number } {
  const n = path.length;
  let maxDev = 0;
  for (let iter = 0; iter < 12; iter++) {
    const spl = sampleClosedSpline(idx.map((i) => ({ x: path[i].x, z: path[i].z, y: z[i], width: 12 })), 2);
    const segErr = new Map<number, number>();
    let near = 0;
    maxDev = 0;
    for (let j = 0; j < spl.count; j++) {
      const p = { x: spl.px[j], z: spl.pz[j] };
      let best = Infinity;
      let bi = near;
      for (let k = near - 4; k <= near + 80; k++) {
        const a = path[(k + n) % n];
        const b = path[(k + 1 + n) % n];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
        const d = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
        if (d < best) [best, bi] = [d, k];
      }
      near = Math.min(bi, n + 1000);
      const at = ((bi % n) + n) % n;
      let seg = idx.length - 1;
      for (let q = 0; q < idx.length; q++) if (idx[q] > at) { seg = q - 1; break; }
      segErr.set(seg, Math.max(segErr.get(seg) ?? 0, best));
      maxDev = Math.max(maxDev, best);
    }
    const add: number[] = [];
    for (const [seg, err] of segErr) {
      const a = idx[seg];
      const b = seg + 1 < idx.length ? idx[seg + 1] : n;
      if (err > TOL && (b - a) * ds >= 2 * MIN_SEG) add.push(Math.round((a + b) / 2) % n);
    }
    if (!add.length) break;
    idx = [...idx, ...add].sort((x, y) => x - y);
  }
  return { idx, maxDev };
}

// ───────────────────────────── per-circuit driver ─────────────────────────────

async function loadConfig(): Promise<Record<string, CircuitConfig>> {
  const url = new URL('./circuits.json', import.meta.url);
  return JSON.parse(await readFile(decodeURIComponent(url.pathname), 'utf8')) as Record<string, CircuitConfig>;
}

async function fetchLoop(id: string, cfg: CircuitConfig, log: string[]): Promise<LL[]> {
  const [s, w, n, e] = cfg.bbox;
  if (cfg.route) {
    const filter = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|raceway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$';
    const els = await overpass(`[out:json][timeout:180];way["highway"~"${filter}"](${s},${w},${n},${e});out geom;`);
    const loop = routeLoop(els.filter((x) => x.type === 'way'), cfg.route, cfg.avoid ?? []);
    log.push(`route: ${cfg.route.length} waypoints over ${els.length} ways`);
    return loop;
  }
  const exclude = new Set(cfg.ways?.exclude ?? []);
  const els: OsmElement[] = [];
  if (cfg.relation) {
    const r = await overpass(`[out:json][timeout:120];rel(${cfg.relation});out tags;way(r);out geom;`);
    const rel = r.find((x) => x.type === 'relation');
    log.push(`relation ${cfg.relation}: ${rel?.tags?.name ?? '?'}`);
    els.push(...r.filter((x) => x.type === 'way'));
  }
  if (cfg.ways?.include?.length) {
    els.push(...(await overpass(`[out:json][timeout:120];way(id:${cfg.ways.include.join(',')});out geom;`)));
  }
  if (!els.length) throw new Error(`${id}: config needs relation, ways.include or route`);
  const included = new Set(cfg.ways?.include ?? []);
  const keep = els.filter((x) => !exclude.has(x.id) && (included.has(x.id) || !isPitWay(x.tags)));
  const dropped = els.filter((x) => !keep.includes(x)).map((x) => x.id);
  if (dropped.length) log.push(`dropped ways (pit/excluded): ${dropped.join(',')}`);
  const chain = chainWays(keep, cfg.official, cfg.bridgeGap ?? 40, log);
  if (chain.left.length) log.push(`UNUSED ways (not on the loop; exclude or fix): ${chain.left.join(',')}`);
  return chain.pts;
}

interface Result {
  id: string;
  lines: string[];
  summary: string;
}

async function importCircuit(id: string, cfg: CircuitConfig): Promise<Result> {
  const log: string[] = [];
  const ll = await fetchLoop(id, cfg, log);

  // local projection around the loop centroid
  const lat0 = ll.reduce((s, p) => s + p.lat, 0) / ll.length;
  const lon0 = ll.reduce((s, p) => s + p.lon, 0) / ll.length;
  const toXZ = (p: LL): V => ({ x: (p.lon - lon0) * DEG * R_EARTH * Math.cos(lat0 * DEG), z: -(p.lat - lat0) * DEG * R_EARTH });
  const toLL = (p: V): LL => ({ lat: lat0 - p.z / (DEG * R_EARTH), lon: lon0 + p.x / (DEG * R_EARTH * Math.cos(lat0 * DEG)) });
  let poly = ll.map(toXZ);
  // drop closing duplicate
  if (poly.length > 2 && Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].z - poly[poly.length - 1].z) < 0.5) poly.pop();
  const rawLength = poly.reduce((s, p, i) => s + Math.hypot(poly[(i + 1) % poly.length].x - p.x, poly[(i + 1) % poly.length].z - p.z), 0);

  // orientation
  const area = signedArea(poly);
  const startXZ = toXZ({ lat: cfg.start[0], lon: cfg.start[1] });
  const orient = (reverse: boolean): V[] => (reverse ? poly.slice().reverse() : poly);
  let reverse: boolean;
  let dirNote: string;
  if (cfg.firstTurn) {
    // sign of the first real corner (net turn over 60 samples once 20 samples turn by > 0.25 rad)
    const probe = (rev: boolean): number => {
      const q = orient(rev);
      const s0 = arcOfNearest(q, startXZ);
      const r = resampleClosed(q, Math.round(rawLength), s0);
      const turn = (i: number): number =>
        wrapAngle(Math.atan2(r[i + 1].z - r[i].z, r[i + 1].x - r[i].x) - Math.atan2(r[i].z - r[i - 1].z, r[i].x - r[i - 1].x));
      for (let i = 1; i < cfg.firstTurn!.within; i++) {
        let w = 0;
        for (let k = 0; k < 20; k++) w += turn(i + k);
        if (Math.abs(w) > 0.25) {
          let net = 0;
          for (let k = 0; k < 60; k++) net += turn(i + k);
          return net;
        }
      }
      return 0;
    };
    const wantRight = cfg.firstTurn.turn === 'right';
    reverse = probe(false) > 0 !== wantRight;
    dirNote = `first corner ${cfg.firstTurn.turn} within ${cfg.firstTurn.within} m (area ${(area / 1e4).toFixed(1)} ha)`;
  } else {
    const isClockwise = area > 0;
    reverse = isClockwise !== (cfg.direction === 'clockwise');
    dirNote = `area ${(area / 1e4).toFixed(1)} ha => ${isClockwise ? 'clockwise' : 'anticlockwise'} as mapped${reverse ? ', chain reversed' : ''}`;
  }
  poly = orient(reverse);
  const finalArea = signedArea(poly);

  // start line -> s = 0, 1 m resample
  const s0 = (((arcOfNearest(poly, startXZ) + (cfg.startOffset ?? 0)) % rawLength) + rawLength) % rawLength;
  const n = Math.round(rawLength);
  const ds = rawLength / n;
  const dense = resampleClosed(poly, n, s0);
  const sigma = cfg.sigma ?? 5;
  const straights = cfg.straights ?? [];
  const { path, kappa } = smoothPath(dense, ds, sigma, straights);
  const L = path.reduce((s, p, i) => s + Math.hypot(path[(i + 1) % n].x - p.x, path[(i + 1) % n].z - p.z), 0);
  const crossings = findCrossings(path, ds);
  log.push(`straight candidates (s0..s1 trimmed 25 m): ${listStraights(path, kappa, ds)}`);

  // elevation: DEM every ~25 m
  const m = Math.round(L / 25);
  const samplePts: LL[] = [];
  for (let k = 0; k < m; k++) samplePts.push(toLL(path[Math.round((k * n) / m) % n]));
  const raw = await elevations(samplePts, cfg.dem);
  const elev = buildElevation(raw, L, cfg, crossings, log);
  if (process.env.PROFILE) {
    const du = L / m;
    const rows: string[] = [];
    for (let k = 0; k < m; k += Math.round(100 / du)) rows.push(`${Math.round(k * du)}:${raw[k].toFixed(0)}/${elev[k].toFixed(1)}`);
    log.push(`profile s:rawDEM/final  ${rows.join(' ')}`);
  }
  const yAt = (i: number): number => lerpCyclic(elev, (i * L) / n, L);

  // control points
  const yDense = path.map((_, i) => yAt(i));
  const picked = refineControls(path, yDense, pickControlIndices(path, kappa, ds), ds);
  const points: TrackControlPoint[] = picked.idx.map((i) => ({
    x: +path[i].x.toFixed(2),
    z: +path[i].z.toFixed(2),
    y: +yDense[i].toFixed(2),
  }));

  // build with the real engine and report
  const def: TrackDef = {
    id, name: cfg.name, location: id, country: '', biome: 'city', timeOfDay: 'day', street: false,
    points, width: 12, fullLaps: 50, sectors: [0.33, 0.66], drsZones: [],
    pit: { side: 'left', entry: 0.95, exit: 0.05, box: 0 }, description: '',
  };
  let built: ReturnType<typeof buildTrack> | null = null;
  try {
    built = buildTrack(def);
  } catch (e) {
    log.push(`buildTrack FAILED: ${String(e)}`);
  }
  const ys = elev;
  let maxGrade = 0;
  let minRadius = Infinity;
  let builtLength = L;
  if (built) {
    builtLength = built.length;
    const w = Math.round(20 / built.spacing);
    for (let i = 0; i < built.count; i++) {
      maxGrade = Math.max(maxGrade, Math.abs(built.py[(i + w) % built.count] - built.py[i]) / (w * built.spacing));
      minRadius = Math.min(minRadius, 1 / Math.max(1e-6, Math.abs(built.curvature[i])));
    }
  }
  // tightest corners (s, radius, side) to eyeball direction against the real layout
  let tightest = '';
  let clearance = '';
  if (built) {
    const b = built;
    const order = Array.from({ length: b.count }, (_, i) => i).sort((p, q) => Math.abs(b.curvature[q]) - Math.abs(b.curvature[p]));
    const picked: number[] = [];
    for (const i of order) {
      if (picked.length >= 4) break;
      if (picked.every((j) => Math.abs(j - i) * b.spacing > 80)) picked.push(i);
    }
    tightest = picked.map((i) => `s${Math.round(i * b.spacing)} R${Math.round(1 / Math.abs(b.curvature[i]))}${b.curvature[i] > 0 ? 'R' : 'L'}`).join(' ');
    // final height difference at self-crossings (built.py, 12 m smoothed)
    clearance = crossings
      .map((c) => `${Math.abs(b.py[Math.round(c.sA / b.spacing) % b.count] - b.py[Math.round(c.sB / b.spacing) % b.count]).toFixed(1)} m`)
      .join(', ');
  }
  // contiguous stretch around s = 0 with radius > 1500 m (the pit straight)
  let backM = 0;
  let fwdM = 0;
  if (built) {
    const calm = (i: number): boolean => Math.abs(built!.curvature[((i % built!.count) + built!.count) % built!.count]) < 1 / 1500;
    while (backM < built.length / 2 && calm(-backM / built.spacing - 1)) backM += built.spacing;
    while (fwdM < built.length / 2 && calm(fwdM / built.spacing)) fwdM += built.spacing;
  }
  const straightCurv = (built && straights.length)
    ? straights.filter(([a, b]) => b - a > 180).map(([a, b]) => {
        let mx = 0;
        for (let i = 0; i < built!.count; i++) if (inRange(i * built!.spacing, a + 85, b - 85, builtLength)) mx = Math.max(mx, Math.abs(built!.curvature[i]));
        return `straight[${a + 60},${b - 60}] max|k|=${mx.toExponential(1)}`;
      })
    : [];

  await writeOutput(id, cfg, points);
  const pct = ((builtLength / cfg.official - 1) * 100).toFixed(1);
  const dirOk = (finalArea > 0) === (cfg.direction === 'clockwise') || !!cfg.firstTurn;
  const summary =
    `${id}: built ${builtLength.toFixed(0)} m vs official ${cfg.official} (${pct}%), raw OSM ${rawLength.toFixed(0)} m, ` +
    `${points.length} pts, y ${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)} m, ` +
    `max grade ${(maxGrade * 100).toFixed(1)}%, min R ${minRadius.toFixed(0)} m, spline dev ${picked.maxDev.toFixed(2)} m, ` +
    `straight at s0 -${backM.toFixed(0)}..+${fwdM.toFixed(0)} m, ` +
    `direction ${dirOk ? 'OK' : 'MISMATCH'} (${dirNote}), crossings ${crossings.length}${clearance ? ` (clearance ${clearance})` : ''}, tightest ${tightest}`;
  return { id, lines: [...log, ...straightCurv], summary };
}

async function writeOutput(id: string, cfg: CircuitConfig, pts: TrackControlPoint[]): Promise<void> {
  const name = `${id.toUpperCase().replace(/-/g, '_')}_POINTS`;
  const body = pts.map((p) => `  { x: ${p.x}, z: ${p.z}, y: ${p.y} },`).join('\n');
  const text = `/**
 * ${cfg.name} - raw centre-line control points (driving order, points[0] = start/finish line).
 * Source: © OpenStreetMap contributors (ODbL), elevation: ${cfg.dem.join(' / ')} via OpenTopoData.
 * Generated by tools/import-circuit.ts on ${new Date().toISOString().slice(0, 10)}. x = east, z = south (m), y relative to the line.
 */
import type { TrackControlPoint } from '../../src/core/types';

export const ${name}: TrackControlPoint[] = [
${body}
];
`;
  await mkdir(new URL('./out', import.meta.url).pathname, { recursive: true });
  await writeFile(decodeURIComponent(new URL(`./out/${id}.points.ts`, import.meta.url).pathname), text);
}

async function findCmd(id: string, cfg: CircuitConfig): Promise<void> {
  const [s, w, n, e] = cfg.bbox;
  const els = await overpass(
    `[out:json][timeout:120];(relation["type"="circuit"](${s},${w},${n},${e});way["highway"="raceway"](${s},${w},${n},${e}););out tags geom;`,
  );
  const ways = els.filter((x) => x.type === 'way');
  console.log(`${id}: ${ways.length} raceway ways (${ways.reduce((a, x) => a + polyLen(x.geometry ?? []), 0).toFixed(0)} m total)`);
  for (const x of els.filter((e) => e.type === 'relation')) console.log(`relation ${x.id} name=${x.tags?.name ?? ''} ${x.tags?.layout ?? ''}`);
  if (process.argv[4] === '--ways') {
    for (const x of ways) console.log(`way ${x.id} len=${polyLen(x.geometry ?? []).toFixed(0)} ${x.tags?.name ?? ''}`);
  }
}

async function main(): Promise<void> {
  await mkdir(CACHE, { recursive: true });
  const cfgAll = await loadConfig();
  const [a, b] = process.argv.slice(2);
  if (!a) {
    console.log('usage: bun tools/import-circuit.ts <id>|all | find <id>');
    process.exit(1);
  }
  if (a === 'find') {
    await findCmd(b, cfgAll[b]);
    return;
  }
  const ids = a === 'all' ? Object.keys(cfgAll) : [a];
  const summaries: string[] = [];
  for (const id of ids) {
    if (!cfgAll[id]) throw new Error(`unknown circuit ${id}`);
    console.log(`\n== ${id}`);
    try {
      const r = await importCircuit(id, cfgAll[id]);
      r.lines.forEach((l) => console.log(`  ${l}`));
      console.log(r.summary);
      summaries.push(r.summary);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.log(`${id}: FAILED ${msg}`);
      summaries.push(`${id}: FAILED ${msg.split('\n')[0]}`);
    }
  }
  console.log('\n===== summary =====');
  summaries.forEach((s) => console.log(s));
}

await main();
