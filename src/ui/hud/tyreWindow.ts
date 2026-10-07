/**
 * Optimal tyre-temperature window per compound for the HUD temperature colour. Probed once from
 * physics.tyreGrip (so the colours follow the real grip model); static fallback if the probe fails.
 */
import type { TireCompound } from '../../core/types';
import { tyreGrip } from '../../physics/index';

export interface TempWindow {
  lo: number;
  hi: number;
}

const FALLBACK: Record<TireCompound, TempWindow> = {
  soft: { lo: 85, hi: 108 },
  medium: { lo: 88, hi: 112 },
  hard: { lo: 92, hi: 118 },
  inter: { lo: 55, hi: 85 },
  wet: { lo: 45, hi: 75 },
};

const PROBE_MIN = 20;
const PROBE_MAX = 150;
const PROBE_STEP = 2;
/** Grip within this fraction of the peak counts as "in the window". */
const WINDOW_FRACTION = 0.97;

const cache: Partial<Record<TireCompound, TempWindow>> = {};

export function tyreWindow(compound: TireCompound): TempWindow {
  const hit = cache[compound];
  if (hit) return hit;
  const win = probe(compound) ?? FALLBACK[compound] ?? FALLBACK.medium;
  cache[compound] = win;
  return win;
}

function probe(compound: TireCompound): TempWindow | null {
  const wetness = compound === 'wet' ? 1 : compound === 'inter' ? 0.5 : 0;
  const temps: number[] = [];
  const grips: number[] = [];
  try {
    for (let t = PROBE_MIN; t <= PROBE_MAX; t += PROBE_STEP) {
      const g = tyreGrip(compound, 0, t, wetness);
      if (!Number.isFinite(g)) return null;
      temps.push(t);
      grips.push(g);
    }
  } catch {
    return null;
  }
  let peak = -Infinity;
  for (const g of grips) peak = Math.max(peak, g);
  if (!(peak > 0)) return null;
  const threshold = peak * WINDOW_FRACTION;
  let lo = NaN;
  let hi = NaN;
  for (let i = 0; i < grips.length; i++) {
    if (grips[i] < threshold) continue;
    if (Number.isNaN(lo)) lo = temps[i];
    hi = temps[i];
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return {
    lo: lo <= PROBE_MIN ? -Infinity : lo,
    hi: hi >= PROBE_MAX ? Infinity : hi,
  };
}
