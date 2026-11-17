/**
 * The touch deck: one control per TOUCH_CONTROLS row inside the HUD root, above the HUD widgets and under the pause
 * and help overlays, with every finger routed to the TouchPort. Its DOM is built on the first sync with a context, so
 * a keyboard or gamepad session never gets one. The deck is the only writer of `.nvh-root[data-touch]`.
 *
 * Every way of hiding it (pause, replay, a mode flip) goes through sync(null) → port.setLive(false), and a control
 * that turns invisible under a finger is released through port.releaseControl(id): no stuck hold, no press.
 */
import { clamp } from '../../core/math';
import { steerTravel, type PedalSpan, type TouchContact, type TouchPort } from '../../input/touch';
import { AttrSlot, ShowSlot, StyleSlot, TextSlot, el } from './dom';
import { TOUCH_CONTROLS, controlVisible, type TouchContext, type TouchControlDef, type TouchZone } from './touchLayout';

/** Shown while tilt steering reads the screen as lying flat (no defined roll, steer 0). */
export const TILT_FLAT_TEXT = '請將裝置立起';

interface StickView {
  active: AttrSlot;
  /** the stick's centre, px from the surface's left edge */
  origin: StyleSlot;
  /** finger offset -1..1 of full travel */
  offset: StyleSlot;
  /** the surface's left edge (client px), measured at the steering finger-down */
  left: number;
}

interface WheelView {
  angle: StyleSlot;
  flat: AttrSlot;
}

interface ControlView {
  def: TouchControlDef;
  node: HTMLElement;
  show: ShowSlot;
  label: TextSlot;
  lit: AttrSlot;
  visible: boolean;
  stick: StickView | null;
  wheel: WheelView | null;
}

interface DeckDom {
  root: HTMLElement;
  show: ShowSlot;
  steering: AttrSlot;
  controls: ControlView[];
  byId: Map<string, ControlView>;
}

function isPedalAction(action: string | null): action is PedalSpan['action'] {
  return action === 'brake' || action === 'throttle';
}

export class TouchDeck {
  private dom: DeckDom | null = null;
  private readonly touchAttr: AttrSlot;
  private destroyed = false;

  constructor(
    private readonly hudRoot: HTMLElement,
    private readonly port: TouchPort,
  ) {
    this.touchAttr = new AttrSlot(hudRoot, 'data-touch');
  }

  /** Once per frame. null hides the deck (keyboard / gamepad mode, paused, replay) and lets every finger go. */
  sync(ctx: TouchContext | null): void {
    if (this.destroyed) return;
    if (!ctx) {
      this.port.setLive(false);
      this.touchAttr.set(null);
      this.dom?.show.set(false);
      return;
    }
    const dom = (this.dom ??= this.build());
    this.port.setLive(true);
    this.touchAttr.set('1');
    dom.show.set(true);
    dom.steering.set(ctx.steering);
    let indicators = false;
    for (const c of dom.controls) {
      const visible = controlVisible(c.def, ctx);
      if (c.visible && !visible) this.port.releaseControl(c.def.id);
      c.visible = visible;
      c.show.set(visible);
      if (!visible) continue;
      if (typeof c.def.label === 'function') c.label.set(c.def.label(ctx));
      c.lit.set(c.def.lit?.(ctx) ? '1' : null);
      if (c.stick || c.wheel) indicators = true;
    }
    if (indicators) this.syncIndicators(dom);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.port.setLive(false);
    this.touchAttr.set(null);
    this.dom?.root.remove();
    this.dom = null;
  }

  private build(): DeckDom {
    const root = el('div', 'nvt', this.hudRoot);
    const zones = new Map<TouchZone, HTMLElement>();
    const controls = TOUCH_CONTROLS.map((def) => {
      let zone = zones.get(def.zone);
      if (!zone) {
        zone = el('div', 'nvt-zone', root);
        zone.dataset.zone = def.zone;
        zones.set(def.zone, zone);
      }
      return this.buildControl(def, zone);
    });
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      root.addEventListener(name, this.onPointer, name === 'pointerdown' ? { passive: false } : undefined);
    }
    const show = new ShowSlot(root);
    return { root, show, steering: new AttrSlot(root, 'data-steering'), controls, byId: new Map(controls.map((c) => [c.def.id, c])) };
  }

  private buildControl(def: TouchControlDef, zone: HTMLElement): ControlView {
    const node = el('button', 'nvt-ctl', zone);
    node.type = 'button';
    node.tabIndex = -1;
    node.dataset.control = def.id;
    node.dataset.kind = def.kind;
    const label = new TextSlot(el('span', 'nvt-label', node));
    if (typeof def.label === 'string') label.set(def.label);
    let stick: StickView | null = null;
    let wheel: WheelView | null = null;
    if (def.kind === 'surface') {
      const base = el('span', 'nvt-stick', node);
      el('span', 'nvt-knob', base);
      stick = { active: new AttrSlot(node, 'data-drag'), origin: new StyleSlot(node, '--nvt-ox'), offset: new StyleSlot(node, '--nvt-dx'), left: 0 };
    } else if (def.kind === 'indicator') {
      el('span', 'nvt-wheel', node);
      el('span', 'nvt-flat', node, TILT_FLAT_TEXT);
      wheel = { angle: new StyleSlot(node, '--nvt-steer'), flat: new AttrSlot(node, 'data-flat') };
    } else if (def.kind === 'permission') {
      // iOS grants the motion prompt only to a user activation, which a click carries and a pointerdown does not
      node.addEventListener('click', () => this.port.enableTilt());
    }
    const show = new ShowSlot(node);
    show.set(false);
    return { def, node, show, label, lit: new AttrSlot(node, 'data-lit'), visible: false, stick, wheel };
  }

  private syncIndicators(dom: DeckDom): void {
    const view = this.port.view();
    for (const c of dom.controls) {
      if (!c.visible) continue;
      if (c.stick) {
        const drag = view.drag;
        c.stick.active.set(drag ? '1' : null);
        if (drag) {
          c.stick.origin.set(`${Math.round(drag.origin - c.stick.left)}px`);
          c.stick.offset.set(clamp(drag.travel > 0 ? (drag.x - drag.origin) / drag.travel : 0, -1, 1).toFixed(3));
        }
      }
      if (c.wheel) {
        c.wheel.angle.set(clamp(view.steer, -1, 1).toFixed(3));
        c.wheel.flat.set(view.flat ? '1' : null);
      }
    }
  }

  /** What a finger on this control is; null for the controls a finger does not hold (tilt indicator, permission chip). */
  private contact(c: ControlView, x: number): TouchContact | null {
    const { def, node } = c;
    switch (def.kind) {
      case 'surface': {
        const rect = node.getBoundingClientRect();
        if (c.stick) c.stick.left = rect.left;
        return { kind: 'steer', x, travel: steerTravel(rect.width) };
      }
      case 'pedal':
        return { kind: 'pedal', x, spans: this.pedalSpans(def.zone) };
      case 'tap':
      case 'hold':
        return def.action ? { kind: 'button', control: def.id, action: def.action, hold: def.kind === 'hold' } : null;
      default:
        return null;
    }
  }

  /** The visible pedals of a thumb zone, measured once per finger-down (the HUD dirties layout every frame). */
  private pedalSpans(zone: TouchZone): PedalSpan[] {
    const spans: PedalSpan[] = [];
    for (const c of this.dom?.controls ?? []) {
      const action = c.def.action;
      if (c.def.kind !== 'pedal' || c.def.zone !== zone || !c.visible || !isPedalAction(action)) continue;
      const rect = c.node.getBoundingClientRect();
      spans.push({ control: c.def.id, action, left: rect.left, right: rect.right });
    }
    return spans;
  }

  private readonly onPointer = (e: PointerEvent): void => {
    if (e.type !== 'pointerdown') {
      if (e.type === 'pointermove') this.port.move(e.pointerId, e.clientX);
      else this.port.up(e.pointerId);
      return;
    }
    const target = e.target as Partial<Element> | null;
    const node = target?.closest?.('[data-control]') as HTMLElement | null | undefined;
    const c = node ? this.dom?.byId.get(node.dataset.control ?? '') : undefined;
    if (!c) return;
    const contact = this.contact(c, e.clientX);
    if (!contact || !this.port.down(e.pointerId, contact)) return;
    c.node.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
}
