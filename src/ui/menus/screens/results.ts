/**
 * Session results: full classification (race: laps, time / gap, best lap, stops, penalties, points; timed
 * sessions: best lap & gap incl. simulated AI qualifying times), fastest lap, objective outcome, progress notes,
 * podium in the 3D background for races, and next steps (next session / replay / continue).
 */
import type { CarStatus, DriverDef, SessionResult, TeamDef, WorldState } from '../../../core/types';
import { formatGap, formatLapTime } from '../../../core/math';
import type { SessionContext } from '../../../meta/context';
import type { ProgressOutcome } from '../../../meta/progression';
import { findLayout } from '../../../meta/options';
import { driverName } from '../../../meta/roster';
import { pointsForRow } from '../../../meta/season';
import { requestForKind, requestFromConfig, type QualifyingEntry } from '../../../meta/sessionBuilder';
import { STORY_CHAPTERS } from '../../../meta/story';
import { achievementDef } from '../../../meta/achievements';
import { h } from '../dom';
import { kindLabel, MODE_LABEL, STEP_LABEL, weatherLabel } from '../labels';
import { Screen, type Host, type StageRequest } from '../screen';
import { showroomCar } from '../showroom';
import type { ShowroomCar } from '../types';
import { button, heading, scrollRegion, teamChip } from '../widgets';
import { BriefingScreen } from './briefing';
import { MainMenuScreen } from './mainMenu';
import { StoryScreen } from './story';
import { StoryCardsScreen } from './storyCards';

export interface ResultsData {
  result: SessionResult;
  world: WorldState;
  ctx: SessionContext;
  onReplay: (() => void) | null;
  outcome: ProgressOutcome;
  /** qualifying classification incl. simulated AI times */
  qualifying: QualifyingEntry[] | null;
}

interface DisplayRow {
  position: string;
  driverId: string;
  teamId: string;
  carId: number;
  human: boolean;
  cells: string[];
  fastest: boolean;
}

const STATUS_TEXT: Partial<Record<CarStatus, string>> = { retired: '退賽' };

export class ResultsScreen extends Screen {
  readonly title: string;
  private readonly primaryBtn: HTMLButtonElement;
  private readonly podiumCars: ShowroomCar[];

  constructor(
    host: Host,
    private readonly d: ResultsData,
  ) {
    const race = d.result.kind === 'race';
    super(host, { layout: race ? 'showroom' : 'panel', className: `nvm-results${race ? ' nvm-results--race' : ''}` });
    const { result, world, ctx, outcome } = d;
    this.title = `${kindLabel(result.kind, result.sprint)}成績`;
    const layout = findLayout(result.layoutId);
    this.podiumCars = race ? this.buildPodium() : [];

    const nextKind = ctx.weekendQueue[0];
    const nextBtn = nextKind ? button({ label: `下一節：${STEP_LABEL[nextKind]}`, variant: 'primary', onClick: () => this.goNext() }) : null;
    const continueBtn = button({ label: '繼續', variant: nextBtn ? 'ghost' : 'primary', onClick: () => this.continue() });
    const replayBtn = d.onReplay ? button({ label: '觀看重播', onClick: () => d.onReplay?.() }) : null;
    this.primaryBtn = nextBtn ?? continueBtn;

    const banner =
      outcome.objectiveMet !== null
        ? h(
            'div',
            { class: `nvm-banner ${outcome.objectiveMet ? 'is-good' : 'is-bad'}` },
            h('b', { text: outcome.objectiveMet ? '目標達成' : '目標未達成' }),
            h('span', { text: world.config.objective ? world.config.objective.text : '' }),
          )
        : null;
    const notes = [...outcome.notes, ...outcome.newAchievements.map((id) => `成就解鎖：${achievementDef(id).title}`)];
    const fastest = this.fastestLine();
    this.el.append(
      h(
        'div',
        { class: race ? 'nvm-results__col' : 'nvm-wide' },
        heading(this.title, `${ctx.returnTo === 'online' ? '線上多人' : MODE_LABEL[result.mode]}・${layout ? layout.displayName : result.layoutId}・${weatherLabel(result.weather)}`),
        banner,
        notes.length > 0 ? h('ul', { class: 'nvm-notes' }, notes.map((n) => h('li', { text: n }))) : null,
        scrollRegion(this.table()),
        fastest ? h('p', { class: 'nvm-results__fastest', text: fastest }) : null,
        h('div', { class: 'nvm-actions nvm-actions--bar' }, nextBtn, replayBtn, continueBtn),
      ),
    );
  }

  override stage(): StageRequest {
    return this.podiumCars.length > 0 ? { kind: 'podium', cars: this.podiumCars } : { kind: 'none' };
  }

  override initialFocus(): HTMLElement {
    return this.primaryBtn;
  }

  override onBack(): boolean {
    this.continue();
    return true;
  }

  // ───────────────────────────── data ─────────────────────────────

  private driver(id: string): DriverDef | undefined {
    return this.d.world.config.drivers.find((x) => x.id === id);
  }

  private team(id: string): TeamDef | undefined {
    return this.d.world.config.teams.find((t) => t.id === id);
  }

  private carColor(carId: number, teamId: string): string {
    const car = carId >= 0 ? this.d.world.cars[carId] : undefined;
    return car ? car.livery.primary : (this.team(teamId)?.livery.primary ?? '#888888');
  }

  private buildPodium(): ShowroomCar[] {
    return [...this.d.result.rows]
      .filter((r) => r.status !== 'retired' && r.position >= 1)
      .sort((a, b) => a.position - b.position)
      .slice(0, 3)
      .map((r) => {
        const car = r.carId >= 0 ? this.d.world.cars[r.carId] : undefined;
        const team = this.team(r.teamId);
        const base = { ...showroomCar(team, this.driver(r.driverId)), regulation: this.d.world.config.regulation };
        return car ? { ...base, livery: { ...car.livery }, number: car.number } : base;
      });
  }

  private rows(): DisplayRow[] {
    const { result, qualifying } = this.d;
    if (result.kind === 'race') {
      return [...result.rows]
        .sort((a, b) => a.position - b.position)
        .map((r) => {
          const timeText = r.position === 1 && r.time !== null && r.status !== 'retired' ? formatLapTime(r.time) : r.gapText || STATUS_TEXT[r.status] || '—';
          const pts = pointsForRow(r, result.sprint === true);
          return {
            position: r.status === 'retired' ? 'DNF' : String(r.position),
            driverId: r.driverId,
            teamId: r.teamId,
            carId: r.carId,
            human: r.playerIndex >= 0,
            fastest: r.fastestLap,
            cells: [
              String(r.lapsCompleted),
              timeText,
              formatLapTime(r.bestLap),
              String(r.pitStops),
              r.penaltySec > 0 ? `+${r.penaltySec} 秒` : '—',
              pts > 0 ? String(pts) : '—',
            ],
          };
        });
    }
    const entries =
      qualifying ??
      [...result.rows]
        .sort((a, b) => a.position - b.position)
        .map<QualifyingEntry>((r) => ({
          driverId: r.driverId,
          teamId: r.teamId,
          time: r.time ?? r.bestLap,
          carId: r.carId,
          playerIndex: r.playerIndex,
          simulated: false,
        }));
    const best = entries.find((e) => e.time !== null)?.time ?? null;
    const fastestId = best !== null ? entries.find((e) => e.time === best)?.driverId : undefined;
    return entries.map((e, i) => {
      const row = result.rows.find((r) => r.driverId === e.driverId);
      return {
        position: String(i + 1),
        driverId: e.driverId,
        teamId: e.teamId,
        carId: e.carId,
        human: e.playerIndex >= 0,
        fastest: e.driverId === fastestId,
        cells: [
          e.time !== null ? formatLapTime(e.time) : '無有效圈',
          e.time === null || best === null || i === 0 ? '—' : formatGap(e.time - best),
          row ? String(row.lapsCompleted) : '—',
        ],
      };
    });
  }

  private table(): HTMLElement {
    const race = this.d.result.kind === 'race';
    const head = race ? ['名次', '車手', '車隊', '圈數', '時間／差距', '最快圈', '進站', '罰秒', '積分'] : ['名次', '車手', '車隊', '最快圈', '差距', '圈數'];
    return h(
      'table',
      { class: 'nvm-table nvm-table--results' },
      h('thead', null, h('tr', null, head.map((t) => h('th', { text: t })))),
      h(
        'tbody',
        null,
        this.rows().map((r) => {
          const dr = this.driver(r.driverId);
          const team = this.team(r.teamId);
          const fastestCol = race ? 2 : 0;
          return h(
            'tr',
            { class: r.human ? 'is-me' : '' },
            h('td', { class: 'nvm-table__pos', text: r.position }),
            h('td', null, dr ? driverName(dr) : r.driverId, dr ? h('small', { text: ` ${dr.abbr}` }) : null),
            h('td', null, teamChip(this.carColor(r.carId, r.teamId)), team ? team.shortName : '—'),
            r.cells.map((c, i) => h('td', { class: i === fastestCol && r.fastest ? 'is-fastest' : '', text: c })),
          );
        }),
      ),
    );
  }

  private fastestLine(): string | null {
    const fl = this.d.result.fastestLap;
    if (!fl) return null;
    const row = this.d.result.rows.find((r) => r.carId === fl.carId);
    const dr = row ? this.driver(row.driverId) : undefined;
    return `最快圈：${dr ? driverName(dr) : '—'}　${formatLapTime(fl.time)}（第 ${fl.lap} 圈）`;
  }

  // ───────────────────────────── navigation ─────────────────────────────

  private goNext(): void {
    const { ctx, world, result, qualifying } = this.d;
    const [next, ...rest] = ctx.weekendQueue;
    if (!next) return;
    const plan = ctx.plan ?? { request: requestFromConfig(world.config), qualifyingOrder: null };
    const qualifyingOrder = result.kind === 'qualifying' && qualifying ? qualifying.map((q) => q.driverId) : plan.qualifyingOrder;
    const request = requestForKind(plan.request, next, qualifyingOrder);
    request.players = request.players.map((p) => {
      const slot = world.config.players.find((s) => s.playerIndex === p.playerIndex);
      return slot ? { ...p, setup: { ...slot.setup } } : p;
    });
    const nextCtx: SessionContext = { ...ctx, weekendQueue: rest, plan: { request: plan.request, qualifyingOrder } };
    this.host.reset([new BriefingScreen(this.host, request, nextCtx, true)]);
  }

  private continue(): void {
    const { ctx } = this.d;
    if (ctx.weekendQueue.length > 0) {
      this.host.confirm('結束這個週末？', '尚未進行的節次將會取消，生涯進度不會推進。', () => this.leave(), '結束週末');
      return;
    }
    this.leave();
  }

  private leave(): void {
    this.host.resultsClosed();
    const { ctx, outcome } = this.d;
    const chapter = ctx.storyId ? STORY_CHAPTERS.find((c) => c.id === ctx.storyId) : undefined;
    if (chapter && ctx.weekendQueue.length === 0) {
      const cards = outcome.objectiveMet ? chapter.outroSuccess : chapter.outroFail;
      const host = this.host;
      host.reset([
        new MainMenuScreen(host),
        new StoryScreen(host),
        new StoryCardsScreen(host, `第 ${chapter.number} 章　${chapter.title}`, cards, 'outro', () => host.pop()),
      ]);
      return;
    }
    this.host.goHome(ctx.returnTo);
  }
}
