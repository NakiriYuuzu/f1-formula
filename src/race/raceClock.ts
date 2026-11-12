/**
 * Race clocks and the race's horizon, shared by the races decided by time (elimination.ts, endurance.ts): a countdown on
 * world time that can be stopped and run again, and the session's laps kept ahead of the leader from the racing still
 * to come, so race control, the AI's strategy and the HUD never read a lap target the race does not have.
 */
import type { RaceClock } from '../core/types';

/** Seconds left on the clock at world time `time`. */
export const clockLeft = (c: RaceClock, time: number): number => c.held ?? Math.max(0, c.dueAt - time);

/** Run the clock at world time `time`, or stop it (it keeps the seconds left, and runs out that much later once it runs again). */
export function runClock(c: RaceClock, time: number, running: boolean): void {
  if (!running) {
    if (c.held === null) c.held = Math.max(0, c.dueAt - time);
    return;
  }
  if (c.held !== null) {
    c.dueAt = time + c.held;
    c.held = null;
  }
}

/** The laps of a race whose leader is on lap `leaderLap` with `seconds` more racing in it after the start of that lap, at `lapTime` a lap. */
export const lapsAhead = (leaderLap: number, seconds: number, lapTime: number): number =>
  Math.max(0, leaderLap - 1) + Math.ceil(seconds / Math.max(30, lapTime));
