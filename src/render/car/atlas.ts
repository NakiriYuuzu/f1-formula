/**
 * Car livery atlas: one texture per car holding (a) a cylindrical body wrap, (b) solid colour swatches,
 * (c) a side-projected shark-fin panel and (d) a helmet wrap. All car parts share the same UV layout, so a
 * whole car body (incl. carbon parts and driver) renders with ONE material. A shared surface map with the same
 * layout (R = clear coat, G = roughness, B = metalness; values from CAR_SURFACE) gives paint, carbon, metal and
 * visor their own surface response.
 *
 * Atlas (three.js UV, v up):
 *   body   u 0..1,   v 0.25..1
 *   swatch u 0..0.5625, v 0.1875..0.25 (9 base swatches)    fin panel u 0.5625..1, v 0.125..0.25
 *          u 0..0.25,   v 0.125..0.1875 (4 part swatches: halo, wings, rear flap)
 *   helmet u 0..1,   v 0..0.125
 */
import * as THREE from 'three';
import type { Livery, LiveryParts, LiveryPattern } from '../../core/types';
import { canvasTexture, createCanvas, fitFont, luminance, mixHex, safeHex, UI_FONT, type Canvas2D } from '../core/canvas';
import { CAR_SURFACE } from './carQuality';
import type { CarDims } from './dims';

export const SWATCHES = [
  'primary',
  'secondary',
  'accent',
  'carbon',
  'metal',
  'visor',
  'black',
  'white',
  'satin',
  // second row: parts a livery may colour individually (LiveryParts)
  'halo',
  'frontWing',
  'rearWing',
  'rearFlap',
] as const;
export type Swatch = (typeof SWATCHES)[number];

export const BODY_V0 = 0.25;
export const SWATCH_V0 = 0.125;
export const SWATCH_V1 = 0.25;
/** boundary between the base swatch row (above) and the part swatch row (below) */
export const SWATCH_VMID = (SWATCH_V0 + SWATCH_V1) / 2;
export const HELMET_V1 = 0.125;
/** swatches per row; the fin panel starts right after the 9th column */
const SWATCH_ROW = 9;
export const FIN_U0 = SWATCH_ROW / 16;

/** Atlas cell of a swatch: column and row (0 = base row, 1 = part row). */
function swatchCell(name: Swatch): { col: number; row: number } {
  const i = Math.max(0, SWATCHES.indexOf(name));
  return { col: i % SWATCH_ROW, row: Math.floor(i / SWATCH_ROW) };
}

/** UV at the centre of a swatch. */
export function swatchUV(name: Swatch): [number, number] {
  const { col, row } = swatchCell(name);
  return [(col + 0.5) / 16, row === 0 ? (SWATCH_VMID + SWATCH_V1) / 2 : (SWATCH_V0 + SWATCH_VMID) / 2];
}

/** Canvas rect (x, y, w, h) of a swatch cell; +1 px overlap hides seams. */
function swatchRect(name: Swatch, W: number, H: number): [number, number, number, number] {
  const { col, row } = swatchCell(name);
  const top = row === 0 ? SWATCH_V1 : SWATCH_VMID;
  return [(col / 16) * W, H * (1 - top), W / 16 + 1, H * (SWATCH_V1 - SWATCH_VMID) + 1];
}

/**
 * Body wrap: U along the car (0 = rear), V around the long axis (0.5 top, 0.75 left side, 0.25 right side).
 * `centreY` is the wrap axis height at this z; it must lie inside the body section there so the V = 0 / 1 seam
 * stays on the underside (a fixed axis above the low nose / tail put the seam on their top centreline).
 */
export function wrapUV(d: CarDims, x: number, y: number, z: number, centreY: number): [number, number] {
  const U = clamp01((z - d.wrapZMin) / (d.wrapZMax - d.wrapZMin));
  const V = 0.5 + Math.atan2(x, y - centreY) / (Math.PI * 2);
  return [U, BODY_V0 + clamp01(V) * (1 - BODY_V0)];
}

/** Side-projected fin panel; `rightFace` mirrors u so text reads correctly from both sides. */
export function finUV(d: CarDims, y: number, z: number, rightFace: boolean): [number, number] {
  const t = clamp01((z - d.finZ0) / (d.finZ1 - d.finZ0));
  const pu = rightFace ? t : 1 - t;
  const pv = clamp01((y - d.finY0) / (d.finY1 - d.finY0));
  return [FIN_U0 + pu * (1 - FIN_U0), SWATCH_V0 + pv * (SWATCH_V1 - SWATCH_V0)];
}

/** Helmet sphere wrap around its centre (front of the visor at u = 0.5). */
export function helmetUV(lx: number, ly: number, lz: number): [number, number] {
  const len = Math.hypot(lx, ly, lz) || 1;
  const u = 0.5 + Math.atan2(lx, lz) / (Math.PI * 2);
  const v = 0.5 + Math.asin(Math.max(-1, Math.min(1, ly / len))) / Math.PI;
  return [clamp01(u), clamp01(v) * HELMET_V1];
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

export interface LiveryPaint {
  livery: Livery;
  helmet: Livery;
  number: number;
  teamShort: string;
}

const CARBON = '#1d1e21';
/** Satin carbon (floor, diffuser, unpainted wing parts): a touch lighter and rougher than the weave above. */
const SATIN = '#3b3e45';

/** A part colour when it is a valid '#rrggbb', else null (the part keeps its default). */
function partColor(parts: LiveryParts | undefined, key: keyof LiveryParts): string | null {
  const c = parts?.[key];
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null;
}

/** Colour of every atlas swatch for a livery (unset parts: halo / wings primary, rear flap secondary). */
export function swatchColors(l: Livery): Record<Swatch, string> {
  const primary = safeHex(l.primary, '#c0c0c0');
  const secondary = safeHex(l.secondary, '#202020');
  return {
    primary,
    secondary,
    accent: safeHex(l.accent, '#ffffff'),
    carbon: CARBON,
    metal: '#9a9ea6',
    visor: '#121418',
    black: '#0b0b0c',
    white: '#f2f2f2',
    satin: SATIN,
    halo: partColor(l.parts, 'halo') ?? primary,
    frontWing: partColor(l.parts, 'frontWing') ?? primary,
    rearWing: partColor(l.parts, 'rearWing') ?? primary,
    rearFlap: partColor(l.parts, 'rearFlap') ?? secondary,
  };
}

/** Paint a car's livery atlas. */
export function paintLiveryCanvas(size: number, d: CarDims, p: LiveryPaint): Canvas2D {
  const c = createCanvas(size, size);
  const { ctx } = c;
  const W = c.w;
  const H = c.h;
  const primary = safeHex(p.livery.primary, '#c0c0c0');
  const secondary = safeHex(p.livery.secondary, '#202020');
  const accent = safeHex(p.livery.accent, '#ffffff');
  const pattern: LiveryPattern = p.livery.pattern ?? 'classic';
  const num = String(Math.max(0, Math.min(99, Math.round(Number.isFinite(p.number) ? p.number : 0))));
  const code = (p.teamShort || '').toUpperCase().slice(0, 3);

  // ── body region: canvas y 0 .. 0.75H ──
  const bh = H * (1 - BODY_V0);
  const bx = (U: number): number => U * W;
  const by = (V: number): number => (1 - V) * bh;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, bh);
  ctx.clip();
  ctx.fillStyle = primary;
  ctx.fillRect(0, 0, W, bh);
  const uOf = (z: number): number => (z - d.wrapZMin) / (d.wrapZMax - d.wrapZMin);
  switch (pattern) {
    case 'stripe': {
      ctx.fillStyle = secondary;
      ctx.fillRect(0, by(0.548), W, by(0.452) - by(0.548));
      ctx.fillStyle = accent;
      ctx.fillRect(0, by(0.556), W, by(0.548) - by(0.556));
      ctx.fillRect(0, by(0.452), W, by(0.444) - by(0.452));
      ctx.fillStyle = secondary;
      ctx.fillRect(0, by(0.94), W, by(0.8) - by(0.94));
      ctx.fillRect(0, by(0.2), W, by(0.06) - by(0.2));
      break;
    }
    case 'chevron': {
      ctx.fillStyle = secondary;
      for (let k = 1; k <= 9; k++) {
        const e = 0.36;
        ctx.beginPath();
        ctx.moveTo(bx((k - 1.5) / 7), by(0.2));
        ctx.lineTo(bx(k / 7), by(0.5));
        ctx.lineTo(bx((k - 1.5) / 7), by(0.8));
        ctx.lineTo(bx((k - 1.5 + e) / 7), by(0.8));
        ctx.lineTo(bx((k + e) / 7), by(0.5));
        ctx.lineTo(bx((k - 1.5 + e) / 7), by(0.2));
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = accent;
      ctx.fillRect(0, by(0.86), W, by(0.83) - by(0.86));
      ctx.fillRect(0, by(0.17), W, by(0.14) - by(0.17));
      break;
    }
    case 'split': {
      const mid = uOf(-0.1);
      ctx.fillStyle = secondary;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(bx(mid + 0.06), 0);
      ctx.lineTo(bx(mid - 0.06), bh);
      ctx.lineTo(0, bh);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(2, W * 0.012);
      ctx.beginPath();
      ctx.moveTo(bx(mid + 0.06), 0);
      ctx.lineTo(bx(mid - 0.06), bh);
      ctx.stroke();
      break;
    }
    case 'fade': {
      const g = ctx.createLinearGradient(bx(0.15), 0, bx(0.85), 0);
      g.addColorStop(0, secondary);
      g.addColorStop(0.45, mixHex(secondary, primary, 0.5));
      g.addColorStop(1, primary);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, bh);
      ctx.fillStyle = accent;
      ctx.fillRect(bx(0.2), by(0.8), bx(0.98) - bx(0.2), by(0.775) - by(0.8));
      ctx.fillRect(bx(0.2), by(0.225), bx(0.98) - bx(0.2), by(0.2) - by(0.225));
      break;
    }
    default: {
      // classic: side bands in secondary with accent pinstripes, accent nose tip
      ctx.fillStyle = secondary;
      ctx.fillRect(bx(0.1), by(0.86), bx(0.97) - bx(0.1), by(0.64) - by(0.86));
      ctx.fillRect(bx(0.1), by(0.36), bx(0.97) - bx(0.1), by(0.14) - by(0.36));
      ctx.fillStyle = accent;
      ctx.fillRect(bx(0.1), by(0.645), bx(0.97) - bx(0.1), by(0.625) - by(0.645));
      ctx.fillRect(bx(0.1), by(0.375), bx(0.97) - bx(0.1), by(0.355) - by(0.375));
      ctx.fillRect(bx(uOf(d.noseTipZ - 0.18)), 0, W, bh);
      break;
    }
  }
  // per-part colours over the pattern (roster packs); z ranges in model metres, V around the wrap axis
  const parts = p.livery.parts;
  const zoneU = (z0: number, z1: number): [number, number] => [bx(Math.max(0, uOf(z0))), bx(Math.min(1, uOf(z1)))];
  const sides = (color: string, u: [number, number], v0: number, v1: number): void => {
    ctx.fillStyle = color;
    ctx.fillRect(u[0], by(1 - v0), u[1] - u[0], by(1 - v1) - by(1 - v0));
    ctx.fillRect(u[0], by(v1), u[1] - u[0], by(v0) - by(v1));
  };
  const sidepods = partColor(parts, 'sidepods');
  if (sidepods) sides(sidepods, zoneU(d.rearAxleZ + 0.3, d.cockpitZ1), 0.12, 0.38);
  const cover = partColor(parts, 'engineCover');
  if (cover) {
    const u = zoneU(d.wrapZMin, d.cockpitZ0);
    ctx.fillStyle = cover;
    ctx.fillRect(u[0], by(0.64), u[1] - u[0], by(0.36) - by(0.64));
  }
  const nose = partColor(parts, 'nose');
  if (nose) {
    const u = zoneU(d.cockpitZ1, d.wrapZMax);
    ctx.fillStyle = nose;
    ctx.fillRect(u[0], 0, u[1] - u[0], bh);
  }
  const lower = partColor(parts, 'lower');
  if (lower) sides(lower, zoneU(d.wrapZMin, d.wrapZMax), 0.04, 0.2);

  // underside / seam band in carbon
  ctx.fillStyle = CARBON;
  ctx.fillRect(0, by(1), W, by(0.94) - by(1));
  ctx.fillRect(0, by(0.06), W, by(0) - by(0.06));

  // nose number: readable from in front of the car (glyph up = towards the rear)
  {
    const cx = bx(uOf(d.noseNumberZ));
    const cy = by(0.5);
    const glyphH = (0.2 / (d.wrapZMax - d.wrapZMin)) * W;
    const maxRun = (by(0.42) - by(0.58)) * 0.95;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 2);
    drawLabel(ctx, num, glyphH, maxRun, nose ?? primary, accent);
    ctx.restore();
  }
  // team code on both sidepods (left side V=0.75 reads with a 180° turn, right side V=0.25 upright)
  {
    const cx = bx(uOf(d.sidepodTextZ));
    const glyphH = (0.16 / 0.6) * (by(0.7) - by(0.8));
    const run = (0.5 / (d.wrapZMax - d.wrapZMin)) * W;
    const sideBg = sidepods ?? (pattern === 'classic' ? secondary : primary);
    ctx.save();
    ctx.translate(cx, by(0.75));
    ctx.rotate(Math.PI);
    drawLabel(ctx, code, Math.max(8, glyphH), run, sideBg, accent);
    ctx.restore();
    ctx.save();
    ctx.translate(cx, by(0.25));
    drawLabel(ctx, code, Math.max(8, glyphH), run, sideBg, accent);
    ctx.restore();
  }
  ctx.restore();

  // ── swatches ──
  const sy = H * (1 - SWATCH_V1);
  const sh = H * (SWATCH_V1 - SWATCH_V0);
  const swatchColor = swatchColors(p.livery);
  for (const name of SWATCHES) {
    ctx.fillStyle = swatchColor[name];
    ctx.fillRect(...swatchRect(name, W, H));
  }

  // ── fin panel ──
  {
    const fx = FIN_U0 * W;
    const fw = W - fx;
    const finBg = cover ?? primary;
    ctx.fillStyle = finBg;
    ctx.fillRect(fx, sy, fw, sh);
    ctx.fillStyle = secondary;
    ctx.fillRect(fx, sy, fw, sh * 0.22);
    ctx.fillStyle = accent;
    ctx.fillRect(fx, sy + sh * 0.22, fw, sh * 0.05);
    ctx.save();
    ctx.translate(fx + fw * 0.5, sy + sh * 0.62);
    drawLabel(ctx, num, sh * 0.62, fw * 0.4, finBg, accent);
    ctx.restore();
  }

  // ── helmet ──
  {
    const hy = H * (1 - HELMET_V1);
    const hh = H * HELMET_V1;
    const hp = safeHex(p.helmet.primary, '#ffffff');
    const hs = safeHex(p.helmet.secondary, '#202020');
    const ha = safeHex(p.helmet.accent, '#d02020');
    ctx.fillStyle = hp;
    ctx.fillRect(0, hy, W, hh);
    // band around the head (latitude ~0.55..0.7)
    ctx.fillStyle = hs;
    ctx.fillRect(0, hy + hh * 0.3, W, hh * 0.16);
    // top cap
    ctx.fillStyle = ha;
    ctx.fillRect(0, hy, W, hh * 0.14);
    // side flashes
    ctx.fillStyle = hs;
    for (const u of [0.25, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(u * W - W * 0.06, hy + hh * 0.46);
      ctx.lineTo(u * W + W * 0.06, hy + hh * 0.46);
      ctx.lineTo(u * W, hy + hh * 0.8);
      ctx.closePath();
      ctx.fill();
    }
  }
  return c;
}

/** Centered label with contrasting fill + outline relative to the background colour. */
function drawLabel(ctx: CanvasRenderingContext2D, text: string, glyphH: number, maxWidth: number, bg: string, accent: string): void {
  if (!text) return;
  const dark = luminance(bg) > 0.55;
  const fill = dark ? '#111111' : '#ffffff';
  const accentLight = luminance(accent) > 0.5;
  // outline must contrast with the fill: use the accent when it does, otherwise plain white / black
  const outline = dark ? (accentLight ? accent : '#ffffff') : accentLight ? '#000000' : accent;
  fitFont(ctx, text, '900', glyphH * 1.25, Math.max(4, maxWidth));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, glyphH * 0.12);
  ctx.strokeStyle = outline;
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = fill;
  ctx.fillText(text, 0, 0);
}

export function liveryTexture(size: number, d: CarDims, p: LiveryPaint, anisotropy: number): THREE.CanvasTexture {
  return canvasTexture(paintLiveryCanvas(size, d, p), { anisotropy });
}

/** Shared surface map with the atlas layout: R = clear coat, G = roughness, B = metalness. Caller owns disposal. */
export function surfaceMapTexture(): THREE.CanvasTexture {
  const c = createCanvas(256, 256);
  const { ctx } = c;
  const px = (k: keyof typeof CAR_SURFACE): string => {
    const [r, m, cc] = CAR_SURFACE[k];
    return `rgb(${Math.round(cc * 255)},${Math.round(r * 255)},${Math.round(m * 255)})`;
  };
  ctx.fillStyle = px('paint');
  ctx.fillRect(0, 0, c.w, c.h);
  const sy = c.h * (1 - SWATCH_V1);
  const sh = c.h * (SWATCH_V1 - SWATCH_V0);
  for (const name of SWATCHES) {
    ctx.fillStyle = px(name);
    ctx.fillRect(...swatchRect(name, c.w, c.h));
  }
  ctx.fillStyle = px('fin');
  ctx.fillRect(FIN_U0 * c.w, sy, c.w * (1 - FIN_U0), sh);
  ctx.fillStyle = px('helmet');
  ctx.fillRect(0, c.h * (1 - HELMET_V1), c.w, c.h * HELMET_V1);
  // underside carbon band of the body wrap
  ctx.fillStyle = px('underside');
  const bh = c.h * (1 - BODY_V0);
  ctx.fillRect(0, 0, c.w, bh * 0.06);
  ctx.fillRect(0, bh * 0.94, c.w, bh * 0.06);
  return canvasTexture(c, { srgb: false });
}

/** For text glyph fonts used elsewhere (keeps one font stack). */
export const LIVERY_FONT = UI_FONT;
