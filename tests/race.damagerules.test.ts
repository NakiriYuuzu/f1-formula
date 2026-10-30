/**
 * Damage and penalty rules (2025 / 2026 sporting regulations): a broken suspension withdraws the car where it stops
 * (B1.8.9) in every session and with or without race control; the black-and-orange flag calls a car with a wing hanging
 * off in and black-flags it at the second line crossing without a stop (B1.8.7); 5 / 10 s penalties are served
 * stationary at the next stop, else added to the race time (B1.9.6); the flashback target of a crash; HUD helpers.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import type { BuiltTrack, ControlInput, GameEvent, SafetyCarSetting, SessionConfig, SessionKind, WorldState } from '../src/core/types';
import { computeAIInput } from '../src/ai/index';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { buildSessionResult, cancelPit, crashTime, createWorld, isSessionOver, requestPit, retireCar, stepWorld } from '../src/race/index';
import { raceTotal, unservedPenalty } from '../src/race/classification';
import { BLACK_ORANGE_CROSSINGS, BROKEN_REASON } from '../src/race/damageRules';
import { applyTimePenalty } from '../src/race/legality';
import { finishCar } from '../src/race/session';
import { forwardDistance } from '../src/track/track';
import { rewindableCrash } from '../src/app/flashback';
import { emptyStats, evaluateAchievements, updateStats } from '../src/meta/achievements';
import { driverStandings, recordRace, sanitizeRoundRecords } from '../src/meta/season';
import { blackOrangeDeadline, flagsOf, unservedPenaltySec } from '../src/ui/hud/raceControl';
import { useFictionalRoster } from './rosterFixture';

beforeEach(useFictionalRoster);

const RACERS = DRIVERS.filter((d) => d.teamId !== '');
const team = (id: string): string => RACERS.find((d) => d.id === id)?.teamId ?? '';

function config(
  o: { kind?: SessionKind; laps?: number; cars?: number; safetyCar?: SafetyCarSetting; human?: boolean; pole?: boolean; mandatoryPitStop?: boolean } = {},
): SessionConfig {
  const kind = o.kind ?? 'race';
  const ids = RACERS.slice(0, o.cars ?? 6).map((d) => d.id);
  const human = o.human === false ? null : o.pole ? ids[0] : ids[ids.length - 1];
  return {
    mode: 'grandPrix',
    kind,
    layoutId: 'isola-verde',
    laps: o.laps ?? 4,
    timeLimit: kind === 'race' ? null : 600,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 90,
    players: human ? [{ playerIndex: 0, driverId: human, teamId: team(human), setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } }] : [],
    grid: ids.map((id) => ({ driverId: id, teamId: team(id), playerIndex: id === human ? 0 : -1, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: o.safetyCar ?? 'off', damage: 'full', mandatoryPitStop: o.mandatoryPitStop ?? false },
    seed: 5,
    ghost: null,
    objective: null,
  };
}

interface Opts {
  /** edit the player's input (autopilot otherwise) */
  input?: (w: WorldState, input: ControlInput) => void;
  /** before every step */
  each?: (w: WorldState) => void;
  until?: (w: WorldState) => boolean;
}

function run(world: WorldState, track: BuiltTrack, maxTime: number, o: Opts = {}): GameEvent[] {
  const events: GameEvent[] = [];
  while (!isSessionOver(world) && world.time < maxTime && !(o.until?.(world) ?? false)) {
    o.each?.(world);
    const me = world.cars.find((c) => c.playerIndex === 0);
    let inputs: (ControlInput | null)[] = [];
    if (me) {
      const input = computeAIInput(world, me, track, SIM_DT);
      o.input?.(world, input);
      inputs = [input];
    }
    stepWorld(world, track, inputs, SIM_DT);
    for (const e of world.events) if (e.type !== 'shift') events.push(e);
    world.events.length = 0;
  }
  return events;
}

const ofType = <T extends GameEvent['type']>(events: GameEvent[], type: T): Extract<GameEvent, { type: T }>[] =>
  events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

const track = getLayout('isola-verde');

describe('terminal damage (broken suspension)', () => {
  test('safety car off: an AI car whose suspension broke pulls over and is withdrawn where it stops', () => {
    const world = createWorld(config({ safetyCar: 'off' }), track);
    run(world, track, 30);
    const car = world.cars[1];
    expect(car.status).toBe('running');
    car.phys.damage.suspension = 1;
    const events = run(world, track, 45);
    expect(ofType(events, 'terminalDamage').map((e) => e.carId)).toEqual([car.id]);
    const retired = ofType(events, 'retired').find((e) => e.carId === car.id);
    expect(retired?.reason).toBe(BROKEN_REASON);
    expect(car.status).toBe('retired');
    // no race control: no marshals, no hazard left on track
    expect(car.race.hazard).toBe(false);
    expect(ofType(events, 'incident')).toHaveLength(0);
  }, 60_000);

  test('race control on: the broken car gets an incident, is withdrawn as a hazard and neutralises the race', () => {
    const world = createWorld(config({ safetyCar: 'standard', cars: 10 }), track);
    run(world, track, 30);
    const car = world.cars[3];
    car.phys.damage.suspension = 1;
    const events = run(world, track, 50);
    expect(ofType(events, 'incident').some((e) => e.carId === car.id)).toBe(true);
    expect(ofType(events, 'retired').find((e) => e.carId === car.id)?.reason).toBe(BROKEN_REASON);
    expect(car.status).toBe('retired');
    const modes = ofType(events, 'raceControl').map((e) => e.mode);
    expect(modes.some((m) => m === 'sc' || m === 'vsc' || m === 'red')).toBe(true);
  }, 60_000);

  test('a broken human car cannot be driven: full throttle, it still stops and retires', () => {
    const world = createWorld(config({ safetyCar: 'off' }), track);
    run(world, track, 30);
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    me.phys.damage.suspension = 1;
    const at = world.time;
    const events = run(world, track, 50, {
      input: (_w, input) => {
        input.throttle = 1;
        input.brake = 0;
      },
    });
    expect(me.status).toBe('retired');
    const retired = ofType(events, 'retired').find((e) => e.carId === me.id)!;
    expect(retired.reason).toBe(BROKEN_REASON);
    // the flashback goes back to the break, not to the retirement
    expect(crashTime(world, me.id)).toBeCloseTo(at + SIM_DT, 5);
  }, 60_000);

  test('practice: a broken car is withdrawn from the session too', () => {
    const world = createWorld(config({ kind: 'practice', cars: 1 }), track);
    run(world, track, 20);
    const me = world.cars[0];
    me.phys.damage.suspension = 1;
    const events = run(world, track, 40);
    expect(me.status).toBe('retired');
    expect(ofType(events, 'retired')[0]?.reason).toBe(BROKEN_REASON);
  }, 60_000);

  test('broken just before the flag: the car that coasts over the line stays classified (race control on)', () => {
    const world = createWorld(config({ safetyCar: 'standard', laps: 3, cars: 12, pole: true }), track);
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    const L = track.length;
    // the last car stops on lap 2 and is ~20 s behind at the end: the race goes on after the player's flag
    const back = world.cars[11];
    run(world, track, 600, {
      each: (w) => {
        if (back.timing.lapsCompleted === 1 && back.pit.stops === 0 && !back.pit.requested) requestPit(w, back.id, 'hard');
      },
      until: () => me.timing.lapsCompleted === 2 && 3 * L - me.timing.progress < 150,
    });
    expect(me.status).toBe('running');
    // nobody has the flag yet: race control judges the break
    expect(world.session.phase).toBe('running');
    me.phys.damage.suspension = 1;
    const events = run(world, track, 900);
    expect(ofType(events, 'terminalDamage').map((e) => e.carId)).toEqual([me.id]);
    expect(ofType(events, 'carFinished').some((e) => e.carId === me.id)).toBe(true);
    expect(ofType(events, 'retired').filter((e) => e.carId === me.id)).toHaveLength(0);
    expect(me.status).toBe('finished');
    const row = buildSessionResult(world).rows.find((r) => r.carId === me.id)!;
    expect(row.status).toBe('finished');
    expect(row.gapText).not.toBe('退賽');
  }, 120_000);

  test('a classified finisher is never retired afterwards (pause menu, race control)', () => {
    const world = createWorld(config({ safetyCar: 'off', laps: 3 }), track);
    run(world, track, 30);
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    me.timing.lapsCompleted = 3;
    finishCar(world, me, world.time);
    world.events.length = 0;
    retireCar(world, me.id, '車手退賽');
    expect(me.status).toBe('finished');
    expect(world.events.filter((e) => e.type === 'retired')).toHaveLength(0);
  });

  test('black-and-orange flag, then the suspension breaks: not driven into the pit lane, withdrawn for the damage', () => {
    const world = createWorld(config({ safetyCar: 'standard', laps: 6, human: false }), track);
    run(world, track, 30);
    const car = world.cars[2];
    car.phys.damage.frontWing = 0.7;
    run(world, track, 31);
    expect(car.flags.blackOrange).not.toBeNull();
    // keep it out this lap, then break it just before the pit entry with the request still standing
    run(world, track, 400, { each: () => (car.pit.requested = false), until: () => forwardDistance(track, track.pit.entry, car.phys.s) < 30 });
    run(world, track, 400, { until: () => forwardDistance(track, car.phys.s, track.pit.entry) < 60 });
    expect(car.pit.phase).toBe('none');
    car.phys.damage.suspension = 1;
    let pitted = false;
    const events = run(world, track, world.time + 30, {
      each: () => (pitted ||= car.pit.phase !== 'none'),
      until: () => car.status === 'retired',
    });
    expect(pitted).toBe(false);
    expect(car.status).toBe('retired');
    expect(ofType(events, 'retired').find((e) => e.carId === car.id)?.reason).toBe(BROKEN_REASON);
    expect(car.pit.stops).toBe(0);
    expect(car.flags.blackOrange ?? null).toBeNull();
    expect(car.penalties.disqualified).toBe(false);
  }, 120_000);

  test('full damage: a human car wrecked without one heavy hit (damage built up) still red-flags the race', () => {
    const world = createWorld(config({ safetyCar: 'standard', laps: 6 }), track);
    run(world, track, 30);
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    me.phys.damage.suspension = 1;
    const events = run(world, track, 80);
    expect(ofType(events, 'retired').find((e) => e.carId === me.id)?.reason).toBe(BROKEN_REASON);
    expect(ofType(events, 'raceControl').map((e) => e.mode)).toContain('red');
    expect(me.status).toBe('retired');
  }, 120_000);
});

describe('black-and-orange flag', () => {
  test('an AI car with a wing hanging off is called in, repaired at the stop, and the flag clears', () => {
    const world = createWorld(config({ safetyCar: 'off', laps: 5 }), track);
    run(world, track, 30);
    const car = world.cars[2];
    car.phys.damage.frontWing = 0.7;
    const events = run(world, track, 40);
    expect(ofType(events, 'blackOrangeFlag').map((e) => e.carId)).toEqual([car.id]);
    expect(car.pit.requested || car.pit.phase !== 'none').toBe(true);
    expect(flagsOf(car).blackOrange?.crossingsLeft).toBeGreaterThanOrEqual(1);
    const later = run(world, track, 400, { until: () => car.pit.stops > 0 && car.pit.phase === 'none' });
    expect(car.pit.stops).toBe(1);
    expect(car.phys.damage.frontWing).toBe(0);
    expect(car.flags.blackOrange ?? null).toBeNull();
    expect(car.penalties.disqualified).toBe(false);
    expect(ofType(later, 'disqualified')).toHaveLength(0);
  }, 120_000);

  test('ignoring it: black flag at the second line crossing — disqualified, unclassified, no points', () => {
    const world = createWorld(config({ safetyCar: 'off', laps: 6 }), track);
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    run(world, track, 400, { until: () => me.timing.lapsCompleted >= 1 && me.timing.currentLapTime > 5 });
    me.phys.damage.rearWing = 0.6;
    const shownAt = me.timing.lapsCompleted;
    const events = run(world, track, 900, {
      // the driver never boxes
      each: (w) => cancelPit(w, me.id),
    });
    expect(ofType(events, 'blackOrangeFlag').map((e) => e.carId)).toEqual([me.id]);
    const dq = ofType(events, 'disqualified').find((e) => e.carId === me.id);
    expect(dq).toBeDefined();
    expect(me.penalties.disqualified).toBe(true);
    expect(me.status).toBe('retired');
    expect(me.timing.lapsCompleted).toBe(shownAt + BLACK_ORANGE_CROSSINGS);
    expect(me.pit.stops).toBe(0);
    expect(isSessionOver(world)).toBe(true);
    const rows = buildSessionResult(world).rows;
    const row = rows.find((r) => r.carId === me.id)!;
    expect(row.disqualified).toBe(true);
    expect(row.points).toBe(0);
    expect(row.gapText).toBe('取消資格');
    expect(rows[rows.length - 1].carId).toBe(me.id);
  }, 120_000);
});

describe('time penalties served at the next stop', () => {
  test('the car stands for the penalty before the service; a served penalty is not added to the race time', () => {
    const world = createWorld(config({ safetyCar: 'off', laps: 4 }), track);
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    run(world, track, 25);
    applyTimePenalty(world, me, 5, '測試罰時');
    expect(unservedPenalty(me)).toBe(5);
    expect(unservedPenaltySec(me, world)).toBe(5);
    requestPit(world, me.id, 'hard');
    const events = run(world, track, 400, { until: () => me.pit.stops > 0 });
    expect(ofType(events, 'penaltyServed')).toEqual([{ type: 'penaltyServed', carId: me.id, seconds: 5 }]);
    const stop = ofType(events, 'pitStop').find((e) => e.carId === me.id)!;
    expect(stop.duration).toBeGreaterThanOrEqual(5 + 2);
    expect(me.penalties.servedSec).toBe(5);
    expect(unservedPenalty(me)).toBe(0);
    // a later penalty without another stop is added at the end
    applyTimePenalty(world, me, 5, '測試罰時');
    run(world, track, 900);
    expect(isSessionOver(world)).toBe(true);
    expect(me.status).toBe('finished');
    const start = world.session.startTime!;
    expect(raceTotal(world, me)).toBeCloseTo(me.timing.finishTime! - start + 5, 6);
    const row = buildSessionResult(world).rows.find((r) => r.carId === me.id)!;
    expect(row.penaltySec).toBe(10);
    expect(row.penaltyServedSec).toBe(5);
  }, 120_000);
});

describe('disqualification across the game', () => {
  function dsqAtTheLine(): { world: WorldState; events: GameEvent[] } {
    const world = createWorld(config({ safetyCar: 'off', laps: 3, mandatoryPitStop: true }), track);
    run(world, track, 30);
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    world.events.length = 0;
    // took the flag first, never on a second dry compound
    me.timing.lapsCompleted = 3;
    me.timing.progress += 3 * track.length;
    finishCar(world, me, world.time);
    const events = [...world.events];
    world.events.length = 0;
    return { world, events };
  }

  test('disqualified at the line: no finishing radio, classified behind everyone, no podium / win credit', () => {
    const { world, events } = dsqAtTheLine();
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    expect(me.penalties.disqualified).toBe(true);
    const radio = ofType(events, 'radio').map((e) => e.text);
    expect(radio.some((t) => t.includes('取消資格'))).toBe(true);
    expect(radio.some((t) => t.includes('冠軍') || t.includes('完賽'))).toBe(false);
    const result = buildSessionResult(world);
    const row = result.rows.find((r) => r.carId === me.id)!;
    expect(row.disqualified).toBe(true);
    expect(row.status).toBe('finished');
    expect(result.rows[result.rows.length - 1].carId).toBe(me.id);
    // profile stats / achievements
    const stats = updateStats(emptyStats(), result);
    expect(stats.racesFinished).toBe(0);
    const ach = evaluateAchievements({ result, trackLimitWarnings: 0, beatGhost: false, storyComplete: false, rdMaxed: false, champion: false, stats });
    expect(ach).not.toContain('cleanRace');
    expect(ach).not.toContain('firstWin');
    // season record: kept through a save round trip, no win / podium / countback
    const saved = sanitizeRoundRecords(JSON.parse(JSON.stringify([recordRace(result)])), 30);
    const entry = saved[0].classification.find((e) => e.driverId === row.driverId)!;
    expect(entry.disqualified).toBe(true);
    const standing = driverStandings(saved, [row.driverId]).find((e) => e.id === row.driverId)!;
    expect(standing.points).toBe(0);
    expect(standing.wins + standing.podiums + standing.best).toBe(0);
    expect(standing.finishes.every((n) => n === 0)).toBe(true);
  }, 60_000);

  test('the live order puts a disqualified car behind the retired ones, as the results do', () => {
    const world = createWorld(config({ safetyCar: 'off', laps: 3, mandatoryPitStop: true, human: false }), track);
    run(world, track, 30);
    retireCar(world, 5, '測試退賽');
    const a = world.cars[0];
    a.timing.lapsCompleted = 3;
    a.timing.progress += 3 * track.length;
    finishCar(world, a, world.time);
    expect(a.penalties.disqualified).toBe(true);
    stepWorld(world, track, [], SIM_DT);
    expect(world.race.order.slice(-2)).toEqual([5, 0]);
    const rows = buildSessionResult(world).rows.map((r) => r.carId);
    expect(rows.slice(-2)).toEqual([5, 0]);
  }, 60_000);
});

describe('flashback after a crash', () => {
  test('goes back past the earliest crash the buffer still holds; an older crash stays', () => {
    // buffer holds 40 s → now: a crash at 45 s is undone, one at 30 s is not
    expect(rewindableCrash([45, null], 40)).toBe(45);
    expect(rewindableCrash([30, null], 40)).toBeNull();
    // split screen: player 1 crashed long ago, player 2 crashed now — only the reachable crash counts
    expect(rewindableCrash([30, 52], 40)).toBe(52);
    expect(rewindableCrash([47, 52], 40)).toBe(47);
    expect(rewindableCrash([null, null], 40)).toBeNull();
    expect(rewindableCrash([45], null)).toBeNull();
  });
});

describe('HUD helpers', () => {
  test('black-and-orange deadline text and unserved penalty seconds', () => {
    expect(blackOrangeDeadline(2)).toBe('2 圈內進站，否則黑旗');
    expect(blackOrangeDeadline(1)).toBe('過終點線前進站，否則黑旗');
    const world = createWorld(config({ safetyCar: 'off' }), track);
    const car = world.cars[0];
    car.penalties.timeSec = 10;
    car.penalties.servedSec = 5;
    expect(unservedPenaltySec(car, world)).toBe(5);
    expect(flagsOf(car).blackOrange).toBeNull();
    expect(flagsOf(car).mandatoryStop).toBe(false);
  });
});
