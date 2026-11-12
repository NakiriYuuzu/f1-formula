// Read-only probe: draw calls / triangles of the static scenery per quality tier (real layouts) and of one car model per tier / LOD.
const T = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, ''));
const THREE = await import(`${T}/node_modules/three/build/three.module.js`);
const { installFakeDom, buildStatic, sceneryStats } = await import(`${T}/tests/renderHarness`);
const { getLayout } = await import(`${T}/src/data/tracks/index`);
const { createCarModel } = await import(`${T}/src/render/car/carModel`);
const { CarSharedResources } = await import(`${T}/src/render/car/carMaterials`);
installFakeDom();
const ids = (process.argv[2] ?? 'monza').split(',');
const levels = ['low', 'medium', 'high', 'ultra'];
function tris(m: any): number { const g = m.geometry; return (g.index ? g.index.count : g.getAttribute('position').count) / 3 * (m.isInstancedMesh ? m.count : 1); }
for (const id of (process.env.CARS_ONLY ? [] : ids)) {
  const track = getLayout(id);
  for (const level of levels) {
    const t0 = performance.now();
    const s = buildStatic(track, { level });
    const st = sceneryStats(s.root);
    // instanced meshes / matrixAutoUpdate / transparent / material kinds
    const kinds: Record<string, number> = {}; let instanced = 0, transparent = 0, noCull = 0, autoUpd = 0, objs = 0, casters = 0, lights = 0, points = 0, lines = 0, sprites = 0;
    s.root.traverse((o: any) => {
      objs++;
      if (o.matrixAutoUpdate) autoUpd++;
      if (o.isLight) lights++;
      if (o.isPoints) points++;
      if (o.isLine || o.isLineSegments) lines++;
      if (o.isSprite) sprites++;
      if (!o.isMesh || !o.visible) return;
      if (o.isInstancedMesh) instanced++;
      if (o.frustumCulled === false) noCull++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { kinds[m.type] = (kinds[m.type] ?? 0) + 1; if (m.transparent) transparent++; }
    });
    console.log(JSON.stringify({ layout: id, level, buildMs: Math.round(performance.now() - t0), calls: st.calls, shadowCasters: st.shadowCasters, triangles: st.triangles, instancedMeshes: instanced, transparentMats: transparent, frustumCulledOff: noCull, objects: objs, matrixAutoUpdateObjs: autoUpd, lights, points, lines, sprites, matTypes: kinds }));
    s.dispose();
  }
}
// one car per tier: per-LOD mesh count / triangles
for (const level of levels) {
  const model = createCarModel({ livery: { primary: '#d22', secondary: '#fff', accent: '#000' }, number: 7, teamShort: 'TST', helmet: { primary: '#ff0', secondary: '#000', accent: '#fff' }, regulation: '2026', quality: level as any, shared: new CarSharedResources(level as any), textureSize: level === 'low' || level === 'medium' ? 512 : 1024 });
  const per: any[] = [];
  const lod = (model.nodes as any).lod;
  const levelsObj = lod ? lod.levels.map((l: any) => l.object) : [model.root];
  levelsObj.forEach((obj: any, i: number) => {
    let calls = 0, t = 0, cast = 0; const mt: Record<string, number> = {};
    obj.traverse((o: any) => { if (o.isMesh) { calls++; t += tris(o); if (o.castShadow) cast++; const m = Array.isArray(o.material) ? o.material[0] : o.material; mt[m.type] = (mt[m.type] ?? 0) + 1; } });
    per.push({ lod: i, meshes: calls, triangles: Math.round(t), shadowCastingMeshes: cast, mat: mt });
  });
  console.log(JSON.stringify({ car: level, lodDistances: lod ? lod.levels.map((l: any) => l.distance) : null, per }));
}
