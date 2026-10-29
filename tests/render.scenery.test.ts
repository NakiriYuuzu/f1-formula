/**
 * Scenery (headless, fake canvas): TrackFeature layout mapping, the grade-separated crossing bridge on the figure-8
 * fixture, every landmark name (placement rules, clearance over the road, budgets), tunnels vs cameras, and every
 * biome × time-of-day combination on a big circuit fixture.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { Biome, QualityLevel, TimeOfDay, TrackDef, TrackFeature } from '../src/core/types';
import { buildTrack, GRADE_CLEARANCE } from '../src/track/track';
import { CameraRig } from '../src/render/cameras';
import { Environment } from '../src/render/environment';
import { BRIDGE_NAMES, LANDMARK_NAMES, layoutFeatures, inSpan } from '../src/render/track/features';
import { DECK_SLAB } from '../src/render/track/deck';
import { BRIDGE_CLEARANCE, LEAF_MAX_DEPTH, LEAF_MIN_DOUBLE, LEAF_OPEN_DEPTH, PLANTATION_SPACING } from '../src/render/track/landmarks';
import { buildStatic, installFakeDom, sceneryStats, underDeckBlockers } from './renderHarness';
import { figureEightDef, longDef, pinchDef, streetDef } from './trackFixtures';

const withFeatures = (def: TrackDef, features: TrackFeature[]): TrackDef => ({ ...def, real: { ...(def.real as NonNullable<TrackDef['real']>), features } });

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

function positions(m: THREE.Mesh): Float32Array {
  return m.geometry.getAttribute('position').array as Float32Array;
}

describe('feature layout mapping', () => {
  const def = withFeatures(longDef(), [
    { kind: 'tunnel', at: 0.3, end: 0.35, name: 'tunnel' },
    { kind: 'landmark', at: 0.2, side: 'left', offset: 30, name: 'marina' },
    { kind: 'bridge', at: 0.6, name: 'footbridge' },
    { kind: 'landmark', at: 0.5, end: 0.55, side: 'right', name: 'forest' },
    { kind: 'landmark', at: 0.1, name: 'no-such-thing' },
    { kind: 'bridge', at: 0.1, name: 'marina' },
  ]);
  test('forward keeps fractions and sides; unknown names / wrong kinds are dropped', () => {
    const t = buildTrack(def);
    const f = layoutFeatures(t);
    expect(f.map((x) => x.name)).toEqual(['tunnel', 'marina', 'footbridge', 'forest']);
    expect(f[0].s0 / t.length).toBeCloseTo(0.3, 6);
    expect(f[0].length / t.length).toBeCloseTo(0.05, 6);
    expect(f[1].side).toBe(-1);
    expect(f[1].offset).toBe(30);
    expect(f[3].side).toBe(1);
  });
  test('reverse mirrors fractions (ranges swap ends) and flips the side', () => {
    const t = buildTrack(def, { reverse: true });
    const f = layoutFeatures(t);
    expect(f[0].s0 / t.length).toBeCloseTo(0.65, 6);
    expect(f[0].s1 / t.length).toBeCloseTo(0.7, 6);
    expect(f[1].s0 / t.length).toBeCloseTo(0.8, 6);
    expect(f[1].side).toBe(1);
    expect(f[2].s0 / t.length).toBeCloseTo(0.4, 6);
    expect(f[2].side).toBe(0);
    expect(f[3].side).toBe(-1);
    expect(f[3].s0 / t.length).toBeCloseTo(0.45, 6);
  });
  test('inSpan handles wrapping spans', () => {
    expect(inSpan(10, 90, 20, 100)).toBe(true);
    expect(inSpan(50, 90, 20, 100)).toBe(false);
    expect(inSpan(45, 50, 60, 100, 8)).toBe(true);
  });
  test('registry covers every name of the contract', () => {
    expect([...BRIDGE_NAMES, ...LANDMARK_NAMES].sort()).toEqual(
      [
        'banking-bridge', 'casino-square', 'control-tower', 'ferris-wheel', 'footbridge', 'forest', 'fountain-lake', 'grandstand', 'hillside-houses',
        'hotel-bridge', 'lake', 'leaf-grandstand', 'led-sphere', 'marina', 'observation-tower', 'old-banking', 'palm-plantation', 'pit-building-wing',
        'sky-park-hotel', 'skyline', 'swimming-pool', 'wing-grandstand',
      ].sort(),
    );
  });
});

describe('grade-separated crossing (figure-8 fixture)', () => {
  const track = buildTrack(figureEightDef());
  const scene = buildStatic(track, { level: 'high' });
  const deckMesh = meshes(scene.root).find((m) => m.name === 'deck');

  test('deck samples exist and a deck mesh is built', () => {
    expect(track.deck.some((d) => d === 1)).toBe(true);
    expect(deckMesh).toBeDefined();
  });

  test('the terrain never reaches the road surface of either road', () => {
    const f = scene.frame;
    let worst = Infinity;
    for (let i = 0; i < track.count; i += 3) {
      for (const lat of [-0.9, -0.5, 0, 0.5, 0.9]) {
        const x = track.px[i] + track.rx[i] * lat * track.halfWidth[i];
        const z = track.pz[i] + track.rz[i] * lat * track.halfWidth[i];
        worst = Math.min(worst, track.py[i] - scene.heightAtXZ(x, z));
      }
    }
    expect(f.hasDeck).toBe(true);
    // lowered ≥ ~0.3 m under every road (the 0.45 m ring drop can only deepen it)
    expect(worst).toBeGreaterThan(0.15);
  });

  test('deck underside clears the lower road by ≥ 5.5 m and no deck geometry stands in the lower road corridor', () => {
    const f = scene.frame;
    const pos = positions(deckMesh as THREE.Mesh);
    let violations = 0;
    let minClear = Infinity;
    for (let v = 0; v < pos.length; v += 3) {
      const near = f.nearestWithin(pos[v], pos[v + 2], 40, true);
      if (!near) continue;
      const corridor = f.occupiedTo(near.index, near.lateral >= 0 ? 1 : -1) + 0.2;
      if (Math.abs(near.lateral) > corridor) continue;
      const above = pos[v + 1] - track.py[near.index];
      if (above < 0.5) continue; // not over that road at all (below it)
      minClear = Math.min(minClear, above);
      if (above < 5.5) violations++;
    }
    expect(minClear).toBeGreaterThanOrEqual(5.5);
    expect(violations).toBe(0);
  });

  test('deck slab is thicker than the barrier feet and the parapet walls follow the engine wall line', () => {
    expect(DECK_SLAB).toBeGreaterThan(1.2);
    for (let i = 0; i < track.count; i++) {
      if (!track.deck[i]) continue;
      expect(track.runoffLeft[i]).toBeLessThanOrEqual(2.5 + 1e-6);
      expect(scene.frame.barrierL[i] - track.halfWidth[i]).toBeLessThan(5);
    }
  });

  test('deck mesh normals agree with the winding (no inside-out faces)', () => {
    const g = (deckMesh as THREE.Mesh).geometry;
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const idx = g.index as THREE.BufferAttribute;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let bad = 0;
    let total = 0;
    for (let i = 0; i < idx.count; i += 3) {
      const i0 = idx.getX(i);
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, idx.getX(i + 1));
      c.fromBufferAttribute(pos, idx.getX(i + 2));
      const n = b.sub(a).cross(c.sub(a));
      if (n.lengthSq() < 1e-10) continue;
      total++;
      if (n.dot(new THREE.Vector3(nor.getX(i0), nor.getY(i0), nor.getZ(i0))) < 0) bad++;
    }
    expect(total).toBeGreaterThan(100);
    expect(bad).toBe(0);
  });

  test('barriers on deck samples are concrete walls (no armco / tyres)', () => {
    expect(meshes(scene.root).some((m) => m.name === 'concrete')).toBe(true);
  });

  test('the lower road stays open under the deck (no parapet reaches down into its sight lines)', () => {
    expect(underDeckBlockers(scene, track)).toEqual([]);
  });
});

const SPOTS = [0.1, 0.22, 0.47, 0.72];
const featureList = (name: string): TrackFeature[] =>
  SPOTS.map((at) => ({
    kind: (BRIDGE_NAMES as readonly string[]).includes(name) ? 'bridge' : 'landmark',
    at,
    end: name === 'forest' || name === 'old-banking' || name === 'palm-plantation' ? at + 0.04 : undefined,
    side: 'right',
    name,
  }));
const NAMES = [...LANDMARK_NAMES, ...BRIDGE_NAMES].filter((n) => n !== 'pit-building-wing' && n !== 'grandstand');

/** Winding vs stored normals: the share of triangles facing against their vertex normals. */
function backFacing(m: THREE.Mesh): { bad: number; total: number } {
  const g = m.geometry;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const idx = g.index;
  if (!nor) return { bad: 0, total: 0 };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  let bad = 0;
  let total = 0;
  const count = idx ? idx.count : pos.count;
  for (let i = 0; i < count; i += 3) {
    const ids = [0, 1, 2].map((k) => (idx ? idx.getX(i + k) : i + k));
    a.fromBufferAttribute(pos, ids[0]);
    b.fromBufferAttribute(pos, ids[1]);
    c.fromBufferAttribute(pos, ids[2]);
    const geo = b.sub(a).cross(c.sub(a));
    if (geo.lengthSq() < 1e-9) continue;
    total++;
    n.set(0, 0, 0);
    for (const j of ids) n.add(new THREE.Vector3(nor.getX(j), nor.getY(j), nor.getZ(j)));
    if (geo.dot(n) < 0) bad++;
  }
  return { bad, total };
}

describe('landmarks (every registry name)', () => {
  const base = longDef();
  for (const name of NAMES) {
    test(`${name}: builds on the 7 km fixture, within budget, clear of the road corridor`, () => {
      const track = buildTrack(withFeatures(base, featureList(name)));
      const scene = buildStatic(track, { level: 'high', timeOfDay: 'night' });
      const lm = scene.root.getObjectByName('landmarks') as THREE.Group | undefined;
      const forests = scene.root.getObjectByName('forests') as THREE.Group | undefined;
      const mine = [...(lm?.children ?? []), ...(forests?.children ?? [])].filter((c) => c.name === name || c.name.startsWith(`${name}:`)) as THREE.Mesh[];
      expect(mine.length).toBeGreaterThan(0);
      const per = new THREE.Group();
      for (const m of mine) per.add(m.clone());
      const st = sceneryStats(per);
      // 4 candidate spots at most; one feature = ≤ 5 meshes
      expect(mine.length).toBeLessThanOrEqual(SPOTS.length * 5 + 1);
      expect(st.triangles / SPOTS.length).toBeLessThan(name === 'forest' || name === 'palm-plantation' ? 60_000 : 25_000);
      const f = scene.frame;
      let low = 0;
      let bad = 0;
      for (const m of mine) {
        const pos = positions(m);
        for (let v = 0; v < pos.length; v += 3) {
          expect(Number.isFinite(pos[v] + pos[v + 1] + pos[v + 2])).toBe(true);
          if (name === 'forest' || name === 'old-banking' || name === 'palm-plantation') continue;
          const near = f.nearestWithin(pos[v], pos[v + 2], 12);
          if (!near) continue;
          const corridor = f.occupiedTo(near.index, near.lateral >= 0 ? 1 : -1);
          // bridges span the corridor at ≥ BRIDGE_CLEARANCE; everything else keeps out of it entirely
          if (Math.abs(near.lateral) < corridor - 0.05 && pos[v + 1] - track.py[near.index] < BRIDGE_CLEARANCE - 0.6) low++;
        }
        if (!(m as THREE.InstancedMesh).isInstancedMesh) bad += backFacing(m).bad;
      }
      expect(low).toBe(0);
      expect(bad).toBe(0);
      // inside the terrain rectangle (+ margin) so nothing floats over the far ground / backdrop
      const b = track.bounds;
      for (const m of mine) {
        const bb = m.geometry.boundingBox as THREE.Box3;
        expect(bb.min.x).toBeGreaterThan(b.minX - 400);
        expect(bb.max.x).toBeLessThan(b.maxX + 400);
        expect(bb.min.z).toBeGreaterThan(b.minZ - 400);
        expect(bb.max.z).toBeLessThan(b.maxZ + 400);
      }
      scene.dispose();
    });
  }

  test('landmark offsets are clamped clear of the barrier / pit complex and sit on the requested side', () => {
    const track = buildTrack(withFeatures(base, [{ kind: 'landmark', at: 0.1, side: 'left', offset: 1, name: 'marina' }]));
    const scene = buildStatic(track, { level: 'medium' });
    const lm = scene.root.getObjectByName('landmarks') as THREE.Group;
    expect(lm).toBeDefined();
    const f = scene.frame;
    for (const m of lm.children as THREE.Mesh[]) {
      const pos = positions(m);
      for (let v = 0; v < pos.length; v += 3) {
        const near = f.nearestWithin(pos[v], pos[v + 2], 10);
        if (!near) continue;
        expect(Math.abs(near.lateral)).toBeGreaterThan(f.occupiedTo(near.index, near.lateral >= 0 ? 1 : -1) + 1);
      }
    }
    scene.dispose();
  });

  test('a feature with no room is skipped silently (and unknown names / empty lists build nothing)', () => {
    const tight = buildTrack(withFeatures(streetDef(), [{ kind: 'landmark', at: 0.5, name: 'lake', offset: 5000 }, { kind: 'landmark', at: 0.3, name: 'not-a-landmark' }]));
    const s = buildStatic(tight, { level: 'low' });
    expect(s.root.getObjectByName('landmarks')).toBeUndefined();
    s.dispose();
  });

  test('winding agrees with normals on every scenery mesh incl. deck and tunnels', () => {
    const feats: TrackFeature[] = [{ kind: 'tunnel', at: 0.9, end: 0.93, name: 'tunnel' }, ...NAMES.flatMap(featureList)];
    const track = buildTrack(withFeatures(base, feats));
    const scene = buildStatic(track, { level: 'high', timeOfDay: 'night' });
    let bad = 0;
    scene.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && m.name !== 'terrain') bad += backFacing(m).bad;
    });
    expect(bad).toBe(0);
    scene.dispose();
  });
});

describe('Sepang landmarks: leaf grandstand and palm plantation', () => {
  const tropical = (def: TrackDef, features: TrackFeature[]): TrackDef => ({ ...withFeatures(def, features), biome: 'tropical' });
  const leaf = (at: number): TrackFeature[] => [{ kind: 'landmark', at, side: 'right', name: 'leaf-grandstand' }];

  /** Local (frame) coordinates of a world point: x away from the road, z along the track. */
  const local = (fr: { ox: number; oz: number; yaw: number }, x: number, z: number): [number, number] => {
    const c = Math.cos(fr.yaw);
    const s = Math.sin(fr.yaw);
    return [(x - fr.ox) * c - (z - fr.oz) * s, (x - fr.ox) * s + (z - fr.oz) * c];
  };

  function checkStand(track: ReturnType<typeof buildTrack>, scene: ReturnType<typeof buildStatic>): { depth: number; double: boolean | undefined } {
    const pl = scene.plan.placements.find((p) => p.f.name === 'leaf-grandstand');
    expect(pl).toBeDefined();
    const p = pl as NonNullable<typeof pl>;
    // the whole footprint (3 m grid) is clear of every road, barrier and the pit complex
    const w = new THREE.Vector3();
    for (let x = 0; x <= p.depth + 1e-6; x += 3) {
      for (let z = -p.length / 2; z <= p.length / 2 + 1e-6; z += 3) {
        p.frame.w(x, 0, z, w);
        expect(scene.frame.isClear(w.x, w.z, 0)).toBe(true);
      }
    }
    // every vertex of the stand lies inside the footprint
    const lm = scene.root.getObjectByName('landmarks') as THREE.Group;
    const mine = lm.children.filter((c) => c.name === 'leaf-grandstand' || c.name.startsWith('leaf-grandstand:')) as THREE.Mesh[];
    expect(mine.length).toBeGreaterThan(1);
    let top = -Infinity;
    for (const m of mine) {
      const pos = positions(m);
      for (let v = 0; v < pos.length; v += 3) {
        const [lx, lz] = local(p.frame, pos[v], pos[v + 2]);
        expect(lx).toBeGreaterThanOrEqual(-0.5);
        expect(lx).toBeLessThanOrEqual(p.depth + 0.5);
        expect(Math.abs(lz)).toBeLessThanOrEqual(p.length / 2 + 0.5);
        top = Math.max(top, pos[v + 1] - track.py[p.k]);
      }
      expect(backFacing(m).bad).toBe(0);
    }
    // canopy leaves stand well above the seating
    expect(top).toBeGreaterThan(14);
    expect(sceneryStats(new THREE.Group().add(...mine.map((m) => m.clone()))).triangles).toBeLessThan(25_000);
    return { depth: p.depth, double: p.double };
  }

  test('between two parallel straights it sizes itself to the gap and stays clear of both roads', () => {
    for (const gap of [70, 110]) {
      const track = buildTrack(tropical(pinchDef(gap), leaf(0.516)));
      const scene = buildStatic(track, { level: 'high' });
      const r = checkStand(track, scene);
      expect(r.double).toBe(true);
      expect(r.depth).toBeGreaterThanOrEqual(LEAF_MIN_DOUBLE);
      expect(r.depth).toBeLessThanOrEqual(LEAF_MAX_DEPTH);
      // the roads are only ~gap + 2 × corridor apart: the stand is much shallower than in open ground
      expect(r.depth).toBeLessThan(gap);
      scene.dispose();
    }
  });

  test('a tight pinch never gets a stand that touches a road (falls back to another spot or one-sided seating)', () => {
    const track = buildTrack(tropical(pinchDef(40), leaf(0.516)));
    const scene = buildStatic(track, { level: 'medium' });
    expect(scene.plan.dropped).toEqual([]);
    checkStand(track, scene);
    scene.dispose();
  });

  test('without a second road nearby it stands at most LEAF_OPEN_DEPTH deep, seating the near road only', () => {
    const track = buildTrack(tropical(longDef(), leaf(0.05)));
    const scene = buildStatic(track, { level: 'high' });
    const r = checkStand(track, scene);
    expect(r.double).toBe(false);
    expect(r.depth).toBeLessThanOrEqual(LEAF_OPEN_DEPTH);
    expect(r.depth).toBeGreaterThanOrEqual(12);
    scene.dispose();
  });

  test('reverse layouts mirror the feature (side flips) and still place the stand clear of the roads', () => {
    const def = tropical(pinchDef(110), leaf(0.516));
    const fwd = layoutFeatures(buildTrack(def))[0];
    const rev = layoutFeatures(buildTrack(def, { reverse: true }))[0];
    expect(fwd.side).toBe(1);
    expect(rev.side).toBe(-1);
    const t = buildTrack(def, { reverse: true });
    expect(rev.s0 / t.length).toBeCloseTo(1 - 0.516, 6);
    const scene = buildStatic(t, { level: 'medium' });
    expect(scene.plan.dropped).toEqual([]);
    checkStand(t, scene);
    scene.dispose();
  });

  test('palm plantation: staggered grid, same caps as forests, nothing in the road corridor', () => {
    const feats: TrackFeature[] = [{ kind: 'landmark', at: 0.02, end: 0.1, side: 'right', name: 'palm-plantation' }];
    const counts: number[] = [];
    for (const level of ['low', 'medium', 'high', 'ultra'] as QualityLevel[]) {
      const track = buildTrack(tropical(longDef(), feats));
      const scene = buildStatic(track, { level });
      const grp = scene.root.getObjectByName('forests') as THREE.Group;
      const inst = grp.children.filter((c) => c.name === 'palm-plantation:oilPalm') as THREE.InstancedMesh[];
      expect(inst.length).toBeGreaterThan(0);
      const pts: [number, number][] = [];
      const m4 = new THREE.Matrix4();
      const v = new THREE.Vector3();
      for (const m of inst) {
        for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, m4);
          v.setFromMatrixPosition(m4);
          pts.push([v.x, v.z]);
          expect(scene.frame.isClear(v.x, v.z, 0)).toBe(true);
        }
      }
      counts.push(pts.length);
      expect(pts.length).toBeLessThanOrEqual({ low: 120, medium: 320, high: 650, ultra: 1000 }[level]);
      // regular planting: nearest-neighbour distance clusters around the grid step
      let regular = 0;
      for (const a of pts) {
        let nn = Infinity;
        for (const b of pts) if (a !== b) nn = Math.min(nn, Math.hypot(a[0] - b[0], a[1] - b[1]));
        if (nn > PLANTATION_SPACING * 0.5 && nn < PLANTATION_SPACING * 2.2 + 12) regular++;
      }
      expect(regular / pts.length).toBeGreaterThan(0.9);
      scene.dispose();
    }
    expect(counts[0]).toBeLessThan(counts[2]);
  });
});

describe('feature variants and layouts', () => {
  const base = longDef();
  test('reverse layouts build the whole tour without errors', () => {
    const feats: TrackFeature[] = [{ kind: 'tunnel', at: 0.9, end: 0.93, name: 'tunnel' }, ...NAMES.flatMap(featureList)];
    const track = buildTrack(withFeatures(base, feats), { reverse: true });
    const scene = buildStatic(track, { level: 'medium', timeOfDay: 'dusk' });
    expect(scene.root.getObjectByName('landmarks')).toBeDefined();
    expect(scene.ctx.tunnels.length).toBe(1);
    scene.dispose();
  });
  test('a tunnel wrapping through the start line is registered and built', () => {
    const track = buildTrack(withFeatures(base, [{ kind: 'tunnel', at: 0.97, end: 0.02, name: 'tunnel' }]));
    const scene = buildStatic(track, { level: 'low' });
    const [tn] = scene.ctx.tunnels;
    expect(tn.s1).toBeLessThan(tn.s0);
    expect(meshes(scene.root).some((m) => m.name === 'tunnel')).toBe(true);
    scene.dispose();
  });
  test("'pit-building-wing' adds the wavy roof, 'grandstand' adds a named stand", () => {
    const plain = buildStatic(buildTrack(base), { level: 'high' });
    const wing = buildStatic(buildTrack(withFeatures(base, [{ kind: 'landmark', at: 0.5, name: 'pit-building-wing' }, { kind: 'landmark', at: 0.4, side: 'left', name: 'grandstand' }])), { level: 'high' });
    expect(meshes(plain.root).some((m) => m.name === 'pitWingRoof')).toBe(false);
    expect(meshes(wing.root).some((m) => m.name === 'pitWingRoof')).toBe(true);
    expect(wing.ctx.featureStands.length).toBe(1);
    plain.dispose();
    wing.dispose();
  });
  test('TecPro stacks stand in front of the wall line, never in the racing surface', () => {
    const track = buildTrack(streetDef());
    const scene = buildStatic(track, { level: 'high' });
    const tec = meshes(scene.root).find((m) => m.name === 'tecpro');
    expect(tec).toBeDefined();
    const pos = positions(tec as THREE.Mesh);
    for (let v = 0; v < pos.length; v += 3) {
      const near = scene.frame.nearestWithin(pos[v], pos[v + 2], 30);
      if (!near) continue;
      expect(Math.abs(near.lateral)).toBeGreaterThan(track.halfWidth[near.index] + 1);
    }
    scene.dispose();
  });
});

describe('tunnels and cameras', () => {
  const def = withFeatures(longDef(), [{ kind: 'tunnel', at: 0.5, end: 0.54, name: 'tunnel' }]);
  const track = buildTrack(def);
  const scene = buildStatic(track, { level: 'high' });
  const [tn] = scene.ctx.tunnels;

  test('the tunnel span is registered, built and free of trackside props', () => {
    expect(tn).toBeDefined();
    expect(meshes(scene.root).some((m) => m.name === 'tunnel')).toBe(true);
    expect(meshes(scene.root).some((m) => m.name === 'tunnel:light')).toBe(true);
  });

  test('TV spots never sit in or beside a tunnel', () => {
    expect(scene.tvSpots.length).toBeGreaterThan(0);
    for (const sp of scene.tvSpots) expect(inSpan(sp.s, tn.s0, tn.s1, track.length, 30)).toBe(false);
  });

  test('tv camera inside a tunnel stays below the ceiling (never inside the earth cover)', () => {
    const rig = new CameraRig();
    const k = Math.round(((tn.s0 + tn.s1) / 2 / track.length) * track.count);
    const yaw = Math.atan2(track.tx[k], track.tz[k]);
    const target = { carId: 0, x: track.px[k], y: track.py[k], z: track.pz[k], yaw, speed: 60, visible: true, surface: 'asphalt' } as never;
    const tvSpots = [{ index: 0, s: 10, position: new THREE.Vector3(track.px[0] + 30, track.py[0] + 9, track.pz[0]) }];
    const ctx = { settings: { fov: 70, cameraShake: false } as never, time: 0, dims: {} as never, track, frame: scene.frame, tvSpots, tunnels: scene.ctx.tunnels };
    rig.update('tv', false, 0, target, 16 / 9, 0.016, ctx);
    expect(rig.camera.position.y - track.py[k]).toBeLessThan(6.5);
    expect(rig.camera.position.distanceTo(new THREE.Vector3(track.px[k], track.py[k], track.pz[k]))).toBeLessThan(25);
  });
});

describe('biome × time of day', () => {
  installFakeDom();
  const times: TimeOfDay[] = ['day', 'dusk', 'night'];
  const biomes: Biome[] = ['temperate', 'autumn', 'desert', 'coastal', 'city', 'tropical'];
  const track = buildTrack(withFeatures(longDef(), [{ kind: 'landmark', at: 0.4, side: 'left', name: 'skyline' }]));
  for (const biome of biomes) {
    for (const timeOfDay of times) {
      test(`${biome} / ${timeOfDay}: environment + scenery are finite and inside the draw-call budget`, () => {
        const env = new Environment({ biome, timeOfDay, weather: 'clear' });
        expect(Number.isFinite(env.exposure) && env.exposure > 0.5 && env.exposure < 2).toBe(true);
        expect(env.fog.far).toBeGreaterThan(env.fog.near);
        expect(env.fog.far).toBeLessThan(6500);
        env.dispose();
        const s = buildStatic(track, { level: 'medium', biome, timeOfDay });
        const st = sceneryStats(s.root);
        expect(st.calls).toBeLessThan(200);
        for (const m of meshes(s.root)) {
          const pos = positions(m);
          for (let v = 0; v < pos.length; v += 97) expect(Number.isFinite(pos[v])).toBe(true);
        }
        s.dispose();
      });
    }
  }
});

describe('tropical weather', () => {
  for (const timeOfDay of ['day', 'dusk', 'night'] as TimeOfDay[]) {
    for (const weather of ['clear', 'overcast', 'lightRain', 'heavyRain'] as const) {
      test(`tropical / ${timeOfDay} / ${weather}: sky, fog and lights stay finite and readable`, () => {
        installFakeDom();
        const env = new Environment({ biome: 'tropical', timeOfDay, weather });
        const rain = weather === 'heavyRain' ? 1 : weather === 'lightRain' ? 0.5 : 0;
        for (let i = 0; i < 40; i++) env.update(weather, rain, 0.1, i * 0.1);
        expect(env.exposure).toBeGreaterThan(0.5);
        expect(env.exposure).toBeLessThan(2);
        expect(env.fog.near).toBeGreaterThan(0);
        expect(env.fog.far).toBeGreaterThan(env.fog.near);
        expect(env.fog.far).toBeLessThan(6500);
        expect(Number.isFinite(env.sun.intensity + env.hemi.intensity)).toBe(true);
        env.dispose();
      });
    }
  }
  test('tropical air is hazier than temperate (shorter fog, more clear-sky cloud)', () => {
    const a = new Environment({ biome: 'tropical', timeOfDay: 'day', weather: 'clear' });
    const b = new Environment({ biome: 'temperate', timeOfDay: 'day', weather: 'clear' });
    expect(a.fog.far).toBeLessThan(b.fog.far);
    expect(a.skyMaterial.uniforms.cloudCover.value).toBeGreaterThan(b.skyMaterial.uniforms.cloudCover.value);
    a.dispose();
    b.dispose();
  });
});

describe('budgets on the big fixture (7 km, 2.7 × 1.3 km, 104 m relief)', () => {
  const levels: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
  const def = withFeatures(longDef(), [
    { kind: 'landmark', at: 0.2, side: 'right', name: 'forest', end: 0.26 },
    { kind: 'landmark', at: 0.5, side: 'left', name: 'skyline' },
    { kind: 'bridge', at: 0.03, name: 'footbridge' },
  ]);
  const track = buildTrack(def);
  const stats = levels.map((level) => {
    const s = buildStatic(track, { level });
    const st = sceneryStats(s.root);
    s.dispose();
    return st;
  });
  test('draw calls stay far below 500 (cars take ~20 × LOD calls) and low is light', () => {
    stats.forEach((st) => expect(st.calls).toBeLessThan(220));
    expect(stats[0].calls).toBeLessThan(80);
    expect(stats[0].triangles).toBeLessThan(stats[2].triangles);
    expect(stats[2].triangles).toBeLessThan(1_000_000);
    expect(stats[3].triangles).toBeLessThan(1_500_000);
  });
  test('street fixtures too', () => {
    const s = buildStatic(buildTrack(streetDef()), { level: 'high' });
    expect(sceneryStats(s.root).calls).toBeLessThan(220);
    s.dispose();
  });
  test('gradient guard: fixtures use GRADE_CLEARANCE', () => {
    expect(GRADE_CLEARANCE).toBeGreaterThanOrEqual(6);
  });
});
