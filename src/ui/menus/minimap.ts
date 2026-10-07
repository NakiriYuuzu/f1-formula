/**
 * Track minimap previews on <canvas> from the registry's normalized layout outline. Outlines are cached and
 * canvases are painted one per animation frame so a grid of previews never blocks the first paint.
 */
import { getLayoutOutline } from '../../data/tracks';

type Point = { x: number; y: number };

const outlineCache = new Map<string, Point[] | null>();

/** Normalized outline (cached); null when the layout is unknown or the registry fails. */
export function layoutOutline(layoutId: string): Point[] | null {
  if (outlineCache.has(layoutId)) return outlineCache.get(layoutId) ?? null;
  let pts: Point[] | null = null;
  try {
    const raw = getLayoutOutline(layoutId, 240);
    const clean = raw.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    pts = clean.length >= 3 ? clean : null;
  } catch {
    pts = null;
  }
  outlineCache.set(layoutId, pts);
  return pts;
}

export interface MinimapStyle {
  /** stroke colour of the track line */
  color: string;
  /** CSS px */
  lineWidth: number;
  /** show start/finish tick + direction chevron */
  markers: boolean;
}

const DEFAULT_STYLE: MinimapStyle = { color: '#eef2f7', lineWidth: 2.5, markers: true };

/** Paint a layout outline into a canvas of the given CSS size. */
export function paintMinimap(canvas: HTMLCanvasElement, layoutId: string, cssW: number, cssH: number, style: Partial<MinimapStyle> = {}): void {
  const s = { ...DEFAULT_STYLE, ...style };
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pts = layoutOutline(layoutId);
  const pad = Math.max(6, s.lineWidth * 3);
  if (!pts) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cssW / 2, cssH / 2, Math.max(1, cssW / 2 - pad), Math.max(1, cssH / 2 - pad), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(1e-6, maxX - minX);
  const hgt = Math.max(1e-6, maxY - minY);
  const scale = Math.min((cssW - pad * 2) / w, (cssH - pad * 2) / hgt);
  const ox = (cssW - w * scale) / 2 - minX * scale;
  const oy = (cssH - hgt * scale) / 2 - minY * scale;
  const X = (p: Point): number => ox + p.x * scale;
  const Y = (p: Point): number => oy + p.y * scale;

  const trace = (): void => {
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p), Y(p)) : ctx.lineTo(X(p), Y(p))));
    ctx.closePath();
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  trace();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = s.lineWidth + 4;
  ctx.stroke();
  trace();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.lineWidth;
  ctx.stroke();

  if (!s.markers) return;
  const p0 = pts[0] as Point;
  const p1 = pts[Math.min(pts.length - 1, 3)] as Point;
  const dx = X(p1) - X(p0);
  const dy = Y(p1) - Y(p0);
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tick = s.lineWidth * 2.6 + 3;
  // start / finish line (perpendicular tick)
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, s.lineWidth * 0.9);
  ctx.beginPath();
  ctx.moveTo(X(p0) - uy * tick, Y(p0) + ux * tick);
  ctx.lineTo(X(p0) + uy * tick, Y(p0) - ux * tick);
  ctx.stroke();
  // direction chevron just after the line
  const cx = X(p0) + ux * tick * 2.2;
  const cy = Y(p0) + uy * tick * 2.2;
  const a = tick * 0.9;
  ctx.fillStyle = '#ff5a1f';
  ctx.beginPath();
  ctx.moveTo(cx + ux * a, cy + uy * a);
  ctx.lineTo(cx - ux * a * 0.6 - uy * a * 0.8, cy - uy * a * 0.6 + ux * a * 0.8);
  ctx.lineTo(cx - ux * a * 0.6 + uy * a * 0.8, cy - uy * a * 0.6 - ux * a * 0.8);
  ctx.closePath();
  ctx.fill();
}

// ── paint queue (one canvas per frame)
const queue: (() => void)[] = [];
let frame = 0;

function pump(): void {
  frame = 0;
  const job = queue.shift();
  if (job) job();
  if (queue.length > 0) frame = requestAnimationFrame(pump);
}

/** New canvas whose minimap is painted on an upcoming frame. */
export function minimapCanvas(layoutId: string, cssW: number, cssH: number, style: Partial<MinimapStyle> = {}): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'nvm-minimap';
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  if (outlineCache.has(layoutId)) {
    paintMinimap(canvas, layoutId, cssW, cssH, style);
  } else {
    queue.push(() => paintMinimap(canvas, layoutId, cssW, cssH, style));
    if (frame === 0) frame = requestAnimationFrame(pump);
  }
  return canvas;
}

/** Drop pending paints (MenuSystem.destroy). */
export function cancelMinimapQueue(): void {
  queue.length = 0;
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
}
