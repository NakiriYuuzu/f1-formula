/**
 * App: the top-level state machine boot → menu → loading → session (running | paused) → results | replay → menu.
 *
 * Owns the single GameRenderer, the MenuSystem (+ 3D showroom / podium behind it), AudioEngine and InputManager,
 * and at most one SessionRuntime or ReplayRuntime. Runs the requestAnimationFrame loop (clamped dt, fixed-step
 * simulation inside the session), auto-pauses on tab hide / window blur (also when it happened during loading),
 * resumes audio on user gestures, suspends driving input
 * while the settings overlay or a text field has focus, and exposes the test hooks window.render_game_to_text()
 * and window.advanceTime(ms).
 */
import type { SessionConfig, SessionResult, Settings, WorldState } from '../core/types';
import { SIM_DT } from '../core/defaults';
import { AudioEngine } from '../audio/index';
import { getLayout, hasLayout } from '../data/tracks/index';
import { InputManager, isTextEntryTarget } from '../input/index';
import type { SessionContext } from '../meta/context';
import { loadSettings } from '../meta/save';
import { buildQuickStart } from '../meta/sessionBuilder';
import { GameRenderer } from '../render/GameRenderer';
import { ShowroomScene } from '../render/ShowroomScene';
import { MenuSystem, type MenuCallbacks, type ShowroomCar } from '../ui/menus/index';
import { FpsMeter, MAX_FRAME_DT, clampFrameDt } from './clock';
import { reportError } from './errorOverlay';
import { parseQuickStart } from './quickStart';
import { ReplayRuntime, type ReplayDeps } from './ReplayRuntime';
import { forceIncident } from '../race/index';
import { SessionRuntime, type SessionDeps, type SessionNet, type SessionOutcome } from './SessionRuntime';
import { OnlineController } from './online';
import { setOnlineHooks } from '../ui/menus/onlineHooks';
import { ClientSession } from '../net/client';
import { buildTextState, type AppScreen } from './textState';

declare global {
  interface Window {
    /** Test hook: concise JSON description of the current screen / session. */
    render_game_to_text?: () => string;
    /** Test hook: advance the running session deterministically by round(ms / SIM_DT) steps and render once. */
    advanceTime?: (ms: number) => void;
    /** Test hook: force a race-control incident in the running race (yellow flag, VSC, safety car, red flag). */
    debug_force_incident?: (kind: 'yellow' | 'vsc' | 'sc' | 'red') => boolean;
    /** Test hook: renderer statistics of the last rendered frame (performance measurement). */
    render_debug_info?: () => { fps: number; calls: number; triangles: number; geometries: number; textures: number; programs: number };
  }
}

/** Consecutive failing frames of a session / replay before it is abandoned. */
const MAX_ERROR_STREAK = 10;
const CLEAR_COLOR = 0x07090d;
const LOADING_TEXT = '載入賽道與賽車中…';
const FAST_FORWARD_TEXT = '其他車手衝線中，正在統計成績…';

/** Resolves once the current frame has been painted (or after a short timeout in a background tab). */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => window.setTimeout(finish, 0));
    window.setTimeout(finish, 150);
  });
}

export class App {
  private settings: Settings;
  private readonly gr: GameRenderer;
  private readonly menus: MenuSystem;
  private readonly audio: AudioEngine;
  private readonly input: InputManager;
  private readonly fps = new FpsMeter();
  private state: AppScreen = 'boot';
  private session: SessionRuntime | null = null;
  private replay: ReplayRuntime | null = null;
  private results: SessionOutcome | null = null;
  private showroom: ShowroomScene | null = null;
  private showroomFailed = false;
  private showroomCar: ShowroomCar | null = null;
  private podiumCars: ShowroomCar[] | null = null;
  private canvasCleared = false;
  private overlayOpen = false;
  private textFocus = false;
  /** the window lost focus (blur) and has not regained it */
  private windowBlurred = false;
  private loadToken = 0;
  private rafId = 0;
  private lastFrameAt: number | null = null;
  /** advanceTime() ran since the last animation frame: that frame must not add real time to the simulation */
  private manualStepped = false;
  /** the next animation frame starts fresh (after a blocking load) */
  private skipDt = false;
  private errorStreak = 0;
  private started = false;
  private destroyed = false;

  private readonly sessionDeps: SessionDeps;
  private readonly replayDeps: ReplayDeps;
  /** online room (menus host / join through it; null hooks in tests) */
  private readonly online: OnlineController;
  /** the running online host session ends the weekend (its result is final) */
  private onlineFinal = true;

  /** Throws if WebGL 2 is unavailable (GameRenderer). */
  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.settings = loadSettings();
    this.gr = new GameRenderer(canvas, this.settings);
    this.audio = new AudioEngine(this.settings);
    this.input = new InputManager(this.settings);
    const getSettings = (): Settings => this.settings;
    const toggleFullscreen = (): void => this.toggleFullscreen();
    this.sessionDeps = {
      gr: this.gr,
      uiRoot,
      audio: this.audio,
      input: this.input,
      settings: getSettings,
      quit: () => this.quitSession(),
      openSettings: () => this.openSettingsOverlay(),
      toggleFullscreen,
      fastForwardStarted: () => this.menus.showLoading(FAST_FORWARD_TEXT, false),
    };
    this.replayDeps = { gr: this.gr, uiRoot, audio: this.audio, settings: getSettings, toggleFullscreen };
    const callbacks: MenuCallbacks = {
      startSession: (config, ctx) => this.startSession(config, ctx),
      applySettings: (s) => this.applySettings(s),
      showroom: (car) => this.setShowroom(car),
      podium: (cars) => this.setPodium(cars),
      uiSound: (kind) => {
        void this.audio.resume();
        this.audio.ui(kind);
      },
      toggleFullscreen,
      resultsClosed: () => this.resultsClosed(),
    };
    this.menus = new MenuSystem(uiRoot, this.settings, callbacks);
    this.online = new OnlineController({
      start: (session, config, final) => this.startClientSession(session, config, final),
      closed: (reason) => this.onlineClosed(reason),
    });
    setOnlineHooks(this.online);
  }

  /** Attach listeners, expose test hooks, show the title (or a URL quick start) and start the frame loop. */
  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.input.attach(window);
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(type, this.onGesture, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('focus', this.onWindowFocus);
    // closing / reloading the page leaves an online room at once (the others need not wait for the link to time out)
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('focusin', this.onFocusIn);
    document.addEventListener('focusout', this.onFocusOut);
    window.render_game_to_text = () => this.renderGameToText();
    window.advanceTime = (ms: number) => this.advanceTime(ms);
    window.debug_force_incident = (kind) => {
      const s = this.session;
      return s ? forceIncident(s.world, s.track, kind) : false;
    };
    window.render_debug_info = () => {
      const info = this.gr.renderer.info;
      return {
        fps: this.fps.fps,
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
      };
    };

    const quick = parseQuickStart(window.location.search, hasLayout);
    let quickStarted = false;
    if (quick) {
      try {
        const { config, ctx } = buildQuickStart(quick);
        this.startSession(config, ctx);
        quickStarted = true;
      } catch (err) {
        reportError(err, '快速開始');
      }
    }
    if (!quickStarted) {
      this.setState('menu');
      this.menus.showMain();
    }
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** Tear everything down (listeners, session, scenes, audio, renderer). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.loadToken++;
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.removeEventListener(type, this.onGesture, { capture: true });
    }
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('focus', this.onWindowFocus);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('focusin', this.onFocusIn);
    document.removeEventListener('focusout', this.onFocusOut);
    delete window.render_game_to_text;
    delete window.advanceTime;
    delete window.render_debug_info;
    delete window.debug_force_incident;
    this.disposeActive();
    this.online.leave();
    setOnlineHooks(null);
    this.showroom?.dispose();
    this.showroom = null;
    this.menus.destroy();
    this.input.detach();
    this.audio.dispose();
    this.gr.dispose();
  }

  // ───────────────────────────── frame loop ─────────────────────────────

  private readonly loop = (t: number): void => {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const raw = this.lastFrameAt === null ? 0 : (t - this.lastFrameAt) / 1000;
    this.lastFrameAt = t;
    this.fps.tick(raw);
    let dt = clampFrameDt(raw);
    if (this.manualStepped || this.skipDt) {
      this.manualStepped = false;
      this.skipDt = false;
      dt = 0;
    }
    this.tick(dt, null);
  };

  /** One frame: real-time (`manualSteps` null) or a test-hook step of exactly `manualSteps` simulation steps. */
  private tick(dt: number, manualSteps: number | null): void {
    try {
      this.online.room()?.tick();
      this.input.update(dt);
      const actions = this.input.consumeActions();
      const menuInputs = this.input.consumeMenuInputs();
      // menus own the pad while open (title / menus / results / settings overlay); otherwise the session gets it
      if (this.menus.isOpen()) for (const m of menuInputs) this.menus.navigate(m);
      switch (this.state) {
        case 'session': {
          const s = this.session;
          if (!s) break;
          // menus open above the session (settings overlay, fast-forward card): driving actions are void
          const acts = this.menus.isOpen() ? [] : actions;
          this.feedVehicleSpeeds(s);
          if (manualSteps === null) s.frame(dt, this.fps.fps, acts, this.menus.isOpen() ? [] : menuInputs);
          else s.advanceManual(manualSteps, this.fps.fps, acts);
          if (this.session === s && s.isOver()) this.finishSession();
          break;
        }
        case 'replay':
          this.replay?.frame(dt, this.fps.fps, actions);
          break;
        default:
          this.renderBackdrop(dt);
          break;
      }
      this.errorStreak = 0;
    } catch (err) {
      reportError(err, '主迴圈');
      this.errorStreak++;
      if (this.errorStreak >= MAX_ERROR_STREAK && (this.session || this.replay)) this.abortActive();
    }
  }

  /** Speed-sensitive steering: tell the input layer how fast each human car goes (when InputManager supports it). */
  private feedVehicleSpeeds(s: SessionRuntime): void {
    const setSpeed: unknown = Reflect.get(this.input, 'setVehicleSpeed');
    if (typeof setSpeed !== 'function') return;
    // online: this computer's player is input 0 (a guest's car may be any seat)
    if (s.onlineRole) {
      const car = s.world.cars[s.viewCarId];
      if (car) Reflect.apply(setSpeed, this.input, [0, car.phys.speed]);
      return;
    }
    for (const car of s.world.cars) {
      if (car.playerIndex === 0 || car.playerIndex === 1) Reflect.apply(setSpeed, this.input, [car.playerIndex, car.phys.speed]);
    }
  }

  /** Menus / results / loading: the showroom or podium behind transparent menu screens, else a cleared canvas. */
  private renderBackdrop(dt: number): void {
    if (this.state !== 'loading' && (this.podiumCars || this.showroomCar)) {
      const room = this.ensureShowroom();
      if (room) {
        room.render(dt);
        this.canvasCleared = false;
        return;
      }
    }
    if (this.canvasCleared || this.gr.isContextLost()) return;
    const r = this.gr.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.gr.width, this.gr.height);
    r.setClearColor(CLEAR_COLOR, 1);
    r.clear(true, true, false);
    this.canvasCleared = true;
  }

  private advanceTime(ms: number): void {
    if (this.destroyed) return;
    const msSafe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    const steps = Math.round(msSafe / (SIM_DT * 1000));
    this.manualStepped = true;
    const dt = Math.min(MAX_FRAME_DT, msSafe / 1000);
    if (this.state === 'session') this.tick(dt, steps);
    else this.tick(dt, null);
  }

  // ───────────────────────────── sessions ─────────────────────────────

  private startSession(config: SessionConfig, ctx: SessionContext): void {
    if (this.destroyed) return;
    // an online host's weekend session: every guest gets the same config, the host session takes their links
    const room = this.online.room();
    let net: SessionNet | null = null;
    if (room?.hostLobby && ctx.returnTo === 'online') {
      const session = room.nextSession();
      const players = room.hostLobby.sessionPlayers();
      this.onlineFinal = ctx.weekendQueue.length === 0;
      room.hostLobby.startSession(session, config, this.onlineFinal);
      net = { role: 'host', session, players };
    }
    this.beginLoad(config, ctx, () => net);
  }

  /** Guest: the host started a session — leave whatever is shown (results, lobby) and join it. */
  private startClientSession(session: number, config: SessionConfig, final: boolean): void {
    const room = this.online.room();
    const lobby = room?.guestLobby;
    if (this.destroyed || !room || !lobby || lobby.playerIndex === null) return;
    const playerIndex = lobby.playerIndex;
    // the host runs the weekend: a guest's results only lead back to the lobby, the next session arrives from the host
    const ctx: SessionContext = { returnTo: 'online', weekendQueue: [], round: null, storyId: null };
    let runtime: SessionRuntime | null = null;
    // the session's link handler takes over at once: the host's first (complete) mirror and events must not be missed
    let client: ClientSession;
    try {
      const track = getLayout(config.layoutId);
      client = new ClientSession(config, track, session, playerIndex, lobby.link, {
        other: (m) => lobby.handle(m),
        hostLost: () => {
          // the room is gone with its host: one notice, not a second one when the matchmaking link closes too
          this.online.leave();
          this.onlineClosed('房主已離線，連線中斷');
        },
        playerLeft: (_pi, name) => runtime?.notify(`${name} 已離線`, '改由 AI 代駕'),
        paused: (p) => runtime?.notify(p ? '房主已暫停比賽' : '比賽繼續', '', p ? 'warn' : 'info'),
      });
    } catch (err) {
      reportError(err, '線上節次');
      return;
    }
    this.beginLoad(
      config,
      ctx,
      () => ({ role: 'client', client }),
      (s) => {
        runtime = s;
      },
    );
  }

  private beginLoad(
    config: SessionConfig,
    ctx: SessionContext,
    net: (track: ReturnType<typeof getLayout>) => SessionNet | null,
    created?: (s: SessionRuntime) => void,
  ): void {
    const token = ++this.loadToken;
    this.disposeActive();
    this.results = null;
    this.setState('loading');
    this.menus.showLoading(LOADING_TEXT);
    void this.loadSession(config, ctx, token, net, created);
  }

  private async loadSession(
    config: SessionConfig,
    ctx: SessionContext,
    token: number,
    makeNet: (track: ReturnType<typeof getLayout>) => SessionNet | null = () => null,
    created?: (s: SessionRuntime) => void,
  ): Promise<void> {
    await afterPaint();
    if (token !== this.loadToken || this.destroyed) return;
    let session: SessionRuntime;
    try {
      const track = getLayout(config.layoutId);
      session = new SessionRuntime(this.sessionDeps, config, ctx, track, makeNet(track));
      created?.(session);
      session.autopilot = new URLSearchParams(window.location.search).get('autopilot') === '1';
    } catch (err) {
      reportError(err, '載入節次');
      // an online guest's link goes back to the lobby
      this.online.room()?.guestLobby?.attach();
      this.setState('menu');
      this.menus.showHome(ctx.returnTo);
      this.menus.toast('無法載入節次，已返回選單', 'bad');
      return;
    }
    if (token !== this.loadToken || this.destroyed) {
      session.dispose();
      return;
    }
    this.session = session;
    this.errorStreak = 0;
    this.skipDt = true;
    this.setState('session');
    this.menus.hide();
    // the tab was hidden / the window lost focus while loading: start paused like a running session would be
    // (online the race runs for everyone regardless)
    if (!session.onlineRole && (document.visibilityState === 'hidden' || this.windowBlurred)) session.setPaused(true);
  }

  private finishSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.releaseOverlay();
    let outcome: SessionOutcome | null = null;
    try {
      outcome = s.finish();
    } catch (err) {
      reportError(err, '節次成績');
    }
    const role = s.onlineRole;
    if (role === 'host' && outcome) s.host?.sendResult(outcome.result, this.onlineFinal);
    s.dispose();
    // online: back to the lobby's message handling (the host resets ready flags after the weekend)
    const room = this.online.room();
    if (role === 'host') room?.hostLobby?.attach(this.onlineFinal);
    if (role === 'client' && room?.guestLobby) {
      room.guestLobby.attach();
      if (outcome) outcome = { ...outcome, result: localizeResult(outcome.result, outcome.world, room.guestLobby.playerIndex ?? 0) };
    }
    if (!outcome) {
      this.setState('menu');
      this.menus.showHome(s.ctx.returnTo);
      return;
    }
    this.results = outcome;
    this.setState('results');
    this.showResults();
  }

  private showResults(): void {
    const r = this.results;
    if (!r) {
      this.setState('menu');
      this.menus.showMain();
      return;
    }
    this.menus.showResults(r.result, r.world, r.ctx, r.replay ? () => this.startReplay() : null);
  }

  /** Results dismissed (繼續 / end weekend): the finished session's data must no longer be reported. */
  private resultsClosed(): void {
    if (this.state !== 'results') return;
    this.results = null;
    this.setState('menu');
  }

  private quitSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.releaseOverlay();
    // leaving an online session leaves the room (the host's room closes for everyone)
    const online = s.onlineRole !== null;
    s.dispose();
    if (online) {
      this.online.leave();
      this.results = null;
      this.setState('menu');
      this.menus.showHome('main');
      return;
    }
    this.results = null;
    this.setState('menu');
    this.menus.showHome(s.ctx.returnTo);
  }

  private openSettingsOverlay(): void {
    if (!this.session) return;
    this.overlayOpen = true;
    this.syncCapture();
    this.menus.openSettingsOverlay(() => {
      this.overlayOpen = false;
      this.syncCapture();
      this.session?.hudSettingsClosed();
    });
  }

  private startReplay(): void {
    const r = this.results;
    if (!r || !r.replay) {
      this.showResults();
      return;
    }
    try {
      this.replay = new ReplayRuntime(this.replayDeps, r.replay, r.world, () => this.exitReplay());
    } catch (err) {
      reportError(err, '重播');
      this.replay = null;
      this.setState('results');
      this.showResults();
      return;
    }
    this.skipDt = true;
    this.setState('replay');
  }

  private exitReplay(): void {
    const rp = this.replay;
    this.replay = null;
    rp?.dispose();
    this.setState('results');
    this.showResults();
  }

  /** Repeatedly failing session / replay: drop it and return to the menus. */
  private abortActive(): void {
    const home = this.session?.ctx.returnTo ?? 'main';
    try {
      this.disposeActive();
    } catch (err) {
      reportError(err, '釋放節次');
    }
    this.session = null;
    this.replay = null;
    this.results = null;
    this.errorStreak = 0;
    this.setState('menu');
    this.menus.showHome(home);
    this.menus.toast('節次發生錯誤，已返回選單', 'bad');
  }

  private disposeActive(): void {
    const s = this.session;
    const rp = this.replay;
    this.session = null;
    this.replay = null;
    this.releaseOverlay();
    s?.dispose();
    rp?.dispose();
  }

  /**
   * The session's settings overlay goes away with it (menus drop its close callback when they show another
   * screen): driving input capture must not stay suspended.
   */
  private releaseOverlay(): void {
    if (!this.overlayOpen) return;
    this.overlayOpen = false;
    this.syncCapture();
  }

  // ───────────────────────────── menus backdrop ─────────────────────────────

  private setShowroom(car: ShowroomCar | null): void {
    this.showroomCar = car;
    if (car) this.ensureShowroom()?.setCar(car.livery, car.number, car.teamShort, car.helmet);
  }

  private setPodium(cars: ShowroomCar[] | null): void {
    this.podiumCars = cars && cars.length > 0 ? cars : null;
    if (this.podiumCars) this.ensureShowroom()?.setPodium(this.podiumCars);
    else this.showroom?.setPodium(null);
  }

  private ensureShowroom(): ShowroomScene | null {
    if (this.showroom || this.showroomFailed) return this.showroom;
    try {
      this.showroom = new ShowroomScene(this.gr);
    } catch (err) {
      this.showroomFailed = true;
      reportError(err, '展示場景');
      return null;
    }
    // the scene starts with a default car: show what the menus asked for
    const car = this.showroomCar;
    if (car) this.showroom.setCar(car.livery, car.number, car.teamShort, car.helmet);
    if (this.podiumCars) this.showroom.setPodium(this.podiumCars);
    return this.showroom;
  }

  // ───────────────────────────── settings / platform ─────────────────────────────

  private applySettings(settings: Settings): void {
    this.settings = settings;
    this.gr.applySettings(settings);
    this.audio.applySettings(settings);
    this.input.applySettings(settings);
    this.session?.applySettings(settings);
    this.replay?.applySettings(settings);
  }

  private toggleFullscreen(): void {
    try {
      if (document.fullscreenElement) {
        if (typeof document.exitFullscreen === 'function') void document.exitFullscreen().catch(() => undefined);
      } else {
        const el = document.documentElement;
        if (typeof el.requestFullscreen === 'function') void el.requestFullscreen().catch(() => undefined);
      }
    } catch {
      // fullscreen unavailable (iframe / policy): ignore
    }
  }

  private setState(next: AppScreen): void {
    this.state = next;
    document.body.dataset.appState = next;
    this.audio.setMusicScene(next);
  }

  private syncCapture(): void {
    this.input.setCaptureSuspended(this.overlayOpen || this.textFocus);
  }

  private readonly onGesture = (): void => {
    void this.audio.resume();
  };

  /** Online room gone (host left, link lost): drop an online session or the lobby and say why. */
  private onlineClosed(reason: string): void {
    if (this.destroyed) return;
    const s = this.session;
    const inOnline = (s !== null && s.onlineRole !== null) || this.menus.isOpen();
    if (s && s.onlineRole !== null) {
      this.session = null;
      this.releaseOverlay();
      s.dispose();
      this.results = null;
      this.setState('menu');
      this.menus.showHome('main');
    } else if (this.state === 'loading') {
      this.loadToken++;
      this.setState('menu');
      this.menus.showHome('main');
    } else if (this.state === 'menu' || this.state === 'results') {
      // the lobby (or a guest's results): back to the online screen
      this.results = null;
      this.setState('menu');
      this.menus.showHome('online');
    }
    if (inOnline) this.menus.toast(reason, 'bad');
  }

  /** Tab hidden or window blurred: pause the running session / replay (an online race runs on for everyone). */
  private autoPause(): void {
    if (this.state === 'session' && this.session && !this.session.fastForwarding && !this.session.onlineRole) this.session.setPaused(true);
    else if (this.state === 'replay') this.replay?.pause();
  }

  private readonly onVisibility = (): void => {
    this.audio.setMusicHidden(document.hidden);
    if (document.visibilityState === 'hidden') this.autoPause();
  };

  private readonly onWindowBlur = (): void => {
    this.windowBlurred = true;
    this.autoPause();
  };

  private readonly onWindowFocus = (): void => {
    this.windowBlurred = false;
  };

  private readonly onPageHide = (): void => {
    this.online.leave();
  };

  private readonly onFocusIn = (e: FocusEvent): void => {
    this.textFocus = isTextEntryTarget(e.target);
    this.syncCapture();
  };

  private readonly onFocusOut = (e: FocusEvent): void => {
    this.textFocus = isTextEntryTarget(e.relatedTarget);
    this.syncCapture();
  };

  // ───────────────────────────── test hooks ─────────────────────────────

  private renderGameToText(): string {
    const s = this.session;
    const r = this.results;
    let world = s ? s.world : (r?.world ?? null);
    let track = s ? s.track : (r?.replay?.track ?? null);
    if (world && !track) {
      try {
        track = getLayout(world.config.layoutId);
      } catch {
        world = null;
      }
    }
    const viewCarId = s ? s.viewCarId : (r?.world.cars.find((c) => c.playerIndex === 0)?.id ?? 0);
    const player2CarId = s ? s.secondViewCarId : (r?.world.cars.find((c) => c.playerIndex === 1)?.id ?? null);
    return JSON.stringify(
      buildTextState({
        screen: this.state,
        menuOpen: this.menus.isOpen(),
        paused: s ? s.paused : false,
        world,
        track,
        viewCarId,
        player2CarId,
        replay: this.replay ? this.replay.info : null,
      }),
    );
  }
}

/**
 * A guest's view of the classification: its own row becomes player 0 (results highlighting, stats), the host's row
 * takes the guest's index (the mirror world's cars alike).
 */
function localizeResult(result: SessionResult, world: WorldState, mine: number): SessionResult {
  if (mine === 0) return result;
  const swap = <T extends number>(pi: T): T => (pi === mine ? 0 : pi === 0 ? mine : pi) as T;
  for (const c of world.cars) if (c.playerIndex >= 0) c.playerIndex = swap(c.playerIndex);
  return { ...result, rows: result.rows.map((r) => (r.playerIndex >= 0 ? { ...r, playerIndex: swap(r.playerIndex) } : r)) };
}
