/**
 * Procedural, tileable surface textures (canvas): asphalt, grass, gravel, sand, kerbs, concrete,
 * catch fence, tyre wall, chequered line, building windows, garage doors, terrain ground + greyscale ground
 * detail, sea wave normals, sky cloud noise and distant skyline facades, plus the detail normal / roughness maps
 * of the racing surfaces and walls (aggregate, kerb ribs, pebbles, grass blades, concrete pores).
 */
import type * as THREE from 'three';
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import type { Biome } from '../../core/types';
import { hash3, tileableFbm } from '../track/sceneryMath';
import { addBlotches, addGrain, canvasTexture, clampByte, createCanvas, drawWrapped, Rng, shadePixels } from './canvas';

/** Road asphalt: dark grey grain + aggregate speckle (tileable). `size` = edge in px (counts scale with the area). */
export function asphaltTexture(anisotropy: number, seed = 11, size = 512): THREE.CanvasTexture {
  const c = createCanvas(size, size);
  const rng = new Rng(seed);
  const k = c.w / 512;
  c.ctx.fillStyle = '#4a4b4e';
  c.ctx.fillRect(0, 0, c.w, c.h);
  addBlotches(c, rng, 40, ['#3d3e41', '#56575a', '#44464a'], 30 * k, 110 * k, 0.55);
  // patched / resurfaced sections: slightly different binder tone in long rectangles across the lane
  for (let i = 0; i < 3; i++) {
    const v = rng.int(58, 82);
    const pw = rng.range(80, 160) * k;
    const ph = rng.range(24, 60) * k;
    c.ctx.fillStyle = `rgba(${v},${v},${v + 2},0.35)`;
    drawWrapped(c, rng.next() * c.w, rng.next() * c.h, 160 * k, (px, py) => c.ctx.fillRect(px - pw / 2, py - ph / 2, pw, ph));
  }
  // aggregate speckle: low contrast (the detail normal map carries the stones' relief; bright specks read as salt)
  for (let i = 0; i < 2600 * k * k; i++) {
    const x = rng.next() * c.w;
    const y = rng.next() * c.h;
    const v = rng.int(64, 106);
    c.ctx.fillStyle = `rgb(${v},${v},${v + 3})`;
    c.ctx.fillRect(x, y, rng.range(0.8, 2.2) * k, rng.range(0.8, 2.2) * k);
  }
  addGrain(c, rng, 26);
  return canvasTexture(c, { repeat: true, anisotropy });
}

/**
 * Grass with mowing stripes along v (texture tiles every 2 stripes), clumps, blades and soft tonal variation;
 * `saturation` < 1 mutes the painted greens toward real turf, `value` < 1 darkens them.
 */
export function grassTexture(anisotropy: number, base = '#4f7d33', seed = 21, saturation = 1, value = 1): THREE.CanvasTexture {
  const c = createCanvas(256, 256);
  const rng = new Rng(seed);
  c.ctx.fillStyle = base;
  c.ctx.fillRect(0, 0, c.w, c.h);
  // mowing stripe: a slightly lighter green half (a white overlay reads as grey bands under strong sun)
  c.ctx.fillStyle = 'rgba(150,205,95,0.07)';
  c.ctx.fillRect(0, 0, c.w, c.h / 2);
  addBlotches(c, rng, 34, ['#3e6a28', '#5e8f3d', '#6b8a3a', '#47722d'], 10, 56, 0.32);
  // clover / dry clumps
  addBlotches(c, rng, 26, ['#7d9a45', '#355e22', '#8a8f4a'], 3, 9, 0.45);
  for (let i = 0; i < 4200; i++) {
    const x = rng.next() * c.w;
    const y = rng.next() * c.h;
    c.ctx.fillStyle = rng.next() < 0.5 ? 'rgba(28,56,18,0.5)' : 'rgba(160,200,95,0.38)';
    c.ctx.fillRect(x, y, 1, rng.range(1.5, 4.5));
  }
  const tone = tileableFbm(c.w, 4, 4, seed + 5, 0.55);
  const sat = Math.max(0, Math.min(1, saturation));
  shadePixels(c, (x, y, d, i) => {
    const k = (0.9 + 0.2 * tone[y * c.w + x]) * value;
    const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * (1 - sat);
    d[i] = clampByte((d[i] * sat + l) * k);
    d[i + 1] = clampByte((d[i + 1] * sat + l) * k);
    d[i + 2] = clampByte((d[i + 2] * sat + l) * k);
  });
  addGrain(c, rng, 18, false);
  return canvasTexture(c, { repeat: true, anisotropy });
}

/** Gravel trap: shaded pebbles of mixed size and tone over damp / dry patches (tileable). */
export function gravelTexture(anisotropy: number, seed = 31): THREE.CanvasTexture {
  const c = createCanvas(256, 256);
  const rng = new Rng(seed);
  c.ctx.fillStyle = '#b3a386';
  c.ctx.fillRect(0, 0, c.w, c.h);
  addBlotches(c, rng, 22, ['#9d8f74', '#c4b597', '#a89a7e'], 14, 50, 0.45);
  const tones: [number, number, number][] = [
    [1, 0.93, 0.8],
    [1, 0.97, 0.9],
    [0.95, 0.95, 0.95],
    [1, 0.88, 0.74],
    [0.9, 0.86, 0.8],
  ];
  for (let i = 0; i < 4200; i++) {
    const x = rng.next() * c.w;
    const y = rng.next() * c.h;
    const v = rng.int(110, 220);
    const r = rng.next() < 0.12 ? rng.range(2.2, 3.4) : rng.range(0.8, 2.2);
    const tn = rng.pick(tones);
    const col = (k: number): string => `rgb(${clampByte(v * tn[0] * k)},${clampByte(v * tn[1] * k)},${clampByte(v * tn[2] * k)})`;
    drawWrapped(c, x, y, r + 1, (px, py) => {
      // contact shadow, body, highlight
      c.ctx.fillStyle = 'rgba(40,34,26,0.35)';
      c.ctx.beginPath();
      c.ctx.arc(px + r * 0.35, py + r * 0.35, r, 0, Math.PI * 2);
      c.ctx.fill();
      c.ctx.fillStyle = col(1);
      c.ctx.beginPath();
      c.ctx.arc(px, py, r, 0, Math.PI * 2);
      c.ctx.fill();
      if (r > 1.2) {
        c.ctx.fillStyle = col(1.18);
        c.ctx.beginPath();
        c.ctx.arc(px - r * 0.3, py - r * 0.3, r * 0.45, 0, Math.PI * 2);
        c.ctx.fill();
      }
    });
  }
  const damp = tileableFbm(c.w, 3, 3, seed + 9, 0.5);
  shadePixels(c, (x, y, d, i) => {
    const k = 0.84 + 0.24 * damp[y * c.w + x];
    d[i] = clampByte(d[i] * k);
    d[i + 1] = clampByte(d[i + 1] * k);
    d[i + 2] = clampByte(d[i + 2] * k);
  });
  addGrain(c, rng, 20);
  return canvasTexture(c, { repeat: true, anisotropy });
}

/** Painted run-off band: opacity and share of each texture repeat it covers. */
export const RUNOFF_PAINT_ALPHA = 0.38;
export const RUNOFF_PAINT_COVER = 0.32;

/** Painted asphalt run-off (slightly lighter, faint coloured bands, rubber streaks from run-wide moments). */
export function runoffAsphaltTexture(anisotropy: number, band = '#2c5f8a', seed = 41): THREE.CanvasTexture {
  const c = createCanvas(256, 256);
  const rng = new Rng(seed);
  c.ctx.fillStyle = '#5b5d61';
  c.ctx.fillRect(0, 0, c.w, c.h);
  addBlotches(c, rng, 18, ['#505256', '#66686c'], 20, 60, 0.5);
  // painted band: narrow and translucent so it reads as paint on asphalt (wide opaque bands looked like grass strips)
  c.ctx.fillStyle = band;
  c.ctx.globalAlpha = RUNOFF_PAINT_ALPHA;
  c.ctx.fillRect(0, 0, c.w, c.h * RUNOFF_PAINT_COVER);
  c.ctx.globalAlpha = 1;
  for (let i = 0; i < 1600; i++) {
    const v = rng.int(85, 135);
    c.ctx.fillStyle = `rgba(${v},${v},${v + 4},0.6)`;
    c.ctx.fillRect(rng.next() * c.w, rng.next() * c.h, rng.range(0.8, 1.8), rng.range(0.8, 1.8));
  }
  // rubber streaks: long soft dark arcs running roughly along v (driving direction), wrapped vertically
  c.ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const x0 = rng.next() * c.w;
    const bend = rng.range(-30, 30);
    c.ctx.strokeStyle = `rgba(20,20,22,${rng.range(0.12, 0.26).toFixed(2)})`;
    c.ctx.lineWidth = rng.range(2, 5);
    for (const ox of [-c.w, 0, c.w]) {
      c.ctx.beginPath();
      c.ctx.moveTo(x0 + ox, 0);
      c.ctx.quadraticCurveTo(x0 + ox + bend, c.h / 2, x0 + ox, c.h);
      c.ctx.stroke();
    }
  }
  addGrain(c, rng, 22);
  return canvasTexture(c, { repeat: true, anisotropy });
}

/** Kerb: two colour stripes along v (one texture repeat = 2 stripes). Slight grain. */
export function kerbTexture(anisotropy: number, a: string, b: string, seed = 51): THREE.CanvasTexture {
  const c = createCanvas(64, 128);
  const rng = new Rng(seed);
  c.ctx.fillStyle = a;
  c.ctx.fillRect(0, 0, c.w, c.h / 2);
  c.ctx.fillStyle = b;
  c.ctx.fillRect(0, c.h / 2, c.w, c.h / 2);
  // ribs across the kerb
  c.ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 0; y < c.h; y += 8) c.ctx.fillRect(0, y, c.w, 2);
  addGrain(c, rng, 14);
  return canvasTexture(c, { repeat: true, anisotropy });
}

export function concreteTexture(anisotropy: number, tint = '#c9c8c2', seed = 61): THREE.CanvasTexture {
  const c = createCanvas(256, 128);
  const rng = new Rng(seed);
  c.ctx.fillStyle = tint;
  c.ctx.fillRect(0, 0, c.w, c.h);
  addBlotches(c, rng, 20, ['#b4b3ad', '#d8d7d1', '#a9a8a2'], 8, 40, 0.4);
  // panel seams every 4 m (texture = 8 m along u)
  c.ctx.fillStyle = 'rgba(40,40,40,0.55)';
  c.ctx.fillRect(0, 0, 2, c.h);
  c.ctx.fillRect(c.w / 2, 0, 2, c.h);
  // dirt line at the bottom
  const g = c.ctx.createLinearGradient(0, c.h, 0, c.h * 0.6);
  g.addColorStop(0, 'rgba(60,55,50,0.5)');
  g.addColorStop(1, 'rgba(60,55,50,0)');
  c.ctx.fillStyle = g;
  c.ctx.fillRect(0, c.h * 0.6, c.w, c.h * 0.4);
  addGrain(c, rng, 16);
  return canvasTexture(c, { repeat: true, anisotropy });
}

/** Catch / debris fence: diamond wire mesh with transparency (alpha-blended with a tiny alphaTest: mip-averaged alpha fades out at distance). Tiles 2 m x 2 m. */
export function fenceTexture(anisotropy: number): THREE.CanvasTexture {
  const c = createCanvas(128, 128);
  c.ctx.clearRect(0, 0, c.w, c.h);
  c.ctx.strokeStyle = 'rgba(200,205,210,0.95)';
  c.ctx.lineWidth = 2;
  const step = 16;
  for (let k = -c.w; k <= c.w * 2; k += step) {
    c.ctx.beginPath();
    c.ctx.moveTo(k, 0);
    c.ctx.lineTo(k + c.h, c.h);
    c.ctx.stroke();
    c.ctx.beginPath();
    c.ctx.moveTo(k, c.h);
    c.ctx.lineTo(k + c.h, 0);
    c.ctx.stroke();
  }
  // horizontal tension cables
  c.ctx.fillStyle = 'rgba(160,165,170,1)';
  c.ctx.fillRect(0, 0, c.w, 3);
  c.ctx.fillRect(0, c.h / 2, c.w, 2);
  return canvasTexture(c, { repeat: true, anisotropy });
}

/** Tyre wall: rows of tyres with a coloured conveyor-belt facing. u along (2 m), v up (1 m). */
export function tyreWallTexture(anisotropy: number, beltA: string, beltB: string): THREE.CanvasTexture {
  const c = createCanvas(256, 128);
  c.ctx.fillStyle = '#121214';
  c.ctx.fillRect(0, 0, c.w, c.h);
  // belt facing: alternating colour panels
  c.ctx.fillStyle = beltA;
  c.ctx.fillRect(0, 10, c.w / 2, c.h - 20);
  c.ctx.fillStyle = beltB;
  c.ctx.fillRect(c.w / 2, 10, c.w / 2, c.h - 20);
  // bolts / straps
  c.ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (let x = 0; x < c.w; x += 32) c.ctx.fillRect(x, 10, 3, c.h - 20);
  c.ctx.fillStyle = 'rgba(255,255,255,0.12)';
  c.ctx.fillRect(0, 12, c.w, 6);
  return canvasTexture(c, { repeat: true, anisotropy });
}

/** Black / white chequer, 2 x 8 squares (u across track, v along). */
export function checkerTexture(): THREE.CanvasTexture {
  const c = createCanvas(256, 64);
  const n = 16;
  const sq = c.w / n;
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < n; i++) {
      c.ctx.fillStyle = (i + row) % 2 === 0 ? '#f4f4f4' : '#141414';
      c.ctx.fillRect(i * sq, row * (c.h / 4), sq, c.h / 4);
    }
  }
  return canvasTexture(c, { nearest: false, anisotropy: 4 });
}

/** Facade with window grid. `lit` paints random warm windows (for the emissive map at night). */
export function windowTexture(lit: boolean, seed = 71): THREE.CanvasTexture {
  const c = createCanvas(256, 256);
  const rng = new Rng(seed);
  c.ctx.fillStyle = lit ? '#000000' : '#d9d6cf';
  c.ctx.fillRect(0, 0, c.w, c.h);
  const cols = 8;
  const rows = 8;
  const cw = c.w / cols;
  const rh = c.h / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const on = rng.next() < 0.45;
      if (lit) {
        if (!on) continue;
        const warm = rng.int(200, 255);
        c.ctx.fillStyle = `rgb(${warm},${Math.round(warm * 0.85)},${Math.round(warm * 0.55)})`;
      } else {
        const v = rng.int(40, 90);
        c.ctx.fillStyle = `rgb(${v},${v + 10},${v + 25})`;
      }
      c.ctx.fillRect(x * cw + cw * 0.18, y * rh + rh * 0.2, cw * 0.64, rh * 0.55);
    }
  }
  return canvasTexture(c, { repeat: true, anisotropy: 2 });
}

/** Garage roller shutter (white, multiplied by the team colour). */
export function shutterTexture(): THREE.CanvasTexture {
  const c = createCanvas(64, 128);
  c.ctx.fillStyle = '#ffffff';
  c.ctx.fillRect(0, 0, c.w, c.h);
  c.ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let y = 0; y < c.h; y += 6) c.ctx.fillRect(0, y, c.w, 1.5);
  c.ctx.fillStyle = 'rgba(0,0,0,0.3)';
  c.ctx.fillRect(0, 0, 2, c.h);
  c.ctx.fillRect(c.w - 2, 0, 2, c.h);
  return canvasTexture(c, { anisotropy: 2 });
}

export interface GroundStyle {
  base: string;
  blotches: string[];
  speck: [number, number, number];
  /** small clumps (tufts, stones, leaf litter) */
  clumps: string[];
}

export const GROUND_STYLES: Record<Biome, GroundStyle> = {
  temperate: { base: '#557f36', blotches: ['#4a7230', '#668c40', '#5d7a35', '#6f8f47'], speck: [70, 110, 45], clumps: ['#3b6427', '#7a9a4a', '#8c8a52'] },
  autumn: { base: '#6f7a3c', blotches: ['#7d6a35', '#5f6e33', '#8a7740', '#6a5a30'], speck: [120, 95, 50], clumps: ['#9a5a2a', '#b07a32', '#5a6430'] },
  desert: { base: '#c9a46b', blotches: ['#bf975d', '#d6b37b', '#b88f58', '#dcbf8c'], speck: [170, 135, 90], clumps: ['#a8834f', '#e0c493', '#9c7a52'] },
  coastal: { base: '#7c9147', blotches: ['#8a9a50', '#6d8540', '#b6a873', '#7f9a4e'], speck: [120, 130, 80], clumps: ['#5f7a38', '#a8a066', '#c2b689'] },
  tropical: { base: '#3f8a2c', blotches: ['#368024', '#4e9a34', '#2f7424', '#5a7a30', '#8a5a36'], speck: [60, 120, 40], clumps: ['#2a6a22', '#6aa83c', '#8a5a3a'] },
  city: { base: '#6e6f70', blotches: ['#646566', '#7a7b7c', '#5d5e60', '#838486'], speck: [95, 95, 98], clumps: ['#58595b', '#8a8b8c', '#6a6b62'] },
};

/** Terrain ground colour map (tiles every ~24 m): blotches, clumps, specks and fractal tonal variation. */
export function groundTexture(biome: Biome, anisotropy: number, seed = 81): THREE.CanvasTexture {
  const style = GROUND_STYLES[biome];
  const c = createCanvas(256, 256);
  const rng = new Rng(seed + biome.length * 7);
  c.ctx.fillStyle = style.base;
  c.ctx.fillRect(0, 0, c.w, c.h);
  addBlotches(c, rng, 46, style.blotches, 12, 60, 0.5);
  addBlotches(c, rng, 60, style.clumps, 2, 7, 0.55);
  const [r, g, b] = style.speck;
  for (let i = 0; i < 2800; i++) {
    const x = rng.next() * c.w;
    const y = rng.next() * c.h;
    const k = rng.range(0.7, 1.3);
    c.ctx.fillStyle = `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},0.6)`;
    c.ctx.fillRect(x, y, rng.range(1, 2.5), rng.range(1, 2.5));
  }
  const tone = tileableFbm(c.w, 3, 5, seed + 13, 0.55);
  shadePixels(c, (x, y, d, i) => {
    const k = 0.86 + 0.28 * tone[y * c.w + x];
    d[i] = clampByte(d[i] * k);
    d[i + 1] = clampByte(d[i + 1] * k);
    d[i + 2] = clampByte(d[i + 2] * k);
  });
  addGrain(c, rng, 16, false);
  return canvasTexture(c, { repeat: true, anisotropy });
}

/** Greyscale tileable ground detail (mean ≈ 0.5): fractal noise + per-pixel grit, sampled at two scales. */
export function groundDetailTexture(anisotropy: number, seed = 91): THREE.CanvasTexture {
  const c = createCanvas(256, 256);
  const rng = new Rng(seed);
  const field = tileableFbm(c.w, 8, 4, seed, 0.6);
  shadePixels(c, (x, y, d, i) => {
    const v = 0.7 * field[y * c.w + x] + 0.3 * rng.next();
    const byte = clampByte(Math.round(v * 255));
    d[i] = byte;
    d[i + 1] = byte;
    d[i + 2] = byte;
    d[i + 3] = 255;
  });
  return canvasTexture(c, { repeat: true, anisotropy, srgb: false });
}

/** Tileable wave normal map for the sea: integer-frequency swell sines + fractal chop (OpenGL convention). */
export function seaNormalTexture(seed = 101): THREE.CanvasTexture {
  const n = 256;
  const c = createCanvas(n, n);
  const chop = tileableFbm(n, 8, 4, seed, 0.55);
  const waves: { kx: number; ky: number; a: number; ph: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const kx = Math.round((hash3(i, 1, seed) - 0.5) * 12);
    const ky = Math.round((hash3(i, 2, seed) - 0.5) * 12) || 1;
    waves.push({ kx, ky, a: 1 / Math.hypot(kx, ky), ph: hash3(i, 3, seed) * Math.PI * 2 });
  }
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let h = 0;
      for (const w of waves) h += w.a * Math.sin(((w.kx * x + w.ky * y) / n) * Math.PI * 2 + w.ph);
      height[y * n + x] = h * 0.6 + chop[y * n + x] * 0.9;
    }
  }
  const strength = 2.2;
  shadePixels(c, (x, y, d, i) => {
    const hx = height[y * n + ((x + 1) % n)] - height[y * n + ((x + n - 1) % n)];
    const hy = height[((y + 1) % n) * n + x] - height[((y + n - 1) % n) * n + x];
    let nx = -hx * strength;
    let ny = hy * strength;
    let nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len;
    ny /= len;
    nz /= len;
    d[i] = clampByte(Math.round((nx * 0.5 + 0.5) * 255));
    d[i + 1] = clampByte(Math.round((ny * 0.5 + 0.5) * 255));
    d[i + 2] = clampByte(Math.round((nz * 0.5 + 0.5) * 255));
    d[i + 3] = 255;
  });
  return canvasTexture(c, { repeat: true, anisotropy: 4, srgb: false });
}

/** Tileable greyscale cloud noise for the sky layer (soft billows, full 0..1 range). */
export function cloudNoiseTexture(size = 256, seed = 111): THREE.CanvasTexture {
  const c = createCanvas(size, size);
  const field = tileableFbm(c.w, 4, 6, seed, 0.52);
  shadePixels(c, (x, y, d, i) => {
    const v = field[y * c.w + x];
    // gentle S-curve: rounder cloud cores, wispier edges
    const s = v * v * (3 - 2 * v);
    const byte = clampByte(Math.round((0.35 * v + 0.65 * s) * 255));
    d[i] = byte;
    d[i + 1] = byte;
    d[i + 2] = byte;
    d[i + 3] = 255;
  });
  return canvasTexture(c, { repeat: true, anisotropy: 2, srgb: false });
}

/** Window rows (cols × rows per tile) of the distant skyline facade texture; texel (0.01, 0.01) is roof dark. */
export const SKYLINE_WINDOW_GRID = { cols: 8, rows: 10 } as const;

/**
 * Distant tower facade: `lit` = emissive map (warm / cool lit windows on black, whole floors sometimes dark),
 * else the day facade (glass panes with sky-reflection gradient between mullions and floor slabs).
 */
export function skylineTexture(lit: boolean, seed = 121): THREE.CanvasTexture {
  const c = createCanvas(256, 256);
  const rng = new Rng(seed);
  const { cols, rows } = SKYLINE_WINDOW_GRID;
  const cw = c.w / cols;
  const rh = c.h / rows;
  c.ctx.fillStyle = lit ? '#000000' : '#4a525c';
  c.ctx.fillRect(0, 0, c.w, c.h);
  for (let y = 0; y < rows; y++) {
    const floorOn = rng.next() < 0.82;
    const warmFloor = rng.next() < 0.7;
    for (let x = 0; x < cols; x++) {
      const px = x * cw + cw * 0.12;
      const py = y * rh + rh * 0.18;
      const w = cw * 0.76;
      const h = rh * 0.6;
      if (lit) {
        if (!floorOn || rng.next() > 0.62) continue;
        const v = rng.int(180, 255);
        c.ctx.fillStyle = warmFloor ? `rgb(${v},${Math.round(v * 0.84)},${Math.round(v * 0.55)})` : `rgb(${Math.round(v * 0.82)},${Math.round(v * 0.9)},${v})`;
      } else {
        const v = rng.int(70, 125);
        const g = c.ctx.createLinearGradient(px, py, px, py + h);
        g.addColorStop(0, `rgb(${v + 40},${v + 55},${v + 75})`);
        g.addColorStop(1, `rgb(${v},${v + 10},${v + 22})`);
        c.ctx.fillStyle = g;
      }
      c.ctx.fillRect(px, py, w, h);
    }
  }
  // keep the roof texel corner (uv 0.01, 0.01 = canvas bottom-left with flipY) dark / plain
  c.ctx.fillStyle = lit ? '#000000' : '#3a4048';
  c.ctx.fillRect(0, c.h - 6, 6, 6);
  return canvasTexture(c, { repeat: true, anisotropy: 2 });
}

// ───────────────────────────── detail normal / roughness maps ─────────────────────────────

/**
 * Tangent-space normal map (OpenGL convention, as seaNormalTexture) from a tileable w × h height field: wrapped central
 * differences, `strength` = slope gain per height unit.
 */
export function normalMapFromHeight(height: Float32Array, w: number, h: number, strength: number, anisotropy: number): THREE.CanvasTexture {
  const c = createCanvas(w, h);
  shadePixels(c, (x, y, d, i) => {
    const hx = height[y * w + ((x + 1) % w)] - height[y * w + ((x + w - 1) % w)];
    const hy = height[((y + 1) % h) * w + x] - height[((y + h - 1) % h) * w + x];
    let nx = -hx * strength;
    let ny = hy * strength;
    let nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len;
    ny /= len;
    nz /= len;
    d[i] = clampByte(Math.round((nx * 0.5 + 0.5) * 255));
    d[i + 1] = clampByte(Math.round((ny * 0.5 + 0.5) * 255));
    d[i + 2] = clampByte(Math.round((nz * 0.5 + 0.5) * 255));
    d[i + 3] = 255;
  });
  return canvasTexture(c, { repeat: true, anisotropy, srgb: false });
}

/** Roughness map (G channel, as three samples it) from a 0..1 field: lo..hi multipliers of the material roughness. */
function roughnessMapFromField(field: Float32Array, w: number, h: number, lo: number, hi: number, anisotropy: number): THREE.CanvasTexture {
  const c = createCanvas(w, h);
  shadePixels(c, (x, y, d, i) => {
    const v = clampByte(Math.round((lo + (hi - lo) * field[y * w + x]) * 255));
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  });
  return canvasTexture(c, { repeat: true, anisotropy, srgb: false });
}

/** Stamp rounded stones (domes with flattened tops) into a wrapped height field; returns the tops mask (polish). */
function stampStones(height: Float32Array, n: number, rng: Rng, count: number, rMin: number, rMax: number, top: Float32Array | null): void {
  for (let s = 0; s < count; s++) {
    const cx = rng.next() * n;
    const cy = rng.next() * n;
    const r = rng.range(rMin, rMax);
    const peak = rng.range(0.55, 1);
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const q = 1 - (dx * dx + dy * dy) / (r * r);
        if (q <= 0) continue;
        const x = (((Math.floor(cx) + dx) % n) + n) % n;
        const y = (((Math.floor(cy) + dy) % n) + n) % n;
        const v = peak * Math.min(1, Math.sqrt(q) * 1.6);
        const j = y * n + x;
        if (v > height[j]) {
          height[j] = v;
          if (top) top[j] = q > 0.35 ? 1 : 0;
        }
      }
    }
  }
}

/** Repeats of the asphalt detail maps per asphalt colour-map repeat (detail texels ≈ 6 mm on a 12 m colour tile). */
export const ASPHALT_DETAIL_REPEAT = 4;

/**
 * Asphalt micro-relief: packed aggregate stones in a darker binder, faint seal cracks; the roughness map polishes the
 * exposed stone tops slightly (multipliers 0.9–1 of the material roughness).
 */
export function asphaltDetailMaps(anisotropy: number, seed = 13, size = 512): { normal: THREE.CanvasTexture; roughness: THREE.CanvasTexture } {
  const n = Math.max(16, Math.floor(size));
  const rng = new Rng(seed);
  const height = new Float32Array(n * n);
  const top = new Float32Array(n * n);
  const grit = tileableFbm(n, 32, 3, seed + 3, 0.5);
  for (let i = 0; i < height.length; i++) height[i] = 0.12 * grit[i] + 0.08 * rng.next();
  stampStones(height, n, rng, Math.round(0.034 * n * n), 0.9, 2.6, top);
  // seal cracks: a few long thin grooves
  for (let c = 0; c < 6; c++) {
    let x = rng.next() * n;
    let y = rng.next() * n;
    let a = rng.next() * Math.PI * 2;
    for (let st = 0; st < n * 0.6; st++) {
      a += rng.range(-0.25, 0.25);
      x += Math.cos(a);
      y += Math.sin(a);
      const j = ((((Math.floor(y) % n) + n) % n) * n) + ((((Math.floor(x) % n) + n) % n));
      height[j] = Math.min(height[j], -0.35);
      top[j] = 0;
    }
  }
  const tone = tileableFbm(n, 4, 3, seed + 7, 0.5);
  const rough = new Float32Array(n * n);
  for (let i = 0; i < rough.length; i++) rough[i] = top[i] > 0 ? 0.4 + 0.3 * tone[i] : 0.7 + 0.3 * tone[i];
  // gentle polish only: glossier stone tops turn into white glitter at grazing angles (Fresnel) otherwise
  return { normal: normalMapFromHeight(height, n, n, 1.8, anisotropy), roughness: roughnessMapFromField(rough, n, n, 0.9, 1, anisotropy) };
}

/** Kerb relief (same 64 × 128 layout as kerbTexture): rounded ribs every 8 px along v, rounded outer edge, grit. */
export function kerbNormalTexture(anisotropy: number, seed = 53): THREE.CanvasTexture {
  const w = 64;
  const h = 128;
  const rng = new Rng(seed);
  const height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const rib = 0.5 + 0.5 * Math.cos(((y % 8) / 8) * Math.PI * 2);
    for (let x = 0; x < w; x++) height[y * w + x] = 0.9 * rib * rib + 0.12 * rng.next();
  }
  return normalMapFromHeight(height, w, h, 1.4, anisotropy);
}

/** Gravel relief: tightly packed rounded pebbles with shadowed gaps. */
export function pebbleNormalTexture(anisotropy: number, seed = 33, size = 256): THREE.CanvasTexture {
  const n = Math.max(16, Math.floor(size));
  const rng = new Rng(seed);
  const height = new Float32Array(n * n);
  for (let i = 0; i < height.length; i++) height[i] = 0.1 * rng.next();
  stampStones(height, n, rng, Math.round(0.09 * n * n), 0.8, 2.4, null);
  return normalMapFromHeight(height, n, n, 2.0, anisotropy);
}

/**
 * Generic organic relief from fractal noise + per-texel grit (grass blades, concrete pores, worn paint): `period`
 * noise cells per tile, `grit` 0..1 share of single-texel noise, `strength` slope gain.
 */
export function noiseNormalTexture(anisotropy: number, seed: number, size = 256, period = 16, grit = 0.4, strength = 1.5): THREE.CanvasTexture {
  const n = Math.max(16, Math.floor(size));
  const rng = new Rng(seed);
  const field = tileableFbm(n, period, 4, seed, 0.55);
  const height = new Float32Array(n * n);
  for (let i = 0; i < height.length; i++) height[i] = (1 - grit) * field[i] + grit * rng.next();
  return normalMapFromHeight(height, n, n, strength, anisotropy);
}

/**
 * Foliage atlas UV rectangles [u0, v0, u1, v1] (texture space, v up) and the opaque white block (trunks, branch
 * tiers: also what the shadow pass samples there). Atlas 1024 × 512: broadleaf cluster on the left half; on the right a
 * pinnate palm frond (top), a conifer needle spray (middle) and the solid block (bottom-right corner).
 */
export const FOLIAGE_UV = {
  leaf: [0, 0, 0.5, 1] as const,
  frond: [0.5, 0.5, 1, 1] as const,
  needle: [0.5, 0.125, 0.9375, 0.5] as const,
  solid: [0.97, 0.06] as const,
};

/**
 * Procedural foliage atlas (RGBA, sRGB): near-neutral leaf colours (the per-instance crown colour gives the hue) with
 * value / warmth variation per leaf, transparent between leaves. Leaves fall off toward the cluster edge, so a card
 * never shows its square outline.
 */
export function foliageAtlasTexture(anisotropy: number, seed = 141): THREE.DataTexture {
  const c = createCanvas(1024, 512);
  const rng = new Rng(seed);
  const g = c.ctx;
  g.clearRect(0, 0, c.w, c.h);
  const leafShape = (x: number, y: number, len: number, wid: number, a: number): void => {
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.beginPath();
    g.moveTo(-len / 2, 0);
    g.quadraticCurveTo(0, -wid, len / 2, 0);
    g.quadraticCurveTo(0, wid, -len / 2, 0);
    g.fill();
    g.restore();
  };
  const tone = (lo: number, hi: number): string => {
    const v = rng.range(lo, hi);
    return `rgb(${Math.round(v * rng.range(0.9, 1.02))},${Math.round(v)},${Math.round(v * rng.range(0.72, 0.9))})`;
  };
  // broadleaf cluster (512 × 512): twigs, then ~420 leaves densest at the centre
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(60, 200);
    g.strokeStyle = `rgb(${Math.round(rng.range(70, 95))},${Math.round(rng.range(60, 80))},${Math.round(rng.range(45, 60))})`;
    g.lineWidth = rng.range(1.5, 3.5);
    g.beginPath();
    g.moveTo(256, 256);
    g.quadraticCurveTo(256 + Math.cos(a + 0.4) * r * 0.5, 256 + Math.sin(a + 0.4) * r * 0.5, 256 + Math.cos(a) * r, 256 + Math.sin(a) * r);
    g.stroke();
  }
  for (let i = 0; i < 640; i++) {
    const rr = Math.min(1, Math.abs(rng.range(-1, 1) * rng.range(0.35, 1)) + 0.04) * 218;
    const a = rng.range(0, Math.PI * 2);
    const x = 256 + Math.cos(a) * rr;
    const y = 256 + Math.sin(a) * rr;
    const len = rng.range(20, 38) * (1 - 0.3 * (rr / 218));
    g.fillStyle = tone(rr < 120 ? 120 : 150, 250);
    leafShape(x, y, len, len * rng.range(0.36, 0.5), a + rng.range(-0.9, 0.9));
  }
  // pinnate palm frond (512 × 256, canvas top half of the right side): rachis along x, leaflets both sides
  const fy = 128;
  for (let t = 0.02; t < 0.99; t += 0.017) {
    const x = 520 + t * 496;
    const span = (108 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.06)), 0.7) + 10) * rng.range(0.88, 1.06);
    for (const side of [-1, 1]) {
      const ang = side * rng.range(0.55, 0.85);
      g.fillStyle = tone(160, 245);
      g.save();
      g.translate(x, fy);
      g.rotate(ang);
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(span * 0.5, side * -4.5, span, 0);
      g.quadraticCurveTo(span * 0.5, side * 4.5, 0, 0);
      g.fill();
      g.restore();
    }
  }
  g.strokeStyle = 'rgb(176,168,112)';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(516, fy);
  g.lineTo(1018, fy);
  g.stroke();
  // conifer needle spray (448 × 192, below the frond): branchlets densely set with short needles
  const ny = 352;
  for (let k = 0; k < 7; k++) {
    const x0 = 520 + k * 60 + rng.range(-6, 6);
    const dir = rng.range(-0.5, 0.5);
    for (let i = 0; i < 46; i++) {
      const t = i / 46;
      const bx = x0 + t * 70;
      const by = ny + dir * t * 70 + rng.range(-3, 3);
      for (const side of [-1, 1]) {
        const a = side * rng.range(0.6, 1.2) + dir;
        const l = rng.range(9, 16) * (1 - 0.4 * t);
        g.strokeStyle = tone(140, 230);
        g.lineWidth = rng.range(1.2, 2.2);
        g.beginPath();
        g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(a) * l * 0.6, by + Math.sin(a) * l);
        g.stroke();
      }
    }
  }
  // opaque block (bottom-right corner, 64 × 64)
  g.fillStyle = '#ffffff';
  g.fillRect(960, 448, 64, 64);
  // DataTexture (rows flipped to v-up): transparent texels keep a neutral leaf colour, so mip levels do not darken the
  // leaf edges (a canvas upload would turn every transparent texel black)
  const img = g.getImageData(0, 0, c.w, c.h).data;
  const data = new Uint8Array(c.w * c.h * 4);
  for (let y = 0; y < c.h; y++) {
    const src = (c.h - 1 - y) * c.w * 4;
    const dst = y * c.w * 4;
    for (let x = 0; x < c.w * 4; x += 4) {
      const a = img[src + x + 3];
      data[dst + x] = a > 0 ? img[src + x] : 176;
      data[dst + x + 1] = a > 0 ? img[src + x + 1] : 184;
      data[dst + x + 2] = a > 0 ? img[src + x + 2] : 148;
      data[dst + x + 3] = a;
    }
  }
  const tex = new DataTexture(data, c.w, c.h, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = Math.max(1, anisotropy);
  tex.name = 'foliage-atlas';
  tex.needsUpdate = true;
  return tex;
}
