/**
 * My Team hub over the team car: budget, next round, R&D centre (part-level projects → createCarSpec part gains),
 * driver market, livery editor, calendar, standings, season flow.
 */
import {
  myTeamDef,
  myTeamDevelopment,
  myTeamRequest,
  myTeamRoster,
  sponsorTarget,
  startNextMyTeamSeason,
  type MyTeamSave,
} from '../../../meta/myTeam';
import { isSeasonComplete } from '../../../meta/career';
import { findLayout, listLayouts } from '../../../meta/options';
import { driverName, MY_TEAM_ID, PLAYER_DRIVER_ID } from '../../../meta/roster';
import { createCalendar, seasonWeekend, standingPosition, teamStandings } from '../../../meta/season';
import { loadMyTeam, loadProfile, loadSetup, saveMyTeam, saveProfile } from '../../../meta/save';
import { h, setChildren } from '../dom';
import { focusElement } from '../nav';
import { launchWeekend } from '../flow';
import { FORMAT_LABEL, money, weatherLabel } from '../labels';
import { minimapCanvas } from '../minimap';
import { developmentNote, idleSlotsNote, seasonRuleNote } from '../components/rndRows';
import { seasonSummaryCard } from '../components/seasonTables';
import { Screen, type Host, type StageRequest } from '../screen';
import { myTeamCar } from '../showroom';
import { button, heading, panel, teamChip } from '../widgets';
import { MyTeamWizardScreen } from './myTeamWizard';
import { CalendarScreen } from './calendar';
import { DriverMarketScreen } from './driverMarket';
import { LiveryEditorScreen } from './liveryEditor';
import { RndScreen } from './rnd';
import { SeasonSettingsScreen } from './seasonSettings';
import { StandingsScreen } from './standings';


export class MyTeamHubScreen extends Screen {
  readonly title = '我的車隊';
  private save: MyTeamSave | null;
  private readonly col: HTMLElement;
  private primary: HTMLButtonElement | null = null;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-hub' });
    this.save = loadMyTeam();
    if (this.save && this.save.calendar.length === 0) {
      const layouts = listLayouts();
      if (layouts.length > 0) {
        this.save = { ...this.save, calendar: createCalendar(this.save.seed, layouts, this.save.settings.calendar) };
        saveMyTeam(this.save);
      }
    }
    this.col = h('div', { class: 'nvm-col' });
    this.el.append(this.col);
  }

  override stage(): StageRequest {
    return this.save ? { kind: 'car', car: myTeamCar(this.save) } : { kind: 'none' };
  }

  override initialFocus(): HTMLElement | null {
    return this.primary;
  }

  override onEnter(): void {
    this.save = loadMyTeam();
    this.render();
    this.host.refreshStage();
  }

  private render(): void {
    const save = this.save;
    if (!save) {
      setChildren(this.col, heading('我的車隊', ''), h('p', { class: 'nvm-empty', text: '找不到車隊存檔。' }), button({ label: '返回', back: true, onClick: () => this.host.pop() }));
      return;
    }
    const roster = myTeamRoster(save);
    const team = myTeamDef(save);
    const teams = teamStandings(save.results, roster.teams.map((t) => t.id));
    const mine = teams.find((s) => s.id === MY_TEAM_ID);
    const complete = isSeasonComplete(save);
    const round = complete ? null : (save.calendar[save.results.length] ?? null);
    const layout = round ? findLayout(round.layoutId) : null;
    let roundCard: HTMLElement;
    if (complete) {
      const last = save.history[save.history.length - 1];
      roundCard = last ? seasonSummaryCard(last, roster, '車隊積分榜') : panel('賽季結束');
      this.primary = button({ label: `開始第 ${save.season + 1} 季`, variant: 'primary', onClick: () => this.nextSeason() });
    } else if (round) {
      roundCard = panel(
        `第 ${save.results.length + 1} 站`,
        h(
          'div',
          { class: 'nvm-hub__round' },
          minimapCanvas(round.layoutId, 120, 80, { lineWidth: 2 }),
          h(
            'div',
            null,
            h('b', { text: layout ? layout.displayName : round.layoutId }),
            h('small', { text: `預報：${weatherLabel(round.weather)}・${FORMAT_LABEL[save.settings.format]}・贊助目標：前 ${sponsorTarget(save)} 名` }),
          ),
        ),
      );
      this.primary = button({ label: '開始週末', variant: 'primary', onClick: () => this.startRound() });
    } else {
      roundCard = panel(null, h('p', { class: 'nvm-empty', text: '賽道資料尚未載入，無法開始比賽。' }));
      this.primary = null;
    }
    const income = save.lastIncome.length > 0 ? h('p', { class: 'nvm-note', text: `上一筆：${save.lastIncome.map((l) => `${l.label} ${l.amount >= 0 ? '+' : ''}${l.amount.toFixed(1)}`).join('・')}` }) : null;
    const devNote = developmentNote(save.development, MY_TEAM_ID, save.results.length);
    const ruleNote = seasonRuleNote(save.season, save.results.length);
    setChildren(
      this.col,
      heading(save.name, `我的車隊・${save.shortName}`),
      h(
        'div',
        { class: 'nvm-hub__id' },
        teamChip(team.livery.primary),
        h('div', null, h('b', { text: `${driverName(save.driver)}・#${save.driver.number}` }), h('small', { text: `第 ${save.season} 季・動力單元 ${team.powerUnit}` })),
      ),
      h(
        'div',
        { class: 'nvm-hub__stats' },
        h('span', null, h('b', { text: money(save.budget) }), h('small', { text: '資金' })),
        h('span', null, h('b', { text: save.results.length > 0 ? `P${standingPosition(teams, MY_TEAM_ID)}` : '—' }), h('small', { text: '車隊榜' })),
        h('span', null, h('b', { text: String(mine ? mine.points : 0) }), h('small', { text: '積分' })),
      ),
      income,
      devNote ? h('p', { class: 'nvm-note', text: devNote }) : null,
      ruleNote ? h('p', { class: 'nvm-note', text: ruleNote }) : null,
      roundCard,
      h(
        'nav',
        { class: 'nvm-menu-list' },
        this.primary,
        button({
          label: '研發中心',
          badge: idleSlotsNote(myTeamDevelopment(save), save.budget, 'money') ?? undefined,
          onClick: () => this.host.push(new RndScreen(this.host)),
        }),
        button({ label: '車手市場', onClick: () => this.host.push(new DriverMarketScreen(this.host)) }),
        button({ label: '塗裝編輯', onClick: () => this.host.push(new LiveryEditorScreen(this.host)) }),
        button({ label: '賽季賽程', onClick: () => this.host.push(new CalendarScreen(this.host, `第 ${save.season} 季`, save.calendar, save.results, PLAYER_DRIVER_ID, save.settings)) }),
        button({ label: '積分榜', onClick: () => this.host.push(new StandingsScreen(this.host, `第 ${save.season} 季`, save.results, roster, [PLAYER_DRIVER_ID, save.teammateId], MY_TEAM_ID)) }),
        button({
          label: '賽季設定',
          onClick: () =>
            this.host.push(
              new SeasonSettingsScreen(this.host, '我的車隊', save.settings, loadProfile().assists, (settings, assists) => {
                const current = loadMyTeam();
                if (current) saveMyTeam({ ...current, settings });
                const profile = loadProfile();
                profile.assists = assists;
                saveProfile(profile);
              }),
            ),
        }),
        button({
          label: '建立新車隊',
          variant: 'danger',
          onClick: () =>
            this.host.confirm('建立新車隊？', '目前的車隊、資金與研發進度將被刪除，且無法復原。', () => {
              saveMyTeam(null);
              this.host.replace(new MyTeamWizardScreen(this.host));
            }, '刪除並重新建立'),
        }),
        button({ label: '返回主選單', back: true, onClick: () => this.host.pop() }),
      ),
    );
  }

  private startRound(): void {
    const save = this.save;
    const round = save ? save.calendar[save.results.length] : undefined;
    const layout = round ? findLayout(round.layoutId) : null;
    if (!save || !layout) {
      this.host.sound('error');
      this.host.toast('賽道資料尚未載入', 'bad');
      return;
    }
    const profile = loadProfile();
    const req = myTeamRequest(save, 'race', layout.fullLaps, { assists: profile.assists, setup: loadSetup(layout.id), startCompound: null }, null);
    if (!req) return;
    launchWeekend(this.host, req, seasonWeekend(save.settings, save.results.length, save.calendar), { returnTo: 'myTeam', round: save.results.length, storyId: null });
  }

  private nextSeason(): void {
    if (!this.save) return;
    const layouts = listLayouts();
    if (layouts.length === 0) {
      this.host.sound('error');
      this.host.toast('賽道資料尚未載入', 'bad');
      return;
    }
    this.save = startNextMyTeamSeason(this.save, Date.now() >>> 0, layouts);
    saveMyTeam(this.save);
    this.host.toast(`第 ${this.save.season} 季開始！`, 'good');
    this.render();
    if (this.primary) focusElement(this.primary);
  }
}
