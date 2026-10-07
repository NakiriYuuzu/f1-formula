/**
 * First-run onboarding: 選擇駕駛經驗 (three assist presets, persisted as the default assists of every mode)
 * followed by a short 操作方式 card. The experience screen can also be re-opened from 設定 (saves are untouched).
 */
import { ASSIST_PRESETS } from '../../../core/defaults';
import type { KeyAction } from '../../../core/types';
import { assistsEqual } from '../../../meta/options';
import { applyExperience, EXPERIENCE_LEVELS, type ExperienceLevel } from '../../../meta/prefs';
import { loadProfile, saveProfile } from '../../../meta/save';
import { h } from '../dom';
import { KEY_ACTION_LABEL, PRESET_LABEL, keyLabel } from '../labels';
import { Screen, type Host } from '../screen';
import { button, heading, panel } from '../widgets';
import { MainMenuScreen } from './mainMenu';

const EXPERIENCE_TEXT: Record<ExperienceLevel, string> = {
  beginner: '煞車／轉向輔助、完整行車線、自排：專心享受駕駛，車子幫你守住賽道',
  intermediate: '循跡控制與僅彎道行車線、自排：保留一點輔助，開始掌握煞車點',
  expert: '無輔助、手排、無行車線：完全由你掌控每一次入彎與出彎',
};

/** Driving actions listed on the 操作方式 card, in display order. */
const CONTROL_ROWS: readonly KeyAction[] = ['throttle', 'brake', 'steerLeft', 'steerRight', 'shiftUp', 'shiftDown', 'drs', 'overtake', 'ersCycle', 'pitRequest', 'flashback', 'camera', 'pause'];

const GAMEPAD_LINES: readonly string[] = [
  '右扳機 油門　左扳機 煞車　左搖桿 轉向',
  'A DRS　X 切換 ERS　Y 切換鏡頭　B 回溯',
  'LB／RB 降檔／升檔　十字鍵上 進站　十字鍵下 限速器　Start 暫停',
  '選單中：十字鍵移動　A 確認　B 返回',
];

export class ExperienceScreen extends Screen {
  readonly title = '駕駛經驗';
  private readonly cards = new Map<ExperienceLevel, HTMLButtonElement>();
  private readonly firstRun: boolean;

  constructor(host: Host, firstRun: boolean) {
    super(host, { layout: 'panel', className: 'nvm-onboard' });
    this.firstRun = firstRun;
    const current = loadProfile().assists;
    for (const level of EXPERIENCE_LEVELS) {
      this.cards.set(
        level,
        button({
          label: PRESET_LABEL[level],
          sub: EXPERIENCE_TEXT[level],
          variant: 'tile',
          className: 'nvm-onboard__card',
          badge: !firstRun && assistsEqual(current, ASSIST_PRESETS[level]) ? '目前' : undefined,
          onClick: () => this.choose(level),
        }),
      );
    }
    this.el.append(
      h(
        'div',
        { class: 'nvm-narrow' },
        heading('選擇駕駛經驗', firstRun ? '歡迎' : '設定'),
        h('p', { class: 'nvm-note', text: '這會成為每種模式新場次的預設駕駛輔助；之後仍可在各模式的準備畫面逐項調整。存檔不會被清除。' }),
        h('div', { class: 'nvm-onboard__cards' }, ...this.cards.values()),
        firstRun ? null : h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
      ),
    );
  }

  override initialFocus(): HTMLElement | null {
    if (this.firstRun) return this.cards.get('intermediate') ?? null;
    const current = loadProfile().assists;
    return this.cards.get(EXPERIENCE_LEVELS.find((l) => assistsEqual(current, ASSIST_PRESETS[l])) ?? 'intermediate') ?? null;
  }

  override hints(): string[] {
    return this.firstRun ? ['←→ 選擇', 'Enter 確認'] : ['←→ 選擇', 'Enter 確認', 'Esc 返回'];
  }

  override onBack(): boolean {
    return this.firstRun;
  }

  private choose(level: ExperienceLevel): void {
    saveProfile(applyExperience(loadProfile(), level));
    if (this.firstRun) this.host.replace(new ControlsCardScreen(this.host));
    else {
      this.host.toast(`已將預設駕駛輔助改為「${PRESET_LABEL[level]}」`, 'good');
      this.host.pop();
    }
  }
}

/** 操作方式: current keyboard bindings for driving plus a gamepad summary; 開始 enters the main menu. */
export class ControlsCardScreen extends Screen {
  readonly title = '操作方式';
  private readonly start: HTMLButtonElement;

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-onboard' });
    const bindings = host.settings.keyBindings;
    const rows = CONTROL_ROWS.map((action) =>
      h(
        'div',
        { class: 'nvm-onboard__row' },
        h('span', { class: 'nvm-onboard__action', text: KEY_ACTION_LABEL[action] }),
        h('span', { class: 'nvm-onboard__keys', text: (bindings[action] ?? []).map(keyLabel).join('　/　') || '未設定' }),
      ),
    );
    this.start = button({ label: '開始', variant: 'primary', onClick: () => this.host.replace(new MainMenuScreen(this.host)) });
    this.el.append(
      h(
        'div',
        { class: 'nvm-narrow' },
        heading('操作方式', '開始之前'),
        panel('鍵盤', h('div', { class: 'nvm-onboard__rows' }, rows)),
        panel('手把', ...GAMEPAD_LINES.map((t) => h('p', { class: 'nvm-note', text: t }))),
        h('p', { class: 'nvm-note', text: '按鍵可隨時在 設定 → 按鍵 中修改。' }),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, this.start),
      ),
    );
  }

  override initialFocus(): HTMLElement {
    return this.start;
  }

  override hints(): string[] {
    return ['Enter 開始'];
  }

  override onBack(): boolean {
    return true;
  }
}
