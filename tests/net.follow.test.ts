/**
 * Followers (src/net/follow.ts): a fix carried along its arc, and what is drawn when a newer fix moves that arc.
 */
import { describe, expect, test } from 'bun:test';
import { SIM_DT } from '../src/core/defaults';
import { Follower, MAX_CARRY, carry, type Fix } from '../src/net/follow';

const fix = (o: Partial<Fix> = {}): Fix => ({ time: 10, x: 100, y: 5, z: -40, yaw: 0.4, speed: 60, course: 0.42, accel: 0, turn: 0, spin: 0, climb: 0, ...o });

/** The same motion taken in small steps: speed changing at `accel`, the course turning at `turn`. */
function stepped(f: Fix, t: number): { x: number; z: number; speed: number } {
  const n = 4000;
  const h = t / n;
  let x = f.x;
  let z = f.z;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) * h;
    const v = f.speed + f.accel * u;
    x += Math.sin(f.course + f.turn * u) * v * h;
    z += Math.cos(f.course + f.turn * u) * v * h;
  }
  return { x, z, speed: f.speed + f.accel * t };
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

describe('carrying a fix', () => {
  test('a turning, braking car is where its speed and course take it, pointing where its yaw rate turns it; so is one going back in time', () => {
    for (const f of [fix({ accel: -30, turn: 0.9, spin: 0.9 }), fix({ accel: 12, turn: -0.6, spin: 1.4 }), fix({ turn: 1e-6, accel: 8 }), fix({ turn: 2e-4, accel: -8, spin: -2 })]) {
      for (const t of [0.05, 0.2, 0.4, -0.1]) {
        const p = carry(f, t);
        const want = stepped(f, t);
        expect(dist(p, want)).toBeLessThan(1e-4);
        expect(p.speed).toBeCloseTo(want.speed, 9);
        expect(p.yaw).toBeCloseTo(f.yaw + f.spin * t, 9);
      }
    }
  });

  test('a car sliding to a halt stops turning on the spot once it is slow enough to grip', () => {
    // 1.2 rad off its course at 4 m/s, braking at 10 m/s² and spinning at 2 rad/s: it grips at 3 m/s, 0.1 s on
    const f = fix({ yaw: 0.42 - 1.2, speed: 4, accel: -10, spin: 2 });
    expect(carry(f, 0.05).yaw).toBeCloseTo(f.yaw + 0.1, 9);
    expect(carry(f, 0.3).yaw).toBeCloseTo(f.yaw + 0.2, 9);
    // one going where it points keeps turning as it slows (a car parking, the pit lane)
    expect(carry(fix({ speed: 4, accel: -10, spin: 0.5 }), 0.3).yaw).toBeCloseTo(0.4 + 0.15, 9);
  });

  test('a braking car stops where its speed runs out and stays there', () => {
    const f = fix({ speed: 6, accel: -30, turn: 0.5 });
    const stop = carry(f, 0.2);
    const later = carry(f, 0.5);
    expect(stop.speed).toBe(0);
    expect(dist(stop, f)).toBeCloseTo(0.6, 2);
    expect(later).toEqual(stop);
  });

  test('it climbs with the road', () => {
    expect(carry(fix({ climb: 0.1 }), 0.5).y).toBeCloseTo(5 + 0.1 * 30, 9);
  });
});

describe('a follower', () => {
  /** A follower shown for `seconds` of steps from `view`; the drawn places in order. */
  function run(f: Follower, view: number, seconds: number): { x: number; z: number; speed: number }[] {
    const drawn = [];
    for (let k = 1; k <= Math.round(seconds / SIM_DT); k++) {
      f.step(view + k * SIM_DT);
      drawn.push(f.drawn);
    }
    return drawn;
  }

  test('a newer fix off the old arc is faded in: no jump when it arrives, most of it shown half a second later', () => {
    const view = 10.15;
    const f = new Follower(fix(), view);
    const before = f.drawn;
    // the car braked and turned since: 0.45 m short and 0.2 m aside of where the old fix was heading
    const off = { x: -0.45 * Math.sin(0.42) + 0.2 * Math.cos(0.42), z: -0.45 * Math.cos(0.42) - 0.2 * Math.sin(0.42) };
    const was = carry(fix(), 0.1);
    f.take(fix({ time: 10.1, x: was.x + off.x, z: was.z + off.z, speed: 55, accel: -30 }), view);
    expect(dist(f.drawn, before)).toBeLessThan(1e-9);
    const left = dist(f.drawn, f.at);
    expect(left).toBeGreaterThan(0.45);
    // each 60 Hz frame is the car's own motion plus a share of what is left to correct: never more than 4 cm
    let last = { ...before, speed: f.at.speed };
    let worst = 0;
    run(f, view, 0.5).forEach((p, i) => {
      if (i % 2 === 0) return;
      worst = Math.max(worst, Math.abs(dist(p, last) - ((p.speed + last.speed) / 2) * 2 * SIM_DT));
      last = p;
    });
    expect(worst).toBeLessThan(0.04);
    expect(dist(f.drawn, f.at)).toBeLessThan(left / 4);
  });

  test('a car the host put somewhere else is shown there at once; so is everything when the view time is set', () => {
    const view = 10.15;
    const f = new Follower(fix(), view);
    const was = carry(fix(), 0.1);
    f.take(fix({ time: 10.1, x: was.x + 20, z: was.z }), view);
    expect(dist(f.drawn, f.at)).toBe(0);
    // a correction on its way in, then the view time set: nothing left of it
    f.take(fix({ time: 10.2, x: was.x + 20.5, z: was.z + 6 }), view);
    expect(dist(f.drawn, f.at)).toBeGreaterThan(0.3);
    f.jump(view + 0.3);
    expect(dist(f.drawn, f.at)).toBe(0);
  });

  test('a fix no newer than the one held is dropped', () => {
    const f = new Follower(fix(), 10.1);
    const at = f.at;
    f.take(fix({ x: 0, z: 0 }), 10.1);
    f.take(fix({ time: 9.9, x: 0, z: 0 }), 10.1);
    expect(f.at).toEqual(at);
  });

  test('it goes on from where something else was drawn in its place', () => {
    const f = new Follower(fix(), 10.1);
    const drawn = { x: f.at.x + 1.2, y: f.at.y, z: f.at.z - 0.5 };
    f.resume(drawn);
    expect(dist(f.drawn, drawn)).toBeLessThan(1e-9);
    run(f, 10.1, 2);
    expect(dist(f.drawn, f.at)).toBeLessThan(0.01);
    expect(f.at.speed).toBe(60);
  });

  test('a host silent for longer than MAX_CARRY leaves its cars standing where the last fix was heading', () => {
    const f = new Follower(fix(), 10);
    f.step(10 + MAX_CARRY + 1);
    expect(dist(f.at, carry(fix(), MAX_CARRY))).toBeLessThan(1e-9);
  });
});
