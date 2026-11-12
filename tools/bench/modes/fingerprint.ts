/**
 * Race fingerprints: a standard race (safety car and red flags on, the mandatory stop), a wet-to-dry standard race, a
 * sprint and an elimination race, each simulated to its end on a fixed seed. Prints a hash of every car's state once a
 * simulated second and of every event, then the classification. Run it on two revisions (BENCH_ROOT) and diff the output:
 * equal lines mean the races ran step for step the same.
 *   bun run tools/bench/modes/fingerprint.ts [standard,wet,sprint,elimination]
 */
const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, isSessionOver, stepWorld, buildSessionResult, eliminationFormat } = await import(`${R}/race/index`);
const { DEFAULT_RULES, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { getLayout } = await import(`${R}/data/tracks/index`);

const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');

interface Case {
  layoutId: string;
  laps: number;
  seed: number;
  weather: string;
  dynamicWeather: boolean;
  rules: Record<string, unknown>;
  sprint?: boolean;
  elimination?: number;
}

const CASES: Record<string, Case> = {
  standard: { layoutId: 'monza', laps: 14, seed: 42, weather: 'clear', dynamicWeather: false, rules: { safetyCar: 'increased', redFlags: true, mandatoryPitStop: true } },
  wet: { layoutId: 'silverstone', laps: 10, seed: 7, weather: 'lightRain', dynamicWeather: true, rules: { safetyCar: 'standard', mandatoryPitStop: true } },
  sprint: { layoutId: 'suzuka', laps: 5, seed: 3, weather: 'clear', dynamicWeather: false, rules: { safetyCar: 'standard', mandatoryPitStop: false }, sprint: true },
  elimination: { layoutId: 'monza', laps: 3, seed: 11, weather: 'clear', dynamicWeather: false, rules: { safetyCar: 'standard', mandatoryPitStop: true }, elimination: 30 },
};

/** FNV-1a over a string, as 8 hex digits. */
function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
const hex = (h: number): string => h.toString(16).padStart(8, '0');

function run(name: string, c: Case): void {
  const track = getLayout(c.layoutId);
  const world = createWorld(
    {
      mode: 'grandPrix', kind: 'race', layoutId: c.layoutId, laps: c.laps, timeLimit: null, qualifyingLaps: 0, weather: c.weather,
      dynamicWeather: c.dynamicWeather, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
      grid: RACERS.map((d: any, i: number) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: i % 3 === 0 ? 'soft' : 'medium' })),
      teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, ...c.rules }, seed: c.seed, ghost: null, objective: null,
      ...(c.sprint ? { sprint: true } : {}),
      ...(c.elimination ? { raceFormat: eliminationFormat(c.elimination) } : {}),
    } as any,
    track,
  );
  let state = 0x811c9dc5;
  let events = 0x811c9dc5;
  let nextMark = 1;
  let steps = 0;
  while (!isSessionOver(world) && world.time < 4 * 3600) {
    stepWorld(world, track, [], SIM_DT);
    steps++;
    for (const e of world.events) events = fnv(JSON.stringify(e), events);
    world.events.length = 0;
    if (world.time >= nextMark) {
      nextMark += 1;
      const cars = world.cars.map((car: any) => {
        const p = car.phys;
        return [p.x, p.z, p.speed, p.fuelKg, p.tire.wear, p.ers.charge, car.timing.lap, car.timing.position, car.status, car.pit.phase, car.pit.stops];
      });
      state = fnv(JSON.stringify([world.session.totalLaps, world.session.phase, world.session.control.mode, cars]), state);
    }
  }
  const result = buildSessionResult(world);
  const rows = result.rows.map((r: any) => `${r.carId}:${r.position}:${r.lapsCompleted}:${r.gapText}:${r.pitStops}`).join(' ');
  console.log(`${name.padEnd(12)} steps ${steps} t ${world.time.toFixed(3)} laps ${world.session.totalLaps} state ${hex(state)} events ${hex(events)}`);
  console.log(`${''.padEnd(12)} result ${hex(fnv(rows))} ${rows.slice(0, 160)}`);
}

const pick = (process.argv[2] ?? Object.keys(CASES).join(',')).split(',');
for (const name of pick) run(name, CASES[name]!);
