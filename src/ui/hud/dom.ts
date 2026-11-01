/**
 * HUD DOM helpers: element factories plus change-cached writers so per-frame updates only touch the DOM
 * when a displayed value actually changes.
 */
import { clamp01 } from '../../core/math';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an HTML element with an optional class, parent and text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: Element,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

/** Create an SVG element with attributes. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
  if (parent) parent.appendChild(node);
  return node;
}

/**
 * A real <button> for a pointer-only HUD control (tower interval / gap toggle, MFD buttons, replay bar, 操作說明
 * tabs and 返回). It is out of the tab order (tabindex -1) and never takes focus from a mouse press, so Space / Enter
 * keep driving the car or the replay instead of re-pressing the last control. Keyboard / pad paths: MFD (1-6 keys,
 * D-pad), replay bar (Space, arrows, A, D-pad), 操作說明 (arrows / pad, Esc closes). The tower interval / gap toggle
 * has no key binding yet: HudLayer.toggleTowerMode() is the hook an App key can call. Assistive tech still sees a
 * button and can activate it.
 */
export function clickable(className: string, parent: Element, text: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, parent, text);
  node.type = 'button';
  node.tabIndex = -1;
  node.addEventListener('mousedown', (e) => e.preventDefault());
  node.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return node;
}

/** Cached textContent writer. */
export class TextSlot {
  private last: string | null = null;
  constructor(readonly node: Element) {}
  set(text: string): void {
    if (text === this.last) return;
    this.last = text;
    this.node.textContent = text;
  }
}

/** Cached attribute writer; `null` removes the attribute. Used for data-state driven CSS. */
export class AttrSlot {
  private last: string | null | undefined = undefined;
  constructor(
    readonly node: Element,
    readonly name: string,
  ) {}
  set(value: string | null): void {
    if (value === this.last) return;
    this.last = value;
    if (value === null) this.node.removeAttribute(this.name);
    else this.node.setAttribute(this.name, value);
  }
}

/** Cached single inline style property writer. */
export class StyleSlot {
  private last: string | null = null;
  constructor(
    readonly node: HTMLElement | SVGElement,
    readonly prop: string,
  ) {}
  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.node.style.setProperty(this.prop, value);
  }
}

/** Cached 0..1 bar fill via transform scale (quantised to 1/500 to avoid needless writes). */
export class ScaleSlot {
  private last = -1;
  constructor(
    readonly node: HTMLElement,
    readonly axis: 'x' | 'y',
  ) {}
  set(value: number): void {
    const q = Math.round(clamp01(Number.isFinite(value) ? value : 0) * 500) / 500;
    if (q === this.last) return;
    this.last = q;
    this.node.style.transform = this.axis === 'x' ? `scaleX(${q})` : `scaleY(${q})`;
  }
}

/**
 * Cached 0..1 arc fill for an SVG path with pathLength 100 and `stroke-dasharray: 100` (set in CSS): the dash is
 * shortened with stroke-dashoffset. Quantised to 1/500 like ScaleSlot.
 */
export class DashSlot {
  private last = -1;
  constructor(readonly node: SVGElement) {}
  set(value: number): void {
    const q = Math.round(clamp01(Number.isFinite(value) ? value : 0) * 500) / 500;
    if (q === this.last) return;
    this.last = q;
    this.node.style.strokeDashoffset = String(Math.round((1 - q) * 1000) / 10);
  }
}

/** Cached visibility toggle (class-based so it beats author `display` rules). */
export class ShowSlot {
  private last: boolean | null = null;
  constructor(readonly node: Element) {}
  set(visible: boolean): void {
    if (visible === this.last) return;
    this.last = visible;
    this.node.classList.toggle('nvh-hidden', !visible);
  }
}
