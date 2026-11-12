/**
 * Where the guest draws the other cars against where the host has them at the frame's time, in the moments the
 * smoothness gates (net.jitter.test.ts) do not score: a spin, grades, a wall hit, a link outage. The scenarios are the
 * pose probe's (tools/bench/net/pose.ts): host and one guest on the target link, frames at 60 fps.
 */
import { describe, expect, test } from 'bun:test';
import { height, outage, spin, wall } from '../tools/bench/net/pose';

describe('the other cars as the guest draws them', () => {
  test(
    "a spinning car's nose turns with the host's, and a slow car barely turning is drawn barely turning",
    () => {
      // five random-crash spins on one link and one on another. 9c3e7ea, which drew no yaw rate: 0.29–0.41 rad off
      // while spinning (0.35 over the six), up to 0.17 slow; e48caa8, whose yaw turned with the path: 0.74–1.06 rad off
      // while spinning, 1.46 rad slow. With the tow at 0.22 the races run differently: 9c3e7ea then draws 0.29–0.41 (0.35
      // over the six, 0.41 on the spin at 37 s, this model 0.40 there and 0.21 over the six), so one spin is gated at
      // 9c3e7ea's worst and the six at well under its mean
      const spinning: number[] = [];
      for (const [seed, at] of [[9, 20], [9, 26], [9, 31], [9, 37], [9, 44], [11, 26]] as const) {
        const r = spin(seed, at);
        spinning.push(r.spinYawMean);
        expect(r.spinYawMean).toBeLessThan(0.41);
        expect(r.slowYawMax).toBeLessThan(0.2);
      }
      expect(spinning.reduce((a, b) => a + b, 0) / spinning.length).toBeLessThan(0.25);
    },
    60_000,
  );

  test(
    'the other cars sit on the road on grades: their height no further off than 9c3e7ea drew it, but for the largest single error on wet Spa (a known gap)',
    () => {
      // 9c3e7ea's |Δy| p99 and max on each run (e48caa8, which carried the height along the grade: Spa p99 0.34 m,
      // max 0.45 m, up to 0.43 m above or below the road). Suzuka's p99 is 9c3e7ea's spread over link seeds 9-11
      // (0.018-0.022; this model 0.020-0.021): a car's height is the road's under its drawn place, so what is left is
      // that place's error along the grade. Spa in heavy rain likewise since the tow is 0.22: 9c3e7ea over link seeds
      // 9-12 p99 0.017-0.019, max 0.057-0.063; this model 0.015-0.020, max 0.028-0.120 (seed 10, the one run here, is
      // its worst). That max is a known gap, not a reference: on this seed this model's largest single error is twice
      // 9c3e7ea's, and the gate only keeps it from growing
      const runs: [string, number, number, string, number, number][] = [
        ['spa', 9, 70, 'clear', 0.045, 0.146],
        ['monza', 9, 50, 'clear', 0.013, 0.021],
        ['suzuka', 9, 70, 'clear', 0.022, 0.052],
        ['spa', 10, 70, 'heavyRain', 0.02, 0.125],
      ];
      for (const [layout, seed, secs, weather, p99, most] of runs) {
        const r = height(layout, seed, secs, weather);
        expect(r.floatMax).toBeLessThan(0.01);
        expect(r.dyP99).toBeLessThanOrEqual(p99);
        expect(r.dyMax).toBeLessThanOrEqual(most);
      }
    },
    60_000,
  );

  test(
    'a car turned into the wall: never drawn past the barrier, no frame jumps, no further off the road than 9c3e7ea',
    () => {
      // 9c3e7ea: 4 frames more than 1 m further off the road than the host, one 3.84 m jump and 8 frames over 0.5 m;
      // e48caa8: 30 frames, no jump
      const r = wall(9, 20, 1.2);
      expect(r.pastBarrier).toBe(0);
      expect(r.jumpsOver50cm).toBe(0);
      expect(r.offRoad).toBeLessThanOrEqual(4);
      // a spun car pushed along a narrowing barrier (9c3e7ea 2.57 m off, e48caa8 4.08 m)
      expect(spin(9, 20).placeMax).toBeLessThan(2.6);
    },
    60_000,
  );

  test(
    'after a link outage longer than a fix is carried, every car is put where the host has it once, none slides back',
    () => {
      // e48caa8: every car slides back over a second (up to 2.2 m a frame), at 1.6 s one is put and ten slide.
      // 9c3e7ea: at 1.0 s every car slides (44 frames over 0.5 m), at 1.6 and 1.9 s each is put once (10, 11)
      for (const ms of [1000, 1600, 1900]) {
        const r = outage(ms, 9);
        expect(r.carsSlid).toBe(0);
        expect(r.over50cm).toBeLessThanOrEqual(11);
      }
    },
    60_000,
  );
});
