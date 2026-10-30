/**
 * How a car shows its damage (pure, no three.js): CarRenderState.damage (+ impact history) → the deformations
 * carModel.ts applies. A bent front wing rolls and sags on the hit side until it breaks (FRONT_WING_BREAK swaps in the
 * broken mesh); a damaged rear wing lets its flap droop and twist; bent suspension splays one wheel (camber, toe,
 * pushed out) and the body sags onto that corner, fully when broken; paint scuffs and exposed carbon spread with the
 * damage and with every hard impact (scuffs stay for the rest of the session, pit stops only replace the wings).
 */
import { clamp01, smoothstep } from '../../core/math';

/** Front-wing damage at which the wing hangs off (broken mesh). */
export const FRONT_WING_BREAK = 0.5;
/** Rear-wing damage at which the flap hangs off (black-and-orange level in race/damageRules.ts). */
export const REAR_WING_BREAK = 0.5;
/** Bent front wing just before it breaks: roll (rad) and drop (m) on the hit side. */
export const FRONT_WING_BEND = { roll: 0.075, drop: 0.025 } as const;
/** Rear flap at full damage: droop (rad, trailing edge down) and twist (rad). */
export const REAR_FLAP_HANG = { droop: 0.5, twist: 0.2 } as const;
/** Suspension: camber / toe (rad) and outward push (m) of the wheel when bent (s → 1) and extra once broken. */
export const SUSPENSION_BEND = { camber: 0.12, toe: 0.08, out: 0.03 } as const;
export const SUSPENSION_BROKEN = { camber: 0.42, toe: 0.22, out: 0.11 } as const;
/** Body sag onto the broken corner (rad of roll / pitch). */
export const SUSPENSION_SAG = { roll: 0.045, pitch: 0.03 } as const;
/** Impact scuffing: impulse threshold (matches the impact spark burst), scuff per impulse unit, cap from impacts alone. */
export const SCUFF_IMPACT_MIN = 500;
export const SCUFF_PER_IMPACT = 1 / 9000;
export const SCUFF_IMPACT_CAP = 0.55;

export interface CarDamageInput {
  frontWing: number;
  rearWing: number;
  floor?: number;
  suspension?: number;
}

export interface DamageLook {
  /** front wing roll (rad, signed toward the hit side) and drop (m); 0 once broken (the broken mesh shows) */
  frontWingRoll: number;
  frontWingDrop: number;
  frontWingBroken: boolean;
  rearFlapDroop: number;
  rearFlapTwist: number;
  /** damaged corner 0 FL, 1 FR, 2 RL, 3 RR and its wheel deformation */
  corner: number;
  camber: number;
  toe: number;
  wheelOut: number;
  /** body sag: roll (+ = right side down) and pitch (+ = nose up) added to the pose */
  sagRoll: number;
  sagPitch: number;
  /** paint scuff coverage 0..1 */
  scuff: number;
}

export function createDamageLook(): DamageLook {
  return { frontWingRoll: 0, frontWingDrop: 0, frontWingBroken: false, rearFlapDroop: 0, rearFlapTwist: 0, corner: 0, camber: 0, toe: 0, wheelOut: 0, sagRoll: 0, sagPitch: 0, scuff: 0 };
}

const fin01 = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) ? clamp01(v) : 0);

/** Corner (0 FL, 1 FR, 2 RL, 3 RR) whose suspension a car bends: fixed per car so the same wheel stays splayed. */
export function damagedCorner(carId: number): number {
  const id = Number.isFinite(carId) ? Math.floor(Math.abs(carId)) : 0;
  return (Math.imul(id + 1, 0x9e3779b1) >>> 29) & 3;
}

/** Scuff accumulated from impacts: each rising impact above SCUFF_IMPACT_MIN adds impulse × SCUFF_PER_IMPACT (capped). */
export function scuffAfterImpact(scuff: number, impact: number, previousImpact: number): number {
  const s = Number.isFinite(scuff) ? clamp01(scuff) : 0;
  const now = Number.isFinite(impact) ? impact : 0;
  const before = Number.isFinite(previousImpact) ? previousImpact : 0;
  if (now < SCUFF_IMPACT_MIN || now - before < 300) return s;
  return Math.min(SCUFF_IMPACT_CAP, Math.max(s, s + now * SCUFF_PER_IMPACT));
}

/** Deformations for a damage state, the car's damaged corner and the scuff from impacts (written into `out`). */
export function damageLook(d: CarDamageInput | undefined, corner: number, impactScuff: number, out: DamageLook = createDamageLook()): DamageLook {
  const fw = fin01(d?.frontWing);
  const rw = fin01(d?.rearWing);
  const floor = fin01(d?.floor);
  const susp = fin01(d?.suspension);
  const c = ((Math.floor(Number.isFinite(corner) ? corner : 0) % 4) + 4) % 4;
  // hit side: the damaged corner's side (+1 = left, the car's +X)
  const side = c % 2 === 0 ? 1 : -1;
  out.frontWingBroken = fw > FRONT_WING_BREAK;
  const bend = out.frontWingBroken ? 0 : smoothstep(0.12, FRONT_WING_BREAK, fw);
  // +roll = right side down: a left hit drops the left tip (negative roll)
  out.frontWingRoll = -side * FRONT_WING_BEND.roll * bend;
  out.frontWingDrop = FRONT_WING_BEND.drop * bend;
  out.rearFlapDroop = REAR_FLAP_HANG.droop * smoothstep(0.25, REAR_WING_BREAK + 0.25, rw);
  out.rearFlapTwist = -side * REAR_FLAP_HANG.twist * smoothstep(REAR_WING_BREAK - 0.1, 1, rw);
  out.corner = c;
  const bent = smoothstep(0.05, 0.6, susp);
  const broken = smoothstep(0.85, 1, susp);
  out.camber = SUSPENSION_BEND.camber * bent + (SUSPENSION_BROKEN.camber - SUSPENSION_BEND.camber) * broken;
  out.toe = SUSPENSION_BEND.toe * bent + (SUSPENSION_BROKEN.toe - SUSPENSION_BEND.toe) * broken;
  out.wheelOut = SUSPENSION_BEND.out * bent + (SUSPENSION_BROKEN.out - SUSPENSION_BEND.out) * broken;
  const sag = 0.25 * bent + 0.75 * broken;
  out.sagRoll = -side * SUSPENSION_SAG.roll * sag;
  out.sagPitch = (c < 2 ? -1 : 1) * SUSPENSION_SAG.pitch * sag;
  out.scuff = clamp01(Math.max(0.55 * fw, 0.55 * rw, 0.75 * floor, susp, Number.isFinite(impactScuff) ? impactScuff : 0));
  return out;
}
