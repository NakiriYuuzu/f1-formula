/**
 * Season calendar screen (Driver Career / My Team): all rounds with forecast and the player's results.
 */
import type { CalendarRound, RoundRecord, SeasonSettings } from '../../../meta/season';
import { calendarList } from '../components/seasonTables';
import { h } from '../dom';
import { Screen, type Host } from '../screen';
import { button, heading, panel, scrollRegion } from '../widgets';

export class CalendarScreen extends Screen {
  readonly title: string;

  constructor(host: Host, title: string, calendar: readonly CalendarRound[], results: readonly RoundRecord[], playerId: string, settings?: Pick<SeasonSettings, 'sprintWeekends'>) {
    super(host, { layout: 'panel', className: 'nvm-calendar-screen' });
    this.title = title;
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('賽季賽程', title),
        panel(null, scrollRegion(calendarList(calendar, results, playerId, settings))),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
      ),
    );
  }
}
