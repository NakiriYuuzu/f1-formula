/**
 * Racecraft probe. Usage:
 *   bun run tools/bench/ai/probe.ts <repoRoot> <layout> <laps> <seed> <mode: normal|reverse|reverseFull> <difficulty> <out.json>
 * Imports the repo by absolute path (dynamic), writes only to <out.json>.
 */
const [root, layoutId, lapsS, seedS, mode, diffS, outPath] = process.argv.slice(2);
const laps = Number(lapsS);
const seed = Number(seedS);
const difficulty = Number(diffS);
const R = (p: string) => import(`${root}/src/${p}`);
const race = await R('race/index');
const defaults = await R('core/defaults');
const teamsMod = await R('data/teams');
const tracks = await R('data/tracks/index');
const traffic = await R('ai/traffic');
const { createWorld, isSessionOver, stepWorld } = race;
const { DEFAULT_RULES, SIM_DT } = defaults;
const { DRIVERS, TEAMS } = teamsMod;
const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
function cfgFor(order: string[], compoundMode: 'mixed' | 'medium'): any {
  return {
    mode: 'grandPrix', kind: 'race', layoutId, laps, timeLimit: null, qualifyingLaps: 0, weather: 'clear',
    dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: difficulty, players: [],
    grid: order.map((id) => ({
      driverId: id, teamId: RACERS.find((d: any) => d.id === id)?.teamId ?? '', playerIndex: -1,
      startCompound: compoundMode === 'medium' ? 'medium' : hash(`${id}tyre${seed}`) < 0.55 ? 'medium' : 'soft',
    })),
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off', aeroWake: process.env.WAKE !== '0' }, seed, ghost: null, objective: null,
  };
}
const strength = (id: string): number => {
  const d = RACERS.find((x: any) => x.id === id); const t = TEAMS.find((x: any) => x.id === d?.teamId);
  return (t.rating.aero + t.rating.power + t.rating.chassis) / 3 + d.skill.pace * 0.35 + (hash(`${id}${seed}`) - 0.5) * 0.04;
};
const track = tracks.getLayout(layoutId);
const baseOrder: string[] = RACERS.map((d: any) => d.id).sort((a: string, b: string) => strength(b) - strength(a));
let order = baseOrder;
let compoundMode: 'mixed' | 'medium' = 'mixed';
let backFive: string[] = [];
let backScore = -1;
if (mode !== 'normal') {
  compoundMode = 'medium';
  // paceTime (race form included) depends on the grid slot through the car's seed: hill-climb by swapping a misplaced
  // fast car with a slow one in the back five until the world's own 5 fastest sit in slots 16-20
  const K = mode === 'reverseFull' ? 0 : 5;
  const fastOf = (o: string[]): string[] => {
    const w = createWorld(cfgFor(o, compoundMode), track);
    return [...w.cars].sort((a: any, b: any) => a.ai.paceTime - b.ai.paceTime).map((c: any) => c.driverId);
  };
  if (K > 0) {
    let rs = (seed * 2654435761) >>> 0;
    const rnd = (): number => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
    const score = (o: string[]): number => { const f5 = new Set(fastOf(o).slice(0, 5)); return o.slice(15).filter((id) => f5.has(id)).length; };
    let byPace = fastOf(order);
    order = [...byPace.slice(5), ...byPace.slice(0, 5).reverse()];
    let bestScore = score(order);
    for (let it = 0; it < 600 && bestScore < 5; it++) {
      const cand = [...order];
      const m = rnd();
      if (m < 0.3) { const i = 15 + Math.floor(rnd() * 5), j = 15 + Math.floor(rnd() * 5); [cand[i], cand[j]] = [cand[j], cand[i]]; }
      else if (m < 0.6) { const i = Math.floor(rnd() * 14); [cand[i], cand[i + 1]] = [cand[i + 1], cand[i]]; }
      else {
        const f5 = new Set(fastOf(cand).slice(0, 5));
        const mis = cand.slice(0, 15).filter((id) => f5.has(id));
        const wrong = cand.slice(15).filter((id) => !f5.has(id));
        if (mis.length && wrong.length) { const i = cand.indexOf(mis[Math.floor(rnd() * mis.length)]), j = cand.indexOf(wrong[Math.floor(rnd() * wrong.length)]); [cand[i], cand[j]] = [cand[j], cand[i]]; }
      }
      const s = score(cand);
      if (s >= bestScore) { bestScore = s; order = cand; }
    }
    backScore = bestScore;
  } else {
    order = fastOf(order).reverse();
  }
}
const world = createWorld(cfgFor(order, compoundMode), track);
const wetness = world.weather.wetness;
const n = world.cars.length;
const paceStatic = world.cars.map((c: any) => c.ai.paceTime);
const rankByPace = [...world.cars.keys()].sort((a, b) => paceStatic[a] - paceStatic[b]);
if (mode !== 'normal') backFive = rankByPace.slice(0, 5).map((i) => world.cars[i].driverId);

interface Stint { a: number; b: number; start: number; t1: number; tot: number; drs: number; atk: Record<string, number>; conserve: number; train: number; deltaStatic: number; deltaNow: number; reason: string; lapA: number; pitSoon: boolean }
const stints: Stint[] = [];
const active: (Stint | null)[] = new Array(n).fill(null);
const grace = new Array(n).fill(0);
const events: any[] = [];
const lastPitExit = new Array(n).fill(-1e9);
const prevPhase = world.cars.map((c: any) => c.pit.phase);
const lapRecs: any[] = [];
const lapAcc = world.cars.map(() => ({ lap: 0, t: 0, near: 0, sumAhead: 0, pit: false, flag: false }));
const snaps: { leaderLaps: number; time: number; order: number[] }[] = [];
let prevLeaderLaps = 0;
let collisions = 0, heavy = 0;
const close = (i: number, reason: string, endPit = false): void => {
  const s = active[i]; if (!s) return;
  s.reason = reason; s.pitSoon = endPit; stints.push(s); active[i] = null; grace[i] = 0;
};
const t0 = Date.now();
while (!isSessionOver(world) && world.time < 2400) {
  stepWorld(world, track, [], SIM_DT);
  const live = world.session.phase === 'running';
  const green = world.session.control.mode === 'green';
  const cars = world.cars;
  const leaderLaps = Math.max(...cars.map((c: any) => c.timing.lapsCompleted));
  for (const e of world.events) {
    if (e.type === 'collision' && e.otherCarId !== null) { collisions++; if (e.impulse > 5000) heavy++; }
    if (e.type === 'overtake') {
      const a = cars[e.carId], b = cars[e.passedCarId];
      const pitRel = (c: any): boolean => c.pit.stops > 0 && world.time - lastPitExit[c.id] < 100 || c.pit.requested || c.pit.phase !== 'none';
      events.push({ t: world.time, lead: leaderLaps, lapA: a.timing.lapsCompleted, lapB: b.timing.lapsCompleted, passer: a.id, passed: b.id, pos: e.position, pit: pitRel(a) || pitRel(b), lap1: a.timing.lapsCompleted < 1 || b.timing.lapsCompleted < 1,
        paceA: paceStatic[a.id], paceB: paceStatic[b.id], aiTrick: a.ai.trickTarget === b.id && a.ai.trickTimer > 0 ? a.ai.trickKind : null, mode: a.ai.mode, phase: a.ai.attackPhase });
      close(a.id, 'passed');
    }
  }
  world.events.length = 0;
  if (leaderLaps !== prevLeaderLaps) { snaps.push({ leaderLaps, time: world.time, order: [...world.race.order] }); prevLeaderLaps = leaderLaps; }
  for (const c of cars) {
    const ph = c.pit.phase;
    if (prevPhase[c.id] !== 'none' && ph === 'none') lastPitExit[c.id] = world.time;
    prevPhase[c.id] = ph;
    // lap record
    const acc = lapAcc[c.id];
    if (c.timing.lapsCompleted !== acc.lap) {
      if (acc.t > 30 && c.timing.lastLap && !acc.pit && !acc.flag && acc.lap >= 1) {
        lapRecs.push({ car: c.id, lap: acc.lap + 1, time: c.timing.lastLap, pace: paceStatic[c.id], near: acc.near / acc.t, meanAhead: acc.sumAhead / acc.t });
      }
      acc.lap = c.timing.lapsCompleted; acc.t = 0; acc.near = 0; acc.sumAhead = 0; acc.pit = false; acc.flag = false;
    }
    if (live && c.status === 'running') {
      acc.t += SIM_DT;
      const iv = c.timing.position > 1 && c.timing.interval > 0 ? c.timing.interval : 99;
      acc.sumAhead += Math.min(iv, 12) * SIM_DT; if (iv < 1) acc.near += SIM_DT;
      if (c.pit.phase !== 'none' || c.pit.requested) acc.pit = true;
      if (!green) acc.flag = true;
    }
  }
  // follow stints
  if (live && green) {
    for (const c of cars) {
      const i = c.id;
      const ok = c.status === 'running' && c.pit.phase === 'none' && c.timing.position > 1 && c.timing.lapsCompleted >= 1;
      if (!ok) { close(i, 'pit/other', c.pit.phase !== 'none' || c.pit.requested); continue; }
      const bId = world.race.order[c.timing.position - 2];
      const b = cars[bId];
      const iv = c.timing.interval;
      const s = active[i];
      if (s && s.b !== bId) { close(i, 'reorder'); }
      if (!b || b.pit.phase !== 'none' || b.status !== 'running' || b.timing.lapsCompleted < 1) { close(i, 'pit/other', b ? b.pit.phase !== 'none' : false); continue; }
      let st = active[i];
      if (st) {
        if (iv >= 1.5 || iv <= 0) { grace[i] += SIM_DT; if (grace[i] > 2) close(i, 'dropped'); continue; }
        grace[i] = 0;
        st.tot += SIM_DT;
        if (iv < 1.0) {
          st.t1 += SIM_DT; if (c.phys.drs.open) st.drs += SIM_DT;
          st.atk[c.ai.mode === 'attack' ? c.ai.attackPhase : c.ai.mode] = (st.atk[c.ai.mode === 'attack' ? c.ai.attackPhase : c.ai.mode] ?? 0) + SIM_DT;
          if (c.ai.paceMode === 'conserve') st.conserve += SIM_DT;
          if (c.ai.inTrain) st.train += SIM_DT;
        }
      } else if (iv > 0 && iv < 1.0) {
        const eA = traffic.estimatedPace(c, wetness), eB = traffic.estimatedPace(b, wetness);
        active[i] = { a: i, b: bId, start: world.time, t1: 0, tot: 0, drs: 0, atk: {}, conserve: 0, train: 0, deltaStatic: (paceStatic[bId] - paceStatic[i]) / paceStatic[bId], deltaNow: eB > 0 && eA > 0 ? (eB - eA) / eB : 0, reason: '', lapA: c.timing.lapsCompleted, pitSoon: false };
      }
    }
  }
}
for (let i = 0; i < n; i++) close(i, 'end');
const final = [...world.race.order];
const out = {
  root, layoutId, laps, seed, mode, difficulty, over: isSessionOver(world), simTime: world.time, wall: (Date.now() - t0) / 1000,
  ref: track.referenceLapTime, length: track.length,
  drivers: world.cars.map((c: any) => c.driverId), team: world.cars.map((c: any) => c.teamId), gridPos: world.cars.map((c: any) => c.timing.gridPosition),
  paceStatic, backFive, backScore, final, snaps, events, stints, lapRecs, collisions, heavy,
  retired: world.cars.filter((c: any) => c.status === 'retired').map((c: any) => c.driverId),
  stops: world.cars.map((c: any) => c.pit.stops),
  tricks: world.cars.map((c: any) => ({ f: c.ai.feints, fp: c.ai.feintPasses, s: c.ai.switchbacks, sp: c.ai.switchbackPasses })),
  bestLap: world.cars.map((c: any) => c.timing.bestLap),
};
await Bun.write(outPath, JSON.stringify(out));
console.log(`${layoutId} s${seed} ${mode} d${difficulty} laps${laps} over=${out.over} sim=${out.simTime.toFixed(0)}s wall=${out.wall.toFixed(1)}s overtakes=${events.length} collisions=${collisions} heavy=${heavy} stints=${stints.length} backScore=${backScore}`);
