/**
 * Practice and qualifying run the whole field on track (time trial stays solo): AI cars start spread over the lap,
 * set real lap times, and in qualifying return to the garage (parked, hidden) once their run is done.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { SIM_DT } from '../src/core/defaults';
import { getLayout } from '../src/data/tracks/index';
import { computeAIInput } from '../src/ai/index';
import { buildQuickStart } from '../src/meta/sessionBuilder';
import { buildRenderFrame, buildSessionResult, createWorld, isSessionOver, stepWorld } from '../src/race/index';
import { useFictionalRoster } from './rosterFixture';

// written against the fictional field (data/teams.ts); the game's default is the 2026 F1 grid
beforeEach(useFictionalRoster);

describe('practice / qualifying field', () => {
  test('time trial stays solo', () => {
    const { config } = buildQuickStart({ kind: 'tt', layoutId: 'isola-verde' });
    expect(config.grid).toHaveLength(1);
  });

  test('qualifying: 20 cars on track, all set times, finished AI parked out of sight', () => {
    const { config } = buildQuickStart({ kind: 'quali', layoutId: 'isola-verde' });
    const track = getLayout(config.layoutId);
    const world = createWorld(config, track);
    expect(world.cars).toHaveLength(20);

    const player = world.cars.find((c) => c.playerIndex === 0);
    if (!player) throw new Error('no player car');
    // nobody starts on top of the player
    for (const c of world.cars) {
      if (c.id !== player.id) expect(Math.hypot(c.phys.x - player.phys.x, c.phys.z - player.phys.z)).toBeGreaterThan(50);
    }

    let t = 0;
    let visibleEarly = 0;
    while (!isSessionOver(world) && t < 600) {
      stepWorld(world, track, [computeAIInput(world, player, track, SIM_DT), null], SIM_DT);
      t += SIM_DT;
      if (visibleEarly === 0 && t >= 30) visibleEarly = buildRenderFrame(world, track).cars.filter((c) => c.visible).length;
    }
    expect(isSessionOver(world)).toBe(true);
    expect(visibleEarly).toBe(20);

    const result = buildSessionResult(world);
    expect(result.rows.filter((r) => r.bestLap !== null && Number.isFinite(r.bestLap)).length).toBe(20);
    for (const r of result.rows) {
      if (r.bestLap !== null) expect(r.bestLap).toBeLessThan(track.referenceLapTime * 1.35);
    }
    const aiVisible = buildRenderFrame(world, track).cars.filter((c) => c.visible && c.carId !== player.id);
    expect(aiVisible).toHaveLength(0);
  });
});
