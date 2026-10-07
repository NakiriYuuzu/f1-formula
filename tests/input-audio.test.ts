/**
 * Audio tests (owned by the audio/input agent): pure mix math, headless no-op safety, and a full AudioEngine run
 * against a strict fake WebAudio implementation (invalid parameter values throw, nominal-range violations and
 * per-frame node allocation are detected, every node is disconnected on stopSession/dispose).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AudioEngine } from '../src/audio/index';
import { raceControlCueFor } from '../src/audio/sfx';
import {
  ambienceLayers,
  distanceGain,
  dopplerFactor,
  firingFrequency,
  impactStrength,
  mergeAmbienceLayers,
  MAX_AUDIBLE_DISTANCE,
  panFor,
  rpmNorm,
  selectVoicedCars,
  squealIntensity,
} from '../src/audio/mix';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import type { CarRenderState, GameEvent, RenderFrame } from '../src/core/types';
import { FakeAudioContext, FakeSource, fireEnded, resetFakeAudio, stats } from './fakeAudio';

function car(carId: number, x: number, z: number, patch: Partial<CarRenderState> = {}): CarRenderState {
  return {
    carId,
    x,
    y: 0,
    z,
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: 60,
    steerAngle: 0,
    wheelSpin: 0,
    throttle: 1,
    brake: 0,
    rpm: 10000,
    gear: 5,
    drsOpen: false,
    compound: 'soft',
    rainLight: false,
    limiter: false,
    damage: { frontWing: 0, rearWing: 0 },
    slip: 0,
    lockup: 0,
    impact: 0,
    surface: 'asphalt',
    boost: false,
    visible: true,
    ghost: false,
    ...patch,
  };
}

const ORIGIN = { x: 0, y: 0, z: 0 };

describe('mix math', () => {
  test('distance gain: full nearby, monotone, silent beyond the audible range', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(5)).toBe(1);
    expect(distanceGain(50)).toBeLessThan(distanceGain(20));
    expect(distanceGain(MAX_AUDIBLE_DISTANCE)).toBe(0);
    expect(distanceGain(Number.NaN)).toBe(0);
    expect(distanceGain(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test('pan follows the world convention (right = -X when facing +Z)', () => {
    expect(panFor(0, -10, 0)).toBeGreaterThan(0.5);
    expect(panFor(0, 10, 0)).toBeLessThan(-0.5);
    expect(panFor(0, 0, 10)).toBeCloseTo(0, 6);
    expect(panFor(0, 0, 0)).toBe(0);
    expect(panFor(Number.NaN, 5, 5)).toBe(0);
  });

  test('doppler: approaching raises pitch, receding lowers it, bounded', () => {
    // listener at origin, source 50 m ahead on +Z
    expect(dopplerFactor(0, -50, 0, -80, 0, 0)).toBeGreaterThan(1.1);
    expect(dopplerFactor(0, -50, 0, 80, 0, 0)).toBeLessThan(0.9);
    expect(dopplerFactor(0, -50, 0, -1e6, 0, 0)).toBeLessThanOrEqual(1.3);
    expect(dopplerFactor(0, 0, 50, 50, 0, 0)).toBe(1);
    expect(dopplerFactor(0, -50, Number.NaN, 0, 0, 0)).toBe(1);
  });

  test('voice selection: listener first, nearest others, ghosts/invisible excluded, hysteresis', () => {
    const cars = [
      car(0, 0, 5),
      car(1, 0, 100),
      car(2, 0, 20),
      car(3, 0, 30),
      car(4, 0, 40),
      car(5, 0, 50),
      car(6, 0, 1, { ghost: true }),
      car(7, 0, 2, { visible: false }),
      car(-1, 0, 3, { ghost: true }),
      car(8, 0, 2000),
    ];
    expect(selectVoicedCars(cars, 0, ORIGIN, new Set())).toEqual([0, 2, 3, 4, 5]);
    // car 1 is voiced already and only slightly farther than car 5: it keeps its voice
    const near = [car(0, 0, 5), car(1, 0, 52), car(2, 0, 20), car(3, 0, 30), car(4, 0, 40), car(5, 0, 50)];
    expect(selectVoicedCars(near, 0, ORIGIN, new Set([1]))).toEqual([0, 2, 3, 4, 1]);
    expect(selectVoicedCars([], 0, ORIGIN, new Set())).toEqual([]);
  });

  test('engine helpers', () => {
    expect(firingFrequency(12000)).toBe(600);
    expect(firingFrequency(Number.NaN)).toBe(0);
    expect(rpmNorm(4000, 4000, 12000)).toBe(0);
    expect(rpmNorm(14000, 4000, 12000)).toBe(1);
    expect(rpmNorm(8000, 4000, 4000)).toBe(0);
    expect(squealIntensity(1, 0, 60, 0, 'asphalt')).toBe(1);
    expect(squealIntensity(1, 0, 60, 0, 'gravel')).toBe(0);
    expect(squealIntensity(1, 0, 60, 1, 'asphalt')).toBeCloseTo(0.2, 6);
    expect(squealIntensity(0, 0, 60, 0, 'asphalt')).toBe(0);
    expect(impactStrength(0)).toBe(0);
    expect(impactStrength(1e9)).toBe(1);
    expect(impactStrength(Number.NaN)).toBe(0);
  });
});

const g = globalThis as Record<string, unknown>;
afterEach(() => {
  delete g.AudioContext;
  FakeAudioContext.instances = [];
});

function frame(time: number, cars: CarRenderState[], rain = 0): RenderFrame {
  return { time, cars, startLights: { lit: 0, out: true }, weather: { kind: rain > 0 ? 'lightRain' : 'clear', rain, wetness: rain } };
}

describe('race-control cues', () => {
  test('mode changes map to alert / urgent / clear cues', () => {
    expect(raceControlCueFor('sc', 'green')).toBe('alert');
    expect(raceControlCueFor('vsc', 'green')).toBe('alert');
    expect(raceControlCueFor('red', 'sc')).toBe('urgent');
    expect(raceControlCueFor('green', 'sc')).toBe('clear');
    expect(raceControlCueFor('green', 'red')).toBe('clear');
    expect(raceControlCueFor('green', 'vscEnding')).toBe('clear');
    expect(raceControlCueFor('green', 'formation')).toBeNull();
    expect(raceControlCueFor('scEnding', 'sc')).toBeNull();
    expect(raceControlCueFor('formation', 'green')).toBeNull();
    expect(raceControlCueFor('sc', 'sc')).toBeNull();
  });
});

describe('AudioEngine', () => {
  test('without WebAudio every method is a safe no-op', async () => {
    delete g.AudioContext;
    const audio = new AudioEngine(DEFAULT_SETTINGS);
    await audio.resume();
    audio.applySettings(DEFAULT_SETTINGS);
    audio.update(frame(0, [car(0, 0, 0)]), 0, 'chase', ORIGIN, 1 / 60);
    audio.handleEvents([{ type: 'lightsOut' }], [0]);
    audio.setPaused(true);
    audio.setPaused(false);
    audio.ui('confirm');
    audio.stopSession();
    audio.dispose();
    audio.dispose();
  });

  test('before resume() nothing is created', () => {
    g.AudioContext = FakeAudioContext;
    const audio = new AudioEngine(DEFAULT_SETTINGS);
    audio.update(frame(0, [car(0, 0, 0)]), 0, 'chase', ORIGIN, 1 / 60);
    audio.ui('move');
    expect(FakeAudioContext.instances.length).toBe(0);
    audio.dispose();
  });

  test('full session run: no invalid params, no per-frame allocation, no leaks', async () => {
    resetFakeAudio();
    g.AudioContext = FakeAudioContext;
    const audio = new AudioEngine(DEFAULT_SETTINGS);
    await audio.resume();
    await audio.resume();
    expect(FakeAudioContext.instances.length).toBe(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.state).toBe('running');
    audio.ui('move');
    audio.ui('confirm');
    audio.ui('back');
    audio.ui('error');

    const dt = 1 / 60;
    let t = 0;
    const cars = (i: number): CarRenderState[] => {
      const list: CarRenderState[] = [];
      for (let id = 0; id < 20; id++) {
        const z = id * 15 + i * 0.8;
        list.push(
          car(id, (id % 2) * 4, z, {
            rpm: 6000 + ((i * 37 + id * 500) % 7000),
            gear: 1 + (Math.floor(i / 20 + id) % 8),
            throttle: (i + id) % 50 < 30 ? 1 : 0,
            slip: id === 3 ? 0.9 : 0,
            lockup: id === 4 ? 0.8 : 0,
            surface: id === 0 ? (i % 90 < 30 ? 'kerb' : i % 90 < 60 ? 'gravel' : 'grass') : 'asphalt',
            limiter: id === 0 && i > 200,
            impact: id === 5 && i % 100 === 50 ? 5000 : 0,
          }),
        );
      }
      list.push(car(-1, 0, 10, { ghost: true }));
      return list;
    };
    const cams = ['chase', 'cockpit', 'tv', 'nose', 'tcam', 'chaseFar'] as const;
    const events: GameEvent[] = [
      { type: 'lightsOn', count: 1 },
      { type: 'lightsOut' },
      { type: 'lapComplete', carId: 0, lap: 1, time: 90, valid: true, personalBest: true, overallBest: false },
      { type: 'lapComplete', carId: 0, lap: 2, time: 89, valid: true, personalBest: true, overallBest: true },
      { type: 'collision', carId: 2, otherCarId: 3, impulse: 3000 },
      { type: 'pitStop', carId: 0, duration: 2.4, compound: 'hard' },
      { type: 'carFinished', carId: 0, position: 1 },
      { type: 'chequered' },
      { type: 'radio', carId: null, text: '測試' },
      { type: 'raceControl', mode: 'sc', previous: 'green', reason: '' },
      { type: 'raceControl', mode: 'red', previous: 'sc', reason: '' },
      { type: 'raceControl', mode: 'green', previous: 'red', reason: '' },
      { type: 'blueFlag', carId: 0, forCarId: 1 },
      { type: 'controlWarning', carId: 0, reason: 'x' },
      { type: 'blueFlag', carId: 7, forCarId: 1 },
    ];
    for (let i = 0; i < 400; i++) {
      t += dt;
      ctx.currentTime = t;
      const camCar = cars(i)[0];
      audio.update(frame(t, cars(i), i > 300 ? 0.8 : 0), 0, cams[Math.floor(i / 60) % cams.length], { x: camCar.x, y: 2, z: camCar.z - 8 }, dt);
      if (i % 50 === 0) audio.handleEvents(events, [0]);
      if (i === 120) audio.setPaused(true);
      if (i === 140) audio.setPaused(false);
      fireEnded(t);
    }
    // Steady state: once voices exist, plain frames create no audio nodes
    // (the first frame may legitimately fire a gear-change click: gear differs from the previous run).
    let before = stats.created;
    for (let i = 0; i < 120; i++) {
      if (i === 2) before = stats.created;
      t += dt;
      ctx.currentTime = t;
      const list = [car(0, 0, i * 1.5, { throttle: 0.6 }), car(1, 3, 40 + i, { throttle: 0.6 })];
      audio.update(frame(t, list), 0, 'chase', { x: 0, y: 2, z: i * 1.5 - 8 }, dt);
      fireEnded(t);
    }
    expect(stats.created).toBe(before);

    // Garbage inputs must not throw.
    audio.update(frame(Number.NaN, [car(0, Number.NaN, 0, { rpm: Number.NaN, speed: Number.NaN, throttle: Number.NaN, yaw: Number.NaN })]), 0, 'chase', { x: Number.NaN, y: 0, z: 0 }, Number.NaN);
    audio.update(frame(t, []), 7, 'tv', ORIGIN, -1);
    audio.handleEvents([], []);
    audio.applySettings({ ...DEFAULT_SETTINGS, masterVolume: Number.NaN, engineVolume: 2, sfxVolume: -1 });

    expect(stats.rangeWarnings).toEqual([]);

    fireEnded(t + 10);
    audio.stopSession();
    // Only the persistent bus chain (+ destination) survives a session: 9 buses, plus the music bus and the music
    // player's echo chain (6). Music voices are short-lived and already gone.
    const survivors = [...stats.live].filter((n) => !(n instanceof FakeSource));
    expect([...stats.live].some((n) => n instanceof FakeSource && !n.stopped)).toBe(false);
    expect(survivors.length).toBeLessThanOrEqual(15);

    audio.update(frame(t + 1, [car(0, 0, 0)]), 0, 'chase', ORIGIN, dt);
    audio.dispose();
    expect(ctx.state).toBe('closed');
    expect(stats.live.size).toBe(1); // destination only
    audio.ui('move');
    await audio.resume();
    expect(FakeAudioContext.instances.length).toBe(1);
  });
});

describe('split-screen ambience mix', () => {
  const src = (patch: Partial<Parameters<typeof ambienceLayers>[0]> = {}) => ({
    speed: 0,
    surface: 'asphalt' as const,
    interior: false,
    trackside: false,
    gain: 1,
    ...patch,
  });

  test('a single listener is unchanged by merging with a silent car', () => {
    const a = ambienceLayers(src({ speed: 80, surface: 'kerb' }), 0.5, 0.5);
    expect(mergeAmbienceLayers(a, ambienceLayers(src(), 0.5, 0.5)).wind).toBe(a.wind);
    expect(a.wind).toBeGreaterThan(0);
    expect(a.rumble).toBeGreaterThan(0);
  });

  test('P2 is heard: their wind, surface and spray drive the beds when louder than P1', () => {
    const p1 = ambienceLayers(src({ speed: 5 }), 0, 0);
    const p2 = ambienceLayers(src({ speed: 85, surface: 'gravel' }), 0, 0);
    const m = mergeAmbienceLayers(p1, p2);
    expect(m.wind).toBe(p2.wind);
    expect(m.windSpeed).toBe(85);
    expect(m.offroad).toBe(p2.offroad);
    expect(m.offroadHz).toBe(1700);
    expect(m.rumbleHz).toBe(p2.rumbleHz);
  });

  test('merge is symmetric and never sums beyond the louder car', () => {
    const a = ambienceLayers(src({ speed: 70, interior: true }), 0.3, 0.4);
    const b = ambienceLayers(src({ speed: 70 }), 0.3, 0.4);
    const ab = mergeAmbienceLayers(a, b);
    const ba = mergeAmbienceLayers(b, a);
    expect(ab.wind).toBe(ba.wind);
    expect(ab.wind).toBe(Math.max(a.wind, b.wind));
    expect(ab.rain).toBe(Math.max(a.rain, b.rain));
  });

  test('trackside camera has no wind; NaN input is safe', () => {
    expect(ambienceLayers(src({ speed: 90, trackside: true }), 0, 0).wind).toBe(0);
    const n = ambienceLayers(src({ speed: Number.NaN, gain: Number.NaN }), Number.NaN, Number.NaN);
    for (const v of Object.values(n)) expect(Number.isFinite(v)).toBe(true);
  });
});
