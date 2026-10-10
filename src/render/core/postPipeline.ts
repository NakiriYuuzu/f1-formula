/**
 * Post-processing chain for one full-screen view (owned by GameRenderer, shared by RaceScene and ShowroomScene):
 * RenderPass into a half-float HDR target (MSAA) -> selective bloom (UnrealBloomPass with a soft-knee
 * brightest-channel bright pass, optionally at reduced resolution) -> speed blur + grade + vignette ShaderPass -> OutputPass.
 * While the chain is used the scene renders un-tone-mapped in linear space (three only tone-maps to the screen), so
 * OutputPass alone applies renderer.toneMapping / toneMappingExposure and the sRGB transfer: tone mapping runs once.
 * Sizes are drawing-buffer pixels (the composer runs at pixel ratio 1).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { clamp } from '../../core/math';
import {
  BLOOM_KNEE,
  BLOOM_MAX_INPUT,
  GRADE_LIFT_RANGE,
  GRADE_PIVOT,
  SPEED_BLUR_START,
  SPEED_BLUR_TAPS,
  VIGNETTE_START,
  type PostLook,
} from './post';

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

/**
 * Radial speed blur (taps toward the screen centre, faded in from speedBlurStart so the centre stays sharp), then
 * grade (tint, saturation, pivot-power contrast, toe lift) + vignette, all in linear HDR before OutputPass.
 */
const GRADE_FRAG = /* glsl */ `
const int SPEED_BLUR_TAPS = ${SPEED_BLUR_TAPS};
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
varying vec2 vUv;
void main() {
  vec4 src = texture2D(tDiffuse, vUv);
  vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
  float r = length(d) / (0.5 * length(vec2(aspect, 1.0)));
  vec3 c = max(src.rgb, vec3(0.0));
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
  c *= tint;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, saturation), vec3(0.0));
  c = pivot * pow(max(c / pivot, vec3(1e-6)), vec3(contrast));
  c += lift * (1.0 - smoothstep(vec3(0.0), vec3(liftRange), c));
  c *= 1.0 - vignette * smoothstep(vignetteStart, 1.0, r);
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

export interface PostPipelineOptions {
  /** MSAA samples of the scene target (0 = off) */
  samples: number;
  /** bloom resolution relative to the drawing buffer (0.25..1) */
  bloomScale: number;
}

/** The composer and its passes; render() draws one scene / camera through the chain to the full canvas. */
export class PostPipeline {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloom: SelectiveBloomPass;
  private readonly grade: ShaderPass;
  private readonly gradeUniforms: GradeUniforms;
  private readonly output: OutputPass;
  /** placeholders so the render pass never keeps a disposed scene alive */
  private readonly idleScene = new THREE.Scene();
  private readonly idleCamera = new THREE.Camera();
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, opts: PostPipelineOptions) {
    this.renderer = renderer;
    const samples = Math.max(0, Math.floor(Number.isFinite(opts.samples) ? opts.samples : 0));
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples }));
    this.composer.setPixelRatio(1);
    // renderTarget2 (the initial read buffer) receives the scene: MSAA + depth, depth never needs resolving.
    // renderTarget1 only receives the full-screen grade: no MSAA, no depth.
    const sceneTarget = this.composer.renderTarget2;
    sceneTarget.texture.name = 'post.scene';
    sceneTarget.resolveDepthBuffer = false;
    const gradeTarget = this.composer.renderTarget1;
    gradeTarget.texture.name = 'post.grade';
    gradeTarget.samples = 0;
    gradeTarget.depthBuffer = false;

    this.renderPass = new RenderPass(this.idleScene, this.idleCamera);
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
    };
    this.grade = new ShaderPass(
      new THREE.ShaderMaterial({
        name: 'post-grade',
        uniforms: this.gradeUniforms,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: GRADE_FRAG,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.output);
  }

  /** Resize every target to the drawing buffer (device pixels). */
  setSize(width: number, height: number): void {
    if (this.disposed) return;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.composer.setSize(w, h);
    this.gradeUniforms.aspect.value = w / h;
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
    u.vignette.value = clamp(look.vignette, 0, 1);
    u.speedBlur.value = Number.isFinite(look.speedBlur) ? clamp(look.speedBlur, 0, 1) : 0;
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
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderPass.dispose();
    this.bloom.dispose();
    this.grade.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
