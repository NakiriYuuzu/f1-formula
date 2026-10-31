/**
 * When to re-capture the reflection probe (pure, no three.js): the environment map is captured once at scene start; when
 * the weather moves the sky / light far enough from what the map shows (cloud cover, rain, lamp level) a new capture is
 * due, throttled so a slow weather transition costs only a few captures. The capture itself is spread over frames
 * (RaceScene: one cube face per frame, then one PMREM pass), so a refresh never costs a whole capture in one frame.
 */

/** What the environment map depends on that changes during a race. */
export interface ProbeSignature {
  /** smoothed cloud cover 0..1 (sky brightness / colour, sun disc) */
  cloud: number;
  /** smoothed rain 0..1 (darker clouds) */
  rain: number;
  /** trackside lamp level 0..1 (lamp heads, floodlight panels in the capture) */
  lamps: number;
}

/** Shortest time (s) between two captures. */
export const PROBE_REFRESH_MIN_SEC = 12;
/** Change of any signature field that makes the captured map stale. */
export const PROBE_CLOUD_DELTA = 0.1;
export const PROBE_RAIN_DELTA = 0.15;
export const PROBE_LAMP_DELTA = 0.1;
/** Cube faces rendered per frame while a capture is in progress (6 faces + 1 PMREM frame = 7 frames at 1). */
export const PROBE_FACES_PER_FRAME = 1;

const fin = (v: number): number => (Number.isFinite(v) ? v : 0);

/** How far `now` is from the captured signature, as a multiple of the per-field threshold (≥ 1 = stale). */
export function probeStaleness(captured: ProbeSignature, now: ProbeSignature): number {
  return Math.max(
    Math.abs(fin(now.cloud) - fin(captured.cloud)) / PROBE_CLOUD_DELTA,
    Math.abs(fin(now.rain) - fin(captured.rain)) / PROBE_RAIN_DELTA,
    Math.abs(fin(now.lamps) - fin(captured.lamps)) / PROBE_LAMP_DELTA,
  );
}

/**
 * A new capture should start: never captured, or stale (probeStaleness ≥ 1) and at least PROBE_REFRESH_MIN_SEC since
 * the last capture started. `sinceCaptureSec` that is not finite counts as "long ago".
 */
export function probeRefreshDue(captured: ProbeSignature | null, now: ProbeSignature, sinceCaptureSec: number): boolean {
  if (!captured) return true;
  const since = Number.isFinite(sinceCaptureSec) ? sinceCaptureSec : Number.POSITIVE_INFINITY;
  return since >= PROBE_REFRESH_MIN_SEC && probeStaleness(captured, now) >= 1;
}
