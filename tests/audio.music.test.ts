/**
 * Background-music tests: the original score (pure), the look-ahead sequencer, the settings sanitizer, the music bus
 * policy in AudioEngine (scene / duck / hidden tab), voice lifetime against the strict fake WebAudio, the
 * user-file (decodeAudioData) path and the IndexedDB store's guard rails.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AudioEngine } from '../src/audio/index';
import { createSharedAudio } from '../src/audio/context';
import { bundledTrack, bundledTrackNow, loadBundledMusic, resetBundledTrackCache } from '../src/audio/bundledMusic';
import { MusicPlayer, musicSceneFactor } from '../src/audio/music';
import {
  BPM,
  eventsAtStep,
  MusicSequencer,
  SECTION_LAYOUT,
  STEP_SECONDS,
  STEPS_PER_BAR,
  TOTAL_BARS,
  TOTAL_STEPS,
  type MusicEvent,
} from '../src/audio/musicScore';
import { getMusicError, loadMusicFile, MAX_MUSIC_BYTES, reportMusicError, saveMusicFile, type StoredMusic } from '../src/audio/musicStore';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import type { Settings } from '../src/core/types';
import { sanitizeSettings } from '../src/meta/save';
import { FakeAudioContext, FakeBufferSource, FakeGain, FakeSource, fireEnded, resetFakeAudio, stats } from './fakeAudio';

const g = globalThis as Record<string, unknown>;
afterEach(() => {
  delete g.AudioContext;
  FakeAudioContext.instances = [];
  reportMusicError(null);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const withMusic = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, musicVolume: 0.5, ...patch });

describe('score', () => {
  test('tempo, length and sections', () => {
    expect(BPM).toBeGreaterThanOrEqual(128);
    expect(BPM).toBeLessThanOrEqual(140);
    expect(TOTAL_BARS).toBeGreaterThanOrEqual(32);
    expect(TOTAL_STEPS).toBe(TOTAL_BARS * STEPS_PER_BAR);
    expect(SECTION_LAYOUT.length).toBeGreaterThanOrEqual(3);
    expect(SECTION_LAYOUT.reduce((n, s) => n + s.bars, 0)).toBe(TOTAL_BARS);
    expect(new Set(SECTION_LAYOUT.map((s) => s.name)).size).toBe(SECTION_LAYOUT.length);
  });

  test('deterministic and well-formed', () => {
    const dump = (): string => JSON.stringify(Array.from({ length: TOTAL_STEPS }, (_, s) => eventsAtStep(s)));
    expect(dump()).toBe(dump());
    const voices = new Set<string>();
    for (let s = 0; s < TOTAL_STEPS; s++) {
      const k = s % STEPS_PER_BAR;
      for (const e of eventsAtStep(s)) {
        voices.add(e.voice);
        expect(e.dur).toBeGreaterThan(0);
        expect(e.vel).toBeGreaterThan(0);
        expect(e.vel).toBeLessThanOrEqual(1);
        for (const n of e.notes) {
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(28);
          expect(n).toBeLessThanOrEqual(96);
        }
        // nothing rings past its bar line, so the loop point is clean
        expect(k + e.dur).toBeLessThanOrEqual(STEPS_PER_BAR + 1e-9);
      }
    }
    expect([...voices].sort()).toEqual(['arp', 'bass', 'hat', 'kick', 'lead', 'openHat', 'pad', 'snare', 'stab']);
  });

  test('loops seamlessly: the step after the last is the first, in either direction', () => {
    expect(eventsAtStep(TOTAL_STEPS)).toEqual(eventsAtStep(0));
    expect(eventsAtStep(TOTAL_STEPS + 37)).toEqual(eventsAtStep(37));
    expect(eventsAtStep(-1)).toEqual(eventsAtStep(TOTAL_STEPS - 1));
    // a bar line starts a pad chord on both sides of the loop point
    expect(eventsAtStep(0).some((e) => e.voice === 'pad')).toBe(true);
    expect(eventsAtStep(TOTAL_STEPS - STEPS_PER_BAR).some((e) => e.voice === 'pad')).toBe(true);
  });

  test('sections differ in density: the break drops the kick, the chorus has it', () => {
    const kicks = (name: string): number => {
      const sec = SECTION_LAYOUT.find((s) => s.name === name);
      if (!sec) throw new Error(name);
      let n = 0;
      for (let s = sec.startBar * STEPS_PER_BAR; s < (sec.startBar + sec.bars) * STEPS_PER_BAR; s++) {
        n += eventsAtStep(s).filter((e) => e.voice === 'kick').length;
      }
      return n;
    };
    expect(kicks('break')).toBe(0);
    expect(kicks('chorus')).toBeGreaterThan(kicks('verse'));
  });
});

describe('sequencer', () => {
  test('emits only steps starting inside [now, now + lookahead), each exactly once and in order', () => {
    const seq = new MusicSequencer();
    seq.start(0.05);
    const times: number[] = [];
    const emit = (_e: MusicEvent, t: number): void => void times.push(t);
    let now = 0;
    for (let i = 0; i < 40; i++) {
      now += 0.05;
      const before = times.length;
      seq.advance(now, 0.18, emit);
      for (const t of times.slice(before)) {
        expect(t).toBeGreaterThanOrEqual(now - 1e-9);
        expect(t).toBeLessThan(now + 0.18 + 1e-9);
      }
    }
    for (let i = 1; i < times.length; i++) expect(times[i] as number).toBeGreaterThanOrEqual(times[i - 1] as number);
    const distinct = [...new Set(times.map((t) => t.toFixed(6)))];
    for (let i = 1; i < distinct.length; i++) expect(Number(distinct[i]) - Number(distinct[i - 1])).toBeCloseTo(STEP_SECONDS, 5);
  });

  test('after a long stall it skips ahead instead of replaying the gap, and wraps the loop', () => {
    const seq = new MusicSequencer();
    seq.start(0);
    const times: number[] = [];
    seq.advance(0.1, 0.18, (_e, t) => times.push(t));
    times.length = 0;
    seq.advance(1000, 0.18, (_e, t) => times.push(t));
    expect(times.length).toBeGreaterThan(0);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...times)).toBeLessThan(1000.18);
    const wrap = new MusicSequencer();
    wrap.start(0);
    wrap.advance(0, (TOTAL_STEPS + 2.5) * STEP_SECONDS, () => undefined);
    expect(wrap.position).toBe(3);
  });

  test('restarting resumes on the next bar line', () => {
    const seq = new MusicSequencer();
    seq.start(0);
    seq.advance(0, STEP_SECONDS * 5.5, () => undefined);
    expect(seq.position).toBe(6);
    seq.start(10);
    expect(seq.position).toBe(STEPS_PER_BAR);
  });
});

describe('settings sanitizer', () => {
  test('defaults', () => {
    expect(DEFAULT_SETTINGS.musicVolume).toBe(0.6);
    expect(DEFAULT_SETTINGS.musicSource).toBe('bundled');
    expect(DEFAULT_SETTINGS.musicInRace).toBe(false);
  });

  test('old saves without music fields load with defaults', () => {
    const old: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    delete old.musicVolume;
    delete old.musicSource;
    delete old.musicInRace;
    const s = sanitizeSettings(old);
    expect(s.musicVolume).toBe(0.6);
    expect(s.musicSource).toBe('bundled');
    expect(s.musicInRace).toBe(false);
    expect(sanitizeSettings(undefined)).toEqual(sanitizeSettings({}));
  });

  test('bounds and bad values', () => {
    expect(sanitizeSettings({ musicVolume: 5 }).musicVolume).toBe(1);
    expect(sanitizeSettings({ musicVolume: -2 }).musicVolume).toBe(0);
    expect(sanitizeSettings({ musicVolume: 0.35 }).musicVolume).toBe(0.35);
    expect(sanitizeSettings({ musicVolume: 'loud' }).musicVolume).toBe(0.6);
    expect(sanitizeSettings({ musicVolume: Number.NaN }).musicVolume).toBe(0.6);
    expect(sanitizeSettings({ musicSource: 'custom' }).musicSource).toBe('custom');
    expect(sanitizeSettings({ musicSource: 'bundled' }).musicSource).toBe('bundled');
    expect(sanitizeSettings({ musicSource: 'off' }).musicSource).toBe('off');
    expect(sanitizeSettings({ musicSource: 'original' }).musicSource).toBe('original');
    expect(sanitizeSettings({ musicSource: 'radio' }).musicSource).toBe('bundled');
    expect(sanitizeSettings({ musicSource: 3 }).musicSource).toBe('bundled');
    expect(sanitizeSettings({ musicInRace: true }).musicInRace).toBe(true);
    expect(sanitizeSettings({ musicInRace: 'yes' }).musicInRace).toBe(false);
  });
});

describe('scene policy', () => {
  test('menus play at full level, sessions and replays only when enabled and ducked', () => {
    for (const scene of ['boot', 'menu', 'loading', 'results']) expect(musicSceneFactor(scene, false)).toBe(1);
    for (const scene of ['session', 'replay']) {
      expect(musicSceneFactor(scene, false)).toBe(0);
      expect(musicSceneFactor(scene, true)).toBeCloseTo(0.35, 6);
    }
  });
});

describe('AudioEngine music bus', () => {
  const gainTargets = (): number[] => [...stats.live].filter((n): n is FakeGain => n instanceof FakeGain).map((n) => n.gain.lastTarget);

  test('without WebAudio every music method is a safe no-op', async () => {
    delete g.AudioContext;
    const audio = new AudioEngine(withMusic({}));
    audio.setMusicScene('menu');
    audio.setMusicHidden(true);
    audio.setMusicHidden(false);
    await audio.resume();
    audio.setMusicScene('session');
    audio.applySettings(withMusic({ musicSource: 'custom' }));
    expect(audio.musicLevel()).toBe(0);
    audio.dispose();
  });

  test('level follows volume², scene, ducking, pause and tab visibility', async () => {
    resetFakeAudio();
    g.AudioContext = FakeAudioContext;
    const audio = new AudioEngine(withMusic({ musicInRace: true }));
    audio.setMusicScene('menu'); // before the context exists: remembered
    expect(audio.musicLevel()).toBe(0);
    await audio.resume();
    const full = 0.25;
    expect(audio.musicLevel()).toBeCloseTo(full, 6);

    for (const scene of ['loading', 'results', 'menu']) {
      audio.setMusicScene(scene);
      expect(audio.musicLevel()).toBeCloseTo(full, 6);
    }
    audio.setMusicScene('session');
    expect(audio.musicLevel()).toBeCloseTo(full * 0.35, 6);
    expect(gainTargets().some((v) => Math.abs(v - full * 0.35) < 1e-9)).toBe(true);
    audio.setPaused(true); // the music bus sits outside the session gate
    expect(audio.musicLevel()).toBeCloseTo(full * 0.35, 6);
    audio.setPaused(false);
    audio.setMusicScene('replay');
    expect(audio.musicLevel()).toBeCloseTo(full * 0.35, 6);

    audio.applySettings(withMusic({ musicInRace: false }));
    expect(audio.musicLevel()).toBe(0);
    audio.setMusicScene('results');
    expect(audio.musicLevel()).toBeCloseTo(full, 6);

    audio.setMusicHidden(true);
    expect(audio.musicLevel()).toBe(0);
    audio.setMusicHidden(false);
    expect(audio.musicLevel()).toBeCloseTo(full, 6);
    audio.applySettings(withMusic({ musicVolume: 0 }));
    expect(audio.musicLevel()).toBe(0);
    audio.dispose();
    expect(stats.live.size).toBe(1); // destination only: music nodes are released too
  });

  test('a hidden tab stops scheduling notes; showing it again resumes', async () => {
    resetFakeAudio();
    g.AudioContext = FakeAudioContext;
    const audio = new AudioEngine(withMusic({}));
    await audio.resume();
    const ctx = FakeAudioContext.instances[0] as FakeAudioContext;
    const created = (): number => stats.created;
    ctx.currentTime = 1;
    await sleep(130);
    const playing = created();
    ctx.currentTime = 2;
    await sleep(130);
    expect(created()).toBeGreaterThan(playing);

    audio.setMusicHidden(true);
    ctx.currentTime = 3;
    await sleep(20);
    const frozen = created();
    ctx.currentTime = 4;
    await sleep(130);
    expect(created()).toBe(frozen);

    audio.setMusicHidden(false);
    ctx.currentTime = 5;
    await sleep(130);
    expect(created()).toBeGreaterThan(frozen);
    expect(stats.rangeWarnings).toEqual([]);
    audio.dispose();
  });

  test('source "off" never schedules a note', async () => {
    resetFakeAudio();
    g.AudioContext = FakeAudioContext;
    const audio = new AudioEngine(withMusic({ musicSource: 'off' }));
    await audio.resume();
    const ctx = FakeAudioContext.instances[0] as FakeAudioContext;
    const base = stats.created;
    ctx.currentTime = 3;
    await sleep(130);
    expect(stats.created).toBe(base);
    audio.dispose();
  });
});

describe('MusicPlayer', () => {
  function setup(
    load?: () => Promise<StoredMusic | null>,
    loadBundled?: () => Promise<StoredMusic | null>,
  ): { ctx: FakeAudioContext; out: FakeGain; player: MusicPlayer; base: number } {
    resetFakeAudio();
    const ctx = new FakeAudioContext();
    ctx.state = 'running';
    const shared = createSharedAudio(ctx as unknown as AudioContext);
    const out = new FakeGain();
    out.connect(ctx.destination);
    const base = stats.live.size;
    const player = new MusicPlayer(shared, out as unknown as AudioNode, { load, loadBundled });
    return { ctx, out, player, base };
  }

  test('schedules only inside the look-ahead window', () => {
    const { ctx, player } = setup();
    const starts: number[] = [];
    const proto = FakeSource.prototype;
    const original = proto.start;
    proto.start = function (this: FakeSource, when = 0): void {
      starts.push(when);
      original.call(this, when);
    };
    try {
      player.setActive(true);
      ctx.currentTime = 5;
      starts.length = 0;
      player.tick();
      expect(starts.length).toBeGreaterThan(0);
      for (const t of starts) {
        expect(t).toBeGreaterThanOrEqual(5);
        expect(t).toBeLessThan(5.2);
      }
      starts.length = 0;
      player.tick(); // same instant: nothing new is due
      expect(starts.length).toBe(0);
    } finally {
      proto.start = original;
      player.dispose();
    }
  });

  test('no node leak over many bars, after deactivation and after dispose; voices stay capped', () => {
    const { ctx, player, base } = setup();
    player.setActive(true);
    let peak = 0;
    const bars = TOTAL_BARS * 2;
    const end = bars * STEPS_PER_BAR * STEP_SECONDS;
    for (let t = 0.05; t < end; t += 0.05) {
      ctx.currentTime = t;
      player.tick();
      peak = Math.max(peak, player.voiceCount());
      fireEnded(t);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(60);
    expect(stats.live.size).toBeLessThan(base + 6 + 200);

    player.setActive(false);
    ctx.currentTime = end + 5;
    fireEnded(end + 5);
    player.tick();
    expect(player.voiceCount()).toBe(0);
    expect([...stats.live].filter((n) => n instanceof FakeSource).length).toBe(0);
    expect(stats.live.size).toBe(base + 5); // the persistent echo chain only

    player.setActive(true);
    ctx.currentTime = end + 6;
    player.tick();
    expect(player.voiceCount()).toBeGreaterThan(0);
    player.dispose();
    expect(stats.live.size).toBe(base); // only the bus node and destination remain
    expect(stats.rangeWarnings).toEqual([]);
  });

  test('a stuck voice (no ended event) is reclaimed by the sweep', () => {
    const { ctx, player, base } = setup();
    player.setActive(true);
    player.tick();
    expect(player.voiceCount()).toBeGreaterThan(0);
    ctx.currentTime = 30;
    player.tick();
    const early = [...stats.live].filter((n) => n instanceof FakeSource && n.stopAt < 29);
    expect(early.length).toBe(0);
    expect(player.voiceCount()).toBeLessThan(80);
    player.dispose();
    expect(stats.live.size).toBe(base);
  });

  describe('custom file', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const stored = (): StoredMusic => ({ name: 'lap-song.mp3', type: 'audio/mpeg', size: bytes.length, data: bytes.slice().buffer });

    function decodingContext(impl: (data: ArrayBuffer) => Promise<unknown>): { decoded: ArrayBuffer[] } {
      const decoded: ArrayBuffer[] = [];
      (FakeAudioContext.prototype as unknown as Record<string, unknown>).decodeAudioData = function (data: ArrayBuffer): Promise<unknown> {
        decoded.push(data);
        return impl(data);
      };
      return { decoded };
    }
    const dropDecoder = (): void => void delete (FakeAudioContext.prototype as unknown as Record<string, unknown>).decodeAudioData;
    const loopingSources = (): FakeBufferSource[] =>
      [...stats.live].filter((n): n is FakeBufferSource => n instanceof FakeBufferSource && n.loop && (n.buffer as { duration: number }).duration === 8);

    test('decodes a copy and loops the buffer', async () => {
      const { decoded } = decodingContext(() => Promise.resolve({ duration: 8, getChannelData: () => new Float32Array(1) }));
      try {
        const file = stored();
        const { player } = setup(() => Promise.resolve(file));
        player.setSource('custom');
        player.setActive(true);
        expect(player.mode()).toBe('none'); // still loading: neither track plays
        await sleep(10);
        expect(player.mode()).toBe('custom');
        expect(decoded.length).toBe(1);
        expect(decoded[0]).not.toBe(file.data);
        expect(new Uint8Array(decoded[0] as ArrayBuffer)).toEqual(bytes);
        expect(file.data.byteLength).toBe(bytes.length);
        const looping = loopingSources();
        expect(looping.length).toBe(1);
        expect((looping[0] as FakeBufferSource).started).toBe(true);
        expect(player.voiceCount()).toBe(0); // the synthesized track is silent
        expect(getMusicError()).toBeNull();

        player.setActive(false); // hidden / silent scene: the file stops with a short fade
        expect((looping[0] as FakeBufferSource).stopAt).toBeLessThan(2);
        player.dispose();
      } finally {
        dropDecoder();
      }
    });

    test('decode failure reports a Chinese error and falls back to the original track', async () => {
      decodingContext(() => Promise.reject(new Error('EncodingError')));
      try {
        const { player } = setup(() => Promise.resolve(stored()));
        player.setSource('custom');
        player.setActive(true);
        await sleep(10);
        expect(player.mode()).toBe('original');
        expect(getMusicError()).toContain('lap-song.mp3');
        expect(getMusicError()).toContain('原創');
        expect(player.voiceCount()).toBeGreaterThan(0);
        expect(loopingSources().length).toBe(0);
        player.dispose();
      } finally {
        dropDecoder();
      }
    });

    test('no decodeAudioData, unreadable store and empty store all fall back', async () => {
      dropDecoder();
      const missing = setup(() => Promise.resolve(stored()));
      missing.player.setSource('custom');
      missing.player.setActive(true);
      await sleep(10);
      expect(missing.player.mode()).toBe('original');
      expect(getMusicError()).not.toBeNull();
      missing.player.dispose();

      reportMusicError(null);
      const broken = setup(() => Promise.reject(new Error('此瀏覽器無法儲存音樂檔（IndexedDB 不可用）')));
      broken.player.setSource('custom');
      broken.player.setActive(true);
      await sleep(10);
      expect(broken.player.mode()).toBe('original');
      expect(getMusicError()).toContain('IndexedDB');
      broken.player.dispose();

      reportMusicError(null);
      const empty = setup(() => Promise.resolve(null));
      empty.player.setSource('custom');
      empty.player.setActive(true);
      await sleep(10);
      expect(empty.player.mode()).toBe('original');
      expect(getMusicError()).toBeNull();
      empty.player.dispose();
    });
  });

  describe('bundled track', () => {
    const file = (name: string, length: number): StoredMusic => ({ name, type: 'audio/mpeg', size: length, data: new Uint8Array(length).buffer });
    // the fake buffer's duration = byte length, so each file's loop is recognisable
    const useDecoder = (): void => {
      (FakeAudioContext.prototype as unknown as Record<string, unknown>).decodeAudioData = (data: ArrayBuffer): Promise<unknown> =>
        Promise.resolve({ duration: data.byteLength, getChannelData: () => new Float32Array(1) });
    };
    const dropDecoder = (): void => void delete (FakeAudioContext.prototype as unknown as Record<string, unknown>).decodeAudioData;
    const playing = (duration: number): FakeBufferSource[] =>
      [...stats.live].filter(
        (n): n is FakeBufferSource => n instanceof FakeBufferSource && n.loop && n.started && (n.buffer as { duration: number }).duration === duration,
      );

    test('loops the bundled file; switching to the user file and back reloads each one', async () => {
      useDecoder();
      try {
        let bundledLoads = 0;
        let customLoads = 0;
        const { ctx, player } = setup(
          () => (customLoads++, Promise.resolve(file('mine.mp3', 6))),
          () => (bundledLoads++, Promise.resolve(file('Bundled Song', 8))),
        );
        player.setSource('bundled');
        player.setActive(true);
        expect(player.mode()).toBe('none');
        await sleep(10);
        expect(player.mode()).toBe('bundled');
        expect(playing(8).length).toBe(1);
        expect(customLoads).toBe(0);
        expect(player.voiceCount()).toBe(0);

        ctx.currentTime = 1;
        player.setSource('custom');
        expect(player.mode()).toBe('none');
        expect((playing(8)[0] as FakeBufferSource).stopAt).toBeLessThan(2); // the bundled loop fades out
        await sleep(10);
        expect(player.mode()).toBe('custom');
        expect(customLoads).toBe(1);

        player.setSource('original');
        player.setSource('bundled');
        await sleep(10);
        expect(player.mode()).toBe('bundled');
        expect(bundledLoads).toBe(2);
        expect(getMusicError()).toBeNull();
        player.dispose();
      } finally {
        dropDecoder();
      }
    });

    test('no bundled track installed (the default source): the original track plays, no error', async () => {
      useDecoder();
      try {
        const { player } = setup(undefined, () => Promise.resolve(null));
        player.setSource('bundled');
        player.setActive(true);
        await sleep(10);
        expect(player.mode()).toBe('original');
        expect(getMusicError()).toBeNull();
        expect(player.voiceCount()).toBeGreaterThan(0);
        player.dispose();
      } finally {
        dropDecoder();
      }
    });

    test('manifest: title and file name from public/music/bundled.json, bytes fetched from the same folder', async () => {
      const realFetch = globalThis.fetch;
      const asked: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        asked.push(u);
        if (u === './music/bundled.json') return new Response(JSON.stringify({ title: ' Lap Anthem ', file: 'lap anthem.mp3' }));
        if (u === './music/lap%20anthem.mp3') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
        return new Response('missing', { status: 404 });
      }) as typeof fetch;
      // earlier engine tests (default source 'bundled') already read the real manifest
      resetBundledTrackCache();
      try {
        expect(bundledTrackNow()).toBeUndefined();
        expect(await bundledTrack()).toEqual({ title: 'Lap Anthem', url: './music/lap%20anthem.mp3' });
        expect(bundledTrackNow()?.title).toBe('Lap Anthem');
        const loaded = await loadBundledMusic();
        expect(loaded?.name).toBe('Lap Anthem');
        expect(loaded?.type).toBe('audio/mpeg');
        expect(loaded?.size).toBe(3);
        expect(asked.filter((u) => u.endsWith('bundled.json')).length).toBe(1); // read once
      } finally {
        globalThis.fetch = realFetch;
        resetBundledTrackCache();
      }
    });
  });
});

describe('music store', () => {
  const fileLike = (size: number): File => ({ name: 'big.wav', size, type: 'audio/wav', arrayBuffer: () => Promise.resolve(new ArrayBuffer(Math.min(size, 8))) }) as unknown as File;

  test('rejects files over 50 MB and empty files with a Chinese message', async () => {
    await expect(saveMusicFile(fileLike(MAX_MUSIC_BYTES + 1))).rejects.toThrow('50 MB');
    await expect(saveMusicFile(fileLike(0))).rejects.toThrow('空的');
  });

  test('without IndexedDB, saving and loading fail with a readable error', async () => {
    delete g.indexedDB;
    await expect(saveMusicFile(fileLike(100))).rejects.toThrow('IndexedDB');
    await expect(loadMusicFile()).rejects.toThrow('IndexedDB');
  });
});
