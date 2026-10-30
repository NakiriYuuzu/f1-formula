/**
 * AI field strength and racecraft: AI-only teams run closer cars (a human's team-mate keeps the human's car), the
 * simulated qualifying spread, race-day form (races only, seeded, bounded) and lively green-flag racing in headless
 * 5-lap races (overtakes after the opening lap, every car finishes, few heavy contacts).
 */
import { describe, expect, test } from 'bun:test';
import { AI_CAR_GAP, RACE_FORM, aiCarTeam } from '../src/ai/index';
import { createWorld, isSessionOver, simulateLapTimes, stepWorld } from '../src/race/index';
import { createCarSpec } from '../src/physics/index';
import { DEFAULT_ASSISTS, DEFAULT_RULES, DEFAULT_SETUP, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout } from '../src/data/tracks/index';
import type { SessionConfig, SessionKind, TireCompound } from '../src/core/types';

const RACERS = DRIVERS.filter((d) => d.teamId !== '');

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Menu-like grid (car strength + driver pace, seeded jitter), seeded soft / medium start tyres, difficulty 80. */
function config(layoutId: string, o: { seed?: number; kind?: SessionKind; human?: string } = {}): SessionConfig {
  const seed = o.seed ?? 1;
  const strength = (id: string): number => {
    const d = RACERS.find((x) => x.id === id)!;
    const t = TEAMS.find((x) => x.id === d.teamId)!;
    return (t.rating.aero + t.rating.power + t.rating.chassis) / 3 + d.skill.pace * 0.35 + (hash(`${id}${seed}`) - 0.5) * 0.04;
  };
  const order = RACERS.map((d) => d.id).sort((a, b) => strength(b) - strength(a));
  const human = o.human ? RACERS.find((d) => d.id === o.human)! : null;
  return {
    mode: 'grandPrix',
    kind: o.kind ?? 'race',
    layoutId,
    laps: 5,
    timeLimit: o.kind === 'practice' ? 300 : null,
    qualifyingLaps: 0,
    weather: 'clear',
    dynamicWeather: false,
    timeOfDay: 'day',
    regulation: '2025',
    aiDifficulty: 80,
    players: human ? [{ playerIndex: 0, driverId: human.id, teamId: human.teamId, setup: { ...DEFAULT_SETUP }, assists: { ...DEFAULT_ASSISTS } }] : [],
    grid: order.map((id) => {
      const compound: TireCompound = hash(`${id}tyre${seed}`) < 0.55 ? 'medium' : 'soft';
      const teamId = RACERS.find((d) => d.id === id)!.teamId;
      return { driverId: id, teamId, playerIndex: id === human?.id ? 0 : -1, startCompound: compound };
    }),
    teams: TEAMS,
    drivers: RACERS,
    rules: { ...DEFAULT_RULES, safetyCar: 'off' },
    seed,
    ghost: null,
    objective: null,
  };
}

describe('AI field strength', () => {
  test('aiCarTeam keeps AI_CAR_GAP of each gap to a rating of 1 (reliability untouched)', () => {
    const team = TEAMS.find((t) => t.id === 'corvid')!;
    const ai = aiCarTeam(team);
    expect(ai.rating.aero).toBeCloseTo(1 - (1 - team.rating.aero) * AI_CAR_GAP, 9);
    expect(ai.rating.power).toBeCloseTo(1 - (1 - team.rating.power) * AI_CAR_GAP, 9);
    expect(ai.rating.reliability).toBe(team.rating.reliability);
    expect(aiCarTeam({ ...team, rating: { ...team.rating, aero: 1.03 } }).rating.aero).toBe(1.03);
  });

  test('AI-only teams run closer cars; the AI team-mate of a human keeps the human car', () => {
    const track = getLayout('porto-lumen');
    const world = createWorld(config(track.id, { human: 'caldwell' }), track);
    const human = world.cars.find((c) => c.playerIndex === 0)!;
    const mate = world.cars.find((c) => c.teamId === human.teamId && c.playerIndex === -1)!;
    expect(mate.spec).toEqual(human.spec);
    // same rating as the human's team, but driven by AI only
    const weak = world.cars.find((c) => c.teamId === 'ironbark')!;
    const raw = createCarSpec(TEAMS.find((t) => t.id === 'ironbark')!, DEFAULT_SETUP, '2025');
    expect(weak.spec.downforceArea).toBeGreaterThan(raw.downforceArea);
    expect(weak.spec.icePower).toBeGreaterThan(raw.icePower);
    const best = world.cars.find((c) => c.teamId === 'vanta')!;
    expect(weak.spec.downforceArea).toBeLessThan(best.spec.downforceArea);
  });

  // 2.3 % before the driver's pace counted double and driving styles were added (the stars stand out more)
  test('simulated qualifying: the AI field is within 3.2 % (was ≈ 4.4 %), still ordered by car and driver', () => {
    const track = getLayout('porto-lumen');
    const times = simulateLapTimes(config(track.id), track);
    const all = Object.values(times);
    expect(all).toHaveLength(20);
    expect(Math.max(...all) / Math.min(...all) - 1).toBeLessThan(0.032);
    expect(times.varga).toBeLessThan(times.caldwell);
  });

  test('race-day form: races only, seeded, within ± RACE_FORM of the base pace', () => {
    const track = getLayout('porto-lumen');
    const race = createWorld(config(track.id), track);
    const again = createWorld(config(track.id), track);
    const practice = createWorld(config(track.id, { kind: 'practice' }), track);
    const ratios = race.cars.map((c, i) => c.ai.latFactor / practice.cars[i].ai.latFactor);
    for (const r of ratios) {
      expect(r).toBeGreaterThanOrEqual(1 - RACE_FORM - 1e-9);
      expect(r).toBeLessThanOrEqual(1 + RACE_FORM + 1e-9);
    }
    expect(ratios.some((r) => Math.abs(r - 1) > RACE_FORM / 4)).toBe(true);
    expect(again.cars.map((c) => c.ai.latFactor)).toEqual(race.cars.map((c) => c.ai.latFactor));
  });
});

describe('racecraft', () => {
  // [layout, seed, overtakes after the opening lap at least] — the old, processional AI: 6 and 0
  for (const [layoutId, seed, minOvertakes] of [
    ['monza', 2, 14],
    ['koyo-hills', 1, 8],
  ] as const) {
    test(
      `${layoutId}: positions change after the opening lap, every car finishes, few heavy contacts`,
      () => {
        const track = getLayout(layoutId);
        const world = createWorld(config(layoutId, { seed }), track);
        let overtakes = 0;
        let heavy = 0;
        while (!isSessionOver(world) && world.time < 900) {
          stepWorld(world, track, [], SIM_DT);
          const leaderLaps = Math.max(...world.cars.map((c) => c.timing.lapsCompleted));
          for (const e of world.events) {
            if (e.type === 'overtake' && leaderLaps >= 1) overtakes++;
            if (e.type === 'collision' && e.otherCarId !== null && e.impulse > 5000) heavy++;
          }
          world.events.length = 0;
        }
        expect(isSessionOver(world)).toBe(true);
        expect(world.cars.every((c) => c.status === 'finished')).toBe(true);
        expect(overtakes).toBeGreaterThanOrEqual(minOvertakes);
        expect(heavy).toBeLessThanOrEqual(4);
      },
      60_000,
    );
  }
});
