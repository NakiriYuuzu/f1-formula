/**
 * Season tables shared by Driver Career and My Team: driver / constructor standings and the season calendar.
 */
import { findLayout } from '../../../meta/options';
import { driverName, rosterDrivers, type Roster } from '../../../meta/roster';
import type { SeasonSummary } from '../../../meta/career';
import { driverStandings, isSprintRound, teamStandings, type CalendarRound, type RoundRecord, type SeasonSettings } from '../../../meta/season';
import { h } from '../dom';
import { weatherLabel } from '../labels';
import { minimapCanvas } from '../minimap';
import { panel, teamChip } from '../widgets';

function teamColor(roster: Roster, teamId: string): string {
  return roster.teams.find((t) => t.id === teamId)?.livery.primary ?? '#888888';
}

/** Team a driver raced for in the latest round they appear in ('' if none). */
function lastTeamId(records: readonly RoundRecord[], driverId: string): string {
  for (let i = records.length - 1; i >= 0; i--) {
    const e = records[i]?.classification.find((x) => x.driverId === driverId);
    if (e) return e.teamId;
  }
  return '';
}

export function driverStandingsTable(records: readonly RoundRecord[], roster: Roster, highlight: readonly string[]): HTMLElement {
  const rows = driverStandings(records, roster.drivers.map((d) => d.id));
  return h(
    'table',
    { class: 'nvm-table' },
    h('thead', null, h('tr', null, ['名次', '車手', '車隊', '勝場', '頒獎台', '積分'].map((t) => h('th', { text: t })))),
    h(
      'tbody',
      null,
      rows.map((r, i) => {
        // a driver no longer in the roster (e.g. a replaced My Team teammate): name from the driver list,
        // team from the rounds they raced
        const current = roster.drivers.find((x) => x.id === r.id);
        const d = current ?? rosterDrivers().find((x) => x.id === r.id);
        const teamId = current ? current.teamId : lastTeamId(records, r.id);
        const team = roster.teams.find((t) => t.id === teamId);
        return h(
          'tr',
          { class: highlight.includes(r.id) ? 'is-me' : '' },
          h('td', { class: 'nvm-table__pos', text: String(i + 1) }),
          h('td', null, d ? `${driverName(d)}` : r.id, d ? h('small', { text: ` ${d.abbr}` }) : null),
          h('td', null, teamChip(teamColor(roster, teamId)), team ? team.name : '—'),
          h('td', { text: String(r.wins) }),
          h('td', { text: String(r.podiums) }),
          h('td', { class: 'nvm-table__pts', text: String(r.points) }),
        );
      }),
    ),
  );
}

export function teamStandingsTable(records: readonly RoundRecord[], roster: Roster, highlightTeam: string): HTMLElement {
  const rows = teamStandings(records, roster.teams.map((t) => t.id));
  return h(
    'table',
    { class: 'nvm-table' },
    h('thead', null, h('tr', null, ['名次', '車隊', '動力單元', '勝場', '頒獎台', '積分'].map((t) => h('th', { text: t })))),
    h(
      'tbody',
      null,
      rows.map((r, i) => {
        const team = roster.teams.find((t) => t.id === r.id);
        return h(
          'tr',
          { class: r.id === highlightTeam ? 'is-me' : '' },
          h('td', { class: 'nvm-table__pos', text: String(i + 1) }),
          h('td', null, teamChip(team?.livery.primary ?? '#888888'), team ? team.name : r.id),
          h('td', { text: team?.powerUnit ?? '—' }),
          h('td', { text: String(r.wins) }),
          h('td', { text: String(r.podiums) }),
          h('td', { class: 'nvm-table__pts', text: String(r.points) }),
        );
      }),
    ),
  );
}

/** Calendar list with result of completed rounds for `playerId`. */
export function calendarList(
  calendar: readonly CalendarRound[],
  results: readonly RoundRecord[],
  playerId: string,
  settings?: Pick<SeasonSettings, 'sprintWeekends'>,
): HTMLElement {
  if (calendar.length === 0) return h('p', { class: 'nvm-empty', text: '賽道資料尚未載入，無法建立賽程。' });
  return h(
    'ol',
    { class: 'nvm-calendar' },
    calendar.map((round, i) => {
      const layout = findLayout(round.layoutId);
      const rec = results[i];
      const mine = rec?.classification.find((e) => e.driverId === playerId);
      const status = rec
        ? mine
          ? mine.disqualified === true
            ? '取消資格'
            : mine.status === 'retired'
              ? '退賽'
              : `P${mine.position}・${mine.points} 分`
          : '已完成'
        : i === results.length
          ? '下一站'
          : '';
      return h(
        'li',
        { class: `nvm-calendar__round${rec ? ' is-done' : ''}${i === results.length ? ' is-next' : ''}` },
        h('span', { class: 'nvm-calendar__no', text: String(i + 1).padStart(2, '0') }),
        minimapCanvas(round.layoutId, 64, 44, { lineWidth: 1.6, markers: false }),
        h(
          'span',
          { class: 'nvm-calendar__name' },
          h('b', { text: layout ? layout.displayName : round.layoutId }, settings && isSprintRound(settings, i, calendar) ? h('span', { class: 'nvm-calendar__tag', text: '衝刺' }) : null),
          h('small', { text: `${layout ? layout.location : ''}・預報：${weatherLabel(round.weather)}` }),
        ),
        h('span', { class: 'nvm-calendar__status', text: status }),
      );
    }),
  );
}

/** Season-end summary card. */
export function seasonSummaryCard(summary: SeasonSummary, roster: Roster, teamLabel: string): HTMLElement {
  const champ = roster.drivers.find((d) => d.id === summary.championId);
  return panel(
    `第 ${summary.season} 季總結`,
    h(
      'div',
      { class: 'nvm-summary-card' },
      h('div', null, h('small', { text: '車手積分榜' }), h('b', { text: summary.driverPosition > 0 ? `第 ${summary.driverPosition} 名` : '—' })),
      h('div', null, h('small', { text: '積分' }), h('b', { text: String(summary.points) })),
      h('div', null, h('small', { text: '勝場／頒獎台' }), h('b', { text: `${summary.wins}／${summary.podiums}` })),
      h('div', null, h('small', { text: teamLabel }), h('b', { text: summary.teamPosition > 0 ? `第 ${summary.teamPosition} 名` : '—' })),
    ),
    h('p', { class: 'nvm-note', text: `年度車手冠軍：${champ ? driverName(champ) : summary.championId || '—'}` }),
  );
}
