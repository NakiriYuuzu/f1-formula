/**
 * One running session (race / qualifying / practice / time trial, single or split-screen): owns the WorldState,
 * the RaceScene, the HudLayer, the fixed-step accumulator, the flashback ring and the replay recorder.
 *
 * Per frame: controls per human (one-shots only in the first sub-step) → stepWorld sub-steps → drain events to
 * HUD + audio → input actions (pause, camera, flashback, MFD, Box, fullscreen, HUD) → RenderFrame → scene →
 * audio → HUD. When every human car has finished (or retired from) a race the rest of the field is fast-forwarded
 * off screen; past a simulated-time cap the remaining cars are classified at their projected finish.
 */
import type {
  BuiltTrack,
  CameraMode,
  ControlInput,
  GameEvent,
  PlayerIndex,
  RacingLineMode,
  SessionConfig,
  SessionResult,
  Settings,
  ViewSpec,
  WorldState,
} from '../core/types';
import { SIM_DT } from '../core/defaults';
import { clamp01 } from '../core/math';
import type { AudioEngine } from '../audio/index';
import type { InputAction, InputManager, PadMenuInput } from '../input/index';
import type { SessionContext } from '../meta/context';
import {
  buildRenderFrame,
  buildSessionResult,
  cancelPit,
  concludeRace,
  createWorld,
  endSession,
  getPlayerCarId,
  isSessionOver,
  playerCarIds,
  requestPit,
  retireCar,
  setErsMode,
  stepWorld,
} from '../race/index';
import { computeAIInput } from '../ai/index';
import { RaceScene, type RaceSceneOptions } from '../render/RaceScene';
import type { GameRenderer } from '../render/GameRenderer';
import { HudLayer, type HudCallbacks, type HudFrameInfo, type HudView } from '../ui/hud/index';
import { FixedStepClock, MAX_FRAME_DT, MAX_SUBSTEPS } from './clock';
import { substepInputs, withPendingOneShots } from './controls';
import { FlashbackBuffer, REWIND_SECONDS, flashbacksLeft } from './flashback';
import { ReplayRecorder, type ReplayClip } from './replay';
import { sceneCarsFor, sceneTeamColors } from './sceneCars';
import { buildViews, nextCamera } from './views';
import { HostSession } from '../net/host';
import type { ClientSession } from '../net/client';
import type { NetTransport } from '../net/transport';

/** Seconds of simulation after every human car took the flag before the rest of the race is fast-forwarded. */
const FINISH_GRACE = 6;
/**
 * Real-time budget (ms) per frame for fast-forwarding, and the most simulated seconds it may take before the
 * rest of the race is projected from each car's pace (keeps the wait after an early retirement short).
 */
const FAST_FORWARD_BUDGET_MS = 12;
const FAST_FORWARD_MAX_SIM = 400;
/** advanceTime test hook: simulation steps per input-smoothing update (≈ one 60 Hz frame). */
const MANUAL_CHUNK_STEPS = Math.max(1, Math.round(1 / 60 / SIM_DT));
/** Collision rumble: impulse (N·s) for full strength, duration (ms). */
const RUMBLE_FULL_IMPULSE = 6000;
const RUMBLE_MS = 200;

export interface SessionDeps {
  readonly gr: GameRenderer;
  readonly uiRoot: HTMLElement;
  readonly audio: AudioEngine;
  readonly input: InputManager;
  settings(): Settings;
  /** pause menu → leave to the menus */
  quit(): void;
  /** pause menu → settings overlay; the session calls hudSettingsClosed() when it closes */
  openSettings(): void;
  toggleFullscreen(): void;
  /** every human finished: the App covers the screen while the rest of the race is simulated */
  fastForwardStarted(): void;
}

/** Everything a replay needs after the session itself is gone. */
export interface ReplayPackage {
  clip: ReplayClip;
  track: BuiltTrack;
  scene: Omit<RaceSceneOptions, 'settings'>;
  focusCarId: number;
}

export interface SessionOutcome {
  result: SessionResult;
  world: WorldState;
  ctx: SessionContext;
  replay: ReplayPackage | null;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Online client with no control this step (pause menu open): coast. */
const COAST: ControlInput = {
  throttle: 0,
  brake: 0,
  steer: 0,
  shiftUp: false,
  shiftDown: false,
  drsPressed: false,
  ersCycle: false,
  limiterToggle: false,
  overtakeHeld: false,
};

/**
 * Online session (docs/plans/phase3-online.md §3): the host runs the world with the remote players' inputs (their
 * links → HostSession); a client shows its ClientSession's mirror world and predicted car. Either way: one local view,
 * no flashback / restart, the pause menu does not stop the world (only the host's pause does, for everyone).
 */
export type SessionNet =
  | {
      role: 'host';
      session: number;
      players: { playerIndex: PlayerIndex; name: string; transport: NetTransport }[];
    }
  | { role: 'client'; client: ClientSession };

export class SessionRuntime {
  world: WorldState;
  readonly track: BuiltTrack;
  readonly config: SessionConfig;
  readonly ctx: SessionContext;
  private readonly deps: SessionDeps;
  private readonly scene: RaceScene;
  private readonly sceneOptions: Omit<RaceSceneOptions, 'settings'>;
  private hud: HudLayer;
  private readonly views: ViewSpec[];
  private readonly hudViews: HudView[];
  private readonly humans: number[];
  private readonly clock = new FixedStepClock(SIM_DT, MAX_SUBSTEPS);
  private readonly flashbacks = new FlashbackBuffer();
  private readonly recorder = new ReplayRecorder();
  private pending: (ControlInput | null)[] = [null, null];
  private racingLine: RacingLineMode;
  private pausedFlag = false;
  private humansDoneAt: number | null = null;
  private fastForward = false;
  private fastForwardFrom = 0;
  private disposed = false;
  /** Test aid (URL `autopilot=1`): human cars are driven by the AI controller instead of player input. */
  autopilot = false;
  /** online: the host's link layer / the client's session (null offline) */
  readonly host: HostSession | null = null;
  readonly client: ClientSession | null = null;
  private readonly online: 'host' | 'client' | null;

  constructor(deps: SessionDeps, config: SessionConfig, ctx: SessionContext, track: BuiltTrack, net: SessionNet | null = null) {
    this.deps = deps;
    this.config = config;
    this.ctx = ctx;
    this.track = track;
    this.online = net ? net.role : null;
    if (net?.role === 'client') {
      this.client = net.client;
      this.world = net.client.world;
    } else this.world = createWorld(config, track);
    if (net?.role === 'host') {
      this.host = new HostSession(this.world, track, net.session, net.players, {
        playerLeft: (_pi, name) => (this.hud as HudLayer | undefined)?.notify(`${name} 已離線`, '改由 AI 代駕', 'warn', 4),
      });
    }
    this.humans = playerCarIds(this.world);
    const settings = deps.settings();
    // online: only this computer's car gets a view (the host's other human cars are remote players)
    const local = net?.role === 'client' ? [net.client.carId] : net?.role === 'host' ? [getPlayerCarId(this.world, 0)] : this.humans;
    const { views, hudViews } = buildViews(local, settings.defaultCamera, 0);
    this.views = views;
    this.hudViews = hudViews;
    const p0 = config.players.find((p) => p.playerIndex === 0);
    this.racingLine = p0 ? p0.assists.racingLine : 'off';
    this.sceneOptions = {
      cars: sceneCarsFor(this.world),
      timeOfDay: config.timeOfDay,
      weather: config.weather,
      ghost: config.kind === 'timeTrial' && config.ghost !== null && config.ghost.layoutId === track.id,
      racingLine: this.racingLine,
      regulation: config.regulation,
      teamColors: sceneTeamColors(this.world),
    };
    this.scene = new RaceScene(deps.gr, track, { ...this.sceneOptions, settings });
    // split-screen: each half shows its own player's racing-line assist (the pause menu then sets both)
    if (this.hudViews.length > 1) {
      this.hudViews.forEach((v, i) => {
        const player = config.players.find((p) => p.playerIndex === v.playerIndex);
        if (player) this.scene.setRacingLine(player.assists.racingLine, i);
      });
    }
    try {
      this.hud = this.createHud(settings);
    } catch (err) {
      this.scene.dispose();
      throw err;
    }
    deps.input.setSplitScreen(this.views.length > 1);
    deps.input.reset();
    deps.audio.stopSession();
  }

  // ───────────────────────────── per frame ─────────────────────────────

  /** One rendered frame of real time `dt` (already clamped by the App). `menuInputs` = pad pause-menu navigation. */
  frame(dt: number, fps: number, actions: readonly InputAction[], menuInputs: readonly PadMenuInput[] = []): void {
    if (this.disposed) return;
    if (this.fastForward) {
      this.runFastForward();
      return;
    }
    // a guest's pause menu does not stop the race (that player just coasts); the host's stops it for everyone
    if (!this.pausedFlag || this.online === 'client') {
      const steps = this.clock.advance(dt);
      const controls = this.pausedFlag ? [null, null] : this.readControls();
      if (steps > 0) this.simulate(steps, controls);
      else this.holdOneShots(controls);
    }
    this.dispatchEvents();
    for (const a of actions) {
      if (this.disposed || this.fastForward) return;
      this.handleAction(a);
    }
    for (const m of menuInputs) {
      if (this.disposed || this.fastForward || !this.pausedFlag) break;
      this.handleMenuInput(m);
    }
    if (this.disposed) return;
    this.present(this.pausedFlag ? 0 : dt, fps);
    this.watchFinish();
  }

  /** Test hook: advance exactly `steps` simulation steps now (no real-time accumulation) and render once. */
  advanceManual(steps: number, fps: number, actions: readonly InputAction[]): void {
    if (this.disposed) return;
    if (this.fastForward) {
      this.runFastForward();
      return;
    }
    const n = Math.max(0, Math.floor(Number.isFinite(steps) ? steps : 0));
    if (!this.pausedFlag && n > 0) {
      // n steps stand for n·SIM_DT of play: advance input smoothing alongside, one ~1/60 s chunk at a time
      // (the App already ran input.update for the first chunk; one-shots still reach only the first step)
      for (let done = 0; done < n; ) {
        const k = Math.min(MANUAL_CHUNK_STEPS, n - done);
        if (done > 0) this.deps.input.update(k * SIM_DT);
        this.simulate(k, this.readControls());
        done += k;
      }
      this.clock.reset();
    }
    this.dispatchEvents();
    for (const a of actions) {
      if (this.disposed || this.fastForward) return;
      this.handleAction(a);
    }
    this.present(this.pausedFlag ? 0 : Math.min(MAX_FRAME_DT, n * SIM_DT), fps);
    this.watchFinish();
  }

  // ───────────────────────────── state ─────────────────────────────

  get paused(): boolean {
    return this.pausedFlag;
  }

  get fastForwarding(): boolean {
    return this.fastForward;
  }

  get viewCarId(): number {
    return this.views[0]?.carId ?? 0;
  }

  /** split-screen: the second view's car (player 2), else null */
  get secondViewCarId(): number | null {
    return this.views[1]?.carId ?? null;
  }

  isOver(): boolean {
    if (this.disposed) return false;
    if (this.client) return this.client.result !== null;
    return isSessionOver(this.world);
  }

  /** A notice on the HUD (online: players leaving, the host pausing). */
  notify(title: string, sub: string, tone: 'info' | 'warn' | 'bad' | 'good' = 'info'): void {
    if (!this.disposed) this.hud.notify(title, sub, tone, 4);
  }

  /** Online role of this session (null offline). */
  get onlineRole(): 'host' | 'client' | null {
    return this.online;
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.fastForward || paused === this.pausedFlag) return;
    this.pausedFlag = paused;
    if (this.online !== 'client') this.clock.reset();
    this.pending = [null, null];
    this.deps.input.reset();
    if (this.online !== 'client') this.deps.audio.setPaused(paused);
    this.hud.setPaused(paused, this.world);
    // the host's pause menu stops the race for everyone
    this.host?.setPaused(paused);
  }

  /** Settings overlay (opened from the pause menu) closed: the pause menu takes input again. */
  hudSettingsClosed(): void {
    if (!this.disposed) this.hud.onSettingsClosed();
  }

  applySettings(settings: Settings): void {
    if (!this.disposed) this.hud.applySettings(settings);
  }

  /** Why a flashback is not possible right now (zh-TW), or null when it is. */
  private flashbackBlock(): string | null {
    const w = this.world;
    if (this.online) return '線上模式無法回溯';
    if (w.session.phase === 'finished') return '節次已結束';
    // a retirement chosen from the pause menu is final (rewinding would put the car back in the race)
    if (this.humans.some((id) => w.cars[id]?.status === 'retired')) return '退賽後無法回溯';
    if (flashbacksLeft(w.config.rules, w.flashbacksUsed) === 0) return '回溯次數已用完';
    return null;
  }

  /** Rewind ~5 s with HUD / sound feedback. Returns false when not allowed / nothing stored. */
  flashback(): boolean {
    if (this.disposed || this.fastForward) return false;
    const w = this.world;
    const blocked = this.flashbackBlock();
    const restored = blocked ? null : this.flashbacks.rewind(w.time, REWIND_SECONDS);
    if (!restored) {
      this.hud.notifyFlashback(false, blocked ?? '沒有可回溯的紀錄');
      this.deps.audio.ui('error');
      return false;
    }
    restored.events = [];
    restored.flashbacksUsed = w.flashbacksUsed + 1;
    w.events.length = 0;
    this.world = restored;
    this.recorder.truncateAfter(restored.time);
    this.clock.reset();
    this.pending = [null, null];
    this.humansDoneAt = null;
    this.deps.input.reset();
    const left = flashbacksLeft(restored.config.rules, restored.flashbacksUsed);
    this.hud.notifyFlashback(true, left < 0 ? `倒帶 ${REWIND_SECONDS} 秒` : `倒帶 ${REWIND_SECONDS} 秒・剩餘 ${left} 次`);
    this.deps.audio.ui('back');
    return true;
  }

  /** Same config from the start: new world, fresh HUD, empty flashback / replay buffers. */
  restart(): void {
    if (this.disposed || this.online) return;
    const settings = this.deps.settings();
    this.world = createWorld(this.config, this.track);
    this.hud.destroy();
    this.hud = this.createHud(settings);
    this.flashbacks.clear();
    this.recorder.clear();
    this.clock.reset();
    this.pending = [null, null];
    this.humansDoneAt = null;
    this.fastForward = false;
    this.pausedFlag = false;
    this.deps.audio.stopSession();
    this.deps.audio.setPaused(false);
    this.deps.input.reset();
  }

  /** Final classification + the recorded replay (call once the session is over). */
  finish(): SessionOutcome {
    const result = this.client?.result?.result ?? buildSessionResult(this.world);
    const clip = this.recorder.length >= 2 ? this.recorder.toClip() : null;
    return {
      result,
      world: this.world,
      ctx: this.ctx,
      replay: clip ? { clip, track: this.track, scene: { ...this.sceneOptions, racingLine: 'off' }, focusCarId: this.viewCarId } : null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host?.dispose();
    this.client?.dispose();
    this.hud.destroy();
    this.scene.dispose();
    this.deps.audio.stopSession();
    this.deps.input.setSplitScreen(false);
    this.deps.input.reset();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private createHud(settings: Settings): HudLayer {
    const cb: HudCallbacks = {
      resume: () => this.setPaused(false),
      restart: () => this.restart(),
      quit: () => this.deps.quit(),
      openSettings: () => this.deps.openSettings(),
      requestPit: (carId, compound) => (this.client ? this.client.requestPit(compound) : requestPit(this.world, carId, compound)),
      cancelPit: (carId) => (this.client ? this.client.cancelPit() : cancelPit(this.world, carId)),
      setErsMode: (carId, mode) => (this.client ? this.client.setErsMode(mode) : setErsMode(this.world, carId, mode)),
      setRacingLine: (mode) => {
        this.racingLine = mode;
        this.scene.setRacingLine(mode);
      },
      setCamera: (playerIndex, mode) => this.setCamera(playerIndex, mode),
      flashback: () => {
        if (this.flashback()) this.setPaused(false);
      },
      endSession: () => {
        if (!this.client) endSession(this.world);
        this.setPaused(false);
      },
      // only the chosen player retires; the race runs on (watchFinish fast-forwards once every human is out)
      retire: (playerIndex) => {
        if (this.client) {
          this.client.retire();
          this.setPaused(false);
          return;
        }
        // online host: its own car only (the others are remote players)
        const own = this.online ? [getPlayerCarId(this.world, 0)] : this.humans;
        for (const id of own) {
          const car = this.world.cars[id];
          if (!car || (playerIndex !== undefined && car.playerIndex !== playerIndex)) continue;
          if (car.status !== 'finished' && car.status !== 'retired') retireCar(this.world, id, '車手退賽');
        }
        this.setPaused(false);
      },
    };
    return new HudLayer(this.deps.uiRoot, this.track, this.hudViews, settings, cb, this.online);
  }

  private viewIndexOf(playerIndex: 0 | 1): number {
    return this.hudViews.findIndex((v) => v.playerIndex === playerIndex);
  }

  private setCamera(playerIndex: 0 | 1, mode: CameraMode): void {
    const view = this.views[this.viewIndexOf(playerIndex)];
    if (view) view.camera = mode;
  }

  /** Current controls of every human player, indexed by playerIndex (null = no such player). */
  private readControls(): (ControlInput | null)[] {
    const out: (ControlInput | null)[] = [null, null];
    for (const v of this.hudViews) {
      if (!this.humans.includes(v.carId)) continue;
      const pi = v.playerIndex;
      out[pi] = withPendingOneShots(this.deps.input.getControl(pi), this.pending[pi] ?? null);
    }
    return out;
  }

  /** A frame that ran no sub-step: keep its one-shot presses for the next step. */
  private holdOneShots(controls: readonly (ControlInput | null)[]): void {
    this.pending = controls.map((c) => (c ? { ...c } : null));
  }

  private simulate(steps: number, controls: readonly (ControlInput | null)[]): void {
    const { first, rest } = substepInputs(controls);
    const client = this.client;
    if (client) {
      // a client predicts its own car only; the host runs the world
      for (let k = 0; k < steps; k++) {
        const car = client.car;
        const input = this.autopilot && car ? computeAIInput(this.world, car, this.track, SIM_DT) : (k === 0 ? first : rest)[0];
        client.step(input ?? COAST);
      }
      this.pending = [null, null];
      return;
    }
    for (let k = 0; k < steps; k++) {
      const local = this.autopilot ? this.autopilotInputs() : k === 0 ? first : rest;
      let inputs = local;
      if (this.host) {
        // the remote players' inputs for this step (one-shots fire once) beside the host's own
        inputs = [local[0] ?? null, null, null, null];
        this.host.fillInputs(inputs);
        if (this.autopilot) for (const id of this.humans) this.autopilotFor(id, inputs, true);
      }
      stepWorld(this.world, this.track, inputs, SIM_DT);
      this.afterStep();
      this.host?.afterStep();
    }
    this.pending = [null, null];
  }

  /** AI-computed controls for every human car (autopilot test aid), indexed by playerIndex. */
  private autopilotInputs(): (ControlInput | null)[] {
    const out: (ControlInput | null)[] = [null, null, null, null];
    for (const id of this.humans) this.autopilotFor(id, out, false);
    return out;
  }

  /** `out[playerIndex]` = the AI controller's input for human car `id` (only where none is set, if `fillOnly`). */
  private autopilotFor(id: number, out: (ControlInput | null)[], fillOnly: boolean): void {
    const car = this.world.cars[id];
    if (!car || car.playerIndex < 0) return;
    if (fillOnly && out[car.playerIndex]) return;
    out[car.playerIndex] = computeAIInput(this.world, car, this.track, SIM_DT);
  }

  private afterStep(): void {
    const w = this.world;
    if (w.session.phase !== 'finished') this.flashbacks.record(w);
    this.recorder.maybeRecord(w.time, () => buildRenderFrame(w, this.track));
  }

  private dispatchEvents(): void {
    const w = this.world;
    let events: GameEvent[];
    if (this.client) {
      // what the host reports (local prediction events are dropped by the client session)
      w.events.length = 0;
      events = this.client.takeEvents();
    } else {
      events = w.events.splice(0, w.events.length);
      this.host?.forwardEvents(events);
    }
    if (events.length === 0) return;
    this.hud.handleEvents(events, w);
    // online: sound and rumble are for this computer's car only (the others are remote players)
    this.deps.audio.handleEvents(events, this.online ? [this.viewCarId] : this.humans);
    for (const ev of events) {
      if (ev.type !== 'collision') continue;
      if (this.online) {
        if (ev.carId === this.viewCarId) this.deps.input.rumble(0, clamp01(ev.impulse / RUMBLE_FULL_IMPULSE), RUMBLE_MS);
        continue;
      }
      const pi = w.cars[ev.carId]?.playerIndex;
      if (pi === 0 || pi === 1) this.deps.input.rumble(pi, clamp01(ev.impulse / RUMBLE_FULL_IMPULSE), RUMBLE_MS);
    }
  }

  private handleAction(a: InputAction): void {
    const pi = a.playerIndex;
    switch (a.action) {
      case 'pause':
        this.setPaused(!this.pausedFlag);
        return;
      case 'fullscreen':
        this.deps.toggleFullscreen();
        return;
      default:
        break;
    }
    if (this.pausedFlag) return;
    switch (a.action) {
      case 'camera': {
        const view = this.views[this.viewIndexOf(pi)];
        if (view) view.camera = nextCamera(RaceScene.CAMERA_CYCLE, view.camera);
        break;
      }
      case 'flashback':
        this.flashback();
        break;
      case 'mfd':
        this.hud.toggleMfd(pi);
        break;
      case 'pitRequest':
        this.togglePit(pi);
        break;
      case 'hud':
        this.hud.toggleVisible();
        break;
      default:
        break;
    }
  }

  /** Gamepad in the pause menu: D-pad moves / changes values, A confirms, B resumes (menu callbacks may dispose us). */
  private handleMenuInput(m: PadMenuInput): void {
    if (m === 'back') this.setPaused(false);
    else if (m === 'confirm') this.hud.activateMenu();
    else this.hud.navigateMenu(m);
  }

  private togglePit(playerIndex: 0 | 1): void {
    const w = this.world;
    const carId = this.client ? this.client.carId : getPlayerCarId(w, playerIndex);
    const car = w.cars[carId];
    if (!car) return;
    const compound = this.hud.getMfdCompound(playerIndex) ?? car.pit.nextCompound;
    if (this.client) {
      if (car.pit.requested) {
        if (car.pit.phase === 'none') this.client.cancelPit();
      } else this.client.requestPit(compound);
      return;
    }
    if (car.pit.requested) {
      if (car.pit.phase === 'none') cancelPit(w, carId);
      return;
    }
    requestPit(w, carId, compound);
  }

  private present(dt: number, fps: number): void {
    const w = this.world;
    for (let i = 0; i < this.views.length; i++) {
      const view = this.views[i] as ViewSpec;
      const pi = this.hudViews[i]?.playerIndex ?? 0;
      view.lookBack = !this.pausedFlag && this.deps.input.isHeld('lookBack', pi);
    }
    const frame = this.client ? this.client.renderFrame(dt) : buildRenderFrame(w, this.track);
    this.scene.render(frame, this.views, dt);
    const v0 = this.views[0];
    if (!this.pausedFlag && v0) {
      // split-screen: P2's car is a co-listener so its own engine never fades out with distance from P1's camera
      // and shares the ambience / on-board mix (wind, surface, interior engine) with P1
      const second = this.views[1];
      const others = this.views.slice(1).map((v) => v.carId);
      this.deps.audio.update(frame, v0.carId, v0.camera, this.scene.getCameraPosition(0), dt, others, second ? { carId: second.carId, camera: second.camera } : undefined);
    }
    const info: HudFrameInfo = {
      fps,
      cameras: this.views.map((v) => v.camera),
      // 0 hides the pause-menu item whenever a flashback is not possible (finished, retired, used up)
      flashbacksLeft: this.flashbackBlock() ? 0 : flashbacksLeft(w.config.rules, w.flashbacksUsed),
      racingLine: this.racingLine,
      replay: null,
    };
    this.hud.update(w, dt, info);
  }

  /** Race / practice / qualifying: once every human car is done, fast-forward the rest of the field after a short grace. */
  private watchFinish(): void {
    const w = this.world;
    // a client's session ends with the host's result
    if (this.client) return;
    const allDone =
      w.session.kind !== 'timeTrial' &&
      w.session.phase !== 'finished' &&
      this.humans.length > 0 &&
      this.humans.every((id) => {
        const st = w.cars[id]?.status;
        return st === 'finished' || st === 'retired';
      });
    if (!allDone) {
      this.humansDoneAt = null;
      return;
    }
    if (this.humansDoneAt === null) this.humansDoneAt = w.time;
    if (this.pausedFlag || w.time - this.humansDoneAt < FINISH_GRACE) return;
    this.fastForward = true;
    this.fastForwardFrom = w.time;
    this.deps.audio.setPaused(true);
    this.deps.fastForwardStarted();
  }

  private runFastForward(): void {
    const w = this.world;
    const start = now();
    while (!isSessionOver(w) && now() - start < FAST_FORWARD_BUDGET_MS) {
      for (let k = 0; k < 60 && !isSessionOver(w); k++) {
        // finished human cars do their cool-down lap on the AI controller (coasting would leave the road)
        stepWorld(w, this.track, this.autopilotInputs(), SIM_DT);
        this.recorder.maybeRecord(w.time, () => buildRenderFrame(w, this.track));
      }
      w.events.length = 0;
      if (w.time - this.fastForwardFrom > FAST_FORWARD_MAX_SIM) {
        if (w.session.kind === 'race') concludeRace(w, this.track);
        else endSession(w);
      }
    }
    w.events.length = 0;
  }
}
