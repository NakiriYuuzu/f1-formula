/**
 * Tyre model: compound parameters, grip vs. wetness / temperature / wear, temperature and wear integration.
 * Pure functions — no state besides the TireState passed in.
 */
import type { SurfaceKind, TireCompound, TireState } from '../core/types';
import { clamp, clamp01, damp } from '../core/math';

export interface CompoundParams {
  /** dry grip relative to a fresh soft */
  dryGrip: number;
  /** wear per unit of wear work (relative) */
  wearRate: number;
  /** heating multiplier */
  heat: number;
  /** optimal surface temperature window (°C) */
  windowLo: number;
  windowHi: number;
  /** blanket temperature when fitted (°C) */
  blanketTemp: number;
  /** grip-vs-wetness curve: [wetness, grip multiplier] points (wetness ascending, 0 and 1 included) */
  wetCurve: readonly (readonly [number, number])[];
  /** extra wear factor on a dry track (rain tyres overheat and shred) */
  dryWearPenalty: number;
}

const SLICK_WET: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0.55],
];

export const COMPOUND_PARAMS: Record<TireCompound, CompoundParams> = {
  soft: { dryGrip: 1.0, wearRate: 1.0, heat: 1.1, windowLo: 80, windowHi: 105, blanketTemp: 75, wetCurve: SLICK_WET, dryWearPenalty: 0 },
  medium: { dryGrip: 0.975, wearRate: 0.64, heat: 1.0, windowLo: 85, windowHi: 110, blanketTemp: 75, wetCurve: SLICK_WET, dryWearPenalty: 0 },
  hard: { dryGrip: 0.95, wearRate: 0.44, heat: 0.92, windowLo: 88, windowHi: 115, blanketTemp: 75, wetCurve: SLICK_WET, dryWearPenalty: 0 },
  inter: {
    dryGrip: 1,
    wearRate: 0.6,
    heat: 0.95,
    windowLo: 45,
    windowHi: 80,
    blanketTemp: 55,
    wetCurve: [
      [0, 0.8],
      [0.3, 0.88],
      [0.45, 0.885],
      [0.6, 0.85],
      [1, 0.68],
    ],
    dryWearPenalty: 2.5,
  },
  wet: {
    dryGrip: 1,
    wearRate: 0.55,
    heat: 0.85,
    windowLo: 35,
    windowHi: 70,
    blanketTemp: 45,
    wetCurve: [
      [0, 0.7],
      [0.3, 0.79],
      [0.6, 0.85],
      [1, 0.84],
    ],
    dryWearPenalty: 3.5,
  },
};

/** Surface grip multipliers (kerb uses the setup-dependent spec.kerbGrip instead). */
export const SURFACE_GRIP: Record<SurfaceKind, number> = {
  asphalt: 1,
  kerb: 0.92,
  grass: 0.55,
  gravel: 0.45,
  runoff: 0.95,
  pitlane: 1,
};

/** Extra rolling drag on loose surfaces: deceleration (m/s²) at speed. */
export const SURFACE_DRAG_DECEL: Record<SurfaceKind, number> = {
  asphalt: 0,
  kerb: 0,
  grass: 2.5,
  gravel: 8,
  runoff: 0,
  pitlane: 0,
};

function sampleCurve(curve: readonly (readonly [number, number])[], x: number): number {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) return 1;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (!a || !b) continue;
    if (x <= b[0]) {
      const span = b[0] - a[0];
      const t = span > 1e-9 ? (x - a[0]) / span : 0;
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return last[1];
}

/** Grip multiplier from the compound and track wetness (fresh tyre, optimal temperature). */
export function wetGrip(compound: TireCompound, wetness: number): number {
  const p = COMPOUND_PARAMS[compound];
  return p.dryGrip * sampleCurve(p.wetCurve, clamp01(wetness));
}

/** Temperature factor: 1 inside the window, bell-shaped fall-off outside (cold max -25 %, hot max -30 %). */
export function temperatureGrip(compound: TireCompound, temp: number): number {
  const p = COMPOUND_PARAMS[compound];
  const t = Number.isFinite(temp) ? temp : p.windowLo;
  if (t < p.windowLo) {
    const d = (p.windowLo - t) / 40;
    return 1 - 0.25 * Math.min(1, d * d);
  }
  if (t > p.windowHi) {
    const d = (t - p.windowHi) / 30;
    return 1 - 0.3 * Math.min(1, d * d);
  }
  return 1;
}

/** Wear factor: gentle linear loss to 70 % wear (-6 %), then a cliff to -30 % at 100 %. */
export function wearGrip(wear: number): number {
  const w = clamp01(Number.isFinite(wear) ? wear : 0);
  if (w <= 0.7) return 1 - 0.06 * (w / 0.7);
  const t = (w - 0.7) / 0.3;
  return 0.94 - 0.24 * Math.pow(t, 1.5);
}

/**
 * Tyre grip multiplier (≈1.0 for fresh softs in the dry at optimal temperature) for compound, wear, temperature
 * and track wetness. Used by physics, AI pace and HUD.
 */
export function tyreGrip(compound: TireCompound, wear: number, temp: number, wetness: number): number {
  const g = wetGrip(compound, wetness) * temperatureGrip(compound, temp) * wearGrip(wear);
  return Number.isFinite(g) ? clamp(g, 0.2, 1.2) : 1;
}

/** Per-step tyre load summary produced by the chassis integration. */
export interface TyreWork {
  /** frictional slip power (W) dissipated by both axles */
  slipPower: number;
  /** 0..~3 dimensionless sliding intensity (slip angles, wheelspin, lockup) */
  slipIntensity: number;
  /** |forward speed| (m/s) */
  speed: number;
}

/** Wear per metre travelled and per joule of slip work (calibrated: soft ≈ 17 laps, medium ≈ 27, hard ≈ 40 on ~5 km). */
export const WEAR_PER_METER = 5.2e-6;
export const WEAR_PER_JOULE = 1.1e-8;

/**
 * Advance tyre temperature and wear by dt. `heatScale`/`wearScale` come from the setup (tyre pressure),
 * `wearMultiplier` from session rules (0 disables wear).
 */
export function updateTyre(
  tire: TireState,
  work: TyreWork,
  trackTemp: number,
  wetness: number,
  heatScale: number,
  wearScale: number,
  wearMultiplier: number,
  dt: number,
): void {
  const p = COMPOUND_PARAMS[tire.compound];
  const w = clamp01(wetness);
  const tt = Number.isFinite(trackTemp) ? clamp(trackTemp, -10, 70) : 30;
  const heatIn = (0.6 * work.speed + 42 * Math.min(work.slipIntensity, 3)) * p.heat * heatScale;
  const target = clamp(tt + heatIn - 32 * w, -10, 160);
  const rate = target > tire.temp ? 1 / 16 : 1 / 28;
  const cur = Number.isFinite(tire.temp) ? tire.temp : p.blanketTemp;
  tire.temp = clamp(damp(cur, target, rate, dt), -10, 160);

  const wm = Number.isFinite(wearMultiplier) ? Math.max(0, wearMultiplier) : 1;
  if (wm <= 0) return;
  const overheat = tire.temp > p.windowHi ? 1 + (tire.temp - p.windowHi) / 25 : 1;
  const dryPenalty = 1 + p.dryWearPenalty * (1 - w) * (1 - w);
  const waterCooling = 1 - 0.35 * w;
  const slipPower = Number.isFinite(work.slipPower) ? Math.max(0, work.slipPower) : 0;
  const dWear =
    p.wearRate *
    wearScale *
    wm *
    overheat *
    dryPenalty *
    waterCooling *
    (WEAR_PER_METER * work.speed * dt + WEAR_PER_JOULE * slipPower * dt);
  const cw = Number.isFinite(tire.wear) ? tire.wear : 0;
  tire.wear = clamp01(cw + (Number.isFinite(dWear) ? dWear : 0));
}
