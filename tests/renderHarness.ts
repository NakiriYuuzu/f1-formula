/**
 * Headless scenery harness: a fake 2D-canvas `document` (procedural textures run without a browser) and a builder
 * that assembles the static scenery of a BuiltTrack exactly like RaceScene does, plus draw-call / triangle counters.
 */
import * as THREE from 'three';
import type { Biome, BuiltTrack, QualityLevel, TimeOfDay } from '../src/core/types';
import { Disposer } from '../src/render/core/disposer';
import { qualityProfile } from '../src/render/core/quality';
import { TEAMS } from '../src/data/teams';
import type { SceneryContext } from '../src/render/track/context';
import type { LandmarkPlan } from '../src/render/track/landmarks';
import { buildStaticScenery } from '../src/render/track/scenery';
import { TrackFrame } from '../src/render/track/trackFrame';
import { GRADE_CLEARANCE } from '../src/track/track';

/** Install a minimal fake DOM (canvas with a recording-free 2D context) once. */
export function installFakeDom(): void {
  const g = globalThis as unknown as { document?: unknown };
  if (g.document) return;
  const ctx2d = (w: number, h: number): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'getImageData' || prop === 'createImageData') return (_x: number, _y: number, iw = w, ih = h) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih });
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
          if (prop === 'measureText') return () => ({ width: 10 });
          return () => undefined;
        },
        set: () => true,
      },
    );
  g.document = {
    createElement: () => {
      const c = { width: 1, height: 1, getContext: () => ctx2d(c.width, c.height) };
      return c;
    },
  };
}

export interface StaticScenery {
  root: THREE.Group;
  heightAtXZ: (x: number, z: number) => number;
  tvSpots: { index: number; s: number; position: THREE.Vector3 }[];
  ctx: SceneryContext;
  frame: TrackFrame;
  plan: LandmarkPlan;
  featureStandsBuilt: number;
  dispose(): void;
}

export interface StaticOptions {
  level?: QualityLevel;
  timeOfDay?: TimeOfDay;
  biome?: Biome;
  street?: boolean;
}

/** Scenery context of a track without building anything (plan / terrain tests). */
export function makeContext(track: BuiltTrack, opts: StaticOptions = {}): { ctx: SceneryContext; disposer: Disposer } {
  installFakeDom();
  const quality = qualityProfile(opts.level ?? 'high');
  const disposer = new Disposer();
  const frame = new TrackFrame(track);
  const ctx: SceneryContext = {
    track,
    frame,
    biome: opts.biome ?? track.def.biome,
    street: opts.street ?? track.def.street,
    timeOfDay: opts.timeOfDay ?? track.def.timeOfDay,
    quality,
    disposer,
    anisotropy: 1,
    seed: 12345,
    exclusions: [],
    lampMaterials: [],
    lampBase: [],
    terrainEdits: [],
    featureStands: [],
    tunnels: [],
    pitWing: false,
    teamColors: TEAMS.map((t) => t.livery.primary),
  };
  return { ctx, disposer };
}

export function buildStatic(track: BuiltTrack, opts: StaticOptions = {}): StaticScenery {
  const { ctx, disposer } = makeContext(track, opts);
  const frame = ctx.frame;
  const scenery = buildStaticScenery(ctx, 22);
  const root = scenery.root;
  return { root, heightAtXZ: scenery.heightAtXZ, tvSpots: scenery.tvSpots, ctx, frame, plan: scenery.plan, featureStandsBuilt: scenery.featureStandsBuilt, dispose: () => disposer.dispose() };
}

export interface SceneryStats {
  /** meshes (one draw call each, before view culling) */
  calls: number;
  /** meshes that also render in the shadow pass */
  shadowCasters: number;
  triangles: number;
}

/** Draw calls / triangles of everything under `root`, counting every instance of instanced meshes. */
export function sceneryStats(root: THREE.Object3D): SceneryStats {
  const out: SceneryStats = { calls: 0, shadowCasters: 0, triangles: 0 };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!(m as { isMesh?: boolean }).isMesh || !m.visible) return;
    const geo = m.geometry;
    const tris = (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
    out.calls++;
    if (m.castShadow) out.shadowCasters++;
    out.triangles += tris * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  });
  return out;
}

/**
 * Sight lines along the lower road of every grade-separated crossing: 10 m chords at driver (1.0 m) and chase-cam
 * (2.2 m) height over the lower road within `range` m of where it passes under a deck. Returns "mesh @s" for every chord
 * a scenery mesh blocks (e.g. a wall hanging from the bridge down to the lower road).
 */
export function underDeckBlockers(scene: StaticScenery, track: BuiltTrack, range = 60): string[] {
  const n = track.count;
  const near = new Uint8Array(n);
  const reach = Math.round(range / track.spacing);
  for (let i = 0; i < n; i++) {
    if (track.deck[i]) continue;
    for (let j = 0; j < n; j++) {
      if (!track.deck[j] || track.py[j] - track.py[i] < GRADE_CLEARANCE) continue;
      if (Math.hypot(track.px[j] - track.px[i], track.pz[j] - track.pz[i]) >= track.halfWidth[i] + track.halfWidth[j]) continue;
      for (let k = -reach; k <= reach; k++) near[(i + k + n) % n] = 1;
      break;
    }
  }
  const meshes: THREE.Mesh[] = [];
  scene.root.updateMatrixWorld(true);
  scene.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.visible) meshes.push(o as THREE.Mesh);
  });
  const step = Math.max(1, Math.round(10 / track.spacing));
  const ray = new THREE.Raycaster();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const out = new Set<string>();
  for (let i = 0; i < n; i++) {
    const k = (i + step) % n;
    if (!near[i] || !near[k] || track.deck[i] || track.deck[k]) continue;
    for (const h of [1.0, 2.2]) {
      a.set(track.px[i], track.py[i] + h, track.pz[i]);
      b.set(track.px[k], track.py[k] + h, track.pz[k]);
      ray.far = a.distanceTo(b);
      ray.set(a, b.sub(a).normalize());
      const hit = ray.intersectObjects(meshes, false)[0];
      if (hit) out.add(`${hit.object.name} @${Math.round(track.s[i])}`);
    }
  }
  return [...out];
}
