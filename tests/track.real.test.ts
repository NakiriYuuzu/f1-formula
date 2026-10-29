/**
 * Real-circuit support of the track engine: the validator (validateTrackDef) and its rules, steep / tight / close /
 * large layouts, and grade separation (figure-8 crossover: deck flags, roadside, terrain, projection, contact).
 * Real circuit defs in TRACK_DEFS are validated here too; the synthetic fixtures cover the code paths until then.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { BuiltTrack, TrackControlPoint, TrackDef } from '../src/core/types';
import { TRACK_DEFS, getLayout } from '../src/data/tracks';
import { buildQuickStart } from '../src/meta/sessionBuilder';
import { carContacts } from '../src/race/contact';
import { createWorld } from '../src/race/index';
import {
  DECK_MARGIN,
  GRADE_CLEARANCE,
  buildTrack,
  heightAt,
  isGradeSeparated,
  isOnDeck,
  poseAt,
  projectToTrack,
  sameLevel,
  signedDeltaS,
  validateTrackDef,
} from '../src/track/track';
import { figureEightDef, longDef, pinchDef, streetDef } from './trackFixtures';
import { useFictionalRoster } from './rosterFixture';

const fig8 = figureEightDef();
const street = streetDef();
const pinch = pinchDef();
const long = longDef();
const fixtures = [fig8, street, pinch, long];

const maxGrade = (t: BuiltTrack, over = 10): number => {
  const k = Math.ceil(over / t.spacing);
  let g = 0;
  for (let i = 0; i < t.count; i++) g = Math.max(g, Math.abs(t.py[(i + k) % t.count] - t.py[i]) / (k * t.spacing));
  return g;
};

/** Stadium with end radius r (m): straights 300 m, width w; `bump` = height (m) of a 28 m wide hump at x = 150. */
function stadium(r: number, w: number, bump = 0): TrackDef {
  const pts: TrackControlPoint[] = [];
  for (let x = 0; x <= 300; x += bump ? 10 : 50) pts.push({ x, z: 0, y: bump * Math.exp(-(((x - 150) / 14) ** 2)) });
  for (let a = 15; a < 180; a += 15) pts.push({ x: 300 + r * Math.sin((a * Math.PI) / 180), z: r - r * Math.cos((a * Math.PI) / 180) });
  for (let x = 300; x >= 0; x -= 50) pts.push({ x, z: 2 * r });
  for (let a = 15; a < 180; a += 15) pts.push({ x: -r * Math.sin((a * Math.PI) / 180), z: r + r * Math.cos((a * Math.PI) / 180) });
  return { ...street, id: 'bad-stadium', width: w, points: pts.map((p) => ({ ...p, y: p.y ?? 0, width: w })), real: { ...street.real!, length: 1 } };
}

// written against the fictional field (data/teams.ts); the game's default is the 2026 F1 grid
beforeEach(useFictionalRoster);

describe('validator: fixtures and registered real circuits', () => {
  test.each(fixtures.map((d) => [d.id, d] as const))('%s has no problems (both directions)', (_id, def) => {
    expect(validateTrackDef(def)).toEqual([]);
  });

  test('real circuits in TRACK_DEFS pass the validator (none registered yet is fine)', () => {
    for (const def of TRACK_DEFS.filter((d) => d.real)) expect(validateTrackDef(def)).toEqual([]);
  });

  test('original circuits satisfy the real rules too (apart from the missing def.real note)', () => {
    for (const def of TRACK_DEFS.filter((d) => !d.real)) {
      const problems = validateTrackDef(def).filter((p) => !p.includes('def.real is missing'));
      expect(problems).toEqual([]);
    }
  });

  test('every rule can fail', () => {
    const has = (def: TrackDef, rule: string): boolean => validateTrackDef(def).some((p) => p.includes(`: ${rule}:`));
    expect(has({ ...fig8, real: { ...fig8.real!, length: fig8.real!.length * 1.05 } }, 'length')).toBe(true);
    expect(has({ ...pinch, width: 18, points: pinch.points.map((p) => ({ ...p, width: 18 })) }, 'width')).toBe(true);
    expect(has({ ...long, drsZones: [{ detection: 0.1, activation: 0.15, end: 0.9 }] }, 'drs')).toBe(true);
    expect(has({ ...long, drsZones: [] }, 'drs')).toBe(true);
    expect(has({ ...long, sectors: [0.05, 0.1] }, 'sectors')).toBe(true);
    expect(has({ ...street, pit: { ...street.pit, entry: 0.97, exit: 0.03 } }, 'pit')).toBe(true);
    expect(has({ ...long, pit: { ...long.pit, box: 0.04 } }, 'pit')).toBe(true);
    expect(has(stadium(6, 10), 'radius')).toBe(true);
    expect(has({ ...fig8, points: fig8.points.map((p) => ({ ...p, y: 0 })) }, 'close sections')).toBe(true);
    const steep = { ...long, points: long.points.map((p) => ({ ...p, y: (p.y ?? 0) * 2.5 })) };
    expect(has(steep, 'grade')).toBe(true);
    expect(validateTrackDef({ ...fig8, points: fig8.points.slice(0, 3) }).some((p) => p.includes('buildTrack failed'))).toBe(true);
    // a def without `real` is still checked (and noted)
    expect(validateTrackDef({ ...pinch, real: undefined })).toEqual([`${pinch.id}: def.real is missing (length rule skipped)`]);
  });
});

describe('steep, tight, close and large layouts', () => {
  const builtLong = buildTrack(long);
  const builtStreet = buildTrack(street);
  const builtPinch = buildTrack(pinch);

  test('steep real profiles survive the height smoothing (original circuits keep the heavy smoothing)', () => {
    expect(maxGrade(builtLong)).toBeGreaterThan(0.15);
    expect(maxGrade(builtLong)).toBeLessThanOrEqual(0.2);
    // a short 3 m hump (peak grade ≈ 18 %): kept on a real circuit, flattened to ≤ half on an original one
    const hump = stadium(150, 12, 3);
    expect(maxGrade(buildTrack(hump))).toBeGreaterThan(0.12);
    expect(maxGrade(buildTrack({ ...hump, real: undefined }))).toBeLessThan(0.07);
    expect(maxGrade(builtStreet)).toBeGreaterThan(0.12);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < builtLong.count; i++) {
      lo = Math.min(lo, builtLong.py[i]);
      hi = Math.max(hi, builtLong.py[i]);
    }
    expect(hi - lo).toBeGreaterThan(95);
    // smooth: the grade changes by < 1.5 % per 2 m sample
    for (let i = 0; i < builtLong.count; i++) {
      const g0 = builtLong.py[(i + 1) % builtLong.count] - builtLong.py[i];
      const g1 = builtLong.py[(i + 2) % builtLong.count] - builtLong.py[(i + 1) % builtLong.count];
      expect(Math.abs(g1 - g0) / builtLong.spacing).toBeLessThan(0.015);
    }
  });

  test('terrain beside a steep road stays close to the road (no cliff at the edge or the barrier)', () => {
    for (const t of [builtLong, builtStreet]) {
      for (let i = 0; i < t.count; i += 7) {
        for (const side of [-1, 1] as const) {
          const runoff = side === 1 ? t.runoffRight[i] : t.runoffLeft[i];
          const edge = poseAt(t, t.s[i], side * t.halfWidth[i]);
          const wall = poseAt(t, t.s[i], side * (t.halfWidth[i] + runoff));
          expect(Math.abs(heightAt(t, edge.x, edge.z) - t.py[i])).toBeLessThan(1.5);
          expect(Math.abs(heightAt(t, wall.x, wall.z) - t.py[i])).toBeLessThan(5);
        }
      }
    }
  });

  test('R = 10 m hairpin: stable curvature, racing line, speed profile and corner', () => {
    let maxK = 0;
    let at = 0;
    for (let i = 0; i < builtStreet.count; i++) {
      if (Math.abs(builtStreet.curvature[i]) > maxK) {
        maxK = Math.abs(builtStreet.curvature[i]);
        at = i;
      }
    }
    expect(1 / maxK).toBeGreaterThan(9);
    expect(1 / maxK).toBeLessThan(11);
    expect(builtStreet.speedProfile[at]).toBeLessThan(16);
    expect(builtStreet.speedProfile[at]).toBeGreaterThan(5);
    expect(builtStreet.corners.some((c) => Math.abs(c.apexS - at * builtStreet.spacing) < 20 && c.minSpeed < 16)).toBe(true);
    // racing line keeps its 1.3 m margin and uses the inside of the hairpin
    expect(Math.abs(builtStreet.racingLine[at])).toBeLessThanOrEqual(builtStreet.halfWidth[at] - 1.3 + 1e-9);
    // the inner barrier never passes the centre of curvature
    for (let i = 0; i < builtStreet.count; i++) {
      const k = builtStreet.curvature[i];
      const inside = k > 0 ? builtStreet.runoffRight[i] : builtStreet.runoffLeft[i];
      if (Math.abs(k) > 1e-6) expect(builtStreet.halfWidth[i] + inside).toBeLessThan(1 / Math.abs(k));
    }
  });

  test('two sections 3.5 m apart edge to edge: barrier midway, kerbs shrink, nothing intrudes', () => {
    const t = builtPinch;
    let minGap = Infinity;
    let tight = 0;
    for (let i = 0; i < t.count; i++) {
      for (let j = i + 1; j < t.count; j++) {
        if (Math.abs(j - i) * t.spacing < 400 || (t.count - (j - i)) * t.spacing < 400) continue;
        const d = Math.hypot(t.px[i] - t.px[j], t.pz[i] - t.pz[j]);
        if (d > 25) continue;
        const gap = d - t.halfWidth[i] - t.halfWidth[j];
        minGap = Math.min(minGap, gap);
        if (gap < 6) {
          tight++;
          // each barrier sits inside the gap (never on the other road) and is at least a 1.5 m street wall
          for (const k of [i, j]) {
            const side = ((t.px[k === i ? j : i] - t.px[k]) * t.rx[k] + (t.pz[k === i ? j : i] - t.pz[k]) * t.rz[k]) > 0 ? 1 : -1;
            const runoff = side === 1 ? t.runoffRight[k] : t.runoffLeft[k];
            const kerb = side === 1 ? t.kerbRight[k] : t.kerbLeft[k];
            expect(runoff).toBeLessThanOrEqual(gap - 0.5);
            expect(runoff).toBeGreaterThanOrEqual(1.5 - 1e-9);
            expect(kerb).toBeLessThanOrEqual(runoff - 0.5 + 1e-9);
          }
        }
      }
    }
    expect(minGap).toBeGreaterThan(3.4);
    expect(minGap).toBeLessThan(3.7);
    expect(tight).toBeGreaterThan(10);
  });

  test('pit lane on the curved (R = 400 m) street straight keeps offset, ramps and clearance', () => {
    const t = builtStreet;
    expect(t.pit.laneLength).toBeGreaterThan(0.9 * (t.pit.exit + t.length - t.pit.entry));
    const lane = poseAt(t, t.pit.box, t.pit.laneOffset);
    expect(projectToTrack(t, lane.x, lane.z).surface).toBe('pitlane');
    expect(projectToTrack(t, lane.x, lane.z).lateral).toBeCloseTo(t.pit.laneOffset, 6);
  });

  test('7.8 km, 2.6 km wide layout: grids, projection and caches cope; DRS straight 2.2 km', () => {
    const t = builtLong;
    expect(t.length).toBeGreaterThan(7000);
    expect(t.bounds.maxX - t.bounds.minX).toBeGreaterThan(2400);
    const z = t.drsZones[0];
    const len = (z.end - z.activation + t.length) % t.length;
    expect(len).toBeGreaterThan(2000);
    expect(len).toBeLessThanOrEqual(2300);
    for (const [x, zz] of [[-1e5, 1e5], [t.bounds.minX - 500, t.bounds.minZ - 500], [t.bounds.maxX + 3000, 0], [0, 0]]) {
      const p = projectToTrack(t, x, zz);
      expect(Number.isFinite(p.s) && Number.isFinite(p.lateral)).toBe(true);
      expect(Number.isFinite(heightAt(t, x, zz))).toBe(true);
    }
  });

  test('builds are deterministic and reasonably fast (7.8 km layout)', () => {
    const t0 = performance.now();
    const a = buildTrack(long);
    const ms = performance.now() - t0;
    const b = buildTrack(long);
    expect(Array.from(a.racingLine)).toEqual(Array.from(b.racingLine));
    expect(Array.from(a.runoffLeft)).toEqual(Array.from(b.runoffLeft));
    expect(Array.from(a.deck)).toEqual(Array.from(b.deck));
    expect(ms).toBeLessThan(2000);
  });
});

describe.each([false, true])('grade separation (figure-8 crossover, reverse = %p)', (reverse) => {
  const t = buildTrack(fig8, { reverse });
  // the crossing: the deck sample closest in XZ to a non-adjacent sample, and that sample (the lower road)
  let upper = -1;
  let lower = -1;
  let bestD = Infinity;
  for (let i = 0; i < t.count; i++) {
    if (!t.deck[i]) continue;
    for (let j = 0; j < t.count; j++) {
      const ds = Math.abs(j - i) * t.spacing;
      if (Math.min(ds, t.length - ds) < 100) continue;
      const d = Math.hypot(t.px[i] - t.px[j], t.pz[i] - t.pz[j]);
      if (d < bestD) {
        bestD = d;
        upper = i;
        lower = j;
      }
    }
  }
  const crossing = { x: t.px[upper], z: t.pz[upper] };

  test('the upper road is flagged as deck (with margin), the lower road is not', () => {
    expect(upper).toBeGreaterThanOrEqual(0);
    expect(bestD).toBeLessThan(2);
    expect(t.py[upper] - t.py[lower]).toBeGreaterThanOrEqual(GRADE_CLEARANCE);
    expect(t.deck[lower]).toBe(0);
    let run = 0;
    let count = 0;
    for (let i = 0; i < t.count; i++) if (t.deck[i]) count++;
    // one contiguous run: overlap (≈ 2 × 15 m) + 2 × DECK_MARGIN, nothing else flagged
    for (let k = 0; t.deck[(upper + k) % t.count]; k++) run++;
    for (let k = 1; t.deck[(upper - k + t.count) % t.count]; k++) run++;
    expect(run).toBe(count);
    expect(count * t.spacing).toBeGreaterThan(2 * DECK_MARGIN);
    expect(count * t.spacing).toBeLessThan(2 * DECK_MARGIN + 80);
    expect(isOnDeck(t, t.s[upper])).toBe(true);
    expect(isOnDeck(t, t.s[lower])).toBe(false);
  });

  test('roadside: parapets on the deck, the crossing is exempt from clamping, normal walls elsewhere', () => {
    for (let i = 0; i < t.count; i++) {
      if (t.deck[i]) {
        expect(t.runoffLeft[i]).toBeLessThanOrEqual(3 + 1e-9);
        expect(t.runoffRight[i]).toBeLessThanOrEqual(3 + 1e-9);
        expect(t.runoffSurfaceLeft[i]).toBe(2);
      }
    }
    // far from the crossing the open-circuit run-off is untouched
    const far = (upper + Math.round(t.count / 4)) % t.count;
    expect(t.runoffLeft[far] + t.runoffRight[far]).toBeGreaterThan(20);
    // the lower road at the crossing keeps at least a street-like wall (it is not squeezed to nothing by the deck)
    expect(t.runoffLeft[lower]).toBeGreaterThanOrEqual(1.5);
    expect(t.runoffRight[lower]).toBeGreaterThanOrEqual(1.5);
    expect(isGradeSeparated(t.py[upper] - t.py[lower], 0, t.halfWidth[upper] + t.halfWidth[lower])).toBe(true);
    expect(validateTrackDef(fig8)).toEqual([]);
    // the same plan on one level would be an illegal crossing
    const flat = { ...fig8, points: fig8.points.map((p) => ({ ...p, y: 0 })) };
    expect(validateTrackDef(flat).length).toBeGreaterThan(0);
  });

  test('terrain follows the lower road under the deck; the upper approaches blend normally', () => {
    expect(Math.abs(heightAt(t, crossing.x, crossing.z) - t.py[lower])).toBeLessThan(1);
    expect(heightAt(t, crossing.x, crossing.z)).toBeLessThan(t.py[upper] - GRADE_CLEARANCE + 1);
    // 90 m beyond the deck on the upper road
    for (const dir of [-1, 1]) {
      let k = upper;
      while (t.deck[k]) k = (k + dir + t.count) % t.count;
      for (let m = 0; m < Math.round(90 / t.spacing); m++) k = (k + dir + t.count) % t.count;
      expect(Math.abs(heightAt(t, t.px[k], t.pz[k]) - t.py[k])).toBeLessThan(0.5);
    }
  });

  test('projection: hinted stays local, global resolves the level (y) or the lower road, stale hints re-search', () => {
    const sUp = t.s[upper];
    const sLow = t.s[lower];
    const up = poseAt(t, sUp, 0);
    const low = poseAt(t, sLow, 0);
    const near = (a: number, b: number): boolean => Math.abs(signedDeltaS(t, a, b)) < 0.2;
    // the two road points differ by < 12 m in XZ; use each pose's own XZ
    expect(near(projectToTrack(t, up.x, up.z, upper).s, sUp)).toBe(true);
    expect(near(projectToTrack(t, low.x, low.z, lower).s, sLow)).toBe(true);
    // no hint, no y: the lower road wins at the crossing
    const centre = projectToTrack(t, up.x, up.z);
    expect(centre.height).toBeLessThan(t.py[upper] - GRADE_CLEARANCE + 1);
    // y picks the level
    expect(near(projectToTrack(t, up.x, up.z, undefined, up.y).s, sUp)).toBe(true);
    expect(near(projectToTrack(t, low.x, low.z, undefined, low.y).s, sLow)).toBe(true);
    // stale hint on the other level: re-searched with y
    expect(near(projectToTrack(t, low.x, low.z, upper, low.y).s, sLow)).toBe(true);
    expect(near(projectToTrack(t, up.x, up.z, lower, up.y).s, sUp)).toBe(true);
    // every deck sample round-trips with its own height, every other sample without it
    for (let i = 0; i < t.count; i++) {
      if (!t.deck[i] && i % 9 !== 0) continue;
      const p = poseAt(t, t.s[i], 2);
      const proj = projectToTrack(t, p.x, p.z, undefined, t.deck[i] ? p.y : undefined);
      expect(Math.abs(signedDeltaS(t, t.s[i], proj.s))).toBeLessThan(0.05);
    }
  });

  test('levels: cars on different levels are not in contact range of each other', () => {
    expect(sameLevel(t, t.s[upper], t.s[lower])).toBe(false);
    expect(sameLevel(t, t.s[upper], t.s[upper] + 3)).toBe(true);
    expect(sameLevel(t, t.s[lower], t.s[lower] - 3)).toBe(true);
    expect(sameLevel(t, 0, t.length - 1)).toBe(true);
  });

  test('car-to-car contact skips pairs on different levels and still works on the same level', () => {
    const { config } = buildQuickStart({ kind: 'race', layoutId: 'isola-verde', laps: 2, seed: 3 });
    const world = createWorld(config, t);
    world.config.rules.collisions = true;
    const [a, b, ...rest] = world.cars;
    rest.forEach((c, k) => {
      c.phys.x = 1e6 + k * 100;
      c.phys.z = 1e6;
    });
    const place = (car: typeof a, s: number, lat: number): void => {
      const p = poseAt(t, s, lat);
      car.phys.x = p.x;
      car.phys.z = p.z;
      car.phys.yaw = p.yaw;
      car.phys.vx = 0;
      car.phys.vz = 0;
      car.phys.s = s;
      car.phys.trackIndex = Math.round(s / t.spacing) % t.count;
    };
    // different levels, identical XZ: no contact
    place(a, t.s[upper], 0);
    place(b, t.s[lower], 0);
    a.phys.x = b.phys.x = crossing.x;
    a.phys.z = b.phys.z = crossing.z;
    const ax = a.phys.x;
    const bz = b.phys.z;
    carContacts(world, t);
    expect(a.phys.x).toBe(ax);
    expect(b.phys.z).toBe(bz);
    expect(a.phys.impact).toBe(0);
    // same level, overlapping: they push each other apart
    place(a, 3000 % t.length, 0);
    place(b, 3000 % t.length, 0.5);
    b.phys.x = a.phys.x + 0.5;
    b.phys.z = a.phys.z;
    const gap0 = Math.hypot(b.phys.x - a.phys.x, b.phys.z - a.phys.z);
    carContacts(world, t);
    expect(Math.hypot(b.phys.x - a.phys.x, b.phys.z - a.phys.z)).toBeGreaterThan(gap0);
  });
});

describe('track registry still builds', () => {
  test('layouts expose a deck array (all zero on the original circuits)', () => {
    const t = getLayout('isola-verde');
    expect(t.deck.length).toBe(t.count);
    expect(t.deck.every((v) => v === 0)).toBe(true);
  });
});
