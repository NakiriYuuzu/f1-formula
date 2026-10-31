/**
 * Grandstand crowd motion constants and helpers (pure, no three.js). The vertex shader in sceneryMaterials.ts
 * (patchCrowd) reads these as GLSL constants; the maths that must stay geometrically consistent (a standing
 * spectator's legs reaching the floor, the arms' raise) lives here so the tests can check it.
 *
 * Spectator frame (trackside.ts spectatorGeometry): origin on the seat, +Z toward the track, +Y up; the floor is
 * SEAT_HEIGHT below the origin. Part ids (vertex attribute crowdPart): 1 torso, 2 head, 3 left arm, 4 right arm,
 * 5 thighs, 6 shins; 0 = never moves.
 */

/** Height (m) of the seat above the floor the legs end on. */
export const SEAT_HEIGHT = 0.45;
/** Hip pivot (y, z) and thigh length (m) of a seated spectator; the knee sits at (hipY, hipZ + THIGH). */
export const HIP: readonly [number, number] = [0.08, 0.05];
export const THIGH = 0.42;
/** Thigh pitch (rad, from pointing at the track to pointing at the floor) and the forward step (m) of a standing spectator. */
export const STAND_THETA = 1.15;
export const STAND_FORWARD = 0.2;
/** Shoulder pivot of the arms (|x|, y). */
export const SHOULDER_PIVOT: readonly [number, number] = [0.24, 0.5];
/** Arm raise (rad from hanging) when cheering, the wave on top of it and the wave rate (rad/s); rest = hanging slightly out. */
export const ARM_RAISE = 2.7;
export const ARM_WAVE = 0.35;
export const ARM_WAVE_RATE = 8;
export const ARM_REST = 0.07;
/** Head pivot (y) and the head turn (rad) / rate scale of an idle spectator. */
export const HEAD_PIVOT_Y = 0.76;
export const HEAD_TURN = 0.6;
/** Sway: lateral and fore / aft sway (m per m above the seat) and rates (rad/s). */
export const SWAY_SIDE = 0.03;
export const SWAY_FORE = 0.018;
export const SWAY_RATE: readonly [number, number] = [0.8, 0.5];
/** Ambient cheering: the stand is split into square blocks (m) that cheer on their own schedule (rad/s of the pulse), peak excitement. */
export const BLOCK_SIZE = 14;
export const BLOCK_RATE = 0.21;
export const BLOCK_PEAK = 0.65;
/** A passing car excites spectators from CHEER_NEAR (full) to CHEER_FAR (none) metres. */
export const CHEER_NEAR = 12;
export const CHEER_FAR = 70;
/** Cars tracked for cheering (shader uniform array length) and the speed range (m/s) mapped to their weight 0..1. */
export const CHEER_CARS = 4;
export const CHEER_SPEED: readonly [number, number] = [10, 45];
/** Only cars this close (m) to a camera are picked. */
export const CHEER_PICK_RANGE = 450;

/** What the standing pose of the legs does: riseY lifts the hips so the feet stay on the floor, the shin shifts to sit under the knee. */
export function standingLegs(theta = STAND_THETA): { riseY: number; riseZ: number; kneeY: number; kneeZ: number; shinDz: number; hipHeight: number } {
  const riseY = THIGH * Math.sin(theta);
  const riseZ = STAND_FORWARD;
  // knee after the thigh pitched by theta about the hip, and the hips risen
  const kneeY = HIP[0] - THIGH * Math.sin(theta) + riseY;
  const kneeZ = HIP[1] + THIGH * Math.cos(theta) + riseZ;
  return { riseY, riseZ, kneeY, kneeZ, shinDz: kneeZ - (HIP[1] + THIGH), hipHeight: HIP[0] + riseY + SEAT_HEIGHT };
}

export interface CheerCar {
  x: number;
  z: number;
  speed: number;
  visible?: boolean;
  ghost?: boolean;
}
export interface Planar {
  x: number;
  z: number;
}

/**
 * Pick up to CHEER_CARS cars nearest to any camera (within CHEER_PICK_RANGE) and write them as x, z, weight, 0 quads
 * into `out` (length 4 × CHEER_CARS, unused entries weight 0). Allocation-free; returns the number picked.
 */
export function selectCheerCars(cars: readonly CheerCar[], cams: readonly Planar[], out: Float32Array | number[]): number {
  const n = CHEER_CARS;
  for (let i = 0; i < n * 4; i++) out[i] = 0;
  if (cams.length === 0) return 0;
  let picked = 0;
  // d2 of the picked cars kept in out[i * 4 + 3] while selecting
  for (const c of cars) {
    if (c.visible === false || c.ghost || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
    let d2 = Infinity;
    for (const cam of cams) d2 = Math.min(d2, (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2);
    if (d2 > CHEER_PICK_RANGE * CHEER_PICK_RANGE) continue;
    let slot = -1;
    if (picked < n) slot = picked++;
    else {
      let far = 0;
      for (let i = 1; i < n; i++) if (out[i * 4 + 3] > out[far * 4 + 3]) far = i;
      if (out[far * 4 + 3] > d2) slot = far;
    }
    if (slot < 0) continue;
    const speed = Number.isFinite(c.speed) ? Math.abs(c.speed) : 0;
    const k = Math.min(1, Math.max(0, (speed - CHEER_SPEED[0]) / (CHEER_SPEED[1] - CHEER_SPEED[0])));
    out[slot * 4] = c.x;
    out[slot * 4 + 1] = c.z;
    out[slot * 4 + 2] = k * k * (3 - 2 * k);
    out[slot * 4 + 3] = d2;
  }
  for (let i = 0; i < n; i++) out[i * 4 + 3] = 0;
  return picked;
}
