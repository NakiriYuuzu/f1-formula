/**
 * Live delta (pure logic, no DOM): distance→time lap traces in fixed distance bins. The current lap is
 * recorded while driving; a completed personal-best lap (or the time-trial ghost) becomes the reference
 * the live delta is read from.
 */
import type { BuiltTrack, CarTiming, GhostData } from '../../core/types';
import { clamp, clamp01 } from '../../core/math';

/** Bin size (m). */
export const TRACE_BIN = 5;
/** A forward jump larger than this between two samples means the car was teleported (trace untrustworthy). */
const MAX_JUMP = 250;

const binCount = (length: number): number => Math.max(2, Math.floor(length / TRACE_BIN) + 1);

/** Immutable reference lap: time (s) at each distance bin from the line. */
export class LapTrace {
  constructor(
    readonly length: number,
    readonly lapTime: number,
    private readonly times: Float64Array,
  ) {}

  /** Reference time at distance `d` (m) into the lap. */
  timeAt(d: number): number {
    const n = this.times.length;
    const dist = clamp(Number.isFinite(d) ? d : 0, 0, this.length);
    const x = dist / TRACE_BIN;
    const i = Math.floor(x);
    if (i >= n - 1) {
      const lastD = (n - 1) * TRACE_BIN;
      const t0 = this.times[n - 1];
      const span = this.length - lastD;
      return span > 1e-6 ? t0 + (this.lapTime - t0) * clamp01((dist - lastD) / span) : t0;
    }
    const f = x - i;
    return this.times[i] + (this.times[i + 1] - this.times[i]) * f;
  }
}

/** Records the lap being driven into distance bins. */
export class LapRecorder {
  private readonly times: Float64Array;
  private filled = 0;
  private prevD = 0;
  private prevT = 0;
  private complete = false;

  constructor(private readonly length: number) {
    this.times = new Float64Array(binCount(length));
  }

  /** Start a new lap. `fromLine` = the line crossing was observed (trace can become a reference). */
  begin(fromLine: boolean): void {
    this.times.fill(0);
    this.filled = 0;
    this.prevD = 0;
    this.prevT = 0;
    this.complete = fromLine;
  }

  sample(distance: number, time: number): void {
    if (!Number.isFinite(distance) || !Number.isFinite(time)) return;
    const d = clamp(distance, 0, this.length);
    if (d < this.prevD) {
      // Moved backwards (flashback / reversing): bins past this point get re-recorded.
      this.filled = Math.min(this.filled, Math.floor(d / TRACE_BIN));
      this.prevD = d;
      this.prevT = time;
      return;
    }
    if (d - this.prevD > MAX_JUMP) this.complete = false;
    this.fillTo(d, time, Math.min(this.times.length - 1, Math.floor(d / TRACE_BIN)));
  }

  /** Close the lap at the line with its official time; returns a reference trace or null if incomplete. */
  finish(lapTime: number): LapTrace | null {
    if (!this.complete || !Number.isFinite(lapTime) || lapTime <= 0) return null;
    const last = this.times.length - 1;
    if (this.filled < last * 0.8) return null;
    this.fillTo(this.length, lapTime, last);
    // Enforce a monotonic, bounded trace.
    const out = Float64Array.from(this.times);
    let prev = 0;
    for (let i = 0; i < out.length; i++) {
      const v = clamp(Number.isFinite(out[i]) ? out[i] : prev, prev, lapTime);
      out[i] = v;
      prev = v;
    }
    return new LapTrace(this.length, lapTime, out);
  }

  private fillTo(d: number, t: number, target: number): void {
    const span = d - this.prevD;
    for (let i = this.filled + 1; i <= target; i++) {
      const f = span > 1e-9 ? clamp01((i * TRACE_BIN - this.prevD) / span) : 1;
      this.times[i] = this.prevT + (t - this.prevT) * f;
    }
    if (target > this.filled) this.filled = target;
    this.prevD = d;
    this.prevT = t;
  }
}

/** Per-car live delta against the session personal best (or a fixed ghost reference). */
export class DeltaTracker {
  private readonly recorder: LapRecorder | null;
  private best: LapTrace | null = null;
  private lap = -1;
  private lastWorldTime = -Infinity;

  constructor(
    private readonly length: number,
    private readonly ghost: LapTrace | null,
  ) {
    this.recorder = length > 0 && Number.isFinite(length) ? new LapRecorder(length) : null;
  }

  /** 'ghost' | 'best' | null — what the delta is currently measured against. */
  get reference(): 'ghost' | 'best' | null {
    if (this.ghost) return 'ghost';
    return this.best ? 'best' : null;
  }

  /**
   * Feed this frame's timing. `trackS` (car's distance from the line along the track) is a fallback when the
   * progress-derived lap distance is inconsistent. Returns the delta in seconds (+ = slower) or null.
   */
  update(timing: CarTiming, worldTime: number, trackS: number): number | null {
    const rec = this.recorder;
    if (!rec) return null;
    const lap = Number.isFinite(timing.lap) ? Math.floor(timing.lap) : 0;
    const lapTime = Number.isFinite(timing.currentLapTime) ? timing.currentLapTime : 0;
    const rewound = worldTime < this.lastWorldTime - 1e-6;
    this.lastWorldTime = worldTime;
    let d = this.lapDistance(timing, trackS);

    if (this.lap < 0) {
      this.lap = lap;
      rec.begin(lap >= 1 && lapTime < 0.5 && d < 20);
    } else if (lap > this.lap) {
      if (lap === this.lap + 1 && this.lap >= 1) this.finishLap(timing);
      this.lap = lap;
      rec.begin(true);
      // Lap counter and distance may wrap on different steps; a fresh lap always starts at the line.
      if (d > this.length * 0.5) d = 0;
    } else if (lap < this.lap || (rewound && lap !== this.lap)) {
      this.lap = lap;
      rec.begin(false);
    }

    if (this.best && (timing.bestLap == null || timing.bestLap > this.best.lapTime + 1e-3)) this.best = null;
    if (lap < 1) return null;
    rec.sample(d, lapTime);
    const ref = this.ghost ?? this.best;
    if (!ref || d < 25) return null;
    const delta = lapTime - ref.timeAt(d);
    return Number.isFinite(delta) ? delta : null;
  }

  private lapDistance(timing: CarTiming, trackS: number): number {
    const fromProgress = timing.progress - timing.lapsCompleted * this.length;
    if (Number.isFinite(fromProgress) && fromProgress >= -5 && fromProgress <= this.length + 5) {
      return clamp(fromProgress, 0, this.length);
    }
    return clamp(Number.isFinite(trackS) ? trackS : 0, 0, this.length);
  }

  private finishLap(timing: CarTiming): void {
    const last = timing.lastLap;
    if (this.recorder === null || last == null || !Number.isFinite(last)) return;
    const trace = this.recorder.finish(last);
    if (!trace) return;
    const isPersonalBest = timing.bestLap != null && Math.abs(timing.bestLap - last) < 1e-4;
    if (isPersonalBest && (!this.best || last <= this.best.lapTime + 1e-6)) this.best = trace;
  }
}

/** Nearest track sample to (x, z); windowed around `hint` when given (≥ 0), global otherwise. */
function nearestIndex(track: BuiltTrack, x: number, z: number, hint: number): number {
  const n = track.count;
  let best = Math.max(0, Math.min(n - 1, hint));
  let bestD = Infinity;
  const visit = (i: number): void => {
    const dx = track.px[i] - x;
    const dz = track.pz[i] - z;
    const dd = dx * dx + dz * dz;
    if (dd < bestD) {
      bestD = dd;
      best = i;
    }
  };
  if (hint < 0) {
    for (let i = 0; i < n; i++) visit(i);
  } else {
    const w = Math.min(60, Math.floor(n / 2));
    for (let k = -w; k <= w; k++) visit((((hint + k) % n) + n) % n);
  }
  return best;
}

/** Build a reference trace from (distance, time) samples, starting at (0, 0) and ending at (length, lapTime). */
function traceFromSamples(length: number, lapTime: number, ds: number[], ts: number[]): LapTrace {
  const pd: number[] = [0];
  const pt: number[] = [0];
  for (let k = 0; k < ds.length; k++) {
    const d = ds[k];
    const t = ts[k];
    if (!(d > pd[pd.length - 1] + 0.01) || d >= length || t < pt[pt.length - 1] || t > lapTime) continue;
    pd.push(d);
    pt.push(t);
  }
  pd.push(length);
  pt.push(lapTime);
  const times = new Float64Array(binCount(length));
  let seg = 0;
  for (let i = 0; i < times.length; i++) {
    const D = Math.min(i * TRACE_BIN, length);
    while (seg < pd.length - 2 && pd[seg + 1] < D) seg++;
    const span = pd[seg + 1] - pd[seg];
    const f = span > 1e-9 ? clamp01((D - pd[seg]) / span) : 1;
    times[i] = pt[seg] + (pt[seg + 1] - pt[seg]) * f;
  }
  return new LapTrace(length, lapTime, times);
}

/** Reference trace of a time-trial ghost lap (null when unusable or for another layout). */
export function buildGhostTrace(track: BuiltTrack, ghost: GhostData | null): LapTrace | null {
  if (!ghost || ghost.layoutId !== track.id) return null;
  const len = track.length;
  const n = Math.floor(ghost.samples.length / 4);
  if (n < 2 || !(ghost.dt > 0) || !(ghost.lapTime > 0) || !Number.isFinite(ghost.lapTime)) return null;
  if (!(len > 0) || !Number.isFinite(len) || track.count < 2) return null;
  const ds: number[] = [];
  const ts: number[] = [];
  let idx = -1;
  let prevS = NaN;
  for (let k = 0; k < n; k++) {
    const x = ghost.samples[k * 4];
    const z = ghost.samples[k * 4 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    idx = nearestIndex(track, x, z, idx);
    let s = track.s[idx] + (x - track.px[idx]) * track.tx[idx] + (z - track.pz[idx]) * track.tz[idx];
    if (!Number.isFinite(s)) continue;
    if (Number.isNaN(prevS)) {
      if (s > len / 2) s -= len;
    } else {
      s += Math.round((prevS - s) / len) * len;
    }
    prevS = s;
    ds.push(s);
    ts.push(k * ghost.dt);
  }
  if (ds.length < 2) return null;
  return traceFromSamples(len, ghost.lapTime, ds, ts);
}
