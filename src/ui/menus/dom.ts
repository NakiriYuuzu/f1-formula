/**
 * Tiny typed DOM builder for the menus: h(tag, props, ...children).
 */
export type Child = Node | string | number | null | undefined | false;

type Listeners = { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };

export interface Props {
  class?: string;
  text?: string;
  /** attributes; `false` / null omit the attribute, `true` sets it empty */
  attrs?: Record<string, string | number | boolean | null>;
  /** inline style properties, incl. CSS custom properties ('--team': '#fff') */
  style?: Record<string, string>;
  on?: Listeners;
}

function append(el: HTMLElement, child: Child | Child[]): void {
  if (Array.isArray(child)) {
    for (const c of child) append(el, c);
    return;
  }
  if (child === null || child === undefined || child === false) return;
  el.append(typeof child === 'number' ? String(child) : child);
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v === false || v === null) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (props.style) for (const [k, v] of Object.entries(props.style)) el.style.setProperty(k, v);
    if (props.on) {
      for (const [type, handler] of Object.entries(props.on)) {
        if (handler) el.addEventListener(type, handler as EventListener);
      }
    }
  }
  for (const c of children) append(el, c);
  return el;
}

/** Replace all children. */
export function setChildren(el: HTMLElement, ...children: (Child | Child[])[]): void {
  el.replaceChildren();
  for (const c of children) append(el, c);
}

/** Set textContent only when it changed. */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
