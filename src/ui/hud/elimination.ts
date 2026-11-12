/**
 * Elimination race HUD: what to show (pure, unit-tested) and a thin panel in the top-left column above the timing
 * tower: the countdown, the car that goes out if it runs out now, and a red panel when that car is the player's.
 * Reads the mirrored session state, so an online guest shows the host's countdown on the host's clock.
 */
import type { WorldState } from '../../core/types';
import { eliminationLeft, eliminationRisk } from '../../race/index';
import { AttrSlot, ShowSlot, TextSlot, el } from './dom';
import { formatClock } from './labels';

/** Seconds left from which the countdown turns amber (red and pulsing for the player at risk). */
export const ELIMINATION_WARN = 10;

export type EliminationTone = 'calm' | 'warn' | 'danger';

export interface EliminationHud {
  /** whole seconds left, m:ss */
  clock: string;
  label: string;
  /** the car that goes out if the countdown ran out now ('' before the start) */
  risk: string;
  tone: EliminationTone;
  /** ELIMINATION_WARN or less left on a running countdown */
  urgent: boolean;
  /** the car at risk (null before the start) and whether one of `ownCars` is it */
  carId: number | null;
  mine: boolean;
}

/** null outside an elimination race and once it is decided. `ownCars`: the cars the HUD's players drive. */
export function eliminationHud(world: WorldState, ownCars: readonly number[]): EliminationHud | null {
  const s = world.session;
  const e = s.elimination;
  const format = world.config.raceFormat;
  if (!e || format?.kind !== 'elimination' || s.phase === 'chequered' || s.phase === 'finished') return null;
  const left = eliminationLeft(e, format.interval, world.time);
  const running = e.held === null;
  const car = eliminationRisk(world)?.car ?? null;
  const mine = car !== null && ownCars.includes(car.id);
  const urgent = running && left <= ELIMINATION_WARN;
  return {
    clock: formatClock(left, true),
    label: running ? '淘汰倒數' : s.startTime === null ? '起跑後開始倒數' : '倒數暫停',
    risk: car === null ? '' : mine ? (ownCars.length > 1 ? `${car.abbr} 在淘汰區！` : '你在淘汰區！') : `淘汰區：${car.abbr}`,
    tone: mine ? 'danger' : urgent ? 'warn' : 'calm',
    urgent,
    carId: car?.id ?? null,
    mine,
  };
}

/** Callout when a car goes out: its own view's banner, or a toast for everyone else. */
export function eliminatedCallout(abbr: string, position: number, own: boolean): { title: string; sub: string } {
  const sub = `第 ${Math.max(1, Math.round(position))} 名出局`;
  return own ? { title: '淘汰', sub } : { title: `${abbr} 淘汰`, sub };
}

/** Banner for a player whose car is at risk with the countdown low. */
export const AT_RISK_BANNER = { title: '淘汰危機', sub: '倒數結束前超越前車，否則出局' } as const;

export class EliminationPanel {
  readonly el: HTMLElement;
  private readonly show: ShowSlot;
  private readonly tone: AttrSlot;
  private readonly urgent: AttrSlot;
  private readonly label: TextSlot;
  private readonly clock: TextSlot;
  private readonly risk: TextSlot;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-elim nvh-panel nvh-hidden', parent);
    this.show = new ShowSlot(this.el);
    this.tone = new AttrSlot(this.el, 'data-tone');
    this.urgent = new AttrSlot(this.el, 'data-urgent');
    this.label = new TextSlot(el('span', 'nvh-elim-label', this.el));
    this.clock = new TextSlot(el('b', 'nvh-elim-clock', this.el));
    this.risk = new TextSlot(el('span', 'nvh-elim-risk', this.el));
  }

  /** Per frame; returns what it shows (null = hidden). */
  update(world: WorldState, ownCars: readonly number[]): EliminationHud | null {
    const hud = eliminationHud(world, ownCars);
    this.show.set(hud !== null);
    if (!hud) return null;
    this.tone.set(hud.tone);
    this.urgent.set(hud.urgent ? '1' : null);
    this.label.set(hud.label);
    this.clock.set(hud.clock);
    this.risk.set(hud.risk);
    return hud;
  }
}
