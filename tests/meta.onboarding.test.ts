/**
 * Onboarding preference persistence + loading tips (pure meta logic).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { ASSIST_PRESETS } from '../src/core/defaults';
import { applyExperience, defaultProfile, EXPERIENCE_LEVELS } from '../src/meta/prefs';
import { loadProfile, saveProfile } from '../src/meta/save';
import { MemoryStore, setStore, storageKey } from '../src/meta/storage';
import { LOADING_TIPS, pickTip } from '../src/meta/tips';

beforeEach(() => {
  setStore(new MemoryStore());
});

describe('onboarding', () => {
  test('a fresh profile is not onboarded; the choice persists and survives reload', () => {
    expect(loadProfile().onboarded).toBe(false);
    for (const level of EXPERIENCE_LEVELS) {
      saveProfile(applyExperience(loadProfile(), level));
      const back = loadProfile();
      expect(back.onboarded).toBe(true);
      expect(back.assists).toEqual(ASSIST_PRESETS[level]);
    }
  });

  test('choosing again keeps stats and prefs and does not alias presets', () => {
    const p = defaultProfile();
    p.gp.laps = 'l10';
    p.stats.racesFinished = 7;
    const next = applyExperience(p, 'expert');
    expect(next.gp.laps).toBe('l10');
    expect(next.stats.racesFinished).toBe(7);
    next.assists.abs = true;
    expect(ASSIST_PRESETS.expert.abs).toBe(false);
  });

  test('a stored profile without the flag counts as not onboarded', () => {
    const store = new MemoryStore();
    setStore(store);
    store.setItem(storageKey('profile'), JSON.stringify({ schema: 1, data: { gp: { laps: 'l3' } } }));
    expect(loadProfile().onboarded).toBe(false);
  });
});

describe('loading tips', () => {
  test('at least 12 distinct zh-TW tips; pickTip is total', () => {
    expect(LOADING_TIPS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(LOADING_TIPS).size).toBe(LOADING_TIPS.length);
    expect(pickTip(0)).toBe(LOADING_TIPS[0]);
    expect(pickTip(0.999999)).toBe(LOADING_TIPS[LOADING_TIPS.length - 1]);
    expect(pickTip(Number.NaN)).toBe(LOADING_TIPS[0]);
    expect(pickTip(5)).toBe(LOADING_TIPS[LOADING_TIPS.length - 1]);
  });
});
