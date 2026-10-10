/**
 * FORMULA NOVA — shared contracts (owned by the architect; feature agents must NOT edit this file).
 *
 * WORLD CONVENTIONS (see core/math.ts helpers — use them):
 * - Three.js world space, Y up, meters. Simulation runs on the XZ plane; `y` is visual elevation only.
 * - yaw (rad): forward = (sin yaw, cos yaw), right = (-cos yaw, sin yaw). Turning RIGHT => yaw decreases.
 * - Lateral offsets are signed: + = RIGHT of the driving direction. Curvature signed: + = track turns RIGHT.
 * - steer input / steer angle: + = RIGHT.
 * - Units: m, m/s, s, kg, N, W, J, rad, °C. Unit conversion for display happens in UI only.
 * - All mutable simulation state (WorldState and everything reachable from it) is PLAIN DATA:
 *   numbers, strings, booleans, null, arrays and plain objects. No class instances, Map/Set, functions
 *   or typed arrays — structuredClone(world) must produce an independent, fully working copy (flashback).
 *   BuiltTrack is static (never mutated, never inside WorldState) and may use typed arrays.
 */

import type { AIState } from '../ai/types';
import type { CarSpec, PhysicsInternal } from '../physics/types';
import type { CarRaceInternal, WorldRaceInternal } from '../race/types';

export type { AIState } from '../ai/types';
export type { CarSpec, PhysicsInternal } from '../physics/types';
export type { CarRaceInternal, WorldRaceInternal } from '../race/types';

// ───────────────────────────── enums ─────────────────────────────
export type Regulation = '2025' | '2026';
export type TireCompound = 'soft' | 'medium' | 'hard' | 'inter' | 'wet';
export type WeatherKind = 'clear' | 'overcast' | 'lightRain' | 'heavyRain';
export type TimeOfDay = 'day' | 'dusk' | 'night';
export type Biome = 'desert' | 'temperate' | 'city' | 'coastal' | 'autumn' | 'tropical';
export type SurfaceKind = 'asphalt' | 'kerb' | 'grass' | 'gravel' | 'runoff' | 'pitlane';
export type ErsMode = 'none' | 'medium' | 'hotlap' | 'overtake';
export type SessionKind = 'practice' | 'qualifying' | 'race' | 'timeTrial';
export type GameMode = 'grandPrix' | 'timeTrial' | 'career' | 'myTeam' | 'story' | 'splitScreen';
export type CameraMode = 'chase' | 'chaseFar' | 'tcam' | 'cockpit' | 'nose' | 'tv';
export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export type RacingLineMode = 'off' | 'corners' | 'full';
export type GearboxMode = 'auto' | 'manual';
export type TractionControl = 'off' | 'medium' | 'full';
export type BrakingAssist = 'off' | 'low' | 'high';
export type DamageLevel = 'off' | 'reduced' | 'full';
export type SpeedUnit = 'kmh' | 'mph';
/** Incident frequency: off = no incidents / neutralisations at all. */
export type SafetyCarSetting = 'off' | 'reduced' | 'standard' | 'increased';
/**
 * Race-control state of a race session:
 * green = racing; formation = formation lap; vsc / vscEnding = virtual safety car (ending = ~10 s warning);
 * sc = safety car on track with lights; scEnding = "safety car in this lap" (lights off, SC heading for the pits);
 * red = race suspended (cars regroup on the grid, then a standing restart).
 */
export type RaceControlMode = 'green' | 'formation' | 'vsc' | 'vscEnding' | 'sc' | 'scEnding' | 'red';
/** Flag shown to one car (HUD). */
export type CarFlag = 'none' | 'green' | 'yellow' | 'doubleYellow' | 'blue' | 'vsc' | 'sc' | 'red';

// ───────────────────────────── static data ─────────────────────────────
/** Colors are '#rrggbb'. */
export type LiveryPattern = 'classic' | 'stripe' | 'chevron' | 'split' | 'fade';

/** Paint finish of the livery material; default 'gloss'. */
export type LiveryFinish = 'gloss' | 'satin' | 'matte';

/** Optional per-part colours ('#rrggbb') painted over the pattern; an unset part keeps the default look. */
export interface LiveryParts {
  /** bodywork ahead of the cockpit (nose cone) */
  nose?: string;
  /** top of the bodywork behind the cockpit (engine cover, airbox) + shark fin */
  engineCover?: string;
  /** sides of the bodywork along the sidepods */
  sidepods?: string;
  /** lower sides of the whole bodywork, above the carbon underside */
  lower?: string;
  /** halo hoop + centre pillar (default primary) */
  halo?: string;
  /** front wing endplates + upper flaps (default primary) */
  frontWing?: string;
  /** rear wing endplates (default primary) */
  rearWing?: string;
  /** rear wing flap (default secondary) */
  rearFlap?: string;
}

export interface Livery {
  primary: string;
  secondary: string;
  accent: string;
  /** paint layout on the bodywork; default 'classic' */
  pattern?: LiveryPattern;
  /** roster packs: colours of individual parts */
  parts?: LiveryParts;
  finish?: LiveryFinish;
}

export interface TeamDef {
  id: string;
  name: string;
  /** 3 uppercase letters */
  shortName: string;
  livery: Livery;
  /** fictional HQ */
  base: string;
  /** fictional power-unit supplier */
  powerUnit: string;
  /** car ratings 0..1 (front-runner ≈ 0.97-1.0, back-marker ≈ 0.86) */
  rating: { aero: number; power: number; chassis: number; reliability: number };
  driverIds: [string, string];
}

/** Car parts developed in season modes (meta/development.ts); 0..5 levels each. */
export type CarPartId =
  | 'frontWing' | 'rearWing' | 'floor' | 'suspension' | 'powerUnit'
  | 'ers' | 'gearbox' | 'brakes' | 'weight' | 'reliability';
/** Achieved development per part, 0..5 (a level that only partly succeeded adds 0.5). Missing = 0. */
export type CarPartGains = Partial<Record<CarPartId, number>>;

export interface DriverDef {
  id: string;
  firstName: string;
  lastName: string;
  /** 3 uppercase letters */
  abbr: string;
  /** 1..99, unique on the grid */
  number: number;
  /** ISO 3166-1 alpha-3, e.g. 'TWN' */
  nationality: string;
  /** '' for free agents / reserves */
  teamId: string;
  /** 0..1 */
  skill: { pace: number; racecraft: number; awareness: number; wet: number; consistency: number };
  helmet: Livery;
}

export interface TrackControlPoint {
  x: number;
  z: number;
  /** elevation (m), default 0. Original circuits keep grades ≤ 5 %; real circuits follow the measured profile. */
  y?: number;
  /** total road width (m) at this point; default TrackDef.width */
  width?: number;
}

export interface TrackDef {
  /** kebab-case, unique */
  id: string;
  /** display name (zh-TW): fictional for original circuits, place-name based for real ones */
  name: string;
  location: string;
  country: string;
  biome: Biome;
  timeOfDay: TimeOfDay;
  /** street circuit: barriers close to the road */
  street: boolean;
  /**
   * Closed loop of control points in DRIVING ORDER (centripetal Catmull-Rom through all points).
   * points[0] must lie in the middle of the main straight: it is the start/finish line (s = 0).
   */
  points: TrackControlPoint[];
  /** default road width (m), 12..16 for the original circuits, 10..16 for real circuits (validated by track/validate.ts) */
  width: number;
  /** laps for a 100 % race distance */
  fullLaps: number;
  /** lap fractions (0..1) where sector 2 and sector 3 begin */
  sectors: [number, number];
  /** lap fractions (0..1) in driving direction; may wrap through 0 */
  drsZones: { detection: number; activation: number; end: number }[];
  /** pit lane along the main straight; lap fractions, entry before the line (e.g. 0.95), exit after it (e.g. 0.05) */
  pit: { side: 'left' | 'right'; entry: number; exit: number; box: number };
  /** short zh-TW blurb for menus */
  description: string;
  /** Real-world circuit metadata. Absent on the original fictional circuits. */
  real?: RealCircuitInfo;
}

/** A named place along a real circuit, in forward lap fractions (reverse layouts convert them). */
export interface TrackFeature {
  /**
   * 'tunnel' = covered road from `at` to `end`; 'bridge' = structure spanning the road at `at`;
   * 'landmark' = scenery next to the road at `at` (renderer looks up `name`).
   */
  kind: 'tunnel' | 'bridge' | 'landmark';
  at: number;
  /** tunnel end (lap fraction) */
  end?: number;
  /** side of the road in the forward driving direction */
  side?: 'left' | 'right';
  /** distance (m) from the centre line to the landmark's near edge */
  offset?: number;
  /** renderer id in kebab-case, e.g. 'marina', 'ferris-wheel', 'observation-tower', 'hotel-bridge' */
  name: string;
  /** zh-TW label for menus / info panels */
  label?: string;
}

export interface RealCircuitInfo {
  /** official lap length (m) */
  length: number;
  /** official number of turns */
  turns: number;
  /** clockwise / anticlockwise in the forward layout */
  direction: 'clockwise' | 'anticlockwise';
  /** first world-championship Grand Prix year */
  firstGrandPrix: number;
  /** data attribution, e.g. 'Centre line © OpenStreetMap contributors (ODbL); elevation: EU-DEM via OpenTopoData' */
  source: string;
  features?: TrackFeature[];
}

/** Layout = a TrackDef driven forward or in reverse. id = def.id or `${def.id}-rev`. */
export interface LayoutInfo {
  id: string;
  defId: string;
  reverse: boolean;
  displayName: string;
}

export interface TrackCorner {
  /** 1-based in driving order */
  number: number;
  startS: number;
  apexS: number;
  endS: number;
  /** 1 = right-hander, -1 = left-hander */
  direction: 1 | -1;
  /** reference speed at apex (m/s) */
  minSpeed: number;
}

/** Static, pre-sampled track. Arrays have length `count`, samples ~`spacing` m apart, index 0 at s = 0. */
export interface BuiltTrack {
  id: string;
  def: TrackDef;
  reverse: boolean;
  displayName: string;
  length: number;
  count: number;
  spacing: number;
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  /** unit forward (driving direction) */
  tx: Float64Array;
  tz: Float64Array;
  /** unit right = (-tz, tx) */
  rx: Float64Array;
  rz: Float64Array;
  /** cumulative distance at each sample */
  s: Float64Array;
  /** signed curvature 1/m (+ = turns right) */
  curvature: Float64Array;
  /** half road width (m) */
  halfWidth: Float64Array;
  /** kerb width beyond the road edge (m), 0 = no kerb */
  kerbLeft: Float64Array;
  kerbRight: Float64Array;
  /** distance from road edge to barrier (m) on each side */
  runoffLeft: Float64Array;
  runoffRight: Float64Array;
  /** runoff surface: 0 grass, 1 gravel, 2 asphalt */
  runoffSurfaceLeft: Uint8Array;
  runoffSurfaceRight: Uint8Array;
  /** lateral offset (m, + right) of the optimal racing line */
  racingLine: Float64Array;
  /** reference target speed (m/s) on the racing line: dry, soft tyres, REFERENCE_CAR, no DRS */
  speedProfile: Float64Array;
  /**
   * Grade separation: 1 where this sample is the UPPER road over another part of the lap that crosses it in XZ with
   * an elevation difference ≥ GRADE_CLEARANCE (track/crossings.ts), plus a short margin each side; else 0.
   * Deck samples have close parapet walls (runoff ≤ 3 m), do not pull the terrain up, and the other section is
   * ignored by barrier clamping. All zeros on tracks without a crossing.
   */
  deck: Uint8Array;
  /** s (m) where sectors 1, 2, 3 begin; sectorStarts[0] === 0 */
  sectorStarts: [number, number, number];
  /** s (m) in driving direction; zone may wrap (end < activation) */
  drsZones: { detection: number; activation: number; end: number }[];
  pit: {
    /** +1 = pit lane on the right of the driving direction, -1 = left */
    side: 1 | -1;
    /** s (m) where cars leave the racing surface (before the line) */
    entry: number;
    /** s (m) where cars rejoin (after the line) */
    exit: number;
    /** s (m) of the centre of the pit-box row */
    box: number;
    /** signed lateral offset (m) of the pit-lane centre line in the straight part of the pit zone */
    laneOffset: number;
    /** signed lateral offset (m) of the pit wall separating track and pit lane */
    wallOffset: number;
    /** m/s (80 km/h) */
    speedLimit: number;
    /** pit lane length (m), entry→exit */
    laneLength: number;
  };
  corners: TrackCorner[];
  /** lap time (s) of the reference speed profile */
  referenceLapTime: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
}

export interface TrackProjection {
  index: number;
  s: number;
  /** signed lateral offset from centre line (+ right) */
  lateral: number;
  halfWidth: number;
  surface: SurfaceKind;
  /** centre-line elevation at s */
  height: number;
  /** distance from centre line to the barrier on the side the point is on (positive) */
  wallDistance: number;
  /** track yaw at s */
  heading: number;
}

// ───────────────────────────── settings / setup ─────────────────────────────
export interface Assists {
  steering: boolean;
  braking: BrakingAssist;
  abs: boolean;
  traction: TractionControl;
  gearbox: GearboxMode;
  racingLine: RacingLineMode;
  /** automatic ERS mode management */
  ersAssist: boolean;
  /** automatically open DRS / active aero when available */
  drsAssist: boolean;
  /** behind the safety car, hold the queue speed (throttle cut, light braking): no passing the car ahead / the safety car */
  scLimiter: boolean;
  /**
   * pit autopilot: drive the whole pit visit (entry road → box → exit road). Off = the driver drives the pit lane
   * (limiter between the speed-limit lines, speeding penalised); only the box stop itself is automatic.
   */
  pitAssist: boolean;
}

/** Car setup. Ranges & zh-TW labels live in core/defaults.ts SETUP_RANGES. */
export interface CarSetup {
  /** 0..50 */
  frontWing: number;
  /** 0..50 */
  rearWing: number;
  /** 10..100 (% lock on throttle) */
  diffOnThrottle: number;
  /** 50..70 (% front) */
  brakeBias: number;
  /** 1..11 soft..stiff */
  suspension: number;
  /** 1..11 low..high */
  rideHeight: number;
  /** 1..11 low..high */
  tyrePressure: number;
}

export type KeyAction =
  | 'throttle'
  | 'brake'
  | 'steerLeft'
  | 'steerRight'
  | 'shiftUp'
  | 'shiftDown'
  | 'drs'
  | 'overtake'
  | 'ersCycle'
  | 'limiter'
  | 'camera'
  | 'lookBack'
  | 'pause'
  | 'flashback'
  | 'mfd'
  | 'pitRequest'
  | 'fullscreen'
  | 'hud';

export interface Settings {
  quality: QualityLevel;
  /** 0.5..1.0 render resolution multiplier */
  resolutionScale: number;
  shadows: boolean;
  antialias: boolean;
  showFps: boolean;
  /** vertical FOV in degrees for chase cams, 50..90 */
  fov: number;
  masterVolume: number;
  engineVolume: number;
  sfxVolume: number;
  uiVolume: number;
  /** background music level 0..1 */
  musicVolume: number;
  /** original synthesized track, the optional bundled track (public/music/, git-ignored), a user-selected local file
   * (kept in IndexedDB), or silence */
  musicSource: 'original' | 'bundled' | 'custom' | 'off';
  /** keep playing (ducked) during sessions and replays */
  musicInRace: boolean;
  units: SpeedUnit;
  defaultCamera: CameraMode;
  cameraShake: boolean;
  /** strength 0..1 (0 = off) of the radial screen blur that grows with the followed car's speed
   * (post chain only: quality medium+, single view) */
  speedBlur: number;
  /** 0.5..1.5 */
  steeringSensitivity: number;
  /** gamepad stick deadzone 0..0.3 */
  deadzone: number;
  vibration: boolean;
  /** Player 1 bindings: KeyboardEvent.code values */
  keyBindings: Record<KeyAction, string[]>;
  /** Player 2 (split-screen) bindings: KeyboardEvent.code values */
  keyBindingsP2: Partial<Record<KeyAction, string[]>>;
  hud: { minimap: boolean; tower: boolean; telemetry: boolean; radio: boolean };
}

// ───────────────────────────── per-car simulation state ─────────────────────────────
export interface ControlInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1..1, + = right */
  steer: number;
  /** ONE-SHOT flags: true for exactly one simulation step, then cleared by the producer */
  shiftUp: boolean;
  shiftDown: boolean;
  drsPressed: boolean;
  ersCycle: boolean;
  limiterToggle: boolean;
  /** held: 2026 overtake mode / extra deployment */
  overtakeHeld: boolean;
}

export interface TireState {
  compound: TireCompound;
  /** 0 = new .. 1 = destroyed */
  wear: number;
  /** surface temperature °C */
  temp: number;
  /** laps on this set */
  laps: number;
}

export interface ErsState {
  /** battery state of charge 0..1 */
  charge: number;
  mode: ErsMode;
  /** J deployed / harvested in the current lap */
  deployedLap: number;
  harvestedLap: number;
  /** runtime-granted: overtake boost may be used (2026: within 1 s at detection; 2025: always) */
  overtakeAvailable: boolean;
  /** physics-reported: boost currently being deployed */
  overtakeActive: boolean;
}

export interface DrsState {
  /** runtime: car may open DRS / active aero in the next activation zone */
  eligible: boolean;
  /** runtime: car is inside an activation zone and eligible right now */
  available: boolean;
  /** physics: flap open (opened by input.drsPressed or drsAssist while available, closed by braking or leaving zone) */
  open: boolean;
}

export interface DamageState {
  /** 0 = intact .. 1 = destroyed */
  frontWing: number;
  rearWing: number;
  floor: number;
}

export interface CarPhysicsState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** visual only (radians, + nose up / + roll right side down) */
  pitch: number;
  roll: number;
  /** world-space velocity */
  vx: number;
  vz: number;
  /** rad/s (turning right => negative) */
  yawRate: number;
  /** |v| m/s */
  speed: number;
  /** velocity in car frame: forward / right components */
  vLong: number;
  vLat: number;
  /** front wheel angle (rad, + right) actually applied */
  steerAngle: number;
  /** applied after assists/limiter, 0..1 */
  throttle: number;
  brake: number;
  /** -1 = R, 0 = N, 1..8 */
  gear: number;
  rpm: number;
  /** accumulated wheel rotation (rad) for rendering */
  wheelSpin: number;
  /** slip angles (rad) and rear longitudinal slip ratio, for audio/smoke/TC */
  slipAngleFront: number;
  slipAngleRear: number;
  slipRatio: number;
  /** 0..1 brake lock intensity */
  lockup: number;
  /** body accelerations in g (lat + = right) */
  gLat: number;
  gLong: number;
  tire: TireState;
  fuelKg: number;
  ers: ErsState;
  drs: DrsState;
  damage: DamageState;
  /** pit-lane speed limiter engaged */
  limiter: boolean;
  /** last collision impulse (N·s), decays to 0; for audio/fx */
  impact: number;
  /** written by the race runtime from the latest projection */
  surface: SurfaceKind;
  trackIndex: number;
  s: number;
  lateral: number;
  internal: PhysicsInternal;
}

/** Aerodynamic wake a car runs in (cars close ahead, in line): multipliers on its drag (tow, < 1) and front / rear
 * downforce (dirty air, < 1). */
export interface AeroWake {
  drag: number;
  frontDownforce: number;
  rearDownforce: number;
}

export interface PhysicsEnv {
  surface: SurfaceKind;
  /** water on track 0..1 */
  wetness: number;
  /** track rubber-in 0..1 (slight grip gain) */
  rubber: number;
  /** track temperature °C */
  trackTemp: number;
  regulation: Regulation;
  assists: Assists;
  /** braking-assist target speed (m/s) for the upcoming corner, null = no limit */
  assistTargetSpeed: number | null;
  /** 0 disables tyre wear, 1 normal */
  wearMultiplier: number;
  /** 0 disables fuel use, 1 normal */
  fuelMultiplier: number;
  /** 0 = no damage, 0.5 = reduced, 1 = full */
  damageMultiplier: number;
  /** extra grip/power scaling for AI difficulty or My Team upgrades; 1 = neutral */
  performanceScale: number;
  /** aerodynamic wake of the cars ahead; absent = clean air */
  wake?: AeroWake;
}

export type CarStatus = 'grid' | 'running' | 'pitting' | 'finished' | 'retired';

export type PitPhase = 'none' | 'entry' | 'lane' | 'stopped' | 'exit';

export interface PitState {
  /** box at the next pit entry */
  requested: boolean;
  nextCompound: TireCompound;
  phase: PitPhase;
  /** remaining stationary time while phase === 'stopped' */
  timer: number;
  stops: number;
  /** s (m) of this car's pit box */
  boxS: number;
}

export interface PenaltyState {
  /** seconds added to race time */
  timeSec: number;
  trackLimitWarnings: number;
  /** zh-TW lines for results */
  log: string[];
}

export interface CarTiming {
  /** current lap being driven, 1-based (0 while on the grid / before the first line crossing) */
  lap: number;
  lapsCompleted: number;
  /** monotonic race distance = lapsCompleted * length + distance since line (may start negative on the grid) */
  progress: number;
  /** world time the current lap started */
  lapStart: number;
  currentLapTime: number;
  lastLap: number | null;
  bestLap: number | null;
  /** 0, 1, 2 */
  sector: number;
  /** sector times of the current lap (null = not yet) */
  sectors: (number | null)[];
  lastSectors: (number | null)[];
  bestSectors: (number | null)[];
  lapValid: boolean;
  /** 1-based classification position */
  position: number;
  gridPosition: number;
  /** seconds behind leader (same lap); see lapsDown */
  gapToLeader: number;
  /** seconds to the car directly ahead */
  interval: number;
  lapsDown: number;
  /** world time the car took the chequered flag (null = not finished) */
  finishTime: number | null;
  topSpeed: number;
}

export interface CarEntry {
  /** index into WorldState.cars */
  id: number;
  driverId: string;
  teamId: string;
  /** -1 = AI, 0–3 = human player index (0 / 1 local split-screen; online up to four) */
  playerIndex: -1 | PlayerIndex;
  displayName: string;
  abbr: string;
  number: number;
  livery: Livery;
  phys: CarPhysicsState;
  spec: CarSpec;
  setup: CarSetup;
  assists: Assists;
  /** AI brain (also present for humans: used by pit-lane autopilot); plain data */
  ai: AIState;
  timing: CarTiming;
  pit: PitState;
  penalties: PenaltyState;
  status: CarStatus;
  race: CarRaceInternal;
  /** flags / neutralisation state shown to this car */
  flags: CarFlagState;
}

export interface CarFlagState {
  /** most important flag for this car right now (HUD) */
  shown: CarFlag;
  /** VSC delta (s): ≥ 0 within the limit, < 0 too fast; null when no delta applies */
  delta: number | null;
  /** an illegal overtake (under SC / VSC / yellow / formation) must be undone within timeLeft seconds, else a penalty */
  giveBack: { carId: number; timeLeft: number } | null;
  /** under SC / formation: car is in (or catching) the queue behind the car ahead */
  queuing: boolean;
}

// ───────────────────────────── session / world ─────────────────────────────
/** Human player index: 0 / 1 on one computer (split-screen), up to 3 in an online session. */
export type PlayerIndex = 0 | 1 | 2 | 3;

export interface PlayerSlot {
  playerIndex: PlayerIndex;
  driverId: string;
  teamId: string;
  setup: CarSetup;
  assists: Assists;
}

export interface GridEntry {
  driverId: string;
  teamId: string;
  playerIndex: -1 | PlayerIndex;
  startCompound: TireCompound;
}

export interface SessionRules {
  tyreWear: boolean;
  fuel: boolean;
  damage: DamageLevel;
  trackLimits: boolean;
  /** race: at least one stop with a different dry compound (dry races only) */
  mandatoryPitStop: boolean;
  /** -1 = unlimited, 0 = disabled */
  flashbacks: number;
  /** allow AI cars to collide with each other / the player */
  collisions: boolean;
  /** race incidents & neutralisations (yellow flags, VSC, safety car). undefined = 'off' (legacy configs) */
  safetyCar?: SafetyCarSetting;
  /** severe incidents may red-flag the race (standing restart from the grid). undefined = false */
  redFlags?: boolean;
  /** race starts with a formation lap, then cars park on the grid for the lights. undefined = false */
  formationLap?: boolean;
  /** race: aerodynamic wake behind other cars (tow, dirty air; race/wake.ts). undefined = true */
  aeroWake?: boolean;
}

export interface GhostData {
  layoutId: string;
  lapTime: number;
  driverId: string;
  teamId: string;
  /** sample interval (s) */
  dt: number;
  /** flattened [x, y, z, yaw] per sample, sample i at time i*dt from the lap start */
  samples: number[];
}

export interface StoryObjective {
  kind: 'finishAtOrAbove' | 'gainPositions' | 'beatDriver' | 'lapUnder' | 'noPenalties';
  /** position / count / lap seconds depending on kind */
  value: number;
  /** for beatDriver */
  driverId?: string;
  /** zh-TW objective text */
  text: string;
}

export interface SessionConfig {
  mode: GameMode;
  kind: SessionKind;
  layoutId: string;
  /** race laps (race only, ≥ 1) */
  laps: number;
  /** practice / qualifying time limit (s); null = unlimited (time trial) */
  timeLimit: number | null;
  /** qualifying: max timed laps (one-shot = 1) */
  qualifyingLaps: number;
  weather: WeatherKind;
  dynamicWeather: boolean;
  timeOfDay: TimeOfDay;
  regulation: Regulation;
  /** 0..110 */
  aiDifficulty: number;
  players: PlayerSlot[];
  /** every car on track, in starting order (index 0 = pole). Time trial / practice: only player(s). */
  grid: GridEntry[];
  /** teams/drivers available to this session (static data + custom My Team / career player) */
  teams: TeamDef[];
  drivers: DriverDef[];
  rules: SessionRules;
  seed: number;
  ghost: GhostData | null;
  objective: StoryObjective | null;
  /** race kind only: sprint race (short distance, SPRINT_POINTS, no mandatory stop). undefined = false */
  sprint?: boolean;
  /** season modes: achieved part development per team id (meta/development.ts). undefined / missing team = none */
  development?: Record<string, CarPartGains>;
}

/**
 * pre → (formation → pre) → lights → running → chequered → finished.
 * 'formation': formation lap in progress (cars released, no timing); a red-flag restart goes running → lights → running.
 */
export type SessionPhase = 'pre' | 'formation' | 'lights' | 'running' | 'chequered' | 'finished';

/** The safety car (a separate vehicle, not in WorldState.cars). Pose valid only while onTrack. */
export interface SafetyCarState {
  onTrack: boolean;
  /** light bar flashing (deployed); off = "safety car in this lap" */
  lightsOn: boolean;
  s: number;
  lateral: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  /** accumulated wheel rotation (rad) for rendering */
  wheelSpin: number;
}

export interface RaceControlState {
  mode: RaceControlMode;
  /** world time the current mode began */
  since: number;
  /** per sector (length 3): 0 = green, 1 = yellow, 2 = double yellow */
  sectorFlags: number[];
  /** zh-TW description of the current neutralisation / latest incident ('' = none), e.g. '第 7 彎有車輛停在賽道上' */
  reason: string;
  /** DRS stays disabled until the leader starts this lap after a restart (0 = no lock) */
  drsLockUntilLap: number;
  /** neutralisations so far this session */
  counts: { sc: number; vsc: number; red: number };
  safetyCar: SafetyCarState;
}

export interface SessionState {
  kind: SessionKind;
  phase: SessionPhase;
  /** start lights currently lit, 0..5 */
  lightsOn: number;
  /** world time of lights out (race) / session start */
  startTime: number | null;
  totalLaps: number;
  /** seconds remaining for timed sessions; null = no limit */
  timeRemaining: number | null;
  leaderLap: number;
  drsEnabled: boolean;
  chequeredAt: number | null;
  /** car ids in finishing order */
  finishOrder: number[];
  fastestLap: { carId: number; time: number; lap: number } | null;
  /** race control (flags, VSC, safety car, red flag, formation lap). Always present; 'green' outside races. */
  control: RaceControlState;
}

export interface WeatherState {
  kind: WeatherKind;
  /** current rain intensity 0..1 */
  rain: number;
  /** water on track 0..1 (lags rain) */
  wetness: number;
  dynamic: boolean;
  /** upcoming changes (world time) */
  forecast: { time: number; kind: WeatherKind }[];
  airTemp: number;
  trackTemp: number;
  /** 0..1 */
  rubber: number;
}

export type GameEvent =
  | { type: 'lightsOn'; count: number }
  | { type: 'lightsOut' }
  | { type: 'sessionStart' }
  | { type: 'sector'; carId: number; sector: number; time: number; personalBest: boolean; overallBest: boolean }
  | { type: 'lapComplete'; carId: number; lap: number; time: number; valid: boolean; personalBest: boolean; overallBest: boolean }
  | { type: 'finalLap' }
  | { type: 'chequered' }
  | { type: 'carFinished'; carId: number; position: number }
  | { type: 'sessionEnd' }
  | { type: 'trackLimits'; carId: number; warnings: number }
  | { type: 'penalty'; carId: number; seconds: number; reason: string }
  | { type: 'collision'; carId: number; otherCarId: number | null; impulse: number }
  | { type: 'damage'; carId: number; part: keyof DamageState; level: number }
  | { type: 'drsEnabled' }
  | { type: 'drsAvailable'; carId: number }
  | { type: 'drsOpen'; carId: number }
  | { type: 'overtake'; carId: number; passedCarId: number; position: number }
  | { type: 'pitRequested'; carId: number; compound: TireCompound }
  | { type: 'pitEntry'; carId: number }
  | { type: 'pitStop'; carId: number; duration: number; compound: TireCompound }
  | { type: 'pitExit'; carId: number }
  | { type: 'weatherChange'; kind: WeatherKind }
  | { type: 'shift'; carId: number; gear: number }
  | { type: 'radio'; carId: number | null; text: string }
  | { type: 'retired'; carId: number; reason: string }
  /** race-control mode change (SC / VSC deployed, SC in this lap, red flag, formation lap, green) */
  | { type: 'raceControl'; mode: RaceControlMode; previous: RaceControlMode; reason: string }
  /** local flag change in a sector (0-based); 'clear' = back to green */
  | { type: 'sectorFlag'; sector: number; flag: 'yellow' | 'doubleYellow' | 'clear' }
  /** a car stopped / crashed on or beside the track */
  | { type: 'incident'; carId: number; reason: string }
  /** carId is being lapped by forCarId: let it through */
  | { type: 'blueFlag'; carId: number; forCarId: number }
  /** warning to a car (give a position back, too fast under VSC, ...) */
  | { type: 'controlWarning'; carId: number; reason: string };

export interface WorldState {
  /** simulation time (s) */
  time: number;
  tick: number;
  config: SessionConfig;
  session: SessionState;
  weather: WeatherState;
  cars: CarEntry[];
  /** events emitted since the consumer last drained them (App drains once per frame) */
  events: GameEvent[];
  rng: { s: number };
  flashbacksUsed: number;
  race: WorldRaceInternal;
}

// ───────────────────────────── render view-model ─────────────────────────────
/** Everything the renderer and audio need for one car (also used for replays / ghost). */
export interface CarRenderState {
  /** car id; -1 for the time-trial ghost */
  carId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** body pitch (rad, nose up) incl. the road grade */
  pitch: number;
  /** road grade alone as a nose-up angle (rad): the renderer seats the wheels and contact shadow on it */
  groundPitch?: number;
  roll: number;
  speed: number;
  steerAngle: number;
  wheelSpin: number;
  throttle: number;
  brake: number;
  rpm: number;
  gear: number;
  drsOpen: boolean;
  compound: TireCompound;
  /** rear rain light on */
  rainLight: boolean;
  /** pit limiter light */
  limiter: boolean;
  damage: { frontWing: number; rearWing: number };
  /** 0..1 tyre slip intensity (smoke/squeal) */
  slip: number;
  /** 0..1 lockup intensity */
  lockup: number;
  /** last impact impulse, decays */
  impact: number;
  surface: SurfaceKind;
  /** ERS overtake boost active (2026) */
  boost: boolean;
  visible: boolean;
  ghost: boolean;
}

export interface SafetyCarRenderState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** road grade as a nose-up pitch angle (rad); absent = level */
  pitch?: number;
  speed: number;
  wheelSpin: number;
  lightsOn: boolean;
}

export interface RenderFrame {
  time: number;
  cars: CarRenderState[];
  startLights: { lit: number; out: boolean };
  weather: { kind: WeatherKind; rain: number; wetness: number };
  /** safety car pose while it is on track (absent / null otherwise) */
  safetyCar?: SafetyCarRenderState | null;
  /** trackside marshal light panels: mode + per-sector flags (0 green, 1 yellow, 2 double yellow) */
  raceControl?: { mode: RaceControlMode; sectorFlags: number[] };
}

export interface ViewSpec {
  carId: number;
  camera: CameraMode;
  lookBack: boolean;
  /** normalized viewport, CSS-like origin at TOP-LEFT */
  viewport: { x: number; y: number; w: number; h: number };
}

// ───────────────────────────── results ─────────────────────────────
export interface StandingRow {
  carId: number;
  position: number;
  abbr: string;
  displayName: string;
  teamId: string;
  livery: Livery;
  lap: number;
  gapToLeader: number;
  interval: number;
  lapsDown: number;
  lastLap: number | null;
  bestLap: number | null;
  compound: TireCompound;
  tyreWear: number;
  inPit: boolean;
  status: CarStatus;
  isPlayer: boolean;
  penaltySec: number;
}

export interface ResultRow {
  carId: number;
  driverId: string;
  teamId: string;
  playerIndex: -1 | PlayerIndex;
  position: number;
  gridPosition: number;
  lapsCompleted: number;
  /** race: total time incl. penalties; quali/practice/TT: best lap */
  time: number | null;
  /** human-readable gap / status, e.g. "+3.214", "+1 圈", "退賽" */
  gapText: string;
  bestLap: number | null;
  pitStops: number;
  penaltySec: number;
  points: number;
  fastestLap: boolean;
  status: CarStatus;
}

export interface SessionResult {
  kind: SessionKind;
  mode: GameMode;
  layoutId: string;
  rows: ResultRow[];
  fastestLap: { carId: number; time: number; lap: number } | null;
  weather: WeatherKind;
  /** story objective outcome (null if no objective) */
  objectiveMet: boolean | null;
  /** sprint race (points per SPRINT_POINTS) */
  sprint?: boolean;
}
