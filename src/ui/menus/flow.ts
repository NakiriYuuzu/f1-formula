/**
 * Session launch flow shared by every mode: a weekend (practice → qualifying → [sprint →] race, or a subset) starts with the
 * briefing of its first session; the remaining kinds travel in SessionContext.weekendQueue.
 */
import type { SessionContext } from '../../meta/context';
import type { WeekendStep } from '../../meta/options';
import { requestForKind, type SessionRequest } from '../../meta/sessionBuilder';
import type { Host } from './screen';
import { BriefingScreen } from './screens/briefing';

export interface WeekendStart {
  returnTo: SessionContext['returnTo'];
  round: number | null;
  storyId: string | null;
}

/** Push the briefing of the weekend's first session. */
export function launchWeekend(host: Host, base: SessionRequest, sessions: readonly WeekendStep[], start: WeekendStart): void {
  const kinds: WeekendStep[] = sessions.length > 0 ? [...sessions] : [base.kind];
  const [first, ...rest] = kinds as [WeekendStep, ...WeekendStep[]];
  const ctx: SessionContext = {
    returnTo: start.returnTo,
    weekendQueue: rest,
    round: start.round,
    storyId: start.storyId,
    plan: { request: base, qualifyingOrder: null },
  };
  host.push(new BriefingScreen(host, requestForKind(base, first, null), ctx, false));
}
