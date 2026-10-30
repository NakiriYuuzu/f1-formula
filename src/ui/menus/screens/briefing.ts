/**
 * Pre-session briefing: track preview, conditions, distance / time limit, grid slot, objective and weekend
 * progress. Car setup is reachable here before every session; "start" builds and validates the SessionConfig.
 */
import type { SessionConfig } from '../../../core/types';
import { COMPOUND_INFO } from '../../../core/defaults';
import { formatLapTime } from '../../../core/math';
import type { SessionContext } from '../../../meta/context';
import { detectAssistPreset, findLayout, type WeekendStep } from '../../../meta/options';
import { buildSessionConfig, validateSessionConfig, type SessionRequest } from '../../../meta/sessionBuilder';
import { h } from '../dom';
import {
  difficultyLabel,
  kindLabel,
  KIND_LABEL,
  minutesLabel,
  MODE_LABEL,
  PRESET_LABEL,
  SAFETY_CAR_LABEL,
  STEP_LABEL,
  timeLabel,
  weatherLabel,
} from '../labels';
import { minimapCanvas } from '../minimap';
import { Screen, type Host } from '../screen';
import { button, heading, infoLine, panel } from '../widgets';
import { CarSetupScreen } from './carSetup';

export class BriefingScreen extends Screen {
  readonly title: string;
  private readonly request: SessionRequest;
  private readonly infoEl: HTMLElement;
  private readonly startBtn: HTMLButtonElement;

  constructor(
    host: Host,
    request: SessionRequest,
    private readonly ctx: SessionContext,
    private readonly fromResults: boolean,
  ) {
    super(host, { layout: 'panel', className: 'nvm-briefing' });
    this.request = structuredClone(request);
    // time trial: mode and session share one label (avoid '計時賽・計時賽')
    const modeLabel = ctx.returnTo === 'online' ? '線上多人' : MODE_LABEL[request.mode];
    this.title = modeLabel === KIND_LABEL[request.kind] ? modeLabel : `${modeLabel}・${kindLabel(request.kind, request.sprint)}`;
    const layout = findLayout(request.layoutId);
    this.infoEl = h('div', { class: 'nvm-briefing__info' });
    this.startBtn = button({ label: `開始${kindLabel(request.kind, request.sprint)}`, variant: 'primary', onClick: () => this.start() });
    // online: the host sets up its own car only (the guests' setups come from their own computers)
    const online = ctx.returnTo === 'online';
    const editable = online ? this.request.players.filter((p) => p.playerIndex === 0) : this.request.players;
    const setupButtons = editable.map((p) =>
      button({
        label: editable.length > 1 ? `賽車設定（P${p.playerIndex + 1}）` : '賽車設定',
        onClick: () => {
          const weather = this.preview()?.weather ?? 'clear';
          this.host.push(new CarSetupScreen(this.host, p, this.request.layoutId, this.request.kind, weather, editable.length > 1 ? `P${p.playerIndex + 1}` : '', { online }));
        },
      }),
    );
    const sessions = [request.sprint === true && request.kind === 'race' ? 'sprint' : request.kind, ...ctx.weekendQueue] as WeekendStep[];
    this.el.append(
      h(
        'div',
        { class: 'nvm-wide' },
        heading(layout ? layout.displayName : request.layoutId, `${MODE_LABEL[request.mode]}・節次簡報`),
        h(
          'div',
          { class: 'nvm-columns' },
          h(
            'div',
            { class: 'nvm-stack' },
            panel(null, h('div', { class: 'nvm-briefing__map' }, minimapCanvas(request.layoutId, 420, 260, { lineWidth: 4 }))),
            sessions.length > 1
              ? panel(
                  '週末流程',
                  h(
                    'div',
                    { class: 'nvm-steps' },
                    sessions.map((k, i) => h('span', { class: `nvm-steps__item${i === 0 ? ' is-current' : ''}`, text: STEP_LABEL[k] })),
                  ),
                )
              : null,
          ),
          h(
            'div',
            { class: 'nvm-stack' },
            panel(kindLabel(request.kind, request.sprint), this.infoEl),
            panel(null, h('div', { class: 'nvm-actions nvm-actions--column' }, this.startBtn, setupButtons, button({ label: '返回', back: true, onClick: () => this.leave() }))),
          ),
        ),
      ),
    );
  }

  override initialFocus(): HTMLElement {
    return this.startBtn;
  }

  override onEnter(): void {
    this.renderInfo();
  }

  override onBack(): boolean {
    if (!this.fromResults) return false;
    this.leave();
    return true;
  }

  private leave(): void {
    if (!this.fromResults) {
      this.host.pop();
      return;
    }
    this.host.confirm('離開這個週末？', '尚未進行的節次將會取消，生涯進度不會推進。', () => this.host.goHome(this.ctx.returnTo), '離開');
  }

  private preview(): SessionConfig | null {
    try {
      return buildSessionConfig(this.request);
    } catch {
      return null;
    }
  }

  private renderInfo(): void {
    const config = this.preview();
    if (!config) {
      this.infoEl.replaceChildren(h('p', { class: 'nvm-empty', text: '賽道資料尚未載入，無法開始節次。' }));
      this.startBtn.disabled = true;
      return;
    }
    this.startBtn.disabled = false;
    const lines: HTMLElement[] = [];
    lines.push(infoLine('天氣', this.request.weather === 'dynamic' ? `動態天氣（起始：${weatherLabel(config.weather)}）` : weatherLabel(config.weather)));
    lines.push(infoLine('時段', timeLabel(config.timeOfDay)));
    if (config.kind === 'race') lines.push(infoLine('比賽長度', config.sprint ? `${config.laps} 圈（衝刺賽，無強制進站）` : `${config.laps} 圈`));
    else if (config.kind === 'qualifying' && config.timeLimit !== null) {
      lines.push(infoLine('排位形式', `${minutesLabel(config.timeLimit)}・最多 ${config.qualifyingLaps} 個計時圈`));
    } else if (config.timeLimit !== null) lines.push(infoLine('時間', minutesLabel(config.timeLimit)));
    else lines.push(infoLine('時間', '不限時間'));
    lines.push(infoLine('規則年份', `${config.regulation} 規則`));
    if (config.kind === 'race' || config.kind === 'qualifying') {
      lines.push(infoLine('AI 難度', `${config.aiDifficulty}（${difficultyLabel(config.aiDifficulty)}）`));
    }
    if (config.kind === 'race') lines.push(infoLine('參賽車輛', `${config.grid.length} 台`));
    for (const p of config.players) {
      const slot = config.grid.findIndex((g) => g.driverId === p.driverId);
      const entry = config.grid[slot];
      const who = config.players.length > 1 ? `P${p.playerIndex + 1} ` : '';
      const driver = config.drivers.find((d) => d.id === p.driverId);
      lines.push(infoLine(`${who}車手`, driver ? `${driver.firstName} ${driver.lastName}・#${driver.number}` : p.driverId));
      if (config.kind === 'race' && slot >= 0) lines.push(infoLine(`${who}發車位置`, `P${slot + 1}`));
      if (entry) lines.push(infoLine(`${who}起步輪胎`, COMPOUND_INFO[entry.startCompound].label));
      lines.push(infoLine(`${who}駕駛輔助`, PRESET_LABEL[detectAssistPreset(p.assists)]));
    }
    if (config.kind === 'timeTrial') lines.push(infoLine('幽靈車', config.ghost ? `個人最佳 ${formatLapTime(config.ghost.lapTime)}` : '無'));
    if (config.kind === 'race') {
      const rc = [`安全車 ${SAFETY_CAR_LABEL[config.rules.safetyCar ?? 'off']}`];
      if (config.rules.redFlags === true) rc.push('紅旗');
      if (config.rules.formationLap === true) rc.push('暖胎圈');
      lines.push(infoLine('賽事管制', rc.join('・')));
      lines.push(infoLine('空氣動力尾流', config.rules.aeroWake === false ? '關閉' : '擬真'));
    }
    if (config.rules.flashbacks !== 0) lines.push(infoLine('回溯', config.rules.flashbacks < 0 ? '無限次' : `${config.rules.flashbacks} 次`));
    const objective = config.objective
      ? h('div', { class: 'nvm-objective' }, h('span', { class: 'nvm-objective__k', text: '目標' }), h('span', { class: 'nvm-objective__v', text: config.objective.text }))
      : null;
    this.infoEl.replaceChildren(...lines, ...(objective ? [objective] : []));
  }

  private start(): void {
    let config: SessionConfig;
    try {
      config = buildSessionConfig(this.request);
    } catch (err) {
      console.error('[menus] buildSessionConfig failed', err);
      this.host.sound('error');
      this.host.toast('賽道資料尚未載入，無法開始節次', 'bad');
      return;
    }
    const problems = validateSessionConfig(config);
    if (problems.length > 0) {
      console.error('[menus] invalid session config', problems);
      this.host.sound('error');
      this.host.toast('節次設定無效，請返回重新選擇', 'bad');
      return;
    }
    const plan = this.ctx.plan
      ? {
          ...this.ctx.plan,
          request: {
            ...this.ctx.plan.request,
            players: this.ctx.plan.request.players.map((p) => {
              const mine = this.request.players.find((x) => x.playerIndex === p.playerIndex);
              return mine ? { ...p, setup: { ...mine.setup } } : p;
            }),
          },
        }
      : undefined;
    this.host.startSession(config, { ...this.ctx, ...(plan ? { plan } : {}) });
  }
}
