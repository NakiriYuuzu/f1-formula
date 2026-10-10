/**
 * Driver Career car development: the player's team's 10 car parts (same cards as the My Team R&D centre) paid with the
 * R&D points earned each round, the latest round's development report and every team's progress.
 */
import type { CarPartId } from '../../../core/types';
import { careerRoster, startCareerProject, type CareerSave } from '../../../meta/career';
import { MAX_PROJECTS } from '../../../meta/development';
import { PLAYER_DRIVER_ID } from '../../../meta/roster';
import { loadCareer, saveCareer } from '../../../meta/save';
import { h, setChildren } from '../dom';
import { PART_LABEL } from '../labels';
import { focusNearPart, partSections, reportPanel, rivalPanel, RND_RULES_NOTE } from '../components/rndPanels';
import { costLabel, partGroups, partRow, teamDevelopmentOf } from '../components/rndRows';
import { Screen, type Host, type StageRequest } from '../screen';
import { showroomCarFor } from '../showroom';
import { button, heading, infoLine, panel } from '../widgets';

/** Career R&D: one card per part with level pips, efficiency, effect and the next project (points, rounds, chance). */
export class CareerRndScreen extends Screen {
  readonly title = '車輛研發';
  private save: CareerSave | null;
  private readonly body: HTMLElement;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-rnd' });
    this.save = loadCareer();
    this.body = h('div', { class: 'nvm-rnd__body' });
    this.el.append(h('div', { class: 'nvm-col nvm-col--wide' }, heading('車輛研發', '車手生涯'), this.body));
    this.render();
  }

  override stage(): StageRequest {
    if (!this.save) return { kind: 'none' };
    return { kind: 'car', car: showroomCarFor(careerRoster(this.save).roster, PLAYER_DRIVER_ID, this.save.teamId) };
  }

  private render(): void {
    const save = this.save;
    if (!save) {
      setChildren(this.body, h('p', { class: 'nvm-empty', text: '找不到生涯存檔。' }), button({ label: '返回', back: true, onClick: () => this.host.pop() }));
      return;
    }
    const team = teamDevelopmentOf(save.development, save.teamId);
    const teams = careerRoster(save).roster.teams;
    setChildren(
      this.body,
      panel(
        null,
        infoLine('研發點數', costLabel(save.rdPoints, 'points')),
        infoLine('研發槽', `研發中 ${team.projects.length}/${MAX_PROJECTS}`),
        h('p', {
          class: 'nvm-note',
          text: `${RND_RULES_NOTE}每站正賽後獲得研發點數：以車隊積分榜名次決定的基本額度（與 AI 車隊相同，領先車隊較少、墊底車隊較多），再依完賽名次、是否勝過隊友與衝刺賽名次調整為 0.85–1.2 倍。`,
        }),
      ),
      partSections(partGroups(team, save.rdPoints, 'points'), (part) => this.start(part)),
      reportPanel(save.development.report, teams, save.teamId),
      rivalPanel(save.development, teams, save.teamId),
      h('div', { class: 'nvm-actions' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
    );
  }

  private start(part: CarPartId): void {
    if (!this.save) return;
    const next = startCareerProject(this.save, part);
    if (!next) {
      this.host.sound('error');
      this.host.toast(partRow(teamDevelopmentOf(this.save.development, this.save.teamId), part, this.save.rdPoints, 'points').reason ?? '無法開始研發', 'bad');
      return;
    }
    this.save = next;
    saveCareer(next);
    this.host.toast(`${PART_LABEL[part]} Lv${teamDevelopmentOf(next.development, next.teamId).parts[part].level + 1} 研發開始`, 'good');
    this.render();
    focusNearPart(this.body, part);
  }
}
