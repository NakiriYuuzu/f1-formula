/**
 * Race-runtime-owned internal types (owner: race/AI agent). Plain data only (lives inside WorldState).
 * Other modules must treat these as opaque.
 */
import type { AeroWake, TireCompound } from '../core/types';

export interface CarRaceInternal {
  /** s (m) of the latest projection, used for progress / crossing detection */
  lastS: number;
  /** pose at the start of the current step (ghost interpolation) */
  prevX: number;
  prevY: number;
  prevZ: number;
  prevYaw: number;
  /** world time the current sector started */
  sectorStart: number;
  /** checkpoint timing for gaps: time of the latest pass of each checkpoint slot and its absolute index */
  cpTimes: number[];
  cpAbs: number[];
  /** highest absolute checkpoint index passed */
  cpLast: number;
  /** last crossing time of each DRS detection point */
  drsDetTimes: number[];
  /** DRS zone index the car's eligibility applies to (-1 none) */
  drsZone: number;
  /** last crossing time of the control line (2026 overtake rule) */
  lineTime: number;
  /** time beyond the track limits in a corner (s) and whether this excursion was already flagged */
  limitTimer: number;
  limitFlagged: boolean;
  /** pit autopilot */
  pitStartLat: number;
  pitSpeed: number;
  /** lateral (m) of the kinematic pit path at the previous step */
  pitLat: number;
  /** s (m) the car stops at: own box or the queue spot behind a team-mate */
  pitStopS: number;
  pitStopTotal: number;
  pitRepair: boolean;
  /**
   * driver-driven pit visit (no pit assist): physics + driver inputs except while pitAuto, the kinematic
   * box manoeuvre (approach → stop → back to the lane centre); pitSpeeding = already penalised this visit
   */
  pitManual: boolean;
  pitAuto: boolean;
  pitSpeeding: boolean;
  /** dry compounds used (mandatory-stop rule) and whether a wet-weather tyre was used */
  usedCompounds: TireCompound[];
  usedWetTyre: boolean;
  mandatoryPenaltyApplied: boolean;
  /** AI stuck watchdog: seconds without progress and the progress at the start of that window */
  stuckTime: number;
  stuckProgress: number;
  /** continuous time (s) below walking pace */
  slowTime: number;
  /** event bookkeeping */
  collisionCooldown: number;
  /** damage levels last reported [frontWing, rearWing, floor] */
  reportedDamage: number[];
  drsWasAvailable: boolean;
  drsWasOpen: boolean;
  /** race radio */
  radioCooldown: number;
  radioWearWarned: boolean;
  radioDamageWarned: boolean;
  radioWeatherWarned: boolean;
  radioMandatoryWarned: boolean;
  radioGapTimer: number;
  /** ghost recording (human cars outside races): flattened [x, y, z, yaw] */
  ghostCur: number[];
  ghostBest: number[];
  ghostBestTime: number | null;
  /** world time the car retired (classification order of retirements) */
  retiredAt: number | null;
  /** current lap touched the pit lane (in / out lap), and completed laps that did not (qualifying timed laps) */
  pitLap: boolean;
  timedLaps: number;
  /** current lap ran (partly) under a neutralisation (SC / VSC / red) or from a standing start: not a clean lap */
  neutralLap: boolean;
  /** latest clean race lap (s, 0 = none): AIState.cleanLap is the better of it and the clean lap before */
  lastCleanLap: number;

  // ── race control ──
  /** own grid slot (race start / red-flag restart) */
  gridS: number;
  gridLat: number;
  /** formation lap: distance driven (m), auto-parking into the grid slot, parked, autopilot for an idle human */
  formationDist: number;
  parking: boolean;
  parked: boolean;
  parkStartD: number;
  parkStartLat: number;
  formationAuto: boolean;
  formationIdle: number;
  /** seconds below walking pace while racing (natural incident detection) */
  stopTime: number;
  /** largest contact impulse (N·s) since the last race-control step (heavy-impact detection) */
  impactPeak: number;
  /** world time of the last car-vs-car contact above the collision-event impulse (was another car involved in a crash) */
  carContactAt: number | null;
  /** retired but still visible on / beside the track until the marshals recover it */
  hazard: boolean;
  /** s at the previous race-control step (VSC delta / formation distance) */
  ctlS: number;
  /** VSC: penalty already given this period; cooldown of the next 'controlWarning' */
  vscPenalised: boolean;
  warnCooldown: number;
  /** blue flag: id of the car lapping us (-1 none) and seconds since it was last close */
  blueFor: number;
  blueTimer: number;
  /** safety car: seconds the race leader has been ahead of it after it picked the leader up (0 = behind) */
  scAheadTime: number;
  /** aero wake the car ran in at its last physics step (HUD) */
  wake: AeroWake;
}

export type IncidentKind = 'crash' | 'failure' | 'debris' | 'stopped';
export type IncidentResponse = 'yellow' | 'vsc' | 'sc' | 'red';

/** A hazard on / beside the track (plain data). */
export interface Incident {
  id: number;
  kind: IncidentKind;
  /** car involved, -1 = debris */
  carId: number;
  s: number;
  lateral: number;
  onSurface: boolean;
  /** s the yellow flag is shown at: fixed when the incident starts, moved once the car has come to rest */
  flagS: number;
  /** decided response; null while the car involved is still moving (spinning / pulling over) */
  response: IncidentResponse | null;
  /** forced response (debug hook) */
  forced: IncidentResponse | null;
  startedAt: number;
  /** world time the marshals clear it (null = clears when the car drives away) */
  recoverAt: number | null;
  resolved: boolean;
  /** human crash: peak contact impulse (N·s) that started it; 0 = not from an impact */
  impact: number;
  /** human crash: another car was involved in the hit that started it (just before it, or the hit itself) */
  otherCar: boolean;
}

export interface WorldRaceInternal {
  /** world time the first start light comes on (race) */
  lightsStart: number;
  /** random hold after the fifth light (s) */
  lightsHold: number;
  /** car ids in classification order (hysteresis applied) */
  order: number[];
  /** checkpoint count / spacing (m) used for gaps */
  cpCount: number;
  cpSpacing: number;
  /** overall best valid sector times (solo qualifying: seeded with the simulated AI benchmark) */
  bestSectors: (number | null)[];
  /** solo qualifying: best simulated AI lap a lap must beat to count as overall best (null = none) */
  benchLap: number | null;
  /** highest wetness seen this session (dry-race test for the mandatory stop) */
  maxWetness: number;
  finalLapAnnounced: boolean;
  /** forecast entry already announced on the radio (index), -1 none */
  forecastWarned: number;
  /** session end requested by the player */
  endRequested: boolean;

  // ── race control ──
  /** formation lap already driven (or not required) */
  formationDone: boolean;
  /** the next lights-out is a red-flag restart (lap counters are kept) */
  restart: boolean;
  incidents: Incident[];
  incidentSeq: number;
  /** leader lap of the latest random-incident draw and the world time a drawn incident happens (null = none) */
  incidentDrawLap: number;
  incidentDueAt: number | null;
  /** leader's completed laps when the safety car was deployed / when it left the track (-1 = n/a) */
  scDeployLaps: number;
  scGoneLaps: number;
  /** distance (m) the safety car has driven down the pit lane after coming in (-1 = on track) */
  scPitDist: number;
  /** the safety car waits in the pit lane (not on the scene) to be released in front of the leader */
  scHeld: boolean;
  /** distance (m) the safety car still drives down the pit lane before it rejoins at pit.exit (-1 = on track) */
  scExitDist: number;
  /** the safety car has picked up the race leader (until then the cars in between are waved past) */
  scPickedUp: boolean;
  /** world time the safety car was due in but the leader had not closed up (null = n/a) */
  scDueSince: number | null;
  /** red flag: world time the field is regrouped on the grid (null = n/a) */
  redRegroupAt: number | null;
  /** world time a neutralisation ended / each sector flag cleared (green flag display) */
  greenAt: number;
  sectorClearedAt: number[];
}
