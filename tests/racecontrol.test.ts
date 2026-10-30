/**
 * Race control: safety car, VSC, red flag, formation lap, blue flags, illegal overtakes, random incident budget,
 * sprint points and determinism (headless 20-car races driven by the AI; the player car is on autopilot).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { SIM_DT, SPRINT_POINTS } from '../src/core/defaults';
import type { BuiltTrack, ControlInput, DamageLevel, SafetyCarSetting, WorldState } from '../src/core/types';
import { computeAIInput } from '../src/ai/index';
import { getLayout } from '../src/data/tracks/index';
import { buildQuickStart, buildSessionConfig } from '../src/meta/sessionBuilder';
import {
  buildRenderFrame,
  buildSessionResult,
  createWorld,
  forceIncident,
  isSessionOver,
  snapshotWorld,
  stepWorld,
} from '../src/race/index';
import { HEAVY_IMPACT } from '../src/race/control';
import { BROKEN_REASON } from '../src/race/damageRules';
import { GIVE_BACK_SEC, notePass, stepGiveBack } from '../src/race/legality';
import type { Incident } from '../src/race/types';
import { forwardDistance, poseAt, sampleAt, signedDeltaS, wrapS } from '../src/track/track';
import { useFictionalRoster } from './rosterFixture';

interface RaceOptions {
  layout?: string;
  laps?: number;
  safetyCar?: SafetyCarSetting;
  formation?: boolean;
  sprint?: boolean;
  seed?: number;
  /** player grid position */
  start?: number;
  /** player's safety-car limiter assist */
  scLimiter?: boolean;
  damage?: DamageLevel;
}

function race(o: RaceOptions = {}): { world: WorldState; track: BuiltTrack } {
  const { config: quick, ctx } = buildQuickStart({
    kind: 'race',
    layoutId: o.layout ?? 'isola-verde',
    laps: o.laps ?? 5,
    safetyCar: o.safetyCar ?? 'off',
    redFlags: true,
    formationLap: o.formation ?? false,
    sprint: o.sprint ?? false,
    seed: o.seed ?? 7,
  });
  let config = quick;
  if (o.start !== undefined || o.scLimiter !== undefined) {
    const req = ctx.plan.request;
    config = buildSessionConfig({
      ...req,
      playerStartPosition: o.start ?? req.playerStartPosition,
      players: req.players.map((p) => ({ ...p, assists: { ...p.assists, scLimiter: o.scLimiter ?? p.assists.scLimiter } })),
    });
  }
  if (o.damage) config = { ...config, rules: { ...config.rules, damage: o.damage } };
  const track = getLayout(config.layoutId);
  return { world: createWorld(config, track), track };
}

/** Step with the player on autopilot until `until` returns true or `maxSec` of sim time passed. */
function run(world: WorldState, track: BuiltTrack, maxSec: number, until?: (w: WorldState) => boolean): void {
  const steps = Math.round(maxSec / SIM_DT);
  for (let i = 0; i < steps && !isSessionOver(world); i++) {
    const player = world.cars.find((c) => c.playerIndex === 0);
    stepWorld(world, track, [player ? computeAIInput(world, player, track, SIM_DT) : null, null], SIM_DT);
    world.events.length = 0;
    if (until && until(world)) return;
  }
}

const finite = (w: WorldState): boolean => w.cars.every((c) => Number.isFinite(c.phys.x) && Number.isFinite(c.phys.z) && Number.isFinite(c.phys.speed));

// written against the fictional field (data/teams.ts); the game's default is the 2026 F1 grid
beforeEach(useFictionalRoster);

describe('safety car', () => {
  test('leaves the pit lane in front of the leader, queues the field without position changes, comes in with a lap of notice, restarts green with DRS locked for two laps', () => {
    const { world, track } = race({ layout: 'highland-ridge', laps: 6 });
    run(world, track, 40);
    expect(world.session.phase).toBe('running');
    expect(forceIncident(world, track, 'sc')).toBe(true);
    const c = world.session.control;
    expect(c.mode).toBe('sc');
    // waits in the pit lane, then rejoins at the pit exit as the leader approaches and picks it up
    expect(c.safetyCar.onTrack).toBe(false);
    expect(world.race.scHeld).toBe(true);
    run(world, track, track.referenceLapTime * 1.5, (w) => w.session.control.safetyCar.onTrack);
    expect(c.safetyCar.onTrack).toBe(true);
    expect(world.race.scExitDist).toBeGreaterThan(0);
    expect(c.safetyCar.lateral * track.pit.side).toBeGreaterThan(sampleAt(track, track.halfWidth, c.safetyCar.s));
    expect(buildRenderFrame(world, track).safetyCar).toBeTruthy();
    run(world, track, 40, (w) => w.race.scPickedUp);
    expect(world.race.scPickedUp).toBe(true);

    // let the queue form, then no running car may gain a place on track (pit stops / the stricken car aside)
    run(world, track, 25);
    const orderAt = (w: WorldState): number[] =>
      w.race.order.filter((id) => w.cars[id].status === 'running' && w.cars[id].pit.phase === 'none' && !w.cars[id].ai.failing);
    let illegalGains = 0;
    let prev = orderAt(world);
    // and no car drives through the safety car (it passes slower cars / hazards on the other side)
    let minGap = Infinity;
    run(world, track, 400, (w) => {
      if (w.session.control.mode !== 'sc') return true;
      for (const o of w.cars) {
        if (o.status === 'retired' || o.pit.phase !== 'none') continue;
        minGap = Math.min(minGap, Math.hypot(o.phys.x - c.safetyCar.x, o.phys.z - c.safetyCar.z));
      }
      const now = orderAt(w);
      for (let i = 0; i < now.length; i++) {
        const before = prev.indexOf(now[i]);
        if (before > i && prev.slice(i, before).every((id) => now.includes(id))) illegalGains++;
      }
      prev = now;
      return false;
    });
    expect(illegalGains).toBe(0);
    expect(minGap).toBeGreaterThan(3);
    expect(world.session.control.mode).toBe('scEnding');
    // "in this lap" with most of the lap still to go
    expect(forwardDistance(track, c.safetyCar.s, track.pit.entry)).toBeGreaterThan(track.length * 0.4);
    expect(world.session.control.safetyCar.lightsOn).toBe(false);

    run(world, track, 400, (w) => w.session.control.mode === 'green');
    expect(world.session.control.mode).toBe('green');
    // the safety car is in the pit lane (or already gone) and leaves the scene shortly after
    expect(!world.session.control.safetyCar.onTrack || world.race.scPitDist >= 0).toBe(true);
    expect(world.session.control.drsLockUntilLap).toBe(world.session.leaderLap + 2);
    expect(world.session.drsEnabled).toBe(false);
    run(world, track, 20);
    expect(world.session.control.safetyCar.onTrack).toBe(false);
    expect(buildRenderFrame(world, track).safetyCar).toBeNull();
    expect(finite(world)).toBe(true);
  }, 60000);
});

describe('virtual safety car', () => {
  test('AI keeps a positive delta; a human driving flat out is warned and penalised', () => {
    const { world, track } = race({ layout: 'mirage-sands', laps: 5 });
    run(world, track, 40);
    expect(forceIncident(world, track, 'vsc')).toBe(true);
    expect(world.session.control.mode).toBe('vsc');
    const player = world.cars.find((c) => c.playerIndex === 0)!;
    let minAiDelta = Infinity;
    let warnings = 0;
    let penalties = 0;
    for (let i = 0; i < Math.round(15 / SIM_DT); i++) {
      // the human ignores the VSC: full throttle on the racing line
      const input = computeAIInput(world, player, track, SIM_DT);
      input.throttle = 1;
      input.brake = 0;
      stepWorld(world, track, [input, null], SIM_DT);
      for (const e of world.events) {
        if (e.type === 'controlWarning' && e.carId === player.id) warnings++;
        // the speeding penalty (an illegal pass on the way may add its own)
        if (e.type === 'penalty' && e.carId === player.id && e.reason === '虛擬安全車期間超速') penalties++;
      }
      world.events.length = 0;
      for (const c of world.cars) {
        if (c.playerIndex === -1 && c.status === 'running' && c.pit.phase === 'none' && c.flags.delta !== null && i > 600) {
          minAiDelta = Math.min(minAiDelta, c.flags.delta);
        }
      }
      if (world.session.control.mode !== 'vsc') break;
    }
    expect(minAiDelta).toBeGreaterThan(-0.3);
    expect(warnings).toBeGreaterThan(0);
    expect(penalties).toBe(1);
    run(world, track, 120, (w) => w.session.control.mode === 'green');
    expect(world.session.control.mode).toBe('green');
    expect(world.cars.every((c) => c.flags.delta === null)).toBe(true);
  }, 60000);
});

describe('red flag', () => {
  test('the field regroups on the grid, restarts from standing and keeps its laps', () => {
    const { world, track } = race({ layout: 'koyo-hills', laps: 5 });
    run(world, track, 110);
    const leaderLapsBefore = Math.max(...world.cars.map((c) => c.timing.lapsCompleted));
    expect(leaderLapsBefore).toBeGreaterThanOrEqual(1);
    expect(forceIncident(world, track, 'red')).toBe(true);
    expect(world.session.control.mode).toBe('red');
    run(world, track, 30, (w) => w.session.phase === 'lights');
    expect(world.session.phase).toBe('lights');
    // every car still racing sits on its grid slot, held, damage repaired
    const racing = world.cars.filter((c) => c.status === 'grid');
    expect(racing.length).toBeGreaterThanOrEqual(18);
    for (const c of racing) {
      expect(c.phys.speed).toBe(0);
      expect(c.phys.damage.frontWing).toBe(0);
      expect(Math.abs(c.phys.lateral - c.race.gridLat)).toBeLessThan(0.6);
    }
    expect(world.cars.some((c) => c.status === 'retired')).toBe(true);
    run(world, track, 20, (w) => w.session.phase === 'running');
    expect(world.session.control.mode).toBe('green');
    expect(Math.max(...world.cars.map((c) => c.timing.lapsCompleted))).toBe(leaderLapsBefore);
    run(world, track, 900);
    expect(isSessionOver(world)).toBe(true);
    const result = buildSessionResult(world);
    expect(result.rows[0].lapsCompleted).toBe(5);
    for (const r of result.rows) if (r.status === 'finished') expect(Number.isFinite(r.time ?? NaN)).toBe(true);
    expect(finite(world)).toBe(true);
  }, 90000);
});

describe('formation lap', () => {
  test('cars drive a lap in order, park on their slots, then the lights start the race', () => {
    const { world, track } = race({ layout: 'porto-lumen', laps: 2, formation: true });
    run(world, track, 4);
    expect(world.session.phase).toBe('formation');
    expect(world.session.control.mode).toBe('formation');
    let maxSlotError = 0;
    let checked = false;
    run(world, track, 400, (w) => {
      if (w.session.phase === 'lights' && !checked) {
        checked = true;
        for (const c of w.cars) {
          const e = Math.hypot(c.phys.lateral - c.race.gridLat, ((c.phys.s - c.race.gridS + track.length * 1.5) % track.length) - track.length / 2);
          maxSlotError = Math.max(maxSlotError, e);
        }
      }
      return w.session.phase === 'running';
    });
    expect(world.session.phase).toBe('running');
    expect(checked).toBe(true);
    expect(maxSlotError).toBeLessThan(0.5);
    expect(world.cars.every((c) => c.timing.lap === 1 && c.timing.lapsCompleted === 0)).toBe(true);
    run(world, track, 400);
    expect(isSessionOver(world)).toBe(true);
    expect(buildSessionResult(world).rows[0].lapsCompleted).toBe(2);
  }, 60000);
});

describe('flags and give-backs', () => {
  test('an overtake under the safety car must be given back, else a 5 s penalty', () => {
    const { world, track } = race({ laps: 5 });
    run(world, track, 40);
    expect(forceIncident(world, track, 'sc')).toBe(true);
    const [a, b] = world.race.order.slice(2, 4).map((id) => world.cars[id]);
    // classification swap (notePass is called for it)
    const swap = (): void => {
      [a.timing.position, b.timing.position] = [b.timing.position, a.timing.position];
    };
    notePass(world, track, b, a);
    swap();
    expect(b.flags.giveBack?.carId).toBe(a.id);
    // stays ahead → penalty when the time runs out
    for (let t = 0; t < 11; t += 0.5) stepGiveBack(world, 0.5);
    expect(b.flags.giveBack).toBeNull();
    expect(b.penalties.timeSec).toBe(5);
    // dropping back (in the classification) clears it without a penalty
    notePass(world, track, a, b);
    swap();
    expect(a.flags.giveBack?.carId).toBe(b.id);
    swap();
    stepGiveBack(world, 0.5);
    expect(a.flags.giveBack).toBeNull();
    expect(a.penalties.timeSec).toBe(0);
  });

  test('taking back a place that is owed is legal', () => {
    const { world, track } = race({ laps: 5 });
    run(world, track, 40);
    expect(forceIncident(world, track, 'sc')).toBe(true);
    const [a, b] = world.race.order.slice(2, 4).map((id) => world.cars[id]);
    notePass(world, track, b, a);
    [a.timing.position, b.timing.position] = [b.timing.position, a.timing.position];
    expect(b.flags.giveBack?.carId).toBe(a.id);
    // a passes b back: no give-back for a, and b's is settled once it is classified behind again
    notePass(world, track, a, b);
    expect(a.flags.giveBack).toBeNull();
    [a.timing.position, b.timing.position] = [b.timing.position, a.timing.position];
    stepGiveBack(world, 0.5);
    expect(b.flags.giveBack).toBeNull();
    expect(a.penalties.timeSec + b.penalties.timeSec).toBe(0);
  });

  for (const kind of ['sc', 'vsc'] as const) {
    test(`an AI car gives a place back under the ${kind === 'sc' ? 'safety car' : 'VSC'}`, () => {
      const { world, track } = race({ layout: 'highland-ridge', laps: 12 });
      run(world, track, 60);
      expect(forceIncident(world, track, kind)).toBe(true);
      run(world, track, kind === 'sc' ? 40 : 10);
      // the closest pair of running AI cars (as right after an illegal pass)
      const cars = world.race.order
        .map((id) => world.cars[id])
        .filter((c) => c.playerIndex === -1 && c.status === 'running' && c.pit.phase === 'none' && !c.ai.failing);
      let a = cars[0];
      let b = cars[1];
      for (let i = 0; i + 1 < cars.length; i++) {
        if (forwardDistance(track, cars[i + 1].phys.s, cars[i].phys.s) < forwardDistance(track, b.phys.s, a.phys.s)) {
          a = cars[i];
          b = cars[i + 1];
        }
      }
      a.flags.giveBack = { carId: b.id, timeLeft: GIVE_BACK_SEC };
      run(world, track, GIVE_BACK_SEC + 2);
      expect(a.timing.position).toBeGreaterThan(b.timing.position);
      expect(a.penalties.timeSec).toBe(0);
      expect(finite(world)).toBe(true);
    }, 60000);
  }

  test('safety-car limiter: a human racing flat out stays in the queue; without it a leader that passes the safety car is penalised and the safety car still comes in', () => {
    interface Drive {
      passes: number;
      penalties: number;
      scPenalties: number;
      aheadOfSc: number;
      green: boolean;
    }
    const drive = (start: number, scLimiter: boolean): Drive => {
      const { world, track } = race({ layout: 'highland-ridge', laps: 12, start, scLimiter });
      run(world, track, 60);
      expect(forceIncident(world, track, 'sc')).toBe(true);
      const me = world.cars.find((c) => c.playerIndex === 0)!;
      const c = world.session.control;
      const d: Drive = { passes: 0, penalties: 0, scPenalties: 0, aheadOfSc: 0, green: false };
      for (let i = 0; i < Math.round(600 / SIM_DT) && (c.mode === 'sc' || c.mode === 'scEnding'); i++) {
        // the human ignores the safety car: the AI's racing input as if the race were green
        const mode = c.mode;
        c.mode = 'green';
        const input = computeAIInput(world, me, track, SIM_DT);
        c.mode = mode;
        stepWorld(world, track, [input, null], SIM_DT);
        for (const e of world.events) {
          if (e.type === 'overtake' && e.carId === me.id) d.passes++;
          if (e.type === 'penalty' && e.carId === me.id) {
            d.penalties++;
            if (e.reason === '超越安全車') d.scPenalties++;
          }
        }
        world.events.length = 0;
        if (c.safetyCar.onTrack && world.race.scPitDist < 0 && world.race.scExitDist < 0) {
          const ahead = forwardDistance(track, c.safetyCar.s, me.phys.s);
          if (ahead > 0 && ahead < 100) d.aheadOfSc++;
        }
      }
      d.green = c.mode === 'green';
      expect(finite(world)).toBe(true);
      return d;
    };
    const clean: Drive = { passes: 0, penalties: 0, scPenalties: 0, aheadOfSc: 0, green: true };
    expect(drive(6, true)).toEqual(clean);
    expect(drive(1, true)).toEqual(clean);
    // without the assist the same driver passes cars ...
    const off6 = drive(6, false);
    expect(off6.passes).toBeGreaterThan(0);
    expect(off6.green).toBe(true);
    // ... and, leading, the safety car: penalised, yet the safety car does not stay out for it
    const off1 = drive(1, false);
    expect(off1.aheadOfSc).toBeGreaterThan(0);
    expect(off1.scPenalties).toBeGreaterThan(0);
    expect(off1.green).toBe(true);
  }, 300000);

  test('a car stranded on the racing surface brings out the VSC until it drives on', () => {
    const { world, track } = race({ layout: 'highland-ridge', laps: 8, safetyCar: 'reduced', seed: 5 });
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    const modes: string[] = [];
    let vscWhileStopped = false;
    for (let i = 0; i < Math.round(130 / SIM_DT) && !isSessionOver(world); i++) {
      const input = computeAIInput(world, me, track, SIM_DT);
      // the human stops on the road from 50 s to 75 s
      if (world.time > 50 && world.time < 75) {
        input.throttle = 0;
        input.brake = 1;
      }
      stepWorld(world, track, [input, null], SIM_DT);
      for (const e of world.events) if (e.type === 'raceControl') modes.push(e.mode);
      world.events.length = 0;
      if (world.session.control.mode === 'vsc' && me.phys.speed < 1) vscWhileStopped = true;
    }
    expect(vscWhileStopped).toBe(true);
    expect(modes.slice(0, 3)).toEqual(['vsc', 'vscEnding', 'green']);
    expect(world.session.control.mode).toBe('green');
  }, 60000);

  test('a car about to be lapped sees the blue flag', () => {
    const { world, track } = race({ layout: 'porto-lumen', laps: 8 });
    run(world, track, 60);
    // put the last car one lap down, 30 m ahead of the leader on the same line, at the leader's speed
    const leader = world.cars[world.race.order[0]];
    const slow = world.cars[world.race.order[world.race.order.length - 1]];
    const s = wrapS(track, leader.phys.s + 30);
    const lat = sampleAt(track, track.racingLine, s);
    const pose = poseAt(track, s, lat);
    const p = slow.phys;
    p.x = pose.x;
    p.z = pose.z;
    p.yaw = pose.yaw;
    p.vx = Math.sin(pose.yaw) * leader.phys.speed * 0.9;
    p.vz = Math.cos(pose.yaw) * leader.phys.speed * 0.9;
    p.speed = leader.phys.speed * 0.9;
    p.trackIndex = Math.round(s / track.spacing) % track.count;
    slow.race.lastS = s;
    slow.race.ctlS = s;
    slow.timing.progress = leader.timing.progress - track.length + 30;
    let blueEvent = false;
    for (let i = 0; i < Math.round(0.5 / SIM_DT); i++) {
      stepWorld(world, track, [computeAIInput(world, world.cars.find((c) => c.playerIndex === 0)!, track, SIM_DT), null], SIM_DT);
      if (world.events.some((e) => e.type === 'blueFlag' && e.carId === slow.id && e.forCarId === leader.id)) blueEvent = true;
      world.events.length = 0;
    }
    expect(blueEvent).toBe(true);
    expect(slow.flags.shown).toBe('blue');
  });
});

describe('human crashes', () => {
  interface CrashLog {
    /** peak contact impulse of the human (collision events) and its s at that moment */
    peak: number;
    peakS: number;
    /** 'incident' events of the human car until another car runs into it (a separate incident, e.g. on rejoining) */
    humanIncidents: number;
    /** impact incidents (copied when their response is decided) */
    decided: Incident[];
    /** reason of the human's 'retired' event, null if it did not retire */
    retired: string | null;
  }

  /** After the crash: stand on the brakes for 20 s, then the autopilot drives on. */
  const brakeFor20 = (input: ControlInput, t: number): void => {
    if (t < 20) {
      input.steer = 0;
      input.throttle = 0;
      input.brake = 1;
    }
  };

  /** isola-verde: a straight with a barrier on the left, reached shortly after 45 s whatever the field did. */
  const WALL_S = 2050;

  /**
   * The human steers into the wall at full throttle for `sec` from 45 s — or, with `at`, from the first time after
   * 45 s it reaches s = `at` (the same spot whatever the AI field did) — then `after` edits the autopilot input.
   */
  function crash(
    world: WorldState,
    track: BuiltTrack,
    o: { steer: number; sec: number; until: number; at?: number; after?: (input: ControlInput, t: number) => void },
  ): CrashLog {
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    const log: CrashLog = { peak: 0, peakS: 0, humanIncidents: 0, decided: [], retired: null };
    let start = o.at === undefined ? 45 : Infinity;
    let carHit = false;
    while (world.time < o.until && !isSessionOver(world)) {
      if (o.at !== undefined && start === Infinity && world.time >= 45 && me.phys.s >= o.at && me.phys.s < o.at + 40) start = world.time;
      const t = world.time - start;
      const input = computeAIInput(world, me, track, SIM_DT);
      if (t > 0 && t < o.sec) {
        input.steer = o.steer;
        input.throttle = 1;
        input.brake = 0;
      } else if (t >= o.sec) o.after?.(input, t);
      stepWorld(world, track, [input, null], SIM_DT);
      for (const e of world.events) {
        if (e.type === 'collision' && e.carId === me.id && t > 0 && e.impulse > log.peak) {
          log.peak = e.impulse;
          log.peakS = me.phys.s;
        }
        if (e.type === 'collision' && e.carId === me.id && t > 0 && e.otherCarId !== null) carHit = true;
        if (e.type === 'incident' && e.carId === me.id && !carHit) log.humanIncidents++;
        if (e.type === 'retired' && e.carId === me.id) log.retired = e.reason;
      }
      world.events.length = 0;
      for (const inc of world.race.incidents) {
        if (inc.impact > 0 && inc.response !== null && !log.decided.some((d) => d.id === inc.id)) log.decided.push({ ...inc });
      }
    }
    return log;
  }

  test('a hard hit the human drives away from leaves debris where it hit; the harder the hit, the likelier the safety car', () => {
    const responses: string[] = [];
    for (const seed of [1, 3, 5, 6, 7, 9]) {
      const { world, track } = race({ laps: 8, safetyCar: 'standard', seed });
      // until 64: on autopilot the human reaches the wall at 47–54 s (the incident is judged IMPACT_JUDGE_SEC later)
      const log = crash(world, track, { steer: -1, sec: 0.6, until: 64, at: WALL_S });
      expect(log.peak).toBeGreaterThan(HEAVY_IMPACT);
      expect(log.humanIncidents).toBe(1);
      const inc = log.decided[0];
      expect(inc).toBeDefined();
      // the car drove on: the debris stays where it hit, not with the car
      expect(inc.carId).toBe(-1);
      expect(Math.abs(signedDeltaS(track, log.peakS, inc.flagS))).toBeLessThan(40);
      expect(inc.recoverAt).not.toBeNull();
      responses.push(inc.response!);
    }
    expect(responses.every((r) => r === 'yellow' || r === 'vsc' || r === 'sc')).toBe(true);
    expect(responses).toContain('sc');
  }, 120000);

  test('a human who crashes hard and comes to rest is judged as an AI crash (never just a yellow), keeps racing, and the race goes green again', () => {
    const { world, track } = race({ laps: 8, safetyCar: 'standard', seed: 7 });
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    expect(world.config.rules.damage).not.toBe('full');
    const log = crash(world, track, { steer: -1, sec: 1, until: 300, at: WALL_S, after: brakeFor20 });
    expect(log.peak).toBeGreaterThan(HEAVY_IMPACT);
    const inc = log.decided[0];
    expect(inc).toBeDefined();
    expect(inc.carId).toBe(me.id);
    expect(['sc', 'vsc']).toContain(inc.response!);
    expect(me.status).toBe('running');
    expect(world.race.incidents.filter((i) => i.impact > 0)).toHaveLength(0);
    expect(world.session.control.mode).toBe('green');
  }, 120000);

  test('full damage: a single-car wreck red-flags the race, but the wreck is withdrawn and misses the restart (FIA B1.8.9)', () => {
    const { world, track } = race({ laps: 8, safetyCar: 'standard', seed: 1, damage: 'full' });
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    const log = crash(world, track, { steer: -1, sec: 1, until: 120, at: WALL_S, after: brakeFor20 });
    expect(me.phys.damage.suspension).toBe(1);
    const inc = log.decided[0];
    expect(inc).toBeDefined();
    expect(inc.carId).toBe(me.id);
    expect(inc.response).toBe('red');
    expect(world.session.control.counts.red).toBe(1);
    expect(log.retired).toBe(BROKEN_REASON);
    expect(me.status).toBe('retired');
    // the race restarted without it
    expect(world.session.phase).toBe('running');
    expect(world.session.control.mode).toBe('green');
    expect(me.phys.damage.suspension).toBe(1);
  }, 120000);

  test('reduced damage: a heavy enough hit also ends the race (no red flag: the AI crash rule)', () => {
    const { world, track } = race({ laps: 8, safetyCar: 'standard', seed: 1 });
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    expect(world.config.rules.damage).toBe('reduced');
    const log = crash(world, track, { steer: -1, sec: 1, until: 90, at: WALL_S, after: brakeFor20 });
    expect(log.peak).toBeGreaterThan(31_000);
    expect(me.phys.damage.suspension).toBe(1);
    expect(log.retired).toBe(BROKEN_REASON);
    expect(me.status).toBe('retired');
    expect(['sc', 'vsc']).toContain(log.decided[0]?.response ?? '');
    expect(world.session.control.counts.red).toBe(0);
  }, 120000);

  test('full damage: a wreck that involved another car ends the human race (retired, no red flag)', () => {
    const { world, track } = race({ laps: 8, safetyCar: 'standard', seed: 1, damage: 'full' });
    const me = world.cars.find((c) => c.playerIndex === 0)!;
    run(world, track, 44.9);
    // a stationary AI car right in front of the human
    const other = world.cars.find((c) => c.playerIndex === -1 && c.status === 'running' && c.pit.phase === 'none')!;
    const s = wrapS(track, me.phys.s + 12);
    const pose = poseAt(track, s, me.phys.lateral);
    const p = other.phys;
    p.x = pose.x;
    p.z = pose.z;
    p.yaw = pose.yaw;
    p.vx = 0;
    p.vz = 0;
    p.speed = 0;
    p.trackIndex = Math.round(s / track.spacing) % track.count;
    other.race.lastS = s;
    other.race.ctlS = s;
    other.timing.progress = me.timing.progress + 12;
    const log = crash(world, track, { steer: 0, sec: 0.5, until: 70, after: brakeFor20 });
    expect(me.phys.damage.suspension).toBe(1);
    const inc = log.decided[0];
    expect(inc).toBeDefined();
    expect(['sc', 'vsc']).toContain(inc.response!);
    expect(log.retired).toBe(BROKEN_REASON);
    expect(me.status).toBe('retired');
    expect(world.session.control.counts.red).toBe(0);
  }, 60000);

  test('light wall contact, or the safety car setting off: no incident', () => {
    const light = race({ laps: 8, safetyCar: 'standard', seed: 2 });
    const touch = crash(light.world, light.track, { steer: -1, sec: 0.6, until: 60 });
    expect(touch.peak).toBeGreaterThan(0);
    expect(touch.peak).toBeLessThan(HEAVY_IMPACT);
    expect(touch.humanIncidents).toBe(0);

    const off = race({ laps: 8, safetyCar: 'off', seed: 7 });
    const hit = crash(off.world, off.track, { steer: -1, sec: 0.6, until: 60 });
    expect(hit.peak).toBeGreaterThan(HEAVY_IMPACT);
    expect(hit.humanIncidents).toBe(0);
    const k = off.world.session.control.counts;
    expect(k.sc + k.vsc + k.red).toBe(0);
  }, 60000);
});

describe('incident budget', () => {
  test("'off' (and legacy configs) never neutralise; 'increased' does in most short races", () => {
    const off = race({ laps: 4, safetyCar: 'off', seed: 3 });
    run(off.world, off.track, 1200);
    const k = off.world.session.control.counts;
    expect(k.sc + k.vsc + k.red).toBe(0);

    let neutralised = 0;
    for (const seed of [1, 2, 3, 4]) {
      const { world, track } = race({ laps: 5, safetyCar: 'increased', seed });
      run(world, track, 1500);
      expect(isSessionOver(world)).toBe(true);
      expect(finite(world)).toBe(true);
      const c = world.session.control.counts;
      if (c.sc + c.vsc + c.red > 0) neutralised++;
    }
    expect(neutralised).toBeGreaterThanOrEqual(3);
  }, 180000);
});

describe('sprint and determinism', () => {
  test('sprint results award SPRINT_POINTS', () => {
    const { world, track } = race({ laps: 2, sprint: true });
    run(world, track, 600);
    const result = buildSessionResult(world);
    expect(result.sprint).toBe(true);
    const finishers = result.rows.filter((r) => r.status === 'finished');
    for (let i = 0; i < Math.min(8, finishers.length); i++) expect(finishers[i].points).toBe(SPRINT_POINTS[i]);
    expect(finishers.slice(8).every((r) => r.points === 0)).toBe(true);
  }, 60000);

  test('same seed ⇒ identical race control; a snapshot advances identically', () => {
    const a = race({ laps: 4, safetyCar: 'increased', seed: 5 });
    const b = race({ laps: 4, safetyCar: 'increased', seed: 5 });
    run(a.world, a.track, 200);
    run(b.world, b.track, 200);
    expect(JSON.stringify(a.world.session.control)).toBe(JSON.stringify(b.world.session.control));
    expect(a.world.cars.map((c) => c.phys.x)).toEqual(b.world.cars.map((c) => c.phys.x));
    const snap = snapshotWorld(a.world);
    run(a.world, a.track, 60);
    run(snap, a.track, 60);
    expect(JSON.stringify(snap.session.control)).toBe(JSON.stringify(a.world.session.control));
    expect(snap.cars.map((c) => c.timing.progress)).toEqual(a.world.cars.map((c) => c.timing.progress));
  }, 90000);
});
