/**
 * AI driving controller: start reaction, pure-pursuit steering on the racing line (plus tactical offsets from
 * racecraft), look-ahead braking from the car's own capability, throttle/brake PI with anti-windup, consistency
 * noise and rare mistakes, and stuck recovery (reverse out, then rejoin). Pure logic; mutates only `car.ai`.
 */
import type { BuiltTrack, CarEntry, ControlInput, WorldState } from '../core/types';
import { AIR_DENSITY, angleDiff, clamp, clamp01, moveToward, nextRandom, worldToLocal } from '../core/math';
import { isCarHeld, steerInputForAngle, tyreGrip } from '../physics/index';
import { forwardDistance, poseAt, sampleAt } from '../track/track';
import { difficulty01, wetPaceFactor } from './pace';
import { brakingDecel, capability, lineCurvatureAt, targetSpeedAt } from './profile';
import { neutralPlan } from './neutral';
import { aeroWake } from '../race/wake';
import { EDGE_MARGIN, planTraffic } from './traffic';

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

function updateNoise(world: WorldState, car: CarEntry, track: BuiltTrack, dt: number): void {
  const ai = car.ai;
  ai.noiseTimer -= dt;
  if (ai.noiseTimer <= 0) {
    const amp = (1 - ai.consistency) * 1.6;
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

  const weather = world.weather;
  const v = Math.max(0, fin(p.speed));
  updateNoise(world, car, track, h);

  // capability-based target speed
  const dmg = p.damage;
  const damageFactor = 1 - 0.28 * clamp01(dmg.frontWing) - 0.16 * clamp01(dmg.rearWing) - 0.12 * clamp01(dmg.floor);
  const wetF = wetPaceFactor(weather.wetness, ai.wetSkill);
  const offPenalty = 1 - 0.01 * Math.min(4, Math.abs(ai.offset));
  const cooldown = car.status === 'finished';
  // chasing the car ahead: push harder (more aggressive drivers push more)
  const push = chasing(world, car) ? 1 + CHASE_PUSH * (0.5 + 0.5 * ai.aggression) : 1;
  const latF = Math.min(1, ai.latFactor * push) * wetF * damageFactor * offPenalty * (ai.mistakeTimer > 0 ? 1.02 : 1);
  // attacking: brake a little later (late-braking move)
  const lateBrake = ai.mode === 'attack' ? 1.05 : 1;
  const brkF = Math.min(0.97, ai.brakeFactor * push * wetF * ai.brakeNoise * lateBrake);
  const grip = carGripScale(car, weather.wetness, weather.rubber, ai.performance);
  // in a car's dirty air the corners are slower (and its tow makes the straights quicker)
  const cap = capability(spec, grip, p.fuelKg, latF, brkF, aeroWake(world, track, car));
  // keep extra margin in fast corners: steering authority is tiny at speed, so a slide there cannot be caught
  cap.latB *= HIGH_SPEED_MARGIN;
  let target = targetSpeedAt(track, cap, p.s + v * h * 2, v, cooldown ? 0.78 : 1, ai.offset + ai.lineNoise);

  // tactical lateral plan
  const ld = lookaheadDistance(v);
  const sAhead = p.s + ld;
  const hwAhead = sampleAt(track, track.halfWidth, sAhead);
  const edgeAhead = Math.max(0.5, hwAhead - EDGE_MARGIN);
  const lineAhead = sampleAt(track, track.racingLine, sAhead) + ai.lineNoise;
  const planned = clamp(lineAhead + ai.offset, -edgeAhead, edgeAhead);
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
  const desiredOffset = desired === null ? 0 : desired - lineAhead;
  ai.offset = moveToward(ai.offset, desiredOffset, (desired === null ? 3 : traffic.rate) * h);
  let lateral = clamp(lineAhead + ai.offset, -edgeAhead, edgeAhead);
  // space keeping applies to where the car is now; blend toward the band
  const lo = traffic.lo;
  const hi = traffic.hi;
  if (lateral < lo || lateral > hi) {
    const band = clamp(lateral, lo, hi);
    lateral = clamp(band, -edgeAhead, edgeAhead);
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
    const decel = brakingDecel(cap, v, lineCurvatureAt(track, p.s));
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
  }
  input.overtakeHeld = traffic.overtake && !neutral.noOvertake && p.ers.overtakeAvailable && p.ers.charge > 0.2;

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
