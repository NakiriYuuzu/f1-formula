/**
 * Driver personality: the driving style that makes each AI driver race differently from the rest of the field —
 * not how fast it is (that is the skill set), but how it gets there: how hard it attacks, where on the lap it is
 * strong, how late it brakes, how much its line wanders and how much its pace swings during a race. Signature styles
 * for the real 2026 drivers by id (subjective estimates, like their skills); every other driver (fictional, reserve
 * or custom roster) gets a style derived from its id and skills. Pure and deterministic.
 */
import type { DriverDef } from '../core/types';
import { clamp, clamp01 } from '../core/math';

export interface DriverStyle {
  /** 0..1 willingness to attack / defend */
  aggression: number;
  /** -1..1: + strong in slow corners (mechanical grip), − strong in fast corners (aero commitment) */
  corners: number;
  /** -1..1: + late braker (brakes later, a little less mid-corner speed), − carries speed (brakes earlier) */
  braking: number;
  /** 0..1: how far its line wanders off the racing line (lines differ from car to car and lap to lap) */
  lineFreedom: number;
  /** 0..1: how much its pace swings — race-day form and rhythm within the race */
  volatility: number;
}

type Signature = readonly [aggression: number, corners: number, braking: number, lineFreedom: number, volatility: number];

const SIGNATURES: Readonly<Record<string, Signature>> = {
  verstappen: [0.95, -0.3, 0.7, 0.45, 0.1],
  hamilton: [0.8, 0.4, 0.6, 0.35, 0.2],
  antonelli: [0.88, -0.5, 0.3, 0.6, 0.45],
  russell: [0.75, 0.1, 0.2, 0.3, 0.25],
  leclerc: [0.82, 0.5, 0.4, 0.4, 0.4],
  norris: [0.62, -0.6, -0.4, 0.3, 0.35],
  piastri: [0.68, -0.2, -0.2, 0.25, 0.2],
  hadjar: [0.8, 0.2, 0.3, 0.55, 0.55],
  lawson: [0.88, 0.1, 0.5, 0.5, 0.5],
  lindblad: [0.78, -0.3, 0.2, 0.6, 0.6],
  gasly: [0.66, 0.3, -0.1, 0.35, 0.35],
  colapinto: [0.82, 0.2, 0.4, 0.6, 0.6],
  ocon: [0.84, -0.1, 0.2, 0.3, 0.35],
  bearman: [0.78, -0.2, 0.4, 0.5, 0.5],
  bortoleto: [0.66, 0.1, -0.2, 0.4, 0.4],
  hulkenberg: [0.6, 0.3, -0.3, 0.25, 0.25],
  albon: [0.62, -0.3, -0.3, 0.3, 0.3],
  sainz: [0.72, 0.4, 0.1, 0.3, 0.3],
  alonso: [0.92, 0.5, 0.5, 0.7, 0.15],
  stroll: [0.58, -0.2, 0.1, 0.45, 0.6],
  perez: [0.72, 0.6, -0.5, 0.35, 0.5],
  bottas: [0.48, -0.4, -0.3, 0.2, 0.3],
  tsunoda: [0.86, 0.2, 0.4, 0.5, 0.55],
};

function hashUnit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

const fin = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** The driving style of a driver: its signature if it has one, else derived from its id and skills. */
export function driverStyle(driver: DriverDef): DriverStyle {
  const sig = SIGNATURES[driver.id];
  if (sig) return { aggression: sig[0], corners: sig[1], braking: sig[2], lineFreedom: sig[3], volatility: sig[4] };
  const id = driver.id || `${driver.firstName}${driver.lastName}${driver.number}`;
  const racecraft = clamp01(fin(driver.skill.racecraft, 0.88));
  const consistency = clamp01(fin(driver.skill.consistency, 0.88));
  const unsteady = clamp01((0.95 - consistency) / 0.1);
  return {
    aggression: clamp01(0.5 + (racecraft - 0.88) * 2.5 + (hashUnit(`${id}:aggr`) - 0.5) * 0.5),
    corners: clamp((hashUnit(`${id}:corners`) * 2 - 1) * 0.8, -1, 1),
    braking: clamp((hashUnit(`${id}:braking`) * 2 - 1) * 0.8, -1, 1),
    lineFreedom: clamp01(0.2 + 0.3 * unsteady + (hashUnit(`${id}:line`) - 0.5) * 0.4),
    volatility: clamp01(0.1 + 0.5 * unsteady + (hashUnit(`${id}:form`) - 0.5) * 0.3),
  };
}
