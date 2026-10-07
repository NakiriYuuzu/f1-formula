/**
 * Grand Prix setup: track → team & driver → event options (distance, AI, weather, time, regulation, weekend
 * format, qualifying type), rules and assists → weekend briefing. Choices persist in the profile.
 */
import type { SessionRequest } from '../../../meta/sessionBuilder';
import { findLayout, listLayouts, resolveLaps, weekendSessions } from '../../../meta/options';
import { standardRoster, driverName } from '../../../meta/roster';
import { loadProfile, loadSetup, saveProfile } from '../../../meta/save';
import type { ProfileSave } from '../../../meta/prefs';
import { assistsEditor, raceOptionsEditor, rulesEditor } from '../components/editors';
import { h } from '../dom';
import { launchWeekend } from '../flow';
import { Screen, type Host } from '../screen';
import { button, heading, panel, tabbedSections, teamChip } from '../widgets';
import { minimapCanvas } from '../minimap';
import { TeamSelectScreen } from './teamSelect';
import { TrackSelectScreen } from './trackSelect';

function trackStep(host: Host): TrackSelectScreen {
  return new TrackSelectScreen(host, {
    title: '大獎賽',
    kicker: '大獎賽・步驟 1／3',
    initial: loadProfile().gp.layoutId,
    onChosen: (layoutId) => {
      const profile = loadProfile();
      profile.gp.layoutId = layoutId;
      saveProfile(profile);
      host.push(teamStep(host));
    },
  });
}

function teamStep(host: Host): TeamSelectScreen {
  const gp = loadProfile().gp;
  return new TeamSelectScreen(host, {
    title: '大獎賽',
    kicker: '大獎賽・步驟 2／3',
    roster: standardRoster(),
    initial: { teamId: gp.teamId, driverId: gp.driverId },
    pickDriver: true,
    onChosen: (seat) => {
      const profile = loadProfile();
      profile.gp.teamId = seat.teamId;
      profile.gp.driverId = seat.driverId;
      saveProfile(profile);
      host.push(new GrandPrixOptionsScreen(host));
    },
  });
}

/** Entry from the main menu. */
export function grandPrixEntry(host: Host): Screen {
  return trackStep(host);
}

/** Full chain (returning to the Grand Prix hub after a session). */
export function grandPrixStack(host: Host): Screen[] {
  return [trackStep(host), teamStep(host), new GrandPrixOptionsScreen(host)];
}

export class GrandPrixOptionsScreen extends Screen {
  readonly title = '大獎賽';
  private readonly profile: ProfileSave;
  private readonly startBtn: HTMLButtonElement;

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-gp' });
    this.profile = loadProfile();
    const gp = this.profile.gp;
    const layout = findLayout(gp.layoutId) ?? listLayouts()[0] ?? null;
    const roster = standardRoster();
    const driver = roster.drivers.find((d) => d.id === gp.driverId);
    const team = roster.teams.find((t) => t.id === gp.teamId);
    const persist = (): void => saveProfile(this.profile);
    this.startBtn = button({ label: '開始週末', variant: 'primary', onClick: () => this.start() });
    const race = raceOptionsEditor(
      { laps: gp.laps, aiDifficulty: gp.aiDifficulty, weather: gp.weather, timeOfDay: gp.timeOfDay, regulation: gp.regulation, format: gp.format, qualifying: gp.qualifying },
      layout ? layout.fullLaps : null,
      (v) => {
        Object.assign(this.profile.gp, v);
        persist();
      },
    );
    const rules = rulesEditor(gp.rules, (r) => {
      this.profile.gp.rules = r;
      persist();
    });
    const assists = assistsEditor(this.profile.assists, (a) => {
      this.profile.assists = a;
      persist();
    });
    const summary = panel(
      '本場概要',
      layout ? h('div', { class: 'nvm-briefing__map' }, minimapCanvas(layout.id, 260, 170, { lineWidth: 3 })) : null,
      h('div', { class: 'nvm-summary__item' }, h('small', { text: '賽道' }), h('b', { text: layout ? layout.displayName : '—' })),
      h(
        'div',
        { class: 'nvm-summary__item' },
        h('small', { text: '車手' }),
        team ? teamChip(team.livery.primary) : null,
        h('b', { text: driver ? `${driverName(driver)}・${team?.name ?? ''}` : '—' }),
      ),
      h('p', { class: 'nvm-note', text: '返回上一步可更換賽道或車手。' }),
    );
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('賽事設定', '大獎賽・步驟 3／3'),
        h(
          'div',
          { class: 'nvm-columns nvm-columns--side' },
          tabbedSections([
            { id: 'race', label: '賽事設定', el: race },
            { id: 'rules', label: '規則', el: rules },
            { id: 'assists', label: '駕駛輔助', el: assists },
          ]),
          summary,
        ),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() }), this.startBtn),
      ),
    );
  }

  override initialFocus(): HTMLElement {
    return this.startBtn;
  }

  private start(): void {
    const gp = this.profile.gp;
    const layout = findLayout(gp.layoutId) ?? listLayouts()[0];
    if (!layout) {
      this.host.sound('error');
      this.host.toast('賽道資料尚未載入', 'bad');
      return;
    }
    const base: SessionRequest = {
      mode: 'grandPrix',
      kind: 'race',
      layoutId: layout.id,
      raceLaps: resolveLaps(gp.laps, layout.fullLaps),
      weather: gp.weather,
      timeOfDay: gp.timeOfDay,
      regulation: gp.regulation,
      aiDifficulty: gp.aiDifficulty,
      qualifying: gp.qualifying,
      rules: { ...gp.rules },
      seed: Date.now() >>> 0,
      players: [
        {
          playerIndex: 0,
          driverId: gp.driverId,
          teamId: gp.teamId,
          setup: loadSetup(layout.id),
          assists: { ...this.profile.assists },
          startCompound: null,
        },
      ],
      roster: standardRoster(),
      aiCount: null,
      gridOrder: null,
      playerStartPosition: null,
      ghost: null,
      objective: null,
    };
    launchWeekend(this.host, base, weekendSessions(gp.format), { returnTo: 'grandPrix', round: null, storyId: null });
  }
}
