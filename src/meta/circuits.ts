/**
 * Pure helpers for presenting circuits in menus: real / original filter, real-circuit facts and the credits list.
 */
import type { RealCircuitInfo, TrackDef } from '../core/types';

/** Track browser filter: every circuit, only real-world circuits, only original ones. */
export type TrackFilter = 'all' | 'real' | 'original';
export const TRACK_FILTERS: readonly TrackFilter[] = ['all', 'real', 'original'];
export const TRACK_FILTER_LABEL: Record<TrackFilter, string> = { all: '全部', real: '真實賽道', original: '原創賽道' };

/** Layouts that pass the filter (order kept). */
export function filterLayouts<T extends { real?: unknown }>(layouts: readonly T[], filter: TrackFilter): T[] {
  if (filter === 'all') return [...layouts];
  return layouts.filter((l) => (l.real !== undefined) === (filter === 'real'));
}

/** Official length in km with 3 decimals, e.g. 5412 → '5.412 km'. */
export function formatKm(metres: number): string {
  return `${(metres / 1000).toFixed(3)} km`;
}

export function directionLabel(direction: RealCircuitInfo['direction']): string {
  return direction === 'clockwise' ? '順時針' : '逆時針';
}

/** zh-TW labels of the notable features (unlabelled ones are skipped, duplicates removed). */
export function featureLabels(real: RealCircuitInfo): string[] {
  const out: string[] = [];
  for (const f of real.features ?? []) {
    if (f.label && !out.includes(f.label)) out.push(f.label);
  }
  return out;
}

/**
 * Facts of a real circuit as label / value rows. The direction is the forward layout's; a reverse layout runs the
 * opposite way round.
 */
export function realFacts(real: RealCircuitInfo, reverse = false): { label: string; value: string }[] {
  const dir = reverse ? (real.direction === 'clockwise' ? 'anticlockwise' : 'clockwise') : real.direction;
  const rows = [
    { label: '官方長度', value: formatKm(real.length) },
    { label: '彎道數', value: `${real.turns} 個` },
    { label: '行車方向', value: directionLabel(dir) },
    { label: '首屆大獎賽', value: `${real.firstGrandPrix} 年` },
  ];
  const features = featureLabels(real);
  if (features.length > 0) rows.push({ label: '特色', value: features.join('、') });
  return rows;
}

export interface CircuitCredit {
  name: string;
  location: string;
  source: string;
}

/** Credits list: one entry per real circuit (TrackDef.real set), registry order. */
export function circuitCredits(defs: readonly Pick<TrackDef, 'name' | 'location' | 'real'>[]): CircuitCredit[] {
  const out: CircuitCredit[] = [];
  for (const d of defs) if (d.real) out.push({ name: d.name, location: d.location, source: d.real.source });
  return out;
}
