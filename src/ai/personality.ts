/**
 * Driver personality: the driving style that makes each AI driver race differently from the rest of the field —
 * not how fast it is (that is the skill set), but how it gets there: how hard it attacks, where on the lap it is
 * strong, how late it brakes, how much its line wanders and how much its pace swings during a race, and the traits
 * its reputation is made of: one-lap or race pace, how it treats its tyres, its starts and how it handles pressure.
 * Signature styles for the real 2026 drivers by id (subjective estimates from their reputations, like their skills);
 * every other driver (fictional, reserve or custom roster) gets a style derived from its id and skills. Pure and
 * deterministic.
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
  /** -1..1: + one-lap specialist (quicker in qualifying, a little slower in the race), − race specialist */
  oneLap: number;
  /** -1..1: + gentle on its tyres (less wear), − hard on them */
  tyres: number;
  /** -1..1: + quick off the line (shorter launch reaction), − slow starter */
  starts: number;
  /** -1..1: + errors pile up under pressure (chasing / chased), − cool under pressure */
  nerves: number;
}

type Signature = readonly [
  aggression: number,
  corners: number,
  braking: number,
  lineFreedom: number,
  volatility: number,
  oneLap: number,
  tyres: number,
  starts: number,
  nerves: number,
];

const SIGNATURES: Readonly<Record<string, Signature>> = {
  //            aggr  corn  brake line  vol   1lap  tyres start nerves
  verstappen: [0.95, -0.3, 0.7, 0.45, 0.05, 0.3, 0.6, 0.4, -0.8], // relentless; ice-cold under pressure
  hamilton: [0.8, 0.4, 0.6, 0.35, 0.2, 0.2, 0.7, 0.2, -0.6], // late braker, tyre whisperer, wet master
  antonelli: [0.88, -0.5, 0.3, 0.6, 0.35, 0.2, -0.1, 0.3, 0.2], // 2026 leader: barely a foot wrong, still green
  russell: [0.75, 0.1, 0.2, 0.3, 0.25, 0.7, 0.1, 0.1, -0.1], // qualifying ace
  leclerc: [0.82, 0.5, 0.4, 0.4, 0.4, 0.9, -0.1, 0.0, 0.4], // the pole king; the odd race-day error
  norris: [0.62, -0.6, -0.4, 0.3, 0.35, 0.5, 0.2, -0.6, 0.6], // fast-corner confidence; shaky starts and nerves
  piastri: [0.68, -0.2, -0.2, 0.25, 0.2, 0.1, 0.4, 0.3, -0.6], // calm, unflustered
  hadjar: [0.8, 0.2, 0.3, 0.55, 0.55, 0.3, 0.0, 0.0, 0.3],
  lawson: [0.88, 0.1, 0.5, 0.5, 0.5, 0.0, -0.1, 0.2, 0.3],
  lindblad: [0.78, -0.3, 0.2, 0.6, 0.6, 0.2, -0.2, 0.0, 0.4], // rookie: inconsistent over a race distance
  gasly: [0.66, 0.3, -0.1, 0.35, 0.35, 0.1, 0.2, 0.2, 0.0],
  colapinto: [0.82, 0.2, 0.4, 0.6, 0.6, 0.0, -0.2, 0.0, 0.4],
  ocon: [0.84, -0.1, 0.2, 0.3, 0.35, -0.2, 0.3, 0.3, 0.0],
  bearman: [0.78, -0.2, 0.4, 0.5, 0.5, 0.1, 0.0, 0.1, 0.2],
  bortoleto: [0.66, 0.1, -0.2, 0.4, 0.4, 0.0, 0.3, 0.1, -0.2], // consistency-led champion profile
  hulkenberg: [0.6, 0.3, -0.3, 0.25, 0.25, 0.7, 0.1, 0.0, 0.0], // a qualifier
  albon: [0.62, -0.3, -0.3, 0.3, 0.3, 0.2, 0.3, 0.0, -0.2],
  sainz: [0.72, 0.4, 0.1, 0.3, 0.3, 0.1, 0.5, 0.2, -0.3], // smooth operator
  alonso: [0.92, 0.5, 0.5, 0.7, 0.15, -0.5, 0.9, 0.9, -0.7], // race craft, tyre craft, legendary starts
  stroll: [0.58, -0.2, 0.1, 0.45, 0.6, -0.2, -0.1, 0.6, 0.4], // strong starts
  perez: [0.72, 0.6, -0.5, 0.35, 0.5, -0.7, 0.9, 0.3, 0.3], // race over qualifying; tyre management
  bottas: [0.48, -0.4, -0.3, 0.2, 0.3, 0.6, 0.2, -0.4, 0.2], // quicker on Saturday than on Sunday
  tsunoda: [0.86, 0.2, 0.4, 0.5, 0.55, 0.3, -0.1, 0.0, 0.5],
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
  if (sig) {
    return {
      aggression: sig[0],
      corners: sig[1],
      braking: sig[2],
      lineFreedom: sig[3],
      volatility: sig[4],
      oneLap: sig[5],
      tyres: sig[6],
      starts: sig[7],
      nerves: sig[8],
    };
  }
  const id = driver.id || `${driver.firstName}${driver.lastName}${driver.number}`;
  const racecraft = clamp01(fin(driver.skill.racecraft, 0.88));
  const awareness = clamp01(fin(driver.skill.awareness, 0.88));
  const consistency = clamp01(fin(driver.skill.consistency, 0.88));
  const unsteady = clamp01((0.95 - consistency) / 0.1);
  const signed = (key: string, size: number): number => (hashUnit(`${id}:${key}`) * 2 - 1) * size;
  return {
    aggression: clamp01(0.5 + (racecraft - 0.88) * 2.5 + (hashUnit(`${id}:aggr`) - 0.5) * 0.5),
    corners: clamp(signed('corners', 0.8), -1, 1),
    braking: clamp(signed('braking', 0.8), -1, 1),
    lineFreedom: clamp01(0.2 + 0.3 * unsteady + (hashUnit(`${id}:line`) - 0.5) * 0.4),
    volatility: clamp01(0.1 + 0.5 * unsteady + (hashUnit(`${id}:form`) - 0.5) * 0.3),
    oneLap: clamp(signed('onelap', 0.6), -1, 1),
    tyres: clamp(0.6 - unsteady + signed('tyres', 0.4), -1, 1),
    starts: clamp((awareness - 0.9) * 5 + signed('starts', 0.4), -1, 1),
    nerves: clamp(unsteady - 0.4 + signed('nerves', 0.4), -1, 1),
  };
}
