/**
 * Grade-separated crossing in the race runtime: a stuck AI car reset on the Suzuka bridge deck (no trackIndex hint
 * from the pose alone) must stay on the upper road in both directions instead of dropping to the road below.
 */
import { describe, expect, test } from 'bun:test';
import { createWorld, stepWorld } from '../src/race/index';
import { DEFAULT_RULES, SIM_DT } from '../src/core/defaults';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { getLayout, hasLayout } from '../src/data/tracks/index';
import { poseAt, sampleAt, signedDeltaS } from '../src/track/track';
import type { BuiltTrack, SessionConfig } from '../src/core/types';

const RACERS = DRIVERS.filter((d) => d.teamId !== '').slice(0, 4);

function config(layoutId: string): SessionConfig {
  return {
    mode: 'grandPrix', kind: 'race', layoutId, laps: 5, timeLimit: null, qualifyingLaps: 0, weather: 'clear',
    dynamicWeather: false, timeOfDay: 'day', regulation: '2025', aiDifficulty: 90, players: [],
    grid: RACERS.map((d) => ({ driverId: d.id, teamId: d.teamId, playerIndex: -1, startCompound: 'medium' })),
    teams: TEAMS, drivers: RACERS, rules: { ...DEFAULT_RULES, safetyCar: 'off' }, seed: 7, ghost: null, objective: null,
  };
}

/** s at the middle of the longest deck run. */
function deckMiddle(track: BuiltTrack): number {
  let best = { start: -1, len: 0 };
  for (let i = 0; i < track.count; ) {
    if (!track.deck[i]) { i++; continue; }
    let j = i;
    while (j < track.count && track.deck[j]) j++;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j;
  }
  return (best.start + best.len / 2) * track.spacing;
}

describe.if(hasLayout('suzuka'))('stuck reset on a bridge deck', () => {
  test.each(['suzuka', 'suzuka-rev'])('%s: the reset car stays on the upper road', (layoutId) => {
    const track = getLayout(layoutId);
    const s0 = deckMiddle(track);
    expect(s0).toBeGreaterThan(0);
    const world = createWorld(config(layoutId), track);
    for (let t = 0; world.session.phase !== 'running' && t < 60; t += SIM_DT) stepWorld(world, track, [], SIM_DT);
    for (let k = 0; k < 360; k++) stepWorld(world, track, [], SIM_DT);

    const car = world.cars[world.cars.length - 1];
    const p = car.phys;
    const lat = sampleAt(track, track.racingLine, s0);
    const pose = poseAt(track, s0, lat);
    Object.assign(p, {
      x: pose.x, z: pose.z, y: pose.y, yaw: pose.yaw, vx: 0, vz: 0, speed: 0, vLong: 0, vLat: 0, yawRate: 0,
      s: s0, lateral: lat, trackIndex: Math.round(s0 / track.spacing),
    });
    car.race.lastS = s0;
    car.race.stuckTime = 7.05;
    car.race.stuckProgress = car.timing.progress;
    const progress0 = car.timing.progress;

    for (let k = 0; k < 240; k++) stepWorld(world, track, [], SIM_DT);
    expect(Math.abs(signedDeltaS(track, s0, p.s))).toBeLessThan(150);
    expect(Math.abs(p.y - pose.y)).toBeLessThan(3);
    expect(car.timing.progress).toBeGreaterThan(progress0 - 10);
  });
});
