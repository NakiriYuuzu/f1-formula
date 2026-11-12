const R = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { createWorld, getPlayerCarId, isSessionOver, requestPit, stepWorld } = await import(`${R}/race/index`);
const { estimatePitLoss } = await import(`${R}/race/pitlane`);
const { computeAIInput } = await import(`${R}/ai/index`);
const { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } = await import(`${R}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${R}/data/teams`);
const { getLayout } = await import(`${R}/data/tracks/index`);
const { forwardDistance, pitRampLength, pitZoneLength } = await import(`${R}/track/track`);

const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');
const HUMAN = 'varga';
const team = (id: string) => RACERS.find((d: any) => d.id === id)?.teamId ?? '';

function config(layoutId: string, human: boolean, pitAssist: boolean, laps: number): any {
  return {
    mode: 'grandPrix', kind: 'race', layoutId, laps, timeLimit: null, qualifyingLaps: 0,
    weather: 'clear', dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90,
    players: human ? [{ playerIndex: 0, driverId: HUMAN, teamId: team(HUMAN), setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist } }] : [],
    grid: [{ driverId: HUMAN, teamId: team(HUMAN), playerIndex: human ? 0 : -1, startCompound: 'medium' }],
    teams: TEAMS, drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off', mandatoryPitStop: false },
    seed: 11, ghost: null, objective: null,
  };
}

function run(layoutId: string, o: { human: boolean; pitAssist: boolean; stop: boolean; laps?: number }) {
  const laps = o.laps ?? 5;
  const track = getLayout(layoutId);
  const world = createWorld(config(layoutId, o.human, o.pitAssist, laps), track);
  const laptimes: Record<number, number> = {};
  const marks: { phase: string; t: number; v: number; d: number }[] = [];
  let stopDur = 0; let stops = 0; let requested = false; let lastPhase = 'none';
  let maxJump = 0, maxYawJump = 0, jumpAt = '';
  let prev: any = null;
  const ramp = pitRampLength(track), zone = pitZoneLength(track);
  let handovers: string[] = [];
  let lastAuto = false;
  while (!isSessionOver(world) && world.time < 900) {
    const c = world.cars[0];
    if (o.stop && !requested && c.timing.lap === 3 && c.pit.phase === 'none' && !c.pit.requested) { requestPit(world, 0, 'medium'); requested = true; }
    let inputs: any[] = [];
    if (o.human) inputs = [computeAIInput(world, c, track, SIM_DT)];
    stepWorld(world, track, inputs, SIM_DT);
    for (const e of world.events) {
      if (e.type === 'lapComplete' && e.carId === c.id) laptimes[e.lap] = e.time;
      if (e.type === 'pitStop') { stopDur = e.duration; stops++; }
    }
    world.events.length = 0;
    const ph = c.pit.phase;
    const d = forwardDistance(track, track.pit.entry, c.phys.s);
    if (ph !== lastPhase) { marks.push({ phase: `${lastPhase}->${ph}`, t: +world.time.toFixed(2), v: +c.phys.speed.toFixed(1), d: +d.toFixed(0) }); lastPhase = ph; }
    if (c.race.pitAuto !== lastAuto) { handovers.push(`pitAuto ${lastAuto}->${c.race.pitAuto} t=${world.time.toFixed(1)} v=${c.phys.speed.toFixed(1)} lat=${c.phys.lateral.toFixed(2)} d=${d.toFixed(0)}`); lastAuto = c.race.pitAuto; }
    if (prev && (ph !== 'none' || prev.ph !== 'none')) {
      const dx = c.phys.x - prev.x, dz = c.phys.z - prev.z;
      const jump = Math.hypot(dx, dz) - c.phys.speed * SIM_DT;
      const yj = Math.abs(((c.phys.yaw - prev.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (Math.abs(jump) > maxJump) { maxJump = Math.abs(jump); jumpAt = `${prev.ph}->${ph} d=${d.toFixed(0)}`; }
      if (yj > maxYawJump) maxYawJump = yj;
    }
    prev = { x: c.phys.x, z: c.phys.z, yaw: c.phys.yaw, ph };
  }
  const c = world.cars[0];
  return { laptimes, marks, stopDur, stops, finalStops: c.pit.stops, pen: c.penalties.timeSec, maxJump: +maxJump.toFixed(3), jumpAt, maxYawJump: +maxYawJump.toFixed(3), handovers, ramp, zone, est: estimatePitLoss(track), len: track.length, limit: track.pit.speedLimit, laneLen: track.pit.laneLength };
}

const layouts = process.argv.slice(2);
for (const id of layouts) {
  const ctrl = run(id, { human: false, pitAssist: true, stop: false });
  const ai = run(id, { human: false, pitAssist: true, stop: true });
  const man = run(id, { human: true, pitAssist: false, stop: true });
  const ctrlH = run(id, { human: true, pitAssist: false, stop: false });
  const sum = (r: any) => (r.laptimes[3] ?? NaN) + (r.laptimes[4] ?? NaN);
  console.log(`=== ${id} len=${ctrl.len.toFixed(0)} zone=${ai.zone.toFixed(0)} ramp=${ai.ramp.toFixed(0)} laneLen=${ai.laneLen.toFixed(0)} est=${ai.est.toFixed(1)}`);
  console.log('ctrl laps', JSON.stringify(ctrl.laptimes), 'stops', ctrl.finalStops);
  console.log('AI   laps', JSON.stringify(ai.laptimes), 'stops', ai.finalStops, 'stopDur', ai.stopDur.toFixed(2));
  console.log('AI loss (lap3+4 delta)', (sum(ai) - sum(ctrl)).toFixed(2));
  console.log('AI marks', JSON.stringify(ai.marks));
  console.log('AI maxJump(m, beyond v*dt)', ai.maxJump, ai.jumpAt, 'maxYawJump', ai.maxYawJump);
  console.log('manual ctrl laps', JSON.stringify(ctrlH.laptimes));
  console.log('manual laps', JSON.stringify(man.laptimes), 'stops', man.finalStops, 'stopDur', man.stopDur.toFixed(2), 'pen', man.pen);
  console.log('manual loss vs manual-ctrl', (sum(man) - sum(ctrlH)).toFixed(2), ' vs ctrl AI', (sum(man) - sum(ctrl)).toFixed(2));
  console.log('manual marks', JSON.stringify(man.marks));
  console.log('manual handovers', man.handovers.join(' | '));
  console.log('manual maxJump', man.maxJump, man.jumpAt, 'maxYawJump', man.maxYawJump);
}
