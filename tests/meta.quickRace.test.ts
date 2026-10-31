/**
 * Quick race (meta/quickRace.ts): one press from the main menu builds a valid race-only Grand Prix from the saved
 * Grand Prix choices, falling back to the first layout / first seated team when a choice does not exist.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETUP } from '../src/core/defaults';
import { listLayouts, resolveLaps } from '../src/meta/options';
import { defaultProfile } from '../src/meta/prefs';
import { quickRacePlan } from '../src/meta/quickRace';
import { builtinRoster } from '../src/meta/roster';
import { buildSessionConfig, validateSessionConfig } from '../src/meta/sessionBuilder';

const setup = () => ({ ...DEFAULT_SETUP });

describe('quick race', () => {
  test('a new profile races the first layout as a valid race-only session that returns to the main menu', () => {
    const roster = builtinRoster();
    const plan = quickRacePlan(defaultProfile(), roster, setup, 42);
    if (!plan) throw new Error('no plan');
    const first = listLayouts()[0]!;
    expect(plan.request.kind).toBe('race');
    expect(plan.request.layoutId).toBe(first.id);
    expect(plan.layoutName).toBe(first.displayName);
    expect(plan.ctx.returnTo).toBe('main');
    expect(plan.ctx.weekendQueue).toEqual([]);
    const config = buildSessionConfig(plan.request);
    expect(validateSessionConfig(config)).toEqual([]);
    expect(config.grid.some((g) => g.driverId === plan.driverId)).toBe(true);
  });

  test('the saved track, team, driver, distance and weather are used', () => {
    const roster = builtinRoster();
    const profile = defaultProfile();
    const layout = listLayouts()[3]!;
    const team = roster.teams[2]!;
    const driver = roster.drivers.find((d) => d.teamId === team.id && d.id !== team.driverIds[0]) ?? roster.drivers.find((d) => d.teamId === team.id)!;
    Object.assign(profile.gp, { layoutId: layout.id, teamId: team.id, driverId: driver.id, laps: 'l10', weather: 'rain' });
    const plan = quickRacePlan(profile, roster, setup, 7);
    if (!plan) throw new Error('no plan');
    expect(plan.request.layoutId).toBe(layout.id);
    expect(plan.request.players[0]).toMatchObject({ teamId: team.id, driverId: driver.id });
    expect(plan.request.raceLaps).toBe(resolveLaps('l10', layout.fullLaps));
    expect(plan.request.weather).toBe('rain');
    expect(plan.teamName).toBe(team.name);
  });

  test('a team or driver from another roster falls back to the first seated team and its driver', () => {
    const roster = builtinRoster();
    const profile = defaultProfile();
    Object.assign(profile.gp, { teamId: 'no-such-team', driverId: 'nobody' });
    const plan = quickRacePlan(profile, roster, setup, 1);
    if (!plan) throw new Error('no plan');
    const first = roster.teams[0]!;
    expect(plan.teamId).toBe(first.id);
    expect(roster.drivers.find((d) => d.id === plan.driverId)?.teamId).toBe(first.id);

    Object.assign(profile.gp, { teamId: first.id, driverId: 'nobody' });
    const kept = quickRacePlan(profile, roster, setup, 1);
    expect(kept?.teamId).toBe(first.id);
    expect(roster.drivers.find((d) => d.id === kept?.driverId)?.teamId).toBe(first.id);
  });

  test('no team with drivers means no quick race', () => {
    expect(quickRacePlan(defaultProfile(), { teams: [], drivers: [] }, setup, 1)).toBeNull();
  });
});
