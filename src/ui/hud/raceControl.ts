/**
 * Race-control HUD: pure label / classification helpers (unit-tested), the top-centre status strip
 * (SC / VSC / red flag / formation lap / green flag) and the per-player flag pills (blue flag, VSC delta,
 * give-back countdown, safety-car queue). Everything reads world.session.control / car.flags defensively:
 * a world without them (old tests, fake worlds) behaves like 'green' with no flags.
 */
import type { CarEntry, CarFlagState, RaceControlMode, RaceControlState, WorldState } from '../../core/types';
import { AttrSlot, ShowSlot, TextSlot, el, svgEl } from './dom';
import { fin, formatSeconds } from './labels';

/** How long the green flag stays up after a neutralisation ends (s). */
export const GREEN_FLAG_SECONDS = 3;
/** VSC delta (s) from which the readout turns green; 0..this is amber, below 0 red. */
export const VSC_DELTA_OK = 0.3;

export type StripTone = 'yellow' | 'red' | 'green' | 'formation';

export interface StripSpec {
  tone: StripTone;
  title: string;
  sub: string;
}

const NEUTRAL: readonly RaceControlMode[] = ['sc', 'scEnding', 'vsc', 'vscEnding', 'red'];

export const isNeutralMode = (mode: RaceControlMode): boolean => NEUTRAL.includes(mode);

/** world.session.control or null when the world has none. */
export function controlOf(world: WorldState): RaceControlState | null {
  const c = (world.session as { control?: RaceControlState } | undefined)?.control;
  return c && typeof c === 'object' ? c : null;
}

export const modeOf = (world: WorldState): RaceControlMode => controlOf(world)?.mode ?? 'green';

/** Number of red flags so far (0 without control state). */
export function redCount(world: WorldState): number {
  const n = controlOf(world)?.counts?.red;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** car.flags with every field defaulted. */
export function flagsOf(car: CarEntry): CarFlagState {
  const f = (car as { flags?: Partial<CarFlagState> }).flags ?? {};
  return {
    shown: f.shown ?? 'none',
    delta: typeof f.delta === 'number' && Number.isFinite(f.delta) ? f.delta : null,
    giveBack: f.giveBack ?? null,
    queuing: f.queuing === true,
  };
}

/** Strip content for a mode; null = no strip (green). `reason` is control.reason (zh-TW, '' = none). */
export function stripSpec(mode: RaceControlMode, reason: string): StripSpec | null {
  const sub = typeof reason === 'string' ? reason : '';
  switch (mode) {
    case 'sc':
      return { tone: 'yellow', title: '安全車', sub };
    case 'scEnding':
      return { tone: 'yellow', title: '安全車本圈進站', sub };
    case 'vsc':
      return { tone: 'yellow', title: '虛擬安全車', sub };
    case 'vscEnding':
      return { tone: 'yellow', title: '虛擬安全車即將結束', sub };
    case 'red':
      return { tone: 'red', title: '紅旗 — 比賽中止', sub };
    case 'formation':
      return { tone: 'formation', title: '暖胎圈', sub: '保持隊形，接近發車格時自動停車' };
    default:
      return null;
  }
}

export const GREEN_FLAG_SPEC: StripSpec = { tone: 'green', title: '綠旗', sub: '' };

/** Timing-tower header chip text for a mode ('' = none). */
export function modeChip(mode: RaceControlMode): string {
  switch (mode) {
    case 'sc':
    case 'scEnding':
      return 'SC';
    case 'vsc':
    case 'vscEnding':
      return 'VSC';
    case 'red':
      return '紅旗';
    case 'formation':
      return '暖胎圈';
    default:
      return '';
  }
}

export type DeltaClass = 'ok' | 'warn' | 'bad';

/** VSC delta colour class: >= 0.3 ok, 0..0.3 warn, < 0 bad. */
export function deltaClass(delta: number): DeltaClass {
  if (!Number.isFinite(delta) || delta < 0) return 'bad';
  return delta >= VSC_DELTA_OK ? 'ok' : 'warn';
}

export function formatVscDelta(delta: number): string {
  const d = fin(delta);
  return `VSC 差值 ${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(2)}`;
}

/** Whole seconds left, rounded up, never negative. */
export function countdownSeconds(timeLeft: number): number {
  return Math.max(0, Math.ceil(fin(timeLeft) - 1e-6));
}

export function giveBackText(abbr: string, timeLeft: number): string {
  return `請讓回位置給 ${abbr}（剩 ${countdownSeconds(timeLeft)} 秒）`;
}

export const BLUE_FLAG_TEXT = '藍旗 — 讓後方領先車通過';
export const QUEUE_TEXT = '跟隨安全車 — 禁止超車';
/** Queue pill while the safety-car limiter assist caps the throttle. */
export const QUEUE_LIMITED_TEXT = '安全車限速中 — 禁止超車';

/** Gap to the car ahead for the queue pill ('' when there is none to show). */
export function queueGapText(position: number, interval: number): string {
  if (!(position > 1) || !Number.isFinite(interval) || interval <= 0) return '';
  return `前車 ${formatSeconds(interval, 1)} 秒`;
}

/** Per-sector flag level: 0 green, 1 yellow, 2 double yellow (anything else -> 0). */
export function sectorFlagLevels(control: RaceControlState | null): [number, number, number] {
  const f = control?.sectorFlags;
  const lv = (i: number): number => {
    const v = Array.isArray(f) ? f[i] : 0;
    return v === 1 || v === 2 ? v : 0;
  };
  return [lv(0), lv(1), lv(2)];
}

/** 「黃旗 S2」 / 「雙黃旗 S2」; '' for green. `sector` is 0-based. */
export function sectorFlagLabel(sector: number, level: number): string {
  if (level === 1) return `黃旗 S${sector + 1}`;
  if (level === 2) return `雙黃旗 S${sector + 1}`;
  return '';
}

// ───────────────────────────── DOM: status strip ─────────────────────────────

/** Top-centre race-control strip (root level, shared by every view). */
export class RaceControlStrip {
  readonly el: HTMLElement;
  private readonly show: ShowSlot;
  private readonly tone: AttrSlot;
  private readonly title: TextSlot;
  private readonly sub: TextSlot;
  private readonly subShow: ShowSlot;
  private readonly rootFlag: AttrSlot;
  private prev: RaceControlMode | null = null;
  private greenLeft = 0;

  constructor(parent: HTMLElement) {
    this.el = el('div', 'nvh-rc nvh-hidden', parent);
    this.el.setAttribute('role', 'status');
    this.show = new ShowSlot(this.el);
    this.tone = new AttrSlot(this.el, 'data-tone');
    this.rootFlag = new AttrSlot(parent, 'data-rc');
    const icon = svgEl('svg', { viewBox: '0 0 24 24', class: 'nvh-rc-icon', 'aria-hidden': 'true' }, this.el);
    svgEl('path', { d: 'M5 21V3', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }, icon);
    svgEl('path', { d: 'M5.5 4h13l-3 4.5 3 4.5h-13z', fill: 'currentColor' }, icon);
    const text = el('div', 'nvh-rc-text', this.el);
    this.title = new TextSlot(el('div', 'nvh-rc-title', text));
    const sub = el('div', 'nvh-rc-sub', text);
    this.sub = new TextSlot(sub);
    this.subShow = new ShowSlot(sub);
  }

  update(world: WorldState, dt: number): void {
    const control = controlOf(world);
    const mode = control?.mode ?? 'green';
    if (this.prev !== null && this.prev !== mode) {
      this.greenLeft = mode === 'green' && isNeutralMode(this.prev) ? GREEN_FLAG_SECONDS : 0;
    }
    this.prev = mode;
    let spec = stripSpec(mode, control?.reason ?? '');
    if (!spec && this.greenLeft > 0) {
      this.greenLeft -= Math.max(0, fin(dt));
      if (this.greenLeft > 0) spec = GREEN_FLAG_SPEC;
    }
    this.show.set(spec !== null);
    // lets CSS move the toasts below the strip
    this.rootFlag.set(spec !== null ? '1' : null);
    if (!spec) return;
    this.tone.set(spec.tone);
    this.title.set(spec.title);
    this.sub.set(spec.sub);
    this.subShow.set(spec.sub !== '');
  }
}

// ───────────────────────────── DOM: player flag pills ─────────────────────────────

interface Pill {
  show: ShowSlot;
  text: TextSlot;
  extra: TextSlot;
  cls: AttrSlot;
}

/** Blue flag / VSC delta / give-back / SC queue pills of one player view. */
export class FlagStack {
  readonly el: HTMLElement;
  private readonly blue: Pill;
  private readonly delta: Pill;
  private readonly giveBack: Pill;
  private readonly queue: Pill;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-flags', parent);
    this.blue = this.pill('blue');
    this.giveBack = this.pill('giveback');
    this.delta = this.pill('delta');
    this.queue = this.pill('queue');
  }

  private pill(kind: string): Pill {
    const node = el('div', 'nvh-flagpill nvh-hidden', this.el);
    node.dataset.kind = kind;
    const text = el('span', 'nvh-flagpill-t', node);
    const extra = el('span', 'nvh-flagpill-x', node);
    return { show: new ShowSlot(node), text: new TextSlot(text), extra: new TextSlot(extra), cls: new AttrSlot(node, 'data-class') };
  }

  hide(): void {
    for (const p of [this.blue, this.delta, this.giveBack, this.queue]) p.show.set(false);
  }

  update(car: CarEntry, world: WorldState): void {
    const flags = flagsOf(car);
    const mode = modeOf(world);
    const active = car.status !== 'retired' && car.status !== 'finished';

    const blue = active && flags.shown === 'blue';
    this.blue.show.set(blue);
    if (blue) this.blue.text.set(BLUE_FLAG_TEXT);

    const d = active ? flags.delta : null;
    this.delta.show.set(d !== null);
    if (d !== null) {
      this.delta.text.set(formatVscDelta(d));
      this.delta.cls.set(deltaClass(d));
    }

    const gb = active ? flags.giveBack : null;
    this.giveBack.show.set(gb !== null);
    if (gb) this.giveBack.text.set(giveBackText(world.cars[gb.carId]?.abbr ?? `#${gb.carId}`, gb.timeLeft));

    const q = active && flags.queuing && (mode === 'sc' || mode === 'scEnding');
    this.queue.show.set(q);
    if (q) {
      this.queue.text.set(car.assists?.scLimiter === true ? QUEUE_LIMITED_TEXT : QUEUE_TEXT);
      this.queue.extra.set(queueGapText(fin(car.timing?.position, 1), fin(car.timing?.interval, -1)));
    }
  }
}
