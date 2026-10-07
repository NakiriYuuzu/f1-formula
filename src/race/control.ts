/**
 * Race control (races only). Incidents — random AI crashes / mechanical failures / debris drawn from an incident budget
 * set by rules.safetyCar, plus any car stopped on track (a long stop on the racing surface becomes a VSC) and a human car
 * hitting a barrier / another car hard (debris by severity if it drives on, else judged as an AI crash; with full damage
 * a wreck brings out the red flag and is repaired, or retires when another car was involved) — raise local
 * yellow flags and, by severity, a virtual safety car (per-car delta), the safety car (a kinematic vehicle out of the pit
 * lane that waves the cars before the leader past, picks the leader up and leads the queue, passing slower cars / hazards;
 * the leader may not pass it; "in this lap" with most of a lap's notice, restart at the line) or a red flag (regroup on
 * the grid, standing restart). Also drives the formation lap (queue, auto-parking, then lights),
 * blue flags and illegal-overtake give-backs, and publishes car.flags for the HUD.
 */
import type {
  BuiltTrack,
  CarEntry,
  CarFlag,
  CarFlagState,
  RaceControlMode,
  RaceControlState,
  SafetyCarSetting,
  WorldState,
} from '../core/types';
import { clamp, damp, moveToward, nextRandom, randRange, rightX, rightZ, smoothstep, wrapAngle } from '../core/math';
import { isCarHeld } from '../physics/index';
import { forwardDistance, pitLaneOffsetAt, poseAt, sampleAt, signedDeltaS, wrapS } from '../track/track';
import { emit, isHuman } from './events';
import { parkOnSlot, regroupOnGrid, startParking, wantsToPark } from './gridPark';
import { GIVE_BACK_SEC, ILLEGAL_PASS_PENALTY, applyTimePenalty, checkFormationOrder, sectorOf, stepGiveBack } from './legality';
import { SC_MAX_SPEED, SC_SPEED_FACTOR, pacedSpeedAhead, vscRefSpeed } from './neutralPace';
import { radioAll } from './radio';
import { retire } from './session';
import type { Incident, IncidentKind, IncidentResponse } from './types';

/** Expected random incidents per race (any length) per setting; per-lap draw rate cap. */
const INCIDENT_BUDGET: Record<SafetyCarSetting, number> = { off: 0, reduced: 0.6, standard: 1.4, increased: 3 };
const MAX_LAP_RATE = 0.35;
/** Chance that a safety-car-worthy crash is red-flagged instead (rules.redFlags). */
const RED_CHANCE: Record<SafetyCarSetting, number> = { off: 0, reduced: 0, standard: 0.05, increased: 0.15 };
/** Below this speed (m/s) a car counts as stopped; a stop longer than NATURAL_STOP_SEC is an incident. */
const STOP_SPEED = 2;
const NATURAL_STOP_SEC = 4;
/** A stopped (not retired) car that reaches this speed (m/s) has driven away. */
const MOVING_SPEED = 6;
/** Crash: seconds stopped before the outcome is judged; give up waiting after CRASH_TIMEOUT. */
const CRASH_SETTLE_SEC = 1.5;
const CRASH_TIMEOUT = 12;
const FAILURE_TIMEOUT = 30;
/** Spin impulse of a random crash: yaw kick (rad) and yaw rate (rad/s). */
const CRASH_YAW_KICK = 0.55;
const CRASH_YAW_RATE = 2.4;
/** Crash: path veer toward the nearer edge (rad), chance of a damaging impact, seconds the driver brakes. */
const CRASH_VEER = 0.22;
const CRASH_DAMAGE_CHANCE = 0.75;
const CRASH_BRAKE_SEC = 5;
/** Recovery time ranges (s) per response. */
const RECOVER_SEC: Record<IncidentResponse, [number, number]> = { yellow: [20, 30], vsc: [30, 45], sc: [35, 55], red: [0, 0] };
/** Lateral distance (m) beyond the road edge that still counts as on / near the racing surface. */
const SURFACE_MARGIN = 0.5;
const NEAR_MARGIN = 4;
/** Reference speed (m/s) above which a section counts as fast. */
const FAST_SECTION = 55;
/** VSC delta: start value, cap (s), minimum duration and ending warning (s), penalty threshold (s) and size. */
const VSC_START_DELTA = 1.2;
const VSC_MAX_DELTA = 2.5;
const VSC_MIN_SEC = 20;
const VSC_ENDING_SEC = 10;
const VSC_PENALTY_DELTA = -1;
const VSC_PENALTY = 5;
const WARN_COOLDOWN = 3;
/** Safety car: distance (m) driven down the pit lane before it rejoins at pit.exit, wait-for-field gap (m), accel / decel
 * (m/s²), wheel radius. */
const SC_EXIT_RUN = 200;
const SC_WAIT_GAP = 160;
/** Release from the pit lane: the leader is this many seconds (more than the SC needs to the exit) from pit.exit; the
 * safety car goes anyway after waiting this many reference laps. */
const SC_RELEASE_LEAD: [number, number] = [1, 6];
const SC_HOLD_MAX_LAPS = 1.2;
const SC_ACCEL = 5;
const SC_DECEL = 10;
const SC_WHEEL_RADIUS = 0.34;
/** Races with at least this many laps keep the safety car out for two leader laps; shorter ones for a minimum time (s). */
const SC_LONG_RACE_LAPS = 10;
const SC_SHORT_RACE_MIN_SEC = 40;
/** Short races recover incidents faster: recovery times scale with laps / this, clamped to [0.5, 1]. */
const RECOVERY_FULL_LAPS = 15;
/** Safety car pit-in: distance (m) driven down the pit lane before it leaves the scene, lateral blend length (m). */
const SC_PIT_RUN = 260;
const SC_PIT_BLEND = 140;
/** Leader must be within this distance (m) of the SC before it may come in (and to be picked up by it). */
const SC_QUEUE_FORMED = 250;
/** Before it has the leader, a car (not the leader) within this distance (m) behind is waved past: the SC keeps aside. */
const SC_WAVE_RANGE = 120;
/** Margin (m) from the road edge when the SC keeps aside; lateral clearance (m) when passing a slower car / hazard; it
 * follows one that is closer than SC_FOLLOW_GAP (m) without that room. Slower cars count within SC_AVOID_RANGE (m). */
const SC_ASIDE_MARGIN = 2.2;
const SC_AVOID_CLEAR = 3.2;
const SC_FOLLOW_GAP = 25;
const SC_AVOID_RANGE = 80;
/** "In this lap" is only announced with at least this fraction of a lap left before the pit entry. */
const SC_IN_NOTICE = 0.4;
/** A leader that does not close up (or passed the SC) delays the restart by at most this many reference laps. */
const SC_FORM_GRACE_LAPS = 1;
/** The race leader this far (m) ahead of the SC counts as having passed it. */
const SC_PASSED_MARGIN = 5;
/** A car stopped on the racing surface this long (s) turns its yellow flag into a virtual safety car. */
const STRANDED_SEC = 12;
/** Human crash: contact impulse (N·s) that starts an incident (racing contact stays well below), impulse of the most
 * severe hit, seconds after which a car that has not come to rest counts as having driven on. */
export const HEAVY_IMPACT = 8000;
const SEVERE_IMPACT = 30_000;
const IMPACT_JUDGE_SEC = 6;
/** Human wreck (rules.damage 'full'): front-wing damage of a car that came to rest; contact with another car this many
 * seconds before the hit makes it a crash with another car involved (no red flag, the car retires). */
const WRECK_DAMAGE = 0.9;
const CONTACT_LOOKBACK_SEC = 3;
/** Red flag: seconds of slow running before the field is regrouped on the grid; lights delay after the regroup. */
const RED_REGROUP_SEC = 8;
const RED_LIGHTS_DELAY = 4;
/** Seconds the green flag stays shown after a neutralisation / sector clear. */
const GREEN_SHOW_SEC = 3;
/** Blue flag: lapping car within this distance (m) behind; cleared after BLUE_CLEAR_SEC without it. */
const BLUE_RANGE = 70;
const BLUE_CLEAR_SEC = 2;
/** Formation lap: an idle / dropped-back human is driven by the autopilot; safety timeout in reference laps. */
const FORMATION_IDLE_SEC = 8;
const FORMATION_TAKEOVER_GAP = 400;
const FORMATION_TIMEOUT_LAPS = 4;

export function createControlState(): RaceControlState {
  return {
    mode: 'green',
    since: 0,
    sectorFlags: [0, 0, 0],
    reason: '',
    drsLockUntilLap: 0,
    counts: { sc: 0, vsc: 0, red: 0 },
    safetyCar: { onTrack: false, lightsOn: false, s: 0, lateral: 0, x: 0, y: 0, z: 0, yaw: 0, speed: 0, wheelSpin: 0 },
  };
}

export function createCarFlags(): CarFlagState {
  return { shown: 'none', delta: null, giveBack: null, queuing: false };
}

const settingOf = (world: WorldState): SafetyCarSetting => world.config.rules.safetyCar ?? 'off';

const raceLengthScale = (world: WorldState): number => clamp(world.session.totalLaps / RECOVERY_FULL_LAPS, 0.5, 1);

function setMode(world: WorldState, mode: RaceControlMode, reason: string): void {
  const c = world.session.control;
  if (c.mode === mode) return;
  const previous = c.mode;
  c.mode = mode;
  c.since = world.time;
  c.reason = reason;
  if (mode === 'green') world.race.greenAt = world.time;
  emit(world, { type: 'raceControl', mode, previous, reason });
}

/** First car still racing in classification order. */
function raceLeader(world: WorldState): CarEntry | null {
  for (const id of world.race.order) {
    const car = world.cars[id];
    if (car && (car.status === 'running' || car.status === 'pitting')) return car;
  }
  return null;
}

/** '第 7 彎' when s is in / near a corner, else '第 2 計時段'. */
function placeLabel(track: BuiltTrack, s: number): string {
  for (const k of track.corners) {
    if (signedDeltaS(track, k.startS - 60, s) >= 0 && signedDeltaS(track, s, k.endS + 60) >= 0) return `第 ${k.number} 彎`;
  }
  return `第 ${sectorOf(track, s) + 1} 計時段`;
}

function incidentText(track: BuiltTrack, inc: Incident): string {
  const where = placeLabel(track, inc.s);
  switch (inc.kind) {
    case 'crash':
      return `${where}有車輛撞車`;
    case 'failure':
      return `${where}有車輛故障停車`;
    case 'debris':
      return `${where}賽道上有碎片`;
    default:
      return inc.onSurface ? `${where}有車輛停在賽道上` : `${where}賽道邊有車輛停下`;
  }
}

function onSurface(track: BuiltTrack, s: number, lateral: number): boolean {
  return Math.abs(lateral) < sampleAt(track, track.halfWidth, s) + SURFACE_MARGIN;
}

function createIncident(
  world: WorldState,
  track: BuiltTrack,
  kind: IncidentKind,
  car: CarEntry | null,
  s: number,
  lateral: number,
  forced: IncidentResponse | null,
): Incident {
  const r = world.race;
  r.incidentSeq += 1;
  const inc: Incident = {
    id: r.incidentSeq,
    kind,
    carId: car ? car.id : -1,
    s: wrapS(track, s),
    lateral,
    onSurface: onSurface(track, s, lateral),
    flagS: wrapS(track, s),
    response: null,
    forced,
    startedAt: world.time,
    recoverAt: null,
    resolved: false,
    impact: 0,
    otherCar: false,
  };
  r.incidents.push(inc);
  emit(world, { type: 'incident', carId: inc.carId, reason: incidentText(track, inc) });
  return inc;
}

const hasIncident = (world: WorldState, carId: number): boolean =>
  world.race.incidents.some((i) => !i.resolved && i.carId === carId);

const isWreck = (world: WorldState, car: CarEntry): boolean =>
  world.config.rules.damage === 'full' && car.phys.damage.frontWing >= WRECK_DAMAGE;

const redFlagPossible = (world: WorldState): boolean =>
  world.config.rules.redFlags === true && world.session.leaderLap < world.session.totalLaps;

/** Retire a car where it stopped and keep it visible as a hazard until the marshals recover it. */
function retireAsHazard(world: WorldState, car: CarEntry, reason: string): void {
  car.ai.failing = false;
  car.ai.crashTimer = 0;
  retire(world, car, reason);
  car.race.hazard = true;
}

// ───────────────────────────── responses ─────────────────────────────

function deployVsc(world: WorldState, reason: string): void {
  setMode(world, 'vsc', reason);
  world.session.control.counts.vsc += 1;
  for (const car of world.cars) {
    car.flags.delta = car.status === 'running' || car.status === 'pitting' ? VSC_START_DELTA : null;
    car.race.vscPenalised = false;
    car.race.ctlS = car.phys.s;
  }
  radioAll(world, '虛擬安全車，注意差值，不得超車。');
}

function placeSafetyCar(world: WorldState, track: BuiltTrack, s: number, lateral: number): void {
  const sc = world.session.control.safetyCar;
  sc.s = wrapS(track, s);
  sc.lateral = lateral;
  const pose = poseAt(track, sc.s, sc.lateral);
  sc.x = pose.x;
  sc.y = pose.y;
  sc.z = pose.z;
  sc.yaw = pose.yaw;
}

function deploySafetyCar(world: WorldState, track: BuiltTrack, reason: string): void {
  const c = world.session.control;
  const sc = c.safetyCar;
  const r = world.race;
  const leader = raceLeader(world);
  setMode(world, 'sc', reason);
  c.counts.sc += 1;
  sc.lightsOn = true;
  // it waits in the pit lane (one that came in a moment ago finishes its run there first) and is released in front of the
  // leader; cars that still get between them are waved past
  if (!sc.onTrack || r.scPitDist >= 0) r.scHeld = true;
  r.scPickedUp = false;
  r.scDueSince = null;
  r.scDeployLaps = leader ? leader.timing.lapsCompleted : 0;
  r.scGoneLaps = -1;
  for (const car of world.cars) car.flags.delta = null;
  radioAll(world, '安全車出動，保持差距，不得超車。');
}

function deployRedFlag(world: WorldState, reason: string): void {
  const c = world.session.control;
  setMode(world, 'red', reason);
  c.counts.red += 1;
  c.safetyCar.onTrack = false;
  c.safetyCar.lightsOn = false;
  world.race.scPitDist = -1;
  world.race.scHeld = false;
  world.race.scExitDist = -1;
  world.race.scPickedUp = false;
  world.race.redRegroupAt = world.time + RED_REGROUP_SEC;
  world.race.incidentDueAt = null;
  for (const car of world.cars) car.flags.delta = null;
  radioAll(world, '紅旗！比賽中止，回到發車區。');
}

/** Decide (and apply) the response to an incident whose car has come to rest (or that has no car). */
function decideResponse(world: WorldState, track: BuiltTrack, inc: Incident): void {
  const s = world.session;
  const c = s.control;
  const rng = world.rng;
  const car = inc.carId >= 0 ? world.cars[inc.carId] : null;
  const leader = raceLeader(world);
  const lapsLeft = s.totalLaps - (leader ? leader.timing.lapsCompleted : 0);
  let resp: IncidentResponse;
  if (inc.forced) resp = inc.forced;
  else if (car && car.status !== 'retired' && inc.impact === 0) resp = 'yellow';
  else if (!car && inc.impact > 0) {
    // a human car that drove on after a hard hit: the harder the hit, the more debris
    const severity = clamp((inc.impact - HEAVY_IMPACT) / (SEVERE_IMPACT - HEAVY_IMPACT), 0, 1);
    const roll = nextRandom(rng);
    resp = roll < severity * 0.6 ? 'sc' : roll < 0.3 + severity * 0.5 ? 'vsc' : 'yellow';
  } else if (inc.kind === 'debris') resp = nextRandom(rng) < 0.4 ? 'vsc' : 'yellow';
  else {
    const off = Math.abs(inc.lateral) - sampleAt(track, track.halfWidth, inc.s);
    const fast = sampleAt(track, track.speedProfile, inc.s) > FAST_SECTION;
    const roll = nextRandom(rng);
    // a wrecked car at a barrier leaves debris and needs a crane: usually the safety car
    if (inc.kind === 'crash') resp = fast || roll < 0.6 ? 'sc' : 'vsc';
    else if (off < SURFACE_MARGIN) resp = fast || roll < 0.4 ? 'sc' : 'vsc';
    else if (off < NEAR_MARGIN) resp = roll < 0.55 ? 'vsc' : 'sc';
    else resp = roll < 0.35 ? 'vsc' : 'yellow';
    const heavy = inc.kind === 'crash' && car !== null && car.phys.damage.frontWing >= 0.5;
    if (inc.impact > 0) {
      // a human wreck still in the race came from a single-car crash: the red flag (the regroup repairs it)
      if (car && car.status !== 'retired' && isWreck(world, car)) resp = 'red';
    } else if (resp === 'sc' && heavy && world.config.rules.redFlags === true && c.counts.red === 0 && lapsLeft > 3) {
      if (nextRandom(rng) < RED_CHANCE[settingOf(world)]) resp = 'red';
    }
  }
  if (!inc.forced) {
    if (s.leaderLap >= s.totalLaps) resp = 'yellow';
    else if (resp === 'sc' && lapsLeft < 2) resp = 'vsc';
  }
  inc.response = resp;
  inc.flagS = inc.s;
  // the debris of a hard hit is cleared by the marshals even when the car drives off
  const alive = car !== null && car.status !== 'retired' && inc.forced === null && inc.impact === 0;
  const range = RECOVER_SEC[resp];
  const scale = raceLengthScale(world);
  inc.recoverAt = alive || resp === 'red' ? null : world.time + randRange(rng, range[0], range[1]) * scale;

  const reason = incidentText(track, inc);
  const mode = c.mode;
  if (resp === 'red') {
    if (mode !== 'red') deployRedFlag(world, reason);
  } else if (resp === 'sc') {
    if (mode === 'green' || mode === 'vsc' || mode === 'vscEnding') deploySafetyCar(world, track, reason);
    else if (mode === 'scEnding') resumeSafetyCar(world, track, reason);
  } else if (resp === 'vsc') {
    if (mode === 'green') deployVsc(world, reason);
    else if (mode === 'vscEnding') setMode(world, 'vsc', reason);
    else if (mode === 'scEnding') resumeSafetyCar(world, track, reason);
  }
}

function resumeSafetyCar(world: WorldState, track: BuiltTrack, reason: string): void {
  const sc = world.session.control.safetyCar;
  if (!sc.onTrack || world.race.scPitDist >= 0) {
    // already gone or heading down the pit lane: out again at the pit exit
    deploySafetyCar(world, track, reason);
    return;
  }
  sc.lightsOn = true;
  setMode(world, 'sc', reason);
}

// ───────────────────────────── incidents ─────────────────────────────

function pickIncidentCar(world: WorldState, middle: boolean): CarEntry | null {
  const candidates = world.race.order
    .map((id) => world.cars[id])
    .filter(
      (c): c is CarEntry =>
        !!c &&
        c.playerIndex === -1 &&
        c.status === 'running' &&
        c.pit.phase === 'none' &&
        !isCarHeld(c.phys) &&
        c.phys.speed > 25 &&
        !c.ai.failing &&
        c.timing.lap >= 1,
    );
  if (candidates.length === 0) return null;
  const i = middle ? Math.floor(candidates.length / 2) : Math.floor(nextRandom(world.rng) * candidates.length);
  return candidates[Math.min(candidates.length - 1, i)] ?? null;
}

/**
 * Random crash: the car snaps sideways, its path veers toward the nearer edge and the driver stands on the brakes.
 * Most of the time it hits something (front-wing damage → retirement); sometimes it only spins and rejoins.
 */
function startSpin(world: WorldState, car: CarEntry): void {
  const p = car.phys;
  const rng = world.rng;
  const spin = nextRandom(rng) < 0.5 ? -1 : 1;
  const toward = p.lateral >= 0 ? 1 : -1;
  p.yaw = wrapAngle(p.yaw + spin * CRASH_YAW_KICK);
  p.yawRate = spin * CRASH_YAW_RATE;
  const v = Math.hypot(p.vx, p.vz);
  const rx = rightX(p.yaw);
  const rz = rightZ(p.yaw);
  p.vx = p.vx * Math.cos(CRASH_VEER) + rx * v * Math.sin(CRASH_VEER) * toward;
  p.vz = p.vz * Math.cos(CRASH_VEER) + rz * v * Math.sin(CRASH_VEER) * toward;
  if (nextRandom(rng) < CRASH_DAMAGE_CHANCE) p.damage.frontWing = Math.max(p.damage.frontWing, randRange(rng, 0.5, 0.95));
  car.ai.crashTimer = CRASH_BRAKE_SEC;
}

function startFailure(car: CarEntry): void {
  car.ai.failing = true;
  car.ai.failSide = car.phys.lateral >= 0 ? 1 : -1;
}

/** Create an incident (random draw or forced) — returns false when nothing suitable could be created. */
function triggerIncident(world: WorldState, track: BuiltTrack, forced: IncidentResponse | null): boolean {
  const roll = nextRandom(world.rng);
  let kind: IncidentKind = forced === 'red' ? 'crash' : forced ? 'failure' : roll < 0.45 ? 'crash' : roll < 0.85 ? 'failure' : 'debris';
  const car = kind === 'debris' ? null : pickIncidentCar(world, forced !== null);
  if (!car) kind = 'debris';
  if (kind === 'debris' || !car) {
    const human = world.cars.find((c) => isHuman(c) && c.status === 'running');
    const base = human ? human.phys.s + 500 : nextRandom(world.rng) * track.length;
    const s = wrapS(track, base);
    const inc = createIncident(world, track, 'debris', null, s, sampleAt(track, track.racingLine, s) * 0.5, forced);
    decideResponse(world, track, inc);
    return true;
  }
  if (kind === 'crash') startSpin(world, car);
  else startFailure(car);
  const inc = createIncident(world, track, kind, car, car.phys.s, car.phys.lateral, forced);
  if (forced) decideResponse(world, track, inc);
  return true;
}

function scheduleRandomIncident(world: WorldState, track: BuiltTrack): void {
  const r = world.race;
  const s = world.session;
  const budget = INCIDENT_BUDGET[settingOf(world)];
  if (!(budget > 0)) return;
  if (s.leaderLap > r.incidentDrawLap) {
    r.incidentDrawLap = s.leaderLap;
    if (s.leaderLap < s.totalLaps) {
      const p = Math.min(MAX_LAP_RATE, budget / Math.max(1, s.totalLaps - 1));
      if (nextRandom(world.rng) < p) {
        r.incidentDueAt = world.time + randRange(world.rng, 6, Math.max(8, track.referenceLapTime * 0.8));
      }
    }
  }
  if (r.incidentDueAt !== null && world.time >= r.incidentDueAt) {
    r.incidentDueAt = null;
    const quiet = s.control.mode === 'green' && r.incidents.every((i) => i.resolved);
    if (quiet && s.leaderLap < s.totalLaps) triggerIncident(world, track, null);
  }
}

/** Seconds each racing car has been (nearly) stationary on track. */
function updateStopTimes(world: WorldState, dt: number): void {
  for (const car of world.cars) {
    const r = car.race;
    const watch = car.status === 'running' && car.pit.phase === 'none' && !isCarHeld(car.phys) && !r.parking;
    r.stopTime = watch && car.phys.speed < STOP_SPEED ? r.stopTime + dt : 0;
  }
}

/** Any car (human or AI) stopped on / beside the track for a few seconds while racing. */
function detectStoppedCars(world: WorldState, track: BuiltTrack): void {
  for (const car of world.cars) {
    const r = car.race;
    const p = car.phys;
    if (r.stopTime < NATURAL_STOP_SEC || hasIncident(world, car.id)) continue;
    const inc = createIncident(world, track, 'stopped', car, p.s, p.lateral, null);
    decideResponse(world, track, inc);
  }
}

/** A human car that hit a barrier / another car hard while racing (AI crashes come from the incident budget). */
function detectHeavyImpacts(world: WorldState, track: BuiltTrack): void {
  for (const car of world.cars) {
    const peak = car.race.impactPeak;
    if (!isHuman(car) || car.status !== 'running' || car.pit.phase !== 'none' || peak < HEAVY_IMPACT) continue;
    const open = world.race.incidents.find((i) => !i.resolved && i.carId === car.id);
    if (open) {
      // a second hit before the outcome is judged makes it worse
      if (open.response === null && open.impact > 0) open.impact = Math.max(open.impact, peak);
      continue;
    }
    const inc = createIncident(world, track, 'crash', car, car.phys.s, car.phys.lateral, null);
    inc.impact = peak;
    const contact = car.race.carContactAt;
    inc.otherCar = contact !== null && contact >= world.time - CONTACT_LOOKBACK_SEC;
  }
}

function progressIncident(world: WorldState, track: BuiltTrack, inc: Incident): void {
  const car = inc.carId >= 0 ? (world.cars[inc.carId] ?? null) : null;
  const now = world.time;
  if (car && car.status !== 'retired' && (inc.response === null || inc.impact === 0)) {
    // the hazard moves with the car until it comes to rest (the debris of a hard hit stays once judged)
    inc.s = car.phys.s;
    inc.lateral = car.phys.lateral;
    inc.onSurface = onSurface(track, inc.s, inc.lateral);
  }
  if (inc.response === null) {
    if (!car) {
      decideResponse(world, track, inc);
      return;
    }
    const age = now - inc.startedAt;
    const stopped = car.phys.speed < STOP_SPEED && car.race.stopTime >= CRASH_SETTLE_SEC;
    if (inc.kind === 'failure') {
      if (car.status === 'retired' || stopped || age > FAILURE_TIMEOUT) {
        if (car.status !== 'retired') retireAsHazard(world, car, '機械故障退賽');
        decideResponse(world, track, inc);
      }
    } else if (inc.kind === 'crash') {
      if (stopped) {
        if (inc.impact > 0) {
          // a human wreck retires unless a red flag (single-car crash) lets the team repair it; else it keeps the car
          if (isWreck(world, car) && (inc.otherCar || !redFlagPossible(world))) retireAsHazard(world, car, '車損過重退賽');
        } else if (car.phys.damage.frontWing > 0.45) retireAsHazard(world, car, '撞車退賽');
        else car.ai.crashTimer = 0;
        decideResponse(world, track, inc);
      } else if (inc.impact > 0 && age > IMPACT_JUDGE_SEC) {
        // drove on: debris on the road where it hit
        inc.carId = -1;
        inc.s = inc.flagS;
        inc.lateral = sampleAt(track, track.racingLine, inc.s) * 0.5;
        inc.onSurface = onSurface(track, inc.s, inc.lateral);
        decideResponse(world, track, inc);
      } else if (age > CRASH_TIMEOUT) {
        // spun but kept going: a short yellow only
        inc.response = 'yellow';
        inc.recoverAt = now + 6;
      }
    } else {
      decideResponse(world, track, inc);
    }
    return;
  }
  if (car && car.status !== 'retired') {
    // a car still pulling over after a forced response stops for good here
    if (car.ai.failing && car.phys.speed < STOP_SPEED && car.race.stopTime >= 1) retireAsHazard(world, car, '機械故障退賽');
    else if (inc.recoverAt === null && (inc.response === 'yellow' || inc.response === 'vsc') && inc.forced === null && car.phys.speed >= MOVING_SPEED) {
      inc.resolved = true;
    } else if (
      inc.response === 'yellow' &&
      inc.forced === null &&
      inc.onSurface &&
      car.race.stopTime >= STRANDED_SEC &&
      world.session.phase === 'running' &&
      world.session.control.mode === 'green'
    ) {
      // stranded on the racing surface: a virtual safety car until it gets going again
      inc.response = 'vsc';
      deployVsc(world, incidentText(track, inc));
    }
    if (inc.resolved || inc.recoverAt === null) return;
  }
  if (inc.recoverAt !== null && now >= inc.recoverAt) {
    if (car && car.status !== 'retired' && car.ai.failing) retireAsHazard(world, car, '機械故障退賽');
    if (car) car.race.hazard = false;
    inc.resolved = true;
  }
}

function updateSectorFlags(world: WorldState, track: BuiltTrack): void {
  const c = world.session.control;
  const want = [0, 0, 0];
  for (const inc of world.race.incidents) {
    if (inc.resolved) continue;
    const i = sectorOf(track, inc.flagS);
    // double yellow only for a hazard at rest on the racing surface (a car still moving gets a single yellow)
    const atRest = inc.carId < 0 || inc.response !== null;
    want[i] = Math.max(want[i], inc.onSurface && atRest ? 2 : 1);
  }
  let newYellow = false;
  for (let i = 0; i < 3; i++) {
    const was = c.sectorFlags[i] ?? 0;
    if (want[i] === was) continue;
    c.sectorFlags[i] = want[i];
    emit(world, { type: 'sectorFlag', sector: i, flag: want[i] === 0 ? 'clear' : want[i] === 2 ? 'doubleYellow' : 'yellow' });
    if (want[i] === 0) world.race.sectorClearedAt[i] = world.time;
    else if (was === 0) newYellow = true;
  }
  if (newYellow && c.mode === 'green') radioAll(world, '前方黃旗，小心，不得超車。');
}

// ───────────────────────────── neutralisations ─────────────────────────────

function stepVscDeltas(world: WorldState, track: BuiltTrack, dt: number): void {
  for (const car of world.cars) {
    const r = car.race;
    const p = car.phys;
    const f = car.flags;
    if (car.status !== 'running' && car.status !== 'pitting') {
      f.delta = null;
      continue;
    }
    const ds = Math.max(0, signedDeltaS(track, r.ctlS, p.s));
    r.ctlS = p.s;
    if (f.delta === null) f.delta = VSC_START_DELTA;
    if (car.pit.phase !== 'none') {
      f.delta = Math.max(f.delta, 0.5);
      continue;
    }
    f.delta = clamp(f.delta + dt - ds / vscRefSpeed(track, p.s), -10, VSC_MAX_DELTA);
    if (!isHuman(car)) continue;
    r.warnCooldown = Math.max(0, r.warnCooldown - dt);
    if (f.delta < 0 && r.warnCooldown <= 0) {
      r.warnCooldown = WARN_COOLDOWN;
      emit(world, { type: 'controlWarning', carId: car.id, reason: '超過虛擬安全車限速' });
    }
    if (f.delta < VSC_PENALTY_DELTA && !r.vscPenalised) {
      r.vscPenalised = true;
      applyTimePenalty(world, car, VSC_PENALTY, '虛擬安全車期間超速');
    }
  }
}

/**
 * Where the safety car drives on the road and how fast it may go: keeps aside while waving a car past (before it has the
 * leader), passes slower cars / hazards ahead on the other side and follows one it has no room to pass.
 */
function safetyCarLane(world: WorldState, track: BuiltTrack, leader: CarEntry | null): { lateral: number; speedCap: number } {
  const sc = world.session.control.safetyCar;
  const hw = sampleAt(track, track.halfWidth, sc.s);
  const aside = Math.max(0.5, hw - SC_ASIDE_MARGIN);
  let lateral = sampleAt(track, track.racingLine, sc.s) * 0.5;
  let blocker: CarEntry | null = null;
  let blockGap = Infinity;
  let waving = false;
  for (const o of world.cars) {
    if (o.pit.phase !== 'none' || o.status === 'finished' || (o.status === 'retired' && !o.race.hazard)) continue;
    const ahead = forwardDistance(track, sc.s, o.phys.s);
    const onRoad = Math.abs(o.phys.lateral) < sampleAt(track, track.halfWidth, o.phys.s) + 1;
    if (onRoad && ahead < SC_AVOID_RANGE && ahead < blockGap && o.phys.speed < sc.speed) {
      blocker = o;
      blockGap = ahead;
    }
    if (!world.race.scPickedUp && o !== leader && o.status === 'running' && forwardDistance(track, o.phys.s, sc.s) < SC_WAVE_RANGE) {
      waving = true;
    }
  }
  // keep to our side of the racing line (the cars going past take the line; crossing it would cut them off)
  if (waving) lateral = (sc.lateral >= sampleAt(track, track.racingLine, sc.s) ? 1 : -1) * aside;
  let speedCap = Infinity;
  if (blocker) {
    const bl = blocker.phys.lateral;
    if (Math.abs(bl - lateral) < SC_AVOID_CLEAR) lateral = clamp(bl >= 0 ? bl - SC_AVOID_CLEAR : bl + SC_AVOID_CLEAR, -aside, aside);
    if (blockGap < SC_FOLLOW_GAP && Math.abs(bl - sc.lateral) < SC_AVOID_CLEAR * 0.8) speedCap = Math.max(0, blocker.phys.speed);
  }
  return { lateral, speedCap };
}

/** Out of the pit lane when the leader is a few seconds from pit.exit (or after a long wait): it rejoins in front of it. */
function releaseSafetyCar(world: WorldState, track: BuiltTrack, leader: CarEntry | null): void {
  const c = world.session.control;
  const r = world.race;
  const toExit = SC_EXIT_RUN / track.pit.speedLimit;
  let go = world.time - c.since > track.referenceLapTime * SC_HOLD_MAX_LAPS;
  if (!go && leader && leader.pit.phase === 'none') {
    const t = forwardDistance(track, leader.phys.s, track.pit.exit) / Math.max(20, leader.phys.speed);
    go = t > toExit + SC_RELEASE_LEAD[0] && t < toExit + SC_RELEASE_LEAD[1];
  }
  if (!go) return;
  const sc = c.safetyCar;
  r.scHeld = false;
  sc.onTrack = true;
  sc.speed = track.pit.speedLimit;
  const s0 = track.pit.exit - SC_EXIT_RUN;
  placeSafetyCar(world, track, s0, pitLaneOffsetAt(track, s0) ?? track.pit.laneOffset);
  r.scExitDist = SC_EXIT_RUN;
}

function stepSafetyCar(world: WorldState, track: BuiltTrack, dt: number): void {
  const c = world.session.control;
  const sc = c.safetyCar;
  const r = world.race;
  const leader = raceLeader(world);
  if (r.scHeld && !sc.onTrack && c.mode === 'sc') releaseSafetyCar(world, track, leader);
  if (!sc.onTrack) return;
  let pace = pacedSpeedAhead(track, sc.s, SC_SPEED_FACTOR, SC_MAX_SPEED);
  if (c.mode === 'sc' && leader) {
    const gap = forwardDistance(track, leader.phys.s, sc.s);
    // wait for the leader: until it has been picked up, then whenever it drops back
    if (!r.scPickedUp || (gap > SC_WAIT_GAP && gap < track.length / 2)) pace *= 0.75;
  }
  const onRoad = r.scExitDist < 0 && r.scPitDist < 0;
  const lane = onRoad ? safetyCarLane(world, track, leader) : null;
  if (lane) pace = Math.min(pace, lane.speedCap);
  if (r.scExitDist >= 0) pace = track.pit.speedLimit;
  if (r.scPitDist >= 0) pace = Math.max(track.pit.speedLimit, pace * (1 - r.scPitDist / SC_PIT_RUN));
  sc.speed = moveToward(sc.speed, pace, (pace > sc.speed ? SC_ACCEL : SC_DECEL) * dt);
  const step = sc.speed * dt;
  if (c.mode === 'scEnding' && onRoad && forwardDistance(track, sc.s, track.pit.entry) <= step + 0.5) {
    // into the pit lane: the leader now sets the pace
    r.scPitDist = 0;
    r.scGoneLaps = leader ? leader.timing.lapsCompleted : 0;
  }
  if (r.scPitDist >= 0) {
    r.scPitDist += step;
    if (r.scPitDist >= SC_PIT_RUN) {
      sc.onTrack = false;
      r.scPitDist = -1;
      return;
    }
  }
  if (r.scExitDist >= 0) {
    r.scExitDist -= step;
    if (r.scExitDist <= 0) r.scExitDist = -1;
  }
  sc.s = wrapS(track, sc.s + step);
  if (r.scPitDist >= 0) sc.lateral = track.pit.laneOffset * smoothstep(0, SC_PIT_BLEND, r.scPitDist);
  else if (r.scExitDist >= 0) sc.lateral = pitLaneOffsetAt(track, sc.s) ?? sc.lateral;
  else sc.lateral = damp(sc.lateral, lane ? lane.lateral : sampleAt(track, track.racingLine, sc.s) * 0.5, 1.5, dt);
  const pose = poseAt(track, sc.s, sc.lateral);
  sc.x = pose.x;
  sc.y = pose.y;
  sc.z = pose.z;
  sc.yaw = pose.yaw;
  sc.wheelSpin = (sc.wheelSpin + (sc.speed / SC_WHEEL_RADIUS) * dt) % (Math.PI * 2);
  // picked up: the leader is the first car behind it, close enough
  if (!r.scPickedUp && r.scExitDist < 0 && r.scPitDist < 0 && leader && leader.pit.phase === 'none') {
    const gap = forwardDistance(track, leader.phys.s, sc.s);
    const between = world.cars.some(
      (o) => o !== leader && o.status === 'running' && o.pit.phase === 'none' && forwardDistance(track, o.phys.s, sc.s) < gap,
    );
    if (gap < SC_QUEUE_FORMED && !between) r.scPickedUp = true;
  }
}

/**
 * Once the safety car has the race leader, the leader must stay behind it: one that gets ahead is warned and penalised if
 * it has not dropped back within GIVE_BACK_SEC.
 */
function stepSafetyCarPass(world: WorldState, track: BuiltTrack, dt: number): void {
  const c = world.session.control;
  const r = world.race;
  const sc = c.safetyCar;
  const active = (c.mode === 'sc' || c.mode === 'scEnding') && sc.onTrack && r.scPickedUp && r.scExitDist < 0 && r.scPitDist < 0;
  const leader = active ? raceLeader(world) : null;
  for (const car of world.cars) {
    const cr = car.race;
    const d = car === leader && car.pit.phase === 'none' ? forwardDistance(track, sc.s, car.phys.s) : Infinity;
    if (!(d > SC_PASSED_MARGIN && d < track.length / 2)) {
      cr.scAheadTime = 0;
      continue;
    }
    if (cr.scAheadTime === 0) emit(world, { type: 'controlWarning', carId: car.id, reason: '不得超越安全車：請退回安全車後方' });
    const before = cr.scAheadTime;
    cr.scAheadTime += dt;
    if (before < GIVE_BACK_SEC && cr.scAheadTime >= GIVE_BACK_SEC) applyTimePenalty(world, car, ILLEGAL_PASS_PENALTY, '超越安全車');
  }
}

function goGreen(world: WorldState): void {
  const s = world.session;
  s.control.drsLockUntilLap = s.leaderLap + 2;
  for (const car of world.cars) car.flags.delta = null;
  setMode(world, 'green', '');
  radioAll(world, '綠旗、綠旗！');
}

function stepModes(world: WorldState, track: BuiltTrack, dt: number): void {
  const s = world.session;
  const c = s.control;
  const r = world.race;
  const now = world.time;
  const blocking = r.incidents.some((i) => !i.resolved && (i.response === 'vsc' || i.response === 'sc' || i.response === 'red'));
  // the safety car keeps driving (down the pit lane) after the restart until it leaves the scene
  stepSafetyCar(world, track, dt);
  switch (c.mode) {
    case 'vsc':
      stepVscDeltas(world, track, dt);
      if (!blocking && now - c.since >= VSC_MIN_SEC) {
        setMode(world, 'vscEnding', c.reason);
        radioAll(world, '虛擬安全車即將結束，準備加速。');
      }
      break;
    case 'vscEnding':
      stepVscDeltas(world, track, dt);
      if (now - c.since >= VSC_ENDING_SEC) {
        for (const car of world.cars) car.flags.delta = null;
        setMode(world, 'green', '');
        radioAll(world, '綠旗、綠旗！');
      }
      break;
    case 'sc': {
      const leader = raceLeader(world);
      if (!leader) break;
      const sc = c.safetyCar;
      const formed = r.scPickedUp && sc.onTrack && forwardDistance(track, leader.phys.s, sc.s) < SC_QUEUE_FORMED;
      // long races: the leader runs at least two laps behind the safety car; short races: a minimum time instead
      const longEnough =
        s.totalLaps >= SC_LONG_RACE_LAPS ? leader.timing.lapsCompleted >= r.scDeployLaps + 2 : now - c.since >= SC_SHORT_RACE_MIN_SEC;
      // a leader that does not close up (or has passed the safety car) holds the restart up for a lap at most
      const due = !blocking && longEnough;
      if (!due || formed) r.scDueSince = null;
      else if (r.scDueSince === null) r.scDueSince = now;
      const ready = due && (formed || (r.scDueSince !== null && now - r.scDueSince >= track.referenceLapTime * SC_FORM_GRACE_LAPS));
      // "in this lap" with most of the lap still to go, otherwise from the next one
      const notice = sc.onTrack && r.scExitDist < 0 && forwardDistance(track, sc.s, track.pit.entry) >= track.length * SC_IN_NOTICE;
      if ((ready && notice) || s.leaderLap >= s.totalLaps) {
        if (r.scHeld) {
          // never got out: the restart is at the line as if it had just come in
          r.scHeld = false;
          r.scGoneLaps = leader.timing.lapsCompleted;
        }
        c.safetyCar.lightsOn = false;
        setMode(world, 'scEnding', c.reason);
        radioAll(world, '安全車本圈進站，準備重新起跑。');
      }
      break;
    }
    case 'scEnding': {
      const leader = raceLeader(world);
      const inPits = !c.safetyCar.onTrack || r.scPitDist >= 0;
      if (inPits && r.scGoneLaps >= 0 && (!leader || leader.timing.lapsCompleted > r.scGoneLaps)) goGreen(world);
      break;
    }
    case 'red':
      if (r.redRegroupAt !== null && now >= r.redRegroupAt) regroupForRestart(world, track);
      break;
    default:
      break;
  }
}

/** Red flag: field on the grid, hazards cleared, standing restart (session lights; session.ts keeps the laps). */
function regroupForRestart(world: WorldState, track: BuiltTrack): void {
  const s = world.session;
  const r = world.race;
  // the (AI) car that caused the stoppage does not take the restart; a human decides that from the menu
  for (const inc of r.incidents) {
    const car = inc.carId >= 0 ? world.cars[inc.carId] : null;
    if (car && !isHuman(car) && car.status !== 'retired' && (inc.kind === 'crash' || inc.kind === 'failure')) {
      retireAsHazard(world, car, '撞車退賽');
    }
  }
  regroupOnGrid(world, track);
  for (const car of world.cars) car.race.hazard = false;
  r.incidents = [];
  for (let i = 0; i < 3; i++) {
    if ((s.control.sectorFlags[i] ?? 0) > 0) emit(world, { type: 'sectorFlag', sector: i, flag: 'clear' });
    s.control.sectorFlags[i] = 0;
  }
  r.redRegroupAt = null;
  r.restart = true;
  r.lightsStart = world.time + RED_LIGHTS_DELAY;
  r.lightsHold = randRange(world.rng, 0.5, 2.5);
  s.phase = 'lights';
  s.lightsOn = 0;
  s.control.reason = '比賽中止，準備重新起跑';
  radioAll(world, '車隊已回到發車區，準備重新起跑。');
}

function stepBlueFlags(world: WorldState, track: BuiltTrack, dt: number): void {
  const half = track.length * 0.5;
  for (const x of world.cars) {
    const r = x.race;
    if (x.status !== 'running' || x.pit.phase !== 'none') {
      r.blueFor = -1;
      continue;
    }
    let lapper: CarEntry | null = null;
    for (const y of world.cars) {
      if (y === x || y.status !== 'running' || y.pit.phase !== 'none') continue;
      if (y.timing.progress - x.timing.progress < half) continue;
      const d = forwardDistance(track, y.phys.s, x.phys.s);
      if (d > 2 && d < BLUE_RANGE) {
        lapper = y;
        break;
      }
    }
    if (lapper) {
      if (r.blueFor !== lapper.id) {
        r.blueFor = lapper.id;
        emit(world, { type: 'blueFlag', carId: x.id, forCarId: lapper.id });
      }
      r.blueTimer = 0;
    } else if (r.blueFor >= 0) {
      r.blueTimer += dt;
      if (r.blueTimer > BLUE_CLEAR_SEC) r.blueFor = -1;
    }
  }
}

// ───────────────────────────── formation lap ─────────────────────────────

function stepFormation(world: WorldState, track: BuiltTrack, dt: number): void {
  const s = world.session;
  const r = world.race;
  let allParked = true;
  const byGrid = world.cars
    .filter((c) => c.status !== 'retired')
    .sort((a, b) => a.timing.gridPosition - b.timing.gridPosition);
  for (let i = 0; i < byGrid.length; i++) {
    const car = byGrid[i];
    const cr = car.race;
    const p = car.phys;
    if (!cr.parked && !cr.parking) cr.formationDist += Math.max(0, signedDeltaS(track, cr.ctlS, p.s));
    cr.ctlS = p.s;
    if (!cr.parking && !cr.parked && wantsToPark(track, car)) startParking(track, car);
    if (!cr.parked) allParked = false;
    if (isHuman(car) && !cr.formationAuto && !cr.parking && !cr.parked) {
      cr.formationIdle = p.speed < 1 ? cr.formationIdle + dt : 0;
      const ahead = i > 0 ? byGrid[i - 1] : null;
      const gap = ahead && !ahead.race.parked ? ahead.race.formationDist - cr.formationDist : 0;
      if (cr.formationIdle > FORMATION_IDLE_SEC || gap > FORMATION_TAKEOVER_GAP) cr.formationAuto = true;
    }
  }
  checkFormationOrder(world, dt);
  if (!allParked && world.time - s.control.since > track.referenceLapTime * FORMATION_TIMEOUT_LAPS) {
    for (const car of byGrid) if (!car.race.parked) parkOnSlot(track, car);
    allParked = true;
  }
  if (!allParked) return;
  for (const car of world.cars) {
    car.race.formationAuto = false;
    car.race.parking = false;
    car.flags.giveBack = null;
  }
  s.phase = 'pre';
  r.formationDone = true;
  r.lightsStart = world.time + 2;
  setMode(world, 'green', '');
}

// ───────────────────────────── per-car flags ─────────────────────────────

function updateCarFlags(world: WorldState, track: BuiltTrack): void {
  const s = world.session;
  const c = s.control;
  const now = world.time;
  const formation = s.phase === 'formation';
  for (const car of world.cars) {
    const f = car.flags;
    f.queuing = car.status !== 'retired' && (formation || c.mode === 'sc' || c.mode === 'scEnding');
    if (c.mode !== 'vsc' && c.mode !== 'vscEnding') f.delta = null;
    let shown: CarFlag = 'none';
    if (car.status === 'retired' || car.status === 'finished' || formation) shown = 'none';
    else if (c.mode === 'red') shown = 'red';
    else if (c.mode === 'sc' || c.mode === 'scEnding') shown = 'sc';
    else if (c.mode === 'vsc' || c.mode === 'vscEnding') shown = 'vsc';
    else if (car.race.blueFor >= 0) shown = 'blue';
    else {
      const sec = sectorOf(track, car.phys.s);
      const flag = c.sectorFlags[sec] ?? 0;
      if (flag === 2) shown = 'doubleYellow';
      else if (flag === 1) shown = 'yellow';
      else if (now - world.race.greenAt < GREEN_SHOW_SEC || now - (world.race.sectorClearedAt[sec] ?? -1e9) < GREEN_SHOW_SEC) shown = 'green';
    }
    f.shown = shown;
  }
}

// ───────────────────────────── public ─────────────────────────────

/** Advance race control by one step (after classification, before DRS). No-op outside races. */
export function stepRaceControl(world: WorldState, track: BuiltTrack, dt: number): void {
  if (world.config.kind !== 'race') return;
  const s = world.session;
  if (s.phase === 'formation') {
    stepFormation(world, track, dt);
  } else if (s.phase === 'running' || s.phase === 'chequered') {
    const r = world.race;
    updateStopTimes(world, dt);
    if (settingOf(world) !== 'off' && s.phase === 'running') {
      scheduleRandomIncident(world, track);
      detectStoppedCars(world, track);
      detectHeavyImpacts(world, track);
    }
    for (const inc of r.incidents.slice()) progressIncident(world, track, inc);
    r.incidents = r.incidents.filter((i) => !i.resolved);
    updateSectorFlags(world, track);
    stepModes(world, track, dt);
    stepSafetyCarPass(world, track, dt);
    if (s.control.mode === 'green') stepBlueFlags(world, track, dt);
    stepGiveBack(world, dt);
  }
  for (const car of world.cars) car.race.impactPeak = 0;
  updateCarFlags(world, track);
}

/**
 * Debug / test hook: create an incident with the given response right now (picks a mid-field AI car; debris for
 * 'yellow'). Ignores rules.safetyCar / redFlags. False when not a running race or a neutralisation is active.
 */
export function forceIncident(world: WorldState, track: BuiltTrack, kind: IncidentResponse): boolean {
  const s = world.session;
  if (world.config.kind !== 'race' || s.phase !== 'running' || s.control.mode !== 'green') return false;
  if (kind === 'yellow') {
    const human = world.cars.find((c) => isHuman(c) && c.status === 'running');
    const sPos = wrapS(track, (human ? human.phys.s : 0) + 400);
    const inc = createIncident(world, track, 'debris', null, sPos, sampleAt(track, track.racingLine, sPos) * 0.5, 'yellow');
    decideResponse(world, track, inc);
    return true;
  }
  return triggerIncident(world, track, kind);
}

/** Retired cars still visible on track (render). */
export const isHazard = (car: CarEntry): boolean => car.status === 'retired' && car.race.hazard;
