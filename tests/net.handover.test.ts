/**
 * The guest's own car changing hands (src/net/client.ts Drive): a pit stop on the target link (130 ms round trip,
 * 30 ms jitter, 3 % loss). The host drives the car from the pit entry to the exit and the guest draws it from the
 * snapshots meanwhile; going over to the host and back, and all along the lane, the drawn car moves as far each 60 Hz
 * frame as its drawn speed says.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, PlayerIndex, SessionConfig } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { createWorld, getPlayerCarId, stepWorld } from '../src/race/index';
import { HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { LoopbackNetwork } from '../src/net/loopback';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(cars: number): SessionConfig {
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
    players: seats.map((pi) => ({ playerIndex: pi, driverId: ids[pi]!.id, teamId: ids[pi]!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist: true } })),
    grid: ids.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: (seats.includes(i as PlayerIndex) ? i : -1) as -1 | PlayerIndex, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed: 21,
    ghost: null,
    objective: null,
  };
}

describe('online: the own car between the guest and the host', () => {
  test(
    'a pit stop with pit assist: into the lane, through the stop and back out the drawn car never jumps',
    () => {
      const track = getLayout('monza');
      const cfg = config(12);
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
      let hosted = 0;
      let steps = 0;
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
            if (guest.car!.pit.phase !== 'none') hosted++;
          }
          last = { x: own.x, z: own.z, speed: own.speed };
        }
        net.advance(SIM_DT * 1000);
      }
      // the whole visit happened: in, stopped, out, on the new tyres, and the guest saw the lane from its seat
      expect([...phases].sort()).toEqual(['entry', 'exit', 'lane', 'none', 'stopped']);
      expect(outAt).not.toBeNull();
      expect(car.phys.tire.compound).toBe('hard');
      expect(hosted).toBeGreaterThan(600);
      // (0.07 m measured.) Drawn from the last frame's place when it changes hands, a frame of motion is swallowed:
      // 1.3 m at 78 m/s; the lane drawn straight from each snapshot's extrapolation: 1.0–1.6 m
      expect(worst).toBeLessThan(0.3);
    },
    120_000,
  );
});
