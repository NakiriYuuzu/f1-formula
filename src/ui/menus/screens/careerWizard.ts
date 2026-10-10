/**
 * New Driver Career wizard: 1) driver identity & helmet, 2) team choice with ratings (the player takes the
 * team's second seat), 3) season settings & assists → creates the career save and opens the hub.
 */
import type { Assists, TeamDef } from '../../../core/types';
import { careerTakenNumbers, createCareer } from '../../../meta/career';
import { listLayouts } from '../../../meta/options';
import { driverName, rosterTeams, standardRoster, type PlayerIdentity } from '../../../meta/roster';
import { loadProfile, saveCareer, saveProfile } from '../../../meta/save';
import { DEFAULT_SEASON_SETTINGS, type SeasonSettings } from '../../../meta/season';
import { identityForm } from '../components/forms';
import { assistsEditor, seasonSettingsEditor } from '../components/editors';
import { h, setChildren } from '../dom';
import { focusElement } from '../nav';
import { Screen, type Host, type StageRequest } from '../screen';
import { showroomCar } from '../showroom';
import { button, heading, panel, statBar, teamChip } from '../widgets';
import { CareerHubScreen } from './careerHub';

const STEP_TITLES = ['車手資料', '選擇車隊', '賽季設定'];

/** Team preselected in step 2: Helix in the built-in roster, else a midfield team of the roster pack. */
function defaultCareerTeam(): string {
  const teams = rosterTeams();
  return (teams.find((t) => t.id === 'helix') ?? teams[Math.floor(teams.length / 2)] ?? teams[0])?.id ?? '';
}

export class CareerWizardScreen extends Screen {
  readonly title = '車手生涯';
  private step = 0;
  private identity: PlayerIdentity = {
    firstName: '',
    lastName: '',
    abbr: '',
    number: 2,
    nationality: 'TWN',
    helmet: { primary: '#ff5a1f', secondary: '#f4f1e8', accent: '#111214', pattern: 'classic' },
  };
  private teamId = defaultCareerTeam();
  // new careers draw a random calendar so every save runs a different season
  private settings: SeasonSettings = { ...DEFAULT_SEASON_SETTINGS, calendar: 'random', rules: { ...DEFAULT_SEASON_SETTINGS.rules } };
  private assists: Assists;
  private readonly body: HTMLElement;
  private readonly kicker: HTMLElement;
  private firstFocus: HTMLElement | null = null;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-wizard' });
    this.assists = { ...loadProfile().assists };
    this.kicker = h('span');
    this.body = h('div', { class: 'nvm-wizard__body' });
    this.el.append(h('div', { class: 'nvm-col nvm-col--wide' }, heading('建立新生涯', ''), this.kicker, this.body));
    this.render();
  }

  override stage(): StageRequest {
    const team = rosterTeams().find((t) => t.id === this.teamId);
    return { kind: 'car', car: showroomCar(team, { number: this.identity.number, helmet: this.identity.helmet }) };
  }

  override initialFocus(): HTMLElement | null {
    return this.firstFocus;
  }

  override onBack(): boolean {
    if (this.step === 0) return false;
    this.host.sound('back');
    this.go(this.step - 1);
    return true;
  }

  private go(step: number): void {
    this.step = step;
    this.render();
    this.host.refreshStage();
    const target = this.firstFocus ?? this.body.querySelector<HTMLElement>('button, input, [tabindex="0"]');
    if (target) focusElement(target);
  }

  private render(): void {
    setChildren(
      this.kicker,
      h(
        'div',
        { class: 'nvm-steps' },
        STEP_TITLES.map((t, i) => h('span', { class: `nvm-steps__item${i === this.step ? ' is-current' : i < this.step ? ' is-done' : ''}`, text: `${i + 1}. ${t}` })),
      ),
    );
    if (this.step === 0) this.renderIdentity();
    else if (this.step === 1) this.renderTeams();
    else this.renderSettings();
  }

  private renderIdentity(): void {
    const form = identityForm(this.identity, () => careerTakenNumbers(this.teamId), (id) => {
      this.identity = id;
      this.host.refreshStage();
    });
    this.firstFocus = form.first;
    const next = button({
      label: '下一步：選擇車隊',
      variant: 'primary',
      onClick: () => {
        const problems = form.problems().filter((p) => !p.startsWith('車號'));
        if (problems.length > 0) {
          this.host.sound('error');
          this.host.toast(problems[0] ?? '資料不完整', 'bad');
          return;
        }
        this.go(1);
      },
    });
    setChildren(this.body, form.el, h('div', { class: 'nvm-actions' }, button({ label: '返回', back: true, onClick: () => this.host.pop() }), next));
  }

  private renderTeams(): void {
    const roster = standardRoster();
    const info = h('div', { class: 'nvm-panel nvm-wizard__teaminfo' });
    const showInfo = (team: TeamDef): void => {
      const keep = roster.drivers.find((d) => d.id === team.driverIds[0]);
      const out = roster.drivers.find((d) => d.id === team.driverIds[1]);
      const r = team.rating;
      setChildren(
        info,
        h('div', { class: 'nvm-float__head' }, teamChip(team.livery.primary), h('b', { text: team.name })),
        statBar('空力', (r.aero - 0.8) / 0.2, String(Math.round(r.aero * 100))),
        statBar('動力', (r.power - 0.8) / 0.2, String(Math.round(r.power * 100))),
        statBar('底盤', (r.chassis - 0.8) / 0.2, String(Math.round(r.chassis * 100))),
        statBar('可靠度', (r.reliability - 0.8) / 0.2, String(Math.round(r.reliability * 100))),
        h('p', { class: 'nvm-note', text: `隊友：${keep ? driverName(keep) : '—'}・你將取代 ${out ? driverName(out) : '—'} 的席位` }),
      );
    };
    const buttons = roster.teams.map((team) =>
      h(
        'button',
        {
          class: `nvm-pick${team.id === this.teamId ? ' is-selected' : ''}`,
          attrs: { type: 'button', 'data-sound': 'confirm' },
          style: { '--team': team.livery.primary, '--team-2': team.livery.secondary },
          on: {
            focus: () => {
              this.teamId = team.id;
              showInfo(team);
              this.host.refreshStage();
            },
            click: () => {
              this.teamId = team.id;
              if (careerTakenNumbers(team.id).has(this.identity.number)) {
                this.host.sound('error');
                this.host.toast(`車號 ${this.identity.number} 在這支車隊的賽季中已被使用，請返回更換車號`, 'bad');
                return;
              }
              this.go(2);
            },
          },
        },
        teamChip(team.livery.primary),
        h('span', { class: 'nvm-pick__name', text: team.name }),
        h('span', { class: 'nvm-pick__tag', text: `${Math.round(((team.rating.aero + team.rating.power + team.rating.chassis) / 3) * 100)}` }),
      ),
    );
    const selected = buttons.find((b) => b.classList.contains('is-selected')) ?? buttons[0] ?? null;
    this.firstFocus = selected;
    const current = roster.teams.find((t) => t.id === this.teamId);
    if (current) showInfo(current);
    setChildren(this.body, h('div', { class: 'nvm-list' }, buttons), info);
  }

  private renderSettings(): void {
    const team = rosterTeams().find((t) => t.id === this.teamId);
    const create = button({ label: '開始生涯', variant: 'primary', onClick: () => this.create() });
    this.firstFocus = create;
    setChildren(
      this.body,
      panel(
        '確認',
        h('p', { class: 'nvm-note', text: `${driverName(this.identity)}（${this.identity.abbr}・#${this.identity.number}）將加入 ${team ? team.name : ''}，展開完整賽季。` }),
        h('div', { class: 'nvm-actions' }, button({ label: '上一步', back: true, onClick: () => this.go(1) }), create),
      ),
      seasonSettingsEditor(this.settings, (s) => {
        this.settings = s;
      }),
      assistsEditor(this.assists, (a) => {
        this.assists = a;
      }),
    );
  }

  private create(): void {
    const layouts = listLayouts();
    if (layouts.length === 0) {
      this.host.sound('error');
      this.host.toast('賽道資料尚未載入，無法建立賽程', 'bad');
      return;
    }
    const career = createCareer(this.identity, this.teamId, this.settings, Date.now() >>> 0, layouts);
    saveCareer(career);
    const profile = loadProfile();
    profile.assists = { ...this.assists };
    saveProfile(profile);
    this.host.toast('生涯已建立', 'good');
    this.host.replace(new CareerHubScreen(this.host));
  }
}
