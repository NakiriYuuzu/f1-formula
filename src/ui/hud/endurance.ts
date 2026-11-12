/**
 * Endurance race HUD, what to show (pure, unit-tested; timing.ts, telemetry.ts and mfd.ts draw it): the time left in
 * place of the laps, the fuel against the flag or by when to box, and the MFD's fuel for the next stop. Reads the
 * mirrored session state, so an online guest shows the host's clock.
 */
import type { WorldState } from '../../core/types';
import { enduranceLeft, fillTime } from '../../race/index';
import { formatClock } from './labels';

/** The lap counter's slot: the time left, and the lap or 時間到 once it has run out (null outside an endurance race). */
export function enduranceCounter(world: WorldState, lap: number): { value: string; sub: string } | null {
  const left = enduranceLeft(world);
  if (left === null) return null;
  return { value: formatClock(left, true), sub: left <= 0 ? '時間到' : lap >= 1 ? `第 ${lap} 圈` : '' };
}

export type FuelState = 'ok' | 'tight' | 'short';

/**
 * The fuel readout's call: the margin (laps) over the flag when the fuel reaches it, else by when to box — within N
 * passes of the pit entry, 本圈進站 at the next one only, 燃油不足 short of it. `laps`: laps of fuel in the tank;
 * `toGo`: laps to the car's flag; `toEntry`: laps to the next pit entry.
 */
export function enduranceFuelCall(laps: number, toGo: number, toEntry: number): { text: string; state: FuelState } {
  const margin = laps - toGo;
  if (margin >= 0) return { text: `+${margin.toFixed(1)}`, state: margin < 0.3 ? 'tight' : 'ok' };
  const entries = laps < toEntry ? 0 : Math.floor(laps - toEntry) + 1;
  if (entries === 0) return { text: '燃油不足', state: 'short' };
  if (entries === 1) return { text: '本圈進站', state: 'short' };
  return { text: `${entries} 圈內進站`, state: entries === 2 ? 'tight' : 'ok' };
}

/** The MFD's fuel for the next stop: the automatic fill (null), or the tank's share after it (0: none). */
export type FuelChoice = number | null;
export const FUEL_CHOICES: readonly FuelChoice[] = [null, 0, 0.25, 0.5, 0.75, 1];

export function fuelChoiceLabel(choice: FuelChoice): string {
  if (choice === null) return '自動';
  if (choice <= 0) return '不加油';
  if (choice >= 1) return '加滿';
  return choice === 0.5 ? '半箱' : `加到 ${Math.round(choice * 4)}/4`;
}

/** The tank (kg) after the stop the choice asks for (undefined: the automatic fill, decided at the stop). */
export function fuelChoiceTarget(choice: FuelChoice, tank: number): number | undefined {
  return choice === null ? undefined : Math.max(0, Math.min(1, choice)) * tank;
}

/** What a stop with the tank at `target` (kg) after it puts in: '+kg · s', or 不加油. */
export function fillLabel(target: number, fuelKg: number, tank: number): string {
  const kg = Math.min(tank, target) - fuelKg;
  return kg > 0.05 ? `+${kg.toFixed(1)} kg · ${fillTime(kg, tank).toFixed(1)} 秒` : '不加油';
}
