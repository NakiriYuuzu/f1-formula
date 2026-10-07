/**
 * Canvas helpers shared by all procedural textures: canvas creation, seeded RNG, wrap-around
 * drawing for tileable textures and CanvasTexture construction with correct colour space.
 */
import * as THREE from 'three';
import { nextRandom, type RngState } from '../../core/math';

export const UI_FONT = '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Heiti TC", "Segoe UI", Arial, sans-serif';

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

export function createCanvas(w: number, h: number): Canvas2D {
  const canvas = document.createElement('canvas');
  const cw = Math.max(1, Math.floor(w));
  const ch = Math.max(1, Math.floor(h));
  canvas.width = cw;
  canvas.height = ch;
  // procedural textures read their pixels back (shadePixels): keep the canvas CPU-side
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('render: 2D canvas context unavailable');
  return { canvas, ctx, w: cw, h: ch };
}

/** Small deterministic RNG wrapper over core/math mulberry32. */
export class Rng {
  private readonly state: RngState;
  constructor(seed: number) {
    this.state = { s: (Math.floor(Math.abs(seed)) * 2654435761) >>> 0 };
  }
  next(): number {
    return nextRandom(this.state);
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hiInclusive: number): number {
    return Math.min(hiInclusive, lo + Math.floor(this.next() * (hiInclusive - lo + 1)));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }
}

export interface TextureOptions {
  /** colour data (sRGB) vs. non-colour data (roughness etc.) */
  srgb?: boolean;
  repeat?: boolean;
  anisotropy?: number;
  mipmaps?: boolean;
  nearest?: boolean;
}

export function canvasTexture(c: Canvas2D, opts: TextureOptions = {}): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c.canvas);
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (opts.repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  } else {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }
  tex.anisotropy = Math.max(1, Math.floor(opts.anisotropy ?? 1));
  if (opts.nearest) {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
  } else if (opts.mipmaps === false) {
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
  }
  tex.needsUpdate = true;
  return tex;
}

/** Draw with wrap-around so a shape crossing an edge reappears on the opposite edge (tileable textures). */
export function drawWrapped(c: Canvas2D, x: number, y: number, r: number, draw: (x: number, y: number) => void): void {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const px = x + ox * c.w;
      const py = y + oy * c.h;
      if (px + r < 0 || px - r > c.w || py + r < 0 || py - r > c.h) continue;
      draw(px, py);
    }
  }
}

/** Per-pixel grain: adds signed random brightness (amount 0..255) to the whole canvas. */
export function addGrain(c: Canvas2D, rng: Rng, amount: number, mono = true): void {
  const img = c.ctx.getImageData(0, 0, c.w, c.h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * amount;
    if (mono) {
      d[i] = clampByte(d[i] + n);
      d[i + 1] = clampByte(d[i + 1] + n);
      d[i + 2] = clampByte(d[i + 2] + n);
    } else {
      d[i] = clampByte(d[i] + (rng.next() - 0.5) * amount);
      d[i + 1] = clampByte(d[i + 1] + (rng.next() - 0.5) * amount);
      d[i + 2] = clampByte(d[i + 2] + (rng.next() - 0.5) * amount);
    }
  }
  c.ctx.putImageData(img, 0, 0);
}

/** Edit every pixel in place: `shade(x, y, data, i)` reads / writes the RGBA bytes data[i .. i + 3]. */
export function shadePixels(c: Canvas2D, shade: (x: number, y: number, d: Uint8ClampedArray, i: number) => void): void {
  const img = c.ctx.getImageData(0, 0, c.w, c.h);
  const d = img.data;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) shade(x, y, d, (y * c.w + x) * 4);
  }
  c.ctx.putImageData(img, 0, 0);
}

/** Soft tileable blotches (large-scale variation). */
export function addBlotches(c: Canvas2D, rng: Rng, count: number, colors: readonly string[], minR: number, maxR: number, alpha: number): void {
  const { ctx } = c;
  for (let i = 0; i < count; i++) {
    const x = rng.next() * c.w;
    const y = rng.next() * c.h;
    const r = rng.range(minR, maxR);
    const color = rng.pick(colors);
    drawWrapped(c, x, y, r, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, withAlpha(color, alpha));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
}

export function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** '#rrggbb' + alpha -> 'rgba(...)'. Invalid input falls back to grey. */
export function withAlpha(hex: string, a: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

export function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 128, g: 128, b: 128 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/** Safe colour string for canvas / THREE.Color from user data. */
export function safeHex(hex: string | undefined, fallback: string): string {
  return hex && /^#[0-9a-f]{6}$/i.test(hex.trim()) ? hex.trim() : fallback;
}

/** Mix two '#rrggbb' colours. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(ca.r + (cb.r - ca.r) * k);
  const g = Math.round(ca.g + (cb.g - ca.g) * k);
  const bl = Math.round(ca.b + (cb.b - ca.b) * k);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/** Relative luminance 0..1 of an sRGB hex colour (for picking contrasting text). */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Fit text into a box by shrinking the font size. Returns the chosen size. */
export function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: string, maxSize: number, maxWidth: number): number {
  let size = Math.max(4, Math.floor(maxSize));
  ctx.font = `${weight} ${size}px ${UI_FONT}`;
  const w = ctx.measureText(text).width;
  if (w > maxWidth && w > 0) {
    size = Math.max(4, Math.floor((size * maxWidth) / w));
    ctx.font = `${weight} ${size}px ${UI_FONT}`;
  }
  return size;
}
