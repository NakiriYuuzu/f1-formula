/**
 * Test files pin the roster they were written for: the roster switch is module state shared by every file of one
 * `bun test` run, so a file must not depend on what an earlier file left behind.
 */
import { resetRosterPackCache, setDefaultRosterPack, setRosterPack, useDefaultRosterPack } from '../src/meta/rosterPack';

/** The fictional roster of data/teams.ts (10 teams / 20 cars, story mode); the game's default is the 2026 F1 grid. */
export function useFictionalRoster(): void {
  resetRosterPackCache();
  setRosterPack(null);
}

/** The game's default: the built-in 2026 F1 grid (11 teams / 22 cars). */
export function useRealGrid(): void {
  resetRosterPackCache();
  setDefaultRosterPack(null);
  useDefaultRosterPack();
}
