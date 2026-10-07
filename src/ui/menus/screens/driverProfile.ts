/**
 * Career driver profile: rating attributes, teammate head-to-head and season history.
 */
import {
  careerRoster,
  careerTeammateId,
  ratingOverall,
  RATING_KEYS,
  type CareerSave,
  type DriverRating,
} from '../../../meta/career';
import { driverName, PLAYER_DRIVER_ID } from '../../../meta/roster';
import { driverStandings } from '../../../meta/season';
import { h } from '../dom';
import { nationalityLabel } from '../labels';
import { Screen, type Host } from '../screen';
import { button, heading, panel, scrollRegion, statBar } from '../widgets';

const RATING_LABEL: Record<keyof DriverRating, string> = {
  pace: '速度',
  racecraft: '纏鬥技巧',
  awareness: '判斷力',
  wet: '雨戰',
  consistency: '穩定性',
};

export class DriverProfileScreen extends Screen {
  readonly title = '車手資料';

  constructor(host: Host, save: CareerSave) {
    super(host, { layout: 'panel', className: 'nvm-profile' });
    const { roster } = careerRoster(save);
    const mateId = careerTeammateId(save);
    const mate = roster.drivers.find((d) => d.id === mateId);
    const standings = driverStandings(save.results, roster.drivers.map((d) => d.id));
    const mine = standings.find((s) => s.id === PLAYER_DRIVER_ID);
    const theirs = standings.find((s) => s.id === mateId);
    const t = save.teammate;
    const versus = (label: string, a: number, b: number): HTMLElement =>
      h(
        'div',
        { class: 'nvm-versus' },
        h('b', { class: a > b ? 'is-ahead' : '', text: String(a) }),
        h('span', { text: label }),
        h('b', { class: b > a ? 'is-ahead' : '', text: String(b) }),
      );
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading(driverName(save.driver), `${save.driver.abbr}・#${save.driver.number}・${nationalityLabel(save.driver.nationality)}`),
        h(
          'div',
          { class: 'nvm-columns' },
          panel(
            `車手評價 ${ratingOverall(save.rating)}`,
            RATING_KEYS.map((k) => statBar(RATING_LABEL[k], (save.rating[k] - 40) / 59, save.rating[k].toFixed(1))),
            h('p', { class: 'nvm-note', text: '評價會依完賽名次、超車、乾淨駕駛與雨戰表現成長。' }),
          ),
          h(
            'div',
            { class: 'nvm-stack' },
            panel(
              `隊友對比：你 vs ${mate ? driverName(mate) : '隊友'}`,
              versus('排位領先', t.qualiAhead, t.qualiBehind),
              versus('正賽領先', t.raceAhead, t.raceBehind),
              versus('本季積分', mine ? mine.points : 0, theirs ? theirs.points : 0),
            ),
            panel(
              '生涯紀錄',
              save.history.length === 0
                ? h('p', { class: 'nvm-empty', text: '尚未完成任何賽季。' })
                : scrollRegion(
                    h(
                      'ol',
                      { class: 'nvm-history' },
                      save.history.map((s) => h('li', null, h('b', { text: `第 ${s.season} 季` }), ` 車手榜第 ${s.driverPosition} 名・${s.points} 分・${s.wins} 勝`)),
                    ),
                  ),
            ),
          ),
        ),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
      ),
    );
  }
}
