/**
 * Headless full-field races with the real track, physics, race runtime and AI: every layout (20 cars, 3 laps,
 * difficulty 90, dry), a heavy-rain race where slick starters change tyres, a 2026-regulation race and a
 * split-screen race whose two human cars never receive input. Checks completion, NaN-freedom, no stuck AI cars,
 * sane lap times and on-track overtakes.
 */
import { describe, expect, test } from 'bun:test';
import { createWorld, getStandings, isSessionOver, stepWorld } from '../src/race/index';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { angleDiff } from '../src/core/math';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { LAYOUTS, getLayout } from '../src/data/tracks/index';
import type { BuiltTrack, ControlInput, GameEvent, SessionConfig, TireCompound, WeatherKind, WorldState } from '../src/core/types';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Menu-like race grid: car strength + driver pace with a seeded jitter; seeded soft / medium start tyres. */
function raceConfig(layoutId: string, opts: { laps?: number; weather?: WeatherKind; regulation?: '2025' | '2026'; seed?: number } = {}): SessionConfig {
  const seed = opts.seed ?? 42;
  const strength = (id: string): number => {
    const d = RACERS.find((x) => x.id === id);
    const t = TEAMS.find((x) => x.id === d?.teamId);
    if (!d || !t) return 0;
    return (t.rating.aero + t.rating.power + t.rating.chassis) / 3 + d.skill.pace * 0.35 + (hash(`${id}${seed}`) - 0.5) * 0.04;
  };
  const order = RACERS.map((d) => d.id).sort((a, b) => strength(b) - strength(a));
  const weather = opts.weather ?? 'clear';
  return {
    mode: 'grandPrix',
    kind: 'race',
    layoutId,
    laps: opts.laps ?? 3,
    timeLimit: null,
    qualifyingLaps: 0,
    weather,
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: opts.regulation ?? '2025',
    aiDifficulty: 90,
    players: [],
    grid: order.map((id) => {
      const compound: TireCompound =
        weather === 'heavyRain' ? 'wet' : weather === 'lightRain' ? 'inter' : hash(`${id}tyre${seed}`) < 0.55 ? 'medium' : 'soft';
      return { driverId: id, teamId: RACERS.find((d) => d.id === id)?.teamId ?? '', playerIndex: -1, startCompound: compound };
    }),
    teams: TEAMS,
    drivers: RACERS,
    // baseline AI racing: no random incidents (race control has its own tests)
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed,
    ghost: null,
    objective: null,
  };
}

interface RaceRun {
  world: WorldState;
  events: GameEvent[];
  nan: boolean;
  /** longest continuous time (s) any running AI car spent below 1 m/s after lights out */
  maxStuck: number;
}

function finiteCar(world: WorldState): boolean {
  for (const c of world.cars) {
    const p = c.phys;
    const vals = [p.x, p.y, p.z, p.yaw, p.vx, p.vz, p.speed, p.rpm, p.fuelKg, p.tire.wear, p.tire.temp, p.ers.charge, c.timing.progress];
    if (vals.some((v) => !Number.isFinite(v))) return false;
  }
  return true;
}

function runRace(config: SessionConfig, track: BuiltTrack, maxTime: number, inputs: (ControlInput | null)[] = []): RaceRun {
  const world = createWorld(config, track);
  const events: GameEvent[] = [];
  const stuck = new Map<number, number>();
  let maxStuck = 0;
  let nan = false;
  while (!isSessionOver(world) && world.time < maxTime) {
    stepWorld(world, track, inputs, SIM_DT);
    for (const e of world.events) if (e.type !== 'sector' && e.type !== 'shift') events.push(e);
    world.events.length = 0;
    if (world.tick % 30 === 0 && !finiteCar(world)) nan = true;
    if (world.session.phase === 'running' || world.session.phase === 'chequered') {
      for (const c of world.cars) {
        if (c.playerIndex !== -1 || c.status !== 'running') continue;
        const t = c.phys.speed < 1 ? (stuck.get(c.id) ?? 0) + SIM_DT : 0;
        stuck.set(c.id, t);
        if (t > maxStuck) maxStuck = t;
      }
    }
  }
  return { world, events, nan, maxStuck };
}

const count = (events: GameEvent[], type: GameEvent['type']): number => events.filter((e) => e.type === type).length;

describe('20-car 3-lap dry races at difficulty 90 on every layout', () => {
  for (const layout of LAYOUTS) {
    test(
      layout.id,
      () => {
        const track = getLayout(layout.id);
        const { world, events, nan, maxStuck } = runRace(raceConfig(layout.id), track, 900);
        expect(nan).toBe(false);
        expect(isSessionOver(world)).toBe(true);
        expect(world.cars).toHaveLength(20);
        expect(world.cars.every((c) => c.status === 'finished')).toBe(true);
        expect(maxStuck).toBeLessThan(10);
        const ref = track.referenceLapTime;
        const bests = world.cars.map((c) => c.timing.bestLap ?? Infinity);
        const fastest = Math.min(...bests);
        expect(fastest / ref).toBeGreaterThan(0.95);
        expect(fastest / ref).toBeLessThan(1.12);
        for (const b of bests) {
          expect(b / ref).toBeGreaterThan(0.95);
          expect(b / ref).toBeLessThan(1.3);
        }
        expect(count(events, 'overtake')).toBeGreaterThan(0);
        expect(count(events, 'lightsOn')).toBe(5);
        expect(count(events, 'lightsOut')).toBe(1);
        expect(count(events, 'chequered')).toBe(1);
        expect(count(events, 'carFinished')).toBe(20);
        expect(count(events, 'finalLap')).toBe(1);
        expect(world.session.fastestLap).not.toBeNull();
        // standings are a permutation of positions 1..20
        const positions = getStandings(world).map((r) => r.position).sort((a, b) => a - b);
        expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      },
      30_000,
    );
  }
});

describe('weather and regulations', () => {
  test(
    'heavy rain: slick starters box for rain tyres, race completes',
    () => {
      const track = getLayout('isola-verde');
      const config = raceConfig('isola-verde', { weather: 'heavyRain' });
      config.grid.forEach((g, i) => {
        if (i % 4 === 0) g.startCompound = 'soft';
      });
      const { world, events, nan, maxStuck } = runRace(config, track, 1200);
      expect(nan).toBe(false);
      expect(isSessionOver(world)).toBe(true);
      expect(maxStuck).toBeLessThan(10);
      expect(world.weather.wetness).toBeGreaterThan(0.7);
      expect(world.session.drsEnabled).toBe(false);
      const stops = events.filter((e): e is Extract<GameEvent, { type: 'pitStop' }> => e.type === 'pitStop');
      expect(stops.length).toBeGreaterThanOrEqual(3);
      expect(stops.every((e) => e.compound === 'wet' || e.compound === 'inter')).toBe(true);
      const slickStarters = world.cars.filter((c) => c.timing.gridPosition % 4 === 1);
      expect(slickStarters.every((c) => c.phys.tire.compound === 'wet' || c.phys.tire.compound === 'inter')).toBe(true);
      const best = Math.min(...world.cars.map((c) => c.timing.bestLap ?? Infinity));
      expect(best / track.referenceLapTime).toBeGreaterThan(1.05);
      expect(best / track.referenceLapTime).toBeLessThan(1.4);
    },
    30_000,
  );

  test(
    '2026 regulation race completes with straight mode in use',
    () => {
      const track = getLayout('mirage-sands');
      const config = raceConfig('mirage-sands', { regulation: '2026' });
      const world = createWorld(config, track);
      let straightMode = 0;
      let nan = false;
      while (!isSessionOver(world) && world.time < 900) {
        stepWorld(world, track, [], SIM_DT);
        world.events.length = 0;
        for (const c of world.cars) if (c.phys.drs.open) straightMode++;
        if (world.tick % 60 === 0 && !finiteCar(world)) nan = true;
      }
      expect(nan).toBe(false);
      expect(isSessionOver(world)).toBe(true);
      expect(world.cars.every((c) => c.status === 'finished')).toBe(true);
      expect(world.cars[0].spec.regulation).toBe('2026');
      expect(world.cars[0].spec.length).toBeCloseTo(5.4, 5);
      expect(straightMode).toBeGreaterThan(1000);
      const best = Math.min(...world.cars.map((c) => c.timing.bestLap ?? Infinity));
      expect(best / track.referenceLapTime).toBeLessThan(1.2);
    },
    30_000,
  );

  // straight-mode zones here contain flat-out corners: the wings must return to corner mode there
  for (const layoutId of ['highland-ridge', 'koyo-hills', 'koyo-hills-rev']) {
    test(
      `2026 straight mode closes in fast corners (${layoutId})`,
      () => {
        const track = getLayout(layoutId);
        const world = createWorld(raceConfig(layoutId, { regulation: '2026', laps: 2, seed: 21 }), track);
        const lost = new Set<number>();
        let episodes = 0;
        let collisions = 0;
        while (!isSessionOver(world) && world.time < 600) {
          stepWorld(world, track, [], SIM_DT);
          for (const e of world.events) if (e.type === 'collision') collisions++;
          world.events.length = 0;
          if (world.session.phase !== 'running') continue;
          for (const c of world.cars) {
            if (c.status !== 'running' || c.pit.phase !== 'none') continue;
            const i = c.phys.trackIndex;
            const err = Math.abs(angleDiff(c.phys.yaw, Math.atan2(track.tx[i] ?? 0, track.tz[i] ?? 1)));
            if (err > 0.6 && !lost.has(c.id)) {
              lost.add(c.id);
              episodes++;
            }
            if (err < 0.2) lost.delete(c.id);
          }
        }
        expect(isSessionOver(world)).toBe(true);
        expect(world.cars.every((c) => c.status === 'finished')).toBe(true);
        expect(episodes).toBeLessThanOrEqual(4);
        expect(collisions).toBeLessThan(20);
      },
      30_000,
    );
  }
});

describe('split screen', () => {
  test(
    'two human players with null inputs: AI races around them, session ends',
    () => {
      const track = getLayout('isola-verde');
      const config = raceConfig('isola-verde', { laps: 2 });
      config.mode = 'splitScreen';
      const p0 = config.grid[2];
      const p1 = config.grid[7];
      p0.playerIndex = 0;
      p1.playerIndex = 1;
      config.players = [
        { playerIndex: 0, driverId: p0.driverId, teamId: p0.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } },
        { playerIndex: 1, driverId: p1.driverId, teamId: p1.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } },
      ];
      const { world, nan, maxStuck } = runRace(config, track, 900, [null, null]);
      expect(nan).toBe(false);
      expect(isSessionOver(world)).toBe(true);
      expect(maxStuck).toBeLessThan(10);
      const humans = world.cars.filter((c) => c.playerIndex !== -1);
      expect(humans).toHaveLength(2);
      expect(humans.map((c) => c.playerIndex).sort()).toEqual([0, 1]);
      // the idle human cars never moved off the grid; every AI car still took the flag
      expect(humans.every((c) => c.timing.lapsCompleted === 0)).toBe(true);
      expect(world.cars.filter((c) => c.playerIndex === -1).every((c) => c.status === 'finished')).toBe(true);
    },
    30_000,
  );
});
