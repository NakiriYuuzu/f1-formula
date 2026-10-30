/**
 * Pit crew choreography (pure, no three.js): the 16 people of one pit box (per wheel a wheel-gun, a tyre-off and a
 * tyre-on mechanic, front and rear jack, two stabilisers), the box phase machine driven by what the renderer sees
 * (a car of the team approaching in the pit lane, standing in the box, pulling away) and each member's target spot,
 * pose and carried item per phase and service time. pitCrew.ts walks the members to their targets and draws them.
 *
 * Box-local frame: f = metres forward along the lane (the stopped car's direction), r = metres to the car's right,
 * origin = the painted box centre (= the stopped car's centre). yaw 0 faces +f; yaw = atan2(-dr, df) faces (df, dr).
 */
import { smoothstep } from '../../core/math';

export type CrewRole = 'gun' | 'off' | 'on' | 'frontJack' | 'rearJack' | 'stabiliser';
export type CrewPose = 'stand' | 'kneel' | 'crouch';
export type CrewItem = 'none' | 'tyre' | 'gun' | 'jack';
export type BoxPhase = 'idle' | 'ready' | 'service' | 'release';

export interface CrewSlot {
  role: CrewRole;
  /** 0 FL, 1 FR, 2 RL, 3 RR; -1 for jacks / stabilisers */
  wheel: number;
  /** -1 = car's left, +1 = right, 0 = on the centre line */
  side: number;
}

/** Car measurements the spots are placed around (box-local metres). */
export interface CrewCarShape {
  frontAxle: number;
  rearAxle: number;
  /** outer tyre face (|r|) at the front / rear axle */
  frontTrack: number;
  rearTrack: number;
  /** front-wing tip f and rear end f */
  nose: number;
  tail: number;
  /** half body width at the sidepods */
  halfWidth: number;
}

export interface CrewTarget {
  f: number;
  r: number;
  yaw: number;
  pose: CrewPose;
  item: CrewItem;
}

/** What the renderer observed about the box this frame. */
export interface BoxObservation {
  /** a car stands (speed ≈ 0) in the painted box */
  stopped: boolean;
  /** a car of this team is in the pit lane heading for the box */
  approaching: boolean;
  /** the car just serviced is still pulling away from the box */
  departing: boolean;
}

/** Service timeline (s after the car stopped): jacks up, old tyres off, new tyres on, jacks down. */
export const CREW_SERVICE = { jackUp: 0.25, tyreOff: 0.6, tyreOn: 1.3, jackDown: 2.1 } as const;
/** Height (m) the jacks lift the car. */
export const CREW_LIFT = 0.055;
/** Walking / sprinting speed (m/s) between spots and the turn rate (rad/s). */
export const CREW_SPEED = 4;
export const CREW_TURN = 8;
/** A member closer than this (m) to its spot takes the spot's pose; farther away it walks upright. */
export const CREW_ARRIVE = 0.25;

/** The 16 slots of a box, in a fixed order (instances are laid out per box in this order). */
export const CREW_SLOTS: readonly CrewSlot[] = (() => {
  const out: CrewSlot[] = [];
  for (let w = 0; w < 4; w++) {
    const side = w % 2 === 0 ? -1 : 1;
    out.push({ role: 'gun', wheel: w, side }, { role: 'off', wheel: w, side }, { role: 'on', wheel: w, side });
  }
  out.push({ role: 'frontJack', wheel: -1, side: 0 }, { role: 'rearJack', wheel: -1, side: 0 }, { role: 'stabiliser', wheel: -1, side: -1 }, { role: 'stabiliser', wheel: -1, side: 1 });
  return out;
})();

/** Local yaw that faces the direction (df, dr). */
export function faceYaw(df: number, dr: number): number {
  return Math.atan2(-dr, df);
}

/** Next box phase: a stopped car is serviced; afterwards the crew steps back while it leaves, then walks home. */
export function nextBoxPhase(phase: BoxPhase, obs: BoxObservation): BoxPhase {
  if (obs.stopped) return 'service';
  if ((phase === 'service' || phase === 'release') && obs.departing) return 'release';
  return obs.approaching ? 'ready' : 'idle';
}

/** Jack lift (m) of the serviced car `t` s after it stopped (0 outside the service). */
export function crewLift(phase: BoxPhase, t: number): number {
  if (phase !== 'service' || !Number.isFinite(t)) return 0;
  return CREW_LIFT * smoothstep(CREW_SERVICE.jackUp - 0.1, CREW_SERVICE.jackUp + 0.08, t) * (1 - smoothstep(CREW_SERVICE.jackDown, CREW_SERVICE.jackDown + 0.15, t));
}

/**
 * Target of slot `index` (CREW_SLOTS) for a box phase and time `t` in it. `garageR` = r of the garage door line,
 * `garageSide` = its sign (the crew waits in a double row in front of the door when idle).
 */
export function crewTarget(index: number, phase: BoxPhase, t: number, car: CrewCarShape, garageR: number, garageSide: number): CrewTarget {
  const slot = CREW_SLOTS[index] ?? CREW_SLOTS[0];
  const gs = garageSide >= 0 ? 1 : -1;
  if (phase === 'idle') {
    // double row in front of the garage door, facing the lane
    const col = index % 8;
    const row = Math.floor(index / 8);
    return { f: -3.75 + col * 1.07, r: garageR - gs * (0.9 + row * 1.0), yaw: faceYaw(0, -gs), pose: 'stand', item: 'none' };
  }
  const tt = Number.isFinite(t) ? Math.max(0, t) : 0;
  const service = phase === 'service';
  const release = phase === 'release';
  if (slot.wheel >= 0) {
    const front = slot.wheel < 2;
    const fw = front ? car.frontAxle : car.rearAxle;
    const tw = front ? car.frontTrack : car.rearTrack;
    const s = slot.side;
    const toCar = faceYaw(0, -s);
    const at = (df: number, dr: number, pose: CrewPose, item: CrewItem): CrewTarget => ({ f: fw + df, r: s * (tw + dr), yaw: toCar, pose, item });
    switch (slot.role) {
      case 'gun':
        if (service) return at(0, 0.55, 'kneel', 'gun');
        return at(0, release ? 1.7 : 1.4, 'stand', 'gun');
      case 'off':
        if (service) return tt < CREW_SERVICE.tyreOff ? at(-0.55, 0.65, 'crouch', 'none') : at(-1.15, 1.45, 'stand', 'tyre');
        return release ? at(-1.3, 1.8, 'stand', 'tyre') : at(-0.9, 1.2, 'stand', 'none');
      default:
        // tyre-on: waits with the new tyre, fits it once the old one is off, then crouches by the wheel
        if (service) {
          if (tt < CREW_SERVICE.tyreOff) return at(0.8, 1.1, 'stand', 'tyre');
          if (tt < CREW_SERVICE.tyreOn) return at(0.5, 0.8, 'crouch', 'tyre');
          return at(0.55, 0.65, 'crouch', 'none');
        }
        return release ? at(1.2, 1.8, 'stand', 'none') : at(0.9, 1.3, 'stand', 'tyre');
    }
  }
  if (slot.role === 'frontJack') {
    const back = faceYaw(-1, 0);
    if (service) return tt < CREW_SERVICE.jackDown ? { f: car.nose + 1.35, r: 0, yaw: back, pose: 'crouch', item: 'jack' } : { f: car.nose + 2.2, r: 0, yaw: back, pose: 'stand', item: 'jack' };
    // the car drives off through his spot: step aside to the garage side
    if (release) return { f: car.frontAxle + 1.2, r: gs * (car.frontTrack + 2.3), yaw: faceYaw(0, -gs), pose: 'stand', item: 'jack' };
    return { f: car.nose + 2.4, r: 0, yaw: back, pose: 'stand', item: 'jack' };
  }
  if (slot.role === 'rearJack') {
    const fwd = faceYaw(1, 0);
    if (service) return tt < CREW_SERVICE.jackDown ? { f: car.tail - 1.3, r: 0, yaw: fwd, pose: 'crouch', item: 'jack' } : { f: car.tail - 2.1, r: 0, yaw: fwd, pose: 'stand', item: 'jack' };
    // waits beside the lane (the arriving car drives through the box from behind) and steps in once it stands
    if (release) return { f: car.tail - 1.8, r: 0, yaw: fwd, pose: 'stand', item: 'jack' };
    return { f: car.tail - 0.6, r: gs * (car.rearTrack + 1.9), yaw: faceYaw(0, -gs), pose: 'stand', item: 'jack' };
  }
  // stabilisers: hands on the sidepods while the car is up
  const s = slot.side;
  const toCar = faceYaw(0, -s);
  if (service) return { f: 0.3, r: s * (car.halfWidth + 0.5), yaw: toCar, pose: 'crouch', item: 'none' };
  return { f: 0.2, r: s * (car.halfWidth + (release ? 1.8 : 1.4)), yaw: toCar, pose: 'stand', item: 'none' };
}

/** Step `cur` toward `target` at CREW_SPEED / CREW_TURN for `dt` s; returns true while still walking. */
export function walkToward(cur: { f: number; r: number; yaw: number }, target: CrewTarget, dt: number): boolean {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const df = target.f - cur.f;
  const dr = target.r - cur.r;
  const dist = Math.hypot(df, dr);
  const move = Math.min(dist, CREW_SPEED * step);
  let yawGoal = target.yaw;
  if (dist > 1e-6) {
    cur.f += (df / dist) * move;
    cur.r += (dr / dist) * move;
    // walking faces the way it goes; the last metre turns to the spot's heading
    if (dist > 1) yawGoal = faceYaw(df, dr);
  }
  let dy = yawGoal - cur.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  cur.yaw += Math.sign(dy) * Math.min(Math.abs(dy), CREW_TURN * step);
  return dist - move > CREW_ARRIVE;
}

/** Wheel-gun buzz (rad of gun roll) while the nut is being undone / tightened. */
export function gunWobble(phase: BoxPhase, t: number): number {
  if (phase !== 'service') return 0;
  const active = (t > CREW_SERVICE.jackUp && t < CREW_SERVICE.tyreOff) || (t > CREW_SERVICE.tyreOn && t < CREW_SERVICE.jackDown - 0.2);
  return active ? 0.12 * Math.sin(t * 90) : 0;
}

/** Walking bob (m) for a member that has walked `distance` m. */
export function walkBob(distance: number): number {
  return 0.035 * Math.abs(Math.sin(distance * 2.6));
}

/** Speed (m/s) below which a car counts as standing still in the box. */
export const CREW_STOPPED_SPEED = 0.4;
/** Box capture radius (m) along / across the lane for a standing car. */
export const CREW_BOX_ALONG = 2.2;
export const CREW_BOX_ACROSS = 1.6;
/** A team car this far (m) up the pit lane, or closer, calls the crew out. */
export const CREW_CALL_DISTANCE = 170;
/** The serviced car counts as departing until this far (m) past the box. */
export const CREW_DEPART_DISTANCE = 14;
