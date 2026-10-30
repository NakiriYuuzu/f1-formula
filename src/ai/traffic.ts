/**
 * AI racecraft: reads the cars around an AI driver and turns them into a speed limit (following / avoidance /
 * yielding when alongside), an allowed lateral band (space keeping), a desired lateral position (overtake side,
 * covering the inside of the next corner, yielding to a lapping car) and the overtake-button request.
 * Attacks start with a real pace advantage (smoothed time-gap closing rate, a much slower / stopped car ahead) or
 * after being held up, never while braking for a tight corner unless already alongside or lunging from right behind,
 * and more cautiously on the opening lap. An attack runs through phases (stalk in the tow → feint → commit
 * alongside → switchback), each with a time-out, and cool-downs keep it from flickering. Behind a DRS train without
 * the pace to pass it the driver does not force a move. Defending: one move per straight, never started once braking
 * for the corner ahead; side by side the outside car keeps the outside line and the inside car leaves a car's width
 * on the exit; a car more than half alongside is never squeezed. Team orders (strategy.ts): a team-mate told to let us
 * by is passed like a car owing us the place, and eases off and moves off its line on a straight; team-mates holding
 * position do not race each other.
 * Pure logic on WorldState; mutates only `car.ai`.
 */
import type { BuiltTrack, CarEntry, WorldState } from '../core/types';
import type { AIState } from './types';
import { clamp, clamp01, damp, nextRandom } from '../core/math';
import { tyreGrip } from '../physics/index';
import { DRS_GAP } from '../race/drs';
import { forwardDistance, inRangeS, sampleAt, signedDeltaS } from '../track/track';
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
/** Closing speed (m/s) above which a car in the lane we steer into counts as in our path (see intoLane). */
const SWEEP_CLOSING = 8;
/** Curvature (1/m) above which a section counts as a tight corner for the yield rules (R < 120 m). */
const TIGHT_CORNER = 1 / 120;
/** Lateral offset (m) from the racing line, so cars at different points of a curving line compare sensibly. */
const lineOffset = (track: BuiltTrack, car: CarEntry): number => car.phys.lateral - sampleAt(track, track.racingLine, car.phys.s);

/** Curvature (1/m) of the upcoming section above which no new attack is started (R < 250 m). */
const ATTACK_CORNER = 1 / 250;
/** Giving a place back: the car owed it counts within this distance (m) behind. */
const GIVE_BACK_RANGE = 40;

/**
 * Attack phases: stalking in the tow for STALK_TIMEOUT s while losing ground (closing below STALK_LOSING m/s), or
 * committed for COMMIT_MAX s, ends it.
 */
const STALK_TIMEOUT = 10;
const STALK_LOSING = -0.3;
const COMMIT_MAX = 15;
/** No new attack for ATTACK_COOLDOWN s after one is given up, no feint / switchback for TRICK_COOLDOWN s after one. */
const ATTACK_COOLDOWN = 1;
const TRICK_COOLDOWN = 8;
/**
 * Feint: at pull-out range on a straight, with room on both sides and the defender's move for this straight still
 * unused, the driver may first show the other side (the nose FEINT_SHOW m off the defender's line) for up to
 * FEINT_TIME s. A defender moving (or starting a move) FEINT_BITE m toward it has bitten — and has used its move: go
 * the planned way. No bite: the planned way all the same. Chance FEINT_CHANCE + FEINT_SKILL ×
 * (racecraft − 0.85), drawn once per attack.
 */
const FEINT_SHOW = 1.4;
const FEINT_TIME = 1.3;
const FEINT_BITE = 0.6;
const FEINT_CHANCE = 0.5;
const FEINT_SKILL = 3;
/**
 * Switchback: within SWITCHBACK_RANGE m of a defender that dived SWITCHBACK_DIVE m off its line toward the inside of
 * the tight corner ahead — on the outside with its nose at least level with our mid-point, or with the inside
 * covered — the driver may lift early (SWITCHBACK_LIFT) and stay SWITCHBACK_GAP m behind it, then from the apex cut
 * back to the inside and drive alongside out of the corner. Chance SWITCHBACK_CHANCE + SWITCHBACK_SKILL ×
 * (racecraft − 0.85) per corner; given up after SWITCHBACK_TIME s.
 */
const SWITCHBACK_RANGE = 10;
/** … and not when the next corner turns the other way within this distance (m) of its end. */
const SWITCHBACK_STRAIGHT = 200;
const SWITCHBACK_DIVE = 0.8;
const SWITCHBACK_LIFT = 0.015;
const SWITCHBACK_GAP = 2;
const SWITCHBACK_TIME = 6;
const SWITCHBACK_CHANCE = 0.4;
const SWITCHBACK_SKILL = 3;
/** Passing the car within TRICK_CREDIT s of a feint / switchback on it counts as its success. */
const TRICK_CREDIT = 10;
/**
 * DRS train: the car ahead is itself within DRS_GAP of its own car ahead with DRS live. Without a pace advantage of
 * TRAIN_PACE_EDGE (share of the lap time, expected pace on the current tyres) there is no forced attack; the driver
 * conserves while within TRAIN_DRS_KEEP s of it (beyond that it closes back in to keep the DRS).
 */
const TRAIN_PACE_EDGE = 0.006;
/** … or a measured closing rate TRAIN_CLOSING m/s above what starts an attack. */
const TRAIN_CLOSING = 1;
export const TRAIN_DRS_KEEP = 0.8;
/**
 * Defending on a straight: only once the attacker shows a side by this much (m, relative to the racing line). Never a
 * move toward the side it shows once it would reach us within DEFEND_REACH s.
 */
const SHOW_SIDE = 0.6;
const DEFEND_REACH = 1.5;
/** A defensive move needs its lane clear of cars ahead over 15 m + LANE_LOOK s at our speed. */
const LANE_LOOK = 1.5;
/** Side by side in a corner: the inside car leaves the outside one its width plus this (m) to the edge. */
const EXIT_ROOM = 0.5;
/**
 * Braking for the corner ahead (no new defensive move): the track-limited target speed within this (m/s) of ours; or
 * on the brakes at all (pedal above DEFEND_BRAKE).
 */
const BRAKE_ZONE_MARGIN = 2;
const DEFEND_BRAKE = 0.05;
/**
 * Letting a team-mate by (team order): on a straight (nothing tighter than R 250 m within YIELD_LOOK m, not braking),
 * with it right behind in the classification and within YIELD_RANGE m, ease off (target YIELD_EASE m/s under our speed:
 * part throttle, no braking) down to YIELD_FLOOR of the reference speed; within YIELD_ASIDE m move off its line.
 */
const YIELD_RANGE = 150;
const YIELD_LOOK = 150;
const YIELD_FLOOR = 0.8;
const YIELD_EASE = 0.2;
const YIELD_ASIDE = 40;

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
  /** extra reach (m) of the driver's own path over a kerb on the left / right (kerb use; widens the free band) */
  kerbLeft?: number;
  kerbRight?: number;
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
 * Expected lap time (s) of a car right now: the AI's static estimate scaled by the current tyre grip (compound, wear,
 * temperature, wetness) and front-wing damage; a human's measured clean pace (AIState.cleanLap) where it is quicker —
 * stuck in traffic or on the standing-start lap its laps would hide what it can do (0 = unknown).
 */
export function paceOf(car: CarEntry, wetness: number): number {
  const est = estimatedPace(car, wetness);
  if (car.playerIndex === -1) return est;
  const lap = car.ai.cleanLap;
  if (lap > 0) return est > 0 ? Math.min(lap, est) : lap;
  return est > 0 ? est : (car.timing.lastLap ?? car.timing.bestLap ?? 0);
}

/** The AI's static estimate for the car + driver (a human's car has one too) on its current tyres / damage (0 = none). */
export function estimatedPace(car: CarEntry, wetness: number): number {
  if (!(car.ai.paceTime > 0)) return 0;
  const t = car.phys.tire;
  const grip = Math.max(0.3, tyreGrip(t.compound, t.wear, t.temp, wetness));
  return (car.ai.paceTime / Math.sqrt(grip)) * (1 + 0.15 * car.phys.damage.frontWing);
}

/**
 * Whether `car` gives way to `other` running alongside (`ds` = other's s − car's s, `half` = half the summed car
 * lengths): into a tight corner the outside car gives way to an inside car with real overlap (its nose at least level
 * with our mid-point), otherwise the car behind.
 */
function givesWay(track: BuiltTrack, car: CarEntry, other: CarEntry, ds: number, half: number): boolean {
  const k = upcomingCurvature(track, car.phys.s, 90);
  if (Math.abs(k) <= TIGHT_CORNER) return ds > 0.4;
  const otherInside = Math.sign(other.phys.lateral - car.phys.lateral) === Math.sign(k);
  return otherInside ? ds > -half * 0.5 : ds > half * 0.5;
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
  const kerbL = Math.max(0, ctx.kerbLeft ?? 0);
  const kerbR = Math.max(0, ctx.kerbRight ?? 0);
  const plan: TrafficPlan = { speedLimit: SPEED_CAP, lateral: null, rate: 2.2, lo: -edge - kerbL, hi: edge + kerbR, overtake: false };
  const lookahead = Math.max(1, ctx.lookahead);
  const kAhead = upcomingCurvature(track, me.s, 90);
  const mode = world.session.control.mode;
  // (virtual) safety car: a place owed is given back by moving off the line (below)
  const neutralised = mode === 'sc' || mode === 'scEnding' || mode === 'vsc' || mode === 'vscEnding';

  let ahead: CarEntry | null = null;
  let aheadGap = Infinity;
  // overtaking banned: the nearest car ahead in any lane (no drawing alongside it either)
  let held: CarEntry | null = null;
  let heldGap = Infinity;
  let lapper: CarEntry | null = null;
  let owedTo: CarEntry | null = null;
  let threat: CarEntry | null = null;
  let threatDs = -Infinity;
  let yieldTo: CarEntry | null = null;
  // a car alongside limits our lane (not only a car behind claiming one); squeezedBy: one of them is level or ahead
  let sideBand = false;
  let squeezedBy = false;

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
      // into a bend, a much slower car (not the one we attack) in the lane we are steering into, within the look-ahead:
      // pure pursuit gets there sooner than the straight-line guess above (through an S-bend it ran into the back of a
      // car off line and slow)
      const intoLane =
        ds < lookahead &&
        Math.abs(kAhead) > ATTACK_CORNER &&
        !(ai.attackTarget === o.id && ai.attackTimer > 0) &&
        vMe - alongSpeed(track, o) > SWEEP_CLOSING &&
        Math.abs(op.lateral - ctx.plannedLateral) < widthSum + 0.5;
      const far = ds - half > FOLLOW_RANGE && alongSpeed(track, o) > 0.6 * vMe;
      if (!far && (overlapNow || intoLane || Math.abs(op.lateral - myLatThere) < widthSum + 0.5) && ds - half < aheadGap) {
        ahead = o;
        aheadGap = ds - half;
      }
      if (ctx.noOvertake && ds - half < heldGap && ds - half < FOLLOW_RANGE && o.flags.giveBack?.carId !== car.id) {
        held = o;
        heldGap = ds - half;
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
        // in a tight corner the car that gives way bends its line; of the others the outside car keeps the outside
        // line (no turning in on an inside car alongside) and a car more than half alongside is never squeezed
        // (squeezing a car onto a hairpin kerb spins it) …
        if (!inCorner || gives || otherInside || Math.abs(ds) < half * 0.5) {
          if (dLat >= 0) plan.hi = Math.min(plan.hi, op.lateral - need);
          else plan.lo = Math.max(plan.lo, op.lateral + need);
          sideBand = true;
          // (squeezed by a car level or ahead that does not give way to us itself)
          if (ds > -0.4 && !givesWay(track, o, car, -ds, half)) squeezedBy = true;
        } else if (dLat >= 0) {
          // … and the inside car runs out to the exit leaving the outside one its width to the edge
          plan.hi = Math.min(plan.hi, edge - widthSum - EXIT_ROOM);
        } else {
          plan.lo = Math.max(plan.lo, -edge + widthSum + EXIT_ROOM);
        }
        // both giving way (into an S-bend each sees the other on the inside) would slow both to a halt: only the
        // car behind does
        if (gives && (Math.abs(dLat) < need - 0.3 || inCorner) && (ds > 0 || !givesWay(track, o, car, -ds, half))) yieldTo = o;
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
      // a team-mate we let by / hold position with (team orders): no defending against it
      else if (o.id === ai.yieldFor || o.id === ai.holdFor) continue;
      else if (ds > threatDs && alongSpeed(track, o) > vMe - 1) {
        threat = o;
        threatDs = ds;
      }
    }
  }

  // overtaking banned (neutralised, yellow / blue flag, giving a place back): hold station behind the car ahead even
  // in another lane — not a car in trouble (stopped, crawling, failing or spun), which may be passed
  if (held && held !== ahead && heldGap < aheadGap) {
    const vH = alongSpeed(track, held);
    const crawling = neutralised ? vH < 8 : vH < 0.8 * sampleAt(track, track.speedProfile, held.phys.s);
    if (!crawling && !held.ai.failing && held.ai.crashTimer <= 0) {
      ahead = held;
      aheadGap = heldGap;
    }
  }

  if (plan.lo > plan.hi) {
    // squeezed between cars / the edge: hold the current line (never toward the kerb) and drop back — only for a
    // car alongside that is level or ahead and does not give way to us: braking for one behind that claims a lane
    // would just have it (or the next one) hit us, and a car that yields to us is easing off already (both easing
    // off stops both)
    const hold = clamp(me.lateral, -edge - kerbL, edge + kerbR);
    plan.lo = hold;
    plan.hi = hold;
    if (yieldTo === null && sideBand && squeezedBy) plan.speedLimit = Math.max(0, vMe - 2);
  }
  if (yieldTo) plan.speedLimit = Math.min(plan.speedLimit, Math.max(0, alongSpeed(track, yieldTo) - 1.5));

  if (ai.attackTimer > 0) ai.attackTimer = Math.max(0, ai.attackTimer - ctx.dt);
  if (ai.attackCooldown > 0) ai.attackCooldown = Math.max(0, ai.attackCooldown - ctx.dt);
  if (ai.trickCooldown > 0) ai.trickCooldown = Math.max(0, ai.trickCooldown - ctx.dt);
  if (ai.trickTimer > 0) creditTrick(world, track, car, ctx.dt);
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
  ai.inTrain = false;
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
    // team orders (strategy.ts): a team-mate letting us by is passed like a car that owes us the place (not under a
    // flag, though); one we hold position with is not attacked
    const letBy = ahead.playerIndex === -1 && ahead.ai.yieldFor === car.id;
    const hold = (ai.holdFor === ahead.id || ai.noRaceFor === ahead.id) && !letBy;
    const pass = owed || letBy;
    // a DRS train ahead and not clearly quicker than the car in it: no forced move (it has the DRS too) — follow
    // (an aggressive driver has a go with a smaller edge, a patient one waits for a bigger one)
    const edge = TRAIN_PACE_EDGE * (1.6 - ai.aggression);
    const quicker = (mine > 0 && theirs > 0 && theirs - mine > edge * theirs) || ai.closing > closingNeeded + TRAIN_CLOSING;
    const train = !stopped && !pass && !quicker && drsTrain(world, ahead);
    ai.inTrain = train;
    const advantage = stopped || pass || (!train && !hold && (ai.closing > closingNeeded || heldUp));
    // a late-braking lunge: right under its rear wing and still closing into the braking zone (not in the
    // opening-lap pack, not into a DRS train, not on a team-mate holding position)
    const lunge = !train && !hold && !ctx.openingLap && aheadGap < 4 + 0.06 * vMe && ai.closing > 1;
    // no new move once braking for a tight corner (it could not be completed): look over the braking distance
    const brakeRange = Math.max(90, (vMe * vMe) / (2 * Math.max(5, ctx.brakeDecel)) + 40);
    const kBrake = upcomingCurvature(track, me.s, brakeRange);
    const cornerOk = Math.abs(kBrake) < ATTACK_CORNER || aheadGap < 2 || stopped || lunge;
    // a stopped / crawling car may be passed under any flag (legality.ts treats it as legal too)
    const mayPass = !ctx.noOvertake || owed || stopped;
    if (!mayPass && committed) ai.attackTimer = 0;
    // into a train / on a team-mate holding position: a move not yet alongside is called off
    if ((train || hold) && committed && aheadGap > 2) ai.attackTimer = 0;
    const ready = ai.attackCooldown <= 0 || stopped || pass;
    if (mayPass && !committed && ready && advantage && cornerOk && aheadGap < ATTACK_RANGE && ai.mode !== 'recover') {
      // passing back a car that moves away from us (see owedTo below): stay on our side of it
      const side = pass ? (lineOffset(track, car) > lineOffset(track, ahead) ? 1 : -1) : chooseSide(car, op.lateral, widthSum, attackEdge, kAhead);
      if (side !== 0) {
        ai.attackTarget = ahead.id;
        ai.attackSide = side;
        ai.attackTimer = 3 + 3 * ai.aggression;
        ai.mode = 'attack';
        ai.attackPhase = 'stalk';
        ai.phaseTimer = 0;
        ai.switchCorner = -1;
      }
    }
    attacking = ai.attackTarget === ahead.id && ai.attackTimer > 0;
    if (attacking) {
      const env = attackEnv;
      env.ahead = ahead;
      env.gap = aheadGap;
      env.widthSum = widthSum;
      env.vMe = vMe;
      env.vO = vO;
      env.edge = attackEdge;
      env.kAhead = kAhead;
      env.kBrake = kBrake;
      env.brakeRange = brakeRange;
      env.brakeDecel = ctx.brakeDecel;
      env.forced = stopped || pass;
      attacking = runAttack(track, car, env, plan, ctx);
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
  if (ai.attackTimer <= 0 && ai.attackPhase !== 'none') {
    ai.attackPhase = 'none';
    ai.switchCorner = -1;
  }

  const mate = yieldingTo(world, track, car, ctx, vMe);
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
  } else if (mate && plan.lateral === null) {
    // team order: ease off (part throttle, no braking on the straight in front of the cars behind), down to a share of
    // the reference speed — never toward the team-mate's, which follows us — so it closes in; once close, off its line
    const ds = signedDeltaS(track, me.s, mate.phys.s);
    const ease = Math.max(sampleAt(track, track.speedProfile, me.s) * YIELD_FLOOR, vMe - YIELD_EASE);
    plan.speedLimit = Math.min(plan.speedLimit, ease);
    if (ds > -YIELD_ASIDE) {
      plan.lateral = (mate.phys.lateral >= me.lateral ? -1 : 1) * edge * 0.7;
      plan.rate = 2;
    }
  } else if (threat && plan.lateral === null && ai.mode !== 'recover' && !ctx.openingLap && !ctx.noOvertake) {
    const kNext = upcomingCurvature(track, me.s, 60 + 2 * vMe);
    // braking for the corner ahead (its target speed reached ours): no new move from here on
    const braking = ctx.trackSpeed < vMe + BRAKE_ZONE_MARGIN;
    defend(world, track, car, threat, threatDs, alongSpeed(track, threat) - vMe, vMe, kNext, edge, plan, kAhead, braking);
  }
  // one defensive move per straight: the next straight starts in the corner the last move was made for
  if (ai.defendCorner >= 0) {
    const c = track.corners[ai.defendCorner];
    if (!c || inRangeS(track, me.s, c.startS, c.endS)) ai.defendCorner = -1;
  }
  if (ai.defendTimer > 0) ai.defendTimer = Math.max(0, ai.defendTimer - ctx.dt);
  if (ai.defendCooldown > 0) ai.defendCooldown = Math.max(0, ai.defendCooldown - ctx.dt);
  // a cover held into the braking zone stays until the corner it was made for (defendCorner clears at its start):
  // going back to the line there would cut across while braking — a second move, toward where an attacker goes
  const holdToCorner = ai.defendCorner >= 0 && (ctx.trackSpeed < vMe + BRAKE_ZONE_MARGIN || car.phys.brake > DEFEND_BRAKE);
  if (ai.mode === 'defend' && ai.defendTimer <= 0 && holdToCorner) ai.defendTimer = ctx.dt;
  if (ai.mode === 'defend' && ai.defendTimer <= 0) ai.mode = 'race';
  if (ai.defendTimer > 0 && plan.lateral === null) {
    // the cover is for the inside of the next corner (or the side shown on a straight): once the corner ahead turns
    // the other way it is the outside (held into it, the car crawls through on a pinned line and is hit from behind) —
    // let it go, short of the braking zone. The side of the move, not of the road: a move toward the inside from the
    // outside half stays held.
    const kCover = upcomingCurvature(track, me.s, 60 + 2 * vMe);
    const outside = !holdToCorner && Math.abs(kCover) > 1 / 300 && ai.defendSide !== 0 && Math.sign(kCover) !== ai.defendSide;
    if (outside) ai.defendTimer = 0;
    else plan.lateral = clamp(ai.defendOffset, -edge, edge);
  }
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

/** The car ahead runs in a DRS train: within DRS_GAP of its own car ahead while DRS (2026: straight mode) is live. */
function drsTrain(world: WorldState, ahead: CarEntry): boolean {
  const t = ahead.timing;
  return world.config.kind === 'race' && world.session.drsEnabled && t.position > 1 && t.interval > 0 && t.interval < DRS_GAP;
}

/** Index (into track.corners) of the corner whose apex comes next from `s`, -1 none. */
function cornerAhead(track: BuiltTrack, s: number): number {
  let best = -1;
  let dist = Infinity;
  for (let i = 0; i < track.corners.length; i++) {
    const d = forwardDistance(track, s, track.corners[i].apexS);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

/** Index (into track.corners) of the next corner to start from `s` (the one the straight leads to), -1 none. */
function nextCorner(track: BuiltTrack, s: number): number {
  let best = -1;
  let dist = Infinity;
  for (let i = 0; i < track.corners.length; i++) {
    const d = forwardDistance(track, s, track.corners[i].startS);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

/** The car ahead can still answer a feint: a human, or an AI driver with its move for this straight unused. */
function canCover(track: BuiltTrack, o: CarEntry): boolean {
  if (o.playerIndex !== -1) return true;
  const ai = o.ai;
  if (ai.mode === 'attack' || ai.defendTimer > 0 || ai.defendCooldown > 0) return false;
  return ai.defendCorner < 0 || ai.defendCorner !== nextCorner(track, o.phys.s);
}

/** A car ahead within LANE_LOOK s (at our speed) in the lane at `lateral` (m), between here and there. */
function laneTaken(world: WorldState, track: BuiltTrack, car: CarEntry, lateral: number, vMe: number): boolean {
  const me = car.phys;
  const range = 15 + LANE_LOOK * vMe;
  for (const o of world.cars) {
    if (o === car || !isObstacle(track, o)) continue;
    const ds = signedDeltaS(track, me.s, o.phys.s);
    if (ds <= 0 || ds > range) continue;
    const lo = Math.min(me.lateral, lateral);
    const hi = Math.max(me.lateral, lateral);
    const reach = (car.spec.width + o.spec.width) / 2 + 0.5;
    if (o.phys.lateral > lo - reach && o.phys.lateral < hi + reach) return true;
  }
  return false;
}

/**
 * Team order (strategy.ts): the team-mate `ai.yieldFor` to let by right now — on a straight, while it is the next car
 * behind and within YIELD_RANGE m. The order ends once it is by, or after its time-out.
 */
function yieldingTo(world: WorldState, track: BuiltTrack, car: CarEntry, ctx: TrafficContext, vMe: number): CarEntry | null {
  const ai = car.ai;
  if (ai.yieldFor < 0) return null;
  ai.yieldTimer = Math.max(0, ai.yieldTimer - ctx.dt);
  const mate = world.cars[ai.yieldFor];
  const ds = mate ? signedDeltaS(track, car.phys.s, mate.phys.s) : 0;
  if (!mate || mate === car || ai.yieldTimer <= 0 || mate.status !== 'running' || mate.pit.phase !== 'none' || ds > (car.spec.length + mate.spec.length) / 2) {
    ai.yieldFor = -1;
    ai.yieldTimer = 0;
    return null;
  }
  if (ds < -YIELD_RANGE || ctx.noOvertake || mate.timing.position !== car.timing.position + 1) return null;
  const straight = Math.abs(upcomingCurvature(track, car.phys.s, YIELD_LOOK)) < ATTACK_CORNER && ctx.trackSpeed > vMe + BRAKE_ZONE_MARGIN;
  return straight ? mate : null;
}

/** Count a pass of the car a feint / switchback was made on, while its credit window lasts. */
function creditTrick(world: WorldState, track: BuiltTrack, car: CarEntry, dt: number): void {
  const ai = car.ai;
  ai.trickTimer = Math.max(0, ai.trickTimer - dt);
  const o = world.cars.find((c) => c.id === ai.trickTarget);
  if (!o || o === car || !isObstacle(track, o)) {
    ai.trickTimer = 0;
    return;
  }
  if (signedDeltaS(track, car.phys.s, o.phys.s) < -(car.spec.length + o.spec.length) / 2) {
    if (ai.trickKind === 'feint') ai.feintPasses++;
    else ai.switchbackPasses++;
    ai.trickTimer = 0;
  }
}

function credit(ai: AIState, target: number, kind: 'feint' | 'switchback'): void {
  ai.trickTarget = target;
  ai.trickKind = kind;
  ai.trickTimer = TRICK_CREDIT;
  ai.trickCooldown = TRICK_COOLDOWN;
}

/** The attack is over (given up / timed out): back to following, no new one for `cooldown` s. */
function endAttack(ai: AIState, cooldown: number): false {
  ai.attackTimer = 0;
  ai.attackPhase = 'none';
  ai.phaseTimer = 0;
  ai.switchCorner = -1;
  ai.attackCooldown = Math.max(ai.attackCooldown, cooldown);
  return false;
}

interface AttackEnv {
  /** the car attacked and the gap (m) to it, nose to tail (< 0 alongside) */
  ahead: CarEntry;
  gap: number;
  /** half the summed car widths (m) */
  widthSum: number;
  /** along-track speeds (m/s): ours and the attacked car's */
  vMe: number;
  vO: number;
  /** lateral limit (m) of the attacking line */
  edge: number;
  /** strongest line curvature over the next 90 m and over the braking distance; that distance (m) */
  kAhead: number;
  kBrake: number;
  brakeRange: number;
  /** braking capability (m/s²) */
  brakeDecel: number;
  /** passing a stopped car / a car that owes us the place: straight past it, no tricks */
  forced: boolean;
}

/** The attack's environment, refilled for each car and step (planTraffic is not re-entrant: no per-step object). */
const attackEnv: AttackEnv = {
  ahead: undefined as unknown as CarEntry,
  gap: 0,
  widthSum: 0,
  vMe: 0,
  vO: 0,
  edge: 0,
  kAhead: 0,
  kBrake: 0,
  brakeRange: 0,
  brakeDecel: 0,
  forced: false,
};

/** Lateral (m) alongside the attacked car on `side`, within the attacking line's limit. */
function sideTarget(a: AttackEnv, side: number): number {
  return clamp(a.ahead.phys.lateral + side * (a.widthSum + 1.1), -a.edge, a.edge);
}

/** Room for us beside the attacked car on `side`. */
function room(a: AttackEnv, side: number): boolean {
  return Math.abs(sideTarget(a, side) - a.ahead.phys.lateral) >= a.widthSum + 0.4;
}

/**
 * The phases of an attack on `a.ahead`: stalk (too far back to pull out: in its tow on its line) → at pull-out range
 * either a feint (show the other side first; if the defender moves across, go the planned way) or straight to commit
 * (pull out alongside on the attack side) → a switchback when on the outside into a corner it dived into, or with our
 * side covered. Sets the plan's lateral / rate / overtake button (and the switchback's speed limit); false = given up.
 */
function runAttack(track: BuiltTrack, car: CarEntry, a: AttackEnv, plan: TrafficPlan, ctx: TrafficContext): boolean {
  const ai = car.ai;
  const op = a.ahead.phys;
  ai.phaseTimer += ctx.dt;
  const straight = Math.abs(a.kAhead) < 1 / 300;
  if (ai.attackPhase === 'switchback') return switchback(track, car, a, plan, ctx);
  if (!room(a, ai.attackSide)) {
    // no room on that side any more (covered): cut back under it on the corner exit, or give up and follow — a new
    // move on the open side may start at once (no cool-down: that is not dithering)
    if (startSwitchback(track, car, a, ctx, true)) return switchback(track, car, a, plan, ctx);
    return endAttack(ai, 0);
  }
  const pullOut = 8 + 0.08 * a.vMe;
  if (a.gap > pullOut && !a.forced) {
    // stalk: too far back to pull out (an early move off line only costs time): close in on our own line, in its
    // slipstream once lined up behind it — not for ever while losing ground
    if (ai.attackPhase !== 'stalk') {
      ai.attackPhase = 'stalk';
      ai.phaseTimer = 0;
    }
    if (ai.phaseTimer > STALK_TIMEOUT && ai.closing < STALK_LOSING) return endAttack(ai, ATTACK_COOLDOWN);
    if (Math.abs(car.phys.lateral - op.lateral) < a.widthSum + 0.3) {
      plan.lateral = op.lateral;
      plan.rate = 2.2;
      ai.attackTimer = Math.max(ai.attackTimer, 1);
    }
    plan.overtake = straight;
    return true;
  }
  if (ai.attackPhase === 'stalk' || ai.attackPhase === 'none') {
    // in range: pull out — on a straight with room both ways perhaps showing the other side first
    ai.attackPhase = 'commit';
    ai.phaseTimer = 0;
    const clear = Math.abs(upcomingCurvature(track, car.phys.s, a.brakeRange + a.vMe * FEINT_TIME)) < ATTACK_CORNER;
    if (!a.forced && !ctx.openingLap && ai.trickCooldown <= 0 && clear && room(a, -ai.attackSide) && canCover(track, a.ahead)) {
      if (nextRandom(ai.rng) < clamp01(FEINT_CHANCE + FEINT_SKILL * (ai.racecraft - 0.85))) {
        ai.attackPhase = 'feint';
        ai.feintSide = -ai.attackSide;
        ai.feintRef = lineOffset(track, a.ahead);
        ai.trickCooldown = TRICK_COOLDOWN;
      }
    }
  }
  if (ai.attackPhase === 'feint') {
    // bitten: it has moved across toward the side shown — or has started that move (we see it turn)
    const moved = lineOffset(track, a.ahead) - ai.feintRef;
    const d = a.ahead.ai;
    const covering = a.ahead.playerIndex === -1 && d.mode === 'defend' && d.defendTimer > 0 ? d.defendOffset - op.lateral : 0;
    const bitten = (moved + covering) * ai.feintSide > FEINT_BITE;
    if (bitten && room(a, -ai.feintSide)) {
      // it moved across to cover the side shown: go the other way
      ai.attackSide = -ai.feintSide;
      ai.feints++;
      credit(ai, a.ahead.id, 'feint');
      ai.attackPhase = 'commit';
      ai.phaseTimer = 0;
    } else if (ai.phaseTimer > FEINT_TIME || Math.abs(a.kBrake) >= ATTACK_CORNER || !room(a, ai.feintSide)) {
      // no bite (or no time left before the corner): the move goes the planned way
      ai.attackPhase = 'commit';
      ai.phaseTimer = 0;
    } else {
      plan.lateral = clamp(op.lateral + ai.feintSide * FEINT_SHOW, -a.edge, a.edge);
      plan.rate = 2.8;
      plan.overtake = straight && a.gap < 35;
      ai.attackTimer = Math.max(ai.attackTimer, 1);
      return true;
    }
  }
  // commit: alongside on the attack side
  if (ai.phaseTimer > COMMIT_MAX) return endAttack(ai, ATTACK_COOLDOWN);
  if (startSwitchback(track, car, a, ctx, false)) return switchback(track, car, a, plan, ctx);
  plan.lateral = sideTarget(a, ai.attackSide);
  plan.rate = 2.8;
  plan.overtake = straight && a.gap < 35;
  // still gaining (or nose to tail): keep the move going
  if (ai.closing > 0.3 || a.gap < 3) ai.attackTimer = Math.max(ai.attackTimer, 1);
  return true;
}

/**
 * Switch to a switchback for the corner ahead (rolled once per corner and attack), close behind / alongside a defender
 * that has dived off its line toward the inside (its exit will be slow and wide): `blocked` = our side (the inside)
 * is covered; otherwise only on the outside of it with its nose at least level with our mid-point (it has the corner).
 */
function startSwitchback(track: BuiltTrack, car: CarEntry, a: AttackEnv, ctx: TrafficContext, blocked: boolean): boolean {
  const ai = car.ai;
  if (a.forced || ctx.openingLap || ai.trickCooldown > 0 || a.gap > SWITCHBACK_RANGE) return false;
  if (Math.abs(a.kBrake) < ATTACK_CORNER) return false;
  const c = cornerAhead(track, car.phys.s);
  const corner = track.corners[c];
  if (!corner || c === ai.switchCorner || forwardDistance(track, car.phys.s, corner.apexS) > a.brakeRange + 60) return false;
  const dir = corner.direction;
  if (lineOffset(track, a.ahead) * dir < SWITCHBACK_DIVE) return false;
  // not where the outside of this corner is the inside of the next one (a chicane, esses): stay out there
  const next = track.corners[(c + 1) % track.corners.length];
  if (next !== corner && next.direction !== dir && forwardDistance(track, corner.endS, next.startS) < SWITCHBACK_STRAIGHT) return false;
  const half = (car.spec.length + a.ahead.spec.length) / 2;
  const outside = ai.attackSide === -dir && signedDeltaS(track, car.phys.s, a.ahead.phys.s) > -half * 0.5;
  if (!(blocked && ai.attackSide === dir) && !outside) return false;
  ai.switchCorner = c;
  if (nextRandom(ai.rng) >= clamp01(SWITCHBACK_CHANCE + SWITCHBACK_SKILL * (ai.racecraft - 0.85))) return false;
  ai.attackPhase = 'switchback';
  ai.phaseTimer = 0;
  ai.trickCooldown = TRICK_COOLDOWN;
  ai.attackTimer = Math.max(ai.attackTimer, 1);
  return true;
}

/**
 * Switchback on corner `switchCorner`: up to the apex lift a little early, staying SWITCHBACK_GAP m behind the
 * defender, on our own (wider) line; from the apex cut back to the inside of it as its exit runs wide and carry on
 * alongside (commit).
 */
function switchback(track: BuiltTrack, car: CarEntry, a: AttackEnv, plan: TrafficPlan, ctx: TrafficContext): boolean {
  const ai = car.ai;
  const corner = track.corners[ai.switchCorner];
  if (!corner || ai.phaseTimer > SWITCHBACK_TIME || a.gap > 30) return endAttack(ai, ATTACK_COOLDOWN);
  const s = car.phys.s;
  ai.attackTimer = Math.max(ai.attackTimer, 1);
  if (inRangeS(track, s, corner.apexS, corner.endS + 80)) {
    const inside = corner.direction;
    if (room(a, inside) && a.gap < 15) {
      // its exit runs wide: cut back under it
      ai.attackSide = inside;
      ai.attackPhase = 'commit';
      ai.phaseTimer = 0;
      ai.switchbacks++;
      credit(ai, a.ahead.id, 'switchback');
      plan.lateral = sideTarget(a, inside);
      plan.rate = 3;
    }
    return true;
  }
  if (!inRangeS(track, s, corner.startS - a.brakeRange - 60, corner.apexS)) return endAttack(ai, ATTACK_COOLDOWN);
  // into the corner: never closer than SWITCHBACK_GAP to it (whatever the line) — still alongside or that close,
  // a little off the throttle early to drop in behind it
  const gMin = SWITCHBACK_GAP + 0.03 * a.vMe;
  const decel = Math.max(5, a.brakeDecel * 0.9);
  const behind =
    a.gap < gMin ? Math.max(0, a.vO - (gMin - a.gap) * 1.2) : Math.sqrt(Math.max(0, a.vO) ** 2 + 2 * decel * (a.gap - gMin));
  plan.speedLimit = Math.min(plan.speedLimit, behind);
  if (a.gap < gMin) plan.speedLimit = Math.min(plan.speedLimit, ctx.trackSpeed * (1 - SWITCHBACK_LIFT));
  return true;
}

/**
 * Holding a place against a car closing in right behind: one move per straight to cover the inside of the next corner
 * (on a long straight: the side the attacker shows), held into the braking zone — at the price of a slower line into
 * the corner. Never a late move: not when the attacker would reach us within a second (`closing` = its speed
 * advantage, m/s), nor toward the side it shows within DEFEND_REACH s; never started under braking (`braking` = in
 * the braking zone of the corner ahead) nor into a car ahead in that lane. `kNext` = strongest curvature of the
 * coming corner.
 */
function defend(
  world: WorldState,
  track: BuiltTrack,
  car: CarEntry,
  threat: CarEntry,
  threatDs: number,
  closing: number,
  vMe: number,
  kNext: number,
  edge: number,
  plan: TrafficPlan,
  kAhead: number,
  braking: boolean,
): void {
  const ai = car.ai;
  if (ai.defendTimer > 0 || ai.defendCooldown > 0) return;
  const gap = -threatDs - car.spec.length;
  if (gap < 2 || gap > 10 + 0.25 * vMe || Math.abs(kAhead) > TIGHT_CORNER) return;
  if (closing > 0 && gap < closing) return;
  // never started under braking (for the corner ahead, or for a car ahead)
  if (braking || car.phys.brake > DEFEND_BRAKE) return;
  const corner = Math.abs(kNext) > 1 / 300;
  // on a straight: cover the side the attacker shows (relative to the racing line), once it shows one
  const shown = lineOffset(track, threat) - lineOffset(track, car);
  if (!corner && Math.abs(shown) < SHOW_SIDE) return;
  if (ai.aggression * ai.racecraft < 0.3 || nextRandom(ai.rng) > 0.02 + 0.03 * ai.aggression) return;
  // one move per straight: none made yet for the corner it leads to
  const next = nextCorner(track, car.phys.s);
  if (next >= 0 && next === ai.defendCorner) return;
  const lat = car.phys.lateral;
  const side = corner ? Math.sign(kNext) : shown > 0 ? 1 : -1;
  // toward the side it already shows: only while it is still DEFEND_REACH s away (no chopping across its nose)
  if (Math.abs(shown) >= SHOW_SIDE && Math.sign(shown) === side && closing > 0 && gap < closing * DEFEND_REACH) return;
  // covering the inside: toward half the road on that side, at most 3 m in one move (never away from it)
  const move = corner ? clamp(side * edge * 0.5 - lat, side > 0 ? 0 : -3, side > 0 ? 3 : 0) : side * 1.3;
  const cover = clamp(lat + move, -edge, edge);
  // never into a car ahead in that lane (a slower car there would be hit before the move is done)
  if (laneTaken(world, track, car, cover, vMe)) return;
  ai.defendOffset = cover;
  ai.defendSide = side;
  ai.defendTimer = 2.5;
  ai.defendCooldown = 6;
  ai.defendCorner = next;
  ai.mode = 'defend';
  plan.lateral = ai.defendOffset;
  // statistics: a move started while on the brakes would break the rule above
  if (car.phys.brake > DEFEND_BRAKE) ai.defendViolations++;
}
