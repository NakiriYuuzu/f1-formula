/**
 * PhysicsEnv per car and step: surface, weather, regulation, assists, rule multipliers (wear / fuel / damage),
 * AI performanceScale, the aero wake of the cars ahead (wake.ts), the human braking-assist target speed (look-ahead
 * braking curve on this car's own capability in that wake) and fuel saving when the tank cannot reach the flag.
 */
import type { BuiltTrack, CarEntry, PhysicsEnv, WorldState } from '../core/types';
import { capability, carGripScale, targetSpeedAt } from '../ai/index';
import { fuelPerKm } from '../physics/index';
import { damageMultiplier } from './contact';
import { fin, isHuman } from './events';
import { aeroWake } from './wake';

/** Fractions of the car's capability the braking assist plans with. */
const ASSIST_LAT = 0.9;
const ASSIST_BRAKE = 0.82;

/** Fuel burn multiplier (≤ 1) that lets the remaining fuel reach the end of the race. */
function fuelSaving(world: WorldState, track: BuiltTrack, car: CarEntry): number {
  if (world.session.kind !== 'race') return 1;
  const remainingKm = Math.max(0, world.session.totalLaps * track.length - car.timing.progress) / 1000;
  const needed = remainingKm * fuelPerKm(car.spec);
  if (!(needed > 0)) return 1;
  const fuel = Math.max(0, fin(car.phys.fuelKg));
  return needed > fuel ? Math.max(0.6, fuel / needed) : 1;
}

export function buildEnv(world: WorldState, track: BuiltTrack, car: CarEntry): PhysicsEnv {
  const rules = world.config.rules;
  const w = world.weather;
  const human = isHuman(car);
  const performance = human ? 1 : car.ai.performance;
  const wake = aeroWake(world, track, car);
  let assistTargetSpeed: number | null = null;
  if (human && car.assists.braking !== 'off') {
    const p = car.phys;
    const grip = carGripScale(car, w.wetness, w.rubber, performance);
    const cap = capability(car.spec, grip, p.fuelKg, ASSIST_LAT, ASSIST_BRAKE, wake);
    assistTargetSpeed = targetSpeedAt(track, cap, p.s, p.speed);
  }
  return {
    surface: car.phys.surface,
    wetness: fin(w.wetness),
    rubber: fin(w.rubber),
    trackTemp: fin(w.trackTemp, 30),
    regulation: world.config.regulation,
    assists: car.assists,
    assistTargetSpeed,
    wearMultiplier: rules.tyreWear ? 1 : 0,
    fuelMultiplier: rules.fuel ? fuelSaving(world, track, car) : 0,
    damageMultiplier: damageMultiplier(world),
    performanceScale: performance,
    wake,
  };
}
