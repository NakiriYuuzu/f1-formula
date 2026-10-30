/**
 * Per-player HUD for one view region (full screen or a split-screen half): telemetry cluster, timing panel with
 * live delta, toasts, team radio, MFD, first-sessions key hints and a view banner. Split-screen halves use the
 * compact layout. Spectating (the player's car out of a multiplayer race) the cluster and timing show the watched
 * car, the MFD gives way to a 觀戰中 card (who, where, the switch keys).
 */
import type { BuiltTrack, CarEntry, DamageState, ErsMode, SpeedUnit, TireCompound, WorldState } from '../../core/types';
import type { HelpRow } from './controls';
import { AttrSlot, ShowSlot, StyleSlot, TextSlot, el } from './dom';
import { DeltaTracker } from './delta';
import type { LapTrace } from './delta';
import { Banner, RadioPanel, ToastStack } from './feed';
import type { Tone } from './feed';
import { HintStrip } from './hintStrip';
import { DAMAGE_PART_LABEL, fin, safeColor } from './labels';
import { MfdPanel } from './mfd';
import { FlagStack } from './raceControl';
import { TelemetryPanel, type FuelEstimator } from './telemetry';
import { TimingPanel } from './timing';

export interface ViewRegion {
  playerIndex: 0 | 1;
  carId: number;
  region: 'full' | 'left' | 'right';
}

export interface ViewActions {
  requestPit(carId: number, compound: TireCompound): void;
  cancelPit(carId: number): void;
  setErsMode(carId: number, mode: ErsMode): void;
}

/** Data shared by every view for one frame. */
export interface ViewFrame {
  order: readonly CarEntry[];
  overallBestSectors: readonly (number | null)[];
  /** time-trial ghost reference (null outside time trial) */
  ghost: LapTrace | null;
  units: SpeedUnit;
  telemetry: boolean;
}

/** 80 km/h, used if the track has no pit data. */
const PIT_LIMIT_FALLBACK = 80 / 3.6;
/** Minimum spacing between damage toasts for the same part unless the damage grows a lot. */
const DAMAGE_TOAST_GAP = 2.5;

export class ViewHud {
  readonly el: HTMLElement;
  readonly toasts: ToastStack;
  readonly radio: RadioPanel;
  readonly mfd: MfdPanel;
  readonly banner: Banner;
  /** first-sessions essential-keys strip, below the radio / MFD stack */
  readonly hints: HintStrip;
  private readonly flags: FlagStack;
  private readonly telemetry: TelemetryPanel;
  private readonly timing: TimingPanel;
  private readonly teleShow: ShowSlot;
  private readonly noCar: AttrSlot;
  private readonly watchCard: WatchCard;
  /** car shown instead of the player's own while spectating (null = the own car) */
  private watched: number | null = null;
  /** the own car's live delta and fuel measure, kept aside while spectating (back after a split-screen flashback) */
  private ownMeasures: { delta: DeltaTracker | null; fuel: FuelEstimator } | null = null;
  private delta: DeltaTracker | null = null;
  private clock = 0;
  private readonly damageAt: Record<keyof DamageState, number> = {
    frontWing: -Infinity,
    rearWing: -Infinity,
    floor: -Infinity,
    suspension: -Infinity,
  };
  private readonly damageLevel: Record<keyof DamageState, number> = { frontWing: 0, rearWing: 0, floor: 0, suspension: 0 };

  constructor(
    parent: Element,
    readonly view: ViewRegion,
    private readonly track: BuiltTrack,
    pitLoss: number,
    actions: ViewActions,
  ) {
    const compact = view.region !== 'full';
    this.el = el('div', 'nvh-view', parent);
    this.el.dataset.region = view.region;
    this.el.dataset.player = String(view.playerIndex);
    if (compact) this.el.dataset.compact = '1';
    this.noCar = new AttrSlot(this.el, 'data-nocar');
    el('div', 'nvh-view-tag', this.el, `P${view.playerIndex + 1}`);

    this.timing = new TimingPanel(this.el);
    this.telemetry = new TelemetryPanel(this.el);
    this.teleShow = new ShowSlot(this.telemetry.el);
    this.flags = new FlagStack(this.el);
    this.toasts = new ToastStack(this.el);
    const bottom = el('div', 'nvh-bc', this.el);
    this.radio = new RadioPanel(bottom);
    const carId = view.carId;
    this.mfd = new MfdPanel(
      bottom,
      {
        requestPit: (compound) => actions.requestPit(carId, compound),
        cancelPit: () => actions.cancelPit(carId),
        setErsMode: (mode) => actions.setErsMode(carId, mode),
      },
      pitLoss,
      !compact ? 'all' : view.playerIndex === 0 ? 'digit' : 'numpad',
    );
    this.watchCard = new WatchCard(bottom);
    this.hints = new HintStrip(bottom);
    this.banner = new Banner(this.el);
  }

  /** Car the cluster and timing show: the watched one while spectating, else the player's own. */
  get shownCarId(): number {
    return this.watched ?? this.view.carId;
  }

  get watching(): boolean {
    return this.watched !== null;
  }

  /** Spectating: show car `carId` instead of the player's own (null = back to it); `keys` = the switch keys. */
  watch(carId: number | null, keys: readonly HelpRow[]): void {
    if (carId !== this.watched) {
      const kept = this.ownMeasures;
      if (this.watched === null) this.ownMeasures = { delta: this.delta, fuel: this.telemetry.swapFuelMeasure() };
      else if (carId !== null) this.telemetry.swapFuelMeasure();
      this.watched = carId;
      if (carId === null && kept) {
        this.delta = kept.delta;
        this.telemetry.swapFuelMeasure(kept.fuel);
        this.ownMeasures = null;
      } else {
        // another car: its live delta and fuel use are measured afresh
        this.delta = null;
        this.mfd.close();
      }
    }
    this.watchCard.setKeys(keys);
    this.watchCard.show.set(carId !== null);
  }

  /** Feeds (toasts, radio, banner, hints) advance even during replays so nothing gets stuck on screen. */
  tickFeeds(dt: number): void {
    this.clock += dt;
    this.toasts.update(dt);
    this.radio.update(dt);
    this.banner.update(dt);
    this.hints.update(dt);
  }

  update(world: WorldState, dt: number, frame: ViewFrame): void {
    const car = world.cars[this.shownCarId];
    this.noCar.set(car ? null : '1');
    if (!car) {
      this.flags.hide();
      return;
    }
    if (!this.delta) this.delta = new DeltaTracker(this.track.length, frame.ghost);
    const delta = this.delta.update(car.timing, world.time, car.phys.s);
    this.teleShow.set(frame.telemetry);
    if (frame.telemetry) this.telemetry.update(car, world, frame.units, this.track.length);
    this.timing.update(car, world, dt, {
      order: frame.order,
      overallBestSectors: frame.overallBestSectors,
      delta,
      deltaRef: this.delta.reference,
      units: frame.units,
      pitLimit: fin(this.track.pit?.speedLimit, PIT_LIMIT_FALLBACK),
    });
    if (this.watched === null) this.mfd.sync(car, world);
    else this.watchCard.update(car, world);
    this.flags.update(car, world);
  }

  toast(title: string, sub: string, tone: Tone, duration?: number): void {
    this.toasts.push(title, sub, tone, duration);
  }

  /** Damage report, rate-limited per part. */
  damage(part: keyof DamageState, level: number): void {
    const v = fin(level);
    if (v < 0.05) {
      this.damageLevel[part] = v;
      return;
    }
    const grewALot = v - this.damageLevel[part] >= 0.2;
    if (this.clock - this.damageAt[part] < DAMAGE_TOAST_GAP && !grewALot) return;
    this.damageAt[part] = this.clock;
    this.damageLevel[part] = v;
    const pct = Math.round(Math.min(1, v) * 100);
    const advice =
      v < 0.35 ? '' : part === 'frontWing' ? '建議進站更換前翼' : part === 'suspension' ? '抓地力下降，維修站無法修復' : '建議進站維修';
    this.toasts.push(`${DAMAGE_PART_LABEL[part]}受損 ${pct}%`, advice, v >= 0.6 ? 'bad' : 'warn');
  }
}

/** 觀戰中 card (bottom stack, in place of the MFD): the watched car's position, driver and team, and the switch keys. */
class WatchCard {
  readonly el: HTMLElement;
  readonly show: ShowSlot;
  private readonly pos: TextSlot;
  private readonly name: TextSlot;
  private readonly team: TextSlot;
  private readonly human: ShowSlot;
  private readonly color: StyleSlot;
  private readonly keys: HTMLElement;
  private keysText = '';

  constructor(parent: Element) {
    this.el = el('div', 'nvh-watch', parent);
    const head = el('div', 'nvh-watch-head', this.el);
    el('span', 'nvh-watch-title', head, '觀戰中');
    this.pos = new TextSlot(el('span', 'nvh-watch-pos', head));
    const car = el('div', 'nvh-watch-car', this.el);
    this.color = new StyleSlot(car, '--nvh-team');
    this.name = new TextSlot(el('span', 'nvh-watch-name', car));
    this.human = new ShowSlot(el('span', 'nvh-watch-human', car, '玩家'));
    this.team = new TextSlot(el('div', 'nvh-watch-team', this.el));
    this.keys = el('div', 'nvh-hint-items nvh-watch-keys', this.el);
    this.show = new ShowSlot(this.el);
    this.show.set(false);
  }

  setKeys(items: readonly HelpRow[]): void {
    const text = JSON.stringify(items);
    if (text === this.keysText) return;
    this.keysText = text;
    this.keys.replaceChildren();
    for (const item of items) {
      if (item.keys.length === 0) continue;
      const node = el('div', 'nvh-hint-item', this.keys);
      el('span', 'nvh-hint-label', node, item.label);
      for (const k of item.keys) el('kbd', 'nvh-key', node, k);
    }
  }

  update(car: CarEntry, world: WorldState): void {
    const pos = Math.max(0, Math.round(fin(car.timing.position)));
    this.pos.set(car.status === 'finished' ? `P${pos}・完賽` : pos > 0 ? `P${pos}` : '');
    this.name.set(`${car.abbr}　${car.displayName}`);
    this.team.set(world.config.teams.find((t) => t.id === car.teamId)?.name ?? '');
    this.human.set(car.playerIndex >= 0);
    this.color.set(safeColor(car.livery?.primary));
  }
}
