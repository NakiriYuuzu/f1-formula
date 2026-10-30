/**
 * Transient HUD feeds: toast notifications, team-radio subtitles and centre banners.
 * All timing is driven by update(dt) (no timers), so they freeze while the App stops updating and leave
 * nothing behind on destroy.
 */
import { clamp } from '../../core/math';
import { el } from './dom';

export type Tone = 'info' | 'good' | 'warn' | 'bad' | 'purple' | 'flag';

const EXIT_TIME = 0.32;
const MAX_TOASTS = 4;

interface Toast {
  node: HTMLElement;
  age: number;
  duration: number;
  leaving: boolean;
}

/** Stack of short notifications (newest on top). */
export class ToastStack {
  readonly el: HTMLElement;
  private readonly toasts: Toast[] = [];

  constructor(parent: Element) {
    this.el = el('div', 'nvh-toasts', parent);
    this.el.setAttribute('aria-live', 'polite');
  }

  push(title: string, sub: string, tone: Tone, duration = 3.6): void {
    const node = el('div', 'nvh-toast');
    node.dataset.tone = tone;
    el('div', 'nvh-toast-title', node, title);
    if (sub) el('div', 'nvh-toast-sub', node, sub);
    this.el.prepend(node);
    this.toasts.unshift({ node, age: 0, duration: Math.max(0.5, duration), leaving: false });
    let active = 0;
    for (const t of this.toasts) {
      if (t.leaving) continue;
      active++;
      if (active > MAX_TOASTS) this.leave(t);
    }
  }

  update(dt: number): void {
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.age += dt;
      if (!t.leaving && t.age >= t.duration) this.leave(t);
      if (t.leaving && t.age >= t.duration + EXIT_TIME) {
        t.node.remove();
        this.toasts.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const t of this.toasts) t.node.remove();
    this.toasts.length = 0;
  }

  private leave(t: Toast): void {
    t.leaving = true;
    t.age = Math.max(t.age, t.duration);
    t.node.classList.add('is-out');
  }
}

interface RadioMsg {
  text: string;
  color: string;
}

/** Team radio subtitle panel with a small queue. */
export class RadioPanel {
  readonly el: HTMLElement;
  private readonly text: HTMLElement;
  private readonly queue: RadioMsg[] = [];
  private remaining = 0;
  private showing = false;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-radio nvh-hidden', parent);
    const head = el('div', 'nvh-radio-head', this.el);
    el('span', 'nvh-radio-wave', head);
    el('span', 'nvh-radio-who', head, '車隊無線電');
    this.text = el('div', 'nvh-radio-text', this.el);
  }

  push(text: string, color: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (this.queue.length >= 4) this.queue.shift();
    this.queue.push({ text: clean, color });
    if (!this.showing) this.next();
  }

  update(dt: number): void {
    if (!this.showing) return;
    this.remaining -= dt;
    if (this.remaining <= 0) this.next();
  }

  clear(): void {
    this.queue.length = 0;
    this.showing = false;
    this.remaining = 0;
    this.el.classList.add('nvh-hidden');
  }

  private next(): void {
    const msg = this.queue.shift();
    if (!msg) {
      this.showing = false;
      this.el.classList.add('nvh-hidden');
      return;
    }
    this.showing = true;
    this.remaining = clamp(2.6 + msg.text.length * 0.11, 3.5, 9);
    this.text.textContent = msg.text;
    this.el.style.setProperty('--nvh-team', msg.color);
    this.el.classList.remove('nvh-hidden');
    // Restart the entry animation for consecutive messages.
    this.el.classList.remove('is-in');
    void this.el.offsetWidth;
    this.el.classList.add('is-in');
  }
}

/** Large centred banner (phase changes, finish, retirement). One at a time; same key is not repeated. */
export class Banner {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private remaining = 0;
  private key = '';
  private sinceKey = Infinity;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-banner nvh-hidden', parent);
    this.title = el('div', 'nvh-banner-title', this.el);
    this.sub = el('div', 'nvh-banner-sub', this.el);
  }

  show(key: string, title: string, sub: string, tone: Tone, duration = 3.2): void {
    if (key === this.key && this.sinceKey < 6) return;
    this.key = key;
    this.sinceKey = 0;
    this.remaining = Math.max(0.5, duration);
    this.title.textContent = title;
    this.sub.textContent = sub;
    this.sub.classList.toggle('nvh-hidden', !sub);
    this.el.dataset.tone = tone;
    this.el.classList.remove('nvh-hidden', 'is-in');
    void this.el.offsetWidth;
    this.el.classList.add('is-in');
  }

  /** True while the banner with this key is on screen. */
  isShowing(key: string): boolean {
    return this.key === key && this.remaining > 0;
  }

  update(dt: number): void {
    this.sinceKey += dt;
    if (this.remaining <= 0) return;
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.el.classList.add('nvh-hidden');
      this.el.classList.remove('is-in');
    }
  }

  /** Hide it; the next show() appears even with the same key (e.g. the same retirement again after a flashback). */
  clear(): void {
    this.remaining = 0;
    this.key = '';
    this.sinceKey = Infinity;
    this.el.classList.add('nvh-hidden');
  }
}
