/**
 * Replay control bar: play/pause, draggable scrubber, time readout, playback speed (0.25×–4×), camera switch and
 * exit. Keyboard while visible: Space play/pause, ←/→ seek ∓5 s, ↑/↓ faster/slower; gamepad: A play/pause, D-pad the same.
 */
import { clamp01 } from '../../core/math';
import type { PadMenuInput } from '../../input/gamepad';
import { AttrSlot, ScaleSlot, StyleSlot, TextSlot, clickable, el, svgEl } from './dom';
import { REPLAY_SPEEDS, fin, formatClock } from './labels';

export interface ReplayHandlers {
  toggle(): void;
  seek(t: number): void;
  speed(x: number): void;
  camera(): void;
  exit(): void;
}

export interface ReplayInfo {
  time: number;
  duration: number;
  playing: boolean;
  speed: number;
}

const SEEK_STEP = 5;

export class ReplayBar {
  readonly el: HTMLElement;
  private handlers: ReplayHandlers | null = null;
  private readonly playing: AttrSlot;
  private readonly time: TextSlot;
  private readonly fill: ScaleSlot;
  private readonly knob: StyleSlot;
  private readonly track: HTMLElement;
  private readonly speeds: { value: number; active: AttrSlot }[] = [];
  private info: ReplayInfo | null = null;
  private dragging = false;
  private dragPointer = -1;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-replay nvh-panel nvh-hidden', parent);

    const badge = el('div', 'nvh-rp-badge', this.el);
    el('span', 'nvh-rp-dot', badge);
    el('span', '', badge, '重播');

    const play = clickable('nvh-rp-play', this.el, '', () => this.handlers?.toggle());
    play.title = '播放 / 暫停（Space）';
    this.playing = new AttrSlot(play, 'data-playing');
    const icon = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, play);
    svgEl('path', { d: 'M8 5.5v13l10.5-6.5z', class: 'nvh-rp-ico-play' }, icon);
    svgEl('path', { d: 'M7 5.5h3.6v13H7zM13.4 5.5H17v13h-3.6z', class: 'nvh-rp-ico-pause' }, icon);

    this.time = new TextSlot(el('div', 'nvh-rp-time', this.el));

    const scrub = el('div', 'nvh-rp-scrub', this.el);
    this.track = el('div', 'nvh-rp-track', scrub);
    this.fill = new ScaleSlot(el('div', 'nvh-rp-fill', this.track), 'x');
    const knobWrap = el('div', 'nvh-rp-knobwrap', this.track);
    el('div', 'nvh-rp-knob', knobWrap);
    this.knob = new StyleSlot(knobWrap, 'transform');
    scrub.addEventListener('pointerdown', this.onPointerDown);
    scrub.addEventListener('pointermove', this.onPointerMove);
    scrub.addEventListener('pointerup', this.onPointerUp);
    scrub.addEventListener('pointercancel', this.onPointerUp);

    const speeds = el('div', 'nvh-rp-speeds', this.el);
    for (const value of REPLAY_SPEEDS) {
      const b = clickable('nvh-rp-speed', speeds, `${value}×`, () => this.handlers?.speed(value));
      this.speeds.push({ value, active: new AttrSlot(b, 'data-active') });
    }

    const cam = clickable('nvh-rp-btn', this.el, '切換鏡頭', () => this.handlers?.camera());
    cam.dataset.k = 'camera';
    const exit = clickable('nvh-rp-btn', this.el, '離開重播', () => this.handlers?.exit());
    exit.dataset.k = 'exit';
  }

  setHandlers(h: ReplayHandlers | null): void {
    this.handlers = h;
    this.el.classList.toggle('is-inert', h === null);
  }

  update(info: ReplayInfo | null): void {
    this.info = info;
    if (!info) {
      this.el.classList.add('nvh-hidden');
      this.dragging = false;
      return;
    }
    this.el.classList.remove('nvh-hidden');
    const duration = Math.max(0, fin(info.duration));
    const time = Math.min(duration, Math.max(0, fin(info.time)));
    this.playing.set(info.playing ? '1' : null);
    this.time.set(`${formatClock(time)} / ${formatClock(duration)}`);
    if (!this.dragging) this.setProgress(duration > 0 ? time / duration : 0);
    for (const s of this.speeds) s.active.set(Math.abs(s.value - fin(info.speed, 1)) < 1e-3 ? '1' : null);
  }

  /** Keyboard while the bar is visible; returns true if consumed. */
  handleKey(e: KeyboardEvent): boolean {
    const info = this.info;
    const h = this.handlers;
    if (!info || !h) return false;
    switch (e.code) {
      case 'Space':
        if (!e.repeat) h.toggle();
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
        this.seekBy(e.code === 'ArrowLeft' ? -1 : 1);
        return true;
      case 'ArrowUp':
      case 'ArrowDown':
        if (!e.repeat) this.stepSpeed(e.code === 'ArrowUp' ? 1 : -1);
        return true;
      default:
        return false;
    }
  }

  /** Gamepad while the bar is visible: A play/pause, D-pad left/right seek, up/down speed. True if consumed. */
  handlePad(input: PadMenuInput): boolean {
    if (!this.info || !this.handlers) return false;
    switch (input) {
      case 'confirm':
        this.handlers.toggle();
        return true;
      case 'left':
      case 'right':
        this.seekBy(input === 'left' ? -1 : 1);
        return true;
      case 'up':
      case 'down':
        this.stepSpeed(input === 'up' ? 1 : -1);
        return true;
      default:
        return false;
    }
  }

  private seekBy(dir: -1 | 1): void {
    const info = this.info;
    const duration = info ? fin(info.duration) : 0;
    if (!info || !this.handlers || !(duration > 0)) return;
    this.handlers.seek(clamp01((fin(info.time) + dir * SEEK_STEP) / duration));
  }

  private stepSpeed(dir: -1 | 1): void {
    const info = this.info;
    if (!info || !this.handlers) return;
    const cur = fin(info.speed, 1);
    let idx = 0;
    for (let i = 0; i < REPLAY_SPEEDS.length; i++) {
      if (Math.abs(REPLAY_SPEEDS[i] - cur) < Math.abs(REPLAY_SPEEDS[idx] - cur)) idx = i;
    }
    this.handlers.speed(REPLAY_SPEEDS[Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, idx + dir))]);
  }

  private setProgress(frac: number): void {
    const f = clamp01(fin(frac));
    this.fill.set(f);
    this.knob.set(`translateX(${(f * 100).toFixed(2)}%)`);
  }

  private seekFrom(e: PointerEvent): void {
    const rect = this.track.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const frac = clamp01((e.clientX - rect.left) / rect.width);
    this.setProgress(frac);
    this.handlers?.seek(frac);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.handlers || !this.info || e.button !== 0) return;
    e.preventDefault();
    this.dragging = true;
    this.dragPointer = e.pointerId;
    const target = e.currentTarget;
    if (target instanceof Element && typeof target.setPointerCapture === 'function') {
      target.setPointerCapture(e.pointerId);
    }
    this.seekFrom(e);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.dragPointer) return;
    this.seekFrom(e);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.dragPointer) return;
    this.dragging = false;
    this.dragPointer = -1;
    const target = e.currentTarget;
    if (target instanceof Element && target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
  };
}
