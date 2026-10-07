/**
 * Racing-line overlay: a thin ribbon at track.racingLine coloured from the reference speed profile —
 * green = accelerating, yellow = coasting / constant speed, red = braking. 'corners' mode shows only
 * braking zones and corners (track.corners ranges), 'full' shows the whole lap.
 */
import * as THREE from 'three';
import type { RacingLineMode } from '../../core/types';
import { inRangeS } from '../../track/track';
import { GeoBuilder } from '../core/geometry';
import { sidePoint, wrapIndex, type SceneryContext } from './context';

const GREEN = new THREE.Color('#29d16a');
const YELLOW = new THREE.Color('#ffd42a');
const RED = new THREE.Color('#ff3030');

export class RacingLineOverlay {
  readonly group = new THREE.Group();
  private readonly full: THREE.Mesh | null;
  private readonly corners: THREE.Mesh | null;

  constructor(ctx: SceneryContext, mode: RacingLineMode) {
    const { track: t, disposer } = ctx;
    const n = t.count;
    this.group.name = 'racingLine';
    const accel = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = t.speedProfile[i];
      const dv = t.speedProfile[wrapIndex(i + 1, n)] - t.speedProfile[wrapIndex(i - 1, n)];
      const a = (v * dv) / Math.max(0.01, 2 * t.spacing);
      accel[i] = Number.isFinite(a) ? a : 0;
    }
    // light smoothing so colours do not flicker
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -3; k <= 3; k++) s += accel[wrapIndex(i + k, n)];
      sm[i] = s / 7;
    }
    const colorAt = (i: number, out: THREE.Color): THREE.Color => {
      const a = sm[i];
      if (a < -2.5) return out.copy(YELLOW).lerp(RED, Math.min(1, (-a - 2.5) / 4));
      if (a > 0.6) return out.copy(YELLOW).lerp(GREEN, Math.min(1, (a - 0.6) / 1.5));
      return out.copy(YELLOW);
    };
    const inCorner = (i: number): boolean => {
      if (sm[i] < -2.5) return true;
      const s = t.s[i];
      return t.corners.some((c) => inRangeS(t, s, c.startS - 10, c.endS + 10));
    };
    const material = disposer.add(
      new THREE.MeshBasicMaterial({
        name: 'racing-line',
        vertexColors: true,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -8,
        toneMapped: false,
      }),
    );
    const build = (include: (i: number) => boolean): THREE.Mesh | null => {
      const b = new GeoBuilder(true);
      const c = new THREE.Color();
      const p = new THREE.Vector3();
      const q = new THREE.Vector3();
      let prev = -1;
      for (let j = 0; j <= n; j++) {
        const i = wrapIndex(j, n);
        const ip = wrapIndex(j - 1, n);
        const on = include(i) || include(ip);
        if (!on) {
          prev = -1;
          continue;
        }
        const lat = Number.isFinite(t.racingLine[i]) ? t.racingLine[i] : 0;
        sidePoint(t, i, lat - 0.28, 0.03, p);
        sidePoint(t, i, lat + 0.28, 0.03, q);
        b.setColor(colorAt(i, c));
        const row = b.vertex(p.x, p.y, p.z, 0, 1, 0, 0, 0);
        b.vertex(q.x, q.y, q.z, 0, 1, 0, 1, 0);
        if (prev >= 0) b.quad(prev, prev + 1, row + 1, row);
        prev = row;
      }
      const g = b.build();
      if (!g) return null;
      disposer.add(g);
      const m = new THREE.Mesh(g, material);
      m.renderOrder = 2;
      m.frustumCulled = true;
      this.group.add(m);
      return m;
    };
    this.full = build(() => true);
    this.corners = build(inCorner);
    this.setMode(mode);
  }

  setMode(mode: RacingLineMode): void {
    if (this.full) this.full.visible = mode === 'full';
    if (this.corners) this.corners.visible = mode === 'corners';
  }
}
