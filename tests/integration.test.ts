/**
 * Integration tests (headless, no DOM): every game mode / session kind goes through the real meta session builder
 * → race.createWorld → an App-like frame loop (fixed SIM_DT steps from 60 Hz frames, one-shots only in the first
 * sub-step, events drained per frame, flashback snapshots, replay recording) → render frame / standings →
 * end of session → results. Also checks flashback determinism and replay fidelity.
 */
import { describe, expect, test } from 'bun:test';
import type { BuiltTrack, ControlInput, GameEvent, RenderFrame, SessionConfig, SessionKind, WorldState } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { computeAIInput } from '../src/ai/index';
import { getLayout, hasLayout, LAYOUTS } from '../src/data/tracks/index';
import { createCareer, careerRequest } from '../src/meta/career';
import { createMyTeam, myTeamRequest } from '../src/meta/myTeam';
import { reserveDrivers, standardRoster, type PlayerIdentity } from '../src/meta/roster';
import { DEFAULT_SEASON_SETTINGS } from '../src/meta/season';
import { buildQuickStart, buildSessionConfig, validateSessionConfig, type SessionRequest } from '../src/meta/sessionBuilder';
import { resolveObjective, STORY_CHALLENGES, STORY_CHAPTERS, storyRequest } from '../src/meta/story';
import {
  buildRenderFrame,
  buildSessionResult,
  concludeRace,
  createWorld,
  endSession,
  extractGhost,
  getPlayerCarId,
  getStandings,
  isSessionOver,
  playerCarIds,
  requestPit,
  retireCar,
  snapshotWorld,
  stepWorld,
} from '../src/race/index';
import { FixedStepClock } from '../src/app/clock';
import { substepInputs, withPendingOneShots } from '../src/app/controls';
import { FlashbackBuffer, flashbacksLeft } from '../src/app/flashback';
import { parseQuickStart } from '../src/app/quickStart';
import { ReplayRecorder, sampleClip } from '../src/app/replay';
import { sceneCarsFor } from '../src/app/sceneCars';
import { buildTextState } from '../src/app/textState';
import { buildViews } from '../src/app/views';

const FRAME_DT = 1 / 60;
const PLAYER = { assists: { ...DEFAULT_ASSISTS }, setup: { ...DEFAULT_SETUP }, startCompound: null };
const IDENTITY: PlayerIdentity = {
  firstName: '測試',
  lastName: '車手',
  abbr: 'TST',
  number: 42,
  nationality: 'TWN',
  helmet: { primary: '#ff5a1f', secondary: '#111111', accent: '#ffffff' },
};

type Controller = (world: WorldState, track: BuiltTrack, playerIndex: 0 | 1) => ControlInput | null;

interface LoopOptions {
  flashbacks?: FlashbackBuffer;
  recorder?: ReplayRecorder;
  /** original RenderFrames handed to the recorder, in order */
  recorded?: RenderFrame[];
}

/** The App's per-frame simulation logic (SessionRuntime.frame minus rendering), at 60 Hz for `seconds`. */
function runFrames(world: WorldState, track: BuiltTrack, seconds: number, control: Controller, opts: LoopOptions = {}): GameEvent[] {
  const clock = new FixedStepClock(SIM_DT);
  const drained: GameEvent[] = [];
  let pending: (ControlInput | null)[] = [null, null];
  const frames = Math.round(seconds / FRAME_DT);
  for (let f = 0; f < frames; f++) {
    const steps = clock.advance(FRAME_DT);
    const controls: (ControlInput | null)[] = [0, 1].map((pi) => {
      const c = control(world, track, pi as 0 | 1);
      return c ? withPendingOneShots(c, pending[pi] ?? null) : null;
    });
    if (steps === 0) {
      pending = controls;
      continue;
    }
    const { first, rest } = substepInputs(controls);
    for (let k = 0; k < steps; k++) {
      stepWorld(world, track, k === 0 ? first : rest, SIM_DT);
      if (opts.flashbacks && world.session.phase !== 'finished') opts.flashbacks.record(world);
      opts.recorder?.maybeRecord(world.time, () => {
        const frame = buildRenderFrame(world, track);
        opts.recorded?.push(frame);
        return frame;
      });
    }
    pending = [null, null];
    drained.push(...world.events.splice(0, world.events.length));
  }
  return drained;
}

/** Null input for the first `idle` seconds of world time, then the AI drives every human car. */
function scripted(idle: number): Controller {
  return (world, track, pi) => {
    if (world.time < idle) return null;
    const car = world.cars[getPlayerCarId(world, pi)];
    return car ? computeAIInput(world, car, track, SIM_DT) : null;
  };
}

/** Per-step loop (input recomputed every step) so a run is reproducible from any snapshot. */
function runSteps(world: WorldState, track: BuiltTrack, steps: number, control: Controller, flashbacks?: FlashbackBuffer): void {
  for (let i = 0; i < steps; i++) {
    stepWorld(world, track, [control(world, track, 0), control(world, track, 1)], SIM_DT);
    flashbacks?.record(world);
    world.events.length = 0;
  }
}

/** What App.start() does with ?quick=… */
function quickStartFrom(search: string): ReturnType<typeof buildQuickStart> {
  const params = parseQuickStart(search, hasLayout);
  if (!params) throw new Error(`not a quick-start URL: ${search}`);
  return buildQuickStart(params);
}

function expectFiniteWorld(world: WorldState): void {
  for (const c of world.cars) {
    const p = c.phys;
    for (const v of [p.x, p.y, p.z, p.yaw, p.vx, p.vz, p.speed, p.rpm, p.tire.wear, p.tire.temp, p.fuelKg, p.ers.charge, c.timing.progress]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  }
  expect(Number.isFinite(world.time)).toBe(true);
}

function expectFiniteFrame(frame: RenderFrame, carCount: number): void {
  expect(frame.cars.length).toBe(carCount);
  for (const c of frame.cars) {
    for (const v of [c.x, c.y, c.z, c.yaw, c.pitch, c.roll, c.speed, c.steerAngle, c.wheelSpin, c.rpm, c.slip, c.lockup, c.impact]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  }
  expect(frame.startLights.lit).toBeGreaterThanOrEqual(0);
  expect(frame.startLights.lit).toBeLessThanOrEqual(5);
}

function expectStandings(world: WorldState): void {
  const rows = getStandings(world);
  expect(rows.length).toBe(world.cars.length);
  expect(rows.map((r) => r.position).sort((a, b) => a - b)).toEqual(world.cars.map((_, i) => i + 1));
  expect(new Set(rows.map((r) => r.carId)).size).toBe(world.cars.length);
}

function expectResult(world: WorldState, kind: SessionKind): void {
  const result = buildSessionResult(world);
  expect(result.kind).toBe(kind);
  expect(result.layoutId).toBe(world.config.layoutId);
  expect(result.rows.length).toBe(world.cars.length);
  expect(result.rows.map((r) => r.position).sort((a, b) => a - b)).toEqual(world.cars.map((_, i) => i + 1));
  for (const r of result.rows) {
    expect(typeof r.gapText).toBe('string');
    expect(r.gapText.length).toBeGreaterThan(0);
    expect(Number.isFinite(r.points)).toBe(true);
  }
  expect(() => structuredClone(result)).not.toThrow();
}

function gpRequest(kind: SessionKind, layoutId: string, patch: Partial<SessionRequest> = {}): SessionRequest {
  return {
    mode: 'grandPrix',
    kind,
    layoutId,
    raceLaps: 3,
    weather: 'clear',
    timeOfDay: 'auto',
    regulation: '2025',
    aiDifficulty: 90,
    qualifying: 'oneShot',
    // the App flow checks run without random race-control incidents
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed: 20251003,
    players: [{ playerIndex: 0, driverId: 'hsu', teamId: 'nordlys', ...PLAYER }],
    roster: standardRoster(),
    aiCount: null,
    gridOrder: null,
    playerStartPosition: null,
    ghost: null,
    objective: null,
    ...patch,
  };
}

/** Full App flow for one config: world, 30 s of frames (null input, then scripted), views, frame, standings, text. */
function exerciseSession(config: SessionConfig, seconds = 30): { world: WorldState; track: BuiltTrack; events: GameEvent[] } {
  expect(validateSessionConfig(config)).toEqual([]);
  const track = getLayout(config.layoutId);
  const world = createWorld(config, track);
  const humans = playerCarIds(world);
  expect(humans.length).toBe(config.players.length);
  const { views, hudViews } = buildViews(humans, 'chase');
  expect(views.length).toBe(Math.max(1, Math.min(2, humans.length)));
  expect(hudViews.map((v) => v.carId)).toEqual(views.map((v) => v.carId));
  const cars = sceneCarsFor(world);
  expect(cars.map((c) => c.carId)).toEqual(world.cars.map((c) => c.id));

  const events = runFrames(world, track, seconds, scripted(seconds / 3));
  expect(world.time).toBeCloseTo(seconds, 1);
  expect(world.events.length).toBe(0);
  expectFiniteWorld(world);
  const ghost = world.config.ghost && world.config.ghost.layoutId === track.id && config.kind === 'timeTrial' ? 1 : 0;
  expectFiniteFrame(buildRenderFrame(world, track), world.cars.length + ghost);
  expectStandings(world);
  const text = buildTextState({ screen: 'session', menuOpen: false, paused: false, world, track, viewCarId: views[0]!.carId, replay: null });
  expect(() => JSON.parse(JSON.stringify(text))).not.toThrow();
  expect((text.player as { carId: number }).carId).toBe(views[0]!.carId);
  return { world, track, events };
}

/** End a non-race session from the pause menu and classify it. */
function endAndClassify(world: WorldState, track: BuiltTrack, kind: SessionKind): void {
  endSession(world);
  stepWorld(world, track, [null, null], SIM_DT);
  expect(isSessionOver(world)).toBe(true);
  expectResult(world, kind);
}

describe('every mode / kind runs through the App flow', () => {
  test('grand prix race (20 cars): lights, launch with scripted throttle, standings, mid-race and final results', () => {
    const config = buildSessionConfig(gpRequest('race', 'porto-lumen'));
    expect(config.grid.length).toBe(20);
    const { world, track, events } = exerciseSession(config);
    const types = new Set(events.map((e) => e.type));
    expect(types.has('lightsOn')).toBe(true);
    expect(types.has('lightsOut')).toBe(true);
    expect(world.session.phase).toBe('running');
    const player = world.cars[getPlayerCarId(world, 0)]!;
    expect(player.phys.speed).toBeGreaterThan(5);
    expect(player.timing.progress).toBeGreaterThan(0);
    expectResult(world, 'race');
    // the pit-request path the HUD / Box key uses
    requestPit(world, player.id, 'hard');
    expect(player.pit.requested).toBe(true);
    // retire from the pause menu: the race runs on; the fast-forward fallback then classifies the rest
    retireCar(world, player.id, '車手退賽');
    expect(isSessionOver(world)).toBe(false);
    concludeRace(world, track);
    expect(isSessionOver(world)).toBe(true);
    const result = buildSessionResult(world);
    expect(result.rows.find((r) => r.carId === player.id)?.status).toBe('retired');
    expect(result.rows.filter((r) => r.status === 'finished').length).toBe(19);
  });

  test('grand prix qualifying (2026 rules, reverse layout)', () => {
    const config = buildSessionConfig(gpRequest('qualifying', 'mirage-sands-rev', { regulation: '2026' }));
    expect(config.timeLimit).not.toBeNull();
    const { world, track } = exerciseSession(config);
    expect(world.session.timeRemaining).not.toBeNull();
    endAndClassify(world, track, 'qualifying');
  });

  test('grand prix practice in the rain', () => {
    const config = buildSessionConfig(gpRequest('practice', 'highland-ridge', { weather: 'lightRain' }));
    const { world, track } = exerciseSession(config);
    expect(world.weather.rain).toBeGreaterThan(0);
    endAndClassify(world, track, 'practice');
  });

  test('time trial: a lap yields a ghost that the next run renders as car -1', () => {
    const { config } = buildQuickStart({ kind: 'tt', layoutId: 'koyo-hills', seed: 7 });
    expect(config.kind).toBe('timeTrial');
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const playerId = getPlayerCarId(world, 0);
    const drive = scripted(0);
    for (let i = 0; i < 300 && world.cars[playerId]!.timing.bestLap === null; i++) runFrames(world, track, 1, drive);
    expect(world.cars[playerId]!.timing.bestLap).not.toBeNull();
    expect(isSessionOver(world)).toBe(false);
    endAndClassify(world, track, 'timeTrial');
    const ghost = extractGhost(world, playerId);
    expect(ghost).not.toBeNull();
    expect(ghost!.layoutId).toBe('koyo-hills');

    const withGhost = exerciseSession({ ...config, ghost }, 25);
    const frame = buildRenderFrame(withGhost.world, withGhost.track);
    const g = frame.cars.find((c) => c.carId === -1);
    expect(g?.ghost).toBe(true);
    expect(g?.visible).toBe(true);
    endAndClassify(withGhost.world, withGhost.track, 'timeTrial');
  });

  test('driver career round (race)', () => {
    const career = createCareer(IDENTITY, 'kestrel', DEFAULT_SEASON_SETTINGS, 11, LAYOUTS);
    const round = careerRequest(career, 'race', 50, PLAYER, null);
    expect(round).not.toBeNull();
    const config = buildSessionConfig(round!);
    expect(config.mode).toBe('career');
    expect(config.drivers.some((d) => d.id === 'player')).toBe(true);
    const { world } = exerciseSession(config);
    expectResult(world, 'race');
  });

  test('my team weekend: qualifying then race with the 11th team', () => {
    const mate = reserveDrivers()[0]!;
    const team = createMyTeam(
      {
        name: '新星測試車隊',
        shortName: 'NTS',
        livery: { primary: '#2266ff', secondary: '#ffffff', accent: '#ff3300', pattern: 'chevron' },
        powerUnit: 'Helion',
        identity: IDENTITY,
        teammateId: mate.id,
        settings: DEFAULT_SEASON_SETTINGS,
      },
      5,
      LAYOUTS,
    );
    const quali = buildSessionConfig(myTeamRequest(team, 'qualifying', 50, PLAYER, null)!);
    const q = exerciseSession(quali);
    endAndClassify(q.world, q.track, 'qualifying');
    const race = buildSessionConfig(myTeamRequest(team, 'race', 50, PLAYER, null)!);
    expect(race.teams.length).toBe(11);
    expect(race.grid.length).toBe(22);
    const { world } = exerciseSession(race);
    expect(new Set(world.cars.map((c) => c.pit.boxS)).size).toBe(11);
    expectResult(world, 'race');
  });

  test('story chapter and challenge (objective carried into the result)', () => {
    for (const entry of [STORY_CHAPTERS[0]!, STORY_CHALLENGES[0]!]) {
      const track = getLayout(entry.session.layoutId);
      const objective = resolveObjective(entry.objective, track.referenceLapTime);
      const config = buildSessionConfig(storyRequest(entry, objective, PLAYER, 99));
      expect(config.mode).toBe('story');
      expect(config.objective?.kind).toBe(entry.objective.kind);
      const { world } = exerciseSession(config, 20);
      if (config.kind !== 'race') endAndClassify(world, track, config.kind);
      expect(buildSessionResult(world).objectiveMet).not.toBeNull();
    }
  });

  test('split-screen race: two human cars, two half-screen views, both driven', () => {
    const { config, ctx } = buildQuickStart({ kind: 'split', layoutId: 'isola-verde', seed: 3 });
    expect(ctx.returnTo).toBe('splitScreen');
    expect(config.players.length).toBe(2);
    const { world } = exerciseSession(config);
    const ids = playerCarIds(world);
    expect(ids.length).toBe(2);
    const { views, hudViews } = buildViews(ids, 'chase');
    expect(views.map((v) => v.viewport.w)).toEqual([0.5, 0.5]);
    expect(hudViews.map((v) => v.region)).toEqual(['left', 'right']);
    for (const id of ids) expect(world.cars[id]!.timing.progress).toBeGreaterThan(0);
    expectResult(world, 'race');
  });

  test('URL quick starts for every kind build startable sessions', () => {
    for (const quick of ['race', 'quali', 'practice', 'tt', 'split']) {
      const { config } = quickStartFrom(`?quick=${quick}&layout=highland-ridge-rev&laps=2&weather=overcast&reg=2026&ai=40`);
      expect(config.layoutId).toBe('highland-ridge-rev');
      expect(config.regulation).toBe('2026');
      if (config.kind !== 'timeTrial') expect(config.weather).toBe('overcast');
      if (config.kind === 'race') expect(config.laps).toBe(2);
      const track = getLayout(config.layoutId);
      const world = createWorld(config, track);
      runFrames(world, track, 3, scripted(0));
      expectFiniteWorld(world);
      expectStandings(world);
    }
  });
});

describe('flashback', () => {
  test('rewinding 5 s and replaying the same inputs reproduces the original timeline exactly', () => {
    const config = buildSessionConfig(gpRequest('race', 'isola-verde', { seed: 77 }));
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const flashbacks = new FlashbackBuffer();
    const drive = scripted(9);
    runSteps(world, track, Math.round(14 / SIM_DT), drive, flashbacks);
    const reference = snapshotWorld(world);
    expect(flashbacks.size).toBeGreaterThan(20);
    expect(flashbacks.oldestTime).toBeLessThan(world.time - 5);

    const used = world.flashbacksUsed;
    const restored = flashbacks.rewind(world.time, 5);
    expect(restored).not.toBeNull();
    const rewound = restored!;
    rewound.flashbacksUsed = used + 1;
    expect(rewound.time).toBeLessThanOrEqual(world.time - 5 + 1e-6);
    expect(rewound.time).toBeGreaterThan(world.time - 5.6);
    expect(rewound.events.length).toBe(0);
    expect(flashbacksLeft(rewound.config.rules, rewound.flashbacksUsed)).toBe(-1);

    // same inputs from the restored point → identical state at the original time
    runSteps(rewound, track, reference.tick - rewound.tick, drive);
    expect(rewound.tick).toBe(reference.tick);
    const strip = (w: WorldState): unknown => ({ ...w, events: [], flashbacksUsed: 0 });
    expect(JSON.stringify(strip(rewound))).toBe(JSON.stringify(strip(reference)));
  });

  test('the rewound world is independent of the buffer (a second rewind still works)', () => {
    const config = buildSessionConfig(gpRequest('practice', 'porto-lumen'));
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const flashbacks = new FlashbackBuffer();
    runFrames(world, track, 12, scripted(0), { flashbacks });
    const first = flashbacks.rewind(world.time, 5)!;
    const t0 = first.time;
    runFrames(first, track, 3, scripted(0), { flashbacks });
    const second = flashbacks.rewind(first.time, 5)!;
    expect(second.time).toBeLessThan(t0);
    expect(Number.isFinite(second.cars[0]!.phys.x)).toBe(true);
  });
});

describe('replay recording', () => {
  test('30 Hz frames of a race sample back to the recorded state and interpolate between them', () => {
    const config = buildSessionConfig(gpRequest('race', 'koyo-hills', { seed: 5 }));
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const recorder = new ReplayRecorder();
    const recorded: RenderFrame[] = [];
    runFrames(world, track, 20, scripted(8), { recorder, recorded });
    const clip = recorder.toClip();
    expect(clip.times.length).toBe(recorded.length);
    expect(clip.times.length).toBeGreaterThan(590);
    expect(clip.times.length).toBeLessThan(610);
    for (let i = 1; i < clip.times.length; i++) expect(clip.times[i]!).toBeGreaterThan(clip.times[i - 1]!);

    for (const k of [0, 100, 350, clip.times.length - 1]) {
      const original = recorded[k]!;
      const sampled = sampleClip(clip, clip.times[k]!)!;
      expect(sampled.cars.length).toBe(original.cars.length);
      for (let i = 0; i < original.cars.length; i++) {
        const a = original.cars[i]!;
        const b = sampled.cars[i]!;
        expect(b.carId).toBe(a.carId);
        expect(Math.abs(b.x - a.x)).toBeLessThan(1e-3 * Math.max(1, Math.abs(a.x)));
        expect(Math.abs(b.z - a.z)).toBeLessThan(1e-3 * Math.max(1, Math.abs(a.z)));
        expect(b.gear).toBe(a.gear);
        expect(b.compound).toBe(a.compound);
        expect(b.visible).toBe(a.visible);
      }
      expect(sampled.startLights).toEqual(original.startLights);
    }
    // halfway between two frames: positions between the neighbours
    const mid = sampleClip(clip, (clip.times[400]! + clip.times[401]!) / 2)!;
    const a = recorded[400]!.cars[3]!;
    const b = recorded[401]!.cars[3]!;
    expect(mid.cars[3]!.x).toBeCloseTo((a.x + b.x) / 2, 2);
    expect(mid.cars[3]!.z).toBeCloseTo((a.z + b.z) / 2, 2);

    // flashback truncates the recording to the restored time
    recorder.truncateAfter(clip.times[200]!);
    expect(recorder.lastTime).toBe(clip.times[200]!);
    expect(recorder.length).toBe(201);
  });
});
