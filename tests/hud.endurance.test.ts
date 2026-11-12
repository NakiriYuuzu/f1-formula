/**
 * Endurance race HUD (src/ui/hud/endurance.ts): the time left in place of the laps (before the start, running, stopped
 * under a red flag, run out), the fuel readout's call (the margin over the flag, else by when to box), and the MFD's
 * fuel choices and what a fill puts in.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES } from '../src/core/defaults';
import type { SessionConfig, WorldState } from '../src/core/types';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import { createWorld, enduranceFormat, fillTime } from '../src/race/index';
import { FUEL_CHOICES, enduranceCounter, enduranceFuelCall, fillLabel, fuelChoiceLabel, fuelChoiceTarget } from '../src/ui/hud/endurance';

const RACERS = DRIVERS.filter((d) => d.teamId !== '').slice(0, 4);

function world(format = true): WorldState {
  const config: SessionConfig = {
    mode: 'grandPrix',
    kind: 'race',
    layoutId: 'monza',
    laps: 3,
    timeLimit: null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 80,
    players: [],
    grid: RACERS.map((d) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: 'medium' })),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES },
    seed: 3,
    ghost: null,
    objective: null,
    ...(format ? { raceFormat: enduranceFormat(40) } : {}),
  };
  return createWorld(config, getLayout('monza'));
}

describe('the time left in place of the laps', () => {
  test('nothing outside an endurance race', () => {
    expect(enduranceCounter(world(false), 3)).toBeNull();
  });

  test('the whole duration before the start; the clock and the lap while it runs; 時間到 once it has run out', () => {
    const w = world();
    expect(enduranceCounter(w, 0)).toEqual({ value: '40:00', sub: '' });
    w.time = 1000;
    w.session.endurance = { dueAt: 1000 + 754.2, held: null };
    expect(enduranceCounter(w, 9)).toEqual({ value: '12:35', sub: '第 9 圈' });
    // stopped (red flag): what was left, as the host's mirror has it
    w.session.endurance = { dueAt: 0, held: 61 };
    expect(enduranceCounter(w, 9)).toEqual({ value: '1:01', sub: '第 9 圈' });
    w.session.endurance = { dueAt: 999, held: null };
    expect(enduranceCounter(w, 27)).toEqual({ value: '0:00', sub: '時間到' });
  });
});

describe('the fuel readout', () => {
  test('reaching the flag: the margin, tight under 0.3 of a lap', () => {
    expect(enduranceFuelCall(8.4, 7.2, 0.5)).toEqual({ text: '+1.2', state: 'ok' });
    expect(enduranceFuelCall(7.4, 7.2, 0.5)).toEqual({ text: '+0.2', state: 'tight' });
  });

  test('short of the flag: within how many passes of the pit entry to box', () => {
    // 3.6 laps of fuel, the entry 0.4 of a lap ahead: the entries at 0.4, 1.4, 2.4 and 3.4 laps
    expect(enduranceFuelCall(3.6, 12, 0.4)).toEqual({ text: '4 圈內進站', state: 'ok' });
    expect(enduranceFuelCall(1.6, 12, 0.4)).toEqual({ text: '2 圈內進站', state: 'tight' });
    expect(enduranceFuelCall(0.9, 12, 0.4)).toEqual({ text: '本圈進站', state: 'short' });
    expect(enduranceFuelCall(0.3, 12, 0.4)).toEqual({ text: '燃油不足', state: 'short' });
  });
});

describe('the MFD fuel for the next stop', () => {
  test('the choices and the tank each asks for (the automatic fill decided at the stop)', () => {
    expect(FUEL_CHOICES.map(fuelChoiceLabel)).toEqual(['自動', '不加油', '加到 1/4', '半箱', '加到 3/4', '加滿']);
    expect(FUEL_CHOICES.map((c) => fuelChoiceTarget(c, 20))).toEqual([undefined, 0, 5, 10, 15, 20]);
  });

  test('what a fill puts in, and nothing when the tank already holds it', () => {
    expect(fillLabel(20, 4, 20)).toBe(`+16.0 kg · ${fillTime(16, 20).toFixed(1)} 秒`);
    expect(fillLabel(30, 4, 20)).toBe(`+16.0 kg · 8.0 秒`);
    expect(fillLabel(5, 8, 20)).toBe('不加油');
  });
});
