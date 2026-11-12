const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, isSessionOver, requestPit, stepWorld } = await import(`${R}/race/index`);
const { DEFAULT_RULES, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { getLayout } = await import(`${R}/data/tracks/index`);
const { forwardDistance, pitRampLength } = await import(`${R}/track/track`);

const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');
function cfg(layoutId: string, laps: number): any {
  return {
    mode: 'grandPrix', kind: 'race', layoutId, laps, timeLimit: null, qualifyingLaps: 0, weather: 'clear', dynamicWeather: false,
    timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
    grid: RACERS.map((d: any) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: 'medium' })),
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off' }, seed: 42, ghost: null, objective: null,
  };
}

/**
 * The first `count` cars of the grid (ids 0..count-1) are called in on lap 2. Counted every step:
 * - `lane`: steps with two cars both in a pit phase closer than 2.2 m (centre to centre), the pairs, their closest
 *   distance; `track`: the same between a pit car and a car on the track;
 * - `done`: called cars that completed a stop / called cars; `span`: seconds from the first entry to the last exit;
 * - `waits`: the longest extra time between the speed-limit line and the box over the time at the limit.
 */
function run(layoutId: string, count: number, reqLap = 2, laps = 4) {
  const track = getLayout(layoutId);
  const world = createWorld(cfg(layoutId, laps), track);
  const n = world.cars.length;
  const called = new Set<number>();
  const tEntryLane = new Map<number, number>(), waits: number[] = [];
  let laneSteps = 0, trackSteps = 0; const lanePairs = new Set<string>(), trackPairs = new Set<string>();
  let laneMin = 99, trackMin = 99, firstIn = Infinity, lastOut = 0;
  const ramp = pitRampLength(track);
  const prevPh = world.cars.map(() => 'none');
  while (!isSessionOver(world) && world.time < 1200) {
    for (const c of world.cars) {
      if (c.id < count && c.status === 'running' && c.timing.lap === reqLap && !called.has(c.id) && c.pit.phase === 'none' && !c.pit.requested) {
        requestPit(world, c.id, 'hard'); called.add(c.id);
      }
    }
    stepWorld(world, track, [], SIM_DT);
    world.events.length = 0;
    for (let i = 0; i < n; i++) {
      const a = world.cars[i];
      if (a.pit.phase !== prevPh[i]) {
        if (prevPh[i] === 'none') firstIn = Math.min(firstIn, world.time);
        if (a.pit.phase === 'none') lastOut = Math.max(lastOut, world.time);
        if (prevPh[i] === 'entry' && a.pit.phase === 'lane') tEntryLane.set(i, world.time);
        if (prevPh[i] === 'lane' && a.pit.phase === 'stopped' && tEntryLane.has(i)) {
          const boxD = forwardDistance(track, track.pit.entry, a.pit.boxS);
          waits.push(+(world.time - tEntryLane.get(i)! - (boxD - ramp) / track.pit.speedLimit).toFixed(1));
        }
        prevPh[i] = a.pit.phase;
      }
      if (a.status === 'retired') continue;
      for (let j = i + 1; j < n; j++) {
        const b = world.cars[j];
        if (b.status === 'retired') continue;
        const inA = a.pit.phase !== 'none', inB = b.pit.phase !== 'none';
        if (!inA && !inB) continue;
        const d = Math.hypot(a.phys.x - b.phys.x, a.phys.z - b.phys.z);
        const pair = `${a.driverId}/${b.driverId}:${a.pit.phase}+${b.pit.phase}`;
        if (inA && inB) {
          laneMin = Math.min(laneMin, d);
          if (d < 2.2) { laneSteps++; lanePairs.add(pair); }
        } else {
          trackMin = Math.min(trackMin, d);
          if (d < 2.2) { trackSteps++; trackPairs.add(pair); }
        }
      }
    }
  }
  const done = [...called].filter((id) => world.cars[id].pit.stops > 0).length;
  return {
    lane: { steps: laneSteps, pairs: lanePairs.size, min: +laneMin.toFixed(2), first: [...lanePairs].slice(0, 3) },
    track: { steps: trackSteps, pairs: trackPairs.size, min: +trackMin.toFixed(2), first: [...trackPairs].slice(0, 3) },
    done: `${done}/${called.size}`,
    span: +(lastOut - firstIn).toFixed(1),
    waits: waits.sort((x, y) => y - x).slice(0, 5),
  };
}
const args = process.argv.slice(2);
const counts = (args.find((a) => /^[\d,]+$/.test(a)) ?? '5,10,20').split(',').map(Number);
const ids = args.filter((a) => !/^[\d,]+$/.test(a));
for (const id of ids.length ? ids : ['monza', 'monaco', 'silverstone', 'suzuka']) {
  for (const count of counts) console.log(`${id.padEnd(12)} n=${String(count).padStart(2)}`, JSON.stringify(run(id, count)));
}
