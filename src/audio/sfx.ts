/**
 * Short synthesized one-shot sounds (original designs): start-light beeps, lights-out cue, chequered motif,
 * PB chime, pit-limiter beep, gear-shift click, collision thump, wheel-gun burst and UI sounds.
 * Every one-shot is tracked by a OneShotPool: nodes are disconnected when it ends, a cap prevents pile-ups,
 * and stopAll() silences a bus immediately (leaving a session).
 */
import { clamp, clamp01 } from '../core/math';
import { releaseNodes, safeFreq, type SharedAudio } from './context';

interface OneShot {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  pending: number;
}

/** Bounded set of live one-shots feeding one output bus. */
export class OneShotPool {
  private readonly live = new Set<OneShot>();

  constructor(
    readonly shared: SharedAudio,
    readonly out: AudioNode,
    private readonly limit = 24,
  ) {}

  canPlay(): boolean {
    return this.live.size < this.limit;
  }

  /** Builds a one-shot via `build` (which wires nodes into `dest` and returns its sources); auto-cleans on end. */
  play(build: (b: SoundBuilder) => void): void {
    if (!this.canPlay()) return;
    const builder = new SoundBuilder(this.shared, this.out);
    try {
      build(builder);
    } catch {
      releaseNodes(builder.nodes);
      return;
    }
    if (builder.sources.length === 0) {
      releaseNodes(builder.nodes);
      return;
    }
    const shot: OneShot = { sources: builder.sources, nodes: builder.nodes, pending: builder.sources.length };
    this.live.add(shot);
    for (const src of shot.sources) {
      src.onended = () => {
        shot.pending -= 1;
        if (shot.pending <= 0 && this.live.delete(shot)) releaseNodes(shot.nodes);
      };
    }
  }

  stopAll(): void {
    for (const shot of this.live) {
      for (const src of shot.sources) src.onended = null;
      releaseNodes(shot.nodes);
    }
    this.live.clear();
  }
}

/** Helper that creates nodes for one sound and records them for cleanup. */
export class SoundBuilder {
  readonly sources: AudioScheduledSourceNode[] = [];
  readonly nodes: AudioNode[] = [];
  readonly ctx: AudioContext;

  constructor(
    readonly shared: SharedAudio,
    readonly out: AudioNode,
  ) {
    this.ctx = shared.ctx;
  }

  gain(value: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    this.nodes.push(g);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = safeFreq(freq, this.shared.nyquist);
    f.Q.value = q;
    this.nodes.push(f);
    return f;
  }

  /** Output stage with optional stereo pan. */
  output(level: number, pan = 0): GainNode {
    const g = this.gain(clamp(Number.isFinite(level) ? level : 0, 0, 2));
    if (pan !== 0 && Number.isFinite(pan) && typeof this.ctx.createStereoPanner === 'function') {
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      this.nodes.push(p);
      g.connect(p).connect(this.out);
    } else {
      g.connect(this.out);
    }
    return g;
  }

  /** Enveloped oscillator note: attack, then exponential decay over `dur`. Optional pitch glide to `freqEnd`. */
  tone(dest: AudioNode, opts: { type: OscillatorType; freq: number; freqEnd?: number; start: number; dur: number; gain: number; attack?: number; detune?: number }): void {
    const ny = this.shared.nyquist;
    const o = this.ctx.createOscillator();
    o.type = opts.type;
    o.frequency.setValueAtTime(safeFreq(opts.freq, ny), opts.start);
    if (opts.freqEnd !== undefined) o.frequency.exponentialRampToValueAtTime(safeFreq(opts.freqEnd, ny), opts.start + opts.dur);
    if (opts.detune) o.detune.value = opts.detune;
    const env = this.ctx.createGain();
    const attack = Math.max(0.001, opts.attack ?? 0.004);
    env.gain.setValueAtTime(0, opts.start);
    const tau = Math.max(0.004, (opts.dur - attack) / 5);
    env.gain.linearRampToValueAtTime(clamp01(opts.gain), opts.start + attack);
    env.gain.setTargetAtTime(0, opts.start + attack, tau);
    o.connect(env).connect(dest);
    o.start(opts.start);
    // Stop once the envelope is ~e^-8 down: no click.
    o.stop(opts.start + attack + tau * 8);
    this.sources.push(o);
    this.nodes.push(o, env);
  }

  /** Enveloped noise burst through a filter. */
  noise(dest: AudioNode, opts: { type: BiquadFilterType; freq: number; q?: number; start: number; dur: number; gain: number; attack?: number }): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.shared.noise;
    const f = this.filter(opts.type, opts.freq, opts.q ?? 0.7);
    const env = this.ctx.createGain();
    const attack = Math.max(0.001, opts.attack ?? 0.002);
    env.gain.setValueAtTime(0, opts.start);
    const tau = Math.max(0.004, (opts.dur - attack) / 5);
    env.gain.linearRampToValueAtTime(clamp01(opts.gain), opts.start + attack);
    env.gain.setTargetAtTime(0, opts.start + attack, tau);
    src.connect(f).connect(env).connect(dest);
    const end = attack + tau * 8;
    const offset = Math.random() * Math.max(0, this.shared.noise.duration - end - 0.05);
    src.start(opts.start, offset);
    src.stop(opts.start + end);
    this.sources.push(src);
    this.nodes.push(src, env);
  }
}

// ───────────────────────────── session sounds ─────────────────────────────

/** One start light switched on: short two-partial beep. */
export function startBeep(pool: OneShotPool, now: number): void {
  pool.play((b) => {
    const out = b.output(0.32);
    b.tone(out, { type: 'sine', freq: 784, start: now, dur: 0.17, gain: 0.9 });
    b.tone(out, { type: 'triangle', freq: 1568, start: now, dur: 0.12, gain: 0.25 });
  });
}

/** Lights out: brighter, longer upward cue with a low swell. */
export function lightsOutCue(pool: OneShotPool, now: number): void {
  pool.play((b) => {
    const out = b.output(0.34);
    b.tone(out, { type: 'triangle', freq: 1046.5, freqEnd: 1396.9, start: now, dur: 0.5, gain: 0.8 });
    b.tone(out, { type: 'sine', freq: 1568, freqEnd: 2093, start: now + 0.02, dur: 0.45, gain: 0.35 });
    b.tone(out, { type: 'sine', freq: 98, freqEnd: 196, start: now, dur: 0.6, gain: 0.6, attack: 0.03 });
  });
}

/** Original chequered-flag motif: rising major arpeggio landing on a held chord. */
export function chequeredMotif(pool: OneShotPool, now: number): void {
  const notes: readonly [number, number, number][] = [
    // [freq, start offset, duration]
    [587.33, 0, 0.12],
    [739.99, 0.12, 0.12],
    [880, 0.24, 0.12],
    [1174.66, 0.36, 0.2],
    [987.77, 0.58, 0.12],
    [1174.66, 0.72, 0.6],
  ];
  pool.play((b) => {
    const out = b.output(0.3);
    const lp = b.filter('lowpass', 5200, 0.7);
    lp.connect(out);
    for (const [freq, at, dur] of notes) {
      b.tone(lp, { type: 'square', freq, start: now + at, dur, gain: 0.35 });
      b.tone(lp, { type: 'triangle', freq: freq * 2, start: now + at, dur, gain: 0.25, detune: 6 });
    }
    // final chord swell
    for (const freq of [587.33, 739.99, 880]) b.tone(lp, { type: 'triangle', freq, start: now + 0.72, dur: 0.9, gain: 0.3, attack: 0.05 });
  });
}

/** Personal-best lap chime; `overall` (fastest of the session) adds a third, higher note. */
export function pbChime(pool: OneShotPool, now: number, overall: boolean): void {
  pool.play((b) => {
    const out = b.output(0.3);
    b.tone(out, { type: 'sine', freq: 1318.5, start: now, dur: 0.5, gain: 0.8 });
    b.tone(out, { type: 'sine', freq: 1975.5, start: now + 0.11, dur: 0.6, gain: 0.7 });
    if (overall) b.tone(out, { type: 'sine', freq: 2637, start: now + 0.22, dur: 0.7, gain: 0.6 });
  });
}

/** Pit-limiter reminder beep. */
export function limiterBeep(pool: OneShotPool, now: number, interior: boolean): void {
  pool.play((b) => {
    const out = b.output(interior ? 0.16 : 0.09);
    const lp = b.filter('lowpass', 3000, 0.7);
    lp.connect(out);
    b.tone(lp, { type: 'square', freq: 1175, start: now, dur: 0.06, gain: 0.6, attack: 0.002 });
  });
}

/** Mechanical gear-change click (listener car). */
export function shiftClick(pool: OneShotPool, now: number, up: boolean, interior: boolean): void {
  pool.play((b) => {
    const out = b.output(interior ? 0.3 : 0.12);
    b.noise(out, { type: 'highpass', freq: 2600, start: now, dur: 0.025, gain: 0.7 });
    b.tone(out, { type: 'sine', freq: up ? 140 : 110, freqEnd: 55, start: now, dur: 0.06, gain: 0.8 });
  });
}

/** Collision thump: low body hit + filtered crunch, scaled by strength (0..1), attenuation and pan. */
export function collisionThump(pool: OneShotPool, now: number, strength: number, gain: number, pan: number): void {
  const s = clamp01(strength);
  const level = clamp01(gain) * (0.25 + 0.6 * s);
  if (level < 0.005) return;
  pool.play((b) => {
    const out = b.output(level, pan);
    b.tone(out, { type: 'sine', freq: 90, freqEnd: 34, start: now, dur: 0.28, gain: 0.9 });
    b.noise(out, { type: 'lowpass', freq: 380 + 900 * s, start: now, dur: 0.2 + 0.15 * s, gain: 0.8 });
    if (s > 0.5) b.noise(out, { type: 'bandpass', freq: 3200, q: 1.5, start: now + 0.01, dur: 0.12, gain: 0.35 * s });
  });
}

/** Pneumatic wheel-gun rattles (four corners) during a pit stop. */
export function wheelGun(pool: OneShotPool, now: number): void {
  pool.play((b) => {
    const out = b.output(0.22);
    const bp = b.filter('bandpass', 2100, 2.2);
    bp.connect(out);
    for (let i = 0; i < 4; i++) {
      const at = now + 0.15 + i * 0.32;
      b.tone(bp, { type: 'sawtooth', freq: 62, start: at, dur: 0.24, gain: 0.9, attack: 0.003 });
      b.noise(out, { type: 'highpass', freq: 4000, start: at, dur: 0.18, gain: 0.25 });
    }
  });
}

// ───────────────────────────── race-control cues ─────────────────────────────

export type RaceControlCue = 'alert' | 'urgent' | 'clear';

/** Modes that count as a neutralisation (a return to green after one plays the "clear" chime). */
const NEUTRAL_MODES: readonly string[] = ['sc', 'scEnding', 'vsc', 'vscEnding', 'red'];

/** Which cue a race-control mode change gets (null = silent). */
export function raceControlCueFor(mode: string, previous: string): RaceControlCue | null {
  if (mode === previous) return null;
  if (mode === 'sc' || mode === 'vsc') return 'alert';
  if (mode === 'red') return 'urgent';
  if (mode === 'green' && NEUTRAL_MODES.includes(previous)) return 'clear';
  return null;
}

/** SC / VSC alert: two alternating tones; red flag: urgent triple tone; back to green: rising chime. */
export function raceControlCue(pool: OneShotPool, now: number, cue: RaceControlCue): void {
  pool.play((b) => {
    const out = b.output(0.3);
    if (cue === 'alert') {
      b.tone(out, { type: 'triangle', freq: 740, start: now, dur: 0.22, gain: 0.8 });
      b.tone(out, { type: 'triangle', freq: 587.33, start: now + 0.26, dur: 0.3, gain: 0.8 });
    } else if (cue === 'urgent') {
      for (let i = 0; i < 3; i++) {
        b.tone(out, { type: 'square', freq: 880, start: now + i * 0.17, dur: 0.12, gain: 0.45, attack: 0.003 });
        b.tone(out, { type: 'sine', freq: 1760, start: now + i * 0.17, dur: 0.1, gain: 0.25, attack: 0.003 });
      }
    } else {
      b.tone(out, { type: 'sine', freq: 659.25, start: now, dur: 0.2, gain: 0.7 });
      b.tone(out, { type: 'sine', freq: 830.6, start: now + 0.11, dur: 0.22, gain: 0.7 });
      b.tone(out, { type: 'sine', freq: 987.77, start: now + 0.22, dur: 0.45, gain: 0.7 });
    }
  });
}

/** Blue flag: soft double tick. */
export function blueFlagTick(pool: OneShotPool, now: number): void {
  pool.play((b) => {
    const out = b.output(0.2);
    b.tone(out, { type: 'sine', freq: 1568, start: now, dur: 0.05, gain: 0.6, attack: 0.002 });
    b.tone(out, { type: 'sine', freq: 1568, start: now + 0.12, dur: 0.05, gain: 0.6, attack: 0.002 });
  });
}

/** Control warning (give a position back, too fast under VSC...): short low buzz. */
export function controlBuzz(pool: OneShotPool, now: number): void {
  pool.play((b) => {
    const out = b.output(0.26);
    const lp = b.filter('lowpass', 900, 0.7);
    lp.connect(out);
    b.tone(lp, { type: 'sawtooth', freq: 110, start: now, dur: 0.26, gain: 0.7, attack: 0.005 });
    b.tone(lp, { type: 'square', freq: 116, start: now, dur: 0.26, gain: 0.3, attack: 0.005 });
  });
}

// ───────────────────────────── UI sounds ─────────────────────────────

export type UiSound = 'move' | 'confirm' | 'back' | 'error';

export function uiSound(pool: OneShotPool, now: number, kind: UiSound): void {
  pool.play((b) => {
    const out = b.output(0.35);
    switch (kind) {
      case 'move':
        b.tone(out, { type: 'sine', freq: 1250, freqEnd: 1050, start: now, dur: 0.045, gain: 0.5, attack: 0.002 });
        break;
      case 'confirm':
        b.tone(out, { type: 'triangle', freq: 880, start: now, dur: 0.08, gain: 0.6 });
        b.tone(out, { type: 'triangle', freq: 1318.5, start: now + 0.07, dur: 0.14, gain: 0.6 });
        break;
      case 'back':
        b.tone(out, { type: 'triangle', freq: 1046.5, start: now, dur: 0.08, gain: 0.55 });
        b.tone(out, { type: 'triangle', freq: 698.5, start: now + 0.07, dur: 0.12, gain: 0.55 });
        break;
      case 'error': {
        const lp = b.filter('lowpass', 1400, 0.7);
        lp.connect(out);
        b.tone(lp, { type: 'square', freq: 185, start: now, dur: 0.09, gain: 0.55 });
        b.tone(lp, { type: 'square', freq: 175, start: now + 0.12, dur: 0.12, gain: 0.55 });
        break;
      }
    }
  });
}
