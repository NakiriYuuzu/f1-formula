/**
 * Session strip: session badge + layout name, weather icon (sun/moon/cloud/rain), air & track temperature
 * and standing water. Refreshed at 2 Hz.
 */
import type { BuiltTrack, TimeOfDay, WeatherKind, WorldState } from '../../core/types';
import { WEATHER_LABEL, fin, sessionLabel } from './labels';
import { AttrSlot, TextSlot, el, svgEl } from './dom';

const REFRESH = 0.5;

export class SessionStrip {
  readonly el: HTMLElement;
  private readonly kind: TextSlot;
  private readonly icon: SVGSVGElement;
  private readonly weatherLabel: TextSlot;
  private readonly temps: TextSlot;
  private readonly wet: TextSlot;
  private readonly wetState: AttrSlot;
  private iconKey = '';
  private accum = REFRESH;

  constructor(parent: Element, track: BuiltTrack) {
    this.el = el('div', 'nvh-session', parent);
    const top = el('div', 'nvh-session-top', this.el);
    this.kind = new TextSlot(el('span', 'nvh-session-kind', top));
    el('span', 'nvh-session-track', top, track.displayName || track.def.name);
    const wx = el('div', 'nvh-weather', this.el);
    this.icon = svgEl('svg', { viewBox: '0 0 24 24', class: 'nvh-weather-icon', 'aria-hidden': 'true' }, wx);
    this.weatherLabel = new TextSlot(el('span', 'nvh-weather-label', wx));
    this.temps = new TextSlot(el('span', 'nvh-weather-temps', wx));
    const wet = el('span', 'nvh-weather-wet', wx);
    this.wet = new TextSlot(wet);
    this.wetState = new AttrSlot(wet, 'data-show');
  }

  update(world: WorldState, dt: number): void {
    this.accum += dt;
    if (this.accum < REFRESH) return;
    this.accum = 0;
    const w = world.weather;
    this.kind.set(sessionLabel(world.session.kind, world.config?.sprint));
    this.weatherLabel.set(WEATHER_LABEL[w.kind] ?? '');
    this.temps.set(`氣溫 ${Math.round(fin(w.airTemp))}° · 賽道 ${Math.round(fin(w.trackTemp))}°`);
    const wetPct = Math.round(Math.max(0, Math.min(1, fin(w.wetness))) * 100);
    this.wet.set(`積水 ${wetPct}%`);
    this.wetState.set(wetPct >= 3 ? '1' : null);
    const key = `${w.kind}|${world.config.timeOfDay}`;
    if (key !== this.iconKey) {
      this.iconKey = key;
      drawWeatherIcon(this.icon, w.kind, world.config.timeOfDay);
    }
  }
}

/** Original line-art weather glyphs (24×24). */
function drawWeatherIcon(svg: SVGSVGElement, kind: WeatherKind, time: TimeOfDay): void {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const night = time === 'night';
  const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const cloudPath = 'M7 18h10.5a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 8.3 9.6 4.2 4.2 0 0 0 7 18z';
  if (kind === 'clear') {
    if (night) {
      svgEl('path', { ...stroke, d: 'M15.5 3.5a8 8 0 1 0 5 13.6A7 7 0 0 1 15.5 3.5z', class: 'nvh-wx-moon' }, svg);
    } else {
      svgEl('circle', { ...stroke, cx: 12, cy: 12, r: 4.2, class: 'nvh-wx-sun' }, svg);
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const x1 = 12 + Math.cos(a) * 7;
        const y1 = 12 + Math.sin(a) * 7;
        const x2 = 12 + Math.cos(a) * 9.5;
        const y2 = 12 + Math.sin(a) * 9.5;
        svgEl('line', { ...stroke, x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2), class: 'nvh-wx-sun' }, svg);
      }
    }
    return;
  }
  if (kind === 'overcast') {
    if (night) svgEl('path', { ...stroke, d: 'M17 2.5a5 5 0 1 0 4.5 7.2 4.4 4.4 0 0 1-4.5-7.2z', class: 'nvh-wx-moon' }, svg);
    else svgEl('circle', { ...stroke, cx: 17, cy: 7, r: 3, class: 'nvh-wx-sun' }, svg);
    svgEl('path', { ...stroke, d: cloudPath, class: 'nvh-wx-cloud' }, svg);
    return;
  }
  svgEl('path', { ...stroke, d: 'M7 15h10.5a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 8.3 6.6 4.2 4.2 0 0 0 7 15z', class: 'nvh-wx-cloud' }, svg);
  const drops = kind === 'heavyRain' ? [6, 9.5, 13, 16.5] : [8.5, 14];
  for (const x of drops) {
    svgEl('line', { ...stroke, x1: x, y1: 18, x2: x - 1.2, y2: 21.5, class: 'nvh-wx-rain' }, svg);
  }
}
