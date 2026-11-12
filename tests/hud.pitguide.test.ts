/**
 * Pit status pill (src/ui/hud/pitGuide.ts): what it says when, for a driver driving the visit and for an autopilot
 * car: the approach and its brake cue, the entry road, the speed against the limit in the lane, a missed entry, a
 * held stop before the tyre change, refuelling in an endurance race.
 */
import { describe, expect, test } from 'bun:test';
import {
  PIT_APPROACH_CUE,
  PIT_BRAKE_DECEL,
  PIT_BRAKE_REACTION,
  PIT_MISSED_FROM,
  PIT_MISSED_SHOW,
  pitGuide,
  pitGuideLabel,
  type PitGuideInput,
} from '../src/ui/hud/pitGuide';

const LIMIT = 80 / 3.6;
const RAMP = 120; // (PIT_RAMP_LENGTH)

function input(over: Partial<PitGuideInput> = {}): PitGuideInput {
  return {
    phase: 'none',
    requested: true,
    active: true,
    manual: true,
    auto: false,
    speed: 70,
    limiter: false,
    toEntry: 2000,
    sinceEntry: 3000,
    ramp: RAMP,
    limit: LIMIT,
    timer: 0,
    stopTotal: 0,
    hold: 0,
    repair: false,
    fuel: 0,
    compound: 'hard',
    ...over,
  };
}

const label = (over: Partial<PitGuideInput>) => pitGuideLabel(pitGuide(input(over)), 'kmh');

describe('pit guide: before the visit', () => {
  test('not called in, or finished: no pill', () => {
    expect(pitGuide(input({ requested: false })).kind).toBe('none');
    expect(pitGuide(input({ active: false })).kind).toBe('none');
    expect(label({ requested: false })).toBeNull();
  });

  test('called in, far from the entry: the lap and the tyre', () => {
    expect(label({})).toEqual({ text: '本圈進站 · 硬胎', state: 'box' });
    // an autopilot car gets no approach cue (the autopilot brakes for it)
    expect(pitGuide(input({ manual: false, toEntry: 200 })).kind).toBe('called');
  });

  test('a driver coming up to the entry: the distance, then a brake cue that only just meets the limit at the line', () => {
    expect(pitGuide(input({ toEntry: PIT_APPROACH_CUE + 1 })).kind).toBe('called');
    expect(label({ toEntry: 420.4 })).toEqual({ text: '進站口 420 m · 硬胎', state: 'box' });
    const v = 85;
    // braking at PIT_BRAKE_DECEL after the reaction time from here meets the limit at the speed-limit line
    const toLine = v * PIT_BRAKE_REACTION + (v * v - LIMIT * LIMIT) / (2 * PIT_BRAKE_DECEL);
    const at = toLine - RAMP;
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(PIT_APPROACH_CUE);
    expect(pitGuide(input({ speed: v, toEntry: at + 2 }))).toMatchObject({ kind: 'approach', brake: false });
    expect(pitGuide(input({ speed: v, toEntry: at - 2 }))).toMatchObject({ kind: 'approach', brake: true });
    expect(label({ speed: v, toEntry: at - 2 })).toEqual({ text: `減速進站 · 進站口 ${Math.round(at - 2)} m`, state: 'warn' });
    // at the limit already: never a brake cue
    expect(pitGuide(input({ speed: LIMIT, toEntry: 1 }))).toMatchObject({ kind: 'approach', brake: false });
  });

  test('turning in (on the first part of the entry road, before the visit starts): the entry road read-out', () => {
    expect(pitGuide(input({ sinceEntry: 10, toEntry: 5000, speed: 40 }))).toMatchObject({ kind: 'entryRoad', toLine: RAMP - 10 });
  });

  test('still on the track past the entry: missed, until well past the entry road', () => {
    const missed = RAMP * PIT_MISSED_FROM;
    expect(pitGuide(input({ sinceEntry: missed, toEntry: 5000 })).kind).toBe('missed');
    expect(pitGuide(input({ sinceEntry: RAMP + PIT_MISSED_SHOW - 1, toEntry: 5000 })).kind).toBe('missed');
    expect(pitGuide(input({ sinceEntry: RAMP + PIT_MISSED_SHOW, toEntry: 5000 })).kind).toBe('called');
    expect(label({ sinceEntry: RAMP, toEntry: 5000 })).toEqual({ text: '錯過進站口 · 下圈再進站', state: 'warn' });
    // an autopilot car past the entry without a visit (a request made too late) is told too
    expect(pitGuide(input({ manual: false, sinceEntry: RAMP, toEntry: 5000 })).kind).toBe('missed');
  });
});

describe('pit guide: the visit', () => {
  test('entry road, driven: the limiter and the speed-limit line; braking late reads as a warning', () => {
    expect(label({ phase: 'entry', sinceEntry: 40, speed: 25 })).toEqual({ text: '開啟限速器 · 限速線 80 m', state: 'lane' });
    expect(label({ phase: 'entry', sinceEntry: 40, speed: LIMIT, limiter: true })).toEqual({ text: '限速器已開 · 限速線 80 m', state: 'lane' });
    expect(label({ phase: 'entry', sinceEntry: 100, speed: 40 })).toEqual({ text: '減速 144/80 km/h · 限速線 20 m', state: 'warn' });
  });

  test('entry road and lane on the autopilot: the limit', () => {
    expect(label({ phase: 'entry', manual: false, sinceEntry: 40, speed: 40 })).toEqual({ text: '維修道限速 80 km/h', state: 'lane' });
    expect(label({ phase: 'lane', manual: true, auto: true, speed: 10 })).toEqual({ text: '維修道限速 80 km/h', state: 'lane' });
  });

  test('lane, driven: the speed against the limit, warned over it', () => {
    expect(label({ phase: 'lane', speed: LIMIT + 0.2 })).toEqual({ text: '81/80 km/h', state: 'lane' });
    expect(label({ phase: 'lane', speed: LIMIT + 1 })).toEqual({ text: '超速 84/80 km/h', state: 'warn' });
    expect(pitGuideLabel(pitGuide(input({ phase: 'lane', speed: LIMIT })), 'mph')).toEqual({ text: '50/50 mph', state: 'lane' });
  });

  test('stopped: a hold (penalty, repairs) reads as a hold, then the tyre change counts down', () => {
    expect(label({ phase: 'stopped', stopTotal: 8, hold: 5, timer: 7 })).toEqual({ text: '執行罰時 4.0 秒', state: 'hold' });
    expect(label({ phase: 'stopped', stopTotal: 8, hold: 5, timer: 7, repair: true })).toEqual({ text: '維修中 4.0 秒', state: 'hold' });
    expect(label({ phase: 'stopped', stopTotal: 8, hold: 5, timer: 2 })).toEqual({ text: '換胎中 2.0 秒', state: 'stop' });
    expect(label({ phase: 'stopped', stopTotal: 2.75, hold: 0, timer: 2.5 })).toEqual({ text: '換胎中 2.5 秒', state: 'stop' });
  });

  test('stopped, refuelling (endurance race): the penalty, then the fill, then the tyre change at its end', () => {
    // 2 s penalty, a 7 s fill, a 3 s tyre change: 9 s, held 2 + 4 (the fill past the tyre change), the tyres in the last 3
    const stop = { phase: 'stopped', stopTotal: 9, hold: 6, fuel: 7 } as const;
    expect(label({ ...stop, timer: 8 })).toEqual({ text: '執行罰時 1.0 秒', state: 'hold' });
    expect(label({ ...stop, timer: 6.5 })).toEqual({ text: '加油中 6.5 秒', state: 'stop' });
    // the tyre change runs under the fill, which ends the stop
    expect(label({ ...stop, timer: 2 })).toEqual({ text: '加油中 2.0 秒', state: 'stop' });
    // a fill shorter than the tyre change (1.5 s of 3): the fill, then the rest of the tyre change
    const short = { phase: 'stopped', stopTotal: 3, hold: 0, fuel: 1.5 } as const;
    expect(label({ ...short, timer: 2.5 })).toEqual({ text: '加油中 1.0 秒', state: 'stop' });
    expect(label({ ...short, timer: 1 })).toEqual({ text: '換胎中 1.0 秒', state: 'stop' });
  });

  test('a visit shows whatever the request and status (the pill follows the car out)', () => {
    expect(label({ phase: 'exit', requested: false, active: false })).toEqual({ text: '駛出維修道', state: 'lane' });
  });
});
