/**
 * Rain streaks around the active camera: a static LineSegments buffer animated entirely in the vertex
 * shader (fall, wind, camera-relative slant, wrap-around box centred on the camera). Streak density
 * follows the rain intensity; per-view camera position / velocity uniforms support split-screen.
 */
import * as THREE from 'three';
import { Rng } from '../core/canvas';

const VERT = /* glsl */ `
attribute vec3 aSeed;
attribute float aEnd;
uniform vec3 uCam;
uniform vec3 uVel;
uniform float uTime;
uniform float uBox;
uniform float uFall;
uniform vec2 uWind;
uniform float uLength;
uniform float uDensity;
varying float vAlpha;
void main() {
  vec3 p = aSeed * uBox;
  p.y -= uTime * uFall;
  p.xz += uWind * uTime;
  vec3 rel = mod(p - uCam + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec3 world = uCam + rel;
  vec3 dir = normalize(vec3(uWind.x - uVel.x * 0.12, -uFall, uWind.y - uVel.z * 0.12));
  world += dir * uLength * aEnd;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  float r = length(rel);
  float visible = step(fract(aSeed.x * 91.7 + aSeed.z * 47.3), uDensity);
  vAlpha = visible * (1.0 - smoothstep(0.3 * uBox, 0.5 * uBox, r)) * smoothstep(0.4, 2.0, r);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  if (vAlpha < 0.01) discard;
  gl_FragColor = vec4(uColor, vAlpha * uOpacity);
  #include <colorspace_fragment>
}`;

export class RainFx {
  readonly lines: THREE.LineSegments;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private intensity = 0;
  private time = 0;

  constructor(count: number, seed = 5) {
    const n = Math.max(16, Math.floor(count));
    const seeds = new Float32Array(n * 2 * 3);
    const ends = new Float32Array(n * 2);
    const pos = new Float32Array(n * 2 * 3);
    const rng = new Rng(seed);
    for (let i = 0; i < n; i++) {
      const sx = rng.next();
      const sy = rng.next();
      const sz = rng.next();
      for (let e = 0; e < 2; e++) {
        const k = i * 2 + e;
        seeds[k * 3] = sx;
        seeds[k * 3 + 1] = sy;
        seeds[k * 3 + 2] = sz;
        ends[k] = e;
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    this.material = new THREE.ShaderMaterial({
      name: 'rain',
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uVel: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uBox: { value: 44 },
        uFall: { value: 15 },
        uWind: { value: new THREE.Vector2(1.2, 0.6) },
        uLength: { value: 0.7 },
        uDensity: { value: 0 },
        uColor: { value: new THREE.Color(0.72, 0.77, 0.86) },
        uOpacity: { value: 0.35 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.name = 'rain';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 8;
    this.lines.visible = false;
  }

  /** rain 0..1; dt seconds. */
  update(rain: number, dt: number): void {
    const r = Number.isFinite(rain) ? Math.max(0, Math.min(1, rain)) : 0;
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    this.intensity += (r - this.intensity) * Math.min(1, step * 1.5);
    this.time = (this.time + step) % 600;
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    u.uDensity.value = this.intensity > 0.02 ? 0.15 + 0.85 * this.intensity : 0;
    u.uOpacity.value = 0.22 + 0.25 * this.intensity;
    u.uLength.value = 0.5 + 0.6 * this.intensity;
    this.lines.visible = this.intensity > 0.02;
  }

  /** Per-view: centre the streak volume on the camera. */
  setCamera(position: THREE.Vector3, velocity: THREE.Vector3): void {
    this.material.uniforms.uCam.value.copy(position);
    this.material.uniforms.uVel.value.copy(velocity);
  }

  dispose(): void {
    this.lines.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
