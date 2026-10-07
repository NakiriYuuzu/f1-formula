/**
 * Race start-lights overlay: five light pods mirroring session.lightsOn, then "熄燈出發！" after lights out.
 */
import type { WorldState } from '../../core/types';
import { AttrSlot, ShowSlot, TextSlot, el } from './dom';
import { redCount } from './raceControl';

const PODS = 5;
const GO_DURATION = 2.4;

export class StartLights {
  readonly el: HTMLElement;
  private readonly show: ShowSlot;
  private readonly lit: AttrSlot[] = [];
  private readonly goShow: ShowSlot;
  private readonly goText: TextSlot;
  private readonly caption: TextSlot;
  private readonly captionShow: ShowSlot;
  private readonly state: AttrSlot;
  /** lights sequence was observed (so lights-out is announced) */
  private armed = false;
  private goTimer = 0;
  /** the formation lap was observed (the unlit gantry is then shown on the grid, not before the lap) */
  private sawFormation = false;
  /** this start is a red-flag restart (control.counts.red > 0) */
  private restart = false;

  constructor(parent: Element) {
    this.el = el('div', 'nvh-lights');
    parent.appendChild(this.el);
    this.show = new ShowSlot(this.el);
    this.state = new AttrSlot(this.el, 'data-state');
    const gantry = el('div', 'nvh-lights-gantry', this.el);
    for (let i = 0; i < PODS; i++) {
      const pod = el('div', 'nvh-lights-pod', gantry);
      el('span', 'nvh-lamp', pod);
      el('span', 'nvh-lamp', pod);
      this.lit.push(new AttrSlot(pod, 'data-lit'));
    }
    const cap = el('div', 'nvh-lights-caption', this.el);
    this.caption = new TextSlot(cap);
    this.captionShow = new ShowSlot(cap);
    this.captionShow.set(false);
    const go = el('div', 'nvh-lights-go', this.el);
    this.goText = new TextSlot(go);
    this.goText.set('熄燈出發！');
    this.goShow = new ShowSlot(go);
    this.goShow.set(false);
    this.show.set(false);
  }

  /** Lights-out event (may arrive before the phase change is observed). */
  lightsOut(): void {
    if (!this.armed) return;
    this.armed = false;
    this.goTimer = GO_DURATION;
  }

  update(world: WorldState, dt: number): void {
    const s = world.session;
    if (s.phase === 'formation') this.sawFormation = true;
    const beforeFormation = s.phase === 'pre' && world.config?.rules?.formationLap === true && !this.sawFormation;
    const waiting = s.kind === 'race' && !beforeFormation && (s.phase === 'pre' || s.phase === 'lights');
    if (waiting) {
      this.restart = redCount(world) > 0;
      const caption = [this.restart ? '重新起跑' : '', world.config?.sprint ? '衝刺賽' : ''].filter(Boolean).join(' · ');
      this.caption.set(caption);
      this.captionShow.set(caption !== '');
      this.goText.set(this.restart ? '重新起跑' : '熄燈出發！');
      this.armed = true;
      this.goTimer = 0;
      const on = Number.isFinite(s.lightsOn) ? Math.max(0, Math.min(PODS, Math.round(s.lightsOn))) : 0;
      for (let i = 0; i < PODS; i++) this.lit[i].set(i < on ? '1' : null);
      this.state.set('waiting');
      this.goShow.set(false);
      this.show.set(true);
      return;
    }
    if (this.armed) this.lightsOut();
    if (this.goTimer > 0) {
      this.goTimer -= dt;
      for (let i = 0; i < PODS; i++) this.lit[i].set(null);
      this.state.set('go');
      this.goShow.set(true);
      this.captionShow.set(false);
      this.show.set(this.goTimer > 0);
      return;
    }
    this.captionShow.set(false);
    this.show.set(false);
  }

  reset(): void {
    this.armed = false;
    this.goTimer = 0;
    this.show.set(false);
  }
}
