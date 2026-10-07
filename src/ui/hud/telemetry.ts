/**
 * Driver telemetry cluster: speed, gear, rpm bar + shift lights, throttle/brake, ERS battery & mode,
 * overtake, DRS / 2026 straight-line mode, limiter, aero wake (tow / dirty air), tyre (compound, wear, temperature),
 * damage silhouette, fuel.
 */
import type { AeroWake, CarEntry, SpeedUnit, WorldState } from '../../core/types';
import { COMPOUND_INFO } from '../../core/defaults';
import { clamp01 } from '../../core/math';
import { fuelPerKm } from '../../physics/index';
import { AttrSlot, ScaleSlot, ShowSlot, TextSlot, el, svgEl } from './dom';
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

/** Aero-wake pill content for a car (null = clean air, slow, or the rule is off). */
export function wakeIndicator(wake: AeroWake | undefined, speed: number, gLat: number): { state: 'tow' | 'dirty'; text: string } | null {
  if (!wake || !(fin(speed) > WAKE_MIN_SPEED)) return null;
  if (fin(wake.frontDownforce, 1) < WAKE_SHOWN && Math.abs(fin(gLat)) > WAKE_CORNER_G) return { state: 'dirty', text: '髒空氣' };
  if (fin(wake.drag, 1) < WAKE_SHOWN) return { state: 'tow', text: '吸尾流' };
  return null;
}

/** Measures real fuel consumption per metre from consecutive frames. */
class FuelEstimator {
  private prevFuel = NaN;
  private prevProgress = NaN;
  private usedFuel = 0;
  private usedDist = 0;

  sample(fuelKg: number, progress: number, inPit: boolean): void {
    if (!Number.isFinite(fuelKg) || !Number.isFinite(progress)) return;
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
}

export class TelemetryPanel {
  readonly el: HTMLElement;
  private readonly shift: AttrSlot;
  private readonly leds: AttrSlot[] = [];
  private readonly gear: TextSlot;
  private readonly speed: TextSlot;
  private readonly unit: TextSlot;
  private readonly rpm: ScaleSlot;
  private readonly throttle: ScaleSlot;
  private readonly brake: ScaleSlot;
  private readonly ersPct: TextSlot;
  private readonly ersFill: ScaleSlot;
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
  private readonly fuelKg: TextSlot;
  private readonly fuelLaps: TextSlot;
  private readonly fuelMargin: TextSlot;
  private readonly fuelMarginState: AttrSlot;
  private readonly fuelEst = new FuelEstimator();

  constructor(parent: Element) {
    this.el = el('div', 'nvh-tele nvh-panel', parent);

    const shift = el('div', 'nvh-shift', this.el);
    this.shift = new AttrSlot(shift, 'data-flash');
    for (const c of LED_COLORS) {
      const led = el('span', 'nvh-led', shift);
      led.dataset.c = c;
      this.leds.push(new AttrSlot(led, 'data-on'));
    }

    const core = el('div', 'nvh-tele-core', this.el);
    const thr = el('div', 'nvh-pedal', core);
    thr.dataset.k = 'thr';
    this.throttle = new ScaleSlot(el('div', 'nvh-pedal-fill', thr), 'y');
    const dial = el('div', 'nvh-dial', core);
    this.gear = new TextSlot(el('div', 'nvh-gear', dial));
    const spd = el('div', 'nvh-speed', dial);
    this.speed = new TextSlot(el('span', 'nvh-speed-num', spd));
    this.unit = new TextSlot(el('span', 'nvh-speed-unit', spd));
    const rpm = el('div', 'nvh-rpm', dial);
    this.rpm = new ScaleSlot(el('div', 'nvh-rpm-fill', rpm), 'x');
    const brk = el('div', 'nvh-pedal', core);
    brk.dataset.k = 'brk';
    this.brake = new ScaleSlot(el('div', 'nvh-pedal-fill', brk), 'y');

    const sys = el('div', 'nvh-sys', this.el);
    const ers = el('div', 'nvh-ers', sys);
    this.ersState = new AttrSlot(ers, 'data-mode');
    const ersHead = el('div', 'nvh-ers-head', ers);
    el('span', 'nvh-ers-tag', ersHead, 'ERS');
    this.ersMode = new TextSlot(el('span', 'nvh-ers-mode', ersHead));
    this.ersPct = new TextSlot(el('span', 'nvh-ers-pct', ersHead));
    this.ersFill = new ScaleSlot(el('div', 'nvh-ers-fill', el('div', 'nvh-ers-bar', ers)), 'x');

    const pills = el('div', 'nvh-pills', sys);
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

    const carRow = el('div', 'nvh-car-row', this.el);
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
    el('div', 'nvh-k', fuel, '燃油');
    this.fuelKg = new TextSlot(el('div', 'nvh-fuel-kg', fuel));
    this.fuelLaps = new TextSlot(el('div', 'nvh-fuel-laps', fuel));
    const margin = el('div', 'nvh-fuel-margin', fuel);
    this.fuelMargin = new TextSlot(margin);
    this.fuelMarginState = new AttrSlot(margin, 'data-state');
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
    this.rpm.set(rpm / maxRpm);
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

    // Fuel.
    const fuel = Math.max(0, fin(p.fuelKg));
    const inPit = car.pit.phase !== 'none';
    this.fuelEst.sample(fuel, car.timing.progress, inPit);
    this.fuelKg.set(`${fuel.toFixed(1)} kg`);
    const perLap = this.fuelEst.rate(world.config.rules.fuel, fuelPerKm(car.spec) / 1000) * trackLength;
    if (perLap > 1e-6 && Number.isFinite(perLap)) {
      const laps = fuel / perLap;
      this.fuelLaps.set(`可跑 ${laps.toFixed(1)} 圈`);
      if (world.session.kind === 'race' && trackLength > 0 && car.status !== 'finished' && car.status !== 'retired') {
        const remainDist = Math.max(0, world.session.totalLaps * trackLength - fin(car.timing.progress));
        const margin = laps - remainDist / trackLength;
        this.fuelMargin.set(`${margin >= 0 ? '+' : '-'}${Math.abs(margin).toFixed(1)}`);
        this.fuelMarginState.set(margin < 0 ? 'short' : margin < 0.3 ? 'tight' : 'ok');
      } else {
        this.fuelMargin.set('');
        this.fuelMarginState.set(null);
      }
    } else {
      this.fuelLaps.set('不消耗');
      this.fuelMargin.set('');
      this.fuelMarginState.set(null);
    }
  }
}
