/**
 * HUD stylesheet house rules (docs/plans/ui-festival-2026-11.md §1 and §3), checked on the CSS text: glass blocks
 * without a backdrop blur (only the pause overlay and the help card over it may blur), figures in the display face
 * with tabular numbers, text of at least 11px at the smallest root (the damage callouts' SVG text included), the tower
 * row height, the split-screen FPS block off the divider, the bottom-centre stack capped against the telemetry cluster,
 * and the pink focus fill.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TOWER_ROW_EM } from '../src/ui/hud/tower';

const css = await Bun.file(new URL('../src/ui/hud/hud.css', import.meta.url)).text();
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const at = code.indexOf(`${selector} {`);
  expect(at).toBeGreaterThanOrEqual(0);
  return code.slice(at, code.indexOf('}', at));
}

/** Every innermost rule block: its selector list (split on top-level commas, so `:is(a, b)` stays whole) and body. */
const blocks = [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
  const selectors: string[] = [];
  let depth = 0;
  let from = 0;
  const text = m[1];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      selectors.push(text.slice(from, i));
      from = i + 1;
    }
  }
  selectors.push(text.slice(from));
  return { text: text.replace(/\s+/g, ' ').trim(), selectors: selectors.map((s) => s.replace(/\s+/g, ' ').trim()), body: m[2] };
});

const TOUCH = '.nvh-root[data-touch]';
const PHONE = "html[data-device='phone']";
const TABLET = "html[data-device='tablet']";

describe('HUD stylesheet', () => {
  test('no backdrop-filter outside the pause overlay and the help card over it', () => {
    const blurred = [...code.matchAll(/([^{}]+)\{[^{}]*backdrop-filter[^{}]*\}/g)].map((m) => m[1].trim());
    expect(blurred.length).toBeGreaterThan(0);
    expect(new Set(blurred)).toEqual(new Set(['.nvh-pause', '.nvh-help']));
  });

  test('blocks are glass: --nv-scrim, no blur on the panel', () => {
    expect(rule('.nvh-panel')).toContain('background: var(--nv-scrim)');
    expect(rule('.nvh-panel')).not.toContain('backdrop-filter');
  });

  test('literal font sizes are at least 0.917em (11px at the smallest 12px root)', () => {
    for (const m of code.matchAll(/font-size:\s*([\d.]+)em/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0.917);
    for (const m of code.matchAll(/--nvh-xs:\s*([\d.]+)em/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0.917);
  });

  test('damage callout text is in SVG units of 0.1em (the diagram spans the card content) and at least 9.2 (0.92em)', () => {
    const ts = readFileSync(new URL('../src/ui/hud/telemetry.ts', import.meta.url), 'utf8');
    const dmgW = Number(/const DMG_W = ([\d.]+);/.exec(ts)?.[1]);
    // the rules themselves, not the overrides that end with the same selector (data-nocar, data-compact, …)
    const tele = /^\.nvh-tele \{[^}]*/m.exec(code)?.[0] ?? '';
    const card = /^\.nvh-car-row \{[^}]*/m.exec(code)?.[0] ?? '';
    const em = (re: RegExp, block: string): number => Number(re.exec(block)?.[1]);
    const content =
      em(/\bwidth: ([\d.]+)em/, tele) -
      em(/grid-template-columns: ([\d.]+)em/, tele) -
      em(/column-gap: ([\d.]+)em/, tele) -
      2 * em(/padding: [\d.]+em ([\d.]+)em/, card);
    expect(dmgW / 10).toBeCloseTo(content, 6);
    const sized = [...code.matchAll(/([^{}]+)\{[^{}]*font-size:\s*([\d.]+)px[^{}]*\}/g)];
    expect(sized.length).toBeGreaterThan(0);
    for (const m of sized) {
      expect(m[1].trim()).toMatch(/^\.nvh-dmg-/);
      expect(Number(m[2])).toBeGreaterThanOrEqual(9.2);
    }
  });

  test('a split-screen half is 0.92em, so its smallest text steps up to 1em', () => {
    const half = rule('.nvh-view[data-compact]');
    expect(half).toContain('font-size: 0.92em');
    expect(half).toContain('--nvh-xs: 1em');
    expect(0.92 * 1).toBeGreaterThanOrEqual(0.917);
  });

  test('root scale and tabular figures', () => {
    expect(code).toContain('font-size: clamp(12px, min(var(--nv-vh) * 0.015, 1.05vw), 18px)');
    expect(code).toContain('font-variant-numeric: tabular-nums');
  });

  test('figures (position, lap, speed, gear, times) use the display face', () => {
    const at = code.indexOf('.nvh-pos,');
    expect(at).toBeGreaterThanOrEqual(0);
    const block = code.slice(at, code.indexOf('}', at));
    for (const sel of ['.nvh-pos', '.nvh-lapbox-v', '.nvh-laptime', '.nvh-speed-num', '.nvh-gear', '.nvh-tw-pos > b']) expect(block).toContain(sel);
    expect(block).toContain('font-family: var(--nv-font-display)');
    expect(block).toContain('font-weight: 800');
  });

  test('the tower row height matches the TOWER_ROW_EM the windowing measures with', () => {
    expect(code).toContain(`--nvh-tw-row: ${TOWER_ROW_EM}em`);
  });

  test('split screen: the FPS / ping block rests left of the divider and the diagnostics panel stays on that side', () => {
    const topc = rule('.nvh-root[data-split] .nvh-topc');
    expect(topc).toContain('left: auto');
    expect(topc).toContain('right: calc(50% + ');
    expect(topc).toContain('translate: none');
    const net = rule('.nvh-root[data-split] .nvh-net');
    expect(net).toContain('right: 0');
    expect(net).toContain('translate: none');
  });

  test('the bottom-centre stack is capped to stay clear of the telemetry cluster on both sides', () => {
    const width = /\.nvh-tele \{[^}]*?\bwidth: ([\d.]+)em/.exec(code);
    expect(width).not.toBeNull();
    expect(rule('.nvh-bc')).toContain(`calc(100% - 2 * (${width![1]}em + var(--nvh-edge) + 0.75em))`);
  });

  test('the gauge arcs are filled by dash offset and the gear sits in a pink disc', () => {
    expect(rule('.nvh-arc-fill')).toContain('stroke-dasharray: 100');
    expect(rule('.nvh-gear')).toContain('background: var(--nv-accent)');
    expect(rule('.nvh-tw-row[data-player]')).toContain('background: var(--nv-accent)');
  });

  test('pause items and confirm buttons take the pink focus fill', () => {
    expect(code).toMatch(/\.nvh-pi:focus,\s*\.nvh-pi\[data-selected\]\s*\{[^}]*var\(--nv-focus-bg\)[^}]*var\(--nv-focus-ink\)/);
    expect(code).toMatch(/\.nvh-cbtn:focus,\s*\.nvh-cbtn\[data-selected\]\s*\{[^}]*var\(--nv-focus-bg\)[^}]*var\(--nv-focus-ink\)/);
  });

  test('reduced motion swaps the slides for fades and stops the focus lift', () => {
    const at = code.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(at).toBeGreaterThanOrEqual(0);
    const media = code.slice(at);
    expect(media).toContain('animation-name: nvh-fade');
    expect(media).toMatch(/\.nvh-pi:focus,[^{]*\{[^}]*transform: none/);
  });
});

describe('HUD stylesheet on phones and tablets', () => {
  test('the HUD root is inset by the safe-area tokens, and only tokens.css reads the insets', () => {
    expect(rule('.nvh-root')).toContain('inset: var(--nv-safe-t) var(--nv-safe-r) var(--nv-safe-b) var(--nv-safe-l)');
    expect(css).not.toContain('env(safe-area-inset');
  });

  test('the pause and help overlays are fixed to the viewport, so they still cover the notch strips', () => {
    for (const sel of ['.nvh-pause', '.nvh-help']) {
      expect(rule(sel)).toContain('position: fixed');
      expect(rule(sel)).toContain('inset: 0');
    }
  });

  test('hiding the HUD keeps the overlays and the touch deck', () => {
    expect(code).toContain('.nvh-root[data-hud-hidden] > :not(.nvh-pause):not(.nvh-help):not(.nvt) {');
  });

  test('viewport heights go through --nv-vh (dynamic on phones), never a bare vh', () => {
    expect(code).not.toMatch(/[\d.]vh\b/);
    expect(rule('.nvh-pause-card')).toContain('var(--nv-vh)');
    expect(rule('.nvh-help-card')).toContain('var(--nv-vh)');
  });

  test('every rule that reads the deck footprint is scoped to a root showing the deck', () => {
    const footprint = blocks.filter((b) => b.body.includes('var(--nvt-'));
    expect(footprint.length).toBeGreaterThan(0);
    for (const b of footprint) for (const s of b.selectors) expect(s).toContain(TOUCH);
    for (const b of blocks) for (const s of b.selectors) if (s.includes('[data-touch]')) expect(s).toContain(TOUCH);
  });

  test('the tower, minimap, telemetry and bottom-centre stack each move while the deck is on screen', () => {
    const touchSelectors = new Set(blocks.flatMap((b) => b.selectors));
    for (const sel of ['.nvh-tl', '.nvh-bl', '.nvh-view', '.nvh-tele', '.nvh-bc']) expect(touchSelectors).toContain(`${TOUCH} ${sel}`);
    const bc = blocks.filter((b) => b.selectors.includes(`${TOUCH} .nvh-bc`)).map((b) => b.body).join('');
    expect(bc).toContain('width: min(29em, calc(100% - 2 * (var(--nvt-thumb-w) + var(--nvt-gap))))');
  });

  test('the phone form hides the minimap and compacts only on a phone showing the deck', () => {
    const phone = blocks.flatMap((b) => b.selectors).filter((s) => s.startsWith(`${PHONE} ${TOUCH} `));
    expect(phone).toContain(`${PHONE} ${TOUCH} .nvh-minimap`);
    for (const b of blocks) {
      for (const s of b.selectors) {
        if (!s.includes(PHONE) || s.startsWith(':is(')) continue;
        // the replay bar has no deck (the deck is off in replays), so its phone form keys off the device alone
        if (!/\.nvh-(replay|rp-)/.test(s)) expect(s.startsWith(`${PHONE} ${TOUCH} `)).toBe(true);
      }
    }
  });

  test('on a phone one row under the lap time shows the pit status, else the flag chips, else the delta', () => {
    const timing = `${PHONE} ${TOUCH} .nvh-timing`;
    const hides = (selector: string): boolean => blocks.some((b) => b.selectors.includes(selector) && /display:\s*none/.test(b.body));
    expect(hides(`${timing}:has(.nvh-pitstat:not(.nvh-hidden)) .nvh-tp-delta`)).toBe(true);
    expect(hides(`${timing}:has(.nvh-flagchip:not(.nvh-hidden)) .nvh-tp-delta`)).toBe(true);
    expect(hides(`${timing}:has(.nvh-pitstat:not(.nvh-hidden)) .nvh-flagchips`)).toBe(true);
    // two rows of chips would be taller than the delta row they replace
    expect(rule(`${PHONE} ${TOUCH} .nvh-flagchips`)).toContain('flex-wrap: nowrap');
  });

  test('tappable controls reach the touch hit size on phones and tablets, and desktop never reads it', () => {
    const sized = blocks.filter((b) => b.body.includes('var(--nv-hit)'));
    expect(sized.length).toBeGreaterThan(0);
    for (const b of sized) for (const s of b.selectors) expect(s.startsWith(`:is(${PHONE}, ${TABLET})`)).toBe(true);
    const controls = [
      '.nvh-pi',
      '.nvh-pi-arrow',
      '.nvh-cbtn',
      '.nvh-help-tab',
      '.nvh-help-close',
      '.nvh-mfd-close',
      '.nvh-arrow',
      '.nvh-btn',
      '.nvh-ers-btn',
      '.nvh-rp-play',
      '.nvh-rp-speed',
      '.nvh-rp-btn',
      '.nvh-rp-scrub',
      '.nvh-tw-toggle',
    ];
    for (const c of controls) {
      const named = new RegExp(`\\${c}(?![\\w-])`);
      const hit = sized.filter((b) => named.test(b.text));
      expect(hit.length).toBeGreaterThan(0);
      expect(hit.some((b) => b.body.includes('min-height'))).toBe(true);
    }
    expect(code).not.toMatch(/data-device='desktop'/);
  });

  test('overlay scroll regions scroll by touch: they own their overflow and nothing in the HUD blocks panning', () => {
    expect(rule('.nvh-pause-card')).toContain('overflow-y: auto');
    expect(rule('.nvh-help-body')).toContain('overflow-y: auto');
    expect(rule(`${PHONE} ${TOUCH} .nvh-mfd`)).toContain('overflow-y: auto');
    const blocked = blocks.filter((b) => /touch-action:\s*none/.test(b.body)).map((b) => b.text);
    expect(blocked).toEqual(['.nvh-rp-scrub']);
  });
});

