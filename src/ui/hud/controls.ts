/**
 * Controls reference data (pure, DOM-free): the 操作說明 pages built from the CURRENT key bindings (P1 / P2, split-screen
 * routing aware) and the input module's standard gamepad mapping, the essential-keys hint strip, and the
 * first-sessions hint counter persisted in localStorage (falls back to page memory when storage is unavailable).
 */
import type { KeyAction, Settings } from '../../core/types';
import { STORAGE_PREFIX } from '../../core/defaults';
import { PAD_BUTTON_ACTIONS, PAD_BUTTON_BRAKE, PAD_BUTTON_THROTTLE } from '../../input/gamepad';
import { KEY_ACTION_LABEL, keyLabel } from '../menus/labels';

/** localStorage key of the number of sessions that already showed the hint strip. */
export const HUD_HINTS_KEY = `${STORAGE_PREFIX}v1:hud-hints`;
/** The hint strip is shown in this many sessions (lights out / session start), then never again. */
export const HUD_HINT_SESSIONS = 3;
/** Seconds the hint strip stays on screen. */
export const HUD_HINT_SECONDS = 12;
/** Keys listed per hint item at most (the full list lives in the 操作說明 panel). */
export const HINT_MAX_KEYS = 2;

export interface HelpRow {
  label: string;
  /** readable key / button labels; empty = not bound */
  keys: string[];
}

export interface HelpSection {
  title: string;
  rows: HelpRow[];
}

export interface HelpPage {
  id: 'kb0' | 'kb1' | 'pad';
  title: string;
  sections: HelpSection[];
  note: string;
}

type BindingSettings = Pick<Settings, 'keyBindings' | 'keyBindingsP2'>;

const HELP_GROUPS: readonly { title: string; actions: readonly KeyAction[] }[] = [
  { title: '駕駛', actions: ['throttle', 'brake', 'steerLeft', 'steerRight', 'shiftUp', 'shiftDown'] },
  { title: '動力與策略', actions: ['drs', 'overtake', 'ersCycle', 'limiter', 'pitRequest', 'mfd'] },
  { title: '鏡頭與系統', actions: ['camera', 'lookBack', 'pause', 'flashback', 'fullscreen', 'hud'] },
];

/** Actions the App handles for everyone, whichever player's key fired them (P2 cannot bind them). */
const SHARED_ACTIONS: ReadonlySet<KeyAction> = new Set<KeyAction>(['pause', 'flashback', 'fullscreen', 'hud']);

/** Standard-mapping button labels (Xbox-style positions). */
export const PAD_BUTTON_LABEL: Readonly<Record<number, string>> = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  6: 'LT',
  7: 'RT',
  8: 'Back',
  9: 'Start',
  10: 'L3',
  11: 'R3',
  12: '十字鍵 ↑',
  13: '十字鍵 ↓',
  14: '十字鍵 ←',
  15: '十字鍵 →',
};

/** Analog gamepad controls (not in PAD_BUTTON_ACTIONS). */
const PAD_ANALOG: Partial<Record<KeyAction, string>> = {
  throttle: PAD_BUTTON_LABEL[PAD_BUTTON_THROTTLE],
  brake: PAD_BUTTON_LABEL[PAD_BUTTON_BRAKE],
  steerLeft: '左搖桿 ←',
  steerRight: '左搖桿 →',
};

/** Readable label for a KeyboardEvent.code (KeyW → W, ArrowUp → ↑, Space → 空白鍵, ShiftLeft → 左 Shift, Escape → Esc). */
export function formatKeyCode(code: string): string {
  return keyLabel(code);
}

function validCodes(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const c of list) if (typeof c === 'string' && c.length > 0 && !out.includes(c)) out.push(c);
  return out;
}

function p2CodeSet(settings: BindingSettings): Set<string> {
  const set = new Set<string>();
  const p2 = settings.keyBindingsP2;
  if (!p2 || typeof p2 !== 'object') return set;
  for (const g of HELP_GROUPS) for (const a of g.actions) for (const c of validCodes(p2[a])) set.add(c);
  return set;
}

/**
 * KeyboardEvent.codes that trigger `action` for a player, following input/bindings routing: single player = P1
 * bindings only; split-screen = every code in keyBindingsP2 belongs to player 2, the rest of P1's codes to player 1.
 * Player 2 shares P1's keys for the App-wide actions (pause, flashback, fullscreen, HUD).
 */
export function effectiveCodes(settings: BindingSettings, playerIndex: 0 | 1, split: boolean, action: KeyAction): string[] {
  const p1 = validCodes(settings.keyBindings?.[action]);
  if (!split) return playerIndex === 0 ? p1 : [];
  const p2Codes = p2CodeSet(settings);
  const p1Own = p1.filter((c) => !p2Codes.has(c));
  if (playerIndex === 0) return p1Own;
  const p2 = validCodes(settings.keyBindingsP2?.[action]);
  return p2.length === 0 && SHARED_ACTIONS.has(action) ? p1Own : p2;
}

function keyboardSections(settings: BindingSettings, playerIndex: 0 | 1, split: boolean): HelpSection[] {
  const sections = HELP_GROUPS.map((g) => ({
    title: g.title,
    rows: g.actions.map((a) => ({ label: KEY_ACTION_LABEL[a], keys: effectiveCodes(settings, playerIndex, split, a).map(formatKeyCode) })),
  }));
  const p2Pad = split && playerIndex === 1;
  sections.push({
    title: 'MFD 與暫停選單',
    rows: [
      { label: 'MFD：ERS 模式', keys: [p2Pad ? '數字鍵盤 1–4' : '1–4'] },
      { label: 'MFD：換胎配方', keys: [p2Pad ? '數字鍵盤 5' : '5'] },
      { label: 'MFD：Box／取消', keys: [p2Pad ? '數字鍵盤 6' : '6'] },
      { label: '選單：選擇／調整', keys: ['↑ ↓', '← →'] },
      { label: '選單：確認', keys: ['Enter'] },
    ],
  });
  return sections;
}

function padSections(): HelpSection[] {
  const sections: HelpSection[] = HELP_GROUPS.map((g) => ({
    title: g.title,
    rows: g.actions
      .map((a) => {
        const analog = PAD_ANALOG[a];
        const buttons = PAD_BUTTON_ACTIONS.filter(([, action]) => action === a).map(([index]) => PAD_BUTTON_LABEL[index] ?? `按鈕 ${index}`);
        return { label: KEY_ACTION_LABEL[a], keys: analog ? [analog, ...buttons] : buttons };
      })
      .filter((row) => row.keys.length > 0),
  }));
  sections.find((s) => s.title === '動力與策略')?.rows.push({ label: 'MFD：換胎配方', keys: ['十字鍵 ←→'] });
  sections.push({
    title: '暫停選單',
    rows: [
      { label: '選擇／調整', keys: ['十字鍵'] },
      { label: '確認', keys: ['A'] },
      { label: '返回／繼續', keys: ['B'] },
    ],
  });
  return sections;
}

/** Pages of the 操作說明 panel: keyboard (P1, + P2 in split-screen) and gamepad. */
export function controlsHelpPages(settings: BindingSettings, split: boolean): HelpPage[] {
  const pages: HelpPage[] = [
    {
      id: 'kb0',
      title: split ? 'P1 鍵盤' : '鍵盤',
      sections: keyboardSections(settings, 0, split),
      note: split ? '分割畫面時，與 P2 重複的按鍵只控制 P2。可在「設定」重新綁定按鍵。' : '可在「設定」重新綁定按鍵。',
    },
  ];
  if (split) {
    pages.push({
      id: 'kb1',
      title: 'P2 鍵盤',
      sections: keyboardSections(settings, 1, true),
      note: '暫停、回溯、全螢幕與 HUD 和 P1 共用按鍵。',
    });
  }
  pages.push({
    id: 'pad',
    title: '手把',
    sections: padSections(),
    note: split ? '標準配置手把：第 1 支控制 P1、第 2 支控制 P2。' : '支援標準配置手把（Xbox 按鍵位置）。',
  });
  return pages;
}

function firstKeys(settings: BindingSettings, playerIndex: 0 | 1, split: boolean, action: KeyAction): string[] {
  return effectiveCodes(settings, playerIndex, split, action).slice(0, HINT_MAX_KEYS).map(formatKeyCode);
}

/** Steering as left／right pairs (e.g. "A／D", "←／→"). */
function steerPairs(settings: BindingSettings, playerIndex: 0 | 1, split: boolean): string[] {
  const left = effectiveCodes(settings, playerIndex, split, 'steerLeft').map(formatKeyCode);
  const right = effectiveCodes(settings, playerIndex, split, 'steerRight').map(formatKeyCode);
  const out: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length) && out.length < HINT_MAX_KEYS; i++) {
    out.push([left[i], right[i]].filter((k): k is string => k !== undefined).join('／'));
  }
  return out;
}

/** Essential keys for the first-sessions hint strip: 油門 / 煞車 / 轉向 / DRS / 暫停 / 回溯. */
export function hintItems(settings: BindingSettings, playerIndex: 0 | 1, split: boolean): HelpRow[] {
  return [
    { label: '油門', keys: firstKeys(settings, playerIndex, split, 'throttle') },
    { label: '煞車', keys: firstKeys(settings, playerIndex, split, 'brake') },
    { label: '轉向', keys: steerPairs(settings, playerIndex, split) },
    { label: 'DRS', keys: firstKeys(settings, playerIndex, split, 'drs') },
    { label: '暫停', keys: firstKeys(settings, playerIndex, split, 'pause') },
    { label: '回溯', keys: firstKeys(settings, playerIndex, split, 'flashback') },
  ];
}

// ───────────── first-sessions counter ─────────────

export interface HintStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Page-lifetime mirror of the counter (used when storage is unavailable or throws). */
export interface HintMemory {
  count: number;
}

const pageMemory: HintMemory = { count: 0 };

/** window.localStorage, or null when it is missing / blocked (sandboxed iframe, privacy mode). */
function browserStore(): HintStore | null {
  try {
    return (globalThis as { localStorage?: HintStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

function parseCount(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Sessions that already showed the hint strip. */
export function hintSessionsShown(store: HintStore | null = browserStore(), memory: HintMemory = pageMemory): number {
  let stored = 0;
  try {
    if (store) stored = parseCount(store.getItem(HUD_HINTS_KEY));
  } catch {
    // unreadable storage: the page-memory count still applies
  }
  return Math.max(stored, memory.count);
}

/** Called once per session start: true (and the counter is bumped) while fewer than HUD_HINT_SESSIONS showed hints. */
export function claimHintSession(store: HintStore | null = browserStore(), memory: HintMemory = pageMemory): boolean {
  const shown = hintSessionsShown(store, memory);
  if (shown >= HUD_HINT_SESSIONS) return false;
  memory.count = shown + 1;
  try {
    store?.setItem(HUD_HINTS_KEY, String(shown + 1));
  } catch {
    // quota / disabled storage: counted in page memory only
  }
  return true;
}
