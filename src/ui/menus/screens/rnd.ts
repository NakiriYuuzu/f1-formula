/**
 * My Team R&D centre: aero / power / chassis / reliability levels, costs and resulting ratings.
 */
import {
  departmentRating,
  isAnyDepartmentMaxed,
  myTeamDef,
  purchaseUpgrade,
  RD_CAP,
  RD_DEPARTMENTS,
  RD_MAX_LEVEL,
  rdUpgradeCost,
  upgradeBonus,
  type MyTeamSave,
  type RdDepartment,
} from '../../../meta/myTeam';
import { achievementDef } from '../../../meta/achievements';
import { unlockNow } from '../../../meta/progression';
import { loadMyTeam, saveMyTeam } from '../../../meta/save';
import { h, setChildren } from '../dom';
import { focusElement } from '../nav';
import { money, RD_LABEL } from '../labels';
import { Screen, type Host, type StageRequest } from '../screen';
import { myTeamCar } from '../showroom';
import { button, heading, infoLine, panel } from '../widgets';

/** R&D centre: one card per department with level pips, resulting rating and upgrade cost. */
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
    const rating = myTeamDef(save).rating;
    const cards = RD_DEPARTMENTS.map((dept) => {
      const level = save.rd[dept];
      const cost = rdUpgradeCost(level);
      const gain = cost === null ? 0 : (departmentRating(save.powerUnit, dept, level + 1) - departmentRating(save.powerUnit, dept, level)) * 100;
      const pips = h('span', { class: 'nvm-pips' }, Array.from({ length: RD_MAX_LEVEL }, (_, i) => h('i', { class: i < level ? 'is-on' : '' })));
      return h(
        'div',
        { class: 'nvm-rnd__dept' },
        h('div', { class: 'nvm-rnd__head' }, h('b', { text: RD_LABEL[dept] }), pips, h('span', { class: 'nvm-rnd__rating', text: `評分 ${Math.round(rating[dept] * 100)}` })),
        button({
          label: cost === null ? '已達最高等級' : `升級（${money(cost)}・評分 +${gain.toFixed(1)}）`,
          variant: cost !== null && save.budget >= cost ? 'primary' : 'ghost',
          disabled: cost === null || save.budget < cost,
          onClick: () => this.upgrade(dept),
        }),
      );
    });
    setChildren(
      this.body,
      panel(
        null,
        infoLine('可用資金', money(save.budget)),
        infoLine('整體升級加成', `+${(upgradeBonus(save) * 100).toFixed(1)}%`),
        h('p', { class: 'nvm-note', text: `每級研發縮小該項評分與頂尖水準（${Math.round(RD_CAP * 100)}）的差距；可靠度越高，碰撞造成的零件損傷越少。整體研發進度另外提供車輛性能加成。比賽收入取決於積分與贊助目標。` }),
      ),
      ...cards,
      h('div', { class: 'nvm-actions' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
    );
  }

  private upgrade(dept: RdDepartment): void {
    if (!this.save) return;
    const next = purchaseUpgrade(this.save, dept);
    if (!next) {
      this.host.sound('error');
      this.host.toast('資金不足或已達最高等級', 'bad');
      return;
    }
    this.save = next;
    saveMyTeam(next);
    this.host.toast(`${RD_LABEL[dept]}升級至第 ${next.rd[dept]} 級`, 'good');
    if (isAnyDepartmentMaxed(next)) {
      for (const id of unlockNow(['rdMaxed'], new Date().toISOString())) this.host.toast(`成就解鎖：${achievementDef(id).title}`, 'good');
    }
    const focusedIndex = RD_DEPARTMENTS.indexOf(dept);
    this.render();
    const buttons = this.body.querySelectorAll<HTMLButtonElement>('.nvm-rnd__dept button');
    const target = buttons[focusedIndex];
    const fallback = this.body.querySelector<HTMLElement>('button:not([disabled])');
    if (target && !target.disabled) focusElement(target);
    else if (fallback) focusElement(fallback);
  }
}
