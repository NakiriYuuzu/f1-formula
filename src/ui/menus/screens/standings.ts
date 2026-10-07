/**
 * Driver and constructor standings screen (Driver Career / My Team).
 */
import type { Roster } from '../../../meta/roster';
import type { RoundRecord } from '../../../meta/season';
import { driverStandingsTable, teamStandingsTable } from '../components/seasonTables';
import { h } from '../dom';
import { Screen, type Host } from '../screen';
import { button, heading, panel, scrollRegion, tabs } from '../widgets';

export class StandingsScreen extends Screen {
  readonly title: string;
  private readonly body: HTMLElement;

  constructor(
    host: Host,
    title: string,
    private readonly records: readonly RoundRecord[],
    private readonly roster: Roster,
    private readonly highlightDrivers: readonly string[],
    private readonly highlightTeam: string,
  ) {
    super(host, { layout: 'panel', className: 'nvm-standings' });
    this.title = title;
    this.body = h('div', { class: 'nvm-standings__body' });
    const bar = tabs(
      [
        { id: 'drivers', label: '車手積分榜' },
        { id: 'teams', label: '車隊積分榜' },
      ],
      'drivers',
      (id) => this.show(id),
    );
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('積分榜', `${title}・已完成 ${records.length} 站`),
        bar.el,
        this.body,
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
      ),
    );
    this.show('drivers');
  }

  private show(id: string): void {
    const table =
      id === 'teams'
        ? teamStandingsTable(this.records, this.roster, this.highlightTeam)
        : driverStandingsTable(this.records, this.roster, this.highlightDrivers);
    this.body.replaceChildren(panel(null, scrollRegion(table)));
  }
}
