/**
 * Flashback buffer (pure): deep WorldState snapshots every SNAPSHOT_INTERVAL seconds of simulation time, keeping
 * the last FLASHBACK_WINDOW seconds. rewind() returns an independent copy from ~REWIND_SECONDS ago and discards
 * the newer snapshots, so the restored timeline continues deterministically from there.
 */
import type { SessionRules, WorldState } from '../core/types';
import { snapshotWorld } from '../race';

export const SNAPSHOT_INTERVAL = 0.5;
export const FLASHBACK_WINDOW = 20;
export const REWIND_SECONDS = 5;

interface Snapshot {
  time: number;
  world: WorldState;
}

export class FlashbackBuffer {
  private snaps: Snapshot[] = [];
  private nextAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly interval = SNAPSHOT_INTERVAL,
    private readonly window = FLASHBACK_WINDOW,
  ) {}

  /** Call after every simulation step: stores a snapshot when one is due. */
  record(world: WorldState): void {
    const t = world.time;
    if (!Number.isFinite(t) || t + 1e-9 < this.nextAt) return;
    const snap = snapshotWorld(world);
    // events belong to the frame that produced them; a restored world must not replay them
    snap.events = [];
    this.snaps.push({ time: t, world: snap });
    this.nextAt = t + this.interval;
    const oldest = t - this.window;
    while (this.snaps.length > 1 && (this.snaps[0] as Snapshot).time < oldest - 1e-9) this.snaps.shift();
  }

  /**
   * World from `seconds` before `now` (latest snapshot at or before that time, else the oldest one), or null when
   * nothing is stored. Snapshots newer than the restored one are dropped; the returned world is a fresh copy.
   */
  rewind(now: number, seconds = REWIND_SECONDS): WorldState | null {
    if (this.snaps.length === 0) return null;
    const target = now - seconds;
    let idx = 0;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if ((this.snaps[i] as Snapshot).time <= target + 1e-6) {
        idx = i;
        break;
      }
    }
    this.snaps.length = idx + 1;
    const snap = this.snaps[idx] as Snapshot;
    this.nextAt = snap.time + this.interval;
    return snapshotWorld(snap.world);
  }

  clear(): void {
    this.snaps = [];
    this.nextAt = Number.NEGATIVE_INFINITY;
  }

  get size(): number {
    return this.snaps.length;
  }

  /** Simulation time of the oldest stored snapshot (null when empty). */
  get oldestTime(): number | null {
    return this.snaps.length > 0 ? (this.snaps[0] as Snapshot).time : null;
  }
}

/** Flashbacks still allowed: -1 = unlimited, otherwise ≥ 0. */
export function flashbacksLeft(rules: SessionRules, used: number): number {
  const limit = Number.isFinite(rules.flashbacks) ? Math.trunc(rules.flashbacks) : 0;
  if (limit < 0) return -1;
  const u = Number.isFinite(used) ? Math.max(0, Math.trunc(used)) : 0;
  return Math.max(0, limit - u);
}
