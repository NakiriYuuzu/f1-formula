/**
 * Online frame timing (src/app/clock.ts ONLINE_*, src/app/backgroundTicker.ts): an online session catches a slow
 * frame up over the next frames instead of dropping it (the host's world is everyone's clock), and a worker timer
 * keeps the online host's frames going while its page is hidden.
 */
import { describe, expect, test } from 'bun:test';
import { SIM_DT } from '../src/core/defaults';
import { FixedStepClock, MAX_SUBSTEPS, ONLINE_MAX_BACKLOG, ONLINE_MAX_FRAME_DT, ONLINE_MAX_SUBSTEPS } from '../src/app/clock';
import { BackgroundTicker } from '../src/app/backgroundTicker';

const online = (): FixedStepClock => new FixedStepClock(SIM_DT, ONLINE_MAX_SUBSTEPS, { maxFrameDt: ONLINE_MAX_FRAME_DT, maxBacklog: ONLINE_MAX_BACKLOG });

describe('online clock', () => {
  test('a 0.3 s frame is caught up over the next frames: no step lost', () => {
    const clock = online();
    let steps = 0;
    for (let i = 0; i < 60; i++) steps += clock.advance(1 / 60);
    const first = clock.advance(0.3);
    expect(first).toBe(ONLINE_MAX_SUBSTEPS);
    steps += first;
    for (let i = 0; i < 60; i++) {
      const n = clock.advance(1 / 60);
      expect(n).toBeLessThanOrEqual(ONLINE_MAX_SUBSTEPS);
      steps += n;
    }
    // 1 s + 0.3 s + 1 s of real time, every step run (offline: 0.3 s → 8 steps, the rest dropped)
    expect(Math.abs(steps - Math.round(2.3 / SIM_DT))).toBeLessThanOrEqual(1);
    expect(clock.pending).toBeLessThan(SIM_DT + 1e-9);
    const offline = new FixedStepClock(SIM_DT);
    expect(offline.advance(0.3)).toBe(MAX_SUBSTEPS);
    expect(offline.pending).toBeLessThan(SIM_DT);
  });

  test('longer gaps are bounded: at most ONLINE_MAX_FRAME_DT taken in, the backlog at most ONLINE_MAX_BACKLOG', () => {
    const clock = online();
    expect(clock.advance(30)).toBe(ONLINE_MAX_SUBSTEPS);
    let steps = ONLINE_MAX_SUBSTEPS;
    for (let i = 0; i < 10; i++) steps += clock.advance(0);
    expect(steps).toBe(Math.round(ONLINE_MAX_FRAME_DT / SIM_DT));
    // two long frames in a row: 1 s taken in, 24 steps run, the backlog capped (the rest dropped)
    expect(clock.advance(0.5)).toBe(ONLINE_MAX_SUBSTEPS);
    expect(clock.advance(0.5)).toBe(ONLINE_MAX_SUBSTEPS);
    expect(clock.pending).toBeCloseTo(ONLINE_MAX_BACKLOG, 9);
    steps = 0;
    for (let i = 0; i < 10; i++) steps += clock.advance(0);
    expect(steps).toBe(Math.round(ONLINE_MAX_BACKLOG / SIM_DT));
    expect(clock.advance(Number.NaN)).toBe(0);
    expect(clock.advance(-1)).toBe(0);
    clock.reset();
    expect(clock.pending).toBe(0);
  });

  test('owed: what the clock still simulates if a frame came now (the host counts it in arrival ages)', () => {
    const clock = online();
    expect(clock.owed(0.3)).toBeCloseTo(0.3, 9);
    clock.advance(0.3);
    // 0.1 s backlog + a 0.5 s frame: all of it will run
    expect(clock.owed(0.5)).toBeCloseTo(0.6, 9);
    // after a 0.5 s frame (0.3 s backlog) another one: 0.8 s, more than maxSteps + maxBacklog runs — the rest is dropped
    const long = online();
    long.advance(0.5);
    expect(long.owed(10)).toBeCloseTo(ONLINE_MAX_SUBSTEPS * SIM_DT + ONLINE_MAX_BACKLOG, 9);
    const offline = new FixedStepClock(SIM_DT);
    expect(offline.owed(0.05)).toBeCloseTo(0.05, 9);
    expect(offline.owed(0.3)).toBeCloseTo(MAX_SUBSTEPS * SIM_DT, 9);
    expect(clock.owed(Number.NaN)).toBeCloseTo(clock.pending, 9);
  });
});

describe('background ticker', () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  test('ticks from a worker until stopped', async () => {
    let ticks = 0;
    const t = new BackgroundTicker(() => ticks++, 10);
    t.start();
    t.start();
    expect(t.running).toBe(true);
    await wait(200);
    t.stop();
    expect(t.running).toBe(false);
    expect(ticks).toBeGreaterThan(5);
    const after = ticks;
    await wait(60);
    expect(ticks).toBe(after);
  });

  test('falls back to a main-thread interval without workers', async () => {
    const saved = globalThis.Worker;
    (globalThis as { Worker?: unknown }).Worker = undefined;
    try {
      let ticks = 0;
      const t = new BackgroundTicker(() => ticks++, 10);
      t.start();
      expect(t.running).toBe(true);
      await wait(100);
      t.stop();
      expect(ticks).toBeGreaterThan(3);
    } finally {
      globalThis.Worker = saved;
    }
  });
});
