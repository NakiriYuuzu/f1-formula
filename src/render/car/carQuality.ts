/**
 * Quality-dependent car rendering parameters (pure, no three.js): level-of-detail switch distances and the
 * screen-size based level selection used by the car's THREE.LOD, plus the paint / surface response tables
 * baked into the shared surface maps (livery atlas regions and tyre atlas columns).
 */
import type { LiveryFinish, QualityLevel } from '../../core/types';
import type { Swatch } from './atlas';

/**
 * Camera distance (m, at CAR_LOD_REFERENCE_FOV) where a car switches to LOD1 (simplified body) and LOD2
 * (low-poly silhouette). Lower quality switches sooner.
 */
export const CAR_LOD_DISTANCES: Record<QualityLevel, readonly [number, number]> = {
  low: [35, 110],
  medium: [45, 140],
  high: [60, 180],
  ultra: [80, 240],
};
/** Fraction of a level's switch distance a car must come back inside before it returns to the finer level. */
export const CAR_LOD_HYSTERESIS = 0.1;
/**
 * Vertical FOV (deg) the distances are tuned for. Narrower lenses (tv cameras zoom to 5–55°) scale the measured
 * distance down by tan(fov / 2) / tan(ref / 2), so a zoomed-in car keeps its full detail.
 */
export const CAR_LOD_REFERENCE_FOV = 70;

export function carLodDistances(quality: QualityLevel): readonly [number, number] {
  return CAR_LOD_DISTANCES[quality] ?? CAR_LOD_DISTANCES.high;
}

/** Distance multiplier for a perspective camera's vertical FOV (1 at the reference FOV). */
export function lodFovScale(fovDeg: number): number {
  const fov = Number.isFinite(fovDeg) ? Math.min(170, Math.max(1, fovDeg)) : CAR_LOD_REFERENCE_FOV;
  const rad = Math.PI / 180;
  return Math.tan((fov * rad) / 2) / Math.tan((CAR_LOD_REFERENCE_FOV * rad) / 2);
}

/**
 * LOD index for an (FOV-scaled) distance. `thresholds[i]` is where level i + 1 starts (ascending). Only the
 * currently shown level gets hysteresis (stays until the distance drops below threshold × (1 − hysteresis)),
 * like THREE.LOD. A non-finite distance keeps the current level.
 */
export function selectLodLevel(distance: number, thresholds: readonly number[], current: number, hysteresis: number): number {
  if (!Number.isFinite(distance)) return Math.max(0, Math.min(thresholds.length, current | 0));
  const h = Number.isFinite(hysteresis) ? Math.min(0.9, Math.max(0, hysteresis)) : 0;
  let level = 0;
  for (let i = 0; i < thresholds.length; i++) {
    const t = i + 1 === current ? thresholds[i] * (1 - h) : thresholds[i];
    if (distance >= t) level = i + 1;
    else break;
  }
  return level;
}

/**
 * Quality guess for callers that do not pass CarModelOptions.quality: the scenes size the livery atlas
 * (low / medium 512, high / ultra ≥ 1024) and anisotropy (1 / 2 / 4 / 8) from the quality profile.
 */
export function inferCarQuality(textureSize: number, anisotropy: number): QualityLevel {
  if (textureSize >= 1024) return anisotropy >= 8 ? 'ultra' : 'high';
  return anisotropy >= 2 ? 'medium' : 'low';
}

// ───────────────────────────── paint ─────────────────────────────

/** Clear-coated livery paint (MeshPhysicalMaterial) on these qualities; MeshStandardMaterial below them. */
export function usesClearcoatPaint(quality: QualityLevel): boolean {
  return quality === 'high' || quality === 'ultra';
}

/** Clear-coat layer of the livery material on high / ultra (scaled per atlas region by CAR_SURFACE[..][2]). */
export const CAR_PAINT = {
  clearcoat: 1.0,
  clearcoatRoughness: 0.08,
  /** environment reflection strength of the livery material (all qualities) */
  envMapIntensity: 1.0,
} as const;

/**
 * Surface response per livery-atlas region: [roughness, metalness, clear-coat amount 0..1]. Baked into the
 * shared surface map (G = roughness, B = metalness, R = clear coat). Carbon is a darker satin weave under a
 * thin coat, black covers tyres / intakes / cockpit walls (matte), the visor is glossy.
 */
export const CAR_SURFACE: Record<Swatch | 'paint' | 'fin' | 'helmet' | 'underside', readonly [number, number, number]> = {
  paint: [0.3, 0.05, 1],
  primary: [0.3, 0.05, 1],
  secondary: [0.3, 0.05, 1],
  accent: [0.3, 0.05, 1],
  fin: [0.3, 0.05, 1],
  carbon: [0.58, 0.15, 0.3],
  underside: [0.58, 0.15, 0.3],
  satin: [0.7, 0.12, 0.12],
  metal: [0.28, 0.85, 0],
  visor: [0.06, 0.7, 1],
  black: [0.9, 0.0, 0],
  white: [0.4, 0.0, 0.6],
  helmet: [0.18, 0.1, 1],
  halo: [0.3, 0.05, 1],
  frontWing: [0.3, 0.05, 1],
  rearWing: [0.3, 0.05, 1],
  rearFlap: [0.3, 0.05, 1],
};

/**
 * Livery finish (Livery.finish): multipliers on the livery material's roughness (the surface map's G channel; the
 * shader clamps at 1) and on its clear coat. Gloss is the paint as tuned above.
 */
export const CAR_FINISH: Record<LiveryFinish, { roughness: number; clearcoat: number }> = {
  gloss: { roughness: 1, clearcoat: 1 },
  satin: { roughness: 1.6, clearcoat: 0.4 },
  matte: { roughness: 2.3, clearcoat: 0 },
};

/** Tyre atlas columns: [roughness, metalness]. Rubber stays matte. */
export const TYRE_SURFACE: Record<'rubber' | 'band' | 'rim' | 'nut', readonly [number, number]> = {
  rubber: [0.95, 0],
  band: [0.7, 0],
  rim: [0.38, 0.7],
  nut: [0.3, 0.9],
};

// ───────────────────────────── surface detail ─────────────────────────────

/**
 * Surface detail shader on the livery / tyre materials per quality: 'full' (high / ultra: carbon weave with rounded
 * tows, metallic paint flakes and colour flop, tyre rubber sheen and graining), 'lite' (medium: the weave's shades
 * only), 'off' (low: unchanged).
 */
export type CarSurfaceDetail = 'full' | 'lite' | 'off';

export function carSurfaceDetail(quality: QualityLevel): CarSurfaceDetail {
  if (quality === 'high' || quality === 'ultra') return 'full';
  return quality === 'medium' ? 'lite' : 'off';
}

/**
 * 2 × 2 twill weave on the carbon and satin-carbon regions (tri-planar in car space): tow width (m, a little coarser
 * than real 12K tow so it reads in close-ups), ± shade of the two tow directions, brightness of the gaps between
 * tows, and the normal tilt across a rounded tow ('full').
 */
export const CARBON_WEAVE = { tow: 0.012, contrast: 0.22, gap: 0.45, bump: 0.35 } as const;

/** Metallic flakes in the painted regions ('full'): flake size (m) and normal tilt under the clear coat. */
export const PAINT_FLAKE = { size: 0.0016, tilt: 0.24 } as const;
/** Paint flop ('full'): brightness of the painted regions at grazing / face-on view (deeper colour along the edges). */
export const PAINT_FLOP: readonly [number, number] = [0.8, 1.05];
/** Weave and flakes fade to their average once a cell spans fewer pixels than this. */
export const SURFACE_DETAIL_MIN_PX = 2;

/**
 * Tyre rubber ('full'): physical sheen (soft grazing-angle lustre of rubber), albedo lift of the rubber columns (worn
 * tyres look dark grey, not black), graining contrast and grain size (m) on tread and sidewalls.
 */
export const TYRE_RUBBER = { sheen: 0.7, sheenRoughness: 0.55, sheenColor: 0.22, albedo: 1.35, grain: 0.2, grainSize: 0.0035 } as const;
