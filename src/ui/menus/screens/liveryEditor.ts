/**
 * My Team livery editor: three colours, pattern and car number, previewed live on the showroom car.
 */
import type { Livery } from '../../../core/types';
import { myTeamDef, type MyTeamSave } from '../../../meta/myTeam';
import { loadMyTeam, saveMyTeam } from '../../../meta/save';
import { liveryFields } from '../components/forms';
import { h } from '../dom';
import { Screen, type Host, type StageRequest } from '../screen';
import { showroomCar } from '../showroom';
import { button, heading, panel, slider } from '../widgets';
import { myTeamTakenNumbers } from './myTeamWizard';

/** Livery editor with live preview on the showroom car; saved on "完成". */
export class LiveryEditorScreen extends Screen {
  readonly title = '塗裝編輯';
  private livery: Livery;
  private number: number;
  private readonly save: MyTeamSave | null;

  constructor(host: Host) {
    super(host, { layout: 'showroom', className: 'nvm-livery' });
    this.save = loadMyTeam();
    this.livery = this.save ? { ...this.save.livery } : { primary: '#ff5a1f', secondary: '#111214', accent: '#ffffff', pattern: 'classic' };
    this.number = this.save ? this.save.driver.number : 2;
    const fields = liveryFields(this.livery, (l) => {
      this.livery = l;
      this.host.refreshStage();
    });
    const taken = (): Set<number> => {
      const set = myTeamTakenNumbers(this.save ? this.save.teammateId : '');
      return set;
    };
    const number = slider({
      label: '車號',
      min: 1,
      max: 99,
      step: 1,
      value: this.number,
      format: (n) => (taken().has(n) ? `#${n}（已被使用）` : `#${n}`),
      onChange: (n) => {
        this.number = n;
        this.host.refreshStage();
      },
    });
    this.el.append(
      h(
        'div',
        { class: 'nvm-col nvm-col--wide' },
        heading('塗裝編輯', this.save ? this.save.name : ''),
        fields.el,
        panel('車號', number.el),
        h(
          'div',
          { class: 'nvm-actions' },
          button({ label: '取消', back: true, onClick: () => this.host.pop() }),
          button({ label: '完成', variant: 'primary', onClick: () => this.finish(taken()) }),
        ),
      ),
    );
  }

  override stage(): StageRequest {
    if (!this.save) return { kind: 'none' };
    return { kind: 'car', car: showroomCar({ ...myTeamDef(this.save), livery: this.livery }, { number: this.number, helmet: this.save.driver.helmet }) };
  }

  private finish(taken: Set<number>): void {
    const latest = loadMyTeam();
    if (!latest) {
      this.host.pop();
      return;
    }
    if (taken.has(this.number)) {
      this.host.sound('error');
      this.host.toast(`車號 ${this.number} 已被使用`, 'bad');
      return;
    }
    saveMyTeam({ ...latest, livery: { ...this.livery }, driver: { ...latest.driver, number: this.number } });
    this.host.toast('塗裝已儲存', 'good');
    this.host.pop();
  }
}
