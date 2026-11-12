/**
 * The guest's own car changing hands (src/net/client.ts Drive): a pit stop on the target link (130 ms round trip,
 * 30 ms jitter, 3 % loss). With pit assist the host drives the car from the pit entry to the exit and the guest draws it
 * from the snapshots meanwhile; without it the player drives the lane and the guest predicts the car there as on the
 * track, the host taking it only for the box. Going over to the host and back, and all along the lane, the drawn car
 * moves as far each 60 Hz frame as its drawn speed says.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, PlayerIndex, SessionConfig } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { createWorld, getPlayerCarId, stepWorld } from '../src/race/index';
import { forwardDistance } from '../src/track/track';
import { HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { LoopbackNetwork } from '../src/net/loopback';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(cars: number, pitAssist: boolean): SessionConfig {
  const ids = RACERS.slice(0, cars);
  const seats: PlayerIndex[] = [0, 1];
  return {
    mode: 'splitScreen',
    kind: 'race',
    layoutId: 'monza',
    laps: 50,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 80,
    players: seats.map((pi) => ({ playerIndex: pi, driverId: ids[pi]!.id, teamId: ids[pi]!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist } })),
    grid: ids.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: (seats.includes(i as PlayerIndex) ? i : -1) as -1 | PlayerIndex, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed: 21,
    ghost: null,
    objective: null,
  };
}

/** The guest (its car on the AI controller) asks for hard tyres at 15 s; the race runs until 3 s after the stop. */
function pitStop(pitAssist: boolean) {
  const track = getLayout('monza');
  const cfg = config(12, pitAssist);
  const net = new LoopbackNetwork({ delayMs: 50, jitterMs: 30, loss: 0.03, retransmitMs: 260, seed: 9 });
  const [h, c] = net.pair();
  const world = createWorld(cfg, track);
  const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
  const guest = new ClientSession(cfg, track, 1, 1, c);
  const car = world.cars[guest.carId]!;
  const phases = new Set<string>();
  let asked = false;
  let outAt: number | null = null;
  let last: { x: number; z: number; speed: number } | null = null;
  let worst = 0;
  let inPit = 0;
  let steps = 0;
  // reconciliations while the player drives the lane (the guest reconciles only a car it predicts)
  let laneReconciles = 0;
  while (world.time < 200 && (outAt === null || world.time < outAt + 3)) {
    const inputs: (ControlInput | null)[] = [null, null, null, null];
    inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
    host.fillInputs(inputs);
    stepWorld(world, track, inputs, SIM_DT);
    world.events.length = 0;
    host.afterStep();
    if (!asked && world.time >= 15) {
      asked = true;
      guest.requestPit('hard');
    }
    phases.add(car.pit.phase);
    if (outAt === null && phases.has('stopped') && car.pit.phase === 'none') outAt = world.time;
    guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
    guest.takeEvents();
    if (++steps % 2 === 0) {
      const own = guest.renderFrame(2 * SIM_DT).cars.find((x) => x.carId === guest.carId)!;
      if (last && world.time > 12) {
        worst = Math.max(worst, Math.abs(Math.hypot(own.x - last.x, own.z - last.z) - ((own.speed + last.speed) / 2) * 2 * SIM_DT));
        if (guest.car!.pit.phase !== 'none') inPit++;
      }
      last = { x: own.x, z: own.z, speed: own.speed };
    }
    const reconciled = guest.corrections;
    net.advance(SIM_DT * 1000);
    if (car.pit.phase !== 'none' && car.race.pitManual && !car.race.pitAuto) laneReconciles += guest.corrections - reconciled;
  }
  return { phases: [...phases].sort(), outAt, compound: car.phys.tire.compound, inPit, worst, laneReconciles };
}

/**
 * With pit assist, the guest predicting its car past the handoff point: the host's word that a stop is requested lands,
 * and its withdrawal three steps later, with no state of the own car for six steps more (the link holds it back: 75 ms,
 * an own-car state lost on a jittery link). The car goes to the host and straight back. The two words are put on the guest's mirrored car directly. Scores the drawn car from
 * there for 1.5 s, and whether the car stood still while the host had it.
 */
function requestWithdrawn() {
  const track = getLayout('monza');
  const cfg = config(12, true);
  const net = new LoopbackNetwork({ delayMs: 50, jitterMs: 30, loss: 0.03, retransmitMs: 260, seed: 9 });
  const [h, c] = net.pair();
  const world = createWorld(cfg, track);
  const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
  const guest = new ClientSession(cfg, track, 1, 1, c);
  const own = guest.car!;
  let at: number | null = null;
  let held: { x: number; z: number } | null = null;
  let stood = true;
  let last: { x: number; z: number; speed: number } | null = null;
  let worst = 0;
  let steps = 0;
  const step = () => {
    const inputs: (ControlInput | null)[] = [null, null, null, null];
    inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
    host.fillInputs(inputs);
    stepWorld(world, track, inputs, SIM_DT);
    world.events.length = 0;
    host.afterStep();
    guest.step(computeAIInput(guest.world, own, track, SIM_DT));
    guest.takeEvents();
    if (++steps % 2 === 0) {
      const drawn = guest.renderFrame(2 * SIM_DT).cars.find((x) => x.carId === guest.carId)!;
      if (last && at !== null) worst = Math.max(worst, Math.abs(Math.hypot(drawn.x - last.x, drawn.z - last.z) - ((drawn.speed + last.speed) / 2) * 2 * SIM_DT));
      last = { x: drawn.x, z: drawn.z, speed: drawn.speed };
    }
  };
  while (world.time < 200 && (at === null || world.time < at + 1.5)) {
    // 130 m before the entry: inside the handoff point (150 m)
    if (at === null && world.time > 12 && forwardDistance(track, own.phys.s, track.pit.entry) < 130) {
      at = world.time;
      own.pit.requested = true;
      for (let i = 0; i < 3; i++) {
        step();
        if (held && (own.phys.x !== held.x || own.phys.z !== held.z)) stood = false;
        held = { x: own.phys.x, z: own.phys.z };
      }
      own.pit.requested = false;
      for (let i = 0; i < 6; i++) step();
      net.advance(9 * SIM_DT * 1000);
      continue;
    }
    step();
    net.advance(SIM_DT * 1000);
  }
  return { at, stood, worst };
}

describe('online: the own car between the guest and the host', () => {
  test(
    'a pit stop with pit assist: into the lane, through the stop and back out the drawn car never jumps',
    () => {
      const r = pitStop(true);
      // the whole visit happened: in, stopped, out, on the new tyres, and the guest saw the lane from its seat
      expect(r.phases).toEqual(['entry', 'exit', 'lane', 'none', 'stopped']);
      expect(r.outAt).not.toBeNull();
      expect(r.compound).toBe('hard');
      expect(r.inPit).toBeGreaterThan(600);
      // (0.07 m measured.) Drawn from the last frame's place when it changes hands, a frame of motion is swallowed:
      // 1.3 m at 78 m/s; the lane drawn straight from each snapshot's extrapolation: 1.0–1.6 m
      expect(r.worst).toBeLessThan(0.3);
    },
    120_000,
  );

  test(
    'a pit stop driven by the player: the guest predicts its car down the lane, the stop completes, nothing jumps',
    () => {
      const r = pitStop(false);
      // (measured 766 and 0.02 m.) Followed from the snapshots once the car was 'pitting', the player steered a car
      // drawn a round trip late (3 reconciliations): here into the pit wall at the entry, where it stayed
      expect(r.laneReconciles).toBeGreaterThan(300);
      expect(r.phases).toEqual(['entry', 'exit', 'lane', 'none', 'stopped']);
      expect(r.compound).toBe('hard');
      expect(r.worst).toBeLessThan(0.3);
    },
    120_000,
  );

  test.failing(
    "the host takes the car and hands it straight back before its next state: the guest's inputs are played once",
    () => {
      const r = requestWithdrawn();
      expect(r.at).not.toBeNull();
      expect(r.stood).toBe(true);
      // e48caa8 played the unacknowledged inputs again on the state it had already played them on: the car ran
      // ahead and was pulled back by the next state (1.4-1.6 m in a frame on the target and a worse link)
      expect(r.worst).toBeLessThan(0.1);
    },
    120_000,
  );
});
