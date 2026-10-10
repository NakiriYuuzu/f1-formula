/**
 * Online wire formats (src/net/protocol.ts, mirror.ts): input packet / snapshot / reliable message round trips,
 * quantisation bounds, malformed payloads dropped, one-shot counters firing exactly once under loss / duplication /
 * reordering (through HostSession's input buffer on a lossy loopback), HUD mirror patches.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, PlayerIndex, SessionConfig, WorldState } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { buildRenderFrame, createWorld, stepWorld } from '../src/race/index';
import { HostSession } from '../src/net/host';
import { LoopbackNetwork } from '../src/net/loopback';
import { applyMirrorPatch, applyMirrorToWorld, diffMirror, mirrorView } from '../src/net/mirror';
import {
  INPUT_REDUNDANCY,
  ONE_SHOTS,
  decodeInputPacket,
  decodeMessage,
  decodeSnapshot,
  encodeInputPacket,
  encodeMessage,
  encodeSnapshot,
  quantizeInput,
  recordToInput,
  seqNewer,
  type InputRecord,
  type NetMessage,
} from '../src/net/protocol';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(layoutId: string, humans: PlayerIndex[] = [0, 1], laps = 3): SessionConfig {
  const ids = RACERS.slice(0, 6);
  return {
    mode: 'splitScreen',
    kind: 'race',
    layoutId,
    laps,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 80,
    players: humans.map((pi) => ({ playerIndex: pi, driverId: ids[pi]!.id, teamId: ids[pi]!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } })),
    grid: ids.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: (humans.includes(i as PlayerIndex) ? i : -1) as -1 | PlayerIndex, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed: 11,
    ghost: null,
    objective: null,
  };
}

const control = (o: Partial<ControlInput> = {}): ControlInput => ({
  throttle: 0,
  brake: 0,
  steer: 0,
  shiftUp: false,
  shiftDown: false,
  drsPressed: false,
  ersCycle: false,
  limiterToggle: false,
  overtakeHeld: false,
  ...o,
});

describe('input packets', () => {
  test('round trip, quantisation within half a step, newest first', () => {
    const recs: InputRecord[] = [];
    for (let i = 0; i < INPUT_REDUNDANCY; i++) {
      recs.push(quantizeInput(65534 + i, control({ throttle: 0.123 * i, brake: 1 - 0.1 * i, steer: -1 + 0.37 * i, overtakeHeld: i % 2 === 0 }), [i, 2 * i, 255, 0, 7]));
    }
    expect(recs[2]!.seq).toBe(0);
    const back = decodeInputPacket(encodeInputPacket(recs))!;
    expect(back).toEqual(recs);
    for (let i = 0; i < recs.length; i++) {
      const c = recordToInput(back[i]!);
      expect(Math.abs(c.throttle - Math.min(1, 0.123 * i))).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      expect(Math.abs(c.brake - (1 - 0.1 * i))).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      expect(Math.abs(c.steer - Math.max(-1, Math.min(1, -1 + 0.37 * i)))).toBeLessThanOrEqual(0.5 / 127 + 1e-9);
      expect(c.shiftUp || c.shiftDown || c.drsPressed || c.ersCycle || c.limiterToggle).toBe(false);
    }
    // out-of-range / non-finite inputs are clamped
    const wild = quantizeInput(1, control({ throttle: 7, brake: Number.NaN, steer: -9 }), []);
    expect([wild.throttle, wild.brake, wild.steer]).toEqual([255, 0, -127]);
    expect(seqNewer(0, 65535)).toBe(true);
    expect(seqNewer(65535, 0)).toBe(false);
  });

  test('malformed packets are dropped', () => {
    const good = encodeInputPacket([quantizeInput(1, control(), [0, 0, 0, 0, 0])]);
    expect(decodeInputPacket(good)).not.toBeNull();
    expect(decodeInputPacket(good.slice(0, good.byteLength - 1))).toBeNull();
    expect(decodeInputPacket(new ArrayBuffer(0))).toBeNull();
    expect(decodeInputPacket('hello')).toBeNull();
    const wrongType = good.slice(0);
    new DataView(wrongType).setUint8(0, 9);
    expect(decodeInputPacket(wrongType)).toBeNull();
    const badSteer = good.slice(0);
    new DataView(badSteer).setInt8(2 + 4, -128);
    expect(decodeInputPacket(badSteer)).toBeNull();
  });

  test('one-shots fire exactly once on the host despite loss, duplicates and reordering', () => {
    const track = getLayout('monza');
    for (const seed of [1, 2, 3]) {
      const world = createWorld(config('monza', [0, 1]), track);
      const net = new LoopbackNetwork({ delayMs: 80, jitterMs: 40, loss: 0.2, duplicate: 0.15, seed });
      const [clientEnd, hostEnd] = net.pair();
      const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'P2', transport: hostEnd }]);
      const counters = ONE_SHOTS.map(() => 0);
      const sent: InputRecord[] = [];
      const pressed = ONE_SHOTS.map(() => 0);
      const fired = ONE_SHOTS.map(() => 0);
      for (let step = 0; step < 600; step++) {
        // press some one-shot every 7 steps (never two of the same kind in a row closer than the packet cadence)
        if (step % 7 === 0 && step < 560) {
          const k = (step / 7) % ONE_SHOTS.length;
          counters[k] = (counters[k]! + 1) & 0xff;
          pressed[k]!++;
        }
        sent.unshift(quantizeInput(step, control({ throttle: 0.5 }), counters));
        if (sent.length > INPUT_REDUNDANCY) sent.length = INPUT_REDUNDANCY;
        if (step % 2 === 1) clientEnd.send('state', encodeInputPacket(sent));
        net.advance(SIM_DT * 1000);
        const inputs: (ControlInput | null)[] = [null, null, null, null];
        host.fillInputs(inputs);
        const c = inputs[1];
        if (c) ONE_SHOTS.forEach((k, i) => (fired[i] += c[k] ? 1 : 0));
      }
      // drain what is still in flight
      for (let i = 0; i < 60; i++) {
        clientEnd.send('state', encodeInputPacket(sent));
        net.advance(SIM_DT * 1000);
        const inputs: (ControlInput | null)[] = [null, null, null, null];
        host.fillInputs(inputs);
        const c = inputs[1];
        if (c) ONE_SHOTS.forEach((k, j) => (fired[j] += c[k] ? 1 : 0));
      }
      expect(net.droppedState).toBeGreaterThan(20);
      expect(fired).toEqual(pressed);
    }
  });
});

describe('snapshots', () => {
  function raceWorld(): { world: WorldState; track: ReturnType<typeof getLayout> } {
    const track = getLayout('silverstone');
    const world = createWorld(config('silverstone'), track);
    for (let i = 0; i < 1200; i++) stepWorld(world, track, [control({ throttle: 1 }), control({ throttle: 0.8 })], SIM_DT);
    return { world, track };
  }

  test('round trip: every car within float precision, ground pitch, marshal panels, own car state and ack', () => {
    const { world, track } = raceWorld();
    const frame = buildRenderFrame(world, track);
    const car = world.cars[1]!;
    const buf = encodeSnapshot({ tick: world.tick, time: world.time, ack: 4242, frame, own: { carId: car.id, phys: car.phys } });
    const s = decodeSnapshot(buf)!;
    expect(s).not.toBeNull();
    expect(s.tick).toBe(world.tick);
    expect(s.time).toBe(world.time);
    expect(s.ack).toBe(4242);
    expect(s.frame.cars).toHaveLength(frame.cars.length);
    for (let i = 0; i < frame.cars.length; i++) {
      const a = frame.cars[i]!;
      const b = s.frame.cars[i]!;
      expect(b.carId).toBe(a.carId);
      expect(Math.abs(b.x - a.x)).toBeLessThan(0.01);
      expect(Math.abs(b.z - a.z)).toBeLessThan(0.01);
      expect(Math.abs(b.yaw - a.yaw)).toBeLessThan(1e-4);
      expect(Math.abs((b.groundPitch ?? 0) - (a.groundPitch ?? 0))).toBeLessThan(1e-4);
      expect(b.compound).toBe(a.compound);
      expect(b.gear).toBe(a.gear);
    }
    expect(s.frame.raceControl?.mode).toBe(frame.raceControl?.mode ?? 'green');
    expect(s.own!.carId).toBe(car.id);
    expect(s.own!.phys.x).toBe(car.phys.x);
    expect(s.own!.phys.tire).toEqual(car.phys.tire);
    expect(s.own!.phys.internal).toEqual(car.phys.internal);
    // 20-ish cars at 30 Hz stay well under 100 KB/s
    const noOwn = encodeSnapshot({ tick: 1, time: 1, ack: null, frame, own: null });
    expect(decodeSnapshot(noOwn)!.ack).toBeNull();
    expect(decodeSnapshot(noOwn)!.own).toBeNull();
    expect((noOwn.byteLength * 30) / 1024).toBeLessThan(100);
  });

  test('a safety car pose survives; truncated / corrupted snapshots are dropped', () => {
    const { world, track } = raceWorld();
    const frame = { ...buildRenderFrame(world, track), safetyCar: { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0.01, speed: 40, wheelSpin: 3, lightsOn: true } };
    const buf = encodeSnapshot({ tick: 9, time: 10, ack: 1, frame, own: null });
    expect(decodeSnapshot(buf)!.frame.safetyCar).toMatchObject({ x: 1, y: 2, z: 3, speed: 40, lightsOn: true });
    expect(decodeSnapshot(buf.slice(0, buf.byteLength - 3))).toBeNull();
    expect(decodeSnapshot(buf.slice(0, 10))).toBeNull();
    expect(decodeSnapshot('x')).toBeNull();
    const nan = buf.slice(0);
    new DataView(nan).setFloat32(1 + 1 + 4 + 8 + 2 + 4 + 4 * 6, Number.NaN);
    expect(decodeSnapshot(nan)).toBeNull();
  });
});

describe('reliable messages', () => {
  test('valid messages round trip; wrong shapes, unknown types and non-JSON are dropped', () => {
    const msgs: NetMessage[] = [
      { t: 'join', version: 1, name: 'Ann' },
      { t: 'welcome', playerIndex: 2 },
      { t: 'ready', ready: true },
      { t: 'pick', teamId: 'a', driverId: 'b', setup: { frontWing: 3 } },
      { t: 'cmd', session: 3, command: { cmd: 'pit', compound: 'soft' } },
      { t: 'cmd', session: 3, command: { cmd: 'ers', mode: 'overtake' } },
      { t: 'events', session: 1, seq: 0, events: [{ type: 'lightsOut' }] },
      { t: 'pause', paused: false },
      { t: 'left', playerIndex: 3, name: 'Bo' },
      { t: 'ping', at: 12.5 },
      { t: 'ping', at: 3, pings: [null, 42, null, 180] },
    ];
    for (const m of msgs) expect(decodeMessage(encodeMessage(m))).toEqual(m);
    for (const bad of [
      '{"t":"welcome","playerIndex":4}',
      '{"t":"cmd","session":1,"command":{"cmd":"pit","compound":"slick"}}',
      '{"t":"cmd","session":1,"command":{"cmd":"warp"}}',
      '{"t":"events","session":1,"seq":0,"events":[1]}',
      '{"t":"nope"}',
      '{"t":"ping","at":"soon"}',
      '{"t":"ping","at":1,"pings":["fast"]}',
      '{"t":"ping","at":1,"pings":[1,2,3,4,5]}',
      '[1,2]',
      'not json',
    ]) {
      expect(decodeMessage(bad)).toBeNull();
    }
    expect(decodeMessage(new ArrayBuffer(4))).toBeNull();
  });
});

describe('HUD mirror', () => {
  test('patches carry only what changed and rebuild the host view on the client world', () => {
    const track = getLayout('monza');
    const host = createWorld(config('monza'), track);
    const client = createWorld(config('monza'), track);
    const v0 = mirrorView(host);
    let state = applyMirrorPatch(undefined, diffMirror(undefined, v0));
    for (let i = 0; i < 2400; i++) stepWorld(host, track, [control({ throttle: 1 }), control({ throttle: 1 })], SIM_DT);
    const v1 = mirrorView(host);
    const patch = diffMirror(v0, v1);
    expect(patch).toBeDefined();
    expect(JSON.stringify(patch).length).toBeLessThan(JSON.stringify(v1).length);
    state = applyMirrorPatch(state, patch);
    expect(state).toEqual(JSON.parse(JSON.stringify(v1)));
    expect(diffMirror(v1, mirrorView(host))).toBeUndefined();
    applyMirrorToWorld(client, state as Record<string, unknown>, 0);
    expect(client.session.phase).toBe(host.session.phase);
    expect(client.race.order).toEqual(host.race.order);
    for (let i = 0; i < host.cars.length; i++) {
      expect(client.cars[i]!.timing.position).toBe(host.cars[i]!.timing.position);
      expect(client.cars[i]!.timing.lapsCompleted).toBe(host.cars[i]!.timing.lapsCompleted);
      if (i !== 0) expect(client.cars[i]!.phys.tire.compound).toBe(host.cars[i]!.phys.tire.compound);
    }
    // the skipped car keeps its own (predicted) physics
    expect(client.cars[0]!.phys.s).not.toBeCloseTo(host.cars[0]!.phys.s, 0);
  });
});
