/**
 * Driver telemetry cluster (festival look): a round gauge with the rpm arc, shift-light dots above it, the speed in the
 * centre, the gear in a disc, throttle / brake / ERS arcs, and under it the overtake, DRS / 2026 straight-line mode,
 * limiter and aero-wake (tow / dirty air) pills; beside it a card: the tyre (compound, wear, temperature) on top, the
 * damage silhouette in the middle, fuel and its bar (what is left of the starting load) at the bottom. Arcs are SVG paths with pathLength 100, filled through stroke-dashoffset.
 */
import type { AeroWake, CarEntry, SpeedUnit, WorldState } from '../../core/types';
import { COMPOUND_INFO } from '../../core/defaults';
import { clamp01 } from '../../core/math';
import { fuelPerKm } from '../../physics/index';
import { AttrSlot, DashSlot, ScaleSlot, ShowSlot, TextSlot, el, svgEl } from './dom';
import { ERS_LABEL, damageBand, displaySpeed, fin, gearLabel, tempBand, unitLabel } from './labels';
import { tyreWindow } from './tyreWindow';

const LED_COLORS = ['g', 'g', 'g', 'g', 'r', 'r', 'r', 'b', 'b', 'b'] as const;
/** Fraction of the idle→shift range before the shift point where the first LED lights. */
const LED_SPAN = 0.28;
/** Aero-wake pill: shown above this speed (m/s) for a wake multiplier below WAKE_SHOWN; dirty air while cornering
 * above WAKE_CORNER_G (g), else the tow. */
const WAKE_MIN_SPEED = 30;
const WAKE_SHOWN = 0.97;
const WAKE_CORNER_G = 1.2;
/** Gauge arcs, in degrees clockwise from 3 o'clock on a 100 x 100 viewBox centred at 50,50 (y points down). */
const RPM_START = 135;
const RPM_SWEEP = 270;
/** The last stretch of the rpm arc (fraction of full scale) is drawn pink. */
const RPM_RED = 0.86;

/** SVG arc path from angle `a0` to `a1` (degrees, clockwise-positive) at radius `r`; the sweep follows the order. */
function arcPath(r: number, a0: number, a1: number): string {
  const pt = (a: number): string => `${(50 + r * Math.cos((a * Math.PI) / 180)).toFixed(2)} ${(50 + r * Math.sin((a * Math.PI) / 180)).toFixed(2)}`;
  return `M${pt(a0)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${pt(a1)}`;
}

/** A dim track plus its fill path (class `fill`), both pathLength 100; returns the fill. */
function arc(parent: Element, d: string, track: string, fill: string): SVGPathElement {
  svgEl('path', { d, class: track, pathLength: 100 }, parent);
  return svgEl('path', { d, class: fill, pathLength: 100 }, parent);
}

/** Aero-wake pill content for a car (null = clean air, slow, or the rule is off). */
export function wakeIndicator(wake: AeroWake | undefined, speed: number, gLat: number): { state: 'tow' | 'dirty'; text: string } | null {
  if (!wake || !(fin(speed) > WAKE_MIN_SPEED)) return null;
  if (fin(wake.frontDownforce, 1) < WAKE_SHOWN && Math.abs(fin(gLat)) > WAKE_CORNER_G) return { state: 'dirty', text: '髒空氣' };
  if (fin(wake.drag, 1) < WAKE_SHOWN) return { state: 'tow', text: '吸尾流' };
  return null;
}

/** Measures real fuel consumption per metre from consecutive frames, and the load the car started with. */
export class FuelEstimator {
  private prevFuel = NaN;
  private prevProgress = NaN;
  private usedFuel = 0;
  private usedDist = 0;
  private startFuel = 0;

  sample(fuelKg: number, progress: number, inPit: boolean): void {
    if (!Number.isFinite(fuelKg) || !Number.isFinite(progress)) return;
    if (fuelKg > this.startFuel) this.startFuel = fuelKg;
    const dF = this.prevFuel - fuelKg;
    const dP = progress - this.prevProgress;
    if (!inPit && dP > 0 && dP < 200 && dF >= 0 && dF < 2) {
      this.usedFuel += dF;
      this.usedDist += dP;
    }
    this.prevFuel = fuelKg;
    this.prevProgress = progress;
  }

  /** kg per metre (0 when fuel use is disabled); `nominal` (the car's expected use) until 800 m are measured. */
  rate(fuelEnabled: boolean, nominal: number): number {
    if (!fuelEnabled) return 0;
    if (this.usedDist > 800) return this.usedFuel / this.usedDist;
    return nominal;
  }

  /** What is left of the starting load, 0..1 (the fuel bar: full at the start, empty when the tank is dry). */
  level(fuelKg: number): number {
    return this.startFuel > 0 ? fuelKg / this.startFuel : 0;
  }
}

export class TelemetryPanel {
  readonly el: HTMLElement;
  private readonly shift: AttrSlot;
  private readonly leds: AttrSlot[] = [];
  private readonly gear: TextSlot;
  private readonly speed: TextSlot;
  private readonly unit: TextSlot;
  private readonly rpmLow: DashSlot;
  private readonly rpmRed: DashSlot;
  private readonly throttle: DashSlot;
  private readonly brake: DashSlot;
  private readonly ersPct: TextSlot;
  private readonly ersFill: DashSlot;
  private readonly ersMode: TextSlot;
  private readonly ersState: AttrSlot;
  private readonly drsLabel: TextSlot;
  private readonly drsState: AttrSlot;
  private readonly otState: AttrSlot;
  private readonly limiter: ShowSlot;
  private readonly wake: ShowSlot;
  private readonly wakeText: TextSlot;
  private readonly wakeState: AttrSlot;
  private readonly tyreBadge: TextSlot;
  private readonly tyreCompound: AttrSlot;
  private readonly tyreWear: TextSlot;
  private readonly tyreTemp: TextSlot;
  private readonly tyreTempBand: AttrSlot;
  private readonly tyreLaps: TextSlot;
  private readonly tyreBand: AttrSlot;
  private readonly dmgFront: AttrSlot;
  private readonly dmgRear: AttrSlot;
  private readonly dmgFloor: AttrSlot;
  private readonly dmgSusp: AttrSlot;
  private readonly fuelKg: TextSlot;
  private readonly fuelLaps: TextSlot;
  private readonly fuelMargin: TextSlot;
  private readonly fuelMarginState: AttrSlot;
  private readonly fuelFill: ScaleSlot;
  private readonly fuelBarState: AttrSlot;
  private fuelEst = new FuelEstimator();

  constructor(parent: Element) {
    this.el = el('div', 'nvh-tele', parent);

    // Left column: shift dots, the round gauge, the ERS readout and the pills.
    const col = el('div', 'nvh-gw', this.el);
    this.ersState = new AttrSlot(col, 'data-mode');
    const shift = el('div', 'nvh-shift', col);
    this.shift = new AttrSlot(shift, 'data-flash');
    for (const c of LED_COLORS) {
      const led = el('span', 'nvh-led', shift);
      led.dataset.c = c;
      this.leds.push(new AttrSlot(led, 'data-on'));
    }

    const gauge = el('div', 'nvh-gauge', col);
    const dialSvg = svgEl('svg', { viewBox: '0 0 100 100', class: 'nvh-gauge-svg', 'aria-hidden': 'true' }, gauge);
    const redAt = RPM_START + RPM_SWEEP * RPM_RED;
    const lowFill = arc(dialSvg, arcPath(44, RPM_START, redAt), 'nvh-arc-track', 'nvh-arc-fill nvh-rpm-fill');
    const redFill = arc(dialSvg, arcPath(44, redAt, RPM_START + RPM_SWEEP), 'nvh-arc-track nvh-arc-red', 'nvh-arc-fill nvh-rpm-fill nvh-rpm-red');
    this.rpmLow = new DashSlot(lowFill);
    this.rpmRed = new DashSlot(redFill);
    // throttle fills up the left side from the bottom, brake up the right side
    this.throttle = new DashSlot(arc(dialSvg, arcPath(34, 135, 225), 'nvh-arc-track nvh-arc-thin', 'nvh-arc-fill nvh-arc-thin nvh-arc-thr'));
    this.brake = new DashSlot(arc(dialSvg, arcPath(34, 45, -45), 'nvh-arc-track nvh-arc-thin', 'nvh-arc-fill nvh-arc-thin nvh-arc-brk'));
    // ERS under the gear, filling left to right
    this.ersFill = new DashSlot(arc(dialSvg, arcPath(44, 118, 62), 'nvh-arc-track nvh-arc-ers-track', 'nvh-arc-fill nvh-ers-fill'));

    const dial = el('div', 'nvh-dial', gauge);
    const spd = el('div', 'nvh-speed', dial);
    this.speed = new TextSlot(el('span', 'nvh-speed-num', spd));
    this.unit = new TextSlot(el('span', 'nvh-speed-unit', spd));
    this.gear = new TextSlot(el('div', 'nvh-gear', dial));

    const ersHead = el('div', 'nvh-ers-head', col);
    el('span', 'nvh-ers-tag', ersHead, 'ERS');
    this.ersMode = new TextSlot(el('span', 'nvh-ers-mode', ersHead));
    this.ersPct = new TextSlot(el('span', 'nvh-ers-pct', ersHead));

    const pills = el('div', 'nvh-pills', col);
    const drs = el('div', 'nvh-pill', pills);
    drs.dataset.k = 'drs';
    this.drsLabel = new TextSlot(drs);
    this.drsState = new AttrSlot(drs, 'data-state');
    const ot = el('div', 'nvh-pill', pills, '超車加力');
    ot.dataset.k = 'ot';
    this.otState = new AttrSlot(ot, 'data-state');
    const lim = el('div', 'nvh-pill', pills, '限速器');
    lim.dataset.k = 'lim';
    lim.dataset.state = 'on';
    this.limiter = new ShowSlot(lim);
    const wake = el('div', 'nvh-pill', pills);
    wake.dataset.k = 'wake';
    this.wake = new ShowSlot(wake);
    this.wakeText = new TextSlot(wake);
    this.wakeState = new AttrSlot(wake, 'data-state');

    // Right column: the card. Tyre on top, the damage silhouette in the middle, fuel at the bottom with its bar last.
    const carRow = el('div', 'nvh-car-row nvh-panel', this.el);
    const svg = svgEl('svg', { viewBox: '0 0 40 84', class: 'nvh-car', 'aria-hidden': 'true' }, carRow);
    const tyres = svgEl('g', { class: 'nvh-car-tyres' }, svg);
    for (const [x, y, w, h] of [
      [2, 14, 7, 13],
      [31, 14, 7, 13],
      [1, 55, 8, 15],
      [31, 55, 8, 15],
    ]) {
      svgEl('rect', { x, y, width: w, height: h, rx: 2 }, tyres);
    }
    this.tyreBand = new AttrSlot(tyres, 'data-band');
    // suspension arms (wheel to body)
    const susp = svgEl('g', { class: 'nvh-car-susp' }, svg);
    for (const d of ['M9 20.5L17 22', 'M31 20.5L23 22', 'M9 62.5L14 62', 'M31 62.5L26 62']) svgEl('path', { d }, susp);
    this.dmgSusp = new AttrSlot(susp, 'data-dmg');
    const floor = svgEl('path', { d: 'M18 9h4l1 13 2 8 5 6v22l-4 10H14l-4-10V36l5-6 2-8z', class: 'nvh-car-body' }, svg);
    this.dmgFloor = new AttrSlot(floor, 'data-dmg');
    svgEl('ellipse', { cx: 20, cy: 39, rx: 2.6, ry: 4.2, class: 'nvh-car-cockpit' }, svg);
    const fw = svgEl('rect', { x: 5, y: 3, width: 30, height: 5.5, rx: 1.2, class: 'nvh-car-wing' }, svg);
    this.dmgFront = new AttrSlot(fw, 'data-dmg');
    const rw = svgEl('rect', { x: 8, y: 72, width: 24, height: 6, rx: 1.2, class: 'nvh-car-wing' }, svg);
    this.dmgRear = new AttrSlot(rw, 'data-dmg');

    const tyre = el('div', 'nvh-tyre', carRow);
    const badge = el('div', 'nvh-tyre-badge', tyre);
    this.tyreBadge = new TextSlot(badge);
    this.tyreCompound = new AttrSlot(badge, 'data-compound');
    const tInfo = el('div', 'nvh-tyre-info', tyre);
    const wearRow = el('div', 'nvh-kv', tInfo);
    el('span', 'nvh-k', wearRow, '磨耗');
    this.tyreWear = new TextSlot(el('span', 'nvh-v', wearRow));
    const tempRow = el('div', 'nvh-kv', tInfo);
    el('span', 'nvh-k', tempRow, '胎溫');
    const tempV = el('span', 'nvh-v nvh-temp', tempRow);
    this.tyreTemp = new TextSlot(tempV);
    this.tyreTempBand = new AttrSlot(tempV, 'data-band');
    const lapsRow = el('div', 'nvh-kv', tInfo);
    el('span', 'nvh-k', lapsRow, '使用');
    this.tyreLaps = new TextSlot(el('span', 'nvh-v', lapsRow));

    const fuel = el('div', 'nvh-fuel', carRow);
    const fuelHead = el('div', 'nvh-kv', fuel);
    el('span', 'nvh-k', fuelHead, '燃油');
    this.fuelKg = new TextSlot(el('span', 'nvh-fuel-kg', fuelHead));
    const fuelFoot = el('div', 'nvh-kv', fuel);
    this.fuelLaps = new TextSlot(el('span', 'nvh-fuel-laps', fuelFoot));
    const margin = el('span', 'nvh-fuel-margin', fuelFoot);
    this.fuelMargin = new TextSlot(margin);
    this.fuelMarginState = new AttrSlot(margin, 'data-state');
    const bar = el('div', 'nvh-fuel-bar', fuel);
    this.fuelFill = new ScaleSlot(el('div', 'nvh-fuel-fill', bar), 'x');
    this.fuelBarState = new AttrSlot(bar, 'data-state');
  }

  /** Another car is shown from now on (spectating): measure its fuel use with `next`; returns the replaced measure. */
  swapFuelMeasure(next: FuelEstimator = new FuelEstimator()): FuelEstimator {
    const prev = this.fuelEst;
    this.fuelEst = next;
    return prev;
  }

  update(car: CarEntry, world: WorldState, units: SpeedUnit, trackLength: number): void {
    const p = car.phys;
    const spec = car.spec;
    const reg2026 = world.config.regulation === '2026';

    // Speed, gear, rpm, shift lights.
    this.speed.set(String(displaySpeed(p.speed, units)));
    this.unit.set(unitLabel(units));
    this.gear.set(gearLabel(p.gear));
    const rpm = Math.max(0, fin(p.rpm));
    const maxRpm = fin(spec.maxRpm) > 0 ? spec.maxRpm : 12000;
    const idle = Math.min(Math.max(0, fin(spec.idleRpm)), maxRpm * 0.6);
    const shiftRpm = fin(spec.shiftRpm) > idle && spec.shiftRpm <= maxRpm ? spec.shiftRpm : maxRpm * 0.93;
    const rpmFrac = rpm / maxRpm;
    this.rpmLow.set(rpmFrac / RPM_RED);
    this.rpmRed.set((rpmFrac - RPM_RED) / (1 - RPM_RED));
    const ledStart = shiftRpm - (shiftRpm - idle) * LED_SPAN;
    const ledFrac = shiftRpm > ledStart ? clamp01((rpm - ledStart) / (shiftRpm - ledStart)) : 0;
    const litCount = Math.round(ledFrac * LED_COLORS.length);
    for (let i = 0; i < this.leds.length; i++) this.leds[i].set(i < litCount ? '1' : null);
    const topGear = Array.isArray(spec.gearRatios) && spec.gearRatios.length > 0 ? spec.gearRatios.length : 8;
    this.shift.set(rpm >= shiftRpm && p.gear >= 1 && p.gear < topGear ? '1' : null);

    this.throttle.set(fin(p.throttle));
    this.brake.set(fin(p.brake));

    // ERS / overtake / DRS / limiter.
    const charge = clamp01(fin(p.ers.charge));
    this.ersPct.set(`${Math.round(charge * 100)}%`);
    this.ersFill.set(charge);
    this.ersMode.set(ERS_LABEL[p.ers.mode] ?? '');
    this.ersState.set(p.ers.mode);
    this.otState.set(p.ers.overtakeActive ? 'active' : p.ers.overtakeAvailable ? 'available' : 'off');
    this.drsLabel.set(reg2026 ? '直線模式' : 'DRS');
    this.drsState.set(p.drs.open ? 'open' : p.drs.available ? 'available' : p.drs.eligible ? 'eligible' : 'off');
    this.limiter.set(p.limiter);
    const racing = car.status === 'running' && car.pit.phase === 'none';
    const wake = racing ? wakeIndicator(car.race?.wake, p.speed, p.gLat) : null;
    this.wake.set(wake !== null);
    if (wake) {
      this.wakeText.set(wake.text);
      this.wakeState.set(wake.state);
    }

    // Tyres.
    const info = COMPOUND_INFO[p.tire.compound] ?? COMPOUND_INFO.medium;
    this.tyreBadge.set(info.letter);
    this.tyreCompound.set(p.tire.compound);
    this.tyreWear.set(`${Math.round(clamp01(fin(p.tire.wear)) * 100)}%`);
    const temp = fin(p.tire.temp);
    this.tyreTemp.set(`${Math.round(temp)}°C`);
    const band = tempBand(temp, tyreWindow(p.tire.compound));
    this.tyreTempBand.set(band);
    this.tyreBand.set(band);
    this.tyreLaps.set(`${Math.max(0, Math.round(fin(p.tire.laps)))} 圈`);

    // Damage.
    this.dmgFront.set(damageBand(p.damage.frontWing));
    this.dmgRear.set(damageBand(p.damage.rearWing));
    this.dmgFloor.set(damageBand(p.damage.floor));
    this.dmgSusp.set(damageBand(p.damage.suspension));

    // Fuel.
    const fuel = Math.max(0, fin(p.fuelKg));
    const inPit = car.pit.phase !== 'none';
    this.fuelEst.sample(fuel, car.timing.progress, inPit);
    this.fuelKg.set(`${fuel.toFixed(1)} kg`);
    this.fuelFill.set(this.fuelEst.level(fuel));
    const perLap = this.fuelEst.rate(world.config.rules.fuel, fuelPerKm(car.spec) / 1000) * trackLength;
    if (perLap > 1e-6 && Number.isFinite(perLap)) {
      const laps = fuel / perLap;
      this.fuelLaps.set(`可跑 ${laps.toFixed(1)} 圈`);
      if (world.session.kind === 'race' && trackLength > 0 && car.status !== 'finished' && car.status !== 'retired') {
        const remainDist = Math.max(0, world.session.totalLaps * trackLength - fin(car.timing.progress));
        const margin = laps - remainDist / trackLength;
        const state = margin < 0 ? 'short' : margin < 0.3 ? 'tight' : 'ok';
        this.fuelMargin.set(`${margin >= 0 ? '+' : '-'}${Math.abs(margin).toFixed(1)}`);
        this.fuelMarginState.set(state);
        this.fuelBarState.set(state);
      } else {
        this.fuelMargin.set('');
        this.fuelMarginState.set(null);
        this.fuelBarState.set(null);
      }
    } else {
      this.fuelLaps.set('不消耗');
      this.fuelMargin.set('');
      this.fuelMarginState.set(null);
      this.fuelBarState.set(null);
    }
  }
}
