/**
 * TrackFeature renderer. planLandmarks() (before the terrain) resolves the layout's features (features.ts), clamps them
 * clear of the road / run-off / pit complex, keeps them inside the terrain rectangle and records what they need from the
 * world: terrain edits (pads, water basins, hillsides), tunnel spans, named grandstands, the pit-building variant and
 * prop exclusions. buildLandmarks() (after the terrain) turns the plan into merged meshes: one set of at most five
 * channel meshes per feature (view culling), shared materials, instanced tree belts for 'forest'. Unknown or unplaceable
 * features are skipped silently.
 *
 * Size and placement rules (all constants below): landmarks stand on the given side with their near edge at
 * max(requested offset, occupied corridor + LANDMARK_GAP); spanning structures (bridges) clear the road by ≥ BRIDGE_CLEARANCE
 * and put their piers outside the barriers / pit complex.
 */
import * as THREE from 'three';
import { clamp, smoothstep } from '../../core/math';
import { heightAt } from '../../track/track';
import { Rng } from '../core/canvas';
import { GeoBuilder } from '../core/geometry';
import { concreteTexture, windowTexture } from '../core/surfaceTextures';
import { headingAt, sidePoint, wrapIndex, type SceneryContext, type TerrainEdit } from './context';
import { layoutFeatures, tunnelRanges, type LayoutFeature } from './features';
import {
  Draw,
  Frame,
  casinoSquare,
  controlTower,
  ferrisWheel,
  fountainLake,
  hillsideHouses,
  lake,
  ledSphere,
  loftRoof,
  marina,
  newChannels,
  observationTower,
  skyline,
  skyParkHotel,
  swimmingPool,
  leafGrandstand,
  PANEL_COLORS,
  type ArchEnv,
  type Channels,
} from './landmarkArch';
import { patchTintMask, patchWindowFade } from './sceneryMaterials';
import { jitterColor, oilPalm, pickWeighted, speciesFor, TintBuilder } from './props';
import { frustum } from './shapes';
import { cap, strip } from './strips';
import { terrainRect } from './terrain';

/** Gap (m) between the occupied corridor (barrier / pit complex) and a landmark's near edge, at minimum. */
export const LANDMARK_GAP = 6;
/** Clearance (m) between the road surface and the underside of a spanning bridge. */
export const BRIDGE_CLEARANCE = 6;
/** Landmarks keep this far (m) inside the terrain rectangle. */
const RECT_INSET = 40;
/** Tunnel: clear height (m), wall offset beyond the barrier (m), hillside cover rise above the roof (m) and spread (m). */
export const TUNNEL_HEIGHT = 7.4;
const TUNNEL_WALL_GAP = 0.9;
/** Tunnel interior: unlit wall tint, floor brightness inside (multiplier on the road), fade length (m) at each portal and lift (m) of the floor shade. */
const TUNNEL_INTERIOR_TINT = '#dfe2e8';
/** Tunnel interior concrete (linear-ish base colour) and the brightness factors of its surfaces: lit by the ceiling strips. */
const TUNNEL_WALL_BASE = [0.46, 0.47, 0.5] as const;
const TUNNEL_LIT = { wallFoot: 0.5, wallTop: 1.0, ceilEdge: 0.95, ceilLight: 1.45, ceilMid: 1.05 } as const;
/** Smoothing length (m) of the ceiling light rows along the tunnel. */
const TUNNEL_LIGHT_SMOOTH = 30;
const TUNNEL_FLOOR_DARK = 0.34;
const TUNNEL_FLOOR_FADE = 45;
const TUNNEL_FLOOR_LIFT = 0.05;
const TUNNEL_COVER_RISE = 4.5;
const TUNNEL_COVER_SPREAD = 9;
/** Landmarks next to a tunnel keep this far (m) beyond the barrier. */
const TUNNEL_MOUND_OUT = 22;
/** Footprint (depth outward × length along, m) per landmark name. */
const FOOTPRINT: Record<string, readonly [number, number]> = {
  marina: [96, 150],
  'observation-tower': [34, 34],
  'control-tower': [52, 56],
  skyline: [130, 260],
  'sky-park-hotel': [74, 290],
  'led-sphere': [130, 130],
  'fountain-lake': [90, 190],
  'casino-square': [120, 180],
  'swimming-pool': [60, 80],
  lake: [120, 180],
  'hillside-houses': [170, 290],
  'leaf-grandstand': [96, 260],
};
/**
 * Leaf grandstand sizing: it fills the gap to the other road (depth = free span, margin LEAF_MARGIN beyond every
 * corridor), at most LEAF_MAX_DEPTH. A gap under LEAF_MIN_DOUBLE keeps only the near-side seating (down to
 * LEAF_MIN_SINGLE); with no other road within LEAF_SCAN it stands at most LEAF_OPEN_DEPTH deep, seating the near road only.
 * A single-sided fit costs LEAF_SINGLE_PENALTY (in slide-cost units) so a double-sided spot nearby wins.
 */
export const LEAF_MAX_DEPTH = 96;
export const LEAF_MIN_DOUBLE = 36;
export const LEAF_MIN_SINGLE = 12;
export const LEAF_OPEN_DEPTH = 46;
export const LEAF_MARGIN = 4;
const LEAF_SCAN = 140;
const LEAF_SINGLE_PENALTY = 1.2;
const LEAF_LENGTH: readonly [number, number] = [120, 320];
/** Palm plantation: tree budget by quality (like forests), belt depth (m), planting grid spacing (m), longest belt. */
const PLANTATION_CAP: Record<string, number> = { low: 120, medium: 320, high: 650, ultra: 1000 };
export const PLANTATION_DEPTH = 80;
export const PLANTATION_SPACING = 9;
/** Observation wheel radius (m): the tall city flyer vs the amusement-park wheel. */
export const WHEEL_RADIUS = { city: 75, park: 24 } as const;
/** Banking profile: bank width (m), rise (m) and parapet height (m); old-banking length when the feature has no `end`. */
const BANK_WIDTH = 32;
const BANK_RISE = 11.5;
const BANK_PARAPET = 1.6;
const BANK_DEFAULT_LENGTH = 320;
/** Trees per feature by quality, tree spacing (m²/tree) and belt depth (m). */
const FOREST_CAP: Record<string, number> = { low: 120, medium: 320, high: 650, ultra: 1000 };
const FOREST_AREA_PER_TREE = 26;
const FOREST_DEPTH = 90;
const FOREST_TALL: readonly [number, number] = [1.35, 1.95];

export interface Placement {
  f: LayoutFeature;
  /** sample index at the feature (after sliding along the track) */
  k: number;
  side: 1 | -1;
  /** distance (m) from the centre line to the near edge */
  offset: number;
  depth: number;
  length: number;
  /** outward frame at the near edge: origin on the ground (raw height), yaw so local +X points away from the road */
  frame: Frame;
  /** absolute plateau / water heights for water landmarks */
  level: number;
  water: number;
  /** leaf grandstand: seating on both sides (true) or only facing the near road */
  double?: boolean;
}

/** A bridge that fits: sample it spans at and the size factor (1 = full size) of the shrinkable ones. */
export interface BridgePlan {
  f: LayoutFeature;
  k: number;
  scale: number;
}

/** A feature the plan could not place, with the reason (the menus list every feature, so this should stay empty). */
export interface DroppedFeature {
  f: LayoutFeature;
  reason: string;
}

export interface LandmarkPlan {
  features: LayoutFeature[];
  placements: Placement[];
  bridges: BridgePlan[];
  dropped: DroppedFeature[];
}

/** Candidate shifts (m) along the track tried when a footprint does not fit at the requested spot, nearest first. */
const SLIDES = [0, 30, -30, 70, -70, 120, -120, 200, -200, 300, -300];
const BRIDGE_SLIDES = [0, 15, -15, 30, -30, 60, -60, 100, -100, 160, -160];
/** Smallest size factor a landmark may shrink to (1 = it keeps its full footprint: fixed-size models). */
const MIN_SCALE: Record<string, number> = { 'sky-park-hotel': 0.8, 'led-sphere': 1, 'ferris-wheel': 1, 'observation-tower': 1, 'control-tower': 1 };
const SCALE_STEPS = [1, 0.8, 0.65, 0.5];
/** Bridges that can shrink (span depth and width) when their piers do not fit. */
const SHRINKABLE_BRIDGES = ['hotel-bridge', 'wing-grandstand'];
/** Footprint probe spacing (m). */
const PROBE_STEP = 12;
const BRIDGE_SCALES = [1, 0.85, 0.7, 0.55, 0.4];

const _p = new THREE.Vector3();

/** Outward frame at sample k on `side`, near edge `offset` m from the centre line. */
function outwardFrame(ctx: SceneryContext, k: number, side: 1 | -1, offset: number): Frame {
  const t = ctx.track;
  sidePoint(t, k, side * offset, 0, _p);
  // local +X (cos yaw, -sin yaw) must be the outward direction side·R, R = (-tz, tx)
  const ox = -t.tz[k] * side;
  const oz = t.tx[k] * side;
  return new Frame(_p.x, _p.z, Math.atan2(-oz, ox), 0);
}

const idxAt = (ctx: SceneryContext, s: number): number => wrapIndex(Math.round(s / Math.max(0.01, ctx.track.spacing)), ctx.track.count);

/** Plan the layout's features: terrain edits, tunnel spans, bridges, banking, landmarks, named stands, pit variant, exclusions. */
export function planLandmarks(ctx: SceneryContext): LandmarkPlan {
  const { track: t, frame: f } = ctx;
  const features = layoutFeatures(t);
  ctx.tunnels.push(...tunnelRanges(features));
  const rect = terrainRect(t);
  const inside = (x: number, z: number): boolean => x > rect.minX + RECT_INSET && x < rect.maxX - RECT_INSET && z > rect.minZ + RECT_INSET && z < rect.maxZ - RECT_INSET;
  const placements: Placement[] = [];
  const bridges: BridgePlan[] = [];
  const dropped: DroppedFeature[] = [];
  const circles: { x: number; z: number; r: number }[] = [];
  const nearTunnel = (s: number, half: number): boolean => ctx.tunnels.some((tn) => inSpanLocal(s, tn.s0, tn.s1, t.length, half));
  const wheelR = ctx.biome === 'city' ? WHEEL_RADIUS.city : WHEEL_RADIUS.park;

  // 1. footprints that must stay free of everything else: tunnel mounds, bridges, the old banking
  for (const ft of features) {
    if (ft.kind === 'tunnel') reserveTunnel(ctx, ft);
  }
  for (const ft of features) {
    if (ft.kind !== 'bridge') continue;
    const bp = planBridge(ctx, ft);
    if (bp) bridges.push(bp);
    else dropped.push({ f: ft, reason: 'no pier position clear of the road' });
  }
  for (const ft of features) {
    if (ft.name !== 'old-banking') continue;
    if (!reserveBanking(ctx, ft)) dropped.push({ f: ft, reason: 'no stretch wide enough for the bank' });
  }
  const reserved = ctx.exclusions.length;
  const free = (x: number, z: number): boolean => {
    for (let i = 0; i < reserved; i++) {
      const ex = ctx.exclusions[i];
      if ((ex.x - x) ** 2 + (ex.z - z) ** 2 < ex.r * ex.r) return false;
    }
    return true;
  };

  for (const ft of features) {
    if (ft.name === 'pit-building-wing') {
      ctx.pitWing = true;
      continue;
    }
    if (ft.kind !== 'landmark') continue;
    if (ft.name === 'grandstand') {
      const k = idxAt(ctx, ft.s0);
      const side = (ft.side || -f.pitSign) as 1 | -1;
      ctx.featureStands.push({ k, side, offset: ft.offset ?? 0, length: 220, rows: 20 });
      continue;
    }
    if (ft.name === 'forest' || ft.name === 'palm-plantation' || ft.name === 'old-banking') continue; // along-track features are placed by their builders
    let [depth0, length0] = FOOTPRINT[ft.name] ?? [0, 0];
    if (ft.name === 'ferris-wheel') [depth0, length0] = [34, wheelR * 2 + 24];
    const leaf = ft.name === 'leaf-grandstand';
    if (leaf && ft.length > 0) length0 = clamp(ft.length, LEAF_LENGTH[0], LEAF_LENGTH[1]);
    if (depth0 <= 0) continue;
    const want = (ft.side || (-f.pitSign as 1 | -1)) as 1 | -1;
    const minScale = MIN_SCALE[ft.name] ?? SCALE_STEPS[SCALE_STEPS.length - 1];
    // candidates, cheapest first: the wanted side beats the other one, then a smaller footprint and a slide along the track
    const cands: { cost: number; side: 1 | -1; scale: number; slide: number; extra: number }[] = [];
    for (const side of [want, -want as 1 | -1]) {
      for (const scale of SCALE_STEPS) {
        if (scale < minScale) continue;
        for (const slide of SLIDES) {
          for (const extra of leaf ? [0] : [0, 22, 55]) {
            cands.push({ cost: (side === want ? 0 : 10) + (1 - scale) * 1.5 + Math.abs(slide) / 150 + extra / 110, side, scale, slide, extra });
          }
        }
      }
    }
    cands.sort((a, b) => a.cost - b.cost);
    let placed: Placement | null = null;
    let fallback: { p: Placement; cost: number; circle: { x: number; z: number; r: number } } | null = null;
    for (const c of cands) {
      if (fallback && c.cost > fallback.cost + LEAF_SINGLE_PENALTY) break;
      let depth = depth0 * c.scale;
      const length = length0 * c.scale;
      const s = ft.s0 + c.slide;
      const k = idxAt(ctx, s);
      if (f.deck[k]) continue;
      const occupied = f.occupiedTo(k, c.side);
      const offset = Math.max(ft.offset ?? 0, occupied + LANDMARK_GAP, nearTunnel(s, length / 2) ? occupied + TUNNEL_MOUND_OUT : 0) + c.extra;
      const fr = outwardFrame(ctx, k, c.side, offset);
      let double: boolean | undefined;
      if (leaf) {
        const g = leafSize(ctx, fr, length, inside, free);
        if (!g) continue;
        depth = g.depth;
        double = g.double;
      }
      let ok = true;
      // probe the footprint on a ≤ 12 m grid (a coarse grid lets a road slip between the points)
      const ni = Math.ceil(depth / PROBE_STEP);
      const nj = Math.ceil(length / PROBE_STEP);
      for (let i = 0; i <= ni && ok; i++) {
        for (let j = 0; j <= nj && ok; j++) {
          fr.w((depth * i) / ni, 0, length * (j / nj - 0.5), _p);
          ok = inside(_p.x, _p.z) && f.isClear(_p.x, _p.z, 3) && free(_p.x, _p.z);
        }
      }
      if (!ok) continue;
      const cc = fr.w(depth / 2, 0, 0);
      const r = Math.hypot(depth, length) * 0.4;
      if (circles.some((o) => (o.x - cc.x) ** 2 + (o.z - cc.z) ** 2 < (o.r + r) ** 2)) continue;
      const cand: Placement = { f: ft, k, side: c.side, offset, depth, length, frame: fr, level: 0, water: 0, double };
      if (leaf && !double) {
        if (!fallback) fallback = { p: cand, cost: c.cost, circle: { x: cc.x, z: cc.z, r } };
        continue;
      }
      circles.push({ x: cc.x, z: cc.z, r });
      placed = cand;
      break;
    }
    if (!placed && fallback) {
      circles.push(fallback.circle);
      placed = fallback.p;
    }
    if (!placed) {
      dropped.push({ f: ft, reason: 'footprint does not fit on either side within 300 m' });
      continue;
    }
    const { frame: fr, depth: dp, length: ln, k } = placed;
    const c = fr.w(dp / 2, 0, 0);
    ctx.exclusions.push({ x: c.x, z: c.z, r: Math.hypot(dp, ln) / 2 + 6 });
    // terrain edits
    const raw = heightAt(t, c.x, c.z);
    const plateau = Math.min(raw, t.py[k]) - 0.4;
    const edit = (e: Partial<TerrainEdit> & Pick<TerrainEdit, 'kind' | 'y'>): void => {
      ctx.terrainEdits.push({ shape: 'rect', cx: c.x, cz: c.z, yaw: fr.yaw, hx: dp / 2, hz: ln / 2, blend: 16, ...e });
    };
    switch (ft.name) {
      case 'marina':
        placed.level = plateau;
        placed.water = plateau - 1.2;
        edit({ kind: 'pad', y: plateau, basinY: placed.water - 1.8, basinInset: 12 });
        break;
      case 'fountain-lake':
        placed.level = plateau;
        placed.water = plateau - 0.8;
        edit({ kind: 'pad', y: plateau, basinY: placed.water - 1.8, basinInset: 10 });
        break;
      case 'lake':
        placed.level = plateau;
        placed.water = plateau - 1;
        edit({ kind: 'pad', shape: 'ellipse', y: plateau, basinY: placed.water - 1.8, basinInset: 4 });
        break;
      case 'swimming-pool':
        placed.level = plateau;
        placed.water = plateau - 0.1;
        edit({ kind: 'pad', y: plateau, basinY: plateau - 1.8, basinInset: 12, blend: 10 });
        break;
      case 'hillside-houses':
        edit({ kind: 'hill', y: 0, gain: 46, blend: 40 });
        break;
      case 'leaf-grandstand': {
        // level with the lowest of the road beside the stand and both ends of it
        const half = Math.round(ln / 2 / Math.max(0.01, t.spacing));
        const lo = Math.min(raw, t.py[k], t.py[wrapIndex(k - half, t.count)], t.py[wrapIndex(k + half, t.count)]) - 0.4;
        placed.level = lo;
        edit({ kind: 'pad', y: lo, blend: 10 });
        break;
      }
      case 'skyline':
        if (ctx.biome === 'coastal' || ctx.track.def.id === 'monaco') edit({ kind: 'hill', y: 0, gain: 42, blend: 36 });
        break;
      default:
        break;
    }
    placements.push(placed);
  }
  return { features, placements, bridges, dropped };
}

/**
 * Size of a leaf grandstand whose near edge is at `fr` (local +X away from the road, centred on the sample, `length` m
 * long): scans outward along its length to the first road / pit complex / reservation and returns the free depth.
 */
function leafSize(
  ctx: SceneryContext,
  fr: Frame,
  length: number,
  inside: (x: number, z: number) => boolean,
  free: (x: number, z: number) => boolean,
): { depth: number; double: boolean } | null {
  let gap = LEAF_SCAN;
  let roadSeen = false;
  const nj = Math.ceil(length / PROBE_STEP);
  for (let j = 0; j <= nj; j++) {
    let reach = -1;
    for (let x = 0; x <= LEAF_SCAN; x += 3) {
      fr.w(x, 0, length * (j / nj - 0.5), _p);
      // the terrain edge only limits the depth; a road / pit complex / reservation also makes the stand double-sided
      if (!inside(_p.x, _p.z)) break;
      if (!(ctx.frame.isClear(_p.x, _p.z, LEAF_MARGIN) && free(_p.x, _p.z))) {
        roadSeen = true;
        break;
      }
      reach = x;
    }
    if (reach < LEAF_MIN_SINGLE) return null;
    gap = Math.min(gap, reach);
  }
  if (!roadSeen) return { depth: Math.min(LEAF_OPEN_DEPTH, gap), double: false };
  const depth = Math.min(LEAF_MAX_DEPTH, gap);
  return { depth, double: depth >= LEAF_MIN_DOUBLE };
}

function inSpanLocal(s: number, s0: number, s1: number, L: number, margin: number): boolean {
  const rel = (((s - (s0 - margin)) % L) + L) % L;
  const len = ((((s1 - s0) % L) + L) % L) + 2 * margin;
  return rel <= len;
}

interface Materials {
  struct: THREE.MeshStandardMaterial;
  win: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  glow: THREE.MeshBasicMaterial;
  water: THREE.MeshStandardMaterial;
  /** concrete portals (daylit) */
  tunnel: THREE.MeshStandardMaterial;
  /** tunnel interior: unlit and dark (the sun and the shadow box never reach it), so it reads as a tunnel at every quality */
  tunnelInner: THREE.MeshBasicMaterial;
  /** multiplies the road inside the tunnel down to a dim floor */
  tunnelFloor: THREE.MeshBasicMaterial;
  tunnelLight: THREE.MeshBasicMaterial;
}

function makeMaterials(ctx: SceneryContext): Materials {
  const d = ctx.disposer;
  const night = ctx.timeOfDay === 'night';
  const win = d.add(new THREE.MeshStandardMaterial({ name: 'landmark-win', map: d.add(windowTexture(false)), vertexColors: true, roughness: 0.8 }));
  if (ctx.timeOfDay !== 'day') {
    win.emissiveMap = d.add(windowTexture(true));
    win.emissive.setRGB(1, 1, 1);
    win.emissiveIntensity = night ? 1.0 : 0.45;
  }
  patchWindowFade(win);
  const glow = d.add(new THREE.MeshBasicMaterial({ name: 'landmark-glow', vertexColors: true, toneMapped: false }));
  ctx.lampMaterials.push(glow);
  ctx.lampBase.push(new THREE.Color(1, 1, 1));
  return {
    struct: d.add(new THREE.MeshStandardMaterial({ name: 'landmark', vertexColors: true, roughness: 0.75, metalness: 0.1 })),
    win,
    glass: d.add(
      new THREE.MeshStandardMaterial({ name: 'landmark-glass', vertexColors: true, roughness: 0.3, metalness: 0.4, emissive: new THREE.Color(ctx.timeOfDay === 'day' ? '#000000' : '#3a3220') }),
    ),
    glow,
    water: d.add(new THREE.MeshStandardMaterial({ name: 'landmark-water', vertexColors: true, roughness: 0.06, metalness: 0.15 })),
    tunnel: d.add(new THREE.MeshStandardMaterial({ name: 'tunnel', map: d.add(concreteTexture(ctx.anisotropy, '#8f9298')), vertexColors: true, roughness: 0.9 })),
    tunnelInner: d.add(new THREE.MeshBasicMaterial({ name: 'tunnel-inner', map: d.add(concreteTexture(ctx.anisotropy, '#8f9298')), vertexColors: true, color: new THREE.Color(TUNNEL_INTERIOR_TINT) })),
    tunnelFloor: d.add(
      new THREE.MeshBasicMaterial({
        name: 'tunnel-floor',
        vertexColors: true,
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    ),
    tunnelLight: d.add(new THREE.MeshBasicMaterial({ name: 'tunnel-light', vertexColors: true, toneMapped: false })),
  };
}

/** Flush a channel builder into a mesh. */
function flush(group: THREE.Group, ctx: SceneryContext, b: GeoBuilder, mat: THREE.Material, name: string, cast: boolean): void {
  const g = b.build();
  if (!g) return;
  ctx.disposer.add(g);
  const m = new THREE.Mesh(g, mat);
  m.name = name;
  m.castShadow = cast;
  m.receiveShadow = true;
  group.add(m);
}

function flushChannels(group: THREE.Group, ctx: SceneryContext, ch: Channels, mats: Materials, name: string): void {
  flush(group, ctx, ch.struct, mats.struct, `${name}`, true);
  flush(group, ctx, ch.win, mats.win, `${name}:windows`, true);
  flush(group, ctx, ch.glass, mats.glass, `${name}:glass`, false);
  flush(group, ctx, ch.glow, mats.glow, `${name}:glow`, false);
  flush(group, ctx, ch.water, mats.water, `${name}:water`, false);
}

/** Build every planned feature; `bounds` = terrain rectangle (trees stay inside). */
export function buildLandmarks(ctx: SceneryContext, plan: LandmarkPlan, heightAtXZ: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'landmarks';
  if (plan.features.length === 0) return group;
  const mats = makeMaterials(ctx);
  const env = (seed: number): ArchEnv => ({
    rng: new Rng(ctx.seed + seed),
    level: ctx.quality.level,
    biome: ctx.biome,
    trackId: ctx.track.def.id,
    night: ctx.timeOfDay === 'night',
    ground: heightAtXZ,
  });
  let ordinal = 0;

  for (const p of plan.placements) {
    const ch = newChannels();
    const e = env(1000 + ordinal++ * 17);
    const { frame: fr, depth, length } = p;
    const st = (): Draw => new Draw(ch.struct, fr, e);
    switch (p.f.name) {
      case 'skyline':
        skyline(ch, fr, e, depth, length);
        break;
      case 'hillside-houses':
        hillsideHouses(ch, fr, e, depth, length);
        break;
      case 'casino-square':
        casinoSquare(ch, fr, e, depth, length);
        break;
      case 'swimming-pool':
        swimmingPool(ch, fr, e, depth, length, p.level - fr.gy);
        quay(st(), 12, depth - 12, -length / 2 + 12, length / 2 - 12, p.level - fr.gy, p.water - fr.gy - 0.6);
        break;
      case 'marina':
        marina(ch, fr, e, depth, length, p.level - fr.gy, p.water - fr.gy);
        quay(st(), 12, depth - 12, -length / 2 + 12, length / 2 - 12, p.level - fr.gy, p.water - fr.gy - 0.6);
        break;
      case 'fountain-lake':
        fountainLake(ch, fr, e, depth, length, p.level - fr.gy, p.water - fr.gy);
        quay(st(), 10, depth - 10, -length / 2 + 10, length / 2 - 10, p.level - fr.gy, p.water - fr.gy - 0.6);
        break;
      case 'lake':
        lake(ch, fr, e, depth, length, p.water - fr.gy);
        break;
      case 'ferris-wheel': {
        // axle along local X: the wheel plane faces the road
        ferrisWheel(ch, new Frame(...frameAt(fr, depth / 2, 0, heightAtXZ)), e, ctx.biome === 'city' ? WHEEL_RADIUS.city : WHEEL_RADIUS.park);
        break;
      }
      case 'observation-tower':
        observationTower(ch, new Frame(...frameAt(fr, depth / 2, 0, heightAtXZ)), e, 77);
        break;
      case 'control-tower':
        controlTower(ch, fr, e);
        break;
      case 'sky-park-hotel':
        skyParkHotel(ch, fr, e, depth, length);
        break;
      case 'led-sphere':
        ledSphere(ch, fr, e, depth);
        break;
      case 'leaf-grandstand':
        leafGrandstand(ch, fr, e, depth, length, p.level - fr.gy, p.double !== false);
        break;
      default:
        break;
    }
    flushChannels(group, ctx, ch, mats, p.f.name);
  }

  for (const bp of plan.bridges) {
    const ch = newChannels();
    if (buildBridge(ctx, bp, ch, env(500 + ordinal++ * 13), heightAtXZ)) flushChannels(group, ctx, ch, mats, bp.f.name);
  }
  for (const ft of plan.features) {
    if (ft.kind === 'tunnel') buildTunnel(ctx, ft, group, mats);
    else if (ft.name === 'old-banking') buildBanking(ctx, ft, group, mats);
  }
  return group;
}

/**
 * Tree belts ('forest' features). Built after the trackside structures (stands, TV towers, ...) so the trees keep clear of
 * every exclusion; instanced, one mesh per species and 450 m chunk.
 */
export function buildForests(ctx: SceneryContext, plan: LandmarkPlan, heightAtXZ: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'forests';
  let ordinal = 0;
  for (const ft of plan.features) {
    if (ft.name !== 'forest' && ft.name !== 'palm-plantation') continue;
    const e: ArchEnv = { rng: new Rng(ctx.seed + 31 + ordinal++), level: ctx.quality.level, biome: ctx.biome, trackId: ctx.track.def.id, night: ctx.timeOfDay === 'night', ground: heightAtXZ };
    if (ft.name === 'forest') buildForest(ctx, ft, group, heightAtXZ, e);
    else buildPlantation(ctx, ft, group, heightAtXZ, e);
  }
  return group;
}

/** Frame constructor args for the point (x, z) of `fr`, standing on the terrain there. */
function frameAt(fr: Frame, x: number, z: number, ground: (x: number, z: number) => number): [number, number, number, number] {
  const p = fr.w(x, 0, z);
  return [p.x, p.z, fr.yaw, ground(p.x, p.z) - 0.3];
}

/** Solid quay slab (3.5 m wide) just inside a basin boundary: vertical quay wall from `bottom` to the plateau. */
function quay(d: Draw, x0: number, x1: number, z0: number, z1: number, level: number, bottom: number): void {
  const w = 3.5;
  const h = level + 0.05 - bottom;
  d.col('#cfcac0');
  d.box((x0 + x1) / 2, bottom, z0 + w / 2 - 0.5, x1 - x0 + 2 * w - 1, h, w);
  d.box((x0 + x1) / 2, bottom, z1 - w / 2 + 0.5, x1 - x0 + 2 * w - 1, h, w);
  d.box(x0 + w / 2 - 0.5, bottom, (z0 + z1) / 2, w, h, z1 - z0 - 2 * w + 1);
  d.box(x1 - w / 2 + 0.5, bottom, (z0 + z1) / 2, w, h, z1 - z0 - 2 * w + 1);
}

// ───────────────────────────── bridges spanning the road ─────────────────────────────

/** Frame across the road at sample k (local +X = left, +Z = forward, origin on the centre line at road height). */
function roadFrame(ctx: SceneryContext, k: number): { fr: Frame; xl: number; xr: number } {
  const t = ctx.track;
  const f = ctx.frame;
  return { fr: new Frame(t.px[k], t.pz[k], headingAt(t, k), t.py[k]), xl: f.occupiedTo(k, -1), xr: -f.occupiedTo(k, 1) };
}

/** True when every sample point of the pier footprint is clear of the track and inside the terrain. */
function pierClear(ctx: SceneryContext, fr: Frame, xs: number[], zs: number[]): boolean {
  const rect = terrainRect(ctx.track);
  for (const x of xs) {
    for (const z of zs) {
      const p = fr.w(x, 0, z);
      if (p.x < rect.minX + RECT_INSET || p.x > rect.maxX - RECT_INSET || p.z < rect.minZ + RECT_INSET || p.z > rect.maxZ - RECT_INSET) return false;
      if (!ctx.frame.isClear(p.x, p.z, 1)) return false;
    }
  }
  return true;
}

function groundMin(fr: Frame, e: ArchEnv, xs: number[], zs: number[]): number {
  let lo = Infinity;
  for (const x of xs) {
    for (const z of zs) {
      const p = fr.w(x, 0, z);
      lo = Math.min(lo, e.ground(p.x, p.z));
    }
  }
  return lo - fr.gy;
}

/** Pier sample points (across-road x, along-road z in the road frame) of a bridge at size factor `sc`. */
function bridgePiers(name: string, xl: number, xr: number, sc: number): { xs: number[]; zs: number[] } | null {
  switch (name) {
    case 'footbridge':
      return { xs: [xl + 1.8, xr - 1.8], zs: [-1.4, 1.4] };
    case 'hotel-bridge': {
      const w = 36 * sc;
      const dz = 64 * sc;
      return { xs: [xl + 5, xl + 5 + w / 2, xl + 5 + w, xr - 5, xr - 5 - w / 2, xr - 5 - w], zs: [-dz / 2, 0, dz / 2] };
    }
    case 'wing-grandstand': {
      const dz = 56 * sc;
      return { xs: [xl + 4, xl + 22, xl + 40, xr - 4, xr - 22, xr - 40], zs: [-dz / 2, 0, dz / 2] };
    }
    case 'banking-bridge': {
      const abut = 16;
      return { xs: [xl + 3, xl + 3 + abut / 2, xl + 3 + abut, xr - 3, xr - 3 - abut / 2, xr - 3 - abut], zs: [-12, 0, 12] };
    }
    default:
      return null;
  }
}

/** True when the bridge `name` fits at sample k at size factor `sc`: free deck sample, sane span, piers clear of every road. */
function bridgeFits(ctx: SceneryContext, name: string, k: number, sc: number): boolean {
  const t = ctx.track;
  if (ctx.frame.deck[k] || ctx.tunnels.some((tn) => inSpanLocal(t.s[k], tn.s0, tn.s1, t.length, 30))) return false;
  const { fr, xl, xr } = roadFrame(ctx, k);
  const span = xl - xr;
  if (!(span > 4) || span > 150) return false;
  const piers = bridgePiers(name, xl, xr, sc);
  return piers !== null && pierClear(ctx, fr, piers.xs, piers.zs);
}

/**
 * Find where a bridge feature fits: the requested sample first, then slid along the track and (hotel / wing) shrunk
 * until its piers clear every road. Reserves the footprint so trees, stands and landmarks keep off it.
 */
function planBridge(ctx: SceneryContext, ft: LayoutFeature): BridgePlan | null {
  const scales = SHRINKABLE_BRIDGES.includes(ft.name) ? BRIDGE_SCALES : [1];
  const cands: { cost: number; slide: number; scale: number }[] = [];
  for (const slide of BRIDGE_SLIDES) for (const scale of scales) cands.push({ cost: Math.abs(slide) / 80 + (1 - scale) * 1.5, slide, scale });
  cands.sort((a, b) => a.cost - b.cost);
  for (const c of cands) {
    const k = idxAt(ctx, ft.s0 + c.slide);
    if (!bridgeFits(ctx, ft.name, k, c.scale)) continue;
    const { fr, xl, xr } = roadFrame(ctx, k);
    const piers = bridgePiers(ft.name, xl, xr, c.scale);
    if (!piers) return null;
    const zr = Math.max(...piers.zs.map(Math.abs));
    const xLo = Math.min(...piers.xs);
    const xHi = Math.max(...piers.xs);
    for (let x = xLo; x <= xHi + 10; x += 20) {
      const p = fr.w(Math.min(x, xHi), 0, 0);
      ctx.exclusions.push({ x: p.x, z: p.z, r: Math.max(zr, 6) + 8 });
    }
    return { f: ft, k, scale: c.scale };
  }
  return null;
}

function buildBridge(ctx: SceneryContext, bp: BridgePlan, ch: Channels, e: ArchEnv, ground: (x: number, z: number) => number): boolean {
  const ft = bp.f;
  const sc = bp.scale;
  const k = bp.k;
  const { fr, xl, xr } = roadFrame(ctx, k);
  const st = new Draw(ch.struct, fr, e);
  const gl = new Draw(ch.glow, fr, e);
  const mid = (xl + xr) / 2;
  const span = xl - xr;
  if (!bridgeFits(ctx, ft.name, k, sc)) return false;
  switch (ft.name) {
    case 'footbridge': {
      const pl = xl + 1.8;
      const pr = xr - 1.8;
      const zs = [-1.4, 1.4];
      const deck = Math.max(BRIDGE_CLEARANCE + 1.1, groundMin(fr, e, [pl, pr], zs) + 4.5 + 1.1);
      for (const x of [pl, pr]) {
        const g = groundMin(fr, e, [x], zs) - 0.6;
        st.col('#9aa0a8').box(x, g, 0, 1.6, deck - g, 2.8);
      }
      st.col('#c9ccd1').box(mid, deck - 1.1, 0, span + 7.2, 1.1, 3.6);
      // fictional advertising panels on both sides, canopy roof on posts
      for (const sz of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const w = (span + 7) / 4 - 0.4;
          st.col(PANEL_COLORS[(i + (sz > 0 ? 3 : 0)) % PANEL_COLORS.length]).box(mid - (span + 7) / 2 + (i + 0.5) * ((span + 7) / 4), deck, sz * 1.85, w, 1.5, 0.15);
          st.col('#ffffff').box(mid - (span + 7) / 2 + (i + 0.5) * ((span + 7) / 4), deck + 1.1, sz * 1.85, w * 0.5, 0.25, 0.17);
        }
      }
      st.col('#dfe2e6').box(mid, deck + 2.7, 0, span + 8, 0.25, 4);
      for (const x of [pl, pr, mid]) for (const sz of [-1, 1]) st.col('#6a6f77').box(x, deck, sz * 1.8, 0.2, 2.7, 0.2);
      gl.col('#fff2d0').box(mid, deck - 1.15, 0, span + 6, 0.12, 1.2);
      return true;
    }
    case 'hotel-bridge': {
      // One hotel over the road: two glazed towers either side, a three-storey link block spanning the road between them
      // and an LED grid shell draped over the whole building (resting on the tower roofs, never inside a tower body).
      const w = 36 * sc;
      const dz = 64 * sc;
      const tower = 44;
      const xsL = [xl + 5, xl + 5 + w / 2, xl + 5 + w];
      const xsR = [xr - 5, xr - 5 - w / 2, xr - 5 - w];
      const zs = [-dz / 2, 0, dz / 2];
      const win = new Draw(ch.win, fr, e);
      for (const sx of [1, -1]) {
        const xc = sx > 0 ? xl + 5 + w / 2 : xr - 5 - w / 2;
        const g = groundMin(fr, e, sx > 0 ? xsL : xsR, zs) - 1;
        win.col('#d4d8dd').wbox(xc, g, 0, w, tower - g, dz);
        st.col('#9aa0a8').box(xc, tower, 0, w + 0.6, 0.8, dz + 0.6);
      }
      // link block: windows on its long faces, slab under and over it, lit soffit
      const linkW = xl + 5 - (xr - 5);
      const linkY = 9.5;
      const linkH = 12;
      const linkD = dz * 0.55;
      win.col('#d4d8dd').wbox(mid, linkY, 0, linkW + 1, linkH, linkD);
      st.col('#9aa0a8').box(mid, linkY - 1.1, 0, linkW + 1, 1.1, linkD + 0.6);
      st.col('#9aa0a8').box(mid, linkY + linkH, 0, linkW + 1, 0.7, linkD + 0.6);
      gl.col('#fff2d0').box(mid, linkY - 1.15, 0, linkW - 2, 0.1, linkD - 2);
      // grid shell: parabolic ribs from the outer roof edge of one tower to the other's, every rib bears on short posts
      const apex = 16;
      const ribs = 11;
      const seg = 16;
      const x0 = xr - 5 - w;
      const x1 = xl + 5 + w;
      const edgeY = tower + 1.8;
      const pt = (u: number, z: number): THREE.Vector3 => fr.w(x0 + (x1 - x0) * u, edgeY + apex * (1 - (2 * u - 1) ** 2), z);
      const zRib = (r: number): number => -dz / 2 + 2 + (r * (dz - 4)) / (ribs - 1);
      for (let r = 0; r < ribs; r++) {
        const z = zRib(r);
        const wRib = r === 0 || r === ribs - 1 ? 0.9 : 0.5;
        for (let i = 0; i < seg; i++) {
          st.col('#e8eaee').beam(pt(i / seg, z), pt((i + 1) / seg, z), wRib);
          if (r % 2 === 0) gl.col(i % 3 ? '#8fd0ff' : '#c9b6ff').beam(pt(i / seg, z), pt((i + 1) / seg, z), 0.22);
        }
        for (const u of [0, 1]) st.col('#c9ccd1').beam(fr.w(x0 + (x1 - x0) * u, tower + 0.8, z), pt(u, z), 0.45);
      }
      for (let i = 1; i < seg; i += 2) {
        for (let r = 0; r + 1 < ribs; r++) st.col('#e8eaee').beam(pt(i / seg, zRib(r)), pt(i / seg, zRib(r + 1)), 0.3);
      }
      return true;
    }
    case 'wing-grandstand': {
      const dz = 56 * sc;
      const xsL = [xl + 4, xl + 22, xl + 40];
      const xsR = [xr - 4, xr - 22, xr - 40];
      const zs = [-dz / 2, 0, dz / 2];
      const roofY = (_u: number, v: number): number => 22 + 6 * v + 3 * Math.sin(Math.PI * _u);
      const xa = xr - 30;
      const xb = xl + 30;
      loftRoof(ch.struct, fr, xa, xb, -dz / 2, dz / 2, roofY, 1.4, 16, 6);
      // seating terraces either side (stepped), columns carrying the roof
      for (const sx of [1, -1]) {
        const x0 = sx > 0 ? xl + 4 : xr - 4;
        const g = groundMin(fr, e, sx > 0 ? xsL : xsR, zs) - 1;
        for (let r = 0; r < 12; r++) {
          st.col(r % 2 ? '#c8102e' : '#e8e8e8').box(x0 + sx * (r * 1.8 + 0.9), g, 0, 1.8, 3 + r * 1.4 - g, dz);
        }
        st.col('#dfe2e6');
        for (const z of [-dz / 2 + 2, -dz / 6, dz / 6, dz / 2 - 2]) {
          const xc = sx > 0 ? xl + 30 : xr - 30;
          const u = (xc - xa) / (xb - xa);
          const v = (z + dz / 2) / dz;
          st.box(xc, g, z, 1.4, roofY(u, v) - g, 1.4);
        }
      }
      return true;
    }
    case 'banking-bridge': {
      const dz = 24;
      const abut = 16;
      const xsL = [xl + 3, xl + 3 + abut / 2, xl + 3 + abut];
      const xsR = [xr - 3, xr - 3 - abut / 2, xr - 3 - abut];
      const zs = [-dz / 2, 0, dz / 2];
      const tilt = Math.tan((24 * Math.PI) / 180);
      const yc = BRIDGE_CLEARANCE + 1.9 + dz * 0.5 * tilt;
      const slab = 1.8;
      // tilted deck (rises with local z), abutment blocks under both ends, parapet on the high edge
      const ring = (xa: number, xb: number, off: number): THREE.Vector3[] =>
        [[xa, -dz / 2], [xb, -dz / 2], [xb, dz / 2], [xa, dz / 2]].map(([x, z]) => fr.w(x, yc + z * tilt + off, z));
      st.col('#74736d');
      const deckTop = ring(xr - abut, xl + abut, 0);
      const deckBot = ring(xr - abut, xl + abut, -slab);
      // deck as one frustum between its tilted bottom and top rings
      frustum(ch.struct, deckBot, deckTop);
      st.col('#b8b6ae').box(mid, yc + dz * 0.5 * tilt - slab, dz / 2 - 0.4, span + 2 * abut, slab + 2.4, 0.8);
      for (const sx of [1, -1]) {
        const xa = sx > 0 ? xl + 3 : xr - 3;
        const g = groundMin(fr, e, sx > 0 ? xsL : xsR, zs) - 1;
        const x0 = sx > 0 ? xa : xa - abut;
        const top = yc - dz * 0.5 * tilt - slab;
        st.col('#a9a79f').box(x0 + abut / 2, g, 0, abut, top - g + 0.5, dz);
      }
      return true;
    }
    default:
      return false;
  }
}

// ───────────────────────────── tunnel ─────────────────────────────

function buildTunnel(ctx: SceneryContext, ft: LayoutFeature, group: THREE.Group, mats: Materials): void {
  const t = ctx.track;
  const f = ctx.frame;
  const n = t.count;
  const i0 = idxAt(ctx, ft.s0);
  const len = Math.min(n - 1, Math.round(ft.length / t.spacing));
  if (len < 4) return;
  const wall = new GeoBuilder(true);
  const portal = new GeoBuilder(true);
  const floor = new GeoBuilder(true);
  const mound = new GeoBuilder(true);
  const light = new GeoBuilder(true);
  const col = new THREE.Color();
  const H = TUNNEL_HEIGHT;
  const W = (k: number, side: number): number => (side > 0 ? f.barrierR[k] : f.barrierL[k]) + TUNNEL_WALL_GAP;
  // interior: dim concrete walls and ceiling, lit by the strips: brighter towards the ceiling and around the light rows
  // (vertex colours, two vertices per strip row: A then B)
  const shade = (b: GeoBuilder, from: number, la: number, lb: number): void => {
    for (let i = from; i < b.vertexCount; i++) {
      const lum = (i - from) % 2 === 0 ? la : lb;
      b.colors[i * 3] = lum * TUNNEL_WALL_BASE[0];
      b.colors[i * 3 + 1] = lum * TUNNEL_WALL_BASE[1];
      b.colors[i * 3 + 2] = lum * TUNNEL_WALL_BASE[2];
    }
  };
  let v0 = wall.vertexCount;
  strip(wall, ctx, i0, len, (k) => [-W(k, -1), -0.3], (k) => [-W(k, -1), H], 'right', 8, 0, 0.9);
  shade(wall, v0, TUNNEL_LIT.wallFoot, TUNNEL_LIT.wallTop);
  v0 = wall.vertexCount;
  strip(wall, ctx, i0, len, (k) => [W(k, 1), -0.3], (k) => [W(k, 1), H], 'left', 8, 0, 0.9);
  shade(wall, v0, TUNNEL_LIT.wallFoot, TUNNEL_LIT.wallTop);
  // the light rows follow a smoothed mid-line of each half (the barrier offset steps by up to ~1.5 m, which kinked the strips)
  const smoothHalf = (side: 1 | -1): Float64Array => {
    const raw = new Float64Array(len + 1);
    for (let j = 0; j <= len; j++) raw[j] = W(wrapIndex(i0 + j, n), side);
    const radius = Math.max(2, Math.round(TUNNEL_LIGHT_SMOOTH / t.spacing));
    let cur = raw;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float64Array(len + 1);
      for (let j = 0; j <= len; j++) {
        let sum = 0;
        let cnt = 0;
        for (let d = -radius; d <= radius; d++) {
          const q = j + d;
          if (q < 0 || q > len) continue;
          sum += cur[q];
          cnt++;
        }
        next[j] = sum / cnt;
      }
      cur = next;
    }
    return cur;
  };
  const wl = smoothHalf(-1);
  const wr = smoothHalf(1);
  const rowLat = (j: number, q: number): number => (q < 0 ? q * wl[j] : q * wr[j]);
  // ceiling in four bands: wall edge, light row, centre, light row, wall edge
  const bands: [number, number, number, number][] = [
    [-1, -0.5, TUNNEL_LIT.ceilEdge, TUNNEL_LIT.ceilLight],
    [-0.5, 0, TUNNEL_LIT.ceilLight, TUNNEL_LIT.ceilMid],
    [0, 0.5, TUNNEL_LIT.ceilMid, TUNNEL_LIT.ceilLight],
    [0.5, 1, TUNNEL_LIT.ceilLight, TUNNEL_LIT.ceilEdge],
  ];
  for (const [qa, qb, la, lb] of bands) {
    v0 = wall.vertexCount;
    const lat = (k: number, j: number, q: number): number => (q === -1 ? -W(k, -1) : q === 1 ? W(k, 1) : rowLat(j, q));
    strip(wall, ctx, i0, len, (k, j) => [lat(k, j, qa), H], (k, j) => [lat(k, j, qb), H], 'right', 8, 0, 2);
    shade(wall, v0, la, lb);
  }
  // ceiling light strips (two rows), always on
  light.setColor(col.setRGB(1.4, 1.25, 1.0));
  for (const q of [-0.5, 0.5]) {
    strip(light, ctx, i0, len, (_k, j) => [rowLat(j, q) - 0.35, H - 0.04], (_k, j) => [rowLat(j, q) + 0.35, H - 0.04], 'right', 8, 0, 1);
  }
  // hillside cover: earth mound over the box, concrete portals at both ends
  mound.setColor(col.set('#5f7f45'));
  const top = H + 1.2 + TUNNEL_COVER_RISE;
  const spread = TUNNEL_COVER_SPREAD;
  strip(mound, ctx, i0, len, (k) => [-(W(k, -1) + 1.2 + spread), -1.4], (k) => [-(W(k, -1) - 0.5), top], 'left', 8, 0, 1);
  strip(mound, ctx, i0, len, (k) => [-(W(k, -1) - 0.5), top], (k) => [W(k, 1) - 0.5, top], 'left', 8, 0, 1);
  strip(mound, ctx, i0, len, (k) => [W(k, 1) - 0.5, top], (k) => [W(k, 1) + 1.2 + spread, -1.4], 'left', 8, 0, 1);
  for (const [j, dir] of [[0, -1], [len, 1]] as const) {
    const k = wrapIndex(i0 + j, n);
    const wl = W(k, -1);
    const wr = W(k, 1);
    const wo = 2.2;
    const hTop = H + 2.4;
    // earth end face behind the portal (bounded by the cover's slopes), concrete portal pieces 0.15 m in front of it
    mound.setColor(col.set('#5f7f45'));
    // (the trapezoid between the cover's slopes minus the opening: left and right of it, and above the roof)
    const frac = (H + 1.4) / (top + 1.4);
    const aL = -(wl + 1.2 + spread);
    const aR = wr + 1.2 + spread;
    const eL = aL + frac * (-(wl - 0.5) - aL);
    const eR = aR + frac * (wr - 0.5 - aR);
    cap(mound, ctx, k, [[aL, -1.4], [-wl, -1.4], [-wl, H], [eL, H]], dir);
    cap(mound, ctx, k, [[wr, -1.4], [aR, -1.4], [eR, H], [wr, H]], dir);
    cap(mound, ctx, k, [[eL, H], [eR, H], [wr - 0.5, top], [-(wl - 0.5), top]], dir);
    portal.setColor(col.set('#b9bbbf'));
    cap(portal, ctx, k, [[-wl - wo, -1.4], [-wl, -1.4], [-wl, hTop], [-wl - wo, hTop]], dir, 0.15);
    cap(portal, ctx, k, [[wr, -1.4], [wr + wo, -1.4], [wr + wo, hTop], [wr, hTop]], dir, 0.15);
    cap(portal, ctx, k, [[-wl - wo, H], [wr + wo, H], [wr + wo, hTop], [-wl - wo, hTop]], dir, 0.15);
  }
  // floor shade: the road between the walls is dimmed (full strength 45 m inside each portal, fading out towards the daylight)
  let prev = -1;
  for (let j = 0; j <= len; j++) {
    const k = wrapIndex(i0 + j, n);
    const inside = Math.min(j, len - j) * t.spacing;
    const m = TUNNEL_FLOOR_DARK + (1 - TUNNEL_FLOOR_DARK) * (1 - smoothstep(0, TUNNEL_FLOOR_FADE, inside));
    floor.setColor(col.setRGB(m, m, m));
    const row = floor.vertexCount;
    for (const lat of [-W(k, -1), W(k, 1)]) {
      sidePoint(t, k, lat, TUNNEL_FLOOR_LIFT, _p);
      floor.vertex(_p.x, _p.y, _p.z, 0, 1, 0, 0, 0);
    }
    if (prev >= 0) floor.quad(prev, prev + 1, row + 1, row);
    prev = row;
  }
  flush(group, ctx, wall, mats.tunnelInner, 'tunnel', false);
  flush(group, ctx, portal, mats.tunnel, 'tunnel:portal', true);
  flush(group, ctx, floor, mats.tunnelFloor, 'tunnel:floor', false);
  flush(group, ctx, mound, mats.struct, 'tunnel:cover', true);
  flush(group, ctx, light, mats.tunnelLight, 'tunnel:light', false);
}

/** Keep props, stands and trees off the tunnel mound. */
function reserveTunnel(ctx: SceneryContext, ft: LayoutFeature): void {
  const t = ctx.track;
  const f = ctx.frame;
  const i0 = idxAt(ctx, ft.s0);
  const len = Math.min(t.count - 1, Math.round(ft.length / t.spacing));
  if (len < 4) return;
  for (let j = 0; j <= len; j += Math.round(30 / t.spacing)) {
    const k = wrapIndex(i0 + j, t.count);
    ctx.exclusions.push({ x: t.px[k], z: t.pz[k], r: Math.max(f.barrierL[k], f.barrierR[k]) + TUNNEL_COVER_SPREAD + 12 });
  }
}

// ───────────────────────────── old banking ─────────────────────────────

/** Where the old banking stands: side, first sample, sample count, near edge per sample and the stretches wide enough to build. */
function bankingLayout(ctx: SceneryContext, ft: LayoutFeature) {
  const t = ctx.track;
  const f = ctx.frame;
  const n = t.count;
  const side = (ft.side || -f.pitSign) as 1 | -1;
  const length = ft.length > 0 ? ft.length : BANK_DEFAULT_LENGTH;
  const start = ft.length > 0 ? ft.s0 : ft.s0 - length / 2;
  const i0 = idxAt(ctx, start);
  const count = Math.min(n - 1, Math.round(length / t.spacing));
  const rect = terrainRect(t);
  // per-sample bank width: as wide as the free ground allows (curved sections fold a wide bank onto itself)
  const near = (k: number): number => Math.max(ft.offset ?? 0, f.occupiedTo(k, side) + LANDMARK_GAP);
  const widthAt = (k: number): number => {
    let free = BANK_WIDTH + 2;
    for (let d = 4; d <= BANK_WIDTH + 2; d += 4) {
      sidePoint(t, k, side * (near(k) + d), 0, _p);
      if (_p.x < rect.minX + RECT_INSET || _p.x > rect.maxX - RECT_INSET || _p.z < rect.minZ + RECT_INSET || _p.z > rect.maxZ - RECT_INSET || !f.isClear(_p.x, _p.z, 2)) {
        free = d - 4;
        break;
      }
    }
    return Math.min(BANK_WIDTH, free - 1);
  };
  const widths = new Float64Array(count + 1);
  for (let j = 0; j <= count; j++) widths[j] = widthAt(wrapIndex(i0 + j, n));
  // contiguous stretches (sample offsets j0 .. j0 + len) where the bank fits
  const runs: [number, number][] = [];
  for (let j = 0; j <= count; ) {
    if (widths[j] < 14) {
      j++;
      continue;
    }
    let e = j;
    while (e + 1 <= count && widths[e + 1] >= 14) e++;
    runs.push([j, e - j]);
    j = e + 1;
  }
  return { side, i0, count, near, widths, runs: runs.filter(([, len]) => len >= 6) };
}

/** Reserve the banking's footprint (props, stands, trees and landmarks keep off it); false when no stretch fits. */
function reserveBanking(ctx: SceneryContext, ft: LayoutFeature): boolean {
  const t = ctx.track;
  const { side, i0, near, runs } = bankingLayout(ctx, ft);
  for (const [j0, len] of runs) {
    const base = wrapIndex(i0 + j0, t.count);
    for (let j = 0; j <= len; j += Math.round(40 / t.spacing)) {
      const k = wrapIndex(base + j, t.count);
      sidePoint(t, k, side * (near(k) + BANK_WIDTH / 2), 0, _p);
      ctx.exclusions.push({ x: _p.x, z: _p.z, r: BANK_WIDTH / 2 + 12 });
    }
  }
  return runs.length > 0;
}

function buildBanking(ctx: SceneryContext, ft: LayoutFeature, group: THREE.Group, mats: Materials): void {
  const t = ctx.track;
  const n = t.count;
  const { side, i0, count, near, widths, runs } = bankingLayout(ctx, ft);
  const b = new GeoBuilder(true);
  const col = new THREE.Color();
  const face = side > 0 ? 'left' : 'right';
  let built = false;
  for (const [j0, len] of runs) {
    const base = wrapIndex(i0 + j0, n);
    const sc = (k: number, j: number): number => widths[clamp(j + j0, 0, count)] / BANK_WIDTH;
    const o = (k: number): number => near(k);
    const P = (a: number, y: number) => (k: number, j: number): readonly [number, number] => [side * (o(k) + a * sc(k, j)), y * sc(k, j)];
    b.setColor(col.set('#7a7871'));
    strip(b, ctx, base, len, P(0, 0), P(BANK_WIDTH, BANK_RISE), face, 8, 0, 6);
    b.setColor(col.set('#9a988f'));
    strip(b, ctx, base, len, P(BANK_WIDTH, BANK_RISE), (k, j) => [side * (o(k) + BANK_WIDTH * sc(k, j)), BANK_RISE * sc(k, j) + BANK_PARAPET], face, 8, 0, 0.5);
    strip(b, ctx, base, len, (k, j) => [side * (o(k) + BANK_WIDTH * sc(k, j)), BANK_RISE * sc(k, j) + BANK_PARAPET], (k, j) => [side * (o(k) + (BANK_WIDTH + 1.2) * sc(k, j)), BANK_RISE * sc(k, j) + BANK_PARAPET], face, 8, 0, 0.3);
    b.setColor(col.set('#6a6963'));
    strip(b, ctx, base, len, (k, j) => [side * (o(k) + (BANK_WIDTH + 1.2) * sc(k, j)), BANK_RISE * sc(k, j) + BANK_PARAPET], (k, j) => [side * (o(k) + (BANK_WIDTH + 1.2) * sc(k, j)), -1.4], face, 8, 0, 4);
    for (const [j, dir] of [[0, -1], [len, 1]] as const) {
      const k = wrapIndex(base + j, n);
      const s = sc(k, j);
      const w = BANK_WIDTH * s;
      const w2 = (BANK_WIDTH + 1.2) * s;
      const r = BANK_RISE * s;
      // two convex pieces: the bank body and the parapet block on its crest
      for (const pts of [
        [[0, -1.4], [w2, -1.4], [w2, r], [w, r], [0, 0]],
        [[w, r], [w2, r], [w2, r + BANK_PARAPET], [w, r + BANK_PARAPET]],
      ]) {
        const lat = pts.map(([x, y]) => [side * (o(k) + x), y] as [number, number]);
        cap(b, ctx, k, side > 0 ? lat : [...lat].reverse(), dir);
      }
    }
    built = true;
  }
  if (built) flush(group, ctx, b, mats.struct, 'old-banking', true);
}

// ───────────────────────────── forest ─────────────────────────────

function buildForest(ctx: SceneryContext, ft: LayoutFeature, group: THREE.Group, ground: (x: number, z: number) => number, e: ArchEnv): void {
  const t = ctx.track;
  const f = ctx.frame;
  const side = (ft.side || -f.pitSign) as 1 | -1;
  const length = Math.max(60, ft.length);
  const rect = terrainRect(t);
  const species = speciesFor(ctx.biome).filter((sp) => sp.shadow && sp.name !== 'boulder' && sp.name !== 'cactus');
  if (species.length === 0) return;
  const budget = Math.min(FOREST_CAP[ctx.quality.level] ?? 500, Math.round((length * FOREST_DEPTH) / FOREST_AREA_PER_TREE));
  const rng = e.rng;
  const up = new THREE.Vector3(0, 1, 0);
  const chunkLen = 450;
  const buckets = species.map(() => new Map<number, { m: THREE.Matrix4[]; c: THREE.Color[] }>());
  let planted = 0;
  for (let a = 0; a < budget * 4 && planted < budget; a++) {
    const s = ft.s0 + rng.next() * length;
    const k = idxAt(ctx, s);
    if (f.deck[k]) continue;
    const near = Math.max(ft.offset ?? 0, f.occupiedTo(k, side) + 5);
    const d = near + Math.pow(rng.next(), 0.8) * FOREST_DEPTH;
    sidePoint(t, k, side * d, 0, _p);
    const x = _p.x + rng.range(-2, 2);
    const z = _p.z + rng.range(-2, 2);
    if (x < rect.minX + 30 || x > rect.maxX - 30 || z < rect.minZ + 30 || z > rect.maxZ - 30) continue;
    const si = pickWeighted(rng, species, (sp) => sp.weight);
    const sp = species[si];
    if (!f.isClear(x, z, sp.clearance) || ctx.exclusions.some((ex) => (ex.x - x) ** 2 + (ex.z - z) ** 2 < ex.r * ex.r)) continue;
    const g = ground(x, z);
    const sc = rng.range(FOREST_TALL[0], FOREST_TALL[1]);
    const q = new THREE.Quaternion().setFromAxisAngle(up, rng.range(0, Math.PI * 2));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, g - 0.15, z), q, new THREE.Vector3(sc, sc * rng.range(0.9, 1.15), sc));
    const key = Math.floor(((s - ft.s0) / chunkLen) % 64);
    const bucket = buckets[si].get(key) ?? { m: [], c: [] };
    bucket.m.push(m);
    bucket.c.push(jitterColor(rng.pick(sp.crown), rng.range(-0.015, 0.015), rng.range(-0.06, 0.06), rng.range(-0.06, 0.04)));
    buckets[si].set(key, bucket);
    planted++;
  }
  species.forEach((sp, si) => {
    if (buckets[si].size === 0) return;
    const tb = new TintBuilder();
    sp.build(tb);
    const geo = ctx.disposer.add(tb.build());
    const mat = ctx.disposer.add(new THREE.MeshLambertMaterial({ name: `forest-${sp.name}`, vertexColors: true, side: sp.doubleSided ? THREE.DoubleSide : THREE.FrontSide }));
    patchTintMask(mat);
    for (const bucket of buckets[si].values()) {
      const mesh = ctx.disposer.add(new THREE.InstancedMesh(geo, mat, bucket.m.length));
      mesh.name = `forest:${sp.name}`;
      bucket.m.forEach((m, i) => {
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, bucket.c[i]);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  });
}

/**
 * Oil-palm plantation ('palm-plantation'): palms on a regular staggered grid (rows parallel to the road, PLANTATION_SPACING
 * apart, every other row shifted half a step) in a belt PLANTATION_DEPTH m deep from `at` to `end`. Same keep-out rules as
 * forests; the grid coarsens (never thins at random) when the quality's tree cap is below the full planting.
 */
function buildPlantation(ctx: SceneryContext, ft: LayoutFeature, group: THREE.Group, ground: (x: number, z: number) => number, e: ArchEnv): void {
  const t = ctx.track;
  const f = ctx.frame;
  const side = (ft.side || -f.pitSign) as 1 | -1;
  const length = Math.max(60, ft.length);
  const rect = terrainRect(t);
  const sp = oilPalm(['#3f7a2e', '#4a8a30', '#356b29', '#5a9a3a'], 1, 0);
  const cap = PLANTATION_CAP[ctx.quality.level] ?? 300;
  const step = Math.max(PLANTATION_SPACING, Math.sqrt((length * PLANTATION_DEPTH) / cap));
  const rng = e.rng;
  const up = new THREE.Vector3(0, 1, 0);
  const chunkLen = 450;
  const buckets = new Map<number, { m: THREE.Matrix4[]; c: THREE.Color[] }>();
  const rows = Math.max(1, Math.floor(PLANTATION_DEPTH / step));
  const along = Math.max(1, Math.floor(length / step));
  let planted = 0;
  for (let row = 0; row < rows; row++) {
    for (let i = 0; i < along; i++) {
      if (planted >= cap) break;
      const s = ft.s0 + (i + 0.5 * (row % 2)) * step;
      const k = idxAt(ctx, s);
      if (f.deck[k]) continue;
      const near = Math.max(ft.offset ?? 0, f.occupiedTo(k, side) + 5);
      sidePoint(t, k, side * (near + row * step), 0, _p);
      const x = _p.x + rng.range(-0.3, 0.3);
      const z = _p.z + rng.range(-0.3, 0.3);
      if (x < rect.minX + 30 || x > rect.maxX - 30 || z < rect.minZ + 30 || z > rect.maxZ - 30) continue;
      if (!f.isClear(x, z, sp.clearance) || ctx.exclusions.some((ex) => (ex.x - x) ** 2 + (ex.z - z) ** 2 < ex.r * ex.r)) continue;
      const sc = rng.range(0.92, 1.12);
      const q = new THREE.Quaternion().setFromAxisAngle(up, rng.range(0, Math.PI * 2));
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, ground(x, z) - 0.15, z), q, new THREE.Vector3(sc, sc * rng.range(0.95, 1.1), sc));
      const key = Math.floor((((s - ft.s0) / chunkLen) % 64 + 64) % 64);
      const bucket = buckets.get(key) ?? { m: [], c: [] };
      bucket.m.push(m);
      bucket.c.push(jitterColor(rng.pick(sp.crown), rng.range(-0.01, 0.01), rng.range(-0.05, 0.05), rng.range(-0.05, 0.04)));
      buckets.set(key, bucket);
      planted++;
    }
  }
  if (buckets.size === 0) return;
  const tb = new TintBuilder();
  sp.build(tb);
  const geo = ctx.disposer.add(tb.build());
  const mat = ctx.disposer.add(new THREE.MeshLambertMaterial({ name: 'palm-plantation', vertexColors: true, side: THREE.DoubleSide }));
  patchTintMask(mat);
  for (const bucket of buckets.values()) {
    const mesh = ctx.disposer.add(new THREE.InstancedMesh(geo, mat, bucket.m.length));
    mesh.name = 'palm-plantation:oilPalm';
    bucket.m.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, bucket.c[i]);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}
