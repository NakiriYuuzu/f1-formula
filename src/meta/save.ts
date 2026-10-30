/**
 * Persistence (owner: menus agent). localStorage, every key prefixed with STORAGE_PREFIX, JSON, versioned,
 * corrupt/missing data falls back to defaults (never throws). In-memory fallback when localStorage is unavailable.
 */
import type { CameraMode, CarSetup, GhostData, KeyAction, PlayerIndex, Regulation, Settings } from '../core/types';
import { DEFAULT_KEY_BINDINGS, DEFAULT_SETTINGS, DEFAULT_SETUP } from '../core/defaults';
import { sanitizeAchievements, type AchievementSave } from './achievements';
import { sanitizeCareer, type CareerSave } from './career';
import { asRecord, bool, isRecord, num, oneOf, sanitizeGhost, sanitizeSetup, stringArray } from './guards';
import { sanitizeMyTeam, type MyTeamSave } from './myTeam';
import { listLayouts } from './options';
import { defaultProfile, sanitizeProfile, sanitizeSetupBook, type ProfileSave } from './prefs';
import { rosterSaveSuffix } from './rosterPack';
import { readRecord, removeRecord, writeRecord } from './storage';
import { emptyStoryProgress, sanitizeStoryProgress, type StoryProgress } from './story';
import { compactGhost, sanitizeTimeTrialRecords, type TimeTrialRecords } from './timeTrial';

/** Every rebindable action, in display order. */
export const KEY_ACTIONS: readonly KeyAction[] = Object.keys(DEFAULT_KEY_BINDINGS) as KeyAction[];

const QUALITY = ['low', 'medium', 'high', 'ultra'] as const;
const CAMERAS: readonly CameraMode[] = ['chase', 'chaseFar', 'tcam', 'cockpit', 'nose', 'tv'];
const MAX_KEYS_PER_ACTION = 4;
/** a pasted YouTube link (watch / playlist URLs stay far below this) */
const MAX_LINK = 300;
/** YouTube links played in turn (`musicYoutube` + `musicYoutubeExtra`) */
export const MAX_YOUTUBE_LINKS = 50;

/** Deep copy of the default settings (never hand out the shared default objects). */
export function defaultSettings(): Settings {
  return cloneSettings(DEFAULT_SETTINGS);
}

export function cloneSettings(s: Settings): Settings {
  const keyBindings = {} as Record<KeyAction, string[]>;
  for (const action of KEY_ACTIONS) keyBindings[action] = [...(s.keyBindings[action] ?? [])];
  const keyBindingsP2: Partial<Record<KeyAction, string[]>> = {};
  for (const action of KEY_ACTIONS) {
    const keys = s.keyBindingsP2[action];
    if (keys) keyBindingsP2[action] = [...keys];
  }
  return { ...s, musicYoutubeExtra: [...s.musicYoutubeExtra], keyBindings, keyBindingsP2, hud: { ...s.hud } };
}

/** Validate every Settings field; unknown / invalid values fall back to defaults. */
export function sanitizeSettings(v: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = asRecord(v);
  const rawP1 = asRecord(r.keyBindings);
  const keyBindings = {} as Record<KeyAction, string[]>;
  for (const action of KEY_ACTIONS) {
    keyBindings[action] = stringArray(rawP1[action], MAX_KEYS_PER_ACTION, d.keyBindings[action]);
  }
  // the pause key is the keyboard's only way out of a session: never leave it unbound
  if (keyBindings.pause.length === 0) keyBindings.pause = [...d.keyBindings.pause];
  let keyBindingsP2: Partial<Record<KeyAction, string[]>> = {};
  if (isRecord(r.keyBindingsP2)) {
    for (const action of KEY_ACTIONS) {
      const raw = r.keyBindingsP2[action];
      if (Array.isArray(raw)) keyBindingsP2[action] = stringArray(raw, MAX_KEYS_PER_ACTION, []);
    }
    // actions added after the save was written: default codes, unless another P2 action or P1 already uses them
    const taken = new Set<string>();
    for (const action of KEY_ACTIONS) for (const code of [...(keyBindingsP2[action] ?? []), ...keyBindings[action]]) taken.add(code);
    for (const action of KEY_ACTIONS) {
      if (keyBindingsP2[action] !== undefined) continue;
      const codes = (d.keyBindingsP2[action] ?? []).filter((c) => !taken.has(c));
      if (codes.length === 0) continue;
      keyBindingsP2[action] = codes;
      for (const c of codes) taken.add(c);
    }
  } else {
    keyBindingsP2 = cloneSettings(d).keyBindingsP2;
  }
  const hud = asRecord(r.hud);
  return {
    quality: oneOf(r.quality, QUALITY, d.quality),
    resolutionScale: num(r.resolutionScale, 0.5, 1, d.resolutionScale),
    shadows: bool(r.shadows, d.shadows),
    antialias: bool(r.antialias, d.antialias),
    showFps: bool(r.showFps, d.showFps),
    fov: num(r.fov, 50, 90, d.fov),
    masterVolume: num(r.masterVolume, 0, 1, d.masterVolume),
    engineVolume: num(r.engineVolume, 0, 1, d.engineVolume),
    sfxVolume: num(r.sfxVolume, 0, 1, d.sfxVolume),
    uiVolume: num(r.uiVolume, 0, 1, d.uiVolume),
    musicVolume: num(r.musicVolume, 0, 1, d.musicVolume),
    musicSource: oneOf(r.musicSource, ['original', 'bundled', 'custom', 'youtube', 'off'] as const, d.musicSource),
    musicYoutube: typeof r.musicYoutube === 'string' ? r.musicYoutube.trim().slice(0, MAX_LINK) : d.musicYoutube,
    musicYoutubeExtra: Array.isArray(r.musicYoutubeExtra)
      ? r.musicYoutubeExtra
          .filter((l): l is string => typeof l === 'string')
          .map((l) => l.trim().slice(0, MAX_LINK))
          .filter((l) => l !== '')
          .slice(0, MAX_YOUTUBE_LINKS - 1)
      : [...d.musicYoutubeExtra],
    musicInRace: bool(r.musicInRace, d.musicInRace),
    units: oneOf(r.units, ['kmh', 'mph'] as const, d.units),
    defaultCamera: oneOf(r.defaultCamera, CAMERAS, d.defaultCamera),
    cameraShake: bool(r.cameraShake, d.cameraShake),
    // `false` = the earlier on/off toggle switched off
    speedBlur: r.speedBlur === false ? 0 : num(r.speedBlur, 0, 1, d.speedBlur),
    steeringSensitivity: num(r.steeringSensitivity, 0.5, 1.5, d.steeringSensitivity),
    deadzone: num(r.deadzone, 0, 0.3, d.deadzone),
    vibration: bool(r.vibration, d.vibration),
    keyBindings,
    keyBindingsP2,
    hud: {
      minimap: bool(hud.minimap, d.hud.minimap),
      tower: bool(hud.tower, d.hud.tower),
      telemetry: bool(hud.telemetry, d.hud.telemetry),
      radio: bool(hud.radio, d.hud.radio),
    },
  };
}

export function loadSettings(): Settings {
  const raw = readRecord('settings');
  return raw === undefined ? defaultSettings() : sanitizeSettings(raw);
}

export function saveSettings(settings: Settings): void {
  writeRecord('settings', sanitizeSettings(settings));
}

// ───────────────────────────── profile & setups ─────────────────────────────

export function loadProfile(): ProfileSave {
  const raw = readRecord('profile');
  return raw === undefined ? defaultProfile() : sanitizeProfile(raw);
}

export function saveProfile(profile: ProfileSave): void {
  writeRecord('profile', sanitizeProfile(profile));
}

/** Setup-book key: player 1 per layout; split-screen player 2 keeps a separate entry (online rooms: loadOnlineSetup). */
function setupKey(layoutId: string, playerIndex: PlayerIndex): string {
  return playerIndex === 1 ? `${layoutId}--p2` : layoutId;
}

/** Last car setup used on a layout (player 2 falls back to player 1's; default setup if none). */
export function loadSetup(layoutId: string, playerIndex: PlayerIndex = 0): CarSetup {
  const book = sanitizeSetupBook(readRecord('setups'));
  const found = book[setupKey(layoutId, playerIndex)] ?? book[layoutId];
  return found ? { ...found } : { ...DEFAULT_SETUP };
}

export function saveSetup(layoutId: string, setup: CarSetup, playerIndex: PlayerIndex = 0): void {
  const book = sanitizeSetupBook(readRecord('setups'));
  book[setupKey(layoutId, playerIndex)] = sanitizeSetup(setup);
  writeRecord('setups', book);
}

/** Car setup for online rooms on a layout: its own book, a layout not set up online yet starts from the single-player one. */
export function loadOnlineSetup(layoutId: string): CarSetup {
  const found = sanitizeSetupBook(readRecord('onlineSetups'))[layoutId];
  return found ? { ...found } : loadSetup(layoutId);
}

/** Online setups never touch the single-player book. */
export function saveOnlineSetup(layoutId: string, setup: CarSetup): void {
  const book = sanitizeSetupBook(readRecord('onlineSetups'));
  book[layoutId] = sanitizeSetup(setup);
  writeRecord('onlineSetups', book);
}

// ───────────────────────────── time trial ─────────────────────────────

export function loadTimeTrialRecords(): TimeTrialRecords {
  return sanitizeTimeTrialRecords(readRecord('timeTrial'));
}

export function saveTimeTrialRecords(records: TimeTrialRecords): void {
  writeRecord('timeTrial', sanitizeTimeTrialRecords(records));
}

function ghostName(layoutId: string, regulation: Regulation): string {
  return `ghost:${layoutId}:${regulation}`;
}

export function loadGhost(layoutId: string, regulation: Regulation): GhostData | null {
  const ghost = sanitizeGhost(readRecord(ghostName(layoutId, regulation)));
  return ghost && ghost.layoutId === layoutId ? ghost : null;
}

/** Store the PB ghost (compacted). Returns false if it could only be kept for this page session. */
export function saveGhost(ghost: GhostData, regulation: Regulation): boolean {
  const clean = sanitizeGhost(ghost);
  if (!clean) return false;
  return writeRecord(ghostName(clean.layoutId, regulation), compactGhost(clean));
}

// ───────────────────────────── career / My Team / story / achievements ─────────────────────────────

/** Career / My Team records of an imported roster pack live beside the built-in ones (switching keeps both). */
function seasonRecord(name: string): string {
  return name + rosterSaveSuffix();
}

export function loadCareer(): CareerSave | null {
  const raw = readRecord(seasonRecord('career'));
  return raw === undefined ? null : sanitizeCareer(raw, listLayouts());
}

export function saveCareer(career: CareerSave | null): void {
  if (career === null) removeRecord(seasonRecord('career'));
  else writeRecord(seasonRecord('career'), career);
}

export function loadMyTeam(): MyTeamSave | null {
  const raw = readRecord(seasonRecord('myTeam'));
  return raw === undefined ? null : sanitizeMyTeam(raw, listLayouts());
}

export function saveMyTeam(team: MyTeamSave | null): void {
  if (team === null) removeRecord(seasonRecord('myTeam'));
  else writeRecord(seasonRecord('myTeam'), team);
}

export function loadStory(): StoryProgress {
  const raw = readRecord('story');
  return raw === undefined ? emptyStoryProgress() : sanitizeStoryProgress(raw);
}

export function saveStory(progress: StoryProgress): void {
  writeRecord('story', sanitizeStoryProgress(progress));
}

export function loadAchievements(): AchievementSave {
  return sanitizeAchievements(readRecord('achievements'));
}

export function saveAchievements(save: AchievementSave): void {
  writeRecord('achievements', sanitizeAchievements(save));
}
