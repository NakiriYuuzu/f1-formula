/**
 * Track acceptance tests (SPEC 6.1 / 4.1): geometry, clearance, barriers, projection, reference lap, racing line,
 * curvature sign, DRS / sector / pit metadata in both directions, outlines. The 5 original circuits (10 layouts) keep
 * their strict rules; layouts whose def has `real` (real circuits, plus the synthetic fixtures in trackFixtures.ts
 * that stand in for them until real data exists) use the real-world rules of src/track/validate.ts.
 */
import { describe, expect, test } from 'bun:test';
import type { BuiltTrack, TrackDef } from '../src/core/types';
import { REFERENCE_CAR } from '../src/core/defaults';
import { angleDiff, nextRandom } from '../src/core/math';
import {
  LAYOUTS,
  TRACK_DEFS,
  getLayout,
  getLayoutInfo,
  getLayoutOutline,
  getTrackDef,
  hasLayout,
  worldToOutline,
} from '../src/data/tracks';
import { figureEightDef, longDef, pinchDef, streetDef } from './trackFixtures';
import {
  MAX_PIT_CURVATURE,
  MIN_PIT_ZONE,
  PIT_BOX_ROW_HALF,
  PIT_LANE_EXTRA,
  PIT_STREET,
  RACING_LINE_MARGIN,
  barrierLimits,
  buildTrack,
  checkBuiltTrack,
  forwardDistance,
  heightAt,
  inRangeS,
  indexAtS,
  isCrossingPair,
  isInPitStraight,
  isInPitZone,
  pitExtrasOf,
  pitLaneOffsetAt,
  pitLaneWallDistance,
  pitRampLength,
  poseAt,
  projectToTrack,
  sampleAt,
  signedDeltaS,
  wrapS,
} from '../src/track/track';

const LENGTH_RANGE: Record<string, [number, number]> = {
  'porto-lumen': [4400, 4800],
  'mirage-sands': [5200, 5500],
  'highland-ridge': [5500, 5900],
  'koyo-hills': [4900, 5200],
  'isola-verde': [4300, 4600],
};
const HILLY = new Set(['highland-ridge', 'koyo-hills']);

const tracks: BuiltTrack[] = LAYOUTS.map((l) => getLayout(l.id));
/** Synthetic real-style layouts (both directions), standing in for real circuits until their data exists. */
const FIXTURE_DEFS: TrackDef[] = [figureEightDef(), streetDef(), pinchDef(), longDef()];
const fixtureTracks: BuiltTrack[] = FIXTURE_DEFS.flatMap((d) => [buildTrack(d), buildTrack(d, { reverse: true })]);
const layoutById = (id: string): BuiltTrack => fixtureTracks.find((t) => t.id === id) ?? getLayout(id);
const ORIGINAL_DEFS = TRACK_DEFS.filter((d) => !d.real);

const loopDist = (t: BuiltTrack, i: number, j: number): number => {
  const d = Math.abs(i - j) * t.spacing;
  return Math.min(d, t.length - d);
};
const yawAt = (t: BuiltTrack, i: number): number => Math.atan2(t.tx[i], t.tz[i]);
const sideArr = (t: BuiltTrack, side: 1 | -1) => ({
  kerb: side === 1 ? t.kerbRight : t.kerbLeft,
  runoff: side === 1 ? t.runoffRight : t.runoffLeft,
});

/** Simple uniform grid over centre-line samples for neighbourhood queries in tests. */
function sampleGrid(t: BuiltTrack, cell: number) {
  const map = new Map<string, number[]>();
  const key = (cx: number, cz: number) => `${cx},${cz}`;
  for (let i = 0; i < t.count; i++) {
    const k = key(Math.floor(t.px[i] / cell), Math.floor(t.pz[i] / cell));
    const list = map.get(k);
    if (list) list.push(i);
    else map.set(k, [i]);
  }
  return (x: number, z: number, r: number, visit: (j: number) => void) => {
    const x0 = Math.floor((x - r) / cell);
    const x1 = Math.floor((x + r) / cell);
    const z0 = Math.floor((z - r) / cell);
    const z1 = Math.floor((z + r) / cell);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) map.get(key(cx, cz))?.forEach(visit);
  };
}

describe('registry', () => {
  test('5 original defs, 2 unique layouts per def, lookups', () => {
    expect(ORIGINAL_DEFS.length).toBe(5);
    expect(LAYOUTS.length).toBe(2 * TRACK_DEFS.length);
    expect(new Set(LAYOUTS.map((l) => l.id)).size).toBe(2 * TRACK_DEFS.length);
    for (const def of TRACK_DEFS) {
      expect(getTrackDef(def.id)).toBe(def);
      const fwd = getLayoutInfo(def.id);
      const rev = getLayoutInfo(`${def.id}-rev`);
      expect(fwd.reverse).toBe(false);
      expect(rev.reverse).toBe(true);
      expect(fwd.displayName).toBe(def.name);
      expect(rev.displayName).toBe(`${def.name}（反向）`);
      expect(def.width).toBeGreaterThanOrEqual(def.real ? 10 : 12);
      expect(def.width).toBeLessThanOrEqual(16);
      expect(def.drsZones.length).toBeGreaterThanOrEqual(def.real ? 1 : 2);
      expect(def.drsZones.length).toBeLessThanOrEqual(def.real ? 4 : 3);
    }
    expect(hasLayout('porto-lumen-rev')).toBe(true);
    expect(hasLayout('nowhere')).toBe(false);
    expect(() => getLayout('nowhere')).toThrow();
    expect(() => getLayoutInfo('nowhere')).toThrow();
    expect(getLayout('koyo-hills')).toBe(getLayout('koyo-hills'));
  });

  test('built layout fields match registry', () => {
    for (const l of LAYOUTS) {
      const t = getLayout(l.id);
      expect(t.id).toBe(l.id);
      expect(t.reverse).toBe(l.reverse);
      expect(t.displayName).toBe(l.displayName);
      expect(t.def.id).toBe(l.defId);
    }
  });
});

describe.each([...tracks, ...fixtureTracks].map((t) => [t.id, t] as const))('layout %s', (_id, t) => {
  const real = t.def.real !== undefined;
  test('length bounds, sampling and arrays', () => {
    if (t.def.real) {
      expect(Math.abs(t.length - t.def.real.length)).toBeLessThanOrEqual(0.02 * t.def.real.length);
    } else {
      const [lo, hi] = LENGTH_RANGE[t.def.id];
      expect(t.length).toBeGreaterThanOrEqual(Math.max(4200, lo));
      expect(t.length).toBeLessThanOrEqual(Math.min(6200, hi));
    }
    expect(t.spacing).toBeGreaterThan(1.9);
    expect(t.spacing).toBeLessThan(2.1);
    expect(t.count * t.spacing).toBeCloseTo(t.length, 6);
    const arrays = [
      t.px, t.py, t.pz, t.tx, t.tz, t.rx, t.rz, t.s, t.curvature, t.halfWidth, t.kerbLeft, t.kerbRight,
      t.runoffLeft, t.runoffRight, t.runoffSurfaceLeft, t.runoffSurfaceRight, t.racingLine, t.speedProfile, t.deck,
    ];
    for (const a of arrays) {
      expect(a.length).toBe(t.count);
      for (let i = 0; i < t.count; i++) expect(Number.isFinite(a[i])).toBe(true);
    }
    for (let i = 0; i < t.count; i++) {
      const j = (i + 1) % t.count;
      const d = Math.hypot(t.px[j] - t.px[i], t.pz[j] - t.pz[i]);
      expect(Math.abs(d - t.spacing)).toBeLessThan(0.02 * t.spacing);
      expect(t.s[i]).toBeCloseTo(i * t.spacing, 6);
      expect(Math.hypot(t.tx[i], t.tz[i])).toBeCloseTo(1, 9);
      expect(t.rx[i]).toBeCloseTo(-t.tz[i], 12);
      expect(t.rz[i]).toBeCloseTo(t.tx[i], 12);
      if (real) expect(2 * t.halfWidth[i]).toBeGreaterThanOrEqual(10 - 1e-9);
      if (real) expect(2 * t.halfWidth[i]).toBeLessThanOrEqual(16 + 1e-9);
      else expect(t.halfWidth[i]).toBeCloseTo(t.def.width / 2, 6);
      expect(t.deck[i] === 0 || t.deck[i] === 1).toBe(true);
      expect(t.runoffSurfaceLeft[i]).toBeLessThanOrEqual(2);
      expect(t.runoffSurfaceRight[i]).toBeLessThanOrEqual(2);
    }
    // s = 0 is points[0] in both directions
    expect(t.px[0]).toBeCloseTo(t.def.points[0].x, 6);
    expect(t.pz[0]).toBeCloseTo(t.def.points[0].z, 6);
  });

  test.if(real)('real: min radius ≥ 9 m, grades ≤ 20 % over ≥ 10 m, edges never fold', () => {
    const k = Math.ceil(10 / t.spacing);
    let maxK = 0;
    for (let i = 0; i < t.count; i++) {
      maxK = Math.max(maxK, Math.abs(t.curvature[i]));
      expect(Math.abs(t.py[(i + k) % t.count] - t.py[i]) / (k * t.spacing)).toBeLessThanOrEqual(0.2);
      expect(t.halfWidth[i]).toBeLessThanOrEqual(0.9 / Math.max(1e-9, Math.abs(t.curvature[i])));
    }
    expect(maxK).toBeLessThanOrEqual(1 / 9);
  });

  test.if(!real)('min corner radius ≥ 15 m, grades ≤ 5 %, elevation range', () => {
    let maxK = 0;
    let sum = 0;
    for (let i = 0; i < t.count; i++) {
      maxK = Math.max(maxK, Math.abs(t.curvature[i]));
      const j = (i + 1) % t.count;
      expect(Math.abs(t.py[j] - t.py[i]) / t.spacing).toBeLessThanOrEqual(0.05);
      sum += t.py[i];
    }
    expect(maxK).toBeLessThanOrEqual(1 / 15);
    const mean = sum / t.count;
    const limit = HILLY.has(t.def.id) ? 10 : 2;
    for (let i = 0; i < t.count; i++) expect(Math.abs(t.py[i] - mean)).toBeLessThanOrEqual(limit);
    if (HILLY.has(t.def.id)) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < t.count; i++) {
        lo = Math.min(lo, t.py[i]);
        hi = Math.max(hi, t.py[i]);
      }
      expect(hi - lo).toBeGreaterThan(8);
    }
  });

  test.if(real)('real: non-adjacent sections ≥ 3 m apart edge to edge unless grade-separated', () => {
    const near = sampleGrid(t, 40);
    for (let i = 0; i < t.count; i++) {
      near(t.px[i], t.pz[i], 60, (j) => {
        const d = Math.hypot(t.px[i] - t.px[j], t.pz[i] - t.pz[j]);
        if (loopDist(t, i, j) <= 1.3 * d + 4) return;
        const hwSum = t.halfWidth[i] + t.halfWidth[j];
        if (isCrossingPair(t.deck, i, j, t.py[i] - t.py[j], d, hwSum)) return;
        expect(d - hwSum).toBeGreaterThanOrEqual(3);
      });
    }
  });

  test.if(!real)('no self-intersection: non-adjacent centre lines ≥ hwA + hwB + 12 m apart', () => {
    const near = sampleGrid(t, 40);
    let worst = Infinity;
    for (let i = 0; i < t.count; i++) {
      near(t.px[i], t.pz[i], 60, (j) => {
        const required = t.halfWidth[i] + t.halfWidth[j] + 12;
        if (loopDist(t, i, j) <= (Math.PI / 2) * required) return;
        const d = Math.hypot(t.px[i] - t.px[j], t.pz[i] - t.pz[j]);
        worst = Math.min(worst, d - required);
      });
    }
    expect(worst).toBeGreaterThanOrEqual(0);
  });

  test('barriers stay beyond the kerb and never intrude into another part of the track', () => {
    let maxHw = 0;
    for (let i = 0; i < t.count; i++) maxHw = Math.max(maxHw, t.halfWidth[i]);
    const near = sampleGrid(t, 25);
    for (const side of [-1, 1] as const) {
      const { kerb, runoff } = sideArr(t, side);
      for (let i = 0; i < t.count; i++) {
        expect(runoff[i]).toBeGreaterThanOrEqual(kerb[i] + 0.5);
        const d = t.halfWidth[i] + runoff[i];
        const bx = t.px[i] + side * d * t.rx[i];
        const bz = t.pz[i] + side * d * t.rz[i];
        near(bx, bz, d + maxHw + 4, (j) => {
          const chord = Math.hypot(t.px[i] - t.px[j], t.pz[i] - t.pz[j]);
          if (loopDist(t, i, j) <= 2 * chord + 4) return;
          if (isCrossingPair(t.deck, i, j, t.py[i] - t.py[j], chord, t.halfWidth[i] + t.halfWidth[j])) return;
          const dist = Math.hypot(bx - t.px[j], bz - t.pz[j]);
          // not on another section's road / kerbs, and on this section's side of the midline
          expect(dist).toBeGreaterThanOrEqual(t.halfWidth[j] + Math.max(t.kerbLeft[j], t.kerbRight[j]) + 0.5);
          expect(dist - t.halfWidth[j]).toBeGreaterThanOrEqual(d - t.halfWidth[i] - 0.05);
        });
      }
    }
  });

  test('street circuits keep walls 2–4 m away (real: 1.5–4 m), others 10–25 m on open sections (real: ≤ 25 m)', () => {
    for (const side of [-1, 1] as const) {
      const { runoff } = sideArr(t, side);
      // the pit-side apron tapers back to normal over (|laneOffset| + 5) / 0.4 m beyond the pit zone
      const taper = (Math.abs(t.pit.laneOffset) + pitExtrasOf(t).outerClearance) / 0.4 + 4;
      for (let i = 0; i < t.count; i++) {
        if (side === t.pit.side && isInPitZone(t, t.s[i])) continue;
        if (side === t.pit.side && inRangeS(t, t.s[i], t.pit.entry - taper, t.pit.exit + taper)) continue;
        expect(runoff[i]).toBeLessThanOrEqual(t.def.street ? 4 + 1e-9 : 25 + 1e-9);
        if (real && t.def.street) expect(runoff[i]).toBeGreaterThanOrEqual(1.5 - 1e-9);
        if (t.deck[i]) expect(runoff[i]).toBeLessThanOrEqual(3 + 1e-9);
      }
    }
    if (real) {
      // nothing more: real circuits squeeze runoff wherever the real road is close to itself
    } else if (!t.def.street) {
      // the typical (median) runoff of a permanent circuit is ≥ 10 m
      const all = Array.from(t.runoffLeft).concat(Array.from(t.runoffRight)).sort((a, b) => a - b);
      expect(all[Math.floor(all.length / 2)]).toBeGreaterThanOrEqual(10);
    } else {
      for (let i = 0; i < t.count; i++) {
        if (!isInPitZone(t, t.s[i])) {
          expect(t.runoffLeft[i]).toBeGreaterThanOrEqual(2 - 1e-9);
          expect(t.runoffRight[i]).toBeGreaterThanOrEqual(2 - 1e-9);
        }
      }
    }
  });

  test('projection round trip < 0.05 m (with and without hint)', () => {
    const rng = { s: 0x5eed ^ t.count };
    for (let k = 0; k < 400; k++) {
      const s = nextRandom(rng) * t.length;
      const i = indexAtS(t, s);
      const reach = t.halfWidth[i] + Math.min(t.kerbLeft[i], t.kerbRight[i]);
      const lat = (nextRandom(rng) * 2 - 1) * reach;
      const p = poseAt(t, s, lat);
      const hint = (i + Math.round((nextRandom(rng) * 2 - 1) * 30) + t.count) % t.count;
      for (const proj of [projectToTrack(t, p.x, p.z, hint), projectToTrack(t, p.x, p.z, undefined, p.y)]) {
        expect(Math.abs(signedDeltaS(t, s, proj.s))).toBeLessThan(0.05);
        expect(Math.abs(proj.lateral - lat)).toBeLessThan(0.05);
        const back = poseAt(t, proj.s, proj.lateral);
        expect(Math.hypot(back.x - p.x, back.z - p.z)).toBeLessThan(0.05);
        expect(Math.abs(angleDiff(proj.heading, p.yaw))).toBeLessThan(1e-6);
        expect(proj.height).toBeCloseTo(p.y, 6);
        expect(proj.index === indexAtS(t, proj.s) || Math.abs(signedDeltaS(t, proj.index * t.spacing, proj.s)) <= t.spacing).toBe(true);
      }
    }
  });

  test('hinted projection walks beyond the window and stays on its section', () => {
    // a car 120 samples ahead of a stale hint is still found by walking past the ±40 window
    // (on a section with no other part of the road within 80 m, where a stale hint is unambiguous)
    const alone = (at: number): boolean => {
      const i0 = indexAtS(t, at);
      let ok = true;
      sampleGrid(t, 40)(t.px[i0], t.pz[i0], 80, (j) => {
        if (loopDist(t, i0, j) > 200) ok = false;
      });
      return ok;
    };
    let s = 1000;
    while (!alone(s)) s += 100;
    const p = poseAt(t, s, 0);
    const proj = projectToTrack(t, p.x, p.z, indexAtS(t, s - 120 * t.spacing));
    expect(Math.abs(signedDeltaS(t, s, proj.s))).toBeLessThan(0.05);
    // a stale hint on the far side of the circuit falls back to the global search
    const stale = projectToTrack(t, p.x, p.z, indexAtS(t, s + t.length / 2), p.y);
    expect(Math.abs(signedDeltaS(t, s, stale.s))).toBeLessThan(0.05);
    // non-finite input is handled
    const bad = projectToTrack(t, Number.NaN, 0, 10);
    expect(Number.isFinite(bad.s)).toBe(true);
    expect(bad.surface).toBe('asphalt');
  });

  test('reference lap time, speed profile and racing line', () => {
    expect(t.referenceLapTime).toBeGreaterThanOrEqual(real ? 60 : 70);
    expect(t.referenceLapTime).toBeLessThanOrEqual(real ? 125 : 110);
    for (let i = 0; i < t.count; i++) {
      expect(Math.abs(t.racingLine[i])).toBeLessThanOrEqual(t.halfWidth[i] - RACING_LINE_MARGIN + 1e-9);
      expect(t.speedProfile[i]).toBeGreaterThan(real ? 5 - 1e-9 : 10);
      expect(t.speedProfile[i]).toBeLessThanOrEqual(REFERENCE_CAR.topSpeed + 1e-9);
    }
    // the line uses the track width (not just the centre line)
    let maxAbs = 0;
    let maxHw = 0;
    for (let i = 0; i < t.count; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(t.racingLine[i]));
      maxHw = Math.max(maxHw, t.halfWidth[i]);
    }
    expect(maxAbs).toBeGreaterThan(maxHw - RACING_LINE_MARGIN - 0.5);
    // speed changes along the racing line are physically plausible (≤ 7.5 g braking, ≤ 2.5 g traction)
    for (let i = 0; i < t.count; i++) {
      const j = (i + 1) % t.count;
      const ds = Math.hypot(
        t.px[j] + t.racingLine[j] * t.rx[j] - t.px[i] - t.racingLine[i] * t.rx[i],
        t.pz[j] + t.racingLine[j] * t.rz[j] - t.pz[i] - t.racingLine[i] * t.rz[i],
      );
      const dv2 = t.speedProfile[j] ** 2 - t.speedProfile[i] ** 2;
      expect(dv2 / (2 * ds)).toBeLessThan(2.5 * 9.81);
      expect(-dv2 / (2 * ds)).toBeLessThan(7.5 * 9.81);
    }
  });

  test('corners: numbered in order, sign conventions (+ curvature = right = yaw decreasing)', () => {
    expect(t.corners.length).toBeGreaterThanOrEqual(real ? 6 : 8);
    let rights = 0;
    let lefts = 0;
    t.corners.forEach((c, k) => {
      expect(c.number).toBe(k + 1);
      if (k > 0) expect(c.startS).toBeGreaterThan(t.corners[k - 1].startS);
      expect(inRangeS(t, c.apexS, c.startS, c.endS + 1e-6) || c.apexS === c.endS).toBe(true);
      expect(c.minSpeed).toBeCloseTo(sampleAt(t, t.speedProfile, c.apexS), 6);
      const a = indexAtS(t, c.startS);
      const b = indexAtS(t, c.endS);
      const apex = indexAtS(t, c.apexS);
      // heading change across the apex (±10 m) — unambiguous even for hairpins beyond 180°
      const turn = angleDiff(yawAt(t, (apex - 5 + t.count) % t.count), yawAt(t, (apex + 5) % t.count));
      let kSum = 0;
      for (let i = a; i !== b; i = (i + 1) % t.count) kSum += t.curvature[i] * t.spacing;
      if (c.direction === 1) {
        rights++;
        expect(kSum).toBeGreaterThan(0);
        expect(turn).toBeLessThan(0);
        expect(t.curvature[indexAtS(t, c.apexS)]).toBeGreaterThan(0);
      } else {
        lefts++;
        expect(kSum).toBeLessThan(0);
        expect(turn).toBeGreaterThan(0);
        expect(t.curvature[indexAtS(t, c.apexS)]).toBeLessThan(0);
      }
    });
    expect(rights).toBeGreaterThan(0);
    expect(lefts).toBeGreaterThan(0);
  });

  test('main straight ≥ 900 m around the line (real: the pit zone fits instead); sectors roughly thirds', () => {
    const flat = (i: number) => Math.abs(t.curvature[(i + t.count) % t.count]) < 1 / 1000;
    let a = 0;
    while (a < t.count && flat(-a)) a++;
    let b = 0;
    while (b < t.count && flat(b)) b++;
    if (!real) {
      expect((a + b) * t.spacing).toBeGreaterThanOrEqual(900);
      expect(Math.abs(a - b) * t.spacing).toBeLessThan(150);
    } else {
      expect(forwardDistance(t, t.pit.entry, t.pit.exit)).toBeGreaterThanOrEqual(MIN_PIT_ZONE);
    }
    const [s1, s2, s3] = t.sectorStarts;
    expect(s1).toBe(0);
    expect(s2).toBeGreaterThan(0);
    expect(s3).toBeGreaterThan(s2);
    expect(s3).toBeLessThan(t.length);
    for (const len of [s2, s3 - s2, t.length - s3]) {
      expect(len / t.length).toBeGreaterThan(real ? 0.15 : 0.24);
      expect(len / t.length).toBeLessThan(real ? 0.55 : 0.42);
    }
  });

  test('DRS zones: ordered, sensible lengths, never across a slow corner (real: 1–4 zones of 150–2300 m)', () => {
    expect(t.drsZones.length).toBeGreaterThanOrEqual(real ? 1 : 2);
    expect(t.drsZones.length).toBeLessThanOrEqual(real ? 4 : 3);
    for (const z of t.drsZones) {
      const lead = forwardDistance(t, z.detection, z.activation);
      const len = forwardDistance(t, z.activation, z.end);
      if (real) {
        expect(lead).toBeLessThanOrEqual(600);
        expect(len).toBeGreaterThanOrEqual(150);
        expect(len).toBeLessThanOrEqual(2300);
        continue;
      }
      expect(lead).toBeGreaterThan(50);
      expect(lead).toBeLessThan(400);
      expect(len).toBeGreaterThan(300);
      expect(len).toBeLessThan(1800);
      for (const c of t.corners) {
        if (inRangeS(t, c.apexS, z.activation, z.end)) expect(c.minSpeed).toBeGreaterThan(0.75 * REFERENCE_CAR.topSpeed);
      }
    }
  });

  test('pit lane: entry before the line, exit after it, geometry and runoff', () => {
    const { pit } = t;
    expect(pit.side === 1 || pit.side === -1).toBe(true);
    expect(pit.entry).toBeGreaterThan(t.length / 2);
    expect(pit.exit).toBeLessThan(t.length / 2);
    expect(inRangeS(t, 0, pit.entry, pit.exit)).toBe(true);
    expect(isInPitZone(t, 0)).toBe(true);
    expect(isInPitStraight(t, pit.box)).toBe(true);
    const ramp = pitRampLength(t);
    const clear = real ? ramp + PIT_BOX_ROW_HALF + 10 : ramp + 80;
    expect(forwardDistance(t, pit.entry, pit.box)).toBeGreaterThan(clear - 1e-9);
    expect(forwardDistance(t, pit.box, pit.exit)).toBeGreaterThan(clear - 1e-9);
    expect(pit.speedLimit).toBeCloseTo(80 / 3.6, 9);
    const zone = forwardDistance(t, pit.entry, pit.exit);
    expect(pit.laneLength).toBeGreaterThan(real ? zone * 0.9 : zone);
    expect(pit.laneLength).toBeLessThan(real ? zone * 1.1 : zone * 1.05);
    expect(Math.sign(pit.laneOffset)).toBe(pit.side);
    expect(Math.sign(pit.wallOffset)).toBe(pit.side);
    let zoneHw = 0;
    for (let i = 0; i < t.count; i++) if (isInPitZone(t, t.s[i])) zoneHw = Math.max(zoneHw, t.halfWidth[i]);
    expect(Math.abs(pit.laneOffset)).toBeCloseTo(zoneHw + pitExtrasOf(t).laneExtra, 6);
    expect(Math.abs(pit.wallOffset)).toBeCloseTo(zoneHw + pitExtrasOf(t).wallExtra, 6);
    // only Monaco (Piscine section ~45 m away) needs the compact street pit lane; every other layout keeps the standard one
    expect(pitExtrasOf(t).laneExtra).toBe(t.id.startsWith('monaco') ? PIT_STREET.laneExtra : PIT_LANE_EXTRA);
    const { runoff, kerb } = sideArr(t, pit.side);
    for (let i = 0; i < t.count; i++) {
      if (!isInPitZone(t, t.s[i])) continue;
      expect(Math.abs(t.curvature[i])).toBeLessThan(real ? MAX_PIT_CURVATURE + 1e-12 : 1 / 1000);
      expect(runoff[i]).toBeGreaterThanOrEqual(Math.abs(pit.laneOffset) + pitExtrasOf(t).outerClearance - 1e-9);
      expect(kerb[i]).toBe(0);
      expect(pitLaneWallDistance(t, t.s[i])).toBeCloseTo(t.halfWidth[i] + runoff[i], 9);
    }
    // the lane centre blends from the road edge to laneOffset and back
    expect(pitLaneOffsetAt(t, wrapS(t, pit.entry - 5))).toBeNull();
    expect(pitLaneOffsetAt(t, wrapS(t, pit.exit + 5))).toBeNull();
    expect(pitLaneOffsetAt(t, pit.box)).toBeCloseTo(pit.laneOffset, 9);
    const atEntry = pitLaneOffsetAt(t, pit.entry) ?? 0;
    expect(Math.abs(atEntry)).toBeLessThan(t.halfWidth[indexAtS(t, pit.entry)]);
  });

  test('pit-lane band reports pitlane; wall distances along the pit straight', () => {
    const { pit } = t;
    const hw = t.halfWidth[indexAtS(t, pit.box)];
    const inLane = poseAt(t, pit.box, pit.laneOffset);
    const p1 = projectToTrack(t, inLane.x, inLane.z);
    expect(p1.surface).toBe('pitlane');
    const nearWall = poseAt(t, pit.box, pit.wallOffset + pit.side * 0.5);
    expect(projectToTrack(t, nearWall.x, nearWall.z).surface).toBe('pitlane');
    const onTrack = poseAt(t, pit.box, pit.side * (hw - 1));
    const p2 = projectToTrack(t, onTrack.x, onTrack.z);
    expect(p2.surface).toBe('asphalt');
    expect(p2.wallDistance).toBeCloseTo(Math.abs(pit.wallOffset), 9);
    // the other side is an ordinary barrier
    const other = poseAt(t, pit.box, -pit.side * (hw - 1));
    const p3 = projectToTrack(t, other.x, other.z);
    const { runoff } = sideArr(t, (-pit.side) as 1 | -1);
    expect(p3.wallDistance).toBeCloseTo(hw + sampleAt(t, runoff, pit.box), 6);
    const otherRunoff = poseAt(t, pit.box, -pit.side * (hw + 1.5));
    expect(projectToTrack(t, otherRunoff.x, otherRunoff.z).surface).not.toBe('pitlane');
    // ramp: the lane centre is pit lane surface once off the road
    const mid = wrapS(t, pit.entry + pitRampLength(t) * 0.6);
    const laneMid = pitLaneOffsetAt(t, mid) ?? 0;
    const pr = poseAt(t, mid, laneMid);
    expect(projectToTrack(t, pr.x, pr.z).surface).toBe('pitlane');
    // barrier limits: track side bounded by the pit wall, lane side between pit wall and outer wall
    const trackSide = barrierLimits(t, pit.box, 0);
    const laneSide = barrierLimits(t, pit.box, pit.laneOffset);
    const outer = pit.side * pitLaneWallDistance(t, pit.box);
    if (pit.side === 1) {
      expect(trackSide.max).toBeCloseTo(pit.wallOffset, 9);
      expect(laneSide.min).toBeCloseTo(pit.wallOffset, 9);
      expect(laneSide.max).toBeCloseTo(outer, 9);
    } else {
      expect(trackSide.min).toBeCloseTo(pit.wallOffset, 9);
      expect(laneSide.max).toBeCloseTo(pit.wallOffset, 9);
      expect(laneSide.min).toBeCloseTo(outer, 9);
    }
    expect(Math.abs(outer)).toBeGreaterThan(Math.abs(pit.laneOffset) + pitExtrasOf(t).outerClearance);
  });

  test('surfaces: asphalt, kerb, runoff materials', () => {
    let kerbChecked = 0;
    for (let i = 0; i < t.count; i += 7) {
      const s = t.s[i];
      for (const side of [-1, 1] as const) {
        if (side === t.pit.side && isInPitZone(t, s)) continue;
        const { kerb, runoff } = sideArr(t, side);
        const hw = t.halfWidth[i];
        const surf = side === 1 ? t.runoffSurfaceRight[i] : t.runoffSurfaceLeft[i];
        const at = (lat: number) => {
          const p = poseAt(t, s, lat);
          return projectToTrack(t, p.x, p.z, i);
        };
        expect(at(side * (hw - 0.5)).surface).toBe('asphalt');
        if (kerb[i] > 0.5 && kerb[(i + 1) % t.count] > 0.5 && kerb[(i - 1 + t.count) % t.count] > 0.5) {
          expect(at(side * (hw + kerb[i] / 2)).surface).toBe('kerb');
          kerbChecked++;
        }
        if (runoff[i] - kerb[i] > 1.5 && surf === (side === 1 ? t.runoffSurfaceRight : t.runoffSurfaceLeft)[(i + 1) % t.count]) {
          const p = at(side * (hw + kerb[i] + 1));
          expect(p.surface).toBe(surf === 0 ? 'grass' : surf === 1 ? 'gravel' : 'runoff');
          expect(p.wallDistance).toBeCloseTo(hw + sampleAt(t, runoff, p.s), 2);
        }
      }
    }
    expect(kerbChecked).toBeGreaterThan(10);
  });

  test('heightAt follows the road and fades to the average far away', () => {
    let sum = 0;
    for (let i = 0; i < t.count; i++) sum += t.py[i];
    const avg = sum / t.count;
    for (let i = 0; i < t.count; i += 5) {
      // on a deck the terrain follows the lower road instead (see the grade separation tests)
      if (t.deck[i]) continue;
      expect(Math.abs(heightAt(t, t.px[i], t.pz[i]) - t.py[i])).toBeLessThan(real ? 0.25 : 0.1);
      const edge = poseAt(t, t.s[i], t.halfWidth[i]);
      expect(Math.abs(heightAt(t, edge.x, edge.z) - t.py[i])).toBeLessThan(real ? 1.5 : 0.3);
    }
    expect(heightAt(t, t.bounds.maxX + 5000, t.bounds.maxZ + 5000)).toBeCloseTo(avg, 9);
    expect(heightAt(t, Number.NaN, 0)).toBeCloseTo(avg, 9);
    // smooth: neighbouring terrain points never jump (real valleys between sections at different heights may be
    // steeper embankments, up to ~42°)
    for (let k = 0; k < 200; k++) {
      const x = t.bounds.minX + ((t.bounds.maxX - t.bounds.minX) * k) / 200;
      const z = (t.bounds.minZ + t.bounds.maxZ) / 2;
      expect(Math.abs(heightAt(t, x + 1, z) - heightAt(t, x, z))).toBeLessThan(real ? 0.9 : 0.6);
    }
  });

  test('bounds contain everything inside the barriers', () => {
    const b = t.bounds;
    for (let i = 0; i < t.count; i++) {
      expect(t.px[i]).toBeGreaterThanOrEqual(b.minX);
      expect(t.px[i]).toBeLessThanOrEqual(b.maxX);
      expect(t.pz[i]).toBeGreaterThanOrEqual(b.minZ);
      expect(t.pz[i]).toBeLessThanOrEqual(b.maxZ);
      expect(t.py[i]).toBeGreaterThanOrEqual(b.minY);
      expect(t.py[i]).toBeLessThanOrEqual(b.maxY);
    }
  });
});

describe('reverse layouts', () => {
  test.each([...TRACK_DEFS, ...FIXTURE_DEFS].map((d) => [d.id, d] as const))('%s: same geometry, mapped metadata', (_id, def) => {
    const f = layoutById(def.id);
    const r = layoutById(`${def.id}-rev`);
    expect(r.length).toBeCloseTo(f.length, 6);
    expect(r.count).toBe(f.count);
    for (let k = 0; k < f.count; k += 13) {
      const j = (f.count - k) % f.count;
      expect(Math.hypot(r.px[k] - f.px[j], r.pz[k] - f.pz[j])).toBeLessThan(0.05);
      // driving direction flips
      expect(r.tx[k] * f.tx[j] + r.tz[k] * f.tz[j]).toBeLessThan(-0.99);
      // grade separation belongs to the physical road, not to the direction
      expect(r.deck[k]).toBe(f.deck[j]);
    }
    const L = f.length;
    const mirror = (s: number) => wrapS(f, L - s);
    // sectors: sorted {L - s3, L - s2}
    expect(r.sectorStarts[1]).toBeCloseTo(mirror(f.sectorStarts[2]), 6);
    expect(r.sectorStarts[2]).toBeCloseTo(mirror(f.sectorStarts[1]), 6);
    // DRS: activation' = L - end, end' = L - activation, same detection lead
    expect(r.drsZones.length).toBe(f.drsZones.length);
    f.drsZones.forEach((z, k) => {
      const rz = r.drsZones[k];
      expect(Math.abs(signedDeltaS(f, rz.activation, mirror(z.end)))).toBeLessThan(1e-6);
      expect(Math.abs(signedDeltaS(f, rz.end, mirror(z.activation)))).toBeLessThan(1e-6);
      expect(forwardDistance(r, rz.detection, rz.activation)).toBeCloseTo(forwardDistance(f, z.detection, z.activation), 6);
    });
    // pit: entry' = L - exit, exit' = L - entry, box' = L - box, side flips
    expect(r.pit.side).toBe(-f.pit.side as 1 | -1);
    expect(Math.abs(signedDeltaS(f, r.pit.entry, mirror(f.pit.exit)))).toBeLessThan(1e-6);
    expect(Math.abs(signedDeltaS(f, r.pit.exit, mirror(f.pit.entry)))).toBeLessThan(1e-6);
    expect(Math.abs(signedDeltaS(f, r.pit.box, mirror(f.pit.box)))).toBeLessThan(1e-6);
    // the pit lane is physically on the same side of the circuit
    const pf = poseAt(f, f.pit.box, f.pit.laneOffset);
    const pr = poseAt(r, r.pit.box, r.pit.laneOffset);
    expect(Math.hypot(pf.x - pr.x, pf.z - pr.z)).toBeLessThan(0.1);
  });
});

describe('outline', () => {
  test.each(LAYOUTS.map((l) => [l.id] as const))('%s: normalized, centred, aspect kept, un-mirrored', (id) => {
    const t = getLayout(id);
    const pts = getLayoutOutline(id, 200);
    expect(pts.length).toBe(200);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.y).toBeLessThanOrEqual(1 + 1e-9);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    expect(Math.max(maxX - minX, maxY - minY)).toBeGreaterThan(0.97);
    expect((minX + maxX) / 2).toBeCloseTo(0.5, 1);
    expect((minY + maxY) / 2).toBeCloseTo(0.5, 1);
    const worldRatio = (t.bounds.maxX - t.bounds.minX) / (t.bounds.maxZ - t.bounds.minZ);
    expect(Math.abs(Math.log((maxX - minX) / (maxY - minY) / worldRatio))).toBeLessThan(0.15);
    // index 0 = start/finish; screen y grows with world +Z, screen x with world +X
    const start = worldToOutline(id, t.px[0], t.pz[0]);
    expect(pts[0].x).toBeCloseTo(start.x, 9);
    expect(pts[0].y).toBeCloseTo(start.y, 9);
    const a = worldToOutline(id, 0, 0);
    const b = worldToOutline(id, 100, 100);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeGreaterThan(a.y);
    // default size and clamping
    expect(getLayoutOutline(id).length).toBe(256);
    expect(getLayoutOutline(id, 2).length).toBe(8);
    expect(getLayoutOutline(id, 1e9).length).toBe(t.count);
  });
});

describe('loop helpers', () => {
  const t = getLayout('isola-verde');
  const L = t.length;
  test('wrapS / forwardDistance / signedDeltaS / inRangeS / indexAtS / sampleAt', () => {
    expect(wrapS(t, -1)).toBeCloseTo(L - 1, 9);
    expect(wrapS(t, L + 3)).toBeCloseTo(3, 9);
    expect(wrapS(t, Number.NaN)).toBe(0);
    expect(wrapS(t, -1e-18)).toBeLessThan(L);
    expect(forwardDistance(t, L - 10, 5)).toBeCloseTo(15, 9);
    expect(forwardDistance(t, 5, L - 10)).toBeCloseTo(L - 15, 9);
    expect(signedDeltaS(t, L - 10, 5)).toBeCloseTo(15, 9);
    expect(signedDeltaS(t, 5, L - 10)).toBeCloseTo(-15, 9);
    expect(signedDeltaS(t, 0, L / 2)).toBeCloseTo(L / 2, 9);
    expect(inRangeS(t, 2, L - 10, 5)).toBe(true);
    expect(inRangeS(t, 6, L - 10, 5)).toBe(false);
    expect(inRangeS(t, 5, 0, 5)).toBe(false);
    expect(inRangeS(t, 3, 3, 3)).toBe(false);
    expect(indexAtS(t, L - 0.1)).toBe(0);
    expect(indexAtS(t, t.spacing * 10.4)).toBe(10);
    expect(sampleAt(t, t.speedProfile, t.s[7])).toBeCloseTo(t.speedProfile[7], 9);
    const mid = sampleAt(t, t.px, L - t.spacing / 2);
    expect(mid).toBeCloseTo((t.px[t.count - 1] + t.px[0]) / 2, 9);
    expect(sampleAt(t, [], 10)).toBe(0);
    expect(sampleAt(t, [4, 8], L / 4)).toBeCloseTo(6, 9);
  });
});

describe('synthetic circles: sign conventions and reverse', () => {
  const R = 300;
  const n = 24;
  // clockwise on the minimap (x right, z down) = right-hand turns: heading +X at the top of the circle
  const ring: TrackDef = {
    id: 'test-ring',
    name: '測試環',
    location: '',
    country: '',
    biome: 'temperate',
    timeOfDay: 'day',
    street: false,
    width: 12,
    fullLaps: 1,
    sectors: [0.3, 0.6],
    drsZones: [{ detection: 0.05, activation: 0.1, end: 0.3 }],
    pit: { side: 'right', entry: 0.95, exit: 0.05, box: 0 },
    description: '',
    points: Array.from({ length: n }, (_, k) => {
      const a = (k / n) * Math.PI * 2;
      return { x: R * Math.sin(a), z: -R * Math.cos(a) };
    }),
  };

  test('right-turning loop has positive curvature and decreasing yaw', () => {
    const t = buildTrack(ring);
    expect(t.length).toBeCloseTo(2 * Math.PI * R, -1);
    for (let i = 0; i < t.count; i += 10) {
      expect(t.curvature[i]).toBeGreaterThan(0.9 / R);
      expect(t.curvature[i]).toBeLessThan(1.1 / R);
      const j = (i + 5) % t.count;
      expect(angleDiff(yawAt(t, i), yawAt(t, j))).toBeLessThan(0);
      // the right vector points to the circle centre (inside of a right-hander)
      expect(t.px[i] * t.rx[i] + t.pz[i] * t.rz[i]).toBeLessThan(0);
    }
    expect(t.corners.every((c) => c.direction === 1)).toBe(true);
    const rev = buildTrack(ring, { reverse: true });
    for (let i = 0; i < rev.count; i += 10) expect(rev.curvature[i]).toBeLessThan(0);
    expect(rev.corners.every((c) => c.direction === -1)).toBe(true);
  });

  test('build is deterministic and fast', () => {
    const def = getTrackDef('highland-ridge');
    const t0 = performance.now();
    const a = buildTrack(def, { reverse: true });
    const ms = performance.now() - t0;
    const b = buildTrack(def, { reverse: true });
    expect(Array.from(a.racingLine)).toEqual(Array.from(b.racingLine));
    expect(Array.from(a.runoffLeft)).toEqual(Array.from(b.runoffLeft));
    expect(a.referenceLapTime).toBe(b.referenceLapTime);
    expect(ms).toBeLessThan(400);
  });

  test('invalid definitions throw', () => {
    expect(() => buildTrack({ ...ring, points: ring.points.slice(0, 3) })).toThrow();
    expect(() => buildTrack({ ...ring, points: [...ring.points.slice(0, 5), { x: Number.NaN, z: 0 }] })).toThrow();
  });
});
