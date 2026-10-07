/**
 * Background-music playback: renders the original score (musicScore.ts) with short-lived WebAudio voices scheduled
 * ~180 ms ahead, or loops a decoded file (user-selected, or the optional bundled track). Owns no gain policy: the
 * AudioEngine sets the music bus level and tells the player whether it should sound (`setActive`).
 *
 * original:         kick/snare/hats/bass/stab/pad/lead/arp voices → mix ┐
 *                   lead + arp → echo send → delay loop ──────────────┴→ out (music bus)
 * custom / bundled: looped AudioBufferSource → own fade gain → out
 */
import type { Settings } from '../core/types';
import { releaseNodes, type SharedAudio } from './context';
import { loadBundledMusic } from './bundledMusic';
import { MusicSequencer, STEP_SECONDS, type MusicEvent } from './musicScore';
import { loadMusicFile, reportMusicError, subscribeMusic, type StoredMusic } from './musicStore';

export type MusicSource = Settings['musicSource'];
type FileSource = 'custom' | 'bundled';

const isFileSource = (s: MusicSource): s is FileSource => s === 'custom' || s === 'bundled';

const LOOKAHEAD = 0.18;
const TICK_MS = 50;
const START_DELAY = 0.06;
/** voices keep ringing this long after the player is deactivated (the bus fade has hidden them by then) */
const STOP_DELAY = 1;
const MAX_VOICES = 40;
/** essential voices (drums, bass, harmony, melody) may exceed MAX_VOICES by this much; hats / pad / arp may not */
const ESSENTIAL_HEADROOM = 16;
const ORIGINAL_LEVEL = 0.5;
const CUSTOM_FADE = 0.3;
/** a voice whose `ended` never arrived is reclaimed this long after its scheduled end */
const SWEEP_GRACE = 0.5;
const SILENT = 0.0001;

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

interface Voice {
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  end: number;
}

interface CustomPlayback {
  src: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
  offset: number;
}

export interface MusicPlayerOptions {
  /** stored-file loader (tests inject a fake) */
  load?: () => Promise<StoredMusic | null>;
  /** bundled-track loader (tests inject a fake) */
  loadBundled?: () => Promise<StoredMusic | null>;
}

/** Scene policy: where music plays and how loud relative to the music level. */
export function musicSceneFactor(scene: string, inRace: boolean): number {
  if (scene === 'session' || scene === 'replay') return inRace ? 0.35 : 0;
  return 1;
}

export class MusicPlayer {
  private readonly ctx: AudioContext;
  private readonly mix: GainNode;
  private readonly send: GainNode;
  private readonly fixed: AudioNode[] = [];
  private readonly voices = new Set<Voice>();
  private readonly sequencer = new MusicSequencer();
  private readonly load: () => Promise<StoredMusic | null>;
  private readonly loadBundled: () => Promise<StoredMusic | null>;
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private source: MusicSource = 'original';
  private active = false;
  private disposed = false;
  /** which file customBuffer / customState / customOffset belong to */
  private fileSource: FileSource = 'custom';
  private customBuffer: AudioBuffer | null = null;
  private customState: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';
  private custom: CustomPlayback | null = null;
  private customOffset = 0;
  private loadToken = 0;

  constructor(
    private readonly shared: SharedAudio,
    private readonly out: AudioNode,
    options: MusicPlayerOptions = {},
  ) {
    const ctx = shared.ctx;
    this.ctx = ctx;
    this.load = options.load ?? loadMusicFile;
    this.loadBundled = options.loadBundled ?? loadBundledMusic;
    const gain = (value: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = value;
      return g;
    };
    this.mix = gain(ORIGINAL_LEVEL);
    this.mix.connect(out);
    // echo: dotted-eighth delay with a darkening feedback loop
    this.send = gain(1);
    const delay = ctx.createDelay(1);
    delay.delayTime.value = STEP_SECONDS * 3;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2800;
    const feedback = gain(0.32);
    this.send.connect(delay);
    delay.connect(tone);
    tone.connect(feedback);
    feedback.connect(delay);
    tone.connect(this.mix);
    this.fixed.push(this.mix, this.send, delay, tone, feedback);
    this.unsubscribe = subscribeMusic((kind) => {
      if (kind === 'file') this.onFileChanged();
    });
  }

  setSource(source: MusicSource): void {
    if (this.source === source) return;
    this.source = source;
    this.sync();
  }

  /** Whether music should currently sound (false: tab hidden, silent scene, volume 0). */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.sync();
  }

  voiceCount(): number {
    return this.voices.size;
  }

  /** Which engine is effectively producing sound for the current source / load state. */
  mode(): 'original' | FileSource | 'none' {
    if (this.source === 'off') return 'none';
    if (isFileSource(this.source)) {
      if (this.fileSource !== this.source) return 'none';
      if (this.customState === 'ready') return this.source;
      if (this.customState === 'idle' || this.customState === 'loading') return 'none';
    }
    return 'original';
  }

  /** Schedule the notes due inside the look-ahead window (called by the timer; public for tests). */
  tick(): void {
    if (this.timer === null || this.disposed) return;
    const ctx = this.ctx;
    if (ctx.state === 'closed') return;
    const now = ctx.currentTime;
    this.sweep(now);
    this.sequencer.advance(now, LOOKAHEAD, (e, t) => this.play(e, t));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadToken += 1;
    this.unsubscribe();
    this.stopTimer();
    for (const v of [...this.voices]) this.reclaim(v);
    if (this.custom) releaseNodes([this.custom.src, this.custom.gain]);
    this.custom = null;
    releaseNodes(this.fixed);
  }

  // ───────────────────────────── source management ─────────────────────────────

  private sync(): void {
    if (this.disposed) return;
    if (isFileSource(this.source)) {
      if (this.fileSource !== this.source) this.resetFile(this.source);
      if (this.customState === 'idle') void this.loadCustom();
    }
    const mode = this.mode();
    if (this.active && mode === 'original') this.startTimer();
    else this.stopTimer();
    if (this.active && (mode === 'custom' || mode === 'bundled')) this.startCustom();
    else this.stopCustom();
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.sequencer.start(this.ctx.currentTime + START_DELAY);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    const stopAt = this.ctx.currentTime + STOP_DELAY;
    for (const v of this.voices) {
      for (const src of v.sources) {
        try {
          src.stop(stopAt);
        } catch {
          // already stopped
        }
      }
    }
  }

  /** Forget the decoded file (another file source, or the stored file changed). */
  private resetFile(source: FileSource): void {
    this.loadToken += 1;
    this.stopCustom();
    this.customBuffer = null;
    this.customOffset = 0;
    this.customState = 'idle';
    this.fileSource = source;
  }

  private onFileChanged(): void {
    if (this.fileSource !== 'custom') return;
    this.resetFile('custom');
    this.sync();
  }

  private async loadCustom(): Promise<void> {
    const token = ++this.loadToken;
    const bundled = this.fileSource === 'bundled';
    this.customState = 'loading';
    let name = '';
    try {
      const stored = await (bundled ? this.loadBundled() : this.load());
      if (token !== this.loadToken) return;
      if (!stored) {
        // no user file / no bundled track installed (the default source): play the original track quietly
        this.customState = 'unavailable';
        this.sync();
        return;
      }
      name = stored.name;
      if (typeof this.ctx.decodeAudioData !== 'function') throw new Error('decode');
      // decodeAudioData detaches the buffer it is given: decode a copy
      const buffer = await this.ctx.decodeAudioData(stored.data.slice(0));
      if (token !== this.loadToken) return;
      this.customBuffer = buffer;
      this.customState = 'ready';
      reportMusicError(null);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.customState = 'unavailable';
      reportMusicError(
        name
          ? `無法解碼「${name}」（可能是不支援的格式或檔案損毀），已改播原創音樂`
          : `${err instanceof Error ? err.message : '無法讀取音樂檔'}，已改播原創音樂`,
      );
    }
    this.sync();
  }

  private startCustom(): void {
    const buffer = this.customBuffer;
    if (this.custom || !buffer || !(buffer.duration > 0)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + CUSTOM_FADE);
    src.connect(gain).connect(this.out);
    const offset = this.customOffset % buffer.duration;
    src.start(now, offset);
    this.custom = { src, gain, startedAt: now, offset };
  }

  private stopCustom(): void {
    const c = this.custom;
    if (!c) return;
    this.custom = null;
    const now = this.ctx.currentTime;
    const duration = c.src.buffer?.duration ?? 0;
    this.customOffset = duration > 0 ? (c.offset + Math.max(0, now - c.startedAt)) % duration : 0;
    c.gain.gain.cancelScheduledValues(now);
    c.gain.gain.setValueAtTime(1, now);
    c.gain.gain.linearRampToValueAtTime(0, now + CUSTOM_FADE);
    c.src.onended = () => releaseNodes([c.src, c.gain]);
    c.src.stop(now + CUSTOM_FADE + 0.05);
  }

  // ───────────────────────────── voice bookkeeping ─────────────────────────────

  private sweep(now: number): void {
    for (const v of this.voices) if (v.end + SWEEP_GRACE < now) this.reclaim(v);
  }

  private reclaim(v: Voice): void {
    if (!this.voices.delete(v)) return;
    releaseNodes([...v.sources, ...v.nodes]);
  }

  private track(nodes: AudioNode[], sources: AudioScheduledSourceNode[], end: number): void {
    const voice: Voice = { nodes, sources, end };
    this.voices.add(voice);
    const first = sources[0];
    if (first) first.onended = () => this.reclaim(voice);
  }

  // ───────────────────────────── rendering ─────────────────────────────

  private gainNode(): GainNode {
    return this.ctx.createGain();
  }

  private osc(type: OscillatorType, freq: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune !== 0) o.detune.value = detune;
    return o;
  }

  private noise(t: number): AudioBufferSourceNode {
    const n = this.ctx.createBufferSource();
    n.buffer = this.shared.noise;
    n.loop = true;
    n.start(t, (t * 0.37) % Math.max(0.01, this.shared.noise.duration - 0.3));
    return n;
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** attack → hold to `until` → linear release. */
  private gate(g: GainNode, t: number, peak: number, attack: number, until: number, release: number): void {
    const p = g.gain;
    p.setValueAtTime(SILENT, t);
    p.linearRampToValueAtTime(peak, t + attack);
    p.setValueAtTime(peak, Math.max(t + attack, until));
    p.linearRampToValueAtTime(0, Math.max(t + attack, until) + release);
  }

  /** instant attack → exponential decay. */
  private pluck(g: GainNode, t: number, peak: number, decay: number): void {
    g.gain.setValueAtTime(Math.max(SILENT, peak), t);
    g.gain.exponentialRampToValueAtTime(SILENT, t + decay);
  }

  private play(e: MusicEvent, t: number): void {
    const essential = e.voice === 'kick' || e.voice === 'snare' || e.voice === 'bass' || e.voice === 'stab' || e.voice === 'lead';
    if (this.voices.size >= (essential ? MAX_VOICES + ESSENTIAL_HEADROOM : MAX_VOICES)) return;
    const len = e.dur * STEP_SECONDS;
    switch (e.voice) {
      case 'kick': {
        const o = this.osc('sine', 160);
        o.frequency.setValueAtTime(160, t);
        o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
        const g = this.gainNode();
        g.gain.setValueAtTime(SILENT, t);
        g.gain.linearRampToValueAtTime(e.vel, t + 0.003);
        g.gain.exponentialRampToValueAtTime(SILENT, t + 0.33);
        o.connect(g).connect(this.mix);
        o.start(t);
        o.stop(t + 0.35);
        this.track([g], [o], t + 0.35);
        break;
      }
      case 'snare': {
        const n = this.noise(t);
        const hp = this.filter('highpass', 1400);
        const ng = this.gainNode();
        this.pluck(ng, t, e.vel * 0.5, 0.17);
        n.connect(hp).connect(ng).connect(this.mix);
        const body = this.osc('triangle', 200);
        body.frequency.setValueAtTime(200, t);
        body.frequency.exponentialRampToValueAtTime(120, t + 0.08);
        const bg = this.gainNode();
        this.pluck(bg, t, e.vel * 0.3, 0.1);
        body.connect(bg).connect(this.mix);
        body.start(t);
        n.stop(t + 0.19);
        body.stop(t + 0.19);
        this.track([hp, ng, bg], [n, body], t + 0.19);
        break;
      }
      case 'hat':
      case 'openHat': {
        const decay = e.voice === 'hat' ? 0.045 : 0.22;
        const n = this.noise(t);
        const hp = this.filter('highpass', 7500);
        const g = this.gainNode();
        this.pluck(g, t, e.vel * 0.3, decay);
        n.connect(hp).connect(g).connect(this.mix);
        n.stop(t + decay + 0.02);
        this.track([hp, g], [n], t + decay + 0.02);
        break;
      }
      case 'bass': {
        const root = e.notes[0] as number;
        const saw = this.osc('sawtooth', hz(root));
        const sub = this.osc('sine', hz(root));
        const lp = this.filter('lowpass', 1400, 3);
        lp.frequency.setValueAtTime(1400, t);
        lp.frequency.exponentialRampToValueAtTime(320, t + 0.15);
        const g = this.gainNode();
        this.gate(g, t, e.vel * 0.34, 0.006, t + len, 0.05);
        saw.connect(lp);
        sub.connect(lp);
        lp.connect(g).connect(this.mix);
        const end = t + len + 0.08;
        saw.start(t);
        sub.start(t);
        saw.stop(end);
        sub.stop(end);
        this.track([lp, g], [saw, sub], end);
        break;
      }
      case 'stab':
      case 'pad': {
        const pad = e.voice === 'pad';
        const lp = this.filter('lowpass', pad ? 1000 : 3500, 0.5);
        if (!pad) {
          lp.frequency.setValueAtTime(3500, t);
          lp.frequency.exponentialRampToValueAtTime(800, t + len + 0.1);
        }
        const g = this.gainNode();
        const release = pad ? 0.5 : 0.1;
        this.gate(g, t, e.vel * (pad ? 0.07 : 0.15), pad ? 0.35 : 0.004, t + len, release);
        lp.connect(g).connect(this.mix);
        const end = t + len + release + 0.02;
        const sources = e.notes.map((m, i) => {
          const o = this.osc('sawtooth', hz(m), (i - 1) * 6);
          o.connect(lp);
          o.start(t);
          o.stop(end);
          return o;
        });
        this.track([lp, g], sources, end);
        break;
      }
      case 'lead':
      case 'arp': {
        const lead = e.voice === 'lead';
        const m = e.notes[0] as number;
        const a = this.osc(lead ? 'sawtooth' : 'square', hz(m));
        const lp = this.filter('lowpass', lead ? 4200 : 2400);
        const g = this.gainNode();
        if (lead) this.gate(g, t, e.vel * 0.16, 0.012, t + len, 0.08);
        else this.pluck(g, t, e.vel * 0.12, 0.13);
        const sources: OscillatorNode[] = [a];
        a.connect(lp);
        if (lead) {
          const b = this.osc('square', hz(m), 7);
          b.connect(lp);
          sources.push(b);
        }
        lp.connect(g);
        g.connect(this.mix);
        const send = this.gainNode();
        send.gain.value = lead ? 0.3 : 0.4;
        g.connect(send).connect(this.send);
        const end = lead ? t + len + 0.1 : t + 0.16;
        for (const o of sources) {
          o.start(t);
          o.stop(end);
        }
        this.track([lp, g, send], sources, end);
        break;
      }
    }
  }
}
