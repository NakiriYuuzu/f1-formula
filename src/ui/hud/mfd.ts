/**
 * Multi-function display (pit strategy): next tyre compound, "Box 本圈" / cancel, ERS mode buttons, current tyre
 * summary and the estimated pit-stop time loss. Mouse, plus keyboard shortcuts while open
 * (1–4 ERS mode, 5 next compound, 6 box / cancel; split-screen: P1 top-row digits, P2 numpad digits).
 */
import type { BuiltTrack, CarEntry, ErsMode, TireCompound, WorldState } from '../../core/types';
import { COMPOUND_INFO } from '../../core/defaults';
import { clamp, clamp01 } from '../../core/math';
import { AttrSlot, ShowSlot, TextSlot, clickable, el } from './dom';
import { ALL_COMPOUNDS, ERS_LABEL, ERS_MODES, cycle, fin } from './labels';

/** Average stationary time (SPEC: 2–3.5 s) and extra decel/accel loss around the box. */
const STOP_TIME = 2.8;
const BOX_MANOEUVRE = 1.5;
const FALLBACK_LOSS = 22;

/** Estimated time lost by a stop: pit-lane time at the limit + stop − racing time over the same stretch. */
export function estimatePitLoss(track: BuiltTrack): number {
  const pit = track.pit;
  const len = track.length;
  if (!pit || !(pit.laneLength > 0) || !(pit.speedLimit > 0) || track.count < 2 || !(len > 0)) return FALLBACK_LOSS;
  const wrap = (s: number): number => ((s % len) + len) % len;
  const entry = wrap(pit.entry);
  const exit = wrap(pit.exit);
  let racing = 0;
  for (let i = 0; i < track.count; i++) {
    const s = track.s[i];
    const inside = entry <= exit ? s >= entry && s < exit : s >= entry || s < exit;
    if (!inside) continue;
    const next = i + 1 < track.count ? track.s[i + 1] : len;
    const ds = next - s;
    if (!(ds > 0) || !Number.isFinite(ds)) continue;
    racing += ds / Math.max(10, fin(track.speedProfile[i], 60));
  }
  const loss = pit.laneLength / pit.speedLimit + STOP_TIME + BOX_MANOEUVRE - racing;
  return Number.isFinite(loss) ? clamp(loss, 8, 45) : FALLBACK_LOSS;
}

/** Sensible next compound: weather crossover first, otherwise a different dry compound. */
function suggestCompound(car: CarEntry, world: WorldState): TireCompound {
  const wet = fin(world.weather.wetness);
  if (wet > 0.6) return 'wet';
  if (wet > 0.25) return 'inter';
  return car.phys.tire.compound === 'medium' ? 'hard' : 'medium';
}

export interface MfdActions {
  requestPit(compound: TireCompound): void;
  cancelPit(): void;
  setErsMode(mode: ErsMode): void;
}

/** Snapshot of what the keyboard shortcuts need (no world references are kept between frames). */
interface MfdState {
  requested: boolean;
  boxAllowed: boolean;
  pitAllowed: boolean;
  nextCompound: TireCompound;
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
  private open = false;
  /** player's explicit compound pick (null = follow suggestion / active request) */
  private picked: TireCompound | null = null;
  private suggestion: TireCompound = 'medium';
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
    this.lossInfo.set(`預估進站損失 ≈ ${fin(pitLoss, FALLBACK_LOSS).toFixed(1)} 秒`);
    el('div', 'nvh-mfd-hint', this.el, keys === 'numpad' ? '[數字鍵盤 1–4] ERS 模式　[5] 換胎配方　[6] Box / 取消' : '[1–4] ERS 模式　[5] 換胎配方　[6] Box / 取消');
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

  /** Per frame: keep the shortcut state fresh; DOM is refreshed only while open. */
  sync(car: CarEntry, world: WorldState): void {
    const pit = car.pit;
    const active = car.status !== 'finished' && car.status !== 'retired';
    const pitAllowed = world.session.kind !== 'timeTrial';
    this.suggestion = suggestCompound(car, world);
    this.state = {
      requested: pit.requested,
      boxAllowed: pitAllowed && active && pit.phase === 'none',
      pitAllowed,
      nextCompound: pit.nextCompound,
    };
    if (!this.open) return;

    for (const row of this.pitRows) row.set(pitAllowed);
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
    const digit = /^(Digit|Numpad)([1-6])$/.exec(code);
    if (!digit) return false;
    if ((this.keys === 'digit' && digit[1] !== 'Digit') || (this.keys === 'numpad' && digit[1] !== 'Numpad')) return false;
    const n = Number(digit[2]);
    if (n <= 4) this.actions.setErsMode(ERS_MODES[n - 1]);
    else if (n === 5) this.stepCompound(1);
    else this.toggleBox();
    return true;
  }

  private stepCompound(step: 1 | -1): void {
    const st = this.state;
    if (!st?.pitAllowed) return;
    const next = cycle(ALL_COMPOUNDS, this.selectedCompound(), step);
    this.picked = next;
    if (st.requested && st.boxAllowed) {
      this.actions.requestPit(next);
      st.nextCompound = next;
    }
  }

  private toggleBox(): void {
    const st = this.state;
    if (!st?.boxAllowed) return;
    if (st.requested) {
      this.actions.cancelPit();
      st.requested = false;
    } else {
      const compound = this.picked ?? this.suggestion;
      this.actions.requestPit(compound);
      st.requested = true;
      st.nextCompound = compound;
    }
  }
}
