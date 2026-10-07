/**
 * Menu contract types shared by MenuSystem and its screens (re-exported from ui/menus/index.ts).
 */
import type { Livery, Regulation, SessionConfig, Settings } from '../../core/types';
import type { SessionContext } from '../../meta/context';

export interface ShowroomCar {
  livery: Livery;
  number: number;
  teamShort: string;
  helmet: Livery;
  /** car generation to build (podium after a race: that race's regulation); default = the showroom's current */
  regulation?: Regulation;
}

export interface MenuCallbacks {
  /** App loads the layout, builds the scene and starts the session. */
  startSession(config: SessionConfig, ctx: SessionContext): void;
  /** Settings changed in the settings screen (already persisted by menus via meta/save). */
  applySettings(settings: Settings): void;
  /** Show a car in the 3D background (null = hide the showroom, e.g. track select shows a minimap instead). */
  showroom(car: ShowroomCar | null): void;
  /** Podium (results of a race): up to 3 cars, P1 first. null = back to single-car showroom. */
  podium(cars: ShowroomCar[] | null): void;
  uiSound(kind: 'move' | 'confirm' | 'back' | 'error'): void;
  toggleFullscreen(): void;
  /** The player left the results screen (繼續 / back / end weekend); optional. */
  resultsClosed?(): void;
}
