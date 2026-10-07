/**
 * Main menu: the nine game areas in a left column over the showroom car, plus a profile strip.
 */
import { ACHIEVEMENTS } from '../../../meta/achievements';
import type { MenuHome } from '../../../meta/context';
import { loadAchievements, loadProfile } from '../../../meta/save';
import { h } from '../dom';
import { entryScreen } from '../hubs';
import { Screen, type Host, type StageRequest } from '../screen';
import { tile } from '../widgets';
import { AchievementsScreen } from './achievements';
import { CreditsScreen } from './credits';
import { SettingsScreen } from './settings';

export class MainMenuScreen extends Screen {
  readonly title = '主選單';
  private readonly statsEl: HTMLElement;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-main' });
    const go = (home: MenuHome) => () => this.host.push(entryScreen(this.host, home));
    const items: [string, string, () => void][] = [
      ['大獎賽', '自訂單場週末：賽道、車隊、天氣與規則', go('grandPrix')],
      ['計時賽', '挑戰個人最佳圈速與幽靈車', go('timeTrial')],
      ['車手生涯', '打造自己的車手，征戰完整賽季', go('career')],
      ['我的車隊', '建立自己的車隊，經營研發與資金', go('myTeam')],
      ['新星之路', '原創劇情 6 章＋挑戰賽', go('story')],
      ['雙人分割畫面', '同一台電腦上的雙人對戰', go('splitScreen')],
      ['設定', '畫面、音效、操控與按鍵', () => this.host.push(new SettingsScreen(this.host, null))],
      ['成就', '12 項本機成就', () => this.host.push(new AchievementsScreen(this.host))],
      ['製作名單', '關於本作', () => this.host.push(new CreditsScreen(this.host))],
    ];
    this.statsEl = h('div', { class: 'nvm-main__stats' });
    this.el.append(
      h(
        'div',
        { class: 'nvm-col' },
        h('div', { class: 'nvm-main__brand' }, h('span', { class: 'nvm-main__brand-a', text: 'FORMULA NOVA' }), h('span', { class: 'nvm-main__brand-b', text: '25' })),
        h('nav', { class: 'nvm-tiles' }, items.map(([label, sub, fn], i) => tile(i + 1, label, sub, fn))),
        this.statsEl,
      ),
    );
  }

  override stage(): StageRequest {
    return { kind: 'car', car: this.host.featuredCar() };
  }

  override onEnter(): void {
    const stats = loadProfile().stats;
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
