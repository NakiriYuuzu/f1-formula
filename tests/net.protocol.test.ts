/**
 * Online wire formats (src/net/protocol.ts, mirror.ts): input packet / snapshot / own car state / reliable message
 * round trips, quantisation bounds, one packet per snapshot half on a full grid, malformed payloads dropped, one-shot counters firing exactly once under loss / duplication /
 * reordering (through HostSession's input buffer on a lossy loopback), HUD mirror patches.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, PlayerIndex, SessionConfig, WorldState } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { REAL_GRID } from '../src/data/realGrid';
import { getLayout } from '../src/data/tracks/index';
import { angleDiff } from '../src/core/math';
import { decodeFrame, encodeFrame } from '../src/app/replay';
import { buildRenderFrame, createWorld, stepWorld } from '../src/race/index';
import { HostSession } from '../src/net/host';
import { LoopbackNetwork } from '../src/net/loopback';
import { applyMirrorPatch, applyMirrorToWorld, diffMirror, mirrorView } from '../src/net/mirror';
import {
  INPUT_REDUNDANCY,
  ONE_PACKET_BYTES,
  ONE_SHOTS,
  decodeInputPacket,
  decodeMessage,
  decodeOwnState,
  decodeSnapshot,
  encodeInputPacket,
  encodeMessage,
  encodeOwnState,
  encodeSnapshot,
  ownStateExtras,
  quantizeInput,
  recordToInput,
  seqNewer,
  type InputRecord,
  type NetMessage,
} from '../src/net/protocol';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

// (a full online grid: 18 AI + 4 players, the real 2026 grid)
const REAL_RACERS = REAL_GRID.drivers.filter((d) => d.teamId !== '');

function config(layoutId: string, humans: PlayerIndex[] = [0, 1], laps = 3, cars = 6): SessionConfig {
  const racers = cars > RACERS.length ? REAL_RACERS : RACERS;
  const ids = racers.slice(0, cars);
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
    teams: cars > RACERS.length ? REAL_GRID.teams : TEAMS,
    drivers: racers,
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
  function raceWorld(cars = 6): { world: WorldState; track: ReturnType<typeof getLayout> } {
    const track = getLayout('silverstone');
    const world = createWorld(config('silverstone', [0, 1], 3, cars), track);
    for (let i = 0; i < 1200; i++) stepWorld(world, track, [control({ throttle: 1 }), control({ throttle: 0.8 })], SIM_DT);
    return { world, track };
  }

  /** Largest quantisation error allowed per render field (the rest travel as float32: exact after replay's packing). */
  const TOLERANCE: Record<string, number> = {
    yaw: 1e-4,
    pitch: 1e-4,
    roll: 1e-4,
    steerAngle: 1e-4,
    groundPitch: 1e-4,
    speed: 0.006,
    throttle: 0.5 / 255 + 1e-9,
    brake: 0.5 / 255 + 1e-9,
    slip: 0.5 / 255 + 1e-9,
    lockup: 0.5 / 255 + 1e-9,
    rpm: 0.5 + 1e-9,
  };

  test('round trip: every field of every car as replay packs it, within its quantisation step; seq, tick, marshal panels', () => {
    const { world, track } = raceWorld();
    const frame = buildRenderFrame(world, track);
    frame.cars[2]!.damage = { frontWing: 0.0004, rearWing: 0.5, floor: 1, suspension: 0 };
    const s = decodeSnapshot(encodeSnapshot({ seq: 4242, tick: world.tick, time: world.time, frame }))!;
    expect(s).not.toBeNull();
    expect(s.seq).toBe(4242);
    expect(s.tick).toBe(world.tick);
    expect(s.time).toBe(world.time);
    // what replay's float32 packing keeps of the frame: a field it packs that the snapshot forgot would differ here
    const packed = decodeFrame(world.time, encodeFrame(frame), null, 0);
    expect(s.frame.cars).toHaveLength(frame.cars.length);
    for (let i = 0; i < frame.cars.length; i++) {
      const want = packed.cars[i] as unknown as Record<string, unknown>;
      const got = s.frame.cars[i] as unknown as Record<string, unknown>;
      for (const [k, w] of Object.entries(want)) {
        const g = got[k];
        if (k === 'damage') {
          for (const [part, d] of Object.entries(w as Record<string, number>)) {
            const gd = (g as Record<string, number>)[part]!;
            // (a scratch below half a step reads as one step)
            expect(Math.abs(gd - d)).toBeLessThanOrEqual(1 / 255 + 1e-9);
            // a scratch never reads as intact
            expect(gd > 0).toBe(d > 0);
          }
        } else if (k === 'yaw') expect(Math.abs(angleDiff(w as number, g as number))).toBeLessThan(TOLERANCE.yaw!);
        else if (typeof w === 'number') expect(Math.abs((g as number) - w)).toBeLessThanOrEqual(TOLERANCE[k] ?? 0);
        else expect(g).toEqual(w);
      }
      expect(Math.abs((s.frame.cars[i]!.groundPitch ?? 0) - (frame.cars[i]!.groundPitch ?? 0))).toBeLessThan(TOLERANCE.groundPitch!);
    }
    expect(s.frame.raceControl?.mode).toBe(frame.raceControl?.mode ?? 'green');
    expect(s.frame.safetyCar).toBeNull();
  });

  test('a full 22-car grid with the safety car out: the frame and the own car each fit one packet', () => {
    const { world, track } = raceWorld(22);
    expect(world.cars.length).toBe(22);
    const frame = { ...buildRenderFrame(world, track), safetyCar: { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0.01, speed: 40, wheelSpin: 3, lightsOn: true } };
    const snap = encodeSnapshot({ seq: 1, tick: world.tick, time: world.time, frame });
    const own = encodeOwnState({ seq: 1, ack: 7, carId: 1, time: world.time, phys: world.cars[1]!.phys });
    expect(snap.byteLength).toBeLessThanOrEqual(ONE_PACKET_BYTES);
    expect(own.byteLength).toBeLessThanOrEqual(ONE_PACKET_BYTES);
    // both at 30 Hz: well under 50 KB/s (the JSON-and-float32 format took about 110 KB/s)
    expect(((snap.byteLength + own.byteLength) * 30) / 1024).toBeLessThan(50);
  });

  test('a safety car pose survives; truncated / corrupted / foreign snapshots are dropped', () => {
    const { world, track } = raceWorld();
    const frame = { ...buildRenderFrame(world, track), safetyCar: { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0.01, speed: 40, wheelSpin: 3, lightsOn: true } };
    const buf = encodeSnapshot({ seq: 9, tick: 9, time: 10, frame });
    expect(decodeSnapshot(buf)!.frame.safetyCar).toMatchObject({ x: 1, y: 2, z: 3, speed: 40, lightsOn: true });
    expect(decodeSnapshot(buf.slice(0, buf.byteLength - 3))).toBeNull();
    expect(decodeSnapshot(buf.slice(0, 10))).toBeNull();
    expect(decodeSnapshot('x')).toBeNull();
    // the first car's x (float32, after the 18-byte header, the 5 frame header floats and its id byte)
    const nan = buf.slice(0);
    new DataView(nan).setFloat32(18 + 5 * 4 + 1, Number.NaN);
    expect(decodeSnapshot(nan)).toBeNull();
    // another frame layout (another build)
    const layout = buf.slice(0);
    new DataView(layout).setUint8(17, 7);
    expect(decodeSnapshot(layout)).toBeNull();
    // an own state is no snapshot and the other way round
    const own = encodeOwnState({ seq: 9, ack: null, carId: 1, time: 10, phys: world.cars[1]!.phys });
    expect(decodeSnapshot(own)).toBeNull();
    expect(decodeOwnState(buf)).toBeNull();
  });

  test('own car state: exact (float64) round trip with seq, ack and host time; every leaf of real states in binary', () => {
    const { world } = raceWorld();
    const phys = world.cars[1]!.phys;
    const o = decodeOwnState(encodeOwnState({ seq: 65535, ack: 4242, carId: 1, time: 12.25, phys }))!;
    expect(o).not.toBeNull();
    expect(o.seq).toBe(65535);
    expect(o.ack).toBe(4242);
    expect(o.carId).toBe(1);
    expect(o.time).toBe(12.25);
    expect(o.phys).toEqual(phys);
    expect(decodeOwnState(encodeOwnState({ seq: 0, ack: null, carId: 1, time: 0, phys }))!.ack).toBeNull();
    // a state field missing from the binary list would travel as JSON: list it in protocol.ts OWN_NUMBERS / FLAGS / TEXTS
    const fresh = createWorld(config('silverstone'), getLayout('silverstone'));
    for (const c of [...world.cars, ...fresh.cars]) expect(ownStateExtras(c.phys)).toEqual([]);
  });

  test('own car state: a field not in the binary list, of another kind or absent still arrives as it was', () => {
    const { world } = raceWorld();
    const phys = structuredClone(world.cars[1]!.phys) as unknown as Record<string, unknown>;
    (phys.internal as Record<string, unknown>).later = 3.25;
    (phys.tire as Record<string, unknown>).laps = null;
    phys.extra = { list: [1, 2] };
    delete phys.lateral;
    const o = decodeOwnState(encodeOwnState({ seq: 1, ack: 1, carId: 1, time: 1, phys: phys as never }))!;
    expect(o.phys as unknown).toEqual(phys);
    expect('lateral' in o.phys).toBe(false);
    expect(ownStateExtras(phys as never).sort()).toEqual(['extra.list', 'internal.later', 'tire.laps']);
  });

  test('own car state: truncated, unsafe paths and non-finite essentials are dropped', () => {
    const { world } = raceWorld();
    const phys = world.cars[1]!.phys;
    const buf = encodeOwnState({ seq: 1, ack: 1, carId: 1, time: 1, phys });
    expect(decodeOwnState(buf.slice(0, buf.byteLength - 1))).toBeNull();
    expect(decodeOwnState(buf.slice(0, 12))).toBeNull();
    expect(decodeOwnState('x')).toBeNull();
    const nan = decodeOwnState(encodeOwnState({ seq: 1, ack: 1, carId: 1, time: 1, phys: { ...phys, x: Number.NaN } }));
    expect(nan).toBeNull();
    const unsafe = { ...structuredClone(phys), ['__proto__.polluted' as string]: 1 } as never;
    expect(decodeOwnState(encodeOwnState({ seq: 1, ack: 1, carId: 1, time: 1, phys: unsafe }))).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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
