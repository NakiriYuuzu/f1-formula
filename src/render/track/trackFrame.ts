/**
 * Render-side track precomputation: visual barrier offsets (the physics wall line, clamped only where it would fold
 * on the inside of tight corners),
 * pit-lane geometry along the main straight, and a spatial grid for nearest-sample queries
 * (terrain corridor lowering, prop exclusion, camera targeting).
 */
import type { BuiltTrack } from '../../core/types';
import { forwardDistance, inRangeS } from '../../track/track';
import { smoothstep } from '../../core/math';

/** Half width (m) of the painted pit lane around its centre line (track: drivable band ±5 m). */
export const PIT_LANE_HALF = 5;
/** Nominal entry / exit ramp length (matches track/pit.ts: min(120, zone / 4)). */
export const PIT_RAMP_MAX = 120;
/** Lane centre starts / ends this far inside the road edge (matches track/pit.ts). */
const PIT_RAMP_EDGE_INSET = 1.5;
/** Garage boxes: 12 teams, spacing along s, centred at track.pit.box (race/world.ts BOX_SLOTS / BOX_SPACING). */
export const PIT_BOX_COUNT = 12;
export const PIT_BOX_SPACING = 12.8;
/** Painted box = working lane, this far (m) from the lane centre toward the garages (race/pitlane.ts BOX_LATERAL). */
export const PIT_BOX_LATERAL = 4;
/** Garage building depth (m) behind the pit-side outer wall line. */
export const GARAGE_DEPTH = 18;
/** Garages never get shallower than this (m); between GARAGE_MIN_DEPTH and GARAGE_DEPTH they shrink to clear other road sections. */
export const GARAGE_MIN_DEPTH = 6;
/** Inside-corner barrier: at most this fraction of the local radius, curvature taken over ±window samples. */
const BARRIER_FOLD_LIMIT = 0.95;
const BARRIER_CURVATURE_WINDOW = 2;

export interface NearestSample {
  index: number;
  /** squared planar distance to the sample */
  dist2: number;
  /** signed lateral offset (+ right) relative to that sample */
  lateral: number;
}

export class TrackFrame {
  readonly track: BuiltTrack;
  readonly n: number;
  /** positive distance from centre line to the visual barrier (left / right) */
  readonly barrierL: Float64Array;
  readonly barrierR: Float64Array;
  /** 1 inside the pit zone (entry..exit) */
  readonly inPit: Uint8Array;
  /** 1 where the pit lane is fully offset (pit wall + garages present) */
  readonly pitStraight: Uint8Array;
  /** signed lateral of the pit-lane centre line (0 outside the zone) */
  readonly pitLane: Float64Array;
  /** blend 0..1 of the pit lane offset (0 at entry/exit, 1 on the straight) */
  readonly pitBlend: Float64Array;
  /** 1 where the garage block stands (pit straight around pit.box) */
  readonly garage: Uint8Array;
  /** garage block depth (m) behind the pit-side wall per sample: GARAGE_DEPTH, or less where another road section runs close behind */
  readonly garageDepth: Float64Array;
  /** 1 on the upper road of a grade-separated crossing (BuiltTrack.deck; all 0 when the track has no crossing) */
  readonly deck: Uint8Array;
  readonly hasDeck: boolean;
  readonly pitSign: 1 | -1;
  readonly pitRamp: number;
  readonly minY: number;
  readonly maxY: number;

  private readonly cell = 24;
  private readonly gx0: number;
  private readonly gz0: number;
  private readonly gnx: number;
  private readonly gnz: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  constructor(track: BuiltTrack) {
    this.track = track;
    const n = Math.max(0, track.count | 0);
    this.n = n;
    this.pitSign = track.pit.side === 1 ? 1 : -1;
    this.deck = track.deck && track.deck.length === n ? track.deck : new Uint8Array(n);
    this.hasDeck = this.deck.some((d) => d > 0);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const y = track.py[i];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.minY = Number.isFinite(minY) ? minY : 0;
    this.maxY = Number.isFinite(maxY) ? maxY : 0;

    // ── visual barrier offsets: the physics wall line (hw + runoff, track barrierLimits), pulled in only where an
    // inside offset would fold over the corner's centre of curvature ──
    this.barrierL = new Float64Array(n);
    this.barrierR = new Float64Array(n);
    const win = BARRIER_CURVATURE_WINDOW;
    for (let i = 0; i < n; i++) {
      let maxRight = 0;
      let maxLeft = 0;
      for (let k = -win; k <= win; k++) {
        const c = track.curvature[(i + k + n) % n] || 0;
        if (c > maxRight) maxRight = c;
        if (-c > maxLeft) maxLeft = -c;
      }
      const hw = safe(track.halfWidth[i], 6);
      const minL = hw + safe(track.kerbLeft[i], 0) + 1;
      const minR = hw + safe(track.kerbRight[i], 0) + 1;
      let l = hw + Math.max(0.5, safe(track.runoffLeft[i], 3));
      let r = hw + Math.max(0.5, safe(track.runoffRight[i], 3));
      if (maxLeft > 1e-4) l = Math.min(l, BARRIER_FOLD_LIMIT / maxLeft);
      if (maxRight > 1e-4) r = Math.min(r, BARRIER_FOLD_LIMIT / maxRight);
      this.barrierL[i] = Math.max(minL, l);
      this.barrierR[i] = Math.max(minR, r);
    }

    // ── pit lane ──
    this.inPit = new Uint8Array(n);
    this.pitStraight = new Uint8Array(n);
    this.pitLane = new Float64Array(n);
    this.pitBlend = new Float64Array(n);
    this.garage = new Uint8Array(n);
    this.garageDepth = new Float64Array(n).fill(GARAGE_DEPTH);
    const { entry, exit, laneOffset } = track.pit;
    const zone = forwardDistance(track, entry, exit);
    this.pitRamp = Math.max(1, Math.min(PIT_RAMP_MAX, zone / 4));
    const full = Math.abs(safe(laneOffset, 15));
    const garageHalf = (PIT_BOX_COUNT * PIT_BOX_SPACING) / 2 + 18;
    for (let i = 0; i < n; i++) {
      const s = track.s[i];
      if (!inRangeS(track, s, entry, exit)) continue;
      const dIn = forwardDistance(track, entry, s);
      const dOut = zone - dIn;
      const f = Math.min(smoothstep(0, this.pitRamp, dIn), smoothstep(0, this.pitRamp, dOut));
      const edge = Math.max(0, safe(track.halfWidth[i], 6) - PIT_RAMP_EDGE_INSET);
      this.inPit[i] = 1;
      this.pitBlend[i] = f;
      this.pitLane[i] = this.pitSign * (edge + (full - edge) * f);
      this.pitStraight[i] = dIn >= this.pitRamp && dOut >= this.pitRamp ? 1 : 0;
      const dBox = Math.abs(((((s - track.pit.box) % track.length) + track.length * 1.5) % track.length) - track.length / 2);
      this.garage[i] = this.pitStraight[i] && dBox <= garageHalf ? 1 : 0;
    }

    // ── spatial grid (CSR) ──
    const b = track.bounds;
    this.gx0 = safe(b.minX, 0) - this.cell;
    this.gz0 = safe(b.minZ, 0) - this.cell;
    this.gnx = Math.max(1, Math.ceil((safe(b.maxX, 0) - this.gx0) / this.cell) + 2);
    this.gnz = Math.max(1, Math.ceil((safe(b.maxZ, 0) - this.gz0) / this.cell) + 2);
    const cells = this.gnx * this.gnz;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(track.px[i], track.pz[i]);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    const fill = Int32Array.from(counts.subarray(0, cells));
    this.cellItems = new Int32Array(n);
    for (let i = 0; i < n; i++) this.cellItems[fill[cellOf[i]]++] = i;

    // ── garage depth: shrink the block where another section of the lap runs behind the pit-side wall ──
    if (this.garage.some((g) => g > 0)) {
      const fit = new Float64Array(n).fill(GARAGE_DEPTH);
      for (let i = 0; i < n; i++) {
        if (!this.garage[i]) continue;
        const base = this.pitSign > 0 ? this.barrierR[i] : this.barrierL[i];
        let d = GARAGE_DEPTH;
        for (; d > GARAGE_MIN_DEPTH; d -= 2) {
          let clear = true;
          for (const q of [0.25, 0.5, 0.75, 1]) {
            const lat = this.pitSign * (base + d * q + 1.5);
            if (!this.isClearOfOther(track.px[i] + track.rx[i] * lat, track.pz[i] + track.rz[i] * lat, 0.5, i, 80)) clear = false;
          }
          if (clear) break;
        }
        fit[i] = Math.max(GARAGE_MIN_DEPTH, d);
      }
      // smooth steps: the lowest depth within ±3 samples
      for (let i = 0; i < n; i++) {
        if (!this.garage[i]) continue;
        let lo = fit[i];
        for (let k = -3; k <= 3; k++) lo = Math.min(lo, fit[(i + k + n) % n]);
        this.garageDepth[i] = lo;
      }
    }
  }

  private cellIndex(x: number, z: number): number {
    const cx = Math.min(this.gnx - 1, Math.max(0, Math.floor((x - this.gx0) / this.cell)));
    const cz = Math.min(this.gnz - 1, Math.max(0, Math.floor((z - this.gz0) / this.cell)));
    return cz * this.gnx + cx;
  }

  /** Nearest sample within `maxDist` (planar), or null. `skipDeck` ignores the upper road of a crossing. */
  nearestWithin(x: number, z: number, maxDist: number, skipDeck = false): NearestSample | null {
    if (this.n === 0 || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const r = Math.max(1, maxDist);
    const cx0 = Math.max(0, Math.floor((x - r - this.gx0) / this.cell));
    const cx1 = Math.min(this.gnx - 1, Math.floor((x + r - this.gx0) / this.cell));
    const cz0 = Math.max(0, Math.floor((z - r - this.gz0) / this.cell));
    const cz1 = Math.min(this.gnz - 1, Math.floor((z + r - this.gz0) / this.cell));
    let best = -1;
    let bestD = r * r;
    const t = this.track;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * this.gnx + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.cellItems[k];
          if (skipDeck && this.deck[i]) continue;
          const dx = x - t.px[i];
          const dz = z - t.pz[i];
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD) {
            bestD = d2;
            best = i;
          }
        }
      }
    }
    if (best < 0) return null;
    return { index: best, dist2: bestD, lateral: (x - t.px[best]) * t.rx[best] + (z - t.pz[best]) * t.rz[best] };
  }

  /**
   * Calls `visit(index, lateral)` for every non-deck sample within `maxDist` (planar) whose centre-line normal passes
   * within one sample spacing of the point (the sections that actually cover it), plus the nearest sample.
   */
  eachCovering(x: number, z: number, maxDist: number, visit: (index: number, lateral: number) => void): void {
    if (this.n === 0 || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const near = this.nearestWithin(x, z, maxDist, this.hasDeck);
    if (!near) return;
    visit(near.index, near.lateral);
    const t = this.track;
    const r = Math.max(1, maxDist);
    const alongMax = t.spacing * 1.5 + 0.5;
    const cx0 = Math.max(0, Math.floor((x - r - this.gx0) / this.cell));
    const cx1 = Math.min(this.gnx - 1, Math.floor((x + r - this.gx0) / this.cell));
    const cz0 = Math.max(0, Math.floor((z - r - this.gz0) / this.cell));
    const cz1 = Math.min(this.gnz - 1, Math.floor((z + r - this.gz0) / this.cell));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * this.gnx + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.cellItems[k];
          if (i === near.index || (this.hasDeck && this.deck[i])) continue;
          const dx = x - t.px[i];
          const dz = z - t.pz[i];
          if (Math.abs(dx * t.tx[i] + dz * t.tz[i]) > alongMax) continue;
          const lat = dx * t.rx[i] + dz * t.rz[i];
          if (Math.abs(lat) <= r) visit(i, lat);
        }
      }
    }
  }

  /**
   * Height (m) of the lowest deck underside (upper road of a crossing, `slab` m under its surface) above the point, or
   * Infinity when no deck covers it. `margin` widens each deck's occupied corridor.
   */
  deckUnderside(x: number, z: number, slab: number, margin: number): number {
    if (!this.hasDeck) return Infinity;
    const t = this.track;
    const r = 40;
    const cx0 = Math.max(0, Math.floor((x - r - this.gx0) / this.cell));
    const cx1 = Math.min(this.gnx - 1, Math.floor((x + r - this.gx0) / this.cell));
    const cz0 = Math.max(0, Math.floor((z - r - this.gz0) / this.cell));
    const cz1 = Math.min(this.gnz - 1, Math.floor((z + r - this.gz0) / this.cell));
    let low = Infinity;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * this.gnx + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.cellItems[k];
          if (!this.deck[i]) continue;
          const dx = x - t.px[i];
          const dz = z - t.pz[i];
          if (Math.abs(dx * t.tx[i] + dz * t.tz[i]) > t.spacing * 1.5 + 0.5) continue;
          const lat = dx * t.rx[i] + dz * t.rz[i];
          if (Math.abs(lat) < this.occupiedTo(i, lat >= 0 ? 1 : -1) + margin) low = Math.min(low, t.py[i] - slab);
        }
      }
    }
    return low;
  }

  /** Nearest sample anywhere. With `hint`, searches a local ±60 sample window first. */
  nearest(x: number, z: number, hint?: number): NearestSample {
    const t = this.track;
    if (this.n === 0) return { index: 0, dist2: 0, lateral: 0 };
    if (hint !== undefined && Number.isInteger(hint) && hint >= 0 && hint < this.n) {
      let best = hint;
      let bestD = Infinity;
      for (let k = -60; k <= 60; k++) {
        const i = (hint + k + this.n) % this.n;
        const dx = x - t.px[i];
        const dz = z - t.pz[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          best = i;
        }
      }
      if (bestD < 900) return { index: best, dist2: bestD, lateral: (x - t.px[best]) * t.rx[best] + (z - t.pz[best]) * t.rz[best] };
    }
    const local = this.nearestWithin(x, z, 120);
    if (local) return local;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.n; i++) {
      const dx = x - t.px[i];
      const dz = z - t.pz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    return { index: best, dist2: bestD, lateral: (x - t.px[best]) * t.rx[best] + (z - t.pz[best]) * t.rz[best] };
  }

  /** Visual barrier distance on the side of `lateral` (positive). */
  barrierAt(i: number, lateral: number): number {
    const k = ((i % this.n) + this.n) % this.n;
    return lateral >= 0 ? this.barrierR[k] : this.barrierL[k];
  }

  /**
   * Outer boundary (positive lateral distance) of everything the track occupies at sample i on the side of
   * `sign` (+1 right, -1 left): barrier, or pit complex incl. garages on the pit side.
   */
  occupiedTo(i: number, sign: number): number {
    const k = ((i % this.n) + this.n) % this.n;
    const base = sign >= 0 ? this.barrierR[k] : this.barrierL[k];
    if (this.inPit[k] && sign === this.pitSign) {
      const lane = Math.abs(this.pitLane[k]) + PIT_LANE_HALF + 0.5;
      return Math.max(base, lane) + (this.garage[k] ? this.garageDepth[k] + 6 : 0);
    }
    return base;
  }

  /**
   * True if no section of the lap that is more than `minLoop` metres (along the lap) away from sample `k` occupies the
   * point (corridor + `margin`): the crossing road under a bridge deck, ignoring the deck's own approaches.
   */
  isClearOfOther(x: number, z: number, margin: number, k: number, minLoop: number): boolean {
    const t = this.track;
    const r = 90 + margin;
    const cx0 = Math.max(0, Math.floor((x - r - this.gx0) / this.cell));
    const cx1 = Math.min(this.gnx - 1, Math.floor((x + r - this.gx0) / this.cell));
    const cz0 = Math.max(0, Math.floor((z - r - this.gz0) / this.cell));
    const cz1 = Math.min(this.gnz - 1, Math.floor((z + r - this.gz0) / this.cell));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * this.gnx + cx;
        for (let m = this.cellStart[c]; m < this.cellStart[c + 1]; m++) {
          const i = this.cellItems[m];
          const dLoop = Math.abs(i - k) * t.spacing;
          if (Math.min(dLoop, t.length - dLoop) < minLoop) continue;
          const dx = x - t.px[i];
          const dz = z - t.pz[i];
          const along = dx * t.tx[i] + dz * t.tz[i];
          if (Math.abs(along) > t.spacing * 1.5 + 0.5) continue;
          const lat = dx * t.rx[i] + dz * t.rz[i];
          if (Math.abs(lat) < this.occupiedTo(i, lat >= 0 ? 1 : -1) + margin) return false;
        }
      }
    }
    return true;
  }

  /**
   * True if the point is clear of every track section by at least `margin` metres beyond the occupied corridor.
   */
  isClear(x: number, z: number, margin: number): boolean {
    const near = this.nearestWithin(x, z, 90 + margin);
    if (!near) return true;
    // check the few closest candidates around the nearest one, plus any other section in range
    const t = this.track;
    const r = 90 + margin;
    const cx0 = Math.max(0, Math.floor((x - r - this.gx0) / this.cell));
    const cx1 = Math.min(this.gnx - 1, Math.floor((x + r - this.gx0) / this.cell));
    const cz0 = Math.max(0, Math.floor((z - r - this.gz0) / this.cell));
    const cz1 = Math.min(this.gnz - 1, Math.floor((z + r - this.gz0) / this.cell));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * this.gnx + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.cellItems[k];
          const dx = x - t.px[i];
          const dz = z - t.pz[i];
          const along = dx * t.tx[i] + dz * t.tz[i];
          if (Math.abs(along) > t.spacing * 1.5 + 0.5) continue;
          const lat = dx * t.rx[i] + dz * t.rz[i];
          const lim = this.occupiedTo(i, lat >= 0 ? 1 : -1) + margin;
          if (Math.abs(lat) < lim) return false;
        }
      }
    }
    return true;
  }
}

function safe(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) ? v : fallback;
}

