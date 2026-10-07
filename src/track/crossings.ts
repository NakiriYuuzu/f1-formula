/**
 * Grade separation: two non-adjacent parts of the lap may cross in XZ when their elevations differ by at least
 * GRADE_CLEARANCE (bridge / underpass, e.g. a figure-8 crossover). The UPPER road is flagged per sample (`deck`).
 * Only roads whose surfaces really overlap in XZ form a crossing; side-by-side sections at different heights
 * (a hillside street) are NOT grade-separated and obey the normal clearance rules.
 */
import type { BuiltTrack } from '../core/types';
import { sampleAt } from './loop';
import { wrapIndex } from './signal';
import { SampleGrid } from './spatial';

/** Minimum elevation difference (m) between the two roads of a crossing (road surface to road surface). */
export const GRADE_CLEARANCE = 6;
/** Two roads count as crossing when their edges are closer than this in XZ (m): covers kerbs and parapets. */
export const CROSS_BAND = 6;
/** The deck flag extends this far (m) beyond the overlap along the upper road (bridge approaches). */
export const DECK_MARGIN = 20;

/**
 * True if samples with centre distance `d` (m, XZ), half widths summing to `hwSum` and elevation difference `dy`
 * are geometrically a grade-separated pair (one road ≥ GRADE_CLEARANCE above, edges within CROSS_BAND in XZ).
 * Geometry only: whether the pair belongs to a real crossing is decided by the deck flags (`isCrossingPair`).
 */
export function isGradeSeparated(dy: number, d: number, hwSum: number): boolean {
  return Math.abs(dy) >= GRADE_CLEARANCE && d < hwSum + CROSS_BAND;
}

/** True if the centre lines of samples with distance `d` and half widths summing to `hwSum` overlap in XZ (road surfaces cross). */
export function roadsOverlap(d: number, hwSum: number): boolean {
  return d < hwSum;
}

/**
 * True if samples i and j (`dy` = py[i] - py[j], `d` = centre distance, `hwSum` = half widths) belong to a real
 * crossing: grade-separated geometry AND the upper sample is flagged `deck` (so it lies on or beside an overlap).
 * Pairs that merely sit side by side at different heights are not crossings.
 */
export function isCrossingPair(deck: ArrayLike<number>, i: number, j: number, dy: number, d: number, hwSum: number): boolean {
  return isGradeSeparated(dy, d, hwSum) && deck[dy > 0 ? i : j] > 0;
}

/**
 * Per-sample deck flags (1 = upper road of a crossing, incl. DECK_MARGIN each side). Candidates are samples that
 * are not neighbours along the loop (loop distance > 1.3 × chord + 4, the same rule the barrier clamp uses).
 */
export function detectDeck(
  px: Float64Array,
  py: Float64Array,
  pz: Float64Array,
  halfWidth: Float64Array,
  spacing: number,
): Uint8Array {
  const n = px.length;
  const deck = new Uint8Array(n);
  let maxHw = 0;
  for (let i = 0; i < n; i++) maxHw = Math.max(maxHw, halfWidth[i]);
  const grid = new SampleGrid(px, pz, 20);
  const radius = 2 * maxHw + CROSS_BAND;
  const L = n * spacing;
  let any = false;
  for (let i = 0; i < n; i++) {
    grid.forEachInRadius(px[i], pz[i], radius, (j, d2) => {
      const dy = py[i] - py[j];
      if (dy < GRADE_CLEARANCE) return;
      const chord = Math.sqrt(d2);
      const ds = Math.abs(i - j) * spacing;
      if (Math.min(ds, L - ds) <= 1.3 * chord + 4) return;
      if (roadsOverlap(chord, halfWidth[i] + halfWidth[j])) {
        deck[i] = 1;
        any = true;
      }
    });
  }
  if (!any) return deck;
  const margin = Math.round(DECK_MARGIN / spacing);
  const core = Uint8Array.from(deck);
  for (let i = 0; i < n; i++) {
    if (!core[i]) continue;
    for (let k = -margin; k <= margin; k++) deck[wrapIndex(i + k, n)] = 1;
  }
  return deck;
}

/** Elevation of the road at distance s. */
function levelAt(track: Pick<BuiltTrack, 'length' | 'count' | 'spacing' | 'py'>, s: number): number {
  return sampleAt(track, track.py, s);
}

/** True if the road at sA and sB is at the same level (|Δy| < GRADE_CLEARANCE / 2), i.e. cars there can touch. */
export function sameLevel(track: Pick<BuiltTrack, 'length' | 'count' | 'spacing' | 'py'>, sA: number, sB: number): boolean {
  return Math.abs(levelAt(track, sA) - levelAt(track, sB)) < GRADE_CLEARANCE / 2;
}

/** True if distance s lies on a deck (upper road over another section). */
export function isOnDeck(track: Pick<BuiltTrack, 'length' | 'count' | 'spacing' | 'deck'>, s: number): boolean {
  return sampleAt(track, track.deck, s) > 0.5;
}
