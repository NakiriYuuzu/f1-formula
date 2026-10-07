/**
 * 新星之路: chapter list (sequential unlock) and challenges (挑戰賽), narrative card player, and the launch flow
 * that resolves each objective (lap targets use the layout's reference lap, scaled to the regulation's pace)
 * before the briefing.
 */
import { formatLapTime } from '../../../core/math';
import { getLayout } from '../../../data/tracks';
import { findLayout } from '../../../meta/options';
import { qualiCalibration } from '../../../race/index';
import { loadProfile, loadSetup, loadStory } from '../../../meta/save';
import {
  isChapterUnlocked,
  objectiveText,
  resolveObjective,
  STORY_CHALLENGES,
  STORY_CHAPTERS,
  storyRequest,
  type ObjectiveTemplate,
  type StoryChallenge,
  type StoryChapter,
  type StoryProgress,
} from '../../../meta/story';
import { h, setChildren } from '../dom';
import { launchWeekend } from '../flow';
import { KIND_LABEL, weatherLabel } from '../labels';
import { Screen, type Host } from '../screen';
import { button, heading, tabs } from '../widgets';
import { StoryCardsScreen } from './storyCards';

function templateText(t: ObjectiveTemplate): string {
  if (t.kind === 'lapUnder') return '跑出指定時間內的有效單圈';
  return objectiveText({ kind: t.kind, value: t.value, ...(t.driverId ? { driverId: t.driverId } : {}) });
}

function sessionLine(entry: StoryChapter | StoryChallenge): string {
  const s = entry.session;
  const layout = findLayout(s.layoutId);
  const parts = [layout ? layout.displayName : s.layoutId, KIND_LABEL[s.kind], weatherLabel(s.weather)];
  if (s.kind === 'race') parts.push(`${s.laps} 圈`);
  if (s.kind === 'race' && s.startPosition !== null) parts.push(`第 ${s.startPosition} 位發車`);
  return parts.join('・');
}

/** Resolve the objective and open the briefing of a chapter / challenge. */
export function launchStoryEntry(host: Host, entry: StoryChapter | StoryChallenge): void {
  let reference: number | null = null;
  if (entry.objective.kind === 'lapUnder') {
    const s = entry.session;
    try {
      // the reference lap is a 2025-class car: scale by the same regulation pace the race module uses
      const pace = qualiCalibration(s.aiDifficulty, s.regulation) / qualiCalibration(s.aiDifficulty, '2025');
      reference = getLayout(s.layoutId).referenceLapTime * pace;
    } catch {
      reference = null;
    }
  }
  const objective = resolveObjective(entry.objective, reference);
  const profile = loadProfile();
  const request = storyRequest(entry, objective, { assists: profile.assists, setup: loadSetup(entry.session.layoutId), startCompound: null }, Date.now() >>> 0);
  launchWeekend(host, request, [entry.session.kind], { returnTo: 'story', round: null, storyId: entry.id });
}

export class StoryScreen extends Screen {
  readonly title = '新星之路';
  private progress: StoryProgress;
  private tab: 'chapters' | 'challenges' = 'chapters';
  private readonly body: HTMLElement;
  private readonly tabBar: ReturnType<typeof tabs>;

  constructor(host: Host) {
    super(host, { layout: 'panel', className: 'nvm-story' });
    this.progress = loadStory();
    this.body = h('div', { class: 'nvm-story__grid' });
    this.tabBar = tabs(
      [
        { id: 'chapters', label: '劇情章節' },
        { id: 'challenges', label: '挑戰賽' },
      ],
      this.tab,
      (id) => {
        this.tab = id === 'challenges' ? 'challenges' : 'chapters';
        this.render();
      },
    );
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading('新星之路', '原創劇情：鴉嶺車隊新人的第一個賽季'),
        this.tabBar.el,
        this.body,
        h('div', { class: 'nvm-actions nvm-actions--bar' }, button({ label: '返回', back: true, onClick: () => this.host.pop() })),
      ),
    );
  }

  override onEnter(): void {
    this.progress = loadStory();
    this.render();
  }

  private render(): void {
    if (this.tab === 'chapters') {
      setChildren(
        this.body,
        STORY_CHAPTERS.map((chapter, i) => {
          const unlocked = isChapterUnlocked(this.progress, i);
          const done = this.progress.completed.includes(chapter.id);
          return h(
            'button',
            {
              class: `nvm-story__card${done ? ' is-done' : ''}${unlocked ? '' : ' is-locked'}`,
              attrs: { type: 'button', disabled: !unlocked, 'data-sound': 'confirm' },
              on: {
                click: () =>
                  this.host.push(
                    new StoryCardsScreen(this.host, `第 ${chapter.number} 章　${chapter.title}`, chapter.intro, 'intro', () => {
                      this.host.pop();
                      launchStoryEntry(this.host, chapter);
                    }),
                  ),
              },
            },
            h('span', { class: 'nvm-story__no', text: `CH.${chapter.number}` }),
            h('span', { class: 'nvm-story__title', text: chapter.title }),
            h('span', { class: 'nvm-story__sub', text: chapter.subtitle }),
            h('span', { class: 'nvm-story__goal', text: unlocked ? `目標：${templateText(chapter.objective)}` : '完成上一章後解鎖' }),
            h('span', { class: 'nvm-story__status', text: done ? '已完成' : unlocked ? '可遊玩' : '未解鎖' }),
          );
        }),
      );
      return;
    }
    setChildren(
      this.body,
      STORY_CHALLENGES.map((c) => {
        const rec = this.progress.challenges[c.id];
        const best = rec
          ? [rec.bestPosition !== null ? `最佳名次 P${rec.bestPosition}` : '', rec.bestLap !== null ? `最佳圈 ${formatLapTime(rec.bestLap)}` : '', `嘗試 ${rec.attempts} 次`].filter(Boolean).join('・')
          : '尚未挑戰';
        return h(
          'button',
          {
            class: `nvm-story__card nvm-story__card--challenge${rec?.completed ? ' is-done' : ''}`,
            attrs: { type: 'button', 'data-sound': 'confirm' },
            on: { click: () => launchStoryEntry(this.host, c) },
          },
          h('span', { class: 'nvm-story__no', text: '挑戰' }),
          h('span', { class: 'nvm-story__title', text: c.title }),
          h('span', { class: 'nvm-story__sub', text: sessionLine(c) }),
          h('span', { class: 'nvm-story__goal', text: c.description }),
          h('span', { class: 'nvm-story__status', text: rec?.completed ? `已完成・${best}` : best }),
        );
      }),
    );
  }
}
