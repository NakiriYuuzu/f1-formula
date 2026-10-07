/**
 * Session views (pure): one full-screen view per single player, left/right halves in split-screen, with the
 * matching HUD regions; and camera cycling per view.
 */
import type { CameraMode, ViewSpec } from '../core/types';
import type { HudView } from '../ui/hud/index';

export interface SessionViews {
  views: ViewSpec[];
  hudViews: HudView[];
}

/**
 * Views for the human cars (player 0 first). With no human car (spectating) one full-screen view follows
 * `fallbackCarId`. Split-screen = two side-by-side halves (viewport origin top-left, normalized).
 */
export function buildViews(humanCarIds: readonly number[], camera: CameraMode, fallbackCarId = 0): SessionViews {
  const ids = humanCarIds.filter((id) => Number.isInteger(id) && id >= 0).slice(0, 2);
  if (ids.length < 2) {
    const carId = ids[0] ?? Math.max(0, fallbackCarId);
    return {
      views: [{ carId, camera, lookBack: false, viewport: { x: 0, y: 0, w: 1, h: 1 } }],
      hudViews: [{ playerIndex: 0, carId, region: 'full' }],
    };
  }
  const [left, right] = ids as [number, number];
  return {
    views: [
      { carId: left, camera, lookBack: false, viewport: { x: 0, y: 0, w: 0.5, h: 1 } },
      { carId: right, camera, lookBack: false, viewport: { x: 0.5, y: 0, w: 0.5, h: 1 } },
    ],
    hudViews: [
      { playerIndex: 0, carId: left, region: 'left' },
      { playerIndex: 1, carId: right, region: 'right' },
    ],
  };
}

/** Next camera in `cycle` after `current` (modes outside the cycle, e.g. 'tv', restart at the first entry). */
export function nextCamera(cycle: readonly CameraMode[], current: CameraMode): CameraMode {
  if (cycle.length === 0) return current;
  const i = cycle.indexOf(current);
  return cycle[(i + 1) % cycle.length] as CameraMode;
}
