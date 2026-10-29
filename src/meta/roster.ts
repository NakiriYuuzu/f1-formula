/**
 * Rosters: which teams and drivers take part in an event. Builds the standard field (the active roster pack — by
 * default the 2026 F1 grid — or the 10 fictional teams; see rosterPack.ts), the career field (custom 'player' driver replaces a team's
 * second driver) and the My Team field (extra team 'myteam').
 * All functions return fresh deep copies so persisted / static data is never aliased.
 */
import type { DriverDef, Livery, TeamDef } from '../core/types';
import { DRIVERS, TEAMS } from '../data/teams';
import { activeRosterPack } from './rosterPack';

export const PLAYER_DRIVER_ID = 'player';
export const MY_TEAM_ID = 'myteam';

export interface Roster {
  teams: TeamDef[];
  drivers: DriverDef[];
}

/** Custom driver identity chosen in the career / My Team wizards. */
export interface PlayerIdentity {
  firstName: string;
  lastName: string;
  /** 3 uppercase letters */
  abbr: string;
  /** 1..99 */
  number: number;
  /** ISO 3166-1 alpha-3 */
  nationality: string;
  helmet: Livery;
}

export function cloneLivery(l: Livery): Livery {
  return {
    primary: l.primary,
    secondary: l.secondary,
    accent: l.accent,
    pattern: l.pattern ?? 'classic',
    ...(l.parts ? { parts: { ...l.parts } } : {}),
    ...(l.finish ? { finish: l.finish } : {}),
  };
}

export function cloneTeam(t: TeamDef): TeamDef {
  return {
    ...t,
    livery: cloneLivery(t.livery),
    rating: { ...t.rating },
    driverIds: [t.driverIds[0], t.driverIds[1]],
  };
}

export function cloneDriver(d: DriverDef): DriverDef {
  return { ...d, skill: { ...d.skill }, helmet: cloneLivery(d.helmet) };
}

export function cloneRoster(r: Roster): Roster {
  return { teams: r.teams.map(cloneTeam), drivers: r.drivers.map(cloneDriver) };
}

/** Teams of the active roster (roster pack, else the fictional teams). Read-only: clone before changing. */
export function rosterTeams(): readonly TeamDef[] {
  return activeRosterPack()?.teams ?? TEAMS;
}

/** Drivers (race drivers + reserves) of the active roster. Read-only: clone before changing. */
export function rosterDrivers(): readonly DriverDef[] {
  return activeRosterPack()?.drivers ?? DRIVERS;
}

/** Reserve / free-agent drivers (career & My Team driver market). */
export function reserveDrivers(): DriverDef[] {
  return rosterDrivers().filter((d) => d.teamId === '').map(cloneDriver);
}

function buildRoster(sourceTeams: readonly TeamDef[], sourceDrivers: readonly DriverDef[]): Roster {
  const teams = sourceTeams.map(cloneTeam);
  const drivers: DriverDef[] = [];
  for (const team of teams) {
    for (const id of team.driverIds) {
      const def = sourceDrivers.find((d) => d.id === id);
      if (def) drivers.push({ ...cloneDriver(def), teamId: team.id });
    }
  }
  return { teams, drivers };
}

/** The active roster's teams with their race drivers. */
export function standardRoster(): Roster {
  return buildRoster(rosterTeams(), rosterDrivers());
}

/** The 10 fictional teams with their 20 race drivers, whatever pack is active (story mode). */
export function builtinRoster(): Roster {
  return buildRoster(TEAMS, DRIVERS);
}

/** Car performance proxy used for grid ordering, expectations and AI field selection (0..1). */
export function teamStrength(team: TeamDef): number {
  const { aero, power, chassis } = team.rating;
  const v = (aero + power + chassis) / 3;
  return Number.isFinite(v) ? v : 0.85;
}

export function findDriver(roster: Roster, id: string): DriverDef | undefined {
  return roster.drivers.find((d) => d.id === id);
}

export function findTeam(roster: Roster, id: string): TeamDef | undefined {
  return roster.teams.find((t) => t.id === id);
}

/** Display name "First Last". */
export function driverName(d: Pick<DriverDef, 'firstName' | 'lastName'>): string {
  return `${d.firstName} ${d.lastName}`.trim();
}

/** Build the custom player DriverDef. */
export function createPlayerDriver(identity: PlayerIdentity, teamId: string, skill: DriverDef['skill']): DriverDef {
  return {
    id: PLAYER_DRIVER_ID,
    firstName: identity.firstName,
    lastName: identity.lastName,
    abbr: identity.abbr,
    number: identity.number,
    nationality: identity.nationality,
    teamId,
    skill: { ...skill },
    helmet: cloneLivery(identity.helmet),
  };
}

/**
 * Standard roster (or `base`) where `player` takes the seat of `teamId`'s second driver.
 * Returns the replaced driver id (left out of the session). Unknown team → first team.
 */
export function rosterWithReplacement(
  teamId: string,
  player: DriverDef,
  base: Roster = standardRoster(),
): { roster: Roster; replacedId: string } {
  const team = base.teams.find((t) => t.id === teamId) ?? base.teams[0];
  if (!team) return { roster: base, replacedId: '' };
  const replacedId = team.driverIds[1];
  team.driverIds = [team.driverIds[0], player.id];
  const drivers = base.drivers.filter((d) => d.id !== replacedId && d.id !== player.id);
  drivers.push({ ...cloneDriver(player), teamId: team.id });
  return { roster: { teams: base.teams, drivers }, replacedId };
}

/** Standard roster plus an extra team (My Team) with its two drivers. */
export function rosterWithExtraTeam(team: TeamDef, teamDrivers: DriverDef[]): Roster {
  const base = standardRoster();
  const extraIds = new Set(teamDrivers.map((d) => d.id));
  // a signed reserve is never part of the standard field, but guard anyway against duplicate ids
  const drivers = base.drivers.filter((d) => !extraIds.has(d.id));
  for (const d of teamDrivers) drivers.push({ ...cloneDriver(d), teamId: team.id });
  return { teams: [...base.teams.filter((t) => t.id !== team.id), cloneTeam(team)], drivers };
}

/** Car numbers already used by the roster (optionally ignoring some driver ids). */
export function usedNumbers(roster: Roster, ignoreIds: readonly string[] = []): Set<number> {
  const out = new Set<number>();
  for (const d of roster.drivers) if (!ignoreIds.includes(d.id)) out.add(d.number);
  return out;
}

/**
 * Make car numbers unique: drivers listed in `priorityIds` keep theirs (in order), the others keep theirs
 * when free, and duplicates get the lowest free number in 2..99.
 */
export function ensureUniqueNumbers(drivers: DriverDef[], priorityIds: readonly string[]): DriverDef[] {
  const taken = new Set<number>();
  const result = drivers.map(cloneDriver);
  const order = [
    ...result.filter((d) => priorityIds.includes(d.id)).sort((a, b) => priorityIds.indexOf(a.id) - priorityIds.indexOf(b.id)),
    ...result.filter((d) => !priorityIds.includes(d.id)),
  ];
  const pending: DriverDef[] = [];
  for (const d of order) {
    const n = Number.isInteger(d.number) && d.number >= 1 && d.number <= 99 ? d.number : 0;
    if (n > 0 && !taken.has(n)) taken.add(n);
    else pending.push(d);
  }
  for (const d of pending) {
    // a field never exceeds 24 cars, so a free number in 1..99 always exists
    let n = 2;
    while (n <= 99 && taken.has(n)) n++;
    if (n > 99) n = 1;
    d.number = n;
    taken.add(n);
  }
  return result;
}
