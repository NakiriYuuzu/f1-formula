/**
 * Pause menu: action items (with optional second-press confirmation for destructive ones) and cycle items
 * (camera, racing line). Keyboard: ↑/↓ select, ←/→ change value, Enter/Space confirm, Backspace cancels a
 * pending confirmation. Mouse: hover selects, click activates. Escape is left to the App's pause toggle; gamepad
 * navigation arrives through navigate() / activate().
 */
import { AttrSlot, TextSlot, el } from './dom';

export interface PauseAction {
  kind: 'action';
  id: string;
  label: string | (() => string);
  /** when set, the first activation asks for confirmation with this text */
  confirm?: string;
  run(): void;
}

export interface PauseCycle {
  kind: 'cycle';
  id: string;
  label: string;
  options: readonly { value: string; label: string }[];
  get(): string;
  set(value: string): void;
}

export type PauseItem = PauseAction | PauseCycle;

export type MenuDirection = 'up' | 'down' | 'left' | 'right';

interface ItemView {
  def: PauseItem;
  label: TextSlot;
  value: TextSlot | null;
  selected: AttrSlot;
  confirm: AttrSlot;
}

export class PauseMenu {
  readonly el: HTMLElement;
  private readonly subtitle: TextSlot;
  private readonly list: HTMLElement;
  private readonly hint: TextSlot;
  private items: ItemView[] = [];
  private index = 0;
  private pending: string | null = null;
  private visible = false;
  private suspended = false;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-pause nvh-hidden', parent);
    const card = el('div', 'nvh-pause-card', this.el);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '暫停選單');
    el('div', 'nvh-pause-title', card, '暫停');
    this.subtitle = new TextSlot(el('div', 'nvh-pause-sub', card));
    this.list = el('div', 'nvh-pause-list', card);
    this.list.setAttribute('role', 'menu');
    this.hint = new TextSlot(el('div', 'nvh-pause-hint', card));
    this.setResumeKeys(['Esc', 'P']);
  }

  /** Labels of the keyboard keys bound to 暫停 (they also resume); the gamepad B button always does. */
  setResumeKeys(labels: readonly string[]): void {
    this.hint.set(`↑↓ 選擇　←→ 調整　Enter／A 確認　${[...labels, 'B'].join('／')} 繼續`);
  }

  /** Shown and accepting input (not hidden behind the settings overlay). */
  isOpen(): boolean {
    return this.visible && !this.suspended;
  }

  isVisible(): boolean {
    return this.visible;
  }

  open(items: PauseItem[], subtitle: string): void {
    this.subtitle.set(subtitle);
    // Visible first: build() renders labels through refresh(), which skips hidden menus.
    this.visible = true;
    this.suspended = false;
    this.build(items);
    this.el.classList.remove('nvh-hidden');
  }

  close(): void {
    this.visible = false;
    this.suspended = false;
    this.pending = null;
    this.el.classList.add('nvh-hidden');
  }

  /** Hide while another overlay (settings) owns the screen; show again with suspend(false). */
  suspend(on: boolean): void {
    this.suspended = on;
    this.pending = null;
    this.el.classList.toggle('nvh-hidden', !this.visible || on);
    if (!on) this.refresh();
  }

  /** Re-read dynamic labels and cycle values. */
  refresh(): void {
    if (!this.visible) return;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const def = it.def;
      if (def.kind === 'cycle') {
        const cur = def.get();
        const opt = def.options.find((o) => o.value === cur);
        it.value?.set(opt ? opt.label : '');
      } else {
        it.label.set(this.pending === def.id && def.confirm ? def.confirm : labelOf(def));
      }
      it.selected.set(i === this.index ? '1' : null);
      it.confirm.set(this.pending === def.id ? '1' : null);
    }
  }

  navigate(dir: MenuDirection): void {
    if (!this.isOpen() || this.items.length === 0) return;
    if (dir === 'up' || dir === 'down') {
      const n = this.items.length;
      this.select((this.index + (dir === 'down' ? 1 : -1) + n) % n);
      return;
    }
    const def = this.items[this.index]?.def;
    if (def?.kind === 'cycle') this.cycleItem(def, dir === 'right' ? 1 : -1);
  }

  activate(): void {
    if (!this.isOpen()) return;
    const def = this.items[this.index]?.def;
    if (!def) return;
    if (def.kind === 'cycle') {
      this.cycleItem(def, 1);
      return;
    }
    if (def.confirm && this.pending !== def.id) {
      this.pending = def.id;
      this.refresh();
      return;
    }
    this.pending = null;
    // run() may close or destroy the HUD synchronously: nothing may follow it.
    def.run();
  }

  /** Keyboard handling while open; returns true if the key was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.isOpen()) return false;
    switch (e.code) {
      case 'ArrowUp':
        this.navigate('up');
        return true;
      case 'ArrowDown':
        this.navigate('down');
        return true;
      case 'ArrowLeft':
        this.navigate('left');
        return true;
      case 'ArrowRight':
        this.navigate('right');
        return true;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        if (!e.repeat) this.activate();
        return true;
      case 'Backspace':
        if (this.pending !== null) {
          this.pending = null;
          this.refresh();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  private build(defs: PauseItem[]): void {
    this.list.replaceChildren();
    this.items = defs.map((def, i) => {
      const node = el('div', 'nvh-pi', this.list);
      node.setAttribute('role', 'menuitem');
      node.dataset.kind = def.kind;
      const label = new TextSlot(el('span', 'nvh-pi-label', node));
      let value: TextSlot | null = null;
      if (def.kind === 'cycle') {
        label.set(def.label);
        const box = el('span', 'nvh-pi-value', node);
        const left = el('span', 'nvh-pi-arrow', box, '‹');
        value = new TextSlot(el('span', 'nvh-pi-cur', box));
        const right = el('span', 'nvh-pi-arrow', box, '›');
        left.addEventListener('click', (e) => {
          e.stopPropagation();
          this.select(i);
          this.cycleItem(def, -1);
        });
        right.addEventListener('click', (e) => {
          e.stopPropagation();
          this.select(i);
          this.cycleItem(def, 1);
        });
      }
      node.addEventListener('mouseenter', () => {
        if (this.isOpen() && this.index !== i) this.select(i);
      });
      node.addEventListener('click', (e) => {
        e.preventDefault();
        if (!this.isOpen()) return;
        this.index = i;
        this.activate();
      });
      return { def, label, value, selected: new AttrSlot(node, 'data-selected'), confirm: new AttrSlot(node, 'data-confirm') };
    });
    this.index = 0;
    this.pending = null;
    this.refresh();
  }

  private select(i: number): void {
    if (i === this.index) return;
    this.index = i;
    this.pending = null;
    this.refresh();
  }

  private cycleItem(def: PauseCycle, step: 1 | -1): void {
    const n = def.options.length;
    if (n === 0) return;
    const cur = def.options.findIndex((o) => o.value === def.get());
    const next = def.options[(((cur < 0 ? 0 : cur + step) % n) + n) % n];
    def.set(next.value);
    this.pending = null;
    this.refresh();
  }
}

function labelOf(def: PauseAction): string {
  return typeof def.label === 'function' ? def.label() : def.label;
}
