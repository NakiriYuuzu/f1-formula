/**
 * Post-processing chain for one full-screen view (owned by GameRenderer, shared by RaceScene and ShowroomScene):
 * RenderPass into a half-float HDR target (MSAA) -> optional ambient occlusion (GTAO from the scene target's resolved
 * depth, at reduced resolution, multiplied onto the frame in place) -> selective bloom (UnrealBloomPass with a soft-knee
 * brightest-channel bright pass, optionally at reduced resolution) -> chromatic aberration + speed blur + aerial
 * perspective (haze from the resolved depth) + grade + vignette + film grain ShaderPass -> OutputPass.
 * While the chain is used the scene renders un-tone-mapped in linear space (three only tone-maps to the screen), so
 * OutputPass alone applies renderer.toneMapping / toneMappingExposure and the sRGB transfer: tone mapping runs once.
 * Sizes are drawing-buffer pixels (the composer runs at pixel ratio 1).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { clamp } from '../../core/math';
import {
  AO_RADIUS,
  AO_SAMPLES,
  AO_THICKNESS,
  BLOOM_KNEE,
  BLOOM_MAX_INPUT,
  GRADE_LIFT_RANGE,
  GRADE_PIVOT,
  GRADE_SPLIT_HIGHLIGHT,
  GRADE_SPLIT_SHADOW,
  CLOUD_SHADOW_HEIGHT,
  CLOUD_SHADOW_TILE,
  HAZE_SUN_POWER,
  SPEED_BLUR_START,
  SPEED_BLUR_TAPS,
  VIGNETTE_START,
  type PostLook,
} from './post';

function glslVec3(v: readonly [number, number, number]): string {
  return `vec3(${v.map((x) => x.toFixed(4)).join(', ')})`;
}

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Bright pass: brightest channel (saturated red lamps qualify), soft knee, HDR input clamped against fireflies. */
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float luminosityThreshold;
uniform float smoothWidth;
uniform float maxInput;
varying vec2 vUv;
void main() {
  vec3 c = clamp(texture2D(tDiffuse, vUv).rgb, 0.0, maxInput);
  float b = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, b), 1.0);
}`;

/** Multiplies the denoised AO onto the frame in place (blending dst × src): 1 where unoccluded or for the sky. */
const AO_APPLY_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform float intensity;
varying vec2 vUv;
void main() {
  float ao = texture2D(tAO, vUv).r;
  gl_FragColor = vec4(vec3(mix(1.0, ao, intensity)), 1.0);
}`;

/**
 * Lateral chromatic aberration (red sampled toward the centre, blue away, growing to the corners), radial speed blur
 * (taps toward the screen centre, faded in from speedBlurStart so the centre stays sharp), aerial perspective (USE_HAZE:
 * the view ray rebuilt from the resolved depth; exponential height fog integrated along it; transmitted light loses
 * blue, the veil is bluer on steep paths and glows toward the sun; the sky, depth 1, keeps its own horizon), then grade
 * (tint, saturation, pivot-power contrast, toe lift) + vignette + animated film grain, all in linear HDR before OutputPass.
 */
const GRADE_FRAG = /* glsl */ `
const int SPEED_BLUR_TAPS = ${SPEED_BLUR_TAPS};
#ifdef USE_HAZE
uniform sampler2D tDepth;
uniform mat4 projInv;
uniform mat4 viewInv;
uniform vec3 camPos;
uniform float hazeAmount;
uniform float hazeDensity;
uniform float hazeHeight;
uniform float hazeBase;
uniform vec3 hazeColor;
uniform vec3 hazeSteep;
uniform vec3 hazeSun;
uniform vec3 hazeSunDir;
uniform float hazeBlue;
uniform float hazeCap;
uniform sampler2D cloudMap;
uniform float cloudShadow;
uniform float cloudCover;
uniform float cloudSoft;
uniform vec2 cloudOffset;
vec3 applyHaze(vec3 c, vec2 uv) {
  float depth = texture2D(tDepth, uv).x;
  if (hazeAmount <= 0.0 || depth >= 0.999999) return c;
  vec4 v = projInv * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 vp = v.xyz / v.w;
  float t = length(vp);
  if (t < 1e-3) return c;
  vec3 rd = normalize(mat3(viewInv) * (vp / t));
  if (cloudShadow > 0.0 && hazeSunDir.y > 0.05) {
    // the cloud deck's noise (as the sky dome) projected along the sun onto this surface: drifting soft shadows
    vec3 wp = camPos + rd * t;
    vec2 q = (wp.xz + hazeSunDir.xz / hazeSunDir.y * (CLOUD_SHADOW_HEIGHT - wp.y)) / CLOUD_SHADOW_TILE + cloudOffset;
    float n = texture2D(cloudMap, q).r * 0.68 + texture2D(cloudMap, q * 2.7 + cloudOffset * 1.6 + vec2(0.37, 0.61)).r * 0.32;
    // a cloud's shadow is denser than its thin sunlit edge looks against the sky: steeper ramp than the dome's
    float lo = 1.0 - cloudCover;
    c *= 1.0 - cloudShadow * smoothstep(lo - 0.04, lo + cloudSoft * 0.45, n);
  }
  float hm = 1.0 / hazeHeight;
  float k = rd.y * hm;
  float kt = k * t;
  // optical depth of exp(-(y - base) / H) along the ray from the camera
  float od = hazeDensity * exp(-clamp((camPos.y - hazeBase) * hm, -3.0, 20.0)) * (abs(kt) > 1e-4 ? (1.0 - exp(-kt)) / k : t);
  float ext = min(1.0 - exp(-od), hazeCap) * hazeAmount;
  float s = max(dot(rd, hazeSunDir), 0.0);
  vec3 veil = mix(hazeColor, hazeSteep, smoothstep(0.04, 0.45, abs(rd.y))) + hazeSun * pow(s, HAZE_SUN_POWER);
  c *= 1.0 - vec3(0.19, 0.27, 0.35) * (hazeBlue * ext);
  return mix(c, veil, ext);
}
#endif
uniform sampler2D tDiffuse;
uniform vec3 tint;
uniform float saturation;
uniform float contrast;
uniform float lift;
uniform float liftRange;
uniform float pivot;
uniform float vignette;
uniform float vignetteStart;
uniform float aspect;
uniform float speedBlur;
uniform float speedBlurStart;
uniform float chroma;
uniform float grain;
uniform float grainSeed;
uniform float split;
uniform float sharpen;
uniform vec2 texel;
varying vec2 vUv;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 src = texture2D(tDiffuse, vUv);
  vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
  float r = length(d) / (0.5 * length(vec2(aspect, 1.0)));
  vec3 c = max(src.rgb, vec3(0.0));
  vec3 sharpD = vec3(0.0);
  if (sharpen > 0.0) {
    // unsharp mask against the 4-neighbour average, limited so bright edges do not ring
    vec3 nb = texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(texel.x, 0.0)).rgb
      + texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, texel.y)).rgb;
    sharpD = clamp(c - max(nb * 0.25, vec3(0.0)), -0.25 * c - 0.02, 0.25 * c + 0.02) * sharpen * 4.0;
  }
  if (chroma > 0.0) {
    vec2 ca = (vUv - 0.5) * chroma * r;
    c.r = max(texture2D(tDiffuse, vUv - ca).r, 0.0);
    c.b = max(texture2D(tDiffuse, vUv + ca).b, 0.0);
  }
  c = max(c + sharpD, vec3(0.0));
  float blur = speedBlur * smoothstep(speedBlurStart, 1.0, r);
  if (blur > 1e-4) {
    // stratified taps over (0, blur] of the way to the centre; per-pixel jitter hides the banding
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec2 toCentre = (0.5 - vUv) * blur;
    for (int i = 1; i < SPEED_BLUR_TAPS; i++) {
      float t = (float(i) - jitter) / float(SPEED_BLUR_TAPS - 1);
      c += max(texture2D(tDiffuse, vUv + toCentre * t).rgb, vec3(0.0));
    }
    c /= float(SPEED_BLUR_TAPS);
  }
  #ifdef USE_HAZE
  c = applyHaze(c, vUv);
  #endif
  c *= tint;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, saturation), vec3(0.0));
  c = pivot * pow(max(c / pivot, vec3(1e-6)), vec3(contrast));
  c += lift * (1.0 - smoothstep(vec3(0.0), vec3(liftRange), c));
  if (split > 0.0) {
    float sl = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c *= 1.0 + split * mix(SPLIT_SHADOW, SPLIT_HIGHLIGHT, smoothstep(0.02, 0.6, sl));
  }
  c *= 1.0 - vignette * smoothstep(vignetteStart, 1.0, r);
  if (grain > 0.0) c *= 1.0 + grain * (hash12(gl_FragCoord.xy + grainSeed * vec2(113.0, 71.0)) * 2.0 - 1.0);
  gl_FragColor = vec4(c, src.a);
}`;

interface GradeUniforms {
  [name: string]: THREE.IUniform;
  tDiffuse: THREE.IUniform<THREE.Texture | null>;
  tint: THREE.IUniform<THREE.Vector3>;
  saturation: THREE.IUniform<number>;
  contrast: THREE.IUniform<number>;
  lift: THREE.IUniform<number>;
  liftRange: THREE.IUniform<number>;
  pivot: THREE.IUniform<number>;
  vignette: THREE.IUniform<number>;
  vignetteStart: THREE.IUniform<number>;
  aspect: THREE.IUniform<number>;
  speedBlur: THREE.IUniform<number>;
  speedBlurStart: THREE.IUniform<number>;
  chroma: THREE.IUniform<number>;
  grain: THREE.IUniform<number>;
  grainSeed: THREE.IUniform<number>;
  split: THREE.IUniform<number>;
  sharpen: THREE.IUniform<number>;
  texel: THREE.IUniform<THREE.Vector2>;
  tDepth: THREE.IUniform<THREE.Texture | null>;
  projInv: THREE.IUniform<THREE.Matrix4>;
  viewInv: THREE.IUniform<THREE.Matrix4>;
  camPos: THREE.IUniform<THREE.Vector3>;
  hazeAmount: THREE.IUniform<number>;
  hazeDensity: THREE.IUniform<number>;
  hazeHeight: THREE.IUniform<number>;
  hazeBase: THREE.IUniform<number>;
  hazeColor: THREE.IUniform<THREE.Vector3>;
  hazeSteep: THREE.IUniform<THREE.Vector3>;
  hazeSun: THREE.IUniform<THREE.Vector3>;
  hazeSunDir: THREE.IUniform<THREE.Vector3>;
  hazeBlue: THREE.IUniform<number>;
  hazeCap: THREE.IUniform<number>;
  cloudMap: THREE.IUniform<THREE.Texture | null>;
  cloudShadow: THREE.IUniform<number>;
  cloudCover: THREE.IUniform<number>;
  cloudSoft: THREE.IUniform<number>;
  cloudOffset: THREE.IUniform<THREE.Vector2>;
}

/** UnrealBloomPass with the brightest-channel soft-knee bright pass and a resolution scale. */
class SelectiveBloomPass extends UnrealBloomPass {
  private readonly resolutionScale: number;

  constructor(resolutionScale: number) {
    super(new THREE.Vector2(256, 256), 0, 0.5, 1);
    this.resolutionScale = resolutionScale;
    this.materialHighPassFilter.dispose();
    const uniforms = {
      tDiffuse: { value: null as THREE.Texture | null },
      luminosityThreshold: { value: 1 },
      smoothWidth: { value: BLOOM_KNEE },
      maxInput: { value: BLOOM_MAX_INPUT },
    };
    // render() writes tDiffuse / luminosityThreshold into highPassUniforms every frame
    this.highPassUniforms = uniforms;
    this.materialHighPassFilter = new THREE.ShaderMaterial({
      name: 'post-bloom-bright',
      uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  override setSize(width: number, height: number): void {
    super.setSize(Math.max(2, Math.round(width * this.resolutionScale)), Math.max(2, Math.round(height * this.resolutionScale)));
  }

  override dispose(): void {
    super.dispose();
    // UnrealBloomPass.dispose() does not release its bright-pass material
    this.materialHighPassFilter.dispose();
  }
}

/**
 * GTAOPass fed by an external depth texture (no extra normal / depth render of the scene: normals are rebuilt from depth).
 * three r186's setGBuffer / setSize / dispose dereference the normal target even when a depth texture is supplied, so
 * an unused 1 × 1 one is provided here (it is never rendered to, so it never allocates GPU memory).
 */
class DepthGtaoPass extends GTAOPass {
  override setGBuffer(depthTexture?: THREE.DepthTexture, normalTexture?: THREE.Texture): void {
    const self = this as unknown as { normalRenderTarget?: THREE.WebGLRenderTarget };
    self.normalRenderTarget ??= new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) });
    super.setGBuffer(depthTexture, normalTexture);
  }
}

/** Ambient occlusion from the scene target's depth at a resolution scale, multiplied onto the read buffer in place. */
class AmbientOcclusionPass extends Pass {
  readonly gtao: DepthGtaoPass;
  intensity = 0;
  private readonly scale: number;
  private readonly applyMaterial: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(depthTexture: THREE.DepthTexture, scene: THREE.Scene, camera: THREE.Camera, scale: number) {
    super();
    this.needsSwap = false;
    this.scale = scale;
    this.gtao = new DepthGtaoPass(scene, camera, 2, 2, { depthTexture });
    this.gtao.output = GTAOPass.OUTPUT.Off;
    this.gtao.updateGtaoMaterial({ radius: AO_RADIUS, thickness: AO_THICKNESS, distanceExponent: 1.4, scale: 1, samples: AO_SAMPLES });
    this.gtao.updatePdMaterial({ samples: 12, rings: 2, radius: 6 });
    this.applyMaterial = new THREE.ShaderMaterial({
      name: 'post-ao-apply',
      uniforms: { tAO: { value: this.gtao.gtaoMap }, intensity: { value: 0 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: AO_APPLY_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.quad = new FullScreenQuad(this.applyMaterial);
  }

  setView(scene: THREE.Scene, camera: THREE.Camera): void {
    this.gtao.scene = scene;
    this.gtao.camera = camera;
  }

  override setSize(width: number, height: number): void {
    this.gtao.setSize(Math.max(2, Math.round(width * this.scale)), Math.max(2, Math.round(height * this.scale)));
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    // output Off: the GTAO pass only fills its own (denoised) AO target
    this.gtao.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    this.applyMaterial.uniforms.intensity.value = this.intensity;
    renderer.setRenderTarget(readBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.gtao.dispose();
    this.applyMaterial.dispose();
    this.quad.dispose();
  }
}

export interface PostPipelineOptions {
  /** MSAA samples of the scene target (0 = off) */
  samples: number;
  /** bloom resolution relative to the drawing buffer (0.25..1) */
  bloomScale: number;
  /** ambient-occlusion resolution relative to the drawing buffer (0 = no AO pass, else 0.25..1) */
  aoScale?: number;
  /** resolve the scene depth for the aerial perspective in the grade pass (AO resolves it anyway) */
  haze?: boolean;
}

/** The composer and its passes; render() draws one scene / camera through the chain to the full canvas. */
export class PostPipeline {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly ao: AmbientOcclusionPass | null;
  private readonly bloom: SelectiveBloomPass;
  private readonly grade: ShaderPass;
  private readonly gradeUniforms: GradeUniforms;
  private readonly output: OutputPass;
  /** placeholders so the render pass never keeps a disposed scene alive */
  private readonly idleScene = new THREE.Scene();
  private readonly idleCamera = new THREE.Camera();
  private grainFrame = 0;
  private disposed = false;
  /** the grade pass reads the resolved scene depth for the aerial perspective */
  private readonly hazeEnabled: boolean;

  constructor(renderer: THREE.WebGLRenderer, opts: PostPipelineOptions) {
    this.renderer = renderer;
    const samples = Math.max(0, Math.floor(Number.isFinite(opts.samples) ? opts.samples : 0));
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples }));
    this.composer.setPixelRatio(1);
    // renderTarget2 (the initial read buffer) receives the scene: MSAA + depth, depth never needs resolving.
    // renderTarget1 only receives the full-screen grade: no MSAA, no depth.
    const sceneTarget = this.composer.renderTarget2;
    sceneTarget.texture.name = 'post.scene';
    // AO and the aerial perspective read the scene's depth: resolve it into a depth texture; otherwise depth never needs resolving
    const aoScale = Number.isFinite(opts.aoScale) && (opts.aoScale ?? 0) > 0 ? clamp(opts.aoScale ?? 0, 0.25, 1) : 0;
    if (aoScale > 0 || opts.haze === true) {
      sceneTarget.depthTexture = new THREE.DepthTexture(1, 1);
      sceneTarget.depthTexture.name = 'post.depth';
      sceneTarget.resolveDepthBuffer = true;
    } else sceneTarget.resolveDepthBuffer = false;
    const gradeTarget = this.composer.renderTarget1;
    gradeTarget.texture.name = 'post.grade';
    gradeTarget.samples = 0;
    gradeTarget.depthBuffer = false;

    this.renderPass = new RenderPass(this.idleScene, this.idleCamera);
    this.ao = sceneTarget.depthTexture && aoScale > 0 ? new AmbientOcclusionPass(sceneTarget.depthTexture, this.idleScene, this.idleCamera, aoScale) : null;
    this.hazeEnabled = sceneTarget.depthTexture !== null;
    this.bloom = new SelectiveBloomPass(clamp(Number.isFinite(opts.bloomScale) ? opts.bloomScale : 1, 0.25, 1));
    this.gradeUniforms = {
      tDiffuse: { value: null },
      tint: { value: new THREE.Vector3(1, 1, 1) },
      saturation: { value: 1 },
      contrast: { value: 1 },
      lift: { value: 0 },
      liftRange: { value: GRADE_LIFT_RANGE },
      pivot: { value: GRADE_PIVOT },
      vignette: { value: 0 },
      vignetteStart: { value: VIGNETTE_START },
      aspect: { value: 16 / 9 },
      speedBlur: { value: 0 },
      speedBlurStart: { value: SPEED_BLUR_START },
      chroma: { value: 0 },
      grain: { value: 0 },
      grainSeed: { value: 0 },
      split: { value: 0 },
      sharpen: { value: 0 },
      texel: { value: new THREE.Vector2(1, 1) },
      tDepth: { value: sceneTarget.depthTexture },
      projInv: { value: new THREE.Matrix4() },
      viewInv: { value: new THREE.Matrix4() },
      camPos: { value: new THREE.Vector3() },
      hazeAmount: { value: 0 },
      hazeDensity: { value: 0 },
      hazeHeight: { value: 1000 },
      hazeBase: { value: 0 },
      hazeColor: { value: new THREE.Vector3() },
      hazeSteep: { value: new THREE.Vector3() },
      hazeSun: { value: new THREE.Vector3() },
      hazeSunDir: { value: new THREE.Vector3(0, 1, 0) },
      hazeBlue: { value: 0 },
      hazeCap: { value: 1 },
      cloudMap: { value: null },
      cloudShadow: { value: 0 },
      cloudCover: { value: 0 },
      cloudSoft: { value: 0.3 },
      cloudOffset: { value: new THREE.Vector2() },
    };
    this.grade = new ShaderPass(
      new THREE.ShaderMaterial({
        name: 'post-grade',
        uniforms: this.gradeUniforms,
        defines: {
          SPLIT_SHADOW: glslVec3(GRADE_SPLIT_SHADOW),
          SPLIT_HIGHLIGHT: glslVec3(GRADE_SPLIT_HIGHLIGHT),
          ...(this.hazeEnabled
            ? {
                USE_HAZE: '',
                HAZE_SUN_POWER: HAZE_SUN_POWER.toFixed(1),
                CLOUD_SHADOW_HEIGHT: CLOUD_SHADOW_HEIGHT.toFixed(1),
                CLOUD_SHADOW_TILE: CLOUD_SHADOW_TILE.toFixed(1),
              }
            : {}),
        },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: GRADE_FRAG,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass);
    if (this.ao) this.composer.addPass(this.ao);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.output);
  }

  /** Cloud noise of the current sky for the next render() only (cloud shadows of the aerial perspective; null = none). */
  setCloudMap(map: THREE.Texture | null): void {
    this.gradeUniforms.cloudMap.value = map;
  }

  /** Resize every target to the drawing buffer (device pixels). */
  setSize(width: number, height: number): void {
    if (this.disposed) return;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.composer.setSize(w, h);
    this.gradeUniforms.aspect.value = w / h;
    this.gradeUniforms.texel.value.set(1 / w, 1 / h);
  }

  /**
   * Draw `scene` through the chain to the full canvas (caller sets the full viewport, exposure and clear colour).
   * renderer.info then counts the scene plus every post pass of this view.
   */
  render(scene: THREE.Scene, camera: THREE.Camera, look: PostLook, dt: number): void {
    if (this.disposed) return;
    const b = look.bloom;
    this.bloom.enabled = b.strength > 0;
    this.bloom.strength = b.strength;
    this.bloom.radius = clamp(b.radius, 0, 1);
    this.bloom.threshold = b.threshold;
    const u = this.gradeUniforms;
    const g = look.grade;
    u.tint.value.set(g.tint[0], g.tint[1], g.tint[2]);
    u.saturation.value = g.saturation;
    u.contrast.value = g.contrast;
    u.lift.value = g.lift;
    u.split.value = Number.isFinite(g.split) ? clamp(g.split, 0, 1) : 0;
    u.sharpen.value = Number.isFinite(look.sharpen) ? clamp(look.sharpen, 0, 0.5) : 0;
    u.vignette.value = clamp(look.vignette, 0, 1);
    u.speedBlur.value = Number.isFinite(look.speedBlur) ? clamp(look.speedBlur, 0, 1) : 0;
    u.chroma.value = Number.isFinite(look.chroma) ? clamp(look.chroma, 0, 0.02) : 0;
    u.grain.value = Number.isFinite(look.grain) ? clamp(look.grain, 0, 0.2) : 0;
    this.grainFrame = (this.grainFrame + 1) % 64;
    u.grainSeed.value = this.grainFrame;
    const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
    if (this.hazeEnabled) {
      const h = look.haze;
      u.hazeAmount.value = persp && Number.isFinite(h.amount) ? clamp(h.amount, 0, 1) : 0;
      if (u.hazeAmount.value > 0) {
        camera.updateMatrixWorld();
        u.projInv.value.copy(camera.projectionMatrixInverse);
        u.viewInv.value.copy(camera.matrixWorld);
        u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
        u.hazeDensity.value = Math.max(0, h.density);
        u.hazeHeight.value = Math.max(1, h.height);
        u.hazeBase.value = h.base;
        u.hazeColor.value.fromArray(h.color);
        u.hazeSteep.value.fromArray(h.steep);
        u.hazeSun.value.fromArray(h.sun);
        u.hazeSunDir.value.fromArray(h.sunDir);
        u.hazeBlue.value = clamp(h.blueShift, 0, 1);
        u.hazeCap.value = clamp(h.cap, 0, 1);
        u.cloudShadow.value = u.cloudMap.value && Number.isFinite(h.cloudShadow) ? clamp(h.cloudShadow, 0, 1) : 0;
        u.cloudCover.value = h.cloudCover;
        u.cloudSoft.value = h.cloudSoft;
        u.cloudOffset.value.fromArray(h.cloudOffset);
      }
    }
    if (this.ao) {
      const aoIntensity = Number.isFinite(look.ao) ? clamp(look.ao, 0, 1) : 0;
      this.ao.enabled = aoIntensity > 0 && persp;
      this.ao.intensity = aoIntensity;
      this.ao.setView(scene, camera);
    }
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    // the scene always lands in the multisampled target, whatever the swap parity left by the previous frame
    this.composer.readBuffer = this.composer.renderTarget2;
    this.composer.writeBuffer = this.composer.renderTarget1;
    const info = this.renderer.info;
    const autoReset = info.autoReset;
    info.autoReset = false;
    info.reset();
    try {
      this.composer.render(Number.isFinite(dt) ? dt : 0);
    } finally {
      info.autoReset = autoReset;
      this.renderPass.scene = this.idleScene;
      this.renderPass.camera = this.idleCamera;
      this.ao?.setView(this.idleScene, this.idleCamera);
      // the cloud map belongs to the scene that set it for this frame (it may be disposed with that scene)
      this.gradeUniforms.cloudMap.value = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderPass.dispose();
    this.ao?.dispose();
    this.bloom.dispose();
    this.grade.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
