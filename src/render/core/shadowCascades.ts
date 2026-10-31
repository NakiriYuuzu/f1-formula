/**
 * Sun shadow cascades (pure maths, no three.js): a near cascade re-rendered every frame around the viewed car (cars and
 * scenery) and a far cascade that only holds static scenery, rendered once and again only when the view has moved far
 * enough or the sun changed. The shader (sunCascadeShader.ts) samples the near map inside its box, fades to the far map
 * across the outer band and uses the far map alone beyond it.
 */

/** Half edge (m) of the near cascade box (was one ±70 m box for everything). */
export const NEAR_CASCADE_HALF = 50;
/** Half edge (m) of the far, static-only cascade box. */
export const FAR_CASCADE_HALF = 320;
/**
 * Normalised box radius (0 = centre, 1 = edge, max-norm in light space) where the near cascade starts fading into the
 * far one; it is gone by the edge. Must match SUN_CASCADE_FADE in the shader.
 */
export const CASCADE_FADE_START = 0.78;
/**
 * The far cascade is re-centred (and re-rendered) once the focus has moved this fraction of its half edge away from
 * the centre it was rendered for, so the view always has ≥ (1 − fraction) × FAR_CASCADE_HALF of far shadows around it.
 */
export const FAR_CASCADE_RECENTRE = 0.35;
/** Sun direction change (rad) that also forces a far re-render (the key light never moves within a race today). */
export const FAR_CASCADE_SUN_EPS = 0.002;

/**
 * Far cascade light placement: distance (m) from the focus to the light and the shadow camera's depth range. Low sun
 * (dusk, 7°) stretches the box ~8× along the sun's azimuth on the ground, so the depth range is generous; the bias is
 * `bias × (far − near)` metres (−0.00008 × 5000 m = 40 cm, invisible at the far cascade's ~30 cm texels).
 */
export const FAR_SHADOW = { distance: 3000, near: 500, far: 5500, bias: -0.00008, normalBias: 0.35 } as const;

/** Texel edge (m) of a cascade box of half edge `half` rendered at `mapSize` px. */
export function cascadeTexel(half: number, mapSize: number): number {
  const size = Number.isFinite(mapSize) && mapSize > 0 ? mapSize : 1;
  return (2 * Math.max(0, half)) / size;
}

/**
 * Near-cascade weight 0..1 of a point at normalised light-space box coordinates (u, v in 0..1, the shadow map UV):
 * 1 inside the inner square, 0 from the box edge outward (then only the far cascade shades it).
 */
export function nearCascadeWeight(u: number, v: number): number {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return 0;
  const r = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
  if (r <= CASCADE_FADE_START) return 1;
  if (r >= 1) return 0;
  const t = (r - CASCADE_FADE_START) / (1 - CASCADE_FADE_START);
  return 1 - t * t * (3 - 2 * t);
}

/** Planar (x, z) point. */
export interface CascadeFocus {
  x: number;
  z: number;
}

/**
 * Whether the far cascade has to be rendered again for `focus`: never rendered (`centre` null), the focus moved more
 * than FAR_CASCADE_RECENTRE × FAR_CASCADE_HALF away from the centre it was rendered for, or the sun turned by more than
 * FAR_CASCADE_SUN_EPS (`sunTurn`, rad). Non-finite input never triggers a render.
 */
export function farCascadeStale(centre: CascadeFocus | null, focus: CascadeFocus, sunTurn = 0): boolean {
  if (!Number.isFinite(focus.x) || !Number.isFinite(focus.z)) return false;
  if (!centre) return true;
  if (Number.isFinite(sunTurn) && sunTurn > FAR_CASCADE_SUN_EPS) return true;
  const lim = FAR_CASCADE_RECENTRE * FAR_CASCADE_HALF;
  return (focus.x - centre.x) ** 2 + (focus.z - centre.z) ** 2 > lim * lim;
}

/** Object layer of static shadow casters: the far cascade's shadow camera sees only this layer (no cars, crews, fx). */
export const STATIC_SHADOW_LAYER = 3;
