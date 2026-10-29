/**
 * App building blocks (pure, no DOM): fixed-step clock, one-shot input plumbing, flashback buffer limits,
 * replay packing / interpolation / ring buffer, URL quick-start parsing, split-screen views, scene car mapping
 * and the render_game_to_text payload.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { CarRenderState, ControlInput, RenderFrame, SessionRules } from '../src/core/types';
import { DEFAULT_RULES, SIM_DT } from '../src/core/defaults';
import { DRIVERS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { buildQuickStart } from '../src/meta/sessionBuilder';
import { BOX_SLOTS, BOX_SPACING, GRID_FRONT, GRID_GAP, GRID_LATERAL, createWorld, stepWorld } from '../src/race/index';
import { GRID_LAYOUT } from '../src/render/track/context';
import { PIT_BOX_COUNT, PIT_BOX_SPACING } from '../src/render/track/trackFrame';
import { FixedStepClock, FpsMeter, MAX_FRAME_DT, MAX_SUBSTEPS, clampFrameDt } from '../src/app/clock';
import { hasOneShot, substepInputs, withPendingOneShots, withoutOneShots } from '../src/app/controls';
import { FlashbackBuffer, flashbacksLeft } from '../src/app/flashback';
import { parseQuickStart } from '../src/app/quickStart';
import { ReplayRecorder, clipDuration, decodeFrame, encodeFrame, sampleClip } from '../src/app/replay';
import { sceneCarsFor } from '../src/app/sceneCars';
import { COORDINATE_NOTE, buildTextState } from '../src/app/textState';
import { buildViews, nextCamera } from '../src/app/views';
import { useFictionalRoster } from './rosterFixture';

const input = (patch: Partial<ControlInput> = {}): ControlInput => ({
  throttle: 0.5,
  brake: 0,
  steer: -0.25,
  shiftUp: false,
  shiftDown: false,
  drsPressed: false,
  ersCycle: false,
  limiterToggle: false,
  overtakeHeld: true,
  ...patch,
});

function car(patch: Partial<CarRenderState> = {}): CarRenderState {
  return {
    carId: 0,
    x: 10,
    y: 1,
    z: -20,
    yaw: 3.1,
    pitch: 0.01,
    roll: -0.02,
    speed: 50,
    steerAngle: 0.1,
    wheelSpin: 1000,
    throttle: 1,
    brake: 0,
    rpm: 11000,
    gear: 6,
    drsOpen: true,
    compound: 'medium',
    rainLight: false,
    limiter: false,
    damage: { frontWing: 0.25, rearWing: 0 },
    slip: 0.1,
    lockup: 0,
    impact: 0,
    surface: 'kerb',
    boost: false,
    visible: true,
    ghost: false,
    ...patch,
  };
}

const frame = (time: number, cars: CarRenderState[]): RenderFrame => ({
  time,
  cars,
  startLights: { lit: 3, out: false },
  weather: { kind: 'lightRain', rain: 0.4, wetness: 0.3 },
});

// written against the fictional field (data/teams.ts); the game's default is the 2026 F1 grid
beforeEach(useFictionalRoster);

describe('FixedStepClock', () => {
  test('120 / 60 / 144 / 240 Hz frames produce exactly one SIM_DT step per 1/120 s', () => {
    for (const hz of [120, 60, 144, 240, 50]) {
      const clock = new FixedStepClock(SIM_DT);
      let steps = 0;
      for (let i = 0; i < hz * 10; i++) steps += clock.advance(1 / hz);
      expect(Math.abs(steps - 1200)).toBeLessThanOrEqual(1);
      expect(clock.pending).toBeLessThan(SIM_DT + 1e-9);
    }
  });

  test('slow frames are clamped to MAX_FRAME_DT and at most MAX_SUBSTEPS steps, without a backlog', () => {
    const clock = new FixedStepClock(SIM_DT);
    expect(clock.advance(0.5)).toBe(MAX_SUBSTEPS);
    expect(clock.pending).toBeLessThan(SIM_DT);
    expect(clock.advance(1 / 120)).toBeLessThanOrEqual(2);
    expect(clampFrameDt(5)).toBe(MAX_FRAME_DT);
    expect(clampFrameDt(Number.NaN)).toBe(0);
    expect(clampFrameDt(-1)).toBe(0);
    expect(clock.advance(Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1);
    clock.reset();
    expect(clock.pending).toBe(0);
    expect(() => new FixedStepClock(0)).toThrow();
  });

  test('FpsMeter averages over its window', () => {
    const fps = new FpsMeter(0.5);
    for (let i = 0; i < 60; i++) fps.tick(1 / 60);
    expect(fps.fps).toBeCloseTo(60, 0);
    fps.tick(Number.NaN);
    expect(fps.fps).toBeCloseTo(60, 0);
  });
});

describe('one-shot input plumbing', () => {
  test('only the first sub-step carries one-shots; held inputs reach every sub-step', () => {
    const c = input({ shiftUp: true, drsPressed: true });
    const { first, rest } = substepInputs([c, null]);
    expect(first[0]?.shiftUp).toBe(true);
    expect(first[0]?.drsPressed).toBe(true);
    expect(rest[0]?.shiftUp).toBe(false);
    expect(rest[0]?.drsPressed).toBe(false);
    expect(rest[0]?.throttle).toBe(0.5);
    expect(rest[0]?.overtakeHeld).toBe(true);
    expect(first[1]).toBeNull();
    expect(rest[1]).toBeNull();
    expect(c.shiftUp).toBe(true); // source untouched
  });

  test('presses from a frame without a step are carried into the next one', () => {
    const pending = input({ ersCycle: true });
    const merged = withPendingOneShots(input({ throttle: 1, limiterToggle: true }), pending);
    expect(merged.ersCycle).toBe(true);
    expect(merged.limiterToggle).toBe(true);
    expect(merged.throttle).toBe(1);
    expect(withPendingOneShots(input(), null).shiftUp).toBe(false);
    expect(hasOneShot(withoutOneShots(merged))).toBe(false);
    expect(hasOneShot(merged)).toBe(true);
    expect(hasOneShot(null)).toBe(false);
  });
});

describe('flashback limits', () => {
  const rules = (flashbacks: number): SessionRules => ({ ...DEFAULT_RULES, flashbacks });
  test('unlimited, disabled and counted', () => {
    expect(flashbacksLeft(rules(-1), 99)).toBe(-1);
    expect(flashbacksLeft(rules(0), 0)).toBe(0);
    expect(flashbacksLeft(rules(3), 0)).toBe(3);
    expect(flashbacksLeft(rules(3), 2)).toBe(1);
    expect(flashbacksLeft(rules(3), 7)).toBe(0);
    expect(flashbacksLeft(rules(Number.NaN), 0)).toBe(0);
  });

  test('buffer keeps ~20 s of 0.5 s snapshots and rewinds to the oldest when younger than 5 s', () => {
    const { config } = buildQuickStart({ kind: 'practice', layoutId: 'porto-lumen', seed: 1 });
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const buffer = new FlashbackBuffer();
    expect(buffer.rewind(0)).toBeNull();
    for (let i = 0; i < Math.round(3 / SIM_DT); i++) {
      stepWorld(world, track, [null], SIM_DT);
      buffer.record(world);
    }
    expect(buffer.size).toBe(6);
    const early = buffer.rewind(world.time, 5);
    expect(early?.time).toBeCloseTo(SIM_DT, 6);
    expect(buffer.size).toBe(1);
    for (let i = 0; i < Math.round(30 / SIM_DT); i++) {
      stepWorld(world, track, [null], SIM_DT);
      buffer.record(world);
    }
    expect(buffer.size).toBeGreaterThanOrEqual(40);
    expect(buffer.size).toBeLessThanOrEqual(42);
    expect(world.time - (buffer.oldestTime ?? 0)).toBeLessThanOrEqual(20.5);
    buffer.clear();
    expect(buffer.size).toBe(0);
  });
});

describe('replay data', () => {
  test('pack / unpack round trip keeps every field (Float32 precision)', () => {
    const src = frame(12.5, [car(), car({ carId: 1, compound: 'wet', surface: 'pitlane', limiter: true, rainLight: true, drsOpen: false, gear: -1 }), car({ carId: -1, ghost: true, visible: false })]);
    const out = decodeFrame(12.5, encodeFrame(src), null, 0);
    expect(out.time).toBe(12.5);
    expect(out.startLights).toEqual({ lit: 3, out: false });
    expect(out.weather.kind).toBe('lightRain');
    expect(out.weather.rain).toBeCloseTo(0.4, 5);
    expect(out.cars.length).toBe(3);
    const [a, b, g] = out.cars as [CarRenderState, CarRenderState, CarRenderState];
    expect(a.x).toBeCloseTo(10, 4);
    expect(a.yaw).toBeCloseTo(3.1, 5);
    expect(a.wheelSpin).toBeCloseTo(1000, 2);
    expect(a.drsOpen).toBe(true);
    expect(a.surface).toBe('kerb');
    expect(a.damage.frontWing).toBeCloseTo(0.25, 5);
    expect(b.compound).toBe('wet');
    expect(b.surface).toBe('pitlane');
    expect(b.limiter && b.rainLight).toBe(true);
    expect(b.gear).toBe(-1);
    expect(g.carId).toBe(-1);
    expect(g.ghost).toBe(true);
    expect(g.visible).toBe(false);
  });

  test('interpolation blends positions and wraps yaw the short way; teleports snap', () => {
    const a = encodeFrame(frame(0, [car({ x: 0, yaw: Math.PI - 0.1 }), car({ carId: 1, x: 0 })]));
    const b = encodeFrame(frame(1, [car({ x: 10, yaw: -Math.PI + 0.1 }), car({ carId: 1, x: 500 })]));
    const mid = decodeFrame(0.5, a, b, 0.5);
    expect(mid.cars[0]!.x).toBeCloseTo(5, 4);
    expect(Math.abs(Math.abs(mid.cars[0]!.yaw) - Math.PI)).toBeLessThan(1e-4);
    expect(mid.cars[1]!.x === 0 || mid.cars[1]!.x === 500).toBe(true);
    const early = decodeFrame(0.25, a, b, 0.25);
    expect(early.cars[1]!.x).toBe(0);
  });

  test('recorder: 30 Hz cadence, bounded ring keeps the newest frames, truncate and clear', () => {
    const rec = new ReplayRecorder(30, 1);
    for (let i = 0; i <= 240; i++) rec.maybeRecord(i / 120, () => frame(i / 120, [car({ x: i })]));
    const clip = rec.toClip();
    expect(clip.times.length).toBe(31); // capacity = 30 Hz × 1 s + 1
    expect(clip.times[clip.times.length - 1]).toBeCloseTo(2, 6);
    expect(clipDuration(clip)).toBeCloseTo(1, 1);
    for (let i = 1; i < clip.times.length; i++) expect(clip.times[i]! - clip.times[i - 1]!).toBeCloseTo(1 / 30, 2);
    // no frame before the first, clamp after the last
    expect(sampleClip(clip, -100)!.time).toBe(clip.times[0]!);
    expect(sampleClip(clip, 1e9)!.cars[0]!.x).toBeCloseTo(240, 3);
    expect(sampleClip(clip, Number.NaN)).not.toBeNull();
    expect(sampleClip({ times: [], frames: [] }, 1)).toBeNull();
    rec.truncateAfter(1.5);
    expect(rec.lastTime!).toBeLessThanOrEqual(1.5);
    // recording resumes after the truncation point
    expect(rec.maybeRecord(1.55, () => frame(1.55, [car()]))).toBe(true);
    expect(rec.maybeRecord(1.56, () => frame(1.56, [car()]))).toBe(false);
    rec.clear();
    expect(rec.length).toBe(0);
    expect(rec.lastTime).toBeNull();
  });
});

describe('URL quick start', () => {
  const isLayout = (id: string): boolean => id === 'porto-lumen' || id === 'porto-lumen-rev';
  test('valid parameters are parsed', () => {
    expect(parseQuickStart('?quick=race&layout=porto-lumen-rev&laps=7&weather=heavyRain&reg=2026&ai=95&seed=12', isLayout)).toEqual({
      kind: 'race',
      layoutId: 'porto-lumen-rev',
      laps: 7,
      weather: 'heavyRain',
      regulation: '2026',
      aiDifficulty: 95,
      seed: 12,
    });
    expect(parseQuickStart('?quick=tt', isLayout)).toEqual({ kind: 'tt' });
    for (const kind of ['race', 'quali', 'practice', 'tt', 'split']) expect(parseQuickStart(`?quick=${kind}`, isLayout)?.kind).toBe(kind);
  });

  test('invalid values are dropped, out-of-range values clamped, non-quick URLs ignored', () => {
    expect(parseQuickStart('', isLayout)).toBeNull();
    expect(parseQuickStart('?quick=drift', isLayout)).toBeNull();
    expect(parseQuickStart('?layout=porto-lumen', isLayout)).toBeNull();
    expect(parseQuickStart('?quick=race&layout=monaco&laps=0&reg=1999&ai=500', isLayout)).toEqual({ kind: 'race', aiDifficulty: 110 });
    expect(parseQuickStart('?quick=race&laps=abc&ai=-4', isLayout)).toEqual({ kind: 'race', aiDifficulty: 0 });
    expect(parseQuickStart('?quick=race&laps=9999', isLayout)?.laps).toBe(200);
  });
});

describe('views and cameras', () => {
  test('single player, split-screen and spectator views', () => {
    const one = buildViews([4], 'cockpit');
    expect(one.views).toEqual([{ carId: 4, camera: 'cockpit', lookBack: false, viewport: { x: 0, y: 0, w: 1, h: 1 } }]);
    expect(one.hudViews).toEqual([{ playerIndex: 0, carId: 4, region: 'full' }]);
    const two = buildViews([2, 7], 'chase');
    expect(two.views.map((v) => v.viewport)).toEqual([
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ]);
    expect(two.hudViews.map((v) => [v.playerIndex, v.carId, v.region])).toEqual([
      [0, 2, 'left'],
      [1, 7, 'right'],
    ]);
    expect(buildViews([], 'tv', 3).views[0]!.carId).toBe(3);
    expect(buildViews([-1, Number.NaN], 'tv').views.length).toBe(1);
  });

  test('camera cycling wraps and restarts from outside the cycle', () => {
    const cycle = ['chase', 'chaseFar', 'tcam', 'cockpit', 'nose'] as const;
    expect(nextCamera(cycle, 'chase')).toBe('chaseFar');
    expect(nextCamera(cycle, 'nose')).toBe('chase');
    expect(nextCamera(cycle, 'tv')).toBe('chase');
    expect(nextCamera([], 'tv')).toBe('tv');
  });
});

describe('race placement matches the painted track', () => {
  test('grid slots and pit boxes use the same geometry in race and render', () => {
    expect(GRID_LAYOUT.firstSlot).toBe(GRID_FRONT);
    expect(GRID_LAYOUT.spacing).toBe(GRID_GAP);
    expect(GRID_LAYOUT.lateral).toBe(GRID_LATERAL);
    expect(PIT_BOX_SPACING).toBe(BOX_SPACING);
    expect(PIT_BOX_COUNT).toBe(BOX_SLOTS);
    // pole is placed (and painted) on the side away from the pit lane
    for (const id of ['porto-lumen', 'mirage-sands']) {
      const { config } = buildQuickStart({ kind: 'race', layoutId: id, seed: 1 });
      const track = getLayout(id);
      const pole = createWorld(config, track).cars[0]!;
      expect(Math.sign(pole.phys.lateral)).toBe(GRID_LAYOUT.poleSide * track.pit.side);
      expect(Math.abs(pole.phys.lateral)).toBeCloseTo(GRID_LAYOUT.lateral, 6);
    }
  });
});

describe('session presentation helpers', () => {
  test('scene cars carry livery, number, team code and the driver helmet', () => {
    const { config } = buildQuickStart({ kind: 'race', layoutId: 'isola-verde', seed: 2 });
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const cars = sceneCarsFor(world);
    expect(cars.length).toBe(world.cars.length);
    for (const c of cars) {
      const entry = world.cars[c.carId]!;
      expect(c.number).toBe(entry.number);
      expect(c.livery.primary).toBe(entry.livery.primary);
      expect(c.teamShort).toMatch(/^[A-Z]{3}$/);
      const driver = DRIVERS.find((d) => d.id === entry.driverId);
      if (driver) expect(c.helmet.primary).toBe(driver.helmet.primary);
    }
  });

  test('render_game_to_text payload: menus, and a race with player + neighbours', () => {
    const empty = buildTextState({ screen: 'menu', menuOpen: true, paused: false, world: null, track: null, viewCarId: 0, replay: null });
    expect(empty.coordinates).toBe(COORDINATE_NOTE);
    expect(empty.player).toBeNull();
    expect(JSON.parse(JSON.stringify(empty)).screen).toBe('menu');

    const { config } = buildQuickStart({ kind: 'race', layoutId: 'porto-lumen', seed: 9 });
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const player = world.cars.find((c) => c.playerIndex === 0)!;
    const text = buildTextState({ screen: 'session', menuOpen: false, paused: true, world, track, viewCarId: player.id, replay: null });
    const session = text.session as Record<string, unknown>;
    expect(session.kind).toBe('race');
    expect(session.phase).toBe('pre');
    expect(session.lightsOut).toBe(false);
    expect(session.totalLaps).toBe(config.laps);
    const p = text.player as Record<string, unknown>;
    expect(p.carId).toBe(player.id);
    expect(p.gear).toBe(0);
    expect(p.position).toBe(player.timing.position);
    expect(typeof p.speedKmh).toBe('number');
    // on the grid somebody is ahead or behind within a few slots
    const ahead = text.ahead as { distance: number } | null;
    const behind = text.behind as { distance: number } | null;
    expect(ahead !== null || behind !== null).toBe(true);
    for (const n of [ahead, behind]) if (n) expect(n.distance).toBeLessThan(40);
    expect(text.paused).toBe(true);
    expect(() => JSON.stringify(text)).not.toThrow();
  });

  test('render_game_to_text after results are dismissed: menu screen, no session data', () => {
    // App clears its results (world = null) and switches to 'menu' when 繼續 is pressed on the results screen
    const afterResults = buildTextState({ screen: 'menu', menuOpen: true, paused: false, world: null, track: null, viewCarId: 0, player2CarId: null, replay: null });
    expect(afterResults.screen).toBe('menu');
    expect(afterResults.session).toBeNull();
    expect(afterResults.player).toBeNull();
    expect(afterResults.player2).toBeNull();
  });
});
