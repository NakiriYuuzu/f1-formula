/**
 * The touch control table and what derives from it (pure): row integrity against the input core, which rows a race
 * context shows, the 操作說明 「觸控」 page, the hint strip's touch rows, and a deck CSS rule for every zone.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { CarEntry, KeyAction, WorldState } from '../src/core/types';
import { HELD_ACTIONS, LATCH_FOR_ACTION, QUEUED_ACTIONS } from '../src/input/core';
import type { HudInput } from '../src/input/index';
import type { EffectiveSteering } from '../src/input/touch';
import { HELP_GROUPS } from '../src/ui/hud/controls';
import {
  TOUCH_CONTROLS,
  howText,
  touchContext,
  touchHelpSections,
  touchHintItems,
  visibleControls,
  type TouchContext,
  type TouchContextInput,
} from '../src/ui/hud/touchLayout';
import { KEY_ACTION_LABEL } from '../src/ui/menus/labels';

const SCHEMES: readonly EffectiveSteering[] = ['drag', 'tilt', 'buttons'];

interface CarPatch {
  status?: CarEntry['status'];
  playerIndex?: number;
  limiter?: boolean;
  drsAvailable?: boolean;
  overtakeAvailable?: boolean;
  pitPhase?: string;
  pitRequested?: boolean;
  pitManual?: boolean;
  gearbox?: 'auto' | 'manual';
  drsAssist?: boolean;
  pitAssist?: boolean;
}

function car(p: CarPatch = {}): CarEntry {
  return {
    playerIndex: p.playerIndex ?? 0,
    status: p.status ?? 'running',
    phys: { limiter: p.limiter ?? false, drs: { available: p.drsAvailable ?? false }, ers: { overtakeAvailable: p.overtakeAvailable ?? false } },
    pit: { phase: p.pitPhase ?? 'none', requested: p.pitRequested ?? false },
    race: { pitManual: p.pitManual ?? false, formationAuto: false },
    assists: { gearbox: p.gearbox ?? 'auto', drsAssist: p.drsAssist ?? true, pitAssist: p.pitAssist ?? true },
  } as unknown as CarEntry;
}

function world(kind = 'race', regulation = '2025'): WorldState {
  return { config: { kind, regulation } } as unknown as WorldState;
}

const touchInput = (patch: Partial<HudInput> = {}): HudInput => ({ mode: 'touch', steering: 'drag', tiltPending: false, tiltProblem: null, ...patch });

function ctx(patch: Partial<TouchContextInput> = {}): TouchContext {
  const c = touchContext({
    input: touchInput(),
    paused: false,
    replay: false,
    watching: false,
    car: car(),
    world: world(),
    flashbacksLeft: 3,
    online: false,
    ...patch,
  });
  if (!c) throw new Error('expected a touch context');
  return c;
}

/** Every row's switch on: a driving context in which each `when` holds. */
const allOn = (steering: EffectiveSteering): TouchContext => ({
  phase: 'driving',
  steering,
  tiltPending: false,
  manualGearbox: true,
  drsManual: true,
  drsReady: false,
  overtakeReady: false,
  limiter: true,
  limiterOn: false,
  pit: true,
  boxCalled: false,
  flashback: true,
  reg2026: false,
});

const ids = (c: TouchContext): string[] => visibleControls(c).map((r) => r.id);

describe('touch control table', () => {
  test('ids are unique', () => {
    const all = TOUCH_CONTROLS.map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
  });

  test('every action a row raises has a help label', () => {
    for (const r of TOUCH_CONTROLS) if (r.action) expect(KEY_ACTION_LABEL[r.action]).toBeTruthy();
  });

  test('a row only names an action the input core handles for a finger', () => {
    const tapped = (a: KeyAction): boolean => a in LATCH_FOR_ACTION || QUEUED_ACTIONS.has(a);
    for (const r of TOUCH_CONTROLS) {
      if (r.kind === 'tap') expect({ id: r.id, ok: r.action !== null && tapped(r.action) }).toEqual({ id: r.id, ok: true });
      else if (r.kind === 'hold' || r.kind === 'pedal') expect({ id: r.id, ok: r.action !== null && HELD_ACTIONS.has(r.action) }).toEqual({ id: r.id, ok: true });
      else expect({ id: r.id, action: r.action }).toEqual({ id: r.id, action: null });
    }
  });

  test('every steering scheme has exactly one way to steer and exactly one brake', () => {
    const steerSources: Record<EffectiveSteering, string[]> = { drag: ['steer'], tilt: ['tilt'], buttons: ['steerLeft', 'steerRight'] };
    for (const s of SCHEMES) {
      const rows = visibleControls(allOn(s));
      const steering = rows.filter((r) => r.kind === 'surface' || r.kind === 'indicator' || r.action === 'steerLeft' || r.action === 'steerRight');
      expect({ s, ids: steering.map((r) => r.id) }).toEqual({ s, ids: steerSources[s] });
      expect({ s, brakes: rows.filter((r) => r.action === 'brake').length }).toEqual({ s, brakes: 1 });
    }
  });

  test('tilt moves the brake under the left thumb', () => {
    expect(visibleControls(allOn('tilt')).find((r) => r.action === 'brake')?.zone).toBe('thumbL');
    expect(visibleControls(allOn('drag')).find((r) => r.action === 'brake')?.zone).toBe('thumbR');
  });

  test('help wording: a row\'s own words, else 點 for a tap and 按住 for a hold or pedal', () => {
    const row = (id: string) => TOUCH_CONTROLS.find((r) => r.id === id)!;
    expect(howText(row('pause'))).toBe('點「暫停」');
    expect(howText(row('throttle'))).toBe('按住「油門」');
    expect(howText(row('lookBack'))).toBe('按住「後視」');
    expect(howText(row('steer'))).toBe('在左側區域左右拖曳');
    expect(howText(row('drs'))).toContain('直線模式');
    for (const r of TOUCH_CONTROLS) expect(howText(r).length).toBeGreaterThan(0);
  });
});

describe('touchContext', () => {
  test('no deck in keyboard or gamepad mode, while paused, or in a replay', () => {
    const base: TouchContextInput = { input: touchInput(), paused: false, replay: false, watching: false, car: car(), world: world(), flashbacksLeft: 1, online: false };
    expect(touchContext(base)).not.toBeNull();
    expect(touchContext({ ...base, input: touchInput({ mode: 'keyboard' }) })).toBeNull();
    expect(touchContext({ ...base, input: touchInput({ mode: 'gamepad' }) })).toBeNull();
    expect(touchContext({ ...base, paused: true })).toBeNull();
    expect(touchContext({ ...base, replay: true })).toBeNull();
  });

  test('the shift buttons follow a manual gearbox', () => {
    expect(ids(ctx({ car: car({ gearbox: 'manual' }) }))).toEqual(expect.arrayContaining(['shiftUp', 'shiftDown']));
    expect(ids(ctx({ car: car({ gearbox: 'auto' }) }))).not.toContain('shiftUp');
    expect(ids(ctx({ car: car({ gearbox: 'auto' }) }))).not.toContain('shiftDown');
  });

  test('no DRS button while the DRS assist opens it; a manual one glows when DRS is available', () => {
    expect(ids(ctx({ car: car({ drsAssist: true }) }))).not.toContain('drs');
    const manual = ctx({ car: car({ drsAssist: false, drsAvailable: true }) });
    const drs = visibleControls(manual).find((r) => r.id === 'drs')!;
    expect(drs.lit?.(manual)).toBe(true);
    expect(typeof drs.label === 'function' && drs.label(manual)).toBe('DRS');
    expect(typeof drs.label === 'function' && drs.label(ctx({ car: car({ drsAssist: false }), world: world('race', '2026') }))).toBe('直線模式');
  });

  test('the limiter shows only while the driver drives a pit visit, or while it is on', () => {
    const shown = (p: CarPatch): boolean => ids(ctx({ car: car(p) })).includes('limiter');
    expect(shown({})).toBe(false);
    expect(shown({ pitRequested: true, pitAssist: true })).toBe(false);
    expect(shown({ pitRequested: true, pitAssist: false })).toBe(true);
    expect(shown({ pitPhase: 'entry', pitManual: true })).toBe(true);
    expect(shown({ pitPhase: 'entry', pitManual: false, pitAssist: false })).toBe(false);
    expect(shown({ limiter: true })).toBe(true);
    const on = ctx({ car: car({ limiter: true }) });
    expect(visibleControls(on).find((r) => r.id === 'limiter')?.lit?.(on)).toBe(true);
  });

  test('Box: not in a time trial, not before the car runs, and it glows once called', () => {
    expect(ids(ctx())).toContain('box');
    expect(ids(ctx({ world: world('timeTrial') }))).not.toContain('box');
    expect(ids(ctx({ car: car({ status: 'grid' }) }))).not.toContain('box');
    const called = ctx({ car: car({ pitRequested: true }) });
    expect(visibleControls(called).find((r) => r.id === 'box')?.lit?.(called)).toBe(true);
  });

  test('flashback: never online, never with none left', () => {
    expect(ids(ctx())).toContain('flashback');
    expect(ids(ctx({ online: true }))).not.toContain('flashback');
    expect(ids(ctx({ flashbacksLeft: 0 }))).not.toContain('flashback');
    expect(ids(ctx({ flashbacksLeft: -1 }))).toContain('flashback');
  });

  test('out of the race: the system buttons and the flashback offer only', () => {
    expect(ids(ctx({ car: car({ status: 'retired' }) }))).toEqual(['pause', 'camera', 'flashback']);
    expect(ids(ctx({ car: null, online: true }))).toEqual(['pause', 'camera']);
  });

  test('spectating: previous / next car, no driving controls', () => {
    expect(ids(ctx({ watching: true, online: true, car: car({ status: 'retired' }) }))).toEqual(['pause', 'camera', 'prevCar', 'nextCar']);
  });

  test('the scheme picks the steering rows; tilt still waiting for permission shows the chip over the drag surface', () => {
    expect(ids(ctx({ input: touchInput({ steering: 'tilt' }) }))).toEqual(expect.arrayContaining(['tilt', 'brakeL']));
    expect(ids(ctx({ input: touchInput({ steering: 'buttons' }) }))).toEqual(expect.arrayContaining(['steerLeft', 'steerRight', 'brake']));
    const pending = ids(ctx({ input: touchInput({ steering: 'drag', tiltPending: true }) }));
    expect(pending).toEqual(expect.arrayContaining(['steer', 'tiltEnable']));
  });

  test('a driving context with the default assists: the basic set', () => {
    expect(ids(ctx())).toEqual(['pause', 'camera', 'mfd', 'box', 'flashback', 'steer', 'lookBack', 'brake', 'throttle', 'overtake']);
  });
});

describe('操作說明 觸控 page', () => {
  const labelOrder = HELP_GROUPS.flatMap((g) => g.actions.map((a) => (a === 'steerLeft' || a === 'steerRight' ? '轉向' : KEY_ACTION_LABEL[a])));

  test('sections and rows follow HELP_GROUPS order, and every action of the scheme is listed', () => {
    for (const s of SCHEMES) {
      const sections = touchHelpSections(s);
      expect(sections.map((x) => x.title)).toEqual(HELP_GROUPS.map((g) => g.title));
      const labels = sections.flatMap((x) => x.rows.map((r) => r.label));
      expect(labels).toEqual(labelOrder.filter((l, i) => labels.includes(l) && labelOrder.indexOf(l) === i));
      for (const r of TOUCH_CONTROLS) {
        if (r.schemes && !r.schemes.includes(s)) continue;
        if (!r.action && r.kind !== 'surface' && r.kind !== 'indicator') continue;
        const label = r.action && r.action !== 'steerLeft' && r.action !== 'steerRight' ? KEY_ACTION_LABEL[r.action] : '轉向';
        expect({ s, id: r.id, listed: labels.includes(label) }).toEqual({ s, id: r.id, listed: true });
      }
    }
  });

  test('every way of steering is one 轉向 row, in the words of the scheme', () => {
    const steer = (s: EffectiveSteering) => touchHelpSections(s)[0].rows.find((r) => r.label === '轉向')!.keys;
    expect(steer('drag')[0]).toBe('在左側區域左右拖曳');
    expect(steer('tilt')[0]).toBe('像方向盤一樣左右轉動裝置');
    expect(steer('buttons').slice(0, 2)).toEqual(['按住「◀」', '按住「▶」']);
    for (const s of SCHEMES) expect(steer(s)).toContain('點「上一台」（觀戰時切換車手）');
  });

  test('a control that is not always on screen says when it is', () => {
    const keys = touchHelpSections('drag').flatMap((x) => x.rows.flatMap((r) => r.keys));
    expect(keys).toContain('點「升檔」（手動變速時）');
    expect(keys).toContain('點「限速器」（自行駕駛進站時）');
    expect(keys).toContain('按住「超車」');
  });
});

describe('hint strip touch rows', () => {
  test('the same six essentials as the keyboard strip, in the words of each scheme', () => {
    expect(touchHintItems('drag')).toEqual([
      { label: '油門', keys: ['按住「油門」'] },
      { label: '煞車', keys: ['按住「煞車」'] },
      { label: '轉向', keys: ['在左側區域左右拖曳'] },
      { label: KEY_ACTION_LABEL.drs, keys: ['點「DRS」或「直線模式」'] },
      { label: '暫停', keys: ['點「暫停」'] },
      { label: '回溯', keys: ['點「回溯」'] },
    ]);
    expect(touchHintItems('tilt').find((r) => r.label === '轉向')?.keys).toEqual(['像方向盤一樣左右轉動裝置']);
    expect(touchHintItems('buttons').find((r) => r.label === '轉向')?.keys).toEqual(['按住「◀」', '按住「▶」']);
  });
});

describe('touch.css', () => {
  test('every zone in the table has a deck rule', () => {
    const css = readFileSync(new URL('../src/ui/hud/touch.css', import.meta.url), 'utf8');
    for (const zone of new Set(TOUCH_CONTROLS.map((r) => r.zone))) {
      expect({ zone, ruled: new RegExp(`\\[data-zone='${zone}'\\][^{}]*\\{`).test(css) }).toEqual({ zone, ruled: true });
    }
  });
});
