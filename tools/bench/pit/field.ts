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
function run(layoutId: string, reqLap: number, laps: number, everyone: boolean) {
  const track = getLayout(layoutId);
  const world = createWorld(cfg(layoutId, laps), track);
  const n = world.cars.length;
  const reqd = new Set<number>();
  const tEntryLane = new Map<number, number>(), waits: number[] = [];
  let overlapSteps = 0; const overlapPairs = new Set<string>(); let minDist = 99;
  const onTrackNearPit: string[] = [];
  let worstClosing = 0, worstClosingInfo = '';
  let relCloseSteps = 0, relMin = 99, relInfo = '';
  const ramp = pitRampLength(track);
  const prevPh = world.cars.map(() => 'none');
  const pitCarLossOrder: number[] = [];
  let contactsNearEntry = 0;
  while (!isSessionOver(world) && world.time < 1200) {
    for (const c of world.cars) {
      if (c.status === 'running' && c.timing.lap === reqLap && !reqd.has(c.id) && c.pit.phase === 'none' && !c.pit.requested && (everyone || c.id % 2 === 0 || true)) {
        requestPit(world, c.id, 'hard'); reqd.add(c.id);
      }
    }
    stepWorld(world, track, [], SIM_DT);
    for (const e of world.events) if (e.type === 'contact' || e.type === 'collision') contactsNearEntry++;
    world.events.length = 0;
    for (let i = 0; i < n; i++) {
      const a = world.cars[i];
      if (a.pit.phase !== prevPh[i]) {
        if (prevPh[i] === 'entry' && a.pit.phase === 'lane') tEntryLane.set(i, world.time);
        if (prevPh[i] === 'lane' && a.pit.phase === 'stopped' && tEntryLane.has(i)) {
          const boxD = forwardDistance(track, track.pit.entry, a.pit.boxS);
          const ideal = (boxD - ramp) / track.pit.speedLimit;
          waits.push(+(world.time - tEntryLane.get(i)! - ideal).toFixed(1));
        }
        prevPh[i] = a.pit.phase;
      }
      if (a.status === 'retired') continue;
      for (let j = i + 1; j < n; j++) {
        const b = world.cars[j];
        if (b.status === 'retired') continue;
        if (a.pit.phase === 'none' && b.pit.phase === 'none') continue;
        const d = Math.hypot(a.phys.x - b.phys.x, a.phys.z - b.phys.z);
        if (d < minDist) minDist = d;
        if (d < 2.2) { overlapSteps++; overlapPairs.add(`${a.driverId ?? i}/${b.driverId ?? j}:${a.pit.phase}+${b.pit.phase}`); }
        // a pit car (any phase) with an on-track car: physical overlap that collisions would normally have resolved
      }
    }
    // pit-bound car on entry road vs track car behind: closing speed and distance
    for (const a of world.cars) {
      if (a.pit.phase !== 'entry' && a.pit.phase !== 'exit') continue;
      for (const b of world.cars) {
        if (b === a || b.pit.phase !== 'none' || b.status !== 'running') continue;
        const gap = forwardDistance(track, b.phys.s, a.phys.s); // b behind a
        if (gap > 0 && gap < 60 && Math.abs(b.phys.lateral - a.phys.lateral) < 4) {
          const closing = b.phys.speed - a.phys.speed;
          if (closing > worstClosing) { worstClosing = closing; worstClosingInfo = `${a.pit.phase} gap=${gap.toFixed(0)}m closing=${closing.toFixed(0)}m/s dlat=${Math.abs(b.phys.lateral - a.phys.lateral).toFixed(1)}`; }
        }
      }
    }
  }
  const stops = world.cars.map((c: any) => c.pit.stops);
  return { stops: stops.filter((s: number) => s > 0).length, finished: world.cars.filter((c: any) => c.status === 'finished').length, overlapSteps, pairs: overlapPairs.size, pairList: [...overlapPairs].slice(0, 6), minDist: +minDist.toFixed(2), waits: waits.sort((a, b) => b - a).slice(0, 8), worstClosing, worstClosingInfo, time: +world.time.toFixed(0) };
}
for (const id of process.argv.slice(2)) {
  console.log('=== ', id, JSON.stringify(run(id, 2, 4, true)));
}
