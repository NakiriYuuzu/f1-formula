const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, isSessionOver, requestPit, stepWorld } = await import(`${R}/race/index`);
const { computeAIInput, steerToward } = await import(`${R}/ai/index`);
const { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { getLayout } = await import(`${R}/data/tracks/index`);
const { forwardDistance, pitLaneOffsetAt, pitRampLength, pitZoneLength } = await import(`${R}/track/track`);
const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');
const cfg = (layoutId: string, pitAssist: boolean): any => ({
  mode: 'grandPrix', kind: 'race', layoutId, laps: 3, timeLimit: null, qualifyingLaps: 0, weather: 'clear', dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90,
  players: [{ playerIndex: 0, driverId: 'varga', teamId: RACERS.find((d: any) => d.id === 'varga')!.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist } }],
  grid: [{ driverId: 'varga', teamId: RACERS.find((d: any) => d.id === 'varga')!.teamId, playerIndex: 0, startCompound: 'medium' }],
  teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off', mandatoryPitStop: false }, seed: 11, ghost: null, objective: null });
const wrapYaw = (a: number): number => Math.abs(((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);

/**
 * One pit visit of the player's car. Manual (pit assist off): a scripted driver holds `laneSpeed` between the lines
 * (limiter pressed or not) until the box autopilot takes over. Assist on: the full autopilot.
 * Rows: where the autopilot took over (d from the entry, metres of lane driven before it), the largest one-tick speed
 * change and the deceleration it implies while the autopilot drives, the largest one-tick yaw change within 30 m of
 * the box, the speed at the hand back.
 */
function go(layoutId: string, laneSpeed: number, limiter: boolean, pitAssist: boolean): string {
  const track = getLayout(layoutId);
  const world = createWorld(cfg(layoutId, pitAssist), track);
  const ramp = pitRampLength(track), zone = pitZoneLength(track);
  const c = world.cars[0];
  const boxD = forwardDistance(track, track.pit.entry, c.pit.boxS);
  let req = false, lastAuto = false, takeD = NaN, handV = NaN, pen = 0;
  let maxDv = 0, maxDvAt = '', maxYaw = 0, maxYawAt = '', minG = 0;
  let prevV = 0, prevYaw = c.phys.yaw, prevPh = 'none', prevKin = false;
  while (!isSessionOver(world) && world.time < 600) {
    if (!req && c.timing.lap === 2 && c.pit.phase === 'none') { requestPit(world, 0, 'soft'); req = true; }
    const ai = computeAIInput(world, c, track, SIM_DT);
    let inp = ai;
    if (!pitAssist && c.pit.requested && !c.race.pitAuto) {
      const p = c.phys; const d = forwardDistance(track, track.pit.entry, p.s); const look = 14;
      const inZone = d < zone;
      const lat = inZone ? pitLaneOffsetAt(track, p.s + look) ?? p.lateral : null;
      if (lat !== null) {
        const target = d < ramp ? Math.max(laneSpeed, Math.sqrt(laneSpeed ** 2 + 2 * 14 * Math.max(0, ramp - d - 8))) : d < zone - ramp ? laneSpeed : 60;
        const err = target - p.speed;
        inp = { ...ai, steer: steerToward(c, track, lat, look), throttle: err > 0 ? Math.min(1, err * 0.6 + 0.1) : 0, brake: err < -0.3 ? Math.min(1, -err * 0.4) : 0, limiterToggle: limiter && !p.limiter && d > ramp * 0.5 && d < zone - ramp };
      }
    }
    stepWorld(world, track, [inp], SIM_DT); world.events.length = 0;
    const p = c.phys;
    const d = forwardDistance(track, track.pit.entry, p.s);
    if (c.race.pitAuto !== lastAuto) {
      if (c.race.pitAuto) takeD = d; else handV = p.speed;
      lastAuto = c.race.pitAuto;
    }
    // ticks the kinematic autopilot drives (box manoeuvre of a manual visit / the whole visit with the assist)
    const kin = c.pit.phase !== 'none' && (!c.race.pitManual || c.race.pitAuto);
    if (kin || prevKin) {
      const dv = p.speed - prevV;
      if (Math.abs(dv) > maxDv) { maxDv = Math.abs(dv); maxDvAt = `${prevPh}->${c.pit.phase} d=${d.toFixed(0)} v=${prevV.toFixed(1)}->${p.speed.toFixed(1)}`; }
      minG = Math.min(minG, p.gLong);
    }
    if (c.pit.phase !== 'none' && Math.abs(d - boxD) <= 30) {
      const yj = wrapYaw(p.yaw - prevYaw);
      if (yj > maxYaw) { maxYaw = yj; maxYawAt = `${c.pit.phase} d-box=${(d - boxD).toFixed(1)} v=${p.speed.toFixed(1)}`; }
    }
    prevV = p.speed; prevYaw = p.yaw; prevPh = c.pit.phase; prevKin = kin;
    pen = c.penalties.timeSec;
  }
  const lane = Number.isFinite(takeD) ? Math.max(0, takeD - ramp) : NaN;
  const mode = pitAssist ? 'assist     ' : `manual ${String(laneSpeed).padStart(2)}${limiter ? 'L' : ' '}`;
  return `${layoutId.padEnd(12)} ${mode} | stops ${c.pit.stops} pen ${pen} | box d=${boxD.toFixed(0)} line=${ramp.toFixed(0)} takeover d=${Number.isFinite(takeD) ? takeD.toFixed(1) : '-'} laneDriven=${Number.isFinite(lane) ? lane.toFixed(1) : '-'}m` +
    ` | max1tick dv=${maxDv.toFixed(3)} m/s (${(maxDv / SIM_DT).toFixed(1)} m/s2) [${maxDvAt}] minGLong=${minG.toFixed(2)}` +
    ` | yaw/tick near box max=${maxYaw.toFixed(4)} rad [${maxYawAt}] | handback v=${Number.isFinite(handV) ? handV.toFixed(1) : '-'}`;
}
const ids = process.argv.length > 2 ? process.argv.slice(2) : ['monza', 'monaco', 'silverstone', 'suzuka'];
for (const id of ids) {
  console.log(go(id, 22, true, false));
  console.log(go(id, 30, false, false));
  console.log(go(id, 0, false, true));
}
