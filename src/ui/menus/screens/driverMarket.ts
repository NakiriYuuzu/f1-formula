/**
 * My Team driver market: sign a reserve driver as the second driver.
 */
import { reserveSalary, signTeammate } from '../../../meta/myTeam';
import { driverName, reserveDrivers } from '../../../meta/roster';
import { loadMyTeam, saveMyTeam } from '../../../meta/save';
import { h, setChildren } from '../dom';
import { focusElement } from '../nav';
import { money, nationalityLabel } from '../labels';
import { Screen, type Host } from '../screen';
import { button, heading, panel, statBar } from '../widgets';
import { myTeamTakenNumbers, skillAverage } from './myTeamWizard';

/** Driver market: sign one of the reserve drivers as the second driver. */
export class DriverMarketScreen extends Screen {
  readonly title = '車手市場';
  private readonly body: HTMLElement;

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-market' });
    this.body = h('div', { class: 'nvm-market__grid' });
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('車手市場', '第二車手簽約'),
        this.body,
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
      ),
    );
    this.render();
  }

  private render(): void {
    const save = loadMyTeam();
    if (!save) {
      setChildren(this.body, h('p', { class: 'nvm-empty', text: '找不到車隊存檔。' }));
      return;
    }
    setChildren(
      this.body,
      reserveDrivers().map((d) => {
        const current = d.id === save.teammateId;
        const fee = reserveSalary(d);
        const clash = d.number === save.driver.number;
        return panel(
          null,
          h('div', { class: 'nvm-market__head' }, h('b', { text: `#${d.number} ${driverName(d)}` }), h('small', { text: nationalityLabel(d.nationality) })),
          statBar('綜合', (skillAverage(d) - 0.7) / 0.3, String(Math.round(skillAverage(d) * 100))),
          statBar('速度', (d.skill.pace - 0.7) / 0.3, String(Math.round(d.skill.pace * 100))),
          statBar('雨戰', (d.skill.wet - 0.7) / 0.3, String(Math.round(d.skill.wet * 100))),
          button({
            label: current ? '目前隊友' : clash ? '車號衝突' : `簽約（${money(fee)}）`,
            variant: current ? 'ghost' : 'primary',
            disabled: current || clash || save.budget < fee,
            onClick: () =>
              this.host.confirm(`簽下 ${driverName(d)}？`, `簽約金 ${money(fee)} 將從資金中扣除（目前 ${money(save.budget)}）。`, () => {
                const latest = loadMyTeam();
                const next = latest ? signTeammate(latest, d.id) : null;
                if (!next || myTeamTakenNumbers(next.teammateId).has(next.driver.number)) {
                  this.host.sound('error');
                  this.host.toast('簽約失敗：資金不足或車號衝突', 'bad');
                  return;
                }
                saveMyTeam(next);
                this.host.toast(`已簽下 ${driverName(d)}`, 'good');
                this.render();
                const first = this.body.querySelector<HTMLElement>('button:not([disabled])');
                if (first) focusElement(first);
              }, '簽約'),
          }),
        );
      }),
    );
  }
}
