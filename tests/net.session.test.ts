/**
 * Online session end to end on the loopback transport (80 ms ± 30 ms, 5 % loss and duplicates on the state channel):
 * one HostSession (the host runs the world; its own car on the AI controller) and two ClientSessions (each drives its
 * car with the AI controller on its mirror world, as a player would with keys). Checks that client inputs drive the
 * host's cars, the other cars are drawn on the own car's timeline (both match the host's history at the frame's
 * time), events arrive complete and in order, a pit command works, a guest dropping out hands its car to the AI and
 * the race still finishes, everyone gets the same result and the own-car prediction stays close.
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
      // host positions by time (for checking the clients' drawn cars)
      const history: { t: number; pos: { x: number; z: number }[] }[] = [];
      const hostAt = (t: number, id: number): { x: number; z: number } | null => {
        const i = history.findIndex((hh) => hh.t >= t);
        if (i <= 0) return null;
        const a = history[i - 1]!;
        const b = history[i]!;
        const f = (t - a.t) / (b.t - a.t);
        const pa = a.pos[id]!;
        const pb = b.pos[id]!;
        return { x: pa.x + (pb.x - pa.x) * f, z: pa.z + (pb.z - pa.z) * f };
      };
      // client A's frames waiting for the host to reach their time
      const drawn: { t: number; cars: { id: number; x: number; z: number }[] }[] = [];
      const othersErr: number[] = [];
      const ownErr: number[] = [];
      // client A's own lap timer and the other cars' race distance (worked out on the guest) against the host's
      const lapTimerErr: number[] = [];
      const distanceErr: number[] = [];
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
        while (drawn.length > 0 && drawn[0]!.t <= world.time) {
          const d = drawn.shift()!;
          for (const rc of d.cars) {
            const p = hostAt(d.t, rc.id);
            if (!p) continue;
            const e = Math.hypot(rc.x - p.x, rc.z - p.z);
            (rc.id === a.carId ? ownErr : othersErr).push(e);
          }
        }

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
        // client A draws every step; every half second its cars are checked against the host once it reaches the
        // frame's time
        const frame = a.hostLeft ? null : a.renderFrame(SIM_DT);
        if (frame && steps % 60 === 0 && world.session.phase === 'running' && world.time > 10) {
          drawn.push({ t: frame.time, cars: frame.cars.map((c) => ({ id: c.carId, x: c.x, z: c.z })) });
          const own = world.cars[a.carId]!;
          if (own.status === 'running') lapTimerErr.push(Math.abs(a.car!.timing.currentLapTime - own.timing.currentLapTime));
          for (const c of world.cars) {
            if (c.id !== a.carId && c.status === 'running') distanceErr.push(Math.abs(a.world.cars[c.id]!.timing.progress - c.timing.progress));
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
      // one timeline: the own car (predicted) and the other cars (extrapolated) both where the host had them at the
      // frame's time; own-car prediction close to the host
      const mean = (xs: number[]): number => xs.reduce((x, y) => x + y, 0) / xs.length;
      const p95 = (xs: number[]): number => [...xs].sort((x, y) => x - y)[Math.floor(xs.length * 0.95)]!;
      // (measured 0.45 / 0.85 m own, 0.29 / 1.06 m others; drawing the others interpolated 0.1 s behind the clock
      // left the own car 18 m ahead of them on average)
      expect(ownErr.length).toBeGreaterThan(100);
      expect(othersErr.length).toBeGreaterThan(500);
      expect(mean(ownErr)).toBeLessThan(1);
      expect(p95(ownErr)).toBeLessThan(2);
      expect(mean(othersErr)).toBeLessThan(1);
      expect(p95(othersErr)).toBeLessThan(3);
      // the mirror is per receiver: A's own lap timer comes with A's view, the others' race distance is A's own work
      // (measured p95 0.10 s and 9.7 m; a view without A's timing left its lap timer running on: 211 s at lap 3)
      expect(lapTimerErr.length).toBeGreaterThan(100);
      expect(p95(lapTimerErr)).toBeLessThan(0.5);
      expect(distanceErr.length).toBeGreaterThan(1000);
      expect(p95(distanceErr)).toBeLessThan(30);
      expect(Math.max(...distanceErr)).toBeLessThan(60);
      // round trips: the host measures each guest, the guest learns its own (80 ± 30 ms each way); B is gone
      expect(a.ping).not.toBeNull();
      expect(a.ping!).toBeGreaterThan(80);
      expect(a.ping!).toBeLessThan(400);
      const pings = host.pings();
      expect(pings.map((p) => [p.playerIndex, p.name])).toEqual([[1, 'Ann']]);
      expect(pings[0]!.ms).toBe(host.pingOf(1));
      expect(a.corrections).toBeGreaterThan(1000);
      expect(a.maxCorrection).toBeLessThan(2);
    },
    120_000,
  );
});
