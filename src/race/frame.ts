/**
 * View-model builders: RenderFrame for renderer / audio (cars in world.cars order plus the time-trial ghost,
 * carId -1, interpolated at player 0's current lap time) and best-lap ghost extraction.
 */
import type { BuiltTrack, CarEntry, CarRenderState, GhostData, RenderFrame, SafetyCarRenderState, WorldState } from '../core/types';
import { angleDiff, clamp01, wrapAngle } from '../core/math';
import { sampleAt } from '../track/track';
import { fin, inGarage } from './events';
import { isHazard } from './control';
import { GHOST_DT } from './timing';

/** Half the distance (m) over which the road grade under a car is measured (≈ half its wheelbase). */
const GRADE_HALF_SPAN = 1.8;

/** Road grade under a car as a nose-up pitch angle (rad), so both axles sit on sloped road. */
function gradePitch(track: BuiltTrack, s: number): number {
  if (!Number.isFinite(s)) return 0;
  const rise = sampleAt(track, track.py, s + GRADE_HALF_SPAN) - sampleAt(track, track.py, s - GRADE_HALF_SPAN);
  return Math.atan(fin(rise) / (2 * GRADE_HALF_SPAN));
}

function carState(world: WorldState, track: BuiltTrack, car: CarEntry): CarRenderState {
  const p = car.phys;
  const w = world.weather;
  const wet = car.phys.tire.compound === 'inter' || car.phys.tire.compound === 'wet';
  const grade = gradePitch(track, p.s);
  return {
    carId: car.id,
    x: fin(p.x),
    y: fin(p.y),
    z: fin(p.z),
    yaw: fin(p.yaw),
    pitch: fin(p.pitch) + grade,
    groundPitch: grade,
    roll: fin(p.roll),
    speed: fin(p.speed),
    steerAngle: fin(p.steerAngle),
    wheelSpin: fin(p.wheelSpin),
    throttle: fin(p.throttle),
    brake: fin(p.brake),
    rpm: fin(p.rpm),
    gear: p.gear,
    drsOpen: p.drs.open,
    compound: p.tire.compound,
    rainLight: w.rain > 0.12 || w.wetness > 0.25 || wet,
    limiter: p.limiter,
    damage: { frontWing: clamp01(fin(p.damage.frontWing)), rearWing: clamp01(fin(p.damage.rearWing)) },
    slip: clamp01(Math.max(Math.abs(fin(p.slipAngleRear)) / 0.15, Math.abs(fin(p.slipRatio)) * 3, fin(p.lockup))),
    lockup: clamp01(fin(p.lockup)),
    impact: Math.max(0, fin(p.impact)),
    surface: p.surface,
    boost: p.ers.overtakeActive,
    visible: (car.status !== 'retired' || isHazard(car)) && !inGarage(world, car),
    ghost: false,
  };
}

/** Ghost car at `lapTime` seconds into its lap; null when no sample data. */
function ghostState(ghost: GhostData, lapTime: number, visible: boolean): CarRenderState | null {
  const n = Math.floor(ghost.samples.length / 4);
  const dt = ghost.dt > 0 ? ghost.dt : GHOST_DT;
  if (n < 1) return null;
  const u = Math.max(0, fin(lapTime) / dt);
  const i = Math.min(n - 1, Math.floor(u));
  const j = Math.min(n - 1, i + 1);
  const f = j > i ? Math.min(1, u - i) : 0;
  const s = ghost.samples;
  const x = fin(s[i * 4] + (s[j * 4] - s[i * 4]) * f);
  const y = fin(s[i * 4 + 1] + (s[j * 4 + 1] - s[i * 4 + 1]) * f);
  const z = fin(s[i * 4 + 2] + (s[j * 4 + 2] - s[i * 4 + 2]) * f);
  const yaw = wrapAngle(fin(s[i * 4 + 3]) + angleDiff(fin(s[i * 4 + 3]), fin(s[j * 4 + 3])) * f);
  const speed = j > i ? Math.hypot(s[j * 4] - s[i * 4], s[j * 4 + 2] - s[i * 4 + 2]) / dt : 0;
  return {
    carId: -1,
    x,
    y,
    z,
    yaw,
    pitch: 0,
    roll: 0,
    speed: fin(speed),
    steerAngle: 0,
    wheelSpin: 0,
    throttle: 0,
    brake: 0,
    rpm: 0,
    gear: 0,
    drsOpen: false,
    compound: 'soft',
    rainLight: false,
    limiter: false,
    damage: { frontWing: 0, rearWing: 0 },
    slip: 0,
    lockup: 0,
    impact: 0,
    surface: 'asphalt',
    boost: false,
    visible,
    ghost: true,
  };
}

function safetyCarState(world: WorldState, track: BuiltTrack): SafetyCarRenderState | null {
  const sc = world.session.control.safetyCar;
  if (world.session.kind !== 'race' || !sc.onTrack) return null;
  return {
    x: fin(sc.x), y: fin(sc.y), z: fin(sc.z), yaw: fin(sc.yaw), pitch: gradePitch(track, sc.s),
    speed: fin(sc.speed), wheelSpin: fin(sc.wheelSpin), lightsOn: sc.lightsOn,
  };
}

export function renderFrame(world: WorldState, track: BuiltTrack): RenderFrame {
  const cars = world.cars.map((c) => carState(world, track, c));
  const ghost = world.config.ghost;
  if (ghost && ghost.layoutId === track.id && world.session.kind === 'timeTrial') {
    const player = world.cars.find((c) => c.playerIndex === 0);
    const lap = player ? player.timing.lap : 0;
    const lapTime = player ? player.timing.currentLapTime : 0;
    const visible = !!player && lap >= 1 && lapTime <= fin(ghost.lapTime, 0) + 1 && player.status !== 'retired';
    const g = ghostState(ghost, visible ? lapTime : 0, visible);
    if (g) cars.push(g);
  }
  const s = world.session;
  const raceStarted = s.kind !== 'race' || (s.phase !== 'pre' && s.phase !== 'lights');
  return {
    time: world.time,
    cars,
    startLights: { lit: s.lightsOn, out: raceStarted },
    weather: { kind: world.weather.kind, rain: clamp01(fin(world.weather.rain)), wetness: clamp01(fin(world.weather.wetness)) },
    safetyCar: safetyCarState(world, track),
    raceControl: s.kind === 'race' ? { mode: s.control.mode, sectorFlags: s.control.sectorFlags.slice() } : undefined,
  };
}

/** Best valid lap of a car as ghost data (recorded for human cars outside races), or null. */
export function ghostOf(world: WorldState, carId: number): GhostData | null {
  const car = world.cars[carId];
  if (!car || car.race.ghostBestTime === null || car.race.ghostBest.length < 8) return null;
  return {
    layoutId: world.config.layoutId,
    lapTime: car.race.ghostBestTime,
    driverId: car.driverId,
    teamId: car.teamId,
    dt: GHOST_DT,
    samples: car.race.ghostBest.slice(),
  };
}
