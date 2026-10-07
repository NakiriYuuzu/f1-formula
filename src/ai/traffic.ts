/**
 * AI racecraft: reads the cars around an AI driver and turns them into a speed limit (following / avoidance /
 * yielding when alongside), an allowed lateral band (space keeping), a desired lateral position (overtake side,
 * covering the inside of the next corner, yielding to a lapping car) and the overtake-button request.
 * Attacks start with a real pace advantage (smoothed time-gap closing rate, a much slower / stopped car ahead) or
 * after being held up, never while braking for a tight corner unless already alongside or lunging from right behind,
 * and more cautiously on the opening lap.
 * Pure logic on WorldState; mutates only `car.ai`.
 */
import type { BuiltTrack, CarEntry, WorldState } from '../core/types';
import { clamp, damp, nextRandom } from '../core/math';
import { tyreGrip } from '../physics/index';
import { sampleAt, signedDeltaS } from '../track/track';
import { PATH_EDGE_MARGIN, SPEED_CAP, lineCurvatureAt } from './profile';

/** Minimum clearance (m) kept between car sides when running alongside. */
const SIDE_CLEARANCE = 1.1;
/** Lateral margin (m) between the car centre line and the road edge. */
export const EDGE_MARGIN = PATH_EDGE_MARGIN;
/** Distance (m) ahead within which an attack can start. */
const ATTACK_RANGE = 60;
/** Minimum gap (m) while stalking in the slipstream before an overtake (plus 0.04 s of speed). */
const STALK_GAP = 3;
/** Gap (m) within which the car ahead limits our speed. */
const FOLLOW_RANGE = 55;
/** Curvature (1/m) above which a section counts as a tight corner for the yield rules (R < 120 m). */
const TIGHT_CORNER = 1 / 120;
/** Lateral offset (m) from the racing line, so cars at different points of a curving line compare sensibly. */
const lineOffset = (track: BuiltTrack, car: CarEntry): number => car.phys.lateral - sampleAt(track, track.racingLine, car.phys.s);

/** Curvature (1/m) of the upcoming section above which no new attack is started (R < 250 m). */
const ATTACK_CORNER = 1 / 250;
/** Giving a place back: the car owed it counts within this distance (m) behind. */
const GIVE_BACK_RANGE = 40;

export interface TrafficContext {
  /** lateral (m) the car is currently steering toward at the look-ahead point */
  plannedLateral: number;
  /** pure-pursuit look-ahead distance (m) */
  lookahead: number;
  /** track-limited target speed (m/s) right now */
  trackSpeed: number;
  /** braking capability (m/s²) at the current speed, used for following distances */
  brakeDecel: number;
  /** step length (s) */
  dt: number;
  /** opening lap of a race (extra caution) */
  openingLap: boolean;
  /** within the first seconds after lights out (cars ahead still launching) */
  openingLapStart: boolean;
  /** race control forbids overtaking (safety car, VSC, yellow flag, blue flag, giving a place back) */
  noOvertake?: boolean;
}

export interface TrafficPlan {
  /** speed limit imposed by traffic (m/s); SPEED_CAP when free */
  speedLimit: number;
  /** desired absolute lateral (m, + right) or null = own line */
  lateral: number | null;
  /** lateral rate (m/s) for moving toward `lateral` */
  rate: number;
  /** allowed lateral band [lo, hi] (space keeping) */
  lo: number;
  hi: number;
  /** hold the ERS overtake button */
  overtake: boolean;
}

/** Speed of a car along the track direction at its sample (m/s, + forward). */
export function alongSpeed(track: BuiltTrack, car: CarEntry): number {
  const p = car.phys;
  const i = p.trackIndex >= 0 && p.trackIndex < track.count ? p.trackIndex : 0;
  const v = p.vx * track.tx[i] + p.vz * track.tz[i];
  return Number.isFinite(v) ? v : 0;
}

/** Cars that other drivers must respect on track (not retired, not hidden in the pit lane). */
export function isObstacle(track: BuiltTrack, car: CarEntry): boolean {
  if (car.status === 'retired') return car.race.hazard;
  if (car.pit.phase === 'none') return true;
  if (car.pit.phase === 'entry' || car.pit.phase === 'exit') {
    const hw = sampleAt(track, track.halfWidth, car.phys.s);
    return Math.abs(car.phys.lateral) < hw + 0.5;
  }
  return false;
}

/**
 * Expected lap time (s) of a car right now: a human's latest lap when known, else the AI's static estimate scaled by
 * the current tyre grip (compound, wear, temperature, wetness) and front-wing damage (0 = unknown).
 */
function paceOf(car: CarEntry, wetness: number): number {
  if (car.playerIndex !== -1) return car.timing.lastLap ?? car.timing.bestLap ?? 0;
  if (!(car.ai.paceTime > 0)) return 0;
  const t = car.phys.tire;
  const grip = Math.max(0.3, tyreGrip(t.compound, t.wear, t.temp, wetness));
  return (car.ai.paceTime / Math.sqrt(grip)) * (1 + 0.15 * car.phys.damage.frontWing);
}

/** Strongest racing-line curvature (1/m, signed) over the next `range` metres. */
function upcomingCurvature(track: BuiltTrack, s: number, range: number): number {
  let k = 0;
  for (let d = 10; d <= range; d += 15) {
    const c = lineCurvatureAt(track, s + d);
    if (Math.abs(c) > Math.abs(k)) k = c;
  }
  return k;
}

export function planTraffic(world: WorldState, car: CarEntry, track: BuiltTrack, ctx: TrafficContext): TrafficPlan {
  const ai = car.ai;
  const me = car.phys;
  const myL = car.spec.length;
  const myW = car.spec.width;
  const hw = sampleAt(track, track.halfWidth, me.s);
  const edge = Math.max(0.5, hw - EDGE_MARGIN);
  const attackEdge = Math.max(0.5, edge - 0.35);
  const vMe = alongSpeed(track, car);
  const plan: TrafficPlan = { speedLimit: SPEED_CAP, lateral: null, rate: 2.2, lo: -edge, hi: edge, overtake: false };
  const lookahead = Math.max(1, ctx.lookahead);
  const kAhead = upcomingCurvature(track, me.s, 90);
  const mode = world.session.control.mode;
  // (virtual) safety car: a place owed is given back by moving off the line (below)
  const neutralised = mode === 'sc' || mode === 'scEnding' || mode === 'vsc' || mode === 'vscEnding';

  let ahead: CarEntry | null = null;
  let aheadGap = Infinity;
  let lapper: CarEntry | null = null;
  let owedTo: CarEntry | null = null;
  let threat: CarEntry | null = null;
  let threatDs = -Infinity;
  let yieldTo: CarEntry | null = null;
  // a car alongside limits our lane (not only a car behind claiming one)
  let sideBand = false;

  for (const o of world.cars) {
    if (o === car || !isObstacle(track, o)) continue;
    const op = o.phys;
    const ds = signedDeltaS(track, me.s, op.s);
    if (ds < -45 || ds > 150) continue;
    const half = (myL + o.spec.length) / 2;
    const widthSum = (myW + o.spec.width) / 2;
    const dLat = op.lateral - me.lateral;
    if (ds > half) {
      const t = Math.min(1, ds / lookahead);
      const myLatThere = me.lateral + (ctx.plannedLateral - me.lateral) * t;
      // in our path where we are heading — or still overlapping our current line while close
      const overlapNow = ds - half < 30 && Math.abs(op.lateral - me.lateral) < widthSum + 0.3;
      const far = ds - half > FOLLOW_RANGE && alongSpeed(track, o) > 0.6 * vMe;
      if (!far && (overlapNow || Math.abs(op.lateral - myLatThere) < widthSum + 0.5) && ds - half < aheadGap) {
        ahead = o;
        aheadGap = ds - half;
      }
    } else if (ds > -half - 0.5) {
      // alongside: keep a lane free between the cars
      const need = widthSum + SIDE_CLEARANCE;
      if (Math.abs(dLat) < need + 1.5) {
        // who gives way: into a corner the car on the outside yields to an inside car with real overlap
        // (its nose at least level with our mid-point); otherwise the car behind yields
        const inCorner = Math.abs(kAhead) > TIGHT_CORNER;
        const otherInside = inCorner && Math.sign(dLat) === Math.sign(kAhead);
        const gives = inCorner ? (otherInside ? ds > -half * 0.5 : ds > half * 0.5) : ds > 0.4;
        // in a tight corner only the car that gives way bends its line (squeezing a car onto a hairpin kerb
        // spins it); the other one keeps its line and relies on the yielding car dropping back
        if (!inCorner || gives) {
          if (dLat >= 0) plan.hi = Math.min(plan.hi, op.lateral - need);
          else plan.lo = Math.max(plan.lo, op.lateral + need);
          sideBand = true;
        }
        if (gives && (Math.abs(dLat) < need - 0.3 || inCorner)) yieldTo = o;
      }
    } else {
      // mirror check: a closing car just behind, already offset to one side, claims that lane
      const need = widthSum + SIDE_CLEARANCE * 0.6;
      if (Math.abs(kAhead) < TIGHT_CORNER && ds > -half - 5 - 6 * ai.awareness && Math.abs(dLat) > widthSum * 0.8 && Math.abs(dLat) < need + 1.5 && alongSpeed(track, o) > vMe - 0.5) {
        if (dLat >= 0) plan.hi = Math.min(plan.hi, op.lateral - need);
        else plan.lo = Math.max(plan.lo, op.lateral + need);
      }
      const lapping = o.timing.progress > car.timing.progress + track.length * 0.5;
      if (neutralised && car.flags.giveBack?.carId === o.id && ds > -GIVE_BACK_RANGE) owedTo = o;
      else if (lapping && ds > -40) lapper = o;
      else if (ds > threatDs && alongSpeed(track, o) > vMe - 1) {
        threat = o;
        threatDs = ds;
      }
    }
  }

  if (plan.lo > plan.hi) {
    // squeezed between cars / the edge: hold the current line (never toward the kerb) and drop back — only for a
    // car alongside: braking for one behind that claims a lane would just have it (or the next one) hit us
    const hold = clamp(me.lateral, -edge, edge);
    plan.lo = hold;
    plan.hi = hold;
    if (yieldTo === null && sideBand) plan.speedLimit = Math.max(0, vMe - 2);
  }
  if (yieldTo) plan.speedLimit = Math.min(plan.speedLimit, Math.max(0, alongSpeed(track, yieldTo) - 1.5));

  if (ai.attackTimer > 0) ai.attackTimer = Math.max(0, ai.attackTimer - ctx.dt);
  // the car in our path, which we follow (the attack below may target another car)
  const pathCar = ahead;
  const pathGap = aheadGap;
  // a committed attack keeps its target once we have pulled out of its wake (it is then no longer in our path),
  // up to running nose to nose with it
  if (ai.attackTimer > 0 && ahead?.id !== ai.attackTarget) {
    const rival = world.cars.find((o) => o.id === ai.attackTarget);
    if (rival && rival !== car && isObstacle(track, rival)) {
      const ds = signedDeltaS(track, me.s, rival.phys.s);
      const gap = ds - (myL + rival.spec.length) / 2;
      if (ds > 0 && gap < ATTACK_RANGE) {
        ahead = rival;
        aheadGap = gap;
      }
    }
  }
  let attacking = false;
  let stopped = false;
  if (ahead) {
    const vO = alongSpeed(track, ahead);
    const op = ahead.phys;
    const widthSum = (myW + ahead.spec.width) / 2;
    updateClosing(world, car, ahead, vMe, ctx.dt);
    ai.followTimer = aheadGap < 18 ? ai.followTimer + ctx.dt : Math.max(0, ai.followTimer - ctx.dt);
    const committed = ai.attackTarget === ahead.id && ai.attackTimer > 0;
    // a car far slower than us (stopped, spun, crawling) — not merely a slower start off the line — or a
    // stationary car we have been queued behind
    stopped = (vO < 8 && vMe > vO + 8) || (vO < 2 && ai.followTimer > 2.5 && !ctx.openingLapStart);
    const closingNeeded = (ctx.openingLap ? 2.2 : 0.5) - 0.4 * ai.aggression;
    const mine = paceOf(car, world.weather.wetness);
    const theirs = paceOf(ahead, world.weather.wetness);
    // quicker than the car ahead, or stuck behind it long enough to try anyway
    const heldUp = !ctx.openingLap && ((ai.followTimer > 1 && mine > 0 && theirs > mine) || ai.followTimer > 6 - 3 * ai.aggression);
    // a car that owes us a place (it passed illegally) is easing off for us: pass it back, even while overtaking is banned
    const owed = ahead.flags.giveBack?.carId === car.id;
    const advantage = stopped || ai.closing > closingNeeded || heldUp || owed;
    // a late-braking lunge: right under its rear wing and still closing into the braking zone (not in the
    // opening-lap pack)
    const lunge = !ctx.openingLap && aheadGap < 4 + 0.06 * vMe && ai.closing > 1;
    // no new move once braking for a tight corner (it could not be completed): look over the braking distance
    const brakeRange = Math.max(90, (vMe * vMe) / (2 * Math.max(5, ctx.brakeDecel)) + 40);
    const cornerOk = Math.abs(upcomingCurvature(track, me.s, brakeRange)) < ATTACK_CORNER || aheadGap < 2 || stopped || lunge;
    // a stopped / crawling car may be passed under any flag (legality.ts treats it as legal too)
    const mayPass = !ctx.noOvertake || owed || stopped;
    if (!mayPass && committed) ai.attackTimer = 0;
    if (mayPass && !committed && advantage && cornerOk && aheadGap < ATTACK_RANGE && ai.mode !== 'recover') {
      // passing back a car that moves away from us (see owedTo below): stay on our side of it
      const side = owed ? (lineOffset(track, car) > lineOffset(track, ahead) ? 1 : -1) : chooseSide(car, op.lateral, widthSum, attackEdge, kAhead);
      if (side !== 0) {
        ai.attackTarget = ahead.id;
        ai.attackSide = side;
        ai.attackTimer = 3 + 3 * ai.aggression;
        ai.mode = 'attack';
      }
    }
    attacking = ai.attackTarget === ahead.id && ai.attackTimer > 0;
    if (attacking) {
      const target = clamp(op.lateral + ai.attackSide * (widthSum + 1.1), -attackEdge, attackEdge);
      const inLine = Math.abs(me.lateral - op.lateral) < widthSum + 0.3;
      const pullOut = 8 + 0.08 * vMe;
      if (Math.abs(target - op.lateral) < widthSum + 0.4) {
        // no room on that side any more: give up and follow
        ai.attackTimer = 0;
        attacking = false;
      } else if (aheadGap > pullOut && !stopped && !owed) {
        // too far back to pull out (an early move off line only costs time): close in on our own line, in its
        // slipstream once lined up behind it
        if (inLine) {
          plan.lateral = op.lateral;
          plan.rate = 2.2;
          ai.attackTimer = Math.max(ai.attackTimer, 1);
        }
        plan.overtake = Math.abs(kAhead) < 1 / 300;
      } else {
        plan.lateral = target;
        plan.rate = 2.8;
        plan.overtake = Math.abs(kAhead) < 1 / 300 && aheadGap < 35;
        // still gaining (or nose to tail): keep the move going
        if (ai.closing > 0.3 || aheadGap < 3) ai.attackTimer = Math.max(ai.attackTimer, 1);
      }
    }
  } else {
    ai.gapCar = -1;
    ai.closing = damp(ai.closing, 0, 2, ctx.dt);
    ai.followTimer = Math.max(0, ai.followTimer - ctx.dt);
  }
  // follow / avoid: never close in below the safe gap while still in its path. Only near cars count: a car
  // far ahead that is slow because of a corner will have accelerated away by the time we get there.
  // While attacking it, the tow is used to close in tighter before pulling out.
  const vP = pathCar ? alongSpeed(track, pathCar) : 0;
  if (pathCar && (pathGap < FOLLOW_RANGE || vP < 0.6 * vMe)) {
    const stalking = attacking && pathCar === ahead;
    // a car unexpectedly slow for where it is (spinning, off line, in trouble); under a (virtual) safety car all are
    const troubled = !neutralised && vP < 0.8 * sampleAt(track, track.speedProfile, pathCar.phys.s);
    // racing (from lap 2): brake about where the car ahead does instead of well before it — not in the opening-lap
    // pack, behind a car in trouble or under a (virtual) safety car
    const close = !ctx.openingLap && !neutralised && !troubled;
    const gMin = stalking && !troubled ? STALK_GAP + 0.04 * Math.max(0, vMe) : 2 + (close ? 0.07 : 0.1) * Math.max(0, vMe);
    const a = Math.max(5, ctx.brakeDecel * (close ? 0.9 : 0.75));
    const follow =
      pathGap < gMin ? Math.max(0, vP - (gMin - pathGap) * 1.2) : Math.sqrt(Math.max(0, vP) ** 2 + 2 * a * (pathGap - gMin));
    plan.speedLimit = Math.min(plan.speedLimit, follow);
    // queued behind a stationary car while pulling out around it: creep forward
    if (stopped && stalking && pathGap > 1.2 && vP < 2) plan.speedLimit = Math.max(plan.speedLimit, 4);
  }
  if (ai.attackTimer <= 0 && ai.mode === 'attack') ai.mode = 'race';

  if (owedTo) {
    // giving a place back (neutral.ts lowers our speed): move off the line away from the car we owe, it passes on the other
    // side
    const side = lineOffset(track, car) >= lineOffset(track, owedTo) ? 1 : -1;
    const width = (myW + owedTo.spec.width) / 2 + SIDE_CLEARANCE;
    // short of the edge, or the passing car's lane-keeping squeezes us to a crawl
    const room = Math.max(0.5, edge - 1);
    plan.lateral = clamp(sampleAt(track, track.racingLine, me.s + lookahead) + side * width, -room, room);
    plan.rate = 3;
  } else if (lapper && plan.lateral === null) {
    // yield to a car lapping us: move off line and lift slightly
    const side = lapper.phys.lateral >= me.lateral ? -1 : 1;
    plan.lateral = side * edge * 0.7;
    plan.rate = 2;
    plan.speedLimit = Math.min(plan.speedLimit, ctx.trackSpeed * 0.97);
  } else if (threat && plan.lateral === null && ai.mode !== 'recover' && !ctx.openingLap && !ctx.noOvertake) {
    const kNext = upcomingCurvature(track, me.s, 60 + 2 * vMe);
    defend(car, threat, threatDs, alongSpeed(track, threat) - vMe, vMe, kNext, edge, plan, kAhead);
  }
  if (ai.defendTimer > 0) ai.defendTimer = Math.max(0, ai.defendTimer - ctx.dt);
  if (ai.defendCooldown > 0) ai.defendCooldown = Math.max(0, ai.defendCooldown - ctx.dt);
  if (ai.mode === 'defend' && ai.defendTimer <= 0) ai.mode = 'race';
  if (ai.defendTimer > 0 && plan.lateral === null) plan.lateral = clamp(ai.defendOffset, -edge, edge);
  return plan;
}

/**
 * Closing rate on the car ahead, as m/s at our speed: how fast the time gap at the 50 m timing checkpoints shrinks
 * (equal track positions). A plain speed difference says nothing in a braking zone, where the car ahead is slower
 * simply because it brakes first.
 */
function updateClosing(world: WorldState, car: CarEntry, ahead: CarEntry, vMe: number, dt: number): void {
  const ai = car.ai;
  const n = world.race.cpCount;
  const cp = car.race.cpLast;
  const slot = n > 0 ? ((cp % n) + n) % n : -1;
  if (slot < 0 || car.race.cpAbs[slot] !== cp || ahead.race.cpAbs[slot] !== cp) {
    ai.gapCar = -1;
    ai.closing = damp(ai.closing, 0, 1, dt);
    return;
  }
  const crossed = car.race.cpTimes[slot];
  if (ai.gapCar === ahead.id && crossed === ai.gapAt) return;
  const gap = crossed - ahead.race.cpTimes[slot];
  if (ai.gapCar === ahead.id && crossed > ai.gapAt) {
    const rate = ((ai.gapTime - gap) / (crossed - ai.gapAt)) * vMe;
    if (Number.isFinite(rate)) ai.closing = damp(ai.closing, clamp(rate, -20, 20), 1.5, crossed - ai.gapAt);
  } else if (ai.gapCar !== ahead.id) {
    ai.closing = 0;
  }
  ai.gapTime = gap;
  ai.gapAt = crossed;
  ai.gapCar = ahead.id;
}

/** Overtake side (-1 left, +1 right, 0 none): needs room; prefers the inside of the next corner, then more room. */
function chooseSide(car: CarEntry, otherLat: number, widthSum: number, edge: number, kAhead: number): number {
  const need = widthSum + 1.1;
  const roomRight = edge - (otherLat + need);
  const roomLeft = otherLat - need + edge;
  const okRight = roomRight >= -0.1;
  const okLeft = roomLeft >= -0.1;
  if (!okRight && !okLeft) return 0;
  if (okRight !== okLeft) return okRight ? 1 : -1;
  if (Math.abs(kAhead) > 1 / 400) return kAhead > 0 ? 1 : -1;
  if (Math.abs(roomRight - roomLeft) < 0.5) return car.phys.lateral >= otherLat ? 1 : -1;
  return roomRight > roomLeft ? 1 : -1;
}

/**
 * Holding a place against a car closing in right behind: one move to cover the inside of the next corner (on a
 * long straight: toward the attacker's side), held into the braking zone — at the price of a slower line into the
 * corner. Never a late move: not when the attacker would reach us within a second (`closing` = its speed
 * advantage, m/s). `kNext` = strongest curvature of the coming corner.
 */
function defend(
  car: CarEntry,
  threat: CarEntry,
  threatDs: number,
  closing: number,
  vMe: number,
  kNext: number,
  edge: number,
  plan: TrafficPlan,
  kAhead: number,
): void {
  const ai = car.ai;
  if (ai.defendTimer > 0 || ai.defendCooldown > 0) return;
  const gap = -threatDs - car.spec.length;
  if (gap < 2 || gap > 10 + 0.25 * vMe || Math.abs(kAhead) > TIGHT_CORNER) return;
  if (closing > 0 && gap < closing) return;
  if (ai.aggression * ai.racecraft < 0.3 || nextRandom(ai.rng) > 0.02 + 0.03 * ai.aggression) return;
  const lat = car.phys.lateral;
  const corner = Math.abs(kNext) > 1 / 300;
  const side = corner ? Math.sign(kNext) : threat.phys.lateral >= lat ? 1 : -1;
  // covering the inside: toward half the road on that side, at most 3 m in one move (never away from it)
  const move = corner ? clamp(side * edge * 0.5 - lat, side > 0 ? 0 : -3, side > 0 ? 3 : 0) : side * 1.3;
  ai.defendOffset = clamp(lat + move, -edge, edge);
  ai.defendTimer = 2.5;
  ai.defendCooldown = 6;
  ai.mode = 'defend';
  plan.lateral = ai.defendOffset;
}
