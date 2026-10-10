/**
 * New My Team wizard: name & short name → livery (3 colours + pattern + number, live on the showroom car) →
 * owner-driver identity → power unit → teammate signing from the reserves → season settings & budget summary.
 */
import type { Assists, DriverDef } from '../../../core/types';
import {
  createMyTeam,
  powerUnitOption,
  powerUnitOptions,
  reserveSalary,
  startingBudget,
  teamNameProblems,
  type MyTeamDraft,
} from '../../../meta/myTeam';
import { listLayouts } from '../../../meta/options';
import { driverName, reserveDrivers, rosterTeams, standardRoster, usedNumbers } from '../../../meta/roster';
import { loadProfile, saveMyTeam, saveProfile } from '../../../meta/save';
import { DEFAULT_SEASON_SETTINGS } from '../../../meta/season';
import { identityForm, lettersOnly, liveryFields } from '../components/forms';
import { assistsEditor, seasonSettingsEditor } from '../components/editors';
import { h, setChildren } from '../dom';
import { focusElement } from '../nav';
import { money, nationalityLabel } from '../labels';
import { Screen, type Host, type StageRequest } from '../screen';
import type { ShowroomCar } from '../types';
import { button, heading, infoLine, panel, slider, statBar, textField } from '../widgets';
import { MyTeamHubScreen } from './myTeamHub';

const STEPS = ['車隊名稱', '塗裝', '車手', '動力單元', '隊友', '確認'];

/** Numbers taken by the standard field (+ an optional reserve teammate). */
export function myTeamTakenNumbers(teammateId: string): Set<number> {
  const taken = usedNumbers(standardRoster());
  const mate = reserveDrivers().find((d) => d.id === teammateId);
  if (mate) taken.add(mate.number);
  return taken;
}

export function skillAverage(d: DriverDef): number {
  const s = d.skill;
  return (s.pace + s.racecraft + s.awareness + s.wet + s.consistency) / 5;
}

export class MyTeamWizardScreen extends Screen {
  readonly title = '我的車隊';
  private step = 0;
  private draft: MyTeamDraft;
  private assists: Assists;
  private readonly body: HTMLElement;
  private readonly stepsEl: HTMLElement;
  private firstFocus: HTMLElement | null = null;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-wizard' });
    const reserves = reserveDrivers();
    this.draft = {
      name: '',
      shortName: '',
      livery: { primary: '#ff5a1f', secondary: '#111214', accent: '#f4f1e8', pattern: 'chevron' },
      powerUnit: powerUnitOption('').id,
      identity: {
        firstName: '',
        lastName: '',
        abbr: '',
        number: 2,
        nationality: 'TWN',
        helmet: { primary: '#ff5a1f', secondary: '#f4f1e8', accent: '#111214', pattern: 'classic' },
      },
      teammateId: reserves[0]?.id ?? '',
      // new teams draw a random calendar so every save runs a different season
      settings: { ...DEFAULT_SEASON_SETTINGS, calendar: 'random', rules: { ...DEFAULT_SEASON_SETTINGS.rules } },
    };
    this.assists = { ...loadProfile().assists };
    this.stepsEl = h('div', { class: 'nvm-steps' });
    this.body = h('div', { class: 'nvm-wizard__body' });
    this.el.append(h('div', { class: 'nvm-col nvm-col--wide' }, heading('建立我的車隊', `第 ${rosterTeams().length + 1} 支車隊`), this.stepsEl, this.body));
    this.render();
  }

  override stage(): StageRequest {
    return { kind: 'car', car: this.car() };
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

  private car(): ShowroomCar {
    return {
      livery: { ...this.draft.livery },
      number: this.draft.identity.number,
      teamShort: this.draft.shortName.length === 3 ? this.draft.shortName : 'NEW',
      helmet: { ...this.draft.identity.helmet },
    };
  }

  private go(step: number): void {
    this.step = Math.max(0, Math.min(STEPS.length - 1, step));
    this.render();
    this.host.refreshStage();
    const target = this.firstFocus ?? this.body.querySelector<HTMLElement>('button, input, [tabindex="0"]');
    if (target) focusElement(target);
  }

  private nav(nextLabel: string, onNext: () => void): HTMLElement {
    const back = this.step === 0 ? button({ label: '返回', back: true, onClick: () => this.host.pop() }) : button({ label: '上一步', back: true, onClick: () => this.go(this.step - 1) });
    return h('div', { class: 'nvm-actions' }, back, button({ label: nextLabel, variant: 'primary', onClick: onNext }));
  }

  private fail(message: string): void {
    this.host.sound('error');
    this.host.toast(message, 'bad');
  }

  private render(): void {
    this.stepsEl.replaceChildren(
      ...STEPS.map((t, i) => h('span', { class: `nvm-steps__item${i === this.step ? ' is-current' : i < this.step ? ' is-done' : ''}`, text: `${i + 1}. ${t}` })),
    );
    [this.renderName, this.renderLivery, this.renderDriver, this.renderPowerUnit, this.renderTeammate, this.renderConfirm][this.step]?.call(this);
  }

  private renderName(): void {
    const name = textField({ label: '車隊名稱', value: this.draft.name, maxLength: 24, placeholder: '例：Nova Works Racing', onInput: (v) => (this.draft.name = v) });
    const short = textField({
      label: '車隊縮寫（3 個英文字母）',
      value: this.draft.shortName,
      maxLength: 3,
      transform: lettersOnly,
      onInput: (v) => {
        this.draft.shortName = v;
        this.host.refreshStage();
      },
    });
    this.firstFocus = name.input;
    setChildren(
      this.body,
      panel('車隊名稱', name.el, short.el, h('p', { class: 'nvm-note', text: '縮寫會印在車身與計時塔上，不可與其他車隊重複。' })),
      this.nav('下一步：塗裝', () => {
        const problems = teamNameProblems(this.draft.name, this.draft.shortName);
        if (problems.length > 0) this.fail(problems[0] ?? '資料不完整');
        else this.go(1);
      }),
    );
  }

  private renderLivery(): void {
    const fields = liveryFields(this.draft.livery, (l) => {
      this.draft.livery = l;
      this.host.refreshStage();
    });
    const taken = (): Set<number> => myTeamTakenNumbers(this.draft.teammateId);
    const number = slider({
      label: '車號',
      min: 1,
      max: 99,
      step: 1,
      value: this.draft.identity.number,
      format: (n) => (taken().has(n) ? `#${n}（已被使用）` : `#${n}`),
      onChange: (n) => {
        this.draft.identity = { ...this.draft.identity, number: n };
        this.host.refreshStage();
      },
    });
    this.firstFocus = fields.first;
    setChildren(
      this.body,
      fields.el,
      panel('車號', number.el),
      this.nav('下一步：車手', () => {
        if (taken().has(this.draft.identity.number)) this.fail(`車號 ${this.draft.identity.number} 已被使用`);
        else this.go(2);
      }),
    );
  }

  private renderDriver(): void {
    const form = identityForm(
      this.draft.identity,
      () => new Set<number>(),
      (id) => {
        this.draft.identity = { ...id, number: this.draft.identity.number };
        this.host.refreshStage();
      },
      { number: false },
    );
    this.firstFocus = form.first;
    setChildren(
      this.body,
      form.el,
      this.nav('下一步：動力單元', () => {
        const problems = form.problems();
        if (problems.length > 0) this.fail(problems[0] ?? '資料不完整');
        else this.go(3);
      }),
    );
  }

  private renderPowerUnit(): void {
    const info = h('div', { class: 'nvm-panel' });
    const show = (id: string): void => {
      const pu = powerUnitOption(id);
      setChildren(
        info,
        h('b', { text: pu.id }),
        h('p', { class: 'nvm-note', text: pu.blurb }),
        statBar('輸出', (pu.power - 0.8) / 0.2, String(Math.round(pu.power * 100))),
        statBar('可靠度', (pu.reliability - 0.8) / 0.2, String(Math.round(pu.reliability * 100))),
        infoLine('年度費用', money(pu.cost)),
      );
    };
    const buttons = powerUnitOptions().map((pu) =>
      h(
        'button',
        {
          class: `nvm-pick${pu.id === this.draft.powerUnit ? ' is-selected' : ''}`,
          attrs: { type: 'button', 'data-sound': 'confirm' },
          on: {
            focus: () => show(pu.id),
            click: () => {
              this.draft.powerUnit = pu.id;
              this.go(4);
            },
          },
        },
        h('span', { class: 'nvm-pick__name', text: pu.id }),
        h('span', { class: 'nvm-pick__tag', text: money(pu.cost) }),
      ),
    );
    this.firstFocus = buttons.find((b) => b.classList.contains('is-selected')) ?? buttons[0] ?? null;
    show(this.draft.powerUnit);
    setChildren(this.body, h('div', { class: 'nvm-list' }, buttons), info, h('div', { class: 'nvm-actions' }, button({ label: '上一步', back: true, onClick: () => this.go(2) })));
  }

  private renderTeammate(): void {
    const info = h('div', { class: 'nvm-panel' });
    const reserves = reserveDrivers();
    const show = (d: DriverDef): void => {
      setChildren(
        info,
        h('b', { text: `${driverName(d)}・#${d.number}` }),
        h('p', { class: 'nvm-note', text: `${nationalityLabel(d.nationality)}・薪資 ${money(reserveSalary(d))}` }),
        statBar('速度', (d.skill.pace - 0.7) / 0.3),
        statBar('纏鬥', (d.skill.racecraft - 0.7) / 0.3),
        statBar('判斷', (d.skill.awareness - 0.7) / 0.3),
        statBar('雨戰', (d.skill.wet - 0.7) / 0.3),
        statBar('穩定', (d.skill.consistency - 0.7) / 0.3),
      );
    };
    const buttons = reserves.map((d) =>
      h(
        'button',
        {
          class: `nvm-pick nvm-pick--driver${d.id === this.draft.teammateId ? ' is-selected' : ''}`,
          attrs: { type: 'button', 'data-sound': 'confirm' },
          style: { '--team': d.helmet.primary },
          on: {
            focus: () => show(d),
            click: () => {
              if (d.number === this.draft.identity.number) {
                this.fail(`${driverName(d)} 的車號與你相同（#${d.number}），請先更換車號`);
                return;
              }
              this.draft.teammateId = d.id;
              this.go(5);
            },
          },
        },
        h('span', { class: 'nvm-pick__num', text: String(d.number) }),
        h('span', { class: 'nvm-pick__name', text: driverName(d) }),
        h('span', { class: 'nvm-pick__tag', text: money(reserveSalary(d)) }),
      ),
    );
    this.firstFocus = buttons.find((b) => b.classList.contains('is-selected')) ?? buttons[0] ?? null;
    const current = reserves.find((d) => d.id === this.draft.teammateId) ?? reserves[0];
    if (current) show(current);
    setChildren(this.body, h('div', { class: 'nvm-list' }, buttons), info, h('div', { class: 'nvm-actions' }, button({ label: '上一步', back: true, onClick: () => this.go(3) })));
  }

  private renderConfirm(): void {
    const create = button({ label: '建立車隊', variant: 'primary', onClick: () => this.create() });
    const mate = reserveDrivers().find((d) => d.id === this.draft.teammateId);
    const pu = powerUnitOption(this.draft.powerUnit);
    this.firstFocus = create;
    setChildren(
      this.body,
      panel(
        `${this.draft.name}（${this.draft.shortName}）`,
        infoLine('車手', `${driverName(this.draft.identity)}・#${this.draft.identity.number}`),
        infoLine('隊友', mate ? `${driverName(mate)}・#${mate.number}` : '—'),
        infoLine('動力單元', `${pu.id}（${money(pu.cost)}／季）`),
        infoLine('起始資金', money(startingBudget(this.draft.powerUnit, this.draft.teammateId))),
        h('div', { class: 'nvm-actions' }, button({ label: '上一步', back: true, onClick: () => this.go(4) }), create),
      ),
      seasonSettingsEditor(this.draft.settings, (s) => (this.draft.settings = s)),
      assistsEditor(this.assists, (a) => (this.assists = a)),
    );
  }

  private create(): void {
    const layouts = listLayouts();
    if (layouts.length === 0) {
      this.fail('賽道資料尚未載入，無法建立賽程');
      return;
    }
    if (myTeamTakenNumbers(this.draft.teammateId).has(this.draft.identity.number)) {
      this.fail(`車號 ${this.draft.identity.number} 已被使用`);
      return;
    }
    saveMyTeam(createMyTeam(this.draft, Date.now() >>> 0, layouts));
    const profile = loadProfile();
    profile.assists = { ...this.assists };
    saveProfile(profile);
    this.host.toast(`${this.draft.name} 正式成軍！`, 'good');
    this.host.replace(new MyTeamHubScreen(this.host));
  }
}
