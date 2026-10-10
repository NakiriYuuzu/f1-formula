/**
 * R&D view models (pure, no DOM) shared by the My Team R&D centre, the career R&D screen and both hubs: each part's
 * project button (label, and why it cannot start), parts grouped aero / power / chassis, the hubs' idle-slot reminder
 * and new-season rule-change line, the latest round's report (own team first) and every team's development ranking.
 */
import type { CarPartId } from '../../../core/types';
import {
  CAR_PARTS,
  emptyTeamDevelopment,
  MAX_PROJECTS,
  nextProject,
  PART_GROUP,
  PART_MAX_LEVEL,
  projectCost,
  totalGain,
  totalLevel,
  type DevProject,
  type DevReportLine,
  type PartGroup,
  type SeasonDevelopment,
  type TeamDevelopment,
} from '../../../meta/development';
import { money, PART_EFFECT, PART_GROUP_LABEL, PART_LABEL } from '../labels';

/** My Team pays projects in money (M), the career player's team in R&D points. */
export type RndCurrency = 'money' | 'points';

/** A part's project button: 'start' = can start now; anything else is the reason it is disabled. */
export type PartActionState = 'start' | 'running' | 'maxed' | 'slotsFull' | 'unaffordable';

export interface PartRow {
  part: CarPartId;
  name: string;
  effect: string;
  level: number;
  gain: number;
  /** 'Lv3・效率 2.5' */
  status: string;
  state: PartActionState;
  /** the running project (state 'running') or the next level's project; null when maxed */
  project: DevProject | null;
  /** cost of the next level's project; null when running or maxed */
  cost: number | null;
  /** button label */
  label: string;
  /** why the button is disabled; null when the project can start */
  reason: string | null;
}

export interface PartGroupRows {
  group: PartGroup;
  label: string;
  rows: PartRow[];
}

export interface RankRow {
  teamId: string;
  /** 1-based; teams with the same total level and gain share a rank (1, 1, 3, …) */
  rank: number;
  totalLevel: number;
  totalGain: number;
  /** parts in development */
  projects: CarPartId[];
}

export const PART_GROUP_ORDER: readonly PartGroup[] = ['aero', 'power', 'chassis'];

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** A team's development, or an undeveloped team when the id is missing. */
export function teamDevelopmentOf(dev: SeasonDevelopment, teamId: string): TeamDevelopment {
  return hasOwn(dev.teams, teamId) ? dev.teams[teamId] : emptyTeamDevelopment();
}

/** '2.7 M' or '80 點'. */
export function costLabel(cost: number, currency: RndCurrency): string {
  return currency === 'money' ? money(cost) : `${cost} 點`;
}

function blockReason(state: PartActionState, currency: RndCurrency): string | null {
  switch (state) {
    case 'start':
      return null;
    case 'running':
      return '研發中';
    case 'maxed':
      return '已滿級';
    case 'slotsFull':
      return '研發槽已滿';
    case 'unaffordable':
      return currency === 'money' ? '資金不足' : '點數不足';
  }
}

const percent = (chance: number): string => `${Math.round(chance * 100)}%`;

/**
 * One part's card: level / efficiency and the project button. Disabled reasons by priority: running project, maxed,
 * both slots taken, then not enough money / points (`funds` = budget in M or R&D points, same check as
 * startMyTeamProject / startCareerProject).
 */
export function partRow(team: TeamDevelopment, part: CarPartId, funds: number, currency: RndCurrency): PartRow {
  const { level, gain } = team.parts[part];
  const running = team.projects.find((q) => q.part === part) ?? null;
  const next = running ? null : nextProject(team, part);
  const cost = next ? projectCost(next.level, currency) : null;
  let state: PartActionState;
  if (running) state = 'running';
  else if (!next || cost === null) state = 'maxed';
  else if (team.projects.length >= MAX_PROJECTS) state = 'slotsFull';
  else if (!(funds + 1e-9 >= cost)) state = 'unaffordable';
  else state = 'start';
  let label: string;
  if (running) label = `研發 Lv${running.level} 進行中｜剩 ${running.roundsLeft} 站｜成功率 ${percent(running.chance)}`;
  else if (next && cost !== null) label = `研發 Lv${next.level}｜${costLabel(cost, currency)}｜${next.rounds} 站｜成功率 ${percent(next.chance)}`;
  else label = `已完成全部 ${PART_MAX_LEVEL} 級`;
  return {
    part,
    name: PART_LABEL[part],
    effect: PART_EFFECT[part],
    level,
    gain,
    status: `Lv${level}・效率 ${gain}`,
    state,
    project: running ?? next,
    cost,
    label,
    reason: blockReason(state, currency),
  };
}

/**
 * Hub reminder on the R&D entry: '研發槽閒置 1/2' while a slot is free and some project can start right now (same
 * check as the part buttons); null when both slots run, or nothing can start / is affordable.
 */
export function idleSlotsNote(team: TeamDevelopment, funds: number, currency: RndCurrency): string | null {
  const idle = MAX_PROJECTS - team.projects.length;
  if (idle <= 0 || !CAR_PARTS.some((p) => partRow(team, p, funds, currency).state === 'start')) return null;
  return `研發槽閒置 ${idle}/${MAX_PROJECTS}`;
}

/**
 * Hub line at the start of a new season (season 2 on, before its first race): every part dropped a level at the
 * rollover (rolloverDevelopment). null otherwise.
 */
export function seasonRuleNote(season: number, racedRounds: number): string | null {
  return season > 1 && racedRounds <= 0 ? '新賽季規則調整：所有零件下降一級' : null;
}

/** Every part's card, grouped 空力 / 動力 / 底盤 (design table order inside a group). */
export function partGroups(team: TeamDevelopment, funds: number, currency: RndCurrency): PartGroupRows[] {
  return PART_GROUP_ORDER.map((group) => ({
    group,
    label: PART_GROUP_LABEL[group],
    rows: CAR_PARTS.filter((p) => PART_GROUP[p] === group).map((p) => partRow(team, p, funds, currency)),
  }));
}

/** The latest round's completed projects: the player's team first, then the rivals in report order. */
export function splitReport(report: readonly DevReportLine[], playerTeamId: string): { own: DevReportLine[]; rivals: DevReportLine[] } {
  return { own: report.filter((l) => l.teamId === playerTeamId), rivals: report.filter((l) => l.teamId !== playerTeamId) };
}

export function reportResultLabel(success: boolean): string {
  return success ? '成功' : '部分成功';
}

/** '前翼 Lv2 成功' */
export function reportLineText(line: DevReportLine): string {
  return `${PART_LABEL[line.part]} Lv${line.level} ${reportResultLabel(line.success)}`;
}

/**
 * Hub summary of the latest round's report: own completed projects and the rivals' count. null before the first
 * race of the season (the report is empty until a round has been raced).
 */
export function developmentNote(dev: SeasonDevelopment, playerTeamId: string, racedRounds: number): string | null {
  if (racedRounds <= 0) return null;
  const { own, rivals } = splitReport(dev.report, playerTeamId);
  const partial = rivals.filter((l) => !l.success).length;
  const ownText = own.length > 0 ? `自家 ${own.map(reportLineText).join('、')}` : '自家無完成項目';
  const rivalText = rivals.length > 0 ? `對手完成 ${rivals.length} 項${partial > 0 ? `（${partial} 項部分成功）` : ''}` : '對手無完成項目';
  return `上站研發：${ownText}・${rivalText}`;
}

/**
 * Teams (`teamIds` order, duplicates dropped) by total level, then total gain; equal teams keep `teamIds` order and
 * share a rank (1, 1, 3, …).
 */
export function developmentRanking(dev: SeasonDevelopment, teamIds: readonly string[]): RankRow[] {
  const rows = teamIds
    .filter((id, i) => teamIds.indexOf(id) === i)
    .map((teamId) => {
      const team = teamDevelopmentOf(dev, teamId);
      return { teamId, rank: 1, totalLevel: totalLevel(team), totalGain: totalGain(team), projects: team.projects.map((q) => q.part) };
    })
    .sort((a, b) => b.totalLevel - a.totalLevel || b.totalGain - a.totalGain);
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && prev.totalLevel === r.totalLevel && prev.totalGain === r.totalGain ? prev.rank : i + 1;
  });
  return rows;
}
