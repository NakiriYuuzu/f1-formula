/**
 * Online session end to end on the loopback transport (80 ms ± 30 ms, 5 % loss and duplicates on the state channel):
 * one HostSession (the host runs the world; its own car on the AI controller) and two ClientSessions (each drives its
 * car with the AI controller on its mirror world, as a player would with keys). Checks that client inputs drive the
 * host's cars, the interpolated cars match the host's history, events arrive complete and in order, a pit command
 * works, a guest dropping out hands its car to the AI and the race still finishes, everyone gets the same result and
 * the own-car prediction stays close.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, GameEvent, PlayerIndex, SessionConfig } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { buildSessionResult, createWorld, getPlayerCarId, isSessionOver, stepWorld } from '../src/race/index';
import { AI_TAKEOVER_SUFFIX, HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { LoopbackNetwork } from '../src/net/loopback';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(laps: number): SessionConfig {
  const ids = RACERS.slice(0, 8);
  const humans: PlayerIndex[] = [0, 1, 2];
  return {
    mode: 'splitScreen',
    kind: 'race',
    layoutId: 'monza',
    laps,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 80,
    players: humans.map((pi) => ({ playerIndex: pi, driverId: ids[pi]!.id, teamId: ids[pi]!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist: true } })),
    grid: ids.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: (i < 3 ? i : -1) as -1 | PlayerIndex, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed: 21,
    ghost: null,
    objective: null,
  };
}

describe('online session (loopback)', () => {
  test(
    'host + 2 clients: inputs drive the host cars, mirror tracks the host, events / pit / dropout / results',
    () => {
      const track = getLayout('monza');
      const cfg = config(3);
      const net = new LoopbackNetwork({ delayMs: 80, jitterMs: 30, loss: 0.05, duplicate: 0.03, seed: 5 });
      const [h1, c1] = net.pair();
      const [h2, c2] = net.pair();
      const world = createWorld(cfg, track);
      const left: number[] = [];
      const host = new HostSession(world, track, 1, [
        { playerIndex: 1, name: 'Ann', transport: h1 },
        { playerIndex: 2, name: 'Bo', transport: h2 },
      ], { playerLeft: (pi) => left.push(pi) });
      const a = new ClientSession(cfg, track, 1, 1, c1);
      const b = new ClientSession(cfg, track, 1, 2, c2);
      expect(a.carId).toBe(getPlayerCarId(world, 1));
      expect(b.carId).toBe(getPlayerCarId(world, 2));

      const forwarded: GameEvent[] = [];
      const received: GameEvent[] = [];
      // host positions by time (for checking the clients' interpolated cars)
      const history: { t: number; pos: { x: number; z: number }[] }[] = [];
      let maxInterpErr = 0;
      let interpChecks = 0;
      let pitAsked = false;
      let dropped = false;
      let steps = 0;
      while (!isSessionOver(world) && world.time < 600) {
        const inputs: (ControlInput | null)[] = [null, null, null, null];
        const hostCar = world.cars[getPlayerCarId(world, 0)]!;
        inputs[0] = computeAIInput(world, hostCar, track, SIM_DT);
        host.fillInputs(inputs);
        stepWorld(world, track, inputs, SIM_DT);
        const ev = world.events.splice(0);
        host.forwardEvents(ev);
        forwarded.push(...ev.filter((e) => e.type !== 'shift'));
        host.afterStep();
        history.push({ t: world.time, pos: world.cars.map((c) => ({ x: c.phys.x, z: c.phys.z })) });
        if (history.length > 400) history.shift();

        for (const c of [a, b]) {
          const car = c.car;
          if (!c.hostLeft && car && !(c === b && dropped)) c.step(computeAIInput(c.world, car, track, SIM_DT));
        }
        received.push(...a.takeEvents());
        b.takeEvents();
        net.advance(SIM_DT * 1000);
        steps++;

        // a pit request from client A on its second lap
        if (!pitAsked && a.car && a.world.cars[a.carId]!.timing.lap === 2 && a.world.session.phase === 'running') {
          a.requestPit('soft');
          pitAsked = true;
        }
        // client B's player drops out mid-race
        if (!dropped && world.time > 120) {
          c2.close();
          dropped = true;
        }
        // every second: the interpolated other cars of client A against the host's history at that time
        if (steps % 120 === 0 && world.session.phase === 'running') {
          const frame = a.renderFrame(0);
          const past = history.find((hh) => Math.abs(hh.t - frame.time) < SIM_DT / 2);
          if (past) {
            for (const rc of frame.cars) {
              if (rc.carId === a.carId) continue;
              const p = past.pos[rc.carId]!;
              maxInterpErr = Math.max(maxInterpErr, Math.hypot(rc.x - p.x, rc.z - p.z));
              interpChecks++;
            }
          }
        }
      }
      expect(isSessionOver(world)).toBe(true);
      const result = buildSessionResult(world);
      host.sendResult(result, true);
      host.forwardEvents(world.events.splice(0));
      for (let i = 0; i < 60; i++) net.advance(10);
      received.push(...a.takeEvents());

      // client inputs drove the host's cars: both completed laps (B's car under the AI after the dropout)
      const carA = world.cars[a.carId]!;
      const carB = world.cars[b.carId]!;
      expect(carA.status).toBe('finished');
      expect(carA.timing.lapsCompleted).toBe(3);
      expect(carA.pit.stops).toBe(1);
      expect(carA.phys.tire.compound).toBe('soft');
      // dropout: AI takeover, named, announced; the race finished for that car too
      expect(left).toEqual([2]);
      expect(carB.playerIndex).toBe(-1);
      expect(carB.displayName.endsWith(AI_TAKEOVER_SUFFIX)).toBe(true);
      expect(carB.status).toBe('finished');
      // (B closed its own link: nothing more to receive)
      b.dispose();
      // events: complete and in order
      expect(received.length).toBeGreaterThan(50);
      expect(received).toEqual(forwarded.concat(received.slice(forwarded.length)));
      expect(received.slice(0, forwarded.length)).toEqual(forwarded);
      // the same classification
      expect(a.result?.result).toEqual(result);
      expect(a.result?.final).toBe(true);
      // the mirror: positions, timing and the session state follow the host
      expect(a.world.session.phase).toBe(world.session.phase);
      for (const c of world.cars) expect(a.world.cars[c.id]!.timing.position).toBe(c.timing.position);
      // interpolation within a metre of the host's history; own-car prediction close to the host
      expect(interpChecks).toBeGreaterThan(100);
      expect(maxInterpErr).toBeLessThan(1);
      expect(a.corrections).toBeGreaterThan(1000);
      expect(a.maxCorrection).toBeLessThan(2);
    },
    120_000,
  );
});
