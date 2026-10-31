/**
 * Main menu: quick race first, then the game areas in four groups in a left column over the showroom car, plus a
 * profile strip.
 */
import { ACHIEVEMENTS } from '../../../meta/achievements';
import type { MenuHome } from '../../../meta/context';
import { quickRacePlan } from '../../../meta/quickRace';
import { standardRoster } from '../../../meta/roster';
import { loadAchievements, loadProfile, loadSetup } from '../../../meta/save';
import { buildSessionConfig, validateSessionConfig } from '../../../meta/sessionBuilder';
import { h, setText } from '../dom';
import { entryScreen } from '../hubs';
import { Screen, type Host, type StageRequest } from '../screen';
import { tile } from '../widgets';
import { AchievementsScreen } from './achievements';
import { CreditsScreen } from './credits';
import { SettingsScreen } from './settings';

export class MainMenuScreen extends Screen {
  readonly title = '主選單';
  private readonly statsEl: HTMLElement;
  private readonly quickTile: HTMLButtonElement;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-main' });
    const go = (home: MenuHome) => () => this.host.push(entryScreen(this.host, home));
    const groups: [string, string, () => void][][] = [
      [
        ['大獎賽', '自訂單場週末：賽道、車隊、天氣與規則', go('grandPrix')],
        ['計時賽', '挑戰個人最佳圈速與幽靈車', go('timeTrial')],
      ],
      [
        ['車手生涯', '打造自己的車手，征戰完整賽季', go('career')],
        ['我的車隊', '建立自己的車隊，經營研發與資金', go('myTeam')],
        ['新星之路', '原創劇情 6 章＋挑戰賽', go('story')],
      ],
      [
        ['雙人分割畫面', '同一台電腦上的雙人對戰', go('splitScreen')],
        ['線上多人', '2–4 名玩家連線對戰（點對點）', go('online')],
      ],
      [
        ['設定', '畫面、音效、操控與按鍵', () => this.host.push(new SettingsScreen(this.host, null))],
        ['成就', '12 項本機成就', () => this.host.push(new AchievementsScreen(this.host))],
        ['製作名單', '關於本作', () => this.host.push(new CreditsScreen(this.host))],
      ],
    ];
    this.quickTile = tile('快速比賽', '', () => this.quickRace(), true);
    const rows: HTMLElement[] = [this.quickTile];
    for (const group of groups) {
      rows.push(...group.map(([label, sub, fn], i) => (i === 0 ? [h('div', { class: 'nvm-tiles__gap', attrs: { 'aria-hidden': 'true' } }), tile(label, sub, fn)] : [tile(label, sub, fn)])).flat());
    }
    this.statsEl = h('div', { class: 'nvm-main__stats' });
    this.el.append(h('div', { class: 'nvm-col' }, h('nav', { class: 'nvm-tiles', attrs: { 'aria-label': '主選單' } }, rows), this.statsEl));
  }

  override initialFocus(): HTMLElement {
    return this.quickTile;
  }

  /** One press: a race-only Grand Prix with the last Grand Prix choices, straight to the loading card. */
  private quickRace(): void {
    const plan = quickRacePlan(loadProfile(), standardRoster(), loadSetup, Date.now());
    const fail = (text: string): void => {
      this.host.sound('error');
      this.host.toast(text, 'bad');
    };
    if (!plan) return fail('沒有可用的賽道或車隊，請先到大獎賽選擇');
    let config;
    try {
      config = buildSessionConfig(plan.request);
    } catch (err) {
      console.error('[menus] quick race config failed', err);
      return fail('賽道資料尚未載入，無法開始比賽');
    }
    const problems = validateSessionConfig(config);
    if (problems.length > 0) {
      console.error('[menus] invalid quick race config', problems);
      return fail('比賽設定無效，請到大獎賽重新選擇');
    }
    this.host.startSession(config, plan.ctx);
  }

  override stage(): StageRequest {
    return { kind: 'car', car: this.host.featuredCar() };
  }

  override onEnter(): void {
    const profile = loadProfile();
    const plan = quickRacePlan(profile, standardRoster(), loadSetup, 0);
    const sub = this.quickTile.querySelector<HTMLElement>('.nvm-tile__sub');
    if (sub) setText(sub, plan ? `${plan.layoutName}・${plan.teamName}・${plan.request.raceLaps} 圈，直接開賽` : '直接開賽');
    const stats = profile.stats;
    const unlocked = Object.keys(loadAchievements().unlocked).length;
    this.statsEl.replaceChildren(
      ...[
        ['完賽', String(stats.racesFinished)],
        ['勝場', String(stats.wins)],
        ['頒獎台', String(stats.podiums)],
        ['桿位', String(stats.poles)],
        ['成就', `${unlocked}/${ACHIEVEMENTS.length}`],
      ].map(([k, v]) => h('span', { class: 'nvm-main__stat' }, h('b', { text: v }), h('small', { text: k }))),
    );
  }

  override onBack(): boolean {
    return true;
  }

  /** Nothing to go back to from here, so no 'Esc 返回' hint. */
  override hints(): string[] {
    return ['↑↓←→ 選擇', 'Enter 確認'];
  }
}
