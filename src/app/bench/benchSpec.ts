/**
 * Benchmark mode, pure parts: URL parameters (`?bench=1&quality=low&...`), the scenario table, the tier-field overrides
 * for A/B runs, frame-time statistics and the result shape shown by the panel and exposed as `window.__benchResult`.
 */
import type { QualityLevel, TimeOfDay, WeatherKind } from '../../core/types';
import { baseQualityProfile, type QualityProfile } from '../../render/core/quality';

export const BENCH_QUALITIES: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
/** Every benchmark session uses this seed, so the grid, the AI and the weather are the same on every machine. */
export const BENCH_SEED = 20251;
/** The play rate the benchmark simulates: one frame = 1/60 s of play (two 120 Hz steps). */
export const BENCH_FRAME_MS = 1000 / 60;

export interface BenchScenario {
  id: string;
  /** zh-TW label for the panel */
  label: string;
  layoutId: string;
  weather: WeatherKind;
  timeOfDay: TimeOfDay;
  /** grid slot of the player's car (autopilot drives it); the camera follows it */
  startPosition: number;
  /** simulated seconds run before the first timed frame (0 = the standing grid) */
  runUpSeconds: number;
  /** most frames (warm-up included) before the scenario must stop; the grid has to end before lights out */
  maxFrames: number;
}

export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  { id: 'grid-monza', label: 'Monza 發車格（20 車，日間）', layoutId: 'monza', weather: 'clear', timeOfDay: 'day', startPosition: 10, runUpSeconds: 0, maxFrames: 340 },
  { id: 'pack-spa', label: 'Spa 車群中段（日間）', layoutId: 'spa', weather: 'clear', timeOfDay: 'day', startPosition: 10, runUpSeconds: 28, maxFrames: 2000 },
  { id: 'rain-spa', label: 'Spa 大雨（日間）', layoutId: 'spa', weather: 'heavyRain', timeOfDay: 'day', startPosition: 10, runUpSeconds: 28, maxFrames: 2000 },
  { id: 'night-singapore', label: '新加坡街道賽（夜間）', layoutId: 'singapore', weather: 'clear', timeOfDay: 'night', startPosition: 10, runUpSeconds: 28, maxFrames: 2000 },
];

export interface BenchParams {
  qualities: QualityLevel[];
  scenarios: BenchScenario[];
  /** device pixel ratios to run (null = the display's own) */
  dprs: (number | null)[];
  /** Settings.resolutionScale */
  scale: number;
  width: number;
  height: number;
  frames: number;
  warmup: number;
  runs: number;
  autorun: boolean;
  /** canvas MSAA of the context, fixed when the page loads: null = the first listed quality's tier decides, else forced */
  antialias: boolean | null;
  /** tier fields overridden in the treatment variant (empty = a single, untuned variant) */
  tune: Partial<QualityProfile>;
  /** alternate an untuned and a tuned variant on every run */
  ab: boolean;
  /** load one scenario, run warm-up frames, then stop on the frame for a screenshot */
  hold: boolean;
}

const DEFAULTS = { frames: 300, warmup: 45, runs: 1, width: 1280, height: 720, scale: 1 };

function list(raw: string | null): string[] {
  return raw === null ? [] : raw.split(',').map((x) => x.trim()).filter((x) => x !== '');
}

function intIn(raw: string | null, min: number, max: number, fallback: number): number {
  const v = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

/**
 * `tune=shadowMapSize:0,lampLights:2,post:0`: keys must be fields of the quality table; a boolean field takes
 * 0/1/true/false, a number field a number, a string field is refused. Unknown or ill-typed entries are dropped.
 */
export function parseTune(raw: string | null): Partial<QualityProfile> {
  const out: Record<string, number | boolean> = {};
  const sample = baseQualityProfile('high') as unknown as Record<string, unknown>;
  for (const item of list(raw)) {
    const [key, val] = item.split(':');
    if (key === undefined || val === undefined || !(key in sample) || key === 'level') continue;
    const current = sample[key];
    if (typeof current === 'boolean') {
      if (val === '0' || val === 'false') out[key] = false;
      else if (val === '1' || val === 'true') out[key] = true;
    } else if (typeof current === 'number') {
      const n = Number(val);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  return out as Partial<QualityProfile>;
}

/** Parse location.search; null when the URL does not ask for the benchmark. */
export function parseBench(search: string): BenchParams | null {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    return null;
  }
  const flag = q.get('bench');
  if (flag === null || flag === '0') return null;
  const qualities = list(q.get('quality')).filter((x): x is QualityLevel => (BENCH_QUALITIES as readonly string[]).includes(x));
  const wanted = list(q.get('scenario'));
  const scenarios = wanted.length > 0 ? BENCH_SCENARIOS.filter((s) => wanted.includes(s.id)) : [...BENCH_SCENARIOS];
  const dprs = list(q.get('dpr'))
    .map((x) => (x === 'device' ? null : Number(x)))
    .filter((x): x is number | null => x === null || (Number.isFinite(x) && x > 0));
  const size = /^(\d{3,5})x(\d{3,5})$/.exec(q.get('size') ?? '');
  const tune = parseTune(q.get('tune'));
  const scale = Number(q.get('scale'));
  return {
    qualities: qualities.length > 0 ? [...new Set(qualities)] : [...BENCH_QUALITIES],
    scenarios: scenarios.length > 0 ? scenarios : [...BENCH_SCENARIOS],
    dprs: dprs.length > 0 ? dprs : [null],
    scale: Number.isFinite(scale) && scale >= 0.5 && scale <= 1 ? scale : DEFAULTS.scale,
    width: size ? Number(size[1]) : DEFAULTS.width,
    height: size ? Number(size[2]) : DEFAULTS.height,
    frames: intIn(q.get('frames'), 30, 5000, DEFAULTS.frames),
    warmup: intIn(q.get('warmup'), 0, 1000, DEFAULTS.warmup),
    runs: intIn(q.get('runs'), 1, 20, DEFAULTS.runs),
    autorun: q.get('autorun') === '1',
    antialias: q.get('aa') === '0' ? false : q.get('aa') === '1' ? true : null,
    tune,
    ab: q.get('ab') === '1' && Object.keys(tune).length > 0,
    hold: q.get('hold') === '1',
  };
}

// ───────────────────────────── statistics ─────────────────────────────

export interface Dist {
  median: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Nearest-rank percentile of an ascending array. */
function rank(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

export function summarize(values: readonly number[]): Dist {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { median: r3(rank(s, 0.5)), p95: r3(rank(s, 0.95)), p99: r3(rank(s, 0.99)), mean: r3(sum / s.length), min: r3(s[0] ?? 0), max: r3(s[s.length - 1] ?? 0) };
}

// ───────────────────────────── result ─────────────────────────────

export interface BenchCounters {
  /** renderer.info of one frame, median over the timed frames (post passes included) */
  drawCalls: number;
  triangles: number;
  programs: number;
  canvasWidth: number;
  canvasHeight: number;
  canvasPixels: number;
  /** MSAA samples of the canvas framebuffer, and of the target the scene is drawn into */
  canvasSamples: number;
  sceneSamples: number;
  /** enabled post passes after the scene pass, and Mpx they write per frame */
  fullscreenPasses: number;
  postFillMpx: number;
  shadowRenders: number;
  lights: number;
  shadowLights: number;
  ibl: boolean;
}

export interface BenchRow {
  run: number;
  variant: 'base' | 'tuned';
  quality: QualityLevel;
  /** requested pixel ratio (null = the display's) and the one the canvas ended up with */
  dpr: number | null;
  pixelRatio: number;
  scenario: string;
  /** frames timed (after warm-up) */
  frames: number;
  /** wall time of one frame: sim + HUD + render + GPU finish */
  frameMs: Dist;
  /** the part up to the end of the JS call (sim, HUD, command submission) */
  cpuMs: Dist;
  /** the part spent waiting for the GPU to finish (readPixels) */
  gpuWaitMs: Dist;
  counters: BenchCounters;
  /** session phase after the last frame (a grid scenario must still be on the grid) */
  phaseEnd: string;
  errors: number;
}

export interface BenchEnv {
  userAgent: string;
  gpu: string;
  /** the GPU string names a software rasteriser (SwiftShader, llvmpipe, ...) */
  software: boolean;
  /** the tier automatic quality starts with on this GPU, by its name (guessQuality) */
  autoPick: QualityLevel;
  deviceDpr: number;
  maxSamples: number;
  startedAt: string;
}

export interface BenchResult {
  version: 1;
  env: BenchEnv;
  params: {
    qualities: QualityLevel[];
    scenarios: string[];
    dprs: (number | null)[];
    scale: number;
    cssWidth: number;
    cssHeight: number;
    frames: number;
    warmup: number;
    runs: number;
    antialias: boolean | null;
    tune: Partial<QualityProfile>;
    ab: boolean;
  };
  rows: BenchRow[];
  done: boolean;
}
