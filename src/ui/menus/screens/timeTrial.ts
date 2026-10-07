/**
 * Time Trial hub: layout grid (personal best badges per regulation), local leaderboard, ghost toggle,
 * regulation, car choice and assists → briefing.
 */
import type { Regulation } from '../../../core/types';
import { formatLapTime } from '../../../core/math';
import type { LayoutMeta } from '../../../meta/options';
import type { ProfileSave } from '../../../meta/prefs';
import { driverName, standardRoster } from '../../../meta/roster';
import { loadGhost, loadProfile, loadSetup, loadTimeTrialRecords, saveProfile } from '../../../meta/save';
import type { SessionRequest } from '../../../meta/sessionBuilder';
import { personalBest, recordKey, type TimeTrialRecords } from '../../../meta/timeTrial';
import { DEFAULT_RULES } from '../../../core/defaults';
import { assistPresetCycler, REGULATION_OPTIONS } from '../components/editors';
import { TrackBrowser } from '../components/trackBrowser';
import { h, setChildren, setText } from '../dom';
import { focusElement } from '../nav';
import { launchWeekend } from '../flow';
import { Screen, type Host } from '../screen';
import { button, cycler, heading, panel, toggle } from '../widgets';
import { TeamSelectScreen } from './teamSelect';

export class TimeTrialScreen extends Screen {
  readonly title = '計時賽';
  private readonly profile: ProfileSave;
  private records: TimeTrialRecords;
  private readonly browser: TrackBrowser;
  private readonly nameEl: HTMLElement;
  private readonly boardEl: HTMLElement;
  private readonly carBtn: HTMLButtonElement;
  private readonly startBtn: HTMLButtonElement;

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-tt' });
    this.profile = loadProfile();
    this.records = loadTimeTrialRecords();
    this.nameEl = h('h3', { class: 'nvm-details__name' });
    this.boardEl = h('ol', { class: 'nvm-board' });
    this.browser = new TrackBrowser({
      initial: this.profile.tt.layoutId,
      badge: (l) => this.pbBadge(l),
      // hovering other cards on the way to 開始計時賽 must not change the chosen layout
      selectOnFocus: false,
      onFocus: (l) => {
        this.profile.tt.layoutId = l.id;
        saveProfile(this.profile);
        this.renderBoard();
      },
      onChoose: () => focusElement(this.startBtn),
    });
    this.carBtn = button({ label: '', sub: '賽車', onClick: () => this.pickCar() });
    this.startBtn = button({ label: '開始計時賽', variant: 'primary', onClick: () => this.start() });
    const reg = cycler<Regulation>({
      label: '規則年份',
      options: REGULATION_OPTIONS,
      value: this.profile.tt.regulation,
      onChange: (r) => {
        this.profile.tt.regulation = r;
        saveProfile(this.profile);
        this.browser.refreshBadges();
        this.renderBoard();
      },
    });
    const ghost = toggle('幽靈車', this.profile.tt.ghost, (v) => {
      this.profile.tt.ghost = v;
      saveProfile(this.profile);
    }, '與個人最佳圈的幽靈車同場競速');
    const assists = assistPresetCycler('駕駛輔助', this.profile.assists, (a) => {
      this.profile.assists = a;
      saveProfile(this.profile);
    });
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('計時賽', '挑戰個人最佳'),
        h(
          'div',
          { class: 'nvm-columns nvm-columns--track' },
          this.browser.el,
          h(
            'div',
            { class: 'nvm-stack' },
            panel('本機排行榜', this.nameEl, this.boardEl),
            panel('設定', reg.el, ghost.el, assists.el, this.carBtn),
            h('div', { class: 'nvm-actions nvm-actions--column' }, this.startBtn, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
          ),
        ),
      ),
    );
  }

  override initialFocus(): HTMLElement | null {
    return this.browser.currentCard();
  }

  override onEnter(): void {
    this.records = loadTimeTrialRecords();
    this.browser.refreshBadges();
    this.renderBoard();
    this.renderCar();
  }

  private pbBadge(layout: LayoutMeta): string | null {
    const pb = personalBest(this.records, layout.id, this.profile.tt.regulation);
    return pb ? `PB ${formatLapTime(pb.lapTime)}` : null;
  }

  private renderBoard(): void {
    const layout = this.browser.current();
    setText(this.nameEl, layout ? `${layout.displayName}・${this.profile.tt.regulation} 規則` : '—');
    const list = layout ? (this.records[recordKey(layout.id, this.profile.tt.regulation)] ?? []) : [];
    if (list.length === 0) {
      setChildren(this.boardEl, h('li', { class: 'nvm-board__empty', text: '尚無紀錄' }));
      return;
    }
    const roster = standardRoster();
    setChildren(
      this.boardEl,
      list.map((r, i) => {
        const d = roster.drivers.find((x) => x.id === r.driverId);
        const date = r.date ? r.date.slice(0, 10) : '';
        return h(
          'li',
          { class: i === 0 ? 'is-best' : '' },
          h('b', { text: formatLapTime(r.lapTime) }),
          h('span', { text: d ? d.abbr : r.driverId }),
          h('small', { text: date }),
        );
      }),
    );
  }

  private renderCar(): void {
    const roster = standardRoster();
    const d = roster.drivers.find((x) => x.id === this.profile.tt.driverId);
    const t = roster.teams.find((x) => x.id === this.profile.tt.teamId);
    const label = this.carBtn.querySelector('.nvm-btn__label');
    if (label) label.textContent = d && t ? `${t.name}・${driverName(d)}` : '選擇賽車';
  }

  private pickCar(): void {
    this.host.push(
      new TeamSelectScreen(this.host, {
        title: '計時賽',
        kicker: '選擇賽車',
        roster: standardRoster(),
        initial: { teamId: this.profile.tt.teamId, driverId: this.profile.tt.driverId },
        pickDriver: true,
        onChosen: (seat) => {
          this.profile.tt.teamId = seat.teamId;
          this.profile.tt.driverId = seat.driverId;
          saveProfile(this.profile);
          this.host.pop();
        },
      }),
    );
  }

  private start(): void {
    const layout = this.browser.current();
    if (!layout) {
      this.host.sound('error');
      this.host.toast('賽道資料尚未載入', 'bad');
      return;
    }
    const tt = this.profile.tt;
    const base: SessionRequest = {
      mode: 'timeTrial',
      kind: 'timeTrial',
      layoutId: layout.id,
      raceLaps: 1,
      weather: 'clear',
      timeOfDay: 'auto',
      regulation: tt.regulation,
      aiDifficulty: 90,
      qualifying: 'oneShot',
      rules: { ...DEFAULT_RULES },
      seed: Date.now() >>> 0,
      players: [
        { playerIndex: 0, driverId: tt.driverId, teamId: tt.teamId, setup: loadSetup(layout.id), assists: { ...this.profile.assists }, startCompound: null },
      ],
      roster: standardRoster(),
      aiCount: null,
      gridOrder: null,
      playerStartPosition: null,
      ghost: tt.ghost ? loadGhost(layout.id, tt.regulation) : null,
      objective: null,
    };
    if (tt.ghost && !base.ghost) this.host.toast('此佈局尚無幽靈車，跑出個人最佳後會自動儲存');
    launchWeekend(this.host, base, ['timeTrial'], { returnTo: 'timeTrial', round: null, storyId: null });
  }
}
