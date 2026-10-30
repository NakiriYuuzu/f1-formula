/**
 * AI attack and defence (docs/plans/phase2-ai.md §B): the attack phases (stalk → feint → commit → switchback), the
 * DRS-train judgement, the defending rules (one move per straight, never started under braking, no move into a car
 * ahead or across an attacker's nose) and the side-by-side rules (the outside car keeps the outside line, the inside
 * car leaves a car's width, no squeeze once more than half alongside) — unit checks on planTraffic with constructed
 * cars, and 20-car headless races at Monza / Koyo (difficulty 90, the phase-2 metrics grid).
 */
import { describe, expect, test } from 'bun:test';
import { SPEED_CAP, createAIState } from '../src/ai/index';
import { PATH_EDGE_MARGIN, lineCurvatureAt } from '../src/ai/profile';
import { planTraffic, type TrafficContext } from '../src/ai/traffic';
import { createWorld, isSessionOver, stepWorld } from '../src/race/index';
import { forwardDistance, inRangeS, indexAtS, poseAt, sampleAt, wrapS } from '../src/track/track';
import { forwardX, forwardZ } from '../src/core/math';
import { DEFAULT_RULES, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import type { BuiltTrack, CarEntry, SessionConfig, TireCompound, WorldState } from '../src/core/types';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');
const driver = (id: string) => RACERS.find((d) => d.id === id)!;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** A race with the given drivers (in grid order), difficulty 90, soft tyres, safety car off. */
function smallRace(layoutId: string, ids: string[]): SessionConfig {
  return {
    mode: 'grandPrix',
    kind: 'race',
    layoutId,
    laps: 5,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 90,
    players: [],
    grid: ids.map((id) => ({ driverId: id, teamId: driver(id).teamId, playerIndex: -1, startCompound: 'soft' as TireCompound })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed: 7,
    ghost: null,
    objective: null,
  };
}

/** The 20-car grid of the phase-2 metrics (car strength + driver pace, seeded tyres), difficulty 90, 5 laps. */
function raceConfig(layoutId: string, seed: number): SessionConfig {
  const strength = (id: string): number => {
    const d = driver(id);
    const t = TEAMS.find((x) => x.id === d.teamId)!;
    return (t.rating.aero + t.rating.power + t.rating.chassis) / 3 + d.skill.pace * 0.35 + (hash(`${id}${seed}`) - 0.5) * 0.04;
  };
  const order = RACERS.map((d) => d.id).sort((a, b) => strength(b) - strength(a));
  return {
    ...smallRace(layoutId, order),
    grid: order.map((id) => {
      const compound: TireCompound = hash(`${id}tyre${seed}`) < 0.55 ? 'medium' : 'soft';
      return { driverId: id, teamId: driver(id).teamId, playerIndex: -1, startCompound: compound };
    }),
    seed,
  };
}

/** Put a car at distance `s`, `lat` m off the centre line, running straight along the track at `v` m/s. */
function place(track: BuiltTrack, car: CarEntry, s: number, lat: number, v: number): void {
  const at = wrapS(track, s);
  const pose = poseAt(track, at, lat);
  const p = car.phys;
  p.x = pose.x;
  p.y = pose.y;
  p.z = pose.z;
  p.yaw = pose.yaw;
  p.vx = forwardX(pose.yaw) * v;
  p.vz = forwardZ(pose.yaw) * v;
  p.speed = v;
  p.vLong = v;
  p.vLat = 0;
  p.brake = 0;
  p.s = at;
  p.lateral = lat;
  p.trackIndex = indexAtS(track, at);
  car.status = 'running';
  car.pit.phase = 'none';
}

const line = (track: BuiltTrack, s: number): number => sampleAt(track, track.racingLine, s);

function ctx(car: CarEntry, over: Partial<TrafficContext> = {}): TrafficContext {
  return {
    plannedLateral: car.phys.lateral,
    lookahead: 38,
    trackSpeed: SPEED_CAP,
    brakeDecel: 40,
    dt: SIM_DT,
    openingLap: false,
    openingLapStart: false,
    ...over,
  };
}

/** The middle of the longest straight (from the end of a corner to the start of the next one). */
function longStraight(track: BuiltTrack): { s: number; next: number } {
  const c = track.corners;
  let best = 0;
  let at = 0;
  for (let i = 0; i < c.length; i++) {
    const n = (i + 1) % c.length;
    const d = forwardDistance(track, c[i].endS, c[n].startS);
    if (d > best) {
      best = d;
      at = i;
    }
  }
  return { s: wrapS(track, c[at].endS + best / 2), next: (at + 1) % c.length };
}

describe('attack state', () => {
  test('a new brain: no attack phase, cool-downs clear, counters zero, not in a train', () => {
    const ai = createAIState(driver('varga'), 90, 3);
    expect(ai.attackPhase).toBe('none');
    expect(ai.attackCooldown).toBe(0);
    expect(ai.trickCooldown).toBe(0);
    expect(ai.switchCorner).toBe(-1);
    expect(ai.trickTarget).toBe(-1);
    expect(ai.defendCorner).toBe(-1);
    expect(ai.inTrain).toBe(false);
    for (const k of ['feints', 'feintPasses', 'switchbacks', 'switchbackPasses', 'defendViolations'] as const) expect(ai[k]).toBe(0);
  });
});

describe('B2 DRS train', () => {
  const track = getLayout('monza');

  /** Three cars nose to tail down the main straight, each 0.3 s behind the car ahead, equal pace on equal tyres. */
  function train(): { world: WorldState; front: CarEntry; middle: CarEntry; rear: CarEntry } {
    const world = createWorld(smallRace(track.id, ['varga', 'marchand', 'okafor']), track);
    const [front, middle, rear] = world.cars;
    const { s } = longStraight(track);
    place(track, front, s + 40, line(track, s + 40), 75);
    place(track, middle, s + 20, line(track, s + 20), 75);
    place(track, rear, s, line(track, s), 75);
    world.cars.forEach((c, i) => {
      c.timing.position = i + 1;
      c.timing.interval = i === 0 ? 0 : 0.3;
      c.ai.paceTime = 85;
      // held up behind the car ahead long enough to try a move
      c.ai.followTimer = 10;
    });
    world.session.drsEnabled = true;
    return { world, front, middle, rear };
  }

  test('the car behind a DRS train does not force a move; the car behind the train leader still attacks', () => {
    const { world, middle, rear } = train();
    planTraffic(world, rear, track, ctx(rear));
    expect(rear.ai.inTrain).toBe(true);
    expect(rear.ai.attackTimer).toBe(0);
    expect(rear.ai.mode).toBe('race');
    // the train leader is not in a train itself: the middle car is free to attack it
    planTraffic(world, middle, track, ctx(middle));
    expect(middle.ai.inTrain).toBe(false);
    expect(middle.ai.mode).toBe('attack');
    expect(middle.ai.attackTimer).toBeGreaterThan(0);
    expect(middle.ai.attackPhase).not.toBe('none');
  });

  test('…but it attacks without DRS, or with a clear pace advantage', () => {
    const noDrs = train();
    noDrs.world.session.drsEnabled = false;
    planTraffic(noDrs.world, noDrs.rear, track, ctx(noDrs.rear));
    expect(noDrs.rear.ai.inTrain).toBe(false);
    expect(noDrs.rear.ai.mode).toBe('attack');

    const quicker = train();
    quicker.rear.ai.paceTime = 85 * 0.99;
    planTraffic(quicker.world, quicker.rear, track, ctx(quicker.rear));
    expect(quicker.rear.ai.inTrain).toBe(false);
    expect(quicker.rear.ai.mode).toBe('attack');
  });

  test('a human in the train is judged by its clean pace (or its car), not by a slow raw lap', () => {
    // an in-lap / a lap stuck in traffic: its raw lap is 2 % slower, yet nothing says the car is
    const t = train();
    t.middle.playerIndex = 0;
    t.middle.timing.lastLap = 87;
    planTraffic(t.world, t.rear, track, ctx(t.rear));
    expect(t.rear.ai.inTrain).toBe(true);
    expect(t.rear.ai.attackTimer).toBe(0);
    // a measured clean lap only ever makes it quicker than its car's estimate, never slower
    t.middle.ai.cleanLap = 88;
    planTraffic(t.world, t.rear, track, ctx(t.rear));
    expect(t.rear.ai.inTrain).toBe(true);
  });

  test('a move already under way is called off once the car ahead is in a train', () => {
    const { world, middle, rear } = train();
    world.session.drsEnabled = false;
    planTraffic(world, rear, track, ctx(rear));
    expect(rear.ai.attackTarget).toBe(middle.id);
    expect(rear.ai.attackTimer).toBeGreaterThan(0);
    world.session.drsEnabled = true;
    planTraffic(world, rear, track, ctx(rear));
    expect(rear.ai.attackTimer).toBe(0);
    expect(rear.ai.attackPhase).toBe('none');
  });
});

describe('B3 defending', () => {
  const track = getLayout('monza');
  const straight = longStraight(track);

  /** A defender down the main straight and an attacker 14 m behind (centres), `show` m to its right, closing. */
  function duel(show: number, vAttacker = 80): { world: WorldState; def: CarEntry; att: CarEntry } {
    const world = createWorld(smallRace(track.id, ['varga', 'marchand']), track);
    const [def, att] = world.cars;
    const s = straight.s;
    place(track, def, s, line(track, s), 75);
    place(track, att, s - 14, line(track, s - 14) + show, vAttacker);
    def.timing.position = 1;
    att.timing.position = 2;
    return { world, def, att };
  }

  /** Call planTraffic for the defender up to `n` times (fixed positions); true once a defensive move started. */
  function tries(world: WorldState, def: CarEntry, over: Partial<TrafficContext> = {}, n = 600): boolean {
    for (let i = 0; i < n; i++) {
      planTraffic(world, def, track, ctx(def, over));
      if (def.ai.defendTimer > 0) return true;
    }
    return false;
  }

  test('covers the side the attacker shows on a straight — never in the braking zone, on the brakes or before it shows a side', () => {
    const braking = duel(1.5);
    // the track-limited target speed has come down to ours: the braking zone of the corner ahead
    expect(tries(braking.world, braking.def, { trackSpeed: 75 })).toBe(false);
    const onBrakes = duel(1.5);
    onBrakes.def.phys.brake = 0.4;
    expect(tries(onBrakes.world, onBrakes.def)).toBe(false);
    const inLine = duel(0);
    expect(tries(inLine.world, inLine.def)).toBe(false);
    // closing so fast that it would be alongside within 1.5 s: no chop across its nose
    const late = duel(1.5, 82);
    expect(tries(late.world, late.def)).toBe(false);

    const free = duel(1.5);
    expect(tries(free.world, free.def)).toBe(true);
    expect(free.def.ai.mode).toBe('defend');
    expect(free.def.ai.defendOffset).toBeGreaterThan(free.def.phys.lateral + 1);
    expect(free.def.ai.defendCorner).toBe(straight.next);
    expect(free.def.ai.defendViolations).toBe(0);
  });

  test('one move per straight: no second move before the corner, a new one on the next straight', () => {
    const { world, def, att } = duel(1.5);
    expect(tries(world, def)).toBe(true);
    // time passes on the same straight (hold and cool-down over): still no second move
    def.ai.defendTimer = 0;
    def.ai.defendCooldown = 0;
    def.ai.mode = 'race';
    expect(tries(world, def)).toBe(false);
    // through the corner the straight led to: the next straight allows a move again
    const corner = track.corners[straight.next];
    place(track, def, corner.startS + 5, line(track, corner.startS + 5), 40);
    planTraffic(world, def, track, ctx(def));
    expect(def.ai.defendCorner).toBe(-1);
    place(track, def, straight.s, line(track, straight.s), 75);
    place(track, att, straight.s - 14, line(track, straight.s - 14) + 1.5, 80);
    expect(tries(world, def)).toBe(true);
  });

  test('a cover toward the inside from the outside half is held (released only once the corner ahead turns away)', () => {
    const world = createWorld(smallRace(track.id, ['varga', 'marchand']), track);
    const [def, att] = world.cars;
    const corner = track.corners[straight.next];
    const s = wrapS(track, corner.startS - 120);
    // the corner ahead as the defender reads it (strongest racing-line curvature over 60 m + 2 s at 60 m/s)
    let kMax = 0;
    for (let d = 10; d <= 180; d += 15) if (Math.abs(lineCurvatureAt(track, s + d)) > Math.abs(kMax)) kMax = lineCurvatureAt(track, s + d);
    const k = Math.sign(kMax);
    const edge = sampleAt(track, track.halfWidth, s) - PATH_EDGE_MARGIN;
    // on the outside half of the road for the corner ahead, the attacker right behind
    place(track, def, s, -k * Math.min(5, edge - 0.5), 60);
    place(track, att, s - 14, -k * Math.min(5, edge - 0.5), 65);
    def.timing.position = 1;
    att.timing.position = 2;
    expect(tries(world, def)).toBe(true);
    expect(def.ai.defendSide).toBe(k);
    // the cover is still on the outside half of the road — the move was toward the inside, so it stays
    expect(Math.sign(def.ai.defendOffset)).toBe(-k);
    for (let i = 0; i < 30; i++) {
      const plan = planTraffic(world, def, track, ctx(def));
      expect(plan.lateral).toBe(def.ai.defendOffset);
    }
    expect(def.ai.mode).toBe('defend');
    expect(def.ai.defendTimer).toBeGreaterThan(2);
  });

  test('a hold running out in the braking zone stays until the corner (no cutting back across under braking)', () => {
    const { world, def } = duel(1.5);
    expect(tries(world, def)).toBe(true);
    const cover = def.ai.defendOffset;
    // braking for the corner ahead (track-limited target speed at ours) as the hold runs out
    def.ai.defendTimer = SIM_DT;
    for (let i = 0; i < 120; i++) {
      const plan = planTraffic(world, def, track, ctx(def, { trackSpeed: 75 }));
      expect(plan.lateral).toBe(cover);
    }
    expect(def.ai.mode).toBe('defend');
    // out of the braking zone (no corner to hold it for) it runs out as before
    const free = duel(1.5);
    expect(tries(free.world, free.def)).toBe(true);
    free.def.ai.defendTimer = SIM_DT;
    planTraffic(free.world, free.def, track, ctx(free.def));
    planTraffic(free.world, free.def, track, ctx(free.def));
    expect(free.def.ai.mode).not.toBe('defend');
    // at the corner it was made for the hold ends
    const corner = track.corners[straight.next];
    place(track, def, corner.startS + 5, cover, 40);
    planTraffic(world, def, track, ctx(def, { trackSpeed: 40 }));
    planTraffic(world, def, track, ctx(def, { trackSpeed: 40 }));
    expect(def.ai.mode).not.toBe('defend');
  });

  test('never moves into a car ahead in the lane it would cover', () => {
    const world = createWorld(smallRace(track.id, ['varga', 'marchand', 'okafor']), track);
    const [def, att, slow] = world.cars;
    const s = straight.s;
    place(track, def, s, line(track, s), 75);
    place(track, att, s - 14, line(track, s - 14) + 1.5, 80);
    // a much slower car 60 m ahead, just where the cover would go
    place(track, slow, s + 60, line(track, s + 60) + 1.3, 40);
    expect(tries(world, def)).toBe(false);
    place(track, slow, s + 60, line(track, s + 60) - 4.5, 40);
    expect(tries(world, def)).toBe(true);
  });
});

describe('B3 side by side', () => {
  const track = getLayout('monza');
  // a tight corner (apex speed < 40 m/s, not the first chicane): the cars 50 m before its apex
  const corner = track.corners.find((c) => c.minSpeed < 40 && Math.abs(lineCurvatureAt(track, c.apexS)) > 1 / 120 && c.number >= 4)!;
  const dir = Math.sign(lineCurvatureAt(track, corner.apexS));
  const s = corner.apexS - 50;
  const edge = sampleAt(track, track.halfWidth, s) - PATH_EDGE_MARGIN;

  /** The inside car `dsInside` m ahead of (+) or behind (−) the outside car. */
  function pair(dsInside: number): { world: WorldState; inside: CarEntry; outside: CarEntry; need: number; widthSum: number } {
    const world = createWorld(smallRace(track.id, ['varga', 'marchand']), track);
    const [inside, outside] = world.cars;
    place(track, outside, s, -dir * 2.5, 40);
    place(track, inside, s + dsInside, dir * 1, 40);
    const widthSum = (inside.spec.width + outside.spec.width) / 2;
    return { world, inside, outside, need: widthSum + 1.1, widthSum };
  }

  test('the outside car keeps the outside line beside an inside car (no turning in on it)', () => {
    expect(corner).toBeDefined();
    // the outside car is ahead by more than half a car: it does not give way, but still leaves the inside car its lane
    const { world, inside, outside, need } = pair(-4);
    const plan = planTraffic(world, outside, track, ctx(outside));
    if (dir > 0) expect(plan.hi).toBeLessThanOrEqual(inside.phys.lateral - need + 1e-9);
    else expect(plan.lo).toBeGreaterThanOrEqual(inside.phys.lateral + need - 1e-9);
  });

  test('the inside car leaves the outside one a car width to the edge; more than half alongside it keeps its lane', () => {
    // the inside car ahead (less than half overlap): free to run out toward the exit, but not to the edge
    const ahead = pair(4);
    const plan = planTraffic(ahead.world, ahead.inside, track, ctx(ahead.inside));
    // the limit on the outside (toward the other car): at least a car's width from the edge, short of the full lane
    const limit = dir > 0 ? -plan.lo : plan.hi;
    expect(limit).toBeLessThanOrEqual(edge - ahead.widthSum - 0.5 + 1e-9);
    expect(limit).toBeGreaterThan(-dir * ahead.outside.phys.lateral - ahead.need);
    // level: no squeeze — the full lane beside the outside car stays free
    const level = pair(1);
    const lp = planTraffic(level.world, level.inside, track, ctx(level.inside));
    if (dir > 0) expect(lp.lo).toBeGreaterThanOrEqual(level.outside.phys.lateral + level.need - 1e-9);
    else expect(lp.hi).toBeLessThanOrEqual(level.outside.phys.lateral - level.need + 1e-9);
  });
});

describe('B1 / B4 headless races', () => {
  interface RaceLog {
    world: WorldState;
    overtakes: number;
    heavy: number;
    /** defensive moves started (seen from outside), of them under braking / in a reference braking zone / a second one
     * for the same corner */
    moves: number;
    braking: number;
    inBrakeZone: number;
    secondMove: number;
    /** holds that ended on the brakes short of a corner and moved the car > 1 m off its line while still braking */
    cutBack: number;
    /** car-seconds spent behind a DRS train */
    trainTime: number;
  }

  function runRace(config: SessionConfig): RaceLog {
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const log: RaceLog = { world, overtakes: 0, heavy: 0, moves: 0, braking: 0, inBrakeZone: 0, secondMove: 0, cutBack: 0, trainTime: 0 };
    // braking zone of the reference car: its target speed falls toward the corner
    const refBraking = (at: number): boolean => sampleAt(track, track.speedProfile, at + 8) < sampleAt(track, track.speedProfile, at) - 0.3;
    // the corner each car's last defensive move was made for, until it reaches that corner
    const nextStart = (at: number): number => {
      let best = -1;
      let dist = Infinity;
      track.corners.forEach((c, i) => {
        const d = forwardDistance(track, at, c.startS);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      return best;
    };
    const lastMove = world.cars.map(() => -1);
    const cooldown = world.cars.map(() => 0);
    const holdLeft = world.cars.map(() => 0);
    const lineOff = (c: CarEntry): number => c.phys.lateral - line(track, c.phys.s);
    // released holds being watched: offset from the line at the release, time since
    const released: { car: number; off: number; t: number; counted: boolean }[] = [];
    while (!isSessionOver(world) && world.time < 1500) {
      const brake = world.cars.map((c) => c.phys.brake);
      stepWorld(world, track, [], SIM_DT);
      for (const c of world.cars) {
        const last = track.corners[lastMove[c.id]];
        if (last && inRangeS(track, c.phys.s, last.startS, last.endS)) lastMove[c.id] = -1;
        if (c.ai.defendCooldown > cooldown[c.id] + 1) {
          log.moves++;
          if (brake[c.id] > 0.05) log.braking++;
          if (refBraking(c.phys.s)) log.inBrakeZone++;
          const next = nextStart(c.phys.s);
          if (next === lastMove[c.id]) log.secondMove++;
          lastMove[c.id] = next;
        }
        cooldown[c.id] = c.ai.defendCooldown;
        if (holdLeft[c.id] > 0 && c.ai.defendTimer === 0 && c.phys.brake > 0.05) {
          const inCorner = track.corners.some((q) => inRangeS(track, c.phys.s, q.startS, q.endS));
          if (!inCorner) released.push({ car: c.id, off: lineOff(c), t: 0, counted: false });
        }
        holdLeft[c.id] = c.ai.defendTimer;
        if (c.ai.inTrain) log.trainTime += SIM_DT;
      }
      for (let i = released.length - 1; i >= 0; i--) {
        const r = released[i];
        const c = world.cars[r.car];
        r.t += SIM_DT;
        if (c.phys.brake > 0.05 && !r.counted && Math.abs(lineOff(c) - r.off) > 1) {
          r.counted = true;
          log.cutBack++;
        }
        if (r.t >= 1.5 || !(c.phys.brake > 0.05)) released.splice(i, 1);
      }
      const leaderLaps = Math.max(...world.cars.map((c) => c.timing.lapsCompleted));
      for (const e of world.events) {
        if (e.type === 'overtake' && leaderLaps >= 1) log.overtakes++;
        if (e.type === 'collision' && e.otherCarId !== null && e.impulse > 5000) log.heavy++;
      }
      world.events.length = 0;
    }
    expect(isSessionOver(world)).toBe(true);
    // every car finishes, unless a crash broke its suspension (it is withdrawn: race/damageRules.ts)
    expect(world.cars.every((c) => c.status === 'finished' || (c.status === 'retired' && c.phys.damage.suspension >= 1))).toBe(true);
    return log;
  }

  const total = (r: RaceLog, k: 'feints' | 'feintPasses' | 'switchbacks' | 'switchbackPasses' | 'defendViolations'): number =>
    r.world.cars.reduce((a, c) => a + c.ai[k], 0);

  test(
    'Monza / Koyo: feints and switchbacks happen (and pay off), defensive moves follow the rules, lively and clean',
    () => {
      // [layout, overtakes after the opening lap at least: the phase-2 baseline of this grid before §B]
      const races = ([
        ['monza', 17],
        ['koyo-hills', 15],
      ] as const).map(([id, minOvertakes]) => ({ log: runRace(raceConfig(id, 42)), minOvertakes }));
      for (const { log, minOvertakes } of races) {
        expect(total(log, 'feints')).toBeGreaterThanOrEqual(1);
        expect(total(log, 'switchbacks')).toBeGreaterThanOrEqual(1);
        expect(total(log, 'defendViolations')).toBe(0);
        expect(log.moves).toBeGreaterThan(20);
        expect(log.braking).toBe(0);
        expect(log.inBrakeZone).toBe(0);
        expect(log.secondMove).toBe(0);
        expect(log.cutBack).toBe(0);
        expect(log.overtakes).toBeGreaterThanOrEqual(minOvertakes);
        expect(log.heavy).toBeLessThanOrEqual(4);
      }
      const passes = races.reduce((a, { log }) => a + total(log, 'feintPasses') + total(log, 'switchbackPasses'), 0);
      expect(passes).toBeGreaterThanOrEqual(1);
      // the train rule is live in the DRS laps
      for (const { log } of races) expect(log.trainTime).toBeGreaterThan(10);
    },
    240_000,
  );
});
