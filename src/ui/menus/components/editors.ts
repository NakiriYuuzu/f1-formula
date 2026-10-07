/**
 * Form editors shared by several screens: driving assists (preset + every item), session rules,
 * race options (laps / difficulty / weather / time / regulation / format / qualifying) and season settings.
 */
import type { Assists, Regulation, SafetyCarSetting, SessionRules } from '../../../core/types';
import { ASSIST_PRESETS } from '../../../core/defaults';
import {
  detectAssistPreset,
  LAPS_CHOICES,
  QUALIFYING_TYPES,
  TIME_OF_DAY_CHOICES,
  WEATHER_CHOICES,
  WEEKEND_FORMATS,
  type AssistPreset,
  type LapsChoice,
  type QualifyingType,
  type TimeOfDayChoice,
  type WeatherChoice,
  type WeekendFormat,
} from '../../../meta/options';
import { SAFETY_CAR_SETTINGS } from '../../../meta/guards';
import { SEASON_FORMATS, type CalendarKind, type SeasonSettings } from '../../../meta/season';
import { h } from '../dom';
import {
  ASSIST_LABEL,
  BRAKING_LABEL,
  DAMAGE_LABEL,
  difficultyLabel,
  FORMAT_LABEL,
  GEARBOX_LABEL,
  lapsLabel,
  PRESET_LABEL,
  QUALI_LABEL,
  RACING_LINE_LABEL,
  SAFETY_CAR_LABEL,
  SPRINT_WEEKEND_DESCRIPTION,
  TIME_LABEL,
  TRACTION_LABEL,
  WEATHER_LABEL,
} from '../labels';
import { cycler, panel, slider, toggle, type Control, type CyclerControl } from '../widgets';

function opts<T extends string>(values: readonly T[], labels: Record<T, string>): { value: T; label: string }[] {
  return values.map((v) => ({ value: v, label: labels[v] }));
}

const FIXED_PRESETS: readonly AssistPreset[] = ['beginner', 'intermediate', 'expert'];

/**
 * Assist preset + individual assists. Calls onChange with a fresh object on every change. 「自訂」 is offered once
 * a custom set exists and restores the latest one.
 */
export function assistsEditor(initial: Assists, onChange: (a: Assists) => void, title = '駕駛輔助'): HTMLElement {
  let value: Assists = { ...initial };
  let custom: Assists | null = detectAssistPreset(value) === 'custom' ? { ...value } : null;
  const presetOptions = (): { value: AssistPreset; label: string }[] =>
    opts(custom ? [...FIXED_PRESETS, 'custom'] : FIXED_PRESETS, PRESET_LABEL);
  const refreshers: (() => void)[] = [];
  const emit = (): void => {
    const p = detectAssistPreset(value);
    if (p === 'custom') {
      const first = custom === null;
      custom = { ...value };
      if (first) preset.setOptions(presetOptions());
    }
    preset.set(p);
    onChange({ ...value });
  };
  const preset = cycler<AssistPreset>({
    label: '輔助預設',
    options: presetOptions(),
    value: detectAssistPreset(value),
    onChange: (p) => {
      value = p === 'custom' ? { ...(custom ?? value) } : { ...ASSIST_PRESETS[p] };
      for (const refresh of refreshers) refresh();
      onChange({ ...value });
    },
    description: '選擇預設後仍可個別調整（會自動切為「自訂」）',
  });
  const add = <K extends keyof Assists>(key: K, control: Control<Assists[K]>): HTMLElement => {
    refreshers.push(() => control.set(value[key]));
    return control.el;
  };
  const set = <K extends keyof Assists>(key: K) => (v: Assists[K]): void => {
    value = { ...value, [key]: v };
    emit();
  };
  return panel(
    title,
    preset.el,
    add('steering', toggle(ASSIST_LABEL.steering, value.steering, set('steering'), '高速時降低轉向幅度並協助反打')),
    add('braking', cycler({ label: ASSIST_LABEL.braking, options: opts(['off', 'low', 'high'] as const, BRAKING_LABEL), value: value.braking, onChange: set('braking') })),
    add('abs', toggle(ASSIST_LABEL.abs, value.abs, set('abs'))),
    add('traction', cycler({ label: ASSIST_LABEL.traction, options: opts(['off', 'medium', 'full'] as const, TRACTION_LABEL), value: value.traction, onChange: set('traction') })),
    add('gearbox', cycler({ label: ASSIST_LABEL.gearbox, options: opts(['auto', 'manual'] as const, GEARBOX_LABEL), value: value.gearbox, onChange: set('gearbox') })),
    add('racingLine', cycler({ label: ASSIST_LABEL.racingLine, options: opts(['off', 'corners', 'full'] as const, RACING_LINE_LABEL), value: value.racingLine, onChange: set('racingLine') })),
    add('ersAssist', toggle(ASSIST_LABEL.ersAssist, value.ersAssist, set('ersAssist'), '自動管理電池釋放模式')),
    add('drsAssist', toggle(ASSIST_LABEL.drsAssist, value.drsAssist, set('drsAssist'), '可用時自動開啟 DRS／主動空力')),
    add('scLimiter', toggle(ASSIST_LABEL.scLimiter, value.scLimiter, set('scLimiter'), '安全車期間自動控制車速（收油、必要時輕踩煞車）：不會超過前車或安全車，落後時仍可加速追上')),
  );
}

/** Compact preset-only assist selector (time trial, split-screen per player); a custom initial set stays selectable. */
export function assistPresetCycler(label: string, initial: Assists, onChange: (a: Assists) => void): CyclerControl<AssistPreset> {
  const current = detectAssistPreset(initial);
  const custom = current === 'custom' ? { ...initial } : null;
  return cycler<AssistPreset>({
    label,
    options: opts(custom ? [...FIXED_PRESETS, 'custom'] : FIXED_PRESETS, PRESET_LABEL),
    value: current,
    onChange: (p) => onChange(p === 'custom' ? { ...(custom ?? initial) } : { ...ASSIST_PRESETS[p] }),
  });
}

const FLASHBACK_OPTIONS = [
  { value: -1, label: '無限' },
  { value: 0, label: '停用' },
  { value: 1, label: '1 次' },
  { value: 3, label: '3 次' },
  { value: 5, label: '5 次' },
];

/** Race-control rows (safety car / red flags / formation lap) shared by the rules editor and split-screen setup. */
export function raceControlRows(
  value: SessionRules,
  set: <K extends 'safetyCar' | 'redFlags' | 'formationLap'>(key: K) => (v: SessionRules[K]) => void,
): HTMLElement[] {
  return [
    cycler<SafetyCarSetting>({
      label: '安全車',
      options: opts(SAFETY_CAR_SETTINGS, SAFETY_CAR_LABEL),
      value: value.safetyCar ?? 'standard',
      onChange: set('safetyCar'),
      description: '事故頻率：決定黃旗、虛擬安全車與安全車出現的機率',
    }).el,
    toggle('紅旗', value.redFlags ?? true, set('redFlags'), '嚴重事故可能中止比賽，車輛回到發車格後重新起跑').el,
    toggle('暖胎圈', value.formationLap ?? false, set('formationLap'), '起跑前先繞行一圈，結束後自動停入發車格').el,
  ];
}

/** Aerodynamic wake rule row, shared by the rules editor and split-screen setup. */
export function aeroWakeRow(value: SessionRules, set: (key: 'aeroWake') => (v: boolean) => void): HTMLElement {
  return cycler<boolean>({
    label: '空氣動力尾流',
    options: [
      { value: true, label: '擬真' },
      { value: false, label: '關閉' },
    ],
    value: value.aeroWake ?? true,
    onChange: set('aeroWake'),
    description: '正賽跟車時：直線吸尾流阻力較小，彎道髒空氣使前輪抓地變差（轉向不足）',
  }).el;
}

/** Session rules editor. */
export function rulesEditor(initial: SessionRules, onChange: (r: SessionRules) => void): HTMLElement {
  let value: SessionRules = { ...initial };
  const set = <K extends keyof SessionRules>(key: K) => (v: SessionRules[K]): void => {
    value = { ...value, [key]: v };
    onChange({ ...value });
  };
  const flashbackValue = FLASHBACK_OPTIONS.some((o) => o.value === value.flashbacks) ? value.flashbacks : -1;
  return panel(
    '規則',
    toggle('輪胎磨耗', value.tyreWear, set('tyreWear')).el,
    toggle('燃油消耗', value.fuel, set('fuel')).el,
    cycler({ label: '車損', options: opts(['off', 'reduced', 'full'] as const, DAMAGE_LABEL), value: value.damage, onChange: set('damage') }).el,
    toggle('賽道界線', value.trackLimits, set('trackLimits'), '四輪越界警告 3 次後每次罰 5 秒').el,
    toggle('強制進站', value.mandatoryPitStop, set('mandatoryPitStop'), '乾地正賽需至少使用兩種不同乾胎配方').el,
    cycler({ label: '回溯次數', options: FLASHBACK_OPTIONS, value: flashbackValue, onChange: set('flashbacks') }).el,
    toggle('車輛碰撞', value.collisions, set('collisions')).el,
    aeroWakeRow(value, set),
    ...raceControlRows(value, set),
  );
}

export interface RaceOptionsValue {
  laps: LapsChoice;
  aiDifficulty: number;
  weather: WeatherChoice;
  timeOfDay: TimeOfDayChoice;
  regulation: Regulation;
  format: WeekendFormat;
  qualifying: QualifyingType;
}

export const REGULATION_OPTIONS: { value: Regulation; label: string }[] = [
  { value: '2025', label: '2025 規則' },
  { value: '2026', label: '2026 規則（主動空力・Overtake）' },
];

/** Event options. `fields` limits which rows appear. */
export function raceOptionsEditor(
  initial: RaceOptionsValue,
  fullLaps: number | null,
  onChange: (v: RaceOptionsValue) => void,
  fields: readonly (keyof RaceOptionsValue)[] = ['laps', 'aiDifficulty', 'weather', 'timeOfDay', 'regulation', 'format', 'qualifying'],
  title = '賽事設定',
  formats: readonly WeekendFormat[] = WEEKEND_FORMATS,
): HTMLElement {
  let value: RaceOptionsValue = { ...initial };
  const set = <K extends keyof RaceOptionsValue>(key: K) => (v: RaceOptionsValue[K]): void => {
    value = { ...value, [key]: v };
    onChange({ ...value });
  };
  const rows: Record<keyof RaceOptionsValue, () => HTMLElement> = {
    laps: () =>
      cycler<LapsChoice>({
        label: '比賽長度',
        options: LAPS_CHOICES.map((c) => ({ value: c, label: lapsLabel(c, fullLaps) })),
        value: value.laps,
        onChange: set('laps'),
      }).el,
    aiDifficulty: () =>
      slider({
        label: 'AI 難度',
        min: 0,
        max: 110,
        step: 1,
        value: value.aiDifficulty,
        format: (v) => `${v}（${difficultyLabel(v)}）`,
        onChange: set('aiDifficulty'),
        description: '0–110；按住 Shift 以 5 為單位調整',
      }).el,
    weather: () => cycler<WeatherChoice>({ label: '天氣', options: opts(WEATHER_CHOICES, WEATHER_LABEL), value: value.weather, onChange: set('weather'), description: '動態天氣：比賽中可能轉晴或下雨' }).el,
    timeOfDay: () => cycler<TimeOfDayChoice>({ label: '時段', options: opts(TIME_OF_DAY_CHOICES, TIME_LABEL), value: value.timeOfDay, onChange: set('timeOfDay') }).el,
    regulation: () => cycler<Regulation>({ label: '規則年份', options: REGULATION_OPTIONS, value: value.regulation, onChange: set('regulation'), description: '2026：車身更小更輕、直線模式取代 DRS、1 秒內可用 Overtake' }).el,
    format: () => cycler<WeekendFormat>({ label: '週末賽制', options: opts(formats, FORMAT_LABEL), value: value.format, onChange: set('format'), description: formats.includes('sprint') ? SPRINT_WEEKEND_DESCRIPTION : undefined }).el,
    qualifying: () => cycler<QualifyingType>({ label: '排位形式', options: opts(QUALIFYING_TYPES, QUALI_LABEL), value: value.qualifying, onChange: set('qualifying'), description: '單圈排位只計 1 個計時圈；短排位最多 3 個計時圈' }).el,
  };
  return panel(title, fields.map((f) => rows[f]()));
}

/** Season settings (career / My Team): race options + rules. */
export function seasonSettingsEditor(initial: SeasonSettings, onChange: (s: SeasonSettings) => void): HTMLElement {
  let value: SeasonSettings = { ...initial, rules: { ...initial.rules } };
  const race = raceOptionsEditor(
    { laps: value.laps, aiDifficulty: value.aiDifficulty, weather: 'clear', timeOfDay: 'auto', regulation: value.regulation, format: value.format, qualifying: value.qualifying },
    null,
    (v) => {
      value = { ...value, laps: v.laps, aiDifficulty: v.aiDifficulty, regulation: v.regulation, format: v.format, qualifying: v.qualifying };
      onChange({ ...value });
    },
    ['laps', 'aiDifficulty', 'regulation', 'format', 'qualifying'],
    '賽季設定',
    SEASON_FORMATS,
  );
  const sprint = toggle('衝刺賽週末', value.sprintWeekends, (v) => {
    value = { ...value, sprintWeekends: v };
    onChange({ ...value });
  }, '開啟後，真實賽曆的上海、斯帕、奧斯汀、英特拉格斯站（原創賽曆為第 3、6、9 站）為衝刺賽週末：排位 → 衝刺賽 → 正賽，衝刺賽積分計入積分榜');
  const calendar = cycler<CalendarKind>({
    label: '賽曆',
    options: [
      { value: 'real', label: '真實賽曆（12 站）' },
      { value: 'original', label: '原創賽道（10 站）' },
    ],
    value: value.calendar,
    onChange: (v) => {
      value = { ...value, calendar: v };
      onChange({ ...value });
    },
    description: '真實賽曆依 2025 年順序行駛真實賽道的正向佈局；進行中的賽季不變，下一季起生效',
  });
  const rules = rulesEditor(value.rules, (r) => {
    value = { ...value, rules: r };
    onChange({ ...value });
  });
  return h('div', { class: 'nvm-stack' }, race, panel('賽曆與衝刺賽', calendar.el, sprint.el), rules);
}
