/**
 * Multi-function display (pit strategy): next tyre compound, the fuel for the next stop (endurance race), "Box 本圈" /
 * cancel, ERS mode buttons, current tyre summary and the estimated pit-stop time loss. Mouse, plus keyboard shortcuts
 * while open (1–4 ERS mode, 5 next compound, 6 box / cancel, 7 fuel; split-screen: P1 top-row digits, P2 numpad
 * digits); the player's gamepad D-pad left/right steps the compound (see padStep; the fuel stays on its choice).
 */
import type { BuiltTrack, CarEntry, ErsMode, TireCompound, WorldState } from '../../core/types';
import { COMPOUND_INFO } from '../../core/defaults';
import { clamp01 } from '../../core/math';
import { PIT_LOSS_FALLBACK, autoFuel, fuelTank } from '../../race/index';
import { FUEL_CHOICES, fillLabel, fuelChoiceLabel, fuelChoiceTarget, type FuelChoice } from './endurance';
import { AttrSlot, ShowSlot, TextSlot, clickable, el } from './dom';
import { ALL_COMPOUNDS, ERS_LABEL, ERS_MODES, cycle, fin } from './labels';

/** Sensible next compound: weather crossover first, otherwise a different dry compound. */
function suggestCompound(car: CarEntry, world: WorldState): TireCompound {
  const wet = fin(world.weather.wetness);
  if (wet > 0.6) return 'wet';
  if (wet > 0.25) return 'inter';
  return car.phys.tire.compound === 'medium' ? 'hard' : 'medium';
}

export interface MfdActions {
  /** `fuel`: an endurance race's tank (kg) after the stop (undefined: the automatic fill) */
  requestPit(compound: TireCompound, fuel?: number): void;
  cancelPit(): void;
  setErsMode(mode: ErsMode): void;
}

/** Snapshot of what the keyboard shortcuts need (no world references are kept between frames). */
interface MfdState {
  requested: boolean;
  boxAllowed: boolean;
  pitAllowed: boolean;
  nextCompound: TireCompound;
  /** an endurance race's tank (kg; 0 in any other race) */
  tank: number;
}

export class MfdPanel {
  readonly el: HTMLElement;
  private readonly show: ShowSlot;
  private readonly pitRows: ShowSlot[] = [];
  private readonly cmpBadge: TextSlot;
  private readonly cmpBadgeKind: AttrSlot;
  private readonly cmpLabel: TextSlot;
  private readonly boxBtn: TextSlot;
  private readonly boxState: AttrSlot;
  private readonly ersBtns: AttrSlot[] = [];
  private readonly ersNote: ShowSlot;
  private readonly tyreInfo: TextSlot;
  private readonly lossInfo: TextSlot;
  private readonly fuelRow: ShowSlot;
  private readonly fuelLabel: TextSlot;
  private readonly fuelHint: ShowSlot;
  private open = false;
  /** player's explicit compound pick (null = follow suggestion / active request) */
  private picked: TireCompound | null = null;
  private suggestion: TireCompound = 'medium';
  /** fuel for the next stop (endurance race) */
  private fuelPick: FuelChoice = null;
  private state: MfdState | null = null;

  /**
   * `keys`: which digit keys drive this MFD — 'all' (single view: top-row digits or numpad), 'digit' (split-screen
   * P1: top row only) or 'numpad' (split-screen P2: numpad only), so both players can work their own MFD at once.
   */
  constructor(
    parent: Element,
    private readonly actions: MfdActions,
    pitLoss: number,
    private readonly keys: 'all' | 'digit' | 'numpad' = 'all',
  ) {
    this.el = el('div', 'nvh-mfd nvh-panel', parent);
    this.show = new ShowSlot(this.el);
    this.show.set(false);
    const head = el('div', 'nvh-mfd-head', this.el);
    el('span', 'nvh-mfd-title', head, 'MFD · 進站策略');
    clickable('nvh-mfd-close', head, '關閉', () => this.toggle());

    const cmpRow = el('div', 'nvh-mfd-row', this.el);
    this.pitRows.push(new ShowSlot(cmpRow));
    el('span', 'nvh-mfd-k', cmpRow, '下次輪胎');
    const cmp = el('div', 'nvh-mfd-cmp', cmpRow);
    clickable('nvh-arrow', cmp, '‹', () => this.stepCompound(-1));
    const badge = el('span', 'nvh-tyre-badge nvh-tyre-badge-sm', cmp);
    this.cmpBadge = new TextSlot(badge);
    this.cmpBadgeKind = new AttrSlot(badge, 'data-compound');
    this.cmpLabel = new TextSlot(el('span', 'nvh-mfd-cmp-label', cmp));
    clickable('nvh-arrow', cmp, '›', () => this.stepCompound(1));

    const fuelRow = el('div', 'nvh-mfd-row', this.el);
    this.fuelRow = new ShowSlot(fuelRow);
    el('span', 'nvh-mfd-k', fuelRow, '加油');
    const fuel = el('div', 'nvh-mfd-cmp', fuelRow);
    clickable('nvh-arrow', fuel, '‹', () => this.stepFuel(-1));
    this.fuelLabel = new TextSlot(el('span', 'nvh-mfd-cmp-label', fuel));
    clickable('nvh-arrow', fuel, '›', () => this.stepFuel(1));

    const boxRow = el('div', 'nvh-mfd-row', this.el);
    this.pitRows.push(new ShowSlot(boxRow));
    el('span', 'nvh-mfd-k', boxRow, '進站');
    const box = clickable('nvh-btn', boxRow, '', () => this.toggleBox());
    this.boxBtn = new TextSlot(box);
    this.boxState = new AttrSlot(box, 'data-state');

    const ersRow = el('div', 'nvh-mfd-row', this.el);
    const ersK = el('span', 'nvh-mfd-k', ersRow, 'ERS 模式');
    this.ersNote = new ShowSlot(el('span', 'nvh-mfd-note', ersK, '（輔助中）'));
    const btns = el('div', 'nvh-ers-btns', ersRow);
    for (const mode of ERS_MODES) {
      const b = clickable('nvh-ers-btn', btns, ERS_LABEL[mode], () => this.actions.setErsMode(mode));
      this.ersBtns.push(new AttrSlot(b, 'data-active'));
    }

    const info = el('div', 'nvh-mfd-info', this.el);
    this.tyreInfo = new TextSlot(el('div', '', info));
    const loss = el('div', '', info);
    this.pitRows.push(new ShowSlot(loss));
    this.lossInfo = new TextSlot(loss);
    this.lossInfo.set(`預估進站損失 ≈ ${fin(pitLoss, PIT_LOSS_FALLBACK).toFixed(1)} 秒`);
    const hint = el('div', 'nvh-mfd-hint', this.el, keys === 'numpad' ? '[數字鍵盤 1–4] ERS 模式　[5] 換胎配方　[6] Box / 取消　[手把 十字鍵 ←→] 換胎配方' : '[1–4] ERS 模式　[5] 換胎配方　[6] Box / 取消　[手把 十字鍵 ←→] 換胎配方');
    this.fuelHint = new ShowSlot(el('span', '', hint, '　[7] 加油'));
    this.fuelRow.set(false);
    this.fuelHint.set(false);
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open = !this.open;
    this.show.set(this.open);
  }

  close(): void {
    this.open = false;
    this.show.set(false);
  }

  /** Compound used for a pit request right now (explicit pick, active request or suggestion). */
  selectedCompound(): TireCompound {
    if (this.state?.requested) return this.state.nextCompound;
    return this.picked ?? this.suggestion;
  }

  /** Fuel (kg in the tank after the stop) for a pit request right now: undefined for the automatic fill or outside an endurance race. */
  selectedFuel(): number | undefined {
    const tank = this.state?.tank ?? 0;
    return tank > 0 ? fuelChoiceTarget(this.fuelPick, tank) : undefined;
  }

  /** Per frame: keep the shortcut state fresh; DOM is refreshed only while open. */
  sync(car: CarEntry, world: WorldState, track: BuiltTrack): void {
    const pit = car.pit;
    const active = car.status !== 'finished' && car.status !== 'retired';
    const pitAllowed = world.session.kind !== 'timeTrial';
    this.suggestion = suggestCompound(car, world);
    this.state = {
      requested: pit.requested,
      boxAllowed: pitAllowed && active && pit.phase === 'none',
      pitAllowed,
      nextCompound: pit.nextCompound,
      tank: world.session.endurance ? fuelTank(car.spec, track) : 0,
    };
    if (!this.open) return;

    for (const row of this.pitRows) row.set(pitAllowed);
    const tank = this.state.tank;
    this.fuelRow.set(tank > 0);
    this.fuelHint.set(tank > 0);
    if (tank > 0) {
      // (the automatic fill as it stands now: decided when the car stops)
      const target = this.selectedFuel() ?? autoFuel(world, track, car);
      this.fuelLabel.set(`${fuelChoiceLabel(this.fuelPick)} · ${fillLabel(target, car.phys.fuelKg, tank)}`);
    }
    const compound = this.selectedCompound();
    const info = COMPOUND_INFO[compound] ?? COMPOUND_INFO.medium;
    this.cmpBadge.set(info.letter);
    this.cmpBadgeKind.set(compound);
    this.cmpLabel.set(info.label);
    if (!this.state.boxAllowed) {
      this.boxBtn.set(pit.phase !== 'none' ? '維修道中' : '無法進站');
      this.boxState.set('disabled');
    } else if (pit.requested) {
      this.boxBtn.set('取消進站');
      this.boxState.set('cancel');
    } else {
      this.boxBtn.set('Box 本圈');
      this.boxState.set('request');
    }
    for (let i = 0; i < ERS_MODES.length; i++) this.ersBtns[i].set(car.phys.ers.mode === ERS_MODES[i] ? '1' : null);
    this.ersNote.set(car.assists.ersAssist);
    const tyre = car.phys.tire;
    const cur = COMPOUND_INFO[tyre.compound]?.label ?? '';
    const wear = Math.round(clamp01(fin(tyre.wear)) * 100);
    this.tyreInfo.set(`目前輪胎：${cur} · ${Math.max(0, Math.round(fin(tyre.laps)))} 圈 · 磨耗 ${wear}%`);
  }

  /** Keyboard shortcuts while open. Returns true when the key was consumed. */
  handleKey(code: string): boolean {
    if (!this.open) return false;
    const digit = /^(Digit|Numpad)([1-7])$/.exec(code);
    if (!digit) return false;
    if ((this.keys === 'digit' && digit[1] !== 'Digit') || (this.keys === 'numpad' && digit[1] !== 'Numpad')) return false;
    const n = Number(digit[2]);
    if (n === 7 && !(this.state && this.state.tank > 0)) return false;
    if (n <= 4) this.actions.setErsMode(ERS_MODES[n - 1]);
    else if (n === 5) this.stepCompound(1);
    else if (n === 6) this.toggleBox();
    else this.stepFuel(1);
    return true;
  }

  /** Gamepad D-pad left/right while open: previous / next compound. Returns true when consumed. */
  padStep(step: 1 | -1): boolean {
    if (!this.open) return false;
    this.stepCompound(step);
    return true;
  }

  private stepCompound(step: 1 | -1): void {
    const st = this.state;
    if (!st?.pitAllowed) return;
    const next = cycle(ALL_COMPOUNDS, this.selectedCompound(), step);
    this.picked = next;
    if (st.requested && st.boxAllowed) {
      this.actions.requestPit(next, this.selectedFuel());
      st.nextCompound = next;
    }
  }

  private stepFuel(step: 1 | -1): void {
    const st = this.state;
    if (!st?.pitAllowed || !(st.tank > 0)) return;
    this.fuelPick = cycle(FUEL_CHOICES, this.fuelPick, step);
    if (st.requested && st.boxAllowed) this.actions.requestPit(st.nextCompound, this.selectedFuel());
  }

  private toggleBox(): void {
    const st = this.state;
    if (!st?.boxAllowed) return;
    if (st.requested) {
      this.actions.cancelPit();
      st.requested = false;
    } else {
      const compound = this.picked ?? this.suggestion;
      this.actions.requestPit(compound, this.selectedFuel());
      st.requested = true;
      st.nextCompound = compound;
    }
  }
}
