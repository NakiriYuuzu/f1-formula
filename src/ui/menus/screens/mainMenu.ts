/**
 * Main menu: four tabs (比賽 / 生涯 / 多人 / 個人, Q/E or LB/RB) of colour-field tiles over the showroom car, quick
 * race first, plus the player's record at the top right.
 */
import { ACHIEVEMENTS } from '../../../meta/achievements';
import type { MenuHome } from '../../../meta/context';
import { quickRacePlan } from '../../../meta/quickRace';
import { standardRoster } from '../../../meta/roster';
import { loadAchievements, loadProfile, loadSetup } from '../../../meta/save';
import { buildSessionConfig, validateSessionConfig } from '../../../meta/sessionBuilder';
import { h, setText } from '../dom';
import { entryScreen } from '../hubs';
import { minimapCanvas } from '../minimap';
import { focusElement } from '../nav';
import { Screen, type Host, type StageRequest } from '../screen';
import { tabs, tile, type TileOptions } from '../widgets';
import { AchievementsScreen } from './achievements';
import { CreditsScreen } from './credits';
import { SettingsScreen } from './settings';

/** The tiles' pictures: line drawings in the tile's ink, cropped by the tile edge (viewBox 0 0 100 100). */
const ART = {
  flag: '<defs><pattern id="nvm-chk" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="currentColor"/><rect x="8" y="8" width="8" height="8" fill="currentColor"/></pattern></defs><path d="M20 12C40 4 56 22 82 12V56C56 66 40 48 20 56Z" fill="url(#nvm-chk)" stroke="currentColor" stroke-width="4"/><path d="M20 8V94" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>',
  watch: '<circle cx="50" cy="56" r="33" fill="none" stroke="currentColor" stroke-width="6"/><path d="M42 10H58M50 10V23M76 26L82 20M50 56V34M50 56L64 64" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>',
  helmet: '<path d="M14 64C14 36 34 18 60 18C80 18 92 32 92 50V64C92 72 86 76 78 76H28C20 76 14 72 14 64Z" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/><path d="M52 38H90V54H58C50 54 46 46 52 38Z" fill="currentColor"/><path d="M16 60H48" stroke="currentColor" stroke-width="6"/>',
  shield: '<path d="M50 8L86 20L82 60C78 76 64 86 50 92C36 86 22 76 18 60L14 20Z" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/><path d="M28 70L72 26M38 80L80 38" stroke="currentColor" stroke-width="6"/>',
  star: '<path d="M50 6L62 38H95L68 58L78 92L50 71L22 92L32 58L5 38H38Z" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/>',
  split: '<rect x="6" y="22" width="41" height="56" rx="4" fill="none" stroke="currentColor" stroke-width="6"/><rect x="53" y="22" width="41" height="56" rx="4" fill="none" stroke="currentColor" stroke-width="6"/><path d="M26 64L19 46H33ZM74 64L67 46H81Z" fill="currentColor"/>',
  globe: '<circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" stroke-width="6"/><ellipse cx="50" cy="50" rx="16" ry="38" fill="none" stroke="currentColor" stroke-width="5"/><path d="M14 38H86M14 62H86" stroke="currentColor" stroke-width="5"/>',
  trophy: '<path d="M30 12H70V36C70 52 61 60 50 60C39 60 30 52 30 36Z" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/><path d="M30 20H16C16 36 22 42 31 43M70 20H84C84 36 78 42 69 43M50 60V76M32 88H68V78H32Z" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/>',
  gear: '<circle cx="50" cy="50" r="31" fill="none" stroke="currentColor" stroke-width="14" stroke-dasharray="9.2 7"/><circle cx="50" cy="50" r="24" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="50" cy="50" r="9" fill="none" stroke="currentColor" stroke-width="6"/>',
  film: '<rect x="12" y="42" width="76" height="46" rx="3" fill="none" stroke="currentColor" stroke-width="6"/><path d="M12 30L84 14L88 28L16 44Z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><path d="M30 26L36 40M52 21L58 35M74 16L80 30" stroke="currentColor" stroke-width="5"/>',
} as const;

function art(name: keyof typeof ART): HTMLElement {
  const el = h('span', { class: 'nvm-tile__art', attrs: { 'aria-hidden': 'true' } });
  el.innerHTML = `<svg viewBox="0 0 100 100">${ART[name]}</svg>`;
  return el;
}

type TabId = 'race' | 'career' | 'multi' | 'me';

export class MainMenuScreen extends Screen {
  readonly title = '主選單';
  private readonly statsEl: HTMLElement;
  private readonly quickTile: HTMLButtonElement;
  private readonly quickMap: HTMLElement;
  private readonly trophyTile: HTMLButtonElement;
  private readonly mosaics = new Map<TabId, HTMLElement>();
  private quickLayout = '';

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-main' });
    const go = (home: MenuHome) => () => this.host.push(entryScreen(this.host, home));
    const make = (list: TileOptions[]): HTMLButtonElement[] => list.map((o, i) => tile({ ...o, index: i }));

    this.quickMap = h('span', { class: 'nvm-tile__art nvm-tile__art--map', attrs: { 'aria-hidden': 'true' } });
    const race = make([
      { label: '快速比賽', sub: '', onClick: () => this.quickRace(), color: 'var(--nv-c-pink)', size: 'hero', art: this.quickMap, tag: '一鍵開賽', go: '開始比賽 ▶' },
      { label: '大獎賽', sub: '自訂單場週末：賽道、車隊、天氣與規則', onClick: go('grandPrix'), color: 'var(--nv-c-orange)', size: 'wide', art: art('flag') },
      { label: '計時賽', sub: '挑戰個人最佳圈速與幽靈車', onClick: go('timeTrial'), color: 'var(--nv-c-cyan)', size: 'wide', art: art('watch') },
    ]);
    this.quickTile = race[0] as HTMLButtonElement;
    const career = make([
      { label: '車手生涯', sub: '打造自己的車手，征戰完整賽季', onClick: go('career'), color: 'var(--nv-c-purple)', size: 'hero', art: art('helmet'), go: '進入生涯 ▶' },
      { label: '我的車隊', sub: '建立自己的車隊，經營研發與資金', onClick: go('myTeam'), color: 'var(--nv-c-teal)', size: 'wide', art: art('shield') },
      { label: '新星之路', sub: '原創劇情 6 章＋挑戰賽', onClick: go('story'), color: 'var(--nv-c-yellow)', size: 'wide', art: art('star'), dark: true },
    ]);
    const multi = make([
      { label: '雙人分割畫面', sub: '同一台電腦上的雙人對戰', onClick: go('splitScreen'), color: 'var(--nv-c-red)', size: 'hero', art: art('split') },
      { label: '線上多人', sub: '2–4 名玩家連線對戰（點對點）', onClick: go('online'), color: 'var(--nv-c-green)', size: 'hero', art: art('globe') },
    ]);
    const me = make([
      { label: '成就', sub: '', onClick: () => this.host.push(new AchievementsScreen(this.host)), color: 'var(--nv-c-orange)', size: 'hero', art: art('trophy') },
      { label: '設定', sub: '畫面、音效、操控與按鍵', onClick: () => this.host.push(new SettingsScreen(this.host, null)), color: 'var(--nv-c-slate)', size: 'wide', art: art('gear') },
      { label: '製作名單', sub: '關於本作', onClick: () => this.host.push(new CreditsScreen(this.host)), color: 'var(--nv-c-purple)', size: 'wide', art: art('film') },
    ]);
    this.trophyTile = me[0] as HTMLButtonElement;

    const groups: [TabId, string, HTMLButtonElement[]][] = [
      ['race', '比賽', race],
      ['career', '生涯', career],
      ['multi', '多人', multi],
      ['me', '個人', me],
    ];
    for (const [id, label, tiles] of groups) {
      this.mosaics.set(id, h('nav', { class: 'nvm-mosaic', attrs: { 'aria-label': label, hidden: id !== 'race' } }, tiles));
    }
    // a new tab lands on its first tile, like LB / RB in a console menu
    const bar = tabs(
      groups.map(([id, label]) => ({ id, label })),
      'race',
      (id) => {
        for (const [tab, el] of this.mosaics) el.hidden = tab !== id;
        const first = this.mosaics.get(id as TabId)?.querySelector<HTMLElement>('.nvm-tile');
        if (first) focusElement(first);
      },
    );
    this.statsEl = h('div', { class: 'nvm-main__stats' });
    this.el.append(h('div', { class: 'nvm-main__head' }, bar.el, this.statsEl), ...this.mosaics.values());
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
    const format = plan?.request.raceFormat;
    const length =
      format?.kind === 'elimination' ? `淘汰賽（每 ${format.interval} 秒）` : format ? `耐力賽（${Math.round(format.duration / 60)} 分鐘）` : `${plan?.request.raceLaps} 圈`;
    if (sub) setText(sub, plan ? `${plan.layoutName}・${plan.teamName}・${length}` : '上次的大獎賽設定，直接開賽');
    // the track the quick race will start, drawn in white on the pink field
    const layoutId = plan?.request.layoutId ?? '';
    if (layoutId !== this.quickLayout) {
      this.quickLayout = layoutId;
      this.quickMap.replaceChildren(...(layoutId ? [minimapCanvas(layoutId, 320, 240, { color: '#ffffff', lineWidth: 5, accent: '#ffc21a' })] : []));
    }
    const stats = profile.stats;
    const unlocked = Object.keys(loadAchievements().unlocked).length;
    const trophySub = this.trophyTile.querySelector<HTMLElement>('.nvm-tile__sub');
    if (trophySub) setText(trophySub, `已解鎖 ${unlocked} / ${ACHIEVEMENTS.length}`);
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
