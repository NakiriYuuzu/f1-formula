/**
 * Safety car model: original GT coupé (see safetyCarGeometry.ts), created once per scene and hidden until the race
 * supplies frame.safetyCar. apply() poses it like the race cars (rotation order 'YXZ', y = yaw, local -X = right),
 * rolls the four wheels with rotation.x = +wheelSpin and alternates the two amber roof pods at SC_FLASH_HZ while the
 * lights are on. 11 draw calls, ≈ 3k triangles; casts shadows only when the quality profile has them.
 */
import * as THREE from 'three';
import type { SafetyCarRenderState } from '../../core/types';
import { canvasTexture, createCanvas, UI_FONT } from '../core/canvas';
import {
  SC_ARCH_RADIUS,
  SC_ATLAS,
  SC_AXLE_Z,
  SC_SIDE_RECT,
  SC_SIDE_Y,
  SC_SIDE_Z,
  SC_WHEEL_RADIUS,
  SC_WHEEL_X,
  SC_ARCH_Y,
  SC_BLACK_RECT,
  SC_BONNET_RECT,
  SC_REAR_RECT,
  buildSafetyCarGeometry,
  type AtlasRect,
  type SafetyCarGeometries,
} from './safetyCarGeometry';
import { SC_CENTRE_ON, SC_HEAD_GAIN, SC_POD_OFF, SC_POD_ON, lightBarPhase, wheelSpinAngle } from './safetyCarMath';

/** Livery colours (sRGB hex). */
export const SC_LIVERY = { vermilion: '#e8431f', teal: '#1fb5a6', text: '#f4f6f8', dark: '#0b0c0e' } as const;
const AMBER = new THREE.Color('#ffa012');

/** Paint the livery atlas (transparent background; decal meshes project it onto the body). */
export function paintSafetyCarLivery(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, SC_ATLAS.w, SC_ATLAS.h);
  // black swatch for wheel arches
  const k = SC_BLACK_RECT;
  ctx.fillStyle = '#050506';
  ctx.fillRect(k.x, k.y, k.w, k.h);

  // side decal: stripes + door lettering, wheel arches cut out
  const r = SC_SIDE_RECT;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  const py = (b: number): number => r.y + (1 - b) * r.h;
  const poly = (color: string, pts: [number, number][]): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    pts.forEach(([x, b], i) => (i === 0 ? ctx.moveTo(r.x + x, py(b)) : ctx.lineTo(r.x + x, py(b))));
    ctx.closePath();
    ctx.fill();
  };
  poly(SC_LIVERY.vermilion, [[0, 0.1], [760, 0.1], [973, 0.34], [973, 0.5], [760, 0.26], [0, 0.26]]);
  poly(SC_LIVERY.teal, [[0, 0.3], [700, 0.3], [973, 0.58], [973, 0.64], [700, 0.36], [0, 0.36]]);
  ctx.fillStyle = SC_LIVERY.text;
  ctx.font = `bold 38px ${UI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '4px';
  ctx.fillText('SAFETY CAR', r.x + ((0.1 - SC_SIDE_Z[0]) / (SC_SIDE_Z[1] - SC_SIDE_Z[0])) * r.w, py(0.68));
  ctx.restore();
  // wheel arch cut-outs (the black arch discs show through)
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (const az of [-SC_AXLE_Z, SC_AXLE_Z]) {
    const cx = r.x + ((az - SC_SIDE_Z[0]) / (SC_SIDE_Z[1] - SC_SIDE_Z[0])) * r.w;
    const cy = r.y + (1 - (SC_ARCH_Y - SC_SIDE_Y[0]) / (SC_SIDE_Y[1] - SC_SIDE_Y[0])) * r.h;
    ctx.beginPath();
    ctx.arc(cx, cy, SC_ARCH_RADIUS * SC_ATLAS.pxPerM, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  const cjk = (rect: AtlasRect, size: number, sub: boolean): void => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.fillStyle = SC_LIVERY.vermilion;
    ctx.fillRect(rect.x, rect.y + rect.h - 6, rect.w * 0.6, 6);
    ctx.fillStyle = SC_LIVERY.teal;
    ctx.fillRect(rect.x + rect.w * 0.6, rect.y + rect.h - 6, rect.w * 0.4, 6);
    ctx.fillStyle = SC_LIVERY.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${size}px ${UI_FONT}`;
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '2px';
    ctx.fillText('安全車', rect.x + rect.w / 2, rect.y + rect.h * (sub ? 0.38 : 0.45));
    if (sub) {
      ctx.font = `bold 24px ${UI_FONT}`;
      ctx.fillText('SAFETY CAR', rect.x + rect.w / 2, rect.y + rect.h * 0.66);
    }
    ctx.restore();
  };
  cjk(SC_BONNET_RECT, 64, true);
  cjk(SC_REAR_RECT, 54, false);
}

export interface SafetyCarModel {
  root: THREE.Group;
  /** pose + wheels + light bar; `time` = frame time (s) */
  apply(state: SafetyCarRenderState, time: number): void;
  hide(): void;
  setCastShadow(on: boolean): void;
  dispose(): void;
}

export interface SafetyCarOptions {
  anisotropy?: number;
}

function finite(...v: number[]): boolean {
  return v.every((n) => Number.isFinite(n));
}

export function createSafetyCar(opts: SafetyCarOptions = {}): SafetyCarModel {
  const geo: SafetyCarGeometries = buildSafetyCarGeometry();
  const art = createCanvas(SC_ATLAS.w, SC_ATLAS.h);
  paintSafetyCarLivery(art.ctx);
  const tex = canvasTexture(art, { anisotropy: opts.anisotropy ?? 1 });

  const bodyMat = new THREE.MeshStandardMaterial({ name: 'sc-body', vertexColors: true, roughness: 0.38, metalness: 0.55 });
  const wheelMat = new THREE.MeshStandardMaterial({ name: 'sc-wheel', vertexColors: true, roughness: 0.6, metalness: 0.35 });
  const glassMat = new THREE.MeshStandardMaterial({ name: 'sc-glass', color: '#0a0d12', roughness: 0.08, metalness: 0.9 });
  const decalMat = new THREE.MeshStandardMaterial({
    name: 'sc-decal',
    map: tex,
    transparent: true,
    roughness: 0.4,
    metalness: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const lampMat = new THREE.MeshBasicMaterial({ name: 'sc-lamps', vertexColors: true, side: THREE.DoubleSide, toneMapped: false });
  lampMat.color.setScalar(SC_HEAD_GAIN);
  const barMat = new THREE.MeshStandardMaterial({ name: 'sc-bar', vertexColors: true, roughness: 0.5, metalness: 0.3 });
  const podMatL = new THREE.MeshBasicMaterial({ name: 'sc-pod-l', toneMapped: false });
  const podMatR = new THREE.MeshBasicMaterial({ name: 'sc-pod-r', toneMapped: false });
  const centreMat = new THREE.MeshBasicMaterial({ name: 'sc-centre', vertexColors: true, toneMapped: false });

  const root = new THREE.Group();
  root.name = 'safetyCar';
  root.visible = false;
  const casters: THREE.Mesh[] = [];
  const mk = (g: THREE.BufferGeometry, m: THREE.Material, name: string, cast = false): THREE.Mesh => {
    const mesh = new THREE.Mesh(g, m);
    mesh.name = name;
    mesh.castShadow = cast;
    root.add(mesh);
    if (cast) casters.push(mesh);
    return mesh;
  };
  mk(geo.body, bodyMat, 'sc-body', true);
  mk(geo.glass, glassMat, 'sc-glass', true);
  mk(geo.decals, decalMat, 'sc-decals');
  mk(geo.lamps, lampMat, 'sc-lamps');
  mk(geo.bar, barMat, 'sc-bar', true);
  mk(geo.podLeft, podMatL, 'sc-pod-l');
  mk(geo.podRight, podMatR, 'sc-pod-r');
  mk(geo.centre, centreMat, 'sc-centre');

  // wheels: FL, FR, RL, RR; spinner (rotation.x = wheelSpin) → mesh (outboard face towards the car's own side)
  const spinners: THREE.Group[] = [];
  for (const [sx, z] of [[1, SC_AXLE_Z], [-1, SC_AXLE_Z], [1, -SC_AXLE_Z], [-1, -SC_AXLE_Z]] as const) {
    const spinner = new THREE.Group();
    spinner.position.set(sx * SC_WHEEL_X, SC_WHEEL_RADIUS, z);
    const w = new THREE.Mesh(geo.wheel, wheelMat);
    w.name = 'sc-wheel';
    w.castShadow = true;
    casters.push(w);
    if (sx < 0) w.rotation.y = Math.PI;
    spinner.add(w);
    root.add(spinner);
    spinners.push(spinner);
  }

  let lastLevel = -1;
  const setLevels = (phase: 0 | 1 | null): void => {
    const code = phase === null ? 2 : phase;
    if (code === lastLevel) return;
    lastLevel = code;
    const l = phase === 0 ? SC_POD_ON : SC_POD_OFF;
    const r = phase === 1 ? SC_POD_ON : SC_POD_OFF;
    podMatL.color.copy(AMBER).multiplyScalar(l);
    podMatR.color.copy(AMBER).multiplyScalar(r);
    centreMat.color.setScalar(phase === null ? SC_POD_OFF : SC_CENTRE_ON);
  };
  setLevels(null);
  let disposed = false;

  return {
    root,
    apply(state, time) {
      if (disposed) return;
      if (!finite(state.x, state.y, state.z, state.yaw)) {
        root.visible = false;
        return;
      }
      root.visible = true;
      root.position.set(state.x, state.y, state.z);
      root.rotation.set(-(Number.isFinite(state.pitch) ? (state.pitch as number) : 0), state.yaw, 0, 'YXZ');
      const spin = wheelSpinAngle(state.wheelSpin);
      for (const s of spinners) s.rotation.x = spin;
      setLevels(lightBarPhase(time, state.lightsOn === true));
    },
    hide() {
      root.visible = false;
    },
    setCastShadow(on) {
      for (const m of casters) m.castShadow = on;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const g of Object.values(geo)) g.dispose();
      tex.dispose();
      for (const m of [bodyMat, wheelMat, glassMat, decalMat, lampMat, barMat, podMatL, podMatR, centreMat]) m.dispose();
      root.removeFromParent();
    },
  };
}
