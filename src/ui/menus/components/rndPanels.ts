/**
 * R&D screen pieces shared by the My Team R&D centre and the career R&D screen: part cards grouped 空力／動力／底盤
 * (every card one keyboard stop: its button, or the card itself while the button is disabled), the latest round's
 * development report and every team's development progress (keyboard-scrollable tables).
 */
import type { CarPartId, TeamDef } from '../../../core/types';
import { MAX_PROJECTS, PART_MAX_LEVEL, type DevReportLine, type SeasonDevelopment } from '../../../meta/development';
import { h } from '../dom';
import { focusElement } from '../nav';
import { PART_LABEL } from '../labels';
import { button, panel, scrollRegion, teamChip } from '../widgets';
import { developmentRanking, reportResultLabel, splitReport, type PartGroupRows } from './rndRows';

/** Project rules shown under the funds of both R&D screens. */
export const RND_RULES_NOTE =
  `每個零件分 ${PART_MAX_LEVEL} 級，每級是一個研發專案：需要數站才完成，同時最多進行 ${MAX_PROJECTS} 個；失敗時仍會升級，但只發揮一半效果。對手車隊也會整季研發。每個新賽季因規則調整，所有車隊的零件都會下降一級（效率按比例保留）；進行中的專案改為研發新的下一級，並退還費用差額。`;

function teamOf(teams: readonly TeamDef[], id: string): TeamDef | undefined {
  return teams.find((t) => t.id === id);
}

/**
 * Group titles and one card per part: name, level pips, efficiency, effect and the project button. A card whose
 * button is disabled (skipped by keyboard focus) is focusable itself, so ↑/↓ reach every part.
 */
export function partSections(groups: readonly PartGroupRows[], onStart: (part: CarPartId) => void): HTMLElement[] {
  return groups.flatMap((g) => [
    h('h3', { class: 'nvm-panel__title nvm-rnd__group', text: g.label }),
    ...g.rows.map((row) =>
      h(
        'div',
        { class: 'nvm-rnd__dept', attrs: { 'data-part': row.part, tabindex: row.state === 'start' ? null : 0 } },
        h(
          'div',
          { class: 'nvm-rnd__head' },
          h('b', { text: row.name }),
          h('span', { class: 'nvm-pips' }, Array.from({ length: PART_MAX_LEVEL }, (_, i) => h('i', { class: i < row.level ? 'is-on' : '' }))),
          h('span', { class: 'nvm-rnd__rating', text: row.status }),
        ),
        h('p', { class: 'nvm-note', text: row.effect }),
        button({
          label: row.label,
          badge: row.reason ?? undefined,
          variant: row.state === 'start' ? 'primary' : 'ghost',
          disabled: row.state !== 'start',
          onClick: () => onStart(row.part),
        }),
      ),
    ),
  ]);
}

/** After a project started: focus the next startable part button (from `part` on), else the part's own card. */
export function focusNearPart(root: HTMLElement, part: CarPartId): void {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.nvm-rnd__dept button'));
  const at = buttons.findIndex((b) => b.closest<HTMLElement>('.nvm-rnd__dept')?.dataset.part === part);
  const target =
    buttons.slice(Math.max(0, at)).find((b) => !b.disabled) ?? root.querySelector<HTMLElement>(`.nvm-rnd__dept[data-part="${part}"]`);
  if (target) focusElement(target);
}

/** 上站研發報告: every project completed in the latest round, own team first. */
export function reportPanel(report: readonly DevReportLine[], teams: readonly TeamDef[], playerTeamId: string): HTMLElement {
  const { own, rivals } = splitReport(report, playerTeamId);
  const lines = [...own, ...rivals];
  if (lines.length === 0) return panel('上站研發報告', h('p', { class: 'nvm-empty', text: '上站沒有完成的研發項目（每站正賽後更新）。' }));
  return panel(
    '上站研發報告',
    scrollRegion(
      h(
        'table',
        { class: 'nvm-table nvm-rnd__table' },
        h('thead', null, h('tr', null, ['車隊', '項目', '結果'].map((t) => h('th', { text: t })))),
        h(
          'tbody',
          null,
          lines.map((l) => {
            const team = teamOf(teams, l.teamId);
            return h(
              'tr',
              { class: l.teamId === playerTeamId ? 'is-me' : '' },
              h('td', null, teamChip(team?.livery.primary ?? '#888888'), team ? team.name : l.teamId),
              h('td', { text: `${PART_LABEL[l.part]} Lv${l.level}` }),
              h('td', { text: reportResultLabel(l.success) }),
            );
          }),
        ),
      ),
    ),
  );
}

/** 對手研發進度: every team by total part level (efficiency = total achieved gain), with its running projects. */
export function rivalPanel(dev: SeasonDevelopment, teams: readonly TeamDef[], playerTeamId: string): HTMLElement {
  const rows = developmentRanking(dev, teams.map((t) => t.id));
  return panel(
    '對手研發進度',
    scrollRegion(
      h(
        'table',
        { class: 'nvm-table nvm-rnd__table' },
        h('thead', null, h('tr', null, ['名次', '車隊', '總等級', '效率', '研發中'].map((t) => h('th', { text: t })))),
        h(
          'tbody',
          null,
          rows.map((r) => {
            const team = teamOf(teams, r.teamId);
            return h(
              'tr',
              { class: r.teamId === playerTeamId ? 'is-me' : '' },
              h('td', { class: 'nvm-table__pos', text: String(r.rank) }),
              h('td', null, teamChip(team?.livery.primary ?? '#888888'), team ? team.name : r.teamId),
              h('td', { class: 'nvm-table__pts', text: String(r.totalLevel) }),
              h('td', { text: String(r.totalGain) }),
              h('td', { text: r.projects.length > 0 ? r.projects.map((p) => PART_LABEL[p]).join('、') : '—' }),
            );
          }),
        ),
      ),
    ),
  );
}
