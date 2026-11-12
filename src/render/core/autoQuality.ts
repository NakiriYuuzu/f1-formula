/**
 * Automatic quality (pure): the tier the game picks for a machine until the player takes the choice over. The first
 * pick comes from the WebGL renderer string; the frame-time governor (AdaptiveResolution.starved) then steps it down
 * when the race stays over budget at the lowest resolution scale, or crawls. It never steps up on its own: a frame time
 * read from animation-frame intervals is quantised by vsync, so spare GPU time cannot be seen.
 */
import type { QualityLevel } from '../../core/types';
import { qualityProfile } from './quality';

export const QUALITY_ORDER: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

/** Renderer strings of software rasterisers (no GPU acceleration at all). */
export function isSoftwareGpu(gpu: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(gpu);
}

/**
 * First guess from UNMASKED_RENDERER_WEBGL. Conservative: Apple silicon and discrete cards start at `high`, an integrated
 * GPU of the last few generations at `medium`, older integrated GPUs, phones and software rendering at `low`. An unknown
 * string starts at `medium` and the governor corrects it either way.
 */
export function guessQuality(gpu: string): QualityLevel {
  const g = gpu.toLowerCase();
  if (isSoftwareGpu(g)) return 'low';
  if (/apple (m\d|gpu)/.test(g)) return 'high';
  if (/intel/.test(g)) {
    if (/\barc\b/.test(g)) return 'high';
    if (/iris.*xe|iris.*plus|iris.*pro|uhd.*(7[3-9]\d|770)|\bxe\b/.test(g)) return 'medium';
    return 'low';
  }
  if (/nvidia|geforce|rtx|quadro/.test(g)) {
    // GT 7xx and older, GTX 4xx-6xx, 8xx / 9xx series cards and the MX / GT 1030 class
    if (/\bgt ?[1-9]\d{2}\b|\bgt ?10[0-3]0\b|geforce (8|9)\d{3}|\bgtx ?[4-6]\d{2}\b|\bmx ?\d{2,3}\b/.test(g)) return 'medium';
    return 'high';
  }
  if (/radeon (rx|pro|vii)|radeon\(tm\) rx|\bamd\b.*\brx\b/.test(g)) return 'high';
  if (/radeon|amd|vega/.test(g)) return 'medium';
  if (/mali|adreno|powervr|videocore|v3d|tegra|immortalis|xclipse/.test(g)) return 'low';
  return 'medium';
}

/** One tier below, or null at the bottom. */
export function lowerQuality(level: QualityLevel): QualityLevel | null {
  const i = QUALITY_ORDER.indexOf(level);
  return i > 0 ? (QUALITY_ORDER[i - 1] ?? null) : null;
}

/**
 * The canvas's own MSAA is fixed when the WebGL context is created, so a step down to a tier that draws without it
 * leaves the samples (and their cost) in place until the page is reloaded.
 */
export function canvasMsaaOutlivesStep(to: QualityLevel, canvasSamples: number): boolean {
  return canvasSamples > 0 && !qualityProfile(to).canvasMsaa;
}

/** What the game last picked for a GPU (persisted by the App under its own storage key, never inside Settings). */
export interface AutoRecord {
  gpu: string;
  level: QualityLevel;
}

export function parseAutoRecord(v: unknown): AutoRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const level = QUALITY_ORDER.find((q) => q === r.level);
  return typeof r.gpu === 'string' && level !== undefined ? { gpu: r.gpu, level } : null;
}

/**
 * The tier to start with in auto mode: the recorded one while the GPU is the same one it was recorded for (a step the
 * governor made stays), else the guess for this GPU.
 */
export function bootQuality(record: AutoRecord | null, gpu: string): QualityLevel {
  return record !== null && record.gpu === gpu ? record.level : guessQuality(gpu);
}

/** WebGL renderer string, read from a throwaway context; '' when it cannot be read. */
export function readGpuName(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}
