/**
 * Builders for the 3D showroom car shown behind car-focused menu screens.
 */
import type { DriverDef, Livery, TeamDef } from '../../core/types';
import { myTeamDef, type MyTeamSave } from '../../meta/myTeam';
import { cloneLivery, rosterDrivers, rosterTeams, type Roster } from '../../meta/roster';
import type { ShowroomCar } from './types';

const FALLBACK_LIVERY: Livery = { primary: '#ff5a1f', secondary: '#111214', accent: '#f4f1e8', pattern: 'classic' };

export function showroomCar(team: TeamDef | undefined, driver: Pick<DriverDef, 'number' | 'helmet'> | undefined): ShowroomCar {
  return {
    livery: cloneLivery(team?.livery ?? FALLBACK_LIVERY),
    number: driver?.number ?? 1,
    teamShort: team?.shortName ?? 'NOV',
    helmet: cloneLivery(driver?.helmet ?? FALLBACK_LIVERY),
  };
}

/** Car of a driver within a roster (falls back to the active roster). */
export function showroomCarFor(roster: Roster | null, driverId: string, teamId: string): ShowroomCar {
  const teams = roster?.teams ?? rosterTeams();
  const drivers = roster?.drivers ?? rosterDrivers();
  const driver = drivers.find((d) => d.id === driverId) ?? rosterDrivers().find((d) => d.id === driverId);
  const team = teams.find((t) => t.id === (driver?.teamId || teamId)) ?? teams.find((t) => t.id === teamId) ?? rosterTeams()[0];
  return showroomCar(team, driver);
}

/** The My Team car (custom livery, player number and helmet). */
export function myTeamCar(save: MyTeamSave): ShowroomCar {
  return showroomCar(myTeamDef(save), save.driver);
}
