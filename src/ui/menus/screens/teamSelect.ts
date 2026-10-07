/**
 * Team (and optionally driver) picker over the showroom: the focused team / driver is previewed on the 3D car,
 * with car ratings and line-up in a floating card.
 */
import type { DriverDef, TeamDef } from '../../../core/types';
import { driverName, type Roster } from '../../../meta/roster';
import type { SeatChoice } from '../../../meta/prefs';
import { h, setChildren } from '../dom';
import { focusElement } from '../nav';
import { nationalityLabel } from '../labels';
import { Screen, type Host, type StageRequest } from '../screen';
import { showroomCar } from '../showroom';
import type { ShowroomCar } from '../types';
import { heading, statBar, teamChip } from '../widgets';

export interface TeamSelectOptions {
  title: string;
  kicker: string;
  roster: Roster;
  initial: SeatChoice;
  /** second step: choose one of the team's drivers */
  pickDriver: boolean;
  /** driver that cannot be chosen (e.g. taken by the other player) */
  excludeDriverId?: string | null;
  /** extra line for a team (e.g. "replaces …") */
  note?: (team: TeamDef) => string | null;
  /** custom preview car for a team (team-only mode) */
  preview?: (team: TeamDef) => ShowroomCar;
  onChosen(seat: SeatChoice): void;
}

export class TeamSelectScreen extends Screen {
  readonly title: string;
  private readonly listEl: HTMLElement;
  private readonly infoEl: HTMLElement;
  private readonly kickerEl: HTMLElement;
  private phase: 'team' | 'driver' = 'team';
  private team: TeamDef | undefined;
  private car: ShowroomCar;

  constructor(
    host: Host,
    private readonly o: TeamSelectOptions,
  ) {
    super(host, { layout: 'showroom', className: 'nvm-teamselect' });
    this.title = o.title;
    this.team = o.roster.teams.find((t) => t.id === o.initial.teamId) ?? o.roster.teams[0];
    this.car = this.previewCar(this.team, this.firstDriver(this.team));
    this.listEl = h('div', { class: 'nvm-list' });
    this.infoEl = h('div', { class: 'nvm-float nvm-panel' });
    this.kickerEl = h('p', { class: 'nvm-col__hint' });
    this.el.append(h('div', { class: 'nvm-col' }, heading(o.title, o.kicker), this.kickerEl, this.listEl), this.infoEl);
    this.renderTeams();
  }

  override stage(): StageRequest {
    return { kind: 'car', car: this.car };
  }

  override initialFocus(): HTMLElement | null {
    return this.listEl.querySelector<HTMLElement>('.is-selected') ?? null;
  }

  override onBack(): boolean {
    if (this.phase === 'driver') {
      this.renderTeams();
      const sel = this.initialFocus();
      if (sel) focusElement(sel);
      this.host.sound('back');
      return true;
    }
    return false;
  }

  private drivers(team: TeamDef | undefined): DriverDef[] {
    if (!team) return [];
    return team.driverIds
      .map((id) => this.o.roster.drivers.find((d) => d.id === id))
      .filter((d): d is DriverDef => d !== undefined);
  }

  private firstDriver(team: TeamDef | undefined): DriverDef | undefined {
    const list = this.drivers(team);
    return list.find((d) => d.id === this.o.initial.driverId) ?? list.find((d) => d.id !== this.o.excludeDriverId) ?? list[0];
  }

  private previewCar(team: TeamDef | undefined, driver: DriverDef | undefined): ShowroomCar {
    if (team && this.o.preview) return this.o.preview(team);
    return showroomCar(team, driver);
  }

  private setPreview(team: TeamDef | undefined, driver: DriverDef | undefined): void {
    this.car = this.previewCar(team, driver);
    this.host.refreshStage();
  }

  private renderInfo(team: TeamDef | undefined): void {
    if (!team) {
      this.infoEl.replaceChildren();
      return;
    }
    const r = team.rating;
    const note = this.o.note ? this.o.note(team) : null;
    setChildren(
      this.infoEl,
      h('div', { class: 'nvm-float__head' }, teamChip(team.livery.primary), h('b', { text: team.name }), h('small', { text: ` ${team.shortName}` })),
      h('div', { class: 'nvm-float__sub', text: `總部：${team.base}・動力單元：${team.powerUnit}` }),
      statBar('空力', (r.aero - 0.8) / 0.2, String(Math.round(r.aero * 100))),
      statBar('動力', (r.power - 0.8) / 0.2, String(Math.round(r.power * 100))),
      statBar('底盤', (r.chassis - 0.8) / 0.2, String(Math.round(r.chassis * 100))),
      statBar('可靠度', (r.reliability - 0.8) / 0.2, String(Math.round(r.reliability * 100))),
      h(
        'div',
        { class: 'nvm-float__drivers' },
        this.drivers(team).map((d) => h('span', null, h('b', { text: `#${d.number}` }), ` ${driverName(d)}（${nationalityLabel(d.nationality)}）`)),
      ),
      note ? h('p', { class: 'nvm-note', text: note }) : null,
    );
  }

  private renderTeams(): void {
    this.phase = 'team';
    this.kickerEl.textContent = this.o.pickDriver ? '選擇車隊，接著選擇車手' : '選擇車隊';
    const buttons = this.o.roster.teams.map((team) =>
      h(
        'button',
        {
          class: `nvm-pick${team.id === this.team?.id ? ' is-selected' : ''}`,
          attrs: { type: 'button', 'data-sound': 'confirm' },
          style: { '--team': team.livery.primary, '--team-2': team.livery.secondary },
          on: {
            focus: () => {
              this.team = team;
              this.renderInfo(team);
              this.setPreview(team, this.firstDriver(team));
            },
            click: () => this.chooseTeam(team),
          },
        },
        teamChip(team.livery.primary),
        h('span', { class: 'nvm-pick__name', text: team.name }),
        h('span', { class: 'nvm-pick__tag', text: team.shortName }),
      ),
    );
    this.listEl.replaceChildren(...buttons);
    this.renderInfo(this.team);
  }

  private chooseTeam(team: TeamDef): void {
    this.team = team;
    if (!this.o.pickDriver) {
      this.o.onChosen({ teamId: team.id, driverId: '' });
      return;
    }
    this.phase = 'driver';
    this.kickerEl.textContent = `${team.name}：選擇車手（Esc 返回車隊列表）`;
    const initial = this.firstDriver(team);
    const buttons = this.drivers(team).map((d) => {
      const taken = d.id === this.o.excludeDriverId;
      return h(
        'button',
        {
          class: `nvm-pick nvm-pick--driver${d.id === initial?.id ? ' is-selected' : ''}`,
          attrs: { type: 'button', disabled: taken, 'data-sound': 'confirm' },
          style: { '--team': team.livery.primary, '--team-2': d.helmet.primary },
          on: {
            focus: () => this.setPreview(team, d),
            click: () => this.o.onChosen({ teamId: team.id, driverId: d.id }),
          },
        },
        h('span', { class: 'nvm-pick__num', text: String(d.number) }),
        h('span', { class: 'nvm-pick__name', text: driverName(d) }),
        h('span', { class: 'nvm-pick__tag', text: taken ? '已被選擇' : `${d.abbr}・${nationalityLabel(d.nationality)}` }),
      );
    });
    this.listEl.replaceChildren(...buttons);
    const target = this.listEl.querySelector<HTMLElement>('.is-selected:not([disabled])') ?? this.listEl.querySelector<HTMLElement>('button:not([disabled])');
    if (target) focusElement(target);
  }
}
