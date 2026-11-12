/**
 * Racing surface: asphalt ribbon (incl. pit lane & apron) with a rubbered racing line (two dark tyre tracks along
 * BuiltTrack.racingLine, heavier in braking zones and corners, glossier when wet; lighter, dustier edges and a
 * baked tone drift with resurfaced patches along the lap), raised striped kerbs, run-off
 * ribbons (grass / gravel / painted asphalt; where the surface changes one eases into the other along a curve, and baked
 * vertex colours carry broad tone patches), painted markings (edge lines, grid slots, pit lines & boxes, DRS
 * lines) and the chequered start/finish line. Static geometry is merged per material. With surface detail (quality)
 * the surfaces get procedural normal / roughness maps (aggregate, kerb ribs, pebbles, grass) that flatten when wet.
 */
import * as THREE from 'three';
import type { Biome, BuiltTrack } from '../../core/types';
import { clamp01, smoothstep } from '../../core/math';
import { poseAt, wrapS } from '../../track/track';
import { GeoBuilder } from '../core/geometry';
import {
  ASPHALT_DETAIL_REPEAT,
  asphaltDetailMaps,
  asphaltTexture,
  checkerTexture,
  gravelTexture,
  grassTexture,
  kerbNormalTexture,
  kerbTexture,
  noiseNormalTexture,
  pebbleNormalTexture,
  runoffAsphaltTexture,
} from '../core/surfaceTextures';
import { fbm2D, GROUND_SATURATION, GROUND_VALUE, groundTint, hash3, periodicNoise1D, valueNoise2D } from './sceneryMath';
import { GROUND_MACRO_SCALE } from './terrain';
import { GRID_LAYOUT, segmentRuns, sidePoint, wrapIndex, type SceneryContext } from './context';
import { PIT_BOX_COUNT, PIT_BOX_LATERAL, PIT_BOX_SPACING, PIT_LANE_HALF } from './trackFrame';

export interface RoadParts {
  group: THREE.Group;
  /** materials that react to wetness (roughness / darkening; water fills the relief: normal scale × WET_NORMAL_SCALE) */
  wetMaterials: { material: THREE.MeshStandardMaterial; dryRoughness: number; wetRoughness: number; dryColor: THREE.Color; dryNormalScale?: number }[];
}

/** Normal-map strength left at full wetness (standing water smooths the surface relief). */
export const WET_NORMAL_SCALE = 0.35;

/**
 * Screen-space wet reflections (post chain, quality wetReflections): RaceScene sets this to the track wetness while
 * they are on, else 0. Wet materials then write their reflectivity into the alpha channel of the HDR scene target
 * (alpha = 1 − reflectivity; every other material writes 1), which the reflection pass reads as its mask.
 */
export const WET_REFLECTION: THREE.IUniform<number> = { value: 0 };
/** Reflectivity share per wet surface at full wetness: asphalt mirrors most, painted lines / kerbs less, grass none. */
export const WET_REFLECT_SHARE = { asphalt: 1, runoffAsphalt: 0.85, kerb: 0.65, paint: 0.6, grass: 0 } as const;
/** Standing water collects in patches: the mask varies by ±WET_PATCH_DEPTH over cells of WET_PATCH_SIZE metres. */
export const WET_PATCH_SIZE = 7;
export const WET_PATCH_DEPTH = 0.45;

/** Writes the wet-reflection mask into the fragment alpha (chains behind an existing onBeforeCompile patch). */
function applyWetReflectionMask(material: THREE.MeshStandardMaterial, share: number): void {
  if (share <= 0) return;
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  const f = (v: number): string => v.toFixed(4);
  material.onBeforeCompile = (sh, renderer) => {
    prev.call(material, sh, renderer);
    sh.uniforms.wetReflection = WET_REFLECTION;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWetXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWetXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float wetReflection;
varying vec2 vWetXZ;
float wetHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float wetPatches( vec2 p ) {
  vec2 i = floor( p );
  vec2 u = fract( p );
  u = u * u * ( 3.0 - 2.0 * u );
  return mix( mix( wetHash( i ), wetHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( wetHash( i + vec2( 0.0, 1.0 ) ), wetHash( i + vec2( 1.0 ) ), u.x ), u.y );
}`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
  if ( wetReflection > 0.0 ) {
    float wetPatch = 1.0 - ${f(WET_PATCH_DEPTH)} + ${f(WET_PATCH_DEPTH)} * wetPatches( vWetXZ * ${f(1 / WET_PATCH_SIZE)} );
    gl_FragColor.a = 1.0 - clamp( wetReflection * ${f(share)} * wetPatch, 0.0, 0.98 );
  }`,
      );
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}|wet-mask-${share}`;
}

/** Rubbered racing line: base laid-down rubber, extra in braking zones / corners (0..1 intensity, see rubberIntensity). */
export const RUBBER_BASE = 0.45;
/** Look-ahead (m) and speed drop (m/s) over it that count as a full braking zone. */
export const RUBBER_BRAKE_LOOKAHEAD = 40;
export const RUBBER_BRAKE_DROP = 22;
/** |curvature| (1/m) × gain = corner share (1 at radius ≤ 1 / gain... e.g. 60 m). */
export const RUBBER_CURVE_GAIN = 60;
/** Shader: colour darkening and roughness reduction at full rubber; tyre-track offset / width and overall band width (m). */
export const RUBBER_DARKEN = 0.34;
export const RUBBER_GLOSS = 0.2;
export const RUBBER_TRACK_OFFSET = 0.8;
export const RUBBER_TRACK_WIDTH = 0.3;
export const RUBBER_BAND_WIDTH = 1.2;

/** Laid-down rubber 0..1 at track sample k: base everywhere on the line, up to 1 where cars brake hard or turn tight. */
export function rubberIntensity(t: BuiltTrack, k: number): number {
  const n = t.count;
  if (n <= 0) return 0;
  const i = ((k % n) + n) % n;
  const la = Math.max(1, Math.round(RUBBER_BRAKE_LOOKAHEAD / Math.max(0.01, t.spacing)));
  const v0 = t.speedProfile?.[i] ?? 0;
  const v1 = t.speedProfile?.[(i + la) % n] ?? v0;
  const brake = Number.isFinite(v0 - v1) ? clamp01((v0 - v1) / RUBBER_BRAKE_DROP) : 0;
  const curv = t.curvature?.[i] ?? 0;
  const corner = Number.isFinite(curv) ? clamp01(Math.abs(curv) * RUBBER_CURVE_GAIN) : 0;
  // slow variation along the lap (resurfaced / less used stretches)
  const vary = 0.85 + 0.3 * hash3(Math.floor((t.s[i] ?? 0) / 25), 7, 99);
  return clamp01((RUBBER_BASE + 0.55 * Math.max(brake, corner)) * vary);
}

/** Off-line asphalt near the edges is dustier and less rubbered: brightening at the edge and the width (m) it fades in over. */
export const ASPHALT_EDGE_DUST = 0.3;
export const ASPHALT_EDGE_WIDTH = 3;

const RUBBER_VERT_DECL = /* glsl */ `
attribute vec4 rubber;
varying vec4 vRubber;`;
const RUBBER_FRAG_DECL = /* glsl */ `
varying vec4 vRubber;
float edgeDust() {
  return vRubber.w > 0.5 ? smoothstep(vRubber.w - ${ASPHALT_EDGE_WIDTH.toFixed(3)}, vRubber.w - 0.25, abs(vRubber.x)) : 0.0;
}
float rubberAmount() {
  float dl = vRubber.x - vRubber.y;
  float band = exp(-dl * dl / (2.0 * ${RUBBER_BAND_WIDTH.toFixed(3)} * ${RUBBER_BAND_WIDTH.toFixed(3)}));
  float tr = abs(dl) - ${RUBBER_TRACK_OFFSET.toFixed(3)};
  float tracks = exp(-tr * tr / (2.0 * ${RUBBER_TRACK_WIDTH.toFixed(3)} * ${RUBBER_TRACK_WIDTH.toFixed(3)}));
  return clamp((0.45 * band + 0.55 * tracks) * vRubber.z, 0.0, 1.0);
}`;

/**
 * Asphalt shader patch: per-vertex `rubber` = (vertex lateral, racing-line lateral, intensity, half width or 0 off the
 * track), interpolated across the road row so every fragment knows its distance to the line and to the edge exactly; the
 * line darkens the colour and lowers the roughness, the dusty edges brighten it.
 */
function applyRubberShader(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>${RUBBER_VERT_DECL}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRubber = rubber;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${RUBBER_FRAG_DECL}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>\n  float rubberK = rubberAmount();\n  diffuseColor.rgb *= ( 1.0 - ${RUBBER_DARKEN.toFixed(3)} * rubberK ) * ( 1.0 + ${ASPHALT_EDGE_DUST.toFixed(3)} * edgeDust() * ( 1.0 - rubberK ) );`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n  roughnessFactor *= 1.0 - ${RUBBER_GLOSS.toFixed(3)} * rubberK;`);
  };
  material.customProgramCacheKey = () => 'asphalt-rubber-edge';
}

/** Detail maps get their own (finer) repeat; three keeps one transform per map. */
function detailRepeat<T extends THREE.Texture>(tex: T, repeat: number): T {
  tex.repeat.set(repeat, repeat);
  return tex;
}

const KERB_COLORS: Record<Biome, [string, string]> = {
  temperate: ['#d22a22', '#f2f2f2'],
  autumn: ['#d22a22', '#f2f2f2'],
  desert: ['#d22a22', '#f2f2f2'],
  coastal: ['#1f5fc4', '#f2f2f2'],
  city: ['#d22a22', '#f2f2f2'],
  tropical: ['#d22a22', '#f2f2f2'],
};

const RUNOFF_BAND: Record<Biome, string> = {
  temperate: '#2f5b8c',
  autumn: '#8a4b23',
  desert: '#c9502a',
  coastal: '#1f6fae',
  city: '#3f4a8a',
  tropical: '#2f5b8c',
};

/** Outer edge skirt of the run-off ribbons: reaches below the terrain lowered around the corridor. */
const RUNOFF_SKIRT_Y = -1.2;
/** Sausage kerbs: corners that form a chicane (opposite corner within this many metres), hump dimensions (m). */
/** Kerb runs taper in and out over this distance (m). */
const KERB_TAPER = 8;
const SAUSAGE_CHICANE_GAP = 140;
const SAUSAGE_LENGTH = 26;
const SAUSAGE_WIDTH = 0.7;
const SAUSAGE_HEIGHT = 0.1;
/** Samples over which the hump rises / falls at its ends. */
const SAUSAGE_RAMP = 6;
/** Only where the regular kerb is at least this wide (m) and the wall stays this far (m) beyond the hump. */
const SAUSAGE_MIN_KERB = 0.6;
const SAUSAGE_MIN_CLEAR = 1.2;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

export function buildRoad(ctx: SceneryContext, gridSlots: number): RoadParts {
  const { track: t, frame: f, disposer } = ctx;
  const n = t.count;
  const group = new THREE.Group();
  group.name = 'road';
  const wetMaterials: RoadParts['wetMaterials'] = [];
  const addWet = (m: THREE.MeshStandardMaterial, dry: number, wet: number, reflect: number): void => {
    wetMaterials.push({ material: m, dryRoughness: dry, wetRoughness: wet, dryColor: m.color.clone(), ...(m.normalMap ? { dryNormalScale: m.normalScale.x } : {}) });
    applyWetReflectionMask(m, reflect);
  };
  const detail = ctx.quality.surfaceDetail;
  const pitSide = f.pitSign;

  // ── asphalt ribbon + pit lane / apron (one material) ──
  const road = new GeoBuilder(true);
  const tile = 12;
  // per vertex: (lateral, racing-line lateral, rubber intensity, half width); the pit lane / apron gets no racing-line rubber
  // and no dusty edge
  const rubber: number[] = [];
  const addRow = (i: number, sOff: number, lats: number[], dy = 0, onLine = true): number => {
    const k = wrapIndex(i, n);
    const k1 = wrapIndex(i + 1, n);
    const slope = (t.py[k1] - t.py[k]) / Math.max(0.01, t.spacing);
    // N = R x T (points up)
    const tx = t.tx[k];
    const tz = t.tz[k];
    const nx = -tx * slope;
    const ny = tx * tx + tz * tz;
    const nz = -tz * slope;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const first = road.vertexCount;
    const line = Number.isFinite(t.racingLine?.[k]) ? t.racingLine[k] : 0;
    const amount = onLine ? rubberIntensity(t, k) : 0;
    road.setColor(_tone.setScalar(onLine ? asphaltTone(t.s[k], t.length, ctx.seed) : 1));
    for (const lat of lats) {
      sidePoint(t, k, lat, dy, _a);
      road.vertex(_a.x, _a.y, _a.z, nx / nl, ny / nl, nz / nl, lat / tile, sOff / tile);
      rubber.push(lat, line, amount, onLine ? t.halfWidth[k] : 0);
    }
    return first;
  };
  for (let i = 0; i <= n; i++) {
    const k = wrapIndex(i, n);
    const hw = t.halfWidth[k];
    addRow(i, t.s[k] + (i === n ? t.length : 0), [-hw, hw]);
    if (i > 0) {
      const a = road.vertexCount - 4;
      road.quad(a, a + 1, a + 3, a + 2);
    }
  }
  // pit lane + apron on the pit side (road edge -> pit-side outer wall / garage fronts)
  for (const [start, len] of segmentRuns(n, (i) => f.inPit[i] === 1 && f.inPit[wrapIndex(i + 1, n)] === 1)) {
    let prev = -1;
    for (let j = 0; j <= len; j++) {
      const i = start + j;
      const k = wrapIndex(i, n);
      const hw = t.halfWidth[k];
      const outer = pitSide > 0 ? f.barrierR[k] : f.barrierL[k];
      const lats = pitSide > 0 ? [hw, Math.max(hw + 0.5, outer)] : [-Math.max(hw + 0.5, outer), -hw];
      const row = addRow(i, t.s[k] + (i >= n ? t.length : 0), lats, -0.004, false);
      if (prev >= 0) road.quad(prev, prev + 1, row + 1, row);
      prev = row;
    }
  }
  const asphaltTex = disposer.add(asphaltTexture(ctx.anisotropy, 11, ctx.quality.asphaltTexSize));
  const roadMat = disposer.add(new THREE.MeshStandardMaterial({ name: 'asphalt', map: asphaltTex, roughness: 0.92, metalness: 0, vertexColors: true }));
  const asphaltDetail = detail ? asphaltDetailMaps(ctx.anisotropy) : null;
  if (asphaltDetail) {
    roadMat.normalMap = disposer.add(detailRepeat(asphaltDetail.normal, ASPHALT_DETAIL_REPEAT));
    roadMat.normalScale.setScalar(0.35);
    roadMat.roughnessMap = disposer.add(detailRepeat(asphaltDetail.roughness, ASPHALT_DETAIL_REPEAT));
  }
  applyRubberShader(roadMat);
  addWet(roadMat, 0.92, 0.22, WET_REFLECT_SHARE.asphalt);
  const roadGeo = road.build();
  if (roadGeo) {
    roadGeo.setAttribute('rubber', new THREE.Float32BufferAttribute(rubber, 4));
    disposer.add(roadGeo);
    const m = new THREE.Mesh(roadGeo, roadMat);
    m.receiveShadow = true;
    m.name = 'asphalt';
    group.add(m);
  }

  // ── kerbs (raised, sloped, striped along s) ──
  const kerb = new GeoBuilder();
  const kerbTile = 2;
  // Visual kerb width per side and sample: the engine's kerb zones start and end with a full-width step, so each run tapers
  // in and out over KERB_TAPER metres (no blunt strip ends and no zig-zag outer edge); the run-off ribbons start at this edge.
  const kerbVis = { [-1]: new Float64Array(n), [1]: new Float64Array(n) };
  const taperN = Math.max(1, Math.round(KERB_TAPER / Math.max(0.01, t.spacing)));
  for (const side of [-1, 1] as const) {
    const raw = (k: number): number => (f.inPit[k] && side === pitSide ? 0 : Math.max(0, side > 0 ? t.kerbRight[k] : t.kerbLeft[k]));
    for (const [start, len] of segmentRuns(n, (i) => raw(i) > 0.05 || raw(wrapIndex(i + 1, n)) > 0.05)) {
      for (let j = 0; j <= len; j++) {
        const k = wrapIndex(start + j, n);
        kerbVis[side][k] = raw(k) * smoothstep(0, 1, Math.min(j, len - j) / taperN);
      }
    }
  }
  for (const side of [-1, 1] as const) {
    const widthAt = (k: number): number => kerbVis[side][k];
    const runs = segmentRuns(n, (i) => widthAt(i) > 0.05 || widthAt(wrapIndex(i + 1, n)) > 0.05);
    for (const [start, len] of runs) {
      let prev = -1;
      for (let j = 0; j <= len; j++) {
        const i = start + j;
        const k = wrapIndex(i, n);
        const w = Math.max(0, widthAt(k));
        const hw = t.halfWidth[k];
        const sv = (t.s[wrapIndex(start, n)] + j * t.spacing) / kerbTile;
        const profile: [number, number, number][] = [
          [hw, 0.0, 0],
          [hw + 0.35 * w, 0.05 * Math.min(1, w), 0.35],
          [hw + w, 0.03 * Math.min(1, w), 1],
          [hw + w + 0.02, -0.02, 1],
        ];
        const first = kerb.vertexCount;
        for (const [lat, dy, u] of side > 0 ? profile : [...profile].reverse()) {
          sidePoint(t, k, side * lat, dy, _a);
          kerb.vertex(_a.x, _a.y, _a.z, 0, 1, 0, u, sv);
        }
        if (prev >= 0) for (let q = 0; q < 3; q++) kerb.quad(prev + q, prev + q + 1, first + q + 1, first + q);
        prev = first;
      }
    }
  }
  // sausage kerbs: a raised, striped hump beyond the kerb on the inside of chicane apexes
  const nCorner = t.corners.length;
  for (let c = 0; c < nCorner && nCorner > 1; c++) {
    const a = t.corners[c];
    const next = t.corners[(c + 1) % nCorner];
    const prev = t.corners[(c + nCorner - 1) % nCorner];
    const gapAfter = (((next.startS - a.endS) % t.length) + t.length) % t.length;
    const gapBefore = (((a.startS - prev.endS) % t.length) + t.length) % t.length;
    const chicane = (a.direction !== next.direction && gapAfter < SAUSAGE_CHICANE_GAP) || (a.direction !== prev.direction && gapBefore < SAUSAGE_CHICANE_GAP);
    if (!chicane) continue;
    const side = a.direction;
    const first = Math.round((a.apexS - SAUSAGE_LENGTH / 2) / t.spacing);
    const count = Math.round(SAUSAGE_LENGTH / t.spacing);
    let prevRow = -1;
    for (let j = 0; j <= count; j++) {
      const k = wrapIndex(first + j, n);
      const kw = kerbVis[side][k];
      const wall = side > 0 ? f.barrierR[k] : f.barrierL[k];
      // the hump starts exactly at the kerb's outer edge (same lat / height as its last profile vertex: no seam, no grass gap)
      const inner = t.halfWidth[k] + kw + 0.02;
      if (kw < SAUSAGE_MIN_KERB || f.inPit[k] || t.deck[k] || wall - (inner + SAUSAGE_WIDTH) < SAUSAGE_MIN_CLEAR) {
        prevRow = -1;
        continue;
      }
      // taper in / out over the run so the hump starts and ends flush with the ground (smooth, not a 3-sample ramp)
      const ramp = smoothstep(0, 1, Math.min(j, count - j) / SAUSAGE_RAMP);
      const h = SAUSAGE_HEIGHT * ramp * smoothstep(SAUSAGE_MIN_KERB, SAUSAGE_MIN_KERB + 0.4, kw);
      const profile: [number, number, number][] = [
        [inner, -0.02, 0],
        [inner + 0.22 * SAUSAGE_WIDTH, h, 0.3],
        [inner + 0.78 * SAUSAGE_WIDTH, h, 0.7],
        [inner + SAUSAGE_WIDTH, 0, 1],
      ];
      // same stripe phase and pitch as the kerb, so the bands continue across the join
      const sv = t.s[k] / kerbTile;
      const row = kerb.vertexCount;
      for (const [lat, dy, u] of side > 0 ? profile : [...profile].reverse()) {
        sidePoint(t, k, side * lat, dy, _a);
        kerb.vertex(_a.x, _a.y, _a.z, 0, 1, 0, u, sv);
      }
      if (prevRow >= 0) for (let q = 0; q < 3; q++) kerb.quad(prevRow + q, prevRow + q + 1, row + q + 1, row + q);
      prevRow = row;
    }
  }
  const kerbGeo = kerb.build(true);
  if (kerbGeo) {
    disposer.add(kerbGeo);
    const [ka, kb] = KERB_COLORS[ctx.biome];
    const kerbMat = disposer.add(new THREE.MeshStandardMaterial({ name: 'kerb', map: disposer.add(kerbTexture(ctx.anisotropy, ka, kb)), roughness: 0.7 }));
    if (detail) {
      kerbMat.normalMap = disposer.add(kerbNormalTexture(ctx.anisotropy));
      kerbMat.normalScale.setScalar(0.8);
    }
    addWet(kerbMat, 0.7, 0.2, WET_REFLECT_SHARE.kerb);
    const m = new THREE.Mesh(kerbGeo, kerbMat);
    m.receiveShadow = true;
    m.name = 'kerbs';
    group.add(m);
  }

  // ── run-off ribbons by surface ──
  const builders = [new GeoBuilder(true), new GeoBuilder(true), new GeoBuilder(true)];
  const runoffTile = [6, 5, 8];
  const toneSeed = ctx.seed % 100000;
  for (const side of [-1, 1] as const) {
    const plan = runoffPlan(n, t.spacing, (i) => {
      const i1 = wrapIndex(i + 1, n);
      if (f.inPit[i] && f.inPit[i1] && side === pitSide) return -1;
      const inner0 = t.halfWidth[i] + kerbVis[side][i];
      const inner1 = t.halfWidth[i1] + kerbVis[side][i1];
      if ((side > 0 ? f.barrierR[i] : f.barrierL[i]) - inner0 < 0.2 && (side > 0 ? f.barrierR[i1] : f.barrierL[i1]) - inner1 < 0.2) return -1;
      const surf = side > 0 ? t.runoffSurfaceRight[i] : t.runoffSurfaceLeft[i];
      return surf > 2 ? (ctx.street ? 2 : 0) : ctx.street && surf === 0 ? 2 : surf;
    });
    // one strip of the ribbon between lateral shares [from, to] of the run-off width (and the outer skirt when it reaches the wall)
    const strip = (i: number, surf: number, from0: number, to0: number, from1: number, to1: number): void => {
      if (to0 - from0 < 1e-3 && to1 - from1 < 1e-3) return;
      const i1 = wrapIndex(i + 1, n);
      const b = builders[surf];
      const tileM = runoffTile[surf];
      const inner0 = t.halfWidth[i] + kerbVis[side][i];
      const inner1 = t.halfWidth[i1] + kerbVis[side][i1];
      const w0 = Math.max(0, (side > 0 ? f.barrierR[i] : f.barrierL[i]) - inner0);
      const w1 = Math.max(0, (side > 0 ? f.barrierR[i1] : f.barrierL[i1]) - inner1);
      const lats = [inner0 + from0 * w0, inner0 + to0 * w0, inner1 + to1 * w1, inner1 + from1 * w1];
      const v0 = t.s[i] / tileM;
      const v1 = (t.s[i] + t.spacing) / tileM;
      const base = b.vertexCount;
      lats.forEach((l, c) => {
        sidePoint(t, c < 2 ? i : i1, side * l, -0.012, _a);
        b.setColor(runoffTone(surf, ctx.biome, _a.x, _a.z, toneSeed, _tone));
        b.vertex(_a.x, _a.y, _a.z, 0, 1, 0, l / tileM, c < 2 ? v0 : v1);
      });
      if (side > 0) b.quad(base, base + 1, base + 2, base + 3);
      else b.quad(base, base + 3, base + 2, base + 1);
      if (to0 < 1 || to1 < 1) return;
      // outer skirt down into the lowered terrain (no visible step under barriers / from outside)
      const nx = side * t.rx[i];
      const nz = side * t.rz[i];
      const skirt = b.vertexCount;
      for (const [k, l, y, v] of [[i, lats[1], -0.012, v0], [i1, lats[2], -0.012, v1], [i1, lats[2], RUNOFF_SKIRT_Y, v1], [i, lats[1], RUNOFF_SKIRT_Y, v0]] as const) {
        sidePoint(t, k, side * l, y, _a);
        b.setColor(runoffTone(surf, ctx.biome, _a.x, _a.z, toneSeed, _tone));
        b.vertex(_a.x, _a.y, _a.z, nx, 0, nz, v, -y / tileM);
      }
      if (side > 0) b.quad(skirt, skirt + 3, skirt + 2, skirt + 1);
      else b.quad(skirt, skirt + 1, skirt + 2, skirt + 3);
    };
    for (let i = 0; i < n; i++) {
      const p = plan[i];
      if (!p) continue;
      strip(i, p.inner, 0, p.share0, 0, p.share1);
      strip(i, p.outer, p.share0, 1, p.share1, 1);
    }
  }
  // mown verge turf: muted, real-world greens (a picked swatch reads neon under full sun)
  const grassBase = ctx.biome === 'desert' ? '#a39256' : ctx.biome === 'autumn' ? '#6a7a3c' : ctx.biome === 'tropical' ? '#4b7a36' : '#557a3c';
  const runoffMats = [
    new THREE.MeshStandardMaterial({ name: 'runoff-grass', map: disposer.add(grassTexture(ctx.anisotropy, grassBase, 21, GROUND_SATURATION[ctx.biome], GROUND_VALUE[ctx.biome])), roughness: 0.95, vertexColors: true }),
    new THREE.MeshStandardMaterial({ name: 'runoff-gravel', map: disposer.add(gravelTexture(ctx.anisotropy)), roughness: 1, vertexColors: true }),
    new THREE.MeshStandardMaterial({ name: 'runoff-asphalt', map: disposer.add(runoffAsphaltTexture(ctx.anisotropy, RUNOFF_BAND[ctx.biome])), roughness: 0.85, vertexColors: true }),
  ];
  if (detail) {
    runoffMats[0].normalMap = disposer.add(detailRepeat(noiseNormalTexture(ctx.anisotropy, 23, 256, 32, 0.6, 1.6), 2));
    runoffMats[0].normalScale.setScalar(0.7);
    runoffMats[1].normalMap = disposer.add(pebbleNormalTexture(ctx.anisotropy));
    runoffMats[1].normalScale.setScalar(0.9);
    if (asphaltDetail) {
      // same images as the road (shared GPU source), repeat matched to the 8 m run-off tile
      runoffMats[2].normalMap = disposer.add(detailRepeat(asphaltDetail.normal.clone(), ASPHALT_DETAIL_REPEAT * (8 / tile)));
      runoffMats[2].normalScale.setScalar(0.5);
      runoffMats[2].roughnessMap = disposer.add(detailRepeat(asphaltDetail.roughness.clone(), ASPHALT_DETAIL_REPEAT * (8 / tile)));
    }
  }
  builders.forEach((b, idx) => {
    const g = b.build();
    const mat = disposer.add(runoffMats[idx]);
    if (!g) return;
    disposer.add(g);
    if (idx !== 1) addWet(mat, mat.roughness, idx === 0 ? 0.6 : 0.3, idx === 0 ? WET_REFLECT_SHARE.grass : WET_REFLECT_SHARE.runoffAsphalt);
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.name = mat.name;
    group.add(m);
  });

  // ── painted markings (vertex coloured, one draw call) ──
  const paint = new GeoBuilder(true);
  const white = new THREE.Color('#f4f4f2');
  paint.setColor(white);
  const lineStrip = (i0: number, segs: number, latA: (k: number) => number, latB: (k: number) => number, dy: number): void => {
    let prev = -1;
    for (let j = 0; j <= segs; j++) {
      const k = wrapIndex(i0 + j, n);
      const a = latA(k);
      const b = latB(k);
      sidePoint(t, k, Math.min(a, b), dy, _a);
      sidePoint(t, k, Math.max(a, b), dy, _b);
      const row = paint.vertexCount;
      paint.vertex(_a.x, _a.y, _a.z, 0, 1, 0, 0, 0);
      paint.vertex(_b.x, _b.y, _b.z, 0, 1, 0, 1, 0);
      if (prev >= 0) paint.quad(prev, prev + 1, row + 1, row);
      prev = row;
    }
  };
  // edge lines
  lineStrip(0, n, (k) => -t.halfWidth[k] + 0.12, (k) => -t.halfWidth[k] + 0.34, 0.012);
  lineStrip(0, n, (k) => t.halfWidth[k] - 0.34, (k) => t.halfWidth[k] - 0.12, 0.012);
  // pit lane edge lines on the pit straight
  const lane = (k: number): number => Math.abs(f.pitLane[k]);
  for (const [start, len] of segmentRuns(n, (i) => f.pitStraight[i] === 1 && f.pitStraight[wrapIndex(i + 1, n)] === 1)) {
    const sgn = pitSide;
    lineStrip(start, len, (k) => sgn * (lane(k) - PIT_LANE_HALF + 0.05), (k) => sgn * (lane(k) - PIT_LANE_HALF + 0.3), 0.01);
    lineStrip(start, len, (k) => sgn * (lane(k) + PIT_LANE_HALF - 0.3), (k) => sgn * (lane(k) + PIT_LANE_HALF - 0.05), 0.01);
  }
  // entry / exit separation lines along the ramps (inner edge of the lane once it is off the road)
  for (const [start, len] of segmentRuns(
    n,
    (i) => f.inPit[i] === 1 && f.pitStraight[i] === 0 && lane(i) - PIT_LANE_HALF > t.halfWidth[i] + 0.3 && lane(wrapIndex(i + 1, n)) - PIT_LANE_HALF > t.halfWidth[wrapIndex(i + 1, n)] + 0.3,
  )) {
    const sgn = pitSide;
    lineStrip(start, len, (k) => sgn * (lane(k) - PIT_LANE_HALF), (k) => sgn * (lane(k) - PIT_LANE_HALF + 0.25), 0.01);
  }
  // quad helper in the local frame of a track pose
  const localQuad = (s: number, lat: number, along0: number, along1: number, lat0: number, lat1: number, dy: number): void => {
    const p = poseAt(t, wrapS(t, s), lat);
    if (!Number.isFinite(p.x)) return;
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    const rx = -fz;
    const rz = fx;
    const pt = (al: number, la: number, out: THREE.Vector3): THREE.Vector3 => out.set(p.x + fx * al + rx * la, p.y + dy, p.z + fz * al + rz * la);
    pt(along0, lat0, _a);
    pt(along0, lat1, _b);
    pt(along1, lat1, _c);
    pt(along1, lat0, _d);
    const base = paint.vertexCount;
    paint.vertex(_a.x, _a.y, _a.z, 0, 1, 0, 0, 0);
    paint.vertex(_b.x, _b.y, _b.z, 0, 1, 0, 1, 0);
    paint.vertex(_c.x, _c.y, _c.z, 0, 1, 0, 1, 1);
    paint.vertex(_d.x, _d.y, _d.z, 0, 1, 0, 0, 1);
    paint.quad(base, base + 1, base + 2, base + 3);
  };
  // grid slots: bracket ahead of each car (front line + two short side lines)
  const slots = Math.max(2, Math.min(30, Math.floor(gridSlots)));
  for (let k = 0; k < slots; k++) {
    const sCentre = -(GRID_LAYOUT.firstSlot + k * GRID_LAYOUT.spacing);
    const poleSide = GRID_LAYOUT.poleSide * t.pit.side;
    const lat = (k % 2 === 0 ? poleSide : -poleSide) * GRID_LAYOUT.lateral;
    localQuad(sCentre, lat, 2.9, 3.12, -1.15, 1.15, 0.013);
    localQuad(sCentre, lat, 1.6, 2.9, -1.15, -0.93, 0.013);
    localQuad(sCentre, lat, 1.6, 2.9, 0.93, 1.15, 0.013);
  }
  // DRS detection (single) and activation (double) lines
  for (const z of t.drsZones) {
    const det = poseAt(t, wrapS(t, z.detection), 0);
    const hwDet = halfWidthAt(ctx, z.detection);
    if (Number.isFinite(det.x)) localQuad(z.detection, 0, -0.15, 0.15, -hwDet + 0.4, hwDet - 0.4, 0.013);
    const hwAct = halfWidthAt(ctx, z.activation);
    localQuad(z.activation, 0, -0.45, -0.25, -hwAct + 0.4, hwAct - 0.4, 0.013);
    localQuad(z.activation, 0, 0.25, 0.45, -hwAct + 0.4, hwAct - 0.4, 0.013);
  }
  // pit-lane speed limit lines + team-coloured boxes
  {
    const yellow = new THREE.Color('#f2c230');
    paint.setColor(yellow);
    const ramp = f.pitRamp;
    const laneMid = (s: number): number => {
      const k = Math.round(wrapS(t, s) / Math.max(0.01, t.spacing)) % n;
      return f.pitLane[k] || t.pit.laneOffset;
    };
    for (const s of [t.pit.entry + ramp, t.pit.exit - ramp]) {
      localQuad(s, laneMid(s), -0.2, 0.2, -PIT_LANE_HALF + 0.3, PIT_LANE_HALF - 0.3, 0.012);
    }
    const teamColors = ctx.teamColors.slice(0, PIT_BOX_COUNT);
    while (teamColors.length < PIT_BOX_COUNT) teamColors.push('#9aa0a8');
    for (let b = 0; b < PIT_BOX_COUNT; b++) {
      const s = t.pit.box + (b - (PIT_BOX_COUNT - 1) / 2) * PIT_BOX_SPACING;
      const lat = laneMid(s) + pitSide * PIT_BOX_LATERAL;
      paint.setColor(new THREE.Color(teamColors[b]));
      localQuad(s, lat, -2.6, 2.6, -1.1, 1.1, 0.011);
      paint.setColor(white);
      localQuad(s, lat, -3.0, -2.8, -1.4, 1.4, 0.012);
      localQuad(s, lat, 2.8, 3.0, -1.4, 1.4, 0.012);
    }
  }
  const paintGeo = paint.build();
  if (paintGeo) {
    disposer.add(paintGeo);
    const paintMat = disposer.add(
      new THREE.MeshStandardMaterial({ name: 'paint', vertexColors: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    );
    addWet(paintMat, 0.6, 0.18, WET_REFLECT_SHARE.paint);
    const m = new THREE.Mesh(paintGeo, paintMat);
    m.receiveShadow = true;
    m.name = 'paint';
    group.add(m);
  }

  // ── chequered start / finish line ──
  {
    const b = new GeoBuilder();
    const p0 = poseAt(t, wrapS(t, -0.6), 0);
    const p1 = poseAt(t, wrapS(t, 0.6), 0);
    const hw = halfWidthAt(ctx, 0);
    for (const [p, v] of [[p0, 0], [p1, 1]] as const) {
      const rx = -Math.cos(p.yaw);
      const rz = Math.sin(p.yaw);
      b.vertex(p.x - rx * hw, p.y + 0.014, p.z - rz * hw, 0, 1, 0, 0, v);
      b.vertex(p.x + rx * hw, p.y + 0.014, p.z + rz * hw, 0, 1, 0, 1, v);
    }
    b.quad(0, 1, 3, 2);
    const g = b.build();
    if (g) {
      disposer.add(g);
      const mat = disposer.add(
        new THREE.MeshStandardMaterial({ name: 'start-line', map: disposer.add(checkerTexture()), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }),
      );
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      m.name = 'startLine';
      group.add(m);
    }
  }
  return { group, wetMaterials };
}

/** One run-off segment (sample i to i + 1): the surface on the track side, the one beyond it and the track-side share of the width at both rows. */
export interface RunoffSegment {
  inner: number;
  outer: number;
  share0: number;
  share1: number;
}

/** Where the run-off changes surface the boundary runs diagonally over this many metres (picked per boundary), not straight across. */
export const RUNOFF_TAPER_M: readonly [number, number] = [8, 16];

/**
 * Run-off layout of one side: `surfAt(i)` is the surface of segment i (0 grass, 1 gravel, 2 paved; −1 = none). At a change of
 * surface the higher one (paved > gravel > grass) keeps the track side and its share of the width eases from all to none over
 * the taper, so traps and paved strips end in a curve instead of a straight cut across the ribbon.
 */
export function runoffPlan(n: number, spacing: number, surfAt: (i: number) => number): (RunoffSegment | null)[] {
  const surf = Array.from({ length: n }, (_, i) => surfAt(i));
  const plan = surf.map((s) => (s < 0 ? null : { inner: s, outer: s, share0: 1, share1: 1 }));
  const runLength = (from: number, step: number, s: number): number => {
    let len = 0;
    while (len < n && surf[wrapIndex(from + step * len, n)] === s) len++;
    return len;
  };
  for (let b = 0; b < n; b++) {
    const s0 = surf[wrapIndex(b - 1, n)];
    const s1 = surf[b];
    if (s0 < 0 || s1 < 0 || s0 === s1) continue;
    const want = (RUNOFF_TAPER_M[0] + (RUNOFF_TAPER_M[1] - RUNOFF_TAPER_M[0]) * hash3(b, 5, 77)) / 2 / Math.max(0.01, spacing);
    const half = Math.min(Math.round(want), Math.floor(runLength(b - 1, -1, s0) / 2), Math.floor(runLength(b, 1, s1) / 2));
    if (half < 1) continue;
    const inner = Math.max(s0, s1);
    const share = (row: number): number => {
      const x = smoothstep(0, 1, (row - (b - half)) / (2 * half));
      return inner === s0 ? 1 - x : x;
    };
    for (let k = b - half; k < b + half; k++) {
      plan[wrapIndex(k, n)] = { inner, outer: Math.min(s0, s1), share0: share(k), share1: share(k + 1) };
    }
  }
  return plan;
}

const _tone = new THREE.Color();

/** Asphalt tone along the lap: a slow drift (± share over ASPHALT_DRIFT_M) and resurfaced patches (one ASPHALT_PATCH_CELL_M cell in
 * ASPHALT_PATCH_ODDS gets a darker or lighter stretch of fresh binder with edges crisp to one 2 m segment). */
export const ASPHALT_DRIFT = 0.09;
export const ASPHALT_DRIFT_M = 60;
export const ASPHALT_PATCH = 0.2;
export const ASPHALT_PATCH_CELL_M = 90;
export const ASPHALT_PATCH_ODDS = 0.4;

/** Colour multiplier of the racing surface at lap distance s (vertex colour of its rows). */
export function asphaltTone(s: number, length: number, seed: number): number {
  const drift = periodicNoise1D(s / ASPHALT_DRIFT_M, Math.max(1, Math.round(length / ASPHALT_DRIFT_M)), seed + 61) * 2 - 1;
  const cell = Math.floor(s / ASPHALT_PATCH_CELL_M);
  const from = hash3(cell, 1, seed + 67) * 0.4 * ASPHALT_PATCH_CELL_M;
  const len = (0.3 + 0.3 * hash3(cell, 2, seed + 67)) * ASPHALT_PATCH_CELL_M;
  const at = s - cell * ASPHALT_PATCH_CELL_M;
  const patch = hash3(cell, 3, seed + 67) < ASPHALT_PATCH_ODDS && at >= from && at <= from + len ? (hash3(cell, 4, seed + 67) < 0.6 ? -1 : 1) : 0;
  return 1 + ASPHALT_DRIFT * drift + ASPHALT_PATCH * patch;
}

/**
 * Baked colour variation of the run-off (vertex colours, linear multipliers): the verge carries the terrain's own broad patches
 * (terrain.ts, same noise and seed, so it meets the ground beyond the wall in the same pattern) plus finer mown patches; gravel
 * has damp, darker beds; paved run-off weathered tones.
 */
export function runoffTone(surf: number, biome: Biome, x: number, z: number, seed: number, out: THREE.Color): THREE.Color {
  if (surf === 0) {
    const [r, g, b] = groundTint(biome, fbm2D(x / GROUND_MACRO_SCALE[0], z / GROUND_MACRO_SCALE[0], 2, seed), valueNoise2D(x / GROUND_MACRO_SCALE[1], z / GROUND_MACRO_SCALE[1], seed + 17));
    const k = 1 + RUNOFF_TONE.grass * (valueNoise2D(x / 17, z / 17, seed + 29) * 2 - 1);
    return out.setRGB(r * k, g * k, b * k);
  }
  if (surf === 1) {
    const damp = 1 - fbm2D(x / 21, z / 21, 2, seed + 41);
    return out.setRGB(1 - RUNOFF_TONE.gravel * damp, 1 - RUNOFF_TONE.gravel * 0.95 * damp, 1 - RUNOFF_TONE.gravel * 0.75 * damp);
  }
  const k = 1 + RUNOFF_TONE.paved * (fbm2D(x / 33, z / 33, 2, seed + 53) * 2 - 1);
  return out.setRGB(k, k, k);
}

/** Strength of the run-off tone variation: verge patches (± share), gravel damp darkening (most), paved weathering (± share). */
export const RUNOFF_TONE = { grass: 0.12, gravel: 0.38, paved: 0.1 } as const;

export function halfWidthAt(ctx: SceneryContext, s: number): number {
  const t = ctx.track;
  const k = Math.round(wrapS(t, s) / Math.max(0.01, t.spacing)) % Math.max(1, t.count);
  const hw = t.halfWidth[k];
  return Number.isFinite(hw) ? hw : 6;
}
