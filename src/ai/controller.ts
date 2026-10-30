/**
 * AI driving controller: start reaction, pure-pursuit steering on the racing line (blended toward the kerb-use line
 * by kerb skill, plus tactical offsets from racecraft), look-ahead braking from the car's own capability (with its
 * trail braking), pace mode, throttle/brake PI with anti-windup, consistency noise, rare mistakes and natural
 * self-correcting mistakes (late braking that runs wide, early throttle that steps the rear out), and stuck recovery
 * (reverse out, then rejoin). Pure logic; mutates only `car.ai`.
 */
import type { AIState, BuiltTrack, CarEntry, ControlInput, WorldState } from '../core/types';
import type { AIMistake } from './types';
import { AIR_DENSITY, angleDiff, clamp, clamp01, moveToward, nextRandom, worldToLocal } from '../core/math';
import { isCarHeld, steerInputForAngle, tyreGrip } from '../physics/index';
import { forwardDistance, inRangeS, pitLaneOffsetAt, pitRampLength, pitZoneLength, poseAt, sampleAt } from '../track/track';
import { PACE_MODE_FACTOR, difficulty01, wetBrakeFactor, wetMistakeFactor, wetPaceFactor, wetTechnique } from './pace';
import { brakingDecel, capability, kerbLineAt, kerbReachAt, lineCurvatureAt, targetSpeedAt, type SpeedProbe } from './profile';
import { neutralPlan } from './neutral';
import { aeroWake } from '../race/wake';
import { EDGE_MARGIN, TRAIN_DRS_KEEP, planTraffic } from './traffic';

/** A control input with every field neutral. */
export function neutralInput(): ControlInput {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    shiftUp: false,
    shiftDown: false,
    drsPressed: false,
    ersCycle: false,
    limiterToggle: false,
    overtakeHeld: false,
  };
}

const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/** Racing within this interval (s) of the car ahead an AI pushes: up to CHASE_PUSH more grip / braking used. */
const CHASE_GAP = 1.5;
const CHASE_PUSH = 0.015;

/** Derating of the aero (speed²) part of the lateral grip the AI plans with. */
const HIGH_SPEED_MARGIN = 0.92;

/**
 * Natural mistakes (races from lap 2, green flag, not mid-attack), rolled once per corner: chance =
 * (1 − consistency) × NATURAL_MISTAKE × (1.6 − difficulty) × pressure × (1 + WET_MISTAKE·wetness) × wetMistakeFactor.
 * ≈ 0.6 % a corner for a mid-field driver in the dry (one every ~9 laps), ≈ 3 % for a poor wet driver in heavy rain.
 */
const NATURAL_MISTAKE = 0.08;
/** Everyone errs more on a wet track. */
const WET_MISTAKE = 1.5;
/** Pressure: chasing the car ahead (CHASE_GAP) / a car behind within CHASED_GAP s. */
const CHASE_PRESSURE = 1.5;
const CHASED_GAP = 1;
const CHASED_PRESSURE = 1.3;
/** Share of natural mistakes that are late braking (the rest: early throttle). */
const LATE_BRAKE_SHARE = 0.6;
/**
 * Late braking: the braking point moves 4–9 % later; from turn-in the line opens LATE_BRAKE_WIDE m toward the outside
 * (the speed plan follows that tighter path) and the target speed drops LATE_BRAKE_LIFT, for LATE_BRAKE_TIME s.
 */
const LATE_BRAKE_EXTRA = 0.04;
const LATE_BRAKE_WIDE = 1.5;
const LATE_BRAKE_LIFT = 0.03;
const LATE_BRAKE_TIME = 1.8;
/**
 * Early throttle: from the apex at least EARLY_THROTTLE (still under the slide cut) for up to EARLY_THROTTLE_TIME s,
 * until the rear steps out past EARLY_THROTTLE_SLIP (the slide catch then corrects it).
 */
const EARLY_THROTTLE = 0.8;
const EARLY_THROTTLE_TIME = 0.6;
const EARLY_THROTTLE_SLIP = 0.07;

/**
 * Trail braking in full within TRAIL_ON_LINE m of the driver's intended path, none beyond TRAIL_OFF_LINE m (mid
 * correction) or above TRAIL_SLIDE (rad) rear slip.
 */
const TRAIL_ON_LINE = 0.5;
const TRAIL_OFF_LINE = 1.5;
const TRAIL_SLIDE = 0.06;

/**
 * Pace mode push only with no car within PUSH_CLEAR s ahead (nor CHASE_GAP s behind) — except a push for a pit-stop
 * move (pitMovePush), which is about the stop, not about catching a car.
 */
const PUSH_CLEAR = 3;
/** Pace mode push: hold the ERS overtake mode on straights while the battery is above this charge. */
const PUSH_ERS_CHARGE = 0.5;
/**
 * Pace mode conserve: lift off when braking is due within LIFT_COAST s (coast into the braking zone). Most of the slip
 * work that wears the tyres is drive slip, so this — not the −1.5 % corner / braking use alone (≈ −0.5 % wear) —
 * is what saves them: ≈ −3.5…−5.6 % stint wear for ≈ +0.3…0.7 % lap time (Monza soft / Silverstone medium, 3 laps).
 */
const LIFT_COAST = 0.5;

/**
 * Line wander (m): the slowly varying line noise spans ± (1 − consistency) × 1.6 + LINE_FREEDOM × lineFreedom, so
 * cars in a queue do not all sit on exactly the same line.
 */
const LINE_FREEDOM = 0.5;
/**
 * Race rhythm: every RHYTHM_PERIOD … RHYTHM_PERIOD + RHYTHM_SPREAD s the driver's corner / braking use drifts (at
 * RHYTHM_RATE per s) toward a new level within ± RHYTHM_MAX × (0.25 + 0.75 × volatility) — ≈ ±0.2 % lap time for a
 * steady star, ±0.4 % for an erratic driver — so gaps open and close during a race instead of freezing.
 */
const RHYTHM_MAX = 0.016;
const RHYTHM_PERIOD = 20;
const RHYTHM_SPREAD = 40;
const RHYTHM_RATE = 0.004;

/** Per-step scratch (driveAI is not re-entrant): the lift-and-coast read-out of the speed plan, kerb reach. */
const LIFT_PROBE: SpeedProbe = { ahead: 0, speed: 0 };
const KERB_HERE = { left: 0, right: 0 };
const KERB_AHEAD = { left: 0, right: 0 };

/** Pure-pursuit look-ahead distance (m) for a speed. */
export function lookaheadDistance(speed: number): number {
  return clamp(7 + 0.42 * Math.abs(fin(speed)), 8, 48);
}

/** Grip multiplier the car has right now (tyre × rubber × performance), as used by the physics. */
export function carGripScale(car: CarEntry, wetness: number, rubber: number, performance: number): number {
  const t = car.phys.tire;
  const tyre = tyreGrip(t.compound, t.wear, t.temp, wetness);
  return tyre * (1 + 0.03 * clamp01(fin(rubber))) * (1 + (clamp(fin(performance, 1), 0.5, 1.5) - 1) * 0.6);
}

/** Wheel angle (rad, + right) that steers the car toward a world point with pure pursuit. */
export function pursuitAngle(car: CarEntry, x: number, z: number): number {
  const p = car.phys;
  const loc = worldToLocal(p.yaw, x - p.x, z - p.z);
  const dist = Math.max(1, Math.hypot(loc.right, loc.forward));
  const alpha = Math.atan2(loc.right, loc.forward);
  const curvature = (2 * Math.sin(alpha)) / dist;
  return Math.atan(curvature * car.spec.wheelbase);
}

/** Steering input toward a lateral offset at the look-ahead point (shared by AI and scripted drivers). */
export function steerToward(car: CarEntry, track: BuiltTrack, lateral: number, lookahead?: number): number {
  const p = car.phys;
  const ld = lookahead ?? lookaheadDistance(p.speed);
  const target = poseAt(track, p.s + ld, lateral);
  const angle = pursuitAngle(car, target.x, target.z);
  return steerInputForAngle(car.spec, p.speed, angle);
}

/** Racing within CHASE_GAP of the car ahead (from lap 2; not while neutralised or in the pit lane). */
function chasing(world: WorldState, car: CarEntry): boolean {
  const t = car.timing;
  return (
    world.config.kind === 'race' &&
    world.session.phase === 'running' &&
    world.session.control.mode === 'green' &&
    car.pit.phase === 'none' &&
    t.lapsCompleted >= 1 &&
    t.position > 1 &&
    t.interval > 0 &&
    t.interval < CHASE_GAP
  );
}

/** A car right behind (next position, within CHASED_GAP s) — racing from lap 2 under green. */
function chased(world: WorldState, car: CarEntry, within = CHASED_GAP): boolean {
  const pos = car.timing.position;
  // the race order lists the car ids by position: the next one is the car behind (scan only if it is out of step)
  const id = world.race.order[pos];
  let o: CarEntry | undefined = id === undefined ? undefined : world.cars[id];
  if (!o || o === car || o.timing.position !== pos + 1) o = world.cars.find((c) => c !== car && c.timing.position === pos + 1);
  return o !== undefined && o.status === 'running' && o.pit.phase === 'none' && o.timing.interval > 0 && o.timing.interval < within;
}

/**
 * The strategy's push is for a pit-stop move: the in-lap (boxing at the coming entry) and out-lap (within a lap of
 * the stop) of an undercut or cover, or an overcut being run. Gaining time on that lap is the point, so it is not held
 * back for clean air (PUSH_CLEAR) — with a car right behind it is exactly the car to keep behind.
 */
function pitMovePush(car: CarEntry, track: BuiltTrack): boolean {
  const ai = car.ai;
  if (ai.overcutLaps > 0) return true;
  if (ai.pitCall !== 'undercut' && ai.pitCall !== 'cover') return false;
  return car.pit.requested || car.timing.progress - ai.stintStartProgress < track.length;
}

/**
 * Chance (per corner) of a natural mistake: consistency, difficulty, pressure (chasing / chased, ≥ 1), wetness and
 * wet skill.
 */
export function naturalMistakeChance(ai: AIState, wetness: number, pressure = 1): number {
  const w = clamp01(fin(wetness));
  const p = Math.max(1, fin(pressure, 1));
  const base = (1 - clamp01(ai.consistency)) * NATURAL_MISTAKE * (1.6 - difficulty01(ai.difficulty));
  return clamp01(base * p * (1 + WET_MISTAKE * w) * wetMistakeFactor(w, ai.wetSkill));
}

/** Natural mistakes happen in green-flag racing from lap 2 (not in the pack start, the pit lane or mid-attack). */
function mistakesAllowed(world: WorldState, car: CarEntry): boolean {
  const ai = car.ai;
  return (
    world.config.kind === 'race' &&
    world.session.phase === 'running' &&
    world.session.control.mode === 'green' &&
    car.status === 'running' &&
    car.pit.phase === 'none' &&
    car.timing.lapsCompleted >= 1 &&
    ai.mode !== 'attack' &&
    ai.mode !== 'recover' &&
    !ai.failing &&
    ai.crashTimer <= 0
  );
}

/**
 * Draw a natural mistake at `chance` from the car's own stream (always two draws, so the stream order never depends
 * on the outcome): the kind (or 'none') and a 0..1 size.
 */
export function drawNaturalMistake(ai: AIState, chance: number): { kind: AIMistake; size: number } {
  const roll = nextRandom(ai.rng);
  const size = nextRandom(ai.rng);
  const p = clamp01(fin(chance));
  return { kind: roll < p * LATE_BRAKE_SHARE ? 'lateBrake' : roll < p ? 'earlyThrottle' : 'none', size };
}

/** Roll a natural mistake for the corner `next` (draws from the car's stream only when one can happen). */
function rollMistake(world: WorldState, car: CarEntry, next: number): void {
  const ai = car.ai;
  if (ai.mistakeKind !== 'none' || ai.mistakeTimer > 0 || !mistakesAllowed(world, car)) return;
  const pressure = (chasing(world, car) ? CHASE_PRESSURE : 1) * (chased(world, car) ? CHASED_PRESSURE : 1);
  const { kind, size } = drawNaturalMistake(ai, naturalMistakeChance(ai, world.weather.wetness, pressure));
  if (kind === 'none') return;
  ai.mistakeKind = kind;
  if (kind === 'lateBrake') ai.brakeNoise *= 1 + LATE_BRAKE_EXTRA + 0.05 * size;
  ai.mistakeCorner = next;
  ai.mistakeActive = 0;
  ai.mistakeCount += 1;
}

/** Start (at turn-in / the apex), run down or drop the planned natural mistake. */
function stepMistake(track: BuiltTrack, car: CarEntry, dt: number): void {
  const ai = car.ai;
  if (ai.mistakeKind === 'none') return;
  const c = track.corners[ai.mistakeCorner];
  if (!c || ai.mode === 'recover' || ai.failing || ai.crashTimer > 0 || car.pit.phase !== 'none') {
    ai.mistakeKind = 'none';
    ai.mistakeActive = 0;
    return;
  }
  if (ai.mistakeActive > 0) {
    ai.mistakeActive = Math.max(0, ai.mistakeActive - dt);
    if (ai.mistakeActive === 0) ai.mistakeKind = 'none';
    return;
  }
  const s = car.phys.s;
  const late = ai.mistakeKind === 'lateBrake';
  if (inRangeS(track, s, late ? c.startS : c.apexS, c.endS)) ai.mistakeActive = late ? LATE_BRAKE_TIME : EARLY_THROTTLE_TIME;
  // not approaching that corner any more (passed it, reset elsewhere): the chance has gone
  else if (!inRangeS(track, s, c.startS - 400, c.endS)) ai.mistakeKind = 'none';
}

function updateNoise(world: WorldState, car: CarEntry, track: BuiltTrack, dt: number): void {
  const ai = car.ai;
  if (world.config.kind === 'race') {
    ai.rhythmTimer -= dt;
    if (ai.rhythmTimer <= 0) {
      const amp = RHYTHM_MAX * (0.25 + 0.75 * clamp01(ai.volatility));
      ai.rhythmTarget = 1 + (nextRandom(ai.rng) * 2 - 1) * amp;
      ai.rhythmTimer = RHYTHM_PERIOD + nextRandom(ai.rng) * RHYTHM_SPREAD;
    }
    ai.rhythm = moveToward(ai.rhythm, ai.rhythmTarget, RHYTHM_RATE * dt);
  }
  ai.noiseTimer -= dt;
  if (ai.noiseTimer <= 0) {
    const amp = (1 - ai.consistency) * 1.6 + LINE_FREEDOM * clamp01(ai.lineFreedom);
    ai.lineNoiseTarget = (nextRandom(ai.rng) * 2 - 1) * amp;
    ai.noiseTimer = 2 + nextRandom(ai.rng) * 3;
  }
  ai.lineNoise = moveToward(ai.lineNoise, ai.lineNoiseTarget, 0.25 * dt);
  if (ai.mistakeTimer > 0) ai.mistakeTimer = Math.max(0, ai.mistakeTimer - dt);

  // roll braking-point noise (and rarely a mistake) once per corner approach
  const corners = track.corners;
  if (corners.length === 0) return;
  let next = -1;
  let best = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const d = forwardDistance(track, car.phys.s, corners[i].startS);
    if (d < best) {
      best = d;
      next = i;
    }
  }
  if (next < 0 || best > 350 || next === ai.noiseCorner) return;
  ai.noiseCorner = next;
  const spread = (1 - ai.consistency) * 0.22;
  ai.brakeNoise = 1 + (nextRandom(ai.rng) * 2 - 1) * spread;
  // pushing to catch the car ahead costs some consistency
  const mistakeChance = (1 - ai.consistency) * 0.045 * (1.6 - difficulty01(ai.difficulty)) * (chasing(world, car) ? 1.5 : 1);
  if (nextRandom(ai.rng) < mistakeChance) {
    ai.brakeNoise = 1.1 + nextRandom(ai.rng) * 0.06;
    ai.mistakeTimer = 2.5;
  }
  rollMistake(world, car, next);
}

/** Reverse-out recovery for a car stuck (against a wall / facing the wrong way). */
function recoveryInput(car: CarEntry, track: BuiltTrack, dt: number, input: ControlInput): void {
  const ai = car.ai;
  const p = car.phys;
  ai.recoverTimer += dt;
  const headingIdx = p.trackIndex >= 0 && p.trackIndex < track.count ? p.trackIndex : 0;
  const heading = Math.atan2(track.tx[headingIdx], track.tz[headingIdx]);
  // + = the track direction is at a larger yaw than the nose
  const err = angleDiff(p.yaw, heading);
  if (ai.recoverTimer < 1.2 && p.gear !== -1) {
    // hold the brake at standstill: the gearbox engages reverse after REVERSE_HOLD_TIME
    input.brake = 1;
    ai.recoverDist = 0;
    return;
  }
  if (p.gear === -1 && ai.recoverTimer < 4) {
    ai.recoverDist += Math.abs(fin(p.vLong)) * dt;
    // reversing: steering toward the error rotates the nose toward the track direction
    input.throttle = 0.35;
    input.steer = clamp(err * 2, -1, 1);
    const hw = sampleAt(track, track.halfWidth, p.s);
    const aligned = Math.abs(err) < 0.5 && Math.abs(p.lateral) < hw + 1;
    if (ai.recoverDist < 6 && !(aligned && ai.recoverDist > 2)) return;
  }
  input.shiftUp = p.gear === -1;
  input.brake = p.gear === -1 ? 0.6 : 0;
  ai.mode = 'race';
  ai.recoverTimer = 0;
  ai.recoverDist = 0;
  ai.stuckTimer = 0;
}

/** Compute this step's controls for an AI car. */
/** Pit visit driven by the controller itself (no pit assist): the entry road down to the limit at the line, the lane
 * at just under the limit with the limiter on, the exit road back up to speed. */
const MANUAL_PIT_MARGIN = 1;
const MANUAL_PIT_DECEL = 14;
const MANUAL_PIT_LOOK = 14;
function manualPitInput(car: CarEntry, track: BuiltTrack, input: ControlInput): void {
  const p = car.phys;
  const ramp = pitRampLength(track);
  const zone = pitZoneLength(track);
  const d = forwardDistance(track, track.pit.entry, p.s);
  const lane = Math.max(5, track.pit.speedLimit - MANUAL_PIT_MARGIN);
  const target =
    d < ramp ? Math.max(lane, Math.sqrt(lane * lane + 2 * MANUAL_PIT_DECEL * Math.max(0, ramp - d - 8))) : d < zone - ramp ? lane : 60;
  const lat = pitLaneOffsetAt(track, p.s + MANUAL_PIT_LOOK) ?? p.lateral;
  const err = target - p.speed;
  input.steer = clamp(steerToward(car, track, lat, MANUAL_PIT_LOOK), -1, 1);
  input.throttle = err > 0 ? Math.min(1, err * 0.6 + 0.1) : 0;
  input.brake = err < -0.3 ? Math.min(1, -err * 0.4) : 0;
  input.limiterToggle = !p.limiter && d > ramp * 0.5 && d < zone - ramp;
}

export function driveAI(world: WorldState, car: CarEntry, track: BuiltTrack, dt: number): ControlInput {
  const input = neutralInput();
  const ai = car.ai;
  const p = car.phys;
  const spec = car.spec;
  const h = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.05) : 0;
  const phase = world.session.phase;
  if (car.status === 'retired' || track.count < 4) {
    input.brake = 1;
    return input;
  }
  if (phase === 'pre' || phase === 'lights' || (isCarHeld(p) && car.status === 'grid')) {
    ai.launchTimer = 0;
    input.throttle = phase === 'lights' ? 0.55 : 0.15;
    return input;
  }
  ai.launchTimer += h;
  if (world.config.kind === 'race' && ai.launchTimer < ai.reaction && car.timing.lapsCompleted === 0 && p.speed < 1) {
    input.throttle = 0.6;
    input.brake = 1;
    return input;
  }
  if (ai.crashTimer > 0) {
    // forced spin (race-control incident): no throttle, no counter-steer
    ai.crashTimer = Math.max(0, ai.crashTimer - h);
    input.brake = 0.8;
    return input;
  }
  if (ai.mode === 'recover') {
    recoveryInput(car, track, h, input);
    return input;
  }
  // a driver-driven pit visit (a human car on the AI controller: autopilot): the lane at the limit, limiter on
  if (car.pit.phase !== 'none' && car.race.pitManual && !car.race.pitAuto) {
    manualPitInput(car, track, input);
    return input;
  }

  const weather = world.weather;
  const v = Math.max(0, fin(p.speed));
  updateNoise(world, car, track, h);
  stepMistake(track, car, h);
  const mistakeCorner = ai.mistakeActive > 0 ? track.corners[ai.mistakeCorner] : undefined;
  const runWide = mistakeCorner !== undefined && ai.mistakeKind === 'lateBrake';
  const earlyThrottle = mistakeCorner !== undefined && ai.mistakeKind === 'earlyThrottle';

  // capability-based target speed
  const dmg = p.damage;
  // (a bent suspension costs up to 8 % grip: ≈ 4 % cornering speed)
  const damageFactor =
    1 - 0.28 * clamp01(dmg.frontWing) - 0.16 * clamp01(dmg.rearWing) - 0.12 * clamp01(dmg.floor) - 0.04 * clamp01(fin(dmg.suspension));
  const wetF = wetPaceFactor(weather.wetness, ai.wetSkill);
  // trail braking and kerb use fade on a wet track (faster for a poor wet driver)
  const wetT = wetTechnique(weather.wetness, ai.wetSkill);
  const kerbUse = ai.kerbSkill * wetT;
  const offPenalty = 1 - 0.01 * Math.min(4, Math.abs(ai.offset));
  const cooldown = car.status === 'finished';
  // chasing the car ahead: push harder (more aggressive drivers push more)
  const push = chasing(world, car) ? 1 + CHASE_PUSH * (0.5 + 0.5 * ai.aggression) : 1;
  // following a DRS train it cannot pass: conserve while within DRS range (beyond it the standard pace closes back in)
  const gap = car.timing.interval;
  const wanted = ai.inTrain && ai.paceMode === 'standard' && gap > 0 && gap < TRAIN_DRS_KEEP ? 'conserve' : ai.paceMode;
  // pushing is for clean air (PUSH_CLEAR): closing in on a car it arrives too fast (and chasing it the chase push
  // replaces it), and with a car chasing us it would take that car's edge away (−17 % overtakes in 32 short races) —
  // but a pit-stop move pushes regardless (within CHASE_GAP of the car ahead the chase push still stands in for it)
  const pushOk =
    wanted === 'push' &&
    push === 1 &&
    (pitMovePush(car, track) || ((car.timing.position === 1 || !(gap > 0) || gap > PUSH_CLEAR) && !chased(world, car, CHASE_GAP)));
  const paceMode = wanted === 'push' && !pushOk ? 'standard' : wanted;
  const modeF = PACE_MODE_FACTOR[paceMode] ?? 1;
  const latF = Math.min(1, ai.latFactor * push * modeF * ai.rhythm) * wetF * damageFactor * offPenalty * (ai.mistakeTimer > 0 ? 1.02 : 1);
  // attacking: brake a little later (late-braking move) — not when dropping back for a switchback
  const lateBrake = ai.mode === 'attack' && ai.attackPhase !== 'switchback' ? 1.05 : 1;
  const wetBrake = wetBrakeFactor(weather.wetness, ai.wetSkill);
  const brkF = Math.min(0.97, ai.brakeFactor * push * modeF * ai.rhythm * wetF * wetBrake * ai.brakeNoise * lateBrake);
  const grip = carGripScale(car, weather.wetness, weather.rubber, ai.performance);
  // trail braking needs the car on its intended path (line + tactical offset): it fades out over TRAIL_OFF_LINE m
  // off it (a big correction under braking already loads the tyres sideways) and while the rear slides
  const offLine = Math.abs(p.lateral - kerbLineAt(track, p.s, kerbUse) - ai.offset - ai.lineNoise);
  const sliding = Math.abs(fin(p.slipAngleRear)) > TRAIL_SLIDE;
  const trail = sliding ? 0 : ai.trail * wetT * clamp01((TRAIL_OFF_LINE - offLine) / (TRAIL_OFF_LINE - TRAIL_ON_LINE));
  // in a car's dirty air the corners are slower (and its tow makes the straights quicker)
  const cap = capability(spec, grip, p.fuelKg, latF, brkF, aeroWake(world, track, car), trail);
  // keep extra margin in fast corners: steering authority is tiny at speed, so a slide there cannot be caught
  cap.latB *= HIGH_SPEED_MARGIN;
  // the driver's style: stronger in slow or in fast corners
  cap.latA *= ai.gripLow;
  cap.latB *= ai.gripHigh;
  // conserving: whether braking is due within LIFT_COAST s on the racing line (lift and coast, below) — read off this
  // plan when it is that plan (on the line, no cool-down scale), else from a scan of its own
  const offNow = ai.offset + ai.lineNoise;
  const lift = paceMode === 'conserve' && !cooldown && !(Math.abs(offNow) > 0.3) ? LIFT_PROBE : undefined;
  if (lift) lift.ahead = v * (LIFT_COAST - h * 2);
  let target = targetSpeedAt(track, cap, p.s + v * h * 2, v, cooldown ? 0.78 : 1, offNow, kerbUse, lift);
  // a late-braking mistake: lift to gather the car up while running wide
  if (runWide) target *= 1 - LATE_BRAKE_LIFT;

  // tactical lateral plan (the path edge widens where the driver's own kerb-use line runs over a kerb)
  const ld = lookaheadDistance(v);
  const sAhead = p.s + ld;
  const hwAhead = sampleAt(track, track.halfWidth, sAhead);
  const edgeAhead = Math.max(0.5, hwAhead - EDGE_MARGIN);
  const kerbAhead = kerbReachAt(track, sAhead, kerbUse, KERB_AHEAD);
  const kerbHere = kerbReachAt(track, p.s, kerbUse, KERB_HERE);
  const loAhead = -edgeAhead - kerbAhead.left;
  const hiAhead = edgeAhead + kerbAhead.right;
  const lineAhead = kerbLineAt(track, sAhead, kerbUse) + ai.lineNoise;
  const planned = clamp(lineAhead + ai.offset, loAhead, hiAhead);
  const neutral = neutralPlan(world, track, car);
  const traffic = planTraffic(world, car, track, {
    plannedLateral: planned,
    lookahead: ld,
    trackSpeed: target,
    brakeDecel: cap.brkA + cap.brkB * v * v,
    dt: h,
    openingLap: world.config.kind === 'race' && car.timing.lapsCompleted === 0,
    noOvertake: neutral.noOvertake,
    openingLapStart: world.config.kind === 'race' && car.timing.lapsCompleted === 0 && ai.launchTimer < 6,
    kerbLeft: Math.max(kerbHere.left, kerbAhead.left),
    kerbRight: Math.max(kerbHere.right, kerbAhead.right),
  });
  target = Math.min(target, traffic.speedLimit);
  target = Math.min(target * neutral.scale, neutral.cap);

  // pit request: line up on the pit side before the entry
  let desired = traffic.lateral;
  if (neutral.yieldSide !== 0) desired = neutral.yieldSide * edgeAhead * 0.85;
  if (car.pit.requested && car.pit.phase === 'none' && world.config.kind !== 'timeTrial') {
    const toEntry = forwardDistance(track, p.s, track.pit.entry);
    if (toEntry < 420) desired = track.pit.side * edgeAhead;
  }
  // a late-braking mistake on our own line: the line opens toward the outside of the corner (missed apex)
  const wide = runWide && desired === null && mistakeCorner ? -mistakeCorner.direction * LATE_BRAKE_WIDE : 0;
  const desiredOffset = desired === null ? wide : desired - lineAhead;
  ai.offset = moveToward(ai.offset, desiredOffset, (desired === null ? 3 : traffic.rate) * h);
  let lateral = clamp(lineAhead + ai.offset, loAhead, hiAhead);
  // space keeping applies to where the car is now; blend toward the band
  const lo = traffic.lo;
  const hi = traffic.hi;
  if (lateral < lo || lateral > hi) {
    const band = clamp(lateral, lo, hi);
    lateral = clamp(band, loAhead, hiAhead);
    ai.offset = lateral - lineAhead;
  }
  ai.targetLateral = lateral;

  // off the road: slow down and come back
  const hwHere = sampleAt(track, track.halfWidth, p.s);
  const offRoad = Math.abs(p.lateral) > hwHere + 0.6 && p.surface !== 'pitlane';
  if (offRoad) target = Math.min(target, p.surface === 'gravel' ? 22 : 32);

  // mechanical failure: coast off the road on the failing side and stop there
  if (ai.failing) {
    const hwFail = sampleAt(track, track.halfWidth, sAhead);
    lateral = ai.failSide * (hwFail + 1.5);
    // once off the road, stop quickly close to the edge
    const off = Math.abs(p.lateral) > hwHere + 0.8;
    target = v < 6 ? 0 : Math.max(0, v - (off ? 9 : 4));
  }

  // steering (pure pursuit)
  const aim = poseAt(track, sAhead, lateral);
  let angle = pursuitAngle(car, aim.x, aim.z);
  if (ai.mistakeTimer > 0) angle *= 0.97;
  // catch a sliding rear: counter-steer in the slide direction (same sign convention as the steering assist)
  const slideR = fin(p.slipAngleRear);
  const slideExcess = Math.abs(slideR) - Math.abs(fin(p.slipAngleFront)) - 0.02;
  if (slideExcess > 0 && Math.abs(slideR) > 0.05) angle += Math.sign(slideR) * Math.min(0.12, 0.8 * slideExcess);
  input.steer = steerInputForAngle(spec, v, angle);

  // pedals: brake feed-forward from the planned deceleration + P, throttle PI with anti-windup
  const err = target - v;
  if (err < -0.25) {
    const mass = spec.mass + Math.max(0, fin(p.fuelKg));
    const drag = (0.5 * AIR_DENSITY * spec.dragArea * v * v) / mass;
    const decel = brakingDecel(cap, v, lineCurvatureAt(track, p.s, kerbUse));
    const ff = clamp(((decel - drag) * mass) / Math.max(1, spec.maxBrakeForce), 0, 1);
    // never brake much harder than the friction circle allows on this (curved) sample: a hard stab mid-corner
    // unloads the rear and spins the car
    input.brake = clamp(ff + (-err - 0.25) * 0.3, 0.05, Math.min(1, ff * 1.35 + 0.08));
    // a sliding rear under braking: ease off so the rear can grip again
    if (slideExcess > 0.02 && Math.abs(slideR) > 0.07) input.brake *= 0.45;
    input.throttle = 0;
    ai.integral = 0;
  } else {
    const raw = 0.42 + err * 0.55 + ai.integral;
    if (raw > 0 && raw < 1) ai.integral = clamp(ai.integral + err * 0.9 * h, -0.4, 0.4);
    // traction: feed the throttle in while the rear is loaded laterally, back off when it starts to slide
    const latMax = cap.latA / Math.max(0.5, latF) + (cap.latB / Math.max(0.5, latF)) * v * v;
    const latUse = Math.abs(fin(p.gLat)) * 9.81 / Math.max(1, latMax);
    // above ~35 m/s a full lift would add lift-off oversteer; at low speed cut the drive almost completely
    const slideCap = clamp(1 - (Math.abs(slideR) - 0.055) * 10, v > 35 ? 0.3 : 0.05, 1);
    const loadCap = clamp(0.25 + (1 - latUse) * 2.6, 0.25, 1);
    input.throttle = clamp(Math.min(raw, slideCap, loadCap), 0, 1);
    if (earlyThrottle) {
      // an early-throttle mistake: hard on the power before the car is straight, until the rear steps out (the
      // slide cut above still applies, the slide catch corrects it)
      if (Math.abs(slideR) > EARLY_THROTTLE_SLIP) {
        ai.mistakeActive = 0;
        ai.mistakeKind = 'none';
      } else input.throttle = Math.max(input.throttle, Math.min(EARLY_THROTTLE, slideCap));
    }
  }
  // conserving: lift and coast into the braking zones (no drive slip, less braking — the tyres and fuel last longer)
  if (paceMode === 'conserve' && input.throttle > 0) {
    const ahead = lift ? lift.speed : targetSpeedAt(track, cap, p.s + v * LIFT_COAST, v, 1, 0, kerbUse);
    if (ahead < v - 0.5) input.throttle = 0;
  }
  // pushing: deploy the overtake mode on the straights while the battery allows
  const straight = Math.abs(lineCurvatureAt(track, p.s)) < 1 / 300 && Math.abs(lineCurvatureAt(track, sAhead)) < 1 / 300;
  const pushErs = paceMode === 'push' && straight && input.throttle > 0.9 && p.ers.charge > PUSH_ERS_CHARGE;
  input.overtakeHeld = (traffic.overtake || pushErs) && !neutral.noOvertake && p.ers.overtakeAvailable && p.ers.charge > 0.2;

  // stuck detection → recovery
  if (v < 1.5 && target > 5 && !isCarHeld(p)) {
    ai.stuckTimer += h;
    if (ai.stuckTimer > 1.4) {
      ai.mode = 'recover';
      ai.recoverTimer = 0;
    }
  } else {
    ai.stuckTimer = Math.max(0, ai.stuckTimer - h * 2);
  }
  return input;
}
