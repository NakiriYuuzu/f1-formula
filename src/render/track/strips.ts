/**
 * Ribbons along the track: a strip between two profile points (lateral offset, height above the road) swept over a run
 * of samples. Used by the crossing bridge, tunnels, the old banking and quays.
 *
 * Facing: walking A -> B in the (lateral, up) plane with lateral to the right and up up, 'right' means the face looks to
 * the right-hand side of that edge (an upward edge at the right of the road with 'right' faces outwards; a horizontal
 * edge running to +lateral with 'right' faces down, with 'left' faces up).
 */
import * as THREE from 'three';
import type { GeoBuilder } from '../core/geometry';
import { sidePoint, wrapIndex, type SceneryContext } from './context';

export type Profile = (k: number, j: number) => readonly [lat: number, y: number];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Sweep the edge A -> B over `len` segments starting at sample i0. u runs along the track (s / uTile), v from vA to vB. */
export function strip(
  b: GeoBuilder,
  ctx: SceneryContext,
  i0: number,
  len: number,
  A: Profile,
  B: Profile,
  face: 'left' | 'right',
  uTile = 8,
  vA = 0,
  vB = 1,
): void {
  const t = ctx.track;
  let prev = -1;
  for (let j = 0; j <= len; j++) {
    const k = wrapIndex(i0 + j, t.count);
    const [la, ya] = A(k, j);
    const [lb, yb] = B(k, j);
    const dl = lb - la;
    const dy = yb - ya;
    const inv = 1 / (Math.hypot(dl, dy) || 1);
    // outward normal in the (lateral, up) plane, then to world
    const sg = face === 'right' ? 1 : -1;
    const nl = dy * inv * sg;
    const ny = -dl * inv * sg;
    const nx = t.rx[k] * nl;
    const nz = t.rz[k] * nl;
    const u = (t.s[wrapIndex(i0, t.count)] + j * t.spacing) / uTile;
    sidePoint(t, k, la, ya, _a);
    sidePoint(t, k, lb, yb, _b);
    const row = b.vertex(_a.x, _a.y, _a.z, nx, ny, nz, u, vA);
    b.vertex(_b.x, _b.y, _b.z, nx, ny, nz, u, vB);
    if (prev >= 0) {
      if (face === 'right') b.quad(prev, row, row + 1, prev + 1);
      else b.quad(prev, prev + 1, row + 1, row);
    }
    prev = row;
  }
}

/** Cap polygon (a flat convex cross-section) at sample k facing `dir` (+1 = along the track, -1 = back). */
export function cap(b: GeoBuilder, ctx: SceneryContext, k: number, pts: readonly (readonly [number, number])[], dir: 1 | -1, lift = 0): void {
  const t = ctx.track;
  const kk = wrapIndex(k, t.count);
  const nx = t.tx[kk] * dir;
  const nz = t.tz[kk] * dir;
  const base = b.vertexCount;
  for (const [lat, y] of pts) {
    sidePoint(t, kk, lat, y, _a);
    // `lift` pushes the face along its normal (m) so a cap in front of another one never z-fights
    b.vertex(_a.x + nx * lift, _a.y, _a.z + nz * lift, nx, 0, nz, lat / 8, y / 8);
  }
  // pts are given counter-clockwise in the (lateral, up) plane; viewed from +T that plane is mirrored
  for (let i = 1; i + 1 < pts.length; i++) {
    if (dir > 0) b.tri(base, base + i + 1, base + i);
    else b.tri(base, base + i, base + i + 1);
  }
}
