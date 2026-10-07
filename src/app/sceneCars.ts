/**
 * Maps the world's cars to the renderer's car list (pure): livery, number, team code and driver helmet,
 * resolved from the session's teams/drivers with the static data as fallback.
 */
import type { Livery, WorldState } from '../core/types';
import { DRIVERS, TEAMS } from '../data/teams';
import type { RaceSceneCar } from '../render/RaceScene';

function copyLivery(l: Livery): Livery {
  return {
    primary: l.primary,
    secondary: l.secondary,
    accent: l.accent,
    ...(l.pattern ? { pattern: l.pattern } : {}),
    ...(l.parts ? { parts: { ...l.parts } } : {}),
    ...(l.finish ? { finish: l.finish } : {}),
  };
}

/** Team colours in pit-box order (race/world.ts boxSlot uses the SessionConfig.teams index). */
export function sceneTeamColors(world: WorldState): string[] {
  return world.config.teams.map((t) => t.livery.primary);
}

export function sceneCarsFor(world: WorldState): RaceSceneCar[] {
  const { teams, drivers } = world.config;
  return world.cars.map((car) => {
    const team = teams.find((t) => t.id === car.teamId) ?? TEAMS.find((t) => t.id === car.teamId);
    const driver = drivers.find((d) => d.id === car.driverId) ?? DRIVERS.find((d) => d.id === car.driverId);
    return {
      carId: car.id,
      livery: copyLivery(car.livery),
      number: car.number,
      teamShort: team?.shortName ?? car.abbr,
      helmet: copyLivery(driver?.helmet ?? car.livery),
    };
  });
}
