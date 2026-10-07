/**
 * Physics-owned types (owner: physics agent). Fields listed here are relied on by other modules —
 * they may be ADDED to but never removed/renamed. Plain data only (CarSpec and PhysicsInternal live in WorldState).
 */
import type { Regulation } from '../core/types';

/** Static per-car parameters, produced by createCarSpec(). */
export interface CarSpec {
  regulation: Regulation;
  /** dry mass incl. driver (kg), excludes fuel */
  mass: number;
  /** overall dimensions (m) — used by renderer, collisions, AI spacing */
  length: number;
  width: number;
  wheelbase: number;
  /** distance from CG to front / rear axle (m) */
  cgToFront: number;
  cgToRear: number;
  trackWidth: number;
  wheelRadius: number;
  /** forward gear ratios, index 0 = 1st gear (length = gear count, 8) */
  gearRatios: number[];
  finalDrive: number;
  idleRpm: number;
  maxRpm: number;
  /** rpm where the shift lights start / auto gearbox upshifts */
  shiftRpm: number;
  /** combustion engine peak power (W) */
  icePower: number;
  /** ERS-K max deployment (W) */
  ersPower: number;
  /** battery energy (J) */
  batteryCapacity: number;
  /** drag area Cd*A (m²) */
  dragArea: number;
  /** downforce area Cl*A (m²) */
  downforceArea: number;
  /** fraction of downforce on the front axle */
  aeroBalance: number;
  fuelCapacity: number;
  /** max steering angle at the wheels (rad) */
  maxSteer: number;

  // ── physics-owned extensions (read-only for other modules) ──
  /** CG height (m), used for longitudinal load transfer */
  cgHeight: number;
  /** yaw moment of inertia (kg·m²) at mass + 50 kg fuel */
  yawInertia: number;
  /** dry peak friction coefficient of the chassis on fresh softs at optimal temperature (team chassis rating applied) */
  baseMu: number;
  /** axle grip multipliers (setup balance; rear > front = stable) */
  frontGrip: number;
  rearGrip: number;
  /** rear longitudinal (traction) grip multiplier from the differential */
  tractionGrip: number;
  /** 0..1 on-throttle differential lock (setup diffOnThrottle mapped) */
  diffLock: number;
  /** fraction of brake force on the front axle (0.5..0.7) */
  brakeBias: number;
  /** total brake force at full pedal (N) */
  maxBrakeForce: number;
  /** rolling resistance coefficient (× total normal load) */
  rollingResistance: number;
  /** engine/gearbox → wheel efficiency */
  drivetrainEfficiency: number;
  /** Pacejka B (stiffness) and C (shape) for lateral tyre force */
  tyreB: number;
  tyreC: number;
  /** grip multiplier on kerbs (setup dependent, ≈ 0.92) */
  kerbGrip: number;
  /** multiplier on tyre heating, wear and grip from setup (tyre pressure) */
  tyreHeatScale: number;
  tyreWearScale: number;
  tyreGripScale: number;
  /** DRS / active-aero open: drag multiplier and front/rear downforce multipliers */
  drsDragScale: number;
  drsFrontDownforceScale: number;
  drsRearDownforceScale: number;
  /** ERS harvest limits (W): under braking / coasting, and "free" on-throttle harvest */
  ersHarvestBrake: number;
  ersHarvestThrottle: number;
  /** extra deployment while the overtake boost is active, as a fraction of ersPower */
  overtakeBoost: number;
  /** clutch-slip launch rpm (1st gear from standstill) */
  launchRpm: number;
  /** gear ratio used in reverse */
  reverseRatio: number;
  /** impact-damage multiplier from the team's reliability rating (sturdier parts take less damage) */
  damageScale: number;
}

/** Physics-private per-car integration state (plain data). Other modules: read-only, except via the exported helpers. */
export interface PhysicsInternal {
  /** runtime hold (grid before lights out / pit stop): car is pinned in place, engine may rev */
  held: boolean;
  /** remaining gear-change time (s); drive torque is cut while > 0 */
  shiftTimer: number;
  /** auto gearbox: minimum time (s) before the next automatic shift */
  shiftCooldown: number;
  /** time (s) the brake has been held at standstill (reverse engagement) */
  brakeHoldTime: number;
  /** reverse: throttle has been used in R since engaging it */
  revDriven: boolean;
  /** reverse: throttle released at standstill after reversing — next throttle press selects 1st */
  revArmed: boolean;
  /** filtered body accelerations (m/s²) used for load transfer and g readouts */
  accelLong: number;
  accelLat: number;
  /** previous-step axle lateral tyre forces (N, wheel frame) for combined-slip TC/ABS */
  fyFront: number;
  fyRear: number;
  /** 0..1 smoothed rear wheel-spin intensity */
  spin: number;
  /** distance driven (m) */
  odometer: number;
  /** last-step ERS deployment / harvest power (W) — telemetry */
  ersDeployW: number;
  ersHarvestW: number;
  /** last-step ICE power used (W) — telemetry / fuel */
  icePowerW: number;
}
