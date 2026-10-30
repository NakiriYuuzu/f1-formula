/**
 * Render quality presets: maps Settings.quality to concrete budgets (shadow map + softness, prop density,
 * particle pools, terrain resolution, texture sizes, surface detail maps, scenery reflection probe,
 * post-processing chain incl. ambient occlusion).
 */
import type { QualityLevel, Settings } from '../../core/types';

/**
 * Camera far plane (m) of every race view. Large real circuits (2.6 × 2 km, laps up to 7 km) put the farthest scenery
 * (backdrop ring, mountains) ~5 km from a camera on the opposite side of the circuit.
 */
export const CAMERA_FAR = 6500;

export interface QualityProfile {
  level: QualityLevel;
  /** 0 = shadows off */
  shadowMapSize: number;
  /** PCF filter radius of the sun shadow in shadow-map texels (soft penumbra; 1 = three's default) */
  shadowRadius: number;
  /** fraction of the full prop / crowd density (0..1) */
  propDensity: number;
  /** pooled smoke + spray particles */
  smokeParticles: number;
  /** pooled spark particles */
  sparkParticles: number;
  /** rain streaks around each camera */
  rainStreaks: number;
  /** terrain grid cell edge (m) */
  terrainCell: number;
  /** livery atlas edge (px) */
  liveryTexSize: number;
  /** trackside board atlas edge (px) */
  boardTexSize: number;
  /** texture anisotropy (clamped to the GPU maximum) */
  anisotropy: number;
  /** road asphalt colour map edge (px); its detail normal / roughness maps tile 4 × finer */
  asphaltTexSize: number;
  /** normal + roughness detail maps on road, kerbs, run-off, walls and terrain */
  surfaceDetail: boolean;
  /** car / glass reflections show the real circuit (PMREM of the scenery) instead of the sky alone */
  sceneProbe: boolean;
  /** post chain (bloom + grade + vignette) for single full-screen views; false = direct render */
  post: boolean;
  /** bloom render-target scale relative to the drawing buffer (UnrealBloomPass halves it again internally) */
  bloomScale: number;
  /** screen-edge vignette in the post chain */
  vignette: boolean;
  /** ambient-occlusion (GTAO) resolution relative to the drawing buffer; 0 = off */
  aoScale: number;
}

const PROFILES: Record<QualityLevel, QualityProfile> = {
  low: {
    level: 'low',
    shadowMapSize: 0,
    shadowRadius: 1,
    propDensity: 0.25,
    smokeParticles: 192,
    sparkParticles: 48,
    rainStreaks: 500,
    terrainCell: 16,
    liveryTexSize: 512,
    boardTexSize: 1024,
    anisotropy: 1,
    asphaltTexSize: 512,
    surfaceDetail: false,
    sceneProbe: false,
    post: false,
    bloomScale: 0,
    vignette: false,
    aoScale: 0,
  },
  medium: {
    level: 'medium',
    shadowMapSize: 1024,
    shadowRadius: 1.5,
    propDensity: 0.5,
    smokeParticles: 384,
    sparkParticles: 96,
    rainStreaks: 1000,
    terrainCell: 12,
    liveryTexSize: 512,
    boardTexSize: 1024,
    anisotropy: 2,
    asphaltTexSize: 512,
    surfaceDetail: true,
    sceneProbe: true,
    post: true,
    bloomScale: 0.5,
    vignette: true,
    aoScale: 0,
  },
  high: {
    level: 'high',
    shadowMapSize: 2048,
    shadowRadius: 2.5,
    propDensity: 0.8,
    smokeParticles: 768,
    sparkParticles: 192,
    rainStreaks: 1800,
    terrainCell: 8,
    liveryTexSize: 1024,
    boardTexSize: 2048,
    anisotropy: 4,
    asphaltTexSize: 1024,
    surfaceDetail: true,
    sceneProbe: true,
    post: true,
    bloomScale: 1,
    vignette: true,
    aoScale: 0.5,
  },
  ultra: {
    level: 'ultra',
    shadowMapSize: 4096,
    shadowRadius: 3,
    propDensity: 1,
    smokeParticles: 1200,
    sparkParticles: 320,
    rainStreaks: 2800,
    terrainCell: 6,
    liveryTexSize: 1024,
    boardTexSize: 2048,
    anisotropy: 8,
    asphaltTexSize: 1024,
    surfaceDetail: true,
    sceneProbe: true,
    post: true,
    bloomScale: 1,
    vignette: true,
    aoScale: 0.75,
  },
};

export function qualityProfile(level: QualityLevel): QualityProfile {
  return PROFILES[level] ?? PROFILES.high;
}

/** Effective shadow map size: 0 when shadows are disabled in the settings or by quality. */
export function shadowSizeFor(settings: Settings): number {
  return settings.shadows ? qualityProfile(settings.quality).shadowMapSize : 0;
}
