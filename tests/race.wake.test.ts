/**
 * Aerodynamic wake: tow and dirty air from the car ahead (race/wake.ts), the physics applying it (drag / downforce)
 * and the AI planning with it (capability).
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_ASSISTS, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import type { AeroWake, CarEntry, ControlInput, PhysicsEnv, WorldState } from '../src/core/types';
import { capability, cornerSpeed } from '../src/ai/index';
import { TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { buildQuickStart } from '../src/meta/sessionBuilder';
import { createCarPhysics, createCarSpec, stepCarPhysics } from '../src/physics/index';
import { parseQuickStart } from '../src/app/quickStart';
import { sanitizeRules } from '../src/meta/guards';
import { createWorld, stepWorld } from '../src/race/index';
import { CLEAN_AIR, DIRTY_FRONT, TOW_DRAG, aeroWake } from '../src/race/wake';
import { wakeIndicator } from '../src/ui/hud/telemetry';

function world(kind: 'race' | 'quali' = 'race', aeroWake?: boolean): WorldState {
  const { config } = buildQuickStart({ kind, layoutId: 'isola-verde', laps: 3, seed: 7, safetyCar: 'off' });
  if (aeroWake !== undefined) config.rules = { ...config.rules, aeroWake };
  return createWorld(config, getLayout(config.layoutId));
}

/** Car `b` placed `ds` metres ahead of `a` (offset `lat`, speed `vB`); every other car parked far away. */
function pair(w: WorldState, ds: number, lat = 0, vB = 60): { a: CarEntry; b: CarEntry } {
  const [a, b] = w.cars;
  for (const c of w.cars) c.phys.s = 2500;
  a.phys.s = 1000;
  a.phys.lateral = 0;
  a.phys.speed = 60;
  b.phys.s = 1000 + ds;
  b.phys.lateral = lat;
  b.phys.speed = vB;
  for (const c of [a, b]) {
    c.status = 'running';
    c.pit.phase = 'none';
  }
  return { a, b };
}

describe('aero wake', () => {
  const track = getLayout('isola-verde');

  test('close behind in line: tow and front dirty air, fading with the gap', () => {
    const w = world();
    const { a } = pair(w, 15);
    const near = aeroWake(w, track, a);
    expect(near.drag).toBeCloseTo(1 - TOW_DRAG * (1 - 15 / 80), 6);
    expect(near.frontDownforce).toBeCloseTo(1 - DIRTY_FRONT * (1 - 15 / 40), 6);
    expect(near.rearDownforce).toBe(1);
    // farther back: still some tow, no dirty air
    pair(w, 60);
    const far = aeroWake(w, track, a);
    expect(far.drag).toBeLessThan(1);
    expect(far.drag).toBeGreaterThan(near.drag);
    expect(far.frontDownforce).toBe(1);
  });

  test('clean air: off line, alongside, a much slower car ahead, or not a race', () => {
    const w = world();
    const { a } = pair(w, 15, 4);
    expect(aeroWake(w, track, a)).toBe(CLEAN_AIR);
    pair(w, 3);
    expect(aeroWake(w, track, a)).toBe(CLEAN_AIR);
    pair(w, 15, 0, 20);
    expect(aeroWake(w, track, a)).toBe(CLEAN_AIR);
    const q = world('quali');
    expect(q.config.kind).not.toBe('race');
    const qa = pair(q, 15).a;
    expect(aeroWake(q, track, qa)).toBe(CLEAN_AIR);
  });

  test('physics: the tow raises the speed down a straight; the AI plans slower corners in dirty air', () => {
    const spec = createCarSpec(TEAMS[0]!, DEFAULT_SETUP, '2025');
    const env = (wake?: AeroWake): PhysicsEnv => ({
      surface: 'asphalt',
      wetness: 0,
      rubber: 0,
      trackTemp: 35,
      regulation: '2025',
      assists: { ...DEFAULT_ASSISTS, ersAssist: false, traction: 'full' },
      assistTargetSpeed: null,
      wearMultiplier: 1,
      fuelMultiplier: 1,
      damageMultiplier: 1,
      performanceScale: 1,
      ...(wake ? { wake } : {}),
    });
    const input: ControlInput = {
      throttle: 1,
      brake: 0,
      steer: 0,
      shiftUp: false,
      shiftDown: false,
      drsPressed: false,
      ersCycle: false,
      limiterToggle: false,
      overtakeHeld: false,
    };
    const flatOut = (wake?: AeroWake): number => {
      const car = createCarPhysics({ x: 0, y: 0, z: 0, yaw: 0 }, 'soft', 50, spec);
      car.tire.temp = 92;
      car.ers.mode = 'hotlap';
      for (let i = 0; i < Math.round(20 / SIM_DT); i++) stepCarPhysics(car, spec, input, env(wake), SIM_DT);
      return car.speed;
    };
    const tow: AeroWake = { drag: 1 - TOW_DRAG, frontDownforce: 1, rearDownforce: 1 };
    expect(flatOut(tow) - flatOut()).toBeGreaterThan(2);
    // dirty air: a fast corner is slower, a tow alone does not slow it
    const dirty: AeroWake = { drag: 1, frontDownforce: 1 - DIRTY_FRONT, rearDownforce: 1 };
    const clean = cornerSpeed(capability(spec, 1, 50, 1, 1), 1 / 150);
    expect(cornerSpeed(capability(spec, 1, 50, 1, 1, dirty), 1 / 150)).toBeLessThan(clean * 0.98);
    expect(cornerSpeed(capability(spec, 1, 50, 1, 1, tow), 1 / 150)).toBeCloseTo(clean, 1);
  });

  test('rules.aeroWake: off means clean air everywhere; on, the cars record the wake they run in', () => {
    const off = world('race', false);
    expect(aeroWake(off, track, pair(off, 15).a)).toBe(CLEAN_AIR);
    const seen = (w: WorldState): boolean => {
      let any = false;
      for (let i = 0; i < Math.round(40 / SIM_DT); i++) {
        stepWorld(w, track, [null, null], SIM_DT);
        w.events.length = 0;
        if (w.cars.some((c) => c.race.wake.drag < 1)) any = true;
      }
      return any;
    };
    expect(seen(world('race', false))).toBe(false);
    expect(seen(world('race', true))).toBe(true);
  }, 60000);

  test('URL quick start: wake=0 / 1 sets the rule, anything else keeps the default (on)', () => {
    const any = (): boolean => true;
    expect(parseQuickStart('?quick=race&wake=0', any)?.aeroWake).toBe(false);
    expect(parseQuickStart('?quick=split&wake=1', any)?.aeroWake).toBe(true);
    expect(parseQuickStart('?quick=race&wake=yes', any)?.aeroWake).toBeUndefined();
    expect(buildQuickStart({ kind: 'race', seed: 1, aeroWake: false }).config.rules.aeroWake).toBe(false);
    expect(buildQuickStart({ kind: 'race', seed: 1 }).config.rules.aeroWake).toBe(true);
  });

  test('old saves without the rule get it on; an explicit off is kept', () => {
    const { aeroWake: _, ...legacy } = sanitizeRules({});
    expect(sanitizeRules(legacy).aeroWake).toBe(true);
    expect(sanitizeRules({ ...legacy, aeroWake: false }).aeroWake).toBe(false);
  });
});

describe('HUD wake pill', () => {
  const tow: AeroWake = { drag: 0.9, frontDownforce: 1, rearDownforce: 1 };
  const close: AeroWake = { drag: 0.88, frontDownforce: 0.9, rearDownforce: 1 };
  test('tow on the straight, dirty air while cornering hard, nothing slow or in clean air', () => {
    expect(wakeIndicator(tow, 70, 0.1)).toEqual({ state: 'tow', text: '吸尾流' });
    expect(wakeIndicator(close, 70, 0.2)).toEqual({ state: 'tow', text: '吸尾流' });
    expect(wakeIndicator(close, 50, 2.5)).toEqual({ state: 'dirty', text: '髒空氣' });
    expect(wakeIndicator(tow, 50, 2.5)).toEqual({ state: 'tow', text: '吸尾流' });
    expect(wakeIndicator(close, 20, 2.5)).toBeNull();
    expect(wakeIndicator(CLEAN_AIR, 70, 0)).toBeNull();
    expect(wakeIndicator(undefined, 70, 0)).toBeNull();
    expect(wakeIndicator({ drag: NaN, frontDownforce: NaN, rearDownforce: NaN }, 70, NaN)).toBeNull();
  });
});
