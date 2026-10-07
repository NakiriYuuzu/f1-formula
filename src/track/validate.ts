/**
 * Self-check for real-circuit TrackDefs. `validateTrackDef` builds both directions and returns human-readable
 * problems; `checkBuiltTrack` applies the same rules to one built layout. tests/track*.test.ts run these very
 * rules, so an empty list means the real-circuit track tests pass.
 *
 * Rules (REAL_LIMITS): lap length within ±2 % of def.real.length; grades ≤ 20 % over ≥ 10 m; centre-line radius
 * ≥ 9 m and the road edge / inner barrier never fold; road width 10–16 m; 1–4 DRS zones of 150–2300 m with 0–600 m
 * detection lead; sectors 15–55 % of the lap; ≥ 6 corners; reference lap 60–125 s; non-adjacent sections ≥ 3 m
 * apart edge to edge with barriers between them (never on the other road or its kerbs) unless grade-separated
 * (crossings.ts); street walls 1.5–4 m, other circuits ≤ 25 m; deck walls ≤ 3 m; pit zone ≥ MIN_PIT_ZONE,
 * |curvature| ≤ MAX_PIT_CURVATURE inside it, the garage row fits between the ramps.
 */
import type { BuiltTrack, TrackDef } from '../core/types';
import { buildTrack } from './build';
import { isCrossingPair, isGradeSeparated, roadsOverlap } from './crossings';
import { forwardDistance, inRangeS } from './loop';
import {
  MAX_PIT_CURVATURE,
  MIN_PIT_ZONE,
  PIT_BOX_ROW_HALF,
  isInPitZone,
  pitExtrasOf,
  pitRampLength,
} from './pit';
import { SampleGrid } from './spatial';

export const REAL_LIMITS = {
  lengthTolerance: 0.02,
  maxGrade: 0.2,
  gradeBaseline: 10,
  minRadius: 9,
  width: [10, 16],
  drsZones: [1, 4],
  drsLength: [150, 2300],
  drsLead: [0, 600],
  sectorShare: [0.15, 0.55],
  minCorners: 6,
  lapTime: [60, 125],
  minEdgeGap: 3,
  streetWall: [1.5, 4],
  openWall: 25,
  deckWall: 3,
  /** road half width must stay below this fraction of the local radius */
  edgeFold: 0.9,
} as const;

/** Collects problems, at most `cap` messages per rule (plus a count of the rest). */
class Report {
  readonly list: string[] = [];
  private readonly counts = new Map<string, number>();
  add(rule: string, message: string, cap = 3): void {
    const n = (this.counts.get(rule) ?? 0) + 1;
    this.counts.set(rule, n);
    if (n <= cap) this.list.push(`${rule}: ${message}`);
    else if (n === cap + 1) this.list.push(`${rule}: ... more`);
  }
}

const at = (t: BuiltTrack, i: number): string => `s=${(i * t.spacing).toFixed(0)} m`;

/** Problems of one built layout (empty = all real-circuit rules pass). `def.real` adds the lap-length rule. */
export function checkBuiltTrack(t: BuiltTrack): string[] {
  const r = new Report();
  const n = t.count;
  const L = REAL_LIMITS;

  if (t.def.real) {
    const want = t.def.real.length;
    if (Math.abs(t.length - want) > L.lengthTolerance * want) {
      r.add('length', `${t.length.toFixed(0)} m vs official ${want} m (±${L.lengthTolerance * 100} %)`);
    }
  }
  for (const name of ['px', 'py', 'pz', 'curvature', 'halfWidth', 'kerbLeft', 'kerbRight', 'runoffLeft', 'runoffRight', 'racingLine', 'speedProfile'] as const) {
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(t[name][i])) {
        r.add('finite', `${name}[${i}] is not finite`);
        break;
      }
    }
  }

  // grades over ≥ 10 m, radius, width, edge fold
  const k = Math.max(1, Math.ceil(L.gradeBaseline / t.spacing));
  let maxCurv = 0;
  for (let i = 0; i < n; i++) {
    const grade = Math.abs(t.py[(i + k) % n] - t.py[i]) / (k * t.spacing);
    if (grade > L.maxGrade) r.add('grade', `${(grade * 100).toFixed(1)} % at ${at(t, i)}`);
    const c = Math.abs(t.curvature[i]);
    maxCurv = Math.max(maxCurv, c);
    if (c > 1 / L.minRadius) r.add('radius', `${(1 / c).toFixed(1)} m (< ${L.minRadius} m) at ${at(t, i)}`);
    const w = 2 * t.halfWidth[i];
    if (w < L.width[0] - 1e-6 || w > L.width[1] + 1e-6) r.add('width', `${w.toFixed(1)} m at ${at(t, i)}`);
    if (c > 1e-9 && t.halfWidth[i] > L.edgeFold / c) {
      r.add('edge fold', `half width ${t.halfWidth[i].toFixed(1)} m vs radius ${(1 / c).toFixed(1)} m at ${at(t, i)}`);
    }
    for (const side of [-1, 1] as const) {
      const inside = side * t.curvature[i];
      const runoff = side === 1 ? t.runoffRight[i] : t.runoffLeft[i];
      if (inside > 1e-9 && t.halfWidth[i] + runoff > 1 / inside + 1e-6) {
        r.add('barrier fold', `inner barrier ${(t.halfWidth[i] + runoff).toFixed(1)} m beyond the radius ${(1 / inside).toFixed(1)} m at ${at(t, i)}`);
      }
    }
  }

  // DRS, sectors, corners, lap time
  if (t.drsZones.length < L.drsZones[0] || t.drsZones.length > L.drsZones[1]) {
    r.add('drs', `${t.drsZones.length} zones (need ${L.drsZones[0]}–${L.drsZones[1]})`);
  }
  for (const z of t.drsZones) {
    const lead = forwardDistance(t, z.detection, z.activation);
    const len = forwardDistance(t, z.activation, z.end);
    if (len < L.drsLength[0] || len > L.drsLength[1]) r.add('drs', `zone at ${z.activation.toFixed(0)} m is ${len.toFixed(0)} m long`);
    if (lead < L.drsLead[0] || lead > L.drsLead[1]) r.add('drs', `detection lead ${lead.toFixed(0)} m at ${z.activation.toFixed(0)} m`);
  }
  const [s1, s2, s3] = t.sectorStarts;
  [s2 - s1, s3 - s2, t.length - s3].forEach((len, idx) => {
    const share = len / t.length;
    if (share < L.sectorShare[0] || share > L.sectorShare[1]) r.add('sectors', `sector ${idx + 1} is ${(share * 100).toFixed(0)} % of the lap`);
  });
  if (t.corners.length < L.minCorners) r.add('corners', `${t.corners.length} detected (need ≥ ${L.minCorners})`);
  if (t.referenceLapTime < L.lapTime[0] || t.referenceLapTime > L.lapTime[1]) {
    r.add('lap time', `reference lap ${t.referenceLapTime.toFixed(1)} s (need ${L.lapTime[0]}–${L.lapTime[1]})`);
  }

  checkRoadside(t, r);
  checkPit(t, r);
  return r.list;
}

function checkRoadside(t: BuiltTrack, r: Report): void {
  const L = REAL_LIMITS;
  const n = t.count;
  let maxHw = 0;
  for (let i = 0; i < n; i++) maxHw = Math.max(maxHw, t.halfWidth[i]);
  const grid = new SampleGrid(t.px, t.pz, 25);
  const loopDist = (i: number, j: number): number => {
    const d = Math.abs(i - j) * t.spacing;
    return Math.min(d, t.length - d);
  };

  // roads: edge gap between non-adjacent sections; every grade-separated crossing has its deck flagged
  for (let i = 0; i < n; i++) {
    grid.forEachInRadius(t.px[i], t.pz[i], 2 * maxHw + L.minEdgeGap + 2, (j, d2) => {
      const chord = Math.sqrt(d2);
      if (loopDist(i, j) <= 1.3 * chord + 4) return;
      const hwSum = t.halfWidth[i] + t.halfWidth[j];
      const dy = t.py[i] - t.py[j];
      if (isGradeSeparated(dy, chord, hwSum) && roadsOverlap(chord, hwSum) && dy > 0 && !t.deck[i]) {
        r.add('deck', `upper road at ${at(t, i)} is not flagged as deck`);
      }
      if (isCrossingPair(t.deck, i, j, dy, chord, hwSum)) return;
      if (j > i && chord - hwSum < L.minEdgeGap) {
        r.add('close sections', `${at(t, i)} and ${at(t, j)} are ${(chord - hwSum).toFixed(1)} m apart edge to edge (need ≥ ${L.minEdgeGap} m, or ≥ 6 m of height difference)`);
      }
    });
  }

  // barriers: beyond the kerb, between the roads, never on another section's road or kerbs
  const near = new SampleGrid(t.px, t.pz, 25);
  for (const side of [-1, 1] as const) {
    const kerb = side === 1 ? t.kerbRight : t.kerbLeft;
    const runoff = side === 1 ? t.runoffRight : t.runoffLeft;
    for (let i = 0; i < n; i++) {
      if (runoff[i] < kerb[i] + 0.5 - 1e-9) r.add('barrier', `runoff ${runoff[i].toFixed(2)} m < kerb ${kerb[i].toFixed(2)} m + 0.5 at ${at(t, i)}`);
      const d = t.halfWidth[i] + runoff[i];
      const bx = t.px[i] + side * d * t.rx[i];
      const bz = t.pz[i] + side * d * t.rz[i];
      near.forEachInRadius(bx, bz, d + maxHw + 4, (j) => {
        const chord = Math.hypot(t.px[i] - t.px[j], t.pz[i] - t.pz[j]);
        if (loopDist(i, j) <= 2 * chord + 4) return;
        if (isCrossingPair(t.deck, i, j, t.py[i] - t.py[j], chord, t.halfWidth[i] + t.halfWidth[j])) return;
        const dist = Math.hypot(bx - t.px[j], bz - t.pz[j]);
        if (dist < t.halfWidth[j] + Math.max(t.kerbLeft[j], t.kerbRight[j]) + 0.5) {
          r.add('barrier', `barrier at ${at(t, i)} intrudes on the road / kerb at ${at(t, j)}`);
        } else if (dist - t.halfWidth[j] < d - t.halfWidth[i] - 0.05) {
          r.add('barrier', `barrier at ${at(t, i)} is past the midline towards ${at(t, j)}`);
        }
      });
    }
  }

  // wall distances: street 1.5–4 m, open ≤ 25 m, deck ≤ 3 m (the pit side near the pit zone is wide on purpose)
  const extras = pitExtrasOf(t);
  const taper = (Math.abs(t.pit.laneOffset) + extras.outerClearance) / 0.4 + 4;
  for (const side of [-1, 1] as const) {
    const runoff = side === 1 ? t.runoffRight : t.runoffLeft;
    for (let i = 0; i < n; i++) {
      const s = t.s[i];
      const w = runoff[i];
      if (t.deck[i] && w > L.deckWall + 1e-9) r.add('walls', `deck parapet ${w.toFixed(1)} m (> ${L.deckWall} m) at ${at(t, i)}`);
      if (side === t.pit.side && inRangeS(t, s, t.pit.entry - taper, t.pit.exit + taper)) continue;
      if (t.def.street) {
        if (w < L.streetWall[0] - 1e-9 || w > L.streetWall[1] + 1e-9) r.add('walls', `street wall ${w.toFixed(1)} m at ${at(t, i)} (need ${L.streetWall[0]}–${L.streetWall[1]} m)`);
      } else if (w > L.openWall + 1e-9) {
        r.add('walls', `runoff ${w.toFixed(1)} m (> ${L.openWall} m) at ${at(t, i)}`);
      }
    }
  }
}

function checkPit(t: BuiltTrack, r: Report): void {
  const { pit } = t;
  const zone = forwardDistance(t, pit.entry, pit.exit);
  if (!(pit.entry > t.length / 2) || !(pit.exit < t.length / 2) || !inRangeS(t, 0, pit.entry, pit.exit)) {
    r.add('pit', 'the pit zone must run through the start line (entry in the last half, exit in the first half of the lap)');
  }
  if (zone < MIN_PIT_ZONE) r.add('pit', `pit zone ${zone.toFixed(0)} m < ${MIN_PIT_ZONE} m`);
  const ramp = pitRampLength(t);
  const clear = ramp + PIT_BOX_ROW_HALF + 10;
  if (forwardDistance(t, pit.entry, pit.box) < clear || forwardDistance(t, pit.box, pit.exit) < clear) {
    r.add('pit', `the garage row (box ± ${PIT_BOX_ROW_HALF} m) must stay ${clear.toFixed(0)} m from the pit entry and exit`);
  }
  if (pit.laneLength < zone * 0.9 || pit.laneLength > zone * 1.1) {
    r.add('pit', `lane length ${pit.laneLength.toFixed(0)} m vs zone ${zone.toFixed(0)} m (curvature too high)`);
  }
  const runoff = pit.side === 1 ? t.runoffRight : t.runoffLeft;
  const kerb = pit.side === 1 ? t.kerbRight : t.kerbLeft;
  const extras = pitExtrasOf(t);
  const need = Math.abs(pit.laneOffset) + extras.outerClearance;
  for (let i = 0; i < t.count; i++) {
    if (!isInPitZone(t, t.s[i])) continue;
    if (Math.abs(t.curvature[i]) > MAX_PIT_CURVATURE) r.add('pit', `curvature radius ${(1 / Math.abs(t.curvature[i])).toFixed(0)} m < ${1 / MAX_PIT_CURVATURE} m at ${at(t, i)}`);
    if (runoff[i] < need - 1e-9) r.add('pit', `pit-side runoff ${runoff[i].toFixed(1)} m < ${need.toFixed(1)} m at ${at(t, i)} (another section too close?)`);
    if (kerb[i] !== 0) r.add('pit', `kerb in the pit zone at ${at(t, i)}`);
    if (t.deck[i]) r.add('pit', `deck inside the pit zone at ${at(t, i)}`);
  }
  let zoneHw = 0;
  for (let i = 0; i < t.count; i++) if (isInPitZone(t, t.s[i])) zoneHw = Math.max(zoneHw, t.halfWidth[i]);
  if (Math.abs(Math.abs(pit.laneOffset) - (zoneHw + extras.laneExtra)) > 1e-6) r.add('pit', 'laneOffset is not zone half width + the pit lane extra');
}

/**
 * Build both directions of `def` and return every problem found (empty = valid). Errors thrown by buildTrack
 * are reported as problems. Messages are prefixed with the layout id.
 */
export function validateTrackDef(def: TrackDef): string[] {
  const problems: string[] = [];
  const real = def.real;
  if (!real) problems.push(`${def.id}: def.real is missing (length rule skipped)`);
  else {
    if (!(real.length > 0) || !(real.turns > 0)) problems.push(`${def.id}: real.length / real.turns must be positive`);
    for (const f of real.features ?? []) {
      const ok = f.at >= 0 && f.at < 1 && (f.end === undefined || (f.end >= 0 && f.end < 1));
      if (!ok) problems.push(`${def.id}: feature ${f.name} has a lap fraction outside [0, 1)`);
      if (f.kind === 'tunnel' && f.end === undefined) problems.push(`${def.id}: tunnel ${f.name} needs an end`);
    }
  }
  if (def.width < REAL_LIMITS.width[0] || def.width > REAL_LIMITS.width[1]) problems.push(`${def.id}: def.width ${def.width} outside ${REAL_LIMITS.width[0]}–${REAL_LIMITS.width[1]} m`);
  const built: BuiltTrack[] = [];
  for (const reverse of [false, true]) {
    try {
      built.push(buildTrack(def, { reverse }));
    } catch (e) {
      problems.push(`${reverse ? `${def.id}-rev` : def.id}: buildTrack failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const t of built) for (const p of checkBuiltTrack(t)) problems.push(`${t.id}: ${p}`);
  return problems;
}
