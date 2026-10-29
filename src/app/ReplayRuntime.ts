/**
 * Post-session replay: rebuilds a RaceScene for the recorded track and plays the recorded RenderFrames with
 * interpolation (TV camera by default), driven by the HUD replay bar (play/pause, seek, speed, camera, exit)
 * and the pause key (exit). Audio follows the replayed frames while playing.
 */
import type { CameraMode, Settings, ViewSpec, WorldState } from '../core/types';
import type { AudioEngine } from '../audio/index';
import type { InputAction, PadMenuInput } from '../input/index';
import { RaceScene } from '../render/RaceScene';
import type { GameRenderer } from '../render/GameRenderer';
import { HudLayer, type HudCallbacks } from '../ui/hud/index';
import { clipDuration, clipStart, sampleClip } from './replay';
import type { ReplayPackage } from './SessionRuntime';
import { nextCamera } from './views';

const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

export interface ReplayDeps {
  readonly gr: GameRenderer;
  readonly uiRoot: HTMLElement;
  readonly audio: AudioEngine;
  settings(): Settings;
  toggleFullscreen(): void;
}

const noop = (): void => undefined;

/** HUD callbacks are not reachable while replaying (no pause menu / MFD); keep them inert. */
const INERT_HUD: HudCallbacks = {
  resume: noop,
  restart: noop,
  quit: noop,
  openSettings: noop,
  requestPit: noop,
  cancelPit: noop,
  setErsMode: noop,
  setRacingLine: noop,
  setCamera: noop,
  flashback: noop,
  endSession: noop,
  retire: noop,
};

export class ReplayRuntime {
  private readonly deps: ReplayDeps;
  private readonly pkg: ReplayPackage;
  private readonly world: WorldState;
  private readonly onExit: () => void;
  private readonly scene: RaceScene;
  private readonly hud: HudLayer;
  private readonly view: ViewSpec;
  private readonly cameraCycle: CameraMode[] = ['tv', ...RaceScene.CAMERA_CYCLE];
  private readonly start: number;
  private readonly duration: number;
  private t = 0;
  private playing = true;
  private speed = 1;
  private exitRequested = false;
  private audioPaused = false;
  private disposed = false;

  constructor(deps: ReplayDeps, pkg: ReplayPackage, finalWorld: WorldState, onExit: () => void) {
    this.deps = deps;
    this.pkg = pkg;
    this.world = finalWorld;
    this.onExit = onExit;
    this.start = clipStart(pkg.clip);
    this.duration = clipDuration(pkg.clip);
    const settings = deps.settings();
    this.view = { carId: pkg.focusCarId, camera: 'tv', lookBack: false, viewport: { x: 0, y: 0, w: 1, h: 1 } };
    this.scene = new RaceScene(deps.gr, pkg.track, { ...pkg.scene, settings });
    try {
      this.hud = new HudLayer(deps.uiRoot, pkg.track, [{ playerIndex: 0, carId: pkg.focusCarId, region: 'full' }], settings, INERT_HUD);
    } catch (err) {
      this.scene.dispose();
      throw err;
    }
    this.hud.setReplayHandlers({
      toggle: () => this.togglePlay(),
      seek: (frac) => this.seek(frac),
      speed: (x) => {
        if (SPEEDS.includes(x)) this.speed = x;
      },
      camera: () => this.cycleCamera(),
      // exiting disposes this HUD: do it on the next frame, outside the click handler
      exit: () => {
        this.exitRequested = true;
      },
    });
    deps.audio.stopSession();
    deps.audio.setPaused(false);
  }

  get info(): { time: number; duration: number; playing: boolean; speed: number } {
    return { time: this.t, duration: this.duration, playing: this.playing, speed: this.speed };
  }

  /** `menuInputs` = gamepad presses: A play/pause, D-pad left/right seek, up/down speed (the replay bar's own actions). */
  frame(dt: number, fps: number, actions: readonly InputAction[], menuInputs: readonly PadMenuInput[] = []): void {
    if (this.disposed) return;
    for (const m of menuInputs) this.hud.handleReplayPad(m);
    for (const a of actions) {
      if (a.action === 'pause') this.exitRequested = true;
      else if (a.action === 'camera') this.cycleCamera();
      else if (a.action === 'fullscreen') this.deps.toggleFullscreen();
      else if (a.action === 'hud') this.hud.toggleVisible();
    }
    if (this.exitRequested) {
      this.exitRequested = false;
      this.onExit();
      return;
    }
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t >= this.duration) {
        this.t = this.duration;
        this.playing = false;
      }
    }
    this.syncAudioPause();
    const frame = sampleClip(this.pkg.clip, this.start + this.t);
    if (frame) {
      this.scene.render(frame, [this.view], this.playing ? dt * this.speed : 0);
      if (this.playing) this.deps.audio.update(frame, this.view.carId, this.view.camera, this.scene.getCameraPosition(0), dt);
    }
    this.hud.update(this.world, dt, { fps, cameras: [this.view.camera], flashbacksLeft: 0, racingLine: 'off', replay: this.info });
  }

  /** Tab hidden: stop playback (resumed by the player). */
  pause(): void {
    this.playing = false;
    this.syncAudioPause();
  }

  applySettings(settings: Settings): void {
    if (!this.disposed) this.hud.applySettings(settings);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hud.setReplayHandlers(null);
    this.hud.destroy();
    this.scene.dispose();
    this.deps.audio.stopSession();
  }

  private togglePlay(): void {
    if (!this.playing && this.t >= this.duration) this.t = 0;
    this.playing = !this.playing;
  }

  private seek(frac: number): void {
    if (!Number.isFinite(frac)) return;
    this.t = Math.min(1, Math.max(0, frac)) * this.duration;
  }

  private cycleCamera(): void {
    this.view.camera = nextCamera(this.cameraCycle, this.view.camera);
  }

  private syncAudioPause(): void {
    if (this.audioPaused === !this.playing) return;
    this.audioPaused = !this.playing;
    this.deps.audio.setPaused(this.audioPaused);
  }
}
