// Read-only probe: what three's frustum culling leaves of the static scenery for a chase camera driven round the lap.
//   bun run tools/bench/perf/cull-probe.ts monza,spa low [stepMetres] [cellMetres]
// With a cell size the large merged meshes are split in memory by triangle centroid (instanced vegetation by instance
// position; the crowd is left alone, its instances are animated) and each cell is tested on its own bounding sphere:
// the submitted calls and triangles a spatial chunking would leave, without writing the chunking itself.
// The camera sits 7 m behind and 2.4 m above the centre line looking 30 m ahead (fov 68, 16:9, far 6500, like the chase
// view). A mesh counts as submitted when three's WebGLRenderer would draw it: frustumCulled === false or its bounding
// sphere meets the frustum. Cars, particles and sky are not in the static scenery, so the figures are scenery only.
const T = process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const THREE = await import(`${T}/node_modules/three/build/three.module.js`);
const { installFakeDom, buildStatic } = await import(`${T}/tests/renderHarness`);
const { getLayout } = await import(`${T}/src/data/tracks/index`);
installFakeDom();
const ids = (process.argv[2] ?? 'monza').split(',');
const level = process.argv[3] ?? 'low';
const step = Number(process.argv[4] ?? 100);
const cell = Number(process.argv[5] ?? 0);
const MIN_SPLIT_TRIS = 1500;

function tris(m: any): number {
  const g = m.geometry;
  return ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * (m.isInstancedMesh ? m.count : 1);
}
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;

for (const id of ids) {
  const track = getLayout(id);
  const s = buildStatic(track, { level });
  s.root.updateMatrixWorld(true);
  const meshes: any[] = [];
  s.root.traverse((o: any) => {
    if (o.isMesh && o.visible) meshes.push(o);
  });
  const name = (o: any): string => String(o.name || o.parent?.name || 'unnamed').replace(/[\d_.-]+$/, '');
  type Unit = { name: string; tris: number; sphere: any | null; obj: any; vis: number[] };
  const per: Unit[] = [];
  const _p = new THREE.Vector3();
  for (const o of meshes) {
    const nm = name(o);
    const t = tris(o);
    const identity = o.matrixWorld.equals(new THREE.Matrix4());
    if (cell > 0 && t >= MIN_SPLIT_TRIS && identity && nm !== 'crowd' && !o.isInstancedMesh) {
      const g = o.geometry;
      const pos = g.getAttribute('position');
      const idx = g.index;
      const n = idx ? idx.count : pos.count;
      const cells = new Map<number, { tris: number; pts: any[] }>();
      for (let i = 0; i < n; i += 3) {
        const a = idx ? idx.getX(i) : i;
        const b = idx ? idx.getX(i + 1) : i + 1;
        const c = idx ? idx.getX(i + 2) : i + 2;
        const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
        const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        const key = Math.floor(cz / cell) * 100003 + Math.floor(cx / cell);
        const e = cells.get(key) ?? { tris: 0, pts: [] };
        e.tris++;
        for (const v of [a, b, c]) e.pts.push(new THREE.Vector3(pos.getX(v), pos.getY(v), pos.getZ(v)));
        cells.set(key, e);
      }
      for (const e of cells.values()) {
        const box = new THREE.Box3().setFromPoints(e.pts);
        const ctr = box.getCenter(new THREE.Vector3());
        let r2 = 0;
        for (const q of e.pts) r2 = Math.max(r2, ctr.distanceToSquared(q));
        per.push({ name: nm, tris: e.tris, sphere: new THREE.Sphere(ctr, Math.sqrt(r2)), obj: o, vis: [] });
      }
    } else if (cell > 0 && o.isInstancedMesh && nm !== 'crowd' && t >= MIN_SPLIT_TRIS) {
      if (o.geometry.boundingSphere === null) o.geometry.computeBoundingSphere();
      const gr = o.geometry.boundingSphere.radius * 1.3;
      const per1 = t / o.count;
      const cells = new Map<number, any[]>();
      for (let i = 0; i < o.count; i++) {
        const e = o.instanceMatrix.array;
        _p.set(e[i * 16 + 12], e[i * 16 + 13], e[i * 16 + 14]);
        const key = Math.floor(_p.z / cell) * 100003 + Math.floor(_p.x / cell);
        const l = cells.get(key) ?? [];
        l.push(_p.clone());
        cells.set(key, l);
      }
      for (const pts of cells.values()) {
        const box = new THREE.Box3().setFromPoints(pts);
        const ctr = box.getCenter(new THREE.Vector3());
        per.push({ name: nm, tris: per1 * pts.length, sphere: new THREE.Sphere(ctr, box.getSize(new THREE.Vector3()).length() / 2 + gr), obj: o, vis: [] });
      }
    } else {
      per.push({ name: nm, tris: t, sphere: null, obj: o, vis: [] });
    }
  }
  const totalTris = per.reduce((a, e) => a + e.tris, 0);
  const cam = new THREE.PerspectiveCamera(68, 16 / 9, 0.2, 6500);
  const frustum = new THREE.Frustum();
  const m = new THREE.Matrix4();
  const calls: number[] = [];
  const trisSeen: number[] = [];
  const stride = Math.max(1, Math.round(step / track.spacing));
  for (let k = 0; k < track.count; k += stride) {
    const fx = track.tx[k]!;
    const fz = track.tz[k]!;
    cam.position.set(track.px[k]! - fx * 7, track.py[k]! + 2.4, track.pz[k]! - fz * 7);
    cam.lookAt(track.px[k]! + fx * 30, track.py[k]! + 1, track.pz[k]! + fz * 30);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m);
    let c = 0;
    let t = 0;
    for (const e of per) {
      const seen = e.obj.frustumCulled === false || (e.sphere ? frustum.intersectsSphere(e.sphere) : frustum.intersectsObject(e.obj));
      e.vis.push(seen ? e.tris : 0);
      if (seen) {
        c++;
        t += e.tris;
      }
    }
    calls.push(c);
    trisSeen.push(t);
  }
  const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  console.log(`${id} ${level}${cell > 0 ? ` cell ${cell} m` : ''}: ${per.length} draw calls (${meshes.length} meshes), ${Math.round(totalTris / 1000)}k triangles in the scene; ${calls.length} camera poses every ~${stride * track.spacing} m`);
  console.log(`  submitted per pose   calls mean ${mean(calls).toFixed(1)} median ${median(calls)} max ${Math.max(...calls)}   triangles mean ${Math.round(mean(trisSeen) / 1000)}k median ${Math.round(median(trisSeen) / 1000)}k max ${Math.round(Math.max(...trisSeen) / 1000)}k`);
  const byName = new Map<string, { n: number; tris: number; vis: number; calls: number }>();
  for (const e of per) {
    const r = byName.get(e.name) ?? { n: 0, tris: 0, vis: 0, calls: 0 };
    r.n++;
    r.tris += e.tris;
    r.vis += mean(e.vis);
    r.calls += e.vis.filter((v) => v > 0).length / Math.max(1, e.vis.length);
    byName.set(e.name, r);
  }
  const rows = [...byName.entries()].sort((a, b) => b[1].vis - a[1].vis);
  for (const [n, r] of rows.slice(0, 16)) {
    console.log(`  ${n.padEnd(24)} meshes ${String(r.n).padStart(3)}  total ${String(Math.round(r.tris / 1000) + 'k').padStart(5)}  submitted ${String(Math.round(r.vis / 1000) + 'k').padStart(5)} (${Math.round((r.vis / Math.max(1, r.tris)) * 100)}%)  calls ${r.calls.toFixed(1)}`);
  }
  s.dispose();
}
