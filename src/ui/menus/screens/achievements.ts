/**
 * Achievements gallery: the 12 local achievements with unlock state and date, plus profile statistics.
 */
import { ACHIEVEMENTS } from '../../../meta/achievements';
import { loadAchievements, loadProfile } from '../../../meta/save';
import { h } from '../dom';
import { Screen, type Host } from '../screen';
import { button, heading, infoLine, panel } from '../widgets';

export class AchievementsScreen extends Screen {
  readonly title = '成就';

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-achievements' });
    const unlocked = loadAchievements().unlocked;
    const stats = loadProfile().stats;
    const count = ACHIEVEMENTS.filter((a) => unlocked[a.id] !== undefined).length;
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('成就', `已解鎖 ${count} / ${ACHIEVEMENTS.length}`),
        h(
          'div',
          { class: 'nvm-columns nvm-columns--wide-left' },
          h(
            'div',
            { class: 'nvm-badges' },
            ACHIEVEMENTS.map((a) => {
              const date = unlocked[a.id];
              return h(
                'div',
                { class: `nvm-badge${date ? ' is-unlocked' : ''}` },
                h('span', { class: 'nvm-badge__glyph', text: a.glyph }),
                h('b', { class: 'nvm-badge__title', text: a.title }),
                h('span', { class: 'nvm-badge__desc', text: a.description }),
                h('small', { class: 'nvm-badge__date', text: date ? `解鎖於 ${date.slice(0, 10)}` : '未解鎖' }),
              );
            }),
          ),
          panel(
            '生涯統計',
            infoLine('完成節次', String(stats.sessions)),
            infoLine('完賽正賽', String(stats.racesFinished)),
            infoLine('勝場', String(stats.wins)),
            infoLine('頒獎台', String(stats.podiums)),
            infoLine('桿位', String(stats.poles)),
            infoLine('最快圈', String(stats.fastestLaps)),
          ),
        ),
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
      ),
    );
  }
}
