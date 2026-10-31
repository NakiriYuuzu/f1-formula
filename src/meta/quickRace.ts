/**
 * Quick race (main menu): one press starts a race-only Grand Prix with the last Grand Prix track, team, driver and
 * options saved in the profile. Pure: the caller passes the roster, the setup lookup and the seed.
 */
import type { CarSetup } from '../core/types';
import type { SessionContext } from './context';
import { findLayout, listLayouts, resolveLaps } from './options';
import type { ProfileSave } from './prefs';
import type { Roster } from './roster';
import { requestForKind, type SessionRequest } from './sessionBuilder';

export interface QuickRacePlan {
  /** the race session to build */
  request: SessionRequest;
  ctx: SessionContext;
  layoutName: string;
  teamName: string;
  teamId: string;
  driverId: string;
}

/**
 * The quick race for this profile, or null when no layout or no team with drivers exists. A saved team or driver
 * that is not in the roster (another roster pack was active) falls back to the roster's first team and its driver.
 */
export function quickRacePlan(profile: ProfileSave, roster: Roster, setupFor: (layoutId: string) => CarSetup, seed: number): QuickRacePlan | null {
  const gp = profile.gp;
  const layout = findLayout(gp.layoutId) ?? listLayouts()[0];
  if (!layout) return null;
  const seated = (teamId: string): string[] => roster.drivers.filter((d) => d.teamId === teamId).map((d) => d.id);
  let team = roster.teams.find((t) => t.id === gp.teamId && seated(t.id).length > 0);
  team ??= roster.teams.find((t) => seated(t.id).length > 0);
  if (!team) return null;
  const drivers = seated(team.id);
  const driverId = drivers.includes(gp.driverId) ? gp.driverId : (drivers[0] as string);
  const base: SessionRequest = {
    mode: 'grandPrix',
    kind: 'race',
    layoutId: layout.id,
    raceLaps: resolveLaps(gp.laps, layout.fullLaps),
    weather: gp.weather,
    timeOfDay: gp.timeOfDay,
    regulation: gp.regulation,
    aiDifficulty: gp.aiDifficulty,
    qualifying: gp.qualifying,
    rules: { ...gp.rules },
    seed: seed >>> 0,
    players: [{ playerIndex: 0, driverId, teamId: team.id, setup: setupFor(layout.id), assists: { ...profile.assists }, startCompound: null }],
    roster,
    aiCount: null,
    gridOrder: null,
    playerStartPosition: null,
    ghost: null,
    objective: null,
  };
  return {
    request: requestForKind(base, 'race', null),
    ctx: { returnTo: 'main', weekendQueue: [], round: null, storyId: null, plan: { request: base, qualifyingOrder: null } },
    layoutName: layout.displayName,
    teamName: team.name,
    teamId: team.id,
    driverId,
  };
}
