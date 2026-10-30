/**
 * RaceScene: full race environment for one BuiltTrack — sky / lights / fog by biome × time × weather,
 * terrain, road, kerbs, run-off, barriers, pit complex, start gantry, grandstands + crowd, boards,
 * biome props, pit crews, racing-line overlay, rain, spray / smoke / sparks / crash debris, procedural cars (+ ghost,
 * with visible damage) and one camera rig per split-screen view. Reflections come from a PMREM capture of the
 * circuit itself (quality sceneProbe) or of the sky. render() draws a single full-screen view through GameRenderer's post chain
 * (bloom / grade / vignette by time of day, biome and rain, optional speed blur by the viewed car's speed; direct
 * when the quality has no post); split-screen
 * clears once and draws every ViewSpec directly in its own scissored viewport.
 */
import * as THREE from 'three';
import type {
  BuiltTrack,
  CameraMode,
  CarRenderState,
  Livery,
  RacingLineMode,
  Regulation,
  RenderFrame,
  Settings,
  TimeOfDay,
  ViewSpec,
  WeatherKind,
} from '../core/types';
import { clamp, clamp01, lerp } from '../core/math';
import type { GameRenderer } from './GameRenderer';
import { carDims, type CarDims } from './car/dims';
import { CarSharedResources } from './car/carMaterials';
import { createSafetyCar, type SafetyCarModel } from './car/safetyCar';
import { createCarModel, type CarModel } from './car/carModel';
import { CameraRig, type RigContext } from './cameras';
import { Disposer } from './core/disposer';
import { LAMP_HDR_GAIN, LENS_CHROMA, LENS_GRAIN, VIGNETTE_STRENGTH, aoAmount, bloomParams, createPostLook, gradeParams, speedBlurAmount } from './core/post';
import { CAMERA_FAR, qualityProfile, shadowSizeFor, type QualityProfile } from './core/quality';
import { Environment, buildEnvironmentMap, type SceneProbe } from './environment';
import { CarEffects } from './fx/carEffects';
import { ContactShadows } from './fx/contactShadows';
import { DebrisFx } from './fx/debris';
import { RainFx } from './fx/rain';
import type { MarshalPanels } from './track/marshalPanels';
import { inTunnel, type SceneryContext } from './track/context';
import { PitCrew } from './track/pitCrew';
import { RacingLineOverlay } from './track/racingLine';
import { WET_NORMAL_SCALE, type RoadParts } from './track/road';
import { TrackFrame } from './track/trackFrame';
import { buildStaticScenery } from './track/scenery';
import type { StartGantry } from './track/pitComplex';
import type { TvSpot } from './track/trackside';

export interface RaceSceneCar {
  carId: number;
  livery: Livery;
  number: number;
  /** 3-letter team code painted on the car */
  teamShort: string;
  /** helmet colors of the driver */
  helmet: Livery;
  /** pit box index in garage order (race/world.ts boxSlot); absent = the crews serve any car standing in their box */
  pitBox?: number;
}

export interface RaceSceneOptions {
  cars: RaceSceneCar[];
  timeOfDay: TimeOfDay;
  weather: WeatherKind;
  settings: Settings;
  /** include a translucent ghost car (carId -1) */
  ghost: boolean;
  racingLine: RacingLineMode;
  /** '2026' = smaller/narrower cars; drsOpen animates active-aero front + rear flaps instead of the DRS flap only */
  regulation: Regulation;
  /** team colours in pit-box order (SessionConfig.teams); default: the cars' liveries in grid order */
  teamColors?: string[];
}

const GHOST_LIVERY: Livery = { primary: '#bfeaff', secondary: '#5fb8ff', accent: '#ffffff', pattern: 'stripe' };
const MAX_VIEWS = 4;
/** Split-screen views whose shadow focus is closer than this (m) share one shadow map render. */
const SHADOW_SHARE_DIST = 20;
/** Reflection probe height (m) above the track: clear of barriers, fences and most trackside clutter. */
const PROBE_HEIGHT = 14;
/** Candidate probe samples tried (nearest the circuit centre first) before falling back to the start line. */
const PROBE_CANDIDATES = 240;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Team colours for the pit boxes / fan blocks: the given list, else each team's livery once (cars order). */
function sceneTeamColors(opts: RaceSceneOptions): string[] {
  const given = (opts.teamColors ?? []).filter((c) => typeof c === 'string' && c.length > 0);
  if (given.length > 0) return given;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const car of opts.cars) {
    if (car.carId < 0 || seen.has(car.teamShort)) continue;
    seen.add(car.teamShort);
    out.push(car.livery.primary);
  }
  return out.length > 0 ? out : ['#8d939b'];
}

/** A race track scene: environment, track, cars, effects, cameras, split-screen views. */
export class RaceScene {
  /** Ordered list of camera modes for cycling. */
  static readonly CAMERA_CYCLE: CameraMode[] = ['chase', 'chaseFar', 'tcam', 'cockpit', 'nose'];

  readonly scene = new THREE.Scene();
  readonly track: BuiltTrack;
  private readonly gr: GameRenderer;
  private settings: Settings;
  private quality: QualityProfile;
  private readonly disposer = new Disposer();
  private readonly frame: TrackFrame;
  private readonly env: Environment;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  /** GameRenderer.contextVersion the environment map was rendered for */
  private envContext = 0;
  private readonly road: RoadParts;
  private readonly gantry: StartGantry;
  private readonly racingLine: RacingLineOverlay;
  private readonly shared: CarSharedResources;
  private readonly cars = new Map<number, CarModel>();
  private readonly dims: CarDims;
  private readonly safetyCar: SafetyCarModel;
  private readonly contactShadows: ContactShadows;
  private readonly marshals: MarshalPanels;
  private readonly crew: PitCrew;
  private effects: CarEffects;
  private readonly debris: DebrisFx;
  private rain: RainFx;
  private readonly rigs: CameraRig[] = [];
  private readonly tvSpots: TvSpot[];
  private readonly ctx: SceneryContext;
  private readonly rigCtx: RigContext;
  private readonly lastCamPos: THREE.Vector3[] = [];
  private readonly stateById = new Map<number, CarRenderState>();
  private readonly seen = new Set<number>();
  private readonly focus = new THREE.Vector3();
  /** focus of the shadow map rendered last this frame (split-screen views close together share it) */
  private readonly shadowFocus = new THREE.Vector3();
  /** racing-line mode for every view, and per-view overrides (split-screen: each player's own assist) */
  private lineMode: RacingLineMode;
  private readonly viewLineModes: (RacingLineMode | undefined)[] = [];
  private readonly staticRoot: THREE.Group;
  private settingsVersion: number;
  private shadowSize = 0;
  private wetness = 0;
  private lastTime = Number.NaN;
  private disposed = false;
  /** post-chain look, refreshed every post frame from time of day, biome, cloud and rain */
  private readonly look = createPostLook();

  constructor(gr: GameRenderer, track: BuiltTrack, opts: RaceSceneOptions) {
    this.gr = gr;
    this.track = track;
    this.settings = opts.settings;
    this.quality = qualityProfile(opts.settings.quality);
    this.settingsVersion = gr.settingsVersion;
    this.dims = carDims(opts.regulation);
    this.scene.name = `race:${track.id}`;
    const biome = track.def?.biome ?? 'temperate';
    const street = track.def?.street === true;
    const anisotropy = Math.min(this.quality.anisotropy, gr.renderer.capabilities.getMaxAnisotropy() || 1);

    this.frame = new TrackFrame(track);
    this.env = new Environment({ biome, timeOfDay: opts.timeOfDay, weather: opts.weather, floodlit: track.def.real ? 1 : 0.35 });
    this.scene.add(this.env.sky, this.env.sun, this.env.sun.target, this.env.hemi);
    this.scene.fog = this.env.fog;
    this.envContext = gr.contextVersion;
    this.envTarget = buildEnvironmentMap(gr.renderer, this.env);
    if (this.envTarget) this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = this.env.envIntensity;

    this.ctx = {
      track,
      frame: this.frame,
      biome,
      street,
      timeOfDay: opts.timeOfDay,
      quality: this.quality,
      disposer: this.disposer,
      anisotropy,
      seed: hashString(track.id),
      exclusions: [],
      lampMaterials: [],
      lampBase: [],
      terrainEdits: [],
      featureStands: [],
      tunnels: [],
      pitWing: false,
      teamColors: sceneTeamColors(opts),
    };

    // ── static scenery ──
    const scenery = buildStaticScenery(this.ctx, Math.max(22, opts.cars.length));
    this.staticRoot = scenery.root;
    this.tvSpots = scenery.tvSpots;
    this.road = scenery.road;
    this.gantry = scenery.gantry;
    this.marshals = scenery.marshals;
    this.lineMode = opts.racingLine;
    this.racingLine = new RacingLineOverlay(this.ctx, opts.racingLine);
    this.staticRoot.add(this.racingLine.group);
    this.scene.add(this.staticRoot);
    this.staticRoot.updateMatrixWorld(true);
    this.staticRoot.traverse((o) => {
      if (o !== this.staticRoot && o !== this.gantry.group) o.matrixAutoUpdate = false;
    });

    // ── cars ──
    this.shared = new CarSharedResources();
    for (const c of opts.cars) {
      if (this.cars.has(c.carId)) continue;
      const model = createCarModel({
        livery: c.livery,
        number: c.number,
        teamShort: c.teamShort,
        helmet: c.helmet,
        regulation: opts.regulation,
        textureSize: this.quality.liveryTexSize,
        anisotropy,
        quality: this.quality.level,
        shared: this.shared,
      });
      model.root.visible = false;
      this.cars.set(c.carId, model);
      this.scene.add(model.root);
    }
    if (opts.ghost) {
      const ghost = createCarModel({
        livery: GHOST_LIVERY,
        number: 0,
        teamShort: 'GST',
        helmet: GHOST_LIVERY,
        regulation: opts.regulation,
        ghost: true,
        textureSize: 256,
        anisotropy: 1,
        quality: this.quality.level,
        shared: this.shared,
      });
      ghost.root.visible = false;
      this.cars.set(-1, ghost);
      this.scene.add(ghost.root);
    }

    // pit crews by every team's box
    const carBox = new Map<number, number>();
    for (const c of opts.cars) if (Number.isInteger(c.pitBox) && (c.pitBox ?? -1) >= 0) carBox.set(c.carId, c.pitBox ?? 0);
    this.crew = new PitCrew(this.ctx, this.dims, carBox);
    this.scene.add(this.crew.group);

    // safety car: created once, hidden until frame.safetyCar is present
    this.safetyCar = createSafetyCar({ anisotropy });
    this.scene.add(this.safetyCar.root);
    // contact shadows keep the cars visually grounded (the sun's shadow often falls to the side)
    this.contactShadows = new ContactShadows(this.disposer, this.dims, opts.cars.length + 1, opts.timeOfDay);
    this.scene.add(this.contactShadows.group);

    // ── effects ──
    this.effects = new CarEffects(this.quality.smokeParticles, this.quality.sparkParticles, biome, this.dims);
    this.scene.add(this.effects.smoke.points, this.effects.sparks.points);
    this.rain = new RainFx(this.quality.rainStreaks, this.ctx.seed);
    this.scene.add(this.rain.lines);
    // crash debris (carbon shards, broken wing pieces in the livery colour)
    const liveries = new Map<number, string>();
    for (const c of opts.cars) liveries.set(c.carId, c.livery.primary);
    this.debris = new DebrisFx(Math.max(32, Math.round(this.quality.sparkParticles / 2)), this.dims, liveries);
    this.scene.add(this.debris.mesh);

    this.rigCtx = { settings: this.settings, time: 0, dims: this.dims, track, frame: this.frame, tvSpots: this.tvSpots, tunnels: this.ctx.tunnels };
    this.applyShadows();
    this.precompile();
    if (this.quality.sceneProbe) this.captureReflections();
    // every race scene starts at the user's full resolution
    gr.resetAdaptiveResolution();
  }

  /** Compile every shader program up front so the first race frame does not stall. */
  private precompile(): void {
    const r = this.gr.renderer;
    if (typeof r.compile !== 'function') return;
    try {
      const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.2, CAMERA_FAR);
      cam.position.set(this.track.px[0] ?? 0, (this.track.py[0] ?? 0) + 3, this.track.pz[0] ?? 0);
      cam.updateMatrixWorld();
      for (const m of this.cars.values()) m.root.visible = true;
      this.safetyCar.root.visible = true;
      r.compile(this.scene, cam);
      // the post chain renders into a linear HDR target: a separate (un-tone-mapped) variant of every program
      if (this.gr.postEnabled) {
        const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
        const prev = r.getRenderTarget();
        try {
          r.setRenderTarget(target);
          r.compile(this.scene, cam);
        } finally {
          r.setRenderTarget(prev);
          target.dispose();
        }
      }
    } catch (err) {
      console.warn('render: shader precompile skipped', err);
    } finally {
      for (const m of this.cars.values()) m.root.visible = false;
      this.safetyCar.root.visible = false;
    }
  }

  /** Racing-line mode of one view (split-screen), or of every view when `viewIndex` is omitted. */
  setRacingLine(mode: RacingLineMode, viewIndex?: number): void {
    if (this.disposed) return;
    if (viewIndex === undefined) {
      this.lineMode = mode;
      this.viewLineModes.length = 0;
      this.racingLine.setMode(mode);
    } else if (Number.isInteger(viewIndex) && viewIndex >= 0 && viewIndex < MAX_VIEWS) {
      this.viewLineModes[viewIndex] = mode;
    }
  }

  applySettings(settings: Settings): void {
    if (this.disposed) return;
    const prevQuality = this.quality.level;
    this.settings = settings;
    this.quality = qualityProfile(settings.quality);
    this.rigCtx.settings = settings;
    this.settingsVersion = this.gr.settingsVersion;
    if (prevQuality !== this.quality.level) {
      // particle budgets follow quality immediately; scenery density applies to the next scene
      this.effects.dispose();
      this.effects = new CarEffects(this.quality.smokeParticles, this.quality.sparkParticles, this.ctx.biome, this.dims);
      this.scene.add(this.effects.smoke.points, this.effects.sparks.points);
      this.rain.dispose();
      this.rain = new RainFx(this.quality.rainStreaks, this.ctx.seed);
      this.scene.add(this.rain.lines);
    }
    this.applyShadows();
  }

  private applyShadows(): void {
    const size = shadowSizeFor(this.settings);
    const sun = this.env.sun;
    const enabled = size > 0;
    const changed = enabled !== sun.castShadow;
    sun.castShadow = enabled;
    sun.shadow.radius = this.quality.shadowRadius;
    this.gr.renderer.shadowMap.enabled = enabled;
    if (enabled && size !== this.shadowSize) {
      sun.shadow.mapSize.set(size, size);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
    }
    this.shadowSize = enabled ? size : 0;
    this.safetyCar.setCastShadow(enabled);
    if (changed) {
      this.scene.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) m.needsUpdate = true;
      });
    }
  }

  /** The WebGL context was restored: the PMREM render target lost its contents, render it again. */
  private rebuildEnvironmentMap(): void {
    this.envContext = this.gr.contextVersion;
    this.envTarget?.dispose();
    this.envTarget = buildEnvironmentMap(this.gr.renderer, this.env);
    this.scene.environment = this.envTarget ? this.envTarget.texture : null;
    if (this.quality.sceneProbe) this.captureReflections();
  }

  /**
   * Replace the sky-only reflections by a capture of the circuit itself (stands, trees, terrain, sky) from a probe
   * above the track near the circuit's centre. Cars, particles and overlays are hidden while capturing.
   */
  private captureReflections(): void {
    if (this.gr.isContextLost()) return;
    this.applyLamps(1);
    const hide: THREE.Object3D[] = [this.contactShadows.group, this.effects.smoke.points, this.effects.sparks.points, this.debris.mesh, this.rain.lines, this.racingLine.group, this.safetyCar.root];
    for (const m of this.cars.values()) hide.push(m.root);
    const probe: SceneProbe = { scene: this.scene, position: this.probePosition(), hide, shadowMapSize: this.shadowSize };
    const rt = buildEnvironmentMap(this.gr.renderer, this.env, probe);
    if (!rt) return;
    this.envTarget?.dispose();
    this.envTarget = rt;
    this.scene.environment = rt.texture;
  }

  /** The track sample nearest the circuit's centre that is open to the sky (no tunnel or bridge above), lifted PROBE_HEIGHT. */
  private probePosition(): THREE.Vector3 {
    const t = this.track;
    const n = Math.max(1, t.count);
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += t.px[i];
      cz += t.pz[i];
    }
    cx /= n;
    cz /= n;
    const d2 = (i: number): number => (t.px[i] - cx) ** 2 + (t.pz[i] - cz) ** 2;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d2(a) - d2(b));
    const covered = (k: number): boolean => {
      for (let j = 0; j < n; j++) {
        if (t.py[j] > t.py[k] + 2 && (t.px[j] - t.px[k]) ** 2 + (t.pz[j] - t.pz[k]) ** 2 < 15 * 15) return true;
      }
      return false;
    };
    for (const k of order.slice(0, PROBE_CANDIDATES)) {
      if (!Number.isFinite(t.px[k]) || inTunnel(this.ctx, t.s[k], 20) || covered(k)) continue;
      return new THREE.Vector3(t.px[k], t.py[k] + PROBE_HEIGHT, t.pz[k]);
    }
    return new THREE.Vector3(t.px[0] ?? 0, (t.py[0] ?? 0) + PROBE_HEIGHT, t.pz[0] ?? 0);
  }

  /** Trackside lamp heads at the environment's lamp level × `gain` (HDR gain with the post chain). */
  private applyLamps(gain: number): void {
    for (let i = 0; i < this.ctx.lampMaterials.length; i++) {
      this.ctx.lampMaterials[i].color.copy(this.ctx.lampBase[i]).multiplyScalar((0.08 + 0.92 * this.env.lampLevel) * gain);
    }
  }

  /** Render one frame. One view = full screen; two views = split-screen (each with its own camera rig). */

  render(frame: RenderFrame, views: ViewSpec[], dt: number): void {
    if (this.disposed) return;
    if (this.settingsVersion !== this.gr.settingsVersion) this.applySettings(this.gr.settings);
    if (this.envContext !== this.gr.contextVersion) this.rebuildEnvironmentMap();
    const r = this.gr.renderer;
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    const time = Number.isFinite(frame.time) ? frame.time : 0;
    // a backwards / large time jump means flashback or replay seek: drop transient effects
    if (Number.isFinite(this.lastTime) && (time < this.lastTime - 0.05 || time - this.lastTime > 2)) {
      this.effects.reset();
      this.debris.reset();
      this.crew.reset();
      for (const rig of this.rigs) rig.reset();
    }
    this.lastTime = time;

    // views: one full-screen view uses the post chain; split-screen stays direct (see the draw section)
    const list = views.slice(0, MAX_VIEWS);
    const rects = list.map((v) => this.gr.viewportRect(v.viewport));
    const wantPost = list.length === 1 && this.gr.postEnabled && this.coversCanvas(rects[0]);

    // environment & weather
    const weather = frame.weather ?? { kind: 'clear', rain: 0, wetness: 0 };
    this.env.update(weather.kind, weather.rain, step, time);
    this.scene.environmentIntensity = this.env.envIntensity;
    // with post, lamp heads go HDR so they clear the bloom threshold (direct rendering would only clip them)
    this.applyLamps(wantPost ? LAMP_HDR_GAIN : 1);
    const wet = clamp01(Number.isFinite(weather.wetness) ? weather.wetness : 0);
    if (Math.abs(wet - this.wetness) > 0.004) {
      this.wetness = wet;
      for (const w of this.road.wetMaterials) {
        w.material.roughness = lerp(w.dryRoughness, w.wetRoughness, wet);
        w.material.color.copy(w.dryColor).multiplyScalar(lerp(1, 0.62, wet));
        if (w.dryNormalScale !== undefined) w.material.normalScale.setScalar(w.dryNormalScale * lerp(1, WET_NORMAL_SCALE, wet));
      }
    }

    // cars
    this.stateById.clear();
    this.seen.clear();
    const ctxApply = { time, rain: Number.isFinite(weather.rain) ? weather.rain : 0 };
    for (const s of frame.cars ?? []) {
      this.stateById.set(s.carId, s);
      const model = this.cars.get(s.ghost ? -1 : s.carId);
      if (!model) continue;
      model.apply(s, step, ctxApply);
      this.seen.add(s.ghost ? -1 : s.carId);
      let near = false;
      for (const p of this.lastCamPos) {
        if (p.distanceToSquared(model.root.position) < 30 * 30) near = true;
      }
      model.setDetail(near);
    }
    for (const [id, model] of this.cars) if (!this.seen.has(id)) model.root.visible = false;

    // pit crews (jacks lift a car standing in its box)
    this.crew.update(frame.cars ?? [], time, this.lastCamPos);
    for (const [id, model] of this.cars) {
      const lift = id >= 0 ? this.crew.liftFor(id) : 0;
      if (lift > 0) model.root.position.y += lift;
    }

    // safety car + marshal light panels (absent fields = no safety car / all green)
    if (frame.safetyCar) this.safetyCar.apply(frame.safetyCar, time);
    else this.safetyCar.hide();
    this.contactShadows.update(frame.cars ?? [], frame.safetyCar);
    this.marshals.update(frame.raceControl, time);

    this.gantry.setLights(frame.startLights?.lit ?? 0, frame.startLights?.out ?? true);
    this.effects.update(frame.cars ?? [], this.lastCamPos, wet, step);
    this.debris.update(frame.cars ?? [], step);
    this.rain.update(Number.isFinite(weather.rain) ? weather.rain : 0, step);

    if (this.gr.isContextLost()) return;
    // real frame time -> adaptive resolution (may resize the drawing buffer before this frame is drawn)
    this.gr.beginFrame(true);

    // cameras
    this.rigCtx.time = time;
    list.forEach((view, i) => {
      if (!this.rigs[i]) this.rigs[i] = new CameraRig();
      const target = this.stateById.get(view.carId) ?? this.fallbackTarget(frame);
      const rect = rects[i];
      this.rigs[i].update(view.camera, view.lookBack, view.carId, target, rect.w / Math.max(1, rect.h), step, this.rigCtx);
    });

    // draw. A single full-screen view goes through the post chain (exposure still comes from the environment:
    // OutputPass reads toneMappingExposure). Split-screen keeps direct scissor rendering of every view into its
    // own viewport: the chain is single-view only (one composer per view would double fill cost and target memory).
    const post = wantPost ? this.gr.postPipeline() : null;
    if (post) {
      const rain = Number.isFinite(weather.rain) ? weather.rain : 0;
      const view = list[0];
      bloomParams(this.ctx.timeOfDay, this.quality.level, this.env.cloud, rain, this.look.bloom);
      gradeParams(this.ctx.biome, this.ctx.timeOfDay, rain, this.look.grade);
      this.look.vignette = this.quality.vignette ? VIGNETTE_STRENGTH : 0;
      this.look.ao = aoAmount(this.ctx.timeOfDay, this.quality.aoScale, this.env.cloud);
      // lens artefacts belong to car-mounted / broadcast cameras, not to the cockpit view through the visor
      this.look.chroma = view.camera === 'cockpit' ? 0 : LENS_CHROMA;
      this.look.grain = LENS_GRAIN;
      // speed blur follows the viewed car; trackside TV cameras stand still, so they get none
      const target = this.stateById.get(view.carId) ?? this.fallbackTarget(frame);
      this.look.speedBlur = view.camera === 'tv' ? 0 : speedBlurAmount(target?.speed ?? 0, this.settings.speedBlur);
    }
    r.toneMappingExposure = this.env.exposure;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.gr.width, this.gr.height);
    r.setClearColor(this.env.fog.color, 1);
    if (!post) r.clear(true, true, false);
    const pxRatio = r.getPixelRatio();
    list.forEach((view, i) => {
      const rig = this.rigs[i];
      const rect = rects[i];
      if (!post) {
        r.setViewport(rect.x, rect.y, rect.w, rect.h);
        r.setScissor(rect.x, rect.y, rect.w, rect.h);
        r.setScissorTest(true);
      }
      // shadows follow each view's own target (the shadow box is only ±70 m)
      if (this.shadowSize > 0) this.placeShadows(view, i, frame);
      this.racingLine.setMode(this.viewLineModes[i] ?? this.lineMode);
      const cam = rig.camera;
      this.env.followCamera(cam);
      this.rain.setCamera(cam.position, rig.velocity);
      this.effects.smoke.setViewScale(rect.h * pxRatio, cam.fov);
      this.effects.sparks.setViewScale(rect.h * pxRatio, cam.fov);
      if (post) post.render(this.scene, cam, this.look, step);
      else r.render(this.scene, cam);
      r.shadowMap.needsUpdate = false;
      if (!this.lastCamPos[i]) this.lastCamPos[i] = new THREE.Vector3();
      this.lastCamPos[i].copy(cam.position);
    });
    this.lastCamPos.length = list.length;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.gr.width, this.gr.height);
  }

  /** Centre the sun's shadow map ahead of the view's target; re-render it unless the previous view's map covers it. */
  private placeShadows(view: ViewSpec, index: number, frame: RenderFrame): void {
    const t = this.stateById.get(view.carId) ?? this.fallbackTarget(frame);
    if (t && Number.isFinite(t.x)) {
      const ahead = view.camera === 'tv' ? 0 : 22;
      this.focus.set(t.x + Math.sin(t.yaw || 0) * ahead, Number.isFinite(t.y) ? t.y : 0, t.z + Math.cos(t.yaw || 0) * ahead);
    } else this.focus.copy(this.rigs[index]?.camera.position ?? this.focus);
    if (index > 0 && this.focus.distanceToSquared(this.shadowFocus) < SHADOW_SHARE_DIST * SHADOW_SHARE_DIST) return;
    this.shadowFocus.copy(this.focus);
    this.env.placeSun(this.focus, this.shadowSize);
    this.gr.renderer.shadowMap.needsUpdate = true;
  }

  /** The rect fills the whole canvas (the post chain always draws full screen). */
  private coversCanvas(rect: { x: number; y: number; w: number; h: number } | undefined): boolean {
    return !!rect && rect.x === 0 && rect.y === 0 && rect.w === this.gr.width && rect.h === this.gr.height;
  }

  private fallbackTarget(frame: RenderFrame): CarRenderState | null {
    for (const c of frame.cars ?? []) if (c.visible && !c.ghost) return c;
    return frame.cars?.[0] ?? null;
  }

  /** Camera world position of a view after the last render (audio listener). */
  getCameraPosition(viewIndex: number): { x: number; y: number; z: number } {
    const p = this.lastCamPos[viewIndex] ?? this.rigs[viewIndex]?.camera.position ?? this.lastCamPos[0];
    if (!p) return { x: 0, y: 0, z: 0 };
    return { x: p.x, y: p.y, z: p.z };
  }

  /** Camera of a view (after the last render), e.g. for screen-space HUD markers. */
  getCamera(viewIndex: number): THREE.PerspectiveCamera | null {
    return this.rigs[viewIndex]?.camera ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of this.cars.values()) m.dispose();
    this.cars.clear();
    this.safetyCar.dispose();
    this.shared.dispose();
    this.effects.dispose();
    this.debris.dispose();
    this.rain.dispose();
    this.env.dispose();
    if (this.envTarget) {
      this.envTarget.dispose();
      this.envTarget = null;
    }
    this.scene.environment = null;
    this.scene.fog = null;
    this.disposer.dispose();
    this.scene.clear();
    this.rigs.length = 0;
    this.lastCamPos.length = 0;
  }
}
