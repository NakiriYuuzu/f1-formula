/**
 * Scene environment by biome × time of day × weather: gradient sky dome (sun / moon glow / stars and a drifting
 * cloud layer sampled from a tileable canvas noise texture on a high virtual plane: soft scattered clouds by
 * day, thinner at dusk, dense grey under overcast / rain), sun (or night floodlight key) with shadow, hemisphere
 * fill, fog, exposure and a PMREM environment map for reflections. Weather blends smoothly at runtime.
 * Night is floodlit: bright cool key light + strong hemisphere so the track always stays readable.
 */
import * as THREE from 'three';
import type { Biome, TimeOfDay, WeatherKind } from '../core/types';
import { clamp01, damp, lerp } from '../core/math';
import { cloudNoiseTexture } from './core/surfaceTextures';

interface TimePreset {
  sunElevation: number;
  sunAzimuth: number;
  sunColor: string;
  sunIntensity: number;
  zenith: string;
  horizon: string;
  overcastZenith: string;
  overcastHorizon: string;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  fogNear: number;
  fogFar: number;
  exposure: number;
  stars: number;
  showSun: boolean;
  /** 0..1 emissive level for lamps / floodlight heads */
  lamps: number;
  envIntensity: number;
}

const TIME: Record<TimeOfDay, TimePreset> = {
  day: {
    sunElevation: 52,
    sunAzimuth: 35,
    sunColor: '#fff3df',
    sunIntensity: 3.1,
    zenith: '#3f7fd8',
    horizon: '#bcd5ec',
    overcastZenith: '#7f8893',
    overcastHorizon: '#aeb3b9',
    hemiSky: '#d2e4ff',
    hemiGround: '#6f6a55',
    hemiIntensity: 1.15,
    fogNear: 300,
    fogFar: 2800,
    exposure: 1.0,
    stars: 0,
    showSun: true,
    lamps: 0,
    envIntensity: 0.9,
  },
  dusk: {
    sunElevation: 7,
    sunAzimuth: 60,
    sunColor: '#ffb37a',
    sunIntensity: 2.4,
    zenith: '#2d3f75',
    horizon: '#eea576',
    overcastZenith: '#4f4f60',
    overcastHorizon: '#9b8a86',
    hemiSky: '#9aa8dc',
    hemiGround: '#5d4c42',
    hemiIntensity: 1.0,
    fogNear: 220,
    fogFar: 2300,
    exposure: 1.08,
    stars: 0.15,
    showSun: true,
    lamps: 0.7,
    envIntensity: 0.8,
  },
  night: {
    sunElevation: 62,
    sunAzimuth: 20,
    sunColor: '#e6edff',
    sunIntensity: 2.0,
    zenith: '#060b1a',
    horizon: '#1d2846',
    overcastZenith: '#0d1018',
    overcastHorizon: '#262a36',
    hemiSky: '#7d90c2',
    hemiGround: '#3e3e46',
    hemiIntensity: 1.05,
    fogNear: 180,
    fogFar: 1900,
    exposure: 1.18,
    stars: 1,
    showSun: false,
    lamps: 1,
    envIntensity: 0.7,
  },
};

/**
 * Biome atmosphere: horizon haze tint / amount, sun azimuth offset, optional extra clear-sky cloud cover (towering
 * cumulus) and fog distance multiplier (humid air shortens the view).
 */
const BIOME_HAZE: Record<Biome, { haze: string; amount: number; azimuthOffset: number; cloud?: number; fog?: number }> = {
  temperate: { haze: '#c6d6e6', amount: 0.1, azimuthOffset: 0 },
  autumn: { haze: '#e2d2bc', amount: 0.2, azimuthOffset: 30 },
  desert: { haze: '#e3d3b2', amount: 0.35, azimuthOffset: -40 },
  coastal: { haze: '#b6d4ea', amount: 0.2, azimuthOffset: 80 },
  city: { haze: '#b8b8bc', amount: 0.25, azimuthOffset: 140 },
  tropical: { haze: '#d3dcd6', amount: 0.4, azimuthOffset: 100, cloud: 0.2, fog: 0.75 },
};

/** Cloud layer: fraction of the sky covered under clear weather and under full overcast. */
export const CLOUD_COVER_CLEAR = 0.42;
export const CLOUD_COVER_OVERCAST = 1.0;
/** Coverage multiplier for light cloud at dusk / night (thinner, wispier evening sky). */
export const CLOUD_DUSK_THIN = 0.68;
export const CLOUD_NIGHT_THIN = 0.8;
/** Edge softness of cloud shapes (noise range) under clear / overcast weather. */
export const CLOUD_SOFTNESS: readonly [number, number] = [0.28, 0.55];
/** Texture repeats per unit of the projected cloud plane (bigger = smaller clouds). */
export const CLOUD_SCALE = 0.5;
/** Cloud drift (texture units per second of race time) — slow wind. */
export const CLOUD_DRIFT: readonly [number, number] = [0.0032, 0.0011];
/** Cloud noise texture edge (px). */
export const CLOUD_TEXTURE_SIZE = 256;
/** Lit / shaded cloud colours per time of day, for clear and full overcast skies. */
const CLOUD_COLORS: Record<TimeOfDay, { lit: string; shade: string; litOvercast: string; shadeOvercast: string }> = {
  day: { lit: '#f7f8fb', shade: '#a7b0bf', litOvercast: '#b6bbc2', shadeOvercast: '#7b818a' },
  dusk: { lit: '#f4b891', shade: '#6c5a73', litOvercast: '#968890', shadeOvercast: '#4e4754' },
  night: { lit: '#3a425a', shade: '#1b1f2c', litOvercast: '#2b2f3b', shadeOvercast: '#15171f' },
};
/** Moon halo strength (night): broad glow and tight corona. */
export const MOON_GLOW: readonly [number, number] = [0.05, 0.16];

/** Cloud layer shape for a smoothed cloudiness (0..1) and time of day: coverage, edge softness, opacity. */
export function cloudLayer(cloud: number, timeOfDay: TimeOfDay, extra = 0): { cover: number; softness: number; opacity: number } {
  const c = clamp01(Number.isFinite(cloud) ? cloud : 0);
  const thin = timeOfDay === 'dusk' ? CLOUD_DUSK_THIN : timeOfDay === 'night' ? CLOUD_NIGHT_THIN : 1;
  const cover = lerp(CLOUD_COVER_CLEAR + extra, CLOUD_COVER_OVERCAST, smooth(c)) * lerp(thin, 1, c);
  return { cover: clamp01(cover), softness: lerp(CLOUD_SOFTNESS[0], CLOUD_SOFTNESS[1], c), opacity: lerp(0.82, 1, c) };
}

/** Cloudiness implied by a weather kind. */
export function weatherCloud(kind: WeatherKind): number {
  switch (kind) {
    case 'overcast':
      return 0.75;
    case 'lightRain':
      return 0.9;
    case 'heavyRain':
      return 1;
    default:
      return 0.12;
  }
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 ground;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float sunDisc;
uniform vec3 moonDir;
uniform float moon;
uniform float stars;
uniform float cloudCover;
uniform float cloudSoft;
uniform float cloudOpacity;
uniform vec3 cloudColor;
uniform vec3 cloudShade;
uniform vec2 cloudOffset;
uniform sampler2D cloudMap;
uniform float time;
varying vec3 vDir;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.5));
  col = mix(col, ground, 1.0 - smoothstep(-0.12, 0.0, h));
  float sd = max(dot(dir, sunDir), 0.0);
  col += sunColor * (pow(sd, 6.0) * 0.18 + pow(sd, 120.0) * 0.5) * sunDisc;
  col += sunColor * smoothstep(0.99955, 0.99975, sd) * 2.5 * sunDisc;
  float md = max(dot(dir, moonDir), 0.0);
  vec3 moonTint = vec3(0.78, 0.85, 1.0);
  col += moonTint * (smoothstep(0.99935, 0.9996, md) * 1.4 + pow(md, 12.0) * MOON_GLOW_WIDE + pow(md, 80.0) * MOON_GLOW_CORE) * moon;
  if (stars > 0.0 && h > 0.0) {
    vec3 q = floor(dir * 700.0);
    float s = hash13(q);
    float tw = 0.6 + 0.4 * sin(time * 2.0 + s * 50.0);
    col += vec3(step(0.9982, s) * tw * stars * smoothstep(0.02, 0.25, h));
  }
  if (h > 0.0 && cloudCover > 0.0) {
    vec2 p = dir.xz / (h + 0.12) * CLOUD_SCALE;
    float n = texture2D(cloudMap, p + cloudOffset).r * 0.68 + texture2D(cloudMap, p * 2.7 + cloudOffset * 1.6 + vec2(0.37, 0.61)).r * 0.32;
    float lo = 1.0 - cloudCover;
    float dens = smoothstep(lo, lo + cloudSoft, n) * smoothstep(0.0, 0.1, h);
    float thick = smoothstep(lo + cloudSoft * 0.35, lo + cloudSoft + 0.25, n);
    vec3 cc = mix(cloudColor, cloudShade, thick);
    cc += sunColor * pow(sd, 5.0) * 0.45 * sunDisc * (1.0 - thick);
    cc += moonTint * pow(md, 6.0) * 0.22 * moon;
    col = mix(col, cc, dens * cloudOpacity);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export interface SkyUniforms {
  [uniform: string]: THREE.IUniform;
  zenith: THREE.IUniform<THREE.Color>;
  horizon: THREE.IUniform<THREE.Color>;
  ground: THREE.IUniform<THREE.Color>;
  sunDir: THREE.IUniform<THREE.Vector3>;
  sunColor: THREE.IUniform<THREE.Color>;
  sunDisc: THREE.IUniform<number>;
  moonDir: THREE.IUniform<THREE.Vector3>;
  moon: THREE.IUniform<number>;
  stars: THREE.IUniform<number>;
  cloudCover: THREE.IUniform<number>;
  cloudSoft: THREE.IUniform<number>;
  cloudOpacity: THREE.IUniform<number>;
  cloudColor: THREE.IUniform<THREE.Color>;
  cloudShade: THREE.IUniform<THREE.Color>;
  cloudOffset: THREE.IUniform<THREE.Vector2>;
  cloudMap: THREE.IUniform<THREE.Texture | null>;
  time: THREE.IUniform<number>;
}

/** Sky dome material; `cloudMap` = tileable greyscale noise (null disables the cloud layer). */
export function createSkyMaterial(cloudMap: THREE.Texture | null = null): THREE.ShaderMaterial & { uniforms: SkyUniforms } {
  const uniforms: SkyUniforms = {
    zenith: { value: new THREE.Color() },
    horizon: { value: new THREE.Color() },
    ground: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunColor: { value: new THREE.Color(1, 1, 1) },
    sunDisc: { value: 1 },
    moonDir: { value: new THREE.Vector3(0, 1, 0) },
    moon: { value: 0 },
    stars: { value: 0 },
    cloudCover: { value: 0 },
    cloudSoft: { value: CLOUD_SOFTNESS[0] },
    cloudOpacity: { value: 1 },
    cloudColor: { value: new THREE.Color(1, 1, 1) },
    cloudShade: { value: new THREE.Color(0.7, 0.72, 0.76) },
    cloudOffset: { value: new THREE.Vector2() },
    cloudMap: { value: cloudMap },
    time: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    name: 'sky',
    uniforms,
    defines: {
      CLOUD_SCALE: glslFloat(CLOUD_SCALE),
      MOON_GLOW_WIDE: glslFloat(MOON_GLOW[0]),
      MOON_GLOW_CORE: glslFloat(MOON_GLOW[1]),
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  if (!cloudMap) uniforms.cloudCover.value = 0;
  return mat as THREE.ShaderMaterial & { uniforms: SkyUniforms };
}

function glslFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}

export interface EnvironmentOptions {
  biome: Biome;
  timeOfDay: TimeOfDay;
  weather: WeatherKind;
  /** 0..1: how strongly floodlights light the circuit at night (real F1 night races ~1, the original city circuit lower) */
  floodlit?: number;
}

/** Night floodlighting: key / ambient light multipliers and exposure gain at full strength (the sky dome is unlit, so it stays dark). */
export const FLOOD_SUN_GAIN = 0.4;
export const FLOOD_HEMI_GAIN = 0.7;
export const FLOOD_EXPOSURE_GAIN = 0.05;
/** At full strength the moonlight key turns neutral white and the ambient sky colour loses its blue cast. */
const FLOOD_SUN_COLOR = '#f4f1ea';
const FLOOD_HEMI_SKY = '#b3bddc';

/**
 * Sun shadow camera. The key light sits SUN_DISTANCE (400 m) from the focus along the sun direction, so everything that
 * can shade the ±70 m box (terrain relief, towers up to ~250 m) lies between 100 m and 650 m from the camera. An ortho
 * depth bias is `bias × (far − near)` metres: 0.00015 × 550 m = 8 cm (it was 0.0004 × 899 m = 36 cm, which let the tyres
 * float above their shadow). normalBias covers the acne a smaller bias would bring back.
 */
export const SUN_SHADOW = { near: 100, far: 650, bias: -0.00015, normalBias: 0.04 } as const;
/** Light-to-focus distance (m) used by placeSun. */
export const SUN_DISTANCE = 400;

/** Effective shadow depth offset in metres. */
export function sunShadowBiasMetres(): number {
  return Math.abs(SUN_SHADOW.bias) * (SUN_SHADOW.far - SUN_SHADOW.near);
}

/** Owns sky, lights and fog of a race scene. */
export class Environment {
  readonly sky: THREE.Mesh;
  readonly skyMaterial: THREE.ShaderMaterial & { uniforms: SkyUniforms };
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.Fog;
  /** unit vector towards the key light */
  readonly sunDir = new THREE.Vector3();
  readonly timeOfDay: TimeOfDay;
  readonly preset: TimePreset;
  /** floodlight strength 0..1 (full at night, half at dusk, 0 by day) */
  readonly flood: number;
  /** current lamp glow (0..1), read by trackside lamp materials */
  lampLevel: number;
  exposure: number;
  envIntensity: number;
  /** current smoothed cloudiness 0..1 */
  cloud: number;

  private readonly base = {
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    oZenith: new THREE.Color(),
    oHorizon: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    sunColor: new THREE.Color(),
  };
  private readonly tmp = new THREE.Color();
  private readonly tmp2 = new THREE.Color();
  private readonly geometry: THREE.SphereGeometry;
  /** tileable cloud noise sampled by the sky shader (also shared with the PMREM sky copy) */
  readonly cloudTexture: THREE.Texture | null;
  private rain = 0;
  /** biome extras: added clear-sky cloud cover and fog distance multiplier */
  private readonly biomeCloud: number;
  private readonly biomeFog: number;

  constructor(opts: EnvironmentOptions) {
    this.timeOfDay = opts.timeOfDay;
    this.flood = clamp01(opts.floodlit ?? 0) * (opts.timeOfDay === 'night' ? 1 : opts.timeOfDay === 'dusk' ? 0.5 : 0);
    const p = TIME[opts.timeOfDay] ?? TIME.day;
    this.preset = p;
    const bh = BIOME_HAZE[opts.biome] ?? BIOME_HAZE.temperate;
    const haze = new THREE.Color(bh.haze);
    this.biomeCloud = bh.cloud ?? 0;
    this.biomeFog = bh.fog ?? 1;
    this.base.zenith.set(p.zenith);
    this.base.horizon.set(p.horizon).lerp(haze, opts.timeOfDay === 'night' ? bh.amount * 0.15 : bh.amount);
    this.base.oZenith.set(p.overcastZenith);
    this.base.oHorizon.set(p.overcastHorizon);
    this.base.hemiSky.set(p.hemiSky);
    this.base.hemiGround.set(p.hemiGround);
    this.base.sunColor.set(p.sunColor);
    if (opts.timeOfDay === 'night') {
      this.base.sunColor.lerp(this.tmp.set(FLOOD_SUN_COLOR), this.flood);
      this.base.hemiSky.lerp(this.tmp.set(FLOOD_HEMI_SKY), this.flood);
    }

    const el = THREE.MathUtils.degToRad(p.sunElevation);
    const az = THREE.MathUtils.degToRad(p.sunAzimuth + bh.azimuthOffset);
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();

    this.cloudTexture = createCloudTexture();
    this.skyMaterial = createSkyMaterial(this.cloudTexture);
    this.geometry = new THREE.SphereGeometry(3000, 32, 16);
    this.sky = new THREE.Mesh(this.geometry, this.skyMaterial);
    this.sky.name = 'sky';
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.sky.matrixAutoUpdate = true;

    this.sun = new THREE.DirectionalLight(this.base.sunColor.clone(), p.sunIntensity);
    this.sun.name = 'sun';
    // light direction = position - target; correct even when placeSun() is never called (shadows off)
    this.sun.position.copy(this.sunDir).multiplyScalar(SUN_DISTANCE);
    this.sun.target.position.set(0, 0, 0);
    this.sun.shadow.bias = SUN_SHADOW.bias;
    this.sun.shadow.normalBias = SUN_SHADOW.normalBias;
    const sc = this.sun.shadow.camera;
    sc.left = -70;
    sc.right = 70;
    sc.top = 70;
    sc.bottom = -70;
    sc.near = SUN_SHADOW.near;
    sc.far = SUN_SHADOW.far;
    this.hemi = new THREE.HemisphereLight(this.base.hemiSky.clone(), this.base.hemiGround.clone(), p.hemiIntensity);
    this.hemi.name = 'hemi';
    this.fog = new THREE.Fog(this.base.horizon.clone(), p.fogNear, p.fogFar);

    const u = this.skyMaterial.uniforms;
    u.sunDir.value.copy(this.sunDir);
    u.sunDisc.value = p.showSun ? 1 : 0;
    u.stars.value = p.stars;
    if (opts.timeOfDay === 'night') {
      u.moon.value = 1;
      u.moonDir.value.set(-this.sunDir.x, 0.55, -this.sunDir.z).normalize();
    }
    this.cloud = weatherCloud(opts.weather);
    this.lampLevel = p.lamps;
    this.exposure = p.exposure;
    this.envIntensity = p.envIntensity;
    this.applyWeather(this.cloud, 0);
  }

  /** Smoothly follow the current weather. Call once per frame. */
  update(kind: WeatherKind, rain: number, dt: number, time: number): void {
    const r = clamp01(Number.isFinite(rain) ? rain : 0);
    const target = Math.max(weatherCloud(kind), r > 0.05 ? 0.85 + 0.15 * r : 0);
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
    this.cloud = damp(this.cloud, target, 0.6, step);
    this.rain = damp(this.rain, r, 0.8, step);
    this.applyWeather(this.cloud, this.rain);
    const t = Number.isFinite(time) ? time % 10000 : 0;
    const u = this.skyMaterial.uniforms;
    u.time.value = t;
    u.cloudOffset.value.set((t * CLOUD_DRIFT[0]) % 1, (t * CLOUD_DRIFT[1]) % 1);
  }

  private applyWeather(cloud: number, rain: number): void {
    const p = this.preset;
    const c = clamp01(cloud);
    const u = this.skyMaterial.uniforms;
    u.zenith.value.copy(this.base.zenith).lerp(this.base.oZenith, c);
    u.horizon.value.copy(this.base.horizon).lerp(this.base.oHorizon, c);
    u.ground.value.copy(u.horizon.value).multiplyScalar(0.85);
    u.sunColor.value.copy(this.base.sunColor);
    u.sunDisc.value = p.showSun ? 1 - smooth(c) * 0.97 : 0;
    const layer = cloudLayer(c, this.timeOfDay, this.biomeCloud);
    u.cloudCover.value = this.cloudTexture ? layer.cover : 0;
    u.cloudSoft.value = layer.softness;
    u.cloudOpacity.value = layer.opacity;
    const night = this.timeOfDay === 'night';
    const cc = CLOUD_COLORS[this.timeOfDay] ?? CLOUD_COLORS.day;
    const dark = 1 - 0.28 * clamp01(rain);
    u.cloudColor.value.copy(this.tmp.set(cc.lit)).lerp(this.tmp2.set(cc.litOvercast), c).multiplyScalar(dark).lerp(u.horizon.value, 0.12 + 0.25 * c);
    u.cloudShade.value.copy(this.tmp.set(cc.shade)).lerp(this.tmp2.set(cc.shadeOvercast), c).multiplyScalar(dark).lerp(u.horizon.value, 0.1 + 0.2 * c);
    u.stars.value = p.stars * (1 - c);
    u.moon.value = night ? 1 - c * 0.9 : 0;

    // key light: dims under clouds (night floodlights are artificial, dim less)
    const dimK = night ? 0.25 : 0.72;
    this.sun.intensity = p.sunIntensity * (1 + FLOOD_SUN_GAIN * this.flood) * (1 - dimK * c);
    this.sun.shadow.intensity = 1 - (night ? 0.3 : 0.65) * c;
    this.hemi.intensity = p.hemiIntensity * (1 + FLOOD_HEMI_GAIN * this.flood) * (1 + 0.18 * c);
    this.hemi.color.copy(this.base.hemiSky).lerp(this.tmp.set('#c4c8cf'), night ? 0.1 * c : 0.6 * c);
    this.hemi.groundColor.copy(this.base.hemiGround);

    this.fog.color.copy(u.horizon.value);
    this.fog.near = p.fogNear * this.biomeFog * lerp(1, 0.35, c) * lerp(1, 0.4, rain);
    this.fog.far = p.fogFar * this.biomeFog * lerp(1, 0.5, c) * lerp(1, 0.38, rain);
    this.exposure = p.exposure * (1 + FLOOD_EXPOSURE_GAIN * this.flood) * lerp(1, 1.06, c);
    this.envIntensity = p.envIntensity * lerp(1, 0.65, c);
    this.lampLevel = Math.max(p.lamps, this.timeOfDay === 'day' ? 0.35 * smooth(c) : 0);
  }

  /** Keep the dome centred on the camera of the view being rendered. */
  followCamera(cam: THREE.Camera): void {
    this.sky.position.copy(cam.position);
    this.sky.updateMatrixWorld();
  }

  /**
   * Position the key light so its ±70 m shadow box is centred on `focus`, snapped to shadow-map texels to
   * avoid shimmering.
   */
  placeSun(focus: THREE.Vector3, shadowMapSize: number): void {
    const size = Math.max(256, shadowMapSize || 2048);
    const texel = 140 / size;
    const light = this.sun;
    // snap in light space
    const up = Math.abs(this.sunDir.y) > 0.99 ? _x : _y;
    _right.crossVectors(up, this.sunDir).normalize();
    _up.crossVectors(this.sunDir, _right).normalize();
    const a = Math.round(focus.dot(_right) / texel) * texel;
    const b = Math.round(focus.dot(_up) / texel) * texel;
    const c = focus.dot(this.sunDir);
    _f.copy(_right).multiplyScalar(a).addScaledVector(_up, b).addScaledVector(this.sunDir, c);
    light.target.position.copy(_f);
    light.position.copy(_f).addScaledVector(this.sunDir, SUN_DISTANCE);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
  }

  dispose(): void {
    this.geometry.dispose();
    this.skyMaterial.dispose();
    this.cloudTexture?.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
  }
}

const _x = new THREE.Vector3(1, 0, 0);
const _y = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _f = new THREE.Vector3();

/** Cloud noise texture, or null where no 2D canvas is available (the sky then renders without clouds). */
function createCloudTexture(): THREE.Texture | null {
  try {
    return cloudNoiseTexture(CLOUD_TEXTURE_SIZE);
  } catch (err) {
    console.warn('render: cloud texture unavailable', err);
    return null;
  }
}

function smooth(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * Build a PMREM environment map from the current sky (plus bright floodlight panels at night) so paint
 * and wet asphalt get plausible reflections. Returns the render target (caller disposes it).
 */
export function buildEnvironmentMap(renderer: THREE.WebGLRenderer, env: Environment): THREE.WebGLRenderTarget | null {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  const skyMat = createSkyMaterial(env.cloudTexture);
  const src = env.skyMaterial.uniforms;
  const dst = skyMat.uniforms;
  dst.zenith.value.copy(src.zenith.value);
  dst.horizon.value.copy(src.horizon.value);
  dst.ground.value.copy(src.ground.value).multiplyScalar(0.6);
  dst.sunDir.value.copy(src.sunDir.value);
  dst.sunColor.value.copy(src.sunColor.value);
  dst.sunDisc.value = src.sunDisc.value * 0.6;
  dst.cloudCover.value = src.cloudCover.value * 0.6;
  dst.cloudSoft.value = src.cloudSoft.value;
  dst.cloudOpacity.value = src.cloudOpacity.value;
  dst.cloudColor.value.copy(src.cloudColor.value);
  dst.cloudShade.value.copy(src.cloudShade.value);
  dst.cloudOffset.value.copy(src.cloudOffset.value);
  const geo = new THREE.SphereGeometry(50, 32, 16);
  scene.add(new THREE.Mesh(geo, skyMat));
  const extras: THREE.BufferGeometry[] = [geo];
  const extraMats: THREE.Material[] = [skyMat];
  if (env.preset.lamps > 0.5) {
    const panelGeo = new THREE.PlaneGeometry(8, 3);
    const panelMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.1, 1.9), side: THREE.DoubleSide, toneMapped: false });
    extras.push(panelGeo);
    extraMats.push(panelMat);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const m = new THREE.Mesh(panelGeo, panelMat);
      m.position.set(Math.cos(a) * 30, 9, Math.sin(a) * 30);
      m.lookAt(0, 0, 0);
      scene.add(m);
    }
  }
  let rt: THREE.WebGLRenderTarget | null = null;
  try {
    rt = pmrem.fromScene(scene, 0.02, 0.1, 100);
  } catch (err) {
    console.error('render: environment map failed', err);
    rt = null;
  }
  pmrem.dispose();
  for (const g of extras) g.dispose();
  for (const m of extraMats) m.dispose();
  return rt;
}
