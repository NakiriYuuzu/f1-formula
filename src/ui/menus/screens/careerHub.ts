/**
 * Driver Career hub over the player's car: next round, calendar, standings, driver rating & teammate
 * comparison, season settings, season-end summary / next season, new career.
 */
import {
  careerRequest,
  careerRoster,
  currentRound,
  isSeasonComplete,
  ratingOverall,
  startNextCareerSeason,
  type CareerSave,
} from '../../../meta/career';
import { createCalendar, seasonWeekend, driverStandings, standingPosition } from '../../../meta/season';
import { findLayout, listLayouts } from '../../../meta/options';
import { driverName, PLAYER_DRIVER_ID } from '../../../meta/roster';
import { loadCareer, loadProfile, loadSetup, saveCareer, saveProfile } from '../../../meta/save';
import { h, setChildren } from '../dom';
import { focusElement } from '../nav';
import { launchWeekend } from '../flow';
import { FORMAT_LABEL, weatherLabel } from '../labels';
import { minimapCanvas } from '../minimap';
import { seasonSummaryCard } from '../components/seasonTables';
import { Screen, type Host, type StageRequest } from '../screen';
import { showroomCarFor } from '../showroom';
import { button, heading, panel, teamChip } from '../widgets';
import { CareerWizardScreen } from './careerWizard';
import { CalendarScreen } from './calendar';
import { DriverProfileScreen } from './driverProfile';
import { SeasonSettingsScreen } from './seasonSettings';
import { StandingsScreen } from './standings';


export class CareerHubScreen extends Screen {
  readonly title = '車手生涯';
  private save: CareerSave | null;
  private readonly col: HTMLElement;
  private primary: HTMLButtonElement | null = null;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-hub' });
    this.save = loadCareer();
    if (this.save && this.save.calendar.length === 0) {
      const layouts = listLayouts();
      if (layouts.length > 0) {
        this.save = { ...this.save, calendar: createCalendar(this.save.seed, layouts, this.save.settings.calendar) };
        saveCareer(this.save);
      }
    }
    this.col = h('div', { class: 'nvm-col' });
    this.el.append(this.col);
  }

  override stage(): StageRequest {
    if (!this.save) return { kind: 'none' };
    return { kind: 'car', car: showroomCarFor(careerRoster(this.save).roster, PLAYER_DRIVER_ID, this.save.teamId) };
  }

  override initialFocus(): HTMLElement | null {
    return this.primary;
  }

  override onEnter(): void {
    this.save = loadCareer();
    this.render();
    this.host.refreshStage();
  }

  private render(): void {
    const save = this.save;
    if (!save) {
      setChildren(this.col, heading('車手生涯', ''), h('p', { class: 'nvm-empty', text: '找不到生涯存檔。' }), button({ label: '返回', back: true, onClick: () => this.host.pop() }));
      return;
    }
    const { roster } = careerRoster(save);
    const team = roster.teams.find((t) => t.id === save.teamId);
    const standings = driverStandings(save.results, roster.drivers.map((d) => d.id));
    const me = standings.find((s) => s.id === PLAYER_DRIVER_ID);
    const complete = isSeasonComplete(save);
    const round = currentRound(save);
    const layout = round ? findLayout(round.layoutId) : null;

    const header = h(
      'div',
      { class: 'nvm-hub__id' },
      team ? teamChip(team.livery.primary) : null,
      h('div', null, h('b', { text: `${driverName(save.driver)}・#${save.driver.number}` }), h('small', { text: `${team ? team.name : ''}・第 ${save.season} 季・評價 ${ratingOverall(save.rating)}` })),
    );
    const stats = h(
      'div',
      { class: 'nvm-hub__stats' },
      h('span', null, h('b', { text: standingPosition(standings, PLAYER_DRIVER_ID) > 0 && save.results.length > 0 ? `P${standingPosition(standings, PLAYER_DRIVER_ID)}` : '—' }), h('small', { text: '積分榜' })),
      h('span', null, h('b', { text: String(me ? me.points : 0) }), h('small', { text: '積分' })),
      h('span', null, h('b', { text: `${save.results.length}/${save.calendar.length}` }), h('small', { text: '已完成' })),
    );

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
          h('div', null, h('b', { text: layout ? layout.displayName : round.layoutId }), h('small', { text: `預報：${weatherLabel(round.weather)}・${FORMAT_LABEL[save.settings.format]}` })),
        ),
      );
      this.primary = button({ label: '開始週末', variant: 'primary', onClick: () => this.startRound() });
    } else {
      roundCard = panel(null, h('p', { class: 'nvm-empty', text: '賽道資料尚未載入，無法開始比賽。' }));
      this.primary = null;
    }

    setChildren(
      this.col,
      heading('車手生涯', '生涯樞紐'),
      header,
      stats,
      roundCard,
      h(
        'nav',
        { class: 'nvm-menu-list' },
        this.primary,
        button({ label: '賽季賽程', onClick: () => this.host.push(new CalendarScreen(this.host, `第 ${save.season} 季`, save.calendar, save.results, PLAYER_DRIVER_ID, save.settings)) }),
        button({ label: '積分榜', onClick: () => this.host.push(new StandingsScreen(this.host, `第 ${save.season} 季`, save.results, roster, [PLAYER_DRIVER_ID], save.teamId)) }),
        button({ label: '車手資料與隊友對比', onClick: () => this.host.push(new DriverProfileScreen(this.host, save)) }),
        button({
          label: '賽季設定',
          onClick: () =>
            this.host.push(
              new SeasonSettingsScreen(this.host, '車手生涯', save.settings, loadProfile().assists, (settings, assists) => {
                const current = loadCareer();
                if (current) saveCareer({ ...current, settings });
                const profile = loadProfile();
                profile.assists = assists;
                saveProfile(profile);
              }),
            ),
        }),
        button({
          label: '開始新生涯',
          variant: 'danger',
          onClick: () =>
            this.host.confirm('開始新生涯？', '目前的生涯進度將被刪除，且無法復原。', () => {
              saveCareer(null);
              this.host.replace(new CareerWizardScreen(this.host));
            }, '刪除並重新開始'),
        }),
        button({ label: '返回主選單', back: true, onClick: () => this.host.pop() }),
      ),
    );
  }

  private startRound(): void {
    const save = this.save;
    const round = save ? currentRound(save) : null;
    const layout = round ? findLayout(round.layoutId) : null;
    if (!save || !round || !layout) {
      this.host.sound('error');
      this.host.toast('賽道資料尚未載入', 'bad');
      return;
    }
    const profile = loadProfile();
    const req = careerRequest(save, 'race', layout.fullLaps, { assists: profile.assists, setup: loadSetup(layout.id), startCompound: null }, null);
    if (!req) return;
    launchWeekend(this.host, req, seasonWeekend(save.settings, save.results.length, save.calendar), { returnTo: 'career', round: save.results.length, storyId: null });
  }

  private nextSeason(): void {
    if (!this.save) return;
    const layouts = listLayouts();
    if (layouts.length === 0) {
      this.host.sound('error');
      this.host.toast('賽道資料尚未載入', 'bad');
      return;
    }
    this.save = startNextCareerSeason(this.save, Date.now() >>> 0, layouts);
    saveCareer(this.save);
    this.host.toast(`第 ${this.save.season} 季開始！`, 'good');
    this.render();
    if (this.primary) focusElement(this.primary);
  }
}
