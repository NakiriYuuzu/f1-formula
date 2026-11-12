const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, isSessionOver, stepWorld } = await import(`${R}/race/index`);
const { DEFAULT_RULES, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { getLayout } = await import(`${R}/data/tracks/index`);

const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');
const LAPS = Number(process.env.LAPS ?? 12);

/**
 * A full 20-car race with the mandatory stop, each car stopping when its own strategy says. Per stop: the time from
 * the pit entry to the pit exit less the stationary time, against the fastest such visit of the race (a car with the
 * lane to itself): `extra` is what lane traffic cost.
 */
function race(layoutId: string, seed: number) {
  const track = getLayout(layoutId);
  const world = createWorld({
    mode: 'grandPrix', kind: 'race', layoutId, laps: LAPS, timeLimit: null, qualifyingLaps: 0, weather: 'clear', dynamicWeather: false,
    timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
    grid: RACERS.map((d: any) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: 'medium' })),
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off', mandatoryPitStop: true }, seed, ghost: null, objective: null,
  } as any, track);
  const entered = new Map<number, number>();
  const stood = new Map<number, number>();
  const visits: number[] = [];
  while (!isSessionOver(world) && world.time < 3600) {
    stepWorld(world, track, [], SIM_DT);
    for (const e of world.events) {
      if (e.type === 'pitEntry') entered.set(e.carId, world.time);
      if (e.type === 'pitStop') stood.set(e.carId, e.duration);
      if (e.type === 'pitExit' && entered.has(e.carId)) {
        visits.push(world.time - entered.get(e.carId)! - (stood.get(e.carId) ?? 0));
        entered.delete(e.carId);
      }
    }
    world.events.length = 0;
  }
  return visits;
}

const ids = process.argv.slice(2);
const seeds = (process.env.SEEDS ?? '42').split(',').map(Number);
for (const id of ids.length ? ids : ['monza', 'monaco', 'silverstone', 'suzuka']) {
  const all: number[] = [];
  for (const seed of seeds) all.push(...race(id, seed));
  const best = Math.min(...all);
  const extra = all.map((v) => v - best);
  const mean = extra.reduce((a, b) => a + b, 0) / Math.max(1, extra.length);
  console.log(`${id.padEnd(12)} stops ${all.length} lane time (no stationary) best ${best.toFixed(2)} s; traffic extra mean ${mean.toFixed(2)} max ${Math.max(...extra).toFixed(2)} s; >0.5 s: ${extra.filter((x) => x > 0.5).length}`);
}
