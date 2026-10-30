/**
 * Online entries: what a player races as in an online room — a roster driver, their own driver from a career / My Team
 * save in a roster driver's seat (a career driver brings their career team's part development to the team they sit
 * in), or their whole My Team (name, livery, rating and part development, driver and signed teammate) in a roster
 * team's place (its garage and both seats). A guest sends its entry with its pick; the host
 * sanitizes it and applies every player's entry to its roster when it builds a session (pure; ids made unique per seat).
 */
import type { CarPartGains, DriverDef, PlayerIndex, TeamDef } from '../core/types';
import type { CareerSave } from './career';
import { CAR_PARTS, PART_MAX_LEVEL, teamGains } from './development';
import { asRecord, isRecord, num, sanitizeDriver, sanitizeLivery, str } from './guards';
import { myTeamDef, myTeamDevelopment, type MyTeamSave } from './myTeam';
import { cloneDriver, cloneRoster, cloneTeam, driverName, rosterDrivers, type Roster } from './roster';

export type OnlineEntry =
  | { kind: 'roster' }
  /**
   * source: which save the driver comes from (the lobby lists it, so the player sees which of the two the host took);
   * gains: a career driver's team development, for both cars of the team they sit in (empty for a My Team driver)
   */
  | { kind: 'driver'; source: 'career' | 'myTeamDriver'; driver: DriverDef; gains: CarPartGains }
  | { kind: 'team'; team: TeamDef; driver: DriverDef; mate: DriverDef | null; gains: CarPartGains };

/** Where an entry comes from (remembered in the online prefs). */
export type OnlineEntrySource = 'roster' | 'career' | 'myTeamDriver' | 'myTeam';
export const ONLINE_ENTRY_SOURCES: readonly OnlineEntrySource[] = ['roster', 'career', 'myTeamDriver', 'myTeam'];

export interface OnlineEntryOption {
  source: OnlineEntrySource;
  /** zh-TW */
  label: string;
  entry: OnlineEntry;
}

export const ROSTER_ENTRY: OnlineEntry = { kind: 'roster' };

/** The entries a player can race as: always the roster, plus what their career / My Team saves hold. */
export function onlineEntryOptions(career: CareerSave | null, myTeam: MyTeamSave | null): OnlineEntryOption[] {
  const out: OnlineEntryOption[] = [{ source: 'roster', label: '名單車手', entry: ROSTER_ENTRY }];
  if (career) {
    out.push({
      source: 'career',
      label: `生涯車手：${driverName(career.driver)}`,
      entry: { kind: 'driver', source: 'career', driver: cloneDriver(career.driver), gains: teamGains(career.development.teams[career.teamId]) },
    });
  }
  if (myTeam) {
    out.push({
      source: 'myTeamDriver',
      label: `我的車隊車手：${driverName(myTeam.driver)}`,
      entry: { kind: 'driver', source: 'myTeamDriver', driver: cloneDriver(myTeam.driver), gains: {} },
    });
    const mate = rosterDrivers().find((d) => d.id === myTeam.teammateId);
    out.push({
      source: 'myTeam',
      label: `我的車隊：${myTeam.name}（整隊）`,
      entry: { kind: 'team', team: myTeamDef(myTeam), driver: cloneDriver(myTeam.driver), mate: mate ? cloneDriver(mate) : null, gains: teamGains(myTeamDevelopment(myTeam)) },
    });
  }
  return out;
}

const FALLBACK_LIVERY = { primary: '#00d2ff', secondary: '#101820', accent: '#ffffff', pattern: 'classic' } as const;
const FALLBACK_DRIVER: DriverDef = {
  id: 'online',
  firstName: '玩家',
  lastName: '',
  abbr: 'PLY',
  number: 99,
  nationality: 'TWN',
  teamId: '',
  skill: { pace: 0.85, racecraft: 0.85, awareness: 0.85, wet: 0.85, consistency: 0.85 },
  helmet: { ...FALLBACK_LIVERY },
};

function sanitizeTeam(v: unknown): TeamDef {
  const r = asRecord(v);
  const rating = asRecord(r.rating);
  return {
    id: 'myteam',
    name: str(r.name, '我的車隊', 24),
    shortName: typeof r.shortName === 'string' && /^[A-Z]{3}$/.test(r.shortName) ? r.shortName : 'MYT',
    livery: sanitizeLivery(r.livery, FALLBACK_LIVERY),
    base: str(r.base, '新星工坊', 32),
    powerUnit: str(r.powerUnit, '', 32, true),
    rating: {
      aero: num(rating.aero, 0, 1, 0.86),
      power: num(rating.power, 0, 1, 0.91),
      chassis: num(rating.chassis, 0, 1, 0.86),
      reliability: num(rating.reliability, 0, 1, 0.93),
    },
    driverIds: ['', ''],
  };
}

function sanitizeGains(v: unknown): CarPartGains {
  const r = asRecord(v);
  const out: CarPartGains = {};
  for (const p of CAR_PARTS) {
    const gain = num(r[p], 0, PART_MAX_LEVEL, 0);
    if (gain > 0) out[p] = gain;
  }
  return out;
}

/** An entry from another player (untrusted): a valid entry, the roster when malformed. */
export function sanitizeOnlineEntry(v: unknown): OnlineEntry {
  if (!isRecord(v)) return ROSTER_ENTRY;
  if (v.kind === 'driver' && isRecord(v.driver)) {
    const source = v.source === 'myTeamDriver' ? 'myTeamDriver' : 'career';
    return { kind: 'driver', source, driver: sanitizeDriver(v.driver, FALLBACK_DRIVER), gains: source === 'career' ? sanitizeGains(v.gains) : {} };
  }
  if (v.kind === 'team' && isRecord(v.team) && isRecord(v.driver)) {
    return {
      kind: 'team',
      team: sanitizeTeam(v.team),
      driver: sanitizeDriver(v.driver, FALLBACK_DRIVER),
      mate: isRecord(v.mate) ? sanitizeDriver(v.mate, FALLBACK_DRIVER) : null,
      gains: sanitizeGains(v.gains),
    };
  }
  return ROSTER_ENTRY;
}

function maxGains(a: CarPartGains, b: CarPartGains): CarPartGains {
  const out: CarPartGains = { ...a };
  for (const p of CAR_PARTS) {
    const g = Math.max(a[p] ?? 0, b[p] ?? 0);
    if (g > 0) out[p] = g;
  }
  return out;
}

/** A player's seat in the lobby (roster ids) and what they race as. */
export interface OnlineSeat {
  playerIndex: PlayerIndex;
  teamId: string;
  driverId: string;
  entry: OnlineEntry;
}

export interface OnlineField {
  roster: Roster;
  /** every seat's driver / team in `roster` (the roster's ids when the entry could not be applied) */
  seats: { playerIndex: PlayerIndex; teamId: string; driverId: string }[];
  /** part development of the My Team entries and of the teams career drivers sit in (SessionRequest.development) */
  development: Record<string, CarPartGains>;
}

/**
 * The session roster with every seat's entry applied: a driver entry takes its seat's place in the team, a team entry
 * takes its team's place in the team list (so its garage too) with the player and their teammate (without one, the
 * team's first roster driver stays on as teammate). A career driver's development goes to both cars of their team (two
 * in one team: the higher gain per part). A seat that no longer resolves keeps its roster ids.
 */
export function applyOnlineEntries(base: Roster, seats: readonly OnlineSeat[]): OnlineField {
  const roster = cloneRoster(base);
  const development: Record<string, CarPartGains> = {};
  const out: OnlineField['seats'] = [];
  for (const seat of seats) {
    const tag = `p${seat.playerIndex + 1}`;
    const entry = seat.entry;
    const ti = roster.teams.findIndex((t) => t.id === seat.teamId);
    const team = roster.teams[ti];
    if (entry.kind === 'team' && team) {
      const teamId = `online-team-${tag}`;
      const driverId = `online-${tag}`;
      const keep = entry.mate ? null : roster.drivers.find((d) => d.id === team.driverIds[0]) ?? null;
      const mate: DriverDef | null = entry.mate ? { ...cloneDriver(entry.mate), id: `online-${tag}-mate` } : keep;
      if (mate) {
        const old = team.driverIds;
        roster.teams[ti] = { ...cloneTeam(entry.team), id: teamId, driverIds: [driverId, mate.id] };
        roster.drivers = roster.drivers.filter((d) => !old.includes(d.id));
        roster.drivers.push({ ...cloneDriver(entry.driver), id: driverId, teamId }, { ...cloneDriver(mate), teamId });
        development[teamId] = { ...entry.gains };
        out.push({ playerIndex: seat.playerIndex, teamId, driverId });
        continue;
      }
    }
    if (entry.kind === 'driver' && team) {
      const slot = team.driverIds.indexOf(seat.driverId);
      const di = roster.drivers.findIndex((d) => d.id === seat.driverId);
      if (slot >= 0 && di >= 0) {
        const driverId = `online-${tag}`;
        team.driverIds[slot] = driverId;
        roster.drivers[di] = { ...cloneDriver(entry.driver), id: driverId, teamId: team.id };
        const gains = maxGains(development[team.id] ?? {}, entry.gains);
        if (Object.keys(gains).length > 0) development[team.id] = gains;
        out.push({ playerIndex: seat.playerIndex, teamId: team.id, driverId });
        continue;
      }
    }
    out.push({ playerIndex: seat.playerIndex, teamId: seat.teamId, driverId: seat.driverId });
  }
  return { roster, seats: out, development };
}
