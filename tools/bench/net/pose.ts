// Pose probe: where the guest draws the other cars against where the host has them at the frame's time, in the moments
// the smoothness probe (probe.ts) does not score: a spin, grades, a wall hit, a link outage, the safety car.
// Host and one guest on the target link (LoopbackNetwork, manual clock), frames at 60 fps. Read-only; BENCH_ROOT as in
// probe.ts. Usage: bun run tools/bench/net/pose.ts [spin|height|wall|outage|sc|all]
const ROOT = (process.env.BENCH_ROOT ?? new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')) + '/src';
const { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } = await import(`${ROOT}/core/defaults`);
const { DRIVERS, TEAMS } = await import(`${ROOT}/data/teams`);
const { getLayout } = await import(`${ROOT}/data/tracks/index`);
const { computeAIInput } = await import(`${ROOT}/ai/index`);
const R = await import(`${ROOT}/race/index`);
const { HostSession } = await import(`${ROOT}/net/host`);
const { ClientSession } = await import(`${ROOT}/net/client`);
const { LoopbackNetwork } = await import(`${ROOT}/net/loopback`);
const M = await import(`${ROOT}/core/math`);
const T = await import(`${ROOT}/track/track`);

export const TARGET = { delayMs: 50, jitterMs: 30, loss: 0.03, retransmitMs: 260 };
const RACERS = DRIVERS.filter((d: any) => d.teamId !== '');

interface Pose { x: number; y: number; z: number; yaw: number; speed: number; yawRate: number }
interface Frame { step: number; hostTime: number; time: number; cars: Map<number, any>; sc: any | null }

function config(o: { layout?: string; weather?: string; safetyCar?: string }): any {
  const ids = RACERS.slice(0, 12);
  const seats = [0, 1];
  return {
    mode: 'splitScreen', kind: 'race', layoutId: o.layout ?? 'monza', laps: 50, timeLimit: null, qualifyingLaps: 0,
    weather: o.weather ?? 'clear', dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 80,
    players: seats.map((pi) => ({ playerIndex: pi, driverId: ids[pi].id, teamId: ids[pi].teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS, pitAssist: true } })),
    grid: ids.map((d: any, i: number) => ({ driverId: d.id, teamId: d.teamId, playerIndex: seats.includes(i) ? i : -1, startCompound: 'medium' })),
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: o.safetyCar ?? 'off' }, seed: 21, ghost: null, objective: null,
  };
}

/** A host and one guest on the target link; the host's every step kept to look its cars up at any time. */
function session(o: { layout?: string; weather?: string; safetyCar?: string; netSeed: number }) {
  const cfg = config(o);
  const track = getLayout(cfg.layoutId);
  const net = new LoopbackNetwork({ ...TARGET, seed: o.netSeed });
  const [h, c] = net.pair();
  const world = R.createWorld(cfg, track);
  const host = new HostSession(world, track, 1, [{ playerIndex: 1, name: 'Ann', transport: h }], { now: () => net.now });
  const guest = new ClientSession(cfg, track, 1, 1, c);
  const hist: { t: number; cars: Pose[]; sc: Pose | null }[] = [];
  let steps = 0;
  const pose = (c: any, yawRate: number): Pose => ({ x: c.x, y: c.y, z: c.z, yaw: c.yaw, speed: c.speed, yawRate });
  return {
    track, world, guest, net,
    get steps() { return steps; },
    /** one 120 Hz step of host and guest (`before` runs on the host's world first) */
    step(before?: (w: any) => void): void {
      before?.(world);
      const inputs: any[] = [null, null, null, null];
      inputs[0] = computeAIInput(world, world.cars[R.getPlayerCarId(world, 0)]!, track, SIM_DT);
      host.fillInputs(inputs);
      R.stepWorld(world, track, inputs, SIM_DT);
      world.events.length = 0;
      host.afterStep();
      const f = R.buildRenderFrame(world, track);
      hist.push({ t: world.time, cars: f.cars.map((c: any) => pose(c, world.cars[c.carId].phys.yawRate)), sc: f.safetyCar ? pose(f.safetyCar, 0) : null });
      guest.step(computeAIInput(guest.world, guest.car!, track, SIM_DT));
      guest.takeEvents();
      net.advance(SIM_DT * 1000);
      steps++;
    },
    /** the guest's frame at 60 fps */
    frame(): Frame {
      const fr = guest.renderFrame(2 * SIM_DT);
      return { step: steps, hostTime: world.time, time: fr.time, cars: new Map(fr.cars.map((c: any) => [c.carId, c])), sc: fr.safetyCar };
    },
    /** car `id` (-1: the safety car) as the host had it at host time `t` */
    truth(t: number, id: number): Pose | null {
      let lo = 0;
      let hi = hist.length - 1;
      if (hi < 1 || t < hist[0]!.t || t > hist[hi]!.t) return null;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (hist[m]!.t <= t) lo = m;
        else hi = m;
      }
      const a = id < 0 ? hist[lo]!.sc : hist[lo]!.cars[id];
      const b = id < 0 ? hist[hi]!.sc : hist[hi]!.cars[id];
      if (!a || !b) return null;
      const f = (t - hist[lo]!.t) / (hist[hi]!.t - hist[lo]!.t);
      const l = (p: number, q: number) => p + (q - p) * f;
      return { x: l(a.x, b.x), y: l(a.y, b.y), z: l(a.z, b.z), yaw: a.yaw + M.angleDiff(a.yaw, b.yaw) * f, speed: l(a.speed, b.speed), yawRate: l(a.yawRate, b.yawRate) };
    },
  };
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const pct = (xs: number[], p: number) => (xs.length ? sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : NaN);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : NaN);
const yawErr = (a: number, b: number) => Math.abs(M.angleDiff(a, b));
/** How far a frame's step is off the car's drawn speed × the frame's host time step (smooth motion: millimetres). */
const jumpOf = (c: any, p: any, dt: number) => Math.abs(Math.hypot(c.x - p.x, c.z - p.z) - ((c.speed + p.speed) / 2) * dt);

/**
 * A random crash (race/control.ts startSpin, replicated) on the first AI car over 40 m/s at `at` s. The spun car's
 * drawn yaw against the host's while it spins (host yaw rate over 1 rad/s), while it is slow and barely turning (under
 * 3 m/s and 0.2 rad/s), and its drawn place, for 6 s.
 */
export function spin(netSeed = 9, at = 20) {
  const s = session({ netSeed });
  let target = -1;
  const frames: Frame[] = [];
  while (s.world.time < at + 8) {
    s.step((w) => {
      if (target >= 0 || w.time < at) return;
      const c = w.cars.find((c: any) => c.playerIndex === -1 && c.status === 'running' && c.pit.phase === 'none' && c.phys.speed > 40);
      if (!c) return;
      target = c.id;
      const p = c.phys;
      const toward = p.lateral >= 0 ? 1 : -1;
      p.yaw = M.wrapAngle(p.yaw + 0.55);
      p.yawRate = 2.4;
      const v = Math.hypot(p.vx, p.vz);
      const rx = M.rightX(p.yaw);
      const rz = M.rightZ(p.yaw);
      p.vx = p.vx * Math.cos(0.22) + rx * v * Math.sin(0.22) * toward;
      p.vz = p.vz * Math.cos(0.22) + rz * v * Math.sin(0.22) * toward;
      c.ai.crashTimer = 5;
    });
    if (s.steps % 2 === 0 && s.world.time >= 12) frames.push(s.frame());
  }
  const spinning: number[] = [], slow: number[] = [], all: number[] = [], place: number[] = [], others: number[] = [];
  for (const fr of frames) {
    for (const [id, c] of fr.cars) {
      if (id === s.guest.carId || !c.visible) continue;
      const h = s.truth(fr.time, id);
      if (!h) continue;
      const e = yawErr(c.yaw, h.yaw);
      if (id !== target) others.push(e);
      else if (fr.hostTime >= at && fr.hostTime < at + 6) {
        all.push(e);
        place.push(Math.hypot(c.x - h.x, c.z - h.z));
        if (Math.abs(h.yawRate) > 1) spinning.push(e);
        if (h.speed < 3 && Math.abs(h.yawRate) < 0.2) slow.push(e);
      }
    }
  }
  return {
    yawMean: mean(all), spinYawMean: mean(spinning), spinYawMax: max(spinning), slowYawMax: max(slow), slowFrames: slow.length,
    placeMean: mean(place), placeMax: max(place), othersYawP99: pct(others, 0.99),
  };
}

/** Every other car's drawn height against the host's, from 12 s to `secs`. */
export function height(layout = 'spa', netSeed = 9, secs = 70, weather = 'clear') {
  const s = session({ layout, weather, netSeed });
  const frames: Frame[] = [];
  while (s.world.time < secs) {
    s.step();
    if (s.steps % 2 === 0 && s.world.time >= 12) frames.push(s.frame());
  }
  const dy: number[] = [];
  for (const fr of frames) {
    for (const [id, c] of fr.cars) {
      if (id === s.guest.carId || !c.visible) continue;
      const h = s.truth(fr.time, id);
      if (h) dy.push(Math.abs(c.y - h.y));
    }
  }
  return { dyMean: mean(dy), dyP99: pct(dy, 0.99), dyMax: max(dy), over20cm: dy.filter((x) => x > 0.2).length };
}

/** How far (m) a car body at this pose reaches past the barrier (race/contact.ts barrierContact; ≤ 0: inside). */
function intoBarrier(track: any, spec: any, x: number, z: number, yaw: number): number {
  const proj = T.projectToTrack(track, x, z);
  const lim = T.barrierLimits(track, proj.s, proj.lateral);
  const wall = proj.lateral >= 0 ? lim.max : -lim.min;
  const rel = M.angleDiff(proj.heading, yaw);
  return Math.abs(proj.lateral) + Math.abs(Math.sin(rel)) * spec.length * 0.5 + Math.abs(Math.cos(rel)) * spec.width * 0.5 - wall;
}

/**
 * An AI car over 60 m/s turned `angle` rad toward the nearer barrier at `at` s, heading and velocity both. For 2 s:
 * frames the guest draws its body past the barrier (by over 5 cm) and the host's own count, frames drawn more than
 * 1 m further off the road than the host has it, each frame's jump, and the drawn place's error.
 */
export function wall(netSeed = 9, at = 20, angle = 1.2) {
  const s = session({ netSeed });
  let target = -1;
  let hitAt = 0;
  let prev: any = null;
  let prevTime = 0;
  const frames: Frame[] = [];
  const jumps: number[] = [];
  while (s.world.time < at + 4) {
    s.step((w) => {
      if (target >= 0 || w.time < at) return;
      const c = w.cars.find((c: any) => c.playerIndex === -1 && c.status === 'running' && c.pit.phase === 'none' && c.phys.speed > 60);
      if (!c) return;
      target = c.id;
      hitAt = w.time;
      const p = c.phys;
      p.yaw = M.wrapAngle(p.yaw - (p.lateral >= 0 ? 1 : -1) * angle);
      p.vx = M.forwardX(p.yaw) * p.speed;
      p.vz = M.forwardZ(p.yaw) * p.speed;
      p.yawRate = 0;
    });
    if (s.steps % 2 !== 0 || target < 0) continue;
    const fr = s.frame();
    const c = fr.cars.get(target);
    if (prev) jumps.push(jumpOf(c, prev, fr.time - prevTime));
    prev = c;
    prevTime = fr.time;
    frames.push(fr);
  }
  const spec = s.world.cars[target].spec;
  const place: number[] = [];
  let past = 0, hostPast = 0, offRoad = 0;
  for (const fr of frames) {
    const c = fr.cars.get(target);
    const h = s.truth(fr.time, target);
    if (!h || fr.hostTime > hitAt + 2) continue;
    place.push(Math.hypot(c.x - h.x, c.z - h.z));
    if (intoBarrier(s.track, spec, c.x, c.z, c.yaw) > 0.05) past++;
    if (intoBarrier(s.track, spec, h.x, h.z, h.yaw) > 0.05) hostPast++;
    if (Math.abs(T.projectToTrack(s.track, c.x, c.z).lateral) - Math.abs(T.projectToTrack(s.track, h.x, h.z).lateral) > 1) offRoad++;
  }
  return { pastBarrier: past, hostPastBarrier: hostPast, offRoad, jumpMax: max(jumps), jumpsOver50cm: jumps.filter((j) => j > 0.5).length, placeMean: mean(place), placeMax: max(place) };
}

/**
 * The link stalls for `ms` at 20 s (everything sent meanwhile held, then let through). For 3 s after it, each other
 * car's frame jumps: frames over 0.5 m, cars put back at once (one frame over 0.5 m), cars that slid back (more than
 * one), and the largest jump under 10 m.
 */
export function outage(ms = 1900, netSeed = 9) {
  const s = session({ netSeed });
  let stalled = false;
  let prevTime = 0;
  const prev = new Map<number, any>();
  const over = new Map<number, number[]>();
  const all: number[] = [];
  while (s.world.time < 20 + ms / 1000 + 3) {
    s.step(() => {
      if (!stalled && s.world.time >= 20) {
        stalled = true;
        s.net.stall(ms);
      }
    });
    if (s.steps % 2 !== 0) continue;
    const fr = s.frame();
    for (const [id, c] of fr.cars) {
      const p = prev.get(id);
      prev.set(id, c);
      if (!p || id === s.guest.carId || !c.visible || s.world.time < 20 + ms / 1000) continue;
      const j = jumpOf(c, p, fr.time - prevTime);
      all.push(j);
      if (j > 0.5) over.set(id, [...(over.get(id) ?? []), j]);
    }
    prevTime = fr.time;
  }
  const put = [...over.values()].filter((js) => js.length === 1).length;
  const slid = [...over.values()].filter((js) => js.length > 1).length;
  return { over50cm: all.filter((j) => j > 0.5).length, carsPut: put, carsSlid: slid, slideMax: max(all.filter((j) => j < 10)) };
}

/** A safety car called at 15 s: once it is out, its drawn place and per-frame jump against the host's for 30 s. */
export function sc(netSeed = 9) {
  const s = session({ netSeed, safetyCar: 'standard' });
  let called = false;
  let out = Infinity;
  let prev: any = null;
  let prevTime = 0;
  const frames: Frame[] = [];
  const jumps: number[] = [];
  while (s.world.time < Math.min(out + 30, 240)) {
    s.step((w) => {
      if (!called && w.time >= 15) called = R.forceIncident(w, s.track, 'sc');
    });
    if (s.steps % 2 !== 0 || !called) continue;
    const fr = s.frame();
    if (!fr.sc) {
      prev = null;
      continue;
    }
    out = Math.min(out, s.world.time);
    if (prev) jumps.push(jumpOf(fr.sc, prev, fr.time - prevTime));
    prev = fr.sc;
    prevTime = fr.time;
    frames.push(fr);
  }
  const place: number[] = [];
  for (const fr of frames) {
    const h = s.truth(fr.time, -1);
    if (h) place.push(Math.hypot(fr.sc.x - h.x, fr.sc.z - h.z));
  }
  return { frames: place.length, placeMean: mean(place), placeP99: pct(place, 0.99), placeMax: max(place), jumpP99: pct(jumps, 0.99), jumpMax: max(jumps) };
}

const RUNS: Record<string, [string, () => object][]> = {
  spin: ([[9, 20], [9, 26], [9, 31], [9, 37], [9, 44], [11, 26]] as const).map(([seed, at]) => [`spin ${seed} ${at}`, () => spin(seed, at)] as [string, () => object]),
  height: [
    ['height spa 9 70', () => height('spa', 9, 70)],
    ['height monza 9 50', () => height('monza', 9, 50)],
    ['height suzuka 9 70', () => height('suzuka', 9, 70)],
    ['height spa heavyRain 10 70', () => height('spa', 10, 70, 'heavyRain')],
  ],
  wall: [['wall 9 20 1.2', () => wall(9, 20, 1.2)]],
  outage: [1000, 1600, 1900].map((ms) => [`outage ${ms} ms`, () => outage(ms, 9)] as [string, () => object]),
  sc: [['sc 9', () => sc(9)], ['sc 10', () => sc(10)]],
};

if (import.meta.main) {
  const which = process.argv[2] ?? 'all';
  const fmt = (v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v));
  console.log(`root=${ROOT}`);
  for (const k of which === 'all' ? Object.keys(RUNS) : which.split(',')) {
    for (const [label, run] of RUNS[k] ?? []) {
      console.log(`${label.padEnd(28)} ${Object.entries(run()).map(([n, v]) => `${n}=${fmt(v)}`).join(' ')}`);
    }
  }
}
