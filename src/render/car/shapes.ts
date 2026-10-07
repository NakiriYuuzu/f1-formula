/**
 * Procedural shape primitives for the car model: superellipse lofts (with an optional open cockpit
 * U-section), revolved profiles (tyres / rims), airfoil wing elements, rods between two points and
 * extruded side plates. All functions return indexed or non-indexed THREE.BufferGeometry with
 * position + normal (UVs are assigned later by the PartList atlas mapper).
 */
import * as THREE from 'three';

export interface LoftStation {
  z: number;
  /** half width */
  hw: number;
  /** bottom / top y */
  yb: number;
  yt: number;
  /** centre x (default 0) */
  xc?: number;
  /** superellipse exponent (2 = ellipse, larger = boxier); default 2.6 */
  n?: number;
  /** cockpit opening depth below the top surface (0 = closed). Only used when LoftOptions.cutHalfWidth is set. */
  cut?: number;
  /**
   * Undercut 0..1: the lower half of the section is narrowed and pulled towards the car centreline (xc > 0 pulls
   * towards -X, xc < 0 towards +X), like a sidepod tucked in above the floor. Ignored with a cockpit cut.
   */
  tuck?: number;
}

export interface LoftOptions {
  /** points along the outer contour */
  segments: number;
  /** enables the open-top U section with this opening half-width */
  cutHalfWidth?: number;
  cutSegments?: number;
  capStart?: boolean;
  capEnd?: boolean;
}

const sgnPow = (a: number, p: number): number => Math.sign(a) * Math.pow(Math.abs(a), p);

/**
 * Loft through superellipse sections (stations sorted by increasing z). Rings are CCW when viewed from +z,
 * which (with the quad order used) yields outward normals. Adds a float attribute `inner` (1 = cockpit
 * interior wall) for the UV mapper.
 */
export function loft(stations: LoftStation[], opts: LoftOptions): THREE.BufferGeometry {
  const st = [...stations].sort((a, b) => a.z - b.z);
  const rings: { x: number; y: number; inner: number }[][] = [];
  const cw = opts.cutHalfWidth ?? 0;
  const M = Math.max(6, opts.segments | 0);
  const Mi = Math.max(4, opts.cutSegments ?? 8);
  for (const s of st) {
    const n = s.n ?? 2.6;
    const xc = s.xc ?? 0;
    const hw = Math.max(1e-4, s.hw);
    const hh = Math.max(1e-4, (s.yt - s.yb) / 2);
    const yc = (s.yb + s.yt) / 2;
    const tuck = s.tuck ?? 0;
    const ring: { x: number; y: number; inner: number }[] = [];
    if (cw > 0) {
      const c = Math.min(cw, hw * 0.92);
      const t0 = Math.acos(Math.min(1, Math.pow(c / hw, n / 2)));
      const yOuter = (x: number): number => yc + hh * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / hw, n)), 1 / n);
      // clockwise (seen from +z): outer contour from top-left rim around the bottom to top-right rim
      const cwRing: { x: number; y: number; inner: number }[] = [];
      for (let j = 0; j <= M; j++) {
        const t = t0 - (j / M) * (Math.PI + 2 * t0);
        cwRing.push({ x: xc + hw * sgnPow(Math.cos(t), 2 / n), y: yc + hh * sgnPow(Math.sin(t), 2 / n), inner: 0 });
      }
      const depth = Math.max(0, Math.min(s.cut ?? 0, (s.yt - s.yb) * 0.85));
      const d = Math.min(0.02, c * 0.2);
      for (let k = 0; k <= Mi; k++) {
        let x: number;
        let dep: number;
        if (k === 0) {
          x = -c;
          dep = 0;
        } else if (k === Mi) {
          x = c;
          dep = 0;
        } else {
          x = -c + d + ((2 * c - 2 * d) * (k - 1)) / Math.max(1, Mi - 2);
          dep = depth;
        }
        cwRing.push({ x: xc + x, y: yOuter(x) - dep, inner: depth > 0 ? 1 : 0 });
      }
      cwRing.reverse();
      ring.push(...cwRing);
    } else {
      for (let j = 0; j <= M; j++) {
        const t = -Math.PI / 2 + (j / M) * Math.PI * 2;
        const cx = sgnPow(Math.cos(t), 2 / n);
        const sy = sgnPow(Math.sin(t), 2 / n);
        let x = xc + hw * cx;
        if (tuck > 0 && sy < 0) {
          const k = tuck * Math.pow(-sy, 1.5);
          x = xc + hw * cx * (1 - 0.5 * k) + (xc >= 0 ? -1 : 1) * hw * 0.6 * k;
        }
        ring.push({ x, y: yc + hh * sy, inner: 0 });
      }
    }
    rings.push(ring);
  }
  const R = rings[0]?.length ?? 0;
  const pos: number[] = [];
  const inner: number[] = [];
  const idx: number[] = [];
  rings.forEach((ring, k) => {
    for (const p of ring) {
      pos.push(p.x, p.y, st[k].z);
      inner.push(p.inner);
    }
  });
  for (let k = 0; k < rings.length - 1; k++) {
    for (let j = 0; j < R - 1; j++) {
      const a = k * R + j;
      const b = k * R + j + 1;
      const c = (k + 1) * R + j + 1;
      const d = (k + 1) * R + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setAttribute('inner', new THREE.Float32BufferAttribute(inner, 1));
  body.setIndex(idx);
  body.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [body];
  const cap = (k: number, facing: 1 | -1): void => {
    const ring = rings[k];
    if (!ring || ring.length < 3) return;
    let cx = 0;
    let cy = 0;
    for (const p of ring) {
      cx += p.x;
      cy += p.y;
    }
    cx /= ring.length;
    cy /= ring.length;
    const cp: number[] = [cx, cy, st[k].z];
    for (const p of ring) cp.push(p.x, p.y, st[k].z);
    const ci: number[] = [];
    for (let j = 0; j < ring.length - 1; j++) {
      if (facing === 1) ci.push(0, j + 1, j + 2);
      else ci.push(0, j + 2, j + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    const nz = new Array((cp.length / 3) * 3).fill(0);
    for (let i = 0; i < cp.length / 3; i++) nz[i * 3 + 2] = facing;
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nz, 3));
    g.setAttribute('inner', new THREE.Float32BufferAttribute(new Array(cp.length / 3).fill(0), 1));
    g.setIndex(ci);
    parts.push(g);
  };
  if (opts.capStart) cap(0, -1);
  if (opts.capEnd) cap(rings.length - 1, 1);
  return mergeNonIndexed(parts);
}

/** A revolve strip: consecutive profile points sharing one atlas key; each point has radius r and axial a. */
export interface RevolveStrip {
  key: string;
  points: { r: number; a: number; nr: number; na: number }[];
}

/**
 * Revolve profile strips around the local X axis (x = axial a, y/z = radial). Returns a geometry plus a
 * per-vertex key index attribute `key` (index into `keys`).
 */
export function revolve(strips: RevolveStrip[], segments: number): { geometry: THREE.BufferGeometry; keys: string[] } {
  const S = Math.max(8, segments | 0);
  const pos: number[] = [];
  const nor: number[] = [];
  const key: number[] = [];
  const idx: number[] = [];
  const keys: string[] = [];
  for (const strip of strips) {
    let ki = keys.indexOf(strip.key);
    if (ki < 0) {
      keys.push(strip.key);
      ki = keys.length - 1;
    }
    const P = strip.points.length;
    if (P < 2) continue;
    const base = pos.length / 3;
    for (let p = 0; p < P; p++) {
      const pt = strip.points[p];
      const nl = Math.hypot(pt.nr, pt.na) || 1;
      for (let s = 0; s <= S; s++) {
        const phi = (s / S) * Math.PI * 2;
        const c = Math.cos(phi);
        const sn = Math.sin(phi);
        pos.push(pt.a, pt.r * c, pt.r * sn);
        nor.push(pt.na / nl, (pt.nr / nl) * c, (pt.nr / nl) * sn);
        key.push(ki);
      }
    }
    for (let p = 0; p < P - 1; p++) {
      for (let s = 0; s < S; s++) {
        const a = base + p * (S + 1) + s;
        const b = a + 1;
        const c = a + (S + 1) + 1;
        const d = a + (S + 1);
        idx.push(a, b, c, a, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('key', new THREE.Float32BufferAttribute(key, 1));
  g.setIndex(idx);
  fixWindingToNormals(g);
  return { geometry: g, keys };
}

/**
 * Reorders each triangle so its geometric normal agrees with the averaged vertex normal (used where the
 * analytic normals are known but the strip direction may vary).
 */
export function fixWindingToNormals(g: THREE.BufferGeometry): void {
  const index = g.getIndex();
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  if (!index || !pos || !nor) return;
  const arr = index.array as Uint16Array | Uint32Array;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const vn = new THREE.Vector3();
  for (let i = 0; i < arr.length; i += 3) {
    a.fromBufferAttribute(pos, arr[i]);
    b.fromBufferAttribute(pos, arr[i + 1]);
    c.fromBufferAttribute(pos, arr[i + 2]);
    n.subVectors(b, a).cross(c.sub(a));
    if (n.lengthSq() < 1e-14) continue;
    vn.fromBufferAttribute(nor, arr[i]).add(c.fromBufferAttribute(nor, arr[i + 1])).add(b.fromBufferAttribute(nor, arr[i + 2]));
    if (n.dot(vn) < 0) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
  }
  index.needsUpdate = true;
}

/**
 * Airfoil element spanning X in [x0, x1] at (y, z = leading edge). Chord runs towards -Z.
 * `pitch` (rad) raises the trailing edge. `camber` > 0 bulges downwards (inverted wing). `segments` = outline
 * points per surface (fewer for the simplified levels of detail).
 */
export function airfoil(x0: number, x1: number, y: number, zLead: number, chord: number, thickness: number, pitch: number, camber = 0.04, segments = 10): THREE.BufferGeometry {
  const span = Math.max(0.005, Math.abs(x1 - x0));
  const shape = new THREE.Shape();
  const N = Math.max(2, Math.floor(segments));
  const up: [number, number][] = [];
  const lo: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const xc = (1 - Math.cos((i / N) * Math.PI)) / 2;
    const yt = 5 * thickness * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
    const yc = -camber * 4 * xc * (1 - xc);
    up.push([xc * chord, (yc + yt) * chord]);
    lo.push([xc * chord, (yc - yt) * chord]);
  }
  shape.moveTo(up[0][0], up[0][1]);
  for (let i = 1; i <= N; i++) shape.lineTo(up[i][0], up[i][1]);
  for (let i = N - 1; i >= 1; i--) shape.lineTo(lo[i][0], lo[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, steps: 1, curveSegments: 1 });
  // shape (x = chord, y = thickness, z = span) -> car (z = -chord, y, x = span)
  g.translate(0, 0, -span / 2);
  g.rotateY(Math.PI / 2);
  g.rotateX(pitch);
  g.translate((x0 + x1) / 2, y, zLead);
  return g;
}

/** Cylinder rod between two points. */
export function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, radial = 8): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(1e-4, dir.length());
  const g = new THREE.CylinderGeometry(radius, radius, len, radial, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/**
 * Flattened strut between two points (aero-faired suspension arm): an elliptical section `chord` long (along the
 * car's Z axis as far as the strut allows) and `thick` thin.
 */
export function blade(a: THREE.Vector3, b: THREE.Vector3, chord: number, thick: number, radial = 6): THREE.BufferGeometry {
  // a flattened triangular prism has smooth normals > 90 degrees off its faces (inverted shading): 4 sides is the minimum
  radial = Math.max(4, Math.round(radial));
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(1e-4, dir.length());
  const y = dir.clone().divideScalar(len);
  const g = new THREE.CylinderGeometry(1, 1, len, radial, 1, false);
  g.scale(chord / 2, 1, thick / 2);
  const x = new THREE.Vector3(0, 0, 1);
  x.addScaledVector(y, -x.dot(y));
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  g.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Vertical plate: outline in (z, y) extruded along X from x0 to x0 + thickness. */
export function plateZY(outline: [number, number][], x0: number, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], outline[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.002, thickness), bevelEnabled: false, steps: 1, curveSegments: 4 });
  // shape (x, y, z=extrude) -> car (z = shape x, y, x = -extrude); rotateY(-PI/2): x' = -z, z' = x
  g.rotateY(-Math.PI / 2);
  g.translate(x0 + thickness, 0, 0);
  return g;
}

/** Horizontal plate: outline in (x, z) extruded along Y from y0 to y0 + thickness. */
export function plateXZ(outline: [number, number][], y0: number, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(outline[0][0], -outline[0][1]);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], -outline[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.002, thickness), bevelEnabled: false, steps: 1, curveSegments: 4 });
  // shape (x, y = -z, extrude) -> rotateX(-PI/2): y' = extrude, z' = -y = z
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

/** Merge geometries after converting each to non-indexed, keeping only the attributes common to all. */
export function mergeNonIndexed(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  const names = Object.keys(flat[0]?.attributes ?? {}).filter((n) => flat.every((g) => g.getAttribute(n) !== undefined));
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const itemSize = flat[0].getAttribute(name).itemSize;
    let total = 0;
    for (const g of flat) total += g.getAttribute(name).count * itemSize;
    const arr = new Float32Array(total);
    let off = 0;
    for (const g of flat) {
      const a = g.getAttribute(name);
      for (let i = 0; i < a.count; i++) {
        for (let k = 0; k < itemSize; k++) arr[off++] = a.getComponent(i, k);
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  for (const g of flat) g.dispose();
  for (const g of geoms) g.dispose();
  return out;
}
