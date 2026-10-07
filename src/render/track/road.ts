/**
 * Racing surface: asphalt ribbon (incl. pit lane & apron), raised striped kerbs, run-off ribbons
 * (grass / gravel / painted asphalt), painted markings (edge lines, grid slots, pit lines & boxes, DRS
 * lines) and the chequered start/finish line. Static geometry is merged per material.
 */
import * as THREE from 'three';
import type { Biome } from '../../core/types';
import { smoothstep } from '../../core/math';
import { poseAt, wrapS } from '../../track/track';
import { GeoBuilder } from '../core/geometry';
import {
  asphaltTexture,
  checkerTexture,
  gravelTexture,
  grassTexture,
  kerbTexture,
  runoffAsphaltTexture,
} from '../core/surfaceTextures';
import { GRID_LAYOUT, segmentRuns, sidePoint, wrapIndex, type SceneryContext } from './context';
import { PIT_BOX_COUNT, PIT_BOX_LATERAL, PIT_BOX_SPACING, PIT_LANE_HALF } from './trackFrame';

export interface RoadParts {
  group: THREE.Group;
  /** materials that react to wetness (roughness / darkening) */
  wetMaterials: { material: THREE.MeshStandardMaterial; dryRoughness: number; wetRoughness: number; dryColor: THREE.Color }[];
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
  const addWet = (m: THREE.MeshStandardMaterial, dry: number, wet: number): void => {
    wetMaterials.push({ material: m, dryRoughness: dry, wetRoughness: wet, dryColor: m.color.clone() });
  };
  const pitSide = f.pitSign;

  // ── asphalt ribbon + pit lane / apron (one material) ──
  const road = new GeoBuilder();
  const tile = 12;
  const addRow = (i: number, sOff: number, lats: number[], dy = 0): number => {
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
    for (const lat of lats) {
      sidePoint(t, k, lat, dy, _a);
      road.vertex(_a.x, _a.y, _a.z, nx / nl, ny / nl, nz / nl, lat / tile, sOff / tile);
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
      const row = addRow(i, t.s[k] + (i >= n ? t.length : 0), lats, -0.004);
      if (prev >= 0) road.quad(prev, prev + 1, row + 1, row);
      prev = row;
    }
  }
  const asphaltTex = disposer.add(asphaltTexture(ctx.anisotropy));
  const roadMat = disposer.add(new THREE.MeshStandardMaterial({ name: 'asphalt', map: asphaltTex, roughness: 0.92, metalness: 0 }));
  addWet(roadMat, 0.92, 0.22);
  const roadGeo = road.build();
  if (roadGeo) {
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
    addWet(kerbMat, 0.7, 0.2);
    const m = new THREE.Mesh(kerbGeo, kerbMat);
    m.receiveShadow = true;
    m.name = 'kerbs';
    group.add(m);
  }

  // ── run-off ribbons by surface ──
  const builders = [new GeoBuilder(), new GeoBuilder(), new GeoBuilder()];
  const runoffTile = [6, 5, 8];
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < n; i++) {
      const i1 = wrapIndex(i + 1, n);
      if (f.inPit[i] && f.inPit[i1] && side === pitSide) continue;
      let surf = side > 0 ? t.runoffSurfaceRight[i] : t.runoffSurfaceLeft[i];
      if (surf > 2) surf = 0;
      if (ctx.street && surf === 0) surf = 2;
      const inner0 = t.halfWidth[i] + kerbVis[side][i];
      const inner1 = t.halfWidth[i1] + kerbVis[side][i1];
      const outer0 = side > 0 ? f.barrierR[i] : f.barrierL[i];
      const outer1 = side > 0 ? f.barrierR[i1] : f.barrierL[i1];
      if (outer0 - inner0 < 0.2 && outer1 - inner1 < 0.2) continue;
      const b = builders[surf];
      const tileM = runoffTile[surf];
      const s0 = t.s[i];
      const s1 = s0 + t.spacing;
      const lat = (v: number): number => side * v;
      sidePoint(t, i, lat(inner0), -0.012, _a);
      sidePoint(t, i, lat(Math.max(inner0, outer0)), -0.012, _b);
      sidePoint(t, i1, lat(Math.max(inner1, outer1)), -0.012, _c);
      sidePoint(t, i1, lat(inner1), -0.012, _d);
      const u0 = inner0 / tileM;
      const u1 = Math.max(inner0, outer0) / tileM;
      const v0 = s0 / tileM;
      const v1 = s1 / tileM;
      const base = b.vertexCount;
      b.vertex(_a.x, _a.y, _a.z, 0, 1, 0, u0, v0);
      b.vertex(_b.x, _b.y, _b.z, 0, 1, 0, u1, v0);
      b.vertex(_c.x, _c.y, _c.z, 0, 1, 0, u1, v1);
      b.vertex(_d.x, _d.y, _d.z, 0, 1, 0, u0, v1);
      if (side > 0) b.quad(base, base + 1, base + 2, base + 3);
      else b.quad(base, base + 3, base + 2, base + 1);
      // outer skirt down into the lowered terrain (no visible step under barriers / from outside)
      sidePoint(t, i, lat(Math.max(inner0, outer0)), RUNOFF_SKIRT_Y, _a);
      sidePoint(t, i1, lat(Math.max(inner1, outer1)), RUNOFF_SKIRT_Y, _d);
      const nx = side * t.rx[i];
      const nz = side * t.rz[i];
      const skirt = b.vertexCount;
      b.vertex(_b.x, _b.y, _b.z, nx, 0, nz, v0, 0);
      b.vertex(_c.x, _c.y, _c.z, nx, 0, nz, v1, 0);
      b.vertex(_d.x, _d.y, _d.z, nx, 0, nz, v1, -RUNOFF_SKIRT_Y / tileM);
      b.vertex(_a.x, _a.y, _a.z, nx, 0, nz, v0, -RUNOFF_SKIRT_Y / tileM);
      if (side > 0) b.quad(skirt, skirt + 3, skirt + 2, skirt + 1);
      else b.quad(skirt, skirt + 1, skirt + 2, skirt + 3);
    }
  }
  const grassBase = ctx.biome === 'desert' ? '#a39256' : ctx.biome === 'autumn' ? '#6a7a36' : ctx.biome === 'tropical' ? '#3f8a2c' : '#4f7d33';
  const runoffMats = [
    new THREE.MeshStandardMaterial({ name: 'runoff-grass', map: disposer.add(grassTexture(ctx.anisotropy, grassBase)), roughness: 0.95 }),
    new THREE.MeshStandardMaterial({ name: 'runoff-gravel', map: disposer.add(gravelTexture(ctx.anisotropy)), roughness: 1 }),
    new THREE.MeshStandardMaterial({ name: 'runoff-asphalt', map: disposer.add(runoffAsphaltTexture(ctx.anisotropy, RUNOFF_BAND[ctx.biome])), roughness: 0.85 }),
  ];
  builders.forEach((b, idx) => {
    const g = b.build();
    const mat = disposer.add(runoffMats[idx]);
    if (!g) return;
    disposer.add(g);
    if (idx !== 1) addWet(mat, mat.roughness, idx === 0 ? 0.6 : 0.3);
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
    addWet(paintMat, 0.6, 0.18);
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

export function halfWidthAt(ctx: SceneryContext, s: number): number {
  const t = ctx.track;
  const k = Math.round(wrapS(t, s) / Math.max(0.01, t.spacing)) % Math.max(1, t.count);
  const hw = t.halfWidth[k];
  return Number.isFinite(hw) ? hw : 6;
}
