/**
 * Physics lap tests: a ~5 km synthetic lap (straights + corners of many radii) driven at racing pace by a simple
 * pure-pursuit driver that uses the exported AI helpers (steerInputForAngle, maxLateralAccel, maxBrakeDecel).
 * Checks tyre wear per lap per compound, fuel per km, tyre temperature window and ERS bounds.
 */
import { describe, expect, test } from 'bun:test';
import {
  createCarPhysics,
  createCarSpec,
  fuelPerKm,
  maxBrakeDecel,
  maxLateralAccel,
  stepCarPhysics,
  steerInputForAngle,
} from '../src/physics/index';
import { TEAMS } from '../src/data/teams';
import { DEFAULT_ASSISTS, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { worldToLocal } from '../src/core/math';
import type { CarPhysicsState, PhysicsEnv, Regulation, TireCompound } from '../src/core/types';

/** [length (m), curvature (1/m, + = right)] */
type Segment = [number, number];
const arc = (deg: number, radius: number): Segment => [(Math.abs(deg) * Math.PI * radius) / 180, Math.sign(deg) / radius];
const LAP: Segment[] = [
  [700, 0], arc(90, 25), [300, 0], arc(-60, 80), [250, 0], arc(45, 200), [500, 0], arc(-120, 40), [200, 0],
  arc(30, 300), [410, 0], arc(90, 60), arc(-90, 60), [400, 0], arc(-150, 35), [300, 0], arc(70, 120), [250, 0],
  arc(-40, 150), [350, 0], arc(100, 50), [200, 0],
];

interface Path {
  x: number[];
  z: number[];
  target: number[];
}

/** 1 m samples of the lap with a target speed from the exported capability helpers (90 % of the limit). */
function buildPath(reg: Regulation): Path {
  const spec = createCarSpec(TEAMS[0]!, DEFAULT_SETUP, reg);
  const x: number[] = [];
  const z: number[] = [];
  const k: number[] = [];
  let px = 0;
  let pz = 0;
  let yaw = 0;
  for (const [len, curv] of LAP) {
    for (let i = 0; i < Math.round(len); i++) {
      x.push(px);
      z.push(pz);
      k.push(curv);
      yaw -= curv;
      px += Math.sin(yaw);
      pz += Math.cos(yaw);
    }
  }
  const target = k.map((c) => {
    let v = 95;
    if (Math.abs(c) > 1e-6) for (let it = 0; it < 8; it++) v = Math.min(95, Math.sqrt(maxLateralAccel(spec, v, 0.9) / Math.abs(c)));
    return v;
  });
  for (let i = target.length - 2; i >= 0; i--) {
    const next = target[i + 1] ?? 95;
    target[i] = Math.min(target[i] ?? 95, Math.sqrt(next * next + 2 * maxBrakeDecel(spec, next, 0.9) * 0.85));
  }
  return { x, z, target };
}

interface LapResult {
  time: number;
  wear: number;
  fuelPerKm: number;
  meanTemp: number;
  maxPathError: number;
  minCharge: number;
  maxCharge: number;
  car: CarPhysicsState;
}

function driveLaps(reg: Regulation, compound: TireCompound, laps: number): LapResult {
  const path = buildPath(reg);
  const spec = createCarSpec(TEAMS[0]!, DEFAULT_SETUP, reg);
  const car = createCarPhysics({ x: 0, y: 0, z: 0, yaw: 0 }, compound, 100, spec);
  const env: PhysicsEnv = {
    surface: 'asphalt',
    wetness: 0,
    rubber: 0.5,
    trackTemp: 35,
    regulation: reg,
    assists: { ...DEFAULT_ASSISTS, traction: 'medium', abs: true, ersAssist: true },
    assistTargetSpeed: null,
    wearMultiplier: 1,
    fuelMultiplier: 1,
    damageMultiplier: 1,
    performanceScale: 1,
  };
  car.vz = 60;
  car.gear = 5;
  car.tire.temp = 90;
  const n = path.x.length;
  const fuel0 = car.fuelKg;
  let time = 0;
  let tempSum = 0;
  let tempN = 0;
  let maxErr = 0;
  let minCharge = 1;
  let maxCharge = 0;
  for (let lap = 0; lap < laps; lap++) {
    let idx = 0;
    if (lap > 0) {
      // restart the course from its first sample with the car's current state carried over
      car.x = 0;
      car.z = 0;
      car.yaw = 0;
      car.vx = 0;
      car.vz = Math.max(40, car.speed);
      car.yawRate = 0;
    }
    while (idx < n - 30 && time < 200 * laps) {
      let best = idx;
      let bestD = Infinity;
      for (let j = idx; j < Math.min(n, idx + 60); j++) {
        const d = ((path.x[j] ?? 0) - car.x) ** 2 + ((path.z[j] ?? 0) - car.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      idx = best;
      maxErr = Math.max(maxErr, Math.sqrt(bestD));
      const lookahead = Math.max(8, Math.min(40, 0.35 * car.speed + 6));
      const li = Math.min(n - 1, idx + Math.round(lookahead));
      const loc = worldToLocal(car.yaw, (path.x[li] ?? 0) - car.x, (path.z[li] ?? 0) - car.z);
      const alpha = Math.atan2(loc.right, loc.forward);
      const wheel = Math.atan((2 * spec.wheelbase * Math.sin(alpha)) / lookahead);
      const target = path.target[Math.min(n - 1, idx + Math.round(car.speed * 0.15))] ?? 50;
      const brake = car.speed > target + 0.3 ? Math.min(1, (car.speed - target) * 0.5) : 0;
      const throttle = brake > 0 ? 0 : Math.max(0, Math.min(1, (target - car.speed) * 0.8 + 0.2));
      stepCarPhysics(
        car,
        spec,
        {
          throttle,
          brake,
          steer: steerInputForAngle(spec, car.speed, wheel),
          shiftUp: false,
          shiftDown: false,
          drsPressed: false,
          ersCycle: false,
          limiterToggle: false,
          overtakeHeld: false,
        },
        env,
        SIM_DT,
      );
      time += SIM_DT;
      tempSum += car.tire.temp;
      tempN++;
      minCharge = Math.min(minCharge, car.ers.charge);
      maxCharge = Math.max(maxCharge, car.ers.charge);
    }
  }
  return {
    time: time / laps,
    wear: car.tire.wear / laps,
    fuelPerKm: (fuel0 - car.fuelKg) / ((n * laps) / 1000),
    meanTemp: tempSum / Math.max(1, tempN),
    maxPathError: maxErr,
    minCharge,
    maxCharge,
    car,
  };
}

describe('racing-pace lap (~5 km)', () => {
  const lapLength = LAP.reduce((sum, [len]) => sum + Math.round(len), 0);

  test('synthetic lap is ~5 km', () => {
    expect(lapLength).toBeGreaterThan(4800);
    expect(lapLength).toBeLessThan(5200);
  });

  const ranges: [TireCompound, number, number][] = [
    ['soft', 15, 20],
    ['medium', 25, 30],
    ['hard', 35, 45],
  ];
  for (const [compound, minLaps, maxLaps] of ranges) {
    test(`${compound} tyre life ${minLaps}–${maxLaps} laps`, () => {
      const r = driveLaps('2025', compound, 1);
      expect(r.maxPathError).toBeLessThan(8);
      expect(r.time).toBeGreaterThan(70);
      expect(r.time).toBeLessThan(110);
      const life = 1 / r.wear;
      expect(life).toBeGreaterThan(minLaps);
      expect(life).toBeLessThan(maxLaps);
    }, 30_000);
  }

  test('fuel use matches fuelPerKm, tyre temperature stays near the window, ERS bounded (2025, 3 laps)', () => {
    const r = driveLaps('2025', 'medium', 3);
    const spec = createCarSpec(TEAMS[0]!, DEFAULT_SETUP, '2025');
    expect(r.fuelPerKm).toBeGreaterThan(fuelPerKm(spec) * 0.9);
    expect(r.fuelPerKm).toBeLessThan(fuelPerKm(spec) * 1.1);
    expect(r.meanTemp).toBeGreaterThan(80);
    expect(r.meanTemp).toBeLessThan(110);
    expect(r.minCharge).toBeGreaterThanOrEqual(0);
    expect(r.maxCharge).toBeLessThanOrEqual(1);
    expect(r.car.ers.harvestedLap).toBeGreaterThan(0);
  }, 60_000);

  test('2026 car completes the lap, uses less fuel, battery bounded', () => {
    const r = driveLaps('2026', 'medium', 2);
    const spec = createCarSpec(TEAMS[0]!, DEFAULT_SETUP, '2026');
    expect(r.maxPathError).toBeLessThan(8);
    expect(r.time).toBeLessThan(115);
    expect(r.fuelPerKm).toBeGreaterThan(fuelPerKm(spec) * 0.88);
    expect(r.fuelPerKm).toBeLessThan(fuelPerKm(spec) * 1.12);
    expect(r.minCharge).toBeGreaterThanOrEqual(0);
    expect(r.maxCharge).toBeLessThanOrEqual(1);
  }, 60_000);
});
