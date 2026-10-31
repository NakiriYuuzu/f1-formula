/**
 * Per-time-of-day display grade baked into a 3D LUT (pure, no three.js): one subtle look per time of day applied
 * after tone mapping (post chain output pass), replacing the stacked lens effects (chromatic aberration, film grain,
 * vignette) of race views. The look is a gentle S-curve (ends fixed), a saturation touch and a split tone (cool
 * shadows, warm highlights) weighted by 4·l·(1 − l), so black and white never move. Rain fades the look towards
 * neutral (lutAmount).
 */
import type { TimeOfDay } from '../../core/types';
import type { Rgb } from './post';

export interface LutLook {
  /** S-curve share 0..1 (mix of each channel towards smoothstep(0, 1, x)) */
  curve: number;
  /** saturation around the luminance */
  saturation: number;
  /** display-space offsets of the shadows and of the highlights (blended by luminance) */
  shadow: Rgb;
  highlight: Rgb;
}

/** Day crisp and neutral-warm, dusk amber over teal, night cool shadows with clean lamp-lit highlights. */
export const LUT_BY_TIME: Record<TimeOfDay, LutLook> = {
  day: { curve: 0.1, saturation: 1.04, shadow: [-0.01, 0.004, 0.012], highlight: [0.012, 0.005, -0.012] },
  dusk: { curve: 0.12, saturation: 1.07, shadow: [-0.014, 0.002, 0.02], highlight: [0.028, 0.011, -0.022] },
  night: { curve: 0.08, saturation: 1.02, shadow: [-0.012, 0.006, 0.026], highlight: [0.01, 0.005, -0.006] },
};
/** LUT edge length (32³ RGBA8 = 128 KiB). */
export const LUT_SIZE = 32;
/** Look strength at full rain (flat grey light: less grade). */
export const LUT_RAIN_AMOUNT = 0.6;

const LUMA: Rgb = [0.2126, 0.7152, 0.0722];
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const luma = (c: Rgb): number => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

/** The graded display colour (sRGB 0..1 in and out) of `c` under `look` (written into `out`). */
export function gradeDisplay(c: Rgb, look: LutLook, out: Rgb = [0, 0, 0]): Rgb {
  const l = luma(c);
  for (let i = 0; i < 3; i++) {
    const s = l + (c[i] - l) * look.saturation;
    const x = Math.min(1, Math.max(0, s));
    out[i] = x + (smooth(0, 1, x) - x) * look.curve;
  }
  const l2 = luma(out);
  const w = 4 * l2 * (1 - l2);
  const t = smooth(0.15, 0.7, l2);
  for (let i = 0; i < 3; i++) {
    const v = out[i] + w * (look.shadow[i] + (look.highlight[i] - look.shadow[i]) * t);
    out[i] = Math.min(1, Math.max(0, v));
  }
  return out;
}

/** RGBA8 data of a size³ LUT (red fastest, then green, then blue; alpha 255). */
export function buildLutData(look: LutLook, size = LUT_SIZE): Uint8Array {
  const n = Math.max(2, Math.floor(size));
  const data = new Uint8Array(n * n * n * 4);
  const inC: Rgb = [0, 0, 0];
  const outC: Rgb = [0, 0, 0];
  let o = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        inC[0] = r / (n - 1);
        inC[1] = g / (n - 1);
        inC[2] = b / (n - 1);
        gradeDisplay(inC, look, outC);
        data[o++] = Math.round(outC[0] * 255);
        data[o++] = Math.round(outC[1] * 255);
        data[o++] = Math.round(outC[2] * 255);
        data[o++] = 255;
      }
    }
  }
  return data;
}

/** Look strength for rain 0..1. */
export function lutAmount(rain: number): number {
  const r = Number.isFinite(rain) ? Math.min(1, Math.max(0, rain)) : 0;
  return 1 + (LUT_RAIN_AMOUNT - 1) * r;
}
