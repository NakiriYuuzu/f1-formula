/**
 * Reusable menu controls: buttons / tiles, option cyclers, sliders, toggles, text fields, colour pickers,
 * tabs, panels and rating bars. Every control is keyboard-focusable; ←/→ adjust value controls.
 */
import { h, setText, type Child } from './dom';
import { focusElement, registerAdjuster } from './nav';

type SoundKind = 'move' | 'confirm' | 'back' | 'error';
let soundHook: (kind: SoundKind) => void = () => undefined;

/** MenuSystem installs the UI sound callback used by value controls. */
export function setWidgetSound(fn: (kind: SoundKind) => void): void {
  soundHook = fn;
}

export function widgetSound(kind: SoundKind): void {
  soundHook(kind);
}

// ───────────────────────────── buttons ─────────────────────────────

export interface ButtonOptions {
  label: string;
  sub?: string;
  onClick: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'tile' | 'chip';
  disabled?: boolean;
  /** small tag on the right */
  badge?: string;
  /** play the 'back' sound instead of 'confirm' */
  back?: boolean;
  /** extra content (e.g. a minimap canvas) */
  extra?: Child;
  className?: string;
}

export function button(o: ButtonOptions): HTMLButtonElement {
  const el = h(
    'button',
    {
      class: `nvm-btn nvm-btn--${o.variant ?? 'ghost'}${o.className ? ` ${o.className}` : ''}`,
      attrs: { type: 'button', disabled: o.disabled === true, 'data-sound': o.back ? 'back' : 'confirm' },
      on: { click: () => o.onClick() },
    },
    o.extra ?? null,
    h('span', { class: 'nvm-btn__label', text: o.label }),
    o.sub ? h('span', { class: 'nvm-btn__sub', text: o.sub }) : null,
    o.badge ? h('span', { class: 'nvm-btn__badge', text: o.badge }) : null,
  );
  return el;
}

/** Big angled main-menu tile with index number. */
export function tile(index: number, label: string, sub: string, onClick: () => void): HTMLButtonElement {
  return h(
    'button',
    { class: 'nvm-tile', attrs: { type: 'button', 'data-sound': 'confirm' }, on: { click: () => onClick() } },
    h('span', { class: 'nvm-tile__index', text: String(index).padStart(2, '0') }),
    h('span', { class: 'nvm-tile__body' }, h('span', { class: 'nvm-tile__label', text: label }), h('span', { class: 'nvm-tile__sub', text: sub })),
    h('span', { class: 'nvm-tile__arrow', text: '›' }),
  );
}

// ───────────────────────────── value rows ─────────────────────────────

export interface Control<T> {
  el: HTMLElement;
  /** the focusable element */
  focus: HTMLElement;
  get(): T;
  /** update without firing onChange */
  set(v: T): void;
  setDisabled(disabled: boolean): void;
}

function rowShell(label: string, description: string | undefined, control: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'nvm-row' },
    h('div', { class: 'nvm-row__head' }, h('span', { class: 'nvm-row__label', text: label }), control),
    description ? h('div', { class: 'nvm-row__desc', text: description }) : null,
  );
}

export interface Option<T> {
  value: T;
  label: string;
  /** optional colour chip */
  swatch?: string;
}

export interface CyclerOptions<T> {
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (v: T) => void;
  description?: string;
  /** wrap around at the ends (default true) */
  wrap?: boolean;
}

export interface CyclerControl<T> extends Control<T> {
  /** replace the option list (keeps the current value when still present) */
  setOptions(next: readonly Option<T>[]): void;
}

/** ◀ value ▶ option selector. */
export function cycler<T>(o: CyclerOptions<T>): CyclerControl<T> {
  let options = o.options;
  let index = Math.max(0, options.findIndex((x) => x.value === o.value));
  let disabled = false;
  const valueEl = h('span', { class: 'nvm-cycler__value' });
  const swatchEl = h('span', { class: 'nvm-cycler__swatch' });
  const dots = h('span', { class: 'nvm-cycler__dots' });
  const render = (): void => {
    const opt = options[index];
    setText(valueEl, opt ? opt.label : '—');
    if (opt?.swatch) {
      swatchEl.style.setProperty('background', opt.swatch);
      swatchEl.hidden = false;
    } else swatchEl.hidden = true;
    dots.hidden = options.length > 10;
    if (!dots.hidden && dots.childElementCount !== options.length) {
      dots.replaceChildren(...options.map(() => h('i')));
    }
    Array.from(dots.children).forEach((d, i) => d.classList.toggle('is-on', i === index));
  };
  const step = (dir: -1 | 1): void => {
    if (disabled || options.length === 0) return;
    let next = index + dir;
    if (o.wrap === false) next = Math.max(0, Math.min(options.length - 1, next));
    else next = (next + options.length) % options.length;
    if (next === index) return;
    index = next;
    render();
    widgetSound('move');
    const opt = options[index];
    if (opt) o.onChange(opt.value);
  };
  const arrow = (glyph: string, dir: -1 | 1): HTMLElement =>
    h('span', {
      class: 'nvm-cycler__arrow',
      text: glyph,
      on: {
        click: (e) => {
          e.stopPropagation();
          step(dir);
        },
      },
    });
  const prev = arrow('◀', -1);
  const next = arrow('▶', 1);
  const control = h(
    'button',
    { class: 'nvm-cycler', attrs: { type: 'button', 'data-sound': 'none' }, on: { click: () => step(1) } },
    prev,
    h('span', { class: 'nvm-cycler__mid' }, swatchEl, valueEl, dots),
    next,
  );
  registerAdjuster(control, (dir) => step(dir));
  render();
  const el = rowShell(o.label, o.description, control);
  return {
    el,
    focus: control,
    get: () => (options[index] ?? options[0])?.value as T,
    set: (v) => {
      const i = options.findIndex((x) => x.value === v);
      if (i >= 0) {
        index = i;
        render();
      }
    },
    setDisabled: (d) => {
      disabled = d;
      control.disabled = d;
      el.classList.toggle('is-disabled', d);
    },
    setOptions: (nextOptions) => {
      const current = options[index]?.value;
      options = nextOptions;
      const i = options.findIndex((x) => x.value === current);
      index = i >= 0 ? i : 0;
      render();
    },
  };
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, description?: string): Control<boolean> {
  return cycler<boolean>({
    label,
    options: [
      { value: true, label: '開啟' },
      { value: false, label: '關閉' },
    ],
    value,
    onChange,
    description,
  });
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  description?: string;
}

/** Horizontal slider: ←/→ step (Shift = ×5), mouse/touch drag on the track. */
export function slider(o: SliderOptions): Control<number> {
  const span = o.max - o.min;
  const snap = (v: number): number => {
    if (!Number.isFinite(v)) return o.min;
    const s = o.min + Math.round((v - o.min) / o.step) * o.step;
    const clamped = Math.min(o.max, Math.max(o.min, s));
    return Math.round(clamped * 1e6) / 1e6;
  };
  let value = snap(o.value);
  let disabled = false;
  const fill = h('span', { class: 'nvm-slider__fill' });
  const knob = h('span', { class: 'nvm-slider__knob' });
  const out = h('span', { class: 'nvm-slider__value' });
  const track = h('span', { class: 'nvm-slider__track' }, fill, knob);
  const render = (): void => {
    const t = span > 0 ? (value - o.min) / span : 0;
    const pct = `${(t * 100).toFixed(2)}%`;
    fill.style.setProperty('width', pct);
    knob.style.setProperty('left', pct);
    setText(out, o.format(value));
  };
  const commit = (v: number, sound: boolean): void => {
    const next = snap(v);
    if (next === value) return;
    value = next;
    render();
    if (sound) widgetSound('move');
    o.onChange(value);
  };
  const control = h('div', { class: 'nvm-slider', attrs: { tabindex: 0, role: 'slider', 'aria-valuemin': o.min, 'aria-valuemax': o.max } }, track, out);
  const fromPointer = (e: PointerEvent): void => {
    const r = track.getBoundingClientRect();
    if (r.width <= 0) return;
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    commit(o.min + t * span, false);
  };
  control.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return;
    control.focus({ preventScroll: true });
    control.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  control.addEventListener('pointermove', (e) => {
    if (control.hasPointerCapture(e.pointerId)) fromPointer(e);
  });
  const release = (e: PointerEvent): void => {
    if (control.hasPointerCapture(e.pointerId)) control.releasePointerCapture(e.pointerId);
  };
  control.addEventListener('pointerup', release);
  control.addEventListener('pointercancel', release);
  registerAdjuster(control, (dir, coarse) => {
    if (!disabled) commit(value + dir * o.step * (coarse ? 5 : 1), true);
  });
  render();
  const el = rowShell(o.label, o.description, control);
  return {
    el,
    focus: control,
    get: () => value,
    set: (v) => {
      value = snap(v);
      render();
    },
    setDisabled: (d) => {
      disabled = d;
      control.setAttribute('tabindex', d ? '-1' : '0');
      el.classList.toggle('is-disabled', d);
    },
  };
}

export interface TextOptions {
  label: string;
  value: string;
  maxLength: number;
  placeholder?: string;
  /** e.g. uppercase letters only */
  transform?: (v: string) => string;
  onInput: (v: string) => void;
  description?: string;
}

export function textField(o: TextOptions): Control<string> & { input: HTMLInputElement } {
  const input = h('input', {
    class: 'nvm-input',
    attrs: { type: 'text', maxlength: o.maxLength, placeholder: o.placeholder ?? '', spellcheck: 'false', autocomplete: 'off' },
  });
  input.value = o.value;
  input.addEventListener('input', () => {
    if (o.transform) {
      const t = o.transform(input.value).slice(0, o.maxLength);
      if (t !== input.value) input.value = t;
    }
    o.onInput(input.value);
  });
  const el = rowShell(o.label, o.description, input);
  return {
    el,
    focus: input,
    input,
    get: () => input.value,
    set: (v) => {
      input.value = v;
    },
    setDisabled: (d) => {
      input.disabled = d;
    },
  };
}

/** Curated swatches for livery / helmet editors. */
export const PALETTE: readonly string[] = [
  '#ff5a1f', '#e8322f', '#c8102e', '#ff7a1a', '#ffb020', '#ffd400', '#a6e22e', '#2fd27a',
  '#1f5e3b', '#12b5a6', '#19d3c5', '#7fd3ff', '#2f7fe8', '#1e3fae', '#0a1f44', '#5b2a86',
  '#b04dff', '#e0218a', '#ffb7c5', '#b0763b', '#f4f1e8', '#c0c6cc', '#3a3f47', '#111214',
];

/** Colour picker: ←/→ cycle the palette, click the swatch for any colour. */
export function colorPicker(label: string, value: string, onChange: (v: string) => void): Control<string> {
  let current = value;
  const native = h('input', { class: 'nvm-color__native', attrs: { type: 'color', tabindex: -1, 'aria-hidden': 'true' } });
  native.value = value;
  const chip = h('span', { class: 'nvm-color__chip' });
  const hex = h('span', { class: 'nvm-color__hex' });
  const render = (): void => {
    chip.style.setProperty('background', current);
    setText(hex, current.toUpperCase());
    native.value = current;
  };
  const apply = (v: string, sound: boolean): void => {
    if (!/^#[0-9a-f]{6}$/i.test(v) || v.toLowerCase() === current) return;
    current = v.toLowerCase();
    render();
    if (sound) widgetSound('move');
    onChange(current);
  };
  native.addEventListener('input', () => apply(native.value, false));
  const control = h(
    'button',
    { class: 'nvm-color', attrs: { type: 'button', 'data-sound': 'none' }, on: { click: () => native.click() } },
    h('span', { class: 'nvm-cycler__arrow', text: '◀' }),
    chip,
    hex,
    h('span', { class: 'nvm-cycler__arrow', text: '▶' }),
    native,
  );
  registerAdjuster(control, (dir) => {
    const i = PALETTE.indexOf(current);
    const next = i < 0 ? (dir > 0 ? 0 : PALETTE.length - 1) : (i + dir + PALETTE.length) % PALETTE.length;
    apply(PALETTE[next] ?? current, true);
  });
  render();
  const el = rowShell(label, undefined, control);
  return {
    el,
    focus: control,
    get: () => current,
    set: (v) => {
      if (/^#[0-9a-f]{6}$/i.test(v)) {
        current = v.toLowerCase();
        render();
      }
    },
    setDisabled: (d) => {
      control.disabled = d;
    },
  };
}

// ───────────────────────────── layout pieces ─────────────────────────────

export interface TabsControl {
  el: HTMLElement;
  setActive(id: string): void;
}

/** Tab bar; ←/→ on a focused tab switch tabs. */
export function tabs(items: readonly { id: string; label: string }[], active: string, onChange: (id: string) => void): TabsControl {
  const buttons = items.map((item) =>
    h('button', {
      class: 'nvm-tab',
      attrs: { type: 'button', 'data-sound': 'move', 'data-tab': item.id },
      text: item.label,
      on: { click: () => select(item.id) },
    }),
  );
  let current = active;
  const paint = (): void => buttons.forEach((b) => b.classList.toggle('is-active', b.dataset.tab === current));
  const select = (id: string): void => {
    if (id === current) return;
    current = id;
    paint();
    onChange(id);
  };
  paint();
  // ←/→ on a focused tab switch to the neighbouring tab (focus and the shown section stay together)
  buttons.forEach((b, i) =>
    registerAdjuster(b, (dir) => {
      const next = buttons[i + dir];
      const id = next?.dataset.tab;
      if (!next || !id) return;
      select(id);
      focusElement(next);
      widgetSound('move');
    }),
  );
  return {
    el: h('div', { class: 'nvm-tabs', attrs: { role: 'tablist' } }, buttons),
    setActive: (id) => {
      current = id;
      paint();
    },
  };
}

export function panel(title: string | null, ...children: (Child | Child[])[]): HTMLElement {
  return h('div', { class: 'nvm-panel' }, title ? h('h3', { class: 'nvm-panel__title', text: title }) : null, ...children);
}

/** Labelled 0..1 bar. */
export function statBar(label: string, value01: number, text?: string): HTMLElement {
  const v = Number.isFinite(value01) ? Math.min(1, Math.max(0, value01)) : 0;
  return h(
    'div',
    { class: 'nvm-stat' },
    h('span', { class: 'nvm-stat__label', text: label }),
    h('span', { class: 'nvm-stat__bar' }, h('i', { style: { width: `${(v * 100).toFixed(1)}%` } })),
    h('span', { class: 'nvm-stat__value', text: text ?? String(Math.round(v * 100)) }),
  );
}

/** Small key/value line. */
export function infoLine(label: string, value: string | HTMLElement): HTMLElement {
  return h('div', { class: 'nvm-info' }, h('span', { class: 'nvm-info__k', text: label }), typeof value === 'string' ? h('span', { class: 'nvm-info__v', text: value }) : value);
}

/** Team colour chip. */
export function teamChip(color: string): HTMLElement {
  return h('span', { class: 'nvm-chip', style: { '--chip': color } });
}

export function heading(title: string, kicker?: string): HTMLElement {
  return h('header', { class: 'nvm-heading' }, kicker ? h('span', { class: 'nvm-heading__kicker', text: kicker }) : null, h('h2', { class: 'nvm-heading__title', text: title }));
}

/**
 * Tabbed sections: one focusable column visible at a time (←/→ on the tab bar switches), so every control stays
 * reachable with the arrow keys even though ←/→ adjust values inside rows.
 */
export function tabbedSections(sections: readonly { id: string; label: string; el: HTMLElement }[]): HTMLElement {
  const body = h('div', { class: 'nvm-sections__body' });
  const show = (id: string): void => {
    const section = sections.find((s) => s.id === id) ?? sections[0];
    if (section) body.replaceChildren(section.el);
  };
  const bar = tabs(sections.map((s) => ({ id: s.id, label: s.label })), sections[0]?.id ?? '', show);
  show(sections[0]?.id ?? '');
  return h('div', { class: 'nvm-sections' }, bar.el, body);
}

/** Scrollable region reachable with the keyboard (↑/↓ scroll while focused). */
export function scrollRegion(...children: HTMLElement[]): HTMLElement {
  return h('div', { class: 'nvm-scroll', attrs: { tabindex: 0, 'data-scroll': '' } }, ...children);
}
