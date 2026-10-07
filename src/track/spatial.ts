/**
 * Uniform spatial hash (CSR layout) over a subset of track samples on the XZ plane.
 * Used for global projection, barrier clamping and terrain height blending.
 */

export class SampleGrid {
  readonly cellSize: number;
  readonly minX: number;
  readonly minZ: number;
  readonly nx: number;
  readonly nz: number;
  private readonly px: ArrayLike<number>;
  private readonly pz: ArrayLike<number>;
  private readonly cellStart: Int32Array;
  private readonly items: Int32Array;

  /**
   * @param px sample X coordinates
   * @param pz sample Z coordinates
   * @param cellSize cell edge (m)
   * @param stride index only every `stride`-th sample (≥ 1)
   * @param skip optional per-sample flags; samples with a non-zero flag are not indexed
   */
  constructor(px: ArrayLike<number>, pz: ArrayLike<number>, cellSize: number, stride = 1, skip?: ArrayLike<number>) {
    this.px = px;
    this.pz = pz;
    this.cellSize = Math.max(1, cellSize);
    const n = px.length;
    const step = Math.max(1, Math.floor(stride));
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
      if (pz[i] < minZ) minZ = pz[i];
      if (pz[i] > maxZ) maxZ = pz[i];
    }
    if (n === 0) {
      minX = 0;
      minZ = 0;
      maxX = 0;
      maxZ = 0;
    }
    this.minX = minX;
    this.minZ = minZ;
    this.nx = Math.max(1, Math.floor((maxX - minX) / this.cellSize) + 1);
    this.nz = Math.max(1, Math.floor((maxZ - minZ) / this.cellSize) + 1);
    const cells = this.nx * this.nz;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i += step) {
      if (skip && skip[i]) continue;
      const c = this.cellIndex(px[i], pz[i]);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    const fill = Int32Array.from(counts.subarray(0, cells));
    this.items = new Int32Array(counts[cells]);
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      if (c >= 0) this.items[fill[c]++] = i;
    }
  }

  private cellIndex(x: number, z: number): number {
    const cx = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)));
    const cz = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / this.cellSize)));
    return cz * this.nx + cx;
  }

  /** Visit every indexed sample within `radius` of (x, z). Callback receives index and squared distance. */
  forEachInRadius(x: number, z: number, radius: number, visit: (index: number, d2: number) => void): void {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(radius > 0)) return;
    const r2 = radius * radius;
    const cx0 = Math.floor((x - radius - this.minX) / this.cellSize);
    const cx1 = Math.floor((x + radius - this.minX) / this.cellSize);
    const cz0 = Math.floor((z - radius - this.minZ) / this.cellSize);
    const cz1 = Math.floor((z + radius - this.minZ) / this.cellSize);
    const ax = Math.max(0, cx0);
    const bx = Math.min(this.nx - 1, cx1);
    const az = Math.max(0, cz0);
    const bz = Math.min(this.nz - 1, cz1);
    for (let cz = az; cz <= bz; cz++) {
      for (let cx = ax; cx <= bx; cx++) {
        const c = cz * this.nx + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.items[k];
          const dx = this.px[i] - x;
          const dz = this.pz[i] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= r2) visit(i, d2);
        }
      }
    }
  }

  /** Nearest indexed sample to (x, z) via an expanding ring search. Returns -1 only for an empty grid. */
  nearest(x: number, z: number): number {
    if (this.items.length === 0 || !Number.isFinite(x) || !Number.isFinite(z)) return -1;
    const qx = Math.floor((x - this.minX) / this.cellSize);
    const qz = Math.floor((z - this.minZ) / this.cellSize);
    // distance from the query cell to the grid; rings closer than this are empty
    const outside = Math.max(0, -qx, qx - (this.nx - 1), -qz, qz - (this.nz - 1));
    const maxRing = outside + Math.max(this.nx, this.nz);
    let best = -1;
    let bestD2 = Infinity;
    for (let ring = outside; ring <= maxRing; ring++) {
      for (let cz = qz - ring; cz <= qz + ring; cz++) {
        if (cz < 0 || cz >= this.nz) continue;
        const edgeRow = cz === qz - ring || cz === qz + ring;
        const stepX = edgeRow ? 1 : 2 * ring;
        for (let cx = qx - ring; cx <= qx + ring; cx += Math.max(1, stepX)) {
          if (cx < 0 || cx >= this.nx) continue;
          const c = cz * this.nx + cx;
          for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
            const i = this.items[k];
            const dx = this.px[i] - x;
            const dz = this.pz[i] - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = i;
            }
          }
        }
      }
      // every cell of the next ring is at least `ring` cells away from the query point
      if (best >= 0) {
        const reach = ring * this.cellSize;
        if (bestD2 <= reach * reach) break;
      }
    }
    return best;
  }
}
