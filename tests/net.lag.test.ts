/**
 * Online lag (src/net/host.ts input timeline) on the loopback transport: lag spikes (everything held for 600 ms, then
 * a burst), a guest frame that loses time, a guest frozen for 3 s, a guest page hidden, a host frame that loses time
 * and host frames that stall and catch up (the App's online clock). The host guesses a
 * late input, replays the car with the real ones once they arrive and keeps its playout delay at the link's latency;
 * a guessed car is a ghost to the others (race netGhost). Online seats 3 and 4 get their car and drive it.
 */
import { describe, expect, test } from 'bun:test';
import type { ControlInput, PlayerIndex, SessionConfig } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { createWorld, getPlayerCarId, stepWorld } from '../src/race/index';
import { carContacts } from '../src/race/contact';
import { HostSession } from '../src/net/host';
import { ClientSession } from '../src/net/client';
import { LoopbackNetwork } from '../src/net/loopback';
import { FixedStepClock, ONLINE_MAX_BACKLOG, ONLINE_MAX_FRAME_DT, ONLINE_MAX_SUBSTEPS } from '../src/app/clock';
import { standardRoster } from '../src/meta/roster';
import { buildSessionConfig, validateSessionConfig } from '../src/meta/sessionBuilder';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(layoutId: string, seats: readonly PlayerIndex[], cars = 8): SessionConfig {
  const ids = RACERS.slice(0, cars);
  return {
    mode: 'splitScreen',
    kind: 'race',
    layoutId,
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

const ERS_ORDER = ['none', 'medium', 'hotlap', 'overtake'];
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

/** Host (its car on the AI) + one guest in seat 1 driving its car with the AI on its mirror world. */
function race(layoutId: string, owed?: (sinceLastStep: number) => number) {
  const track = getLayout(layoutId);
  const cfg = config(layoutId, [0, 1]);
  const net = new LoopbackNetwork({ delayMs: 40, jitterMs: 10, loss: 0.02, seed: 3 });
  const [h, c] = net.pair();
  const world = createWorld(cfg, track);
  const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now, ...(owed ? { owed } : {}) });
  const guest = new ClientSession(cfg, track, 1, 1, c);
  const hostStep = (): void => {
    const inputs: (ControlInput | null)[] = [null, null, null, null];
    inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
    host.fillInputs(inputs);
    stepWorld(world, track, inputs, SIM_DT);
    world.events.length = 0;
    host.afterStep();
  };
  const guestStep = (): void => {
    guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
    guest.takeEvents();
    guest.renderFrame(SIM_DT);
  };
  return { world, net, host, guest, hostStep, guestStep };
}

describe('online lag', () => {
  test(
    'lag spikes: late inputs are replayed (the car drives as the player saw it), the input delay comes back',
    () => {
      const { world, net, host, guest, hostStep, guestStep } = race('monaco');
      const spikes = [30, 40, 50, 60];
      const before: number[] = [];
      const after: number[] = [];
      let delayBefore = 0;
      while (world.time < 75) {
        hostStep();
        guestStep();
        net.advance(SIM_DT * 1000);
        if (spikes.length > 0 && world.time >= spikes[0]!) {
          spikes.shift();
          if (delayBefore === 0) delayBefore = host.inputDelayOf(1);
          net.stall(600);
        }
        if (world.time > 20 && world.time < 30) before.push(guest.pendingInputs);
        if (world.time > 68) after.push(guest.pendingInputs);
      }
      const car = world.cars[guest.carId]!;
      expect(car.status).toBe('running');
      // every spike: about 70 steps (0.6 s) guessed, then replayed with the real inputs
      expect(host.replayed).toBeGreaterThan(4 * 50);
      // the host's car is where the guest predicted it (measured 0.1 m; holding the last input instead: 34 m and
      // into the barriers)
      expect(guest.maxCorrection).toBeLessThan(1.5);
      // no delay left behind (measured 13 → 13 steps; buffering instead: 11 → 21)
      expect(median(after)).toBeLessThanOrEqual(median(before) + 1);
      expect(Math.abs(host.inputDelayOf(1) - delayBefore)).toBeLessThanOrEqual(1);
    },
    120_000,
  );

  test(
    'a guest frame and a host frame that lose 40 steps: the playout delay re-anchors, the input latency comes back',
    () => {
      const { world, net, guest, hostStep, guestStep } = race('monza');
      const before: number[] = [];
      const afterGuest: number[] = [];
      const afterHost: number[] = [];
      let hostHitch = false;
      while (world.time < 70) {
        if (!hostHitch && world.time >= 50) {
          // the host's frame stalls: the guest keeps sending
          hostHitch = true;
          for (let i = 0; i < 40; i++) {
            guestStep();
            net.advance(SIM_DT * 1000);
          }
        }
        hostStep();
        // the guest's frame stalls past what it catches up: 40 steps of its time lost
        if (world.time < 30 || world.time >= 30 + 40 * SIM_DT) guestStep();
        net.advance(SIM_DT * 1000);
        if (world.time > 20 && world.time < 30) before.push(guest.pendingInputs);
        if (world.time > 44 && world.time < 50) afterGuest.push(guest.pendingInputs);
        if (world.time > 64) afterHost.push(guest.pendingInputs);
      }
      expect(world.cars[guest.carId]!.status).toBe('running');
      expect(median(afterGuest)).toBeLessThanOrEqual(median(before) + 2);
      expect(median(afterHost)).toBeLessThanOrEqual(median(before) + 2);
      // and settled: the prediction matches the host again
      guest.maxCorrection = 0;
      for (let i = 0; i < 600; i++) {
        hostStep();
        guestStep();
        net.advance(SIM_DT * 1000);
      }
      expect(guest.maxCorrection).toBeLessThan(1.5);
    },
    120_000,
  );

  for (const dropped of [40, 60]) {
    test(
      `a host frame that drops ${dropped} steps: the guest's car keeps its place on the field and the guest's view follows the host's lost time`,
      () => {
        const { world, net, guest, hostStep } = race('monza');
        const track = getLayout('monza');
        const car = () => world.cars[guest.carId]!;
        // the guest's drawn own car against the host's car when the host reaches the frame's time: the other cars are
        // drawn at that time, so this is how far off they are relative to the own car
        const history: { t: number; x: number; z: number; v: number }[] = [];
        const drawn: { t: number; x: number; z: number; at: number }[] = [];
        const errs: { at: number; err: number }[] = [];
        const draw = (): void => {
          guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
          guest.takeEvents();
          const frame = guest.renderFrame(SIM_DT);
          const own = frame.cars.find((c) => c.carId === guest.carId);
          if (own && world.time > 45) drawn.push({ t: frame.time, x: own.x, z: own.z, at: world.time });
        };
        const HITCH = 50;
        let prev: { x: number; z: number } | null = null;
        let maxMove = 0;
        let gained = 0;
        while (world.time < 60) {
          if (prev === null && world.time >= HITCH) {
            // the host's frame stalls and the time is dropped; the guest keeps driving
            for (let i = 0; i < dropped; i++) {
              draw();
              net.advance(SIM_DT * 1000);
            }
            prev = { x: car().phys.x, z: car().phys.z };
          }
          hostStep();
          const p = car().phys;
          history.push({ t: world.time, x: p.x, z: p.z, v: p.speed });
          if (prev !== null && world.time < HITCH + 3) {
            // the guest's car's move this host step in steps of its speed: an extra step is 2
            const move = Math.hypot(p.x - prev.x, p.z - prev.z) / (p.speed * SIM_DT);
            maxMove = Math.max(maxMove, move);
            gained += move - 1;
          }
          if (prev !== null) prev = { x: p.x, z: p.z };
          while (drawn.length > 0 && drawn[0]!.t <= world.time) {
            const d = drawn.shift()!;
            const h = history.reduce((a, b) => (Math.abs(b.t - d.t) < Math.abs(a.t - d.t) ? b : a));
            // in seconds at the car's speed: how far ahead / behind in time the drawn car is (metres would depend on
            // where on the lap the AI field happens to put the car at the hitch)
            errs.push({ at: d.at, err: Math.hypot(d.x - h.x, d.z - h.z) / Math.max(10, h.v) });
          }
          draw();
          net.advance(SIM_DT * 1000);
        }
        const worst = (from: number, to: number): number => Math.max(...errs.filter((e) => e.at >= HITCH + from && e.at < HITCH + to).map((e) => e.err));
        // the guest's records of the lost time skipped, as the host's own cars lost it: no step gained, none taken twice
        // (measured 2.0 / 1.0 — the delay estimate settles a step more right after the skip: one extra step; every
        // record due at once: 42 / 64 steps in one host step and gained; extra steps up to the band: 30 gained)
        expect(maxMove).toBeLessThan(2.1);
        expect(gained).toBeLessThan(3);
        expect(car().status).toBe('running');
        // measured 1 / 2 steps (8.3 / 16.7 ms) after 0.3 s, 1 step after 1 s — at 24–26 m/s there (before the driver
        // styles) 0.21 / 0.40 m and 0.25 m, the bounds 1 m / 0.5 m. Host clock estimate pulled back 2 % a late snapshot:
        // 2.7 / 0.63 m (40 steps); view steered at most 25 % faster, set only 0.5 s off: 6.5–7.5 m (all at ≈ 25 m/s)
        expect(worst(0.3, 1)).toBeLessThan(0.04);
        expect(worst(1, 3)).toBeLessThan(0.019);
      },
      120_000,
    );
  }

  test(
    'host frames of 0.3 s and 0.5 s in a row, caught up by the online clock: no input skipped or guessed',
    () => {
      // the host runs frames as the App does: the online clock decides the steps of each frame, and the host learns
      // what that clock still owes (HostCallbacks.owed)
      const clock = new FixedStepClock(SIM_DT, ONLINE_MAX_SUBSTEPS, { maxFrameDt: ONLINE_MAX_FRAME_DT, maxBacklog: ONLINE_MAX_BACKLOG });
      const { world, net, host, guest, hostStep, guestStep } = race('monza', (since) => clock.owed(since));
      const hitches = [20, 25, 30, 35, 40];
      let delayBefore = 0;
      const corrections: number[] = [];
      let mark = -1;
      // wall time in steps: the guest steps and the link moves every step; the host's frame is 2 steps long, or a
      // stalled one of 36 steps followed by one of 60 (0.8 s caught up over the next frames, nothing dropped)
      const frames: number[] = [];
      let inFrame = 0;
      let wall = 0;
      while (wall < 44) {
        if (hitches.length > 0 && wall >= hitches[0]!) {
          hitches.shift();
          if (delayBefore === 0) delayBefore = host.inputDelayOf(1);
          guest.maxCorrection = 0;
          mark = wall;
          frames.push(36, 60);
        }
        guestStep();
        net.advance(SIM_DT * 1000);
        wall += SIM_DT;
        inFrame++;
        if (inFrame >= (frames[0] ?? 2)) {
          frames.shift();
          const n = clock.advance(inFrame * SIM_DT);
          for (let i = 0; i < n; i++) hostStep();
          inFrame = 0;
        }
        if (mark >= 0 && wall > mark + 3) {
          corrections.push(guest.maxCorrection);
          mark = -1;
        }
      }
      expect(corrections.length).toBe(5);
      // the host kept up with the wall clock (every step caught up)
      expect(Math.abs(world.time - wall)).toBeLessThan(0.05);
      // arrival ages in steps run (frozen while the host stalls): the delay shrank by the stall, every input after it
      // was late (6–24 m); the wall time since the last step without what the clock still owes: 17 m; owed capped
      // at 0.5 s (the clock can owe 0.7 s): 6.3 m; dropping the time instead: 6–23 m
      expect(Math.max(...corrections)).toBeLessThan(0.3);
      expect(Math.abs(host.inputDelayOf(1) - delayBefore)).toBeLessThanOrEqual(1);
      expect(world.cars[guest.carId]!.status).toBe('running');
    },
    120_000,
  );

  // the delay grows and the host takes its timeline back over records it has played: by more than LEAD_MAX (30) at
  // once (the route 300 ms slower at 15 s), or past the band's edge (~90 ms slower at 15, 15.8 and 16.6 s: ~11 holds
  // each, the band's 30 reached in the third). An ERS cycle pressed on every seq from the one due after the step back
  // to the last one played before it cycles the mode once per press: the ones played with their records before (the
  // jump: 3) are steps on the last input now, the guessed ones are played with their records
  for (const c of [
    { name: 'a jump of the delay', route: [[15, 320]] as const, from: 15, rise: 31, band: false },
    { name: 'a step past the band', route: [[15, 110], [15.8, 200], [16.6, 290]] as const, from: 16.7, rise: 3, band: true },
  ]) {
    test(`${c.name}: the timeline goes back over inputs already played, a one-shot still fires once`, () => {
      const run = (presses: ReadonlySet<number>) => {
        const track = getLayout('monza');
        const cfg = config('monza', [0, 1], 2);
        cfg.players[1] = { ...cfg.players[1]!, assists: { ...cfg.players[1]!.assists, ersAssist: false } };
        const net = new LoopbackNetwork({ delayMs: 20, jitterMs: 4, loss: 0, seed: 7 });
        const [h, t] = net.pair();
        const world = createWorld(cfg, track);
        const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
        const guest = new ClientSession(cfg, track, 1, 1, t);
        const car = world.cars[guest.carId]!;
        let seq = 0;
        let k = 0;
        let delay = -1;
        let back: { k: number; from: number; to: number; real: number; holdsBefore: number } | null = null;
        // the car's holds since 14 s: a step each it lost on the field
        let holds = 0;
        // ERS modes advanced (one step may run two records: the extra step of a shrunk delay)
        let cycles = 0;
        while (world.time < c.from + 6) {
          for (const [at, ms] of c.route) if (Math.abs(world.time - at) < SIM_DT / 2) net.setDelay(ms);
          const mode = car.phys.ers.mode;
          const inputs: (ControlInput | null)[] = [null, null, null, null];
          inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
          host.fillInputs(inputs);
          stepWorld(world, track, inputs, SIM_DT);
          world.events.length = 0;
          host.afterStep();
          cycles += (ERS_ORDER.indexOf(car.phys.ers.mode) - ERS_ORDER.indexOf(mode) + 4) % 4;
          const held = world.time > 14 && car.race.netHold === true;
          if (held) holds++;
          const d = host.inputDelayOf(1);
          // step k plays seq k − delay: the step back goes to that seq (past the band: to the band's edge after it)
          if (!back && world.time > c.from && delay >= 0 && d - delay >= c.rise) back = { k, from: delay, to: k - d, real: host.playedRecordOf(1), holdsBefore: holds - (held ? 1 : 0) };
          delay = d;
          k++;
          const input = computeAIInput(guest.world, guest.car!, track, SIM_DT);
          input.ersCycle = presses.has(seq++);
          guest.step(input);
          guest.takeEvents();
          net.advance(SIM_DT * 1000);
        }
        return { back, delay, holds, cycles, host: car.phys.ers.mode, guest: guest.car!.phys.ers.mode };
      };
      const dry = run(new Set());
      const back = dry.back!;
      expect(back).not.toBeNull();
      expect(dry.cycles).toBe(0);
      const rise = dry.delay - back.from;
      if (c.band) {
        // no jump; the holds stop at the band's edge (LEAD_MAX 30 steps lost on the field), the rest taken at once
        expect(rise).toBeLessThanOrEqual(30);
        expect(dry.holds).toBeLessThanOrEqual(30);
        expect(dry.holds - back.holdsBefore).toBeLessThan(rise);
      } else {
        expect(rise).toBeGreaterThan(30);
        // seqs played with their records before are gone back over (3 here: the 409fe48 timeline played them again)
        expect(back.real).toBeGreaterThanOrEqual(back.to);
      }
      // the last seq played before the step back (step k plays seq k − delay) and every one back to `to` (past the
      // band only the last: the step back goes to the band's edge, the guesses before it stay final — a press in them
      // fires with the next record, several in a row as one)
      const last = back.k - back.from - 1;
      const first = c.band ? last : back.to;
      const presses = new Set(Array.from({ length: last - first + 1 }, (_, i) => first + i));
      const pressed = run(presses);
      // played again with their records (the counters newer by then): a press fired once more per record (409fe48 and
      // a timeline played again over its records); lost: guesses not replaced by their records (the band alone)
      expect(pressed.cycles).toBe(presses.size);
      expect(pressed.guest).toBe(pressed.host);
    }, 120_000);
  }

  test(
    "guest frames of 0.4 s and 0.5 s, caught up by the online clock: the other cars never jump back on the guest's screen",
    () => {
      // the guest runs frames as the App does (ClientSession.useClock: snapshots that arrive while its frame stalls
      // are timed with the steps the clock still owes); the host steps with the wall clock
      const clock = new FixedStepClock(SIM_DT, ONLINE_MAX_SUBSTEPS, { maxFrameDt: ONLINE_MAX_FRAME_DT, maxBacklog: ONLINE_MAX_BACKLOG });
      const { world, net, guest, hostStep } = race('monza');
      guest.useClock({ now: () => net.now, owed: (since) => clock.owed(since) });
      const track = getLayout('monza');
      const hitches = [20, 25, 30, 35, 40];
      const frames: number[] = [];
      let inFrame = 0;
      const last = new Map<number, { x: number; z: number }>();
      let backwards = 0;
      let drawnFrames = 0;
      while (world.time < 44) {
        if (hitches.length > 0 && world.time >= hitches[0]!) frames.push(hitches.shift()! % 10 === 0 ? 48 : 60);
        hostStep();
        net.advance(SIM_DT * 1000);
        inFrame++;
        if (inFrame < (frames[0] ?? 2)) continue;
        frames.shift();
        const n = clock.advance(inFrame * SIM_DT);
        inFrame = 0;
        for (let i = 0; i < n; i++) {
          guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
          guest.takeEvents();
        }
        const frame = guest.renderFrame(n * SIM_DT);
        if (world.time < 15) continue;
        drawnFrames++;
        for (const c of frame.cars) {
          if (c.carId === guest.carId) continue;
          const p = last.get(c.carId);
          // this frame's move along the car's heading: backwards at speed is a jump back
          if (p && c.speed > 20 && (c.x - p.x) * Math.sin(c.yaw) + (c.z - p.z) * Math.cos(c.yaw) < -1) backwards++;
          last.set(c.carId, { x: c.x, z: c.z });
        }
      }
      expect(drawnFrames).toBeGreaterThan(800);
      // arrivals timed by the steps run so far (stalled with the frame): the host clock estimate ran ahead by the stall,
      // the view jumped forward and then back — 15 jumps back of 4–18 m in this run (measured 0; 409fe48 had none)
      expect(backwards).toBe(0);
    },
    120_000,
  );

  for (const hidden of [1, 5]) {
    test(
      `a guest page hidden for ${hidden} s: the first frame back jumps the other cars to the present, the next 0.1 s is smooth`,
      () => {
        // the App runs no frames while the page is hidden and skips that time when it is shown (ClientSession.skipTime)
        const clock = new FixedStepClock(SIM_DT, ONLINE_MAX_SUBSTEPS, { maxFrameDt: ONLINE_MAX_FRAME_DT, maxBacklog: ONLINE_MAX_BACKLOG });
        const { world, net, guest, hostStep } = race('monza');
        guest.useClock({ now: () => net.now, owed: (since) => clock.owed(since) });
        const track = getLayout('monza');
        const last = new Map<number, { x: number; z: number }>();
        let inFrame = 0;
        let back = -1;
        let backFrames = 0;
        let worst = 0;
        while (world.time < 20 + hidden + 0.5) {
          hostStep();
          net.advance(SIM_DT * 1000);
          inFrame++;
          if (world.time >= 20 && world.time < 20 + hidden) {
            if (back < 0) guest.skipTime();
            back = 0;
            inFrame = 0;
            continue;
          }
          if (back === 0) back = world.time;
          if (inFrame < 2 && !(back > 0 && backFrames === 0)) continue;
          // (the first frame back: no time)
          const n = clock.advance(back > 0 && backFrames === 0 ? 0 : inFrame * SIM_DT);
          inFrame = 0;
          for (let i = 0; i < n; i++) {
            guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
            guest.takeEvents();
          }
          const frame = guest.renderFrame(n * SIM_DT);
          let move = 0;
          for (const c of frame.cars) {
            if (c.carId === guest.carId) continue;
            const p = last.get(c.carId);
            if (p) move = Math.max(move, Math.hypot(c.x - p.x, c.z - p.z));
            last.set(c.carId, { x: c.x, z: c.z });
          }
          if (back > 0) backFrames++;
          // from the second frame back (the first, with no step, jumps to the present), the next 0.1 s
          if (backFrames >= 2 && world.time < back + 0.1) worst = Math.max(worst, move);
        }
        expect(backFrames).toBeGreaterThan(5);
        // 60 Hz frames at up to 89 m/s: 1.5 m. With the hidden time counted as steps still owed: 10–45 m jumps; the first
        // frame back drawn at the view left behind: the jump a frame later (16–61 m). (Not measured: 0.13–0.3 s later the
        // host re-anchors this guest's timeline, its own car is put right and the other cars move with it, 4–15 m)
        expect(worst).toBeLessThan(3);
      },
      120_000,
    );
  }

  test(
    'a guest frozen for 3 s (a background tab) drives its car again right after it is back',
    () => {
      const { world, net, guest, hostStep, guestStep } = race('monza');
      const brake: ControlInput = { throttle: 0, brake: 1, steer: 0, shiftUp: false, shiftDown: false, drsPressed: false, ersCycle: false, limiterToggle: false, overtakeHeld: false };
      let back = -1;
      const throttle: number[] = [];
      while (world.time < 40) {
        hostStep();
        if (world.time < 30) guestStep();
        else if (world.time >= 33) {
          if (back < 0) back = world.time;
          if (world.time < back + 1.3) {
            // back: full brakes at once
            guest.step(brake);
            guest.takeEvents();
            guest.renderFrame(SIM_DT);
          } else guestStep();
          if (world.time > back + 2) expect(guest.pendingInputs).toBeGreaterThan(0);
        }
        net.advance(SIM_DT * 1000);
        if (back >= 0 && world.time > back + 0.3 && world.time < back + 1.3) throttle.push(world.cars[guest.carId]!.phys.throttle);
      }
      // the host applies the guest's braking within 0.3 s (re-anchoring by holding instead: 3 s of old inputs)
      expect(throttle.length).toBeGreaterThan(100);
      expect(Math.max(...throttle)).toBeLessThan(0.05);
      guest.maxCorrection = 0;
      for (let i = 0; i < 360; i++) {
        hostStep();
        guestStep();
        net.advance(SIM_DT * 1000);
      }
      expect(guest.maxCorrection).toBeLessThan(1.5);
    },
    120_000,
  );

  test('a car driven on a guess for a while (race netGhost) touches no other car', () => {
    const track = getLayout('monza');
    const world = createWorld(config('monza', [0], 2), track);
    const [a, b] = world.cars as [(typeof world.cars)[0], (typeof world.cars)[0]];
    const overlap = (): void => {
      b.phys.x = a.phys.x + 1;
      b.phys.z = a.phys.z;
      b.phys.s = a.phys.s;
      world.events.length = 0;
    };
    overlap();
    a.race.netGhost = true;
    carContacts(world, track);
    expect(world.events.some((e) => e.type === 'collision')).toBe(false);
    expect(b.phys.x).toBe(a.phys.x + 1);
    a.race.netGhost = false;
    a.phys.vx = 30;
    carContacts(world, track);
    expect(b.phys.x).not.toBe(a.phys.x + 1);
  });

  test('online seats 3 and 4 are in the session and drive their own cars', () => {
    const roster = standardRoster();
    const ds = roster.drivers.slice(0, 4);
    const built = buildSessionConfig({
      mode: 'splitScreen',
      kind: 'race',
      layoutId: 'monza',
      raceLaps: 3,
      weather: 'clear',
      timeOfDay: 'auto',
      regulation: '2025',
      aiDifficulty: 80,
      qualifying: 'oneShot',
      rules: { ...DEFAULT_RULES },
      seed: 1,
      players: ds.map((d, i) => ({ playerIndex: i as PlayerIndex, driverId: d.id, teamId: d.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS }, startCompound: null })),
      roster,
      aiCount: 4,
      gridOrder: null,
      playerStartPosition: null,
      ghost: null,
      objective: null,
    });
    expect(validateSessionConfig(built)).toEqual([]);
    expect(built.players.map((p) => p.playerIndex)).toEqual([0, 1, 2, 3]);
    expect(built.grid.filter((g) => g.playerIndex !== -1).map((g) => g.playerIndex).sort()).toEqual([0, 1, 2, 3]);
    // no input from anyone for 30 s: every human car is still on the grid (the AI would be racing)
    const track = getLayout('monza');
    const world = createWorld(config('monza', [0, 1, 2, 3], 6), track);
    const idle: ControlInput = { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false, drsPressed: false, ersCycle: false, limiterToggle: false, overtakeHeld: false };
    for (let i = 0; i < 30 / SIM_DT; i++) stepWorld(world, track, [idle, idle, idle, idle], SIM_DT);
    for (const pi of [0, 1, 2, 3] as const) expect(world.cars[getPlayerCarId(world, pi)]!.phys.speed).toBeLessThan(1);
    expect(Math.max(...world.cars.filter((c) => c.playerIndex === -1).map((c) => c.timing.progress))).toBeGreaterThan(300);
  });
});
