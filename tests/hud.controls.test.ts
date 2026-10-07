/**
 * 操作說明 data + first-sessions hints (pure): readable key labels, split-screen routing of the CURRENT bindings,
 * gamepad mapping pages, essential-key hint items, and the localStorage hint counter (incl. unavailable storage).
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import type { Settings } from '../src/core/types';
import {
  HUD_HINTS_KEY,
  HUD_HINT_SESSIONS,
  HUD_HINT_SECONDS,
  claimHintSession,
  controlsHelpPages,
  effectiveCodes,
  formatKeyCode,
  hintItems,
  hintSessionsShown,
  type HelpPage,
  type HintStore,
} from '../src/ui/hud/controls';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

class MapStore implements HintStore {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

class BrokenStore implements HintStore {
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
}

const row = (page: HelpPage, label: string): string[] | undefined => {
  for (const s of page.sections) for (const r of s.rows) if (r.label === label) return r.keys;
  return undefined;
};

describe('key labels', () => {
  test('KeyboardEvent.code → readable label', () => {
    expect(formatKeyCode('KeyW')).toBe('W');
    expect(formatKeyCode('ArrowUp')).toBe('↑');
    expect(formatKeyCode('ArrowLeft')).toBe('←');
    expect(formatKeyCode('Space')).toBe('空白鍵');
    expect(formatKeyCode('ShiftLeft')).toBe('左 Shift');
    expect(formatKeyCode('ShiftRight')).toBe('右 Shift');
    expect(formatKeyCode('Escape')).toBe('Esc');
    expect(formatKeyCode('Digit5')).toBe('5');
    expect(formatKeyCode('Slash')).toBe('/');
  });
});

describe('binding routing for the help', () => {
  test('single player: P1 bindings; player 2 has none', () => {
    const s = settings();
    expect(effectiveCodes(s, 0, false, 'throttle')).toEqual(['KeyW', 'ArrowUp']);
    expect(effectiveCodes(s, 1, false, 'throttle')).toEqual([]);
  });

  test('split-screen: codes in keyBindingsP2 belong to P2 only; P2 shares the App-wide keys', () => {
    const s = settings();
    expect(effectiveCodes(s, 0, true, 'throttle')).toEqual(['KeyW']);
    expect(effectiveCodes(s, 1, true, 'throttle')).toEqual(['ArrowUp']);
    expect(effectiveCodes(s, 1, true, 'pause')).toEqual(['Escape', 'KeyP']);
    expect(effectiveCodes(s, 1, true, 'flashback')).toEqual(['KeyR']);
    expect(effectiveCodes(s, 1, true, 'limiter')).toEqual([]);
  });

  test('reflects custom bindings and tolerates malformed entries', () => {
    const s = settings({
      keyBindings: { ...DEFAULT_SETTINGS.keyBindings, drs: ['KeyG', '', 'KeyG'], camera: 'oops' as unknown as string[] },
      keyBindingsP2: { brake: ['KeyG'] },
    });
    expect(effectiveCodes(s, 0, false, 'drs')).toEqual(['KeyG']);
    expect(effectiveCodes(s, 0, false, 'camera')).toEqual([]);
    expect(effectiveCodes(s, 0, true, 'drs')).toEqual([]);
  });
});

describe('help pages', () => {
  test('single player: keyboard + gamepad pages built from the current bindings', () => {
    const pages = controlsHelpPages(settings({ keyBindings: { ...DEFAULT_SETTINGS.keyBindings, pause: ['KeyP'] } }), false);
    expect(pages.map((p) => p.id)).toEqual(['kb0', 'pad']);
    expect(row(pages[0], '油門')).toEqual(['W', '↑']);
    expect(row(pages[0], 'DRS／主動空力')).toEqual(['空白鍵']);
    expect(row(pages[0], '暫停')).toEqual(['P']);
    expect(row(pages[0], '超車加力（Overtake）')).toEqual(['左 Shift']);
  });

  test('split-screen adds a P2 page; unbound actions list no keys', () => {
    const pages = controlsHelpPages(settings(), true);
    expect(pages.map((p) => p.id)).toEqual(['kb0', 'kb1', 'pad']);
    expect(row(pages[0], '油門')).toEqual(['W']);
    expect(row(pages[1], '油門')).toEqual(['↑']);
    expect(row(pages[1], '維修道限速器')).toEqual([]);
    expect(row(pages[1], 'MFD：ERS 模式')).toEqual(['數字鍵盤 1–4']);
  });

  test('gamepad page follows the standard mapping', () => {
    const pad = controlsHelpPages(settings(), false)[1];
    expect(row(pad, '油門')).toEqual(['RT']);
    expect(row(pad, '煞車')).toEqual(['LT']);
    expect(row(pad, '向左轉')).toEqual(['左搖桿 ←']);
    expect(row(pad, 'DRS／主動空力')).toEqual(['A']);
    expect(row(pad, '回溯')).toEqual(['B']);
    expect(row(pad, '切換鏡頭')).toEqual(['Y']);
    expect(row(pad, '暫停')).toEqual(['Start']);
    expect(row(pad, '請求進站（Box）')).toEqual(['十字鍵 ↑']);
    expect(row(pad, '全螢幕')).toBeUndefined(); // no pad button: row omitted
    expect(row(pad, '返回／繼續')).toEqual(['B']);
  });
});

describe('hint strip items', () => {
  test('essential keys, at most two per item, steering as left／right pairs', () => {
    const items = hintItems(settings(), 0, false);
    expect(items.map((i) => i.label)).toEqual(['油門', '煞車', '轉向', 'DRS', '暫停', '回溯']);
    expect(items[0].keys).toEqual(['W', '↑']);
    expect(items[2].keys).toEqual(['A／D', '←／→']);
    expect(items[4].keys).toEqual(['Esc', 'P']);
    expect(items[5].keys).toEqual(['R']);
    for (const i of items) expect(i.keys.length).toBeLessThanOrEqual(2);
  });

  test('split-screen: each player sees their own keys', () => {
    expect(hintItems(settings(), 0, true)[2].keys).toEqual(['A／D']);
    const p2 = hintItems(settings(), 1, true);
    expect(p2[0].keys).toEqual(['↑']);
    expect(p2[2].keys).toEqual(['←／→']);
    expect(p2[3].keys).toEqual(['/']);
    expect(p2[4].keys).toEqual(['Esc', 'P']);
  });

  test('one-sided steering binding still shows', () => {
    const s = settings({ keyBindings: { ...DEFAULT_SETTINGS.keyBindings, steerLeft: ['KeyJ'], steerRight: [] } });
    expect(hintItems(s, 0, false)[2].keys).toEqual(['J']);
  });
});

describe('first-sessions counter', () => {
  test('key, session count and duration', () => {
    expect(HUD_HINTS_KEY).toBe('formula-nova:v1:hud-hints');
    expect(HUD_HINT_SESSIONS).toBe(3);
    expect(HUD_HINT_SECONDS).toBeCloseTo(12, 9);
  });

  test('shown for the first 3 sessions, persisted in storage', () => {
    const store = new MapStore();
    const memory = { count: 0 };
    expect([1, 2, 3, 4, 5].map(() => claimHintSession(store, memory))).toEqual([true, true, true, false, false]);
    expect(store.map.get(HUD_HINTS_KEY)).toBe('3');
    // a new page (fresh memory) still remembers
    expect(claimHintSession(store, { count: 0 })).toBe(false);
  });

  test('corrupt stored values count as zero', () => {
    const store = new MapStore();
    store.setItem(HUD_HINTS_KEY, 'not a number');
    expect(hintSessionsShown(store, { count: 0 })).toBe(0);
    store.setItem(HUD_HINTS_KEY, '-4');
    expect(claimHintSession(store, { count: 0 })).toBe(true);
    expect(store.map.get(HUD_HINTS_KEY)).toBe('1');
  });

  test('unavailable / throwing storage falls back to page memory without throwing', () => {
    const memory = { count: 0 };
    const broken = new BrokenStore();
    expect([1, 2, 3, 4].map(() => claimHintSession(broken, memory))).toEqual([true, true, true, false]);
    const none = { count: 0 };
    expect([1, 2, 3, 4].map(() => claimHintSession(null, none))).toEqual([true, true, true, false]);
  });
});
