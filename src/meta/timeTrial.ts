/**
 * Time trial records (pure logic): local leaderboard (top 5) per layout + regulation, personal best lookup,
 * and ghost compaction for storage.
 */
import type { GhostData, Regulation } from '../core/types';
import { asRecord, num, str } from './guards';

export const LEADERBOARD_SIZE = 5;

export interface LapRecord {
  lapTime: number;
  teamId: string;
  driverId: string;
  /** ISO date */
  date: string;
}

/** key = recordKey(layoutId, regulation) → best laps, fastest first */
export type TimeTrialRecords = Record<string, LapRecord[]>;

export function recordKey(layoutId: string, regulation: Regulation): string {
  return `${layoutId}|${regulation}`;
}

export function personalBest(records: TimeTrialRecords, layoutId: string, regulation: Regulation): LapRecord | null {
  return records[recordKey(layoutId, regulation)]?.[0] ?? null;
}

/** Insert a lap; reports whether it is a new personal best and its leaderboard rank (1-based, null = off the board). */
export function addLapRecord(
  records: TimeTrialRecords,
  layoutId: string,
  regulation: Regulation,
  rec: LapRecord,
): { records: TimeTrialRecords; isPersonalBest: boolean; rank: number | null } {
  if (!Number.isFinite(rec.lapTime) || rec.lapTime <= 0) return { records, isPersonalBest: false, rank: null };
  const key = recordKey(layoutId, regulation);
  const list = [...(records[key] ?? [])];
  const prevBest = list[0]?.lapTime ?? Infinity;
  list.push({ ...rec });
  list.sort((a, b) => a.lapTime - b.lapTime);
  const trimmed = list.slice(0, LEADERBOARD_SIZE);
  const idx = trimmed.findIndex((r) => r.lapTime === rec.lapTime && r.date === rec.date);
  return {
    records: { ...records, [key]: trimmed },
    isPersonalBest: rec.lapTime < prevBest,
    rank: idx >= 0 ? idx + 1 : null,
  };
}

/** Round ghost samples (cm / milliradian) so a lap fits comfortably in localStorage. */
export function compactGhost(g: GhostData): GhostData {
  const samples = new Array<number>(g.samples.length);
  for (let i = 0; i < g.samples.length; i++) {
    const v = g.samples[i] ?? 0;
    const scale = i % 4 === 3 ? 1000 : 100;
    samples[i] = Number.isFinite(v) ? Math.round(v * scale) / scale : 0;
  }
  return { ...g, samples };
}

export function sanitizeTimeTrialRecords(v: unknown): TimeTrialRecords {
  const out: TimeTrialRecords = {};
  for (const [key, raw] of Object.entries(asRecord(v))) {
    if (!Array.isArray(raw) || !/^[a-z0-9-]+\|(2025|2026)$/.test(key)) continue;
    const list: LapRecord[] = [];
    for (const item of raw.slice(0, LEADERBOARD_SIZE)) {
      const r = asRecord(item);
      const lapTime = num(r.lapTime, 0, 3600, 0);
      if (lapTime <= 0) continue;
      list.push({
        lapTime,
        teamId: str(r.teamId, '', 32, true),
        driverId: str(r.driverId, '', 32, true),
        date: str(r.date, '', 40, true),
      });
    }
    list.sort((a, b) => a.lapTime - b.lapTime);
    if (list.length > 0) out[key] = list;
  }
  return out;
}
