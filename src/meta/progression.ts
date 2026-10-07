/**
 * Applies a finished session to the persisted progress: profile statistics, time-trial PB / leaderboard / ghost,
 * career and My Team rounds (points, rating, budget, season end), story completion and achievements.
 * Reads and writes through meta/save (memory fallback in tests). Never throws.
 */
import type { GhostData, SessionConfig, SessionResult } from '../core/types';
import { formatLapTime } from '../core/math';
import { evaluateAchievements, unlockAchievements, updateStats, type AchievementId } from './achievements';
import { applyCareerQualifying, applyCareerRace, applyCareerSprint, type SeasonSummary } from './career';
import type { SessionContext } from './context';
import { applyMyTeamRace, applyMyTeamSprint, isAnyDepartmentMaxed } from './myTeam';
import {
  loadAchievements,
  loadCareer,
  loadMyTeam,
  loadProfile,
  loadStory,
  loadTimeTrialRecords,
  saveAchievements,
  saveCareer,
  saveGhost,
  saveMyTeam,
  saveProfile,
  saveStory,
  saveTimeTrialRecords,
} from './save';
import { pointsForRow } from './season';
import { evaluateObjective, isStoryComplete, recordStoryAttempt } from './story';
import { addLapRecord } from './timeTrial';

export interface ProgressInput {
  result: SessionResult;
  config: SessionConfig;
  ctx: SessionContext;
  /** track-limit warnings of player 0 (from the world) */
  trackLimitWarnings: number;
  /** time trial: ghost of the player's best lap (race.extractGhost) */
  ghost: GhostData | null;
  /** qualifying: full classification (driverIds) including simulated AI times */
  qualifyingOrder: string[] | null;
  /** ISO timestamp */
  date: string;
}

export interface ProgressOutcome {
  /** zh-TW lines for the results screen */
  notes: string[];
  newAchievements: AchievementId[];
  personalBest: boolean;
  leaderboardRank: number | null;
  objectiveMet: boolean | null;
  /** career / My Team: the season ended with this race */
  seasonSummary: SeasonSummary | null;
}

function pointsOf(result: SessionResult, driverId: string): number {
  const row = result.rows.find((r) => r.driverId === driverId);
  return row ? pointsForRow(row, true) : 0;
}

/** Objective outcome: the runtime's verdict when present, else evaluated here. */
export function resolveObjectiveMet(result: SessionResult, config: SessionConfig): boolean | null {
  if (typeof result.objectiveMet === 'boolean') return result.objectiveMet;
  return config.objective ? evaluateObjective(config.objective, result) : null;
}

/** Unlock achievements outside a session (e.g. buying the last R&D level). Returns the newly unlocked ids. */
export function unlockNow(ids: readonly AchievementId[], date: string): AchievementId[] {
  const { save, newly } = unlockAchievements(loadAchievements(), ids, date);
  if (newly.length > 0) saveAchievements(save);
  return newly;
}

/**
 * Qualifying results from the runtime only contain the cars that actually ran (usually just the humans); positions
 * are re-derived from the full classification (incl. simulated AI times) so poles are judged fairly.
 */
export function withQualifyingPositions(result: SessionResult, order: readonly string[] | null): SessionResult {
  if (result.kind !== 'qualifying' || !order || order.length === 0) return result;
  return {
    ...result,
    rows: result.rows.map((r) => {
      const i = order.indexOf(r.driverId);
      return i >= 0 ? { ...r, position: i + 1 } : r;
    }),
  };
}

export function applyProgress(input: ProgressInput): ProgressOutcome {
  const { config, ctx } = input;
  const result = withQualifyingPositions(input.result, input.qualifyingOrder);
  const out: ProgressOutcome = {
    notes: [],
    newAchievements: [],
    personalBest: false,
    leaderboardRank: null,
    objectiveMet: resolveObjectiveMet(result, config),
    seasonSummary: null,
  };
  const me = result.rows.find((r) => r.playerIndex === 0);

  // ── sprint race: only its points are kept (career / My Team standings); no race stats, income or achievements
  if (result.sprint === true && result.kind === 'race') {
    if (result.mode === 'career') {
      const career = loadCareer();
      if (career && ctx.round === career.results.length) {
        saveCareer(applyCareerSprint(career, result));
        out.notes.push(`衝刺賽完成，獲得 ${pointsOf(result, 'player')} 分`);
      }
    } else if (result.mode === 'myTeam') {
      const team = loadMyTeam();
      if (team && ctx.round === team.results.length) {
        saveMyTeam(applyMyTeamSprint(team, result));
        out.notes.push(`衝刺賽完成，獲得 ${pointsOf(result, 'player')} 分`);
      }
    }
    return out;
  }

  const profile = loadProfile();
  profile.stats = updateStats(profile.stats, result);
  saveProfile(profile);

  // ── time trial
  let beatGhost = false;
  if (result.kind === 'timeTrial' && result.mode === 'timeTrial' && me) {
    const best = me.bestLap ?? me.time;
    if (best !== null && Number.isFinite(best) && best > 0) {
      const added = addLapRecord(loadTimeTrialRecords(), config.layoutId, config.regulation, {
        lapTime: best,
        teamId: me.teamId,
        driverId: me.driverId,
        date: input.date,
      });
      saveTimeTrialRecords(added.records);
      out.personalBest = added.isPersonalBest;
      out.leaderboardRank = added.rank;
      if (added.isPersonalBest) {
        out.notes.push(`新的個人最佳圈速：${formatLapTime(best)}`);
        if (input.ghost && saveGhost({ ...input.ghost, layoutId: config.layoutId }, config.regulation)) {
          out.notes.push('已儲存幽靈車');
        }
      } else if (added.rank !== null) {
        out.notes.push(`本機排行榜第 ${added.rank} 名`);
      }
      if (config.ghost && best < config.ghost.lapTime) beatGhost = true;
    }
  }

  // ── career
  let champion = false;
  if (result.mode === 'career') {
    const career = loadCareer();
    if (career && ctx.round === career.results.length) {
      if (result.kind === 'qualifying' && input.qualifyingOrder) {
        saveCareer(applyCareerQualifying(career, input.qualifyingOrder));
      } else if (result.kind === 'race') {
        const upd = applyCareerRace(career, result, input.trackLimitWarnings);
        saveCareer(upd.save);
        const pts = upd.record.classification.find((e) => e.driverId === 'player')?.points ?? 0;
        out.notes.push(`第 ${upd.save.results.length} 站完成，獲得 ${pts} 分`);
        if (upd.summary) {
          out.seasonSummary = upd.summary;
          champion = upd.summary.driverPosition === 1;
          out.notes.push(`第 ${upd.summary.season} 季結束：車手積分榜第 ${upd.summary.driverPosition} 名`);
        }
      }
    }
  }

  // ── My Team
  const team = loadMyTeam();
  if (result.mode === 'myTeam' && result.kind === 'race' && team && ctx.round === team.results.length) {
    const upd = applyMyTeamRace(team, result);
    saveMyTeam(upd.save);
    const income = upd.save.lastIncome.reduce((acc, l) => acc + l.amount, 0);
    out.notes.push(`車隊收入 +${income.toFixed(1)} M（資金 ${upd.save.budget.toFixed(1)} M）`);
    if (upd.summary) {
      out.seasonSummary = upd.summary;
      champion = upd.summary.driverPosition === 1 || upd.summary.teamPosition === 1;
      out.notes.push(`第 ${upd.summary.season} 季結束：車隊積分榜第 ${upd.summary.teamPosition} 名`);
    }
  }

  // ── story
  let storyDone = false;
  if (result.mode === 'story' && ctx.storyId) {
    const progress = recordStoryAttempt(loadStory(), ctx.storyId, out.objectiveMet === true, result);
    saveStory(progress);
    storyDone = isStoryComplete(progress);
  } else {
    storyDone = isStoryComplete(loadStory());
  }

  // ── achievements
  const ids = evaluateAchievements({
    result,
    trackLimitWarnings: Math.max(0, Number.isFinite(input.trackLimitWarnings) ? input.trackLimitWarnings : 0),
    beatGhost,
    storyComplete: storyDone,
    rdMaxed: team !== null && isAnyDepartmentMaxed(team),
    champion,
    stats: profile.stats,
  });
  out.newAchievements = unlockNow(ids, input.date);
  return out;
}
