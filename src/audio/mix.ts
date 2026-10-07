/**
 * Pure audio-mix math (no WebAudio): voice selection, distance attenuation, air absorption, stereo pan,
 * doppler and engine-tone mapping. Kept separate so it can be unit-tested headless.
 */
import { clamp, clamp01, forwardX, forwardZ, rightX, rightZ, smoothstep } from '../core/math';
import type { CameraMode, CarRenderState, SurfaceKind } from '../core/types';

/** Distance (m) up to which a source plays at full level. */
export const REF_DISTANCE = 8;
/** Beyond this distance (m) nothing is audible. */
export const MAX_AUDIBLE_DISTANCE = 450;
export const SPEED_OF_SOUND = 343;
/** < 1 tames the doppler shift for playability. */
export const DOPPLER_SCALE = 0.7;
/** Engine voices besides the listener car. */
export const MAX_OTHER_VOICES = 4;
/** Already-voiced cars count as this much closer, so near-equal cars do not flap between voices. */
export const VOICE_STICKINESS = 0.8;

export const ONBOARD_CAMERAS: ReadonlySet<CameraMode> = new Set<CameraMode>(['cockpit', 'nose', 'tcam']);

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

export function distance3(a: Vec3, b: Vec3): number {
  const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return Number.isFinite(d) ? d : Number.POSITIVE_INFINITY;
}

/** Inverse-distance rolloff with a smooth fade to silence at MAX_AUDIBLE_DISTANCE. */
export function distanceGain(d: number): number {
  if (!Number.isFinite(d) || d >= MAX_AUDIBLE_DISTANCE) return 0;
  const dist = Math.max(0, d);
  const rolloff = REF_DISTANCE / (REF_DISTANCE + Math.max(0, dist - REF_DISTANCE));
  return rolloff * (1 - smoothstep(MAX_AUDIBLE_DISTANCE * 0.7, MAX_AUDIBLE_DISTANCE, dist));
}

/** Lowpass ceiling (Hz) for air absorption: far cars lose their top end. */
export function distanceCutoff(d: number): number {
  const dist = Number.isFinite(d) ? Math.max(0, d) : MAX_AUDIBLE_DISTANCE;
  return clamp(16000 / (1 + dist / 40), 1200, 16000);
}

/** Stereo pan (-1 left .. +1 right) of a source at offset (dx, dz) for a listener facing `listenerYaw`. */
export function panFor(listenerYaw: number, dx: number, dz: number): number {
  const len = Math.hypot(dx, dz);
  if (!(len > 0.5) || !Number.isFinite(len) || !Number.isFinite(listenerYaw)) return 0;
  const side = (dx * rightX(listenerYaw) + dz * rightZ(listenerYaw)) / len;
  return clamp(side * 0.85, -0.85, 0.85);
}

/**
 * Doppler pitch factor for a source with velocity (svx, svz) at offset (dx, dz) = listener - source,
 * heard by a listener moving with (lvx, lvz).
 */
export function dopplerFactor(dx: number, dz: number, svx: number, svz: number, lvx: number, lvz: number): number {
  const len = Math.hypot(dx, dz);
  if (!(len > 0.5) || !Number.isFinite(len)) return 1;
  const ux = dx / len;
  const uz = dz / len;
  const vs = finiteOr(svx * ux + svz * uz, 0) * DOPPLER_SCALE;
  const vl = -finiteOr(lvx * ux + lvz * uz, 0) * DOPPLER_SCALE;
  const f = (SPEED_OF_SOUND + clamp(vl, -150, 150)) / (SPEED_OF_SOUND - clamp(vs, -150, 150));
  return clamp(f, 0.75, 1.3);
}

/** World velocity of a rendered car (speed along its heading). */
export function carVelocity(car: CarRenderState): { x: number; z: number } {
  const v = finiteOr(car.speed, 0);
  return { x: forwardX(car.yaw) * v, z: forwardZ(car.yaw) * v };
}

/**
 * Cars that should own an engine voice: the listener car first (if present), then the nearest audible other cars.
 * Ghost and invisible cars never get a voice. `current` = cars voiced last frame (hysteresis).
 */
export function selectVoicedCars(
  cars: readonly CarRenderState[],
  listenerCarId: number,
  cameraPos: Vec3,
  current: ReadonlySet<number>,
  maxOthers = MAX_OTHER_VOICES,
  /** cars voiced like the listener regardless of distance (split-screen: the other player's car) */
  always: readonly number[] = [],
): number[] {
  const out: number[] = [];
  const others: { carId: number; score: number }[] = [];
  for (const car of cars) {
    if (car.ghost || !car.visible || car.carId < 0) continue;
    if (car.carId === listenerCarId || always.includes(car.carId)) {
      out.push(car.carId);
      continue;
    }
    const d = distance3(car, cameraPos);
    if (d >= MAX_AUDIBLE_DISTANCE) continue;
    others.push({ carId: car.carId, score: current.has(car.carId) ? d * VOICE_STICKINESS : d });
  }
  others.sort((a, b) => a.score - b.score || a.carId - b.carId);
  const n = Math.max(0, Math.min(maxOthers, others.length));
  for (let i = 0; i < n; i++) out.push(others[i].carId);
  return out;
}

/** Normalised engine speed 0..1 between idle and the highest rpm seen so far. */
export function rpmNorm(rpm: number, idleRpm: number, maxRpm: number): number {
  if (!Number.isFinite(rpm) || !(maxRpm > idleRpm)) return 0;
  return clamp01((rpm - idleRpm) / (maxRpm - idleRpm));
}

/** V6 four-stroke: 3 firing pulses per crank revolution. */
export function firingFrequency(rpm: number): number {
  return Number.isFinite(rpm) ? Math.max(0, rpm) / 20 : 0;
}

/** Tyre squeal intensity 0..1 from slip / lockup, speed and track wetness. */
export function squealIntensity(slip: number, lockup: number, speed: number, wetness: number, surface: CarRenderState['surface']): number {
  if (surface === 'grass' || surface === 'gravel') return 0;
  const s = Math.max(finiteOr(slip, 0), finiteOr(lockup, 0));
  const speedFactor = clamp01(finiteOr(speed, 0) / 15);
  const dry = 1 - 0.8 * clamp01(finiteOr(wetness, 0));
  return smoothstep(0.2, 0.9, s) * speedFactor * dry;
}

/** Collision impulse (N·s) → thump strength 0..1 (log scale; light touches are quiet). */
export function impactStrength(impulse: number): number {
  if (!Number.isFinite(impulse) || impulse <= 0) return 0;
  return clamp01(Math.log10(1 + impulse / 300) / 1.4);
}

/** What one human car contributes to the shared ambience beds (wind, spray, kerb / gravel / grass). */
export interface AmbienceSource {
  /** car speed (m/s) */
  speed: number;
  surface: SurfaceKind;
  /** on-board camera */
  interior: boolean;
  /** static trackside camera (no wind) */
  trackside: boolean;
  /** exterior-distance attenuation 0..1 */
  gain: number;
}

/** Target levels of the ambience beds (linear gains) plus the frequencies they follow. */
export interface AmbienceLayers {
  wind: number;
  /** speed (m/s) that drives the wind filter */
  windSpeed: number;
  /** rain bed + tyre spray */
  rain: number;
  rumble: number;
  rumbleHz: number;
  offroad: number;
  offroadHz: number;
}

/** Ambience bed levels for one listener car (rain / wetness are environmental). */
export function ambienceLayers(p: AmbienceSource, rainIn: number, wetnessIn: number): AmbienceLayers {
  const speed = Number.isFinite(p.speed) ? Math.max(0, p.speed) : 0;
  const att = Number.isFinite(p.gain) ? clamp01(p.gain) : 0;
  const rain = Number.isFinite(rainIn) ? clamp01(rainIn) : 0;
  const wet = Number.isFinite(wetnessIn) ? clamp01(wetnessIn) : 0;
  const speedN = clamp01(speed / 90);
  const wind = p.trackside ? 0 : Math.min(0.4, 0.26 * speedN * speedN) * (p.interior ? 1.25 : 1);
  const spray = 0.12 * wet * clamp01(speed / 60) * att;
  const moving = smoothstep(1, 20, speed);
  let rumbleHz = 30;
  let rumble = 0;
  let offroad = 0;
  let offroadHz = 400;
  switch (p.surface) {
    case 'kerb':
      rumbleHz = speed / 0.9;
      rumble = 0.5 * moving;
      break;
    case 'gravel':
      rumbleHz = speed / 2.2;
      rumble = 0.22 * moving;
      offroad = 0.42 * moving;
      offroadHz = 1700;
      break;
    case 'grass':
      rumbleHz = speed / 3;
      rumble = 0.12 * moving;
      offroad = 0.3 * moving;
      offroadHz = 380;
      break;
    default:
      break;
  }
  const onboard = p.interior ? 1.2 : 1;
  return {
    wind,
    windSpeed: speed,
    rain: rain * (p.interior ? 0.24 : 0.18) + spray,
    rumble: rumble * att * onboard,
    rumbleHz,
    offroad: offroad * att * onboard,
    offroadHz,
  };
}

/**
 * Two human listeners share one stereo mix: every bed plays at the louder of the two cars' levels (never a sum, so
 * the mix cannot clip), and its frequency follows the car that drives it. Each player therefore hears their own
 * wind / surface / rain whenever it is the dominant one.
 */
export function mergeAmbienceLayers(a: AmbienceLayers, b: AmbienceLayers): AmbienceLayers {
  return {
    wind: Math.max(a.wind, b.wind),
    windSpeed: b.wind > a.wind ? b.windSpeed : a.windSpeed,
    rain: Math.max(a.rain, b.rain),
    rumble: Math.max(a.rumble, b.rumble),
    rumbleHz: b.rumble > a.rumble ? b.rumbleHz : a.rumbleHz,
    offroad: Math.max(a.offroad, b.offroad),
    offroadHz: b.offroad > a.offroad ? b.offroadHz : a.offroadHz,
  };
}
