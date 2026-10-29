/**
 * Grade-separated crossing (BuiltTrack.deck = the upper road of a bridge / figure-8 crossover): a concrete slab under
 * the road, fascias along the parapets, abutment walls down to the ground wherever the lower road does not pass under
 * the deck, and cap walls where the deck run meets the embankment. The parapets themselves are the normal concrete
 * barriers (barriers.ts forces them on deck samples at the engine's close wall line, ≤ 2.5 m run-off) and, like the
 * fascias, stop at the slab over the openings (`deckOpenings`). The terrain follows
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

/** Signed lateral (m) of the fascia on `side` of deck sample k. */
function fasciaLat(ctx: SceneryContext, k: number, side: number): number {
  const f = ctx.frame;
  return side * ((side > 0 ? f.barrierR[k] : f.barrierL[k]) + FASCIA_OUT);
}

/**
 * The openings the crossing road passes through: per deck sample and side (`k * 2 + (side > 0 ? 1 : 0)`), 1 within 2
 * samples of a fascia point over the crossing road. The fascia and the parapet (barriers.ts) stop at the slab there;
 * everywhere else both reach down to the ground.
 */
export function deckOpenings(ctx: SceneryContext): Uint8Array {
  const { track: t, frame: f } = ctx;
  const n = t.count;
  const open = new Uint8Array(n * 2);
  if (!f.hasDeck) return open;
  const over = new Uint8Array(n * 2);
  for (let k = 0; k < n; k++) {
    if (!f.deck[k]) continue;
    for (const side of [-1, 1] as const) {
      sidePoint(t, k, fasciaLat(ctx, k, side), 0, _p);
      if (!f.isClearOfOther(_p.x, _p.z, OPENING_MARGIN, k, OWN_ROAD_LOOP)) over[k * 2 + (side > 0 ? 1 : 0)] = 1;
    }
  }
  for (let k = 0; k < n; k++) {
    if (!f.deck[k]) continue;
    for (const s of [0, 1]) {
      for (let d = -2; d <= 2 && !open[k * 2 + s]; d++) open[k * 2 + s] = over[wrapIndex(k + d, n) * 2 + s];
    }
  }
  return open;
}

export function buildDeck(ctx: SceneryContext, heightAtXZ: (x: number, z: number) => number): THREE.Mesh | null {
  const { track: t, frame: f, disposer } = ctx;
  if (!f.hasDeck) return null;
  const n = t.count;
  const b = new GeoBuilder();
  const open = deckOpenings(ctx);
  const runs = segmentRuns(n, (i) => f.deck[i] === 1 && f.deck[wrapIndex(i + 1, n)] === 1);
  for (const [i0, len] of runs) {
    const outer = (k: number, side: number): number => fasciaLat(ctx, k, side);
    // fascia bottom per side and sample: down to the ground unless the lower road passes under this stretch
    const bottoms: Float64Array[] = [];
    for (const side of [-1, 1] as const) {
      const held = new Float64Array(len + 1);
      for (let j = 0; j <= len; j++) {
        const k = wrapIndex(i0 + j, n);
        sidePoint(t, k, outer(k, side), 0, _p);
        const ground = heightAtXZ(_p.x, _p.z) - FOOT_BELOW_GROUND;
        held[j] = open[k * 2 + (side > 0 ? 1 : 0)] ? -DECK_SLAB : Math.min(-DECK_SLAB, ground - t.py[k]);
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
