const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, getPlayerCarId, isSessionOver, requestPit, stepWorld } = await import(`${R}/race/index`);
const { computeAIInput, steerToward } = await import(`${R}/ai/index`);
const { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { getLayout } = await import(`${R}/data/tracks/index`);
const { forwardDistance, pitLaneOffsetAt, pitRampLength, pitZoneLength } = await import(`${R}/track/track`);
const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');
const cfg = (layoutId: string): any => ({
  mode: 'grandPrix', kind: 'race', layoutId, laps: 3, timeLimit: null, qualifyingLaps: 0, weather: 'clear', dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90,
  players: [{ playerIndex: 0, driverId: 'varga', teamId: RACERS.find((d: any) => d.id === 'varga')!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist: false } }],
  grid: [{ driverId: 'varga', teamId: RACERS.find((d: any) => d.id === 'varga')!.teamId, playerIndex: 0, startCompound: 'medium' }],
  teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off', mandatoryPitStop: false }, seed: 11, ghost: null, objective: null });
function go(layoutId: string, laneSpeed: number, limiter: boolean) {
  const track = getLayout(layoutId); const world = createWorld(cfg(layoutId), track);
  const ramp = pitRampLength(track), zone = pitZoneLength(track);
  let req = false, lastAuto = false, prevV = 0, prevG = 0; const out: string[] = []; let minGLong = 0, pen = 0;
  while (!isSessionOver(world) && world.time < 600) {
    const c = world.cars[0];
    if (!req && c.timing.lap === 2 && c.pit.phase === 'none') { requestPit(world, 0, 'soft'); req = true; }
    const ai = computeAIInput(world, c, track, SIM_DT);
    let inp = ai;
    if (c.pit.phase !== 'none' && !c.race.pitAuto) {
      const p = c.phys; const d = forwardDistance(track, track.pit.entry, p.s); const look = 14;
      const lat = pitLaneOffsetAt(track, p.s + look) ?? p.lateral;
      const target = d < ramp ? Math.max(laneSpeed, Math.sqrt(laneSpeed ** 2 + 2 * 14 * Math.max(0, ramp - d - 8))) : d < zone - ramp ? laneSpeed : 60;
      const err = target - p.speed;
      inp = { ...ai, steer: steerToward(c, track, lat, look), throttle: err > 0 ? Math.min(1, err * 0.6 + 0.1) : 0, brake: err < -0.3 ? Math.min(1, -err * 0.4) : 0, limiterToggle: limiter && !p.limiter && d > ramp * 0.5 && d < zone - ramp };
    }
    prevV = c.phys.speed; prevG = c.phys.gLong;
    stepWorld(world, track, [inp], SIM_DT); world.events.length = 0;
    if (c.race.pitAuto !== lastAuto) {
      out.push(`pitAuto ${lastAuto}->${c.race.pitAuto}: speed before=${prevV.toFixed(2)} after=${c.phys.speed.toFixed(2)} (dv=${(c.phys.speed - prevV).toFixed(2)} m/s) gLong after=${c.phys.gLong.toFixed(1)}`);
      lastAuto = c.race.pitAuto;
    }
    if (c.pit.phase !== 'none') minGLong = Math.min(minGLong, c.phys.gLong);
    pen = c.penalties.timeSec;
  }
  console.log(layoutId, 'laneSpeed', laneSpeed, 'limiter', limiter, '| stops', world.cars[0].pit.stops, 'penalty s', pen, 'minGLong', minGLong.toFixed(1), '\n  ', out.join('\n   '));
}
go('monza', 22, true); go('monza', 30, false); go('monaco', 22, true); go('silverstone', 22, true);
