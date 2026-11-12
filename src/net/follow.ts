/**
 * How a guest shows what the host drives (docs/plans/phase3-online.md §2): the other cars, the safety car, and its own
 * car while the host has it (pit lane, formation, parking). Each is a Follower:
 * - the newest Fix the host sent of it (pose, speed and how both were changing), carried along its arc — speed
 *   changing at `accel`, course at `turn` — to the time on screen, its yaw turning at `spin` (a sliding or spinning
 *   car does not point where it goes). One fix is enough, so a lost snapshot only makes the next one older;
 * - an offset from that arc to what is drawn. A newer fix moves the arc; what was drawn stays where it was and the
 *   offset fades out (RATE), so a correction shows as a drift of a fraction of a second, never as a jump. Only a car
 *   the host put somewhere else (further than it could have driven since the last fix), or a view time that was set
 *   rather than run (ClientSession), is shown at once.
 * Pure: no track, no world.
 */
import { SIM_DT } from '../core/defaults';
import { angleDiff, clamp, wrapAngle } from '../core/math';

/** A mover as the host had it at one time. */
export interface Fix {
  /** host time (s) */
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  /** direction of travel (rad, as yaw) */
  course: number;
  /** change of speed (m/s²), of course and of yaw (rad/s) */
  accel: number;
  turn: number;
  spin: number;
  /** height gained per metre travelled (the road's grade) */
  climb: number;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
}

/** A fix is carried at most this far (s) past its time: a host silent for longer leaves its cars standing there. */
export const MAX_CARRY = 0.6;
/** … and this far back (a view behind the newest fix: a spectator's). */
const MAX_BACK = 0.25;
/** Share of the offset removed per second. */
const RATE = 3;
/** A fix further from where the last one was heading than this (m) plus what MAX_ACCEL (m/s²) covers in the time
 * between them: the car was put there, not driven. */
const TELEPORT = 3;
const MAX_ACCEL = 60;
/** Below this turn rate (rad/s) the arc is taken as a straight with a slight bend (its closed form divides by the rate). */
const STRAIGHT = 1e-4;
/** A car whose course is further than this (rad) off its yaw is sliding. */
export const SLIDE = 0.15;
/** A sliding car slowing to this speed (m/s) stops sliding and spinning: the physics drives it kinematically below it. */
const GRIPS = 3;

/**
 * A fix carried `t` s along its arc (t < 0: back). A braking car stops, it never reverses; a braking car that slides
 * stops turning on the spot once it is slow enough to grip.
 */
export function carry(f: Fix, t: number): Pose {
  const tt = f.accel < 0 && t > 0 ? Math.min(t, f.speed / -f.accel) : t;
  const sliding = Math.abs(angleDiff(f.yaw, f.course)) > SLIDE && f.speed > GRIPS && f.accel < 0;
  const spun = sliding && t > 0 ? Math.min(tt, (f.speed - GRIPS) / -f.accel) : tt;
  const v = Math.max(0, f.speed + f.accel * tt);
  const dist = f.speed * tt + 0.5 * f.accel * tt * tt;
  const sin0 = Math.sin(f.course);
  const cos0 = Math.cos(f.course);
  let dx: number;
  let dz: number;
  if (Math.abs(f.turn) < STRAIGHT) {
    const side = f.turn * ((f.speed * tt * tt) / 2 + (f.accel * tt * tt * tt) / 3);
    dx = sin0 * dist + cos0 * side;
    dz = cos0 * dist - sin0 * side;
  } else {
    // ∫ (speed + accel·u) · (sin, cos)(course + turn·u) du
    const w = f.turn;
    const sin1 = Math.sin(f.course + w * tt);
    const cos1 = Math.cos(f.course + w * tt);
    const v1 = f.speed + f.accel * tt;
    dx = (f.speed * cos0 - v1 * cos1) / w + (f.accel * (sin1 - sin0)) / (w * w);
    dz = (v1 * sin1 - f.speed * sin0) / w + (f.accel * (cos1 - cos0)) / (w * w);
  }
  return { x: f.x + dx, y: f.y + f.climb * dist, z: f.z + dz, yaw: wrapAngle(f.yaw + f.spin * spun), speed: v };
}

/** The host time a fix of `time` is shown at when the view time is `view` (within what it is carried). */
export const shownTime = (time: number, view: number): number => time + clamp(view - time, -MAX_BACK, MAX_CARRY);

const carryTo = (f: Fix, view: number): Pose => carry(f, shownTime(f.time, view) - f.time);

export class Follower {
  /** the newest fix carried to the view time: where the host most likely has it then */
  at: Pose;
  /** drawn − at */
  private readonly offset = { x: 0, y: 0, z: 0, yaw: 0 };

  constructor(
    private fix: Fix,
    view: number,
  ) {
    this.at = carryTo(fix, view);
  }

  /** What is drawn at the view time. */
  get drawn(): Pose {
    const o = this.offset;
    return { x: this.at.x + o.x, y: this.at.y + o.y, z: this.at.z + o.z, yaw: wrapAngle(this.at.yaw + o.yaw), speed: this.at.speed };
  }

  /** A newer fix (older ones are dropped): the arc moves to it, what is drawn stays and fades over. */
  take(fix: Fix, view: number): void {
    const dt = fix.time - this.fix.time;
    if (!(dt > 0)) return;
    const expected = carry(this.fix, Math.min(dt, MAX_CARRY));
    const put = Math.hypot(fix.x - expected.x, fix.z - expected.z) > TELEPORT + 0.5 * MAX_ACCEL * dt * dt;
    const was = this.at;
    this.fix = fix;
    this.at = carryTo(fix, view);
    if (put) this.show();
    else this.shift(was);
  }

  /** The view time ran on one step. */
  step(view: number): void {
    const keep = Math.exp(-RATE * SIM_DT);
    const o = this.offset;
    o.x *= keep;
    o.y *= keep;
    o.z *= keep;
    o.yaw *= keep;
    this.at = carryTo(this.fix, view);
  }

  /** The view time was set to `view` (not run there): shown where it is then, at once. */
  jump(view: number): void {
    this.at = carryTo(this.fix, view);
    this.show();
  }

  /** Something else was drawn in this one's place until now (the own car as predicted): it goes on from there. */
  resume(drawn: { x: number; y: number; z: number }): void {
    this.show();
    this.offset.x = drawn.x - this.at.x;
    this.offset.y = drawn.y - this.at.y;
    this.offset.z = drawn.z - this.at.z;
  }

  /** Shown where the host has it, at once. */
  show(): void {
    const o = this.offset;
    o.x = o.y = o.z = o.yaw = 0;
  }

  private shift(was: Pose): void {
    const o = this.offset;
    o.x += was.x - this.at.x;
    o.y += was.y - this.at.y;
    o.z += was.z - this.at.z;
    o.yaw += angleDiff(this.at.yaw, was.yaw);
  }
}
