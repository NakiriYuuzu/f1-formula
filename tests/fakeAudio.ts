/**
 * Strict fake WebAudio shared by the audio tests: invalid parameter values throw, nominal-range violations and
 * node allocation are tracked, `fireEnded` plays the audio thread's `ended` events.
 */
export const SAMPLE_RATE = 48000;
const NYQUIST = SAMPLE_RATE / 2;

interface Stats {
  created: number;
  live: Set<FakeNode>;
  rangeWarnings: string[];
}
export let stats: Stats = { created: 0, live: new Set(), rangeWarnings: [] };

/** Fresh counters and scheduled-source bookkeeping (call at the start of a test that inspects them). */
export function resetFakeAudio(): void {
  stats = { created: 0, live: new Set(), rangeWarnings: [] };
  scheduledSources.clear();
}

export class FakeParam {
  /** last setTargetAtTime() value (smooth glides never change `value` in the fake) */
  lastTarget = Number.NaN;
  constructor(
    public value: number,
    readonly minValue: number,
    readonly maxValue: number,
    private readonly name: string,
  ) {}
  private check(v: number, t: number): void {
    if (!Number.isFinite(v) || !Number.isFinite(t)) throw new TypeError(`${this.name}: non-finite ${v} @ ${t}`);
    if (t < 0) throw new RangeError(`${this.name}: negative time`);
    if (v < this.minValue || v > this.maxValue) stats.rangeWarnings.push(`${this.name}=${v}`);
  }
  setValueAtTime(v: number, t: number): this {
    this.check(v, t);
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    if (v === 0) throw new RangeError(`${this.name}: exponential ramp to 0`);
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number): this {
    this.check(v, t);
    this.lastTarget = v;
    if (!Number.isFinite(tau) || tau < 0) throw new RangeError(`${this.name}: bad time constant`);
    return this;
  }
  cancelScheduledValues(t: number): this {
    if (!Number.isFinite(t) || t < 0) throw new RangeError(`${this.name}: bad cancel time`);
    return this;
  }
}

export class FakeNode {
  readonly outputs = new Set<FakeNode | FakeParam>();
  constructor() {
    stats.created += 1;
    stats.live.add(this);
  }
  connect<T extends FakeNode | FakeParam>(dest: T): T extends FakeNode ? T : undefined {
    if (!(dest instanceof FakeNode) && !(dest instanceof FakeParam)) throw new TypeError('bad connect target');
    this.outputs.add(dest);
    return (dest instanceof FakeNode ? dest : undefined) as T extends FakeNode ? T : undefined;
  }
  disconnect(): void {
    this.outputs.clear();
    stats.live.delete(this);
  }
}

export const scheduledSources = new Set<FakeSource>();

export class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  stopAt = Number.POSITIVE_INFINITY;
  start(when = 0): void {
    if (this.started) throw new Error('start twice');
    if (!Number.isFinite(when)) throw new TypeError('bad start');
    this.started = true;
  }
  stop(when = 0): void {
    if (!this.started) throw new Error('stop before start');
    if (!Number.isFinite(when)) throw new TypeError('bad stop');
    this.stopped = true;
    this.stopAt = Math.min(this.stopAt, when);
    scheduledSources.add(this);
  }
}

/** Fire `ended` for every source whose stop time has passed (what the audio thread would do). */
export function fireEnded(now: number): void {
  for (const src of scheduledSources) {
    if (src.stopAt > now) continue;
    scheduledSources.delete(src);
    src.onended?.();
  }
}

export class FakeOscillator extends FakeSource {
  type = 'sine';
  frequency = new FakeParam(440, -NYQUIST, NYQUIST, 'osc.frequency');
  detune = new FakeParam(0, -153600, 153600, 'osc.detune');
}
export class FakeBufferSource extends FakeSource {
  buffer: unknown = null;
  loop = false;
  override start(when = 0, offset = 0): void {
    if (!Number.isFinite(offset) || offset < 0) throw new RangeError('bad offset');
    super.start(when);
  }
}
export class FakeGain extends FakeNode {
  gain = new FakeParam(1, -3.4e38, 3.4e38, 'gain');
}
export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350, 0, NYQUIST, 'biquad.frequency');
  Q = new FakeParam(1, -3.4e38, 3.4e38, 'biquad.Q');
  gain = new FakeParam(0, -1541, 1541, 'biquad.gain');
}
export class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample = 'none';
}
export class FakePanner extends FakeNode {
  pan = new FakeParam(0, -1, 1, 'pan');
}
export class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24, -100, 0, 'threshold');
  knee = new FakeParam(30, 0, 40, 'knee');
  ratio = new FakeParam(12, 1, 20, 'ratio');
  attack = new FakeParam(0.003, 0, 1, 'attack');
  release = new FakeParam(0.25, 0, 1, 'release');
}

export class FakeDelay extends FakeNode {
  delayTime = new FakeParam(0, 0, 180, 'delayTime');
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  sampleRate = SAMPLE_RATE;
  state: 'running' | 'suspended' | 'closed' = 'suspended';
  destination = new FakeNode();
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator();
  }
  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad();
  }
  createWaveShaper(): FakeShaper {
    return new FakeShaper();
  }
  createDelay(): FakeDelay {
    return new FakeDelay();
  }
  createStereoPanner(): FakePanner {
    return new FakePanner();
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource();
  }
  createBuffer(channels: number, length: number, sampleRate: number): { duration: number; getChannelData(i: number): Float32Array } {
    if (channels < 1 || length < 1) throw new RangeError('bad buffer');
    const data = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => data };
  }
}
