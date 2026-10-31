/**
 * Post-processing look + adaptive resolution: every tunable of the post chain (ambient occlusion, aerial perspective,
 * selective bloom, colour grade, vignette, speed blur, lens chromatic aberration, film grain) and of the frame-time controller as
 * named constants, plus the pure helpers that turn time of day /
 * biome / weather / quality into a PostLook (no three.js, no DOM: unit-tested headless). postPipeline.ts applies a
 * PostLook to the GPU passes; GameRenderer drives AdaptiveResolution.
 *
 * All colour values are linear, scene-referred HDR (before exposure and ACES, which only OutputPass applies).
 * Reference levels: a sun-lit white surface reaches ~1.1–1.3 by day, ~0.7 under night floodlights; the LDR
 * emissives (lamp heads, start lights, rain light, brake glow) peak at 1.0 in their brightest channel.
 * The bright pass therefore tests the brightest channel (red lamps qualify) against a per-time-of-day threshold.
 */
import type { Biome, QualityLevel, TimeOfDay } from '../../core/types';
import { clamp, clamp01, lerp, smoothstep } from '../../core/math';

export type Rgb = [number, number, number];

export interface BloomParams {
  /** UnrealBloomPass strength (a large uniform bright area gains ≈ 9 × strength × its value) */
  strength: number;
  /** 0..1 blur radius blend between the small and the wide mips */
  radius: number;
  /** brightest-channel level where the soft knee starts */
  threshold: number;
}

export interface GradeParams {
  /** per-channel multiplier, normalised to luminance 1 (never changes overall exposure) */
  tint: Rgb;
  /** 1 = unchanged, < 1 = desaturated */
  saturation: number;
  /** power-curve contrast around GRADE_PIVOT (0 stays 0, so blacks are never clipped) */
  contrast: number;
  /** linear amount added to the darkest tones (fades out by GRADE_LIFT_RANGE) */
  lift: number;
  /** photographic split tone 0..1: cool-green shadows, warm highlights (GRADE_SPLIT_SHADOW / GRADE_SPLIT_HIGHLIGHT) */
  split: number;
}

/**
 * Aerial perspective (applied from the scene depth in the grade pass): exponential height fog integrated along the view
 * ray, the transmitted light losing blue with distance, and a veil that is bluer on steep paths and glows toward the sun.
 */
export interface HazeParams {
  /** blend 0..1 (0 = off) */
  amount: number;
  /** extinction (1/m) at the base height */
  density: number;
  /** exponential scale height (m) of the haze above `base` */
  height: number;
  /** world height (m) where the extinction equals `density` */
  base: number;
  /** veil colour of level / grazing paths (linear HDR) */
  color: Rgb;
  /** veil colour of steep paths (looking down from a height: denser blue) */
  steep: Rgb;
  /** forward-scatter glow added toward the sun (linear HDR, × (cos angle)^HAZE_SUN_POWER) */
  sun: Rgb;
  /** unit vector toward the sun */
  sunDir: Rgb;
  /** blue loss of the transmitted light at full veil (0 = neutral) */
  blueShift: number;
  /** largest veil share: the farthest scenery keeps a readable silhouette */
  cap: number;
  /** darkening under cloud shadows 0..1 (0 = off): the sky's cloud noise projected along the sun onto the ground */
  cloudShadow: number;
  /** cloud layer coverage / edge softness (as the sky dome) and drift offset (texture units) */
  cloudCover: number;
  cloudSoft: number;
  cloudOffset: [number, number];
}

export interface PostLook {
  bloom: BloomParams;
  grade: GradeParams;
  /** corner darkening 0..1 (0 = off) */
  vignette: number;
  /** radial speed blur 0..SPEED_BLUR_MAX (0 = off), see speedBlurAmount */
  speedBlur: number;
  /** ambient-occlusion blend 0..1 (0 = off; only where the pipeline was built with AO) */
  ao: number;
  /** lateral chromatic aberration at the corners (UV fraction, 0 = off) */
  chroma: number;
  /** film grain amplitude (multiplicative ±, 0 = off) */
  grain: number;
  /** unsharp-mask amount (0 = off): crisper texture detail after the MSAA resolve */
  sharpen: number;
  /** aerial perspective (only where the pipeline resolves the scene depth) */
  haze: HazeParams;
}

// ───────────────────────────── pipeline ─────────────────────────────

/** MSAA samples of the composer's scene target when Settings.antialias is on (clamped to the GPU maximum). */
export const POST_MSAA_SAMPLES = 4;

// ───────────────────────────── ambient occlusion ─────────────────────────────

/** GTAO blend per time of day (night floodlight scenes have less ambient light to occlude). */
export const AO_BY_TIME: Record<TimeOfDay, number> = { day: 0.8, dusk: 0.75, night: 0.6 };
/** Overcast / rain light is diffuse: contact shading reads stronger (blend × (1 + boost × cloud)). */
export const AO_OVERCAST_BOOST = 0.15;
/** World radius (m) of the occlusion search: under cars, wheel arches, barrier feet, grandstand rows. */
export const AO_RADIUS = 0.9;
/** Depth difference (m) beyond which an occluder in front is ignored (no dark halos around cars against far ground). */
export const AO_THICKNESS = 0.8;
/** Horizon samples per pixel (GTAO SAMPLES). */
export const AO_SAMPLES = 12;
/** Showroom AO blend (studio light is mostly ambient: AO grounds the car on the turntable). */
export const SHOWROOM_AO = 0.9;

// ───────────────────────────── aerial perspective ─────────────────────────────

/**
 * Haze extinction = HAZE_FOG_K / the environment's linear fog far distance (clear day 2800 m ⇒ 0.00025 / m: ≈ 7 % veil
 * at 300 m, 31 % at 1.5 km, 50 % at 2.8 km at ground level), so weather and biome keep their tuned visibility while
 * distant ranges keep their relief.
 */
export const HAZE_FOG_K = 0.7;
/** Scale height (m) of the haze above the circuit's lowest point: hill and mountain tops stand out of it. */
export const HAZE_HEIGHT = 900;
/** Veil colours relative to the sky's horizon / zenith: a touch darker than the horizon sky, bluer on steep paths. */
export const HAZE_VEIL_GAIN = 0.9;
export const HAZE_STEEP_ZENITH = 0.4;
/** Forward-scatter glow toward the sun (× sun colour × visible sun disc) and its angular tightness. */
export const HAZE_SUN_GAIN = 0.32;
export const HAZE_SUN_POWER = 8;
/** Blue loss of the transmitted light per time of day (napali: (.55, .78, 1) × .35 at full veil). */
export const HAZE_BLUE_SHIFT: Record<TimeOfDay, number> = { day: 1, dusk: 0.6, night: 0 };
/** Largest veil share per time of day (night keeps lit skylines readable). */
export const HAZE_CAP: Record<TimeOfDay, number> = { day: 0.93, dusk: 0.93, night: 0.85 };
/**
 * Cloud shadows on the land: darkening under a cloud by time of day (they fade out toward full overcast, where the
 * light is already flat), the cloud deck height (m) the noise is projected from and the world size (m) of one noise tile.
 */
export const CLOUD_SHADOW: Record<TimeOfDay, number> = { day: 0.42, dusk: 0.28, night: 0 };
export const CLOUD_SHADOW_HEIGHT = 1500;
export const CLOUD_SHADOW_TILE = 2400;
/** Shadow coverage is the sky's plus this: thin cloud edges that barely show against the sky still shade the land. */
export const CLOUD_SHADOW_EXTRA_COVER = 0.07;

/** What the environment provides for the haze (linear colours). */
export interface HazeInput {
  time: TimeOfDay;
  /** linear fog far distance (m) of the current weather / biome */
  fogFar: number;
  /** lowest height of the circuit (m): haze base */
  base: number;
  horizon: Rgb;
  zenith: Rgb;
  sunColor: Rgb;
  sunDir: Rgb;
  /** visible sun disc 0..1 (0 at night / under full overcast) */
  sunDisc: number;
  /** smoothed cloudiness 0..1 and the sky's cloud layer (coverage, softness, drift offset) */
  cloud: number;
  cloudCover: number;
  cloudSoft: number;
  cloudOffset: [number, number];
}

// ───────────────────────────── lens ─────────────────────────────

/** Lateral chromatic aberration at the screen corners (UV fraction toward the centre; red in, blue out). */
export const LENS_CHROMA = 0.0022;
/** Film grain amplitude (± fraction of the linear colour; also dithers sky gradients against banding). */
export const LENS_GRAIN = 0.03;

// ───────────────────────────── bloom ─────────────────────────────

/** Bloom per time of day: night strongest, day subtle (day threshold sits above sun-lit white). */
export const BLOOM_BY_TIME: Record<TimeOfDay, BloomParams> = {
  day: { strength: 0.05, radius: 0.25, threshold: 1.6 },
  dusk: { strength: 0.09, radius: 0.32, threshold: 1.1 },
  night: { strength: 0.14, radius: 0.4, threshold: 1.0 },
};
/** Threshold reached under full cloud cover (overcast light is flat: lit surfaces stay below it, lamps do not). */
export const BLOOM_OVERCAST_THRESHOLD = 1.0;
/** Extra bloom strength at full rain (wet glare): strength × (1 + boost × rain). */
export const BLOOM_RAIN_BOOST = 0.15;
/** Soft-knee width above the threshold (0 = hard cut, more = gentler fade-in, less popping). */
export const BLOOM_KNEE = 0.12;
/** HDR input clamp of the bright pass (stops sun glints from blooming into flickering fireflies). */
export const BLOOM_MAX_INPUT = 6;
/** Strength / radius multipliers per quality (low has no post chain at all). */
export const BLOOM_QUALITY: Record<QualityLevel, { strength: number; radius: number }> = {
  low: { strength: 0, radius: 0 },
  medium: { strength: 0.85, radius: 0.85 },
  high: { strength: 1, radius: 1 },
  ultra: { strength: 1, radius: 1 },
};
/** Trackside lamp-head colour gain while the post chain is on (pushes them into HDR above the threshold). */
export const LAMP_HDR_GAIN = 1.5;

// ───────────────────────────── colour grade ─────────────────────────────

/** Base grade per time of day: dusk warmer, night cooler with a touch of lift for readability. */
export const GRADE_BY_TIME: Record<TimeOfDay, GradeParams> = {
  day: { tint: [1, 1, 1], saturation: 0.98, contrast: 1.08, lift: 0.003, split: 1 },
  dusk: { tint: [1.05, 1.0, 0.92], saturation: 1.04, contrast: 1.07, lift: 0.004, split: 0.8 },
  night: { tint: [0.95, 0.99, 1.05], saturation: 0.96, contrast: 1.06, lift: 0.008, split: 0.3 },
};
/**
 * Split tone at full strength (napali's photographic grade): per-channel gain offsets of the shadows and of the
 * highlights, blended by luminance (shadows cool green-cyan, highlights warm). Rain halves it.
 */
export const GRADE_SPLIT_SHADOW: Rgb = [-0.035, 0.012, 0.01];
export const GRADE_SPLIT_HIGHLIGHT: Rgb = [0.035, 0.01, -0.05];
/** Unsharp mask of race views per quality (low has no post chain). */
export const SHARPEN_BY_QUALITY: Record<QualityLevel, number> = { low: 0, medium: 0.1, high: 0.16, ultra: 0.18 };
/** Biome flavour on top of the time-of-day grade: tint multiplier and saturation offset. */
export const GRADE_BIOME: Record<Biome, { tint: Rgb; saturation: number }> = {
  temperate: { tint: [1, 1, 1], saturation: 0 },
  autumn: { tint: [1.03, 1.0, 0.95], saturation: 0.04 },
  desert: { tint: [1.03, 1.0, 0.95], saturation: 0.02 },
  coastal: { tint: [0.99, 1.0, 1.02], saturation: 0.03 },
  city: { tint: [0.99, 1.0, 1.01], saturation: -0.02 },
  tropical: { tint: [1.01, 1.01, 0.97], saturation: 0.06 },
};
/** Grade at full rain: saturation and contrast multipliers, cool grey tint (blended in by rain 0..1). */
export const GRADE_RAIN = { saturation: 0.82, contrast: 0.97, tint: [0.98, 0.99, 1.02] as Rgb };
/** Contrast pivot (linear mid grey). */
export const GRADE_PIVOT = 0.18;
/** Lift fades out completely at this linear level. */
export const GRADE_LIFT_RANGE = 0.3;

// ───────────────────────────── vignette ─────────────────────────────

/** Corner darkening of race views (multiplier 1 − strength at the corners). */
export const VIGNETTE_STRENGTH = 0.22;
/** Normalised radius where the vignette starts (1 = screen corner; 16:9 edge centres sit at ~0.49 / ~0.87). */
export const VIGNETTE_START = 0.45;

// ───────────────────────────── speed blur ─────────────────────────────

/** Followed car's speed (m/s, ≈ 162 km/h) where the radial speed blur starts: slow corners stay sharp. */
export const SPEED_BLUR_MIN_SPEED = 45;
/** Speed (m/s, ≈ 324 km/h) of the full speed blur. */
export const SPEED_BLUR_FULL_SPEED = 90;
/** Blur length at full speed and 100 % strength, as a fraction of each pixel's distance to the screen centre. */
export const SPEED_BLUR_MAX = 0.09;
/** Normalised radius (as VIGNETTE_START) where the blur fades in: the centre (car, apex) stays sharp. */
export const SPEED_BLUR_START = 0.3;
/** Texture taps along the blur (jittered per pixel against banding). */
export const SPEED_BLUR_TAPS = 12;

// ───────────────────────────── showroom ─────────────────────────────

/** Menu showroom: bloom for the turntable rim and paint glints only (rim is pushed above it by the gain below). */
export const SHOWROOM_BLOOM: BloomParams = { strength: 0.06, radius: 0.3, threshold: 2.4 };
/** Turntable rim colour gain while the post chain is on. */
export const SHOWROOM_RIM_HDR_GAIN = 1.3;
/** Showroom grade: neutral tint, a little extra saturation / contrast for the paint. */
export const SHOWROOM_GRADE: GradeParams = { tint: [1, 1, 1], saturation: 1.04, contrast: 1.03, lift: 0, split: 0.4 };
/** Showroom corner darkening (when the quality profile enables the vignette). */
export const SHOWROOM_VIGNETTE = 0.3;

// ───────────────────────────── adaptive resolution ─────────────────────────────

/** Frame times are averaged over windows of this length (s). */
export const ADAPTIVE_WINDOW_SEC = 2;
/** A window averaging above this (ms) steps the resolution down. */
export const ADAPTIVE_SLOW_MS = 19;
/** Windows averaging below this (ms) for ADAPTIVE_UP_SEC step it back up. */
/**
 * Below this average the frame is "keeping up" and the scale may step back up. Just above one 60 Hz vsync interval:
 * with vsync on, rAF intervals never drop below 16.7 ms, so a lower threshold could never restore the resolution.
 * Flap detection (ADAPTIVE_FLAP_SEC / ADAPTIVE_MAX_UP_SEC) backs off if the step-up drops frames again.
 */
export const ADAPTIVE_FAST_MS = 17.5;
/** Sustained fast time needed before stepping up (s); doubles after each up-step that had to be undone. */
export const ADAPTIVE_UP_SEC = 4;
/** Upper bound of the doubled up-step hold (s). */
export const ADAPTIVE_MAX_UP_SEC = 32;
/** A step down within this time after a step up counts as oscillation (s). */
export const ADAPTIVE_FLAP_SEC = 10;
/** Step size, as a fraction of the user's pixel ratio. */
export const ADAPTIVE_STEP = 0.1;
/** Lowest fraction of the user's pixel ratio. */
export const ADAPTIVE_MIN_SCALE = 0.6;
/** Frames longer than this (s) are hitches (tab switch, loading, shader compile) and are ignored. */
export const ADAPTIVE_MAX_SAMPLE_SEC = 0.25;

// ───────────────────────────── helpers ─────────────────────────────

const LUMA: Rgb = [0.2126, 0.7152, 0.0722];

/** A neutral look (no bloom, identity grade, no vignette) to be filled by the helpers below. */
export function createPostLook(): PostLook {
  return {
    bloom: { strength: 0, radius: 0, threshold: 1 },
    grade: { tint: [1, 1, 1], saturation: 1, contrast: 1, lift: 0, split: 0 },
    vignette: 0,
    speedBlur: 0,
    ao: 0,
    chroma: 0,
    grain: 0,
    sharpen: 0,
    haze: {
      amount: 0,
      density: 0,
      height: HAZE_HEIGHT,
      base: 0,
      color: [0, 0, 0],
      steep: [0, 0, 0],
      sun: [0, 0, 0],
      sunDir: [0, 1, 0],
      blueShift: 0,
      cap: 1,
      cloudShadow: 0,
      cloudCover: 0,
      cloudSoft: 0.3,
      cloudOffset: [0, 0],
    },
  };
}

/** Aerial perspective for the environment (written into `out`); amount 0 when `enabled` is false. */
export function hazeParams(input: HazeInput, enabled: boolean, out: HazeParams = createPostLook().haze): HazeParams {
  const far = Number.isFinite(input.fogFar) && input.fogFar > 1 ? input.fogFar : 1e6;
  out.amount = enabled ? 1 : 0;
  out.density = HAZE_FOG_K / far;
  out.height = HAZE_HEIGHT;
  out.base = Number.isFinite(input.base) ? input.base : 0;
  const disc = clamp01(Number.isFinite(input.sunDisc) ? input.sunDisc : 0);
  for (let i = 0; i < 3; i++) {
    const h = Math.max(0, fin0(input.horizon[i]));
    const z = Math.max(0, fin0(input.zenith[i]));
    out.color[i] = h * HAZE_VEIL_GAIN;
    out.steep[i] = lerp(h, z, HAZE_STEEP_ZENITH) * HAZE_VEIL_GAIN;
    out.sun[i] = Math.max(0, fin0(input.sunColor[i])) * HAZE_SUN_GAIN * disc;
  }
  const len = Math.hypot(fin0(input.sunDir[0]), fin0(input.sunDir[1]), fin0(input.sunDir[2]));
  if (len > 1e-6) for (let i = 0; i < 3; i++) out.sunDir[i] = fin0(input.sunDir[i]) / len;
  else out.sunDir.splice(0, 3, 0, 1, 0);
  out.blueShift = HAZE_BLUE_SHIFT[input.time] ?? HAZE_BLUE_SHIFT.day;
  out.cap = HAZE_CAP[input.time] ?? HAZE_CAP.day;
  const cloud = clamp01(Number.isFinite(input.cloud) ? input.cloud : 0);
  out.cloudShadow = enabled ? (CLOUD_SHADOW[input.time] ?? 0) * (1 - smoothstep(0.35, 0.9, cloud)) * disc : 0;
  out.cloudCover = clamp01((Number.isFinite(input.cloudCover) ? input.cloudCover : 0) + CLOUD_SHADOW_EXTRA_COVER);
  out.cloudSoft = Math.max(0.01, Number.isFinite(input.cloudSoft) ? input.cloudSoft : 0.3);
  out.cloudOffset[0] = fin0(input.cloudOffset[0]);
  out.cloudOffset[1] = fin0(input.cloudOffset[1]);
  return out;
}

/** Veil share (before the cap) of a level path `distance` m long at the haze base height (density from fogFar). */
export function hazeVeilAt(distance: number, fogFar: number): number {
  const d = Math.max(0, Number.isFinite(distance) ? distance : 0);
  const far = Number.isFinite(fogFar) && fogFar > 1 ? fogFar : 1e6;
  return 1 - Math.exp(-(HAZE_FOG_K / far) * d);
}

const fin0 = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Race AO blend for a time of day, the quality's AO scale (0 = off) and smoothed cloud cover 0..1. */
export function aoAmount(time: TimeOfDay, aoScale: number, cloud: number): number {
  if (!Number.isFinite(aoScale) || aoScale <= 0) return 0;
  const c = clamp01(Number.isFinite(cloud) ? cloud : 0);
  return clamp01((AO_BY_TIME[time] ?? AO_BY_TIME.day) * (1 + AO_OVERCAST_BOOST * c));
}

/**
 * Radial speed blur for the followed car's speed (m/s) and the user's strength 0..1 (Settings.speedBlur, 0 = off):
 * 0 below SPEED_BLUR_MIN_SPEED, SPEED_BLUR_MAX * strength at full speed.
 */
export function speedBlurAmount(speed: number, strength: number): number {
  if (!Number.isFinite(speed) || !Number.isFinite(strength)) return 0;
  return SPEED_BLUR_MAX * clamp01(strength) * smoothstep(SPEED_BLUR_MIN_SPEED, SPEED_BLUR_FULL_SPEED, speed);
}

/** Race bloom for a time of day, quality, smoothed cloud cover 0..1 and rain 0..1 (written into `out`). */
export function bloomParams(time: TimeOfDay, quality: QualityLevel, cloud: number, rain: number, out: BloomParams = createPostLook().bloom): BloomParams {
  const base = BLOOM_BY_TIME[time] ?? BLOOM_BY_TIME.day;
  const q = BLOOM_QUALITY[quality] ?? BLOOM_QUALITY.high;
  const c = clamp01(Number.isFinite(cloud) ? cloud : 0);
  const r = clamp01(Number.isFinite(rain) ? rain : 0);
  out.strength = base.strength * q.strength * (1 + BLOOM_RAIN_BOOST * r);
  out.radius = clamp(base.radius * q.radius, 0, 1);
  out.threshold = lerp(base.threshold, Math.min(base.threshold, BLOOM_OVERCAST_THRESHOLD), c);
  return out;
}

/** Race colour grade for a biome, time of day and rain 0..1 (written into `out`). */
export function gradeParams(biome: Biome, time: TimeOfDay, rain: number, out: GradeParams = createPostLook().grade): GradeParams {
  const base = GRADE_BY_TIME[time] ?? GRADE_BY_TIME.day;
  const b = GRADE_BIOME[biome] ?? GRADE_BIOME.temperate;
  const r = clamp01(Number.isFinite(rain) ? rain : 0);
  for (let i = 0; i < 3; i++) out.tint[i] = base.tint[i] * b.tint[i] * lerp(1, GRADE_RAIN.tint[i], r);
  normaliseTint(out.tint);
  out.saturation = Math.max(0, (base.saturation + b.saturation) * lerp(1, GRADE_RAIN.saturation, r));
  out.contrast = Math.max(0.5, base.contrast * lerp(1, GRADE_RAIN.contrast, r));
  out.lift = Math.max(0, base.lift);
  out.split = clamp01(base.split * lerp(1, 0.5, r));
  return out;
}

/** Scale a tint so its luminance is 1 (a grade tint shifts hue, not exposure). */
export function normaliseTint(tint: Rgb): Rgb {
  const l = tint[0] * LUMA[0] + tint[1] * LUMA[1] + tint[2] * LUMA[2];
  if (l > 1e-6) for (let i = 0; i < 3; i++) tint[i] /= l;
  return tint;
}

/** Showroom look: fixed light bloom + neutral grade, vignette when the quality enables it, AO when `ao` (written into `out`). */
export function showroomLook(quality: QualityLevel, vignette: boolean, out: PostLook = createPostLook(), ao = false): PostLook {
  const q = BLOOM_QUALITY[quality] ?? BLOOM_QUALITY.high;
  out.bloom.strength = SHOWROOM_BLOOM.strength * q.strength;
  out.bloom.radius = clamp(SHOWROOM_BLOOM.radius * q.radius, 0, 1);
  out.bloom.threshold = SHOWROOM_BLOOM.threshold;
  for (let i = 0; i < 3; i++) out.grade.tint[i] = SHOWROOM_GRADE.tint[i];
  out.grade.saturation = SHOWROOM_GRADE.saturation;
  out.grade.contrast = SHOWROOM_GRADE.contrast;
  out.grade.lift = SHOWROOM_GRADE.lift;
  out.grade.split = SHOWROOM_GRADE.split;
  out.vignette = vignette ? SHOWROOM_VIGNETTE : 0;
  out.speedBlur = 0;
  out.ao = ao ? SHOWROOM_AO : 0;
  out.chroma = 0;
  out.grain = vignette ? LENS_GRAIN * 0.5 : 0;
  out.sharpen = SHARPEN_BY_QUALITY[quality] ?? 0;
  out.haze.amount = 0;
  return out;
}

/** three.js ACES filmic curve on one grey channel (OutputPass: x × exposure / 0.6, RRT+ODT fit, clamped). */
export function acesFilmic(x: number, exposure: number): number {
  const v = Math.max(0, x) * exposure / 0.6;
  return clamp01((v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081));
}

/**
 * Inverse of `acesFilmic` (per channel): the linear value that tone-maps to `y`. Used to keep non-tone-mapped
 * backdrops looking the same when the post chain tone-maps everything.
 */
export function acesFilmicInverse(y: number, exposure: number): number {
  const t = clamp(Number.isFinite(y) ? y : 0, 0, 0.98);
  // v²(1 − 0.983729 t) + v(0.0245786 − 0.432951 t) − (0.000090537 + 0.238081 t) = 0
  const a = 1 - 0.983729 * t;
  const b = 0.0245786 - 0.432951 * t;
  const c = -(0.000090537 + 0.238081 * t);
  const v = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return Math.max(0, v) * 0.6 / Math.max(1e-6, exposure);
}

/**
 * Adaptive resolution controller (hysteresis). Feed real frame durations; every ADAPTIVE_WINDOW_SEC the window
 * average is judged: above ADAPTIVE_SLOW_MS steps `scale` down by ADAPTIVE_STEP (floor ADAPTIVE_MIN_SCALE); below
 * ADAPTIVE_FAST_MS for ADAPTIVE_UP_SEC steps it up (never above 1). The window right after a change is discarded
 * (reallocation hitch), hitches longer than ADAPTIVE_MAX_SAMPLE_SEC are ignored, and an up-step that has to be
 * undone within ADAPTIVE_FLAP_SEC doubles the hold before the next up-step, so it cannot oscillate.
 */
export class AdaptiveResolution {
  /** fraction (ADAPTIVE_MIN_SCALE..1) of the user's chosen pixel ratio */
  scale = 1;
  /** average frame time (ms) of the last completed window; NaN before the first */
  lastAverageMs = Number.NaN;
  private windowSec = 0;
  private windowFrames = 0;
  private fastSec = 0;
  private upHoldSec = ADAPTIVE_UP_SEC;
  private sinceUpSec = Number.POSITIVE_INFINITY;
  private settle = false;

  /** Feed one frame duration (s). Returns true when `scale` changed. */
  sample(frameSec: number): boolean {
    if (!Number.isFinite(frameSec) || frameSec <= 0 || frameSec > ADAPTIVE_MAX_SAMPLE_SEC) return false;
    this.sinceUpSec += frameSec;
    this.windowSec += frameSec;
    this.windowFrames++;
    // tolerance: summing e.g. 80 × 0.025 s lands a hair below 2 s
    if (this.windowSec < ADAPTIVE_WINDOW_SEC - 1e-6) return false;
    const span = this.windowSec;
    const avgMs = (span / this.windowFrames) * 1000;
    this.windowSec = 0;
    this.windowFrames = 0;
    this.lastAverageMs = avgMs;
    if (this.settle) {
      this.settle = false;
      return false;
    }
    if (avgMs > ADAPTIVE_SLOW_MS) {
      this.fastSec = 0;
      if (this.scale <= ADAPTIVE_MIN_SCALE + 1e-6) return false;
      if (this.sinceUpSec < ADAPTIVE_FLAP_SEC) this.upHoldSec = Math.min(ADAPTIVE_MAX_UP_SEC, this.upHoldSec * 2);
      return this.setScale(this.scale - ADAPTIVE_STEP);
    }
    if (avgMs < ADAPTIVE_FAST_MS && this.scale < 1) {
      this.fastSec += span;
      if (this.fastSec + 1e-6 < this.upHoldSec) return false;
      this.fastSec = 0;
      this.sinceUpSec = 0;
      return this.setScale(this.scale + ADAPTIVE_STEP);
    }
    this.fastSec = 0;
    return false;
  }

  /** Back to full resolution with fresh timers (new session, menus). */
  reset(): void {
    this.scale = 1;
    this.lastAverageMs = Number.NaN;
    this.windowSec = 0;
    this.windowFrames = 0;
    this.fastSec = 0;
    this.upHoldSec = ADAPTIVE_UP_SEC;
    this.sinceUpSec = Number.POSITIVE_INFINITY;
    this.settle = false;
  }

  private setScale(v: number): boolean {
    const next = clamp(Math.round(v * 100) / 100, ADAPTIVE_MIN_SCALE, 1);
    if (next === this.scale) return false;
    this.scale = next;
    this.settle = true;
    return true;
  }
}
