/**
 * HUD stylesheet house rules (docs/plans/ui-redesign-2026-11.md §1 and §3), checked on the CSS text: no blur,
 * gradients, text shadow, uppercase, tracked letter-spacing, mono / display faces, glowing shadows or text under 11px
 * at the smallest root, and the split-screen FPS block must not sit on the divider.
 */
import { describe, expect, test } from 'bun:test';
import { TOWER_ROW_EM } from '../src/ui/hud/tower';

const css = await Bun.file(new URL('../src/ui/hud/hud.css', import.meta.url)).text();
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const at = code.indexOf(`${selector} {`);
  expect(at).toBeGreaterThanOrEqual(0);
  return code.slice(at, code.indexOf('}', at));
}

describe('HUD stylesheet', () => {
  test('banned properties and values are absent', () => {
    for (const banned of [/backdrop-filter/, /gradient\(/, /text-shadow/, /text-transform:\s*uppercase/, /font-style:\s*italic/, /--nv-font-display|--nv-font-mono|Barlow|monospace/]) {
      expect(code).not.toMatch(banned);
    }
  });

  test('letter-spacing is never tracked out', () => {
    for (const m of code.matchAll(/letter-spacing:\s*(-?[\d.]+)em/g)) expect(Number(m[1])).toBeLessThan(0.05);
  });

  test('weights are 400, 500 and 600 only', () => {
    for (const m of code.matchAll(/font-weight:\s*(\d+)/g)) expect([400, 500, 600]).toContain(Number(m[1]));
  });

  test('the only box-shadow is the floating one on the pause menu, its confirm dialog and the help card', () => {
    const shadows = [...code.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]);
    expect(shadows.length).toBe(3);
    expect(new Set(shadows)).toEqual(new Set(['0 12px 32px rgba(0, 0, 0, 0.5)']));
  });

  test('literal font sizes are at least 0.917em (11px at the smallest 12px root)', () => {
    for (const m of code.matchAll(/font-size:\s*([\d.]+)em/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0.917);
    for (const m of code.matchAll(/--nvh-xs:\s*([\d.]+)em/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0.917);
  });

  test('a split-screen half is 0.92em, so its smallest text steps up to 1em', () => {
    const half = rule('.nvh-view[data-compact]');
    expect(half).toContain('font-size: 0.92em');
    expect(half).toContain('--nvh-xs: 1em');
    expect(0.92 * 1).toBeGreaterThanOrEqual(0.917);
  });

  test('root scale and tabular figures', () => {
    expect(code).toContain('font-size: clamp(12px, min(1.5vh, 1.05vw), 18px)');
    expect(code).toContain('font-variant-numeric: tabular-nums');
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

  test('the bottom-centre stack is capped to stay clear of the 21em telemetry cluster on both sides', () => {
    expect(code).toMatch(/\.nvh-tele \{[^}]*width: 21em/);
    expect(rule('.nvh-bc')).toContain('calc(100% - 2 * (21em + var(--nvh-edge) + 0.75em))');
  });

  test('pause items and confirm buttons invert on focus', () => {
    expect(code).toMatch(/\.nvh-pi:focus,\s*\.nvh-pi\[data-selected\]\s*\{[^}]*var\(--nv-focus-bg\)[^}]*var\(--nv-focus-ink\)/);
    expect(code).toMatch(/\.nvh-cbtn:focus,\s*\.nvh-cbtn\[data-selected\]\s*\{[^}]*var\(--nv-focus-bg\)[^}]*var\(--nv-focus-ink\)/);
  });
});
