/**
 * Race-control HUD: pure label / colour / countdown helpers, the mode -> strip mapping, and the strip's green-flag
 * timing and the player flag pills on a minimal fake DOM. Worlds without control / flags must not throw.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CarEntry, WorldState } from '../src/core/types';
import {
  FlagStack,
  GREEN_FLAG_SECONDS,
  RaceControlStrip,
  countdownSeconds,
  deltaClass,
  flagsOf,
  formatVscDelta,
  giveBackText,
  modeChip,
  queueGapText,
  redCount,
  sectorFlagLabel,
  sectorFlagLevels,
  stripSpec,
} from '../src/ui/hud/raceControl';
import { sessionLabel } from '../src/ui/hud/labels';
import { Banner } from '../src/ui/hud/feed';

class FakeEl {
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  classes = new Set<string>();
  offsetWidth = 0;
  classList = {
    toggle: (c: string, on?: boolean): void => {
      if (on ?? !this.classes.has(c)) this.classes.add(c);
      else this.classes.delete(c);
    },
    add: (...cs: string[]): void => cs.forEach((c) => this.classes.add(c)),
    remove: (...cs: string[]): void => cs.forEach((c) => this.classes.delete(c)),
  };
  constructor(readonly tag: string) {}
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  get hidden(): boolean {
    return this.classes.has('nvh-hidden');
  }
}

const g = globalThis as unknown as { document?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.document;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  };
});
afterAll(() => {
  g.document = saved;
});

const worldWith = (control: unknown, cars: unknown[] = []): WorldState => ({ cars, session: { kind: 'race', control } }) as unknown as WorldState;

describe('race-control helpers', () => {
  test('mode -> strip mapping', () => {
    expect(stripSpec('green', '')).toBeNull();
    expect(stripSpec('sc', '第 7 彎有車輛停在賽道上')).toEqual({ tone: 'yellow', title: '安全車', sub: '第 7 彎有車輛停在賽道上' });
    expect(stripSpec('scEnding', '')?.title).toBe('安全車本圈進站');
    expect(stripSpec('vsc', '')?.title).toBe('虛擬安全車');
    expect(stripSpec('vscEnding', '')?.title).toBe('虛擬安全車即將結束');
    expect(stripSpec('red', '')).toMatchObject({ tone: 'red', title: '紅旗 — 比賽中止' });
    expect(stripSpec('formation', 'ignored')).toMatchObject({ title: '暖胎圈', sub: '保持隊形，接近發車格時自動停車' });
  });

  test('tower chip text', () => {
    expect(modeChip('green')).toBe('');
    expect(modeChip('sc')).toBe('SC');
    expect(modeChip('scEnding')).toBe('SC');
    expect(modeChip('vscEnding')).toBe('VSC');
    expect(modeChip('red')).toBe('紅旗');
    expect(modeChip('formation')).toBe('暖胎圈');
  });

  test('VSC delta colour classes and text', () => {
    expect(deltaClass(0.84)).toBe('ok');
    expect(deltaClass(0.3)).toBe('ok');
    expect(deltaClass(0.29)).toBe('warn');
    expect(deltaClass(0)).toBe('warn');
    expect(deltaClass(-0.01)).toBe('bad');
    expect(formatVscDelta(0.84)).toBe('VSC 差值 +0.84');
    expect(formatVscDelta(-0.2)).toBe('VSC 差值 -0.20');
  });

  test('countdown and give-back text', () => {
    expect(countdownSeconds(6.2)).toBe(7);
    expect(countdownSeconds(7)).toBe(7);
    expect(countdownSeconds(-1)).toBe(0);
    expect(countdownSeconds(Number.NaN)).toBe(0);
    expect(giveBackText('ABC', 6.2)).toBe('請讓回位置給 ABC（剩 7 秒）');
  });

  test('queue gap, sector flags, session label', () => {
    expect(queueGapText(3, 0.84)).toBe('前車 0.8 秒');
    expect(queueGapText(1, 0.84)).toBe('');
    expect(queueGapText(3, Number.POSITIVE_INFINITY)).toBe('');
    expect(sectorFlagLabel(1, 1)).toBe('黃旗 S2');
    expect(sectorFlagLabel(1, 2)).toBe('雙黃旗 S2');
    expect(sectorFlagLabel(1, 0)).toBe('');
    expect(sectorFlagLevels(null)).toEqual([0, 0, 0]);
    expect(sectorFlagLevels({ sectorFlags: [0, 2, 1] } as never)).toEqual([0, 2, 1]);
    expect(sessionLabel('race', true)).toBe('衝刺賽');
    expect(sessionLabel('race')).toBe('正賽');
    expect(sessionLabel('practice', true)).toBe('練習賽');
  });

  test('worlds without control / flags fall back', () => {
    const bare = { cars: [], session: { kind: 'race' } } as unknown as WorldState;
    expect(redCount(bare)).toBe(0);
    expect(redCount(worldWith({ counts: { red: 2 } }))).toBe(2);
    expect(flagsOf({} as CarEntry)).toEqual({
      shown: 'none',
      delta: null,
      giveBack: null,
      queuing: false,
      blackOrange: null,
      mandatoryStop: false,
    });
  });
});

describe('RaceControlStrip', () => {
  test('green flag shows for GREEN_FLAG_SECONDS after a neutralisation, not after formation', () => {
    const root = new FakeEl('div');
    const strip = new RaceControlStrip(root as unknown as HTMLElement);
    const node = root.children[0];
    strip.update(worldWith({ mode: 'green', reason: '' }), 0.1);
    expect(node.hidden).toBe(true);
    strip.update(worldWith({ mode: 'sc', reason: 'x' }), 0.1);
    expect(node.hidden).toBe(false);
    expect(root.attrs.get('data-rc')).toBe('1');
    strip.update(worldWith({ mode: 'green', reason: '' }), 0.1);
    expect(node.hidden).toBe(false);
    expect(node.attrs.get('data-tone')).toBe('green');
    strip.update(worldWith({ mode: 'green', reason: '' }), GREEN_FLAG_SECONDS + 0.1);
    expect(node.hidden).toBe(true);
    expect(root.attrs.has('data-rc')).toBe(false);
    strip.update(worldWith({ mode: 'formation', reason: '' }), 0.1);
    strip.update(worldWith({ mode: 'green', reason: '' }), 0.1);
    expect(node.hidden).toBe(true);
  });

  test('a world without session.control never throws', () => {
    const root = new FakeEl('div');
    const strip = new RaceControlStrip(root as unknown as HTMLElement);
    strip.update({ cars: [], session: { kind: 'race' } } as unknown as WorldState, 0.1);
    expect(root.children[0].hidden).toBe(true);
  });
});

describe('FlagStack', () => {
  const pills = (root: FakeEl): FakeEl[] => root.children[0].children;
  const car = (flags?: unknown): CarEntry => ({ id: 0, abbr: 'AAA', status: 'racing', flags, timing: { position: 3, interval: 1.24 } }) as unknown as CarEntry;

  test('shows blue, delta, give-back and queue pills from car.flags', () => {
    const root = new FakeEl('div');
    const stack = new FlagStack(root as unknown as Element);
    const [, blue, giveBack, delta, queue] = pills(root);
    const other = { id: 1, abbr: 'ABC' } as unknown as CarEntry;
    const world = { cars: [car(), other], session: { kind: 'race', control: { mode: 'sc' } } } as unknown as WorldState;
    stack.update(car({ shown: 'blue', delta: 0.1, giveBack: { carId: 1, timeLeft: 6.1 }, queuing: true }), world);
    expect(blue.hidden).toBe(false);
    expect(blue.children[0].textContent).toBe('藍旗 — 讓後方領先車通過');
    expect(giveBack.children[0].textContent).toBe('請讓回位置給 ABC（剩 7 秒）');
    expect(delta.children[0].textContent).toBe('VSC 差值 +0.10');
    expect(delta.attrs.get('data-class')).toBe('warn');
    expect(queue.hidden).toBe(false);
    expect(queue.children[1].textContent).toBe('前車 1.2 秒');
    stack.update(car(), world);
    expect([blue, giveBack, delta, queue].every((p) => p.hidden)).toBe(true);
  });

  test('queue pill says when the safety-car limiter holds the speed', () => {
    const root = new FakeEl('div');
    const stack = new FlagStack(root as unknown as Element);
    const queue = pills(root)[4];
    const world = { cars: [], session: { kind: 'race', control: { mode: 'sc' } } } as unknown as WorldState;
    stack.update(car({ queuing: true }), world);
    expect(queue.children[0].textContent).toBe('跟隨安全車 — 禁止超車');
    stack.update({ ...car({ queuing: true }), assists: { scLimiter: true } } as unknown as CarEntry, world);
    expect(queue.children[0].textContent).toBe('安全車限速中 — 禁止超車');
  });

  test('pit duties: black-and-orange flag (on top), unserved penalty and the open mandatory stop', () => {
    const root = new FakeEl('div');
    const stack = new FlagStack(root as unknown as Element);
    const all = pills(root);
    const [blackOrange] = all;
    const [penalty, mandatory] = all.slice(-2);
    const world = { cars: [], session: { kind: 'race', control: { mode: 'green' } } } as unknown as WorldState;
    const flagged = {
      ...car({ blackOrange: { crossingsLeft: 1 }, mandatoryStop: true }),
      penalties: { timeSec: 10, servedSec: 5 },
    } as unknown as CarEntry;
    stack.update(flagged, world);
    expect(blackOrange.hidden).toBe(false);
    expect(blackOrange.attrs.get('data-kind') ?? blackOrange.dataset?.kind).toBe('blackorange');
    expect(blackOrange.children[0].textContent).toBe('黑橘旗 — 車損危險，必須進站維修');
    expect(blackOrange.children[1].textContent).toBe('過終點線前進站，否則黑旗');
    expect(penalty.hidden).toBe(false);
    expect(penalty.children[0].textContent).toBe('待執行罰時 5 秒');
    expect(mandatory.hidden).toBe(false);
    expect(mandatory.children[0].textContent).toBe('強制進站：尚未使用第二種乾地配方');
    // served / not flagged / out of the race: nothing
    stack.update({ ...car({}), penalties: { timeSec: 5, servedSec: 5 } } as unknown as CarEntry, world);
    expect([blackOrange, penalty, mandatory].every((p) => p.hidden)).toBe(true);
    stack.update({ ...flagged, status: 'retired' } as unknown as CarEntry, world);
    expect(all.every((p) => p.hidden)).toBe(true);
  });

  test('queue pill needs sc / scEnding; a car without flags shows nothing', () => {
    const root = new FakeEl('div');
    const stack = new FlagStack(root as unknown as Element);
    const world = { cars: [], session: { kind: 'race' } } as unknown as WorldState;
    stack.update(car({ queuing: true }), world);
    expect(pills(root).every((p) => p.hidden)).toBe(true);
    stack.update({ id: 0, status: 'racing' } as unknown as CarEntry, world);
    stack.hide();
  });
});

describe('view banner', () => {
  test('cleared by a flashback: the same retirement banner shows again at once', () => {
    const banner = new Banner(new FakeEl('div') as unknown as Element);
    const el = banner.el as unknown as FakeEl;
    banner.show('retired', '退賽', '懸吊損毀退賽', 'bad', 6);
    expect(banner.isShowing('retired')).toBe(true);
    // the same key is not repeated while it is recent
    banner.update(1);
    banner.show('retired', '退賽', '懸吊損毀退賽', 'bad', 6);
    banner.clear();
    expect(banner.isShowing('retired')).toBe(false);
    expect(el.hidden).toBe(true);
    banner.show('retired', '退賽', '懸吊損毀退賽', 'bad', 6);
    expect(banner.isShowing('retired')).toBe(true);
    expect(el.hidden).toBe(false);
  });
});
