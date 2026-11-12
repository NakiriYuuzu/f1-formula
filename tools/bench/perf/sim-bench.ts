// Read-only probe: times the headless sim (physics + AI + race logic for 20 cars). Imports repo modules; writes nothing.
const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, stepWorld, buildRenderFrame } = await import(`${R}/race/index`);
const { DEFAULT_RULES, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { LAYOUTS, getLayout } = await import(`${R}/data/tracks/index`);
const { FlashbackBuffer } = await import(`${R}/app/flashback`);
const { ReplayRecorder } = await import(`${R}/app/replay`);

const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');
const cfg = (layoutId: string): any => ({
  mode: 'grandPrix', kind: 'race', layoutId, laps: 5, timeLimit: null, qualifyingLaps: 0,
  weather: 'clear', dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
  grid: RACERS.map((d: any) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: 'medium' })),
  teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off' }, seed: 42, ghost: null, objective: null,
});
const ids = (process.argv[2] ?? 'monza,monaco').split(',');
const simSeconds = Number(process.argv[3] ?? 40);
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const id of ids) {
  if (!LAYOUTS.some((l: any) => l.id === id)) { console.log('unknown layout', id); continue; }
  const track = getLayout(id);
  const world = createWorld(cfg(id), track);
  // warm up: 12 s of sim (lights + start) so JIT is hot and cars are in a pack
  const warm = Math.round(Number(process.argv[4] ?? 12) / SIM_DT);
  for (let i = 0; i < warm; i++) { stepWorld(world, track, [], SIM_DT); world.events.length = 0; }
  const n = Math.round(simSeconds / SIM_DT);
  const per: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    stepWorld(world, track, [], SIM_DT);
    per.push(performance.now() - a);
    world.events.length = 0;
  }
  const total = performance.now() - t0;
  // render-frame build (per rendered frame) and flashback/replay costs
  const fr = new FlashbackBuffer(); const rec = new ReplayRecorder();
  const fb: number[] = []; const rf: number[] = [];
  for (let i = 0; i < 200; i++) { const a = performance.now(); buildRenderFrame(world, track); rf.push(performance.now() - a); }
  for (let i = 0; i < 40; i++) { world.time += 0.5; const a = performance.now(); fr.record(world); fb.push(performance.now() - a); }
  const avgSpeed = world.cars.reduce((a: number, c: any) => a + c.phys.speed, 0) / world.cars.length;
  console.log('phase', world.session.phase, 't', world.time.toFixed(1), 'avgSpeed m/s', avgSpeed.toFixed(1));
  const heap = (process.memoryUsage().heapUsed / 1e6).toFixed(0);
  console.log(JSON.stringify({
    layout: id, cars: world.cars.length, simSeconds, wallMs: +total.toFixed(1),
    msPerSimSecond: +(total / simSeconds).toFixed(2),
    stepMs: { mean: +(total / n).toFixed(4), p50: +pct(per, 0.5).toFixed(4), p95: +pct(per, 0.95).toFixed(4), p99: +pct(per, 0.99).toFixed(4), max: +Math.max(...per).toFixed(3) },
    cpuShareAt120HzRealtime: +(total / simSeconds / 1000).toFixed(4),
    buildRenderFrameMs: { p50: +pct(rf, 0.5).toFixed(4), p95: +pct(rf, 0.95).toFixed(4) },
    flashbackSnapshotMs: { p50: +pct(fb, 0.5).toFixed(3), p95: +pct(fb, 0.95).toFixed(3), max: +Math.max(...fb).toFixed(3) },
    heapMB: heap,
  }));
}
