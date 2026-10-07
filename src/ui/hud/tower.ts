/**
 * Timing tower: every car in classification order (car rows glide to their new slot while the position numbers stay
 * fixed per slot, so the column always reads 1..N even mid-glide), team colour, abbreviation,
 * tyre letter, gap-to-leader / interval toggle (race) or best-lap gap (other sessions), pit / finished /
 * retired / penalty markers, fastest-lap marker and player highlight. Refreshed at 5 Hz.
 */
import type { CarEntry, WorldState } from '../../core/types';
import { COMPOUND_INFO } from '../../core/defaults';
import { formatGap, formatLapTime } from '../../core/math';
import { AttrSlot, ShowSlot, TextSlot, clickable, el } from './dom';
import { safeColor } from './labels';
import { modeChip, modeOf } from './raceControl';

const REFRESH = 0.2;
/** row glide duration (matches the .nvh-tw-row transform transition) */
export const GLIDE_SEC = 0.45;

export type TowerMode = 'interval' | 'gap';

interface Row {
  carId: number;
  abbr: string;
  node: HTMLElement;
  slot: number;
  tyre: TextSlot;
  tyreCompound: AttrSlot;
  value: TextSlot;
  tag: TextSlot;
  tagKind: AttrSlot;
  status: AttrSlot;
  fastest: AttrSlot;
}

interface NumberSlot {
  node: HTMLElement;
  player: AttrSlot;
  status: AttrSlot;
  /** car id whose row is currently shown at this slot */
  shown: number;
  /** car id whose row is gliding to this slot (-1 = none) and when it arrives */
  pending: number;
  due: number;
}

export class TimingTower {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly title: TextSlot;
  private readonly modeChip: TextSlot;
  private readonly modeChipShow: ShowSlot;
  private readonly modeChipKind: AttrSlot;
  private readonly toggle: HTMLElement;
  private readonly toggleText: TextSlot;
  private rows: Row[] = [];
  /**
   * static position number per slot (never moves). Its player / retired styling follows the car whose row is
   * visually at that slot: a slot only switches to a new car once that car's row has finished gliding there.
   */
  private slots: NumberSlot[] = [];
  private cars: readonly CarEntry[] = [];
  private now = 0;
  private mode: TowerMode = 'interval';
  private accum = REFRESH;
  private isRace = true;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-tower nvh-panel', parent);
    const head = el('div', 'nvh-tw-head', this.el);
    this.title = new TextSlot(el('span', 'nvh-tw-title', head));
    const chip = el('span', 'nvh-tw-mode nvh-hidden', head);
    this.modeChip = new TextSlot(chip);
    this.modeChipShow = new ShowSlot(chip);
    this.modeChipKind = new AttrSlot(chip, 'data-mode');
    this.toggle = clickable('nvh-tw-toggle', head, '', () => this.toggleMode());
    this.toggle.title = '切換差距 / 間隔';
    this.toggleText = new TextSlot(this.toggle);
    this.body = el('div', 'nvh-tw-body', this.el);
  }

  /** Switch between interval (to the car ahead) and gap to the leader. */
  toggleMode(): void {
    this.mode = this.mode === 'interval' ? 'gap' : 'interval';
    this.accum = REFRESH;
  }

  update(world: WorldState, order: readonly CarEntry[], dt: number): void {
    this.now += dt;
    this.settleSlots();
    this.accum += dt;
    if (this.accum < REFRESH) return;
    this.accum = 0;
    this.isRace = world.session.kind === 'race';
    this.cars = world.cars;
    this.ensureRows(world.cars);
    this.title.set(this.isRace ? '名次' : '最快圈');
    const mode = modeOf(world);
    const chipText = modeChip(mode);
    this.modeChipShow.set(chipText !== '');
    if (chipText) {
      this.modeChip.set(chipText);
      this.modeChipKind.set(mode === 'red' ? 'red' : mode === 'formation' ? 'formation' : 'yellow');
    }
    this.toggle.classList.toggle('nvh-hidden', !this.isRace);
    this.toggleText.set(this.mode === 'interval' ? '間隔' : '差距');

    const leaderBest = order.length > 0 ? order[0].timing.bestLap : null;
    const fastestId = world.session.fastestLap?.carId ?? -1;
    for (let i = 0; i < order.length; i++) {
      const car = order[i];
      const row = this.rows[car.id];
      if (!row || row.carId !== car.id) continue;
      if (row.slot !== i) {
        row.slot = i;
        row.node.style.transform = `translateY(${i * 100}%)`;
      }
      this.trackSlot(i, car.id);
      const compound = car.phys.tire.compound;
      row.tyre.set(COMPOUND_INFO[compound]?.letter ?? '');
      row.tyreCompound.set(compound);
      row.value.set(this.valueText(car, i, order, leaderBest));
      row.status.set(car.status);
      row.fastest.set(car.id === fastestId && car.timing.bestLap != null ? '1' : null);
      const inPit = car.pit.phase !== 'none' || car.status === 'pitting';
      if (car.status === 'retired') {
        row.tag.set('');
        row.tagKind.set(null);
      } else if (inPit) {
        row.tag.set('進站');
        row.tagKind.set('pit');
      } else if (car.status === 'finished') {
        row.tag.set('');
        row.tagKind.set('flag');
      } else if (car.penalties.timeSec > 0) {
        row.tag.set(`+${Math.round(car.penalties.timeSec)}s`);
        row.tagKind.set('pen');
      } else {
        row.tag.set('');
        row.tagKind.set(null);
      }
    }
  }

  /** Slots whose incoming row has finished gliding adopt that car's number styling (runs every frame). */
  private settleSlots(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.pending !== -1 && this.now >= s.due) {
        s.shown = s.pending;
        s.pending = -1;
        this.styleSlot(s);
      }
    }
  }

  private trackSlot(i: number, carId: number): void {
    const s = this.slots[i];
    if (!s) return;
    if (s.shown === carId) {
      s.pending = -1;
    } else if (s.pending !== carId) {
      s.pending = carId;
      s.due = this.now + GLIDE_SEC;
    }
    this.styleSlot(s);
  }

  private styleSlot(s: NumberSlot): void {
    const car = this.cars[s.shown];
    s.player.set(car && car.playerIndex !== -1 ? String(car.playerIndex) : null);
    s.status.set(car && car.status === 'retired' ? 'retired' : null);
  }

  private valueText(car: CarEntry, index: number, order: readonly CarEntry[], leaderBest: number | null): string {
    const t = car.timing;
    if (car.status === 'retired') return '退賽';
    if (!this.isRace) {
      if (t.bestLap == null) return '無時間';
      if (index === 0 || leaderBest == null) return formatLapTime(t.bestLap);
      return formatGap(t.bestLap - leaderBest);
    }
    if (index === 0) return car.status === 'finished' ? '完賽' : '領先';
    const lapsDown = Number.isFinite(t.lapsDown) ? Math.max(0, Math.round(t.lapsDown)) : 0;
    if (this.mode === 'gap') {
      if (lapsDown > 0) return `+${lapsDown} 圈`;
      return Number.isFinite(t.gapToLeader) ? formatGap(Math.max(0, t.gapToLeader)) : '--';
    }
    const prev = order[index - 1];
    const prevDown = Number.isFinite(prev.timing.lapsDown) ? Math.max(0, Math.round(prev.timing.lapsDown)) : 0;
    if (lapsDown > prevDown) return `+${lapsDown - prevDown} 圈`;
    return Number.isFinite(t.interval) ? formatGap(Math.max(0, t.interval)) : '--';
  }

  private ensureRows(cars: readonly CarEntry[]): void {
    const same = this.rows.length === cars.length && cars.every((c, i) => this.rows[i].abbr === c.abbr);
    if (same) return;
    for (const r of this.rows) r.node.remove();
    for (const s of this.slots) s.node.remove();
    this.rows = cars.map((car, i) => this.buildRow(car, i));
    this.slots = cars.map((car, i) => {
      const node = el('span', 'nvh-tw-pos', this.body);
      el('b', undefined, node, String(i + 1));
      node.style.transform = `translateY(${i * 100}%)`;
      const player = new AttrSlot(node, 'data-player');
      const status = new AttrSlot(node, 'data-status');
      const slot: NumberSlot = { node, player, status, shown: car.id, pending: -1, due: 0 };
      this.styleSlot(slot);
      return slot;
    });
    this.body.style.height = `calc(var(--nvh-tw-row) * ${cars.length})`;
  }

  private buildRow(car: CarEntry, index: number): Row {
    const node = el('div', 'nvh-tw-row', this.body);
    node.style.transform = `translateY(${index * 100}%)`;
    if (car.playerIndex !== -1) node.dataset.player = String(car.playerIndex);
    el('span', 'nvh-tw-posgap', node);
    const team = el('span', 'nvh-tw-team', node);
    team.style.background = safeColor(car.livery?.primary);
    const name = el('span', 'nvh-tw-abbr', node, car.abbr);
    el('span', 'nvh-tw-fl', name);
    const tyre = el('span', 'nvh-tw-tyre', node);
    const value = el('span', 'nvh-tw-val', node);
    const tag = el('span', 'nvh-tw-tag', node);
    return {
      carId: car.id,
      abbr: car.abbr,
      node,
      slot: index,
      tyre: new TextSlot(tyre),
      tyreCompound: new AttrSlot(tyre, 'data-compound'),
      value: new TextSlot(value),
      tag: new TextSlot(tag),
      tagKind: new AttrSlot(tag, 'data-kind'),
      status: new AttrSlot(node, 'data-status'),
      fastest: new AttrSlot(node, 'data-fl'),
    };
  }
}
