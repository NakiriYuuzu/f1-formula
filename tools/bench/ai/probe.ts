/**
 * Racecraft probe. Usage:
 *   bun run tools/bench/ai/probe.ts <repoRoot> <layout> <laps> <seed> <mode: normal|reverse|reverseFull> <difficulty> <out.json> [seat: none|slow|fast|cost] [mistakes: 0|1]
 * Imports the repo by absolute path (dynamic), writes only to <out.json>.
 *
 * seat: one car sits in the player's seat (playerIndex 0, grid slot SEAT_SLOT, default P10), driven by the AI controller's
 * own inputs. slow = pace held SEAT_DEFICIT (default 0.4 %) behind the field median by scaling its corner / braking factors
 * (calibrated by a solo run, cached under /tmp/ai-rc/seatcal); fast = the car's natural pace. mistakes=1 adds scripted
 * errors (a throttle lift on a corner exit, a stab on the brakes before a corner) whenever a car is 0.2-1 s behind the seat. cost = solo run that
 * prints what each scripted error costs in lap time (no race).
 * SEAT_ROOT=<checkout> drives the seat with that checkout's controller instead of the tree under test (a fixed yardstick while the AI changes).
 */
const [root, layoutId, lapsS, seedS, mode, diffS, outPath, seatRole = 'none', mistakesS = '0'] = process.argv.slice(2);
const seatOn = seatRole === 'slow' || seatRole === 'fast';
const mistakesOn = seatOn && mistakesS === '1';
const SEAT_DRIVER = process.env.SEAT_DRIVER ?? 'lindqvist';
const SEAT_SLOT = Number(process.env.SEAT_SLOT ?? 9);
const SEAT_DEFICIT = Number(process.env.SEAT_DEFICIT ?? 0.004);
const LIFT_SEC = Number(process.env.LIFT_SEC ?? 2.5);
const BRAKE_SEC = Number(process.env.BRAKE_SEC ?? 1.0);
const BRAKE_LEVEL = Number(process.env.BRAKE_LEVEL ?? 0.5);
const BRAKE_FROM = Number(process.env.BRAKE_FROM ?? 260);
const MISTAKE_SPACING = Number(process.env.MISTAKE_SPACING ?? 20);
const MISTAKE_WINDOW = 15;
const laps = Number(lapsS);
const seed = Number(seedS);
const difficulty = Number(diffS);
const R = (p: string) => import(`${root}/src/${p}`);
const race = await R('race/index');
const defaults = await R('core/defaults');
const teamsMod = await R('data/teams');
const tracks = await R('data/tracks/index');
const traffic = await R('ai/traffic');
const SEAT_ROOT = process.env.SEAT_ROOT ?? root;
// the seat is driven by a frozen controller (SEAT_ROOT, default: the tree under test) so that its racecraft stays a fixed yardstick
const aiMod = await import(`${SEAT_ROOT}/src/ai/index`);
const trackMod = await R('track/track');
const { createWorld, isSessionOver, stepWorld } = race;
const { DEFAULT_RULES, SIM_DT, AI_ASSISTS } = defaults;
const { DRIVERS, TEAMS } = teamsMod;
const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
function cfgFor(order: string[], compoundMode: 'mixed' | 'medium', seatDriver = '', cfgLaps = laps, cfgSeed = seed): any {
  return {
    mode: 'grandPrix', kind: 'race', layoutId, laps: cfgLaps, timeLimit: null, qualifyingLaps: 0, weather: 'clear',
    dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: difficulty, players: [],
    grid: order.map((id) => ({
      driverId: id, teamId: RACERS.find((d: any) => d.id === id)?.teamId ?? '', playerIndex: id === seatDriver ? 0 : -1,
      startCompound: compoundMode === 'medium' ? 'medium' : hash(`${id}tyre${cfgSeed}`) < 0.55 ? 'medium' : 'soft',
    })),
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off', aeroWake: process.env.WAKE !== '0' }, seed: cfgSeed, ghost: null, objective: null,
  };
}
const strength = (id: string): number => {
  const d = RACERS.find((x: any) => x.id === id); const t = TEAMS.find((x: any) => x.id === d?.teamId);
  return (t.rating.aero + t.rating.power + t.rating.chassis) / 3 + d.skill.pace * 0.35 + (hash(`${id}${seed}`) - 0.5) * 0.04;
};
const track = tracks.getLayout(layoutId);
const baseOrder: string[] = RACERS.map((d: any) => d.id).sort((a: string, b: string) => strength(b) - strength(a));
let order = baseOrder;
let compoundMode: 'mixed' | 'medium' = 'mixed';
let backFive: string[] = [];
let backScore = -1;
if (mode !== 'normal') {
  compoundMode = 'medium';
  // paceTime (race form included) depends on the grid slot through the car's seed: hill-climb by swapping a misplaced
  // fast car with a slow one in the back five until the world's own 5 fastest sit in slots 16-20
  const K = mode === 'reverseFull' ? 0 : 5;
  const fastOf = (o: string[]): string[] => {
    const w = createWorld(cfgFor(o, compoundMode), track);
    return [...w.cars].sort((a: any, b: any) => a.ai.paceTime - b.ai.paceTime).map((c: any) => c.driverId);
  };
  if (K > 0) {
    let rs = (seed * 2654435761) >>> 0;
    const rnd = (): number => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
    const score = (o: string[]): number => { const f5 = new Set(fastOf(o).slice(0, 5)); return o.slice(15).filter((id) => f5.has(id)).length; };
    let byPace = fastOf(order);
    order = [...byPace.slice(5), ...byPace.slice(0, 5).reverse()];
    let bestScore = score(order);
    for (let it = 0; it < 600 && bestScore < 5; it++) {
      const cand = [...order];
      const m = rnd();
      if (m < 0.3) { const i = 15 + Math.floor(rnd() * 5), j = 15 + Math.floor(rnd() * 5); [cand[i], cand[j]] = [cand[j], cand[i]]; }
      else if (m < 0.6) { const i = Math.floor(rnd() * 14); [cand[i], cand[i + 1]] = [cand[i + 1], cand[i]]; }
      else {
        const f5 = new Set(fastOf(cand).slice(0, 5));
        const mis = cand.slice(0, 15).filter((id) => f5.has(id));
        const wrong = cand.slice(15).filter((id) => !f5.has(id));
        if (mis.length && wrong.length) { const i = cand.indexOf(mis[Math.floor(rnd() * mis.length)]), j = cand.indexOf(wrong[Math.floor(rnd() * wrong.length)]); [cand[i], cand[j]] = [cand[j], cand[i]]; }
      }
      const s = score(cand);
      if (s >= bestScore) { bestScore = s; order = cand; }
    }
    backScore = bestScore;
  } else {
    order = fastOf(order).reverse();
  }
}

interface SeatCal { kappa: number; tNat: number; scale: number; tSeat: number; target: number }
interface Plan { (w: any, seat: any, input: any, lap: number): void }
/** Lap times of one car alone on the track (lap 1 is the standing start): the seat under the AI controller, or the same driver as an AI car. */
function runSolo(driverId: string, human: boolean, scale: number, soloLapCount: number, plan?: Plan): { times: number[]; paceTime: number } {
  const w = createWorld(cfgFor([driverId], 'medium', human ? driverId : '', soloLapCount, 1), track);
  const car = w.cars[0];
  if (human) { Object.assign(car.assists, AI_ASSISTS); car.ai.latFactor *= scale; car.ai.brakeFactor *= scale; }
  const times: number[] = [];
  let seen = 0;
  while (!isSessionOver(w) && w.time < 4000) {
    const inputs: any[] = [null, null, null, null];
    if (human) { inputs[0] = aiMod.computeAIInput(w, car, track, SIM_DT); plan?.(w, car, inputs[0], car.timing.lapsCompleted); }
    stepWorld(w, track, inputs, SIM_DT);
    if (car.timing.lapsCompleted !== seen) { seen = car.timing.lapsCompleted; if (car.timing.lastLap) times.push(car.timing.lastLap); }
  }
  return { times, paceTime: car.ai.paceTime };
}
const flying = (t: number[]): number => { const a = t.slice(1); return a.reduce((x, y) => x + y, 0) / Math.max(1, a.length); };

/** First corner whose start lies at least minDist ahead of s (-1 none). */
function cornerFrom(s: number, minDist: number): number {
  let best = -1, dist = Infinity;
  for (let i = 0; i < track.corners.length; i++) {
    const d = trackMod.forwardDistance(track, s, track.corners[i].startS);
    if (d >= minDist && d < dist) { dist = d; best = i; }
  }
  return best;
}
/** A scripted error: a throttle lift from the apex of a corner (lift) or a stab on the brakes BRAKE_FROM m before one (brake). */
interface Mistake { kind: 'lift' | 'brake'; corner: number; armedAt: number; t0: number; liftUntil: number; done: boolean }
function armMistake(w: any, seat: any, kind: 'lift' | 'brake', forced = -1): Mistake | null {
  const c = forced >= 0 ? forced : cornerFrom(seat.phys.s, kind === 'lift' ? 150 : 60);
  if (c < 0) return null;
  if (trackMod.forwardDistance(track, seat.phys.s, track.corners[c].startS) > 700) return null;
  return { kind, corner: c, armedAt: w.time, t0: -1, liftUntil: -1, done: false };
}
/** Apply an armed mistake to the seat's input; returns true on the step the error begins. */
function applyMistake(w: any, seat: any, input: any, m: Mistake): boolean {
  let began = false;
  const corner = track.corners[m.corner];
  if (m.kind === 'lift') {
    if (m.t0 < 0 && trackMod.inRangeS(track, seat.phys.s, corner.apexS, corner.endS)) { m.t0 = w.time; m.liftUntil = w.time + LIFT_SEC; began = true; }
    if (m.t0 >= 0 && w.time < m.liftUntil) input.throttle *= 0.2;
    if (m.t0 >= 0 && w.time >= m.liftUntil) m.done = true;
    if (m.t0 < 0 && w.time - m.armedAt > 40) m.done = true;
  } else {
    const d = trackMod.forwardDistance(track, seat.phys.s, corner.startS);
    if (m.t0 < 0 && d < BRAKE_FROM && seat.phys.speed > 40) { m.t0 = w.time; m.liftUntil = w.time + BRAKE_SEC; began = true; }
    if (m.t0 >= 0 && w.time < m.liftUntil) { input.throttle = 0; input.brake = Math.max(input.brake, BRAKE_LEVEL); }
    if (m.t0 >= 0 && w.time >= m.liftUntil) m.done = true;
    if (m.t0 < 0 && w.time - m.armedAt > 30) m.done = true;
  }
  return began;
}

if (seatRole === 'cost') {
  const costLaps = Number(lapsS) || 10;
  const cornerPick = Number(process.env.COST_CORNER ?? 3);
  const base = runSolo(SEAT_DRIVER, true, 1, costLaps);
  const cost = (kind: 'lift' | 'brake'): number => {
    let cur: Mistake | null = null;
    let curLap = -1;
    const plan: Plan = (w, seat, input, lap) => {
      if (lap >= 1 && curLap !== lap) {
        const c = cornerPick % track.corners.length;
        const d = trackMod.forwardDistance(track, seat.phys.s, track.corners[c].startS);
        if (d > 150 && d < 700) { cur = armMistake(w, seat, kind, c); if (cur) curLap = lap; }
      }
      if (cur && !cur.done) applyMistake(w, seat, input, cur);
    };
    return flying(runSolo(SEAT_DRIVER, true, 1, costLaps, plan).times) - flying(base.times);
  };
  console.log(`${layoutId} cost corner=${cornerPick} lift=${LIFT_SEC}s -> ${cost('lift').toFixed(2)} s/lap | brake ${BRAKE_SEC}s at ${BRAKE_LEVEL} from ${BRAKE_FROM} m -> ${cost('brake').toFixed(2)} s/lap (control lap ${flying(base.times).toFixed(2)} s)`);
  process.exit(0);
}

let seatCal: SeatCal | null = null;
if (seatOn) {
  const file = `/tmp/ai-rc/seatcal/${layoutId}_${seatRole}_d${difficulty}_${SEAT_DRIVER}_${SEAT_DEFICIT}.json`;
  const cached = Bun.file(file);
  if (await cached.exists()) seatCal = JSON.parse(await cached.text());
  else {
    const ai = runSolo(SEAT_DRIVER, false, 1, 4);
    const kappa = flying(ai.times) / ai.paceTime;
    let scale = 1;
    let t = flying(runSolo(SEAT_DRIVER, true, 1, 4).times);
    const tNat = t;
    const field = createWorld(cfgFor(baseOrder, 'medium', '', laps, 1), track).cars.map((c: any) => c.ai.paceTime).sort((a: number, b: number) => a - b);
    const target = seatRole === 'slow' ? field[Math.floor(field.length / 2)] * (1 + SEAT_DEFICIT) : tNat / kappa;
    for (let it = 0; it < 4 && seatRole === 'slow'; it++) {
      const x = (target * kappa) / t - 1;
      if (Math.abs(x) < 0.0005) break;
      scale *= 1 - x / 0.37;
      t = flying(runSolo(SEAT_DRIVER, true, scale, 4).times);
    }
    seatCal = { kappa, tNat, scale, tSeat: t, target };
    await Bun.write(file, JSON.stringify(seatCal));
  }
  const k = order.indexOf(SEAT_DRIVER);
  [order[k], order[SEAT_SLOT]] = [order[SEAT_SLOT], order[k]];
}
const world = createWorld(cfgFor(order, compoundMode, seatOn ? SEAT_DRIVER : ''), track);
const wetness = world.weather.wetness;
const n = world.cars.length;
const seat: any = seatOn ? world.cars.find((c: any) => c.playerIndex === 0) : null;
if (seat && seatCal) {
  Object.assign(seat.assists, AI_ASSISTS);
  seat.ai.latFactor *= seatCal.scale;
  seat.ai.brakeFactor *= seatCal.scale;
  seat.ai.paceTime = seatCal.tSeat / seatCal.kappa;
}
const paceStatic = world.cars.map((c: any) => c.ai.paceTime);
const rankByPace = [...world.cars.keys()].filter((i) => i !== seat?.id).sort((a, b) => paceStatic[a] - paceStatic[b]);
if (mode !== 'normal') backFive = rankByPace.slice(0, 5).map((i) => world.cars[i].driverId);
const mistakeRecs: any[] = [];
const contactRecs: any[] = [];
let activeMistake: { m: Mistake; rec: any } | null = null;
let mistakeCount = 0;
let nextMistakeAt = 0;

interface Stint { a: number; b: number; start: number; t1: number; tot: number; drs: number; atk: Record<string, number>; conserve: number; train: number; deltaStatic: number; deltaNow: number; reason: string; lapA: number; pitSoon: boolean }
const stints: Stint[] = [];
const active: (Stint | null)[] = new Array(n).fill(null);
const grace = new Array(n).fill(0);
const events: any[] = [];
const lastPitExit = new Array(n).fill(-1e9);
const attackEps: any[] = [];
const attackOpen: any[] = new Array(n).fill(null);
const prevPhase = world.cars.map((c: any) => c.pit.phase);
const lapRecs: any[] = [];
const SEG = 100;
const segBins = Math.ceil(track.length / SEG);
// closing speed by stretch of track for cars within 1 s of the car in front, split by how much faster the follower is (tyre-aware, at stint start)
const seg: Record<string, { t: number[]; close: number[]; lim: number[] }> = {};
for (const k of ['fast', 'even']) seg[k] = { t: new Array(segBins).fill(0), close: new Array(segBins).fill(0), lim: new Array(segBins).fill(0) };
const crossT: number[][] = world.cars.map(() => []);
const lapAcc = world.cars.map(() => ({ lap: 0, t: 0, near: 0, sumAhead: 0, pit: false, flag: false }));
const snaps: { leaderLaps: number; time: number; order: number[] }[] = [];
let prevLeaderLaps = 0;
let collisions = 0, heavy = 0;
const close = (i: number, reason: string, endPit = false): void => {
  const s = active[i]; if (!s) return;
  s.reason = reason; s.pitSoon = endPit; stints.push(s); active[i] = null; grace[i] = 0;
};
const t0 = Date.now();
while (!isSessionOver(world) && world.time < 2400) {
  const inputs: any[] = seat ? [null, null, null, null] : [];
  if (seat) {
    const inp = aiMod.computeAIInput(world, seat, track, SIM_DT);
    const liveNow = world.session.phase === 'running' && world.session.control.mode === 'green';
    if (mistakesOn) {
      if (!activeMistake && liveNow && seat.status === 'running' && seat.pit.phase === 'none' && seat.timing.lapsCompleted >= 1 && world.time >= nextMistakeAt) {
        const bId = world.race.order[seat.timing.position];
        const b = bId === undefined ? undefined : world.cars[bId];
        if (b && b.status === 'running' && b.pit.phase === 'none' && b.timing.position === seat.timing.position + 1 && b.timing.interval >= 0.2 && b.timing.interval <= 1.0) {
          const m = armMistake(world, seat, mistakeCount % 2 === 0 ? 'lift' : 'brake');
          if (m) {
            mistakeCount++;
            activeMistake = { m, rec: { kind: m.kind, lap: seat.timing.lapsCompleted, tArm: world.time, t0: -1, behind: b.id, iv0: b.timing.interval, deltaBehind: (paceStatic[seat.id] - paceStatic[b.id]) / paceStatic[seat.id], gapMin: 99, taken: null, seatPos: seat.timing.position } };
          }
        }
      }
      if (activeMistake) {
        const { m, rec } = activeMistake;
        if (!m.done && applyMistake(world, seat, inp, m)) rec.t0 = world.time;
        if (rec.t0 >= 0 && world.time - rec.t0 <= 6) {
          const b = world.cars[rec.behind];
          if (b.timing.position === seat.timing.position + 1 && b.timing.interval > 0) rec.gapMin = Math.min(rec.gapMin, b.timing.interval);
        }
        if (rec.t0 >= 0 && world.time - rec.t0 > MISTAKE_WINDOW) {
          mistakeRecs.push(rec);
          activeMistake = null;
          nextMistakeAt = world.time + MISTAKE_SPACING;
        } else if (m.done && rec.t0 < 0) {
          activeMistake = null;
          nextMistakeAt = world.time + MISTAKE_SPACING;
        }
      }
    }
    inputs[0] = inp;
  }
  stepWorld(world, track, inputs, SIM_DT);
  const live = world.session.phase === 'running';
  const green = world.session.control.mode === 'green';
  const cars = world.cars;
  const leaderLaps = Math.max(...cars.map((c: any) => c.timing.lapsCompleted));
  for (const e of world.events) {
    if (e.type === 'collision' && e.otherCarId !== null) { collisions++; if (e.impulse > 5000) heavy++; }
    if (seat && e.type === 'collision' && e.carId === seat.id && e.otherCarId !== null) {
      const o = cars[e.otherCarId];
      contactRecs.push({ t: world.time, other: e.otherCarId, impulse: e.impulse, ds: trackMod.signedDeltaS(track, seat.phys.s, o.phys.s), dLat: o.phys.lateral - seat.phys.lateral, lap: seat.timing.lapsCompleted, inMistake: activeMistake !== null && activeMistake.rec.t0 >= 0, vSeat: seat.phys.speed, vOther: o.phys.speed });
    }
    if (seat && activeMistake && e.type === 'overtake' && e.passedCarId === seat.id && activeMistake.rec.t0 >= 0 && !activeMistake.rec.taken) {
      activeMistake.rec.taken = { by: e.carId, after: world.time - activeMistake.rec.t0 };
    }
    if (e.type === 'overtake') {
      const a = cars[e.carId], b = cars[e.passedCarId];
      const pitRel = (c: any): boolean => c.pit.stops > 0 && world.time - lastPitExit[c.id] < 100 || c.pit.requested || c.pit.phase !== 'none';
      events.push({ t: world.time, lead: leaderLaps, lapA: a.timing.lapsCompleted, lapB: b.timing.lapsCompleted, passer: a.id, passed: b.id, pos: e.position, pit: pitRel(a) || pitRel(b), lap1: a.timing.lapsCompleted < 1 || b.timing.lapsCompleted < 1,
        paceA: paceStatic[a.id], paceB: paceStatic[b.id], aiTrick: a.ai.trickTarget === b.id && a.ai.trickTimer > 0 ? a.ai.trickKind : null, mode: a.ai.mode, phase: a.ai.attackPhase });
      close(a.id, 'passed');
    }
  }
  world.events.length = 0;
  if (leaderLaps !== prevLeaderLaps) { snaps.push({ leaderLaps, time: world.time, order: [...world.race.order] }); prevLeaderLaps = leaderLaps; }
  for (const c of cars) {
    const ph = c.ai.attackPhase;
    const open = attackOpen[c.id];
    if (open && (ph === 'none' || c.ai.attackTarget !== open.target)) { open.t1 = world.time; open.ivEnd = c.timing.interval; attackEps.push(open); attackOpen[c.id] = null; }
    if (ph !== 'none' && !attackOpen[c.id]) attackOpen[c.id] = { car: c.id, target: c.ai.attackTarget, t0: world.time, t1: -1, ivStart: c.timing.interval, ivEnd: 0, lap: c.timing.lapsCompleted, ph: {} };
    const cur = attackOpen[c.id];
    if (cur) cur.ph[ph] = (cur.ph[ph] ?? 0) + SIM_DT;
  }
  for (const c of cars) {
    const ph = c.pit.phase;
    if (prevPhase[c.id] !== 'none' && ph === 'none') lastPitExit[c.id] = world.time;
    prevPhase[c.id] = ph;
    // lap record
    const acc = lapAcc[c.id];
    if (c.timing.lapsCompleted !== acc.lap) {
      crossT[c.id].push(world.time);
      if (acc.t > 30 && c.timing.lastLap && !acc.pit && !acc.flag && acc.lap >= 1) {
        lapRecs.push({ car: c.id, lap: acc.lap + 1, time: c.timing.lastLap, pace: paceStatic[c.id], near: acc.near / acc.t, meanAhead: acc.sumAhead / acc.t });
      }
      acc.lap = c.timing.lapsCompleted; acc.t = 0; acc.near = 0; acc.sumAhead = 0; acc.pit = false; acc.flag = false;
    }
    if (live && c.status === 'running') {
      acc.t += SIM_DT;
      const iv = c.timing.position > 1 && c.timing.interval > 0 ? c.timing.interval : 99;
      acc.sumAhead += Math.min(iv, 12) * SIM_DT; if (iv < 1) acc.near += SIM_DT;
      if (c.pit.phase !== 'none' || c.pit.requested) acc.pit = true;
      if (!green) acc.flag = true;
    }
  }
  // follow stints
  if (live && green) {
    for (const c of cars) {
      const i = c.id;
      const ok = c.status === 'running' && c.pit.phase === 'none' && c.timing.position > 1 && c.timing.lapsCompleted >= 1;
      if (!ok) { close(i, 'pit/other', c.pit.phase !== 'none' || c.pit.requested); continue; }
      const bId = world.race.order[c.timing.position - 2];
      const b = cars[bId];
      const iv = c.timing.interval;
      const s = active[i];
      if (s && s.b !== bId) { close(i, 'reorder'); }
      if (!b || b.pit.phase !== 'none' || b.status !== 'running' || b.timing.lapsCompleted < 1) { close(i, 'pit/other', b ? b.pit.phase !== 'none' : false); continue; }
      let st = active[i];
      if (st) {
        if (iv >= 1.5 || iv <= 0) { grace[i] += SIM_DT; if (grace[i] > 2) close(i, 'dropped'); continue; }
        grace[i] = 0;
        st.tot += SIM_DT;
        if (iv < 1.0) {
          const sg = seg[st.deltaNow > 0.003 ? 'fast' : 'even'];
          const bin = Math.min(segBins - 1, Math.floor(c.phys.s / SEG));
          sg.t[bin] += SIM_DT; sg.close[bin] += (c.phys.speed - b.phys.speed) * SIM_DT;
          if (c.ai.dbgLimited) sg.lim[bin] += SIM_DT;
          st.t1 += SIM_DT; if (c.phys.drs.open) st.drs += SIM_DT;
          st.atk[c.ai.mode === 'attack' ? c.ai.attackPhase : c.ai.mode] = (st.atk[c.ai.mode === 'attack' ? c.ai.attackPhase : c.ai.mode] ?? 0) + SIM_DT;
          if (c.ai.paceMode === 'conserve') st.conserve += SIM_DT;
          if (c.ai.inTrain) st.train += SIM_DT;
          if (c.ai.dbgGate) { st.gate = st.gate ?? {}; st.gate[c.ai.dbgGate] = (st.gate[c.ai.dbgGate] ?? 0) + SIM_DT; }
          if (c.ai.dbgLimited) st.lim = (st.lim ?? 0) + SIM_DT;
        }
      } else if (iv > 0 && iv < 1.0) {
        const eA = traffic.estimatedPace(c, wetness), eB = traffic.estimatedPace(b, wetness);
        active[i] = { a: i, b: bId, start: world.time, t1: 0, tot: 0, drs: 0, atk: {}, conserve: 0, train: 0, deltaStatic: (paceStatic[bId] - paceStatic[i]) / paceStatic[bId], deltaNow: eB > 0 && eA > 0 ? (eB - eA) / eB : 0, reason: '', lapA: c.timing.lapsCompleted, pitSoon: false };
      }
    }
  }
}
for (let i = 0; i < n; i++) close(i, 'end');
const final = [...world.race.order];
const out = {
  root, layoutId, laps, seed, mode, difficulty, over: isSessionOver(world), simTime: world.time, wall: (Date.now() - t0) / 1000,
  ref: track.referenceLapTime, length: track.length,
  drivers: world.cars.map((c: any) => c.driverId), team: world.cars.map((c: any) => c.teamId), gridPos: world.cars.map((c: any) => c.timing.gridPosition),
  paceStatic, backFive, backScore, final, snaps, crossT, seg, corners: track.corners.map((c: any) => [c.startS, c.apexS, c.endS]), events, stints, lapRecs, collisions, heavy,
  retired: world.cars.filter((c: any) => c.status === 'retired').map((c: any) => c.driverId),
  stops: world.cars.map((c: any) => c.pit.stops),
  tricks: world.cars.map((c: any) => ({ f: c.ai.feints, fp: c.ai.feintPasses, s: c.ai.switchbacks, sp: c.ai.switchbackPasses })),
  bestLap: world.cars.map((c: any) => c.timing.bestLap),
  attacks: attackEps,
  seat: seat ? { id: seat.id, driver: SEAT_DRIVER, role: seatRole, mistakes: mistakesOn, slot: SEAT_SLOT, cal: seatCal, pace: paceStatic[seat.id], mistakeRecs, contactRecs, retired: seat.status === 'retired', finalPos: final.indexOf(seat.id) + 1 } : null,
};
await Bun.write(outPath, JSON.stringify(out));
console.log(`${layoutId} s${seed} ${mode} d${difficulty} laps${laps} over=${out.over} sim=${out.simTime.toFixed(0)}s wall=${out.wall.toFixed(1)}s overtakes=${events.length} collisions=${collisions} heavy=${heavy} stints=${stints.length} backScore=${backScore}`);
