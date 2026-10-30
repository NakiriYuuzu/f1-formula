/**
 * In-session HUD, pause menu, pit/MFD, notifications (owner: HUD agent). DOM/CSS (+ 2D canvas for minimap), zh-TW.
 * Exported signatures are a CONTRACT used by the App: keep them (you may add members / optional params).
 *
 * Reads WorldState only (never mutates it); every action goes through HudCallbacks. Layout: per-player views
 * (telemetry, timing + live delta, toasts, radio, MFD), timing tower + session/weather strip (top-left),
 * minimap (bottom-left; bottom-centre in split-screen), start lights, phase banners, pause menu (+ 操作說明 controls
 * panel), first-sessions key hints, replay bar, FPS.
 */
import './hud.css';
import type {
  BuiltTrack,
  CameraMode,
  CarEntry,
  ErsMode,
  GameEvent,
  RacingLineMode,
  SessionPhase,
  Settings,
  TireCompound,
  WorldState,
} from '../../core/types';
import { COMPOUND_INFO } from '../../core/defaults';
import { formatLapTime } from '../../core/math';
import { AttrSlot, ShowSlot, TextSlot, el } from './dom';
import { claimHintSession, controlsHelpPages, hintItems, HUD_HINT_SECONDS } from './controls';
import { ControlsHelp } from './controlsHelp';
import { buildGhostTrace } from './delta';
import type { LapTrace } from './delta';
import { Banner } from './feed';
import type { Tone } from './feed';
import {
  CAMERA_LABEL,
  CAMERA_ORDER,
  RACING_LINE_LABEL,
  RACING_LINE_ORDER,
  WEATHER_LABEL,
  fin,
  formatClock,
  NoticeGate,
  pauseKeyOutcome,
  pingLevel,
  pingText,
  safeColor,
  sessionLabel,
  type PingItem,
} from './labels';
import { Minimap } from './minimap';
import { NET_PANEL_KEY, NetPanel, netPanelRows, type NetDiagnostics } from './netPanel';
import { estimatePitLoss } from '../../race/index';
import { RETIRE_BY_CHOICE } from '../../race/index';
import { PauseMenu } from './pauseMenu';
import type { MenuDirection, PauseItem } from './pauseMenu';
import { RaceControlStrip, sectorFlagLabel } from './raceControl';
import { ReplayBar } from './replayBar';
import type { PadMenuInput } from '../../input/gamepad';
import { StartLights } from './startLights';
import { TimingTower } from './tower';
import { keyLabel } from '../menus/labels';
import { ViewHud } from './viewHud';
import { SessionStrip } from './weather';

export type { MenuDirection } from './pauseMenu';
export type { ReplayHandlers } from './replayBar';

export interface HudView {
  playerIndex: 0 | 1;
  carId: number;
  /** full screen, or left/right half in split-screen */
  region: 'full' | 'left' | 'right';
}

export interface HudCallbacks {
  resume(): void;
  restart(): void;
  quit(): void;
  /** opens MenuSystem.openSettingsOverlay */
  openSettings(): void;
  requestPit(carId: number, compound: TireCompound): void;
  cancelPit(carId: number): void;
  setErsMode(carId: number, mode: ErsMode): void;
  setRacingLine(mode: RacingLineMode): void;
  setCamera(playerIndex: 0 | 1, mode: CameraMode): void;
  /** rewind (App handles snapshots); only offered when flashbacksLeft !== 0 */
  flashback(): void;
  /** practice / qualifying / time trial: end session now and go to results */
  endSession(): void;
  /** race: retire that player's car (every human car when omitted) */
  retire(playerIndex?: 0 | 1): void;
}

export interface HudFrameInfo {
  fps: number;
  /** current camera per view */
  cameras: CameraMode[];
  /** -1 = unlimited */
  flashbacksLeft: number;
  racingLine: RacingLineMode;
  /** replay playback active (HUD shows the replay bar instead of driving widgets) */
  replay: { time: number; duration: number; playing: boolean; speed: number } | null;
  /** online round trips: a guest's own link to the host, or the host's link to each connected guest */
  ping?: readonly PingItem[];
  /** online: the links' statistics for the diagnostics panel (asked for only while it is open) */
  net?: () => NetDiagnostics;
}

/** Timed-session warnings (seconds remaining). */
const TIME_WARNINGS = [300, 60];
const FPS_REFRESH = 0.25;
/** Seconds between two refreshes of the open connection diagnostics panel. */
const NET_REFRESH = 0.5;
const RADIO_FALLBACK_COLOR = '#19d3c5';
/**
 * Seconds a crash-out offers the flashback: the 「按 R 回溯」 banner stays this long, and the runtime waits as long
 * before it fast-forwards the rest of the race (SessionRuntime.watchFinish).
 */
export const CRASH_FLASHBACK_OFFER = 15;
/** Keys that close the 操作說明 panel directly (unless bound to 暫停, see handleBack). */
const HELP_CLOSE_KEYS: ReadonlySet<string> = new Set(['Escape', 'Backspace', 'Enter', 'NumpadEnter', 'Space']);

const positionKey = (c: CarEntry): number =>
  Number.isFinite(c.timing.position) && c.timing.position > 0 ? c.timing.position : 1e6;
const byPosition = (a: CarEntry, b: CarEntry): number => positionKey(a) - positionKey(b) || a.id - b.id;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export class HudLayer {
  private readonly rootEl: HTMLElement;
  private readonly views: ViewHud[] = [];
  private readonly viewByCar = new Map<number, ViewHud>();
  private readonly split: boolean;
  private readonly tower: TimingTower;
  private readonly towerShow: ShowSlot;
  private readonly minimap: Minimap;
  private readonly minimapShow: ShowSlot;
  private readonly strip: SessionStrip;
  private readonly lights: StartLights;
  private readonly control: RaceControlStrip;
  private readonly banner: Banner;
  private readonly pause: PauseMenu;
  private readonly help: ControlsHelp;
  private readonly replayBar: ReplayBar;
  private readonly notices = new NoticeGate();
  private readonly fpsText: TextSlot;
  private readonly fpsShow: ShowSlot;
  /** online only: round trip(s) beside the FPS counter */
  private readonly ping: { text: TextSlot; show: ShowSlot; level: AttrSlot } | null = null;
  /** online only: connection diagnostics under the ping (NET_PANEL_KEY) */
  private readonly netPanel: NetPanel | null = null;
  private netOpen = false;
  private netAccum = 0;
  private readonly replayAttr: AttrSlot;
  private settings: Settings;
  private lastInfo: HudFrameInfo | null = null;
  private readonly order: CarEntry[] = [];
  private readonly overallBest: (number | null)[] = [null, null, null];
  private ghost: LapTrace | null = null;
  private ghostResolved = false;
  private lastPhase: SessionPhase | null = null;
  private lastTimeRemaining: number | null = null;
  private fpsAccum = FPS_REFRESH;
  private paused = false;
  private hidden = false;
  private destroyed = false;
  private replayActive = false;
  /** the first-sessions hint strip was considered for this session (once per HUD) */
  private hintsClaimed = false;
  /** view indices with an open MFD, most recently opened last (keyboard shortcuts go there) */
  private mfdOrder: number[] = [];
  private racingLine: RacingLineMode = 'off';
  private readonly cameraSel: (CameraMode | null)[] = [null, null];

  constructor(
    root: HTMLElement,
    private readonly track: BuiltTrack,
    views: HudView[],
    settings: Settings,
    private readonly cb: HudCallbacks,
    /** online session role: no restart; a client cannot end the session for everyone */
    private readonly online: 'host' | 'client' | null = null,
  ) {
    this.settings = settings;
    this.split = views.length > 1;
    this.rootEl = el('div', 'nvh-root', root);
    if (this.split) this.rootEl.dataset.split = '1';
    this.replayAttr = new AttrSlot(this.rootEl, 'data-replay');

    const pitLoss = estimatePitLoss(track);
    for (const v of views) {
      const vh = new ViewHud(this.rootEl, { playerIndex: v.playerIndex, carId: v.carId, region: v.region }, track, pitLoss, {
        requestPit: (carId, compound) => this.cb.requestPit(carId, compound),
        cancelPit: (carId) => this.cb.cancelPit(carId),
        setErsMode: (carId, mode) => this.cb.setErsMode(carId, mode),
      });
      this.views.push(vh);
      if (!this.viewByCar.has(v.carId)) this.viewByCar.set(v.carId, vh);
    }

    const topLeft = el('div', 'nvh-tl', this.rootEl);
    const bottomLeft = el('div', 'nvh-bl', this.rootEl);
    this.strip = new SessionStrip(this.split ? bottomLeft : topLeft, track);
    this.strip.el.classList.add('nvh-panel');
    this.tower = new TimingTower(topLeft);
    this.towerShow = new ShowSlot(this.tower.el);
    this.minimap = new Minimap(bottomLeft, track);
    this.minimapShow = new ShowSlot(this.minimap.el);

    this.lights = new StartLights(this.rootEl);
    this.control = new RaceControlStrip(this.rootEl);
    this.banner = new Banner(this.rootEl);
    this.banner.el.classList.add('nvh-gbanner');
    const topCentre = el('div', 'nvh-topc', this.rootEl);
    const fps = el('div', 'nvh-fps', topCentre);
    this.fpsText = new TextSlot(fps);
    this.fpsShow = new ShowSlot(fps);
    if (online) {
      const ping = el('div', 'nvh-ping', topCentre);
      this.ping = { text: new TextSlot(ping), show: new ShowSlot(ping), level: new AttrSlot(ping, 'data-level') };
      this.netPanel = new NetPanel(topCentre);
    }
    this.replayBar = new ReplayBar(this.rootEl);
    this.pause = new PauseMenu(this.rootEl);
    this.help = new ControlsHelp(this.rootEl, () => this.closeHelp());

    window.addEventListener('keydown', this.onKeyDown);
    this.applySettings(settings);
  }

  /** Per rendered frame. Must be cheap: only touch the DOM when a displayed value changes. */
  update(world: WorldState, dt: number, info: HudFrameInfo): void {
    if (this.destroyed) return;
    const step = Math.min(0.25, Math.max(0, fin(dt)));
    this.lastInfo = info;
    this.syncFromInfo(info);

    this.fpsAccum += step;
    if (this.settings.showFps && this.fpsAccum >= FPS_REFRESH) {
      this.fpsAccum = 0;
      this.fpsText.set(`${Math.max(0, Math.round(fin(info.fps)))} FPS`);
    }
    if (this.ping) {
      const items = info.ping ?? [];
      this.ping.show.set(items.length > 0);
      this.ping.text.set(pingText(items));
      this.ping.level.set(pingLevel(items));
    }
    if (this.netPanel && this.netOpen && info.net) {
      this.netAccum += step;
      if (this.netAccum >= NET_REFRESH) {
        this.netAccum = 0;
        this.netPanel.render(netPanelRows(info.net(), info.fps));
      }
    }

    const replay = info.replay ?? null;
    this.replayActive = replay !== null;
    this.replayAttr.set(replay ? '1' : null);
    this.replayBar.update(replay);
    this.banner.update(step);
    for (const v of this.views) v.tickFeeds(step);
    this.notices.tick(step);
    if (!replay) this.updateSession(world, step);
    if (this.pause.isVisible()) this.pause.refresh();
  }

  /** Notifications/radio/banners for events drained this frame. */
  handleEvents(events: GameEvent[], world: WorldState): void {
    if (this.destroyed) return;
    for (const ev of events) this.routeEvent(ev, world);
  }

  setPaused(paused: boolean, world: WorldState): void {
    if (this.destroyed) return;
    if (!paused) {
      this.paused = false;
      this.help.close();
      this.pause.close();
      return;
    }
    if (this.paused && this.pause.isVisible()) {
      // Already paused (e.g. returning from the settings overlay): just show the menu again.
      if (!this.help.isOpen()) this.pause.suspend(false);
      return;
    }
    this.paused = true;
    const s = world.session;
    const sub = [sessionLabel(s.kind, world.config?.sprint), this.track.displayName].filter(Boolean).join(' · ');
    this.pause.open(this.buildPauseItems(world), sub);
  }

  /** Toggle the pit-strategy / multi-function display for a player. */
  toggleMfd(playerIndex: 0 | 1): void {
    if (this.destroyed) return;
    const idx = this.views.findIndex((v) => v.view.playerIndex === playerIndex);
    if (idx < 0) return;
    const mfd = this.views[idx].mfd;
    mfd.toggle();
    this.mfdOrder = this.mfdOrder.filter((i) => i !== idx);
    if (mfd.isOpen()) this.mfdOrder.push(idx);
  }

  /** Gamepad D-pad left/right for a player's open MFD: previous / next tyre compound. True when consumed. */
  stepMfdCompound(playerIndex: 0 | 1, step: 1 | -1): boolean {
    if (this.destroyed) return false;
    const v = this.views.find((x) => x.view.playerIndex === playerIndex);
    return v ? v.mfd.padStep(step) : false;
  }

  /** The ERS-cycle key does nothing while the ERS assist is on: say so (rate-limited per player). */
  notifyErsAssist(playerIndex: 0 | 1): void {
    if (this.destroyed || !this.notices.fire(playerIndex)) return;
    const v = this.views.find((x) => x.view.playerIndex === playerIndex);
    if (v) v.toast('ERS 輔助開啟中', '模式自動切換', 'info', 2.4);
  }

  /** Gamepad in a replay (A play/pause, D-pad seek / speed). True when consumed. */
  handleReplayPad(input: PadMenuInput): boolean {
    if (this.destroyed || !this.replayActive || this.hidden) return false;
    return this.replayBar.handlePad(input);
  }

  toggleVisible(): void {
    if (this.destroyed) return;
    this.hidden = !this.hidden;
    this.rootEl.toggleAttribute('data-hud-hidden', this.hidden);
  }

  /** Replay bar callbacks (App provides): play/pause, seek (0..1), speed, exit. */
  setReplayHandlers(h: { toggle(): void; seek(t: number): void; speed(x: number): void; camera(): void; exit(): void } | null): void {
    if (this.destroyed) return;
    this.replayBar.setHandlers(h);
  }

  applySettings(settings: Settings): void {
    if (this.destroyed) return;
    this.settings = settings;
    this.fpsShow.set(settings.showFps);
    this.minimapShow.set(settings.hud.minimap);
    if (!settings.hud.radio) for (const v of this.views) v.radio.clear();
    this.pause.setResumeKeys((settings.keyBindings.pause ?? []).map(keyLabel));
    this.help.setBackKeys((settings.keyBindings.pause ?? []).map(keyLabel));
    for (const v of this.views) {
      if (v.hints.isShowing()) v.hints.setItems(hintItems(settings, v.view.playerIndex, this.split));
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    this.minimap.destroy();
    this.rootEl.remove();
    this.views.length = 0;
    this.viewByCar.clear();
    this.order.length = 0;
    this.mfdOrder = [];
  }

  // ───────────── additional public API ─────────────

  /** Compound the player's MFD would fit (for a pit-request key press outside the MFD); null if no such view. */
  getMfdCompound(playerIndex: 0 | 1): TireCompound | null {
    const v = this.views.find((x) => x.view.playerIndex === playerIndex);
    return v ? v.mfd.selectedCompound() : null;
  }

  isMfdOpen(playerIndex: 0 | 1): boolean {
    return this.views.some((v) => v.view.playerIndex === playerIndex && v.mfd.isOpen());
  }

  /** Gamepad navigation of the pause menu / 操作說明 panel (no-op unless one is open). */
  navigateMenu(dir: MenuDirection): void {
    if (this.destroyed) return;
    if (this.help.isOpen()) this.help.navigate(dir);
    else this.pause.navigate(dir);
  }

  /** Gamepad confirm in the pause menu (no-op unless it is open); closes the 操作說明 panel when that is open. */
  activateMenu(): void {
    if (this.destroyed) return;
    if (this.help.isOpen()) this.closeHelp();
    else this.pause.activate();
  }

  /**
   * Back (pause key / gamepad B) while paused: closes the 操作說明 panel and returns true — the App must then stay
   * paused instead of resuming. False when nothing HUD-side was closed.
   */
  handleBack(): boolean {
    if (this.destroyed || !this.help.isOpen()) return false;
    this.closeHelp();
    return true;
  }

  /** The pause key / pad B: 'pause' when running, otherwise 'stay' (the 操作說明 panel just closed) or 'resume'. */
  onPauseKey(paused: boolean): 'pause' | 'resume' | 'stay' {
    return pauseKeyOutcome(paused, () => this.handleBack());
  }

  /** Call when the settings overlay opened from the pause menu closes: the pause menu takes input again. */
  onSettingsClosed(): void {
    if (!this.destroyed && this.paused) this.pause.suspend(false);
  }

  /** Switch the timing tower between interval and gap-to-leader. */
  toggleTowerMode(): void {
    if (!this.destroyed) this.tower.toggleMode();
  }

  // ───────────── internals ─────────────

  private openHelp(): void {
    this.pause.suspend(true);
    this.help.open(controlsHelpPages(this.settings, this.split));
    // the full list is on screen now: the first-sessions strip has done its job
    for (const v of this.views) v.hints.dismiss();
  }

  private closeHelp(): void {
    if (!this.help.isOpen()) return;
    this.help.close();
    if (this.paused) this.pause.suspend(false);
  }

  /** Session start (lights out / timed-session start): essential-keys strip for the first HUD_HINT_SESSIONS sessions. */
  private startHints(): void {
    if (this.hintsClaimed || this.replayActive) return;
    this.hintsClaimed = true;
    if (!claimHintSession()) return;
    for (const v of this.views) v.hints.start(hintItems(this.settings, v.view.playerIndex, this.split), HUD_HINT_SECONDS);
  }

  private syncFromInfo(info: HudFrameInfo): void {
    if (RACING_LINE_ORDER.includes(info.racingLine)) this.racingLine = info.racingLine;
    const cams = Array.isArray(info.cameras) ? info.cameras : [];
    for (let i = 0; i < this.views.length; i++) {
      const cam = cams[i];
      if (cam && CAMERA_ORDER.includes(cam)) this.cameraSel[this.views[i].view.playerIndex] = cam;
    }
  }

  private updateSession(world: WorldState, dt: number): void {
    const order = this.order;
    order.length = 0;
    for (const c of world.cars) order.push(c);
    order.sort(byPosition);
    for (let i = 0; i < 3; i++) {
      // world bests also hold the simulated AI benchmark in solo qualifying (purple must beat it)
      const wb = world.race.bestSectors?.[i];
      let best: number | null = wb != null && Number.isFinite(wb) && wb > 0 ? wb : null;
      for (const c of world.cars) {
        const v = c.timing.bestSectors?.[i];
        if (v != null && Number.isFinite(v) && v > 0 && (best === null || v < best)) best = v;
      }
      this.overallBest[i] = best;
    }
    if (!this.ghostResolved) {
      this.ghostResolved = true;
      this.ghost = world.config.kind === 'timeTrial' ? buildGhostTrace(this.track, world.config.ghost) : null;
    }

    const frame = {
      order,
      overallBestSectors: this.overallBest,
      ghost: this.ghost,
      units: this.settings.units,
      telemetry: this.settings.hud.telemetry,
    };
    for (const v of this.views) v.update(world, dt, frame);

    const towerVisible = this.settings.hud.tower && !this.split && world.cars.length > 1;
    this.towerShow.set(towerVisible);
    if (towerVisible) this.tower.update(world, order, dt);
    if (this.settings.hud.minimap) this.minimap.update(world, dt);
    this.strip.update(world, dt);
    this.lights.update(world, dt);
    this.control.update(world, dt);
    this.watchPhase(world);
    this.watchTimeRemaining(world);
  }

  private watchPhase(world: WorldState): void {
    const s = world.session;
    if (this.lastPhase === null) {
      this.lastPhase = s.phase;
      this.introBanner(world);
      return;
    }
    if (s.phase === this.lastPhase) return;
    const prev = this.lastPhase;
    this.lastPhase = s.phase;
    switch (s.phase) {
      case 'running':
        if (s.kind !== 'race' && (prev === 'pre' || prev === 'lights') && !this.banner.isShowing('intro')) {
          this.banner.show('start', `${sessionLabel(s.kind, world.config?.sprint)}開始`, this.track.displayName, 'good', 2.6);
        }
        break;
      case 'chequered':
        this.showChequered(world);
        break;
      case 'finished':
        this.banner.show('finished', '節次結束', '', 'info', 3);
        break;
      default:
        break;
    }
  }

  private introBanner(world: WorldState): void {
    const s = world.session;
    const parts = [this.track.displayName];
    if (s.kind === 'race') parts.push(`${Math.max(1, Math.round(fin(s.totalLaps, 1)))} 圈`);
    else if (world.config.timeLimit != null && world.config.timeLimit > 0) parts.push(`限時 ${formatClock(world.config.timeLimit)}`);
    parts.push(WEATHER_LABEL[world.weather.kind] ?? '');
    this.banner.show('intro', sessionLabel(s.kind, world.config?.sprint), parts.filter(Boolean).join(' · '), 'info', 3.4);
    const objective = world.config.objective;
    if (objective && objective.text) this.toastAll('本節目標', objective.text, 'info', 6);
  }

  private showChequered(world: WorldState): void {
    const sub = world.session.kind === 'race' ? '完成本圈後即完賽' : '時間到，完成目前單圈';
    this.banner.show('chequered', '方格旗', sub, 'flag', 3.6);
  }

  private watchTimeRemaining(world: WorldState): void {
    const s = world.session;
    const tr = s.timeRemaining;
    const prev = this.lastTimeRemaining;
    if (tr != null && Number.isFinite(tr) && prev != null && s.phase === 'running' && s.kind !== 'race') {
      for (const th of TIME_WARNINGS) {
        if (prev > th && tr <= th) this.toastAll(`剩餘 ${th / 60} 分鐘`, '', 'warn');
      }
    }
    this.lastTimeRemaining = tr != null && Number.isFinite(tr) ? tr : null;
  }

  /** A notice on every view (online: players leaving, the host pausing). */
  notify(title: string, sub: string, tone: Tone = 'info', duration?: number): void {
    if (!this.destroyed) this.toastAll(title, sub, tone, duration);
  }

  /** Flashback feedback: rewound (sub = how far / how many left) or refused (sub = reason). */
  notifyFlashback(ok: boolean, sub: string): void {
    if (this.destroyed) return;
    if (ok) {
      // the banners, team radio and start lights of the rewound seconds are gone with them (e.g. 退賽 after a crash, a
      // red-flag restart that was on the lights)
      this.banner.clear();
      this.lights.reset();
      for (const v of this.views) {
        v.banner.clear();
        v.radio.clear();
      }
      this.toastAll('回溯', sub, 'info', 2.2);
    } else this.toastAll('無法回溯', sub, 'bad', 2.2);
  }

  private toastAll(title: string, sub: string, tone: Tone, duration?: number): void {
    for (const v of this.views) v.toast(title, sub, tone, duration);
  }

  private routeEvent(ev: GameEvent, world: WorldState): void {
    const abbr = (id: number | null): string => (id === null ? '' : (world.cars[id]?.abbr ?? `#${id}`));
    const reg2026 = world.config.regulation === '2026';
    switch (ev.type) {
      case 'lightsOut':
        this.lights.lightsOut();
        break;
      case 'sessionStart':
        this.startHints();
        break;
      case 'lapComplete': {
        const v = this.viewByCar.get(ev.carId);
        const time = formatLapTime(ev.time);
        if (v) {
          if (!ev.valid) v.toast('單圈無效', `${time} 不列入計時`, 'bad');
          else if (ev.overallBest) v.toast('全場最快圈', time, 'purple');
          else if (ev.personalBest) v.toast('個人最佳圈', time, 'good');
        } else if (ev.valid && ev.overallBest && world.session.kind !== 'timeTrial') {
          this.toastAll('全場最快圈', `${abbr(ev.carId)}　${time}`, 'purple');
        }
        break;
      }
      case 'finalLap':
        this.banner.show('finalLap', '最後一圈', '', 'info', 2.8);
        break;
      case 'chequered':
        this.showChequered(world);
        break;
      case 'carFinished': {
        const v = this.viewByCar.get(ev.carId);
        // disqualified at the flag (tyre rule): the 'disqualified' banner stays
        if (world.cars[ev.carId]?.penalties?.disqualified === true) break;
        if (v) {
          const raceLike = world.session.kind === 'race';
          v.banner.show('finish', raceLike ? `完賽　第 ${ev.position} 名` : '節次完成', raceLike ? '衝過方格旗！' : '', 'flag', 4.5);
        } else if (ev.position === 1 && world.session.kind === 'race') {
          this.toastAll(`${abbr(ev.carId)} 率先衝線`, '贏得本場比賽', 'flag');
        }
        break;
      }
      case 'sessionEnd':
        this.banner.show('finished', '節次結束', '', 'info', 3);
        break;
      case 'trackLimits': {
        const v = this.viewByCar.get(ev.carId);
        if (!v) break;
        const n = Math.max(0, Math.round(ev.warnings));
        if (n <= 3) v.toast(`賽道界線警告 ${n}/3`, '本圈成績不予計算', 'warn');
        else v.toast(`賽道界線違規（第 ${n} 次）`, '本圈成績不予計算', 'bad');
        break;
      }
      case 'penalty': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.toast(`+${Math.round(fin(ev.seconds))} 秒罰時`, ev.reason, 'bad', 4.5);
        break;
      }
      case 'damage': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.damage(ev.part, ev.level);
        break;
      }
      case 'drsEnabled':
        this.toastAll(reg2026 ? '直線模式已開放' : 'DRS 已開放', reg2026 ? '可於直線區段啟用主動空力' : '偵測點落後前車 1 秒內即可使用', 'good');
        break;
      case 'overtake': {
        const mine = this.viewByCar.get(ev.carId);
        if (mine) mine.toast(`超越 ${abbr(ev.passedCarId)}`, `升至第 ${ev.position} 名`, 'good', 2.6);
        const passed = this.viewByCar.get(ev.passedCarId);
        if (passed) passed.toast(`遭 ${abbr(ev.carId)} 超越`, `降至第 ${ev.position + 1} 名`, 'warn', 2.6);
        break;
      }
      case 'pitRequested': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.toast('Box 本圈', `換上${COMPOUND_INFO[ev.compound]?.label ?? ''}`, 'info');
        break;
      }
      case 'pitEntry': {
        const v = this.viewByCar.get(ev.carId);
        const manual = world.cars[ev.carId]?.assists.pitAssist === false;
        if (v) v.toast('進入維修道', manual ? '限速線前開啟限速器' : '限速器將於限速線啟動', 'info', 2.6);
        break;
      }
      case 'pitStop': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.toast(`停站 ${Math.max(0, fin(ev.duration)).toFixed(1)} 秒`, `換上${COMPOUND_INFO[ev.compound]?.label ?? ''}`, 'good');
        break;
      }
      case 'pitExit': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.toast('駛出維修道', '', 'info', 2.4);
        break;
      }
      case 'weatherChange': {
        const wet = ev.kind === 'lightRain' || ev.kind === 'heavyRain';
        this.toastAll(`天氣變化：${WEATHER_LABEL[ev.kind] ?? ''}`, wet ? '路面轉濕，注意抓地力' : '路面逐漸轉乾', 'warn', 4.5);
        break;
      }
      case 'radio': {
        if (!this.settings.hud.radio) break;
        if (ev.carId === null) {
          for (const v of this.views) v.radio.push(ev.text, RADIO_FALLBACK_COLOR);
        } else {
          const v = this.viewByCar.get(ev.carId);
          if (v) v.radio.push(ev.text, safeColor(world.cars[ev.carId]?.livery?.primary, RADIO_FALLBACK_COLOR));
        }
        break;
      }
      case 'raceControl':
        // the status strip (polled from session.control) shows it; radio lines arrive as 'radio' events
        break;
      case 'sectorFlag': {
        // while the race is neutralised the race-control strip already says what is going on
        if (world.session.control.mode !== 'green') break;
        const sector = Math.max(0, Math.round(fin(ev.sector)));
        if (ev.flag === 'clear') this.toastAll(`S${sector + 1} 黃旗解除`, '', 'good', 2.2);
        else this.toastAll(sectorFlagLabel(sector, ev.flag === 'doubleYellow' ? 2 : 1), '禁止超車，準備隨時減速或停車', 'warn', 3.2);
        break;
      }
      case 'incident': {
        const v = this.viewByCar.get(ev.carId);
        if (ev.carId >= 0) this.minimap.addIncident(ev.carId, world.time);
        if (v) this.toastAll('你的賽車發生事故', ev.reason, 'bad', 3.6);
        else if (world.session.control.mode === 'green') this.toastAll(ev.carId >= 0 ? `事故：${abbr(ev.carId)}` : '賽道上有碎片', ev.reason, 'warn', 3.6);
        break;
      }
      case 'blueFlag': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.toast('藍旗', `讓 ${abbr(ev.forCarId)} 通過`, 'info', 2.8);
        break;
      }
      case 'controlWarning': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.toast('賽事管制警告', ev.reason, 'bad', 4);
        break;
      }
      case 'retired': {
        // a disqualification has its own banner / toast
        if (world.cars[ev.carId]?.penalties?.disqualified === true) break;
        const v = this.viewByCar.get(ev.carId);
        const hint = this.flashbackHint(ev.reason);
        if (v) v.banner.show('retired', '退賽', `${ev.reason}${hint}`, 'bad', hint ? CRASH_FLASHBACK_OFFER : 6);
        else this.toastAll(`${abbr(ev.carId)} 退賽`, ev.reason, 'info', 3);
        break;
      }
      case 'terminalDamage': {
        const v = this.viewByCar.get(ev.carId);
        const hint = this.flashbackHint('');
        if (v) v.banner.show('terminal', '賽車報廢', `懸吊斷裂，無法繼續比賽${hint}`, 'bad', hint ? CRASH_FLASHBACK_OFFER : 6);
        break;
      }
      case 'blackOrangeFlag': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.banner.show('blackorange', '黑橘旗', '車損危險：本圈進站維修，否則黑旗取消資格', 'bad', 4.5);
        break;
      }
      case 'disqualified': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.banner.show('dsq', '取消資格', ev.reason, 'bad', 6);
        else this.toastAll(`${abbr(ev.carId)} 取消資格`, ev.reason, 'info', 3.5);
        break;
      }
      case 'penaltyServed': {
        const v = this.viewByCar.get(ev.carId);
        if (v) v.toast(`執行 ${Math.round(fin(ev.seconds))} 秒罰時`, '停站時原地等待，期間不得作業', 'warn', 3.6);
        break;
      }
      default:
        break;
    }
  }

  /** 「・按 R 回溯」 after a crash while a flashback is possible ('' otherwise; never for a retirement the player chose). */
  private flashbackHint(reason: string): string {
    if (this.online || reason === RETIRE_BY_CHOICE || fin(this.lastInfo?.flashbacksLeft ?? 0, 0) === 0) return '';
    const key = (this.settings.keyBindings.flashback ?? [])[0];
    return key ? `・按 ${keyLabel(key)} 回溯` : '・可從暫停選單回溯';
  }

  private buildPauseItems(world: WorldState): PauseItem[] {
    const s = world.session;
    const items: PauseItem[] = [{ kind: 'action', id: 'resume', label: '繼續', run: () => this.cb.resume() }];
    if (!this.online) {
      items.push({
        kind: 'action',
        id: 'restart',
        label: '重新開始',
        confirm: '確定重新開始？再按一次確認',
        run: () => this.cb.restart(),
      });
    }
    const flashbacksLeft = (): number => fin(this.lastInfo?.flashbacksLeft ?? world.config.rules.flashbacks, 0);
    if (flashbacksLeft() !== 0 && s.phase !== 'finished') {
      items.push({
        kind: 'action',
        id: 'flashback',
        label: () => {
          const n = flashbacksLeft();
          return n < 0 ? '回溯（無限次）' : `回溯（剩餘 ${n} 次）`;
        },
        run: () => {
          if (flashbacksLeft() !== 0) this.cb.flashback();
        },
      });
    }
    items.push({
      kind: 'action',
      id: 'settings',
      label: '設定',
      run: () => {
        this.pause.suspend(true);
        this.cb.openSettings();
      },
    });
    items.push({ kind: 'action', id: 'controls', label: '操作說明', run: () => this.openHelp() });
    const cameraOptions = CAMERA_ORDER.map((m) => ({ value: m, label: CAMERA_LABEL[m] }));
    for (const v of this.views) {
      const pi = v.view.playerIndex;
      items.push({
        kind: 'cycle',
        id: `camera${pi}`,
        label: this.split ? `P${pi + 1} 鏡頭` : '鏡頭',
        options: cameraOptions,
        get: () => this.cameraSel[pi] ?? this.settings.defaultCamera,
        set: (value) => {
          const mode = CAMERA_ORDER.find((m) => m === value);
          if (!mode) return;
          this.cameraSel[pi] = mode;
          this.cb.setCamera(pi, mode);
        },
      });
    }
    items.push({
      kind: 'cycle',
      id: 'racingLine',
      label: '行車線',
      options: RACING_LINE_ORDER.map((m) => ({ value: m, label: RACING_LINE_LABEL[m] })),
      get: () => this.racingLine,
      set: (value) => {
        const mode = RACING_LINE_ORDER.find((m) => m === value);
        if (!mode) return;
        this.racingLine = mode;
        this.cb.setRacingLine(mode);
      },
    });
    if (this.netPanel) {
      // (F3 is Mission Control on a Mac keyboard: the menu always works)
      items.push({
        kind: 'cycle',
        id: 'netPanel',
        label: `連線診斷（${NET_PANEL_KEY}）`,
        options: [
          { value: 'off', label: '關閉' },
          { value: 'on', label: '顯示' },
        ],
        get: () => (this.netOpen ? 'on' : 'off'),
        set: (value) => this.setNetOpen(value === 'on'),
      });
    }
    if (s.kind === 'race') {
      // split-screen: one retire item per player still racing, so one player never retires the other
      for (const v of this.views) {
        const car = world.cars[v.view.carId];
        if (car === undefined || car.status === 'finished' || car.status === 'retired') continue;
        const pi = v.view.playerIndex;
        const who = this.split ? `P${pi + 1} ` : '';
        items.push({
          kind: 'action',
          id: `retire${pi}`,
          label: `${who}退賽`,
          confirm: this.split ? `確定讓 P${pi + 1} 退賽？再按一次確認` : '確定退賽？再按一次確認',
          run: () => this.cb.retire(pi),
        });
      }
    } else if (this.online !== 'client') {
      items.push({
        kind: 'action',
        id: 'endSession',
        label: '結束節次',
        confirm: '確定結束節次？再按一次確認',
        run: () => this.cb.endSession(),
      });
    }
    items.push({
      kind: 'action',
      id: 'quit',
      label: this.online ? '離開房間' : '離開至選單',
      confirm: this.online === 'host' ? '確定離開？房間會關閉，所有玩家回到選單' : this.online ? '確定離開房間？' : '確定離開？本節進度不會保留',
      run: () => this.cb.quit(),
    });
    return items;
  }

  /** Show / hide the connection diagnostics panel (online: NET_PANEL_KEY or the pause menu). */
  private setNetOpen(open: boolean): void {
    if (!this.netPanel) return;
    this.netOpen = open;
    this.netPanel.el.classList.toggle('nvh-hidden', !open);
    // the first rows at the next frame
    this.netAccum = NET_REFRESH;
  }

  /** Keys bound to 暫停 (P1; P2 cannot bind it): the App turns them into its pause toggle. */
  private isPauseKey(code: string): boolean {
    return (this.settings.keyBindings.pause ?? []).includes(code);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.destroyed || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (isEditableTarget(e.target)) return;
    if (this.netPanel && e.code === NET_PANEL_KEY) {
      // (the browser's own F3 is find-next)
      e.preventDefault();
      if (!e.repeat) this.setNetOpen(!this.netOpen);
      return;
    }
    if (this.help.isOpen()) {
      if (this.help.handleKey(e.code)) e.preventDefault();
      else if (!e.repeat && HELP_CLOSE_KEYS.has(e.code) && !this.isPauseKey(e.code)) {
        // pause-bound keys (Esc / P) reach the App as 'pause', which closes the panel through handleBack()
        e.preventDefault();
        this.closeHelp();
      }
      return;
    }
    if (this.pause.isOpen()) {
      if (this.pause.handleKey(e)) e.preventDefault();
      return;
    }
    // Paused behind another overlay (settings): never steal its keys.
    if (this.paused) return;
    if (this.replayActive) {
      if (!this.hidden && this.replayBar.handleKey(e)) e.preventDefault();
      return;
    }
    // most recently opened first; split-screen MFDs only take their own player's digit keys (P1 row, P2 numpad)
    for (let i = this.mfdOrder.length - 1; i >= 0; i--) {
      const v = this.views[this.mfdOrder[i]];
      if (v && v.mfd.isOpen() && v.mfd.handleKey(e.code)) {
        e.preventDefault();
        return;
      }
    }
  };
}
