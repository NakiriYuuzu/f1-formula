/**
 * zh-TW display labels for enums, keys, nationalities and formatting helpers used across menu screens.
 */
import type {
  Assists,
  Biome,
  BrakingAssist,
  CameraMode,
  CarPartId,
  DamageLevel,
  GameMode,
  GearboxMode,
  KeyAction,
  QualityLevel,
  RacingLineMode,
  SafetyCarSetting,
  SessionKind,
  TimeOfDay,
  TractionControl,
  WeatherKind,
} from '../../core/types';
import type { PartGroup } from '../../meta/development';
import type { AssistPreset, LapsChoice, QualifyingType, TimeOfDayChoice, WeatherChoice, WeekendFormat, WeekendStep } from '../../meta/options';
import { resolveLaps } from '../../meta/options';

export const WEATHER_LABEL: Record<WeatherChoice, string> = {
  clear: '晴天',
  overcast: '陰天',
  lightRain: '小雨',
  heavyRain: '大雨',
  dynamic: '動態天氣',
};

export function weatherLabel(w: WeatherKind | WeatherChoice): string {
  return WEATHER_LABEL[w];
}

export const TIME_LABEL: Record<TimeOfDayChoice, string> = { auto: '賽道預設', day: '白天', dusk: '黃昏', night: '夜間' };

export function timeLabel(t: TimeOfDay | TimeOfDayChoice): string {
  return TIME_LABEL[t];
}

export const KIND_LABEL: Record<SessionKind, string> = {
  practice: '練習賽',
  qualifying: '排位賽',
  race: '正賽',
  timeTrial: '計時賽',
};

export const STEP_LABEL: Record<WeekendStep, string> = { ...KIND_LABEL, sprint: '衝刺賽' };

/** Session label; a race-kind session flagged as sprint reads 「衝刺賽」. */
export function kindLabel(kind: SessionKind, sprint?: boolean): string {
  return sprint === true && kind === 'race' ? STEP_LABEL.sprint : KIND_LABEL[kind];
}

export const SAFETY_CAR_LABEL: Record<SafetyCarSetting, string> = {
  off: '關閉',
  reduced: '減少',
  standard: '標準',
  increased: '增加',
};

export const MODE_LABEL: Record<GameMode, string> = {
  grandPrix: '大獎賽',
  timeTrial: '計時賽',
  career: '車手生涯',
  myTeam: '我的車隊',
  story: '新星之路',
  splitScreen: '雙人分割畫面',
};

export const FORMAT_LABEL: Record<WeekendFormat, string> = {
  raceOnly: '只有正賽',
  qualiRace: '排位＋正賽',
  full: '練習＋排位＋正賽',
  sprint: '衝刺賽週末',
};

/** Format hint shown under the weekend-format selector. */
export const SPRINT_WEEKEND_DESCRIPTION =
  '衝刺賽週末：排位 → 衝刺賽（約 1/3 賽程、前 8 名計分、無強制進站）→ 正賽；衝刺賽與正賽都依排位順序發車';

export const QUALI_LABEL: Record<QualifyingType, string> = { oneShot: '單圈排位', short: '短排位（3 圈）' };

/** Race length label; `fullLaps` null = layout unknown (percentages shown without a lap count). */
export function lapsLabel(choice: LapsChoice, fullLaps: number | null): string {
  const n = resolveLaps(choice, fullLaps ?? 0);
  const pct = choice === 'p25' ? '25%' : choice === 'p50' ? '50%' : choice === 'p100' ? '100%' : null;
  if (pct === null) return `${n} 圈`;
  return fullLaps === null ? `${pct} 賽程` : `${pct}（${n} 圈）`;
}

export const DAMAGE_LABEL: Record<DamageLevel, string> = { off: '關閉', reduced: '減輕', full: '完整' };

export const BIOME_LABEL: Record<Biome, string> = {
  desert: '沙漠',
  temperate: '溫帶山地',
  city: '城市街道',
  coastal: '海岸',
  autumn: '秋季丘陵',
  tropical: '熱帶',
};

export const QUALITY_LABEL: Record<QualityLevel, string> = { low: '低', medium: '中', high: '高', ultra: '極致' };

export const CAMERA_LABEL: Record<CameraMode, string> = {
  chase: '追焦',
  chaseFar: '遠距追焦',
  tcam: 'T 字鏡頭',
  cockpit: '座艙',
  nose: '鼻錐',
  tv: '電視轉播',
};

export const PRESET_LABEL: Record<AssistPreset, string> = { beginner: '新手', intermediate: '進階', expert: '專家', custom: '自訂' };
export const BRAKING_LABEL: Record<BrakingAssist, string> = { off: '關閉', low: '低', high: '高' };
export const TRACTION_LABEL: Record<TractionControl, string> = { off: '關閉', medium: '中', full: '完整' };
export const GEARBOX_LABEL: Record<GearboxMode, string> = { auto: '自動', manual: '手動' };
export const RACING_LINE_LABEL: Record<RacingLineMode, string> = { off: '關閉', corners: '僅彎道', full: '完整' };

export const ASSIST_LABEL: Record<keyof Assists, string> = {
  steering: '轉向輔助',
  braking: '煞車輔助',
  abs: 'ABS 防鎖死',
  traction: '循跡控制',
  gearbox: '變速箱',
  racingLine: '行車線',
  ersAssist: 'ERS 輔助',
  drsAssist: 'DRS 輔助',
  scLimiter: '安全車限速',
  pitAssist: '進站自動駕駛',
};

export const PART_LABEL: Record<CarPartId, string> = {
  frontWing: '前翼',
  rearWing: '尾翼',
  floor: '底板',
  suspension: '懸吊',
  powerUnit: '動力單元',
  ers: 'ERS',
  gearbox: '變速箱',
  brakes: '煞車',
  weight: '輕量化',
  reliability: '可靠度',
};

/** Effect of one fully successful level (physics/spec.ts createCarSpec, per 1.0 gain). */
export const PART_EFFECT: Record<CarPartId, string> = {
  frontWing: '每級前軸下壓力 +1.6%，空力平衡略往前',
  rearWing: '每級後軸下壓力 +0.5%、空氣阻力 −0.8%',
  floor: '每級前後軸下壓力 +1%',
  suspension: '每級機械抓地力 +0.4%、路緣石抓地提升、輪胎磨耗 −2%',
  powerUnit: '每級內燃機馬力 +1.2%',
  ers: '每級 ERS 輸出與電能回收 +3%',
  gearbox: '每級傳動效率 +0.4 個百分點（88% → 滿級 90%）',
  brakes: '每級最大煞車力 +3%、煞車回收電能 +2%；滿級時煞車減速度最多 +3%、最大煞車力 +15%',
  weight: '每級車重 −2 kg',
  reliability: '每級碰撞損傷 −4%',
};

export const PART_GROUP_LABEL: Record<PartGroup, string> = { aero: '空力', power: '動力', chassis: '底盤' };

export const KEY_ACTION_LABEL: Record<KeyAction, string> = {
  throttle: '油門',
  brake: '煞車',
  steerLeft: '向左轉',
  steerRight: '向右轉',
  shiftUp: '升檔',
  shiftDown: '降檔',
  drs: 'DRS／主動空力',
  overtake: '超車加力（Overtake）',
  ersCycle: '切換 ERS 模式',
  limiter: '維修道限速器',
  camera: '切換鏡頭',
  lookBack: '後視',
  pause: '暫停',
  flashback: '回溯',
  mfd: '多功能顯示（MFD）',
  pitRequest: '請求進站（Box）',
  fullscreen: '全螢幕',
  hud: '顯示／隱藏 HUD',
};

const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: '空白鍵',
  Enter: 'Enter',
  NumpadEnter: '數字 Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ShiftLeft: '左 Shift',
  ShiftRight: '右 Shift',
  ControlLeft: '左 Ctrl',
  ControlRight: '右 Ctrl',
  AltLeft: '左 Alt',
  AltRight: '右 Alt',
  MetaLeft: '左 ⌘',
  MetaRight: '右 ⌘',
  CapsLock: 'Caps Lock',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Quote: "'",
  Semicolon: ';',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
};

/** Human label for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `數字 ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code.replace(/^Numpad/, '數字 ');
}

/** ISO alpha-3 nationalities offered in the driver creator (covers every code used by the fictional field). */
export const NATIONALITIES: readonly { code: string; label: string }[] = [
  { code: 'TWN', label: '臺灣' },
  { code: 'JPN', label: '日本' },
  { code: 'KOR', label: '韓國' },
  { code: 'CHN', label: '中國' },
  { code: 'HKG', label: '香港' },
  { code: 'SGP', label: '新加坡' },
  { code: 'MYS', label: '馬來西亞' },
  { code: 'THA', label: '泰國' },
  { code: 'IND', label: '印度' },
  { code: 'AUS', label: '澳洲' },
  { code: 'NZL', label: '紐西蘭' },
  { code: 'USA', label: '美國' },
  { code: 'CAN', label: '加拿大' },
  { code: 'MEX', label: '墨西哥' },
  { code: 'BRA', label: '巴西' },
  { code: 'ARG', label: '阿根廷' },
  { code: 'CHL', label: '智利' },
  { code: 'COL', label: '哥倫比亞' },
  { code: 'GBR', label: '英國' },
  { code: 'IRL', label: '愛爾蘭' },
  { code: 'FRA', label: '法國' },
  { code: 'DEU', label: '德國' },
  { code: 'ITA', label: '義大利' },
  { code: 'ESP', label: '西班牙' },
  { code: 'PRT', label: '葡萄牙' },
  { code: 'NLD', label: '荷蘭' },
  { code: 'BEL', label: '比利時' },
  { code: 'MCO', label: '摩納哥' },
  { code: 'CHE', label: '瑞士' },
  { code: 'AUT', label: '奧地利' },
  { code: 'DNK', label: '丹麥' },
  { code: 'SWE', label: '瑞典' },
  { code: 'NOR', label: '挪威' },
  { code: 'FIN', label: '芬蘭' },
  { code: 'POL', label: '波蘭' },
  { code: 'CZE', label: '捷克' },
  { code: 'HUN', label: '匈牙利' },
  { code: 'MAR', label: '摩洛哥' },
  { code: 'NGA', label: '奈及利亞' },
  { code: 'ZAF', label: '南非' },
];

export function nationalityLabel(code: string): string {
  return NATIONALITIES.find((n) => n.code === code)?.label ?? code;
}

export function difficultyLabel(v: number): string {
  if (v < 30) return '新手';
  if (v < 60) return '業餘';
  if (v < 85) return '職業';
  if (v < 100) return '菁英';
  return '傳奇';
}

/** "12.5 M" */
export function money(v: number): string {
  return `${Number.isFinite(v) ? v.toFixed(1) : '0.0'} M`;
}

export function ordinal(pos: number): string {
  return pos >= 1 ? `P${pos}` : '—';
}

/** "1:23" for minutes:seconds limits. */
export function minutesLabel(seconds: number): string {
  return `${Math.round(seconds / 60)} 分鐘`;
}
