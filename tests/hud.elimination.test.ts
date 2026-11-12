/**
 * Elimination race HUD: what the panel shows (countdown, the car at risk, amber / red, frozen, before the start, a
 * guest whose mirror has not caught up with an elimination yet), the callouts, and the timing tower marking the cars
 * out by the countdown apart from a retirement.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DEFAULT_RULES } from '../src/core/defaults';
import type { CarEntry, SessionConfig, WorldState } from '../src/core/types';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { createWorld, eliminationFormat } from '../src/race/index';
import { ELIMINATION_WARN, eliminatedCallout, eliminationHud } from '../src/ui/hud/elimination';
import { TimingTower } from '../src/ui/hud/tower';

const RACERS = DRIVERS.filter((d) => d.teamId !== '').slice(0, 4);

function world(format = true): WorldState {
  const config: SessionConfig = {
    mode: 'grandPrix',
    kind: 'race',
    layoutId: 'monza',
    laps: 3,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 80,
    players: [],
    grid: RACERS.map((d) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES },
    seed: 3,
    ghost: null,
    objective: null,
    ...(format ? { raceFormat: eliminationFormat(45) } : {}),
  };
  return createWorld(config, getLayout('monza'));
}

/** Racing, the countdown due `left` s from now, cars in `order` (ids) P1..P4. */
function racing(left: number, order = [0, 1, 2, 3]): WorldState {
  const w = world();
  w.time = 100;
  w.session.phase = 'running';
  w.session.startTime = 10;
  for (const c of w.cars) c.status = 'running';
  w.race.order = order;
  w.session.elimination = { dueAt: w.time + left, held: null, out: [] };
  return w;
}

describe('elimination panel content', () => {
  test('nothing outside an elimination race, nor once it is decided', () => {
    expect(eliminationHud(world(false), [])).toBeNull();
    const w = racing(20);
    w.session.phase = 'finished';
    expect(eliminationHud(w, [])).toBeNull();
  });

  test('before the start: the first countdown waits for lights out, nobody at risk yet', () => {
    expect(eliminationHud(world(), [0])).toMatchObject({ clock: '1:05', label: '起跑後開始倒數', risk: '', tone: 'calm', urgent: false, carId: null });
  });

  test('racing: the countdown and the car last in the order; amber in the last seconds', () => {
    const w = racing(20.2, [2, 0, 3, 1]);
    const abbr = w.cars[1]!.abbr;
    expect(eliminationHud(w, [0])).toMatchObject({ clock: '0:21', label: '淘汰倒數', risk: `淘汰區：${abbr}`, tone: 'calm', carId: 1, mine: false });
    w.session.elimination!.dueAt = w.time + ELIMINATION_WARN;
    expect(eliminationHud(w, [0])).toMatchObject({ clock: '0:10', tone: 'warn', urgent: true });
  });

  test('the player at risk: red whatever the time left, named in split screen', () => {
    const w = racing(30, [0, 2, 3, 1]);
    expect(eliminationHud(w, [1])).toMatchObject({ risk: '你在淘汰區！', tone: 'danger', urgent: false, mine: true });
    expect(eliminationHud(w, [1, 2])).toMatchObject({ risk: `${w.cars[1]!.abbr} 在淘汰區！`, tone: 'danger' });
    // a car already out is not at risk: the last one still racing is
    w.cars[1]!.status = 'retired';
    expect(eliminationHud(w, [1])).toMatchObject({ carId: 3, mine: false });
  });

  test('frozen under a neutralisation: paused, never amber', () => {
    const w = racing(0);
    w.session.elimination!.held = 6.5;
    w.session.control.mode = 'sc';
    expect(eliminationHud(w, [])).toMatchObject({ clock: '0:07', label: '倒數暫停', tone: 'calm', urgent: false });
  });

  test('a guest whose mirror is behind an elimination reads the next countdown, not 0', () => {
    const w = racing(-2);
    expect(eliminationHud(w, [])?.clock).toBe('0:43');
  });

  test('callouts', () => {
    expect(eliminatedCallout('VER', 18, true)).toEqual({ title: '淘汰', sub: '第 18 名出局' });
    expect(eliminatedCallout('VER', 18, false)).toEqual({ title: 'VER 淘汰', sub: '第 18 名出局' });
  });
});

class FakeEl {
  className = '';
  textContent = '';
  title = '';
  type = '';
  tabIndex = 0;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  classList = { toggle: (): void => undefined, add: (): void => undefined, remove: (): void => undefined };
  constructor(readonly tag: string) {}
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  remove(): void {}
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  addEventListener(): void {}
}

const g = globalThis as unknown as { document?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.document;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
});
afterAll(() => {
  g.document = saved;
});

describe('timing tower', () => {
  test('a car out by the countdown reads 淘汰, a retirement 退賽', () => {
    const w = racing(20, [0, 1, 2, 3]);
    w.cars[2]!.status = 'retired';
    w.cars[3]!.status = 'retired';
    w.session.elimination!.out = [3];
    const root = new FakeEl('div');
    const tower = new TimingTower(root as unknown as Element);
    tower.update(w, w.race.order.map((id) => w.cars[id]!) as CarEntry[], 1);
    const body = (root.children[0] as FakeEl).children[1] as FakeEl;
    const value = (id: number): string => {
      const row = body.children.filter((c) => c.className === 'nvh-tw-row')[id] as FakeEl;
      return (row.children[4] as FakeEl).textContent;
    };
    expect(value(2)).toBe('退賽');
    expect(value(3)).toBe('淘汰');
  });
});
