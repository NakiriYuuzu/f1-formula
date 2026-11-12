// Read-only probe: where the triangles of the static scenery go, per mesh name, at one quality tier.
//   bun run tools/bench/perf/scene-breakdown.ts monza,spa low
const T = process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const { installFakeDom, buildStatic } = await import(`${T}/tests/renderHarness`);
const { getLayout } = await import(`${T}/src/data/tracks/index`);
installFakeDom();
const ids = (process.argv[2] ?? 'monza').split(',');
const level = process.argv[3] ?? 'low';

function tris(m: any): number {
  const g = m.geometry;
  return ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * (m.isInstancedMesh ? m.count : 1);
}

for (const id of ids) {
  const s = buildStatic(getLayout(id), { level });
  const byName = new Map<string, { calls: number; tris: number; culled: number; instanced: number; mat: string }>();
  s.root.traverse((o: any) => {
    if (!o.isMesh || !o.visible) return;
    const name = String(o.name || o.parent?.name || 'unnamed').replace(/[\d_.-]+$/, '');
    const e = byName.get(name) ?? { calls: 0, tris: 0, culled: 0, instanced: 0, mat: '' };
    e.calls++;
    e.tris += tris(o);
    if (o.frustumCulled !== false) e.culled++;
    if (o.isInstancedMesh) e.instanced += o.count;
    e.mat = (Array.isArray(o.material) ? o.material[0] : o.material).type;
    byName.set(name, e);
  });
  const rows = [...byName.entries()].sort((a, b) => b[1].tris - a[1].tris);
  const total = rows.reduce((a, [, e]) => a + e.tris, 0);
  console.log(`${id} ${level}: ${Math.round(total / 1000)}k triangles, ${rows.reduce((a, [, e]) => a + e.calls, 0)} draw calls`);
  for (const [name, e] of rows.slice(0, 18)) {
    console.log(`  ${name.padEnd(26)} ${String(Math.round(e.tris / 1000) + 'k').padStart(6)} ${String(Math.round((e.tris / total) * 100) + '%').padStart(4)}  calls ${String(e.calls).padStart(3)}  cullable ${String(e.culled).padStart(3)}  inst ${String(e.instanced).padStart(5)}  ${e.mat}`);
  }
  s.dispose();
}
