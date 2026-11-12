/**
 * A headless endurance race to its end: when the time ran out and when the leader took the flag, stops per car, how
 * long each stood and how much fuel went in, the least fuel any car had left (and any car that ran dry), cars stopping
 * on the same lap and what the lane cost them, the classification by laps then time, and a hash of the race (equal for a
 * seed run twice).
 *   bun run tools/bench/modes/endurance.ts [layout=monza] [minutes=40] [seed=42] [cars=20]
 * SC=off|reduced|standard|increased (default standard), REG=2025|2026.
 */
const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, isSessionOver, stepWorld, buildSessionResult, enduranceFormat, enduranceLeft } = await import(`${R}/race/index`);
const { DEFAULT_RULES, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { getLayout } = await import(`${R}/data/tracks/index`);

const [layoutId = 'monza', minutes = '40', seedArg = '42', carsArg = '20'] = process.argv.slice(2);
const RACERS = DRIVERS.filter((d: any) => d.teamId !== '').slice(0, Number(carsArg));
const track = getLayout(layoutId);
const world = createWorld(
  {
    mode: 'grandPrix', kind: 'race', layoutId, laps: 5, timeLimit: null, qualifyingLaps: 0, weather: 'clear', dynamicWeather: false,
    timeOfDay: 'day', regulation: process.env.REG ?? '2025', aiDifficulty: 90, players: [],
    grid: RACERS.map((d: any, i: number) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: i % 3 === 0 ? 'soft' : 'medium' })),
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: process.env.SC ?? 'standard', mandatoryPitStop: true },
    seed: Number(seedArg), ghost: null, objective: null, raceFormat: enduranceFormat(Number(minutes)),
  } as any,
  track,
);

function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
const f1 = (x: number): string => x.toFixed(1);
const stats = (a: number[]): string => (a.length ? `n ${a.length} min ${f1(Math.min(...a))} mean ${f1(a.reduce((x, y) => x + y, 0) / a.length)} max ${f1(Math.max(...a))}` : 'n 0');

let hash = 0x811c9dc5;
let timeUp: number | null = null;
let leaderLapAtTimeUp = 0;
let minFuel = Infinity;
const dry = new Set<number>();
const stops: { carId: number; lap: number; t: number; duration: number; fuel: number; mode: string; why: string }[] = [];
const entered = new Map<number, { t: number; lap: number }>();
const lane: { carId: number; lap: number; lane: number; mode: string }[] = [];
const modes = new Map<string, number>();
let finalLapAt: number | null = null;
while (!isSessionOver(world) && world.time < 6 * 3600) {
  stepWorld(world, track, [], SIM_DT);
  const s = world.session;
  if (s.phase === 'running') modes.set(s.control.mode, (modes.get(s.control.mode) ?? 0) + SIM_DT);
  for (const e of world.events) {
    hash = fnv(JSON.stringify(e), hash);
    if (e.type === 'finalLap') finalLapAt = world.time;
    if (e.type === 'pitEntry') entered.set(e.carId, { t: world.time, lap: world.cars[e.carId].timing.lap });
    if (e.type === 'pitStop' && process.env.DEBUG) {
      const c = world.cars[e.carId];
      console.log(`stop ${c.abbr} lap ${c.timing.lap} t ${f1(world.time)} why ${c.ai.pitCall} fuel+${f1(e.fuel ?? 0)} now ${f1(c.phys.fuelKg)} burn ${c.ai.fuelPerLap.toFixed(2)} target ${f1(c.ai.fuelTarget)} totalLaps ${s.totalLaps} leaderLap ${s.leaderLap} left ${f1(enduranceLeft(world) ?? 0)} down ${c.timing.lapsDown} plan ${c.ai.planStops}/${c.ai.planStay}`);
    }
    if (e.type === 'pitStop') stops.push({ carId: e.carId, lap: world.cars[e.carId].timing.lap, t: world.time, duration: e.duration, fuel: e.fuel ?? 0, mode: s.control.mode, why: world.cars[e.carId].ai.pitCall });
    if (e.type === 'pitExit' && entered.has(e.carId)) {
      const visit = entered.get(e.carId)!;
      const stood = [...stops].reverse().find((x) => x.carId === e.carId)?.duration ?? 0;
      lane.push({ carId: e.carId, lap: visit.lap, lane: world.time - visit.t - stood, mode: s.control.mode });
      entered.delete(e.carId);
    }
  }
  world.events.length = 0;
  for (const c of world.cars) {
    if (c.status === 'retired' || c.status === 'finished') continue;
    minFuel = Math.min(minFuel, c.phys.fuelKg);
    if (c.phys.fuelKg <= 0) dry.add(c.id);
  }
  const left = enduranceLeft(world);
  if (timeUp === null && s.phase === 'running' && left !== null && left <= 0) {
    timeUp = world.time;
    leaderLapAtTimeUp = s.leaderLap;
  }
}
const s = world.session;
const result = buildSessionResult(world);
const leader = world.cars[result.rows[0].carId];
console.log(`${layoutId} ${minutes} min seed ${seedArg} cars ${RACERS.length}: lights out ${f1(s.startTime ?? 0)} time up ${timeUp === null ? '-' : f1(timeUp)} (leader on lap ${leaderLapAtTimeUp}) final-lap call ${finalLapAt === null ? '-' : f1(finalLapAt)} flag ${f1(s.chequeredAt ?? NaN)} winner ${leader.abbr} laps ${leader.timing.lapsCompleted} race laps ${s.totalLaps}`);
console.log(`modes (s): ${[...modes].map(([m, t]) => `${m} ${f1(t)}`).join(', ')}`);
const per = world.cars.map((c: any) => stops.filter((x) => x.carId === c.id).length);
const hist = new Map<number, number>();
for (const n of per) hist.set(n, (hist.get(n) ?? 0) + 1);
console.log(`stops per car: ${[...hist].sort((a, b) => a[0] - b[0]).map(([n, k]) => `${n}x${k}`).join(' ')}`);
const why = new Map<string, number>();
for (const x of stops) why.set(`${x.why}@${x.mode}`, (why.get(`${x.why}@${x.mode}`) ?? 0) + 1);
console.log(`stop calls: ${[...why].map(([k, n]) => `${k} ${n}`).join(', ')}; stop laps: ${stops.map((x) => x.lap).sort((a, b) => a - b).join(',')}`);
const fuelled = stops.filter((x) => x.fuel > 0);
console.log(`stop length (s), fuel stops: ${stats(fuelled.map((x) => x.duration))}; fill (kg): ${stats(fuelled.map((x) => x.fuel))}; tyre-only stops ${stops.length - fuelled.length}`);
console.log(`least fuel in a car still racing: ${minFuel.toFixed(2)} kg; cars that ran dry: ${dry.size ? [...dry].map((id) => world.cars[id].abbr).join(' ') : 'none'}`);
const byLap = new Map<number, typeof lane>();
for (const v of lane) byLap.set(v.lap, [...(byLap.get(v.lap) ?? []), v]);
const best = Math.min(...lane.map((v) => v.lane));
const together = [...byLap].filter(([, v]) => v.length >= 3).map(([lap, v]) => `lap ${lap}: ${v.length} cars (${v[0].mode}) extra mean ${f1(v.reduce((a, x) => a + x.lane - best, 0) / v.length)} max ${f1(Math.max(...v.map((x) => x.lane - best)))}`);
console.log(`lane time without the stop: best ${f1(best)} s; laps with 3+ cars in: ${together.length ? together.join('; ') : 'none'}`);
// classification: laps then time, as the rows say
let ordered = true;
for (let i = 1; i < result.rows.length; i++) {
  const a = result.rows[i - 1];
  const b = result.rows[i];
  if (a.status === 'retired' || b.status === 'retired' || a.time === null || b.time === null) continue;
  if (b.lapsCompleted > a.lapsCompleted || (b.lapsCompleted === a.lapsCompleted && b.time < a.time - 1e-9)) ordered = false;
}
console.log(`classified by laps then time: ${ordered}; rows ${result.rows.slice(0, 8).map((r: any) => `${r.position}.${world.cars[r.carId].abbr} ${r.lapsCompleted}L ${r.gapText} ${r.pitStops}st`).join(' | ')}`);
console.log(`hash ${(hash >>> 0).toString(16)} sim ${f1(world.time)} s`);
