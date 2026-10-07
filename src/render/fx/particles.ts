/**
 * Pooled camera-facing particles (THREE.Points + custom shader, one draw call per pool): tyre smoke,
 * wet-road spray and off-track dust share a soft alpha-blended pool; impact / skid-block sparks use an
 * additive pool (colours may exceed 1 for HDR / bloom-friendly sparks). Ring-buffer allocation, CPU integration,
 * no per-frame allocations.
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute vec3 aVel;
uniform float uScale;
uniform float uStreak;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vDir;
varying float vStretch;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // streak pools (sparks): stretch the sprite along the particle's screen-space velocity so it reads as a short bright line
  vec2 mv = (modelViewMatrix * vec4(aVel, 0.0)).xy;
  float sp = length(mv);
  vStretch = 1.0 + uStreak * clamp(sp * 0.12, 0.0, 3.0);
  vDir = sp > 0.001 ? mv / sp : vec2(1.0, 0.0);
  gl_PointSize = clamp(aSize * vStretch * uScale / max(0.2, -mvPosition.z), 0.0, 512.0);
  vAlpha = aAlpha;
  vColor = aColor;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform float uHard;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vDir;
varying float vStretch;
#include <fog_pars_fragment>
void main() {
  vec2 c = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y) * 2.0;
  float d = length(vec2(dot(c, vDir), dot(c, vec2(-vDir.y, vDir.x)) * vStretch));
  float a = mix(1.0 - smoothstep(0.15, 1.0, d), 1.0 - smoothstep(0.7, 1.0, d), uHard) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export interface EmitParams {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** start size (m) */
  size: number;
  /** size growth (m/s) */
  growth: number;
  life: number;
  alpha: number;
  color: THREE.Color;
  /** downward acceleration (m/s²) */
  gravity: number;
  /** velocity damping (1/s) */
  drag: number;
}

export class ParticlePool {
  readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly color: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly growth: Float32Array;
  private readonly baseAlpha: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  /** GPU attributes re-uploaded after each simulated frame (cached: no per-frame allocation) */
  private readonly dynamicAttributes: THREE.BufferAttribute[];
  private next = 0;
  private alive = 0;

  constructor(capacity: number, additive: boolean, name: string) {
    this.capacity = Math.max(8, Math.floor(capacity));
    const n = this.capacity;
    this.pos = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.color = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.growth = new Float32Array(n);
    this.baseAlpha = new Float32Array(n);
    this.gravity = new Float32Array(n);
    this.drag = new Float32Array(n);
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = -1e5;
    this.geometry = new THREE.BufferGeometry();
    this.dynamicAttributes = [
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
      new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage),
      new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage),
      new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage),
      new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage),
    ];
    const [pa, sa, aa, ca, va] = this.dynamicAttributes;
    this.geometry.setAttribute('position', pa);
    this.geometry.setAttribute('aSize', sa);
    this.geometry.setAttribute('aAlpha', aa);
    this.geometry.setAttribute('aColor', ca);
    this.geometry.setAttribute('aVel', va);
    this.material = new THREE.ShaderMaterial({
      name,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 500 }, uHard: { value: additive ? 1 : 0 }, uStreak: { value: additive ? 1 : 0 } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
      toneMapped: !additive,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = name;
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    this.points.visible = false;
  }

  /** Pool capacity (max simultaneous particles). */
  get poolSize(): number {
    return this.capacity;
  }

  /** Number of live particles after the last update. */
  get activeCount(): number {
    return this.alive;
  }

  /** Pixels per metre at 1 m distance for the view being rendered. */
  setViewScale(viewportHeightPx: number, fovDeg: number): void {
    const f = Math.tan(THREE.MathUtils.degToRad(Math.max(1, Math.min(170, fovDeg))) / 2);
    this.material.uniforms.uScale.value = Math.max(1, viewportHeightPx) / (2 * Math.max(1e-3, f));
  }

  emit(p: EmitParams): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    if (this.life[i] <= 0 || this.age[i] >= this.life[i]) this.alive++;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = fin(p.vx);
    this.vel[i * 3 + 1] = fin(p.vy);
    this.vel[i * 3 + 2] = fin(p.vz);
    this.size[i] = Math.max(0.01, fin(p.size));
    this.growth[i] = fin(p.growth);
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, fin(p.life));
    this.baseAlpha[i] = Math.max(0, Math.min(1, fin(p.alpha)));
    this.alpha[i] = 0;
    this.gravity[i] = fin(p.gravity);
    this.drag[i] = Math.max(0, fin(p.drag));
    this.color[i * 3] = p.color.r;
    this.color[i * 3 + 1] = p.color.g;
    this.color[i * 3 + 2] = p.color.b;
  }

  update(dtIn: number): void {
    // `alive` also counts particles emitted since the last update; when it is 0 every slot is dead: nothing to
    // simulate or upload (the pool stays hidden)
    if (this.alive <= 0) return;
    const dt = Number.isFinite(dtIn) ? Math.max(0, Math.min(dtIn, 0.1)) : 0;
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        this.size[i] = 0;
        this.pos[i * 3 + 1] = -1e5;
        continue;
      }
      alive++;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.gravity[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.growth[i] * dt;
      const t = this.age[i] / this.life[i];
      // quick fade-in, smooth fade-out
      this.alpha[i] = this.baseAlpha[i] * Math.min(1, t * 8) * (1 - t) * (1 - t * 0.3);
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    // upload while anything lived this frame (incl. the frame the last particle died)
    for (let i = 0; i < this.dynamicAttributes.length; i++) this.dynamicAttributes[i].needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    for (let i = 0; i < this.capacity; i++) this.pos[i * 3 + 1] = -1e5;
    this.alive = 0;
    this.points.visible = false;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}
