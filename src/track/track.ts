/**
 * Track geometry & queries (owner: track agent). Pure logic — must NOT import three.js.
 * Public façade: every function other modules may use is exported from here.
 *
 * Conventions (core/math.ts): forward = (sin yaw, cos yaw), right = (-cos yaw, sin yaw) = (-tz, tx);
 * lateral offsets and curvature are + to the RIGHT; turning right decreases yaw, so curvature = -dyaw/ds.
 * Samples are uniformly spaced (track.spacing) with s[i] = i·spacing and s = 0 at def.points[0].
 *
 * Wall semantics (race / physics / AI):
 * - TrackProjection.wallDistance = halfWidth + runoff on the side of the point, EXCEPT on the pit side along
 *   the pit straight (isInPitStraight) where it is |pit.wallOffset| (the pit wall between track and lane).
 * - Cars in the pit lane are bounded by |pit.wallOffset| (inner) and pitLaneWallDistance(track, s) (outer);
 *   barrierLimits(track, s, lateral) returns the applicable signed [min, max] lateral interval for any car.
 * - Grade separation (crossings.ts): BuiltTrack.deck marks the upper road of a crossing; sameLevel(track, sA, sB)
 *   tells whether two positions can touch (|Δy| < GRADE_CLEARANCE / 2); projectToTrack takes an optional `y`.
 * - Pit-lane autopilot path: pitLaneOffsetAt(track, s) (null outside the pit zone).
 */
export { buildTrack, type BuildOptions } from './build';
export { barrierLimits, poseAt, projectToTrack } from './project';
export { heightAt } from './terrain';
export { CROSS_BAND, DECK_MARGIN, GRADE_CLEARANCE, isCrossingPair, isGradeSeparated, isOnDeck, roadsOverlap, sameLevel } from './crossings';
export { checkBuiltTrack, validateTrackDef } from './validate';
export { forwardDistance, inRangeS, indexAtS, sampleAt, signedDeltaS, wrapS } from './loop';
export {
  MAX_PIT_CURVATURE,
  MIN_PIT_ZONE,
  PIT_BOX_ROW_HALF,
  PIT_LANE_EXTRA,
  PIT_LANE_HALF_WIDTH,
  PIT_OUTER_CLEARANCE,
  PIT_STREET,
  PIT_RAMP_LENGTH,
  PIT_WALL_EXTRA,
  isInPitStraight,
  pitExtrasOf,
  isInPitZone,
  pitLaneOffsetAt,
  pitLaneWallDistance,
  pitRampLength,
  pitWallRange,
  pitZoneLength,
} from './pit';
export { RACING_LINE_MARGIN } from './racingLine';
export { cornerSpeedLimit } from './speedProfile';
