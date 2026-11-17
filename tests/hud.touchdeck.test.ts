/**
 * The touch deck on a minimal fake DOM with a recording TouchPort: no deck outside touch mode, one control per table
 * row, visibility and release on hide, the finger contacts pointer events produce, and the tilt chip's click.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TouchContact, TouchPort, TouchView } from '../src/input/touch';
import { steerTravel } from '../src/input/touch';
import { Banner } from '../src/ui/hud/feed';
import { HintStrip } from '../src/ui/hud/hintStrip';
import { TILT_FLAT_TEXT, TouchDeck } from '../src/ui/hud/touchDeck';
import { TOUCH_CONTROLS, touchHintItems, visibleControls, type TouchContext } from '../src/ui/hud/touchLayout';

interface FakeEvent {
  type: string;
  target: FakeEl;
  pointerId: number;
  clientX: number;
  prevented: boolean;
  preventDefault(): void;
}

class FakeEl {
  readonly classes = new Set<string>();
  readonly classList = {
    toggle: (c: string, on?: boolean): void => {
      if (on ?? !this.classes.has(c)) this.classes.add(c);
      else this.classes.delete(c);
    },
    add: (...c: string[]): void => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]): void => c.forEach((x) => this.classes.delete(x)),
    contains: (c: string): boolean => this.classes.has(c),
  };
  readonly style = {
    props: new Map<string, string>(),
    setProperty(k: string, v: string): void {
      this.props.set(k, v);
    },
  };
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  textContent = '';
  type = '';
  tabIndex = 0;
  listeners = new Map<string, ((e: FakeEvent) => void)[]>();
  rect = { left: 0, width: 100 };
  rectReads = 0;
  captured: number[] = [];
  constructor(readonly tag: string) {}
  set className(v: string) {
    this.classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this.classes.add(c);
  }
  get className(): string {
    return [...this.classes].join(' ');
  }
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  replaceChildren(): void {
    this.children = [];
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  closest(selector: string): FakeEl | null {
    if (selector !== '[data-control]') throw new Error(`unsupported selector ${selector}`);
    for (let n: FakeEl | null = this; n; n = n.parent) if (n.dataset.control !== undefined) return n;
    return null;
  }
  getBoundingClientRect(): { left: number; right: number; width: number } {
    this.rectReads++;
    return { left: this.rect.left, right: this.rect.left + this.rect.width, width: this.rect.width };
  }
  setPointerCapture(id: number): void {
    this.captured.push(id);
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => c.find(pred))];
  }
}

/** Dispatch on `target` and bubble to the root, as the browser does for pointer events. */
function fire(target: FakeEl, type: string, pointerId = 1, clientX = 0): FakeEvent {
  const e: FakeEvent = { type, target, pointerId, clientX, prevented: false, preventDefault: () => void (e.prevented = true) };
  for (let n: FakeEl | null = target; n; n = n.parent) for (const fn of n.listeners.get(type) ?? []) fn(e);
  return e;
}

class FakePort implements TouchPort {
  claim = true;
  live: boolean[] = [];
  downs: { id: number; contact: TouchContact }[] = [];
  moves: [number, number][] = [];
  ups: number[] = [];
  released: string[] = [];
  tiltRequests = 0;
  state: TouchView = { steering: 'drag', steer: 0, drag: null, flat: false };
  down(id: number, contact: TouchContact): boolean {
    this.downs.push({ id, contact });
    return this.claim;
  }
  move(id: number, x: number): void {
    this.moves.push([id, x]);
  }
  up(id: number): void {
    this.ups.push(id);
  }
  releaseControl(control: string): void {
    this.released.push(control);
  }
  setLive(live: boolean): void {
    this.live.push(live);
  }
  view(): TouchView {
    return this.state;
  }
  enableTilt(): void {
    this.tiltRequests++;
  }
}

const g = globalThis as unknown as { document?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.document;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
});
afterAll(() => {
  g.document = saved;
});

const driving = (patch: Partial<TouchContext> = {}): TouchContext => ({
  phase: 'driving',
  steering: 'drag',
  tiltPending: false,
  manualGearbox: false,
  drsManual: false,
  drsReady: false,
  overtakeReady: false,
  limiter: false,
  limiterOn: false,
  pit: true,
  boxCalled: false,
  flashback: true,
  reg2026: false,
  ...patch,
});

function make() {
  const hud = new FakeEl('div');
  const port = new FakePort();
  const deck = new TouchDeck(hud as unknown as HTMLElement, port);
  const deckEl = (): FakeEl | undefined => hud.children.find((c) => c.classes.has('nvt'));
  const control = (id: string): FakeEl => deckEl()!.find((e) => e.dataset.control === id)[0];
  const shown = (): string[] =>
    deckEl()!
      .find((e) => e.dataset.control !== undefined && !e.classes.has('nvh-hidden'))
      .map((e) => e.dataset.control);
  const label = (id: string): FakeEl => control(id).find((e) => e.classes.has('nvt-label'))[0];
  return { hud, port, deck, deckEl, control, shown, label };
}

describe('deck lifetime', () => {
  test('no deck element and no data-touch outside touch mode', () => {
    const { hud, port, deck } = make();
    for (let i = 0; i < 3; i++) deck.sync(null);
    expect(hud.children).toEqual([]);
    expect(hud.attrs.has('data-touch')).toBe(false);
    expect(port.live).toEqual([false, false, false]);
  });

  test('one control per table row, each in its zone, built on the first touch frame', () => {
    const { hud, deck, deckEl } = make();
    deck.sync(driving());
    expect(hud.attrs.get('data-touch')).toBe('1');
    const zones = deckEl()!.children;
    expect(zones.map((z) => z.dataset.zone)).toEqual(['sys', 'thumbL', 'thumbR']);
    const controls = zones.flatMap((z) => z.children.map((c) => ({ id: c.dataset.control, zone: z.dataset.zone, kind: c.dataset.kind })));
    expect(controls).toEqual(TOUCH_CONTROLS.map((r) => ({ id: r.id, zone: r.zone, kind: r.kind })));
    expect(deckEl()!.find((e) => e.tag === 'button').every((b) => b.type === 'button' && b.tabIndex === -1)).toBe(true);
    deck.sync(driving());
    expect(hud.children.filter((c) => c.classes.has('nvt')).length).toBe(1);
  });

  test('sync(null) lets every finger go, hides the deck and takes data-touch off; the next touch frame brings it back', () => {
    const { hud, port, deck, deckEl } = make();
    deck.sync(driving());
    expect(port.live.at(-1)).toBe(true);
    deck.sync(null);
    expect(port.live.at(-1)).toBe(false);
    expect(hud.attrs.has('data-touch')).toBe(false);
    expect(deckEl()!.classes.has('nvh-hidden')).toBe(true);
    deck.sync(driving());
    expect(port.live.at(-1)).toBe(true);
    expect(hud.attrs.get('data-touch')).toBe('1');
    expect(deckEl()!.classes.has('nvh-hidden')).toBe(false);
  });

  test('destroy lets go, removes the deck and ignores later frames', () => {
    const { hud, port, deck } = make();
    deck.sync(driving());
    deck.destroy();
    expect(port.live.at(-1)).toBe(false);
    expect(hud.children).toEqual([]);
    expect(hud.attrs.has('data-touch')).toBe(false);
    deck.sync(driving());
    expect(hud.children).toEqual([]);
  });
});

describe('deck visibility', () => {
  test('the rows the context shows, and no others', () => {
    const { deck, shown } = make();
    for (const c of [driving(), driving({ manualGearbox: true, drsManual: true, limiter: true }), driving({ steering: 'tilt' }), driving({ steering: 'buttons' }), driving({ phase: 'spectating' })]) {
      deck.sync(c);
      expect(shown()).toEqual(visibleControls(c).map((r) => r.id));
    }
  });

  test('a row that turns invisible lets its fingers go; rows that were never shown are not touched', () => {
    const { port, deck } = make();
    deck.sync(driving({ manualGearbox: true }));
    expect(port.released).toEqual([]);
    deck.sync(driving({ manualGearbox: false }));
    expect(port.released).toEqual(['shiftDown', 'shiftUp']);
    deck.sync(driving({ manualGearbox: false }));
    expect(port.released).toEqual(['shiftDown', 'shiftUp']);
  });

  test('a scheme change releases the old steering and brake rows', () => {
    const { port, deck } = make();
    deck.sync(driving({ steering: 'drag' }));
    deck.sync(driving({ steering: 'tilt' }));
    expect(port.released).toEqual(['steer', 'brake']);
  });

  test('labels follow the regulation and the ready glow follows the context', () => {
    const { deck, control, label } = make();
    deck.sync(driving({ drsManual: true }));
    expect(label('drs').textContent).toBe('DRS');
    expect(control('drs').attrs.has('data-lit')).toBe(false);
    deck.sync(driving({ drsManual: true, drsReady: true, reg2026: true }));
    expect(label('drs').textContent).toBe('直線模式');
    expect(control('drs').attrs.get('data-lit')).toBe('1');
    expect(label('throttle').textContent).toBe('油門');
  });
});

describe('deck fingers', () => {
  test('a finger on a pedal: the zone\'s pedals are measured once at finger-down, then it rolls on moves', () => {
    const { port, deck, control, label } = make();
    deck.sync(driving());
    control('brake').rect = { left: 500, width: 80 };
    control('throttle').rect = { left: 590, width: 90 };
    const down = fire(label('throttle'), 'pointerdown', 7, 620);
    expect(port.downs).toEqual([
      {
        id: 7,
        contact: {
          kind: 'pedal',
          x: 620,
          spans: [
            { control: 'brake', action: 'brake', left: 500, right: 580 },
            { control: 'throttle', action: 'throttle', left: 590, right: 680 },
          ],
        },
      },
    ]);
    expect(control('throttle').captured).toEqual([7]);
    expect(down.prevented).toBe(true);
    const reads = control('brake').rectReads + control('throttle').rectReads;
    fire(control('throttle'), 'pointermove', 7, 560);
    fire(control('throttle'), 'pointermove', 7, 540);
    expect(port.moves).toEqual([
      [7, 560],
      [7, 540],
    ]);
    expect(control('brake').rectReads + control('throttle').rectReads).toBe(reads);
  });

  test('tilt: the left brake rolls alone (the throttle is in the other zone)', () => {
    const { port, deck, control } = make();
    deck.sync(driving({ steering: 'tilt' }));
    fire(control('brakeL'), 'pointerdown', 2, 40);
    const contact = port.downs[0].contact;
    expect(contact.kind === 'pedal' && contact.spans.map((s) => s.control)).toEqual(['brakeL']);
  });

  test('the drag surface: travel from its width', () => {
    const { port, deck, control } = make();
    deck.sync(driving());
    control('steer').rect = { left: 10, width: 300 };
    fire(control('steer'), 'pointerdown', 3, 120);
    expect(port.downs).toEqual([{ id: 3, contact: { kind: 'steer', x: 120, travel: steerTravel(300) } }]);
    expect(control('steer').captured).toEqual([3]);
  });

  test('taps and holds become button contacts with their action', () => {
    const { port, deck, control } = make();
    deck.sync(driving({ phase: 'driving' }));
    fire(control('pause'), 'pointerdown', 4);
    fire(control('lookBack'), 'pointerdown', 5);
    expect(port.downs.map((d) => d.contact)).toEqual([
      { kind: 'button', control: 'pause', action: 'pause', hold: false },
      { kind: 'button', control: 'lookBack', action: 'lookBack', hold: true },
    ]);
    deck.sync(driving({ phase: 'spectating' }));
    fire(control('nextCar'), 'pointerdown', 6);
    expect(port.downs[2].contact).toEqual({ kind: 'button', control: 'nextCar', action: 'steerRight', hold: true });
  });

  test('a refused finger takes no capture and keeps its default', () => {
    const { port, deck, control } = make();
    deck.sync(driving());
    port.claim = false;
    const e = fire(control('steer'), 'pointerdown', 9, 50);
    expect(port.downs.length).toBe(1);
    expect(control('steer').captured).toEqual([]);
    expect(e.prevented).toBe(false);
  });

  test('pointerup, pointercancel and lostpointercapture all lift the finger', () => {
    const { port, deck, control } = make();
    deck.sync(driving());
    fire(control('throttle'), 'pointerup', 1);
    fire(control('throttle'), 'pointercancel', 2);
    fire(control('throttle'), 'lostpointercapture', 3);
    expect(port.ups).toEqual([1, 2, 3]);
  });

  test('the tilt chip asks for the sensor on click, never on pointerdown', () => {
    const { port, deck, control } = make();
    deck.sync(driving({ tiltPending: true }));
    const e = fire(control('tiltEnable'), 'pointerdown', 1, 30);
    expect(port.downs).toEqual([]);
    expect(port.tiltRequests).toBe(0);
    expect(e.prevented).toBe(false);
    fire(control('tiltEnable'), 'click');
    expect(port.tiltRequests).toBe(1);
  });

  test('the tilt indicator holds no finger', () => {
    const { port, deck, control } = make();
    deck.sync(driving({ steering: 'tilt' }));
    fire(control('tilt'), 'pointerdown', 1, 30);
    expect(port.downs).toEqual([]);
  });
});

describe('deck indicators', () => {
  test('the stick sits where the finger landed and follows the drag', () => {
    const { port, deck, control } = make();
    deck.sync(driving());
    const steer = control('steer');
    expect(steer.attrs.has('data-drag')).toBe(false);
    steer.rect = { left: 100, width: 300 };
    fire(steer, 'pointerdown', 1, 150);
    port.state = { steering: 'drag', steer: 0.4, drag: { origin: 150, x: 180, travel: 60 }, flat: false };
    deck.sync(driving());
    expect(steer.attrs.get('data-drag')).toBe('1');
    expect(steer.style.props.get('--nvt-ox')).toBe('50px');
    expect(steer.style.props.get('--nvt-dx')).toBe('0.500');
    port.state = { ...port.state, drag: { origin: 200, x: 400, travel: 60 } };
    deck.sync(driving());
    expect(steer.style.props.get('--nvt-dx')).toBe('1.000');
    port.state = { ...port.state, drag: null };
    deck.sync(driving());
    expect(steer.attrs.has('data-drag')).toBe(false);
  });

  test('the wheel turns with the tilt steer and a flat device shows the notice', () => {
    const { port, deck, control } = make();
    port.state = { steering: 'tilt', steer: -0.25, drag: null, flat: false };
    deck.sync(driving({ steering: 'tilt' }));
    const tilt = control('tilt');
    expect(tilt.style.props.get('--nvt-steer')).toBe('-0.250');
    expect(tilt.attrs.has('data-flat')).toBe(false);
    expect(tilt.find((e) => e.classes.has('nvt-flat'))[0].textContent).toBe(TILT_FLAT_TEXT);
    port.state = { steering: 'tilt', steer: 0, drag: null, flat: true };
    deck.sync(driving({ steering: 'tilt' }));
    expect(tilt.attrs.get('data-flat')).toBe('1');
  });
});

describe('text that names an input', () => {
  const showFor = (n: FakeEl): [string | undefined, string][] => n.children.map((c) => [c.dataset.showFor, c.textContent]);

  test('the crash banner says 按 R on keys and 點「回溯」 on touch; a plain line stays plain', () => {
    const banner = new Banner(new FakeEl('div') as unknown as Element);
    banner.show('retired', '退賽', { keys: '撞牆・按 R 回溯', touch: '撞牆・點「回溯」' }, 'bad');
    const sub = (banner.el as unknown as FakeEl).find((e) => e.classes.has('nvh-banner-sub'))[0];
    expect(showFor(sub)).toEqual([
      ['keyboard gamepad', '撞牆・按 R 回溯'],
      ['touch', '撞牆・點「回溯」'],
    ]);
    expect(sub.classes.has('nvh-hidden')).toBe(false);
    banner.clear();
    banner.show('finished', '節次結束', '', 'info');
    expect(sub.classes.has('nvh-hidden')).toBe(true);
  });

  test('the hint strip tags key rows for keyboard and pad, and the deck rows for touch', () => {
    const strip = new HintStrip(new FakeEl('div') as unknown as Element);
    strip.start({ keys: [{ label: '油門', keys: ['W'] }], touch: touchHintItems('drag') }, 5);
    const items = (strip.el as unknown as FakeEl).find((e) => e.classes.has('nvh-hint-item'));
    expect(items.map((i) => i.dataset.showFor)).toEqual(['keyboard gamepad', ...touchHintItems('drag').map(() => 'touch')]);
    const more = (strip.el as unknown as FakeEl).find((e) => e.classes.has('nvh-hint-more'))[0];
    expect(showFor(more).map(([who]) => who)).toEqual(['keyboard gamepad', 'touch']);
  });
});
