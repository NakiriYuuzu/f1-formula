/**
 * Procedural audio (owner: audio/input agent). WebAudio only, every sound synthesized (no audio files).
 *
 * Graph: voices → engine bus ┐
 *        ambience / session one-shots → sfx bus ┴→ session (pause fade) → master → compressor → limiter → out
 *        UI one-shots → ui bus → master
 *        background music (music.ts) → music bus → master (outside the session gate: pausing a session keeps it playing)
 * The YouTube music source (youtube.ts) plays outside the graph, following the music bus level, scene and tab.
 * The AudioContext is created lazily inside resume() (user gesture); until it runs, every method is a no-op.
 */
import { clamp, clamp01, damp, yawFromDir } from '../core/math';
import type { CameraMode, CarRenderState, GameEvent, RenderFrame, Settings } from '../core/types';
import { ListenerAmbience } from './ambience';
import { CarVoice } from './carVoice';
import { createAudioContext, createSharedAudio, glide, releaseNodes, snap, type SharedAudio } from './context';
import { MusicPlayer, musicSceneFactor, musicSceneOf } from './music';
import { reportMusicError } from './musicStore';
import { YouTubeMusic } from './youtube';
import {
  ONBOARD_CAMERAS,
  carVelocity,
  distance3,
  distanceCutoff,
  distanceGain,
  dopplerFactor,
  impactStrength,
  panFor,
  rpmNorm,
  selectVoicedCars,
  squealIntensity,
  type Vec3,
} from './mix';
import {
  OneShotPool,
  blueFlagTick,
  chequeredMotif,
  controlBuzz,
  collisionThump,
  lightsOutCue,
  limiterBeep,
  pbChime,
  raceControlCue,
  raceControlCueFor,
  shiftClick,
  startBeep,
  uiSound,
  wheelGun,
} from './sfx';

/** Listener car + 4 nearest + 1 spare so a swap can cross-fade immediately. */
const VOICE_COUNT = 6;
const IDLE_RPM = 4000;
/** Initial rpm ceiling; raised to the highest rpm actually observed. */
const DEFAULT_MAX_RPM = 11500;
const RPM_SANITY_LIMIT = 25000;
/** The listener car never drops below this level on exterior cameras (TV cam far away). */
const LISTENER_FLOOR = 0.35;
const ENGINE_BUS_TRIM = 0.7;
const PAUSE_TAU = 0.08;
/** music fades on scene changes / tab hide (s) */
const MUSIC_FADE_TAU = 0.2;
const MAX_DT = 0.25;
/** Camera moving faster than this (m/s) between frames = a cut, not motion. */
const CAMERA_CUT_SPEED = 150;
const LIMITER_BEEP_INTERVAL = 0.6;
const THUMP_MIN_INTERVAL = 0.15;
const IMPACT_EDGE = 120;
const AUTO_RESUME_INTERVAL_MS = 2000;

interface Buses {
  master: GainNode;
  session: GainNode;
  engine: GainNode;
  sfx: GainNode;
  ui: GainNode;
  music: GainNode;
  nodes: AudioNode[];
}

/** Per-car edge-detection state (gear changes, impacts, lifts, limiter). */
interface CarTrack {
  gear: number;
  impact: number;
  rpm: number;
  liftArmed: boolean;
  limiterTime: number;
  lastThump: number;
}

/** Creates the YouTube mini player (tests inject a fake; null = no page to show it in). */
type YouTubeFactory = (onStatus: (message: string | null) => void) => Pick<YouTubeMusic, 'update' | 'dispose'>;

const volume = (v: number, fallback: number): number => {
  const x = Number.isFinite(v) ? clamp01(v) : fallback;
  return x * x;
};

export class AudioEngine {
  private settings: Settings;
  private ctx: AudioContext | null = null;
  private shared: SharedAudio | null = null;
  private buses: Buses | null = null;
  private voices: CarVoice[] = [];
  private ambience: ListenerAmbience | null = null;
  private sessionShots: OneShotPool | null = null;
  private music: MusicPlayer | null = null;
  /** App state last passed to setMusicScene() */
  private musicScene = 'boot';
  private musicHidden = false;
  private readonly youtubeFactory: YouTubeFactory | null;
  private youtube: Pick<YouTubeMusic, 'update' | 'dispose'> | null = null;
  /** the YouTube link fails (or cannot play here): the original music plays instead */
  private youtubeFailed = false;
  private youtubeMessage: string | null = null;
  private syncingMusic = false;
  private uiShots: OneShotPool | null = null;
  private paused = false;
  private disposed = false;
  /** the context has run at least once (so later suspensions may be resumed without a new gesture) */
  private wasRunning = false;
  private lastResumeAttempt = 0;

  private readonly tracks = new Map<number, CarTrack>();
  private readonly voiced = new Set<number>();
  private lastCars: readonly CarRenderState[] = [];
  private lastFrameTime = Number.NaN;
  private observedMaxRpm = DEFAULT_MAX_RPM;
  private camPrev: Vec3 | null = null;
  private camPos: Vec3 = { x: 0, y: 0, z: 0 };
  private camVel = { x: 0, z: 0 };
  private listenerYaw = 0;
  private listenerCarId = -1;
  /** split-screen: other human cars (always voiced, never distance-faded below the listener floor) */
  private coListeners: readonly number[] = [];
  private onboard = false;
  /** split-screen: the second human car whose view is on board (its engine / ambience sound interior too) */
  private extraOnboardId = -1;
  private limiterTimer = 0;
  private finishCuePlayed = false;
  /** player cars that already completed a valid lap (first lap is a trivial PB in races) */
  private readonly playerLapSeen = new Set<number>();

  constructor(settings: Settings, options: { youtube?: YouTubeFactory | null } = {}) {
    this.settings = settings;
    this.youtubeFactory =
      options.youtube !== undefined ? options.youtube : typeof document !== 'undefined' ? (onStatus) => new YouTubeMusic(onStatus) : null;
  }

  /** Must be called from a user gesture handler before any sound plays (autoplay policy). Safe to call repeatedly. */
  async resume(): Promise<void> {
    if (this.disposed) return;
    if (!this.ctx) {
      const ctx = createAudioContext();
      if (!ctx) return;
      try {
        this.ctx = ctx;
        this.shared = createSharedAudio(ctx);
        this.buses = this.buildBuses(ctx);
        this.uiShots = new OneShotPool(this.shared, this.buses.ui, 12);
        this.sessionShots = new OneShotPool(this.shared, this.buses.sfx, 24);
      } catch {
        this.teardownContext();
        return;
      }
      try {
        this.music = new MusicPlayer(this.shared, this.buses.music);
        this.syncMusic(0.05);
      } catch {
        // music is optional: the rest of the audio keeps working
        this.music?.dispose();
        this.music = null;
      }
    }
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      try {
        await this.ctx.resume();
      } catch {
        // Still locked by the autoplay policy: stays a no-op until the next gesture.
      }
    }
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    const ctx = this.ctx;
    const b = this.buses;
    if (!ctx || !b) return;
    const now = ctx.currentTime;
    glide(b.master.gain, volume(settings.masterVolume, 0.8), now, 0.03);
    glide(b.engine.gain, volume(settings.engineVolume, 0.8) * ENGINE_BUS_TRIM, now, 0.03);
    glide(b.sfx.gain, volume(settings.sfxVolume, 0.8), now, 0.03);
    glide(b.ui.gain, volume(settings.uiVolume, 0.6), now, 0.03);
    this.syncMusic(0.05);
  }

  /**
   * Where music plays, from the App state (boot | menu | loading | session | results | replay): everywhere except
   * sessions / replays, which keep it (ducked) only when `musicInRace` is on. Fades smoothly.
   */
  setMusicScene(state: string): void {
    this.musicScene = state;
    this.syncMusic(MUSIC_FADE_TAU);
  }

  /** Hidden tab: fade the music out and stop scheduling notes; resumes when shown again. */
  setMusicHidden(hidden: boolean): void {
    this.musicHidden = hidden;
    this.syncMusic(MUSIC_FADE_TAU);
  }

  /** Music bus level currently requested (0 while hidden / silent scene / no context); for tests and diagnostics. */
  musicLevel(): number {
    return this.ctx && this.buses ? this.musicTarget() : 0;
  }

  /**
   * Per-frame update while a session is shown. `listenerCarId` = player car (on-board sound when camera is
   * cockpit/nose/tcam), `cameraPos` = listener position for distance attenuation of other cars.
   * `coListenerIds` (split-screen) = the other players' cars: their engine, shift clicks and limiter beep stay
   * audible however far they are from the first player's camera (one shared stereo mix for both players).
   * `extraListener` (split-screen) = the second player's car and camera: its ambience (wind, spray, surface) joins
   * the first player's beds at the louder of the two, and its engine is interior-voiced when its camera is on board.
   */
  update(
    frame: RenderFrame,
    listenerCarId: number,
    camera: CameraMode,
    cameraPos: { x: number; y: number; z: number },
    dt: number,
    coListenerIds: readonly number[] = [],
    extraListener?: { carId: number; camera: CameraMode },
  ): void {
    const ctx = this.runningContext();
    if (!ctx || !this.shared || !this.buses) return;
    const now = ctx.currentTime;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_DT) : 0;
    this.ensureSession();

    const cars: readonly CarRenderState[] = Array.isArray(frame.cars) ? frame.cars : [];
    const frameTime = Number.isFinite(frame.time) ? frame.time : 0;
    const discontinuity =
      !Number.isFinite(this.lastFrameTime) || frameTime < this.lastFrameTime - 1e-3 || frameTime - this.lastFrameTime > 1;
    this.lastFrameTime = frameTime;
    this.lastCars = cars;

    const cam: Vec3 = {
      x: Number.isFinite(cameraPos.x) ? cameraPos.x : 0,
      y: Number.isFinite(cameraPos.y) ? cameraPos.y : 0,
      z: Number.isFinite(cameraPos.z) ? cameraPos.z : 0,
    };
    this.updateCameraMotion(cam, step, discontinuity);

    const listener = cars.find((c) => c.carId === listenerCarId && !c.ghost) ?? null;
    this.listenerCarId = listenerCarId;
    this.coListeners = coListenerIds.filter((id) => id !== listenerCarId);
    this.onboard = listener !== null && ONBOARD_CAMERAS.has(camera);
    const extra = extraListener ? (cars.find((c) => c.carId === extraListener.carId && !c.ghost) ?? null) : null;
    this.extraOnboardId = extra && extraListener && extra.carId !== listenerCarId && ONBOARD_CAMERAS.has(extraListener.camera) ? extra.carId : -1;
    this.updateListenerYaw(listener, cam);

    for (const c of cars) {
      if (Number.isFinite(c.rpm) && c.rpm > this.observedMaxRpm && c.rpm < RPM_SANITY_LIMIT) this.observedMaxRpm = c.rpm;
    }

    this.assignVoices(cars, listenerCarId, cam, now);
    const wetness = Number.isFinite(frame.weather?.wetness) ? frame.weather.wetness : 0;
    for (const voice of this.voices) {
      if (voice.carId === null || voice.isReleasing()) continue;
      const car = cars.find((c) => c.carId === voice.carId);
      if (!car) {
        voice.release(now);
        continue;
      }
      this.driveVoice(voice, car, wetness, step, discontinuity, now);
    }

    this.detectImpacts(cars, discontinuity, now);
    this.pruneTracks(cars);

    const listenerGain = listener ? this.carGain(listener) : 0;
    this.ambience?.update(
      {
        speed: listener ? listener.speed : 0,
        surface: listener ? listener.surface : 'asphalt',
        rain: Number.isFinite(frame.weather?.rain) ? frame.weather.rain : 0,
        wetness,
        interior: this.onboard,
        trackside: camera === 'tv',
        gain: listenerGain,
      },
      now,
      extra && extraListener && extra.carId !== listenerCarId
        ? {
            speed: extra.speed,
            surface: extra.surface,
            interior: this.extraOnboardId === extra.carId,
            trackside: extraListener.camera === 'tv',
            gain: this.carGain(extra),
          }
        : undefined,
    );

    const limiter = (listener !== null && listener.limiter) || cars.some((c) => this.coListeners.includes(c.carId) && !c.ghost && c.limiter);
    this.updateLimiterBeep(limiter, step, now);
  }

  /** One-shot sounds for events (start beeps, lights out, collisions, pit, lap PB, chequered…). */
  handleEvents(events: GameEvent[], playerCarIds: number[]): void {
    const ctx = this.runningContext();
    const pool = this.sessionShots;
    if (!ctx || !pool || !Array.isArray(events) || events.length === 0) return;
    const now = ctx.currentTime;
    const players = Array.isArray(playerCarIds) ? playerCarIds : [];
    for (const e of events) {
      switch (e.type) {
        case 'lightsOn':
          startBeep(pool, now);
          break;
        case 'lightsOut':
          lightsOutCue(pool, now);
          this.finishCuePlayed = false;
          this.playerLapSeen.clear();
          break;
        case 'sessionStart':
          this.finishCuePlayed = false;
          this.playerLapSeen.clear();
          break;
        case 'lapComplete':
          if (e.valid && players.includes(e.carId)) {
            if (e.personalBest && (e.overallBest || this.playerLapSeen.has(e.carId))) pbChime(pool, now, e.overallBest);
            this.playerLapSeen.add(e.carId);
          }
          break;
        case 'carFinished':
          if (players.includes(e.carId)) this.playFinishCue(pool, now);
          break;
        case 'chequered':
          if (players.length === 0) this.playFinishCue(pool, now);
          break;
        case 'collision':
          this.thumpForCar(e.carId, e.impulse, now);
          break;
        case 'pitStop':
          if (players.includes(e.carId)) wheelGun(pool, now);
          break;
        case 'raceControl': {
          const cue = players.length > 0 ? raceControlCueFor(e.mode, e.previous) : null;
          if (cue) raceControlCue(pool, now, cue);
          break;
        }
        case 'blueFlag':
          if (players.includes(e.carId)) blueFlagTick(pool, now);
          break;
        case 'controlWarning':
          if (players.includes(e.carId)) controlBuzz(pool, now);
          break;
        default:
          break;
      }
    }
  }

  /** Fade engine/ambience out while paused; resume when false. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    const ctx = this.ctx;
    if (!ctx || !this.buses) return;
    glide(this.buses.session.gain, paused ? 0 : 1, ctx.currentTime, PAUSE_TAU);
  }

  /** Stop all session sounds (leaving a session). */
  stopSession(): void {
    for (const v of this.voices) v.dispose();
    this.voices = [];
    this.ambience?.dispose();
    this.ambience = null;
    this.sessionShots?.stopAll();
    this.tracks.clear();
    this.voiced.clear();
    this.playerLapSeen.clear();
    this.lastCars = [];
    this.lastFrameTime = Number.NaN;
    this.observedMaxRpm = DEFAULT_MAX_RPM;
    this.camPrev = null;
    this.camVel = { x: 0, z: 0 };
    this.listenerCarId = -1;
    this.coListeners = [];
    this.onboard = false;
    this.extraOnboardId = -1;
    this.limiterTimer = 0;
    this.finishCuePlayed = false;
    this.paused = false;
    if (this.ctx && this.buses) snap(this.buses.session.gain, 1, this.ctx.currentTime);
  }

  ui(kind: 'move' | 'confirm' | 'back' | 'error'): void {
    const ctx = this.runningContext();
    if (!ctx || !this.uiShots) return;
    uiSound(this.uiShots, ctx.currentTime, kind);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopSession();
    this.uiShots?.stopAll();
    this.teardownContext();
    this.youtube?.dispose();
    this.youtube = null;
    this.disposed = true;
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** The context if it is running; otherwise null (plus a throttled resume if the browser suspended it mid-game). */
  private runningContext(): AudioContext | null {
    const ctx = this.ctx;
    if (!ctx || !this.buses) return null;
    if (ctx.state === 'running') {
      this.wasRunning = true;
      return ctx;
    }
    if (this.wasRunning && ctx.state !== 'closed') {
      const t = Date.now();
      if (t - this.lastResumeAttempt > AUTO_RESUME_INTERVAL_MS) {
        this.lastResumeAttempt = t;
        ctx.resume().catch(() => undefined);
      }
    }
    return null;
  }

  private buildBuses(ctx: AudioContext): Buses {
    const s = this.settings;
    const gain = (value: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = value;
      return g;
    };
    const master = gain(volume(s.masterVolume, 0.8));
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.06;
    const out = gain(0.9);
    master.connect(comp).connect(limiter).connect(out).connect(ctx.destination);

    const session = gain(this.paused ? 0 : 1);
    session.connect(master);
    const engine = gain(volume(s.engineVolume, 0.8) * ENGINE_BUS_TRIM);
    engine.connect(session);
    const sfx = gain(volume(s.sfxVolume, 0.8));
    sfx.connect(session);
    const ui = gain(volume(s.uiVolume, 0.6));
    ui.connect(master);
    const music = gain(this.musicTarget());
    music.connect(master);
    return { master, session, engine, sfx, ui, music, nodes: [engine, sfx, ui, music, session, master, comp, limiter, out] };
  }

  private musicTarget(): number {
    if (this.musicHidden) return 0;
    return volume(this.settings.musicVolume, 0.6) * musicSceneFactor(this.musicScene, this.settings.musicInRace);
  }

  private syncMusic(tau: number): void {
    const ctx = this.ctx;
    const b = this.buses;
    if (!ctx || !b) return;
    const target = this.musicTarget();
    glide(b.music.gain, target, ctx.currentTime, tau);
    const youtube = this.settings.musicSource === 'youtube';
    this.syncingMusic = true;
    try {
      this.syncYouTube(youtube, target);
    } finally {
      this.syncingMusic = false;
    }
    this.music?.setSource(youtube ? (this.youtubeFailed ? 'original' : 'off') : this.settings.musicSource);
    this.music?.setScene(musicSceneOf(this.musicScene));
    this.music?.setActive(target > 0);
  }

  /** The YouTube mini player follows the music bus: its scenes, its level (times the master volume), the hidden tab. */
  private syncYouTube(on: boolean, target: number): void {
    if (!on) {
      this.youtube?.dispose();
      this.youtube = null;
      this.youtubeFailed = false;
      if (this.youtubeMessage !== null) reportMusicError(null);
      this.youtubeMessage = null;
      return;
    }
    if (!this.youtube) {
      if (!this.youtubeFactory) {
        // no page to show a player in: the original music
        this.youtubeFailed = true;
        return;
      }
      this.youtube = this.youtubeFactory((message) => {
        this.youtubeMessage = message;
        reportMusicError(message);
        if (this.youtubeFailed === (message !== null)) return;
        this.youtubeFailed = message !== null;
        if (!this.syncingMusic) this.syncMusic(0.05);
      });
    }
    const placement = musicSceneOf(this.musicScene) === 'race' ? 'race' : 'menu';
    this.youtube.update(this.settings.musicYoutube, target > 0, target * volume(this.settings.masterVolume, 0.8), placement);
  }

  private teardownContext(): void {
    this.music?.dispose();
    this.music = null;
    if (this.buses) releaseNodes(this.buses.nodes);
    this.buses = null;
    this.shared = null;
    this.uiShots = null;
    this.sessionShots = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => undefined);
  }

  private ensureSession(): void {
    if (!this.shared || !this.buses) return;
    if (this.voices.length === 0) {
      for (let i = 0; i < VOICE_COUNT; i++) this.voices.push(new CarVoice(this.shared, this.buses.engine, this.buses.sfx));
    }
    if (!this.ambience) this.ambience = new ListenerAmbience(this.shared, this.buses.sfx);
  }

  private updateCameraMotion(cam: Vec3, step: number, discontinuity: boolean): void {
    const prev = this.camPrev;
    if (prev && step > 0 && !discontinuity) {
      const vx = (cam.x - prev.x) / step;
      const vz = (cam.z - prev.z) / step;
      if (!Number.isFinite(vx) || !Number.isFinite(vz) || Math.hypot(vx, vz) > CAMERA_CUT_SPEED) {
        this.camVel = { x: 0, z: 0 };
      } else {
        this.camVel = { x: damp(this.camVel.x, vx, 10, step), z: damp(this.camVel.z, vz, 10, step) };
      }
    } else if (discontinuity) {
      this.camVel = { x: 0, z: 0 };
    }
    this.camPrev = cam;
    this.camPos = cam;
  }

  /** Listener orientation: along the camera→car line for chase/TV cameras, the car heading on board. */
  private updateListenerYaw(listener: CarRenderState | null, cam: Vec3): void {
    if (!listener) return;
    const dx = listener.x - cam.x;
    const dz = listener.z - cam.z;
    const yaw = !this.onboard && Math.hypot(dx, dz) > 2 ? yawFromDir(dx, dz) : listener.yaw;
    if (Number.isFinite(yaw)) this.listenerYaw = yaw;
  }

  private assignVoices(cars: readonly CarRenderState[], listenerCarId: number, cam: Vec3, now: number): void {
    for (const v of this.voices) v.freeIfSilent(now);
    this.voiced.clear();
    for (const v of this.voices) if (v.carId !== null && !v.isReleasing()) this.voiced.add(v.carId);
    const desired = selectVoicedCars(cars, listenerCarId, cam, this.voiced, undefined, this.coListeners);
    for (const v of this.voices) {
      if (v.carId === null) continue;
      if (desired.includes(v.carId)) v.retain();
      else v.release(now);
    }
    for (const carId of desired) {
      if (this.voices.some((v) => v.carId === carId)) continue;
      const free = this.voices.find((v) => v.carId === null);
      if (!free) break;
      free.assign(carId);
    }
  }

  /** Attenuation for a car as heard from the current camera. */
  private carGain(car: CarRenderState): number {
    const isListener = car.carId === this.listenerCarId;
    if (this.isInterior(car.carId)) return 1;
    const g = distanceGain(distance3(car, this.camPos));
    return isListener || this.coListeners.includes(car.carId) ? Math.max(LISTENER_FLOOR, g) : g;
  }

  /** The car is a human car whose camera is on board: it sounds like the cockpit (centred, no distance fade). */
  private isInterior(carId: number): boolean {
    return carId === this.listenerCarId ? this.onboard : carId === this.extraOnboardId;
  }

  private carPan(car: CarRenderState): number {
    if (this.isInterior(car.carId)) return 0;
    return panFor(this.listenerYaw, car.x - this.camPos.x, car.z - this.camPos.z);
  }

  private trackFor(car: CarRenderState, now: number): { track: CarTrack; fresh: boolean } {
    const existing = this.tracks.get(car.carId);
    if (existing) return { track: existing, fresh: false };
    const track: CarTrack = {
      gear: car.gear,
      impact: Number.isFinite(car.impact) ? car.impact : 0,
      rpm: Number.isFinite(car.rpm) ? car.rpm : 0,
      liftArmed: false,
      limiterTime: 0,
      lastThump: now - THUMP_MIN_INTERVAL,
    };
    this.tracks.set(car.carId, track);
    return { track, fresh: true };
  }

  private driveVoice(voice: CarVoice, car: CarRenderState, wetness: number, step: number, discontinuity: boolean, now: number): void {
    const isListener = car.carId === this.listenerCarId;
    const interior = this.isInterior(car.carId);
    const d = interior ? 0 : distance3(car, this.camPos);
    const rpm = Number.isFinite(car.rpm) ? clamp(car.rpm, 0, RPM_SANITY_LIMIT) : IDLE_RPM;
    const throttle = Number.isFinite(car.throttle) ? clamp01(car.throttle) : 0;
    const rpmN = rpmNorm(rpm, IDLE_RPM, this.observedMaxRpm);
    const { track, fresh } = this.trackFor(car, now);
    const edges = !fresh && !discontinuity;

    // Rev limiter: full throttle, at the ceiling and not climbing for a moment (auto upshifts never trigger it).
    const atCeiling = throttle > 0.8 && rpm >= this.observedMaxRpm * 0.985 && Math.abs(rpm - track.rpm) <= rpm * 0.015;
    track.limiterTime = atCeiling ? track.limiterTime + step : 0;

    const vel = carVelocity(car);
    const slip = Number.isFinite(car.slip) ? car.slip : 0;
    const lockup = Number.isFinite(car.lockup) ? car.lockup : 0;
    const slipMax = Math.max(slip, lockup);
    voice.update(
      {
        rpm,
        rpmN,
        throttle,
        gain: this.carGain(car),
        pan: this.carPan(car),
        doppler: interior ? 1 : dopplerFactor(this.camPos.x - car.x, this.camPos.z - car.z, vel.x, vel.z, this.camVel.x, this.camVel.z),
        interior,
        cutoffCap: interior ? 20000 : distanceCutoff(d),
        revLimiter: track.limiterTime > 0.1,
        squeal: squealIntensity(slip, lockup, car.speed, wetness, car.surface),
        lockupShare: slipMax > 1e-3 ? clamp01(lockup / slipMax) : 0,
      },
      now,
    );

    if (edges && car.gear !== track.gear && car.gear >= 1 && track.gear >= 1) {
      const up = car.gear > track.gear;
      voice.shift(up, now);
      if ((isListener || this.coListeners.includes(car.carId)) && this.sessionShots) shiftClick(this.sessionShots, now, up, interior);
    }
    if (throttle >= 0.75) track.liftArmed = true;
    else if (track.liftArmed && throttle <= 0.15) {
      track.liftArmed = false;
      if (edges && rpmN > 0.6) voice.pops(rpmN, now);
    }
    track.gear = car.gear;
    track.rpm = rpm;
  }

  /** Rising edges of CarRenderState.impact → thumps (also works for replays, which carry no events). */
  private detectImpacts(cars: readonly CarRenderState[], discontinuity: boolean, now: number): void {
    for (const car of cars) {
      if (car.ghost) continue;
      const impact = Number.isFinite(car.impact) ? Math.max(0, car.impact) : 0;
      const { track, fresh } = this.trackFor(car, now);
      if (!fresh && !discontinuity && impact > track.impact + IMPACT_EDGE) this.thump(car, impact, track, now);
      track.impact = impact;
      if (!this.voices.some((v) => v.carId === car.carId)) {
        // Keep edge state current for cars without a voice.
        track.gear = car.gear;
        track.rpm = Number.isFinite(car.rpm) ? car.rpm : 0;
        track.liftArmed = false;
        track.limiterTime = 0;
      }
    }
  }

  private thumpForCar(carId: number, impulse: number, now: number): void {
    const car = this.lastCars.find((c) => c.carId === carId && !c.ghost);
    if (!car) return;
    this.thump(car, impulse, this.trackFor(car, now).track, now);
  }

  private thump(car: CarRenderState, impulse: number, track: CarTrack, now: number): void {
    const pool = this.sessionShots;
    if (!pool || now - track.lastThump < THUMP_MIN_INTERVAL) return;
    const strength = impactStrength(impulse);
    if (strength <= 0) return;
    track.lastThump = now;
    collisionThump(pool, now, strength, this.carGain(car), this.carPan(car));
  }

  private pruneTracks(cars: readonly CarRenderState[]): void {
    if (this.tracks.size <= cars.length) return;
    for (const id of this.tracks.keys()) {
      if (!cars.some((c) => c.carId === id)) this.tracks.delete(id);
    }
  }

  private updateLimiterBeep(limiterOn: boolean, step: number, now: number): void {
    if (!limiterOn || !this.sessionShots) {
      this.limiterTimer = 0;
      return;
    }
    this.limiterTimer -= step;
    if (this.limiterTimer <= 0) {
      this.limiterTimer = LIMITER_BEEP_INTERVAL;
      limiterBeep(this.sessionShots, now, this.onboard || this.extraOnboardId !== -1);
    }
  }

  private playFinishCue(pool: OneShotPool, now: number): void {
    if (this.finishCuePlayed) return;
    this.finishCuePlayed = true;
    chequeredMotif(pool, now);
  }
}
