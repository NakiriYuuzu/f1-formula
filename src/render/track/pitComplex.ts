/**
 * Pit complex along the main straight (pit wall + fence, garage block with 12 team-coloured roller
 * doors, hospitality glazing and roof overhang) and the start-light gantry with 5 light pairs driven
 * by RenderFrame.startLights.
 */
import * as THREE from 'three';
import { poseAt, wrapS } from '../../track/track';
import { GeoBuilder, addBox } from '../core/geometry';
import { concreteTexture, fenceTexture, noiseNormalTexture, shutterTexture } from '../core/surfaceTextures';
import { headingAt, segmentRuns, sidePoint, wrapIndex, type Exclusion, type SceneryContext } from './context';
import { halfWidthAt } from './road';
import { PIT_BOX_COUNT, PIT_BOX_SPACING } from './trackFrame';

/** Glazing: rough enough that the low sun does not turn a facade into one blinding highlight (and bloom). */
const GLASS_ROUGHNESS = 0.32;
const GLASS_METALNESS = 0.35;
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/** Pit building height (m): garages + two glazed storeys. The 'pit-building-wing' roof wave: wavelength, overhang over the apron (m). */
export const PIT_BUILDING_HEIGHT = 12.4;
const PIT_WING_WAVELENGTH = 70;
const PIT_WING_OVERHANG = 4.5;

export interface PitParts {
  group: THREE.Group;
  exclusions: Exclusion[];
}

export function buildPitComplex(ctx: SceneryContext): PitParts {
  const { track: t, frame: f, disposer } = ctx;
  const n = t.count;
  const group = new THREE.Group();
  group.name = 'pit';
  const ps = f.pitSign;
  const wall = new GeoBuilder();
  const building = new GeoBuilder();
  const glass = new GeoBuilder();
  const doors = new GeoBuilder(true);
  const fence = new GeoBuilder();
  const roof = new GeoBuilder();
  const exclusions: Exclusion[] = [];

  // vertical face helper (rows bottom/top), winding by facing direction
  const vface = (b: GeoBuilder, i0: number, len: number, lat: (k: number) => number, y0: number, y1: number, facingRight: boolean, uTile: number, vTile: number): void => {
    let prev = -1;
    const sgn = facingRight ? 1 : -1;
    for (let j = 0; j <= len; j++) {
      const k = wrapIndex(i0 + j, n);
      const u = (t.s[wrapIndex(i0, n)] + j * t.spacing) / uTile;
      sidePoint(t, k, lat(k), y0, _p);
      sidePoint(t, k, lat(k), y1, _q);
      const row = b.vertex(_p.x, _p.y, _p.z, t.rx[k] * sgn, 0, t.rz[k] * sgn, u, 0);
      b.vertex(_q.x, _q.y, _q.z, t.rx[k] * sgn, 0, t.rz[k] * sgn, u, (y1 - y0) / vTile);
      if (prev >= 0) {
        if (facingRight) b.quad(prev, row, row + 1, prev + 1);
        else b.quad(prev, prev + 1, row + 1, row);
      }
      prev = row;
    }
  };
  const hface = (b: GeoBuilder, i0: number, len: number, latA: (k: number) => number, latB: (k: number) => number, y: number, down = false): void => {
    let prev = -1;
    for (let j = 0; j <= len; j++) {
      const k = wrapIndex(i0 + j, n);
      sidePoint(t, k, Math.min(latA(k), latB(k)), y, _p);
      sidePoint(t, k, Math.max(latA(k), latB(k)), y, _q);
      const row = b.vertex(_p.x, _p.y, _p.z, 0, down ? -1 : 1, 0, 0, 0);
      b.vertex(_q.x, _q.y, _q.z, 0, down ? -1 : 1, 0, 1, 0);
      if (prev >= 0) {
        if (down) b.quad(prev, row, row + 1, prev + 1);
        else b.quad(prev, prev + 1, row + 1, row);
      }
      prev = row;
    }
  };

  /** Roof strip with a varying height: up-facing (top) or down-facing (underside). */
  const roofStrip = (b: GeoBuilder, i0: number, len: number, latA: (k: number) => number, latB: (k: number) => number, yAt: (k: number) => number, down: boolean): void => {
    let prev = -1;
    for (let j = 0; j <= len; j++) {
      const k = wrapIndex(i0 + j, n);
      const y = yAt(k);
      sidePoint(t, k, Math.min(latA(k), latB(k)), y, _p);
      sidePoint(t, k, Math.max(latA(k), latB(k)), y, _q);
      const row = b.vertex(_p.x, _p.y, _p.z, 0, down ? -1 : 1, 0, 0, t.s[k] / 8);
      b.vertex(_q.x, _q.y, _q.z, 0, down ? -1 : 1, 0, 1, t.s[k] / 8);
      if (prev >= 0) {
        if (down) b.quad(prev, row, row + 1, prev + 1);
        else b.quad(prev, prev + 1, row + 1, row);
      }
      prev = row;
    }
  };

  // ── pit wall (between track and pit lane) on the straight part ──
  const wallLat = Math.abs(t.pit.wallOffset) > 0.5 ? Math.abs(t.pit.wallOffset) : 0;
  for (const [i0, len] of segmentRuns(n, (i) => f.pitStraight[i] === 1 && f.pitStraight[wrapIndex(i + 1, n)] === 1)) {
    const inner = (k: number): number => ps * Math.max(t.halfWidth[k] + 1.2, wallLat || t.halfWidth[k] + 3) - ps * 0.25;
    const outer = (k: number): number => inner(k) + ps * 0.5;
    vface(wall, i0, len, inner, -0.3, 1.1, ps < 0, 8, 1.4);
    hface(wall, i0, len, inner, outer, 1.1);
    vface(wall, i0, len, outer, -0.3, 1.1, ps > 0, 8, 1.4);
    vface(fence, i0, len, (k) => inner(k) + ps * 0.25, 1.1, 3.4, ps < 0, 2, 2);
  }

  // ── garage block (front face on the pit-side outer wall line) ──
  const boxS = t.pit.box;
  const inBlock = (i: number): boolean => f.garage[wrapIndex(i, n)] === 1;
  const front = (k: number): number => ps * (ps > 0 ? f.barrierR[k] : f.barrierL[k]);
  const depthAt = (k: number): number => f.garageDepth[k];
  // three storeys: garages + two glazed hospitality floors (the 'wing' variant adds a wavy roof canopy)
  const height = PIT_BUILDING_HEIGHT;
  const back = (k: number): number => front(k) + ps * depthAt(k);
  for (const [i0, len] of segmentRuns(n, (i) => inBlock(i) && inBlock(wrapIndex(i + 1, n)))) {
    // front face (towards the lane): lower floor = doors zone, glazing band above
    vface(building, i0, len, front, -0.3, 5.2, ps < 0, 6, 6);
    vface(glass, i0, len, (k) => front(k) - ps * 0.02, 5.2, height - 0.9, ps < 0, 4, 3);
    vface(building, i0, len, front, height - 0.9, height, ps < 0, 6, 6);
    vface(building, i0, len, back, -0.3, height, ps > 0, 6, 6);
    // floor slab band + mullions of the glass facade
    vface(building, i0, len, (k) => front(k) - ps * 0.12, 8.1, 8.45, ps < 0, 6, 6);
    for (let j = 0; j <= len; j += Math.max(1, Math.round(5 / t.spacing))) {
      const k = wrapIndex(i0 + j, n);
      sidePoint(t, k, front(k) - ps * 0.1, (5.2 + height - 0.9) / 2, _p);
      addBox(building, _p.x, _p.y, _p.z, headingAt(t, k), 0.22, height - 6.1, 0.35, 1 / 6);
    }
    if (ctx.pitWing) {
      // wavy roof wing: overhangs the pit apron, thickness 0.6 m, wave along the straight
      const wave = (k: number): number => height + 1.1 + 1.3 * Math.sin((t.s[k] * Math.PI * 2) / PIT_WING_WAVELENGTH);
      roofStrip(roof, i0, len, (k) => front(k) - ps * PIT_WING_OVERHANG, back, (k) => wave(k) + 0.6, false);
      roofStrip(roof, i0, len, (k) => front(k) - ps * PIT_WING_OVERHANG, back, wave, true);
    } else hface(building, i0, len, front, back, height);
    // roof plant boxes (the wing's wavy roof stands above them: it replaces the flat roof)
    for (let j = 0; j <= len && !ctx.pitWing; j += Math.round(26 / t.spacing)) {
      const k = wrapIndex(i0 + j, n);
      sidePoint(t, k, (front(k) + back(k)) / 2, height + 0.9, _p);
      addBox(building, _p.x, _p.y, _p.z, headingAt(t, k), 6, 1.8, 4, 1 / 6);
    }
    // roof overhang above the apron
    const oh = (k: number): number => front(k) - ps * 3;
    hface(building, i0, len, oh, front, 5.6);
    hface(building, i0, len, oh, front, 5.4, true);
    // end caps
    for (const k of [wrapIndex(i0, n), wrapIndex(i0 + len, n)]) {
      const mid = (front(k) + back(k)) / 2;
      sidePoint(t, k, mid, height / 2 - 0.15, _p);
      addBox(building, _p.x, _p.y, _p.z, headingAt(t, k), depthAt(k), height + 0.3, 0.4, 1 / 6);
    }
    for (let j = 0; j <= len; j += 6) {
      const k = wrapIndex(i0 + j, n);
      sidePoint(t, k, (front(k) + back(k)) / 2, 0, _p);
      exclusions.push({ x: _p.x, z: _p.z, r: depthAt(k) + 8 });
    }
  }

  // ── garage doors (team colours) ──
  const colors = ctx.teamColors.slice(0, PIT_BOX_COUNT);
  while (colors.length < PIT_BOX_COUNT) colors.push('#8d939b');
  for (let b = 0; b < PIT_BOX_COUNT; b++) {
    const s = wrapS(t, boxS + (b - (PIT_BOX_COUNT - 1) / 2) * PIT_BOX_SPACING);
    const k = Math.round(s / Math.max(0.01, t.spacing)) % n;
    if (!inBlock(k)) continue;
    const lat = front(k) - ps * 0.06;
    const p = poseAt(t, s, lat);
    if (!Number.isFinite(p.x)) continue;
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    const nx = -ps * -Math.cos(p.yaw);
    const nz = -ps * Math.sin(p.yaw);
    const col = new THREE.Color(colors[b]);
    const quad = (along0: number, along1: number, y0: number, y1: number, c: THREE.Color, v1: number): void => {
      doors.setColor(c);
      const a = doors.vertex(p.x + fx * along0, p.y + y0, p.z + fz * along0, nx, 0, nz, 0, 0);
      doors.vertex(p.x + fx * along1, p.y + y0, p.z + fz * along1, nx, 0, nz, 1, 0);
      doors.vertex(p.x + fx * along1, p.y + y1, p.z + fz * along1, nx, 0, nz, 1, v1);
      doors.vertex(p.x + fx * along0, p.y + y1, p.z + fz * along0, nx, 0, nz, 0, v1);
      // facing towards the lane (-ps * R): for ps > 0 the face looks left
      if (ps > 0) doors.quad(a, a + 3, a + 2, a + 1);
      else doors.quad(a, a + 1, a + 2, a + 3);
    };
    quad(-5, 5, 0, 4.6, new THREE.Color(col).lerp(new THREE.Color('#ffffff'), 0.25), 1);
    quad(-6, 6, 4.65, 5.15, col, 0.05);
  }

  const addMesh = (b: GeoBuilder, mat: THREE.Material, name: string, cast: boolean): void => {
    disposer.add(mat);
    const g = b.build();
    if (!g) return;
    disposer.add(g);
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = true;
    group.add(m);
  };
  const conc = disposer.add(concreteTexture(ctx.anisotropy, '#d3d4d6'));
  const wallMat = new THREE.MeshStandardMaterial({ name: 'pit-wall', map: conc, roughness: 0.85 });
  if (ctx.quality.surfaceDetail) {
    wallMat.normalMap = disposer.add(noiseNormalTexture(ctx.anisotropy, 67, 256, 24, 0.55, 1.3));
    wallMat.normalMap.repeat.set(2, 1);
    wallMat.normalScale.setScalar(0.6);
  }
  addMesh(wall, wallMat, 'pitWall', true);
  addMesh(building, new THREE.MeshStandardMaterial({ name: 'garage', color: '#e7e8ea', roughness: 0.75 }), 'garages', true);
  addMesh(glass, new THREE.MeshStandardMaterial({ name: 'glazing', color: '#1d2b3c', roughness: GLASS_ROUGHNESS, metalness: GLASS_METALNESS, envMapIntensity: 0.6, emissive: new THREE.Color(ctx.timeOfDay === 'day' ? '#000000' : ctx.timeOfDay === 'dusk' ? '#2a2418' : '#3a3220') }), 'glazing', false);
  addMesh(doors, new THREE.MeshStandardMaterial({ name: 'garage-doors', map: disposer.add(shutterTexture()), vertexColors: true, roughness: 0.55, metalness: 0.2 }), 'garageDoors', false);
  addMesh(roof, new THREE.MeshStandardMaterial({ name: 'pit-wing-roof', color: '#f1f2f4', roughness: 0.45, metalness: 0.15, side: THREE.DoubleSide }), 'pitWingRoof', true);
  addMesh(fence, new THREE.MeshStandardMaterial({ name: 'pit-fence', map: disposer.add(fenceTexture(ctx.anisotropy)), alphaTest: 0.04, transparent: true, depthWrite: false, side: THREE.DoubleSide, metalness: 0.5, roughness: 0.5 }), 'pitFence', false);
  return { group, exclusions };
}

/** Start-light gantry over the grid; lights face the cars approaching the line. */
export class StartGantry {
  readonly group = new THREE.Group();
  private readonly lamps: THREE.InstancedMesh;
  private readonly on = new THREE.Color(1, 0.04, 0.02);
  private readonly off = new THREE.Color(0.06, 0.01, 0.01);
  private lastKey = '';

  constructor(ctx: SceneryContext) {
    const { track: t, disposer } = ctx;
    this.group.name = 'startGantry';
    const s = 4;
    const p = poseAt(t, wrapS(t, s), 0);
    const hw = halfWidthAt(ctx, s);
    const ok = Number.isFinite(p.x);
    this.group.position.set(ok ? p.x : 0, ok ? p.y : 0, ok ? p.z : 0);
    this.group.rotation.y = ok ? p.yaw : 0;
    const frame = new GeoBuilder();
    const span = hw + 1.4;
    // posts (local X = left, so +/- span covers both sides) and truss beam
    addBox(frame, span, 3.6, 0, 0, 0.45, 7.2, 0.45);
    addBox(frame, -span, 3.6, 0, 0, 0.45, 7.2, 0.45);
    addBox(frame, 0, 6.9, 0, 0, span * 2 + 0.45, 0.5, 0.5);
    addBox(frame, 0, 6.35, 0, 0, span * 2, 0.12, 0.35);
    // light panel (black housing) facing -Z (towards the grid)
    addBox(frame, 0, 5.75, -0.32, 0, 3.4, 1.3, 0.25);
    const fg = frame.build();
    const frameMat = disposer.add(new THREE.MeshStandardMaterial({ name: 'gantry', color: '#1b1c1f', roughness: 0.6, metalness: 0.4 }));
    if (fg) {
      disposer.add(fg);
      const m = new THREE.Mesh(fg, frameMat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    const disc = disposer.add(new THREE.CircleGeometry(0.17, 16));
    disc.rotateY(Math.PI);
    const lampMat = disposer.add(new THREE.MeshBasicMaterial({ name: 'start-lamp', color: '#ffffff', toneMapped: false }));
    this.lamps = disposer.add(new THREE.InstancedMesh(disc, lampMat, 10));
    this.lamps.name = 'startLamps';
    const m = new THREE.Matrix4();
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 2; r++) {
        // column 0 = leftmost as seen by the drivers on the grid (they look along +Z; their left is +X)
        m.makeTranslation(1.2 - c * 0.6, 6.0 - r * 0.45, -0.46);
        this.lamps.setMatrixAt(c * 2 + r, m);
        this.lamps.setColorAt(c * 2 + r, this.off);
      }
    }
    this.lamps.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
    this.lamps.computeBoundingSphere();
    this.group.add(this.lamps);
  }

  setLights(lit: number, out: boolean): void {
    const n = out ? 0 : Math.max(0, Math.min(5, Math.floor(Number.isFinite(lit) ? lit : 0)));
    const key = `${n}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 2; r++) this.lamps.setColorAt(c * 2 + r, c < n ? this.on : this.off);
    }
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }
}
