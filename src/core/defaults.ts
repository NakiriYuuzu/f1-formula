/**
 * Shared defaults & tuning reference (owned by the architect; feature agents must NOT edit).
 */
import type {
  Assists,
  CarSetup,
  KeyAction,
  SessionRules,
  Settings,
  TireCompound,
} from './types';

export const GAME_TITLE = 'FORMULA NOVA 25';
export const GAME_TITLE_ZH = '新星方程式 25';

/** Simulation fixed timestep (s). App runs stepWorld at this rate (accumulator). */
export const SIM_DT = 1 / 120;

/**
 * Reference car used for the track speed profile / reference lap time and as the physics calibration
 * target. Physics should land within ~±8 % of these capabilities for a neutral setup on soft tyres.
 */
export const REFERENCE_CAR = {
  /** kg incl. driver + 50 kg fuel */
  mass: 850,
  /** W total (ICE + ERS) */
  power: 760_000,
  dragArea: 1.3,
  downforceArea: 4.2,
  /** dry soft-tyre friction coefficient */
  mu: 1.75,
  /** max straight-line braking decel at low speed (m/s²), aero adds on top */
  brakeDecel: 1.75 * 9.81,
  /** top speed without DRS (m/s) ≈ 330 km/h */
  topSpeed: 92,
  /** pit-lane limit (m/s) */
  pitSpeed: 80 / 3.6,
} as const;

/** 2025 points: top 10, no fastest-lap point. */
export const POINTS_TABLE: readonly number[] = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
/** Sprint race points: top 8. */
export const SPRINT_POINTS: readonly number[] = [8, 7, 6, 5, 4, 3, 2, 1];

export const COMPOUNDS: readonly TireCompound[] = ['soft', 'medium', 'hard', 'inter', 'wet'];
export const DRY_COMPOUNDS: readonly TireCompound[] = ['soft', 'medium', 'hard'];

/** Display info for tyre compounds (UI + renderer sidewall colors). */
export const COMPOUND_INFO: Record<TireCompound, { label: string; letter: string; color: string }> = {
  soft: { label: '軟胎', letter: 'S', color: '#e8322f' },
  medium: { label: '中性胎', letter: 'M', color: '#f2c230' },
  hard: { label: '硬胎', letter: 'H', color: '#f2f2f2' },
  inter: { label: '半雨胎', letter: 'I', color: '#3bb54a' },
  wet: { label: '全雨胎', letter: 'W', color: '#2f7fe8' },
};

export const DEFAULT_SETUP: CarSetup = {
  frontWing: 25,
  rearWing: 25,
  diffOnThrottle: 55,
  brakeBias: 57,
  suspension: 6,
  rideHeight: 5,
  tyrePressure: 6,
};

export interface SetupRange {
  key: keyof CarSetup;
  label: string;
  min: number;
  max: number;
  step: number;
  /** zh-TW: what moving the slider up does */
  description: string;
}

export const SETUP_RANGES: SetupRange[] = [
  { key: 'frontWing', label: '前翼角度', min: 0, max: 50, step: 1, description: '提高：前軸下壓力增加、轉向更靈敏，但直線阻力略增' },
  { key: 'rearWing', label: '尾翼角度', min: 0, max: 50, step: 1, description: '提高：後軸抓地與穩定性增加，但極速下降' },
  { key: 'diffOnThrottle', label: '差速器（油門）', min: 10, max: 100, step: 5, description: '提高：出彎牽引力更好，但較易轉向不足' },
  { key: 'brakeBias', label: '煞車平衡（前 %）', min: 50, max: 70, step: 1, description: '提高：前輪較易鎖死，後輪較穩定' },
  { key: 'suspension', label: '懸吊硬度', min: 1, max: 11, step: 1, description: '提高：反應更直接、空力平台穩定，但壓過路緣石時較不穩' },
  { key: 'rideHeight', label: '車身高度', min: 1, max: 11, step: 1, description: '提高：下壓力下降，但壓路緣石較不易失控' },
  { key: 'tyrePressure', label: '胎壓', min: 1, max: 11, step: 1, description: '提高：直線較快、升溫快，但抓地與耐磨下降' },
];

export const ASSIST_PRESETS: Record<'beginner' | 'intermediate' | 'expert', Assists> = {
  beginner: {
    steering: true,
    braking: 'high',
    abs: true,
    traction: 'full',
    gearbox: 'auto',
    racingLine: 'full',
    ersAssist: true,
    drsAssist: true,
    scLimiter: true,
    pitAssist: true,
  },
  intermediate: {
    steering: false,
    braking: 'off',
    abs: true,
    traction: 'medium',
    gearbox: 'auto',
    racingLine: 'corners',
    ersAssist: true,
    drsAssist: false,
    scLimiter: true,
    pitAssist: false,
  },
  expert: {
    steering: false,
    braking: 'off',
    abs: false,
    traction: 'off',
    gearbox: 'manual',
    racingLine: 'off',
    ersAssist: false,
    drsAssist: false,
    scLimiter: true,
    pitAssist: false,
  },
};

export const DEFAULT_ASSISTS: Assists = { ...ASSIST_PRESETS.intermediate };

/** Assists applied to AI-driven cars (the AI controller outputs raw inputs; these keep it stable). */
export const AI_ASSISTS: Assists = {
  steering: false,
  braking: 'off',
  abs: true,
  traction: 'medium',
  gearbox: 'auto',
  racingLine: 'off',
  ersAssist: true,
  drsAssist: true,
  scLimiter: false,
  pitAssist: true,
};

export const DEFAULT_RULES: SessionRules = {
  tyreWear: true,
  fuel: true,
  damage: 'reduced',
  trackLimits: true,
  mandatoryPitStop: false,
  flashbacks: -1,
  collisions: true,
  safetyCar: 'standard',
  redFlags: true,
  formationLap: false,
  aeroWake: true,
};

export const DEFAULT_KEY_BINDINGS: Record<KeyAction, string[]> = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  shiftUp: ['KeyE'],
  shiftDown: ['KeyQ'],
  drs: ['Space'],
  overtake: ['ShiftLeft'],
  ersCycle: ['KeyX'],
  limiter: ['KeyL'],
  camera: ['KeyC'],
  lookBack: ['KeyV'],
  pause: ['Escape', 'KeyP'],
  flashback: ['KeyR'],
  mfd: ['KeyM'],
  pitRequest: ['KeyB'],
  fullscreen: ['KeyF'],
  hud: ['KeyH'],
};

/** Split-screen player 2. In split-screen, any key listed here is routed exclusively to player 2. */
export const DEFAULT_KEY_BINDINGS_P2: Partial<Record<KeyAction, string[]>> = {
  throttle: ['ArrowUp'],
  brake: ['ArrowDown'],
  steerLeft: ['ArrowLeft'],
  steerRight: ['ArrowRight'],
  shiftUp: ['Period'],
  shiftDown: ['Comma'],
  drs: ['Slash'],
  overtake: ['ShiftRight'],
  camera: ['Backslash'],
  lookBack: ['Quote'],
  ersCycle: ['Semicolon'],
  pitRequest: ['BracketLeft'],
  mfd: ['BracketRight'],
};

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  resolutionScale: 1,
  shadows: true,
  antialias: true,
  showFps: false,
  fov: 68,
  masterVolume: 0.8,
  engineVolume: 0.8,
  sfxVolume: 0.8,
  uiVolume: 0.6,
  musicVolume: 0.6,
  // the player's bundled track (public/music/) when installed; without one the original track plays
  musicSource: 'bundled',
  musicInRace: false,
  units: 'kmh',
  defaultCamera: 'chase',
  cameraShake: true,
  steeringSensitivity: 1,
  deadzone: 0.08,
  vibration: true,
  keyBindings: DEFAULT_KEY_BINDINGS,
  keyBindingsP2: DEFAULT_KEY_BINDINGS_P2,
  hud: { minimap: true, tower: true, telemetry: true, radio: true },
};

/** localStorage key prefix — every persisted key must start with this. */
export const STORAGE_PREFIX = 'formula-nova:';
