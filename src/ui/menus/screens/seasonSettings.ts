/**
 * Season settings screen (Driver Career / My Team): race options, rules and assists.
 */
import type { Assists } from '../../../core/types';
import type { SeasonSettings } from '../../../meta/season';
import { assistsEditor, seasonSettingsEditor } from '../components/editors';
import { h } from '../dom';
import { Screen, type Host } from '../screen';
import { button, heading, tabbedSections } from '../widgets';

export class SeasonSettingsScreen extends Screen {
  readonly title: string;
  private settings: SeasonSettings;
  private assists: Assists;

  constructor(host: Host, title: string, initial: SeasonSettings, assists: Assists, onSave: (s: SeasonSettings, a: Assists) => void) {
    super(host, { layout: 'panel', className: 'nvm-season-settings' });
    this.title = title;
    this.settings = { ...initial, rules: { ...initial.rules } };
    this.assists = { ...assists };
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('賽季設定', title),
        tabbedSections([
          {
            id: 'season',
            label: '賽季與規則',
            el: seasonSettingsEditor(this.settings, (s) => {
              this.settings = s;
              onSave(this.settings, this.assists);
            }),
          },
          {
            id: 'assists',
            label: '駕駛輔助',
            el: assistsEditor(this.assists, (a) => {
              this.assists = a;
              onSave(this.settings, this.assists);
            }),
          },
        ]),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '完成', variant: 'primary', back: true, onClick: () => this.host.pop() })),
      ),
    );
  }
}
