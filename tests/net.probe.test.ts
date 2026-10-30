/**
 * Round-trip probes (src/net/probe.ts): the codec, kept apart from the protocol's other binary messages, and on a
 * loopback link whose reliable channel loses and resends: the host's ping is the round trip of the 'state' channel
 * (two delays) where a reliable ping/pong would read the retransmissions, a guest from before the probes is still
 * timed by its pongs, and so is any guest once its probe echoes stop coming (the ping shows the outage).
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
import { LoopbackNetwork, type LoopbackOptions } from '../src/net/loopback';
import { decodeProbe, encodeProbe } from '../src/net/probe';
import { decodeInputPacket, decodeOwnState, decodeSnapshot } from '../src/net/protocol';
import type { NetTransport } from '../src/net/transport';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(seats: readonly PlayerIndex[], cars: number): SessionConfig {
  const ids = RACERS.slice(0, cars);
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
    players: seats.map((pi) => ({ playerIndex: pi, driverId: ids[pi]!.id, teamId: ids[pi]!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } })),
    grid: ids.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: (seats.includes(i as PlayerIndex) ? i : -1) as -1 | PlayerIndex, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed: 21,
    ghost: null,
    objective: null,
  };
}

describe('probe codec', () => {
  test('a probe and its echo round-trip in 9 bytes', () => {
    for (const echo of [false, true]) {
      const buf = encodeProbe({ echo, at: 123456.789 });
      expect(buf.byteLength).toBe(9);
      expect(decodeProbe(buf)).toEqual({ echo, at: 123456.789 });
    }
  });

  test('anything else is not a probe, and a probe is none of the other messages', () => {
    const probe = encodeProbe({ echo: false, at: 1000 });
    const retyped = new Uint8Array(probe.slice(0));
    retyped[0] = 3;
    const nan = new DataView(probe.slice(0));
    nan.setFloat64(1, Number.NaN);
    for (const bad of ['ping', probe.slice(0, 8), new ArrayBuffer(10), retyped.buffer, nan.buffer, null]) expect(decodeProbe(bad)).toBeNull();
    expect(decodeInputPacket(probe)).toBeNull();
    expect(decodeSnapshot(probe)).toBeNull();
    expect(decodeOwnState(probe)).toBeNull();
  });
});

/** The guest's end as a guest from before the probes sees it: probes are not for it, so it never echoes them. */
function oldGuest(t: NetTransport): NetTransport {
  const w: NetTransport = {
    get open() {
      return t.open;
    },
    send: (channel, data) => t.send(channel, data),
    buffered: (channel) => t.buffered(channel),
    onMessage: null,
    onClose: null,
    close: () => t.close(),
  };
  t.onMessage = (channel, data) => {
    if (!(channel === 'state' && decodeProbe(data))) w.onMessage?.(channel, data);
  };
  t.onClose = () => w.onClose?.();
  return w;
}

/**
 * Host + one guest (seat 1) on a 6-car grid driven by the AI: the host's ping of the guest each step from 3 s on.
 * `guestEnd` wraps the guest's transport; `onStep` sees the race time each step.
 */
function pings(opts: LoopbackOptions, seconds: number, guestEnd: (t: NetTransport) => NetTransport = (t) => t, onStep?: (time: number, net: LoopbackNetwork) => void): { at: number; ms: number }[] {
  const track = getLayout('monza');
  const cfg = config([0, 1], 6);
  const net = new LoopbackNetwork(opts);
  const [h, c] = net.pair();
  const world = createWorld(cfg, track);
  const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
  const guest = new ClientSession(cfg, track, 1, 1, guestEnd(c));
  guest.useClock({ now: () => net.now, owed: (since) => since });
  const out: { at: number; ms: number }[] = [];
  while (world.time < seconds) {
    const inputs: (ControlInput | null)[] = [null, null, null, null];
    inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
    host.fillInputs(inputs);
    stepWorld(world, track, inputs, SIM_DT);
    host.forwardEvents(world.events);
    world.events.length = 0;
    host.afterStep();
    guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
    guest.takeEvents();
    guest.renderFrame(SIM_DT);
    net.advance(SIM_DT * 1000);
    onStep?.(world.time, net);
    if (world.time >= 3) out.push({ at: world.time, ms: host.pingOf(1) });
  }
  return out;
}

describe('the ping on a link that loses and resends', () => {
  // 60 ms each way, 8 % loss; the reliable channel resends a lost message after 300 ms (SCTP-like)
  const LINK: LoopbackOptions = { delayMs: 60, jitterMs: 0, loss: 0.08, retransmitMs: 300, seed: 11 };

  test(
    'probes time the state channel: two delays, never a retransmission',
    () => {
      const p = pings(LINK, 20).map((s) => s.ms);
      expect(Math.min(...p)).toBeGreaterThanOrEqual(120);
      expect(Math.max(...p)).toBeLessThan(130);
    },
    60_000,
  );

  test(
    'a guest from before the probes is still timed, by its reliable pongs (which read the retransmissions)',
    () => {
      const p = pings(LINK, 20, oldGuest).map((s) => s.ms);
      expect(Math.min(...p)).toBeGreaterThanOrEqual(120);
      // a ping or pong lost, or waiting behind a lost message: 300 ms more
      expect(Math.max(...p)).toBeGreaterThan(400);
    },
    60_000,
  );

  test(
    'echoes that stop coming: the reliable pongs time the guest again, the ping reads the outage',
    () => {
      // from 8 s nothing the guest sends on the state channel arrives, and the route gets slower (150 ms each way)
      let silent = false;
      const muted = (t: NetTransport): NetTransport => {
        const send = t.send.bind(t);
        t.send = (channel, data) => {
          if (!(silent && channel === 'state')) send(channel, data);
        };
        return t;
      };
      const p = pings({ delayMs: 60, jitterMs: 0, seed: 11 }, 16, muted, (time, net) => {
        if (!silent && time >= 8) {
          silent = true;
          net.setDelay(150);
        }
      });
      const before = p.filter((s) => s.at < 8).map((s) => s.ms);
      const after = p.filter((s) => s.at >= 13).map((s) => s.ms);
      expect(Math.min(...before)).toBeGreaterThanOrEqual(120);
      expect(Math.max(...before)).toBeLessThan(130);
      // no longer the last echo's 120 ms: the pongs' two 150 ms delays
      expect(Math.min(...after)).toBeGreaterThanOrEqual(300);
      expect(Math.max(...after)).toBeLessThan(310);
    },
    60_000,
  );
});
