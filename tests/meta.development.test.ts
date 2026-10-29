/**
 * Part-level R&D (meta/development.ts): constant tables, project rules, seeded round advancement (success / partial
 * success, AI budgets and value-weighted part choice), season rollover (every part a level down, projects re-targeted),
 * save validation, old My Team department migration, career R&D points, and the SessionConfig.development path into
 * the world's car specs and simulated qualifying (also through the career / My Team round requests).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { CarPartGains, CarPartId } from '../src/core/types';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP } from '../src/core/defaults';
import { TEAMS } from '../src/data/teams';
import { getLayout, LAYOUTS } from '../src/data/tracks/index';
import { aiCarTeam } from '../src/ai/index';
import { createCarSpec } from '../src/physics/index';
import { createWorld, simulateLapTimes } from '../src/race/index';
import {
  advanceDevelopment,
  aiDevelopmentBudget,
  CAR_PARTS,
  canStartProject,
  careerRoundPoints,
  createSeasonDevelopment,
  developmentFromRd,
  developmentGains,
  developmentStrength,
  emptyTeamDevelopment,
  GAIN_STRENGTH,
  isAnyPartMaxed,
  MAX_PROJECTS,
  nextProject,
  PART_COST_MONEY,
  PART_AI_WEIGHT,
  PART_COST_POINTS,
  PART_GROUP,
  PART_MAX_LEVEL,
  PARTIAL_GAIN,
  PROJECT_CHANCE,
  PROJECT_ROUNDS,
  projectCost,
  rolloverDevelopment,
  rolloverRefund,
  sanitizeDevelopment,
  SEASON_LEVEL_LOSS,
  startProject,
  teamGains,
  teamsByStrength,
  totalGain,
  totalLevel,
  type SeasonDevelopment,
  type TeamDevelopment,
} from '../src/meta/development';
import { careerRequest, careerRoster, careerTeammateId, createCareer, expectedPosition, type CareerSave } from '../src/meta/career';
import {
  createMyTeam,
  myTeamDef,
  myTeamDevelopment,
  myTeamRequest,
  myTeamRoster,
  sanitizeMyTeam,
  sponsorTarget,
  type MyTeamSave,
} from '../src/meta/myTeam';
import { layoutOrDefault } from '../src/meta/options';
import { MY_TEAM_ID, PLAYER_DRIVER_ID, standardRoster, teamStrength, type PlayerIdentity } from '../src/meta/roster';
import { DEFAULT_SEASON_SETTINGS, roundRequest } from '../src/meta/season';
import { buildSessionConfig, requestFromConfig, type SessionRequest } from '../src/meta/sessionBuilder';
import { useFictionalRoster } from './rosterFixture';

const IDS = TEAMS.map((t) => t.id);
const PLAYER = 'nordlys';

function withTeam(dev: SeasonDevelopment, id: string, team: TeamDevelopment): SeasonDevelopment {
  return { ...dev, teams: { ...dev.teams, [id]: team } };
}

function advance(dev: SeasonDevelopment, seed: number, standings: readonly string[] = IDS): SeasonDevelopment {
  return advanceDevelopment(dev, { seed, playerTeamIds: [PLAYER], standings });
}

// written against the fictional teams (data/teams.ts)
beforeEach(useFictionalRoster);

describe('tables', () => {
  test('parts, groups, projects and costs', () => {
    expect(CAR_PARTS).toEqual(['frontWing', 'rearWing', 'floor', 'suspension', 'powerUnit', 'ers', 'gearbox', 'brakes', 'weight', 'reliability']);
    expect(PART_MAX_LEVEL).toBe(5);
    expect(MAX_PROJECTS).toBe(2);
    expect(PARTIAL_GAIN).toBe(0.5);
    const group = (g: string): CarPartId[] => CAR_PARTS.filter((p) => PART_GROUP[p] === g);
    expect(group('aero')).toEqual(['frontWing', 'rearWing', 'floor']);
    expect(group('power')).toEqual(['powerUnit', 'ers', 'gearbox']);
    expect(group('chassis')).toEqual(['suspension', 'brakes', 'weight', 'reliability']);
    expect(PROJECT_ROUNDS).toEqual([1, 1, 2, 2, 3]);
    expect(PROJECT_CHANCE).toEqual([0.95, 0.9, 0.82, 0.74, 0.65]);
    expect(PART_COST_MONEY).toEqual([1.0, 1.5, 2.0, 2.7, 3.4]);
    expect(PART_COST_POINTS).toEqual([30, 45, 60, 80, 100]);
    for (let level = 1; level <= PART_MAX_LEVEL; level++) {
      expect(projectCost(level, 'money')).toBe(PART_COST_MONEY[level - 1]!);
      expect(projectCost(level, 'points')).toBe(PART_COST_POINTS[level - 1]!);
    }
    expect(projectCost(0, 'points')).toBe(30);
    expect(projectCost(9, 'money')).toBe(3.4);
    expect(projectCost(Number.NaN, 'points')).toBe(30);
    // §10 D2 / D5
    expect(SEASON_LEVEL_LOSS).toBe(1);
    expect(PART_AI_WEIGHT).toEqual({
      frontWing: 1.6,
      rearWing: 0.8,
      floor: 1.3,
      suspension: 1.5,
      powerUnit: 1.3,
      ers: 1.1,
      gearbox: 0.8,
      brakes: 0.5,
      weight: 0.7,
      reliability: 0.4,
    });
  });

  test('empty development, gains and totals', () => {
    const dev = createSeasonDevelopment(['a', 'b', 'a']);
    expect(Object.keys(dev.teams)).toEqual(['a', 'b']);
    expect(dev.report).toEqual([]);
    expect(totalLevel(dev.teams.a!)).toBe(0);
    expect(teamGains(dev.teams.a)).toEqual({});
    expect(teamGains(undefined)).toEqual({});
    expect(developmentGains(undefined)).toEqual({});
    const team = emptyTeamDevelopment();
    team.parts.floor = { level: 3, gain: 2.5 };
    team.parts.ers = { level: 1, gain: 0.5 };
    expect(teamGains(team)).toEqual({ floor: 2.5, ers: 0.5 });
    expect(developmentGains(withTeam(dev, 'b', team))).toEqual({ a: {}, b: { floor: 2.5, ers: 0.5 } });
    expect(totalLevel(team)).toBe(4);
    expect(totalGain(team)).toBe(3);
    expect(isAnyPartMaxed(team)).toBe(false);
    team.parts.weight = { level: 5, gain: 4 };
    expect(isAnyPartMaxed(team)).toBe(true);
  });

  test('developmentStrength counts every gain like GAIN_STRENGTH of rating; no development = plain rating order', () => {
    expect(developmentStrength(undefined)).toBe(0);
    expect(developmentStrength({})).toBe(0);
    expect(developmentStrength({ floor: 2.5, ers: 0.5 })).toBeCloseTo(3 * GAIN_STRENGTH, 12);
    // like createCarSpec: non-finite gains count 0, the rest is clamped to 0..5
    expect(developmentStrength({ floor: Number.NaN, ers: -2, frontWing: 9 } as CarPartGains)).toBeCloseTo(5 * GAIN_STRENGTH, 12);
    const byRating = [...TEAMS].sort((a, b) => teamStrength(b) - teamStrength(a)).map((t) => t.id);
    expect(teamsByStrength(TEAMS, undefined).map((t) => t.id)).toEqual(byRating);
    const dev = createSeasonDevelopment(IDS);
    expect(teamsByStrength(TEAMS, dev).map((t) => t.id)).toEqual(byRating);
    const full = developmentFromRd({ aero: 5, power: 5, chassis: 5, reliability: 5 });
    // every team developed alike keeps the order; the slowest team fully developed alone leads it
    expect(teamsByStrength(TEAMS, { ...dev, teams: Object.fromEntries(IDS.map((id) => [id, full])) }).map((t) => t.id)).toEqual(byRating);
    const last = byRating[byRating.length - 1]!;
    expect(teamsByStrength(TEAMS, withTeam(dev, last, full))[0]!.id).toBe(last);
  });
});

describe('projects', () => {
  test('next level preview, max level, one project per part, MAX_PROJECTS slots', () => {
    const dev = createSeasonDevelopment(IDS);
    const frozen = JSON.stringify(dev);
    expect(nextProject(dev.teams[PLAYER]!, 'floor')).toEqual({ part: 'floor', level: 1, roundsLeft: 1, rounds: 1, chance: 0.95 });
    const one = startProject(dev, PLAYER, 'floor')!;
    expect(JSON.stringify(dev)).toBe(frozen); // input untouched
    expect(one.teams[PLAYER]!.projects).toEqual([{ part: 'floor', level: 1, roundsLeft: 1, rounds: 1, chance: 0.95 }]);
    expect(nextProject(one.teams[PLAYER]!, 'floor')).toBeNull();
    expect(startProject(one, PLAYER, 'floor')).toBeNull();
    const two = startProject(one, PLAYER, 'powerUnit')!;
    expect(two.teams[PLAYER]!.projects.map((q) => q.part)).toEqual(['floor', 'powerUnit']);
    expect(canStartProject(two.teams[PLAYER]!, 'ers')).toBe(false);
    expect(startProject(two, PLAYER, 'ers')).toBeNull();
    expect(startProject(dev, 'nobody', 'ers')).toBeNull();
    // target level = current + 1 with its rounds / chance; maxed parts cannot start
    const team = emptyTeamDevelopment();
    team.parts.rearWing = { level: 4, gain: 3.5 };
    team.parts.brakes = { level: 5, gain: 5 };
    expect(nextProject(team, 'rearWing')).toEqual({ part: 'rearWing', level: 5, roundsLeft: 3, rounds: 3, chance: 0.65 });
    expect(nextProject(team, 'brakes')).toBeNull();
    expect(canStartProject(team, 'brakes')).toBe(false);
    expect(startProject(withTeam(dev, PLAYER, team), PLAYER, 'brakes')).toBeNull();
  });
});

describe('advanceDevelopment', () => {
  test('projects count down, then raise the level and join the report', () => {
    const team = emptyTeamDevelopment();
    team.parts.floor = { level: 2, gain: 2 };
    let dev = startProject(withTeam(createSeasonDevelopment(IDS), PLAYER, team), PLAYER, 'floor')!;
    expect(dev.teams[PLAYER]!.projects[0]).toMatchObject({ level: 3, roundsLeft: 2, rounds: 2 });
    dev = advance(dev, 7);
    expect(dev.teams[PLAYER]!.projects).toEqual([{ part: 'floor', level: 3, roundsLeft: 1, rounds: 2, chance: 0.82 }]);
    expect(dev.teams[PLAYER]!.parts.floor).toEqual({ level: 2, gain: 2 });
    expect(dev.report.filter((l) => l.teamId === PLAYER)).toEqual([]);
    dev = advance(dev, 8);
    expect(dev.teams[PLAYER]!.projects).toEqual([]);
    expect(dev.teams[PLAYER]!.parts.floor.level).toBe(3);
    const line = dev.report.find((l) => l.teamId === PLAYER)!;
    expect(line).toMatchObject({ part: 'floor', level: 3 });
    expect(dev.teams[PLAYER]!.parts.floor.gain).toBe(line.success ? 3 : 2.5);
    // player teams never receive an AI budget
    expect(dev.teams[PLAYER]!.bank).toBe(0);
  });

  test('a finished project succeeds (+1) or partly succeeds (+0.5) by the seeded roll', () => {
    const team = emptyTeamDevelopment();
    team.parts.powerUnit = { level: 4, gain: 4 };
    team.projects = [{ part: 'powerUnit', level: 5, roundsLeft: 1, rounds: 3, chance: PROJECT_CHANCE[4]! }];
    const dev = withTeam(createSeasonDevelopment(IDS), PLAYER, team);
    const outcomes = new Map<boolean, number>();
    let successes = 0;
    const SEEDS = 400;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const next = advance(dev, seed);
      const line = next.report.find((l) => l.teamId === PLAYER)!;
      expect(line).toEqual({ teamId: PLAYER, part: 'powerUnit', level: 5, success: line.success });
      expect(next.teams[PLAYER]!.parts.powerUnit).toEqual({ level: 5, gain: line.success ? 5 : 4.5 });
      if (!outcomes.has(line.success)) outcomes.set(line.success, seed);
      if (line.success) successes++;
    }
    expect([...outcomes.keys()].sort()).toEqual([false, true]);
    // the success rate follows PROJECT_CHANCE (0.65 for level 5)
    expect(successes / SEEDS).toBeGreaterThan(0.58);
    expect(successes / SEEDS).toBeLessThan(0.72);
    // fixed seeds give fixed outcomes
    const failSeed = outcomes.get(false)!;
    expect(advance(dev, failSeed).teams[PLAYER]!.parts.powerUnit.gain).toBe(4.5);
    expect(advance(dev, outcomes.get(true)!).teams[PLAYER]!.parts.powerUnit.gain).toBe(5);
    expect(advance(dev, failSeed)).toEqual(advance(dev, failSeed));
  });

  test('deterministic: same seed and inputs → same season; another seed → another season', () => {
    const run = (seed: number): SeasonDevelopment[] => {
      let dev = createSeasonDevelopment(IDS);
      const out: SeasonDevelopment[] = [];
      for (let round = 0; round < 12; round++) {
        dev = advance(dev, seed * 1000 + round);
        out.push(dev);
      }
      return out;
    };
    const a = run(3);
    expect(run(3)).toEqual(a);
    expect(JSON.stringify(run(4))).not.toBe(JSON.stringify(a));
    const input = createSeasonDevelopment(IDS);
    const frozen = JSON.stringify(input);
    advance(input, 1);
    expect(JSON.stringify(input)).toBe(frozen);
  });

  test('AI teams bank a standing-based budget and start projects that finish at a later round', () => {
    expect(aiDevelopmentBudget(0, 10)).toBeCloseTo(42 * 0.85, 9);
    expect(aiDevelopmentBudget(9, 10)).toBeCloseTo(42 * 1.15, 9);
    expect(aiDevelopmentBudget(4.5, 10)).toBeCloseTo(42, 9);
    expect(aiDevelopmentBudget(99, 10)).toBeCloseTo(42 * 1.15, 9);
    expect(aiDevelopmentBudget(0, 1)).toBeCloseTo(42 * 0.85, 9);

    const standings = IDS.filter((id) => id !== 'corvid'); // corvid missing → ranks last
    const leader = standings[0]!;
    const dev = advance(createSeasonDevelopment(IDS), 11, standings);
    expect(dev.report).toEqual([]); // nothing was running yet: new projects never finish in the round they start
    expect(dev.teams[PLAYER]!.projects).toEqual([]);
    expect(dev.teams[PLAYER]!.bank).toBe(0);
    for (const id of IDS.filter((x) => x !== PLAYER)) {
      const team = dev.teams[id]!;
      expect(team.projects).toHaveLength(1); // 36..48 points buy one level-1 project (30)
      expect(team.projects[0]).toMatchObject({ level: 1, roundsLeft: 1 });
    }
    expect(dev.teams[leader]!.bank).toBeCloseTo(aiDevelopmentBudget(0, IDS.length) - 30, 9);
    expect(dev.teams.corvid!.bank).toBeCloseTo(aiDevelopmentBudget(IDS.length - 1, IDS.length) - 30, 9);

    const next = advance(dev, 12, standings);
    const aiLines = next.report.filter((l) => l.teamId !== PLAYER);
    expect(aiLines).toHaveLength(IDS.length - 1);
    for (const line of aiLines) expect(line.level).toBe(1);
  });

  test('AI picks parts by value: the best weight / (1 + 0.35 · level) (±10 % noise) among the startable parts', () => {
    // first pick of every AI team over many seeds (all parts at 0, the first budget buys one level-1 project):
    // front wing (1.6) or suspension (1.5) — floor / power unit (1.3 × 1.1 < 1.6 × 0.9) never win at level 0
    const picks = new Map<CarPartId, number>(CAR_PARTS.map((p) => [p, 0]));
    for (let seed = 1; seed <= 150; seed++) {
      const first = advance(createSeasonDevelopment(IDS), seed);
      for (const id of IDS) for (const q of first.teams[id]!.projects) picks.set(q.part, picks.get(q.part)! + 1);
    }
    expect(picks.get('frontWing')! + picks.get('suspension')!).toBe(150 * (IDS.length - 1));
    expect(picks.get('frontWing')!).toBeGreaterThan(picks.get('suspension')!);
    expect(picks.get('suspension')!).toBeGreaterThan(0);
    // a developed part scores lower: with front wing / suspension at level 2 (1.6 / 1.7 ≈ 0.94) the 1.3 parts lead
    const team = emptyTeamDevelopment();
    team.parts.frontWing = { level: 2, gain: 2 };
    team.parts.suspension = { level: 2, gain: 2 };
    team.bank = 100;
    const next = advance(withTeam(createSeasonDevelopment(IDS), 'vanta', team), 9);
    expect(next.teams.vanta!.projects.map((q) => q.part).sort()).toEqual(['floor', 'powerUnit']);
    // over two seasons the high-value parts stay ahead of the low-value ones, and every team keeps developing
    let dev = createSeasonDevelopment(IDS);
    for (let round = 0; round < 24; round++) {
      dev = advance(dev, 500 + round);
      if (round === 11) dev = rolloverDevelopment(dev);
      for (const id of IDS) expect(dev.teams[id]!.projects.length).toBeLessThanOrEqual(MAX_PROJECTS);
    }
    const ai = IDS.filter((x) => x !== PLAYER);
    const avgLevel = (p: CarPartId): number => ai.reduce((acc, id) => acc + dev.teams[id]!.parts[p].level, 0) / ai.length;
    expect(avgLevel('frontWing')).toBeGreaterThan(avgLevel('rearWing'));
    expect(avgLevel('suspension')).toBeGreaterThan(avgLevel('brakes'));
    expect(avgLevel('floor')).toBeGreaterThan(avgLevel('reliability'));
    for (const id of ai) {
      expect(totalLevel(dev.teams[id]!)).toBeGreaterThanOrEqual(8);
      expect(totalLevel(dev.teams[id]!)).toBeLessThan(35);
    }
  });

  test('AI saves its bank while the best part is unaffordable (no cheaper fallback), then buys it', () => {
    // every part at level 4 except reliability (0): any level-5 project (100 points) beats reliability's 30-point one
    const team = emptyTeamDevelopment();
    for (const p of CAR_PARTS) if (p !== 'reliability') team.parts[p] = { level: 4, gain: 4 };
    team.bank = 10;
    const budget = aiDevelopmentBudget(IDS.indexOf('vanta'), IDS.length);
    const saved = advance(withTeam(createSeasonDevelopment(IDS), 'vanta', team), 21);
    expect(saved.teams.vanta!.projects).toEqual([]);
    expect(saved.teams.vanta!.bank).toBeCloseTo(10 + budget, 9);
    expect(saved.teams.vanta!.parts.reliability).toEqual({ level: 0, gain: 0 });
    // enough saved: the best part starts (front wing 1.6 / 2.4 or suspension 1.5 / 2.4) and the bank pays its 100 points
    const rich = advance(withTeam(createSeasonDevelopment(IDS), 'vanta', { ...team, bank: 100 }), 21);
    expect(rich.teams.vanta!.projects).toHaveLength(1);
    expect(['frontWing', 'suspension']).toContain(rich.teams.vanta!.projects[0]!.part);
    expect(rich.teams.vanta!.projects[0]!.level).toBe(5);
    expect(rich.teams.vanta!.bank).toBeCloseTo(100 + budget - 100, 9);
  });
});

describe('season rollover, validation and migration', () => {
  test('rollover: every part drops a level keeping its efficiency, running projects re-target and refund the difference, report clears', () => {
    const team = emptyTeamDevelopment();
    team.parts.frontWing = { level: 5, gain: 4.5 };
    team.parts.floor = { level: 3, gain: 2 };
    team.parts.ers = { level: 1, gain: 0.5 };
    team.parts.weight = { level: 2, gain: 2 };
    team.parts.rearWing = { level: 4, gain: 4 };
    team.parts.gearbox = { level: 1, gain: 1 };
    team.parts.suspension = { level: 4, gain: 3 };
    team.parts.powerUnit = { level: 2, gain: 1.5 };
    team.projects = [
      { part: 'rearWing', level: 5, roundsLeft: 3, rounds: 3, chance: PROJECT_CHANCE[4]! },
      { part: 'floor', level: 4, roundsLeft: 1, rounds: 2, chance: PROJECT_CHANCE[3]! },
    ];
    team.bank = 37.5;
    const dev: SeasonDevelopment = { ...withTeam(createSeasonDevelopment(IDS), 'vanta', team), report: [{ teamId: 'vanta', part: 'floor', level: 2, success: true }] };
    const frozen = JSON.stringify(dev);
    const next = rolloverDevelopment(dev);
    expect(JSON.stringify(dev)).toBe(frozen);
    expect(next.report).toEqual([]);
    const v = next.teams.vanta!;
    // level − 1, gain × new level ÷ old level to the nearest 0.5: a partly successful level's shortfall shrinks
    expect(v.parts.frontWing).toEqual({ level: 4, gain: 3.5 }); // 4.5 × 4/5 = 3.6
    expect(v.parts.floor).toEqual({ level: 2, gain: 1.5 }); // 2 × 2/3 ≈ 1.33
    expect(v.parts.suspension).toEqual({ level: 3, gain: 2.5 }); // 3 × 3/4 = 2.25
    expect(v.parts.powerUnit).toEqual({ level: 1, gain: 1 }); // 1.5 × 1/2 = 0.75
    expect(v.parts.ers).toEqual({ level: 0, gain: 0 });
    expect(v.parts.weight).toEqual({ level: 1, gain: 1 }); // full efficiency stays full
    expect(v.parts.rearWing).toEqual({ level: 3, gain: 3 });
    expect(v.parts.gearbox).toEqual({ level: 0, gain: 0 });
    expect(v.parts.brakes).toEqual({ level: 0, gain: 0 }); // undeveloped stays 0
    // projects aim at the new next level: its rounds / chance, roundsLeft capped by the new level's rounds
    expect(v.projects).toEqual([
      { part: 'rearWing', level: 4, roundsLeft: 2, rounds: 2, chance: PROJECT_CHANCE[3]! },
      { part: 'floor', level: 3, roundsLeft: 1, rounds: 2, chance: PROJECT_CHANCE[2]! },
    ]);
    // the re-targeted projects cost less: Lv5 → Lv4 and Lv4 → Lv3 refund the difference into an AI bank
    const refund = PART_COST_POINTS[4]! - PART_COST_POINTS[3]! + (PART_COST_POINTS[3]! - PART_COST_POINTS[2]!);
    expect(rolloverRefund(team, 'points')).toBe(refund);
    expect(rolloverRefund(team, 'money')).toBe(1.4);
    expect(v.bank).toBe(37.5 + refund);
    // a player team's bank stays (the caller refunds its points / money); everything else is the same
    const asPlayer = rolloverDevelopment(dev, ['vanta']);
    expect(asPlayer.teams.vanta).toEqual({ ...v, bank: 37.5 });
    // a project on an undeveloped part keeps its level and costs nothing back
    const fresh = emptyTeamDevelopment();
    fresh.projects = [{ part: 'ers', level: 1, roundsLeft: 1, rounds: 1, chance: PROJECT_CHANCE[0]! }];
    expect(rolloverRefund(fresh, 'points')).toBe(0);
    expect(rolloverDevelopment(withTeam(createSeasonDevelopment(IDS), 'vanta', fresh)).teams.vanta).toEqual(fresh);
    // the same for every team; an undeveloped team is unchanged
    expect(next.teams.corvid).toEqual(dev.teams.corvid);
    expect(next.teams.corvid).not.toBe(dev.teams.corvid);
    // a valid development (save round trip unchanged) whose re-targeted project completes into the new level
    expect(sanitizeDevelopment(JSON.parse(JSON.stringify(next)), IDS)).toEqual(next);
    const after = advance(next, 31);
    expect(after.teams.vanta!.parts.floor.level).toBe(3);
    expect(after.report.find((l) => l.teamId === 'vanta' && l.part === 'floor')?.level).toBe(3);
  });

  test('over many seasons the AI field settles in the middle (rich teams higher), nobody maxes out, the effect holds', () => {
    let dev = createSeasonDevelopment(IDS);
    const standings = [...IDS]; // fixed constructor order: IDS[0] gets the smallest budget, the last team the largest
    const ends: number[] = [];
    const gains: number[] = [];
    const rich = IDS[IDS.length - 1]!;
    const poor = IDS[0]!;
    let richLead = 0;
    let richGainLead = 0;
    for (let season = 0; season < 12; season++) {
      for (let round = 0; round < 12; round++) dev = advanceDevelopment(dev, { seed: 7000 + season * 20 + round, playerTeamIds: [], standings });
      ends.push(IDS.reduce((acc, id) => acc + totalLevel(dev.teams[id]!), 0) / IDS.length);
      gains.push(IDS.reduce((acc, id) => acc + totalGain(dev.teams[id]!), 0) / IDS.length);
      for (const id of IDS) expect(totalLevel(dev.teams[id]!)).toBeLessThan(40);
      if (season >= 2) {
        richLead += totalLevel(dev.teams[rich]!) - totalLevel(dev.teams[poor]!);
        richGainLead += totalGain(dev.teams[rich]!) - totalGain(dev.teams[poor]!);
      }
      dev = rolloverDevelopment(dev);
    }
    // season-end average total level (of 50) stays in 15..30 from the third season on, and grows ever more slowly
    for (const avg of ends.slice(2)) {
      expect(avg).toBeGreaterThanOrEqual(15);
      expect(avg).toBeLessThanOrEqual(30);
    }
    expect(ends[7]! - ends[5]!).toBeLessThan(ends[2]! - ends[0]!);
    // the achieved effect keeps up with the levels (measured ≥ 0.86; a shortfall that survives every rollover sank it
    // to 0.66 by season 12 and the season-end gain from 17.0 at season 6 to 14.7)
    ends.forEach((avg, i) => expect(gains[i]! / avg).toBeGreaterThanOrEqual(0.8));
    expect(gains[11]!).toBeGreaterThanOrEqual(gains[5]!);
    // the largest budget (last place, ×1.15) out-develops the smallest (the leader, ×0.85): ≥ 3 levels and ≥ 3 gain
    // a season (measured 6.6 / 4.5)
    expect(richLead / 10).toBeGreaterThanOrEqual(3);
    expect(richGainLead / 10).toBeGreaterThanOrEqual(3);
  });

  test('sanitizeDevelopment repairs broken data and follows the roster', () => {
    for (const junk of [undefined, null, 42, 'x', [], { teams: [] }, { teams: { a: 'bad' } }]) {
      expect(sanitizeDevelopment(junk, ['a', 'b'])).toEqual(createSeasonDevelopment(['a', 'b']));
    }
    const raw = {
      teams: {
        a: {
          parts: {
            frontWing: { level: 3.4, gain: 2.3 }, // level 3, gain rounded to 2.5
            rearWing: { level: 9, gain: 9 }, // 5 / 5
            floor: { level: 2, gain: 4 }, // gain ≤ level
            suspension: { level: -1, gain: Number.NaN }, // 0 / 0
            powerUnit: { level: 1, gain: 1 },
            ers: 'junk',
          },
          projects: [
            { part: 'frontWing', level: 4, roundsLeft: 9, rounds: 1, chance: 1 }, // roundsLeft clamped, table values
            { part: 'frontWing', level: 4, roundsLeft: 1 }, // duplicate part
            { part: 'rearWing', level: 6, roundsLeft: 1 }, // maxed part
            { part: 'floor', level: 2, roundsLeft: 1 }, // wrong target level
            { part: 'turbo', level: 1, roundsLeft: 1 }, // unknown part
            { part: 'weight', level: 1, roundsLeft: 0 }, // already finished
            { part: 'powerUnit', level: 2, roundsLeft: 1 },
            { part: 'gearbox', level: 1, roundsLeft: 1 }, // over MAX_PROJECTS
          ],
          bank: -5,
        },
        gone: { parts: {}, projects: [], bank: 10 }, // not in the roster any more
      },
      report: [
        { teamId: 'a', part: 'floor', level: 2, success: true },
        { teamId: 'gone', part: 'floor', level: 1, success: true },
        { teamId: 'a', part: 'floor', level: 7, success: true },
        { teamId: 'a', part: 'nope', level: 1, success: false },
        { teamId: 'a', part: 'ers', level: 1, success: 'yes' },
      ],
    };
    const dev = sanitizeDevelopment(raw, ['a', 'b']);
    expect(Object.keys(dev.teams)).toEqual(['a', 'b']);
    const a = dev.teams.a!;
    expect(a.parts.frontWing).toEqual({ level: 3, gain: 2.5 });
    expect(a.parts.rearWing).toEqual({ level: 5, gain: 5 });
    expect(a.parts.floor).toEqual({ level: 2, gain: 2 });
    expect(a.parts.suspension).toEqual({ level: 0, gain: 0 });
    expect(a.parts.ers).toEqual({ level: 0, gain: 0 });
    expect(a.projects).toEqual([
      { part: 'frontWing', level: 4, roundsLeft: 2, rounds: 2, chance: 0.74 },
      { part: 'powerUnit', level: 2, roundsLeft: 1, rounds: 1, chance: 0.9 },
    ]);
    expect(a.bank).toBe(0);
    expect(dev.teams.b).toEqual(emptyTeamDevelopment());
    expect(dev.report).toEqual([{ teamId: 'a', part: 'floor', level: 2, success: true }]);
    // a valid development survives a JSON round trip unchanged
    let season = createSeasonDevelopment(IDS);
    for (let round = 0; round < 6; round++) season = advance(season, 40 + round);
    expect(sanitizeDevelopment(JSON.parse(JSON.stringify(season)), IDS)).toEqual(season);
  });

  test('developmentFromRd maps the old departments onto parts', () => {
    const team = developmentFromRd({ aero: 3, power: 2, chassis: 4, reliability: 5 });
    const levels = Object.fromEntries(CAR_PARTS.map((p) => [p, team.parts[p].level]));
    expect(levels).toEqual({
      frontWing: 3,
      rearWing: 3,
      floor: 3,
      powerUnit: 2,
      ers: 2,
      gearbox: 2,
      suspension: 4,
      brakes: 4,
      weight: 4,
      reliability: 5,
    });
    for (const p of CAR_PARTS) expect(team.parts[p].gain).toBe(team.parts[p].level);
    expect(team.projects).toEqual([]);
    expect(team.bank).toBe(0);
    const odd = developmentFromRd({ aero: 9, power: -2, chassis: Number.NaN, reliability: 2.6 });
    expect([odd.parts.frontWing.level, odd.parts.ers.level, odd.parts.gearbox.level, odd.parts.brakes.level, odd.parts.reliability.level]).toEqual([5, 0, 0, 0, 3]);
  });
});

describe('career R&D points', () => {
  const pts = (teamRank0: number, position: number | null, aheadOfTeammate: boolean, sprintPosition?: number | null): number =>
    careerRoundPoints({ teamRank0, teamCount: 10, position, fieldSize: 20, aheadOfTeammate, sprintPosition });

  test('the team\'s AI budget × (0.85 + 0.25 · finish + 0.05 ahead of the team-mate + 0.05 · sprint), rounded', () => {
    // leader (35.7): a win ahead of the team-mate 35.7 × 1.15, plus a sprint win × 1.2
    expect(pts(0, 1, true)).toBe(41);
    expect(pts(0, 1, true, 1)).toBe(43);
    // midfield team (6th: 42.7), P10 ahead of the team-mate ≈ the average AI budget 42
    expect(pts(5, 10, true)).toBe(Math.round(42 * (0.85 + 0.3 * (5 / 9)) * (0.85 + 0.25 * (10 / 19) + 0.05)));
    expect(pts(5, 10, true)).toBe(44);
    // last team (48.3): P18 behind the team-mate, last place / DNF = 0.85 ×
    expect(pts(9, 18, false)).toBe(42);
    expect(pts(9, 20, false)).toBe(41);
    expect(pts(9, null, false)).toBe(41);
    expect(pts(9, null, true, null)).toBe(Math.round(48.3 * 0.9));
    // sprint score like the race: P8 of 20 = 12 / 19 of the 0.05
    expect(pts(4, 5, false, 8)).toBe(Math.round(aiDevelopmentBudget(4, 10) * (0.85 + 0.25 * (15 / 19) + 0.05 * (12 / 19))));
    // invalid positions score 0
    expect(pts(0, Number.NaN, false, 0)).toBe(pts(0, null, false));
    expect(careerRoundPoints({ teamRank0: Number.NaN, teamCount: 10, position: 1, fieldSize: Number.NaN, aheadOfTeammate: false })).toBe(
      Math.round(aiDevelopmentBudget(9, 10) * 0.85),
    );
  });

  test('like the AI, leaders earn less; a result only moves the points within 0.85–1.2 × the team budget', () => {
    expect(pts(0, 1, true, 1)).toBeLessThan(pts(9, 1, true, 1));
    expect(pts(0, 1, true)).toBeLessThan(aiDevelopmentBudget(9, 10));
    for (let rank = 0; rank < 10; rank++) {
      const budget = aiDevelopmentBudget(rank, 10);
      for (const position of [1, 3, 10, 18, 20, null]) {
        for (const ahead of [true, false]) {
          for (const sprint of [1, 8, null]) {
            const p = pts(rank, position, ahead, sprint);
            expect(p).toBeGreaterThanOrEqual(Math.round(budget * 0.85));
            expect(p).toBeLessThanOrEqual(Math.round(budget * 1.2));
          }
        }
      }
      // a better finish never earns less
      for (let position = 2; position <= 20; position++) expect(pts(rank, position, false)).toBeLessThanOrEqual(pts(rank, position - 1, false));
    }
  });
});

describe('session plumbing', () => {
  const LAYOUT_ID = 'porto-lumen';

  function request(patch: Partial<SessionRequest> = {}): SessionRequest {
    return {
      mode: 'career',
      kind: 'race',
      layoutId: LAYOUT_ID,
      raceLaps: 5,
      weather: 'clear',
      timeOfDay: 'auto',
      regulation: '2025',
      aiDifficulty: 90,
      qualifying: 'oneShot',
      rules: { ...DEFAULT_RULES },
      seed: 4242,
      players: [{ playerIndex: 0, driverId: 'hsu', teamId: PLAYER, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS }, startCompound: null }],
      roster: standardRoster(),
      aiCount: null,
      gridOrder: null,
      playerStartPosition: null,
      ghost: null,
      objective: null,
      ...patch,
    };
  }

  test('roundRequest → SessionRequest → SessionConfig carries the gains (and nothing when absent)', () => {
    let dev = createSeasonDevelopment(IDS);
    for (let round = 0; round < 4; round++) dev = advance(dev, 70 + round);
    const args = {
      mode: 'career' as const,
      kind: 'race' as const,
      round: { layoutId: LAYOUT_ID, weather: 'clear' as const },
      fullLaps: 50,
      settings: DEFAULT_SEASON_SETTINGS,
      roster: standardRoster(),
      seed: 1,
      assists: { ...DEFAULT_ASSISTS },
      setup: { ...DEFAULT_SETUP },
      startCompound: null,
      gridOrder: null,
    };
    expect(roundRequest(args).development).toBeUndefined();
    const req = roundRequest({ ...args, development: dev });
    expect(req.development).toEqual(developmentGains(dev));
    expect(buildSessionConfig(request()).development).toBeUndefined();
    const config = buildSessionConfig(request({ development: req.development }), layoutOrDefault(LAYOUT_ID));
    expect(config.development).toEqual(developmentGains(dev));
    expect(config.development).not.toBe(req.development);
    expect(requestFromConfig(config).development).toEqual(config.development);
  });

  test('world car specs (human and AI teams) and simulated qualifying use the gains', () => {
    const track = getLayout(LAYOUT_ID);
    const gains = Object.fromEntries(CAR_PARTS.map((p) => [p, 5]));
    const plain = buildSessionConfig(request(), layoutOrDefault(LAYOUT_ID));
    const developed = buildSessionConfig(request({ development: { [PLAYER]: gains, vanta: gains } }), layoutOrDefault(LAYOUT_ID));
    const world = createWorld(developed, track);
    const base = createWorld(plain, track);
    const human = world.cars.find((c) => c.playerIndex === 0)!;
    expect(human.spec).toEqual(createCarSpec(TEAMS.find((t) => t.id === PLAYER)!, DEFAULT_SETUP, '2025', gains));
    const vanta = world.cars.find((c) => c.teamId === 'vanta')!;
    expect(vanta.spec).toEqual(createCarSpec(aiCarTeam(TEAMS.find((t) => t.id === 'vanta')!), DEFAULT_SETUP, '2025', gains));
    expect(vanta.spec.icePower).toBeGreaterThan(base.cars.find((c) => c.teamId === 'vanta')!.spec.icePower);
    // undeveloped teams are untouched
    const corvid = (w: typeof world) => w.cars.find((c) => c.teamId === 'corvid')!.spec;
    expect(corvid(world)).toEqual(corvid(base));
    // AI pace estimate and simulated qualifying see the developed car
    expect(vanta.ai.paceTime).toBeLessThan(base.cars.find((c) => c.teamId === 'vanta')!.ai.paceTime);
    const quali = (dev: SessionRequest['development']) =>
      simulateLapTimes(buildSessionConfig(request({ kind: 'qualifying', development: dev }), layoutOrDefault(LAYOUT_ID)), track);
    const before = quali(undefined);
    const after = quali({ vanta: gains });
    const vantaDrivers = TEAMS.find((t) => t.id === 'vanta')!.driverIds;
    for (const id of vantaDrivers) expect(after[id]!).toBeLessThan(before[id]! * 0.98);
    const other = TEAMS.find((t) => t.id === 'corvid')!.driverIds[0];
    expect(after[other]).toBe(before[other]!);
  });
});

describe('season modes', () => {
  const SLOT = { assists: { ...DEFAULT_ASSISTS }, setup: { ...DEFAULT_SETUP }, startCompound: null };
  const IDENTITY: PlayerIdentity = {
    firstName: 'Test',
    lastName: 'Driver',
    abbr: 'TDR',
    number: 2,
    nationality: 'TWN',
    helmet: { primary: '#ff0000', secondary: '#00ff00', accent: '#0000ff' },
  };
  const FULL = developmentFromRd({ aero: 5, power: 5, chassis: 5, reliability: 5 });
  const spec = (world: ReturnType<typeof createWorld>, teamId: string) => world.cars.find((c) => c.teamId === teamId)!.spec;

  test('My Team: a migrated old save puts its parts on both team cars; AI teams carry their own development', () => {
    const fresh = createMyTeam(
      { name: 'Nova Works', shortName: 'NVW', livery: { primary: '#ff5a1f', secondary: '#111111', accent: '#ffffff', pattern: 'stripe' }, powerUnit: 'Helion', identity: IDENTITY, teammateId: 'ishikawa', settings: DEFAULT_SEASON_SETTINGS },
      5,
      LAYOUTS,
    );
    const { development: _d, ...rest } = fresh;
    const migrated = sanitizeMyTeam(JSON.parse(JSON.stringify({ ...rest, rd: { aero: 3, power: 2, chassis: 1, reliability: 4 } })), LAYOUTS)!;
    migrated.development.teams.vanta = FULL;
    const config = buildSessionConfig(myTeamRequest(migrated, 'race', 50, SLOT, null)!);
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const base = createWorld(buildSessionConfig(myTeamRequest(fresh, 'race', 50, SLOT, null)!), track);
    const gains = teamGains(myTeamDevelopment(migrated));
    expect(gains).toEqual({ frontWing: 3, rearWing: 3, floor: 3, suspension: 1, powerUnit: 2, ers: 2, gearbox: 2, brakes: 1, weight: 1, reliability: 4 });
    const myTeam = config.teams.find((t) => t.id === MY_TEAM_ID)!;
    // the rating of the old departments (Helion: power / reliability base 0.94; aero / chassis 0.86; cap 0.99)
    expect(myTeam.rating).toEqual({ aero: 0.938, power: 0.96, chassis: 0.886, reliability: 0.98 });
    expect(myTeam.rating).toEqual(myTeamDef(migrated).rating);
    const mine = world.cars.filter((c) => c.teamId === MY_TEAM_ID);
    expect(mine.map((c) => c.playerIndex).sort()).toEqual([-1, 0]);
    for (const car of mine) expect(car.spec).toEqual(createCarSpec(myTeam, DEFAULT_SETUP, config.regulation, gains));
    expect(spec(world, MY_TEAM_ID).icePower).toBeGreaterThan(spec(base, MY_TEAM_ID).icePower);
    expect(spec(world, MY_TEAM_ID).mass).toBeLessThan(spec(base, MY_TEAM_ID).mass);
    const vanta = TEAMS.find((t) => t.id === 'vanta')!;
    expect(spec(world, 'vanta')).toEqual(createCarSpec(aiCarTeam(vanta), DEFAULT_SETUP, config.regulation, teamGains(FULL)));
    expect(spec(world, 'corvid')).toEqual(spec(base, 'corvid'));
  });

  test('career: the player team (both cars), AI teams and simulated qualifying use the season development', () => {
    const career = createCareer(IDENTITY, 'corvid', DEFAULT_SEASON_SETTINGS, 8, LAYOUTS);
    const developed: CareerSave = { ...career, development: { ...career.development, teams: { ...career.development.teams, corvid: FULL, vanta: FULL } } };
    const gains = teamGains(FULL);
    const config = buildSessionConfig(careerRequest(developed, 'race', 50, SLOT, null)!);
    expect(config.development).toEqual(developmentGains(developed.development));
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    const base = createWorld(buildSessionConfig(careerRequest(career, 'race', 50, SLOT, null)!), track);
    const corvid = config.teams.find((t) => t.id === 'corvid')!;
    const team = world.cars.filter((c) => c.teamId === 'corvid');
    expect(team.map((c) => c.playerIndex).sort()).toEqual([-1, 0]);
    for (const car of team) expect(car.spec).toEqual(createCarSpec(corvid, DEFAULT_SETUP, config.regulation, gains));
    const vanta = TEAMS.find((t) => t.id === 'vanta')!;
    expect(spec(world, 'vanta')).toEqual(createCarSpec(aiCarTeam(vanta), DEFAULT_SETUP, config.regulation, gains));
    expect(spec(world, 'kestrel')).toEqual(spec(base, 'kestrel'));

    const quali = (save: CareerSave) => simulateLapTimes(buildSessionConfig(careerRequest(save, 'qualifying', 50, SLOT, null)!), track);
    const before = quali(career);
    const after = quali(developed);
    expect(after[PLAYER_DRIVER_ID]).toBeUndefined();
    for (const id of [careerTeammateId(career), ...vanta.driverIds]) expect(after[id]!).toBeLessThan(before[id]! * 0.98);
    const other = TEAMS.find((t) => t.id === 'kestrel')!.driverIds[0];
    expect(after[other]).toBe(before[other]!);
  });

  const DRAFT = {
    name: 'Nova Works',
    shortName: 'NVW',
    livery: { primary: '#ff5a1f', secondary: '#111111', accent: '#ffffff', pattern: 'stripe' as const },
    powerUnit: 'Helion',
    identity: IDENTITY,
    teammateId: 'ishikawa',
    settings: DEFAULT_SEASON_SETTINGS,
  };

  test('race grid without qualifying (race-only weekends) ranks part development like rating', () => {
    const fresh = createMyTeam(DRAFT, 5, LAYOUTS);
    const req = myTeamRequest(fresh, 'race', 50, SLOT, null)!;
    // all-zero development = no development: the grid is unchanged
    const { development: _zero, ...plain } = req;
    expect(buildSessionConfig(req).grid).toEqual(buildSessionConfig(plain).grid);
    const slots = (save: MyTeamSave, teamId: string): number[] =>
      buildSessionConfig(myTeamRequest(save, 'race', 50, SLOT, null)!).grid.flatMap((g, i) => (g.teamId === teamId ? [i + 1] : []));
    expect(Math.min(...slots(fresh, MY_TEAM_ID))).toBeGreaterThan(16);
    expect(Math.max(...slots({ ...fresh, development: withTeam(fresh.development, MY_TEAM_ID, FULL) }, MY_TEAM_ID))).toBeLessThanOrEqual(4);
    // AI teams' development counts too
    const corvid = slots({ ...fresh, development: withTeam(fresh.development, 'corvid', FULL) }, 'corvid');
    expect(Math.max(...corvid)).toBeLessThan(Math.min(...slots(fresh, 'corvid')));
  });

  test('sponsor target (My Team) and expected position (career) rank teams with their part development', () => {
    const fresh = createMyTeam(DRAFT, 5, LAYOUTS);
    const ranked = [...myTeamRoster(fresh).teams].sort((a, b) => teamStrength(b) - teamStrength(a));
    const base = sponsorTarget(fresh);
    expect(base).toBe(Math.min(20, ranked.findIndex((t) => t.id === MY_TEAM_ID) * 2 + 1));
    expect(sponsorTarget({ ...fresh, development: withTeam(fresh.development, MY_TEAM_ID, FULL) })).toBe(1);
    // everyone fully developed: equal part strength, My Team ranked by its grown rating (0.99 everywhere)
    const everyone = { ...fresh.development, teams: Object.fromEntries(Object.keys(fresh.development.teams).map((id) => [id, FULL])) };
    const allFull = { ...fresh, development: everyone };
    const rankedFull = [...myTeamRoster(allFull).teams].sort((a, b) => teamStrength(b) - teamStrength(a));
    expect(sponsorTarget(allFull)).toBe(rankedFull.findIndex((t) => t.id === MY_TEAM_ID) * 2 + 1);
    expect(sponsorTarget(allFull)).toBeLessThan(base);

    const career = createCareer(IDENTITY, 'corvid', DEFAULT_SEASON_SETTINGS, 8, LAYOUTS);
    const roster = careerRoster(career).roster;
    expect(expectedPosition('corvid', roster)).toBe(19.5);
    expect(expectedPosition('corvid', roster, career.development)).toBe(19.5);
    expect(expectedPosition('corvid', roster, withTeam(career.development, 'corvid', FULL))).toBe(1.5);
    // two teams behind nordlys out-develop it: it is expected two places (4 positions) further back
    const nordlys = expectedPosition('nordlys', roster);
    expect(expectedPosition('nordlys', roster, withTeam(withTeam(career.development, 'corvid', FULL), 'helix', FULL))).toBe(nordlys + 4);
  });
});
