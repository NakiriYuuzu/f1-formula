/**
 * 新星之路 (story mode, pure logic): 6 original chapters about a rookie's first season with a fictional mentor and
 * rival, plus 6 challenges using the same StoryObjective system. Objective templates, resolution, evaluation and
 * progress bookkeeping.
 */
import type {
  Assists,
  CarSetup,
  DriverDef,
  Regulation,
  SessionKind,
  SessionResult,
  StoryObjective,
  TireCompound,
} from '../core/types';
import { DEFAULT_RULES } from '../core/defaults';
import { formatLapTime } from '../core/math';
import { DRIVERS } from '../data/teams';
import { ratingToSkill, INITIAL_RATING } from './career';
import { asRecord, bool, int, isRecord, num } from './guards';
import type { QualifyingType, TimeOfDayChoice, WeatherChoice } from './options';
import { builtinRoster, createPlayerDriver, driverName, rosterWithReplacement, type PlayerIdentity, type Roster } from './roster';
import type { SessionRequest } from './sessionBuilder';

export interface StorySession {
  kind: SessionKind;
  layoutId: string;
  weather: WeatherChoice;
  timeOfDay: TimeOfDayChoice;
  /** race laps */
  laps: number;
  /** player's 1-based grid slot (race), null = rating order */
  startPosition: number | null;
  regulation: Regulation;
  aiDifficulty: number;
  qualifying: QualifyingType;
  /** team whose second seat the protagonist takes */
  teamId: string;
}

export interface ObjectiveTemplate {
  kind: StoryObjective['kind'];
  /** position / count (unused for lapUnder and noPenalties) */
  value: number;
  /** lapUnder: multiple of the layout's reference lap time (scaled to the session's regulation pace) */
  lapFactor?: number;
  driverId?: string;
}

export interface StoryCard {
  /** speaker name ('' = narration) */
  speaker: string;
  text: string;
}

export interface StoryChapter {
  id: string;
  /** 1-based */
  number: number;
  title: string;
  subtitle: string;
  intro: StoryCard[];
  outroSuccess: StoryCard[];
  outroFail: StoryCard[];
  session: StorySession;
  objective: ObjectiveTemplate;
}

export interface StoryChallenge {
  id: string;
  title: string;
  description: string;
  session: StorySession;
  objective: ObjectiveTemplate;
}

/** The protagonist (original character). */
export const STORY_IDENTITY: PlayerIdentity = {
  firstName: 'Xingyu',
  lastName: 'Cheng',
  abbr: 'CHE',
  number: 31,
  nationality: 'TWN',
  helmet: { primary: '#ff5a1f', secondary: '#0d1118', accent: '#f4f1e8', pattern: 'chevron' },
};
export const STORY_TEAM_ID = 'corvid';
export const STORY_RIVAL_ID = 'brandt';
export const MENTOR = '艾黛兒・溫特斯';
const ME = '程星宇';
const NARRATION = '';

const base = (s: Partial<StorySession> & Pick<StorySession, 'kind' | 'layoutId'>): StorySession => ({
  weather: 'clear',
  timeOfDay: 'auto',
  laps: 5,
  startPosition: null,
  regulation: '2025',
  aiDifficulty: 75,
  qualifying: 'oneShot',
  teamId: STORY_TEAM_ID,
  ...s,
});

export const STORY_CHAPTERS: StoryChapter[] = [
  {
    id: 'ch1',
    number: 1,
    title: '臨危受命',
    subtitle: '高原嶺・自由練習',
    intro: [
      { speaker: NARRATION, text: '季前測試最後一天，鴉嶺車隊的正選車手卡德威爾在健身房扭傷了手腕。隔天清晨，預備車手程星宇接到一通電話。' },
      { speaker: MENTOR, text: '星宇，我是艾黛兒。這個週末的座位是你的。別問為什麼是你──我看過你在青年組的每一圈。' },
      { speaker: MENTOR, text: '今天只是練習。我不要你證明任何事，只要一個乾淨、穩定的單圈。把車帶回來，數據會替你說話。' },
    ],
    outroSuccess: [
      { speaker: MENTOR, text: '數據組說你的第三計時段跟武田只差兩個十分位。今晚早點睡，明天開始才是真的。' },
      { speaker: ME, text: '（握著方向盤的手還在發抖。但那不是害怕。）' },
    ],
    outroFail: [{ speaker: MENTOR, text: '第一次坐進這台車，本來就會手忙腳亂。深呼吸，我們再出去一次。' }],
    session: base({ kind: 'practice', layoutId: 'highland-ridge', aiDifficulty: 70 }),
    objective: { kind: 'lapUnder', value: 0, lapFactor: 1.12 },
  },
  {
    id: 'ch2',
    number: 2,
    title: '雨中初登場',
    subtitle: '翠島海岸・正賽',
    intro: [
      { speaker: NARRATION, text: '翠島海岸的天空在發車前一小時轉成鉛灰色。細雨落在維修區的帳篷上，像是有人在輕敲鼓面。' },
      { speaker: MENTOR, text: '排位賽的事不用再想了，第十八位發車就是我們的現實。雨天的好處是──每個人都一樣看不清楚。' },
      { speaker: MENTOR, text: '保持在賽道上，別跟人硬碰。完賽就有機會撿到名次。' },
    ],
    outroSuccess: [
      { speaker: NARRATION, text: '方格旗落下時，維修牆上的技師們在雨裡跳了起來。新聞稿第二段，第一次出現了「程星宇」三個字。' },
    ],
    outroFail: [{ speaker: MENTOR, text: '雨天會放大每一個錯誤。記住今天那幾個彎的感覺，下次它們會變成你的武器。' }],
    session: base({ kind: 'race', layoutId: 'isola-verde', weather: 'lightRain', startPosition: 18, aiDifficulty: 72 }),
    objective: { kind: 'finishAtOrAbove', value: 12 },
  },
  {
    id: 'ch3',
    number: 3,
    title: '宿敵',
    subtitle: '紅葉丘陵・正賽',
    intro: [
      { speaker: NARRATION, text: '晴原車隊的諾亞・布蘭特，是青年組時期唯一一個總能在最後一圈超過程星宇的人。兩年前，車隊選了他，沒有選星宇。' },
      { speaker: '諾亞・布蘭特', text: '（在車手簡報室外擦肩而過）「替補也能上場啊？別擋我的路就好。」' },
      { speaker: MENTOR, text: '別讓他住進你的腦袋。不過……如果你剛好在他前面衝線，我也不會阻止你。' },
    ],
    outroSuccess: [
      { speaker: '諾亞・布蘭特', text: '（摘下頭盔，沉默了幾秒）「……下一站再說。」' },
      { speaker: MENTOR, text: '你看到他的表情了嗎？我看到了。' },
    ],
    outroFail: [{ speaker: MENTOR, text: '他比你多跑了兩年。差距會縮小的──只要你別再用他的節奏開車。' }],
    session: base({ kind: 'race', layoutId: 'koyo-hills', startPosition: 13, aiDifficulty: 75 }),
    objective: { kind: 'beatDriver', value: 0, driverId: STORY_RIVAL_ID },
  },
  {
    id: 'ch4',
    number: 4,
    title: '沙漠長夜',
    subtitle: '蜃樓沙漠・正賽',
    intro: [
      { speaker: NARRATION, text: '排位賽最後一圈，變速箱在髮夾彎前卡在空檔。程星宇只能從最後一排起跑。' },
      { speaker: MENTOR, text: '兩條長直道、兩個重煞彎。這裡是超車的天堂。我要你在終點前把那些車一台一台收回來。' },
      { speaker: ME, text: '「收到。把他們當成練習賽裡的三角錐。」' },
    ],
    outroSuccess: [
      { speaker: NARRATION, text: '夕陽沉進沙丘的時候，計時塔上的名字一路往上爬。轉播單位第一次把鏡頭切到了鴉嶺的車庫。' },
    ],
    outroFail: [{ speaker: MENTOR, text: '從最後面出發本來就難。下次記得用好 DRS，在直道末端晚一點煞車。' }],
    session: base({ kind: 'race', layoutId: 'mirage-sands', startPosition: 20, laps: 6, aiDifficulty: 78 }),
    objective: { kind: 'gainPositions', value: 8 },
  },
  {
    id: 'ch5',
    number: 5,
    title: '港口之夜',
    subtitle: '流明港街道賽・正賽',
    intro: [
      { speaker: NARRATION, text: '流明港的街道在夜裡被上千盞燈點亮。護牆近得像是可以伸手摸到。' },
      { speaker: MENTOR, text: '上一站你吃了兩次賽道界線警告。管理層開始問我，你是不是太衝了。' },
      { speaker: MENTOR, text: '今晚給我一場乾淨的比賽。不切彎、不出界、不碰牆。讓他們閉嘴。' },
    ],
    outroSuccess: [
      { speaker: MENTOR, text: '零罰秒完賽。這是我今年看過最成熟的一場比賽──而它出自一個新人。' },
    ],
    outroFail: [{ speaker: MENTOR, text: '街道賽不會原諒任何貪心。下次寧可慢半拍，也要把四個輪子留在白線內。' }],
    session: base({ kind: 'race', layoutId: 'porto-lumen', startPosition: 9, aiDifficulty: 82 }),
    objective: { kind: 'noPenalties', value: 0 },
  },
  {
    id: 'ch6',
    number: 6,
    title: '嶺上之光',
    subtitle: '高原嶺（反向）・正賽',
    intro: [
      { speaker: NARRATION, text: '季末的高原嶺改以反向佈局進行。天氣預報說，比賽中段可能會下雨，也可能不會。' },
      { speaker: MENTOR, text: '卡德威爾的手腕好了。明年的座位，管理層會看今天的結果決定。' },
      { speaker: MENTOR, text: '我不會跟你說「盡力就好」。我要你站上頒獎台。' },
    ],
    outroSuccess: [
      { speaker: NARRATION, text: '香檳噴灑在高原的風裡。頒獎台下，艾黛兒難得地笑了。' },
      { speaker: MENTOR, text: '合約在我桌上。新星，歡迎正式加入鴉嶺。' },
    ],
    outroFail: [{ speaker: MENTOR, text: '還差一點。但相信我，今天在場的每個人都記住你了。再來一次。' }],
    session: base({ kind: 'race', layoutId: 'highland-ridge-rev', weather: 'dynamic', startPosition: 7, laps: 8, aiDifficulty: 85 }),
    objective: { kind: 'finishAtOrAbove', value: 3 },
  },
];

export const STORY_CHALLENGES: StoryChallenge[] = [
  {
    id: 'c1',
    title: '紅葉髮夾彎',
    description: '計時賽：在紅葉丘陵反向佈局跑出指定時間內的單圈。',
    session: base({ kind: 'timeTrial', layoutId: 'koyo-hills-rev', teamId: 'kestrel' }),
    objective: { kind: 'lapUnder', value: 0, lapFactor: 1.08 },
  },
  {
    id: 'c2',
    title: '暴雨突圍',
    description: '大雨中從最後一位出發，至少超越 10 台車。',
    session: base({ kind: 'race', layoutId: 'porto-lumen-rev', weather: 'heavyRain', startPosition: 20, aiDifficulty: 85, teamId: 'helix' }),
    objective: { kind: 'gainPositions', value: 10 },
  },
  {
    id: 'c3',
    title: '完美主義者',
    description: '在翠島海岸反向佈局完成一場零罰秒的比賽。',
    session: base({ kind: 'race', layoutId: 'isola-verde-rev', startPosition: 8, aiDifficulty: 88, teamId: 'meridian' }),
    objective: { kind: 'noPenalties', value: 0 },
  },
  {
    id: 'c4',
    title: '追獵領跑者',
    description: '從第 6 位出發，完賽時領先瓦爾加（VAR）。',
    session: base({ kind: 'race', layoutId: 'mirage-sands-rev', startPosition: 6, aiDifficulty: 90, teamId: 'aurora' }),
    objective: { kind: 'beatDriver', value: 0, driverId: 'varga' },
  },
  {
    id: 'c5',
    title: '最後三圈',
    description: '只剩 3 圈，從第 5 位出發拿下勝利。',
    session: base({ kind: 'race', layoutId: 'highland-ridge', laps: 3, startPosition: 5, aiDifficulty: 85, teamId: 'kestrel' }),
    objective: { kind: 'finishAtOrAbove', value: 1 },
  },
  {
    id: 'c6',
    title: '夜色單圈',
    description: '2026 規則賽車、流明港夜間單圈排位，挑戰指定時間。',
    session: base({ kind: 'qualifying', layoutId: 'porto-lumen', regulation: '2026', aiDifficulty: 90, teamId: 'nordlys' }),
    // one-shot lap on a night street circuit: a little more slack than the time-trial challenge c1
    objective: { kind: 'lapUnder', value: 0, lapFactor: 1.1 },
  },
];

export function findStoryEntry(id: string): StoryChapter | StoryChallenge | null {
  return STORY_CHAPTERS.find((c) => c.id === id) ?? STORY_CHALLENGES.find((c) => c.id === id) ?? null;
}

export function isChapter(entry: StoryChapter | StoryChallenge): entry is StoryChapter {
  return 'intro' in entry;
}

// ───────────────────────────── objectives ─────────────────────────────

/** Fallback reference lap (s) if the layout cannot be built. */
const FALLBACK_REFERENCE_LAP = 95;

function nameOf(driverId: string, drivers: readonly DriverDef[]): string {
  const d = drivers.find((x) => x.id === driverId) ?? DRIVERS.find((x) => x.id === driverId);
  return d ? `${driverName(d)}（${d.abbr}）` : driverId;
}

/** zh-TW objective text. */
export function objectiveText(o: Omit<StoryObjective, 'text'>, drivers: readonly DriverDef[] = DRIVERS): string {
  switch (o.kind) {
    case 'finishAtOrAbove':
      return o.value <= 1 ? '贏得比賽' : o.value === 3 ? '站上頒獎台（前 3 名完賽）' : `以第 ${o.value} 名或更好的成績完賽`;
    case 'gainPositions':
      return `比發車位置至少前進 ${o.value} 名並完賽`;
    case 'beatDriver':
      return `完賽名次領先 ${nameOf(o.driverId ?? '', drivers)}`;
    case 'lapUnder':
      return `跑出 ${formatLapTime(o.value)} 以內的有效單圈`;
    case 'noPenalties':
      return '完賽且沒有任何罰秒';
  }
}

/** Concrete objective for a template; lapUnder uses the layout's reference lap time. */
export function resolveObjective(t: ObjectiveTemplate, referenceLapTime: number | null): StoryObjective {
  let value = Number.isFinite(t.value) ? t.value : 0;
  if (t.kind === 'lapUnder') {
    const ref = referenceLapTime !== null && Number.isFinite(referenceLapTime) && referenceLapTime > 0 ? referenceLapTime : FALLBACK_REFERENCE_LAP;
    value = Math.ceil(ref * (t.lapFactor ?? 1.1) * 10) / 10;
  }
  const objective: Omit<StoryObjective, 'text'> = { kind: t.kind, value, ...(t.driverId ? { driverId: t.driverId } : {}) };
  return { ...objective, text: objectiveText(objective) };
}

/** Whether player 0 met the objective in this result. */
export function evaluateObjective(objective: StoryObjective, result: SessionResult): boolean {
  const row = result.rows.find((r) => r.playerIndex === 0);
  if (!row) return false;
  const finished = row.status !== 'retired' && row.disqualified !== true && row.position >= 1;
  switch (objective.kind) {
    case 'finishAtOrAbove':
      return finished && row.position <= objective.value;
    case 'gainPositions':
      return finished && row.gridPosition > 0 && row.gridPosition - row.position >= objective.value;
    case 'beatDriver': {
      if (!finished) return false;
      const other = result.rows.find((r) => r.driverId === objective.driverId);
      return !other || other.status === 'retired' || row.position < other.position;
    }
    case 'lapUnder': {
      const best = row.bestLap ?? (result.kind !== 'race' ? row.time : null);
      return best !== null && Number.isFinite(best) && best > 0 && best <= objective.value;
    }
    case 'noPenalties':
      return finished && row.penaltySec <= 0;
  }
}

// ───────────────────────────── sessions ─────────────────────────────

/** The story always runs on the built-in fictional roster, whatever roster pack is active. */
export function storyRoster(teamId: string): Roster {
  const driver = createPlayerDriver(STORY_IDENTITY, teamId, ratingToSkill(INITIAL_RATING));
  return rosterWithReplacement(teamId, driver, builtinRoster()).roster;
}

export function storyRequest(
  entry: StoryChapter | StoryChallenge,
  objective: StoryObjective,
  player: { assists: Assists; setup: CarSetup; startCompound: TireCompound | null },
  seed: number,
): SessionRequest {
  const s = entry.session;
  const roster = storyRoster(s.teamId);
  const me = roster.drivers.find((d) => d.id === 'player');
  return {
    mode: 'story',
    kind: s.kind,
    layoutId: s.layoutId,
    raceLaps: s.laps,
    weather: s.weather,
    timeOfDay: s.timeOfDay,
    regulation: s.regulation,
    aiDifficulty: s.aiDifficulty,
    qualifying: s.qualifying,
    rules: { ...DEFAULT_RULES },
    seed,
    players: [
      {
        playerIndex: 0,
        driverId: 'player',
        teamId: me ? me.teamId : s.teamId,
        setup: { ...player.setup },
        assists: { ...player.assists },
        startCompound: player.startCompound,
      },
    ],
    roster,
    aiCount: null,
    gridOrder: null,
    playerStartPosition: s.kind === 'race' ? s.startPosition : null,
    ghost: null,
    objective,
  };
}

// ───────────────────────────── progress ─────────────────────────────

export interface ChallengeRecord {
  completed: boolean;
  attempts: number;
  /** best finishing position (race) */
  bestPosition: number | null;
  /** best lap (s) */
  bestLap: number | null;
}

export interface StoryProgress {
  /** completed chapter ids */
  completed: string[];
  challenges: Record<string, ChallengeRecord>;
}

export function emptyStoryProgress(): StoryProgress {
  return { completed: [], challenges: {} };
}

/** Chapter n is playable once chapter n-1 is completed. */
export function isChapterUnlocked(progress: StoryProgress, chapterIndex: number): boolean {
  if (chapterIndex <= 0) return true;
  const prev = STORY_CHAPTERS[chapterIndex - 1];
  return prev !== undefined && progress.completed.includes(prev.id);
}

export function isStoryComplete(progress: StoryProgress): boolean {
  return STORY_CHAPTERS.every((c) => progress.completed.includes(c.id));
}

/** Record an attempt of a chapter / challenge. */
export function recordStoryAttempt(progress: StoryProgress, id: string, met: boolean, result: SessionResult): StoryProgress {
  const next: StoryProgress = { completed: [...progress.completed], challenges: { ...progress.challenges } };
  if (STORY_CHAPTERS.some((c) => c.id === id)) {
    if (met && !next.completed.includes(id)) next.completed.push(id);
    return next;
  }
  if (!STORY_CHALLENGES.some((c) => c.id === id)) return next;
  const row = result.rows.find((r) => r.playerIndex === 0);
  const prev = next.challenges[id] ?? { completed: false, attempts: 0, bestPosition: null, bestLap: null };
  const pos = row && row.status !== 'retired' && row.disqualified !== true && result.kind === 'race' ? row.position : null;
  const lap = row ? (row.bestLap ?? null) : null;
  next.challenges[id] = {
    completed: prev.completed || met,
    attempts: prev.attempts + 1,
    bestPosition: pos !== null && (prev.bestPosition === null || pos < prev.bestPosition) ? pos : prev.bestPosition,
    bestLap: lap !== null && Number.isFinite(lap) && (prev.bestLap === null || lap < prev.bestLap) ? lap : prev.bestLap,
  };
  return next;
}

export function sanitizeStoryProgress(v: unknown): StoryProgress {
  if (!isRecord(v)) return emptyStoryProgress();
  const completed = Array.isArray(v.completed)
    ? v.completed.filter((id): id is string => typeof id === 'string' && STORY_CHAPTERS.some((c) => c.id === id))
    : [];
  const challenges: Record<string, ChallengeRecord> = {};
  for (const [id, raw] of Object.entries(asRecord(v.challenges))) {
    if (!STORY_CHALLENGES.some((c) => c.id === id)) continue;
    const r = asRecord(raw);
    challenges[id] = {
      completed: bool(r.completed, false),
      attempts: int(r.attempts, 0, 99999, 0),
      bestPosition: typeof r.bestPosition === 'number' ? int(r.bestPosition, 1, 30, 1) : null,
      bestLap: typeof r.bestLap === 'number' && Number.isFinite(r.bestLap) && r.bestLap > 0 ? num(r.bestLap, 1, 9999, 1) : null,
    };
  }
  return { completed: [...new Set(completed)], challenges };
}
