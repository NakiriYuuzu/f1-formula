/**
 * Screen-space reflections on wet track surfaces (post chain, quality wetReflections). Wet materials mark themselves in
 * the alpha channel of the HDR scene target (alpha = 1 − reflectivity, track/road.ts WET_REFLECTION); this pass traces
 * the view ray mirrored about the world up axis through the resolved depth at reduced resolution, takes the scene colour
 * where it hits (cars, barriers, stands, lamps — whatever is on screen) and blends it over the road by Fresnel ×
 * reflectivity × hit confidence. Misses keep the material's own probe reflection. A per-pixel jitter of the mirror
 * normal (stretched vertically, like rain-streaked asphalt) and the half-resolution trace soften the mirror.
 */
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { SSR_FADE_EDGE, SSR_MAX_DIST, SSR_ROUGH, SSR_STEPS, SSR_STEP_GROWTH } from './post';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const TRACE_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 proj;
uniform mat4 projInv;
uniform vec3 upView;
uniform float cameraNear;
uniform float cameraFar;
uniform float strength;
varying vec2 vUv;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 viewPosAt(vec2 uv, float depth) {
  vec4 v = projInv * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}
void main() {
  vec4 src = texture2D(tColor, vUv);
  float mask = clamp(1.0 - src.a, 0.0, 1.0);
  float depth = texture2D(tDepth, vUv).x;
  gl_FragColor = vec4(0.0);
  if (mask < 0.01 || depth >= 0.999999 || strength <= 0.0) return;
  vec3 p = viewPosAt(vUv, depth);
  vec3 v = normalize(p);
  // rough water film: jitter the mirror normal, more along the view's vertical (streaks toward the light)
  vec2 j = vec2(hash12(gl_FragCoord.xy), hash12(gl_FragCoord.yx + 17.3)) - 0.5;
  vec3 side = normalize(cross(upView, v));
  vec3 fwd = normalize(cross(side, upView));
  vec3 n = normalize(upView + side * j.x * SSR_ROUGH + fwd * j.y * SSR_ROUGH * 2.5);
  vec3 r = reflect(v, n);
  // the jittered mirror must not send the ray into the surface it starts on
  if (dot(r, upView) < 0.01) r = reflect(v, upView);
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(-v, n), 0.0, 1.0), 5.0);
  // march with growing steps, starting a little off the surface
  float stepLen = max(0.08, -p.z * 0.004);
  vec3 pos = p + n * 0.02 + r * stepLen * hash12(gl_FragCoord.xy + 7.1);
  vec3 prev = pos;
  float hit = 0.0;
  vec2 hitUv = vec2(0.0);
  float travelled = 0.0;
  for (int i = 0; i < SSR_STEPS; i++) {
    prev = pos;
    pos += r * stepLen;
    travelled += stepLen;
    stepLen *= SSR_STEP_GROWTH;
    if (pos.z > -cameraNear || travelled > SSR_MAX_DIST) break;
    vec4 c = proj * vec4(pos, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float sceneZ = perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
    float behind = sceneZ - pos.z;
    // a mirror ray off a flat wet surface never meets another wet surface (grazing rays would hit the road itself)
    if (behind > 0.0 && behind < max(0.35, stepLen * 2.0) && texture2D(tColor, uv).a > 0.99) {
      // refine between the last two samples
      vec3 a = prev;
      vec3 b = pos;
      for (int k = 0; k < 5; k++) {
        vec3 m = (a + b) * 0.5;
        vec4 mc = proj * vec4(m, 1.0);
        vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
        float mz = perspectiveDepthToViewZ(texture2D(tDepth, muv).x, cameraNear, cameraFar);
        if (mz - m.z > 0.0) b = m; else a = m;
      }
      vec4 hc = proj * vec4(b, 1.0);
      hitUv = hc.xy / hc.w * 0.5 + 0.5;
      // the sky never reflects from here (the material's probe already shows it)
      hit = texture2D(tDepth, hitUv).x < 0.999999 ? 1.0 : 0.0;
      break;
    }
  }
  if (hit <= 0.0) return;
  vec2 e = min(hitUv, 1.0 - hitUv);
  float fade = smoothstep(0.0, SSR_FADE_EDGE, min(e.x, e.y)) * (1.0 - smoothstep(SSR_MAX_DIST * 0.6, SSR_MAX_DIST, travelled));
  // a reflecting road pixel never shows another wet road pixel's own reflection (no feedback): its lit colour only
  vec3 col = max(texture2D(tColor, hitUv).rgb, vec3(0.0));
  float a = clamp(mask * fres * fade * strength, 0.0, 0.95);
  gl_FragColor = vec4(col * a, a);
}`;

/**
 * Blends the (premultiplied) reflections over the scene in place: dst = dst × (1 − a) + reflection, dst alpha kept.
 * A 3 × 3 tent filter over the half-resolution trace (bilinear taps between texels) smooths the jittered hits.
 */
const APPLY_FRAG = /* glsl */ `
uniform sampler2D tReflect;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tReflect, vUv) * 0.25;
  c += texture2D(tReflect, vUv + vec2(texel.x, texel.y)) * 0.1875;
  c += texture2D(tReflect, vUv + vec2(-texel.x, texel.y)) * 0.1875;
  c += texture2D(tReflect, vUv + vec2(texel.x, -texel.y)) * 0.1875;
  c += texture2D(tReflect, vUv + vec2(-texel.x, -texel.y)) * 0.1875;
  gl_FragColor = c;
}`;

export class WetReflectionPass extends Pass {
  /** 0..1 blend strength (0 = pass skipped) */
  strength = 0;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly traceMaterial: THREE.ShaderMaterial;
  private readonly applyMaterial: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private readonly scale: number;
  private camera: THREE.Camera | null = null;

  constructor(depthTexture: THREE.DepthTexture, scale: number) {
    super();
    this.needsSwap = false;
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.target.texture.name = 'post.wetReflect';
    this.traceMaterial = new THREE.ShaderMaterial({
      name: 'post-wet-reflect',
      defines: {
        SSR_STEPS: SSR_STEPS,
        SSR_STEP_GROWTH: SSR_STEP_GROWTH.toFixed(4),
        SSR_MAX_DIST: SSR_MAX_DIST.toFixed(2),
        SSR_ROUGH: SSR_ROUGH.toFixed(4),
        SSR_FADE_EDGE: SSR_FADE_EDGE.toFixed(4),
      },
      uniforms: {
        tColor: { value: null },
        tDepth: { value: depthTexture },
        proj: { value: new THREE.Matrix4() },
        projInv: { value: new THREE.Matrix4() },
        upView: { value: new THREE.Vector3(0, 1, 0) },
        cameraNear: { value: 0.1 },
        cameraFar: { value: 1000 },
        strength: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: TRACE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.applyMaterial = new THREE.ShaderMaterial({
      name: 'post-wet-reflect-apply',
      uniforms: { tReflect: { value: this.target.texture }, texel: { value: new THREE.Vector2(1, 1) } },
      vertexShader: VERT,
      fragmentShader: APPLY_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
  }

  setCamera(camera: THREE.Camera | null): void {
    this.camera = camera;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(2, Math.round(width * this.scale));
    const h = Math.max(2, Math.round(height * this.scale));
    this.target.setSize(w, h);
    // diagonal taps 1.2 trace texels out (bilinear: each averages a 2 × 2 block)
    this.applyMaterial.uniforms.texel.value.set(1.2 / w, 1.2 / h);
  }

  override render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const cam = this.camera as THREE.PerspectiveCamera | null;
    if (!cam || cam.isPerspectiveCamera !== true || this.strength <= 0) return;
    const u = this.traceMaterial.uniforms;
    cam.updateMatrixWorld();
    u.tColor.value = readBuffer.texture;
    u.proj.value.copy(cam.projectionMatrix);
    u.projInv.value.copy(cam.projectionMatrixInverse);
    // world up in view space
    u.upView.value.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);
    u.cameraNear.value = cam.near;
    u.cameraFar.value = cam.far;
    u.strength.value = this.strength;
    this.quad.material = this.traceMaterial;
    // every pixel is written (0 where nothing reflects): no clear needed
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    this.quad.material = this.applyMaterial;
    renderer.setRenderTarget(readBuffer);
    this.quad.render(renderer);
    u.tColor.value = null;
  }

  override dispose(): void {
    this.target.dispose();
    this.traceMaterial.dispose();
    this.applyMaterial.dispose();
    this.quad.dispose();
  }
}
