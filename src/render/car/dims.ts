/**
 * Car dimensions (model space: +Z nose, +Y up, +X = car's LEFT, origin on the ground midway between the axles).
 * Every car is drawn as a 2026-regulation car (narrower, shorter wheelbase, smaller tyres), whatever regulation the
 * session's physics run; the session regulation only changes how the wings move (see carModel). Shared by the geometry
 * builder, livery painter, cameras and effects.
 */
export interface CarDims {
  length: number;
  width: number;
  wheelbase: number;
  /** z of front / rear axle */
  frontAxleZ: number;
  rearAxleZ: number;
  /** half track (wheel centre x) */
  frontHalfTrack: number;
  rearHalfTrack: number;
  /** largest tyre radius (the axle radii below are what the geometry uses) */
  wheelRadius: number;
  frontWheelRadius: number;
  rearWheelRadius: number;
  frontTyreWidth: number;
  rearTyreWidth: number;
  /** front wing half span and z range */
  frontWingHalfSpan: number;
  frontWingZ0: number;
  frontWingZ1: number;
  rearWingHalfSpan: number;
  rearWingZ0: number;
  rearWingZ1: number;
  /** nose tip z */
  noseTipZ: number;
  /** cockpit opening z range + driver */
  cockpitZ0: number;
  cockpitZ1: number;
  helmetZ: number;
  helmetY: number;
  helmetR: number;
  /** driver eye (cockpit camera) */
  eyeY: number;
  eyeZ: number;
  /** steering wheel centre */
  wheelHubY: number;
  wheelHubZ: number;
  /** shark fin extent (side-projected livery panel) */
  finZ0: number;
  finZ1: number;
  finY0: number;
  finY1: number;
  /** livery decal anchors */
  noseNumberZ: number;
  sidepodTextZ: number;
  /** rear light position */
  rainLightZ: number;
  rainLightY: number;
  /** z extent of the cylindrical livery wrap (its axis height follows the body sections, see carGeometry) */
  wrapZMin: number;
  wrapZMax: number;
}

const DIMS: CarDims = {
  length: 5.4,
  width: 1.9,
  wheelbase: 3.4,
  frontAxleZ: 1.7,
  rearAxleZ: -1.7,
  frontHalfTrack: 0.76,
  rearHalfTrack: 0.735,
  wheelRadius: 0.355,
  frontWheelRadius: 0.3525,
  rearWheelRadius: 0.355,
  frontTyreWidth: 0.28,
  rearTyreWidth: 0.375,
  frontWingHalfSpan: 0.95,
  frontWingZ0: 2.1,
  frontWingZ1: 2.7,
  rearWingHalfSpan: 0.46,
  rearWingZ0: -2.7,
  rearWingZ1: -2.24,
  noseTipZ: 2.52,
  cockpitZ0: -0.32,
  cockpitZ1: 0.54,
  helmetZ: -0.14,
  helmetY: 0.78,
  helmetR: 0.135,
  eyeY: 0.8,
  eyeZ: -0.06,
  wheelHubY: 0.6,
  wheelHubZ: 0.35,
  finZ0: -2.08,
  finZ1: -0.82,
  finY0: 0.7,
  finY1: 0.96,
  noseNumberZ: 1.98,
  sidepodTextZ: -0.25,
  rainLightZ: -2.48,
  rainLightY: 0.34,
  wrapZMin: -2.85,
  wrapZMax: 2.85,
};

export function carDims(): CarDims {
  return DIMS;
}
