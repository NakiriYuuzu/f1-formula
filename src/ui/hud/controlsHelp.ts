/**
 * 操作說明 panel (opened from the pause menu): one page per input device (keyboard P1 / P2, gamepad) listing the
 * current bindings. ←/→ (D-pad) switch pages, ↑/↓ scroll, Enter / A / 返回 close; the back keys (Esc / B) arrive
 * through HudLayer.handleBack(). Mouse: tabs and 返回 are clickable, the body scrolls with the wheel.
 */
import { AttrSlot, TextSlot, clickable, el } from './dom';
import type { HelpPage } from './controls';
import type { MenuDirection } from './pauseMenu';

/** Fraction of the visible body height scrolled per ↑/↓ press. */
const SCROLL_STEP = 0.3;

export class ControlsHelp {
  readonly el: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly body: HTMLElement;
  private readonly note: TextSlot;
  private readonly hint: TextSlot;
  private tabSlots: AttrSlot[] = [];
  private pages: HelpPage[] = [];
  private page = 0;
  private visible = false;

  constructor(
    parent: Element,
    private readonly onClose: () => void,
  ) {
    this.el = el('div', 'nvh-help nvh-hidden', parent);
    const card = el('div', 'nvh-help-card', this.el);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '操作說明');
    const head = el('div', 'nvh-help-head', card);
    el('div', 'nvh-help-title', head, '操作說明');
    clickable('nvh-help-close', head, '返回', () => this.onClose());
    this.tabs = el('div', 'nvh-help-tabs', card);
    this.tabs.setAttribute('role', 'tablist');
    this.body = el('div', 'nvh-help-body', card);
    this.note = new TextSlot(el('div', 'nvh-help-note', card));
    this.hint = new TextSlot(el('div', 'nvh-help-hint', card));
    this.setBackKeys(['Esc']);
  }

  /** Labels of the keyboard keys that close the panel through the App's pause key (plus Enter and pad B). */
  setBackKeys(labels: readonly string[]): void {
    this.hint.set(`←→ 切換頁面　↑↓ 捲動　${['Enter', ...labels, 'B'].join('／')} 返回`);
  }

  isOpen(): boolean {
    return this.visible;
  }

  open(pages: HelpPage[]): void {
    this.pages = pages;
    this.visible = true;
    this.page = 0;
    this.tabs.replaceChildren();
    this.tabSlots = pages.map((p, i) => {
      const tab = clickable('nvh-help-tab', this.tabs, p.title, () => this.showPage(i));
      tab.setAttribute('role', 'tab');
      return new AttrSlot(tab, 'data-active');
    });
    this.showPage(0);
    this.el.classList.remove('nvh-hidden');
  }

  close(): void {
    this.visible = false;
    this.el.classList.add('nvh-hidden');
  }

  navigate(dir: MenuDirection): void {
    if (!this.visible) return;
    const n = this.pages.length;
    if (dir === 'left' || dir === 'right') {
      if (n > 1) this.showPage((this.page + (dir === 'right' ? 1 : -1) + n) % n);
      return;
    }
    const step = Math.max(24, this.body.clientHeight * SCROLL_STEP);
    this.body.scrollTop += dir === 'down' ? step : -step;
  }

  /** Arrow / page keys while open; returns true if consumed (closing keys are handled by HudLayer). */
  handleKey(code: string): boolean {
    if (!this.visible) return false;
    switch (code) {
      case 'ArrowLeft':
        this.navigate('left');
        return true;
      case 'ArrowRight':
        this.navigate('right');
        return true;
      case 'ArrowUp':
        this.navigate('up');
        return true;
      case 'ArrowDown':
        this.navigate('down');
        return true;
      default:
        return false;
    }
  }

  private showPage(i: number): void {
    const page = this.pages[i];
    if (!page) return;
    this.page = i;
    this.tabSlots.forEach((slot, k) => slot.set(k === i ? '1' : null));
    this.body.replaceChildren();
    for (const section of page.sections) {
      const box = el('div', 'nvh-help-sec', this.body);
      el('div', 'nvh-help-sec-title', box, section.title);
      for (const row of section.rows) {
        const line = el('div', 'nvh-help-row', box);
        el('span', 'nvh-help-label', line, row.label);
        const keys = el('span', 'nvh-help-keys', line);
        if (row.keys.length === 0) el('span', 'nvh-help-none', keys, '未設定');
        for (const k of row.keys) el('kbd', 'nvh-key', keys, k);
      }
    }
    this.body.scrollTop = 0;
    this.note.set(page.note);
  }
}
