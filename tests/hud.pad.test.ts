/**
 * HUD gamepad / notice fixes on a minimal fake DOM: pause key closes the 操作說明 panel first, D-pad compound pick in
 * the MFD, replay bar pad control, and the rate-limited ERS-assist notice.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CarEntry, TireCompound, WorldState } from '../src/core/types';
import { MfdPanel } from '../src/ui/hud/mfd';
import { ReplayBar, type ReplayHandlers } from '../src/ui/hud/replayBar';
import { NOTICE_GAP, NoticeGate, pauseKeyOutcome } from '../src/ui/hud/labels';
import { controlsHelpPages } from '../src/ui/hud/controls';
import { DEFAULT_SETTINGS } from '../src/core/defaults';

class FakeEl {
  className = '';
  textContent = '';
  title = '';
  style: Record<string, unknown> = { setProperty: (): void => undefined };
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  classList = { toggle: (_c: string, _on?: boolean): void => undefined, add: (_c: string): void => undefined, remove: (_c: string): void => undefined };
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
  addEventListener(): void {}
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

const g = globalThis as unknown as { document?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.document;
  g.document = { createElement: (tag: string) => new FakeEl(tag), createElementNS: (_ns: string, tag: string) => new FakeEl(tag) };
});
afterAll(() => {
  g.document = saved;
});

describe('pause key with the 操作說明 panel open', () => {
  test('closes the panel and stays paused; otherwise resumes; running -> pause', () => {
    let helpOpen = true;
    const closeHelp = (): boolean => {
      const was = helpOpen;
      helpOpen = false;
      return was;
    };
    expect(pauseKeyOutcome(true, closeHelp)).toBe('stay');
    expect(pauseKeyOutcome(true, closeHelp)).toBe('resume');
    expect(pauseKeyOutcome(false, () => true)).toBe('pause');
  });
});

describe('MFD compound pick from the gamepad', () => {
  const car = {
    status: 'racing',
    pit: { requested: false, phase: 'none', nextCompound: 'medium' },
    phys: { tire: { compound: 'soft', wear: 0.1, laps: 3 }, ers: { mode: 'balanced' } },
    assists: { ersAssist: false },
  } as unknown as CarEntry;
  const world = { session: { kind: 'race' }, weather: { wetness: 0 } } as unknown as WorldState;

  function mfd(requests: TireCompound[] = []): MfdPanel {
    const m = new MfdPanel(new FakeEl('div') as unknown as Element, { requestPit: (c) => requests.push(c), cancelPit: () => undefined, setErsMode: () => undefined }, 20);
    m.sync(car, world);
    return m;
  }

  test('D-pad steps the compound only while the MFD is open', () => {
    const m = mfd();
    expect(m.padStep(1)).toBe(false);
    expect(m.selectedCompound()).toBe('medium'); // suggestion
    m.toggle();
    expect(m.padStep(1)).toBe(true);
    expect(m.selectedCompound()).toBe('hard');
    expect(m.padStep(-1)).toBe(true);
    expect(m.padStep(-1)).toBe(true);
    expect(m.selectedCompound()).toBe('soft');
  });

  test('the pick is what a later pit request fits; the hint mentions the D-pad', () => {
    const requests: TireCompound[] = [];
    const root = new FakeEl('div');
    const m = new MfdPanel(root as unknown as Element, { requestPit: (c) => requests.push(c), cancelPit: () => undefined, setErsMode: () => undefined }, 20);
    m.sync(car, world);
    m.toggle();
    m.padStep(1);
    m.handleKey('Digit6');
    expect(requests).toEqual(['hard']);
    expect(root.all().some((e) => e.className === 'nvh-mfd-hint' && e.textContent.includes('十字鍵'))).toBe(true);
  });

  test('the gamepad help page lists the compound pick', () => {
    const pad = controlsHelpPages(DEFAULT_SETTINGS, false).find((p) => p.id === 'pad');
    const rows = pad?.sections.flatMap((s) => s.rows) ?? [];
    expect(rows.find((r) => r.label === 'MFD：換胎配方')?.keys).toEqual(['十字鍵 ←→']);
  });
});

describe('replay bar gamepad control', () => {
  function bar(): { bar: ReplayBar; calls: string[] } {
    const calls: string[] = [];
    const b = new ReplayBar(new FakeEl('div') as unknown as Element);
    const handlers: ReplayHandlers = {
      toggle: () => calls.push('toggle'),
      seek: (t) => calls.push(`seek ${t.toFixed(2)}`),
      speed: (x) => calls.push(`speed ${x}`),
      camera: () => calls.push('camera'),
      exit: () => calls.push('exit'),
    };
    b.setHandlers(handlers);
    b.update({ time: 50, duration: 100, playing: true, speed: 1 });
    return { bar: b, calls };
  }

  test('A toggles, D-pad seeks 5 s and steps the speed', () => {
    const { bar: b, calls } = bar();
    expect(b.handlePad('confirm')).toBe(true);
    expect(b.handlePad('left')).toBe(true);
    expect(b.handlePad('right')).toBe(true);
    expect(b.handlePad('up')).toBe(true);
    expect(b.handlePad('down')).toBe(true);
    expect(calls).toEqual(['toggle', 'seek 0.45', 'seek 0.55', 'speed 2', 'speed 0.5']);
    expect(b.handlePad('back')).toBe(false);
  });

  test('inert / hidden bar ignores the pad', () => {
    const b = new ReplayBar(new FakeEl('div') as unknown as Element);
    expect(b.handlePad('confirm')).toBe(false);
  });
});

describe('ERS-assist notice throttle', () => {
  test('fires once, then again only after the gap of frame time', () => {
    const gate = new NoticeGate();
    expect(gate.fire(0)).toBe(true);
    expect(gate.fire(0)).toBe(false); // key mashed
    expect(gate.fire(1)).toBe(true); // other player is independent
    gate.tick(NOTICE_GAP - 0.5);
    expect(gate.fire(0)).toBe(false);
    gate.tick(0.5);
    expect(gate.fire(0)).toBe(true);
  });
});
