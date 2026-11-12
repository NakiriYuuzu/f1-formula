/**
 * Pit lane queues in whole races: how many cars stop on the same lap, and what the lane costs each stop over a car alone
 * in it (the lane time less the stop, against the race's quickest), against what the AI strategy prices a stop at (the
 * pit loss × the SC / VSC share, + QUEUE_LOSS behind a team-mate in the box). The time a car stands still in the lane
 * is split by why: at its queue spot behind its team-mate ('stack'), served and waiting in its box for the fast lane
 * ('release'), or held by a car ahead ('blocked').
 *   bun run tools/bench/pit/queue.ts [layout=silverstone] [laps=30 | 40m for an endurance race] [seed=5] [cars=20]
 * SC=off|reduced|standard|increased (default increased).
 */
const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, isSessionOver, stepWorld, estimatePitLoss, pitLossFactor } = await import(`${R}/race/index`);
const { DEFAULT_RULES, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { getLayout } = await import(`${R}/data/tracks/index`);
const { forwardDistance } = await import(`${R}/track/track`);

const [layoutId = 'silverstone', length = '30', seedArg = '5', carsArg = '20'] = process.argv.slice(2);
const RACERS = DRIVERS.filter((d: any) => d.teamId !== '').slice(0, Number(carsArg));
const track = getLayout(layoutId);
const minutes = /m$/.test(length) ? Number(length.slice(0, -1)) : 0;
const world = createWorld(
  {
    mode: 'grandPrix', kind: 'race', layoutId, laps: minutes ? 5 : Number(length), timeLimit: null, qualifyingLaps: 0, weather: 'clear', dynamicWeather: false,
    timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
    grid: RACERS.map((d: any, i: number) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: i % 3 === 0 ? 'soft' : 'medium' })),
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: process.env.SC ?? 'increased', mandatoryPitStop: true },
    seed: Number(seedArg), ghost: null, objective: null,
    ...(minutes ? { raceFormat: { kind: 'endurance', duration: minutes * 60 } } : {}),
  } as any,
  track,
);

interface Visit { carId: number; lap: number; mode: string; inLane: number; stacked: boolean; entry: number; stood: number; stack: number; release: number; blocked: number; lane: number }
const open = new Map<number, Visit>();
const visits: Visit[] = [];
const D = (s: number): number => forwardDistance(track, track.pit.entry, s);
const f1 = (x: number): string => x.toFixed(1);
while (!isSessionOver(world) && world.time < 4 * 3600) {
  stepWorld(world, track, [], SIM_DT);
  const s = world.session;
  for (const e of world.events) {
    const car = world.cars[(e as any).carId];
    if (e.type === 'pitEntry') {
      const mate = world.cars.find((o: any) => o !== car && o.teamId === car.teamId);
      open.set(car.id, {
        carId: car.id, lap: car.timing.lap, mode: s.control.mode, entry: world.time, stood: 0, stack: 0, release: 0, blocked: 0, lane: 0,
        inLane: world.cars.filter((o: any) => o !== car && o.pit.phase !== 'none').length,
        stacked: !!mate && mate.pit.phase !== 'none',
      });
    }
    if (e.type === 'pitStop' && open.has(car.id)) open.get(car.id)!.stood = e.duration;
    if (e.type === 'pitExit' && open.has(car.id)) {
      const v = open.get(car.id)!;
      v.lane = world.time - v.entry - v.stood;
      visits.push(v);
      open.delete(car.id);
    }
  }
  world.events.length = 0;
  for (const [id, v] of open) {
    const car = world.cars[id];
    if (car.pit.phase === 'stopped' || car.pit.phase === 'none' || car.phys.speed >= 0.5) continue;
    const r = car.race;
    if (r.pitStopTotal <= 0 && r.pitStopS !== car.pit.boxS && Math.abs(D(car.phys.s) - D(r.pitStopS)) < 0.5) v.stack += SIM_DT;
    else if (r.pitStopTotal > 0 && Math.abs(D(car.phys.s) - D(car.pit.boxS)) < 0.5) v.release += SIM_DT;
    else v.blocked += SIM_DT;
  }
}
const best = Math.min(...visits.map((v) => v.lane));
const loss = estimatePitLoss(track);
const QUEUE_LOSS = 4;
console.log(`${layoutId} ${minutes ? `${minutes} min` : `${length} laps`} seed ${seedArg} cars ${RACERS.length} SC ${process.env.SC ?? 'increased'}: ${visits.length} stops, lane alone ${f1(best)} s, pit loss priced ${f1(loss)} s (× ${pitLossFactor('sc')} under SC, × ${pitLossFactor('vsc')} VSC)`);
const byLap = new Map<number, Visit[]>();
for (const v of visits) byLap.set(v.lap, [...(byLap.get(v.lap) ?? []), v]);
for (const [lap, vs] of [...byLap].sort((a, b) => a[0] - b[0])) {
  if (vs.length < 3) continue;
  const sum = (k: 'stack' | 'release' | 'blocked'): string => f1(vs.reduce((a, v) => a + v[k], 0));
  const extra = (stacked: boolean): string => {
    const xs = vs.filter((v) => v.stacked === stacked).map((v) => v.lane - best);
    return xs.length ? `mean ${f1(xs.reduce((a, b) => a + b, 0) / xs.length)} max ${f1(Math.max(...xs))}` : '-';
  };
  console.log(
    `lap ${lap}: ${vs.length} cars (${[...new Set(vs.map((v) => v.mode))].join('/')}), ${vs.filter((v) => v.stacked).length} behind a team-mate; extra alone in the box ${extra(false)}, behind a team-mate ${extra(true)} (priced ${QUEUE_LOSS}); standing: stack ${sum('stack')} release ${sum('release')} blocked ${sum('blocked')} s`,
  );
}
const all = (stacked: boolean): string => {
  const xs = visits.filter((v) => v.stacked === stacked).map((v) => v.lane - best);
  return xs.length ? `mean ${f1(xs.reduce((a, b) => a + b, 0) / xs.length)} max ${f1(Math.max(...xs))} (${xs.length})` : '-';
};
console.log(`all stops: extra alone in the box ${all(false)}, behind a team-mate ${all(true)}; standing total: stack ${f1(visits.reduce((a, v) => a + v.stack, 0))} release ${f1(visits.reduce((a, v) => a + v.release, 0))} blocked ${f1(visits.reduce((a, v) => a + v.blocked, 0))} s`);
