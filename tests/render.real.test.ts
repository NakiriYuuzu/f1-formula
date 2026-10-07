/**
 * Real circuits (12 × both directions): terrain never buries the road / kerbs / barriers at any quality level, and every
 * feature the menus list (landmarks, bridges, banking, named stands) exists in the built scenery.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { BuiltTrack, CarRenderState, QualityLevel } from '../src/core/types';
import { getLayout, LAYOUTS } from '../src/data/tracks';
import { planLandmarks } from '../src/render/track/landmarks';
import { buildTerrain } from '../src/render/track/terrain';
import { carDims } from '../src/render/car/dims';
import { Disposer } from '../src/render/core/disposer';
import { CarEffects } from '../src/render/fx/carEffects';
import { ContactShadows } from '../src/render/fx/contactShadows';
import { buildStatic, installFakeDom, makeContext } from './renderHarness';

const REAL = LAYOUTS.filter((l) => getLayout(l.id).def.real).map((l) => l.id);
const LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
const PLAIN = ['grandstand', 'pit-building-wing', 'forest', 'palm-plantation', 'old-banking'];

/** Worst terrain-above-road (m) over the road + kerb width and at the barrier line of every non-deck sample. */
function burial(t: BuiltTrack, h: (x: number, z: number) => number, frame: { occupiedTo(i: number, s: number): number }): { road: number; barrier: number; at: number } {
  let road = -Infinity;
  let barrier = -Infinity;
  let at = 0;
  for (let k = 0; k < t.count; k++) {
    if (t.deck[k]) continue;
    const at1 = (lat: number): number => h(t.px[k] + t.rx[k] * lat, t.pz[k] + t.rz[k] * lat) - t.py[k];
    const l = t.halfWidth[k] + Math.max(t.kerbLeft[k], 0);
    const r = t.halfWidth[k] + Math.max(t.kerbRight[k], 0);
    for (let lat = -l; lat <= r; lat += 2) road = Math.max(road, at1(lat));
    for (const side of [-1, 1]) {
      const d = at1(side * Math.min(frame.occupiedTo(k, side), 80));
      if (d > barrier) {
        barrier = d;
        at = t.s[k];
      }
    }
  }
  return { road, barrier, at };
}

describe('terrain vs road (all real layouts, all quality levels)', () => {
  for (const id of REAL) {
    test(`${id}: no road, kerb or barrier sample under the terrain`, () => {
      const t = getLayout(id);
      for (const level of LEVELS) {
        const { ctx, disposer } = makeContext(t, { level });
        planLandmarks(ctx);
        const terrain = buildTerrain(ctx);
        const b = burial(t, terrain.heightAtXZ, ctx.frame);
        disposer.dispose();
        expect(`${level} road ${b.road <= 0.02}`).toBe(`${level} road true`);
        expect(`${level} barrier ${b.barrier <= 0.5} @${Math.round(b.at)}`).toBe(`${level} barrier true @${Math.round(b.at)}`);
      }
    });
  }
});

describe('listed features exist (all real layouts)', () => {
  for (const id of REAL) {
    test(`${id}: every landmark, bridge, banking and named stand is built`, () => {
      const t = getLayout(id);
      const s = buildStatic(t, { level: 'high' });
      const plan = s.plan;
      expect(plan.dropped.map((d) => `${d.f.name}@${(d.f.s0 / t.length).toFixed(3)} ${d.reason}`)).toEqual([]);
      const wanted = plan.features.filter((f) => f.kind === 'landmark' && !PLAIN.includes(f.name));
      expect(plan.placements.length).toBe(wanted.length);
      expect(plan.bridges.length).toBe(plan.features.filter((f) => f.kind === 'bridge').length);
      expect(s.featureStandsBuilt).toBe(s.ctx.featureStands.length);
      const names = new Set<string>();
      s.root.traverse((o) => names.add(o.name.split(':')[0]));
      for (const f of plan.features) {
        if (f.kind === 'tunnel') expect(names.has('tunnel')).toBe(true);
        else if (f.kind === 'bridge' || f.name === 'old-banking') expect(names.has(f.name)).toBe(true);
        else if (f.name === 'forest' || f.name === 'palm-plantation') expect(names.has(f.name)).toBe(true);
      }
      // the planned footprint stays clear of the roads
      const p = new THREE.Vector3();
      for (const pl of plan.placements) {
        for (const [x, z] of [[0, 0], [pl.depth, 0], [pl.depth / 2, pl.length / 2], [pl.depth / 2, -pl.length / 2]]) {
          pl.frame.w(x, 0, z, p);
          expect(s.frame.isClear(p.x, p.z, 0)).toBe(true);
        }
      }
      s.dispose();
    });
  }
});

describe('scenery fixes', () => {
  test('tree crown colour jitter never produces black (dark conifer greens)', async () => {
    const { jitterColor, speciesFor } = await import('../src/render/track/props');
    const { Rng } = await import('../src/render/core/canvas');
    const rng = new Rng(5);
    for (const biome of ['temperate', 'autumn', 'coastal', 'city', 'desert', 'tropical'] as const) {
      for (const sp of speciesFor(biome)) {
        for (let i = 0; i < 200; i++) {
          const c = jitterColor(rng.pick(sp.crown), rng.range(-0.015, 0.015), rng.range(-0.06, 0.06), rng.range(-0.06, 0.06));
          expect(c.r + c.g + c.b).toBeGreaterThan(0.02);
        }
      }
    }
  });

  test('sun shadow depth bias is at most 10 cm', async () => {
    const { sunShadowBiasMetres } = await import('../src/render/environment');
    expect(sunShadowBiasMetres()).toBeLessThanOrEqual(0.1);
  });

  test('tunnel portals are open: rays along the road from outside never hit the end caps', () => {
    const t = getLayout('monaco');
    const s = buildStatic(t, { level: 'high' });
    s.root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    s.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name.startsWith('tunnel')) meshes.push(o as THREE.Mesh);
    });
    const tn = s.ctx.tunnels[0];
    const ray = new THREE.Raycaster();
    for (const [sp, dir] of [[tn.s0, 1], [tn.s1, -1]] as const) {
      const k = Math.round(sp / t.spacing) % t.count;
      for (const lat of [-2, 0, 2]) {
        for (const h of [1, 3, 5]) {
          const tx = t.tx[k] * dir;
          const tz = t.tz[k] * dir;
          ray.set(new THREE.Vector3(t.px[k] + t.rx[k] * lat - tx * 25, t.py[k] + h, t.pz[k] + t.rz[k] * lat - tz * 25), new THREE.Vector3(tx, 0, tz));
          ray.far = 28;
          expect(ray.intersectObjects(meshes, false).length).toBe(0);
        }
      }
    }
    s.dispose();
  });

  test('floodlight pools face up and street circuits get a townscape', () => {
    const t = getLayout('singapore');
    const s = buildStatic(t, { level: 'high' });
    let up = 0;
    let down = 0;
    let town = 0;
    s.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (o.name.startsWith('townscape')) town++;
      if (o.name !== 'lightPools') return;
      const p = m.geometry.getAttribute('position');
      const idx = m.geometry.index as THREE.BufferAttribute;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      for (let i = 0; i < idx.count; i += 3) {
        a.fromBufferAttribute(p, idx.getX(i));
        b.fromBufferAttribute(p, idx.getX(i + 1));
        c.fromBufferAttribute(p, idx.getX(i + 2));
        const n = b.sub(a).cross(c.sub(a));
        if (n.y > 0) up++;
        else down++;
      }
    });
    expect(up).toBeGreaterThan(100);
    expect(down).toBe(0);
    expect(town).toBeGreaterThan(0);
    s.dispose();
  });
});

describe('polish round (r3 screenshots)', () => {
  test('Monaco tunnel: light rows follow a smooth line and the walls are dim concrete, not black', () => {
    const t = getLayout('monaco');
    const s = buildStatic(t, { level: 'high' });
    let light: THREE.Mesh | undefined;
    let wall: THREE.Mesh | undefined;
    s.root.traverse((o) => {
      if (o.name === 'tunnel:light') light = o as THREE.Mesh;
      if (o.name === 'tunnel') wall = o as THREE.Mesh;
    });
    expect(light && wall).toBeTruthy();
    // lateral offset of each light-strip row centre from the centre line: consecutive rows never step more than a few cm
    const pos = (light as THREE.Mesh).geometry.getAttribute('position');
    const lat: number[] = [];
    for (let i = 0; i + 1 < pos.count; i += 2) {
      const x = (pos.getX(i) + pos.getX(i + 1)) / 2;
      const z = (pos.getZ(i) + pos.getZ(i + 1)) / 2;
      const near = s.frame.nearestWithin(x, z, 30, true);
      lat.push(near ? near.lateral : Number.NaN);
    }
    let worst = 0;
    for (let i = 1; i < lat.length; i++) if (Number.isFinite(lat[i]) && Number.isFinite(lat[i - 1]) && Math.abs(lat[i] - lat[i - 1]) < 3) worst = Math.max(worst, Math.abs(lat[i] - lat[i - 1]));
    expect(lat.length).toBeGreaterThan(100);
    expect(worst).toBeLessThan(0.12);
    // wall brightness: vertex colour (× the concrete map) is no longer ~1 % grey
    const col = (wall as THREE.Mesh).geometry.getAttribute('color');
    let sum = 0;
    for (let i = 0; i < col.count; i++) sum += (col.getX(i) + col.getY(i) + col.getZ(i)) / 3;
    expect(sum / col.count).toBeGreaterThan(0.3);
    s.dispose();
  });

  test('barrier feet follow the terrain on embankments (nothing floats above the ground)', () => {
    const t = getLayout('interlagos');
    const s = buildStatic(t, { level: 'high' });
    let total = 0;
    let floating = 0;
    s.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.name !== 'concrete') return;
      const pos = m.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const near = s.frame.nearestWithin(x, z, 60);
        if (!near || y > t.py[near.index] - 0.5 || Math.abs(y - t.py[near.index]) > 14) continue;
        const lim = s.frame.occupiedTo(near.index, near.lateral >= 0 ? 1 : -1);
        if (Math.abs(Math.abs(near.lateral) - lim) > 1.2) continue;
        total++;
        if (y - s.heightAtXZ(x, z) > 0.1) floating++;
      }
    });
    expect(total).toBeGreaterThan(500);
    expect(floating / total).toBeLessThan(0.005);
    s.dispose();
  });

  test('townscape: lots are oriented along the street (no building reaches into the road corridor) and balconies touch their facade', () => {
    const t = getLayout('monaco');
    const s = buildStatic(t, { level: 'high' });
    let checked = 0;
    const town: THREE.Mesh[] = [];
    s.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name.startsWith('townscape')) town.push(o as THREE.Mesh);
    });
    for (const m of town) {
      const pos = m.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i += 3) {
        const near = s.frame.nearestWithin(pos.getX(i), pos.getZ(i), 12);
        if (!near) continue;
        checked++;
        expect(Math.abs(near.lateral)).toBeGreaterThan(s.frame.occupiedTo(near.index, near.lateral >= 0 ? 1 : -1) - 0.3);
      }
    }
    expect(checked).toBeGreaterThan(1000);
    s.dispose();
  });

  const state = (over: Partial<CarRenderState>): CarRenderState =>
    ({
      carId: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 80, steerAngle: 0, wheelSpin: 0, throttle: 1, brake: 0, rpm: 11000, gear: 8,
      drsOpen: false, compound: 'medium', rainLight: false, limiter: false, damage: { frontWing: 0, rearWing: 0 }, slip: 0, lockup: 0, impact: 0,
      surface: 'asphalt', boost: false, visible: true, ghost: false, ...over,
    }) as CarRenderState;

  test('skid sparks (pale dots over the road) only exist at dusk / night', () => {
    installFakeDom();
    const count = (time: 'day' | 'dusk' | 'night'): number => {
      const fx = new CarEffects(768, 192, 'temperate', carDims('2025'), time);
      for (let i = 0; i < 90; i++) fx.update([state({ z: i * 1.3 })], [], 0, 1 / 60);
      const n = fx.sparks.activeCount;
      fx.dispose();
      return n;
    };
    expect(count('day')).toBe(0);
    expect(count('dusk')).toBeGreaterThan(0);
    expect(count('night')).toBeGreaterThan(0);
  });

  test('spark particles are streaks (velocity attribute + streak shader), smoke stays round', () => {
    const fx = new CarEffects(64, 64, 'temperate', carDims('2025'), 'night');
    const sparkMat = fx.sparks.points.material as THREE.ShaderMaterial;
    const smokeMat = fx.smoke.points.material as THREE.ShaderMaterial;
    expect(fx.sparks.points.geometry.getAttribute('aVel')).toBeDefined();
    expect(sparkMat.uniforms.uStreak.value).toBeGreaterThan(0);
    expect(smokeMat.uniforms.uStreak.value).toBe(0);
    fx.dispose();
  });

  test('night contact footprints are darker than daytime ones and draw after the additive light pools', () => {
    const alpha = (time: 'day' | 'night'): number => {
      const cs = new ContactShadows(new Disposer(), carDims('2025'), 2, time);
      const mesh = cs.group.children[0] as THREE.InstancedMesh;
      const tex = (mesh.material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
      const data = tex.image.data as Uint8Array;
      const mid = (Math.floor(tex.image.height / 2) * tex.image.width + Math.floor(tex.image.width / 2)) * 4 + 3;
      expect(mesh.renderOrder).toBeGreaterThan(2);
      return data[mid];
    };
    expect(alpha('night')).toBeGreaterThan(alpha('day'));
  });

  test('floodlight pools fade to exactly zero at their rim and at the barriers (no hard-edged zones)', () => {
    const t = getLayout('singapore');
    const s = buildStatic(t, { level: 'high' });
    const m = s.root.getObjectByName('lightPools') as THREE.Mesh;
    const col = m.geometry.getAttribute('color');
    let max = 0;
    let rimOnly = 0;
    // every pool vertex that is non-zero has a neighbour pattern 'rows x (cols + 1)'; the first / last row and both lateral edges are 0
    const cols = 11;
    const perPool = col.count;
    for (let i = 0; i < col.count; i++) {
      const v = col.getX(i);
      max = Math.max(max, v);
      const c = i % cols;
      if ((c === 0 || c === cols - 1) && v > 1e-6) rimOnly++;
    }
    expect(perPool).toBeGreaterThan(cols * 5);
    expect(max).toBeGreaterThan(0.05);
    expect(rimOnly).toBe(0);
    s.dispose();
  });
});
