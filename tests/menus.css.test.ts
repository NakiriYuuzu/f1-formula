/**
 * Menu stylesheet and input-mode contract for phones and tablets, checked on the CSS text: the input mode comes from
 * html[data-input-mode] (no private .is-pad), heights follow --nv-vh, safe areas come only from the tokens, sliders let
 * a vertical swipe scroll, and every phone or touch rule is gated on a root attribute so a desktop with a fine pointer
 * renders as before. Plus the key cap's data-show-for spellings and the touch tap-twice rule on a minimal fake DOM.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const css = await Bun.file(new URL('../src/ui/menus/menus.css', import.meta.url)).text();
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** [selector list, declarations] of every plain rule (at-rule preludes dropped). */
const rules: [string[], string][] = [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [
  (m[1] ?? '')
    .replace(/@media[^{]*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('@')),
  m[2] ?? '',
]);

function rule(selector: string): string {
  const found = rules.find(([sel]) => sel.length === 1 && sel[0] === selector);
  expect(found).toBeDefined();
  return found?.[1] ?? '';
}

describe('menus stylesheet', () => {
  test('the gamepad look reads html[data-input-mode], never a menu-private .is-pad class', () => {
    expect(code).not.toContain('is-pad');
    expect(code).not.toContain('nvm-key-kb');
    expect(code).not.toContain('nvm-key-pad');
    const padGlyph = rules.flatMap(([sel]) => sel).filter((s) => s.includes('kbd[data-pad'));
    expect(padGlyph.length).toBeGreaterThan(0);
    for (const s of padGlyph) expect(s.startsWith("html[data-input-mode='gamepad'] ")).toBe(true);
  });

  test('no bare 100vh: viewport heights use var(--nv-vh)', () => {
    expect(code).not.toMatch(/100vh/);
    expect(code).toContain('var(--nv-vh)');
  });

  test('safe areas come from the tokens only', () => {
    expect(code).not.toContain('env(safe-area-inset');
    for (const side of ['t', 'r', 'b', 'l']) expect(code).toContain(`var(--nv-safe-${side})`);
  });

  test('a slider lets a vertical swipe scroll the page', () => {
    expect(rule('.nvm-slider')).toContain('touch-action: pan-y');
  });

  test('hit sizes only grow: --nv-hit (0px on desktop) is a floor inside max() or a min-height / min-width', () => {
    const uses = rules.flatMap(([, body]) => body.split(';').filter((d) => d.includes('var(--nv-hit)')));
    expect(uses.length).toBeGreaterThan(0);
    for (const decl of uses) {
      const [prop = '', value = ''] = decl.split(/:(.*)/s).map((p) => p.trim());
      const floor = /^(min-height|min-width)$/.test(prop) && value === 'var(--nv-hit)';
      expect(floor || /max\([^()]+, var\(--nv-hit\)\)/.test(value)).toBe(true);
    }
  });

  test('phone and touch rules are gated on a root attribute', () => {
    for (const [selectors, body] of rules) {
      for (const s of selectors) {
        if (s.includes('data-device') || s.includes('data-input-mode') || s.includes('data-fullscreen')) expect(s.startsWith('html')).toBe(true);
        if (s.includes(':active')) expect(s.startsWith("html[data-input-mode='touch'] ")).toBe(true);
        if (s.includes('.nvm-foot') && /display:\s*none/.test(body)) expect(s).toBe("html[data-input-mode='touch'] .nvm-foot");
      }
    }
    const phone = rules.flatMap(([sel]) => sel).filter((s) => s.startsWith("html[data-device='phone']"));
    expect(phone.length).toBeGreaterThan(0);
  });

  test('touch mode drops the footer and gives its height to the stage', () => {
    expect(rule("html[data-input-mode='touch'] .nvm-foot")).toContain('display: none');
    expect(rule("html[data-input-mode='touch'] .nvm-root")).toContain('--nvm-foot-h: 0px');
    expect(rule('.nvm-stage')).toContain('bottom: calc(var(--nvm-foot-h) + var(--nv-safe-b))');
  });

  test('the desktop chrome keeps its sizes: header 3.86em, footer 3.6em, toasts 1em above the footer', () => {
    expect(rule('.nvm-root')).toContain('--nvm-top-h: 3.86em');
    expect(rule('.nvm-root')).toContain('--nvm-foot-h: 3.6em');
    expect(rule('.nvm-toasts')).toContain('bottom: calc(var(--nvm-foot-h) + 1em + var(--nv-safe-b))');
  });

  test('phones drop the floors taller than their stage', () => {
    expect(rule("html[data-device='phone'] .nvm-settings__body")).toContain('min-height: 0');
    expect(rule("html[data-device='phone'] .nvm-scroll")).toContain('max-height: none');
    expect(rule("html[data-device='phone'] .nvm-mosaic")).toContain('grid-auto-rows: minmax(0, 1fr)');
  });
});

interface FakeNode {
  tag: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  textContent: string;
  dataset: Record<string, string>;
  parentElement: null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  append(...c: (FakeNode | string)[]): void;
  addEventListener(): void;
  focus(): void;
}

let focused: FakeNode | null = null;

function fakeEl(tag: string): FakeNode {
  const el: FakeNode = {
    tag,
    attrs: {},
    children: [],
    textContent: '',
    dataset: {},
    parentElement: null,
    setAttribute(k, v) {
      el.attrs[k] = v;
    },
    getAttribute(k) {
      return el.attrs[k] ?? null;
    },
    append(...c) {
      for (const x of c) if (typeof x !== 'string') el.children.push(x);
    },
    addEventListener() {},
    focus() {
      focused = el;
    },
  };
  return el;
}

const root = { dataset: {} as Record<string, string> };
let savedDocument: unknown;

beforeAll(() => {
  savedDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { documentElement: root, createElement: fakeEl };
});

afterAll(() => {
  (globalThis as { document?: unknown }).document = savedDocument;
});

describe('menus input mode', () => {
  test('a key cap carries both spellings for the mode rule in app.css, and hides as a whole for touch', async () => {
    const { keyCap } = await import('../src/ui/menus/widgets');
    const cap = keyCap('Esc', 'B') as unknown as FakeNode;
    expect(cap.attrs['data-show-for']).toBe('keyboard gamepad');
    expect(cap.children.map((c) => [c.attrs['data-show-for'], c.textContent])).toEqual([
      ['keyboard', 'Esc'],
      ['gamepad', 'B'],
    ]);
  });

  test('touch: the first tap on a preview-on-focus item previews it, a second tap on it chooses', async () => {
    const { tapChooses } = await import('../src/ui/menus/nav');
    const a = fakeEl('button');
    const b = fakeEl('button');
    const tap = (el: FakeNode): boolean => tapChooses({ currentTarget: el } as unknown as Event);
    root.dataset.inputMode = 'keyboard';
    expect(tap(a)).toBe(true);
    root.dataset.inputMode = 'touch';
    focused = null;
    expect(tap(a)).toBe(false);
    expect(focused === a).toBe(true);
    expect(tap(b)).toBe(false);
    expect(tap(a)).toBe(false);
    expect(tap(a)).toBe(true);
    expect(tap(a)).toBe(false);
  });

  test('touch: the item the menu focused itself (the selection on entry) is already previewed, so one tap chooses it', async () => {
    const { focusElement, tapChooses } = await import('../src/ui/menus/nav');
    const selected = fakeEl('button');
    const other = fakeEl('button');
    const tap = (el: FakeNode): boolean => tapChooses({ currentTarget: el } as unknown as Event);
    root.dataset.inputMode = 'touch';
    focusElement(selected as unknown as HTMLElement);
    expect(tap(selected)).toBe(true);

    focusElement(selected as unknown as HTMLElement);
    expect(tap(other)).toBe(false);
    expect(focused === other).toBe(true);
    expect(tap(selected)).toBe(false);
    expect(tap(selected)).toBe(true);
  });
});
