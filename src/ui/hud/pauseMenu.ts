/**
 * Pause menu: action items and cycle items (camera, racing line), every item a focusable <button>.
 * Keyboard: ↑/↓ select, ←/→ change a cycle value, Enter/Space activate, Backspace resumes. Escape is left to the
 * App's pause toggle (HudLayer.onPauseKey) and the gamepad arrives through navigate() / activate(); both of those
 * also resume. The selected item is also the focused one (white fill, dark text); mouse hover moves the selection.
 *
 * Destructive actions (`confirm` set: 重新開始, 退賽, 離開至選單, …) open a small confirm dialog inside the overlay
 * instead of arming a second press: a title, one sentence on the consequence, 取消 (focused by default) and a danger
 * button. While it is open ←/→ ↑/↓ move between the two buttons, Enter/Space/A activate, and Backspace / Escape /
 * gamepad B cancel it (closeConfirm()).
 */
import { AttrSlot, TextSlot, el } from './dom';

export interface PauseConfirm {
  title: string;
  /** one sentence on what happens */
  text: string;
  /** the danger button's label */
  ok: string;
}

export interface PauseAction {
  kind: 'action';
  id: string;
  label: string | (() => string);
  /** when set, activating opens a confirm dialog (取消 is the default) before run() */
  confirm?: PauseConfirm;
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

/** Window (ms) in which a click without a pointer (detail 0) after a key activation is the key's own echo. */
const KEY_ECHO_MS = 400;

interface ItemView {
  def: PauseItem;
  node: HTMLElement;
  label: TextSlot;
  value: TextSlot | null;
  selected: AttrSlot;
}

interface DialogView {
  box: HTMLElement;
  title: TextSlot;
  text: TextSlot;
  buttons: [HTMLElement, HTMLElement];
  ok: TextSlot;
  selected: [AttrSlot, AttrSlot];
}

export class PauseMenu {
  readonly el: HTMLElement;
  private readonly subtitle: TextSlot;
  private readonly list: HTMLElement;
  private readonly hint: TextSlot;
  private readonly dialog: DialogView;
  private items: ItemView[] = [];
  private index = 0;
  /** the action whose confirm dialog is open */
  private pending: PauseAction | null = null;
  /** 0 = 取消, 1 = the danger button */
  private dialogIndex = 0;
  private visible = false;
  private suspended = false;
  private lastKeyActivate = -Infinity;

  constructor(
    parent: Element,
    /** Backspace with nothing to cancel: resume the game */
    private readonly onBack: () => void = () => undefined,
  ) {
    this.el = el('div', 'nvh-pause nvh-hidden', parent);
    const card = el('div', 'nvh-pause-card', this.el);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '暫停選單');
    el('div', 'nvh-pause-title', card, '暫停');
    this.subtitle = new TextSlot(el('div', 'nvh-pause-sub', card));
    this.list = el('div', 'nvh-pause-list', card);
    this.hint = new TextSlot(el('div', 'nvh-pause-hint', card));
    this.dialog = this.buildDialog();
    this.setResumeKeys(['Esc', 'P']);
  }

  /** Labels of the keyboard keys bound to 暫停 (they also resume); the gamepad B button always does. */
  setResumeKeys(labels: readonly string[]): void {
    this.hint.set(`↑↓ 選擇　←→ 調整　Enter／A 確認　${[...labels, 'Backspace', 'B'].join('／')} 繼續`);
  }

  /** Shown and accepting input (not hidden behind the settings overlay). */
  isOpen(): boolean {
    return this.visible && !this.suspended;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** A confirm dialog is up (the pause key / B then cancel it instead of resuming). */
  isConfirming(): boolean {
    return this.pending !== null;
  }

  open(items: PauseItem[], subtitle: string): void {
    this.subtitle.set(subtitle);
    // Visible first: build() renders labels through refresh(), which skips hidden menus.
    this.visible = true;
    this.suspended = false;
    this.build(items);
    this.el.classList.remove('nvh-hidden');
    this.syncFocus();
  }

  close(): void {
    this.visible = false;
    this.suspended = false;
    this.hideDialog();
    this.el.classList.add('nvh-hidden');
  }

  /** Hide while another overlay (settings) owns the screen; show again with suspend(false). */
  suspend(on: boolean): void {
    this.suspended = on;
    this.hideDialog();
    this.el.classList.toggle('nvh-hidden', !this.visible || on);
    if (!on) {
      this.refresh();
      this.syncFocus();
    }
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
        it.label.set(labelOf(def));
      }
      it.selected.set(i === this.index ? '1' : null);
    }
  }

  navigate(dir: MenuDirection): void {
    if (!this.isOpen()) return;
    if (this.pending) {
      this.moveDialog(dir === 'up' || dir === 'left' ? 0 : 1);
      return;
    }
    if (this.items.length === 0) return;
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
    if (this.pending) {
      this.activateDialog(this.dialogIndex);
      return;
    }
    const def = this.items[this.index]?.def;
    if (!def) return;
    if (def.kind === 'cycle') {
      this.cycleItem(def, 1);
      return;
    }
    if (def.confirm) {
      this.showDialog(def);
      return;
    }
    // run() may close or destroy the HUD synchronously: nothing may follow it.
    def.run();
  }

  /** Cancel an open confirm dialog; false when none was open. */
  closeConfirm(): boolean {
    if (!this.pending) return false;
    this.hideDialog();
    this.syncFocus();
    return true;
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
        if (!e.repeat) {
          this.lastKeyActivate = Date.now();
          this.activate();
        }
        return true;
      case 'Backspace':
        if (!e.repeat && !this.closeConfirm()) this.onBack();
        return true;
      default:
        return false;
    }
  }

  private build(defs: PauseItem[]): void {
    this.hideDialog();
    this.list.replaceChildren();
    this.items = defs.map((def, i) => {
      const node = el('button', 'nvh-pi', this.list);
      node.type = 'button';
      node.dataset.kind = def.kind;
      if (def.kind === 'action' && def.confirm) node.dataset.danger = '1';
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
        if (this.isOpen() && !this.pending && this.index !== i) this.select(i);
      });
      node.addEventListener('focus', () => {
        if (this.isOpen() && !this.pending && this.index !== i) this.select(i);
      });
      node.addEventListener('click', (e) => {
        e.preventDefault();
        if (!this.isOpen() || this.pending || this.isKeyEcho(e)) return;
        this.index = i;
        this.activate();
      });
      return { def, node, label, value, selected: new AttrSlot(node, 'data-selected') };
    });
    this.index = 0;
    this.refresh();
  }

  private select(i: number): void {
    if (i === this.index) return;
    this.index = i;
    this.refresh();
    this.syncFocus();
  }

  private cycleItem(def: PauseCycle, step: 1 | -1): void {
    const n = def.options.length;
    if (n === 0) return;
    const cur = def.options.findIndex((o) => o.value === def.get());
    const next = def.options[(((cur < 0 ? 0 : cur + step) % n) + n) % n];
    def.set(next.value);
    this.refresh();
  }

  // ───────────── confirm dialog ─────────────

  private buildDialog(): DialogView {
    const back = el('div', 'nvh-confirm nvh-hidden', this.el);
    const box = el('div', 'nvh-confirm-box', back);
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const title = new TextSlot(el('div', 'nvh-confirm-title', box));
    const text = new TextSlot(el('div', 'nvh-confirm-text', box));
    const row = el('div', 'nvh-confirm-btns', box);
    const cancel = el('button', 'nvh-cbtn', row, '取消');
    cancel.type = 'button';
    const okNode = el('button', 'nvh-cbtn', row);
    okNode.type = 'button';
    okNode.dataset.danger = '1';
    const buttons: [HTMLElement, HTMLElement] = [cancel, okNode];
    const selected: [AttrSlot, AttrSlot] = [new AttrSlot(cancel, 'data-selected'), new AttrSlot(okNode, 'data-selected')];
    buttons.forEach((b, i) => {
      b.addEventListener('mouseenter', () => {
        if (this.pending) this.moveDialog(i === 0 ? 0 : 1);
      });
      // Tab / Shift+Tab move the focus without handleKey: Enter must then act on the focused button
      b.addEventListener('focus', () => {
        if (this.pending && this.dialogIndex !== i) this.moveDialog(i === 0 ? 0 : 1);
      });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        if (!this.isOpen() || !this.pending || this.isKeyEcho(e)) return;
        this.activateDialog(i);
      });
    });
    // clicking the dimmed area outside the box cancels
    back.addEventListener('click', (e) => {
      if (e.target === back && this.pending) this.closeConfirm();
    });
    return { box: back, title, text, buttons, ok: new TextSlot(okNode), selected };
  }

  private showDialog(def: PauseAction): void {
    const c = def.confirm;
    if (!c) return;
    this.pending = def;
    this.dialog.title.set(c.title);
    this.dialog.text.set(c.text);
    this.dialog.ok.set(c.ok);
    this.dialog.box.classList.remove('nvh-hidden');
    // the pause list is out of reach (focus, Tab, pointer) while the dialog is up
    this.list.setAttribute('inert', '');
    this.moveDialog(0);
  }

  private hideDialog(): void {
    this.pending = null;
    this.dialogIndex = 0;
    this.dialog.box.classList.add('nvh-hidden');
    this.list.removeAttribute('inert');
  }

  private moveDialog(i: 0 | 1): void {
    this.dialogIndex = i;
    this.dialog.selected[0].set(i === 0 ? '1' : null);
    this.dialog.selected[1].set(i === 1 ? '1' : null);
    this.syncFocus();
  }

  private activateDialog(i: number): void {
    const def = this.pending;
    if (i === 0 || !def) {
      this.closeConfirm();
      return;
    }
    this.hideDialog();
    // run() may close or destroy the HUD synchronously: nothing may follow it.
    def.run();
  }

  // ───────────── focus ─────────────

  /** The selected item (or the dialog's selected button) holds DOM focus, which is what the CSS inverts. */
  private syncFocus(): void {
    if (!this.isOpen()) return;
    const node = this.pending ? this.dialog.buttons[this.dialogIndex] : this.items[this.index]?.node;
    if (node && typeof node.focus === 'function') node.focus({ preventScroll: true });
  }

  /** A click that a key press just produced itself (Space keyup on a freshly focused button). */
  private isKeyEcho(e: MouseEvent): boolean {
    return e.detail === 0 && Date.now() - this.lastKeyActivate < KEY_ECHO_MS;
  }
}

function labelOf(def: PauseAction): string {
  return typeof def.label === 'function' ? def.label() : def.label;
}
