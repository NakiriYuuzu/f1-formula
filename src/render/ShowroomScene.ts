/**
 * ShowroomScene: menu background studio — one car on a slowly rotating turntable over a reflective
 * floor with key / fill / rim lights and a subtle camera orbit, or a podium with up to three cars on
 * stepped plinths (P1 centre and highest, P2 left, P3 right as seen by the camera) with confetti.
 * render(dt) draws full screen (opaque), so it can sit behind transparent DOM menus; on quality ≥ medium it goes
 * through GameRenderer's post chain with a light look (bloom for the rim and paint glints, vignette).
 */
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { CarRenderState, Livery, Regulation } from '../core/types';
import { clamp } from '../core/math';
import { TEAMS, DRIVERS } from '../data/teams';
import type { GameRenderer } from './GameRenderer';
import { CarSharedResources } from './car/carMaterials';
import { createCarModel, type CarModel } from './car/carModel';
import { canvasTexture, createCanvas, Rng, UI_FONT } from './core/canvas';
import { Disposer } from './core/disposer';
import { SHOWROOM_RIM_HDR_GAIN, acesFilmicInverse, createPostLook, showroomLook } from './core/post';
import { qualityProfile, shadowSizeFor } from './core/quality';

interface ShowCar {
  livery: Livery;
  number: number;
  teamShort: string;
  helmet: Livery;
}

const BG_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BG_FRAG = /* glsl */ `
uniform vec3 top;
uniform vec3 bottom;
uniform vec3 glow;
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(bottom, top, smoothstep(0.35, 1.0, h));
  c += glow * pow(max(0.0, 1.0 - abs(vDir.y - 0.05) * 3.0), 3.0) * 0.6;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const CONFETTI = 260;
/** Tone-mapping exposure of the studio. */
const SHOWROOM_EXPOSURE = 1.0;
const BACKDROP_KEYS = ['top', 'bottom', 'glow'] as const;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

function idleState(carId: number): CarRenderState {
  return {
    carId,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    steerAngle: 0,
    wheelSpin: 0,
    throttle: 0,
    brake: 0,
    rpm: 0,
    gear: 0,
    drsOpen: false,
    compound: 'soft',
    rainLight: false,
    limiter: false,
    damage: { frontWing: 0, rearWing: 0 },
    slip: 0,
    lockup: 0,
    impact: 0,
    surface: 'asphalt',
    boost: false,
    visible: true,
    ghost: false,
  };
}

/** Menu background: one car on a lit turntable (main menu, garage, livery editor). */
/** Podium framing on wide screens: fraction of the screen width the plinths fill, and where they are centred. */
const PODIUM_WIDE_ASPECT = 1.2;
const PODIUM_SCREEN_SHARE = 0.5;
const PODIUM_CENTER_X = 0.76;

export class ShowroomScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 200);
  private readonly gr: GameRenderer;
  private readonly disposer = new Disposer();
  private readonly shared = new CarSharedResources();
  private readonly turntable = new THREE.Group();
  private readonly podium = new THREE.Group();
  private readonly key: THREE.DirectionalLight;
  private readonly reflector: Reflector;
  /** backdrop dome colours (linear) as designed for direct, non-tone-mapped output */
  private readonly backdropBase: Record<(typeof BACKDROP_KEYS)[number], THREE.Color>;
  private readonly backdropUniforms: Record<(typeof BACKDROP_KEYS)[number], THREE.IUniform<THREE.Color>>;
  private readonly fogBase: THREE.Color;
  private readonly rimMaterial: THREE.MeshBasicMaterial;
  private readonly rimBase: THREE.Color;
  /** whether the scene colours are currently set up for the post chain (null = not yet applied) */
  private postMode: boolean | null = null;
  private readonly look = createPostLook();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private car: CarModel | null = null;
  private carSpec: ShowCar;
  private regulation: Regulation = '2025';
  private podiumCars: CarModel[] = [];
  private readonly confetti: THREE.InstancedMesh;
  private readonly confettiState: Float32Array;
  private readonly confettiRng = new Rng(77);
  private readonly states: CarRenderState[] = [idleState(0), idleState(1), idleState(2), idleState(3)];
  private time = 0;
  private settingsVersion = -1;
  /** GameRenderer.contextVersion the environment map was rendered for */
  private envContext = 0;
  private disposed = false;

  constructor(gr: GameRenderer) {
    this.gr = gr;
    this.scene.name = 'showroom';
    const bgColor = new THREE.Color('#07090f');
    this.fogBase = bgColor.clone();
    this.scene.fog = new THREE.Fog(bgColor, 16, 46);

    // background dome
    this.backdropBase = { top: new THREE.Color('#141a2c'), bottom: bgColor.clone(), glow: new THREE.Color('#1d3b66') };
    this.backdropUniforms = {
      top: { value: this.backdropBase.top.clone() },
      bottom: { value: this.backdropBase.bottom.clone() },
      glow: { value: this.backdropBase.glow.clone() },
    };
    const bgGeo = this.disposer.add(new THREE.SphereGeometry(80, 32, 16));
    const bgMat = this.disposer.add(
      new THREE.ShaderMaterial({
        uniforms: this.backdropUniforms,
        vertexShader: BG_VERT,
        fragmentShader: BG_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    const bg = new THREE.Mesh(bgGeo, bgMat);
    bg.renderOrder = -1000;
    this.scene.add(bg);

    // reflective floor: mirror below a translucent glossy layer
    const floorGeo = this.disposer.add(new THREE.CircleGeometry(40, 64));
    this.reflector = new Reflector(floorGeo, { textureWidth: 1024, textureHeight: 1024, color: 0x8a8f99, clipBias: 0.003, multisample: 4 });
    this.reflector.rotation.x = -Math.PI / 2;
    this.reflector.position.y = -0.002;
    this.scene.add(this.reflector);
    const gloss = new THREE.Mesh(
      floorGeo,
      this.disposer.add(new THREE.MeshStandardMaterial({ color: '#0b0d12', roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.84 })),
    );
    gloss.rotation.x = -Math.PI / 2;
    gloss.receiveShadow = true;
    this.scene.add(gloss);

    // turntable with a glowing rim
    const disc = new THREE.Mesh(
      this.disposer.add(new THREE.CylinderGeometry(3.7, 3.8, 0.12, 64)),
      this.disposer.add(new THREE.MeshStandardMaterial({ color: '#1a1d24', roughness: 0.3, metalness: 0.6 })),
    );
    disc.position.y = 0.06;
    disc.receiveShadow = true;
    this.rimBase = new THREE.Color(0.3, 0.85, 1.0);
    this.rimMaterial = this.disposer.add(new THREE.MeshBasicMaterial({ color: this.rimBase.clone(), toneMapped: false }));
    const rim = new THREE.Mesh(this.disposer.add(new THREE.TorusGeometry(3.78, 0.025, 8, 96)), this.rimMaterial);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.115;
    this.turntable.add(disc, rim);
    this.scene.add(this.turntable);

    // lights
    this.key = new THREE.DirectionalLight('#ffffff', 2.6);
    this.key.position.set(5, 9, 6);
    this.key.shadow.camera.left = -7;
    this.key.shadow.camera.right = 7;
    this.key.shadow.camera.top = 7;
    this.key.shadow.camera.bottom = -7;
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 30;
    this.key.shadow.bias = -0.0005;
    this.key.shadow.normalBias = 0.03;
    const fill = new THREE.DirectionalLight('#9fb8ff', 0.7);
    fill.position.set(-7, 3, 3);
    const rimLight = new THREE.DirectionalLight('#7fe3ff', 2.0);
    rimLight.position.set(-2, 4, -9);
    const hemi = new THREE.HemisphereLight('#3a4a6a', '#0a0b0f', 0.6);
    this.scene.add(this.key, this.key.target, fill, rimLight, hemi);

    // studio environment for paint reflections
    this.buildEnvironment();
    this.scene.environmentIntensity = 0.55;

    // podium plinths (hidden until setPodium)
    this.buildPodium();
    this.podium.visible = false;
    this.scene.add(this.podium);

    // confetti
    const cg = this.disposer.add(new THREE.PlaneGeometry(0.07, 0.11));
    const cm = this.disposer.add(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }));
    this.confetti = this.disposer.add(new THREE.InstancedMesh(cg, cm, CONFETTI));
    this.confetti.frustumCulled = false;
    this.confetti.visible = false;
    this.confettiState = new Float32Array(CONFETTI * 6);
    this.scene.add(this.confetti);

    const t0 = TEAMS[0];
    const d0 = DRIVERS.find((d) => d.teamId === t0.id);
    this.carSpec = { livery: t0.livery, number: d0?.number ?? 1, teamShort: t0.shortName, helmet: d0?.helmet ?? t0.livery };
    this.rebuildCar();
    this.syncSettings();
  }

  private makeCar(spec: ShowCar, regulation: Regulation = this.regulation): CarModel {
    const q = qualityProfile(this.gr.settings.quality);
    return createCarModel({
      livery: spec.livery,
      number: spec.number,
      teamShort: spec.teamShort,
      helmet: spec.helmet,
      regulation,
      textureSize: Math.max(1024, q.liveryTexSize),
      anisotropy: Math.min(8, this.gr.renderer.capabilities.getMaxAnisotropy() || 1),
      shared: this.shared,
    });
  }

  private rebuildCar(): void {
    if (this.car) this.car.dispose();
    this.car = this.makeCar(this.carSpec);
    this.car.setDetail(true);
    this.car.root.position.y = 0.12;
    this.turntable.add(this.car.root);
  }

  /** Show a car on the turntable (repaints in place when the regulation is unchanged). */
  setCar(livery: Livery, number: number, teamShort: string, helmet: Livery, regulation?: Regulation): void {
    if (this.disposed) return;
    this.carSpec = { livery, number, teamShort, helmet };
    const reg = regulation ?? this.regulation;
    if (this.car && reg === this.regulation) this.car.setLivery(livery, number, teamShort, helmet);
    else {
      this.regulation = reg;
      this.rebuildCar();
    }
  }

  /**
   * Podium scene: up to 3 cars on stepped plinths (P1 centre), each built for its `regulation` (the race's; default
   * the showroom's); null returns to the single-car turntable.
   */
  setPodium(cars: { livery: Livery; number: number; teamShort: string; helmet: Livery; regulation?: Regulation }[] | null): void {
    if (this.disposed) return;
    for (const c of this.podiumCars) c.dispose();
    this.podiumCars = [];
    if (!cars || cars.length === 0) {
      this.podium.visible = false;
      this.turntable.visible = true;
      this.confetti.visible = false;
      return;
    }
    this.podium.visible = true;
    this.turntable.visible = false;
    const slots: [number, number, number][] = [
      [0, 1.1, 0],
      [-3.3, 0.75, 0.32],
      [3.3, 0.45, -0.32],
    ];
    cars.slice(0, 3).forEach((spec, i) => {
      const m = this.makeCar(spec, spec.regulation ?? this.regulation);
      m.setDetail(true);
      const [x, h, yaw] = slots[i];
      m.root.position.set(x, h, 0);
      m.root.rotation.y = yaw;
      this.podium.add(m.root);
      this.podiumCars.push(m);
    });
    // confetti in podium colours
    const palette = cars.slice(0, 3).flatMap((c) => [c.livery.primary, c.livery.secondary]);
    palette.push('#ffd700', '#ffffff');
    const col = new THREE.Color();
    for (let i = 0; i < CONFETTI; i++) {
      this.resetConfetti(i, true);
      this.confetti.setColorAt(i, col.set(this.confettiRng.pick(palette)));
    }
    if (this.confetti.instanceColor) this.confetti.instanceColor.needsUpdate = true;
    this.confetti.visible = true;
  }

  private buildPodium(): void {
    const label = createCanvas(768, 256);
    label.ctx.fillStyle = '#e8e9ec';
    label.ctx.fillRect(0, 0, label.w, label.h);
    ['1', '2', '3'].forEach((n, i) => {
      const x = i * 256;
      label.ctx.fillStyle = i === 0 ? '#c9a227' : i === 1 ? '#a7adb7' : '#b0703a';
      label.ctx.fillRect(x + 8, 8, 240, 240);
      label.ctx.fillStyle = '#111318';
      label.ctx.font = `900 170px ${UI_FONT}`;
      label.ctx.textAlign = 'center';
      label.ctx.textBaseline = 'middle';
      label.ctx.fillText(n, x + 128, 138);
    });
    const tex = this.disposer.add(canvasTexture(label, { anisotropy: 4 }));
    const plinthMat = this.disposer.add(new THREE.MeshStandardMaterial({ color: '#d9dce2', roughness: 0.45, metalness: 0.2 }));
    const labelMat = this.disposer.add(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
    const heights = [1.1, 0.75, 0.45];
    const xs = [0, -3.3, 3.3];
    heights.forEach((h, i) => {
      const box = new THREE.Mesh(this.disposer.add(new THREE.BoxGeometry(3.0, h, 6.6)), plinthMat);
      box.position.set(xs[i], h / 2, 0);
      box.castShadow = true;
      box.receiveShadow = true;
      const plate = this.disposer.add(new THREE.PlaneGeometry(Math.min(0.9, h * 0.9), Math.min(0.9, h * 0.9)));
      const uv = plate.getAttribute('uv');
      for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / 3);
      uv.needsUpdate = true;
      const lab = new THREE.Mesh(plate, labelMat);
      lab.position.set(xs[i], h / 2, 3.301);
      this.podium.add(box, lab);
    });
  }

  private resetConfetti(i: number, anywhere: boolean): void {
    const s = this.confettiState;
    const r = this.confettiRng;
    s[i * 6] = r.range(-6, 6);
    s[i * 6 + 1] = anywhere ? r.range(0, 9) : r.range(7, 9);
    s[i * 6 + 2] = r.range(-3, 3);
    s[i * 6 + 3] = r.range(0, Math.PI * 2);
    s[i * 6 + 4] = r.range(0.6, 1.3);
    s[i * 6 + 5] = r.range(2, 6);
  }

  private syncSettings(): void {
    this.settingsVersion = this.gr.settingsVersion;
    const size = shadowSizeFor(this.gr.settings);
    const enabled = size > 0;
    const changed = this.key.castShadow !== enabled;
    this.key.castShadow = enabled;
    if (enabled) {
      const s = Math.min(2048, size);
      if (this.key.shadow.mapSize.x !== s) {
        this.key.shadow.mapSize.set(s, s);
        this.key.shadow.map?.dispose();
        this.key.shadow.map = null;
      }
    }
    if (changed) {
      this.scene.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) m.needsUpdate = true;
      });
    }
  }

  /**
   * The post chain tone-maps everything in OutputPass, including the non-tone-mapped backdrop and fog: give them the
   * inverse-ACES of their colours so the studio looks as it does with direct rendering, and push the turntable rim
   * into HDR so it blooms. Direct rendering restores the designed colours.
   */
  private setPostMode(on: boolean): void {
    if (on === this.postMode) return;
    this.postMode = on;
    const inv = (dst: THREE.Color, base: THREE.Color): void => {
      if (!on) {
        dst.copy(base);
        return;
      }
      dst.setRGB(
        acesFilmicInverse(base.r, SHOWROOM_EXPOSURE),
        acesFilmicInverse(base.g, SHOWROOM_EXPOSURE),
        acesFilmicInverse(base.b, SHOWROOM_EXPOSURE),
      );
    };
    for (const k of BACKDROP_KEYS) inv(this.backdropUniforms[k].value, this.backdropBase[k]);
    if (this.scene.fog) inv(this.scene.fog.color, this.fogBase);
    this.rimMaterial.color.copy(this.rimBase).multiplyScalar(on ? SHOWROOM_RIM_HDR_GAIN : 1);
  }

  /** Studio PMREM environment (again after a WebGL context restore, which loses render-target contents). */
  private buildEnvironment(): void {
    this.envContext = this.gr.contextVersion;
    this.envTarget?.dispose();
    this.envTarget = null;
    this.scene.environment = null;
    try {
      const pmrem = new THREE.PMREMGenerator(this.gr.renderer);
      const room = new RoomEnvironment();
      this.envTarget = pmrem.fromScene(room, 0.04);
      room.dispose();
      pmrem.dispose();
      this.scene.environment = this.envTarget.texture;
    } catch (err) {
      console.error('render: showroom environment failed', err);
    }
  }

  render(dtIn: number): void {
    if (this.disposed) return;
    if (this.settingsVersion !== this.gr.settingsVersion) this.syncSettings();
    if (this.envContext !== this.gr.contextVersion) this.buildEnvironment();
    const dt = Number.isFinite(dtIn) ? clamp(dtIn, 0, 0.1) : 0;
    this.time += dt;
    const t = this.time;
    const r = this.gr.renderer;
    const W = this.gr.width;
    const H = this.gr.height;
    const aspect = W / Math.max(1, H);
    const podium = this.podium.visible;

    if (!podium) {
      this.turntable.rotation.y = (t * 0.22) % (Math.PI * 2);
      if (this.car) this.car.apply(this.states[0], dt, { time: t, rain: 0 });
      const fov = 30;
      const dist = Math.max(8.8, 3.7 / (Math.tan(THREE.MathUtils.degToRad(fov / 2)) * aspect));
      const ang = 0.55 + Math.sin(t * 0.21) * 0.32;
      this.camera.fov = fov;
      this.camera.position.set(Math.sin(ang) * dist, 2.0 + Math.sin(t * 0.37) * 0.25, Math.cos(ang) * dist);
      this.camera.lookAt(0, 0.45, 0);
    } else {
      this.podiumCars.forEach((m, i) => {
        const st = this.states[i + 1];
        m.apply(st, dt, { time: t, rain: 0 });
      });
      // On wide screens the results table covers the left half: frame the podium in the right part of the view.
      const wide = aspect > PODIUM_WIDE_ASPECT;
      const share = wide ? PODIUM_SCREEN_SHARE : 1;
      const fov = 36;
      const dist = Math.max(12.5, 5.6 / (Math.tan(THREE.MathUtils.degToRad(fov / 2)) * aspect * share));
      const ang = Math.sin(t * 0.18) * 0.2;
      this.camera.fov = fov;
      this.camera.position.set(Math.sin(ang) * dist, 3.4 + Math.sin(t * 0.3) * 0.2, Math.cos(ang) * dist);
      this.camera.lookAt(0, 1.2, 0);
      if (wide) this.camera.setViewOffset(W, H, -Math.round(W * (PODIUM_CENTER_X - 0.5)), 0, W, H);
      else this.camera.clearViewOffset();
      this.updateConfetti(dt);
    }
    if (!podium) this.camera.clearViewOffset();
    // podium cars must keep their placement: apply() writes position/rotation from state
    if (podium) this.placePodiumCars();
    else if (this.car) {
      this.car.root.position.set(0, 0.12, 0);
      this.car.root.rotation.set(0, 0, 0, 'YXZ');
    }
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();

    if (this.gr.isContextLost()) return;
    // menus always render at the user's chosen resolution (no adaptive scaling)
    this.gr.beginFrame(false);
    const post = this.gr.postPipeline();
    this.setPostMode(post !== null);
    r.toneMappingExposure = SHOWROOM_EXPOSURE;
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    r.setClearColor(0x07090f, 1);
    r.shadowMap.needsUpdate = this.key.castShadow;
    if (post) {
      showroomLook(this.gr.quality.level, this.gr.quality.vignette, this.look);
      post.render(this.scene, this.camera, this.look, dt);
    } else {
      r.clear(true, true, false);
      r.render(this.scene, this.camera);
    }
    r.shadowMap.needsUpdate = false;
  }

  private placePodiumCars(): void {
    const slots: [number, number, number][] = [
      [0, 1.1, 0],
      [-3.3, 0.75, 0.32],
      [3.3, 0.45, -0.32],
    ];
    this.podiumCars.forEach((m, i) => {
      const [x, h, yaw] = slots[i];
      m.root.position.set(x, h, 0);
      m.root.rotation.set(0, yaw, 0, 'YXZ');
    });
  }

  private updateConfetti(dt: number): void {
    const s = this.confettiState;
    const m = _m;
    const q = _q;
    const e = _e;
    const p = _p;
    const one = _one;
    for (let i = 0; i < CONFETTI; i++) {
      s[i * 6 + 1] -= s[i * 6 + 4] * dt;
      s[i * 6] += Math.sin(this.time * 1.7 + i) * 0.25 * dt;
      s[i * 6 + 3] += s[i * 6 + 5] * dt;
      if (s[i * 6 + 1] < 0) this.resetConfetti(i, false);
      e.set(s[i * 6 + 3], s[i * 6 + 3] * 0.7, i * 0.3);
      q.setFromEuler(e);
      p.set(s[i * 6], s[i * 6 + 1], s[i * 6 + 2]);
      m.compose(p, q, one);
      this.confetti.setMatrixAt(i, m);
    }
    this.confetti.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.car?.dispose();
    this.car = null;
    for (const c of this.podiumCars) c.dispose();
    this.podiumCars = [];
    this.shared.dispose();
    this.reflector.dispose();
    this.envTarget?.dispose();
    this.envTarget = null;
    this.scene.environment = null;
    this.key.shadow.map?.dispose();
    this.disposer.dispose();
    this.scene.clear();
  }
}
