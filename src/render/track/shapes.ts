/**
 * Solid-shape primitives for landmark architecture, merged into GeoBuilders: oriented frusta / parallelepipeds,
 * square beams, surfaces of revolution (towers, domes, fountains) and icospheres. All faces are wound outwards.
 */
import * as THREE from 'three';
import { GeoBuilder } from '../core/geometry';

const _n = new THREE.Vector3();
const _e = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Vector3();

/** Flat quad p0..p3 wound so its normal points away from `centre`. */
export function quadAway(b: GeoBuilder, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, centre: THREE.Vector3, u1 = 1, v1 = 1): void {
  _n.subVectors(p1, p0).cross(_e.subVectors(p3, p0));
  _c.set((p0.x + p1.x + p2.x + p3.x) / 4 - centre.x, (p0.y + p1.y + p2.y + p3.y) / 4 - centre.y, (p0.z + p1.z + p2.z + p3.z) / 4 - centre.z);
  if (_n.dot(_c) >= 0) b.flatQuad(p0, p1, p2, p3, 0, 0, u1, v1);
  else b.flatQuad(p0, p3, p2, p1, 0, 0, u1, v1);
}

export interface FrustumOptions {
  /** also emit the bottom face (default: the base sits on the ground or inside a foundation) */
  bottom?: boolean;
  /** facade texture tile in metres [u, v]: side faces get repeating UVs (top / bottom → one texel) */
  uvTile?: readonly [number, number];
}

/**
 * Convex solid between two quadrilateral rings (4 corners each, same order, counter-clockwise or clockwise alike):
 * a box, a tapered tower, a tilted slab.
 */
export function frustum(b: GeoBuilder, bottom: readonly THREE.Vector3[], top: readonly THREE.Vector3[], opts: FrustumOptions = {}): void {
  _m.set(0, 0, 0);
  for (const p of bottom) _m.add(p);
  for (const p of top) _m.add(p);
  _m.multiplyScalar(1 / 8);
  const centre = _m.clone();
  const tile = opts.uvTile;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const w = bottom[i].distanceTo(bottom[j]);
    const h = (bottom[i].distanceTo(top[i]) + bottom[j].distanceTo(top[j])) / 2;
    if (tile) quadAway(b, bottom[i], bottom[j], top[j], top[i], centre, w / tile[0], h / tile[1]);
    else quadAway(b, bottom[i], bottom[j], top[j], top[i], centre);
  }
  const flat = (r: readonly THREE.Vector3[]): void => {
    if (tile) {
      const before = b.vertexCount;
      quadAway(b, r[0], r[1], r[2], r[3], centre, 0.0001, 0.0001);
      for (let i = before; i < b.vertexCount; i++) {
        b.uvs[i * 2] = 0.01;
        b.uvs[i * 2 + 1] = 0.01;
      }
    } else quadAway(b, r[0], r[1], r[2], r[3], centre);
  };
  flat(top);
  if (opts.bottom) flat(bottom);
}

const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _ring0: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _ring1: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _Y = new THREE.Vector3(0, 1, 0);
const _X = new THREE.Vector3(1, 0, 0);

/** Square beam of side `w` (and `h` when given) from a to c; the four long faces only (end caps are never seen). */
export function beam(b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, w: number, h = w): void {
  _d.subVectors(c, a);
  if (_d.lengthSq() < 1e-8) return;
  _d.normalize();
  _u.crossVectors(_d, Math.abs(_d.y) > 0.95 ? _X : _Y).normalize();
  _v.crossVectors(_d, _u).normalize();
  const hw = w / 2;
  const hh = h / 2;
  const corner = (o: THREE.Vector3, i: number, out: THREE.Vector3): THREE.Vector3 => {
    const su = i === 0 || i === 3 ? -1 : 1;
    const sv = i < 2 ? -1 : 1;
    return out.set(o.x + _u.x * hw * su + _v.x * hh * sv, o.y + _u.y * hw * su + _v.y * hh * sv, o.z + _u.z * hw * su + _v.z * hh * sv);
  };
  for (let i = 0; i < 4; i++) {
    corner(a, i, _ring0[i]);
    corner(c, i, _ring1[i]);
  }
  _m.addVectors(a, c).multiplyScalar(0.5);
  const centre = _m.clone();
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quadAway(b, _ring0[i], _ring0[j], _ring1[j], _ring1[i], centre);
  }
}

/**
 * Surface of revolution about the vertical axis through (x, z), base height y0. `profile` = (radius, height) points walked
 * so the outside is on the right (bottom to top for a tower; a dome goes out, up, then in). Smooth radial normals.
 */
export function lathe(b: GeoBuilder, x: number, y0: number, z: number, profile: readonly (readonly [number, number])[], seg = 10): void {
  const rows = profile.length;
  if (rows < 2) return;
  const base = b.vertexCount;
  for (let i = 0; i < rows; i++) {
    const [r, y] = profile[i];
    const p = profile[Math.max(0, i - 1)];
    const q = profile[Math.min(rows - 1, i + 1)];
    const dr = q[0] - p[0];
    const dy = q[1] - p[1];
    const inv = 1 / (Math.hypot(dr, dy) || 1);
    const nr = dy * inv;
    const ny = -dr * inv;
    for (let a = 0; a <= seg; a++) {
      const ang = (a / seg) * Math.PI * 2;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      b.vertex(x + c * r, y0 + y, z + s * r, c * nr, ny, s * nr, a / seg, y / 8);
    }
  }
  const rowLen = seg + 1;
  for (let i = 0; i + 1 < rows; i++) {
    for (let a = 0; a < seg; a++) {
      const p0 = base + i * rowLen + a;
      const q0 = base + (i + 1) * rowLen + a;
      // (P_a, Q_a, Q_a+1, P_a+1): outward for a profile walked with the outside on its right (see addCylinderY)
      b.quad(p0, q0, q0 + 1, p0 + 1);
    }
  }
}

/** Icosphere with a colour per triangle (`color(centroid)`), smooth normals. */
export function icosphere(b: GeoBuilder, cx: number, cy: number, cz: number, r: number, detail: number, color: (c: THREE.Vector3, face: number) => THREE.Color): void {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const pos = g.getAttribute('position');
  const cen = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let f = 0; f * 3 < pos.count; f++) {
    cen.set(0, 0, 0);
    for (let k = 0; k < 3; k++) cen.add(p.fromBufferAttribute(pos, f * 3 + k));
    cen.multiplyScalar(1 / 3);
    b.setColor(color(cen, f));
    const base = b.vertexCount;
    for (let k = 0; k < 3; k++) {
      p.fromBufferAttribute(pos, f * 3 + k);
      b.vertex(cx + p.x, cy + p.y, cz + p.z, p.x / r, p.y / r, p.z / r, 0, 0);
    }
    b.tri(base, base + 1, base + 2);
  }
  g.dispose();
}
