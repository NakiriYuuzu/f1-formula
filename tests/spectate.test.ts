/**
 * Spectating after a retirement in a multiplayer session: who a player whose car is out watches (another human still
 * racing first, else the leader), when the view switches over (after the 退賽 banner, or at the first switch press),
 * stepping through the running order, handing over when the watched car drops out, back to the own car when it races
 * again; the switch-key hints; the view HUD showing the watched car (own live delta / fuel measure kept aside); and on
 * an online guest (loopback) the watched cars drawn as the host had them once it spectates, with their lap timers
 * running.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ControlInput, PlayerIndex, SessionConfig, WorldState } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETTINGS, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { COAST_INPUT, createWorld, getPlayerCarId, isSessionOver, retireCar, stepWorld } from '../src/race/index';
import { Spectator, canWatch, firstWatch, stepWatch, watchOrder } from '../src/app/spectate';
import { spectateHintItems } from '../src/ui/hud/controls';
import { ViewHud, type ViewFrame } from '../src/ui/hud/viewHud';
import { keyLabel } from '../src/ui/menus/labels';
import { HostSession } from '../src/net/host';
import { ClientSession, INTERP_DELAY } from '../src/net/client';
import { LoopbackNetwork } from '../src/net/loopback';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function config(humans: number, laps = 3): SessionConfig {
  const ids = RACERS.slice(0, 8);
  const players = Array.from({ length: humans }, (_, i) => i as PlayerIndex);
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
    players: players.map((pi) => ({ playerIndex: pi, driverId: ids[pi]!.id, teamId: ids[pi]!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist: true } })),
    grid: ids.map((d, i) => ({ driverId: d.id, teamId: d.teamId, playerIndex: (i < humans ? i : -1) as -1 | PlayerIndex, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed: 21,
    ghost: null,
    objective: null,
  };
}

/** A two-player race with the running order set: car ids in `order` hold P1, P2, … */
function raceWorld(order?: number[]): WorldState {
  const world = createWorld(config(2), getLayout('monza'));
  const ids = order ?? world.cars.map((c) => c.id);
  ids.forEach((id, i) => {
    const car = world.cars[id]!;
    car.status = 'running';
    car.timing.position = i + 1;
  });
  return world;
}

describe('who a spectator watches', () => {
  test('another human still racing first (best placed), else the best placed car still racing', () => {
    const base = raceWorld();
    const own = getPlayerCarId(base, 0);
    const mate = getPlayerCarId(base, 1);
    const ais = base.cars.filter((c) => c.playerIndex < 0).map((c) => c.id);
    // the mate runs fifth
    const order = [ais[0]!, ais[1]!, own, ais[2]!, mate, ...ais.slice(3)];
    const w2 = raceWorld(order);
    retireCar(w2, own, 'test');
    expect(firstWatch(w2, own)).toBe(mate);
    // the mate out too: the leader
    retireCar(w2, mate, 'test');
    expect(firstWatch(w2, own)).toBe(ais[0]!);
    // the leader already past the flag: the best placed car still racing
    w2.cars[ais[0]!]!.status = 'finished';
    expect(firstWatch(w2, own)).toBe(ais[1]!);
    // retired cars (parked out of sight) are never watched; a finished race car (cool-down lap) is
    expect(canWatch(w2, own)).toBe(false);
    expect(canWatch(w2, ais[0]!)).toBe(true);
    expect(watchOrder(w2).map((c) => c.id)).toEqual([ais[0]!, ais[1]!, ais[2]!, ...ais.slice(3)]);
    // nobody left on track
    for (const c of w2.cars) c.status = 'retired';
    expect(firstWatch(w2, own)).toBeNull();
  });

  test('stepping goes through the running order and wraps', () => {
    const w = raceWorld();
    const own = getPlayerCarId(w, 0);
    retireCar(w, own, 'test');
    const order = watchOrder(w).map((c) => c.id);
    expect(order).not.toContain(own);
    expect(stepWatch(w, order[0]!, 1, own)).toBe(order[1]!);
    expect(stepWatch(w, order[0]!, -1, own)).toBe(order[order.length - 1]!);
    expect(stepWatch(w, order[order.length - 1]!, 1, own)).toBe(order[0]!);
    // a car that cannot be watched any more: a fresh pick
    expect(stepWatch(w, own, 1, own)).toBe(firstWatch(w, own));
  });
});

describe('Spectator', () => {
  test('switches over once the banner has had its time; presses while racing are dropped', () => {
    const w = raceWorld();
    const own = getPlayerCarId(w, 0);
    const mate = getPlayerCarId(w, 1);
    const s = new Spectator(own);
    s.keys(false, true);
    expect(s.update(w, 6)).toBe(false);
    expect(s.watching).toBeNull();
    s.keys(false, false);
    w.time = 100;
    retireCar(w, own, 'test');
    w.time = 105.9;
    expect(s.update(w, 6)).toBe(false);
    expect(s.watching).toBeNull();
    w.time = 106;
    expect(s.update(w, 6)).toBe(true);
    expect(s.watching).toBe(mate);
    expect(s.update(w, 6)).toBe(false);
  });

  test('the first switch press ends the wait; a held key steps once; left / right step the order', () => {
    const w = raceWorld();
    const own = getPlayerCarId(w, 0);
    const mate = getPlayerCarId(w, 1);
    const s = new Spectator(own);
    retireCar(w, own, 'test');
    s.keys(false, true);
    expect(s.update(w, 6)).toBe(true);
    expect(s.watching).toBe(mate);
    // still held: no repeat
    s.keys(false, true);
    expect(s.update(w, 6)).toBe(false);
    const order = watchOrder(w).map((c) => c.id);
    const at = order.indexOf(mate);
    s.keys(false, false);
    s.keys(false, true);
    s.update(w, 6);
    expect(s.watching).toBe(order[(at + 1) % order.length]!);
    s.keys(false, false);
    s.keys(true, false);
    s.update(w, 6);
    expect(s.watching).toBe(mate);
    // a pad D-pad step
    s.step(-1);
    s.update(w, 6);
    expect(s.watching).toBe(order[(at - 1 + order.length) % order.length]!);
  });

  test('a watched car dropping out hands over; the own car back in the race ends spectating', () => {
    const w = raceWorld();
    const own = getPlayerCarId(w, 0);
    const mate = getPlayerCarId(w, 1);
    const s = new Spectator(own);
    retireCar(w, own, 'test');
    s.step(1);
    s.update(w, 6);
    expect(s.watching).toBe(mate);
    retireCar(w, mate, 'test');
    expect(s.update(w, 6)).toBe(true);
    expect(s.watching).toBe(firstWatch(w, own));
    expect(s.watching).not.toBe(mate);
    // (a split-screen flashback: the world from before the crash)
    w.cars[own]!.status = 'running';
    expect(s.update(w, 6)).toBe(true);
    expect(s.watching).toBeNull();
    // a press while racing again does nothing
    s.step(1);
    expect(s.update(w, 6)).toBe(false);
  });
});

describe('switch-key hints', () => {
  test('single player: the steer keys, the D-pad and the camera key / button', () => {
    const items = spectateHintItems(DEFAULT_SETTINGS, 0, false);
    expect(items.map((r) => r.label)).toEqual(['切換車手', '鏡頭']);
    expect(items[0]!.keys).toEqual([`${keyLabel('KeyA')}／${keyLabel('KeyD')}`, `${keyLabel('ArrowLeft')}／${keyLabel('ArrowRight')}`, '十字鍵 ←→']);
    expect(items[1]!.keys).toEqual([keyLabel('KeyC'), 'Y']);
  });

  test('split-screen: each player their own keys', () => {
    const p1 = spectateHintItems(DEFAULT_SETTINGS, 0, true);
    const p2 = spectateHintItems(DEFAULT_SETTINGS, 1, true);
    expect(p1[0]!.keys[0]).toBe(`${keyLabel('KeyA')}／${keyLabel('KeyD')}`);
    expect(p2[0]!.keys[0]).toBe(`${keyLabel('ArrowLeft')}／${keyLabel('ArrowRight')}`);
    expect(p2[1]!.keys[0]).toBe(keyLabel('Backslash'));
  });
});

class FakeEl {
  textContent = '';
  title = '';
  offsetWidth = 0;
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  readonly classes = new Set<string>();
  readonly props = new Map<string, string>();
  readonly style = { setProperty: (k: string, v: string): void => void this.props.set(k, v), transform: '' };
  readonly classList = {
    toggle: (c: string, on?: boolean): void => {
      if (on ?? !this.classes.has(c)) this.classes.add(c);
      else this.classes.delete(c);
    },
    add: (...cs: string[]): void => cs.forEach((c) => this.classes.add(c)),
    remove: (...cs: string[]): void => cs.forEach((c) => this.classes.delete(c)),
    contains: (c: string): boolean => this.classes.has(c),
  };
  constructor(readonly tag: string) {}
  set className(v: string) {
    this.classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this.classes.add(c);
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  replaceChildren(): void {
    this.children = [];
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  addEventListener(): void {}
  find(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      if (c.classes.has(cls)) out.push(c);
      out.push(...c.find(cls));
    }
    return out;
  }
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join('');
  }
}

describe('view HUD while spectating', () => {
  const g = globalThis as unknown as { document?: unknown };
  let saved: unknown;
  beforeAll(() => {
    saved = g.document;
    g.document = { createElement: (tag: string) => new FakeEl(tag), createElementNS: (_ns: string, tag: string) => new FakeEl(tag) };
  });
  afterAll(() => {
    g.document = saved;
  });

  test('shows the watched car with the 觀戰中 card; the own live delta and fuel measure come back with the own car', () => {
    const track = getLayout('monza');
    const w = raceWorld();
    const own = getPlayerCarId(w, 0);
    const mate = getPlayerCarId(w, 1);
    const root = new FakeEl('div');
    const vh = new ViewHud(root as unknown as Element, { playerIndex: 0, carId: own, region: 'full' }, track, 20, {
      requestPit: () => undefined,
      cancelPit: () => undefined,
      setErsMode: () => undefined,
    });
    const frame: ViewFrame = { order: watchOrder(w), overallBestSectors: [null, null, null], ghost: null, units: 'kmh', telemetry: true };
    const card = root.find('nvh-watch')[0]!;
    vh.update(w, 1 / 60, frame);
    expect(card.classes.has('nvh-hidden')).toBe(true);
    const inner = vh as unknown as { delta: unknown; telemetry: { fuelEst: unknown } };
    const ownDelta = inner.delta;
    const ownFuel = inner.telemetry.fuelEst;
    expect(ownDelta).not.toBeNull();
    vh.mfd.toggle();
    expect(vh.mfd.isOpen()).toBe(true);

    vh.watch(mate, spectateHintItems(DEFAULT_SETTINGS, 0, false));
    vh.update(w, 1 / 60, frame);
    expect(vh.shownCarId).toBe(mate);
    expect(vh.watching).toBe(true);
    expect(vh.mfd.isOpen()).toBe(false);
    expect(card.classes.has('nvh-hidden')).toBe(false);
    const m = w.cars[mate]!;
    expect(card.text()).toContain(`P${m.timing.position}`);
    expect(card.text()).toContain(m.abbr);
    expect(card.text()).toContain('切換車手');
    expect(inner.delta).not.toBe(ownDelta);
    expect(inner.telemetry.fuelEst).not.toBe(ownFuel);
    // another car
    const other = stepWatch(w, mate, 1, own)!;
    vh.watch(other, spectateHintItems(DEFAULT_SETTINGS, 0, false));
    vh.update(w, 1 / 60, frame);
    expect(card.text()).toContain(w.cars[other]!.abbr);
    // back to the own car (a split-screen flashback): the measures it had
    vh.watch(null, []);
    expect(vh.shownCarId).toBe(own);
    expect(card.classes.has('nvh-hidden')).toBe(true);
    expect(inner.delta).toBe(ownDelta);
    expect(inner.telemetry.fuelEst).toBe(ownFuel);
  });
});

describe('online guest spectating (loopback)', () => {
  test('the others keep their place through the retirement, then are drawn as the host had them, lap timers running', () => {
    const track = getLayout('monza');
    const cfg = config(2, 4);
    const net = new LoopbackNetwork({ delayMs: 80, jitterMs: 30, loss: 0.05, duplicate: 0.03, seed: 7 });
    const [h1, c1] = net.pair();
    const world = createWorld(cfg, track);
    const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h1 }], {});
    const a = new ClientSession(cfg, track, 1, 1, c1);
    const history: { t: number; pos: { x: number; z: number }[] }[] = [];
    const hostAt = (t: number, id: number): { x: number; z: number } | null => {
      const i = history.findIndex((hh) => hh.t >= t);
      if (i <= 0) return null;
      const p = history[i - 1]!;
      const n = history[i]!;
      const f = (t - p.t) / (n.t - p.t);
      return { x: p.pos[id]!.x + (n.pos[id]!.x - p.pos[id]!.x) * f, z: p.pos[id]!.z + (n.pos[id]!.z - p.pos[id]!.z) * f };
    };
    const drawn: { t: number; cars: { id: number; x: number; z: number }[] }[] = [];
    const racingErr: number[] = [];
    const watchErr: number[] = [];
    const behind: number[] = [];
    const lapTimerErr: number[] = [];
    // the others' movement per step from the guest's retirement until it spectates (the camera still on the own car)
    const bannerMoves: number[] = [];
    let prevDrawn: Map<number, { x: number; z: number }> | null = null;
    let retiredAt: number | null = null;
    let outAt: number | null = null;
    let spectateAt: number | null = null;
    let steps = 0;
    while (!isSessionOver(world) && world.time < 240) {
      const inputs: (ControlInput | null)[] = [null, null, null, null];
      inputs[0] = computeAIInput(world, world.cars[getPlayerCarId(world, 0)]!, track, SIM_DT);
      host.fillInputs(inputs);
      stepWorld(world, track, inputs, SIM_DT);
      host.forwardEvents(world.events.splice(0));
      host.afterStep();
      history.push({ t: world.time, pos: world.cars.map((c) => ({ x: c.phys.x, z: c.phys.z })) });
      if (history.length > 600) history.shift();
      while (drawn.length > 0 && drawn[0]!.t <= world.time) {
        const d = drawn.shift()!;
        for (const rc of d.cars) {
          if (rc.id === a.carId) continue;
          const p = hostAt(d.t, rc.id);
          if (p) (spectateAt === null ? racingErr : watchErr).push(Math.hypot(rc.x - p.x, rc.z - p.z));
        }
      }
      const car = a.car;
      // the guest drives (AI) until it retires from the pause menu at 60 s
      if (car) a.step(car.status === 'retired' ? COAST_INPUT : computeAIInput(a.world, car, track, SIM_DT));
      a.takeEvents();
      net.advance(SIM_DT * 1000);
      steps++;
      if (retiredAt === null && world.time > 60) {
        a.retire();
        retiredAt = world.time;
      }
      // the guest learns of it (mirror), then spectates once the banner has had its time (as SessionRuntime does)
      if (outAt === null && a.car?.status === 'retired') outAt = a.world.time;
      if (outAt !== null && spectateAt === null && a.world.time >= outAt + 6) {
        a.setSpectating(true);
        spectateAt = a.world.time;
      }
      const frame = a.renderFrame(SIM_DT);
      const now = new Map(frame.cars.filter((c) => c.visible && c.carId !== a.carId).map((c) => [c.carId, { x: c.x, z: c.z }]));
      if (outAt !== null && spectateAt === null && prevDrawn) {
        for (const [id, p] of now) {
          const q = prevDrawn.get(id);
          if (q) bannerMoves.push(Math.hypot(p.x - q.x, p.z - q.z));
        }
      }
      prevDrawn = now;
      const settled = spectateAt !== null && a.world.time > spectateAt + 1;
      if (steps % 30 === 0 && world.session.phase === 'running' && world.time > 10 && (retiredAt === null || settled)) {
        drawn.push({ t: frame.time, cars: frame.cars.filter((c) => c.visible).map((c) => ({ id: c.carId, x: c.x, z: c.z })) });
        if (settled) {
          behind.push(world.time - frame.time);
          for (const c of world.cars) {
            if (c.id !== a.carId && c.status === 'running' && c.timing.lap >= 1) lapTimerErr.push(Math.abs(a.world.cars[c.id]!.timing.currentLapTime - c.timing.currentLapTime));
          }
        }
      }
    }
    expect(retiredAt).not.toBeNull();
    expect(spectateAt).not.toBeNull();
    expect(world.cars[a.carId]!.status).toBe('retired');
    const mean = (xs: number[]): number => xs.reduce((x, y) => x + y, 0) / xs.length;
    const p95 = (xs: number[]): number => [...xs].sort((x, y) => x - y)[Math.floor(xs.length * 0.95)]!;
    // through the 退賽 banner the others move on as before: no step back in time when the own car is marked out
    // (switching the view time there made them jump back 13–22 m in one frame)
    expect(bannerMoves.length).toBeGreaterThan(1000);
    expect(Math.max(...bannerMoves)).toBeLessThan(2);
    expect(racingErr.length).toBeGreaterThan(100);
    expect(watchErr.length).toBeGreaterThan(500);
    // spectating, the view runs INTERP_DELAY behind the guest's estimate of the host clock (itself ~ the shortest
    // one-way delay behind): the others are interpolated between snapshots, not extrapolated
    // (measured: extrapolated 0.25 m mean / 0.98 m p95 behind the host's; interpolated 0.003 / 0.009 m)
    expect(Math.min(...behind)).toBeGreaterThan(INTERP_DELAY - 0.02);
    expect(Math.max(...behind)).toBeLessThan(INTERP_DELAY + 0.3);
    expect(mean(watchErr)).toBeLessThan(0.1);
    expect(p95(watchErr)).toBeLessThan(0.3);
    // the watched cars' lap timers run on the guest (none is mirrored: they stood at 0 before)
    expect(lapTimerErr.length).toBeGreaterThan(100);
    expect(p95(lapTimerErr)).toBeLessThan(0.3);
    a.dispose();
    host.dispose();
  }, 120_000);
});
