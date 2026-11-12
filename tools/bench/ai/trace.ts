/**
 * A step-by-step look at one chase. Needs a tree where planTraffic sets ai.dbg* (tools/bench/ai/diag-gates.patch).
 *   bun run tools/bench/ai/trace.ts <root> <layout> <seed> <difficulty> <chaser: grid-reverse rank of pace 0 = fastest> <t0> <t1> [every s]
 * Runs a 12-lap reverse-grid race and prints, every `every` s between t0 and t1, how the fastest car (or the n-th fastest)
 * sits behind the car in front: gap, closing rate, both speeds, the speed the plan allows against the speed it wants.
 */
const [root, layoutId, seedS, diffS, rankS, t0S, t1S, everyS = '0.5'] = process.argv.slice(2);
const R = (p: string) => import(`${root}/src/${p}`);
const race = await R('race/index');
const defaults = await R('core/defaults');
const teamsMod = await R('data/teams');
const tracks = await R('data/tracks/index');
const trackMod = await R('track/track');
const { createWorld, isSessionOver, stepWorld } = race;
const { DEFAULT_RULES, SIM_DT } = defaults;
const { DRIVERS, TEAMS } = teamsMod;
const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');
const seed = Number(seedS);
const track = tracks.getLayout(layoutId);
// the grid of a probe.ts reverse race is recomputed there by hill-climbing: reuse its output file for the order
const probeOut = JSON.parse(await Bun.file(process.env.PROBE_JSON ?? '').text());
const order: string[] = probeOut.drivers.map((_: string, i: number) => probeOut.drivers[probeOut.gridPos.indexOf(i + 1)]);
const hash = (text: string): number => { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const cfg: any = {
  mode: 'grandPrix', kind: 'race', layoutId, laps: 12, timeLimit: null, qualifyingLaps: 0, weather: 'clear', dynamicWeather: false, timeOfDay: 'day', regulation: '2025',
  aiDifficulty: Number(diffS), players: [],
  grid: order.map((id) => ({ driverId: id, teamId: RACERS.find((d: any) => d.id === id)?.teamId ?? '', playerIndex: -1, startCompound: 'medium' })),
  teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off', aeroWake: true }, seed, ghost: null, objective: null,
};
void hash;
const world = createWorld(cfg, track);
const byPace = [...world.cars].sort((a: any, b: any) => a.ai.paceTime - b.ai.paceTime);
const chaser = byPace[Number(rankS)];
const t0 = Number(t0S), t1 = Number(t1S), every = Number(everyS);
console.log(`chaser ${chaser.driverId} (pace rank ${rankS}, ${chaser.ai.paceTime.toFixed(2)} s) grid ${chaser.timing.gridPosition}`);
console.log('t      lap  s     pos  gap_m  tgap_s  close  vMe   vAhead  limit  want   gate        brk   thr  latMe latAh  offs  nois  ahead');
let next = t0;
const episodes = process.env.EPISODES === '1';
const prevPhase = world.cars.map(() => 'none');
if (episodes) console.log('t      car       pace   phase change           gap_m tgap_s close vMe  vAh  dLat  end-reason');
while (!isSessionOver(world) && world.time < t1) {
  stepWorld(world, track, [], SIM_DT);
  if (episodes && world.time >= t0) {
    for (const c of world.cars) {
      const ai: any = c.ai;
      if (ai.attackPhase === prevPhase[c.id]) continue;
      const bId = world.race.order[c.timing.position - 2];
      const b = bId === undefined ? null : world.cars[bId];
      const tgt = world.cars[ai.attackTarget] ?? b;
      console.log(
        [
          world.time.toFixed(1).padStart(6), c.driverId.padEnd(9), c.ai.paceTime.toFixed(1).padStart(5), `${prevPhase[c.id]}->${ai.attackPhase}`.padEnd(22),
          (ai.dbgAheadGap ?? -1).toFixed(1).padStart(5), c.timing.interval.toFixed(2).padStart(6), ai.closing.toFixed(2).padStart(5), c.phys.speed.toFixed(0).padStart(4),
          (tgt ? tgt.phys.speed : 0).toFixed(0).padStart(4), tgt ? (tgt.phys.lateral - c.phys.lateral).toFixed(1).padStart(5) : '    -', ai.attackPhase === 'none' ? `${ai.dbgEnd ?? ''} ${ai.dbgEnd === 'end:noRoom' ? ai.dbgRoom : ''}` : '',
        ].join(' '),
      );
      prevPhase[c.id] = ai.attackPhase;
    }
    continue;
  }
  if (!episodes && world.time >= next) {
    next += every;
    const c = chaser;
    const bId = world.race.order[c.timing.position - 2];
    const b = bId === undefined ? null : world.cars[bId];
    const ai: any = c.ai;
    const tgap = c.timing.interval;
    const v = c.phys.speed;
    console.log(
      [
        world.time.toFixed(1).padStart(6), String(c.timing.lapsCompleted + 1).padStart(3), Math.round(c.phys.s).toString().padStart(5), String(c.timing.position).padStart(4),
        (ai.dbgAheadGap ?? -1).toFixed(1).padStart(6), tgap.toFixed(2).padStart(6), ai.closing.toFixed(2).padStart(6), v.toFixed(1).padStart(5),
        (b ? b.phys.speed : 0).toFixed(1).padStart(7), Math.min(999, ai.dbgSpeedLimit ?? 0).toFixed(1).padStart(6), (ai.dbgTrackSpeed ?? 0).toFixed(1).padStart(6),
        String(ai.dbgGate ?? '').padEnd(11), c.phys.brake.toFixed(2).padStart(5), c.phys.throttle !== undefined ? Number(c.phys.throttle).toFixed(2).padStart(5) : '    -',
        (c.phys.lateral - trackMod.sampleAt(track, track.racingLine, c.phys.s)).toFixed(1).padStart(5),
        b ? (b.phys.lateral - trackMod.sampleAt(track, track.racingLine, b.phys.s)).toFixed(1).padStart(5) : '    -',
        ai.offset.toFixed(1).padStart(5), ai.lineNoise.toFixed(1).padStart(5), b ? b.driverId : '-',
      ].join(' '),
    );
  }
}
void trackMod;
