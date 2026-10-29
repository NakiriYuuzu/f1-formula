/**
 * R&D screen view models (ui/menus/components/rndRows.ts, no DOM) and the part / group labels: part buttons (label,
 * disabled reason and its priority, same affordability as startMyTeamProject / startCareerProject), aero / power /
 * chassis groups, the hubs' idle-slot reminder and new-season rule-change line, the latest round's report split and hub
 * summary, and the development
 * ranking (shared ranks for ties); plus the part cards' keyboard stops (components/rndPanels.ts on a minimal fake DOM).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CarPartId } from '../src/core/types';
import {
  advanceDevelopment,
  CAR_PARTS,
  createSeasonDevelopment,
  emptyTeamDevelopment,
  MAX_PROJECTS,
  PART_COST_MONEY,
  PART_COST_POINTS,
  PART_GROUP,
  PART_MAX_LEVEL,
  startProject,
  type DevReportLine,
  type SeasonDevelopment,
  type TeamDevelopment,
} from '../src/meta/development';
import { createCareer, startCareerProject, type CareerSave } from '../src/meta/career';
import { createMyTeam, myTeamDevelopment, startMyTeamProject, type MyTeamSave } from '../src/meta/myTeam';
import { MY_TEAM_ID, type PlayerIdentity } from '../src/meta/roster';
import { DEFAULT_SEASON_SETTINGS } from '../src/meta/season';
import { MemoryStore, setStore } from '../src/meta/storage';
import { useFictionalRoster } from './rosterFixture';
import { PART_EFFECT, PART_GROUP_LABEL, PART_LABEL } from '../src/ui/menus/labels';
import {
  costLabel,
  developmentNote,
  developmentRanking,
  idleSlotsNote,
  PART_GROUP_ORDER,
  partGroups,
  partRow,
  reportLineText,
  seasonRuleNote,
  splitReport,
  teamDevelopmentOf,
} from '../src/ui/menus/components/rndRows';
import { partSections, RND_RULES_NOTE } from '../src/ui/menus/components/rndPanels';

const LAYOUTS = ['a', 'b', 'c'].flatMap((id) => [
  { id, defId: id, reverse: false },
  { id: `${id}-rev`, defId: id, reverse: true },
]);

const IDENTITY: PlayerIdentity = {
  firstName: 'Test',
  lastName: 'Driver',
  abbr: 'TDR',
  number: 2,
  nationality: 'TWN',
  helmet: { primary: '#ff0000', secondary: '#00ff00', accent: '#0000ff' },
};

function team(parts: Partial<Record<CarPartId, [number, number]>> = {}, projects: CarPartId[] = []): TeamDevelopment {
  let dev: SeasonDevelopment = { teams: { t: emptyTeamDevelopment() }, report: [] };
  for (const [part, [level, gain]] of Object.entries(parts) as [CarPartId, [number, number]][]) dev.teams.t!.parts[part] = { level, gain };
  for (const part of projects) dev = startProject(dev, 't', part)!;
  return dev.teams.t!;
}

beforeEach(() => {
  setStore(new MemoryStore());
  useFictionalRoster();
});

describe('labels', () => {
  test('every part has a label and an effect; groups read 空力／動力／底盤', () => {
    for (const p of CAR_PARTS) {
      expect(PART_LABEL[p].length).toBeGreaterThan(0);
      expect(PART_EFFECT[p]).toStartWith('每級');
    }
    expect(new Set(CAR_PARTS.map((p) => PART_LABEL[p])).size).toBe(CAR_PARTS.length);
    expect(PART_GROUP_LABEL).toEqual({ aero: '空力', power: '動力', chassis: '底盤' });
    expect(PART_EFFECT.weight).toContain('2 kg');
    expect(PART_EFFECT.powerUnit).toContain('1.2%');
    // brakes (§10 D4): the braking limit, not only the brake force
    expect(PART_EFFECT.brakes).toContain('煞車減速度最多 +3%、最大煞車力 +15%');
    // the season rule change is part of the shared rules note
    expect(RND_RULES_NOTE).toContain('所有車隊的零件都會下降一級');
  });
});

describe('part rows', () => {
  test('a startable part: next level, cost, rounds and chance in the button', () => {
    const row = partRow(emptyTeamDevelopment(), 'frontWing', 10, 'money');
    expect(row).toMatchObject({ part: 'frontWing', name: '前翼', level: 0, gain: 0, status: 'Lv0・效率 0', state: 'start', cost: 1, reason: null });
    expect(row.label).toBe('研發 Lv1｜1.0 M｜1 站｜成功率 95%');
    expect(row.project).toEqual({ part: 'frontWing', level: 1, roundsLeft: 1, rounds: 1, chance: 0.95 });
    const later = partRow(team({ floor: [3, 2.5] }), 'floor', 500, 'points');
    expect(later.status).toBe('Lv3・效率 2.5');
    expect(later.cost).toBe(PART_COST_POINTS[3]!);
    expect(later.label).toBe('研發 Lv4｜80 點｜2 站｜成功率 74%');
    expect(costLabel(2.7, 'money')).toBe('2.7 M');
    expect(costLabel(45, 'points')).toBe('45 點');
  });

  test('disabled reasons: 資金不足／點數不足 (exact cost is enough), 研發中, 研發槽已滿, 已滿級', () => {
    const fresh = emptyTeamDevelopment();
    expect(partRow(fresh, 'ers', PART_COST_MONEY[0]!, 'money').state).toBe('start');
    expect(partRow(fresh, 'ers', PART_COST_MONEY[0]! - 0.1, 'money')).toMatchObject({ state: 'unaffordable', reason: '資金不足' });
    expect(partRow(fresh, 'ers', PART_COST_POINTS[0]! - 1, 'points')).toMatchObject({ state: 'unaffordable', reason: '點數不足' });
    expect(partRow(fresh, 'ers', Number.NaN, 'points').state).toBe('unaffordable');
    // an unaffordable button still shows what the project would cost
    expect(partRow(fresh, 'ers', 0, 'points').label).toBe('研發 Lv1｜30 點｜1 站｜成功率 95%');

    const busy = team({ rearWing: [4, 4] }, ['rearWing']);
    const running = partRow(busy, 'rearWing', 100, 'money');
    expect(running).toMatchObject({ state: 'running', reason: '研發中', cost: null });
    expect(running.label).toBe('研發 Lv5 進行中｜剩 3 站｜成功率 65%');
    expect(running.project).toEqual(busy.projects[0]!);

    const full = team({ brakes: [5, 4.5] }, ['floor', 'gearbox']);
    expect(full.projects).toHaveLength(MAX_PROJECTS);
    // slots full wins over the money; maxed and running win over slots full
    expect(partRow(full, 'ers', 100, 'money')).toMatchObject({ state: 'slotsFull', reason: '研發槽已滿' });
    expect(partRow(full, 'ers', 0, 'money')).toMatchObject({ state: 'slotsFull', reason: '研發槽已滿' });
    expect(partRow(full, 'floor', 0, 'money')).toMatchObject({ state: 'running', reason: '研發中' });
    const maxed = partRow(full, 'brakes', 100, 'money');
    expect(maxed).toMatchObject({ state: 'maxed', reason: '已滿級', cost: null, project: null, status: 'Lv5・效率 4.5' });
    expect(maxed.label).toBe(`已完成全部 ${PART_MAX_LEVEL} 級`);
  });

  test('parts grouped 空力／動力／底盤 in design order', () => {
    const groups = partGroups(emptyTeamDevelopment(), 10, 'money');
    expect(groups.map((g) => g.group)).toEqual([...PART_GROUP_ORDER]);
    expect(groups.map((g) => g.label)).toEqual(['空力', '動力', '底盤']);
    expect(groups.map((g) => g.rows.map((r) => r.part))).toEqual([
      ['frontWing', 'rearWing', 'floor'],
      ['powerUnit', 'ers', 'gearbox'],
      ['suspension', 'brakes', 'weight', 'reliability'],
    ]);
    for (const g of groups) for (const r of g.rows) expect(PART_GROUP[r.part]).toBe(g.group);
  });

  test('the button is enabled exactly when startMyTeamProject / startCareerProject succeed', () => {
    const draft = {
      name: 'Nova Works',
      shortName: 'NVW',
      livery: { primary: '#ff5a1f', secondary: '#111111', accent: '#ffffff', pattern: 'stripe' as const },
      powerUnit: 'Helion',
      identity: IDENTITY,
      teammateId: 'ishikawa',
      settings: DEFAULT_SEASON_SETTINGS,
    };
    const base = createMyTeam(draft, 3, LAYOUTS);
    base.development.teams[MY_TEAM_ID]!.parts.floor = { level: 3, gain: 3 };
    base.development.teams[MY_TEAM_ID]!.parts.weight = { level: PART_MAX_LEVEL, gain: PART_MAX_LEVEL };
    const career = createCareer(IDENTITY, 'corvid', DEFAULT_SEASON_SETTINGS, 4, LAYOUTS);
    career.development.teams.corvid!.parts.ers = { level: 2, gain: 1.5 };
    for (const budget of [0, 0.9, 1, 1.5, 2.6, 2.7, 6]) {
      let save: MyTeamSave = { ...base, budget };
      for (let step = 0; step < 3; step++) {
        for (const part of CAR_PARTS) {
          const row = partRow(myTeamDevelopment(save), part, save.budget, 'money');
          expect(startMyTeamProject(save, part) !== null).toBe(row.state === 'start');
        }
        const first = CAR_PARTS.map((p) => startMyTeamProject(save, p)).find((s) => s !== null);
        if (!first) break;
        save = first;
      }
    }
    for (const rdPoints of [0, 29, 30, 59, 60, 200]) {
      let save: CareerSave = { ...career, rdPoints };
      for (let step = 0; step < 3; step++) {
        for (const part of CAR_PARTS) {
          const row = partRow(teamDevelopmentOf(save.development, save.teamId), part, save.rdPoints, 'points');
          expect(startCareerProject(save, part) !== null).toBe(row.state === 'start');
        }
        const first = CAR_PARTS.map((p) => startCareerProject(save, p)).find((s) => s !== null);
        if (!first) break;
        save = first;
      }
    }
  });

  test('hub reminder: idle slots only while a project can start right now', () => {
    expect(idleSlotsNote(emptyTeamDevelopment(), 100, 'points')).toBe(`研發槽閒置 2/${MAX_PROJECTS}`);
    expect(idleSlotsNote(team({}, ['floor']), 1, 'money')).toBe(`研發槽閒置 1/${MAX_PROJECTS}`);
    // nothing affordable, both slots running, or every other part maxed / running: no reminder
    expect(idleSlotsNote(emptyTeamDevelopment(), PART_COST_POINTS[0]! - 1, 'points')).toBeNull();
    expect(idleSlotsNote(team({}, ['floor', 'ers']), 100, 'money')).toBeNull();
    const maxed = Object.fromEntries(CAR_PARTS.map((p) => [p, [PART_MAX_LEVEL, PART_MAX_LEVEL]])) as Record<CarPartId, [number, number]>;
    expect(idleSlotsNote(team(maxed), 100, 'money')).toBeNull();
  });
});

/** Minimal element for the menu DOM builder (h): attributes, children, text. */
class FakeEl {
  className = '';
  textContent = '';
  readonly attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  addEventListener(): void {}
  append(...nodes: (FakeEl | string)[]): void {
    for (const n of nodes) if (typeof n !== 'string') this.children.push(n);
  }
}

describe('part cards and the keyboard', () => {
  const g = globalThis as unknown as { document?: unknown };
  let saved: unknown;
  beforeAll(() => {
    saved = g.document;
    g.document = { createElement: (tag: string) => new FakeEl(tag) };
  });
  afterAll(() => {
    g.document = saved;
  });

  test('every part card is one keyboard stop: its enabled button, else the card itself (disabled buttons are skipped)', () => {
    // new career: 0 points → every button disabled; a running project; slots full
    for (const [dev, funds] of [
      [emptyTeamDevelopment(), 0],
      [team({ weight: [PART_MAX_LEVEL, PART_MAX_LEVEL] }, ['floor']), 100],
      [team({}, ['floor', 'ers']), 100],
    ] as const) {
      const cards = (partSections(partGroups(dev, funds, 'points'), () => undefined) as unknown as FakeEl[]).filter((el) => el.tag === 'div');
      expect(cards).toHaveLength(CAR_PARTS.length);
      for (const card of cards) {
        const part = card.attrs.get('data-part') as CarPartId;
        const btn = card.children.find((c) => c.tag === 'button')!;
        const enabled = !btn.attrs.has('disabled');
        expect(enabled).toBe(partRow(dev, part, funds, 'points').state === 'start');
        expect(card.attrs.get('tabindex')).toBe(enabled ? undefined : '0');
      }
    }
  });
});

describe('report and ranking', () => {
  const report: DevReportLine[] = [
    { teamId: 'vanta', part: 'floor', level: 2, success: true },
    { teamId: 'me', part: 'frontWing', level: 1, success: true },
    { teamId: 'aurora', part: 'ers', level: 3, success: false },
    { teamId: 'me', part: 'powerUnit', level: 4, success: false },
  ];

  test('own lines first; hub note only after a raced round', () => {
    const { own, rivals } = splitReport(report, 'me');
    expect(own.map((l) => l.part)).toEqual(['frontWing', 'powerUnit']);
    expect(rivals.map((l) => l.teamId)).toEqual(['vanta', 'aurora']);
    expect(reportLineText(report[3]!)).toBe('動力單元 Lv4 部分成功');
    const dev: SeasonDevelopment = { ...createSeasonDevelopment(['vanta', 'aurora', 'me']), report };
    expect(developmentNote(dev, 'me', 0)).toBeNull();
    expect(developmentNote(dev, 'me', 3)).toBe('上站研發：自家 前翼 Lv1 成功、動力單元 Lv4 部分成功・對手完成 2 項（1 項部分成功）');
    expect(developmentNote({ ...dev, report: report.filter((l) => l.teamId !== 'me' && l.success) }, 'me', 1)).toBe('上站研發：自家無完成項目・對手完成 1 項');
    expect(developmentNote({ ...dev, report: [] }, 'me', 1)).toBe('上站研發：自家無完成項目・對手無完成項目');
  });

  test('new season: the hubs announce the rule change (every part a level down) until the first race', () => {
    expect(seasonRuleNote(2, 0)).toBe('新賽季規則調整：所有零件下降一級');
    expect(seasonRuleNote(7, 0)).toBe('新賽季規則調整：所有零件下降一級');
    expect(seasonRuleNote(1, 0)).toBeNull(); // the first season starts from scratch
    expect(seasonRuleNote(2, 1)).toBeNull(); // the latest round's report takes over
  });

  test('a real round: the note and the ranking follow advanceDevelopment', () => {
    const ids = ['vanta', 'aurora', 'kestrel', 'me'];
    let dev = createSeasonDevelopment(ids);
    dev = startProject(dev, 'me', 'floor')!;
    for (let round = 0; round < 4; round++) dev = advanceDevelopment(dev, { seed: 11 + round, playerTeamIds: ['me'], standings: ids });
    const note = developmentNote(dev, 'me', 4)!;
    expect(note).toStartWith('上站研發：');
    const ranking = developmentRanking(dev, ids);
    expect(ranking.map((r) => r.teamId).sort()).toEqual([...ids].sort());
    for (let i = 1; i < ranking.length; i++) expect(ranking[i - 1]!.totalLevel).toBeGreaterThanOrEqual(ranking[i]!.totalLevel);
    // AI teams developed (they bank points every round); the player's team only has its one completed project
    expect(ranking.find((r) => r.teamId === 'me')!.totalLevel).toBe(1);
    expect(ranking.filter((r) => r.teamId !== 'me').every((r) => r.totalLevel > 0)).toBe(true);
  });

  test('ranking: total level, then total gain, then the given team order; unknown ids rank as undeveloped', () => {
    const dev = createSeasonDevelopment(['a', 'b', 'c', 'd']);
    dev.teams.a = team({ floor: [2, 2] });
    dev.teams.b = team({ floor: [3, 2] }, ['ers']);
    dev.teams.c = team({ floor: [2, 2] });
    dev.teams.d = team({ floor: [1, 1], ers: [1, 0.5] });
    const rows = developmentRanking(dev, ['a', 'b', 'c', 'd', 'constructor', 'a']);
    expect(rows.map((r) => r.teamId)).toEqual(['b', 'a', 'c', 'd', 'constructor']);
    expect(rows[0]).toEqual({ teamId: 'b', rank: 1, totalLevel: 3, totalGain: 2, projects: ['ers'] });
    expect(rows[3]).toMatchObject({ totalLevel: 2, totalGain: 1.5 });
    expect(rows[4]).toEqual({ teamId: 'constructor', rank: 5, totalLevel: 0, totalGain: 0, projects: [] });
    // a and c tie on level and gain: they share 2nd, d (same level, less gain) is 4th
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 2, 4, 5]);
    // a new season: every team undeveloped shares 1st (the player's team is not shown as last)
    expect(developmentRanking(createSeasonDevelopment(['a', 'b', 'me']), ['a', 'b', 'me']).map((r) => r.rank)).toEqual([1, 1, 1]);
    expect(teamDevelopmentOf(dev, 'constructor')).toEqual(emptyTeamDevelopment());
    expect(teamDevelopmentOf(dev, 'b')).toBe(dev.teams.b!);
  });
});
