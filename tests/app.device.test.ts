/**
 * Device shell (src/app/device.ts): the device form and the rotate rule from the media queries, the fullscreen API
 * pick, and the html attributes and rotate overlay the DeviceWatcher keeps current. A fake matchMedia evaluates the
 * real DEVICE_QUERIES against a viewport, so the tests read the same strings the browser does.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DEVICE_QUERIES, DeviceWatcher, ROTATE_TEXT, deviceForm, fullscreenApi, needsRotate, type MediaMatch } from '../src/app/device';

interface Viewport {
  w: number;
  h: number;
  coarse: boolean;
  /** the device's own screen width (`device-width`), which a split-view window does not change */
  deviceW: number;
}

function evaluate(query: string, v: Viewport): boolean {
  return query.split(' and ').every((part) => {
    const m = /^\((pointer|orientation|max-width|max-height|max-device-width): ([a-z0-9]+?)(?:px)?\)$/.exec(part.trim());
    if (!m) throw new Error(`fake matchMedia cannot read ${part}`);
    const value = m[2]!;
    switch (m[1]) {
      case 'pointer':
        return (value === 'coarse') === v.coarse;
      case 'orientation':
        return value === (v.w > v.h ? 'landscape' : 'portrait');
      case 'max-width':
        return v.w <= Number(value);
      case 'max-device-width':
        return v.deviceW <= Number(value);
      default:
        return v.h <= Number(value);
    }
  });
}

const matcher = (v: Viewport): MediaMatch => (q) => evaluate(q, v);
/** A full-screen window unless `deviceW` says the screen is wider; iOS reports the portrait width as device-width. */
const touch = (w: number, h: number, deviceW = Math.min(w, h)): Viewport => ({ w, h, coarse: true, deviceW });
const mouse = (w: number, h: number): Viewport => ({ w, h, coarse: false, deviceW: Math.min(w, h) });

const PHONES_LANDSCAPE = [touch(667, 375), touch(844, 390), touch(932, 430)];
const PHONES_PORTRAIT = [touch(375, 667), touch(390, 844), touch(430, 932)];
const TABLETS = [touch(1024, 768), touch(1366, 1024), touch(768, 1024)];
/** iPad Slide Over and one-third Split View: a phone-narrow portrait window on a screen 768px or wider */
const IPAD_NARROW_WINDOWS = [touch(375, 980, 820), touch(375, 1024, 1024), touch(320, 1366, 1024)];

describe('deviceForm', () => {
  test('landscape and portrait phones are phones', () => {
    for (const v of [...PHONES_LANDSCAPE, ...PHONES_PORTRAIT]) expect(deviceForm(matcher(v))).toBe('phone');
  });

  test('tablets in both holds are tablets', () => {
    for (const v of TABLETS) expect(deviceForm(matcher(v))).toBe('tablet');
  });

  test('a narrow iPad window (Slide Over, one-third Split View) is a tablet: its screen is not a phone screen', () => {
    for (const v of IPAD_NARROW_WINDOWS) expect([v, deviceForm(matcher(v))]).toEqual([v, 'tablet']);
  });

  test('a small desktop window stays desktop at any size', () => {
    for (const v of [mouse(600, 400), mouse(375, 667), mouse(667, 375), mouse(1920, 1080)]) expect(deviceForm(matcher(v))).toBe('desktop');
  });
});

describe('needsRotate', () => {
  test('only a phone held in portrait', () => {
    for (const v of PHONES_PORTRAIT) expect(needsRotate(matcher(v))).toBe(true);
    for (const v of [...PHONES_LANDSCAPE, ...TABLETS, mouse(375, 667)]) expect(needsRotate(matcher(v))).toBe(false);
  });

  test('never a narrow iPad window, which turning the iPad cannot widen', () => {
    for (const v of IPAD_NARROW_WINDOWS) expect([v, needsRotate(matcher(v))]).toEqual([v, false]);
  });
});

interface FsDocOpts {
  standard?: boolean;
  enabled?: boolean;
  webkit?: boolean;
  webkitReturnsUndefined?: boolean;
}

function fullscreenDoc(opts: FsDocOpts) {
  const calls: string[] = [];
  const root: Record<string, unknown> = {};
  const doc: Record<string, unknown> = { documentElement: root, fullscreenElement: null, webkitFullscreenElement: null };
  if (opts.standard) {
    root.requestFullscreen = function (this: unknown) {
      calls.push(this === root ? 'enter' : 'enter (unbound)');
      return Promise.resolve();
    };
    doc.exitFullscreen = function (this: unknown) {
      calls.push(this === doc ? 'exit' : 'exit (unbound)');
      return Promise.resolve();
    };
    if (opts.enabled !== undefined) doc.fullscreenEnabled = opts.enabled;
  }
  if (opts.webkit) {
    root.webkitRequestFullscreen = function (this: unknown) {
      calls.push(this === root ? 'webkit enter' : 'webkit enter (unbound)');
      return opts.webkitReturnsUndefined ? undefined : Promise.resolve();
    };
    doc.webkitExitFullscreen = function (this: unknown) {
      calls.push(this === doc ? 'webkit exit' : 'webkit exit (unbound)');
    };
  }
  return { doc, calls, asDocument: doc as unknown as Document };
}

describe('fullscreenApi', () => {
  test('the standard API first', async () => {
    const { doc, calls, asDocument } = fullscreenDoc({ standard: true, webkit: true });
    const fs = fullscreenApi(asDocument);
    expect(fs).not.toBeNull();
    expect(fs!.active()).toBe(false);
    await fs!.enter();
    doc.fullscreenElement = doc.documentElement;
    expect(fs!.active()).toBe(true);
    await fs!.exit();
    expect(calls).toEqual(['enter', 'exit']);
  });

  test('else the webkit-prefixed one (iPad Safari), even when it returns no promise', async () => {
    const { doc, calls, asDocument } = fullscreenDoc({ webkit: true, webkitReturnsUndefined: true });
    const fs = fullscreenApi(asDocument);
    expect(fs).not.toBeNull();
    await fs!.enter();
    doc.webkitFullscreenElement = doc.documentElement;
    expect(fs!.active()).toBe(true);
    await fs!.exit();
    expect(calls).toEqual(['webkit enter', 'webkit exit']);
  });

  test('else null (iPhone Safari)', () => {
    expect(fullscreenApi(fullscreenDoc({}).asDocument)).toBeNull();
  });

  test('a standard API that reports itself disabled does not count', () => {
    expect(fullscreenApi(fullscreenDoc({ standard: true, enabled: false }).asDocument)).toBeNull();
    expect(fullscreenApi(fullscreenDoc({ standard: true, enabled: true }).asDocument)).not.toBeNull();
  });
});

class FakeEl {
  className = '';
  textContent = '';
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  append(child: FakeEl): void {
    child.parent = this;
    this.children.push(child);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

class FakeMql {
  readonly listeners = new Set<() => void>();
  constructor(
    readonly media: string,
    public matches: boolean,
  ) {}
  addEventListener(_type: 'change', fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: 'change', fn: () => void): void {
    this.listeners.delete(fn);
  }
}

function fakeWindow(start: Viewport, fullscreen: FsDocOpts = {}) {
  const { doc } = fullscreenDoc(fullscreen);
  const root = doc.documentElement as Record<string, unknown>;
  const dataset: Record<string, string> = {};
  root.dataset = dataset;
  const body = new FakeEl();
  doc.body = body;
  doc.createElement = () => new FakeEl();
  const lists: FakeMql[] = [];
  const win = {
    document: doc,
    matchMedia: (q: string) => {
      const list = new FakeMql(q, evaluate(q, start));
      lists.push(list);
      return list;
    },
  };
  return {
    win: win as unknown as Window,
    dataset,
    body,
    listeners: () => lists.reduce((n, l) => n + l.listeners.size, 0),
    /** fires 'change' only on the lists whose result flipped, like a browser */
    resize(v: Viewport): void {
      for (const list of lists) {
        const now = evaluate(list.media, v);
        if (now === list.matches) continue;
        list.matches = now;
        for (const fn of [...list.listeners]) fn();
      }
    },
  };
}

describe('DeviceWatcher', () => {
  test('a desktop gets data-device and nothing else', () => {
    const w = fakeWindow(mouse(1280, 800), { standard: true });
    const watcher = new DeviceWatcher(w.win);
    expect(watcher.form).toBe('desktop');
    expect(w.dataset).toEqual({ device: 'desktop' });
    w.resize(mouse(400, 800));
    expect(w.dataset).toEqual({ device: 'desktop' });
    expect(w.body.children).toHaveLength(0);
  });

  test('a landscape phone without element fullscreen: phone, fullscreen none, no rotate', () => {
    const w = fakeWindow(touch(844, 390));
    const watcher = new DeviceWatcher(w.win);
    expect(watcher.form).toBe('phone');
    expect(watcher.rotate).toBe(false);
    expect(w.dataset).toEqual({ device: 'phone', fullscreen: 'none' });
    expect(w.body.children).toHaveLength(0);
  });

  test('a tablet with the fullscreen API', () => {
    const w = fakeWindow(touch(1024, 768), { webkit: true });
    expect(new DeviceWatcher(w.win).form).toBe('tablet');
    expect(w.dataset).toEqual({ device: 'tablet', fullscreen: 'api' });
  });

  test('turning a phone to portrait raises the overlay and fires onRotate; turning it back lowers it', () => {
    const w = fakeWindow(touch(844, 390));
    const watcher = new DeviceWatcher(w.win);
    const seen: boolean[] = [];
    watcher.onRotate((blocked) => seen.push(blocked));

    w.resize(touch(390, 844));
    expect(w.dataset.rotate).toBe('');
    expect(watcher.rotate).toBe(true);
    expect(seen).toEqual([true]);
    expect(w.body.children).toHaveLength(1);
    const overlay = w.body.children[0]!;
    expect(overlay.className).toBe('nv-rotate');
    expect(overlay.textContent).toBe(ROTATE_TEXT);

    w.resize(touch(844, 390));
    expect('rotate' in w.dataset).toBe(false);
    expect(seen).toEqual([true, false]);

    w.resize(touch(390, 844));
    expect(w.body.children).toHaveLength(1);
    expect(seen).toEqual([true, false, true]);
  });

  test('a phone that boots in portrait is blocked from the start without a callback', () => {
    const w = fakeWindow(touch(390, 844));
    const watcher = new DeviceWatcher(w.win);
    const seen: boolean[] = [];
    watcher.onRotate((blocked) => seen.push(blocked));
    expect(watcher.rotate).toBe(true);
    expect(w.dataset).toEqual({ device: 'phone', fullscreen: 'none', rotate: '' });
    expect(w.body.children).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  test('a form change on the fly rewrites the attributes (tablet window shrunk to phone height)', () => {
    const w = fakeWindow(touch(1024, 768), { standard: true });
    const watcher = new DeviceWatcher(w.win);
    w.resize(touch(1024, 480));
    expect(watcher.form).toBe('phone');
    expect(w.dataset).toEqual({ device: 'phone', fullscreen: 'api' });
  });

  test('unsubscribe and destroy stop everything', () => {
    const w = fakeWindow(touch(844, 390));
    const watcher = new DeviceWatcher(w.win);
    const seen: boolean[] = [];
    const off = watcher.onRotate((blocked) => seen.push(blocked));
    off();
    w.resize(touch(390, 844));
    expect(seen).toEqual([]);
    expect(w.listeners()).toBe(Object.keys(DEVICE_QUERIES).length);
    watcher.destroy();
    expect(w.listeners()).toBe(0);
    expect(w.body.children).toHaveLength(0);
  });
});

describe('app.css', () => {
  const css = readFileSync(new URL('../src/ui/app.css', import.meta.url), 'utf8');

  test('the rotate overlay is hidden unless html[data-rotate], and sits at --nv-z-rotate when shown', () => {
    expect(css).toMatch(/\n\.nv-rotate \{\s*display: none;\s*\}/);
    const shown = /html\[data-rotate\] \.nv-rotate \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(shown).toContain('position: fixed;');
    expect(shown).toContain('inset: 0;');
    expect(shown).toContain('z-index: var(--nv-z-rotate);');
    expect(shown).toContain('pointer-events: auto;');
  });

  test('no bare 100vh: the fatal panel follows the dynamic viewport', () => {
    expect(css).not.toMatch(/[^-]100vh/);
    expect(/\.nv-error--fatal \{([^}]*)\}/.exec(css)?.[1]).toContain('height: var(--nv-vh);');
  });
});
