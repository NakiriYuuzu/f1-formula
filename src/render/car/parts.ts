/**
 * PartList: collects car part geometries, assigns atlas UVs per triangle (body wrap, colour swatches,
 * fin panel, helmet wrap or keyed strips), optionally mirrors parts to the other side, and merges
 * everything into one non-indexed BufferGeometry (position, normal, uv) — one draw call per mesh.
 */
import * as THREE from 'three';
import { finUV, helmetUV, swatchUV, wrapUV, BODY_V0, type Swatch } from './atlas';
import type { CarDims } from './dims';

export type UVMap =
  /** body wrap around a long axis whose height `axisY(z)` follows the body sections */
  | { kind: 'wrap'; axisY: (z: number) => number }
  | { kind: 'swatch'; name: Swatch }
  | { kind: 'fin' }
  | { kind: 'helmet'; centre: THREE.Vector3 }
  /** per-vertex `key` attribute (from revolve) -> fixed UV per key */
  | { kind: 'keyed'; keys: string[]; uv: Record<string, [number, number]> };

export class PartList {
  private readonly parts: THREE.BufferGeometry[] = [];

  constructor(private readonly dims: CarDims) {}

  get size(): number {
    return this.parts.length;
  }

  /** Add a part (the input geometry is consumed/disposed). `mirror` also adds a copy reflected across x = 0. */
  add(geom: THREE.BufferGeometry, map: UVMap, mirror = false): void {
    const flat = geom.index ? geom.toNonIndexed() : geom;
    if (flat !== geom) geom.dispose();
    if (!flat.getAttribute('normal')) flat.computeVertexNormals();
    this.parts.push(this.mapped(flat, map));
    if (mirror) {
      const m = flat.clone();
      reflectX(m);
      this.parts.push(this.mapped(m, map));
      m.dispose();
    }
    flat.dispose();
  }

  /** Merge all parts; returns an empty-safe geometry (a degenerate triangle if nothing was added). */
  build(): THREE.BufferGeometry {
    const out = new THREE.BufferGeometry();
    let count = 0;
    for (const p of this.parts) count += p.getAttribute('position').count;
    const pos = new Float32Array(Math.max(3, count) * 3);
    const nor = new Float32Array(Math.max(3, count) * 3);
    const uv = new Float32Array(Math.max(3, count) * 2);
    let o = 0;
    for (const p of this.parts) {
      const pa = p.getAttribute('position');
      const na = p.getAttribute('normal');
      const ua = p.getAttribute('uv');
      for (let i = 0; i < pa.count; i++, o++) {
        pos[o * 3] = pa.getX(i);
        pos[o * 3 + 1] = pa.getY(i);
        pos[o * 3 + 2] = pa.getZ(i);
        nor[o * 3] = na.getX(i);
        nor[o * 3 + 1] = na.getY(i);
        nor[o * 3 + 2] = na.getZ(i);
        uv[o * 2] = ua.getX(i);
        uv[o * 2 + 1] = ua.getY(i);
      }
      p.dispose();
    }
    this.parts.length = 0;
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    sanitize(out);
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
  }

  private mapped(src: THREE.BufferGeometry, map: UVMap): THREE.BufferGeometry {
    const pos = src.getAttribute('position');
    const nor = src.getAttribute('normal');
    const inner = src.getAttribute('inner');
    const key = src.getAttribute('key');
    const n = pos.count - (pos.count % 3);
    const uv = new Float32Array(n * 2);
    const d = this.dims;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const fn = new THREE.Vector3();
    const black = swatchUV('black');
    const carbon = swatchUV('carbon');
    for (let t = 0; t < n; t += 3) {
      a.fromBufferAttribute(pos, t);
      b.fromBufferAttribute(pos, t + 1);
      c.fromBufferAttribute(pos, t + 2);
      const set = (k: number, u: number, v: number): void => {
        uv[(t + k) * 2] = u;
        uv[(t + k) * 2 + 1] = v;
      };
      switch (map.kind) {
        case 'swatch': {
          const [u, v] = swatchUV(map.name);
          for (let k = 0; k < 3; k++) set(k, u, v);
          break;
        }
        case 'wrap': {
          const isInner = inner ? inner.getX(t) > 0.5 || inner.getX(t + 1) > 0.5 || inner.getX(t + 2) > 0.5 : false;
          if (isInner) {
            for (let k = 0; k < 3; k++) set(k, black[0], black[1]);
            break;
          }
          if (Math.abs(a.z - b.z) < 1e-6 && Math.abs(a.z - c.z) < 1e-6) {
            // flat end cap (fan around the axis): one colour, the section's top-centre paint at that z
            const top = wrapUV(d, 0, 1, a.z, 0);
            for (let k = 0; k < 3; k++) set(k, top[0], top[1]);
            break;
          }
          const ua = wrapUV(d, a.x, a.y, a.z, map.axisY(a.z));
          const ub = wrapUV(d, b.x, b.y, b.z, map.axisY(b.z));
          const uc = wrapUV(d, c.x, c.y, c.z, map.axisY(c.z));
          const vSpan = Math.max(ua[1], ub[1], uc[1]) - Math.min(ua[1], ub[1], uc[1]);
          if (vSpan > (1 - BODY_V0) * 0.5) {
            // triangle straddles the underside seam: paint it carbon
            for (let k = 0; k < 3; k++) set(k, carbon[0], carbon[1]);
          } else {
            set(0, ua[0], ua[1]);
            set(1, ub[0], ub[1]);
            set(2, uc[0], uc[1]);
          }
          break;
        }
        case 'fin': {
          fn.subVectors(b, a).cross(c.clone().sub(a));
          let right = fn.x < 0;
          if (fn.lengthSq() < 1e-14 && nor) right = nor.getX(t) < 0;
          const ua = finUV(d, a.y, a.z, right);
          const ub = finUV(d, b.y, b.z, right);
          const uc = finUV(d, c.y, c.z, right);
          set(0, ua[0], ua[1]);
          set(1, ub[0], ub[1]);
          set(2, uc[0], uc[1]);
          break;
        }
        case 'helmet': {
          const ce = map.centre;
          const ua = helmetUV(a.x - ce.x, a.y - ce.y, a.z - ce.z);
          const ub = helmetUV(b.x - ce.x, b.y - ce.y, b.z - ce.z);
          const uc = helmetUV(c.x - ce.x, c.y - ce.y, c.z - ce.z);
          const uSpan = Math.max(ua[0], ub[0], uc[0]) - Math.min(ua[0], ub[0], uc[0]);
          if (uSpan > 0.5) {
            // longitude seam at the back of the helmet: collapse to one column
            set(0, ua[0], ua[1]);
            set(1, ua[0], ub[1]);
            set(2, ua[0], uc[1]);
          } else {
            set(0, ua[0], ua[1]);
            set(1, ub[0], ub[1]);
            set(2, uc[0], uc[1]);
          }
          break;
        }
        case 'keyed': {
          for (let k = 0; k < 3; k++) {
            const ki = key ? Math.round(key.getX(t + k)) : 0;
            const name = map.keys[ki] ?? map.keys[0];
            const v = map.uv[name] ?? [0.5, 0.5];
            set(k, v[0], v[1]);
          }
          break;
        }
      }
    }
    const out = new THREE.BufferGeometry();
    const p = new Float32Array(n * 3);
    const nn = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      p[i * 3] = pos.getX(i);
      p[i * 3 + 1] = pos.getY(i);
      p[i * 3 + 2] = pos.getZ(i);
      nn[i * 3] = nor ? nor.getX(i) : 0;
      nn[i * 3 + 1] = nor ? nor.getY(i) : 1;
      nn[i * 3 + 2] = nor ? nor.getZ(i) : 0;
    }
    out.setAttribute('position', new THREE.BufferAttribute(p, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return out;
  }
}

/** Reflect a non-indexed geometry across x = 0 and restore CCW winding. */
export function reflectX(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, -pos.getX(i));
    if (nor) nor.setX(i, -nor.getX(i));
  }
  // swap vertices 1 and 2 of every triangle for every attribute
  for (const name of Object.keys(g.attributes)) {
    const attr = g.getAttribute(name);
    const size = attr.itemSize;
    for (let t = 0; t + 2 < attr.count; t += 3) {
      for (let k = 0; k < size; k++) {
        const v1 = attr.getComponent(t + 1, k);
        attr.setComponent(t + 1, k, attr.getComponent(t + 2, k));
        attr.setComponent(t + 2, k, v1);
      }
    }
    attr.needsUpdate = true;
  }
}

/** Replace any non-finite component with 0 and re-normalise normals (defensive). */
function sanitize(g: THREE.BufferGeometry): void {
  for (const name of ['position', 'normal', 'uv']) {
    const attr = g.getAttribute(name);
    if (!attr) continue;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) arr[i] = 0;
  }
  const nor = g.getAttribute('normal');
  if (nor) {
    for (let i = 0; i < nor.count; i++) {
      const x = nor.getX(i);
      const y = nor.getY(i);
      const z = nor.getZ(i);
      const l = Math.hypot(x, y, z);
      if (l < 1e-6) nor.setXYZ(i, 0, 1, 0);
      else nor.setXYZ(i, x / l, y / l, z / l);
    }
  }
}
