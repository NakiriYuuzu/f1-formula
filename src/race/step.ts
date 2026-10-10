/**
 * stepWorld orchestration, in this order each SIM_DT:
 * weather → session clock / start lights → per car (projection → input (human / AI; pit autopilot overrides) →
 * PhysicsEnv → physics → re-projection → barrier) → car-vs-car contacts → per car (pit-entry detection → timing →
 * track limits → AI stuck watchdog) → classification & gaps → DRS / overtake eligibility → session end →
 * AI pit strategy → radio.
 */
import type { BuiltTrack, CarEntry, ControlInput, TireCompound, WorldState } from '../core/types';
import { COMPOUNDS } from '../core/defaults';
import { clamp, forwardX, forwardZ } from '../core/math';
import { computeAIInput, decidePitStop, safetyCarCap } from '../ai/index';
import { isCarHeld, setCarHeld, stepCarPhysics } from '../physics/index';
import { indexAtS, poseAt, projectToTrack, sampleAt, signedDeltaS, wrapS } from '../track/track';
import { updateClassification } from './classification';
import { barrierContact, carContacts } from './contact';
import { updateDrs } from './drs';
import { buildEnv } from './env';
import { applyProjection, emit, inGarage, isHuman } from './events';
import { updateTrackLimits } from './limits';
import { engagePit, estimatePitLoss, gearForSpeed, pitLossFactor, shouldEngagePit, stepManualPit, stepPitLane } from './pitlane';
import { radioTeamHold, radioTeamYield, stepRadio } from './radio';
import { checkSessionEnd, mandatoryStopOpen, stepSessionClock } from './session';
import { stepRaceControl } from './control';
import { stepParking } from './gridPark';
import { updateCarTiming } from './timing';
import { stepWeather } from './weather';

/** Input used for a human car without input this step: coast with a light brake. */
const COAST_INPUT: Readonly<ControlInput> = Object.freeze({
  throttle: 0,
  brake: 0.15,
  steer: 0,
  shiftUp: false,
  shiftDown: false,
  drsPressed: false,
  ersCycle: false,
  limiterToggle: false,
  overtakeHeld: false,
});

/** An AI car that gains less than STUCK_PROGRESS metres in STUCK_RESET seconds is put back on the racing line. */
const STUCK_PROGRESS = 15;
const STUCK_RESET = 7;
/** Seconds continuously below 1 m/s after which an AI car is reset regardless of creeping progress. */
const SLOW_RESET = 6;
/** Speed (m/s) below which a finished (cool-down) AI car counts as stuck. */
const STUCK_SPEED = 2;
/** Safety-car limiter: throttle per m/s below the cap (as the pit limiter); brake per m/s above it and its maximum (as the
 * 'low' braking assist, so a car without ABS does not lock up). */
const SC_LIMITER_GAIN = 0.8;
const SC_LIMITER_BRAKE_GAIN = 1 / 8;
const SC_LIMITER_MAX_BRAKE = 0.6;

/**
 * Safety-car limiter assist: the human's speed is held at the queue speed (throttle cut, light braking when above it —
 * otherwise a late-braking driver still passes in the braking zones); steering stays manual and harder braking is allowed.
 */
function limitToSafetyCar(world: WorldState, track: BuiltTrack, car: CarEntry, input: ControlInput): ControlInput {
  const cap = safetyCarCap(world, track, car);
  if (!Number.isFinite(cap)) return input;
  const v = car.phys.speed;
  return {
    ...input,
    throttle: Math.min(input.throttle, clamp((cap - v) * SC_LIMITER_GAIN, 0, 1)),
    brake: Math.max(input.brake, clamp((v - cap) * SC_LIMITER_BRAKE_GAIN, 0, SC_LIMITER_MAX_BRAKE)),
  };
}

function stepCar(world: WorldState, track: BuiltTrack, car: CarEntry, inputs: readonly (ControlInput | null)[], dt: number): void {
  const p = car.phys;
  const r = car.race;
  r.prevX = p.x;
  r.prevY = p.y;
  r.prevZ = p.z;
  r.prevYaw = p.yaw;
  if (r.collisionCooldown > 0) r.collisionCooldown = Math.max(0, r.collisionCooldown - dt);
  if (car.status === 'retired' || inGarage(world, car)) {
    if (!isCarHeld(p)) setCarHeld(p, true);
    return;
  }
  // autopilot visits (and the box manoeuvre of a manual one) are kinematic; a manual visit is driven below
  const manualPit = car.pit.phase !== 'none' && r.pitManual && !r.pitAuto;
  if (car.pit.phase !== 'none' && !manualPit) {
    stepPitLane(world, track, car, dt);
    return;
  }
  if (r.parking) {
    stepParking(track, car, dt);
    return;
  }
  const proj = projectToTrack(track, p.x, p.z, p.trackIndex);
  applyProjection(car, proj);
  const human = isHuman(car) && !r.formationAuto;
  let input = human ? (inputs[car.playerIndex] ?? COAST_INPUT) : computeAIInput(world, car, track, dt);
  if (human && car.assists.scLimiter && car.status === 'running') input = limitToSafetyCar(world, track, car, input);
  const gearBefore = p.gear;
  const env = buildEnv(world, track, car);
  if (env.wake) r.wake = env.wake;
  stepCarPhysics(p, car.spec, input, env, dt);
  const after = barrierContact(world, track, car, projectToTrack(track, p.x, p.z, proj.index));
  applyProjection(car, after);
  if (isHuman(car) && p.gear !== gearBefore) emit(world, { type: 'shift', carId: car.id, gear: p.gear });
  if (manualPit) stepManualPit(world, track, car);
}

/**
 * Online client prediction: one step of a human car under `input` exactly as stepWorld drives it on the open road —
 * projection, safety-car limiter assist, PhysicsEnv, physics, re-projection and barrier contact — without the pit
 * lane, parking, other cars or timing (the host decides those). Events land in world.events as usual.
 */
export function predictHumanStep(world: WorldState, track: BuiltTrack, car: CarEntry, input: ControlInput, dt: number): void {
  const p = car.phys;
  const r = car.race;
  r.prevX = p.x;
  r.prevY = p.y;
  r.prevZ = p.z;
  r.prevYaw = p.yaw;
  if (r.collisionCooldown > 0) r.collisionCooldown = Math.max(0, r.collisionCooldown - dt);
  const proj = projectToTrack(track, p.x, p.z, p.trackIndex);
  applyProjection(car, proj);
  let inp = input;
  if (car.assists.scLimiter && car.status === 'running') inp = limitToSafetyCar(world, track, car, inp);
  const env = buildEnv(world, track, car);
  if (env.wake) r.wake = env.wake;
  stepCarPhysics(p, car.spec, inp, env, dt);
  const after = barrierContact(world, track, car, projectToTrack(track, p.x, p.z, proj.index));
  applyProjection(car, after);
}

/**
 * Put a stuck AI car back on track at low speed: the first free spot among the racing line / other lanes at its
 * current s, then up to 45 m further on (a stopped car or a queue behind it never traps it again).
 */
function resetCar(world: WorldState, track: BuiltTrack, car: CarEntry): void {
  const p = car.phys;
  const free = (s: number, lat: number): boolean =>
    !world.cars.some(
      (o) =>
        o !== car &&
        o.status !== 'retired' &&
        o.pit.phase === 'none' &&
        Math.abs(signedDeltaS(track, s, o.phys.s)) < 12 &&
        Math.abs(o.phys.lateral - lat) < 3.2,
    );
  let s = p.s;
  let lat = sampleAt(track, track.racingLine, s);
  search: for (const ahead of [0, 15, 30, 45]) {
    const at = wrapS(track, p.s + ahead);
    const edge = Math.max(0.5, sampleAt(track, track.halfWidth, at) - 1.3);
    const line = sampleAt(track, track.racingLine, at);
    for (const cand of [line, line - 3.5, line + 3.5, -edge, edge]) {
      const l = Math.max(-edge, Math.min(edge, cand));
      if (free(at, l)) {
        s = at;
        lat = l;
        break search;
      }
    }
  }
  const pose = poseAt(track, s, lat);
  const v = 8;
  const g = gearForSpeed(car.spec, v);
  p.x = pose.x;
  p.z = pose.z;
  p.y = pose.y;
  p.yaw = pose.yaw;
  p.vx = forwardX(pose.yaw) * v;
  p.vz = forwardZ(pose.yaw) * v;
  p.speed = v;
  p.vLong = v;
  p.vLat = 0;
  p.yawRate = 0;
  p.steerAngle = 0;
  p.gear = g.gear;
  p.rpm = g.rpm;
  p.internal.accelLong = 0;
  p.internal.accelLat = 0;
  p.internal.shiftTimer = 0;
  p.internal.held = false;
  car.ai.mode = 'race';
  car.ai.stuckTimer = 0;
  car.ai.recoverTimer = 0;
  car.ai.offset = 0;
  car.ai.integral = 0;
  car.race.stuckTime = 0;
  // hint + height keep the car on its own level at a grade-separated crossing
  applyProjection(car, projectToTrack(track, p.x, p.z, indexAtS(track, s), pose.y));
}

function stuckWatchdog(world: WorldState, track: BuiltTrack, car: CarEntry, dt: number): void {
  const r = car.race;
  const ph = world.session.phase;
  const watch =
    !isHuman(car) &&
    !car.ai.failing &&
    car.ai.crashTimer <= 0 &&
    (car.status === 'running' || car.status === 'finished') &&
    car.pit.phase === 'none' &&
    (ph === 'running' || ph === 'chequered' || ph === 'finished') &&
    !isCarHeld(car.phys);
  const progress = car.timing.progress;
  // finished cars no longer accumulate progress: judge them by speed
  const moving = car.status === 'finished' ? car.phys.speed > STUCK_SPEED : progress > r.stuckProgress + STUCK_PROGRESS;
  r.slowTime = watch && car.phys.speed < 1 ? r.slowTime + dt : 0;
  if (!watch || moving) {
    r.stuckTime = 0;
    r.stuckProgress = progress;
  } else {
    r.stuckTime += dt;
  }
  if (r.stuckTime > STUCK_RESET || r.slowTime > SLOW_RESET) {
    resetCar(world, track, car);
    r.stuckProgress = car.timing.progress;
    r.slowTime = 0;
  }
}

function postCar(world: WorldState, track: BuiltTrack, car: CarEntry, t0: number, dt: number): void {
  if (car.pit.phase === 'none' && shouldEngagePit(world, track, car, car.race.lastS)) engagePit(world, car);
  updateCarTiming(world, track, car, t0, dt);
  updateTrackLimits(world, track, car, dt);
  stuckWatchdog(world, track, car, dt);
}

/** Queue a pit stop (shared by the public requestPit and the AI strategy). */
export function queuePit(world: WorldState, car: CarEntry, compound: TireCompound): void {
  if (car.status === 'retired' || car.status === 'finished' || world.config.kind === 'timeTrial') return;
  if (!(COMPOUNDS as readonly string[]).includes(compound)) return;
  if (car.pit.phase !== 'none' && (car.pit.phase === 'stopped' || car.race.pitStopTotal > 0)) return;
  car.pit.nextCompound = compound;
  if (car.pit.phase === 'none') car.pit.requested = true;
  emit(world, { type: 'pitRequested', carId: car.id, compound });
}

/**
 * AI strategy for every AI car (decidePitStop evaluates once per lap): pit requests with the shared pit-loss estimate
 * (cheaper under a safety car / VSC), and the team-order radio when an order is given.
 */
function runStrategies(world: WorldState, track: BuiltTrack, dt: number): void {
  if (world.session.phase !== 'running') return;
  const pitLoss = estimatePitLoss(track);
  const lossFactor = pitLossFactor(world.session.control.mode);
  const mandatoryFor = (o: CarEntry): boolean => mandatoryStopOpen(world, o);
  for (const car of world.cars) {
    if (car.playerIndex !== -1) continue;
    const ai = car.ai;
    const yieldBefore = ai.yieldFor;
    const holdBefore = ai.holdFor;
    const compound = decidePitStop(world, car, track, dt, {
      usedCompounds: car.race.usedCompounds,
      mandatoryOpen: mandatoryStopOpen(world, car),
      pitLoss,
      lossFactor,
      mandatoryFor,
    });
    if (compound) {
      ai.plannedCompound = compound;
      queuePit(world, car, compound);
    }
    if (ai.yieldFor >= 0 && ai.yieldFor !== yieldBefore) radioTeamYield(world, car, world.cars[ai.yieldFor]);
    if (ai.holdFor >= 0 && ai.holdFor !== holdBefore) radioTeamHold(world, car, world.cars[ai.holdFor]);
  }
}

/** Advance the whole session by dt (= SIM_DT). */
export function advanceWorld(world: WorldState, track: BuiltTrack, inputs: readonly (ControlInput | null)[], dt: number): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const h = Math.min(dt, 0.05);
  const t0 = world.time;
  world.time = t0 + h;
  world.tick += 1;
  stepWeather(world, track, h);
  stepSessionClock(world);
  for (const car of world.cars) stepCar(world, track, car, inputs, h);
  carContacts(world, track);
  for (const car of world.cars) postCar(world, track, car, t0, h);
  updateClassification(world, track);
  stepRaceControl(world, track, h);
  updateDrs(world, track, t0);
  checkSessionEnd(world);
  runStrategies(world, track, h);
  stepRadio(world, h, (car) => mandatoryStopOpen(world, car));
}
