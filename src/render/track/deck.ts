/**
 * Grade-separated crossing (BuiltTrack.deck = the upper road of a bridge / figure-8 crossover): a concrete slab under
 * the road, fascias along the parapets, abutment walls down to the ground wherever the lower road does not pass under
 * the deck, and cap walls where the deck run meets the embankment. The parapets themselves are the normal concrete
 * barriers (barriers.ts forces them on deck samples at the engine's close wall line, ≤ 2.5 m run-off). The terrain follows
 * the lower road (terrain.ts) and stays below the deck, so nothing pokes through either road.
 */
import * as THREE from 'three';
import { GeoBuilder } from '../core/geometry';
import { concreteTexture } from '../core/surfaceTextures';
import { segmentRuns, sidePoint, wrapIndex, type SceneryContext } from './context';
import { cap, strip } from './strips';

/** Slab thickness (m) under the road surface (deeper than the barrier feet, FOOT_Y = -1.2 in barriers.ts). */
export const DECK_SLAB = 1.3;
/** Fascia stands this far (m) outside the barrier's outer face. */
const FASCIA_OUT = 0.4;
/** Abutment walls stay this far (m) clear of the lower road's barrier line (the opening the road passes through). */
const OPENING_MARGIN = 3.5;
/** Samples of the lower road closer than this along the lap are the deck's own approaches, not a crossing road. */
const OWN_ROAD_LOOP = 80;
/** Abutments reach this far (m) below the ground height beside them. */
const FOOT_BELOW_GROUND = 0.4;
const _p = new THREE.Vector3();

export function buildDeck(ctx: SceneryContext, heightAtXZ: (x: number, z: number) => number): THREE.Mesh | null {
  const { track: t, frame: f, disposer } = ctx;
  if (!f.hasDeck) return null;
  const n = t.count;
  const b = new GeoBuilder();
  const runs = segmentRuns(n, (i) => f.deck[i] === 1 && f.deck[wrapIndex(i + 1, n)] === 1);
  for (const [i0, len] of runs) {
    const outer = (k: number, side: number): number => side * ((side > 0 ? f.barrierR[k] : f.barrierL[k]) + FASCIA_OUT);
    // fascia bottom per side and sample: down to the ground unless the lower road passes under this stretch
    const bottoms: Float64Array[] = [];
    for (const side of [-1, 1] as const) {
      const bottom = new Float64Array(len + 1);
      const over = new Uint8Array(len + 1);
      for (let j = 0; j <= len; j++) {
        const k = wrapIndex(i0 + j, n);
        sidePoint(t, k, outer(k, side), 0, _p);
        const ground = heightAtXZ(_p.x, _p.z) - FOOT_BELOW_GROUND;
        bottom[j] = Math.min(-DECK_SLAB, ground - t.py[k]);
        over[j] = f.isClearOfOther(_p.x, _p.z, OPENING_MARGIN, k, OWN_ROAD_LOOP) ? 0 : 1;
      }
      // keep the opening: the slab edge holds for 2 samples either side of every crossing-road sample
      const held = Float64Array.from(bottom);
      for (let j = 0; j <= len; j++) {
        for (let d = -2; d <= 2; d++) {
          const q = j + d;
          if (q >= 0 && q <= len && over[q]) {
            held[j] = -DECK_SLAB;
            break;
          }
        }
      }
      bottoms.push(held);
      strip(b, ctx, i0, len, (k, j) => [outer(k, side), held[j]], (k) => [outer(k, side), 0], side > 0 ? 'right' : 'left', 8, 0, 0.5);
    }
    // underside of the slab between both fascias
    strip(b, ctx, i0, len, (k) => [outer(k, -1), -DECK_SLAB], (k) => [outer(k, 1), -DECK_SLAB], 'right', 8, 0, 3);
    // walls closing both ends of the run (the deck meets the embankment)
    for (const [j, dir] of [[0, -1], [len, 1]] as const) {
      const k = wrapIndex(i0 + j, n);
      const bot = Math.min(bottoms[0][j], bottoms[1][j]);
      cap(b, ctx, k, [[outer(k, -1), bot], [outer(k, 1), bot], [outer(k, 1), 0], [outer(k, -1), 0]], dir);
    }
  }
  const g = b.build();
  if (!g) return null;
  disposer.add(g);
  const mat = disposer.add(new THREE.MeshStandardMaterial({ name: 'deck', map: disposer.add(concreteTexture(ctx.anisotropy, '#bdbcb6')), roughness: 0.9 }));
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'deck';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
