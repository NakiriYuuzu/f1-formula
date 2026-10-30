/**
 * Physics acceptance tests (SPEC 6.2): straight-line performance, braking, steering sign, steady cornering,
 * stability (rest + random-input fuzz), tyres, ERS, DRS / active aero, regulations, gearbox protocol, collisions.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyImpactDamage,
  collideCars,
  collideWithBarrier,
  createCarPhysics,
  createCarSpec,
  fitTyres,
  fuelPerKm,
  MAX_CORNER_SPEED,
  maxBrakeDecel,
  maxCornerSpeed,
  maxLateralAccel,
  setCarHeld,
  speedForRpm,
  stepCarPhysics,
  steerAngleForInput,
  steerInputForAngle,
  tyreGrip,
} from '../src/physics/index';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { aiCarTeam } from '../src/ai/index';
import { predictLapTime } from '../src/race/qualiSim';
import { CAR_PARTS } from '../src/meta/development';
import { DEFAULT_ASSISTS, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { forwardX, forwardZ, nextRandom, rightX, rightZ, worldToLocal } from '../src/core/math';
import type {
  Assists,
  CarPartGains,
  CarPartId,
  CarPhysicsState,
  CarSpec,
  ControlInput,
  PhysicsEnv,
  Regulation,
  SurfaceKind,
  TrackProjection,
} from '../src/core/types';

const TOP_TEAM = TEAMS[0]!;
const kmh = (v: number): number => v * 3.6;

function makeEnv(reg: Regulation = '2025', assists: Partial<Assists> = {}): PhysicsEnv {
  return {
    surface: 'asphalt',
    wetness: 0,
    rubber: 0,
    trackTemp: 35,
    regulation: reg,
    assists: { ...DEFAULT_ASSISTS, ...assists },
    assistTargetSpeed: null,
    wearMultiplier: 1,
    fuelMultiplier: 1,
    damageMultiplier: 1,
    performanceScale: 1,
  };
}

function makeInput(p: Partial<ControlInput> = {}): ControlInput {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    shiftUp: false,
    shiftDown: false,
    drsPressed: false,
    ersCycle: false,
    limiterToggle: false,
    overtakeHeld: false,
    ...p,
  };
}

function makeCar(reg: Regulation = '2025', yaw = 0): { spec: CarSpec; car: CarPhysicsState } {
  const spec = createCarSpec(TOP_TEAM, DEFAULT_SETUP, reg);
  const car = createCarPhysics({ x: 0, y: 0, z: 0, yaw }, 'soft', 50, spec);
  car.tire.temp = 92;
  return { spec, car };
}

function run(car: CarPhysicsState, spec: CarSpec, input: ControlInput, env: PhysicsEnv, seconds: number): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) stepCarPhysics(car, spec, input, env, SIM_DT);
}

/** Flat-out run from standstill; returns the peak speed (m/s). Battery starts full in 'hotlap'. */
function topSpeed(reg: Regulation, drs: boolean): number {
  const { spec, car } = makeCar(reg);
  const env = makeEnv(reg, { ersAssist: false, traction: 'full' });
  car.ers.mode = 'hotlap';
  let peak = 0;
  for (let i = 0; i < 45 / SIM_DT; i++) {
    car.drs.available = drs;
    stepCarPhysics(car, spec, makeInput({ throttle: 1, drsPressed: drs }), env, SIM_DT);
    peak = Math.max(peak, car.speed);
  }
  return peak;
}

function isFiniteState(car: CarPhysicsState): boolean {
  const vals = [
    car.x, car.y, car.z, car.yaw, car.pitch, car.roll, car.vx, car.vz, car.yawRate, car.speed, car.vLong, car.vLat,
    car.steerAngle, car.throttle, car.brake, car.gear, car.rpm, car.wheelSpin, car.slipAngleFront, car.slipAngleRear,
    car.slipRatio, car.lockup, car.gLat, car.gLong, car.tire.wear, car.tire.temp, car.fuelKg, car.ers.charge,
    car.ers.deployedLap, car.ers.harvestedLap, car.impact, car.damage.frontWing, car.damage.rearWing, car.damage.floor,
  ];
  return vals.every((v) => Number.isFinite(v));
}

describe('car spec', () => {
  test('dimensions and power split per regulation', () => {
    const s25 = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const s26 = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2026');
    expect([s25.length, s25.width, s25.wheelbase, s25.mass]).toEqual([5.6, 2.0, 3.6, 800]);
    expect([s26.length, s26.width, s26.wheelbase, s26.mass]).toEqual([5.4, 1.9, 3.4, 770]);
    expect(s25.gearRatios.length).toBe(8);
    expect(s25.icePower).toBeGreaterThan(600_000);
    expect(s25.ersPower).toBeCloseTo(120_000, -4);
    expect(s26.icePower).toBeLessThan(420_000);
    expect(s26.ersPower).toBeGreaterThan(330_000);
    expect(s25.batteryCapacity).toBe(4_000_000);
    expect(s25.cgToFront + s25.cgToRear).toBeCloseTo(s25.wheelbase, 6);
    // calibration vs REFERENCE_CAR (±8 %)
    expect(s25.dragArea).toBeGreaterThan(1.3 * 0.92);
    expect(s25.dragArea).toBeLessThan(1.3 * 1.08);
    expect(s25.downforceArea).toBeGreaterThan(4.2 * 0.92);
    expect(s25.downforceArea).toBeLessThan(4.2 * 1.08);
  });

  test('setup and ratings move the right parameters', () => {
    const base = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const lowWing = createCarSpec(TOP_TEAM, { ...DEFAULT_SETUP, frontWing: 5, rearWing: 5 }, '2025');
    const frontHeavy = createCarSpec(TOP_TEAM, { ...DEFAULT_SETUP, frontWing: 45 }, '2025');
    expect(lowWing.dragArea).toBeLessThan(base.dragArea);
    expect(lowWing.downforceArea).toBeLessThan(base.downforceArea);
    expect(frontHeavy.aeroBalance).toBeGreaterThan(base.aeroBalance);
    const backMarker = createCarSpec(TEAMS[TEAMS.length - 1]!, DEFAULT_SETUP, '2025');
    expect(backMarker.icePower).toBeLessThan(base.icePower);
    expect(backMarker.downforceArea).toBeLessThan(base.downforceArea);
    expect(backMarker.baseMu).toBeLessThan(base.baseMu);
    const upgraded = createCarSpec(TEAMS[TEAMS.length - 1]!, DEFAULT_SETUP, '2025', { powerUnit: 5 });
    expect(upgraded.icePower).toBeGreaterThan(backMarker.icePower);
    const bias = createCarSpec(TOP_TEAM, { ...DEFAULT_SETUP, brakeBias: 65 }, '2025');
    expect(bias.brakeBias).toBeCloseTo(0.65, 6);
    const garbage = createCarSpec(TOP_TEAM, { ...DEFAULT_SETUP, frontWing: Number.NaN, rearWing: 999 }, '2025', {
      floor: Number.NaN,
      ers: Number.POSITIVE_INFINITY,
      weight: -3,
    });
    expect(Object.values(garbage).every((v) => typeof v !== 'number' || Number.isFinite(v))).toBe(true);
  });

  test('helpers: fuel, rpm, steering inverse, capability estimates', () => {
    const spec = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    expect(fuelPerKm(spec)).toBeGreaterThan(0.3);
    expect(fuelPerKm(spec)).toBeLessThan(0.36);
    expect(speedForRpm(spec, 8, spec.maxRpm)).toBeGreaterThan(95);
    expect(speedForRpm(spec, 0, 10_000)).toBe(0);
    for (const v of [0, 10, 40, 80]) {
      const angle = steerAngleForInput(spec, v, 0.37);
      expect(steerInputForAngle(spec, v, angle)).toBeCloseTo(0.37, 6);
    }
    expect(steerInputForAngle(spec, 80, 1)).toBe(1);
    expect(steerInputForAngle(spec, 80, -1)).toBe(-1);
    expect(maxLateralAccel(spec, 60)).toBeGreaterThan(maxLateralAccel(spec, 20));
    expect(maxLateralAccel(spec, 60, 0.5)).toBeLessThan(maxLateralAccel(spec, 60, 1));
    expect(maxBrakeDecel(spec, 83)).toBeGreaterThan(4 * 9.81);
    const assisted = steerAngleForInput(spec, 50, 0.5, true);
    expect(assisted).toBeLessThan(steerAngleForInput(spec, 50, 0.5));
    expect(steerInputForAngle(spec, 50, assisted, true)).toBeCloseTo(0.5, 6);
    const v100 = maxCornerSpeed(spec, 1 / 100);
    expect(v100).toBeGreaterThan(52);
    expect(v100).toBeLessThan(66);
    expect(maxCornerSpeed(spec, -1 / 100)).toBeCloseTo(v100, 9);
    expect(maxCornerSpeed(spec, 1 / 30)).toBeLessThan(v100);
    expect(maxCornerSpeed(spec, 0)).toBe(MAX_CORNER_SPEED);
    expect(maxCornerSpeed(spec, 1 / 100, 0.6)).toBeLessThan(v100);
  });
});

describe('part development (season R&D)', () => {
  const ALL5: CarPartGains = Object.fromEntries(CAR_PARTS.map((p) => [p, 5]));
  const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b));

  test('no / zero / invalid gains leave the spec identical field for field', () => {
    const zero: CarPartGains = Object.fromEntries(CAR_PARTS.map((p) => [p, 0]));
    const setups = [DEFAULT_SETUP, { ...DEFAULT_SETUP, frontWing: 5, rearWing: 45, suspension: 1, rideHeight: 11, tyrePressure: 1 }];
    for (const reg of ['2025', '2026'] as const) {
      for (const team of TEAMS) {
        for (const setup of setups) {
          const plain = createCarSpec(team, setup, reg);
          for (const parts of [{}, zero, { floor: Number.NaN, weight: -2, ers: Number.NEGATIVE_INFINITY }]) {
            const spec = createCarSpec(team, setup, reg, parts);
            expect(spec).toStrictEqual(plain);
            for (const key of Object.keys(plain) as (keyof CarSpec)[]) expect(same(spec[key], plain[key])).toBe(true);
          }
        }
      }
    }
  });

  test('each part moves only its own fields, in the right direction', () => {
    const base = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const expected: Record<CarPartId, Partial<Record<keyof CarSpec, 1 | -1>>> = {
      frontWing: { downforceArea: 1, aeroBalance: 1 },
      rearWing: { downforceArea: 1, aeroBalance: -1, dragArea: -1 },
      floor: { downforceArea: 1 },
      suspension: { baseMu: 1, kerbGrip: 1, tyreWearScale: -1 },
      powerUnit: { icePower: 1 },
      ers: { ersPower: 1, ersHarvestBrake: 1, ersHarvestThrottle: 1 },
      gearbox: { drivetrainEfficiency: 1 },
      brakes: { maxBrakeForce: 1, brakeGrip: 1, ersHarvestBrake: 1 },
      weight: { mass: -1, yawInertia: -1 },
      reliability: { damageScale: -1 },
    };
    for (const part of CAR_PARTS) {
      const spec = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025', { [part]: 3 });
      const changed = (Object.keys(base) as (keyof CarSpec)[]).filter((k) => !same(spec[k], base[k]));
      expect(changed.sort()).toEqual(Object.keys(expected[part]).sort());
      for (const [key, sign] of Object.entries(expected[part]) as [keyof CarSpec, number][]) {
        expect(Math.sign((spec[key] as number) - (base[key] as number))).toBe(sign);
      }
    }
  });

  test('level-5 sizes match the design table; gains clamp to 0..5', () => {
    const base = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const at = (parts: CarPartGains): CarSpec => createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025', parts);
    expect(at({ floor: 5 }).downforceArea / base.downforceArea).toBeCloseTo(1.05, 9);
    expect(at({ rearWing: 5 }).dragArea / base.dragArea).toBeCloseTo(0.96, 9);
    expect(at({ powerUnit: 5 }).icePower / base.icePower).toBeCloseTo(1.06, 9);
    expect(at({ ers: 5 }).ersPower / base.ersPower).toBeCloseTo(1.15, 9);
    expect(at({ ers: 5 }).ersHarvestThrottle / base.ersHarvestThrottle).toBeCloseTo(1.15, 9);
    expect(at({ ers: 5, brakes: 5 }).ersHarvestBrake / base.ersHarvestBrake).toBeCloseTo(1.15 * 1.1, 9);
    expect(at({ gearbox: 5 }).drivetrainEfficiency).toBeCloseTo(0.9, 9);
    expect(at({ brakes: 5 }).maxBrakeForce).toBeCloseTo(71_300, 6);
    expect(base.brakeGrip).toBe(1);
    expect(at({ brakes: 5 }).brakeGrip).toBeCloseTo(1.03, 12);
    expect(at({ suspension: 5 }).baseMu / base.baseMu).toBeCloseTo(1.02, 9);
    expect(at({ suspension: 5 }).kerbGrip).toBeCloseTo(base.kerbGrip + 0.05, 9);
    expect(at({ suspension: 5 }).tyreWearScale / base.tyreWearScale).toBeCloseTo(0.9, 9);
    expect(at({ weight: 5 }).mass).toBe(base.mass - 10);
    expect(at({ weight: 5 }).yawInertia / base.yawInertia).toBeCloseTo((base.mass - 10 + 50) / (base.mass + 50), 9);
    expect(at({ reliability: 5 }).damageScale / base.damageScale).toBeCloseTo(0.8, 9);
    // everything at 5: ≈ +10 % downforce, −4 % drag, balance slightly forward
    const all = at(ALL5);
    expect(all.downforceArea / base.downforceArea).toBeGreaterThan(1.09);
    expect(all.downforceArea / base.downforceArea).toBeLessThan(1.11);
    expect(all.dragArea / base.dragArea).toBeCloseTo(0.96, 9);
    expect(all.aeroBalance).toBeGreaterThan(base.aeroBalance);
    expect(all.aeroBalance - base.aeroBalance).toBeLessThan(0.02);
    // clamps
    expect(at({ powerUnit: 9, floor: 5.5 })).toStrictEqual(at({ powerUnit: 5, floor: 5 }));
    expect(at({ powerUnit: -1 })).toStrictEqual(base);
    expect(at({ powerUnit: 2.5 }).icePower / base.icePower).toBeCloseTo(1.03, 9);
    const kerbHeavy = createCarSpec(TOP_TEAM, { ...DEFAULT_SETUP, suspension: 1, rideHeight: 11 }, '2025', { suspension: 5 });
    expect(kerbHeavy.kerbGrip).toBe(0.98);
    const sturdiest = { ...TOP_TEAM, rating: { ...TOP_TEAM.rating, reliability: 1.05 } };
    const sturdy = createCarSpec(sturdiest, DEFAULT_SETUP, '2025', { reliability: 5 });
    expect(sturdy.damageScale).toBeGreaterThanOrEqual(0.6);
    expect(sturdy.damageScale).toBeCloseTo(0.6, 9);
  });

  test('brakes part: tyre braking limit +3 % at Lv5 (maxBrakeDecel, full-physics braking with ABS), identity at 0', () => {
    const base = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const at5 = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025', { brakes: 5 });
    // capability model (AI / quali sim): ≈ +3 % at low speed, a little less where the brake force cap starts to bite
    for (const v of [0, 30, 50, 70, 90]) {
      const ratio = maxBrakeDecel(at5, v) / maxBrakeDecel(base, v);
      expect(ratio).toBeGreaterThan(1.02);
      expect(ratio).toBeLessThanOrEqual(1.0300001);
    }
    // full physics, straight line 300 → 100 km/h at full pedal
    const brakeFrom300 = (spec: CarSpec, abs: boolean): { dist: number; lockup: number; wear: number } => {
      const car = createCarPhysics({ x: 0, y: 0, z: 0, yaw: 0 }, 'soft', 50, spec);
      car.tire.temp = 92;
      car.vz = 300 / 3.6;
      car.speed = 300 / 3.6;
      car.gear = 8;
      const env = makeEnv('2025', { abs });
      const wear0 = car.tire.wear;
      let lockup = 0;
      for (let i = 0; i < 10 / SIM_DT && car.speed > 100 / 3.6; i++) {
        stepCarPhysics(car, spec, makeInput({ brake: 1 }), env, SIM_DT);
        lockup = Math.max(lockup, car.lockup);
      }
      expect(car.speed).toBeLessThanOrEqual(100 / 3.6);
      return { dist: car.z, lockup, wear: car.tire.wear - wear0 };
    };
    const plain = brakeFrom300(base, true);
    const developed = brakeFrom300(at5, true);
    expect(plain.dist).toBeGreaterThan(60);
    expect(plain.dist).toBeLessThan(120);
    // measured −2.6 % with ABS (no lock-up either way); without ABS still shorter
    expect(developed.dist / plain.dist).toBeLessThan(0.985);
    expect(developed.dist / plain.dist).toBeGreaterThan(0.96);
    expect(developed.lockup).toBeLessThan(0.05);
    // the slip that wears the tyres counts brake use against fmax × brakeGrip too: the shorter ABS stop does not wear
    // the tyres more (measured −0.2 %; +1.6 % while the slip still used plain fmax)
    expect(developed.wear).toBeGreaterThan(0);
    expect(developed.wear / plain.wear).toBeLessThanOrEqual(1);
    expect(developed.wear / plain.wear).toBeGreaterThan(0.98);
    expect(brakeFrom300(at5, false).dist).toBeLessThan(brakeFrom300(base, false).dist);
    // brakes at 0 = the plain spec, step for step
    const zero = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025', { brakes: 0 });
    expect(zero).toStrictEqual(base);
    expect(Object.is(brakeFrom300(zero, true).dist, plain.dist)).toBe(true);
    expect(Object.is(brakeFrom300(zero, true).wear, plain.wear)).toBe(true);
    expect(Object.is(brakeFrom300(zero, false).dist, brakeFrom300(base, false).dist)).toBe(true);
  });

  test('all parts at level 5: clearly but not absurdly faster on the in-game point-mass lap', () => {
    // measured (difficulty 90, dry): 3.1 % (monaco) … 5.0 % (isola-verde), both regulations, front-runner and back-marker
    const backMarker = TEAMS[TEAMS.length - 1]!;
    for (const reg of ['2025', '2026'] as const) {
      for (const layoutId of ['porto-lumen', 'highland-ridge', 'isola-verde', 'monaco']) {
        const track = getLayout(layoutId);
        expect(track.id).toBe(layoutId);
        for (const raw of [TOP_TEAM, backMarker]) {
          const team = aiCarTeam(raw);
          const driver = DRIVERS.find((d) => d.teamId === raw.id)!;
          const base = predictLapTime(track, team, driver, 90, reg, 0);
          const gain = 1 - predictLapTime(track, team, driver, 90, reg, 0, ALL5) / base;
          expect(gain).toBeGreaterThan(0.025);
          expect(gain).toBeLessThan(0.06);
          // no single part carries the package (front wing / power unit / ERS / suspension ≈ 25–31 % at most)
          for (const part of CAR_PARTS) {
            const single = 1 - predictLapTime(track, team, driver, 90, reg, 0, { [part]: 5 }) / base;
            expect(single).toBeGreaterThanOrEqual(0);
            expect(single).toBeLessThan(0.4 * gain);
          }
        }
      }
    }
  });
});

describe('straight line', () => {
  test('2025 top speed 320–345 km/h without DRS, DRS adds 8–18 km/h', () => {
    const plain = kmh(topSpeed('2025', false));
    const drs = kmh(topSpeed('2025', true));
    expect(plain).toBeGreaterThan(320);
    expect(plain).toBeLessThan(345);
    expect(drs - plain).toBeGreaterThan(8);
    expect(drs - plain).toBeLessThan(18);
  }, 30_000);

  test('2026 active aero gives a larger straight-line gain than 2025 DRS', () => {
    const gain26 = topSpeed('2026', true) - topSpeed('2026', false);
    const gain25 = topSpeed('2025', true) - topSpeed('2025', false);
    expect(gain26).toBeGreaterThan(gain25);
  }, 30_000);

  test('0–100 km/h in 2.4–3.4 s with full TC, straight and without yaw', () => {
    const { spec, car } = makeCar();
    const env = makeEnv('2025', { traction: 'full' });
    let t = -1;
    for (let i = 1; i < 6 / SIM_DT && t < 0; i++) {
      stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, SIM_DT);
      if (car.speed >= 100 / 3.6) t = i * SIM_DT;
    }
    expect(t).toBeGreaterThan(2.4);
    expect(t).toBeLessThan(3.4);
    expect(Math.abs(car.x)).toBeLessThan(0.01);
    expect(Math.abs(car.yaw)).toBeLessThan(1e-6);
  });

  test('300→100 km/h braking distance < 120 m (with and without ABS)', () => {
    for (const abs of [true, false]) {
      const { spec, car } = makeCar();
      const env = makeEnv('2025', { abs });
      car.vz = 300 / 3.6;
      car.speed = 300 / 3.6;
      car.gear = 8;
      let steps = 0;
      let lockup = 0;
      while (car.speed > 100 / 3.6 && steps < 10 / SIM_DT) {
        stepCarPhysics(car, spec, makeInput({ brake: 1 }), env, SIM_DT);
        lockup = Math.max(lockup, car.lockup);
        steps++;
      }
      expect(car.speed).toBeLessThanOrEqual(100 / 3.6);
      // the stop was actually simulated (≈ 81 m with ABS, ≈ 87 m without), not skipped
      expect(car.z).toBeGreaterThan(60);
      expect(car.z).toBeLessThan(120);
      if (abs) expect(lockup).toBeLessThan(0.05);
    }
  });

  test('auto gearbox upshifts through all gears without hunting', () => {
    const { spec, car } = makeCar();
    const env = makeEnv('2025', { gearbox: 'auto' });
    const changes: number[] = [];
    let gear = car.gear;
    for (let i = 0; i < 30 / SIM_DT; i++) {
      stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, SIM_DT);
      if (car.gear !== gear) {
        changes.push(car.gear);
        gear = car.gear;
      }
    }
    expect(changes).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(car.rpm).toBeLessThanOrEqual(spec.maxRpm * 1.02);
  }, 15_000);
});

describe('handling', () => {
  test('right steer moves the car right and yaw decreases', () => {
    const { spec, car } = makeCar();
    car.vz = 30;
    car.gear = 3;
    run(car, spec, makeInput({ steer: 0.5, throttle: 0.3 }), makeEnv(), 1);
    const loc = worldToLocal(0, car.x, car.z);
    expect(loc.right).toBeGreaterThan(1);
    expect(car.yaw).toBeLessThan(0);
    expect(car.yawRate).toBeLessThan(0);
    expect(car.gLat).toBeGreaterThan(0.5);
  });

  test('steady cornering on a flat 100 m circle reaches ≥ 2.8 g', () => {
    const R = 100;
    const { spec, car } = makeCar();
    const env = makeEnv('2025', { traction: 'full', ersAssist: false });
    const cx = -R; // centre on the car's right (car at origin facing +z)
    const cz = 0;
    let vTarget = 25;
    let best = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 100 / SIM_DT; i++) {
      const dx = car.x - cx;
      const dz = car.z - cz;
      const r = Math.hypot(dx, dz);
      const lookahead = Math.max(12, car.speed * 0.6);
      const ang = Math.atan2(dz, dx) + lookahead / R;
      const loc = worldToLocal(car.yaw, cx + R * Math.cos(ang) - car.x, cz + R * Math.sin(ang) - car.z);
      const alpha = Math.atan2(loc.right, loc.forward);
      const wheelAngle = Math.atan((2 * spec.wheelbase * Math.sin(alpha)) / lookahead);
      vTarget += 0.4 * SIM_DT;
      const throttle = Math.min(1, Math.max(0, (vTarget - car.speed) * 0.5));
      stepCarPhysics(car, spec, makeInput({ throttle, steer: steerInputForAngle(spec, car.speed, wheelAngle) }), env, SIM_DT);
      if (i * SIM_DT < 5) continue;
      if (Math.abs(r - R) < 3) {
        sum += (car.speed * car.speed) / r;
        n++;
        if (n >= 120) {
          best = Math.max(best, sum / n);
          sum = 0;
          n = 0;
        }
      } else {
        sum = 0;
        n = 0;
      }
      if (Math.abs(r - R) > 15) break;
      expect(isFiniteState(car)).toBe(true);
    }
    expect(best / 9.81).toBeGreaterThanOrEqual(2.8);
  }, 20_000);

  test('front-wing damage reduces front grip (lower sustained cornering speed)', () => {
    const steady = (frontWing: number): number => {
      const { spec, car } = makeCar();
      car.damage.frontWing = frontWing;
      car.vz = 70;
      car.gear = 7;
      const env = makeEnv('2025', { traction: 'full' });
      // constant wheel angle; measure the resulting yaw rate after settling at constant speed
      for (let i = 0; i < 4 / SIM_DT; i++) {
        const throttle = Math.min(1, Math.max(0, (70 - car.speed) * 0.5));
        stepCarPhysics(car, spec, makeInput({ throttle, steer: steerInputForAngle(spec, car.speed, 0.06) }), env, SIM_DT);
      }
      return Math.abs(car.yawRate);
    };
    expect(steady(1)).toBeLessThan(steady(0) * 0.95);
  });
});

describe('stability', () => {
  test('a car at rest stays at rest (steering, brake, no throttle)', () => {
    const spec = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const car = createCarPhysics({ x: 12, y: 3, z: -40, yaw: 1.1 }, 'medium', 60, spec);
    const env = makeEnv();
    for (let i = 0; i < 20 / SIM_DT; i++) {
      stepCarPhysics(car, spec, makeInput({ steer: Math.sin(i * 0.01), brake: i % 500 < 50 ? 0.3 : 0 }), env, SIM_DT);
    }
    expect(car.x).toBeCloseTo(12, 9);
    expect(car.z).toBeCloseTo(-40, 9);
    expect(car.yaw).toBeCloseTo(1.1, 9);
    expect(car.speed).toBe(0);
  });

  test('random inputs for 60 s never produce NaN/Infinity (both regulations, all surfaces)', () => {
    const rng = { s: 1234 };
    const surfaces: SurfaceKind[] = ['asphalt', 'kerb', 'grass', 'gravel', 'runoff', 'pitlane'];
    for (const reg of ['2025', '2026'] as const) {
      const spec = createCarSpec(TOP_TEAM, DEFAULT_SETUP, reg);
      const car = createCarPhysics({ x: 0, y: 0, z: 0, yaw: 0.3 }, 'soft', 80, spec, 'grid');
      const env = makeEnv(reg, { gearbox: 'manual', abs: false, traction: 'off', steering: true, braking: 'high' });
      let input = makeInput();
      for (let i = 0; i < 60 / SIM_DT; i++) {
        if (i % 30 === 0) {
          input = makeInput({
            throttle: nextRandom(rng),
            brake: nextRandom(rng) < 0.3 ? nextRandom(rng) : 0,
            steer: nextRandom(rng) * 2 - 1,
            overtakeHeld: nextRandom(rng) < 0.3,
          });
          env.surface = surfaces[Math.floor(nextRandom(rng) * surfaces.length)] ?? 'asphalt';
          env.wetness = nextRandom(rng);
          env.assistTargetSpeed = nextRandom(rng) < 0.5 ? nextRandom(rng) * 80 : null;
          env.assists.abs = nextRandom(rng) < 0.5;
          car.drs.available = nextRandom(rng) < 0.5;
          car.ers.overtakeAvailable = nextRandom(rng) < 0.5;
        }
        const oneShot = i % 30 === 1;
        if (i === 600) setCarHeld(car, false);
        stepCarPhysics(
          car,
          spec,
          {
            ...input,
            shiftUp: oneShot && nextRandom(rng) < 0.5,
            shiftDown: oneShot && nextRandom(rng) < 0.3,
            drsPressed: oneShot,
            ersCycle: oneShot && nextRandom(rng) < 0.2,
            limiterToggle: oneShot && nextRandom(rng) < 0.05,
          },
          env,
          SIM_DT,
        );
        if (!isFiniteState(car)) throw new Error(`non-finite state at step ${i} (${reg})`);
        expect(car.ers.charge).toBeGreaterThanOrEqual(0);
        expect(car.ers.charge).toBeLessThanOrEqual(1);
      }
      expect(car.internal.odometer).toBeGreaterThan(100);
    }
  }, 30_000);

  test('a car sliding sideways at speed keeps sliding (no low-|vLong| snap) and spins down smoothly', () => {
    const { spec, car } = makeCar();
    car.vx = rightX(0) * 40; // pure sideways motion to the right
    car.vz = 0;
    car.yawRate = 2;
    stepCarPhysics(car, spec, makeInput(), makeEnv(), SIM_DT);
    expect(car.speed).toBeGreaterThan(38);
    let prev = car.speed;
    for (let i = 0; i < 8 / SIM_DT; i++) {
      stepCarPhysics(car, spec, makeInput({ brake: 1 }), makeEnv(), SIM_DT);
      expect(car.speed).toBeLessThanOrEqual(prev + 0.5);
      expect(isFiniteState(car)).toBe(true);
      prev = car.speed;
    }
    expect(car.speed).toBeLessThan(1);
  });

  test('garbage input values are sanitised', () => {
    const { spec, car } = makeCar();
    const env = makeEnv();
    const bad = makeInput({ throttle: Number.NaN, brake: Infinity, steer: -Infinity });
    run(car, spec, bad, env, 1);
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, 0);
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, Number.NaN);
    expect(isFiniteState(car)).toBe(true);
  });
});

describe('tyres', () => {
  test('grip table: dry softs ≈ 1, compounds ordered, wet crossover points', () => {
    expect(tyreGrip('soft', 0, 95, 0)).toBeCloseTo(1, 3);
    expect(tyreGrip('medium', 0, 95, 0)).toBeCloseTo(0.975, 3);
    expect(tyreGrip('hard', 0, 100, 0)).toBeCloseTo(0.95, 3);
    const slick = (w: number): number => tyreGrip('soft', 0, 95, w);
    const inter = (w: number): number => tyreGrip('inter', 0, 60, w);
    const wet = (w: number): number => tyreGrip('wet', 0, 50, w);
    expect(slick(1)).toBeGreaterThan(0.5);
    expect(slick(1)).toBeLessThan(0.6);
    for (const w of [0.3, 0.4, 0.5, 0.6]) {
      expect(inter(w)).toBeGreaterThanOrEqual(slick(w));
      expect(inter(w)).toBeGreaterThanOrEqual(wet(w) - 1e-9);
    }
    for (const w of [0.65, 0.8, 1]) {
      expect(wet(w)).toBeGreaterThan(inter(w));
      expect(wet(w)).toBeGreaterThan(slick(w));
    }
    expect(slick(0.1)).toBeGreaterThan(inter(0.1));
    // temperature and wear penalties
    expect(tyreGrip('soft', 0, 30, 0)).toBeLessThan(0.9);
    expect(tyreGrip('soft', 0, 140, 0)).toBeLessThan(0.9);
    expect(tyreGrip('soft', 1, 95, 0)).toBeLessThan(0.8);
    expect(tyreGrip('soft', 0.5, 95, 0)).toBeGreaterThan(0.94);
    expect(Number.isFinite(tyreGrip('soft', Number.NaN, Number.NaN, Number.NaN))).toBe(true);
  });

  test('tyres heat up when driven and cool toward track temperature when parked', () => {
    const { spec, car } = makeCar();
    car.tire.temp = 40;
    car.vz = 50;
    car.gear = 5;
    const env = makeEnv();
    for (let i = 0; i < 30 / SIM_DT; i++) {
      const throttle = Math.min(1, Math.max(0, (60 - car.speed) * 0.5));
      stepCarPhysics(car, spec, makeInput({ throttle, steer: Math.sin(i * SIM_DT) * 0.3 }), env, SIM_DT);
    }
    expect(car.tire.temp).toBeGreaterThan(60);
    const hot = car.tire.temp;
    run(car, spec, makeInput({ brake: 1 }), env, 60);
    expect(car.tire.temp).toBeLessThan(hot);
  });

  test('wear disabled by wearMultiplier 0; fitTyres resets and repairs', () => {
    const { spec, car } = makeCar();
    const env = makeEnv();
    env.wearMultiplier = 0;
    run(car, spec, makeInput({ throttle: 1, steer: 0.2 }), env, 10);
    expect(car.tire.wear).toBe(0);
    car.tire.wear = 0.8;
    car.damage.frontWing = 0.7;
    fitTyres(car, 'hard', true);
    expect(car.tire).toMatchObject({ compound: 'hard', wear: 0, laps: 0 });
    expect(car.damage.frontWing).toBe(0);
  });

  test('low-grip surfaces: gravel decelerates hard, grass less', () => {
    const coast = (surface: SurfaceKind): number => {
      const { spec, car } = makeCar();
      car.vz = 50;
      car.gear = 5;
      const env = makeEnv();
      env.surface = surface;
      run(car, spec, makeInput(), env, 1);
      return car.speed;
    };
    const asphalt = coast('asphalt');
    const grass = coast('grass');
    const gravel = coast('gravel');
    expect(grass).toBeLessThan(asphalt - 1.5);
    expect(gravel).toBeLessThan(asphalt - 6);
  });
});

describe('ERS, DRS and regulations', () => {
  test('battery stays within 0..1, deploys under throttle and harvests under braking', () => {
    const { spec, car } = makeCar();
    const env = makeEnv('2025', { ersAssist: false });
    car.ers.mode = 'overtake';
    run(car, spec, makeInput({ throttle: 1 }), env, 60);
    expect(car.ers.charge).toBeGreaterThanOrEqual(0);
    expect(car.ers.charge).toBeLessThan(0.05);
    expect(car.ers.deployedLap).toBeGreaterThan(3_000_000);
    const before = car.ers.harvestedLap;
    for (let k = 0; k < 20; k++) {
      run(car, spec, makeInput({ brake: 1 }), env, 1.5);
      run(car, spec, makeInput({ throttle: 1 }), env, 4);
    }
    expect(car.ers.harvestedLap).toBeGreaterThan(before);
    car.ers.mode = 'none';
    car.ers.charge = 0.999;
    run(car, spec, makeInput({ throttle: 1 }), env, 30);
    expect(car.ers.charge).toBeLessThanOrEqual(1);
    expect(car.ers.charge).toBeGreaterThan(0.99);
  }, 15_000);

  test('ersCycle cycles modes; ersAssist picks modes from the charge', () => {
    const { spec, car } = makeCar();
    const manual = makeEnv('2025', { ersAssist: false });
    car.ers.mode = 'none';
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      stepCarPhysics(car, spec, makeInput({ ersCycle: true }), manual, SIM_DT);
      seen.push(car.ers.mode);
    }
    expect(seen).toEqual(['medium', 'hotlap', 'overtake', 'none']);
    const assisted = makeEnv('2025', { ersAssist: true });
    car.ers.charge = 0.1;
    stepCarPhysics(car, spec, makeInput(), assisted, SIM_DT);
    expect(car.ers.mode).toBe('none');
  });

  test('overtake boost: active only when held and available; 2026 adds power', () => {
    const accelFrom = (reg: Regulation, held: boolean, available: boolean): { gain: number; active: boolean } => {
      const { spec, car } = makeCar(reg);
      const env = makeEnv(reg, { ersAssist: false });
      car.ers.mode = 'medium';
      car.vz = 60;
      car.gear = 6;
      car.ers.overtakeAvailable = available;
      let active = false;
      for (let i = 0; i < 2 / SIM_DT; i++) {
        stepCarPhysics(car, spec, makeInput({ throttle: 1, overtakeHeld: held }), env, SIM_DT);
        active ||= car.ers.overtakeActive;
      }
      return { gain: car.speed - 60, active };
    };
    const base26 = accelFrom('2026', false, true);
    const boost26 = accelFrom('2026', true, true);
    const denied26 = accelFrom('2026', true, false);
    expect(boost26.active).toBe(true);
    expect(base26.active).toBe(false);
    expect(denied26.active).toBe(false);
    expect(boost26.gain).toBeGreaterThan(base26.gain + 0.5);
    expect(accelFrom('2025', true, true).gain).toBeGreaterThan(accelFrom('2025', false, true).gain);
  });

  test('DRS opens only when available, closes on braking or when unavailable', () => {
    const { spec, car } = makeCar();
    const env = makeEnv('2025', { drsAssist: false });
    car.vz = 70;
    car.gear = 7;
    stepCarPhysics(car, spec, makeInput({ throttle: 1, drsPressed: true }), env, SIM_DT);
    expect(car.drs.open).toBe(false);
    car.drs.available = true;
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, SIM_DT);
    expect(car.drs.open).toBe(false);
    stepCarPhysics(car, spec, makeInput({ throttle: 1, drsPressed: true }), env, SIM_DT);
    expect(car.drs.open).toBe(true);
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, SIM_DT);
    expect(car.drs.open).toBe(true);
    stepCarPhysics(car, spec, makeInput({ brake: 0.5 }), env, SIM_DT);
    expect(car.drs.open).toBe(false);
    stepCarPhysics(car, spec, makeInput({ throttle: 1, drsPressed: true }), env, SIM_DT);
    car.drs.available = false;
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, SIM_DT);
    expect(car.drs.open).toBe(false);
    const assisted = makeEnv('2025', { drsAssist: true });
    car.drs.available = true;
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), assisted, SIM_DT);
    expect(car.drs.open).toBe(true);
  });

  test('2026 straight mode also reduces downforce (2025 DRS keeps the front)', () => {
    const s25 = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const s26 = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2026');
    expect(s26.drsDragScale).toBeLessThan(s25.drsDragScale);
    expect(s26.drsFrontDownforceScale).toBeLessThan(0.7);
    expect(s26.drsRearDownforceScale).toBeLessThan(0.7);
    expect(s25.drsFrontDownforceScale).toBe(1);
    expect(fuelPerKm(s26)).toBeLessThan(fuelPerKm(s25));
  });

  test('2026 straight mode returns to corner mode under lateral load and reopens only once it is low', () => {
    const { spec, car } = makeCar('2026');
    const env = makeEnv('2026', { drsAssist: true });
    car.vz = 70;
    car.gear = 7;
    car.drs.available = true;
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, SIM_DT);
    expect(car.drs.open).toBe(true);
    car.gLat = 1.5;
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, SIM_DT);
    expect(car.drs.open).toBe(false);
    car.gLat = 0.8;
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, SIM_DT);
    expect(car.drs.open).toBe(false);
    car.gLat = 0.2;
    stepCarPhysics(car, spec, makeInput({ throttle: 1 }), env, SIM_DT);
    expect(car.drs.open).toBe(true);
    // 2025 DRS only sheds rear downforce: lateral load alone does not close it
    const c25 = makeCar('2025');
    c25.car.vz = 70;
    c25.car.gear = 7;
    c25.car.drs.available = true;
    c25.car.drs.open = true;
    c25.car.gLat = 1.5;
    stepCarPhysics(c25.car, c25.spec, makeInput({ throttle: 1 }), makeEnv('2025', { drsAssist: true }), SIM_DT);
    expect(c25.car.drs.open).toBe(true);
  });

  test('reliability rating scales impact damage', () => {
    const sturdy = createCarSpec({ ...TOP_TEAM, rating: { ...TOP_TEAM.rating, reliability: 0.97 } }, DEFAULT_SETUP, '2025');
    const fragile = createCarSpec({ ...TOP_TEAM, rating: { ...TOP_TEAM.rating, reliability: 0.9 } }, DEFAULT_SETUP, '2025');
    expect(sturdy.damageScale).toBeLessThan(1);
    expect(fragile.damageScale).toBeGreaterThan(1);
    expect(sturdy.damageScale).toBeGreaterThanOrEqual(0.75);
    expect(fragile.damageScale).toBeLessThanOrEqual(1.3);
  });

  test('pit limiter caps speed at 80 km/h', () => {
    const { spec, car } = makeCar();
    const env = makeEnv();
    stepCarPhysics(car, spec, makeInput({ limiterToggle: true }), env, SIM_DT);
    expect(car.limiter).toBe(true);
    run(car, spec, makeInput({ throttle: 1 }), env, 15);
    expect(kmh(car.speed)).toBeLessThanOrEqual(80.5);
    expect(kmh(car.speed)).toBeGreaterThan(75);
  });

  test('braking assist slows the car toward assistTargetSpeed', () => {
    const { spec, car } = makeCar();
    const env = makeEnv('2025', { braking: 'high' });
    car.vz = 80;
    car.gear = 8;
    env.assistTargetSpeed = 30;
    run(car, spec, makeInput({ throttle: 1 }), env, 4);
    expect(car.speed).toBeLessThan(33);
  });
});

describe('gearbox protocol', () => {
  test('grid: held in neutral, revs, released by runtime, first throttle selects 1st', () => {
    const spec = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const car = createCarPhysics({ x: 1, y: 0, z: 2, yaw: 0.5 }, 'medium', 50, spec, 'grid');
    const env = makeEnv();
    expect(car.gear).toBe(0);
    run(car, spec, makeInput({ throttle: 1 }), env, 2);
    expect(car.gear).toBe(0);
    expect([car.x, car.z, car.speed]).toEqual([1, 2, 0]);
    expect(car.rpm).toBeGreaterThan(8000);
    setCarHeld(car, false);
    run(car, spec, makeInput(), env, 1);
    expect(car.gear).toBe(0);
    expect(car.speed).toBe(0);
    run(car, spec, makeInput({ throttle: 1 }), env, 1);
    expect(car.gear).toBeGreaterThanOrEqual(1);
    expect(car.speed).toBeGreaterThan(5);
  });

  test('reverse: brake held at standstill, throttle reverses, re-press after stopping returns to 1st', () => {
    const { spec, car } = makeCar();
    const env = makeEnv();
    run(car, spec, makeInput({ brake: 1 }), env, 0.4);
    expect(car.gear).toBe(1);
    run(car, spec, makeInput({ brake: 1 }), env, 0.3);
    expect(car.gear).toBe(-1);
    run(car, spec, makeInput({ throttle: 1 }), env, 2);
    expect(car.vLong).toBeLessThan(-3);
    expect(car.vLong).toBeGreaterThan(-7.5);
    run(car, spec, makeInput({ brake: 1 }), env, 2);
    expect(car.speed).toBeLessThan(0.01);
    run(car, spec, makeInput(), env, 0.1);
    run(car, spec, makeInput({ throttle: 1 }), env, 1);
    expect(car.gear).toBeGreaterThanOrEqual(1);
    expect(car.vLong).toBeGreaterThan(3);
  });

  test('manual shifting via one-shot inputs, over-rev downshift blocked', () => {
    const { spec, car } = makeCar();
    const env = makeEnv('2025', { gearbox: 'manual' });
    stepCarPhysics(car, spec, makeInput({ shiftUp: true }), env, SIM_DT);
    expect(car.gear).toBe(2);
    stepCarPhysics(car, spec, makeInput({ shiftDown: true }), env, SIM_DT);
    expect(car.gear).toBe(1);
    car.vz = 80;
    car.gear = 8;
    stepCarPhysics(car, spec, makeInput({ shiftDown: true }), env, SIM_DT);
    expect(car.gear).toBe(7);
    stepCarPhysics(car, spec, makeInput({ shiftDown: true }), env, SIM_DT);
    stepCarPhysics(car, spec, makeInput({ shiftDown: true }), env, SIM_DT);
    expect(car.gear).toBeGreaterThanOrEqual(6);
    run(car, spec, makeInput({ throttle: 1 }), env, 5);
    expect(car.rpm).toBeLessThanOrEqual(spec.maxRpm * 1.02);
  });
});

describe('collisions and damage', () => {
  const projection = (car: CarPhysicsState, wallDistance: number): TrackProjection => ({
    index: 0,
    s: car.z,
    lateral: -car.x, // track heading 0 (+z): right = -x
    halfWidth: 6,
    surface: 'asphalt',
    height: 0,
    wallDistance,
    heading: 0,
  });

  /** Smallest gap between the two-circle footprints of two cars (negative = overlap). */
  const minCircleGap = (a: CarPhysicsState, b: CarPhysicsState, spec: CarSpec): number => {
    const off = spec.length / 2 - spec.width / 2;
    let gap = Infinity;
    for (const sa of [1, -1]) {
      for (const sb of [1, -1]) {
        const ax = a.x + forwardX(a.yaw) * off * sa;
        const az = a.z + forwardZ(a.yaw) * off * sa;
        const bx = b.x + forwardX(b.yaw) * off * sb;
        const bz = b.z + forwardZ(b.yaw) * off * sb;
        gap = Math.min(gap, Math.hypot(ax - bx, az - bz) - spec.width);
      }
    }
    return gap;
  };

  test('barrier keeps the car body inside and removes the inward velocity', () => {
    const { spec, car } = makeCar();
    car.x = -6.5; // 6.5 m right of the centre line
    car.vz = 40;
    car.vx = -10; // moving further right
    const impulse = collideWithBarrier(car, spec, projection(car, 7), 0);
    expect(impulse).toBeGreaterThan(0);
    const lateral = -car.x;
    expect(lateral + spec.width / 2).toBeLessThanOrEqual(7 + 1e-9);
    const inward = car.vx * rightX(0) + car.vz * rightZ(0);
    expect(inward).toBeLessThanOrEqual(0);
    expect(car.speed).toBeLessThan(Math.hypot(40, 10));
    expect(car.impact).toBeGreaterThan(0);
    // clear of the wall: nothing happens
    const free = makeCar().car;
    expect(collideWithBarrier(free, spec, projection(free, 7), 0)).toBe(0);
  });

  test('a car driven into the wall for seconds never ends up beyond it', () => {
    const { spec, car } = makeCar(undefined, -0.3);
    car.vz = 50;
    car.gear = 5;
    const env = makeEnv();
    for (let i = 0; i < 5 / SIM_DT; i++) {
      stepCarPhysics(car, spec, makeInput({ throttle: 1, steer: 0.4 }), env, SIM_DT);
      collideWithBarrier(car, spec, projection(car, 8), 0);
      expect(-car.x).toBeLessThanOrEqual(8);
      expect(isFiniteState(car)).toBe(true);
    }
  });

  test('overlapping cars are separated and exchange momentum', () => {
    const spec = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const a = createCarPhysics({ x: 0, y: 0, z: 0, yaw: 0 }, 'soft', 50, spec);
    const b = createCarPhysics({ x: 0, y: 0, z: 4, yaw: 0 }, 'soft', 50, spec);
    a.vz = 50;
    b.vz = 40;
    const impulse = collideCars(a, spec, b, spec);
    expect(impulse).toBeGreaterThan(0);
    expect(b.z - a.z).toBeGreaterThanOrEqual(4);
    expect(b.vz).toBeGreaterThan(40);
    expect(a.vz).toBeLessThan(50);
    expect(a.vz + b.vz).toBeCloseTo(90, 6); // equal masses: momentum conserved
    expect(collideCars(a, spec, b, spec)).toBe(0);
    // side by side overlap, no relative velocity → only positional separation
    const c = createCarPhysics({ x: 0, y: 0, z: 0, yaw: 0 }, 'soft', 50, spec);
    const d = createCarPhysics({ x: 1.2, y: 0, z: 0.5, yaw: 0 }, 'soft', 50, spec);
    for (let i = 0; i < 6; i++) collideCars(c, spec, d, spec);
    expect(minCircleGap(c, d, spec)).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.abs(c.vx) + Math.abs(d.vx)).toBe(0);
    // identical positions do not produce NaN
    const e = createCarPhysics({ x: 5, y: 0, z: 5, yaw: 0 }, 'soft', 50, spec);
    const f = createCarPhysics({ x: 5, y: 0, z: 5, yaw: 0 }, 'soft', 50, spec);
    collideCars(e, spec, f, spec);
    expect(isFiniteState(e) && isFiniteState(f)).toBe(true);
    expect(Math.hypot(e.x - f.x, e.z - f.z)).toBeGreaterThan(0.5);
  });

  test('a rear hit on the corner spins the struck car', () => {
    const spec = createCarSpec(TOP_TEAM, DEFAULT_SETUP, '2025');
    const front = createCarPhysics({ x: 0, y: 0, z: 5, yaw: 0 }, 'soft', 50, spec);
    const rear = createCarPhysics({ x: -1.2, y: 0, z: 0, yaw: 0 }, 'soft', 50, spec);
    front.vz = 30;
    rear.vz = 45;
    collideCars(rear, spec, front, spec);
    expect(Math.abs(front.yawRate)).toBeGreaterThan(0.01);
    const fx = forwardX(front.yaw);
    const fz = forwardZ(front.yaw);
    expect(front.vx * fx + front.vz * fz).toBeGreaterThan(30);
  });

  test('impact damage: thresholds, multiplier 0 = none, front wing hurts front', () => {
    const { car } = makeCar();
    applyImpactDamage(car, 30_000, true, 0);
    expect(car.damage).toEqual({ frontWing: 0, rearWing: 0, floor: 0, suspension: 0 });
    applyImpactDamage(car, 1_000, true, 1);
    expect(car.damage.frontWing).toBe(0);
    applyImpactDamage(car, 12_000, true, 0.5);
    const half = car.damage.frontWing;
    expect(half).toBeGreaterThan(0);
    applyImpactDamage(car, 12_000, true, 1);
    expect(car.damage.frontWing).toBeGreaterThan(half * 2.5);
    applyImpactDamage(car, 1e9, false, 1);
    expect(car.damage.rearWing).toBeLessThanOrEqual(1);
    expect(car.damage.floor).toBeLessThanOrEqual(1);
  });

  test('suspension: racing contact leaves it intact, one heavy hit breaks it (31k with reduced damage), hits add up', () => {
    const hit = (impulse: number, mult: number, times = 1): number => {
      const { car } = makeCar();
      for (let i = 0; i < times; i++) applyImpactDamage(car, impulse, false, mult);
      return car.damage.suspension;
    };
    // wheel-to-wheel contact in AI races stays below ~4000 N·s
    expect(hit(4000, 1)).toBe(0);
    expect(hit(14_000, 1)).toBeGreaterThan(0.5);
    expect(hit(14_000, 1)).toBeLessThan(1);
    expect(hit(18_000, 1)).toBe(1);
    expect(hit(27_000, 0.5)).toBeLessThan(1);
    expect(hit(31_000, 0.5)).toBe(1);
    expect(hit(12_000, 1, 2)).toBe(1);
    expect(hit(1e9, 0)).toBe(0);
  });

  test('a broken suspension gives no drive; a bent one costs grip', () => {
    const env = makeEnv('2025');
    const intact = makeCar();
    const broken = makeCar();
    broken.car.damage.suspension = 1;
    run(intact.car, intact.spec, makeInput({ throttle: 1 }), env, 3);
    run(broken.car, broken.spec, makeInput({ throttle: 1 }), env, 3);
    expect(intact.car.speed).toBeGreaterThan(20);
    expect(broken.car.speed).toBeLessThan(0.5);
    // rolling at 60 m/s: the broken car loses speed much faster than a coasting intact one
    const coast = makeCar();
    const wreck = makeCar();
    wreck.car.damage.suspension = 1;
    for (const c of [coast, wreck]) {
      c.car.vx = forwardX(0) * 60;
      c.car.vz = forwardZ(0) * 60;
      c.car.gear = 7;
      run(c.car, c.spec, makeInput({ throttle: wreck === c ? 1 : 0 }), env, 2);
    }
    expect(wreck.car.speed).toBeLessThan(coast.car.speed - 5);
    // the same steady corner: a bent suspension slides wider (lower lateral g at the same speed and lock)
    const lateral = (susp: number): number => {
      const { spec, car } = makeCar();
      car.damage.suspension = susp;
      car.vx = forwardX(0) * 45;
      car.vz = forwardZ(0) * 45;
      car.gear = 6;
      let g = 0;
      for (let i = 0; i < Math.round(4 / SIM_DT); i++) {
        stepCarPhysics(car, spec, makeInput({ throttle: 0.55, steer: 1 }), env, SIM_DT);
        g = Math.max(g, Math.abs(car.gLat));
      }
      return g;
    };
    expect(lateral(0.9)).toBeLessThan(lateral(0) * 0.97);
  });
});
