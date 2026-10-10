/**
 * My Team R&D centre: the 10 car parts grouped 空力／動力／底盤 (level, efficiency, effect, running project and the next
 * level's project paid from the budget), the latest round's development report and every team's progress.
 */
import type { CarPartId } from '../../../core/types';
import { MAX_PROJECTS } from '../../../meta/development';
import { myTeamDevelopment, myTeamRoster, startMyTeamProject, type MyTeamSave } from '../../../meta/myTeam';
import { MY_TEAM_ID } from '../../../meta/roster';
import { loadMyTeam, saveMyTeam } from '../../../meta/save';
import { h, setChildren } from '../dom';
import { money, PART_LABEL } from '../labels';
import { focusNearPart, partSections, reportPanel, rivalPanel, RND_RULES_NOTE } from '../components/rndPanels';
import { partGroups, partRow } from '../components/rndRows';
import { Screen, type Host, type StageRequest } from '../screen';
import { myTeamCar } from '../showroom';
import { button, heading, infoLine, panel } from '../widgets';

/** R&D centre: one card per part with level pips, efficiency, effect and the next project (cost, rounds, chance). */
export class RndScreen extends Screen {
  readonly title = '研發中心';
  private save: MyTeamSave | null;
  private readonly body: HTMLElement;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-rnd' });
    this.save = loadMyTeam();
    this.body = h('div', { class: 'nvm-rnd__body' });
    this.el.append(h('div', { class: 'nvm-col nvm-col--wide' }, heading('研發中心', '我的車隊'), this.body));
    this.render();
  }

  override stage(): StageRequest {
    return this.save ? { kind: 'car', car: myTeamCar(this.save) } : { kind: 'none' };
  }

  private render(): void {
    const save = this.save;
    if (!save) {
      setChildren(this.body, h('p', { class: 'nvm-empty', text: '找不到車隊存檔。' }), button({ label: '返回', back: true, onClick: () => this.host.pop() }));
      return;
    }
    const team = myTeamDevelopment(save);
    const teams = myTeamRoster(save).teams;
    setChildren(
      this.body,
      panel(
        null,
        infoLine('可用資金', money(save.budget)),
        infoLine('研發槽', `研發中 ${team.projects.length}/${MAX_PROJECTS}`),
        h('p', { class: 'nvm-note', text: `${RND_RULES_NOTE}自家零件的平均效率也會提升車隊的空力、動力、底盤與可靠度評分。比賽收入取決於積分與贊助目標。` }),
      ),
      partSections(partGroups(team, save.budget, 'money'), (part) => this.start(part)),
      reportPanel(save.development.report, teams, MY_TEAM_ID),
      rivalPanel(save.development, teams, MY_TEAM_ID),
      h('div', { class: 'nvm-actions' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
    );
  }

  private start(part: CarPartId): void {
    if (!this.save) return;
    const next = startMyTeamProject(this.save, part);
    if (!next) {
      this.host.sound('error');
      this.host.toast(partRow(myTeamDevelopment(this.save), part, this.save.budget, 'money').reason ?? '無法開始研發', 'bad');
      return;
    }
    this.save = next;
    saveMyTeam(next);
    this.host.toast(`${PART_LABEL[part]} Lv${myTeamDevelopment(next).parts[part].level + 1} 研發開始`, 'good');
    this.render();
    focusNearPart(this.body, part);
  }
}
