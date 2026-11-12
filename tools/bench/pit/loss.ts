const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, isSessionOver, requestPit, stepWorld } = await import(`${R}/race/index`);
const { estimatePitLoss } = await import(`${R}/race/pitlane`);
const { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { getLayout } = await import(`${R}/data/tracks/index`);

const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');
const DRIVER = 'varga';
const team = (id: string) => RACERS.find((d: any) => d.id === id)?.teamId ?? '';
/** Mean of the seeded stationary time (randRange 2.0–3.5 s). */
const STOP_MEAN = 2.75;

function config(layoutId: string, seed: number): any {
  return {
    mode: 'grandPrix', kind: 'race', layoutId, laps: 5, timeLimit: null, qualifyingLaps: 0,
    weather: 'clear', dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
    grid: [{ driverId: DRIVER, teamId: team(DRIVER), playerIndex: -1, startCompound: 'medium' }],
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off', mandatoryPitStop: false },
    seed, ghost: null, objective: null,
  };
}

/** One AI car alone on track, called in on lap 3 or not: (time, progress) every step, and its pit marks. */
function run(layoutId: string, seed: number, stop: boolean) {
  const track = getLayout(layoutId);
  const world = createWorld(config(layoutId, seed), track);
  const c = world.cars[0];
  const t: number[] = [], p: number[] = [];
  let pIn = NaN, pOut = NaN, stopDur = NaN, vIn = NaN, last = 'none', requested = false;
  while (!isSessionOver(world) && world.time < 900) {
    if (stop && !requested && c.timing.lap === 3) { requestPit(world, 0, 'medium'); requested = true; }
    stepWorld(world, track, [], SIM_DT);
    for (const e of world.events) if (e.type === 'pitStop') stopDur = e.duration;
    world.events.length = 0;
    t.push(world.time); p.push(c.timing.progress);
    if (c.pit.phase !== last) {
      if (last === 'none') { pIn = c.timing.progress; vIn = c.phys.speed; }
      if (c.pit.phase === 'none') pOut = c.timing.progress;
      last = c.pit.phase;
    }
  }
  return { t, p, pIn, pOut, stopDur, vIn, est: estimatePitLoss(track) };
}

function timeAt(r: { t: number[]; p: number[] }, P: number): number {
  let lo = 0, hi = r.p.length - 1;
  if (!(r.p[hi] >= P)) return NaN;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r.p[m] >= P) hi = m; else lo = m; }
  const f = (P - r.p[lo]) / Math.max(1e-9, r.p[hi] - r.p[lo]);
  return r.t[lo] + (r.t[hi] - r.t[lo]) * Math.min(1, Math.max(0, f));
}

/**
 * Time lost by one stop: when the car reaches a point 1000 m past the pit exit, against the same car not stopping
 * (same seed: identical up to the request), with the stationary time put at its mean. Split at the entry and the exit.
 */
const seeds = (process.env.SEEDS ?? '11,12,13').split(',').map(Number);
const ids = process.argv.slice(2);
for (const id of ids.length ? ids : ['monza', 'monaco', 'silverstone', 'suzuka']) {
  const rows: number[] = [];
  let est = NaN;
  const parts: string[] = [];
  for (const seed of seeds) {
    const ctrl = run(id, seed, false), pit = run(id, seed, true);
    est = pit.est;
    const at = (P: number) => timeAt(pit, P) - timeAt(ctrl, P);
    const toEntry = at(pit.pIn), toExit = at(pit.pOut), after = at(pit.pOut + 1000);
    const norm = after - (pit.stopDur - STOP_MEAN);
    rows.push(norm);
    parts.push(`s${seed}: entry ${toEntry.toFixed(2)} zone ${(toExit - toEntry).toFixed(2)} after ${(after - toExit).toFixed(2)} stop ${pit.stopDur.toFixed(2)} vIn ${pit.vIn.toFixed(1)} -> loss ${norm.toFixed(2)}`);
  }
  const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
  const spread = Math.max(...rows) - Math.min(...rows);
  console.log(`${id.padEnd(12)} measured ${mean.toFixed(2)} s (spread ${spread.toFixed(2)}, ${rows.length} seeds) est ${est.toFixed(2)} diff ${(est - mean).toFixed(2)}`);
  for (const s of parts) console.log('    ' + s);
}
