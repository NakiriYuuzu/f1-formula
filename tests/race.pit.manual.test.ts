/**
 * Real-F1 pit lane: free entry / exit roads, the limit only between the speed-limit lines, the driver drives the lane
 * (limiter, speeding penalty) and only the box manoeuvre is automatic; the pit assist keeps the full autopilot.
 */
import { describe, expect, test } from 'bun:test';
import { createWorld, getPlayerCarId, isSessionOver, requestPit, stepWorld } from '../src/race/index';
import { PIT_SPEEDING_PENALTY } from '../src/race/pitlane';
import { computeAIInput, steerToward } from '../src/ai/index';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { forwardDistance, pitLaneOffsetAt, pitRampLength, pitZoneLength } from '../src/track/track';
import type { BuiltTrack, ControlInput, GameEvent, PitPhase, SessionConfig, SessionKind, WorldState } from '../src/core/types';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');
const HUMAN = 'varga';
const team = (id: string): string => RACERS.find((d) => d.id === id)?.teamId ?? '';

function config(layoutId: string, o: { kind?: SessionKind; pitAssist?: boolean; human?: boolean } = {}): SessionConfig {
  const kind = o.kind ?? 'race';
  const human = o.human ?? true;
  return {
    mode: 'grandPrix',
    kind,
    layoutId,
    laps: 3,
    timeLimit: kind === 'race' ? null : 900,
    qualifyingLaps: kind === 'qualifying' ? 3 : 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 90,
    players: human
      ? [{ playerIndex: 0, driverId: HUMAN, teamId: team(HUMAN), setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist: o.pitAssist ?? false } }]
      : [],
    grid: [{ driverId: HUMAN, teamId: team(HUMAN), playerIndex: human ? 0 : -1, startCompound: 'medium' }],
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off', mandatoryPitStop: false },
    seed: 11,
    ghost: null,
    objective: null,
  };
}

interface DriverOpts {
  /** press the limiter before the speed-limit line */
  limiter: boolean;
  /** speed (m/s) held between the lines */
  laneSpeed: number;
  /** ignore the pit lane (stay on the racing line) */
  missEntry?: boolean;
}

/** Scripted human: the AI controller on track; in a manual pit visit it follows the lane centre at opts.laneSpeed. */
function pitDriver(track: BuiltTrack, opts: DriverOpts): (w: WorldState) => (ControlInput | null)[] {
  const ramp = pitRampLength(track);
  const zone = pitZoneLength(track);
  return (w) => {
    const car = w.cars[getPlayerCarId(w, 0)];
    const ai = computeAIInput(w, car, track, SIM_DT);
    if (car.pit.phase === 'none' || car.race.pitAuto || opts.missEntry) return [ai];
    const p = car.phys;
    const d = forwardDistance(track, track.pit.entry, p.s);
    const look = 14;
    const lat = pitLaneOffsetAt(track, p.s + look) ?? p.lateral;
    const target = d < ramp ? Math.max(opts.laneSpeed, Math.sqrt(opts.laneSpeed ** 2 + 2 * 14 * Math.max(0, ramp - d - 8))) : d < zone - ramp ? opts.laneSpeed : 60;
    const err = target - p.speed;
    return [
      {
        ...ai,
        steer: steerToward(car, track, lat, look),
        throttle: err > 0 ? Math.min(1, err * 0.6 + 0.1) : 0,
        brake: err < -0.3 ? Math.min(1, -err * 0.4) : 0,
        limiterToggle: opts.limiter && !p.limiter && d > ramp * 0.5 && d < zone - ramp,
      },
    ];
  };
}

interface Visit {
  world: WorldState;
  events: GameEvent[];
  phases: PitPhase[];
  maxEntrySpeed: number;
  /** highest speed between the lines while the driver (not the box autopilot) drives */
  maxLaneSpeed: number;
  manualSeen: boolean;
  cancelled: boolean;
}

function visit(layoutId: string, o: { kind?: SessionKind; pitAssist?: boolean; human?: boolean; driver?: DriverOpts; maxTime?: number } = {}): Visit {
  const track = getLayout(layoutId);
  const world = createWorld(config(layoutId, o), track);
  const drive = pitDriver(track, o.driver ?? { limiter: true, laneSpeed: 20 });
  const events: GameEvent[] = [];
  const phases: PitPhase[] = [];
  let maxEntrySpeed = 0;
  let maxLaneSpeed = 0;
  let manualSeen = false;
  let cancelled = false;
  let requests = 0;
  while (!isSessionOver(world) && world.time < (o.maxTime ?? 600)) {
    const c = world.cars[0];
    if (c.timing.lap === 2 && c.pit.stops === 0 && !c.pit.requested && c.pit.phase === 'none' && requests === 0) {
      requestPit(world, 0, 'soft');
      requests++;
    }
    const before = c.pit.phase;
    stepWorld(world, track, o.human === false ? [] : drive(world), SIM_DT);
    for (const e of world.events) if (e.type !== 'shift') events.push(e);
    world.events.length = 0;
    if (phases[phases.length - 1] !== c.pit.phase) phases.push(c.pit.phase);
    if (c.race.pitManual) manualSeen = true;
    if (before === 'entry' && c.pit.phase === 'none' && c.pit.stops === 0) cancelled = true;
    if (c.pit.phase === 'entry') maxEntrySpeed = Math.max(maxEntrySpeed, c.phys.speed);
    if (c.pit.phase === 'lane' && !c.race.pitAuto) maxLaneSpeed = Math.max(maxLaneSpeed, c.phys.speed);
    if (o.driver?.missEntry && cancelled) break;
  }
  return { world, events, phases, maxEntrySpeed, maxLaneSpeed, manualSeen, cancelled };
}

const LIMIT = 80 / 3.6;

describe('manual pit lane (pit assist off)', () => {
  test(
    'the driver comes in with the limiter: stop, new tyres, no penalty, free entry road',
    () => {
      for (const id of ['porto-lumen', 'highland-ridge-rev']) {
        const v = visit(id);
        const car = v.world.cars[0];
        expect(v.manualSeen).toBe(true);
        expect(car.pit.stops).toBe(1);
        expect(car.phys.tire.compound).toBe('soft');
        expect(car.status).toBe('finished');
        expect(car.penalties.timeSec).toBe(0);
        expect(v.events.some((e) => e.type === 'penalty')).toBe(false);
        const order = v.events.filter((e) => e.type === 'pitEntry' || e.type === 'pitStop' || e.type === 'pitExit').map((e) => e.type);
        expect(order).toEqual(['pitEntry', 'pitStop', 'pitExit']);
        expect(v.phases).toEqual(['none', 'entry', 'lane', 'stopped', 'lane', 'exit', 'none']);
        // the entry road is not limited; between the lines the limiter holds the car at (or below) the limit
        expect(v.maxEntrySpeed).toBeGreaterThan(LIMIT * 1.5);
        expect(v.maxLaneSpeed).toBeLessThanOrEqual(LIMIT + 0.6);
        expect(car.race.pitManual).toBe(false);
        expect(car.phys.limiter).toBe(false);
      }
    },
    60_000,
  );

  test(
    'speeding between the lines: one race time penalty per visit',
    () => {
      const v = visit('porto-lumen', { driver: { limiter: false, laneSpeed: 30 } });
      const car = v.world.cars[0];
      expect(v.maxLaneSpeed).toBeGreaterThan(LIMIT + 0.6);
      const penalties = v.events.filter((e) => e.type === 'penalty');
      expect(penalties).toHaveLength(1);
      expect(car.penalties.timeSec).toBe(PIT_SPEEDING_PENALTY);
      expect(car.pit.stops).toBe(1);
    },
    60_000,
  );

  test(
    'speeding outside a race is a radio warning, not a time penalty',
    () => {
      const v = visit('porto-lumen', { kind: 'practice', driver: { limiter: false, laneSpeed: 30 }, maxTime: 400 });
      const car = v.world.cars[0];
      expect(car.pit.stops).toBe(1);
      expect(car.penalties.timeSec).toBe(0);
      expect(v.events.some((e) => e.type === 'radio' && e.carId === car.id && e.text.includes('維修道超速'))).toBe(true);
    },
    60_000,
  );

  test(
    'staying on track after the request cancels the visit and keeps the request armed',
    () => {
      const v = visit('porto-lumen', { driver: { limiter: true, laneSpeed: 20, missEntry: true } });
      const car = v.world.cars[0];
      expect(v.cancelled).toBe(true);
      expect(car.pit.phase).toBe('none');
      expect(car.pit.requested).toBe(true);
      expect(car.pit.stops).toBe(0);
      expect(car.status).toBe('running');
    },
    60_000,
  );
});

describe('pit autopilot (pit assist on, AI)', () => {
  test(
    'assist on: the full kinematic visit as before, never manual',
    () => {
      const v = visit('porto-lumen', { pitAssist: true });
      expect(v.manualSeen).toBe(false);
      expect(v.phases).toEqual(['none', 'entry', 'lane', 'stopped', 'lane', 'exit', 'none']);
      expect(v.world.cars[0].pit.stops).toBe(1);
    },
    60_000,
  );

  test(
    'AI keeps speed on the entry road and reaches the limit at the line',
    () => {
      const v = visit('porto-lumen', { human: false });
      expect(v.manualSeen).toBe(false);
      expect(v.maxEntrySpeed).toBeGreaterThan(LIMIT * 1.5);
      expect(v.world.cars[0].pit.stops).toBe(1);
    },
    60_000,
  );
});
