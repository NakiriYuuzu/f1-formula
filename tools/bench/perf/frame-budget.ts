// Read-only probe: where the draw calls and triangles of a bench frame go, without a browser.
//   bun run tools/bench/perf/frame-budget.ts [tier=low] [lod=first,second]
// For each bench scenario it runs the headless sim of a 20-car race (all cars on the AI, so the pack differs a little from
// the bench's autopilot player), puts the chase camera 7 m behind and 2.2 m above car 10 (fov 68, 16:9) and counts what
// three's WebGLRenderer would submit from that pose:
//   scenery  the static scenery meshes whose bounding sphere meets the frustum
//   cars     every car in view at the LOD its distance picks (switch distances from the model, or `lod=` to try others)
//   crew     the pit crews' instanced meshes (drawn while a camera is within their view distance and the pit area is in view)
// The sum is compared with the measured bench rows of the low tier at DPR 1 (tools/bench/baseline/perf-render-gpu.txt).
// Sky, rain, particles and shadow/post passes are not counted, so only the low tier is comparable. Add a cut to the
// tier, rerun, and the counters move the way the bench's would.
const T = process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const THREE = await import(`${T}/node_modules/three/build/three.module.js`);
const { installFakeDom, buildStatic } = await import(`${T}/tests/renderHarness`);
const { createWorld, stepWorld, buildRenderFrame } = await import(`${T}/src/race/index`);
const { DEFAULT_RULES, SIM_DT } = await import(`${T}/src/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${T}/src/data/teams`);
const { getLayout } = await import(`${T}/src/data/tracks/index`);
const { createCarModel } = await import(`${T}/src/render/car/carModel`);
const { CarSharedResources } = await import(`${T}/src/render/car/carMaterials`);
const { lodFovScale } = await import(`${T}/src/render/car/carQuality`);
const { carDims } = await import(`${T}/src/render/car/dims`);
const { PitCrew } = await import(`${T}/src/render/track/pitCrew`);
installFakeDom();

const level = process.argv[2] ?? 'low';
const lodArg = (process.argv[3] ?? '').replace(/^lod=/, '');
const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');
const FOLLOWED = 10;
const FOV = 68;
// measured by the page (?bench=1&quality=low&dpr=1), median of 5 runs: calls, thousand triangles
const MEASURED: Record<string, [number, number]> = { 'grid-monza': [157, 522], 'pack-spa': [102, 329], 'rain-spa': [105, 327], 'night-singapore': [108, 427] };
const SCENARIOS = [
  { id: 'grid-monza', layout: 'monza', weather: 'clear', timeOfDay: 'day', runUp: 0 },
  { id: 'pack-spa', layout: 'spa', weather: 'clear', timeOfDay: 'day', runUp: 28 },
  { id: 'rain-spa', layout: 'spa', weather: 'heavyRain', timeOfDay: 'day', runUp: 28 },
  { id: 'night-singapore', layout: 'singapore', weather: 'clear', timeOfDay: 'night', runUp: 28 },
];

function tris(m: any): number {
  const g = m.geometry;
  return ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * (m.isInstancedMesh ? m.count : 1);
}

const model = createCarModel({ livery: { primary: '#d22', secondary: '#fff', accent: '#000' }, number: 7, teamShort: 'TST', helmet: { primary: '#ff0', secondary: '#000', accent: '#fff' }, regulation: '2026', quality: level as any, shared: new CarSharedResources(level as any), textureSize: level === 'low' || level === 'medium' ? 512 : 1024 });
const lod = (model.nodes as any).lod;
const carLod: { calls: number; tris: number }[] = lod.levels.map((l: any) => {
  let calls = 0;
  let t = 0;
  l.object.traverse((o: any) => {
    if (o.isMesh) {
      calls++;
      t += tris(o);
    }
  });
  return { calls, tris: t };
});
const thresholds: number[] = lodArg ? lodArg.split(',').map(Number) : lod.levels.slice(1).map((l: any) => l.distance);
const lodScale = lodFovScale(FOV);

const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const k = (v: number): string => `${Math.round(v / 1000)}k`;
console.log(`tier ${level}; car LOD1/LOD2 from ${thresholds.join(' / ')} m; car LOD calls/triangles ${carLod.map((c) => `${c.calls}/${k(c.tris)}`).join('  ')}`);

for (const sc of SCENARIOS) {
  const track = getLayout(sc.layout);
  const s = buildStatic(track, { level: level as any, timeOfDay: sc.timeOfDay as any });
  s.root.updateMatrixWorld(true);
  const meshes: any[] = [];
  s.root.traverse((o: any) => {
    if (o.isMesh && o.visible) meshes.push(o);
  });
  const crew = new PitCrew(s.ctx, carDims(), new Map());
  crew.group.updateMatrixWorld(true);
  const cfg: any = {
    mode: 'grandPrix', kind: 'race', layoutId: sc.layout, laps: 5, timeLimit: null, qualifyingLaps: 0,
    weather: sc.weather, dynamicWeather: false, timeOfDay: sc.timeOfDay, regulation: '2025', aiDifficulty: 85, players: [],
    grid: RACERS.map((d: any) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: 'medium' })),
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off' }, seed: 20251, ghost: null, objective: null,
  };
  const world = createWorld(cfg, track);
  for (let i = 0; i < Math.round(sc.runUp / SIM_DT); i++) {
    stepWorld(world, track, [], SIM_DT);
    world.events.length = 0;
  }
  const cam = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.2, 6500);
  const frustum = new THREE.Frustum();
  const m = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const acc = { sCalls: [] as number[], sTris: [] as number[], cCalls: [] as number[], cTris: [] as number[], kCalls: [] as number[], kTris: [] as number[] };
  // the bench times 300 frames (5 s of play) after 45 warm-up frames (0.75 s): sample that window
  const samples = sc.runUp === 0 ? 1 : 40;
  for (let n = 0; n < samples; n++) {
    for (let i = 0; i < Math.round((n === 0 ? 0.75 : 0.125) / SIM_DT) && sc.runUp > 0; i++) {
      stepWorld(world, track, [], SIM_DT);
      world.events.length = 0;
    }
    const frame = buildRenderFrame(world, track);
    const me = frame.cars[FOLLOWED];
    const fx = Math.sin(me.yaw);
    const fz = Math.cos(me.yaw);
    cam.position.set(me.x - fx * 7, me.y + 2.2, me.z - fz * 7);
    cam.lookAt(me.x + fx * 30, me.y + 1, me.z + fz * 30);
    cam.updateMatrixWorld(true);
    m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m);
    let sc1 = 0;
    let st = 0;
    for (const o of meshes) {
      if (o.frustumCulled === false || frustum.intersectsObject(o)) {
        sc1++;
        st += tris(o);
      }
    }
    let cc = 0;
    let ct = 0;
    for (const c of frame.cars) {
      sphere.set(new THREE.Vector3(c.x, c.y + 0.5, c.z), 3.5);
      if (!frustum.intersectsSphere(sphere)) continue;
      const d = Math.hypot(c.x - cam.position.x, c.y - cam.position.y, c.z - cam.position.z) * lodScale;
      let li = 0;
      for (let i = 0; i < thresholds.length; i++) if (d >= thresholds[i]!) li = i + 1;
      cc += carLod[li]!.calls;
      ct += carLod[li]!.tris;
    }
    crew.update(frame.cars, frame.time, [cam.position]);
    crew.update(frame.cars, frame.time + 1 / 60, [cam.position]);
    crew.group.updateMatrixWorld(true);
    let kc = 0;
    let kt = 0;
    if (crew.group.visible) {
      crew.group.traverse((o: any) => {
        if (!o.isMesh || !o.visible) return;
        if (o.frustumCulled === false || frustum.intersectsObject(o)) {
          kc++;
          kt += tris(o);
        }
      });
    }
    acc.sCalls.push(sc1);
    acc.sTris.push(st);
    acc.cCalls.push(cc);
    acc.cTris.push(ct);
    acc.kCalls.push(kc);
    acc.kTris.push(kt);
  }
  const calls = mean(acc.sCalls) + mean(acc.cCalls) + mean(acc.kCalls);
  const t = mean(acc.sTris) + mean(acc.cTris) + mean(acc.kTris);
  const [mc, mt] = MEASURED[sc.id] ?? [0, 0];
  console.log(
    `${sc.id.padEnd(16)} scenery ${mean(acc.sCalls).toFixed(0).padStart(3)} calls ${k(mean(acc.sTris)).padStart(5)} | cars ${mean(acc.cCalls).toFixed(0).padStart(3)} calls ${k(mean(acc.cTris)).padStart(5)} | crew ${mean(acc.kCalls).toFixed(0).padStart(2)} calls ${k(mean(acc.kTris)).padStart(5)} | total ${calls.toFixed(0).padStart(3)} calls ${k(t).padStart(5)}` +
      (level === 'low' ? ` | bench ${mc} calls ${mt}k (${Math.round(((t / 1000 - mt) / mt) * 100)}% triangles, ${Math.round(((calls - mc) / mc) * 100)}% calls)` : '') +
      ` | ${samples} pose${samples > 1 ? 's' : ''}`,
  );
  s.dispose();
}
