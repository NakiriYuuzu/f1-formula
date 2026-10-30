/**
 * Player timing panel: position P x/N, lap counter / time remaining, current lap time (+ invalid flag),
 * live delta (personal best or ghost), sector bars (purple / green / yellow), last & best lap,
 * gaps to the cars ahead/behind (race) and the pit status pill.
 */
import type { CarEntry, SpeedUnit, WorldState } from '../../core/types';
import { COMPOUND_INFO } from '../../core/defaults';
import { formatLapTime } from '../../core/math';
import { AttrSlot, ShowSlot, TextSlot, el } from './dom';
import {
  classifySector,
  displaySpeed,
  fin,
  formatClock,
  formatDelta,
  formatSectorTime,
  formatSeconds,
  unitLabel,
} from './labels';
import type { SectorState } from './labels';
import { controlOf, sectorFlagLabel, sectorFlagLevels } from './raceControl';

/** How long the previous lap's sectors stay on screen after crossing the line (s). */
const LAST_LAP_HOLD = 4;
const DELTA_REFRESH = 0.1;

export interface TimingContext {
  /** cars sorted by classification position */
  order: readonly CarEntry[];
  /** best time per sector over every car (null = none yet) */
  overallBestSectors: readonly (number | null)[];
  delta: number | null;
  deltaRef: 'ghost' | 'best' | null;
  units: SpeedUnit;
  /** pit-lane speed limit (m/s) */
  pitLimit: number;
}

interface SectorSlot {
  flag: AttrSlot;
  state: AttrSlot;
  time: TextSlot;
}

export class TimingPanel {
  readonly el: HTMLElement;
  private readonly posBox: ShowSlot;
  private readonly pos: TextSlot;
  private readonly posOf: TextSlot;
  private readonly lapLabel: TextSlot;
  private readonly lapValue: TextSlot;
  private readonly lapSub: TextSlot;
  private readonly lapTime: TextSlot;
  private readonly invalid: ShowSlot;
  private readonly deltaRow: ShowSlot;
  private readonly deltaLabel: TextSlot;
  private readonly deltaValue: TextSlot;
  private readonly deltaSign: AttrSlot;
  private readonly sectors: SectorSlot[] = [];
  private readonly flagChips: { show: ShowSlot; text: TextSlot; level: AttrSlot }[] = [];
  private readonly last: TextSlot;
  private readonly lastState: AttrSlot;
  private readonly best: TextSlot;
  private readonly bestState: AttrSlot;
  private readonly gapsRow: ShowSlot;
  private readonly gapAhead: TextSlot;
  private readonly gapBehind: TextSlot;
  private readonly pitPill: ShowSlot;
  private readonly pitText: TextSlot;
  private readonly pitState: AttrSlot;
  private deltaAccum = DELTA_REFRESH;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-timing nvh-panel', parent);

    const head = el('div', 'nvh-tp-head', this.el);
    const pos = el('div', 'nvh-pos', head);
    this.posBox = new ShowSlot(pos);
    el('span', 'nvh-pos-p', pos, 'P');
    this.pos = new TextSlot(el('span', 'nvh-pos-n', pos));
    this.posOf = new TextSlot(el('span', 'nvh-pos-of', pos));
    const lapBox = el('div', 'nvh-lapbox', head);
    this.lapLabel = new TextSlot(el('div', 'nvh-k', lapBox));
    this.lapValue = new TextSlot(el('div', 'nvh-lapbox-v', lapBox));
    this.lapSub = new TextSlot(el('div', 'nvh-lapbox-sub', lapBox));

    const timeRow = el('div', 'nvh-tp-time', this.el);
    this.lapTime = new TextSlot(el('div', 'nvh-laptime', timeRow));
    this.invalid = new ShowSlot(el('div', 'nvh-invalid', timeRow, '無效'));

    const deltaRow = el('div', 'nvh-tp-delta', this.el);
    this.deltaRow = new ShowSlot(deltaRow);
    this.deltaSign = new AttrSlot(deltaRow, 'data-sign');
    this.deltaLabel = new TextSlot(el('span', 'nvh-k', deltaRow));
    this.deltaValue = new TextSlot(el('span', 'nvh-delta-v', deltaRow));

    const secs = el('div', 'nvh-sectors', this.el);
    for (let i = 0; i < 3; i++) {
      const s = el('div', 'nvh-sec', secs);
      el('div', 'nvh-sec-bar', s);
      const label = el('div', 'nvh-sec-label', s);
      el('span', 'nvh-sec-n', label, `S${i + 1}`);
      this.sectors.push({ flag: new AttrSlot(s, 'data-flag'), state: new AttrSlot(s, 'data-state'), time: new TextSlot(el('span', 'nvh-sec-t', label)) });
    }

    const chips = el('div', 'nvh-flagchips', this.el);
    for (let i = 0; i < 3; i++) {
      const chip = el('span', 'nvh-flagchip nvh-hidden', chips);
      this.flagChips.push({ show: new ShowSlot(chip), text: new TextSlot(chip), level: new AttrSlot(chip, 'data-level') });
    }

    const laps = el('div', 'nvh-tp-laps', this.el);
    const lastKv = el('div', 'nvh-kv', laps);
    el('span', 'nvh-k', lastKv, '上圈');
    const lastV = el('span', 'nvh-v nvh-mono', lastKv);
    this.last = new TextSlot(lastV);
    this.lastState = new AttrSlot(lastV, 'data-state');
    const bestKv = el('div', 'nvh-kv', laps);
    el('span', 'nvh-k', bestKv, '最佳');
    const bestV = el('span', 'nvh-v nvh-mono', bestKv);
    this.best = new TextSlot(bestV);
    this.bestState = new AttrSlot(bestV, 'data-state');

    const gaps = el('div', 'nvh-tp-gaps', this.el);
    this.gapsRow = new ShowSlot(gaps);
    const aheadKv = el('div', 'nvh-kv', gaps);
    el('span', 'nvh-k', aheadKv, '前車');
    this.gapAhead = new TextSlot(el('span', 'nvh-v nvh-mono', aheadKv));
    const behindKv = el('div', 'nvh-kv', gaps);
    el('span', 'nvh-k', behindKv, '後車');
    this.gapBehind = new TextSlot(el('span', 'nvh-v nvh-mono', behindKv));

    const pit = el('div', 'nvh-pitstat', this.el);
    this.pitPill = new ShowSlot(pit);
    this.pitText = new TextSlot(pit);
    this.pitState = new AttrSlot(pit, 'data-state');
  }

  update(car: CarEntry, world: WorldState, dt: number, ctx: TimingContext): void {
    const t = car.timing;
    const s = world.session;
    const lap = Number.isFinite(t.lap) ? Math.max(0, Math.floor(t.lap)) : 0;
    const finished = car.status === 'finished';
    const retired = car.status === 'retired';
    const disqualified = car.penalties?.disqualified === true;
    const nCars = world.cars.length;

    // Position.
    const showPos = nCars > 1 && s.kind !== 'timeTrial';
    this.posBox.set(showPos);
    if (showPos) {
      const p = Number.isFinite(t.position) && t.position > 0 ? Math.round(t.position) : nCars;
      this.pos.set(String(p));
      this.posOf.set(`/${nCars}`);
    }

    // Lap counter / time remaining.
    if (s.kind === 'race') {
      const total = Math.max(1, Math.round(fin(s.totalLaps, 1)));
      this.lapLabel.set('圈數');
      this.lapValue.set(disqualified ? '取消資格' : finished ? '完賽' : retired ? '退賽' : `${Math.min(Math.max(lap, 1), total)}/${total}`);
      this.lapSub.set('');
    } else if (s.timeRemaining != null && Number.isFinite(s.timeRemaining)) {
      this.lapLabel.set('剩餘時間');
      this.lapValue.set(formatClock(Math.max(0, s.timeRemaining), true));
      this.lapSub.set(lap >= 1 ? `第 ${lap} 圈` : '出場圈');
    } else {
      this.lapLabel.set('圈數');
      this.lapValue.set(lap >= 1 ? String(lap) : '出場圈');
      this.lapSub.set('');
    }

    // Current lap time.
    const live = (s.phase === 'running' || s.phase === 'chequered') && lap >= 1 && !finished && !retired;
    if (finished) this.lapTime.set(formatLapTime(t.lastLap));
    else this.lapTime.set(live ? formatLapTime(fin(t.currentLapTime)) : formatLapTime(null));
    this.invalid.set(live && !t.lapValid);

    // Live delta (throttled for readability).
    this.deltaAccum += dt;
    if (this.deltaAccum >= DELTA_REFRESH) {
      this.deltaAccum = 0;
      const showDelta = ctx.deltaRef !== null && !finished && !retired;
      this.deltaRow.set(showDelta);
      if (showDelta) {
        this.deltaLabel.set(ctx.deltaRef === 'ghost' ? '對比幽靈' : '對比個人最佳');
        const d = ctx.delta;
        this.deltaValue.set(d === null ? '--' : formatDelta(d));
        this.deltaSign.set(d === null ? null : d < -0.0005 ? 'ahead' : d > 0.0005 ? 'behind' : 'even');
      }
    }

    this.updateSectors(car, lap, live, ctx.overallBestSectors);
    this.updateSectorFlags(world);

    // Last / best lap.
    const fastest = s.fastestLap;
    const bestIsOverall = t.bestLap != null && fastest != null && fastest.carId === car.id;
    const bestTag = t.bestLap == null ? null : bestIsOverall ? 'overall' : 'personal';
    this.best.set(formatLapTime(t.bestLap));
    this.bestState.set(bestTag);
    this.last.set(formatLapTime(t.lastLap));
    const lastIsBest = t.lastLap != null && t.bestLap != null && Math.abs(t.lastLap - t.bestLap) < 1e-4;
    this.lastState.set(lastIsBest ? bestTag : null);

    // Gaps to neighbours (race).
    const showGaps = s.kind === 'race' && !finished && !retired && nCars > 1 && lap >= 1;
    this.gapsRow.set(showGaps);
    if (showGaps) {
      const idx = ctx.order.indexOf(car);
      const behind = idx >= 0 && idx + 1 < ctx.order.length ? ctx.order[idx + 1] : null;
      // `interval` is always measured to the car directly ahead.
      this.gapAhead.set(idx > 0 ? gapText(t.interval) : '—');
      this.gapBehind.set(behind && behind.status !== 'retired' ? gapText(behind.timing.interval) : '—');
    }

    this.updatePit(car, ctx);
  }

  private updateSectors(car: CarEntry, lap: number, live: boolean, overall: readonly (number | null)[]): void {
    const t = car.timing;
    const current = t.sectors ?? [];
    const lastSecs = t.lastSectors ?? [];
    const currentEmpty = !current.some((v) => v != null);
    const showLast =
      currentEmpty && lap >= 2 && fin(t.currentLapTime) < LAST_LAP_HOLD && lastSecs.some((v) => v != null);
    const shown = showLast ? lastSecs : current;
    let completed = 0;
    for (let i = 0; i < 3; i++) {
      const v = shown[i];
      if (v != null && Number.isFinite(v)) completed += v;
    }
    for (let i = 0; i < 3; i++) {
      const slot = this.sectors[i];
      const time = shown[i] ?? null;
      let state: SectorState;
      let text: string;
      if (time != null && Number.isFinite(time)) {
        state = !showLast && !t.lapValid ? 'invalid' : classifySector(time, t.bestSectors?.[i] ?? null, overall[i] ?? null);
        text = formatSectorTime(time);
      } else if (!showLast && live && i === t.sector) {
        state = 'live';
        const running = fin(t.currentLapTime) - completed;
        text = running >= 0 ? running.toFixed(1) : '';
      } else {
        state = 'pending';
        text = '';
      }
      slot.state.set(state);
      slot.time.set(text);
    }
  }

  /** Yellow / double-yellow sector bars + chips (「黃旗 S2」). */
  private updateSectorFlags(world: WorldState): void {
    const levels = sectorFlagLevels(controlOf(world));
    for (let i = 0; i < 3; i++) {
      const level = levels[i];
      this.sectors[i].flag.set(level === 2 ? 'double' : level === 1 ? 'yellow' : null);
      const chip = this.flagChips[i];
      chip.show.set(level > 0);
      if (level > 0) {
        chip.text.set(sectorFlagLabel(i, level));
        chip.level.set(String(level));
      }
    }
  }

  private updatePit(car: CarEntry, ctx: TimingContext): void {
    const pit = car.pit;
    const label = COMPOUND_INFO[pit.nextCompound]?.label ?? '';
    let text = '';
    let state: string | null = null;
    switch (pit.phase) {
      case 'entry':
        text = car.assists.pitAssist === false && !car.phys.limiter ? '限速線前開啟限速器' : '進入維修道';
        state = 'lane';
        break;
      case 'lane':
        text = `維修道限速 ${displaySpeed(ctx.pitLimit, ctx.units)} ${unitLabel(ctx.units)}`;
        state = 'lane';
        break;
      case 'stopped':
        text = `停站中 ${Math.max(0, fin(pit.timer)).toFixed(1)} 秒`;
        state = 'stop';
        break;
      case 'exit':
        text = '駛出維修道';
        state = 'lane';
        break;
      default:
        if (pit.requested && car.status !== 'finished' && car.status !== 'retired') {
          text = `本圈進站 · ${label}`;
          state = 'box';
        }
    }
    this.pitPill.set(state !== null);
    this.pitState.set(state);
    this.pitText.set(text);
  }
}

function gapText(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  return `${formatSeconds(sec)} 秒`;
}
