/**
 * Real light from the trackside lamps (pure, no three.js): a fixed pool of spot lights (QualityProfile.lampLights,
 * constant for the scene's lifetime, so the light count never changes and no shader recompiles) is handed each frame
 * to the lamp sites nearest the view's focus. A light fades out as its site nears the next-nearest site's distance
 * (the cut), so a site entering or leaving the pool never pops: at the swap both weights are 0. Far lamps keep their
 * glowing heads and the painted light pools on the road.
 */

/** A lamp head and the point on the track it aims at (world metres). */
export interface LampSite {
  x: number;
  y: number;
  z: number;
  ax: number;
  ay: number;
  az: number;
  /** floodlight tower (night) or lamp post (dusk, street circuits) */
  tower: boolean;
}

/** Distance (m) over which a pooled light fades out before the cut. */
export const LAMP_LIGHT_FADE = 25;
/**
 * Spot lights per kind: luminous intensity (cd; three's physical units, the night key light is ~2.8 lx-equivalent),
 * cone half-angle (rad), penumbra share and colour (sRGB). A tower 22 m up adds ~2.5 at the road under it, a 10 m lamp
 * post ~1.2: brighter pools under the lights, the key light keeps the rest readable.
 */
export const LAMP_LIGHT = {
  tower: { intensity: 1300, angle: 0.95, penumbra: 0.75, color: '#f4f1ea' },
  post: { intensity: 130, angle: 1.05, penumbra: 0.8, color: '#ffe2bd' },
} as const;

/** One assignment: site index (−1 = unused) and its weight 0..1. */
export interface LampSlot {
  site: number;
  weight: number;
}

/**
 * Hand the `slots.length` lights to the sites nearest (x, z) (horizontal distance; written into `slots`, nearest first).
 * `scratch` is reused between calls (no per-frame allocation once it has grown to slots.length + 1).
 */
export function pickLampLights(sites: readonly LampSite[], x: number, z: number, slots: LampSlot[], scratch: number[] = []): LampSlot[] {
  const n = slots.length;
  for (const s of slots) {
    s.site = -1;
    s.weight = 0;
  }
  if (n === 0 || sites.length === 0 || !Number.isFinite(x) || !Number.isFinite(z)) return slots;
  // insertion into the n + 1 nearest (the extra one sets the cut)
  const keep = n + 1;
  scratch.length = 0;
  const dist = (i: number): number => Math.hypot(sites[i].x - x, sites[i].z - z);
  for (let i = 0; i < sites.length; i++) {
    const d = dist(i);
    if (!Number.isFinite(d)) continue;
    if (scratch.length === keep && d >= dist(scratch[keep - 1])) continue;
    let j = Math.min(scratch.length, keep - 1);
    scratch[j] = i;
    while (j > 0 && dist(scratch[j - 1]) > d) {
      scratch[j] = scratch[j - 1];
      scratch[j - 1] = i;
      j--;
    }
  }
  const cut = scratch.length > n ? dist(scratch[n]) : Number.POSITIVE_INFINITY;
  for (let k = 0; k < n && k < scratch.length; k++) {
    const d = dist(scratch[k]);
    slots[k].site = scratch[k];
    slots[k].weight = Number.isFinite(cut) ? Math.min(1, Math.max(0, (cut - d) / LAMP_LIGHT_FADE)) : 1;
  }
  return slots;
}
