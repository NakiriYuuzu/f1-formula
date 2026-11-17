/**
 * The touch control description, pure. One table: the deck draws each row, the 操作說明 「觸控」 page and the hint strip
 * list it, and a finger on it raises its KeyAction. There is no second list.
 */
import type { CarEntry, KeyAction, WorldState } from '../../core/types';
import type { HudInput } from '../../input/index';
import type { EffectiveSteering } from '../../input/touch';
import { drivesOwnPitVisit } from '../../race/index';
import { KEY_ACTION_LABEL } from '../menus/labels';
import { HELP_GROUPS, type HelpRow, type HelpSection } from './controls';

export type TouchZone = 'sys' | 'thumbL' | 'thumbR';
/**
 * tap: press on finger-down. hold: press on down, held until up. pedal: a hold that may roll to the pedal beside it.
 * surface: the drag steering area (analog). indicator: tilt wheel (no input). permission: the 啟用體感轉向 chip (click).
 */
export type TouchKind = 'tap' | 'hold' | 'pedal' | 'surface' | 'indicator' | 'permission';
export type TouchPhase = 'driving' | 'out' | 'spectating';

/** Everything a row's predicates may look at, computed once per frame by touchContext(). */
export interface TouchContext {
  phase: TouchPhase;
  steering: EffectiveSteering;
  tiltPending: boolean;
  manualGearbox: boolean;
  /** DRS assist off: the player opens it */
  drsManual: boolean;
  drsReady: boolean;
  overtakeReady: boolean;
  /** the driver drives a pit visit that is coming up / under way, or the limiter is on */
  limiter: boolean;
  limiterOn: boolean;
  /** a Box call is possible (not time trial, the car running) */
  pit: boolean;
  boxCalled: boolean;
  /** offline and a flashback is possible right now (HudFrameInfo.flashbacksLeft !== 0) */
  flashback: boolean;
  reg2026: boolean;
}

export interface TouchControlDef {
  /** unique; the deck's data-control, and what releaseControl names */
  readonly id: string;
  readonly zone: TouchZone;
  readonly kind: TouchKind;
  /** the KeyAction a finger raises; null for surface / indicator / permission */
  readonly action: KeyAction | null;
  /** on-screen text (short); a function where the regulation renames it */
  readonly label: string | ((c: TouchContext) => string);
  /** help / hint wording; default from kind: tap 點「label」, hold / pedal 按住「label」 */
  readonly how?: string;
  /** when the control is on screen, in words, for 操作說明 (the help page never depends on the live race) */
  readonly note?: string;
  /** steering schemes the row exists in (default: all) */
  readonly schemes?: readonly EffectiveSteering[];
  readonly when: (c: TouchContext) => boolean;
  /** "ready" glow (data-lit): DRS available, overtake available, limiter on, Box called */
  readonly lit?: (c: TouchContext) => boolean;
  /** listed in the first-sessions hint strip */
  readonly hint?: true;
}

const always = (): boolean => true;
const driving = (c: TouchContext): boolean => c.phase === 'driving';
const spectating = (c: TouchContext): boolean => c.phase === 'spectating';

/**
 * Order within a zone is the on-screen order (sys: left → right; thumb zones: top → bottom, then inner → outer).
 * Deliberately absent: ersCycle (the MFD's ERS buttons are tappable), fullscreen (menus header / pause menu), hud (a
 * hidden HUD would hide nothing a touch player needs back), replay controls (the replay bar has its own buttons, so
 * the deck is off in replays).
 */
export const TOUCH_CONTROLS: readonly TouchControlDef[] = [
  { id: 'pause', zone: 'sys', kind: 'tap', action: 'pause', label: '暫停', when: always, hint: true },
  { id: 'camera', zone: 'sys', kind: 'tap', action: 'camera', label: '鏡頭', when: always },
  { id: 'mfd', zone: 'sys', kind: 'tap', action: 'mfd', label: 'MFD', when: driving },
  { id: 'box', zone: 'sys', kind: 'tap', action: 'pitRequest', label: 'Box', note: '計時賽除外', when: (c) => driving(c) && c.pit, lit: (c) => c.boxCalled },
  // also while the car is out: the 退賽 banner offers the flashback for CRASH_FLASHBACK_OFFER seconds
  { id: 'flashback', zone: 'sys', kind: 'tap', action: 'flashback', label: '回溯', note: '還能回溯時', when: (c) => c.flashback, hint: true },

  { id: 'steer', zone: 'thumbL', kind: 'surface', action: null, label: '轉向', how: '在左側區域左右拖曳', schemes: ['drag'], when: driving, hint: true },
  { id: 'tilt', zone: 'thumbL', kind: 'indicator', action: null, label: '轉向', how: '像方向盤一樣左右轉動裝置', schemes: ['tilt'], when: driving, hint: true },
  { id: 'tiltEnable', zone: 'thumbL', kind: 'permission', action: null, label: '啟用體感轉向', when: (c) => driving(c) && c.tiltPending },
  { id: 'steerLeft', zone: 'thumbL', kind: 'hold', action: 'steerLeft', label: '◀', schemes: ['buttons'], when: driving, hint: true },
  { id: 'steerRight', zone: 'thumbL', kind: 'hold', action: 'steerRight', label: '▶', schemes: ['buttons'], when: driving, hint: true },
  // tilt frees the left thumb: the brake moves under it (brake left, throttle right)
  { id: 'brakeL', zone: 'thumbL', kind: 'pedal', action: 'brake', label: '煞車', schemes: ['tilt'], when: driving, hint: true },
  { id: 'shiftDown', zone: 'thumbL', kind: 'tap', action: 'shiftDown', label: '降檔', note: '手動變速時', when: (c) => driving(c) && c.manualGearbox },
  { id: 'lookBack', zone: 'thumbL', kind: 'hold', action: 'lookBack', label: '後視', when: driving },
  // spectating (own car out of a multiplayer race): held steerLeft / steerRight edges switch car (readSpectateKeys)
  { id: 'prevCar', zone: 'thumbL', kind: 'hold', action: 'steerLeft', label: '上一台', how: '點「上一台」', note: '觀戰時切換車手', when: spectating },

  { id: 'brake', zone: 'thumbR', kind: 'pedal', action: 'brake', label: '煞車', schemes: ['drag', 'buttons'], when: driving, hint: true },
  { id: 'throttle', zone: 'thumbR', kind: 'pedal', action: 'throttle', label: '油門', when: driving, hint: true },
  { id: 'shiftUp', zone: 'thumbR', kind: 'tap', action: 'shiftUp', label: '升檔', note: '手動變速時', when: (c) => driving(c) && c.manualGearbox },
  {
    id: 'drs',
    zone: 'thumbR',
    kind: 'tap',
    action: 'drs',
    label: (c) => (c.reg2026 ? '直線模式' : 'DRS'),
    how: '點「DRS」或「直線模式」',
    note: '關閉 DRS 輔助時',
    when: (c) => driving(c) && c.drsManual,
    lit: (c) => c.drsReady,
    hint: true,
  },
  { id: 'overtake', zone: 'thumbR', kind: 'hold', action: 'overtake', label: '超車', when: driving, lit: (c) => c.overtakeReady },
  { id: 'limiter', zone: 'thumbR', kind: 'tap', action: 'limiter', label: '限速器', note: '自行駕駛進站時', when: (c) => driving(c) && c.limiter, lit: (c) => c.limiterOn },
  { id: 'nextCar', zone: 'thumbR', kind: 'hold', action: 'steerRight', label: '下一台', how: '點「下一台」', note: '觀戰時切換車手', when: spectating },
];

export interface TouchContextInput {
  input: HudInput;
  paused: boolean;
  replay: boolean;
  /** the (single) view shows another car */
  watching: boolean;
  /** the player's own car */
  car: CarEntry | null;
  world: WorldState;
  flashbacksLeft: number;
  online: boolean;
}

/**
 * null = no deck (keyboard / gamepad mode, paused, replay).
 *   phase       = watching ? 'spectating' : !car || car.status is 'finished' | 'retired' ? 'out' : 'driving'
 *   limiterOn   = car.phys.limiter
 *   limiter     = limiterOn || (car.pit.phase !== 'none' ? car.race.pitManual : car.pit.requested && drivesOwnPitVisit(car))
 *   pit         = world.config.kind !== 'timeTrial' && car.status === 'running'
 *   flashback   = !online && flashbacksLeft !== 0
 *   drsManual   = !car.assists.drsAssist;  drsReady = car.drs.available;  overtakeReady = car.ers.overtakeAvailable
 */
export function touchContext(i: TouchContextInput): TouchContext | null {
  if (i.input.mode !== 'touch' || i.paused || i.replay) return null;
  const car = i.car;
  const phase: TouchPhase = i.watching
    ? 'spectating'
    : !car || car.status === 'finished' || car.status === 'retired'
      ? 'out'
      : 'driving';
  const limiterOn = car?.phys.limiter === true;
  const pitLimiter = car !== null && (car.pit.phase !== 'none' ? car.race.pitManual === true : car.pit.requested && drivesOwnPitVisit(car));
  return {
    phase,
    steering: i.input.steering,
    tiltPending: i.input.tiltPending,
    manualGearbox: car?.assists.gearbox === 'manual',
    drsManual: car !== null && !car.assists.drsAssist,
    drsReady: car?.phys.drs.available === true,
    overtakeReady: car?.phys.ers.overtakeAvailable === true,
    limiter: limiterOn || pitLimiter,
    limiterOn,
    pit: car !== null && i.world.config.kind !== 'timeTrial' && car.status === 'running',
    boxCalled: car?.pit.requested === true,
    flashback: !i.online && i.flashbacksLeft !== 0,
    reg2026: i.world.config.regulation === '2026',
  };
}

/** The row is on screen in this context (its steering scheme, then `when`). */
export function controlVisible(row: TouchControlDef, c: TouchContext): boolean {
  return inScheme(row, c.steering) && row.when(c);
}

/** Visible rows for a context. The deck and the tests share the rule (controlVisible). */
export function visibleControls(c: TouchContext): TouchControlDef[] {
  return TOUCH_CONTROLS.filter((r) => controlVisible(r, c));
}

function inScheme(row: TouchControlDef, steering: EffectiveSteering): boolean {
  return !row.schemes || row.schemes.includes(steering);
}

/** The help text for a row: its `how`, else from its kind and label (a regulation-dependent label falls back to the action's). */
export function howText(row: TouchControlDef): string {
  if (row.how) return row.how;
  const label = typeof row.label === 'string' ? row.label : row.action ? KEY_ACTION_LABEL[row.action] : row.id;
  return row.kind === 'hold' || row.kind === 'pedal' ? `按住「${label}」` : `點「${label}」`;
}

/** The one help label every way of steering shares (drag surface, tilt, ◀ ▶), as in the keyboard hint strip. */
const STEER_LABEL = '轉向';

/** The action a row documents in the help: the steering surface and the tilt indicator stand for steering. */
function helpAction(row: TouchControlDef): KeyAction | null {
  return row.kind === 'surface' || row.kind === 'indicator' ? 'steerLeft' : row.action;
}

function helpLabel(action: KeyAction): string {
  return action === 'steerLeft' || action === 'steerRight' ? STEER_LABEL : KEY_ACTION_LABEL[action];
}

/** HELP_GROUPS order, one row per help label with its table rows in table order; `key` words each one. */
function helpSections(rows: readonly TouchControlDef[], key: (row: TouchControlDef) => string): HelpSection[] {
  const sections: HelpSection[] = [];
  for (const group of HELP_GROUPS) {
    const out: HelpRow[] = [];
    for (const label of new Set(group.actions.map(helpLabel))) {
      const keys = rows
        .filter((r) => {
          const a = helpAction(r);
          return a !== null && group.actions.includes(a) && helpLabel(a) === label;
        })
        .map(key);
      if (keys.length > 0) out.push({ label, keys });
    }
    if (out.length > 0) sections.push({ title: group.title, rows: out });
  }
  return sections;
}

/**
 * The 操作說明 「觸控」 page sections for a steering scheme: HELP_GROUPS order (controls.ts), one row per action, label
 * from KEY_ACTION_LABEL (every way of steering is one 轉向 row), keys = the how text of every row of that action in
 * that scheme, followed by its `note` when the control is not always on screen.
 */
export function touchHelpSections(steering: EffectiveSteering): HelpSection[] {
  return helpSections(
    TOUCH_CONTROLS.filter((r) => inScheme(r, steering)),
    (r) => (r.note ? `${howText(r)}（${r.note}）` : howText(r)),
  );
}

/** The hint strip's touch rows: rows with `hint` in this scheme, in the help's order and merged by its labels (◀ and ▶ become one 轉向 row). */
export function touchHintItems(steering: EffectiveSteering): HelpRow[] {
  return helpSections(
    TOUCH_CONTROLS.filter((r) => r.hint && inScheme(r, steering)),
    howText,
  ).flatMap((s) => s.rows);
}
