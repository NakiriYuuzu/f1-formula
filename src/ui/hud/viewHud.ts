/**
 * Per-player HUD for one view region (full screen or a split-screen half): telemetry cluster, timing panel with
 * live delta, toasts, team radio, MFD, first-sessions key hints and a view banner. Split-screen halves use the
 * compact layout.
 */
import type { BuiltTrack, CarEntry, DamageState, ErsMode, SpeedUnit, TireCompound, WorldState } from '../../core/types';
import { AttrSlot, ShowSlot, el } from './dom';
import { DeltaTracker } from './delta';
import type { LapTrace } from './delta';
import { Banner, RadioPanel, ToastStack } from './feed';
import type { Tone } from './feed';
import { HintStrip } from './hintStrip';
import { DAMAGE_PART_LABEL, fin } from './labels';
import { MfdPanel } from './mfd';
import { FlagStack } from './raceControl';
import { TelemetryPanel } from './telemetry';
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
    this.hints = new HintStrip(bottom);
    this.banner = new Banner(this.el);
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
    const car = world.cars[this.view.carId];
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
    this.mfd.sync(car, world);
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
