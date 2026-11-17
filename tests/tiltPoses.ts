/**
 * Synthetic device poses → the raw `accelerationIncludingGravity` a phone would report, for the tilt tests.
 * Written from the physical setup, not by calling toScreen: device +x (natural right) turned θ counter-clockwise points
 * along screen (cos θ, sin θ), device +y (natural up) along (−sin θ, cos θ).
 */
import type { GravitySign, Vec3 } from '../src/input/tilt';

export interface Pose {
  /** how far the screen leans back from vertical: 0 upright, 90 flat and face up */
  leanDeg: number;
  /** the screen turned in its own plane, clockwise as the player sees it (+ = right) */
  rollDeg: number;
  /** screen.orientation.angle */
  screenAngleDeg: number;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** The raw sample for a pose. `sign` −1 is WebKit, which reports gravity negated. */
export function poseToSample(pose: Pose, sign: GravitySign, g = 9.81): Vec3 {
  const lean = rad(pose.leanDeg);
  const roll = rad(pose.rollDeg);
  const theta = rad(pose.screenAngleDeg);
  const sx = -Math.sin(roll) * Math.cos(lean);
  const sy = Math.cos(roll) * Math.cos(lean);
  const sz = Math.sin(lean);
  const ux = sx * Math.cos(theta) + sy * Math.sin(theta);
  const uy = -sx * Math.sin(theta) + sy * Math.cos(theta);
  return { x: sign * g * ux, y: sign * g * uy, z: sign * g * sz };
}
