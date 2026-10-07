/**
 * Low-level geometry construction: an indexed BufferGeometry builder with optional vertex colours,
 * plus oriented boxes / cylinders used for merged static trackside structures.
 */
import * as THREE from 'three';

export class GeoBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  private cr = 1;
  private cg = 1;
  private cb = 1;

  constructor(readonly withColor = false) {}

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Current vertex colour for subsequent vertices (linear-space THREE.Color). */
  setColor(c: THREE.Color): this {
    this.cr = c.r;
    this.cg = c.g;
    this.cb = c.b;
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.positions.push(fin(x), fin(y), fin(z));
    this.normals.push(fin(nx), fin(ny), fin(nz));
    this.uvs.push(fin(u), fin(v));
    if (this.withColor) this.colors.push(this.cr, this.cg, this.cb);
    return this.positions.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** Quad a-b-c-d (counter-clockwise when seen from the front). */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  /** Flat quad from 4 corners (CCW seen from the front), normal computed from the corners. */
  flatQuad(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, u0 = 0, v0 = 0, u1 = 1, v1 = 1): void {
    const n = _n.subVectors(p1, p0).cross(_t.subVectors(p3, p0));
    if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
    n.normalize();
    const a = this.vertex(p0.x, p0.y, p0.z, n.x, n.y, n.z, u0, v0);
    const b = this.vertex(p1.x, p1.y, p1.z, n.x, n.y, n.z, u1, v0);
    const c = this.vertex(p2.x, p2.y, p2.z, n.x, n.y, n.z, u1, v1);
    const d = this.vertex(p3.x, p3.y, p3.z, n.x, n.y, n.z, u0, v1);
    this.quad(a, b, c, d);
  }

  /** Returns null when nothing was added. */
  build(computeNormals = false): THREE.BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (this.withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.setIndex(this.indices);
    if (computeNormals) g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/**
 * Oriented box: centre (cx, cy, cz), rotated by `yaw` about Y (same convention as cars: local +Z = forward).
 * w = local X extent, h = Y extent, d = local Z extent. UVs are in metres × uvScale.
 */
export function addBox(
  b: GeoBuilder,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
  w: number,
  h: number,
  d: number,
  uvScale = 1,
  skipBottom = true,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // local X axis -> (c, 0, -s); local Z axis -> (s, 0, c)
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const corner = (lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c);
  const face = (
    a: [number, number, number],
    bb: [number, number, number],
    cc: [number, number, number],
    dd: [number, number, number],
    uw: number,
    vh: number,
  ): void => {
    corner(a[0], a[1], a[2], _p[0]);
    corner(bb[0], bb[1], bb[2], _p[1]);
    corner(cc[0], cc[1], cc[2], _p[2]);
    corner(dd[0], dd[1], dd[2], _p[3]);
    b.flatQuad(_p[0], _p[1], _p[2], _p[3], 0, 0, uw * uvScale, vh * uvScale);
  };
  // +Z (front)
  face([-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], w, h);
  // -Z (back)
  face([hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], w, h);
  // +X
  face([hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], d, h);
  // -X
  face([-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], d, h);
  // top
  face([-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz], w, d);
  if (!skipBottom) face([-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], w, d);
}

/** Vertical cylinder from y0 to y0 + h (open bottom). */
export function addCylinderY(b: GeoBuilder, x: number, y0: number, z: number, r: number, h: number, seg = 8, capTop = true): void {
  const n = Math.max(3, seg);
  const base = b.vertexCount;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const cx = Math.cos(a);
    const sz = Math.sin(a);
    b.vertex(x + cx * r, y0, z + sz * r, cx, 0, sz, i / n, 0);
    b.vertex(x + cx * r, y0 + h, z + sz * r, cx, 0, sz, i / n, 1);
  }
  for (let i = 0; i < n; i++) {
    const a0 = base + i * 2;
    const a1 = a0 + 2;
    // outward winding: (bottom i, top i, top i+1, bottom i+1) seen from outside is clockwise -> reverse
    b.quad(a0, a0 + 1, a1 + 1, a1);
  }
  if (capTop) {
    const centre = b.vertex(x, y0 + h, z, 0, 1, 0, 0.5, 0.5);
    const ring: number[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push(b.vertex(x + Math.cos(a) * r, y0 + h, z + Math.sin(a) * r, 0, 1, 0, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5));
    }
    for (let i = 0; i < n; i++) b.tri(centre, ring[i + 1], ring[i]);
  }
}

/** Append a three.js geometry (any indexed/non-indexed) into a builder with a transform. */
export function addGeometry(b: GeoBuilder, geom: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
  const pos = geom.getAttribute('position');
  const nor = geom.getAttribute('normal');
  const uv = geom.getAttribute('uv');
  if (!pos) return;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const base = b.vertexCount;
  const v = new THREE.Vector3();
  const nn = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    if (nor) nn.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
    else nn.set(0, 1, 0);
    b.vertex(v.x, v.y, v.z, nn.x, nn.y, nn.z, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
  }
  const index = geom.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) b.tri(base + index.getX(i), base + index.getX(i + 1), base + index.getX(i + 2));
  } else {
    for (let i = 0; i < pos.count; i += 3) b.tri(base + i, base + i + 1, base + i + 2);
  }
}
