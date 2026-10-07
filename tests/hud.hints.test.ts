/**
 * Hint strip timing (auto-hide after HUD_HINT_SECONDS with a fade, click dismiss, frozen while paused) and the
 * 操作說明 panel paging / scrolling, on a minimal fake DOM.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { HUD_HINT_SECONDS, controlsHelpPages, hintItems } from '../src/ui/hud/controls';
import { ControlsHelp } from '../src/ui/hud/controlsHelp';
import { HintStrip } from '../src/ui/hud/hintStrip';

class FakeClassList {
  readonly set = new Set<string>();
  add(...c: string[]): void {
    for (const x of c) this.set.add(x);
  }
  remove(...c: string[]): void {
    for (const x of c) this.set.delete(x);
  }
  toggle(c: string, on?: boolean): void {
    if (on ?? !this.set.has(c)) this.set.add(c);
    else this.set.delete(c);
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
}

class FakeEl {
  readonly classList = new FakeClassList();
  textContent = '';
  title = '';
  scrollTop = 0;
  clientHeight = 200;
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  listeners = new Map<string, (e: { preventDefault(): void; stopPropagation(): void }) => void>();
  constructor(readonly tag: string) {}
  set className(v: string) {
    this.classList.set.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this.classList.add(c);
  }
  get className(): string {
    return [...this.classList.set].join(' ');
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
  addEventListener(type: string, fn: (e: { preventDefault(): void; stopPropagation(): void }) => void): void {
    this.listeners.set(type, fn);
  }
  click(): void {
    this.listeners.get('click')?.({ preventDefault: () => undefined, stopPropagation: () => undefined });
  }
  /** all descendants with a class */
  find(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      if (c.classList.contains(cls)) out.push(c);
      out.push(...c.find(cls));
    }
    return out;
  }
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

const hidden = (e: unknown): boolean => (e as FakeEl).classList.contains('nvh-hidden');

describe('HintStrip', () => {
  test('starts hidden, shows the keys, fades out and hides after the display time', () => {
    const parent = new FakeEl('div');
    const strip = new HintStrip(parent as unknown as Element);
    expect(hidden(strip.el)).toBe(true);
    strip.start(hintItems(DEFAULT_SETTINGS, 0, false), HUD_HINT_SECONDS);
    expect(hidden(strip.el)).toBe(false);
    expect((strip.el as unknown as FakeEl).find('nvh-hint-item').length).toBe(6);
    for (let t = 0; t < HUD_HINT_SECONDS - 1; t += 0.5) strip.update(0.5);
    expect(strip.isShowing()).toBe(true);
    expect((strip.el as unknown as FakeEl).classList.contains('is-out')).toBe(false);
    strip.update(0.7);
    expect((strip.el as unknown as FakeEl).classList.contains('is-out')).toBe(true);
    strip.update(0.5);
    expect(strip.isShowing()).toBe(false);
    expect(hidden(strip.el)).toBe(true);
  });

  test('frozen while paused (dt 0) and dismissed by a click', () => {
    const strip = new HintStrip(new FakeEl('div') as unknown as Element);
    strip.start(hintItems(DEFAULT_SETTINGS, 0, false), HUD_HINT_SECONDS);
    for (let i = 0; i < 1000; i++) strip.update(0);
    expect(strip.isShowing()).toBe(true);
    (strip.el as unknown as FakeEl).click();
    expect(strip.isShowing()).toBe(false);
    expect(hidden(strip.el)).toBe(true);
  });

  test('items without keys are skipped', () => {
    const strip = new HintStrip(new FakeEl('div') as unknown as Element);
    strip.start([{ label: '油門', keys: ['W'] }, { label: 'DRS', keys: [] }], 5);
    expect((strip.el as unknown as FakeEl).find('nvh-hint-item').length).toBe(1);
  });
});

describe('ControlsHelp', () => {
  test('pages wrap with ←/→, ↑/↓ scroll, the 返回 button closes', () => {
    let closed = 0;
    const help = new ControlsHelp(new FakeEl('div') as unknown as Element, () => closed++);
    expect(help.isOpen()).toBe(false);
    help.open(controlsHelpPages(DEFAULT_SETTINGS, true));
    expect(help.isOpen()).toBe(true);
    const root = help.el as unknown as FakeEl;
    const tabs = root.find('nvh-help-tab');
    const active = (): number => tabs.findIndex((t) => t.attrs.has('data-active'));
    expect(tabs.length).toBe(3);
    expect(active()).toBe(0);
    help.navigate('left');
    expect(active()).toBe(2);
    expect(help.handleKey('ArrowRight')).toBe(true);
    expect(active()).toBe(0);
    tabs[1].click();
    expect(active()).toBe(1);
    const body = root.find('nvh-help-body')[0];
    help.navigate('down');
    expect(body.scrollTop).toBeGreaterThan(0);
    help.navigate('up');
    expect(body.scrollTop).toBe(0);
    expect(help.handleKey('Escape')).toBe(false); // closing keys belong to HudLayer
    root.find('nvh-help-close')[0].click();
    expect(closed).toBe(1);
    help.close();
    expect(help.isOpen()).toBe(false);
    expect(help.handleKey('ArrowLeft')).toBe(false);
  });
});
