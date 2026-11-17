/**
 * First-sessions hint strip (bottom of a view): the essential keys for ~12 s after the session start, fading out at
 * the end. Click / tap dismisses it. Timing is driven by update(dt), so it freezes while the game is paused.
 */
import { ShowSlot, el, setModeText } from './dom';
import type { HelpRow } from './controls';

/** Seconds of the fade-out at the end of the display time. */
const HINT_FADE = 0.6;

/** The strip's rows per input mode (like ModeText): key rows show for keyboard and gamepad, touch rows on touch. */
export interface HintItems {
  keys: readonly HelpRow[];
  touch?: readonly HelpRow[];
}

export class HintStrip {
  readonly el: HTMLElement;
  private readonly items: HTMLElement;
  private readonly show: ShowSlot;
  private remaining = 0;
  private fading = false;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-hint', parent);
    this.el.title = '點一下關閉';
    this.el.addEventListener('click', (e) => {
      e.preventDefault();
      this.dismiss();
    });
    const head = el('div', 'nvh-hint-head', this.el);
    el('span', 'nvh-hint-title', head, '操作提示');
    setModeText(el('span', 'nvh-hint-more', head), { keys: '完整按鍵：暫停選單 → 操作說明', touch: '完整操作：暫停 → 操作說明' });
    el('span', 'nvh-hint-close', head, '×');
    this.items = el('div', 'nvh-hint-items', this.el);
    this.show = new ShowSlot(this.el);
    this.show.set(false);
  }

  isShowing(): boolean {
    return this.remaining > 0;
  }

  start(items: HintItems, duration: number): void {
    this.setItems(items);
    this.remaining = Math.max(HINT_FADE, duration);
    this.fading = false;
    this.el.classList.remove('is-out');
    this.show.set(true);
  }

  /** Replace the listed keys (e.g. bindings changed in the settings overlay while shown). */
  setItems(items: HintItems): void {
    this.items.replaceChildren();
    this.addItems(items.keys, 'keyboard gamepad');
    if (items.touch) this.addItems(items.touch, 'touch');
  }

  private addItems(items: readonly HelpRow[], showFor: string): void {
    for (const item of items) {
      if (item.keys.length === 0) continue;
      const node = el('div', 'nvh-hint-item', this.items);
      node.dataset.showFor = showFor;
      el('span', 'nvh-hint-label', node, item.label);
      for (const k of item.keys) el('kbd', 'nvh-key', node, k);
    }
  }

  dismiss(): void {
    this.remaining = 0;
    this.show.set(false);
  }

  update(dt: number): void {
    if (this.remaining <= 0) return;
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.dismiss();
      return;
    }
    if (!this.fading && this.remaining <= HINT_FADE) {
      this.fading = true;
      this.el.classList.add('is-out');
    }
  }
}
