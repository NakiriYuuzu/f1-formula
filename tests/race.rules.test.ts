/**
 * Race runtime rules and flows: start lights, pit-stop autopilot (phases, tyres, time loss), track-limit
 * warnings / penalties via a scripted corner-cutting driver, DRS rules (lap 3, 1 s detection, wet disable,
 * 2026 straight mode), determinism and snapshots, qualifying simulation, time-trial ghost, results and points,
 * the mandatory stop, session end per kind and the public helper API.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildRenderFrame,
  buildSessionResult,
  cancelPit,
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
  setErsMode,
  simulateLapTimes,
  snapshotWorld,
  stepWorld,
  MANDATORY_STOP_PENALTY,
  TRACK_LIMIT_PENALTY,
} from '../src/race/index';
import { computeAIInput, steerToward } from '../src/ai/index';
import { updateClassification } from '../src/race/classification';
import { finishCar } from '../src/race/session';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, POINTS_TABLE, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { inRangeS, sampleAt } from '../src/track/track';
import type {
  BuiltTrack,
  ControlInput,
  GameEvent,
  GhostData,
  PitPhase,
  SessionConfig,
  SessionKind,
  StoryObjective,
  TireCompound,
  WeatherKind,
  WorldState,
} from '../src/core/types';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

interface ConfigOptions {
  kind?: SessionKind;
  laps?: number;
  weather?: WeatherKind;
  regulation?: '2025' | '2026';
  seed?: number;
  /** driver ids on the grid in order (default: the whole roster, strongest teams first) */
  grid?: string[];
  /** driver id driven by player 0 */
  human?: string;
  timeLimit?: number | null;
  qualifyingLaps?: number;
  compound?: TireCompound;
  mandatory?: boolean;
  objective?: StoryObjective | null;
  ghost?: GhostData | null;
  difficulty?: number;
}

function config(layoutId: string, o: ConfigOptions = {}): SessionConfig {
  const kind = o.kind ?? 'race';
  const ids = o.grid ?? RACERS.map((d) => d.id);
  const human = o.human ?? null;
  const team = (id: string): string => RACERS.find((d) => d.id === id)?.teamId ?? '';
  return {
    mode: kind === 'timeTrial' ? 'timeTrial' : 'grandPrix',
    kind,
    layoutId,
    laps: o.laps ?? 3,
    timeLimit: o.timeLimit ?? (kind === 'practice' || kind === 'qualifying' ? 600 : null),
    qualifyingLaps: o.qualifyingLaps ?? (kind === 'qualifying' ? 1 : 0),
    weather: o.weather ?? 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: o.regulation ?? '2025',
    aiDifficulty: o.difficulty ?? 90,
    players: human
      ? [{ playerIndex: 0, driverId: human, teamId: team(human), setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } }]
      : [],
    grid: ids.map((id) => ({
      driverId: id,
      teamId: team(id),
      playerIndex: id === human ? 0 : -1,
      startCompound: o.compound ?? 'medium',
    })),
    teams: TEAMS,
    drivers: RACERS,
    rules: {
      ...DEFAULT_RULES,
      // race-control incidents are covered by racecontrol.test.ts
      safetyCar: 'off',
      mandatoryPitStop: o.mandatory ?? false,
      ...(kind === 'timeTrial' ? { tyreWear: false, fuel: false, damage: 'off' as const, collisions: false } : {}),
    },
    seed: o.seed ?? 11,
    ghost: o.ghost ?? null,
    objective: o.objective ?? null,
  };
}

/** Scripted human driver: the AI controller drives the player's car (deterministic). */
function autopilot(world: WorldState, track: BuiltTrack): (ControlInput | null)[] {
  const id = getPlayerCarId(world, 0);
  return id < 0 ? [] : [computeAIInput(world, world.cars[id], track, SIM_DT)];
}

interface Run {
  events: GameEvent[];
}

function run(
  world: WorldState,
  track: BuiltTrack,
  maxTime: number,
  opts: { inputs?: (w: WorldState) => (ControlInput | null)[]; each?: (w: WorldState) => void; until?: (w: WorldState) => boolean } = {},
): Run {
  const events: GameEvent[] = [];
  while (!isSessionOver(world) && world.time < maxTime && !(opts.until?.(world) ?? false)) {
    stepWorld(world, track, opts.inputs ? opts.inputs(world) : [], SIM_DT);
    for (const e of world.events) if (e.type !== 'shift') events.push(e);
    world.events.length = 0;
    opts.each?.(world);
  }
  return { events };
}

const ofType = <T extends GameEvent['type']>(events: GameEvent[], type: T): Extract<GameEvent, { type: T }>[] =>
  events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

describe('race start', () => {
  test('pre → five lights one second apart → random hold → lights out; cars held until then', () => {
    const track = getLayout('porto-lumen');
    const world = createWorld(config('porto-lumen'), track);
    expect(world.session.phase).toBe('pre');
    expect(world.cars.every((c) => c.status === 'grid' && c.phys.gear === 0)).toBe(true);
    const progress0 = world.cars.map((c) => c.timing.progress);
    let outAt = -1;
    const phases = new Set<string>();
    run(world, track, 15, {
      each: (w) => {
        phases.add(w.session.phase);
        if (outAt < 0 && w.session.phase !== 'running') {
          for (const c of w.cars) expect(c.phys.speed).toBe(0);
        }
      },
      until: (w) => {
        if (w.session.phase === 'running' && outAt < 0) outAt = w.time;
        return outAt > 0 && w.time > outAt + 0.5;
      },
    });
    expect(phases.has('pre')).toBe(true);
    expect(phases.has('lights')).toBe(true);
    expect(outAt).toBeGreaterThan(0);
    expect(world.session.startTime).not.toBeNull();
    const start = world.race.lightsStart;
    const hold = (world.session.startTime ?? 0) - (start + 4);
    expect(hold).toBeGreaterThanOrEqual(0.5 - SIM_DT);
    expect(hold).toBeLessThanOrEqual(2.5 + SIM_DT);
    expect(world.cars.every((c) => c.timing.lap === 1)).toBe(true);
    // grid: staggered columns 8 m apart behind the line, pole away from the pit lane
    expect(progress0[0]).toBeCloseTo(-8, 1);
    expect(progress0[1]).toBeCloseTo(-16, 1);
    const pole = createWorld(config('porto-lumen'), track).cars[0];
    expect(Math.sign(pole.phys.lateral)).toBe(-track.pit.side);
  });

  test('lights events are emitted in order with the counts 1..5, then lightsOut', () => {
    const track = getLayout('isola-verde');
    const world = createWorld(config('isola-verde'), track);
    const { events } = run(world, track, 12);
    const seq = events.filter((e) => e.type === 'lightsOn' || e.type === 'lightsOut');
    expect(seq.map((e) => (e.type === 'lightsOn' ? e.count : 0))).toEqual([1, 2, 3, 4, 5, 0]);
  });
});

describe('pit stops', () => {
  const soloRace = (layoutId: string, pit: boolean): { world: WorldState; phases: PitPhase[]; events: GameEvent[]; maxLaneSpeed: number } => {
    const track = getLayout(layoutId);
    const world = createWorld(config(layoutId, { grid: ['varga'], laps: 3 }), track);
    const phases: PitPhase[] = [];
    let maxLaneSpeed = 0;
    const { events } = run(world, track, 600, {
      each: (w) => {
        const c = w.cars[0];
        if (pit && c.timing.lap === 2 && c.pit.stops === 0 && !c.pit.requested && c.pit.phase === 'none') requestPit(w, 0, 'soft');
        if (phases[phases.length - 1] !== c.pit.phase) phases.push(c.pit.phase);
        if (c.pit.phase === 'lane' || c.pit.phase === 'stopped') maxLaneSpeed = Math.max(maxLaneSpeed, c.phys.speed);
      },
    });
    return { world, phases, events, maxLaneSpeed };
  };

  test(
    'autopilot flow, tyre change and a time loss of 18–32 s',
    () => {
      for (const id of ['porto-lumen', 'highland-ridge-rev']) {
        const clean = soloRace(id, false);
        const stop = soloRace(id, true);
        const car = stop.world.cars[0];
        expect(stop.phases).toEqual(['none', 'entry', 'lane', 'stopped', 'lane', 'exit', 'none']);
        expect(car.pit.stops).toBe(1);
        expect(car.phys.tire.compound).toBe('soft');
        expect(car.status).toBe('finished');
        expect(stop.maxLaneSpeed).toBeLessThanOrEqual(80 / 3.6 + 0.05);
        const order = stop.events
          .filter((e) => e.type === 'pitRequested' || e.type === 'pitEntry' || e.type === 'pitStop' || e.type === 'pitExit')
          .map((e) => e.type);
        expect(order).toEqual(['pitRequested', 'pitEntry', 'pitStop', 'pitExit']);
        const pitStop = ofType(stop.events, 'pitStop')[0];
        expect(pitStop.duration).toBeGreaterThanOrEqual(2);
        expect(pitStop.duration).toBeLessThanOrEqual(3.5);
        const t0 = clean.world.cars[0].timing.finishTime ?? NaN;
        const t1 = car.timing.finishTime ?? NaN;
        const loss = t1 - t0;
        expect(loss).toBeGreaterThan(18);
        expect(loss).toBeLessThan(32);
      }
    },
    30_000,
  );

  test(
    'every damaged part is repaired at the stop (full time from 30 % damage, less for lighter damage)',
    () => {
      const track = getLayout('porto-lumen');
      const world = createWorld(config('porto-lumen', { grid: ['varga'], laps: 3 }), track);
      const { events } = run(world, track, 600, {
        each: (w) => {
          const c = w.cars[0];
          if (c.timing.lap === 2 && c.pit.stops === 0 && !c.pit.requested && c.pit.phase === 'none') requestPit(w, 0, 'soft');
          // damaged on the way to the box (the lane is kinematic, the damage does not change the drive there)
          if (c.pit.phase === 'lane' && c.pit.stops === 0) {
            c.phys.damage.rearWing = 0.5;
            c.phys.damage.floor = 0.15;
            c.race.reportedDamage[1] = 0.5;
          }
        },
      });
      const car = world.cars[0];
      expect(car.pit.stops).toBe(1);
      expect(car.phys.damage).toEqual({ frontWing: 0, rearWing: 0, floor: 0 });
      expect(car.race.reportedDamage).toEqual([0, 0, 0]);
      // rear wing 8 s (≥ 30 %) + floor 10 s × 0.15 / 0.3 = 13 s on top of the 2.0–3.5 s service
      const stop = ofType(events, 'pitStop')[0];
      expect(stop.duration).toBeGreaterThanOrEqual(15 - 1e-6);
      expect(stop.duration).toBeLessThanOrEqual(16.5 + 1e-6);
    },
    30_000,
  );

  test('requestPit / cancelPit and time trial ignores pit requests', () => {
    const track = getLayout('koyo-hills');
    const world = createWorld(config('koyo-hills', { grid: ['varga', 'morioka'] }), track);
    requestPit(world, 1, 'hard');
    expect(world.cars[1].pit.requested).toBe(true);
    expect(world.cars[1].pit.nextCompound).toBe('hard');
    expect(world.events.some((e) => e.type === 'pitRequested' && e.carId === 1 && e.compound === 'hard')).toBe(true);
    cancelPit(world, 1);
    expect(world.cars[1].pit.requested).toBe(false);
    requestPit(world, 99, 'soft');
    requestPit(world, -1, 'soft');
    const tt = createWorld(config('koyo-hills', { kind: 'timeTrial', grid: ['hsu'], human: 'hsu' }), track);
    requestPit(tt, 0, 'soft');
    expect(tt.cars[0].pit.requested).toBe(false);
  });
});

describe('track limits', () => {
  /** Drives the player's car normally but aims well beyond the inside kerb around every apex. */
  const cutter = (track: BuiltTrack) => (w: WorldState): (ControlInput | null)[] => {
    const car = w.cars[getPlayerCarId(w, 0)];
    const input = computeAIInput(w, car, track, SIM_DT);
    for (const c of track.corners) {
      const d = (((c.apexS - car.phys.s) % track.length) + track.length) % track.length;
      if (d < 45 || d > track.length - 12) {
        const hw = sampleAt(track, track.halfWidth, c.apexS);
        const kerb = sampleAt(track, c.direction > 0 ? track.kerbRight : track.kerbLeft, c.apexS);
        return [{ ...input, steer: steerToward(car, track, c.direction * (hw + kerb + 3), 22) }];
      }
    }
    return [input];
  };

  test(
    'race: warnings 1–3 invalidate laps, every further offence adds +5 s',
    () => {
      const track = getLayout('koyo-hills');
      const world = createWorld(config('koyo-hills', { grid: ['hsu'], human: 'hsu', laps: 2 }), track);
      const { events } = run(world, track, 500, { inputs: cutter(track) });
      const warnings = ofType(events, 'trackLimits').map((e) => e.warnings);
      expect(warnings.length).toBeGreaterThanOrEqual(5);
      expect(warnings.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
      const penalties = ofType(events, 'penalty');
      expect(penalties.length).toBe(warnings.length - 3);
      expect(penalties.every((p) => p.seconds === TRACK_LIMIT_PENALTY && p.carId === 0)).toBe(true);
      const car = world.cars[0];
      expect(car.penalties.trackLimitWarnings).toBe(warnings.length);
      expect(car.penalties.timeSec).toBe(TRACK_LIMIT_PENALTY * (warnings.length - 3));
      expect(car.penalties.log.length).toBe(penalties.length);
      const laps = ofType(events, 'lapComplete');
      expect(laps.length).toBeGreaterThan(0);
      expect(laps.every((l) => !l.valid)).toBe(true);
      const row = buildSessionResult(world).rows[0];
      expect(row.penaltySec).toBe(car.penalties.timeSec);
    },
    30_000,
  );

  test(
    'qualifying: a cut lap does not count; clean laps do',
    () => {
      const track = getLayout('isola-verde');
      const cut = createWorld(config('isola-verde', { kind: 'qualifying', grid: ['hsu'], human: 'hsu', qualifyingLaps: 1 }), track);
      const a = run(cut, track, 400, { inputs: cutter(track) });
      expect(isSessionOver(cut)).toBe(true);
      expect(ofType(a.events, 'lapComplete').every((l) => !l.valid)).toBe(true);
      expect(cut.cars[0].timing.bestLap).toBeNull();
      expect(cut.cars[0].penalties.timeSec).toBe(0);
      expect(buildSessionResult(cut).rows[0].gapText).toBe('無成績');

      const clean = createWorld(config('isola-verde', { kind: 'qualifying', grid: ['hsu'], human: 'hsu', qualifyingLaps: 1 }), track);
      run(clean, track, 400, { inputs: (w) => autopilot(w, track) });
      expect(isSessionOver(clean)).toBe(true);
      const best = clean.cars[0].timing.bestLap ?? NaN;
      expect(best / track.referenceLapTime).toBeGreaterThan(0.95);
      expect(best / track.referenceLapTime).toBeLessThan(1.15);
      expect(clean.cars[0].status).toBe('finished');
    },
    30_000,
  );
});

describe('DRS rules', () => {
  test(
    'race: closed before the leader starts lap 3, then only within 1.0 s of the car ahead at detection',
    () => {
      const track = getLayout('mirage-sands');
      const world = createWorld(config('mirage-sands', { laps: 3 }), track);
      let availableSteps = 0;
      let enabledEvents = 0;
      run(world, track, 600, {
        each: (w) => {
          for (const e of w.events) if (e.type === 'drsEnabled') enabledEvents++;
          if (w.session.leaderLap < 3) {
            expect(w.session.drsEnabled).toBe(false);
            expect(w.cars.every((c) => !c.phys.drs.available)).toBe(true);
            return;
          }
          for (const c of w.cars) {
            if (!c.phys.drs.available) continue;
            availableSteps++;
            const z = c.race.drsZone;
            expect(z).toBeGreaterThanOrEqual(0);
            const zone = track.drsZones[z];
            expect(inRangeS(track, c.phys.s, zone.activation, zone.end)).toBe(true);
            const mine = c.race.drsDetTimes[z];
            const within = w.cars.some((o) => o !== c && o.race.drsDetTimes[z] < mine && mine - o.race.drsDetTimes[z] <= 1.0);
            expect(within).toBe(true);
          }
        },
      });
      expect(availableSteps).toBeGreaterThan(100);
      expect(world.session.drsEnabled || isSessionOver(world)).toBe(true);
    },
    30_000,
  );

  test('practice: zones always available in the dry, never with wetness > 0.4', () => {
    const track = getLayout('mirage-sands');
    const check = (weather: WeatherKind): number => {
      const world = createWorld(config('mirage-sands', { kind: 'practice', grid: ['hsu'], human: 'hsu', weather, compound: weather === 'clear' ? 'soft' : 'wet' }), track);
      let available = 0;
      run(world, track, 70, {
        inputs: (w) => autopilot(w, track),
        each: (w) => {
          if (w.cars[0].phys.drs.available) available++;
        },
      });
      return available;
    };
    expect(check('clear')).toBeGreaterThan(200);
    expect(check('heavyRain')).toBe(0);
  });

  test('2026: straight mode is available to everyone in the zones from lap 1', () => {
    const track = getLayout('mirage-sands');
    const world = createWorld(config('mirage-sands', { regulation: '2026', laps: 2 }), track);
    let available = 0;
    run(world, track, 70, {
      each: (w) => {
        for (const c of w.cars) if (c.phys.drs.available) available++;
      },
    });
    expect(world.session.leaderLap).toBe(1);
    expect(available).toBeGreaterThan(500);
  });
});

describe('determinism', () => {
  test(
    'same seed and inputs give identical worlds; a snapshot advanced in parallel stays identical',
    () => {
      const track = getLayout('koyo-hills');
      const cfg = config('koyo-hills', { human: 'hsu', laps: 2, seed: 77 });
      const a = createWorld(cfg, track);
      const b = createWorld(cfg, track);
      for (let i = 0; i < 120 * 25; i++) {
        stepWorld(a, track, autopilot(a, track), SIM_DT);
        stepWorld(b, track, autopilot(b, track), SIM_DT);
      }
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const snap = snapshotWorld(a);
      expect(snap).not.toBe(a);
      expect(snap.cars[0]).not.toBe(a.cars[0]);
      for (let i = 0; i < 120 * 15; i++) {
        stepWorld(a, track, autopilot(a, track), SIM_DT);
        stepWorld(snap, track, autopilot(snap, track), SIM_DT);
      }
      expect(JSON.stringify(snap)).toBe(JSON.stringify(a));
      // a different seed diverges
      const c = createWorld({ ...cfg, seed: 78 }, track);
      for (let i = 0; i < 120 * 25; i++) stepWorld(c, track, autopilot(c, track), SIM_DT);
      expect(JSON.stringify(c.cars.map((x) => x.phys.x))).not.toBe(JSON.stringify(b.cars.map((x) => x.phys.x)));
    },
    30_000,
  );
});

describe('qualifying simulation', () => {
  test('ordering, ranges, determinism, weather and difficulty', () => {
    const track = getLayout('highland-ridge');
    const cfg = config('highland-ridge', { kind: 'qualifying', human: 'hsu' });
    const times = simulateLapTimes(cfg, track);
    expect(times.hsu).toBeUndefined();
    expect(Object.keys(times)).toHaveLength(RACERS.length - 1);
    const ref = track.referenceLapTime;
    for (const t of Object.values(times)) {
      expect(t / ref).toBeGreaterThan(0.98);
      expect(t / ref).toBeLessThan(1.25);
    }
    const teamAvg = (teamId: string): number => {
      const ds = RACERS.filter((d) => d.teamId === teamId && times[d.id] !== undefined);
      return ds.reduce((sum, d) => sum + times[d.id], 0) / ds.length;
    };
    expect(teamAvg('vanta')).toBeLessThan(teamAvg('helix'));
    expect(teamAvg('helix')).toBeLessThan(teamAvg('corvid'));
    const fastest = Object.entries(times).sort((a, b) => a[1] - b[1])[0][0];
    expect(['vanta', 'aurora', 'kestrel']).toContain(RACERS.find((d) => d.id === fastest)?.teamId ?? '');
    expect(simulateLapTimes(cfg, track)).toEqual(times);
    const wet = simulateLapTimes({ ...cfg, weather: 'heavyRain' }, track);
    expect(wet.varga).toBeGreaterThan(times.varga * 1.05);
    const easy = simulateLapTimes({ ...cfg, aiDifficulty: 0 }, track);
    const hard = simulateLapTimes({ ...cfg, aiDifficulty: 110 }, track);
    expect(easy.varga).toBeGreaterThan(times.varga);
    expect(hard.varga).toBeLessThan(times.varga);
  });

  test(
    'simulated AI time matches what the AI achieves on a flying lap (±2.5 %)',
    () => {
      const track = getLayout('isola-verde');
      const cfg = config('isola-verde', { kind: 'qualifying', grid: ['marchand'], qualifyingLaps: 2, compound: 'soft' });
      const world = createWorld(cfg, track);
      run(world, track, 400);
      const actual = world.cars[0].timing.bestLap ?? NaN;
      const simulated = simulateLapTimes(cfg, track).marchand;
      expect(Math.abs(simulated / actual - 1)).toBeLessThan(0.025);
    },
    30_000,
  );
});

describe('time trial', () => {
  test(
    'best-lap ghost extraction and ghost playback in the render frame',
    () => {
      const track = getLayout('koyo-hills-rev');
      const world = createWorld(config('koyo-hills-rev', { kind: 'timeTrial', grid: ['hsu'], human: 'hsu' }), track);
      expect(world.session.phase).toBe('running');
      expect(world.session.timeRemaining).toBeNull();
      run(world, track, 400, { inputs: (w) => autopilot(w, track), until: (w) => w.cars[0].timing.lapsCompleted >= 2 });
      expect(isSessionOver(world)).toBe(false);
      endSession(world);
      expect(isSessionOver(world)).toBe(true);
      const car = world.cars[0];
      const ghost = extractGhost(world, car.id);
      expect(ghost).not.toBeNull();
      if (!ghost) return;
      expect(ghost.layoutId).toBe('koyo-hills-rev');
      expect(ghost.lapTime).toBe(car.timing.bestLap ?? NaN);
      expect(ghost.driverId).toBe('hsu');
      const n = ghost.samples.length / 4;
      expect(Number.isInteger(n)).toBe(true);
      expect(Math.abs(n - (Math.floor(ghost.lapTime / ghost.dt) + 1))).toBeLessThanOrEqual(1);
      expect(ghost.samples.every((v) => Number.isFinite(v))).toBe(true);
      // the ghost lap starts and ends on the control line
      const startDist = Math.hypot(ghost.samples[0] - track.px[0], ghost.samples[2] - track.pz[0]);
      const endDist = Math.hypot(ghost.samples[(n - 1) * 4] - track.px[0], ghost.samples[(n - 1) * 4 + 2] - track.pz[0]);
      expect(startDist).toBeLessThan(track.halfWidth[0] + 1);
      expect(endDist).toBeLessThan(10);
      expect(extractGhost(world, 5)).toBeNull();

      const replay = createWorld(config('koyo-hills-rev', { kind: 'timeTrial', grid: ['hsu'], human: 'hsu', ghost }), track);
      const before = buildRenderFrame(replay, track);
      expect(before.cars).toHaveLength(2);
      expect(before.cars[1].carId).toBe(-1);
      expect(before.cars[1].ghost).toBe(true);
      expect(before.cars[1].visible).toBe(false);
      run(replay, track, 60, { inputs: (w) => autopilot(w, track), until: (w) => w.cars[0].timing.lap >= 1 && w.cars[0].timing.currentLapTime > 10 });
      const frame = buildRenderFrame(replay, track);
      const g = frame.cars.find((c) => c.carId === -1);
      expect(g?.visible).toBe(true);
      expect(Number.isFinite(g?.x ?? NaN)).toBe(true);
      // the same driver and car: the ghost runs close to the live car
      const live = frame.cars[0];
      expect(Math.hypot((g?.x ?? 0) - live.x, (g?.z ?? 0) - live.z)).toBeLessThan(40);
    },
    30_000,
  );
});

describe('results', () => {
  test(
    'classification, points, gap texts, retirement, fastest lap and story objective',
    () => {
      const track = getLayout('isola-verde');
      const grid = RACERS.map((d) => d.id);
      const objective: StoryObjective = { kind: 'finishAtOrAbove', value: 20, text: '完賽即可' };
      const world = createWorld(config('isola-verde', { laps: 2, grid, human: grid[9], objective }), track);
      expect(getPlayerCarId(world, 0)).toBe(9);
      expect(getPlayerCarId(world, 1)).toBe(-1);
      expect(playerCarIds(world)).toEqual([9]);
      let retired = false;
      const { events } = run(world, track, 900, {
        inputs: (w) => autopilot(w, track),
        each: (w) => {
          if (!retired && w.time > 40) {
            retired = true;
            retireCar(w, 19, '引擎故障');
          }
        },
      });
      expect(isSessionOver(world)).toBe(true);
      expect(ofType(events, 'retired')).toEqual([{ type: 'retired', carId: 19, reason: '引擎故障' }]);
      const result = buildSessionResult(world);
      expect(result.kind).toBe('race');
      expect(result.layoutId).toBe('isola-verde');
      expect(result.rows).toHaveLength(20);
      expect(result.rows.map((r) => r.position)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      const last = result.rows[19];
      expect(last.carId).toBe(19);
      expect(last.status).toBe('retired');
      expect(last.gapText).toBe('退賽');
      expect(last.points).toBe(0);
      for (let i = 0; i < 19; i++) {
        const row = result.rows[i];
        expect(row.points).toBe(POINTS_TABLE[i] ?? 0);
        expect(row.status).toBe('finished');
        if (i === 0) expect(row.gapText).toMatch(/^\d+:\d{2}\.\d{3}$/);
        else expect(row.gapText).toMatch(/^(\+\d+\.\d{3}|\+\d+ 圈)$/);
        expect(row.time).not.toBeNull();
        if (i > 0) expect(row.time ?? 0).toBeGreaterThanOrEqual(result.rows[i - 1].time ?? 0);
      }
      expect(result.rows.filter((r) => r.fastestLap)).toHaveLength(1);
      expect(result.fastestLap?.carId).toBe(result.rows.find((r) => r.fastestLap)?.carId ?? -2);
      expect(result.objectiveMet).toBe(true);
      expect(new Set(result.rows.map((r) => r.gridPosition)).size).toBe(20);
      const standings = getStandings(world);
      expect(standings).toHaveLength(20);
      expect(standings.find((s) => s.carId === 9)?.isPlayer).toBe(true);
    },
    30_000,
  );

  test('timed session result: best laps, gaps and no points', () => {
    const track = getLayout('porto-lumen');
    const world = createWorld(config('porto-lumen', { kind: 'practice', grid: ['hsu', 'dahl'], human: 'hsu', timeLimit: 200 }), track);
    run(world, track, 600, { inputs: (w) => autopilot(w, track) });
    expect(isSessionOver(world)).toBe(true);
    expect(world.session.chequeredAt).not.toBeNull();
    const result = buildSessionResult(world);
    expect(result.kind).toBe('practice');
    expect(result.rows.every((r) => r.points === 0)).toBe(true);
    const [p1, p2] = result.rows;
    expect(p1.time).toBe(p1.bestLap);
    expect(p1.gapText).toMatch(/^\d+:\d{2}\.\d{3}$/);
    if (p2.bestLap !== null) expect(p2.gapText).toMatch(/^\+\d+\.\d{3}$/);
  });

  test('finish positions rank laps first, then time incl. penalties (lapped car crossing first, penalised car)', () => {
    const track = getLayout('porto-lumen');
    const world = createWorld(config('porto-lumen', { laps: 6, grid: RACERS.slice(0, 4).map((d) => d.id) }), track);
    const s = world.session;
    s.phase = 'chequered';
    s.startTime = 0;
    s.chequeredAt = 500;
    world.time = 500;
    const [a, b, c, d] = world.cars;
    for (const car of world.cars) car.status = 'running';
    b.timing.lapsCompleted = 5;
    c.timing.lapsCompleted = 4;
    d.timing.lapsCompleted = 5;
    a.timing.lapsCompleted = 6;
    finishCar(world, a, 500);
    // lapped car crosses before two cars that will take the flag with more laps
    c.timing.lapsCompleted = 5;
    finishCar(world, c, 503);
    // b crosses after d, but d carries a 5 s penalty
    d.timing.lapsCompleted = 6;
    d.penalties.timeSec = 5;
    finishCar(world, d, 506);
    b.timing.lapsCompleted = 6;
    finishCar(world, b, 508);
    const finishedAt = new Map(ofType(world.events, 'carFinished').map((e) => [e.carId, e.position]));
    expect(finishedAt.get(a.id)).toBe(1);
    expect(finishedAt.get(c.id)).toBe(4);
    expect(finishedAt.get(b.id)).toBe(2);
    updateClassification(world, track);
    const result = buildSessionResult(world);
    expect(result.rows.map((r) => r.carId)).toEqual([a.id, b.id, d.id, c.id]);
    for (const row of result.rows) expect(world.cars[row.carId].timing.position).toBe(row.position);
  });

  test(
    'concludeRace: the field is classified at its projected finish; points only for classified finishers',
    () => {
      const track = getLayout('highland-ridge');
      const grid = RACERS.map((d) => d.id);
      const world = createWorld(config('highland-ridge', { laps: 20, grid, human: grid[3], mandatory: true }), track);
      run(world, track, 70);
      retireCar(world, 3, '車手退賽');
      expect(isSessionOver(world)).toBe(false);
      concludeRace(world, track);
      expect(isSessionOver(world)).toBe(true);
      const result = buildSessionResult(world);
      expect(result.rows.map((r) => r.position)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      const human = result.rows.find((r) => r.carId === 3);
      expect(human?.status).toBe('retired');
      expect(human?.points).toBe(0);
      const finished = result.rows.filter((r) => r.status === 'finished');
      expect(finished).toHaveLength(19);
      expect(finished[0]?.lapsCompleted).toBe(20);
      for (const row of result.rows) {
        expect(row.points).toBe(row.status === 'finished' ? (POINTS_TABLE[row.position - 1] ?? 0) : 0);
        // the projected mandatory stop is part of the time, not a penalty
        expect(row.penaltySec).toBe(0);
      }
      for (let i = 1; i < finished.length; i++) {
        const prev = finished[i - 1];
        const cur = finished[i];
        if (prev && cur && prev.lapsCompleted === cur.lapsCompleted) expect(cur.time ?? 0).toBeGreaterThanOrEqual(prev.time ?? 0);
      }
    },
    30_000,
  );

  test('an unfinished car gets no points, even inside the points positions', () => {
    const track = getLayout('isola-verde');
    const world = createWorld(config('isola-verde', { laps: 1, grid: RACERS.slice(0, 3).map((d) => d.id), human: RACERS[2].id }), track);
    // the human car never moves: the AI cars finish, it is still running when the chequered timeout ends the race
    run(world, track, 600);
    expect(isSessionOver(world)).toBe(true);
    const row = buildSessionResult(world).rows.find((r) => r.carId === 2);
    expect(row?.status).toBe('running');
    expect(row?.position).toBe(3);
    expect(row?.points).toBe(0);
  });
});

describe('mandatory pit stop', () => {
  test(
    'AI cars serve the two-compound stop; a car that never pits gets the penalty',
    () => {
      const track = getLayout('highland-ridge-rev');
      const grid = RACERS.map((d) => d.id).slice(0, 8);
      const world = createWorld(config('highland-ridge-rev', { laps: 3, grid, human: grid[7], mandatory: true }), track);
      const { events } = run(world, track, 900, { inputs: (w) => autopilot(w, track) });
      expect(isSessionOver(world)).toBe(true);
      const human = world.cars[7];
      expect(human.pit.stops).toBe(0);
      expect(human.penalties.timeSec).toBe(MANDATORY_STOP_PENALTY);
      expect(ofType(events, 'penalty').filter((p) => p.carId === 7)).toHaveLength(1);
      for (const c of world.cars.slice(0, 7)) {
        expect(c.pit.stops).toBeGreaterThanOrEqual(1);
        expect(c.race.usedCompounds.length).toBeGreaterThanOrEqual(2);
        expect(c.penalties.timeSec).toBe(0);
      }
    },
    30_000,
  );
});

describe('session end', () => {
  test(
    'qualifying ends after the timed laps; practice after the clock; time trial only on request',
    () => {
      const track = getLayout('mirage-sands-rev');
      const quali = createWorld(config('mirage-sands-rev', { kind: 'qualifying', grid: ['hsu'], human: 'hsu', qualifyingLaps: 1 }), track);
      const q = run(quali, track, 400, { inputs: (w) => autopilot(w, track) });
      expect(isSessionOver(quali)).toBe(true);
      expect(quali.cars[0].timing.lapsCompleted).toBe(1);
      expect(ofType(q.events, 'sessionEnd')).toHaveLength(1);
      expect(ofType(q.events, 'carFinished')).toHaveLength(1);

      const practice = createWorld(config('mirage-sands-rev', { kind: 'practice', grid: ['hsu'], human: 'hsu', timeLimit: 30 }), track);
      expect(practice.session.timeRemaining).toBe(30);
      const p = run(practice, track, 400, { inputs: (w) => autopilot(w, track) });
      expect(isSessionOver(practice)).toBe(true);
      expect(practice.session.timeRemaining).toBe(0);
      expect(ofType(p.events, 'chequered')).toHaveLength(1);

      const tt = createWorld(config('mirage-sands-rev', { kind: 'timeTrial', grid: ['hsu'], human: 'hsu' }), track);
      run(tt, track, 30, { inputs: (w) => autopilot(w, track) });
      expect(isSessionOver(tt)).toBe(false);
      endSession(tt);
      expect(isSessionOver(tt)).toBe(true);
    },
    30_000,
  );

  test('ERS mode and retirement helpers', () => {
    const track = getLayout('porto-lumen');
    const cfg = config('porto-lumen', { grid: ['hsu', 'dahl'], human: 'hsu' });
    cfg.players[0].assists = { ...DEFAULT_ASSISTS, ersAssist: false };
    const world = createWorld(cfg, track);
    setErsMode(world, 0, 'hotlap');
    expect(world.cars[0].phys.ers.mode).toBe('hotlap');
    setErsMode(world, 0, 'bogus' as never);
    expect(world.cars[0].phys.ers.mode).toBe('hotlap');
    retireCar(world, 1, '');
    expect(world.cars[1].status).toBe('retired');
    expect(world.events.some((e) => e.type === 'retired' && e.carId === 1)).toBe(true);
    retireCar(world, 0, '退賽');
    expect(isSessionOver(world)).toBe(true);
    const frame = buildRenderFrame(world, track);
    expect(frame.cars.every((c) => !c.visible)).toBe(true);
  });
});
