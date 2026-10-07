/**
 * Keyboard focus navigation for menu screens: focusable discovery, spatial arrow-key movement (with wrap-around
 * in the same column), adjustable controls (←/→ change a value instead of moving focus) and text-field detection.
 */

export type NavDirection = 'up' | 'down' | 'left' | 'right';

/** Elements whose value ←/→ adjust (cyclers, sliders, toggles). */
const adjusters = new WeakMap<HTMLElement, (dir: -1 | 1, coarse: boolean) => void>();

export function registerAdjuster(el: HTMLElement, fn: (dir: -1 | 1, coarse: boolean) => void): void {
  adjusters.set(el, fn);
}

export function getAdjuster(el: Element | null): ((dir: -1 | 1, coarse: boolean) => void) | undefined {
  return el instanceof HTMLElement ? adjusters.get(el) : undefined;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

function isVisible(el: HTMLElement): boolean {
  if (el.closest('[inert], [hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
}

export function isTextField(el: Element | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'search' || el.type === 'number');
}

/**
 * Scroll vertical scroll containers (up to the menu root) just enough to reveal `el`. Never scrolls horizontally,
 * so a screen mid-transition can not shift the layout sideways.
 */
export function ensureVisible(el: HTMLElement): void {
  const margin = 8;
  let node = el.parentElement;
  while (node && !node.classList.contains('nvm-root')) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      const r = el.getBoundingClientRect();
      const c = node.getBoundingClientRect();
      if (r.top < c.top + margin) node.scrollTop -= c.top + margin - r.top;
      else if (r.bottom > c.bottom - margin) node.scrollTop += r.bottom - (c.bottom - margin);
    }
    node = node.parentElement;
  }
}

/** Focus without letting the browser scroll anything, then reveal the element vertically. */
export function focusElement(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  ensureVisible(el);
}

function center(r: DOMRect): { x: number; y: number } {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Gap between [a0,a1] and [b0,b1] (0 when they overlap). */
function gap(a0: number, a1: number, b0: number, b1: number): number {
  if (b1 < a0) return a0 - b1;
  if (b0 > a1) return b0 - a1;
  return 0;
}

/**
 * Next element in a direction: nearest candidate in the half-plane, weighting misalignment on the cross axis.
 * Vertical moves wrap to the far end of the same column when nothing lies ahead.
 */
export function findNext(root: HTMLElement, current: HTMLElement | null, dir: NavDirection): HTMLElement | null {
  const list = focusables(root);
  if (list.length === 0) return null;
  if (!current || !list.includes(current)) return list[0] ?? null;
  const cr = current.getBoundingClientRect();
  const cc = center(cr);
  const vertical = dir === 'up' || dir === 'down';
  const sign = dir === 'down' || dir === 'right' ? 1 : -1;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const c = center(r);
    const primary = vertical ? (c.y - cc.y) * sign : (c.x - cc.x) * sign;
    if (primary <= 2) continue;
    const cross = vertical ? gap(cr.left, cr.right, r.left, r.right) : gap(cr.top, cr.bottom, r.top, r.bottom);
    const crossCenter = vertical ? Math.abs(c.x - cc.x) : Math.abs(c.y - cc.y);
    const score = primary + cross * 4 + crossCenter * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best || !vertical) return best;
  // wrap within the same column
  let wrap: HTMLElement | null = null;
  let wrapPos = 0;
  for (const el of list) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    if (gap(cr.left, cr.right, r.left, r.right) > 0) continue;
    const y = center(r).y * sign;
    if (wrap === null || y < wrapPos) {
      wrap = el;
      wrapPos = y;
    }
  }
  return wrap;
}

/** Scroll a focused scroll region one step; false when it cannot move further that way. */
export function scrollStep(el: HTMLElement, dir: -1 | 1): boolean {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 1) return false;
  const before = el.scrollTop;
  const next = Math.min(max, Math.max(0, before + dir * 72));
  if (Math.abs(next - before) < 1) return false;
  el.scrollTop = next;
  return true;
}
