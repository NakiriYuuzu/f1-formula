/**
 * Local achievements (12) and profile statistics (pure logic): definitions, evaluation against a finished
 * session, unlock bookkeeping and sanitizers.
 */
import type { ResultRow, SessionResult } from '../core/types';
import { asRecord, int, isRecord } from './guards';

export type AchievementId =
  | 'firstWin'
  | 'firstPole'
  | 'firstPodium'
  | 'wetWin'
  | 'cleanRace'
  | 'comeback'
  | 'fastestLap'
  | 'tenRaces'
  | 'beatGhost'
  | 'storyComplete'
  | 'rdMaxed'
  | 'champion';

export interface AchievementDef {
  id: AchievementId;
  title: string;
  description: string;
  /** short glyph shown in the badge */
  glyph: string;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'firstWin', title: '初嚐勝利', description: '在任何模式贏得一場正賽', glyph: '1' },
  { id: 'firstPole', title: '桿位新星', description: '在排位賽取得第一名', glyph: 'P' },
  { id: 'firstPodium', title: '站上頒獎台', description: '在正賽取得前三名', glyph: '3' },
  { id: 'wetWin', title: '雨中之王', description: '在雨天贏得一場正賽', glyph: '☂' },
  { id: 'cleanRace', title: '乾淨比賽', description: '完成一場沒有賽道界線警告與罰秒的正賽', glyph: '✓' },
  { id: 'comeback', title: '逆轉之王', description: '在一場正賽中比發車位置前進 10 名以上', glyph: '↑' },
  { id: 'fastestLap', title: '最速一圈', description: '在正賽中創下全場最快單圈', glyph: '⏱' },
  { id: 'tenRaces', title: '十場老手', description: '累積完成 10 場正賽', glyph: '10' },
  { id: 'beatGhost', title: '超越幽靈', description: '在計時賽中跑贏自己的幽靈車', glyph: '◐' },
  { id: 'storyComplete', title: '新星誕生', description: '完成「新星之路」全部 6 章', glyph: '★' },
  { id: 'rdMaxed', title: '研發極限', description: '在我的車隊將任一零件研發到滿級', glyph: '⚙' },
  { id: 'champion', title: '年度冠軍', description: '在車手生涯或我的車隊贏得車手或車隊年度冠軍', glyph: '♛' },
];

export interface AchievementSave {
  /** unlock date (ISO string) per achievement */
  unlocked: Partial<Record<AchievementId, string>>;
}

export interface ProfileStats {
  racesFinished: number;
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  sessions: number;
}

export function emptyStats(): ProfileStats {
  return { racesFinished: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, sessions: 0 };
}

/** Facts about a finished session that achievements depend on. */
export interface AchievementContext {
  result: SessionResult;
  /** track-limit warnings of player 0 during the session */
  trackLimitWarnings: number;
  /** time trial: the player's best lap beat the ghost that was on track */
  beatGhost: boolean;
  storyComplete: boolean;
  rdMaxed: boolean;
  /** a career / My Team season just ended with the player (or My Team) as champion */
  champion: boolean;
  /** profile stats AFTER this session was counted */
  stats: ProfileStats;
}

function humanRow(result: SessionResult): ResultRow | undefined {
  return result.rows.find((r) => r.playerIndex === 0);
}

function finished(row: ResultRow): boolean {
  return row.status !== 'retired' && row.position >= 1;
}

/** Stats after counting this session. */
export function updateStats(stats: ProfileStats, result: SessionResult): ProfileStats {
  const next = { ...stats, sessions: stats.sessions + 1 };
  const row = humanRow(result);
  if (!row) return next;
  if (result.kind === 'race' && finished(row)) {
    next.racesFinished++;
    if (row.position === 1) next.wins++;
    if (row.position <= 3) next.podiums++;
    if (row.fastestLap) next.fastestLaps++;
  }
  if (result.kind === 'qualifying' && row.position === 1 && row.time !== null) next.poles++;
  return next;
}

/** Every achievement satisfied by this session (already-unlocked ones included). */
export function evaluateAchievements(ctx: AchievementContext): AchievementId[] {
  const out: AchievementId[] = [];
  const { result } = ctx;
  const row = humanRow(result);
  if (row && result.kind === 'race' && finished(row)) {
    const wet = result.weather === 'lightRain' || result.weather === 'heavyRain';
    if (row.position === 1) out.push('firstWin');
    if (row.position === 1 && wet) out.push('wetWin');
    if (row.position <= 3) out.push('firstPodium');
    if (ctx.trackLimitWarnings === 0 && row.penaltySec <= 0) out.push('cleanRace');
    if (row.gridPosition > 0 && row.gridPosition - row.position >= 10) out.push('comeback');
    if (row.fastestLap) out.push('fastestLap');
  }
  if (row && result.kind === 'qualifying' && row.position === 1 && row.time !== null) out.push('firstPole');
  if (ctx.stats.racesFinished >= 10) out.push('tenRaces');
  if (ctx.beatGhost) out.push('beatGhost');
  if (ctx.storyComplete) out.push('storyComplete');
  if (ctx.rdMaxed) out.push('rdMaxed');
  if (ctx.champion) out.push('champion');
  return out;
}

/** Unlock ids not yet unlocked; returns the new save and the newly unlocked ids. */
export function unlockAchievements(
  save: AchievementSave,
  ids: readonly AchievementId[],
  date: string,
): { save: AchievementSave; newly: AchievementId[] } {
  const unlocked = { ...save.unlocked };
  const newly: AchievementId[] = [];
  for (const id of ids) {
    if (unlocked[id] === undefined) {
      unlocked[id] = date;
      newly.push(id);
    }
  }
  return { save: { unlocked }, newly };
}

export function achievementDef(id: AchievementId): AchievementDef {
  return ACHIEVEMENTS.find((a) => a.id === id) ?? (ACHIEVEMENTS[0] as AchievementDef);
}

export function sanitizeAchievements(v: unknown): AchievementSave {
  const unlocked: Partial<Record<AchievementId, string>> = {};
  const raw = isRecord(v) ? asRecord(v.unlocked) : {};
  for (const def of ACHIEVEMENTS) {
    const date = raw[def.id];
    if (typeof date === 'string' && date.length > 0 && date.length <= 40) unlocked[def.id] = date;
  }
  return { unlocked };
}

export function sanitizeStats(v: unknown): ProfileStats {
  const r = asRecord(v);
  return {
    racesFinished: int(r.racesFinished, 0, 1e6, 0),
    wins: int(r.wins, 0, 1e6, 0),
    podiums: int(r.podiums, 0, 1e6, 0),
    poles: int(r.poles, 0, 1e6, 0),
    fastestLaps: int(r.fastestLaps, 0, 1e6, 0),
    sessions: int(r.sessions, 0, 1e7, 0),
  };
}
