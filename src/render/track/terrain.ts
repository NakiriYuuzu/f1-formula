/**
 * Terrain heightfield around the track: heightAt() sampled on a coarse grid and bilinearly refined,
 * lowered ~0.35 m under the road / run-off / pit corridor (no z-fighting), blended back outside it,
 * sloping into a far ground plane (or the sea for coastal / harbour biomes; their inland edge stays just above
 * the water and continues into the backdrop's land shelf) at the edges. Split into a grid of chunks so views
 * cull what is behind them. Ground shading: macro colour variation (vertex colours), two-scale detail noise,
 * mowing stripes along the track and a shoreline tint (sceneryMaterials.patchGroundMaterial). The sea gets a
 * drifting wave normal map (sun glint) and the distant backdrop ring is attached here (backdrop.ts).
 */
import * as THREE from 'three';
import type { Biome, BuiltTrack, QualityLevel } from '../../core/types';
import { heightAt } from '../../track/track';
import { smoothstep } from '../../core/math';
import { groundDetailTexture, groundTexture, GROUND_STYLES, seaNormalTexture } from '../core/surfaceTextures';
import { buildBackdrop } from './backdrop';
import type { SceneryContext, TerrainEdit } from './context';
import { patchGroundMaterial } from './sceneryMaterials';
import { fbm2D, groundTint, landEdgeBlend, landWeight, valueNoise2D } from './sceneryMath';

export interface TerrainParts {
  group: THREE.Group;
  /** sea level when water is present, else null */
  seaLevel: number | null;
  /** terrain height query using the generated field (bilinear), for prop placement */
  heightAtXZ(x: number, z: number): number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  material: THREE.MeshStandardMaterial;
}

const MARGIN = 400;
const COARSE = 24;
/**
 * Vertex budget of the terrain grid by quality: large real circuits (2.6 × 2 km + margins) coarsen the cell size beyond
 * QualityProfile.terrainCell so the triangle count stays near the budget (two triangles per vertex).
 */
export const TERRAIN_MAX_VERTICES: Record<QualityLevel, number> = { low: 18000, medium: 36000, high: 64000, ultra: 100000 };
/** Terrain under the upper road of a crossing is capped this far (m) below the deck's road surface. */
const DECK_TERRAIN_CAP = 0.35;
/** Soft shoreline: a carved basin rises from its floor to the plateau over this distance (m). */
const BASIN_BANK = 5;
/** Most a vertex next to a corridor is pulled down (m) to the corridor's lowered height. */
const CORRIDOR_RING_DROP = 0.45;
/** Terrain stays this far (m) below the road / kerb / barrier line wherever a triangle covers it. */
const CORRIDOR_CLEARANCE = 0.12;
/** Terrain chunk grid (per axis) by quality: more chunks = better view culling, a few more draw calls. */
export const TERRAIN_CHUNKS: Record<QualityLevel, number> = { low: 1, medium: 3, high: 3, ultra: 4 };
/** Mowing stripes fade out between these distances (m) beyond the occupied track corridor. */
export const MOW_FADE: readonly [number, number] = [8, 48];
/** Mowing-stripe strength per biome (0 = none: sand / urban ground). */
export const MOW_BIOME: Record<Biome, number> = { temperate: 1, autumn: 0.75, coastal: 0.8, desert: 0, city: 0, tropical: 1 };
/** Macro colour variation wavelengths (m): broad patches, finer mottling. */
export const GROUND_MACRO_SCALE: readonly [number, number] = [230, 70];
/** Shore tint (water biomes) fades out this high (m) above sea level. */
export const SHORE_HEIGHT = 2.2;
const SHORE_COLOR: Record<Biome, string> = { temperate: '#b9a77e', autumn: '#b9a77e', desert: '#d9c193', coastal: '#cdbd92', city: '#56575b', tropical: '#a5603f' };
/** Water biomes: inland terrain edge (and the backdrop land shelf) sits this far (m) above sea level. */
export const LAND_EDGE_ABOVE_SEA = 1.2;
/** Sea: metres per wave normal-map repeat, drift (repeats / s), normal strength, roughness. */
export const SEA_TILE = 34;
export const SEA_DRIFT: readonly [number, number] = [0.012, 0.007];
export const SEA_NORMAL_SCALE = 0.34;
export const SEA_ROUGHNESS = 0.07;
const SEA_SIZE = 16000;
/** Backdrop reach margin (m) beyond the farthest centre-line sample (TV cameras, run-off). */
const BACKDROP_REACH_MARGIN = 80;

/** World rectangle covered by the terrain mesh: the track bounds plus MARGIN on every side. */
export function terrainRect(t: BuiltTrack): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const b = t.bounds;
  return { minX: fin(b.minX, -500) - MARGIN, maxX: fin(b.maxX, 500) + MARGIN, minZ: fin(b.minZ, -500) - MARGIN, maxZ: fin(b.maxZ, 500) + MARGIN };
}

export function buildTerrain(ctx: SceneryContext): TerrainParts {
  const { track: t, frame: f, disposer } = ctx;
  const { minX, maxX, minZ, maxZ } = terrainRect(t);
  const water = ctx.biome === 'coastal' || ctx.biome === 'city';
  const seaLevel = water ? f.minY - 3 : null;
  const farY = water ? f.minY - 12 : f.minY - 1.5;
  const landY = seaLevel !== null ? seaLevel + LAND_EDGE_ABOVE_SEA : farY;

  // sea direction: away from the pit straight, towards the far side of the bounds
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const seaDir = new THREE.Vector2(-(t.px[0] - cx), -(t.pz[0] - cz));
  if (seaDir.lengthSq() < 1) seaDir.set(-1, -0.4);
  seaDir.normalize();

  // coarse heightAt grid (includes the smooth coastal fall-off, which starts 150 m from the track)
  const cnx = Math.max(2, Math.ceil((maxX - minX) / COARSE) + 1);
  const cnz = Math.max(2, Math.ceil((maxZ - minZ) / COARSE) + 1);
  const coarse = new Float32Array(cnx * cnz);
  for (let j = 0; j < cnz; j++) {
    for (let i = 0; i < cnx; i++) {
      let h = 0;
      try {
        h = heightAt(t, minX + i * COARSE, minZ + j * COARSE);
      } catch {
        h = 0;
      }
      if (!Number.isFinite(h)) h = f.minY;
      if (water) {
        const x = minX + i * COARSE;
        const z = minZ + j * COARSE;
        const near = f.nearestWithin(x, z, 360);
        const dist = near ? Math.sqrt(near.dist2) : 360;
        const side = (x - cx) * seaDir.x + (z - cz) * seaDir.y;
        h -= smoothstep(150, 340, dist) * smoothstep(-50, 220, side) * 16;
      }
      coarse[j * cnx + i] = h;
    }
  }
  const sampleCoarse = (x: number, z: number): number => {
    const gx = Math.max(0, Math.min(cnx - 1.001, (x - minX) / COARSE));
    const gz = Math.max(0, Math.min(cnz - 1.001, (z - minZ) / COARSE));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const u = gx - i;
    const v = gz - j;
    const h00 = coarse[j * cnx + i];
    const h10 = coarse[j * cnx + i + 1];
    const h01 = coarse[(j + 1) * cnx + i];
    const h11 = coarse[(j + 1) * cnx + i + 1];
    return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
  };

  const budget = TERRAIN_MAX_VERTICES[ctx.quality.level] ?? TERRAIN_MAX_VERTICES.high;
  const cell = Math.max(4, ctx.quality.terrainCell, Math.sqrt(((maxX - minX) * (maxZ - minZ)) / budget));
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell) + 1);
  const nz = Math.max(2, Math.ceil((maxZ - minZ) / cell) + 1);
  const pos = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  const colors = new Float32Array(nx * nz * 3);
  /** per vertex: mow weight, stripe coordinate (s along the nearest track sample), shore weight */
  const ground = new Float32Array(nx * nz * 3);
  const heights = new Float32Array(nx * nz);
  /** 1 = vertex inside a corridor (lowered under the road / run-off ribbons) */
  const corridor = new Uint8Array(nx * nz);
  const tile = 24;
  const mowBiome = MOW_BIOME[ctx.biome] ?? 0;
  const seed = ctx.seed % 100000;
  for (let j = 0; j < nz; j++) {
    const z = Math.min(maxZ, minZ + j * cell);
    for (let i = 0; i < nx; i++) {
      const x = Math.min(maxX, minX + i * cell);
      const k = j * nx + i;
      let h = applyEdits(ctx.terrainEdits, x, z, sampleCoarse(x, z));
      // the lower road of a crossing shapes the ground; the upper road (deck) only caps it
      const near = f.nearestWithin(x, z, 70, f.hasDeck);
      if (near) {
        // every section covering the vertex lowers it (crossing roads at different heights: the lowest wins)
        let drop = h;
        f.eachCovering(x, z, 70, (idx, lateral) => {
          const lat = Math.abs(lateral);
          const occ = f.occupiedTo(idx, lateral >= 0 ? 1 : -1);
          const lo = Math.min(h, t.py[idx] - 0.35);
          if (lat < occ + 1.5) {
            drop = Math.min(drop, lo);
            corridor[k] = 1;
          } else if (lat < occ + 16) drop = Math.min(drop, lo + (h - lo) * smoothstep(occ + 1.5, occ + 16, lat));
        });
        h = drop;
        const lat = Math.abs(near.lateral);
        const occ = f.occupiedTo(near.index, near.lateral >= 0 ? 1 : -1);

        if (mowBiome > 0) {
          ground[k * 3] = mowBiome * (1 - smoothstep(MOW_FADE[0], MOW_FADE[1], lat - occ));
          ground[k * 3 + 1] = t.s[near.index] + (x - t.px[near.index]) * t.tx[near.index] + (z - t.pz[near.index]) * t.tz[near.index];
        }
      }
      if (f.hasDeck) {
        const up = f.nearestWithin(x, z, 70);
        if (up && f.deck[up.index] && Math.abs(up.lateral) < f.occupiedTo(up.index, up.lateral >= 0 ? 1 : -1) + 1.5) {
          h = Math.min(h, t.py[up.index] - DECK_TERRAIN_CAP);
        }
      }
      const edge = Math.min(x - minX, maxX - x, z - minZ, maxZ - z);
      const edgeY = water ? farY + (landY - farY) * landEdgeBlend(landWeight(x - cx, z - cz, seaDir.x, seaDir.y)) : farY;
      h = edgeY + (h - edgeY) * smoothstep(0, 90, edge);
      heights[k] = h;
      pos[k * 3] = x;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / tile;
      uv[k * 2 + 1] = -z / tile;
      const tint = groundTint(
        ctx.biome,
        fbm2D(x / GROUND_MACRO_SCALE[0], z / GROUND_MACRO_SCALE[0], 2, seed),
        valueNoise2D(x / GROUND_MACRO_SCALE[1], z / GROUND_MACRO_SCALE[1], seed + 17),
      );
      colors[k * 3] = tint[0];
      colors[k * 3 + 1] = tint[1];
      colors[k * 3 + 2] = tint[2];
    }
  }
  // A coarse triangle bridging two corridors at different heights must stay below the lower ribbon: vertices next
  // to a corridor vertex drop to its height, by at most CORRIDOR_RING_DROP (barrier feet / ribbon skirts reach it).
  const ringed = heights.slice();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let lowest = heights[k];
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const m = jj * nx + ii;
          if (corridor[m] && heights[m] < lowest) lowest = heights[m];
        }
      }
      ringed[k] = Math.max(lowest, heights[k] - CORRIDOR_RING_DROP);
    }
  }
  // No road, kerb or barrier sample may sit under the mesh: wherever a coarse triangle covers one, the vertex with the
  // largest weight is pulled down until the interpolated height is CORRIDOR_CLEARANCE below the road.
  const lowerUnder = (px: number, pz: number, limit: number): void => {
    const gx = Math.max(0, Math.min(nx - 1.001, (px - minX) / cell));
    const gz = Math.max(0, Math.min(nz - 1.001, (pz - minZ) / cell));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const u = gx - i;
    const v = gz - j;
    const lower = u + v <= 1;
    const a = j * nx + i + (lower ? 0 : nx + 1);
    const b = lower ? a + 1 : a - 1;
    const c = lower ? a + nx : a - nx;
    const wa = lower ? 1 - u - v : u + v - 1;
    const wb = lower ? u : 1 - v;
    const wc = lower ? v : 1 - u;
    const excess = ringed[a] * wa + ringed[b] * wb + ringed[c] * wc - limit;
    if (excess <= 0) return;
    const [w, m] = wa >= wb && wa >= wc ? [wa, a] : wb >= wc ? [wb, b] : [wc, c];
    ringed[m] -= excess / w;
  };
  for (let i = 0; i < t.count; i++) {
    if (f.deck[i]) continue;
    const limit = t.py[i] - CORRIDOR_CLEARANCE;
    const l = f.occupiedTo(i, -1);
    const r = f.occupiedTo(i, 1);
    const step = Math.max(1, cell * 0.5);
    for (let lat = -l; lat < r + step; lat += step) {
      const q = Math.min(lat, r);
      lowerUnder(t.px[i] + t.rx[i] * q, t.pz[i] + t.rz[i] * q, limit);
    }
  }
  for (let k = 0; k < heights.length; k++) {
    heights[k] = ringed[k];
    pos[k * 3 + 1] = ringed[k];
    if (seaLevel !== null) ground[k * 3 + 2] = smoothstep(seaLevel + SHORE_HEIGHT, seaLevel + 0.3, ringed[k]);
  }
  const normals = gridNormals(pos, nx, nz);
  const tex = disposer.add(groundTexture(ctx.biome, ctx.anisotropy));
  const detail = disposer.add(groundDetailTexture(ctx.anisotropy));
  const mat = disposer.add(new THREE.MeshStandardMaterial({ name: 'terrain', map: tex, vertexColors: true, roughness: 0.96, metalness: 0 }));
  patchGroundMaterial(mat, { detail, terrain: true, shoreColor: new THREE.Color(SHORE_COLOR[ctx.biome]) });
  const group = new THREE.Group();
  group.name = 'terrain';
  const chunks = Math.max(1, Math.round(TERRAIN_CHUNKS[ctx.quality.level] ?? 1));
  for (let cj = 0; cj < chunks; cj++) {
    for (let ci = 0; ci < chunks; ci++) {
      const i0 = Math.floor((ci * (nx - 1)) / chunks);
      const i1 = Math.floor(((ci + 1) * (nx - 1)) / chunks);
      const j0 = Math.floor((cj * (nz - 1)) / chunks);
      const j1 = Math.floor(((cj + 1) * (nz - 1)) / chunks);
      if (i1 <= i0 || j1 <= j0) continue;
      const geo = disposer.add(chunkGeometry(i0, i1, j0, j1, nx, { position: pos, normal: normals, uv, color: colors, groundData: ground }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'terrain';
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  // far ground (below the faded terrain edge) or sea
  const farGeo = disposer.add(new THREE.PlaneGeometry(16000, 16000, 1, 1));
  farGeo.rotateX(-Math.PI / 2);
  const farMat = disposer.add(
    new THREE.MeshStandardMaterial({ name: 'far-ground', color: new THREE.Color(GROUND_STYLES[ctx.biome].base).multiplyScalar(0.92), roughness: 1 }),
  );
  const far = new THREE.Mesh(farGeo, farMat);
  far.position.set(cx, farY - 0.05, cz);
  far.name = 'farGround';
  group.add(far);
  if (seaLevel !== null) {
    const seaGeo = disposer.add(new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, 1, 1));
    seaGeo.rotateX(-Math.PI / 2);
    const waves = disposer.add(seaNormalTexture(ctx.seed % 997));
    waves.repeat.set(SEA_SIZE / SEA_TILE, SEA_SIZE / SEA_TILE);
    const seaMat = disposer.add(
      new THREE.MeshStandardMaterial({
        name: 'sea',
        color: new THREE.Color(ctx.biome === 'city' ? '#1a3a52' : '#1b5375'),
        roughness: SEA_ROUGHNESS,
        metalness: 0.15,
        normalMap: waves,
        normalScale: new THREE.Vector2(SEA_NORMAL_SCALE, SEA_NORMAL_SCALE),
      }),
    );
    const sea = new THREE.Mesh(seaGeo, seaMat);
    sea.position.set(cx, seaLevel, cz);
    sea.name = 'sea';
    sea.receiveShadow = true;
    // purely visual swell drift (wall clock, keeps moving while paused)
    sea.onBeforeRender = () => {
      const now = performance.now() / 1000;
      waves.offset.set((now * SEA_DRIFT[0]) % 1, (now * SEA_DRIFT[1]) % 1);
    };
    group.add(sea);
  }

  let reach = 0;
  for (let i = 0; i < t.count; i++) reach = Math.max(reach, Math.hypot(t.px[i] - cx, t.pz[i] - cz));
  const backdrop = buildBackdrop(ctx, {
    cx,
    cz,
    hx: (maxX - minX) / 2,
    hz: (maxZ - minZ) / 2,
    farY,
    seaLevel,
    landY,
    seaDirX: seaDir.x,
    seaDirZ: seaDir.y,
    reach: reach + BACKDROP_REACH_MARGIN,
  });
  if (backdrop) group.add(backdrop);

  const heightAtXZ = (x: number, z: number): number => {
    const gx = Math.max(0, Math.min(nx - 1.001, (x - minX) / cell));
    const gz = Math.max(0, Math.min(nz - 1.001, (z - minZ) / cell));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const u = gx - i;
    const v = gz - j;
    const h00 = heights[j * nx + i];
    const h10 = heights[j * nx + i + 1];
    const h01 = heights[(j + 1) * nx + i];
    const h11 = heights[(j + 1) * nx + i + 1];
    // match the triangle split (a, c, b) / (b, c, d)
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  };
  return { group, seaLevel, heightAtXZ, bounds: { minX, maxX, minZ, maxZ }, material: mat };
}

/** Apply the landmark terrain edits (pads, basins, hillsides) to a height sample. */
function applyEdits(edits: readonly TerrainEdit[], x: number, z: number, h: number): number {
  let out = h;
  for (const e of edits) {
    const dx = x - e.cx;
    const dz = z - e.cz;
    const c = Math.cos(e.yaw);
    const sn = Math.sin(e.yaw);
    // local X = (cos, 0, -sin) (across / outward), local Z = (sin, 0, cos) (along)
    const lx = dx * c - dz * sn;
    const lz = dx * sn + dz * c;
    const dist = (hx: number, hz: number): number => {
      if (e.shape === 'ellipse') return (Math.hypot(lx / hx, lz / hz) - 1) * Math.min(hx, hz);
      const qx = Math.abs(lx) - hx;
      const qz = Math.abs(lz) - hz;
      return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
    };
    if (e.kind === 'pad') {
      const d = dist(e.hx, e.hz);
      out = out + (e.y - out) * (1 - smoothstep(0, e.blend, d));
      if (e.basinY !== undefined) {
        const inset = e.basinInset ?? 0;
        const db = dist(Math.max(1, e.hx - inset), Math.max(1, e.hz - inset));
        out = out + (e.basinY - out) * (1 - smoothstep(-BASIN_BANK, 0, db));
      }
    } else {
      const u = (lx + e.hx) / (2 * e.hx);
      if (u <= 0) continue;
      const rise = (e.gain ?? 0) * smoothstep(0, 1, Math.min(1, u)) * (1 - smoothstep(0, e.blend, lx - e.hx));
      out += rise * (1 - smoothstep(0, e.blend, Math.abs(lz) - e.hz));
    }
  }
  return out;
}

function fin(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Smooth per-vertex normals of the grid (central differences), shared by all chunks so seams stay invisible. */
function gridNormals(pos: Float32Array, nx: number, nz: number): Float32Array {
  const out = new Float32Array(pos.length);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const il = Math.max(0, i - 1);
      const ir = Math.min(nx - 1, i + 1);
      const jd = Math.max(0, j - 1);
      const ju = Math.min(nz - 1, j + 1);
      const l = (j * nx + il) * 3;
      const r = (j * nx + ir) * 3;
      const d = (jd * nx + i) * 3;
      const u = (ju * nx + i) * 3;
      // tangents along +x and +z; normal = dz × dx (points up)
      const ax = pos[r] - pos[l];
      const ay = pos[r + 1] - pos[l + 1];
      const bz = pos[u + 2] - pos[d + 2];
      const by = pos[u + 1] - pos[d + 1];
      let nxv = -ay * bz;
      let nyv = ax * bz;
      let nzv = -by * ax;
      const len = Math.hypot(nxv, nyv, nzv) || 1;
      nxv /= len;
      nyv /= len;
      nzv /= len;
      const k = (j * nx + i) * 3;
      out[k] = nxv;
      out[k + 1] = nyv;
      out[k + 2] = nzv;
    }
  }
  return out;
}

/** Geometry for the vertex block [i0..i1] × [j0..j1] of the terrain grid (row length nx). */
function chunkGeometry(i0: number, i1: number, j0: number, j1: number, nx: number, src: Record<string, Float32Array>): THREE.BufferGeometry {
  const cw = i1 - i0 + 1;
  const ch = j1 - j0 + 1;
  const geo = new THREE.BufferGeometry();
  for (const [name, data] of Object.entries(src)) {
    const size = data.length / (src.position.length / 3);
    const out = new Float32Array(cw * ch * size);
    for (let j = 0; j < ch; j++) {
      const from = ((j0 + j) * nx + i0) * size;
      out.set(data.subarray(from, from + cw * size), j * cw * size);
    }
    geo.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  const idx = new Uint32Array((cw - 1) * (ch - 1) * 6);
  let o = 0;
  for (let j = 0; j < ch - 1; j++) {
    for (let i = 0; i < cw - 1; i++) {
      const a = j * cw + i;
      const b = a + 1;
      const c = a + cw;
      const d = c + 1;
      // CCW from above: a(i,j) -> c(i,j+1) -> d -> b
      idx[o++] = a;
      idx[o++] = c;
      idx[o++] = b;
      idx[o++] = b;
      idx[o++] = c;
      idx[o++] = d;
    }
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
