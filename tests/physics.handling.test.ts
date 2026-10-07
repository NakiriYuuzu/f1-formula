/**
 * Keyboard-style handling regressions: digital steering at full lock, lifting off or trail-braking mid-corner,
 * must not snap the car into a spin (the limit balance pushes wide instead). Expert/no-TC power oversteer is allowed.
 */
import { describe, expect, test } from 'bun:test';
import { ASSIST_PRESETS, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import type { Assists, ControlInput, PhysicsEnv, Regulation } from '../src/core/types';
import { TEAMS } from '../src/data/teams';
import { stepDigitalSteer } from '../src/input/smoothing';
import { createCarPhysics, createCarSpec, stepCarPhysics } from '../src/physics/index';

const team = TEAMS.find((t) => t.id === 'nordlys') ?? TEAMS[0];
const input = (throttle: number, brake: number, steer: number): ControlInput => ({
  throttle,
  brake,
  steer,
  shiftUp: false,
  shiftDown: false,
  drsPressed: false,
  ersCycle: false,
  limiterToggle: false,
  overtakeHeld: false,
});

/** Accelerate to `kmh`, then hold the pedals and ramp the digital steering to `steer`; returns the max body slip (rad). */
function maxBodySlip(kmh: number, throttle: number, brake: number, steer: number, assists: Assists, regulation: Regulation = '2025'): number {
  const spec = createCarSpec(team, DEFAULT_SETUP, regulation);
  const car = createCarPhysics({ x: 0, y: 0, z: 0, yaw: 0 }, 'medium', 20, spec);
  car.tire.temp = 92;
  const env: PhysicsEnv = {
    surface: 'asphalt',
    wetness: 0,
    rubber: 0.3,
    trackTemp: 30,
    regulation,
    assists,
    assistTargetSpeed: null,
    wearMultiplier: 0,
    fuelMultiplier: 1,
    damageMultiplier: 0.5,
    performanceScale: 1,
  };
  for (let i = 0; i < 120 * 40 && car.speed * 3.6 < kmh; i++) stepCarPhysics(car, spec, input(1, 0, 0), env, SIM_DT);
  let s = 0;
  let worst = 0;
  for (let i = 0; i < 120 * 2.5; i++) {
    s = stepDigitalSteer(s, steer, SIM_DT);
    stepCarPhysics(car, spec, input(throttle, brake, s), env, SIM_DT);
    worst = Math.max(worst, Math.abs(Math.atan2(car.vLat, Math.max(0.1, Math.abs(car.vLong)))));
  }
  return worst;
}

const SPIN = 0.5; // ≈ 29° body slip
const SPEEDS = [80, 130, 180, 230, 280];

describe('keyboard handling stays catchable', () => {
  for (const preset of ['beginner', 'intermediate'] as const) {
    const assists = ASSIST_PRESETS[preset];
    test(`${preset}: lifting off at full lock never spins`, () => {
      for (const kmh of SPEEDS) expect(maxBodySlip(kmh, 0, 0, 1, assists)).toBeLessThan(SPIN);
    });
    test(`${preset}: trail-braking at 50 % with full lock never spins`, () => {
      for (const kmh of SPEEDS) expect(maxBodySlip(kmh, 0, 0.5, 1, assists)).toBeLessThan(SPIN);
    });
    test(`${preset}: full throttle at full lock never spins`, () => {
      for (const kmh of SPEEDS) expect(maxBodySlip(kmh, 1, 0, 1, assists)).toBeLessThan(SPIN);
    });
  }

  test('2026 car: lifting off at full lock never spins (intermediate)', () => {
    for (const kmh of [80, 180, 280]) expect(maxBodySlip(kmh, 0, 0, 1, ASSIST_PRESETS.intermediate, '2026')).toBeLessThan(SPIN);
  });
});
