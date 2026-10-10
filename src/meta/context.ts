/**
 * Session context carried through a session (and a race weekend) so the results screen knows what comes next.
 * Plain data. Re-exported by ui/menus as the MenuSystem contract types.
 */
import type { WeekendStep } from './options';
import type { SessionRequest } from './sessionBuilder';

export type MenuHome = 'main' | 'grandPrix' | 'timeTrial' | 'career' | 'myTeam' | 'story' | 'splitScreen' | 'online';

/** Everything needed to build the remaining sessions of a weekend. */
export interface WeekendPlan {
  /** base request of the weekend (kind is replaced per session) */
  request: SessionRequest;
  /** driverIds in qualifying order (set once qualifying is classified) */
  qualifyingOrder: string[] | null;
}

/** Carried through a session so results know where to go next. Plain data. */
export interface SessionContext {
  returnTo: MenuHome;
  /** sessions still to run in this race weekend after the current one, e.g. ['sprint', 'race'] after qualifying of a sprint weekend */
  weekendQueue: WeekendStep[];
  /** career / My Team round index (0-based) */
  round: number | null;
  /** story chapter / challenge id */
  storyId: string | null;
  /** optional weekend plan (menus fill it; absent for contexts built elsewhere) */
  plan?: WeekendPlan;
}
