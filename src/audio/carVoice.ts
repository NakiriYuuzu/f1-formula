/**
 * One synthesized V6-hybrid engine voice (+ that car's tyre squeal and lift-off pops).
 * Firing frequency f0 = rpm/60*3. Sawtooth fundamental + half-order square + detuned 2nd harmonic + crank
 * sub, soft-clipped by a waveshaper (drive grows with throttle), low-shelf body (interior), throttle-dependent
 * lowpass, sub-harmonic amplitude "burble" off-throttle, rev-limiter bounce LFO and a faint MGU whine.
 * Voices are pooled and re-assigned between cars with gain glides (no clicks, no per-frame allocation).
 */
import { clamp, clamp01, lerp } from '../core/math';
import { glide, releaseNodes, safeFreq, snap, startNoise, type SharedAudio } from './context';

/** Per-frame parameters for a voice (all already sanitised by the caller where noted). */
export interface VoiceParams {
  rpm: number;
  /** 0..1 between idle and max rpm */
  rpmN: number;
  throttle: number;
  /** overall attenuation 0..1 (distance, listener floor) */
  gain: number;
  /** -1..1 */
  pan: number;
  /** pitch multiplier */
  doppler: number;
  /** on-board listener sound (cockpit / nose / T-cam) */
  interior: boolean;
  /** air-absorption lowpass ceiling (Hz) */
  cutoffCap: number;
  /** bouncing on the rev limiter */
  revLimiter: boolean;
  /** tyre squeal 0..1 */
  squeal: number;
  /** 0..1 share of squeal coming from brake lock-up (lower, rougher pitch) */
  lockupShare: number;
}

/** Time for a released voice to become silent and reusable (s). */
export const VOICE_RELEASE_TIME = 0.3;
const FADE_TAU = 0.05;
const PARAM_TAU = 0.025;
const VOICE_TRIM = 0.5;
const SQUEAL_TRIM = 0.3;
const LIMITER_LFO_HZ = 16;
const LIMITER_DETUNE_CENTS = -70;
const POP_COOLDOWN = 0.9;

export class CarVoice {
  /** car currently voiced (null = free) */
  carId: number | null = null;
  private releasing = false;
  private releaseAt = 0;
  private snapNext = false;
  private popReadyAt = 0;

  private readonly shared: SharedAudio;
  private readonly oscFire: OscillatorNode;
  private readonly oscSub: OscillatorNode;
  private readonly oscHarm: OscillatorNode;
  private readonly oscCrank: OscillatorNode;
  private readonly oscWhine: OscillatorNode;
  private readonly lfoLimiter: OscillatorNode;
  private readonly lfoBurble: OscillatorNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly gSub: GainNode;
  private readonly gHarm: GainNode;
  private readonly gCrank: GainNode;
  private readonly gWhine: GainNode;
  private readonly drive: GainNode;
  private readonly shelf: BiquadFilterNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly am: GainNode;
  private readonly burbleDepth: GainNode;
  private readonly limiterDetune: GainNode;
  private readonly limiterAm: GainNode;
  private readonly shiftGain: GainNode;
  private readonly level: GainNode;
  private readonly popGain: GainNode;
  private readonly squealFilter: BiquadFilterNode;
  private readonly squealGain: GainNode;
  private readonly panner: StereoPannerNode | null;
  private readonly squealPanner: StereoPannerNode | null;
  private readonly nodes: AudioNode[];

  constructor(shared: SharedAudio, engineOut: AudioNode, sfxOut: AudioNode) {
    this.shared = shared;
    const ctx = shared.ctx;
    const osc = (type: OscillatorType, freq: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      return o;
    };
    const gain = (value: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = value;
      return g;
    };
    const filter = (type: BiquadFilterType, freq: number, q: number): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const panner = (): StereoPannerNode | null => (typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null);

    this.oscFire = osc('sawtooth', 200);
    this.oscSub = osc('square', 100);
    this.oscHarm = osc('sawtooth', 400);
    this.oscHarm.detune.value = 9;
    this.oscCrank = osc('triangle', 66);
    this.oscWhine = osc('sine', 1300);
    this.lfoLimiter = osc('square', LIMITER_LFO_HZ);
    this.lfoBurble = osc('triangle', 100);
    this.noise = startNoise(shared);

    const gFire = gain(0.42);
    this.gSub = gain(0.3);
    this.gHarm = gain(0.1);
    this.gCrank = gain(0.2);
    this.gWhine = gain(0);
    this.drive = gain(1);
    const shaper = ctx.createWaveShaper();
    shaper.curve = shared.shaperCurve;
    shaper.oversample = '2x';
    this.shelf = filter('lowshelf', 170, 0.7);
    this.lowpass = filter('lowpass', 1200, 0.8);
    this.am = gain(1);
    this.burbleDepth = gain(0);
    this.limiterDetune = gain(0);
    this.limiterAm = gain(0);
    this.shiftGain = gain(1);
    this.level = gain(0);
    const popFilter = filter('bandpass', 750, 1.1);
    this.popGain = gain(0);
    this.squealFilter = filter('bandpass', 2200, 7);
    this.squealGain = gain(0);
    this.panner = panner();
    this.squealPanner = panner();

    // Engine tone chain.
    this.oscFire.connect(gFire).connect(this.drive);
    this.oscSub.connect(this.gSub).connect(this.drive);
    this.oscHarm.connect(this.gHarm).connect(this.drive);
    this.oscCrank.connect(this.gCrank).connect(this.drive);
    this.drive.connect(shaper).connect(this.shelf).connect(this.lowpass).connect(this.am).connect(this.shiftGain).connect(this.level);
    this.oscWhine.connect(this.gWhine).connect(this.level);
    // Modulation: rev-limiter bounce (pitch + amplitude) and off-throttle burble.
    this.lfoLimiter.connect(this.limiterDetune);
    for (const o of [this.oscFire, this.oscSub, this.oscHarm, this.oscCrank]) this.limiterDetune.connect(o.detune);
    this.lfoLimiter.connect(this.limiterAm).connect(this.am.gain);
    this.lfoBurble.connect(this.burbleDepth).connect(this.am.gain);
    // Lift-off pops share the voice level/pan.
    this.noise.connect(popFilter).connect(this.popGain).connect(this.level);
    if (this.panner) this.level.connect(this.panner).connect(engineOut);
    else this.level.connect(engineOut);
    // Squeal goes to the SFX bus.
    this.noise.connect(this.squealFilter).connect(this.squealGain);
    if (this.squealPanner) this.squealGain.connect(this.squealPanner).connect(sfxOut);
    else this.squealGain.connect(sfxOut);

    const sources = [this.oscFire, this.oscSub, this.oscHarm, this.oscCrank, this.oscWhine, this.lfoLimiter, this.lfoBurble];
    for (const s of sources) s.start();

    this.nodes = [
      ...sources,
      this.noise,
      gFire,
      this.gSub,
      this.gHarm,
      this.gCrank,
      this.gWhine,
      this.drive,
      shaper,
      this.shelf,
      this.lowpass,
      this.am,
      this.burbleDepth,
      this.limiterDetune,
      this.limiterAm,
      this.shiftGain,
      this.level,
      popFilter,
      this.popGain,
      this.squealFilter,
      this.squealGain,
    ];
    if (this.panner) this.nodes.push(this.panner);
    if (this.squealPanner) this.nodes.push(this.squealPanner);
  }

  /** Bind to a car; the next update jumps pitch instantly (voice is silent) and fades in. */
  assign(carId: number): void {
    this.carId = carId;
    this.releasing = false;
    this.snapNext = true;
  }

  /** Keep the current car (cancels a pending release). */
  retain(): void {
    this.releasing = false;
  }

  isReleasing(): boolean {
    return this.releasing;
  }

  /** Fade out; the voice becomes free once silent (see `freeIfSilent`). */
  release(now: number): void {
    if (this.carId === null || this.releasing) return;
    this.releasing = true;
    this.releaseAt = now;
    glide(this.level.gain, 0, now, FADE_TAU);
    glide(this.squealGain.gain, 0, now, FADE_TAU);
    glide(this.gWhine.gain, 0, now, FADE_TAU);
  }

  /** Frees a released voice once its fade has finished. */
  freeIfSilent(now: number): void {
    if (this.releasing && now - this.releaseAt >= VOICE_RELEASE_TIME) {
      this.releasing = false;
      this.carId = null;
    }
  }

  update(p: VoiceParams, now: number): void {
    if (this.carId === null || this.releasing) return;
    const ny = this.shared.nyquist;
    const t = clamp01(p.throttle);
    const r = clamp01(p.rpmN);
    const doppler = Number.isFinite(p.doppler) ? clamp(p.doppler, 0.5, 2) : 1;
    const f0 = safeFreq((Math.max(0, p.rpm) / 20) * doppler, ny, 20);
    const set = this.snapNext
      ? (param: AudioParam, v: number): void => snap(param, v, now)
      : (param: AudioParam, v: number): void => glide(param, v, now, PARAM_TAU);
    this.snapNext = false;

    set(this.oscFire.frequency, f0);
    set(this.oscSub.frequency, safeFreq(f0 * 0.5, ny));
    set(this.oscHarm.frequency, safeFreq(f0 * 2, ny));
    set(this.oscCrank.frequency, safeFreq(f0 / 3, ny));
    set(this.oscWhine.frequency, safeFreq(f0 * 6.5, ny));
    set(this.lfoBurble.frequency, safeFreq(f0 * 0.5, ny, 1));

    const interior = p.interior;
    glide(this.gSub.gain, 0.3 - 0.08 * t + (interior ? 0.1 : 0), now, PARAM_TAU);
    glide(this.gHarm.gain, 0.07 + 0.16 * t * (0.5 + 0.5 * r), now, PARAM_TAU);
    glide(this.gCrank.gain, interior ? 0.45 : 0.16, now, 0.1);
    glide(this.drive.gain, 0.7 + 1.5 * t + 0.4 * r, now, PARAM_TAU);
    glide(this.shelf.gain, interior ? 9 : 2, now, 0.1);

    const cap = Number.isFinite(p.cutoffCap) ? p.cutoffCap : ny;
    const cutoff = (500 + 900 * r + t * (1600 + 4600 * r)) * (interior ? 0.8 : 1);
    glide(this.lowpass.frequency, safeFreq(Math.min(cutoff, cap), ny, 80), now, PARAM_TAU);
    glide(this.lowpass.Q, 0.8 + 2.2 * t * r, now, PARAM_TAU);

    const burble = lerp(0.3, 0.07, t) * (0.6 + 0.4 * r);
    const limiterAm = p.revLimiter ? 0.22 : 0;
    glide(this.burbleDepth.gain, burble, now, 0.05);
    glide(this.limiterAm.gain, limiterAm, now, 0.02);
    glide(this.am.gain, 1 - burble - limiterAm, now, 0.05);
    glide(this.limiterDetune.gain, p.revLimiter ? LIMITER_DETUNE_CENTS : 0, now, 0.02);

    const att = Number.isFinite(p.gain) ? clamp01(p.gain) : 0;
    const loudness = (0.3 + 0.55 * r) * (0.5 + 0.5 * t) * (interior ? 1.15 : 1);
    glide(this.level.gain, loudness * att * VOICE_TRIM, now, FADE_TAU);
    glide(this.gWhine.gain, (0.012 + 0.02 * t) * r * (interior ? 0.6 : 1), now, 0.05);

    const pan = interior || !Number.isFinite(p.pan) ? 0 : clamp(p.pan, -1, 1);
    if (this.panner) glide(this.panner.pan, pan, now, 0.04);
    if (this.squealPanner) glide(this.squealPanner.pan, pan, now, 0.04);

    const squeal = Number.isFinite(p.squeal) ? clamp01(p.squeal) : 0;
    const lock = Number.isFinite(p.lockupShare) ? clamp01(p.lockupShare) : 0;
    glide(this.squealFilter.frequency, safeFreq(lerp(2300, 1250, lock) * doppler, ny, 200), now, 0.05);
    glide(this.squealGain.gain, squeal * att * SQUEAL_TRIM, now, 0.04);
  }

  /** Ignition-cut dip on upshift, short blip on downshift. */
  shift(up: boolean, now: number): void {
    if (this.carId === null || this.releasing) return;
    const g = this.shiftGain.gain;
    snap(g, 1, now);
    g.setTargetAtTime(up ? 0.3 : 0.65, now, 0.006);
    g.setTargetAtTime(1, now + (up ? 0.045 : 0.03), 0.03);
  }

  /** A short burst of exhaust pops after lifting at high rpm (rate-limited). */
  pops(intensity: number, now: number): void {
    if (this.carId === null || this.releasing || now < this.popReadyAt) return;
    const amp = Number.isFinite(intensity) ? clamp01(intensity) : 0;
    if (amp <= 0.01) return;
    this.popReadyAt = now + POP_COOLDOWN;
    const g = this.popGain.gain;
    snap(g, 0, now);
    let t = now + 0.03;
    const count = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) {
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(amp * (0.35 + 0.65 * Math.random()) * 1.6, t + 0.003);
      g.setTargetAtTime(0, t + 0.003, 0.012);
      t += 0.05 + Math.random() * 0.11;
    }
  }

  dispose(): void {
    releaseNodes(this.nodes);
    this.carId = null;
  }
}
