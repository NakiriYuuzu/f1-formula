/**
 * Device geometry, the rotate overlay and fullscreen support. DeviceWatcher is the only writer of html[data-device],
 * html[data-rotate] and html[data-fullscreen]; CSS keys off those attributes, never off repeated media queries.
 */

import type { DeviceForm } from '../core/types';

export type { DeviceForm };

/**
 * The only place these media queries are written. Every one is gated on a coarse primary pointer, so a small desktop
 * window never becomes a phone. A portrait phone is a narrow screen, not a narrow window: an iPad in Slide Over or
 * one-third Split View has a phone-wide portrait window that turning the iPad never widens, on a screen 744px or wider.
 */
export const DEVICE_QUERIES = {
  coarse: '(pointer: coarse)',
  phoneLandscape: '(pointer: coarse) and (orientation: landscape) and (max-height: 500px)',
  phonePortrait: '(pointer: coarse) and (orientation: portrait) and (max-width: 599px) and (max-device-width: 599px)',
} as const;

export type MediaMatch = (query: string) => boolean;

export function deviceForm(match: MediaMatch): DeviceForm {
  if (match(DEVICE_QUERIES.phoneLandscape) || match(DEVICE_QUERIES.phonePortrait)) return 'phone';
  return match(DEVICE_QUERIES.coarse) ? 'tablet' : 'desktop';
}

/** Portrait phone: the 「請將手機轉為橫向」 overlay covers everything and the App auto-pauses. Tablets never. */
export function needsRotate(match: MediaMatch): boolean {
  return match(DEVICE_QUERIES.phonePortrait);
}

export interface FullscreenApi {
  active(): boolean;
  enter(): Promise<void>;
  exit(): Promise<void>;
}

interface WebkitFullscreenDocument {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface WebkitFullscreenElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/**
 * Standard API, else the webkit-prefixed one (iPad Safari), else null (iPhone Safari: no element fullscreen; the way
 * to lose the browser chrome there is 加入主畫面, which launches the manifest's standalone display).
 */
export function fullscreenApi(doc: Document): FullscreenApi | null {
  const el = doc.documentElement;
  // `fullscreenEnabled === false` means the method exists but always refuses (iPhone Safari, a frame without allowfullscreen)
  if (typeof el.requestFullscreen === 'function' && doc.fullscreenEnabled !== false) {
    return {
      active: () => doc.fullscreenElement != null,
      enter: () => el.requestFullscreen(),
      exit: () => doc.exitFullscreen(),
    };
  }
  const wdoc = doc as Document & WebkitFullscreenDocument;
  const wel = el as HTMLElement & WebkitFullscreenElement;
  if (typeof wel.webkitRequestFullscreen === 'function' && wdoc.webkitFullscreenEnabled !== false) {
    // older WebKit returns undefined instead of a promise
    return {
      active: () => wdoc.webkitFullscreenElement != null,
      enter: async () => {
        await wel.webkitRequestFullscreen?.();
      },
      exit: async () => {
        await wdoc.webkitExitFullscreen?.();
      },
    };
  }
  return null;
}

/** Launched from the home screen (no browser chrome): no 加入主畫面 tip. */
export function isStandalone(win: Window): boolean {
  return (
    win.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches ||
    (win.navigator as { standalone?: boolean }).standalone === true
  );
}

export const ROTATE_TEXT = '請將手機轉為橫向';

/**
 * Created in main.ts before the App, so the first paint already has the attributes. Owns the .nv-rotate element
 * (styled in app.css) and keeps the attributes current through matchMedia 'change' listeners. A desktop gets
 * data-device="desktop" and nothing else: no data-fullscreen, never data-rotate, no overlay element.
 */
export class DeviceWatcher {
  private readonly doc: Document;
  private readonly lists = new Map<string, MediaQueryList>();
  private readonly hasFullscreen: boolean;
  private readonly rotateFns = new Set<(blocked: boolean) => void>();
  private overlay: HTMLElement | null = null;
  private current: DeviceForm = 'desktop';
  private blocked = false;

  constructor(win: Window) {
    this.doc = win.document;
    this.hasFullscreen = fullscreenApi(this.doc) !== null;
    for (const q of Object.values(DEVICE_QUERIES)) {
      const list = win.matchMedia(q);
      list.addEventListener('change', this.sync);
      this.lists.set(q, list);
    }
    this.sync();
  }

  get form(): DeviceForm {
    return this.current;
  }

  /** A phone held in portrait: the overlay is up. */
  get rotate(): boolean {
    return this.blocked;
  }

  /** Fires on each change, not for the state at subscription. Returns the unsubscribe. */
  onRotate(fn: (blocked: boolean) => void): () => void {
    this.rotateFns.add(fn);
    return () => this.rotateFns.delete(fn);
  }

  destroy(): void {
    for (const list of this.lists.values()) list.removeEventListener('change', this.sync);
    this.lists.clear();
    this.rotateFns.clear();
    this.overlay?.remove();
    this.overlay = null;
  }

  private readonly sync = (): void => {
    const match: MediaMatch = (q) => this.lists.get(q)?.matches === true;
    const form = deviceForm(match);
    const rotate = needsRotate(match);
    const data = this.doc.documentElement.dataset;
    data.device = form;
    if (form === 'desktop') delete data.fullscreen;
    else data.fullscreen = this.hasFullscreen ? 'api' : 'none';
    if (rotate) {
      data.rotate = '';
      this.ensureOverlay();
    } else {
      delete data.rotate;
    }
    this.current = form;
    if (rotate === this.blocked) return;
    this.blocked = rotate;
    for (const fn of this.rotateFns) fn(rotate);
  };

  private ensureOverlay(): void {
    if (this.overlay) return;
    const el = this.doc.createElement('div');
    el.className = 'nv-rotate';
    el.setAttribute('role', 'alert');
    el.textContent = ROTATE_TEXT;
    this.doc.body.append(el);
    this.overlay = el;
  }
}
