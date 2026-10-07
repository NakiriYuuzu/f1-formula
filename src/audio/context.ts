/**
 * WebAudio plumbing: guarded AudioContext creation, shared noise buffer + waveshaper curve, and safe
 * AudioParam helpers (non-finite values are dropped, values clamped to nominal ranges to avoid warnings).
 */
import { clamp } from '../core/math';

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** Creates an AudioContext, or null when WebAudio is unavailable (headless, very old browsers, blocked). */
export function createAudioContext(): AudioContext | null {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    return new Ctor({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
}

/** Resources shared by every voice / one-shot of one context (allocated once). */
export interface SharedAudio {
  ctx: AudioContext;
  /** 2 s of mono white noise, seamless when looped */
  noise: AudioBuffer;
  /** soft-clip transfer curve for engine saturation */
  shaperCurve: Float32Array<ArrayBuffer>;
  nyquist: number;
}

const NOISE_SECONDS = 2;
const SHAPER_SAMPLES = 2048;

function createNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // xorshift32: deterministic and cheap.
  let x = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = ((x >>> 0) / 4294967296) * 2 - 1;
  }
  return buffer;
}

function createShaperCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(SHAPER_SAMPLES);
  const k = 2.4;
  const norm = Math.tanh(k);
  for (let i = 0; i < SHAPER_SAMPLES; i++) {
    const x = (i / (SHAPER_SAMPLES - 1)) * 2 - 1;
    // Slightly asymmetric soft clip: adds even harmonics (a rougher, combustion-like edge).
    curve[i] = Math.tanh(k * (x + 0.12 * x * x)) / norm;
  }
  return curve;
}

export function createSharedAudio(ctx: AudioContext): SharedAudio {
  return { ctx, noise: createNoiseBuffer(ctx), shaperCurve: createShaperCurve(), nyquist: ctx.sampleRate / 2 };
}

/** Glide an AudioParam toward `value` (time constant `tau` s). Ignores non-finite values. */
export function glide(param: AudioParam, value: number, time: number, tau: number): void {
  if (!Number.isFinite(value) || !Number.isFinite(time)) return;
  param.setTargetAtTime(clamp(value, param.minValue, param.maxValue), Math.max(0, time), Math.max(0.001, tau));
}

/** Jump an AudioParam to `value` now, discarding pending automation. */
export function snap(param: AudioParam, value: number, time: number): void {
  if (!Number.isFinite(value) || !Number.isFinite(time)) return;
  const t = Math.max(0, time);
  param.cancelScheduledValues(t);
  param.setValueAtTime(clamp(value, param.minValue, param.maxValue), t);
}

/** Clamp a filter/oscillator frequency to a safe audible range below Nyquist. */
export function safeFreq(hz: number, nyquist: number, min = 10): number {
  if (!Number.isFinite(hz)) return min;
  return clamp(hz, min, nyquist * 0.95);
}

/** Looping noise source starting at a random offset (decorrelates sources sharing the buffer). */
export function startNoise(shared: SharedAudio): AudioBufferSourceNode {
  const src = shared.ctx.createBufferSource();
  src.buffer = shared.noise;
  src.loop = true;
  src.start(0, Math.random() * Math.max(0, shared.noise.duration - 0.01));
  return src;
}

/** Stop (if started) and disconnect a set of nodes; never throws. */
export function releaseNodes(nodes: readonly AudioNode[]): void {
  for (const node of nodes) {
    const source = node as Partial<Pick<AudioScheduledSourceNode, 'stop'>>;
    if (typeof source.stop === 'function') {
      try {
        source.stop();
      } catch {
        // never started or already stopped
      }
    }
    try {
      node.disconnect();
    } catch {
      // already disconnected
    }
  }
}
