/**
 * GameRenderer: owns the single WebGLRenderer bound to the game canvas. ACES filmic tone mapping,
 * sRGB output, PCF shadows by quality, pixel ratio = min(devicePixelRatio, 2) × resolutionScale × adaptive scale,
 * full-viewport sizing on window resize / fullscreen changes, and WebGL context-loss tolerance
 * (rendering is skipped while the context is lost; three.js re-uploads buffers / textures afterwards, and scenes
 * watch `contextVersion` to regenerate GPU-only content such as PMREM environment maps).
 * Also owns the shared post-processing chain (postPipeline(): rebuilt after a context restore, resized with the
 * drawing buffer) and the adaptive resolution controller fed by beginFrame() (race views only).
 */
import * as THREE from 'three';
import type { Settings } from '../core/types';
import { clamp } from '../core/math';
import { AdaptiveResolution, POST_MSAA_SAMPLES } from './core/post';
import { PostPipeline } from './core/postPipeline';
import { qualityProfile, shadowSizeFor, type QualityProfile } from './core/quality';

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  settings: Settings;
  quality: QualityProfile;
  /** incremented on every applySettings(); scenes re-sync lazily when it changes */
  settingsVersion = 0;
  /** incremented whenever the drawing buffer is resized */
  sizeVersion = 0;
  /** incremented on every WebGL context restore (render-target contents are lost and must be rebuilt) */
  contextVersion = 0;
  private contextLost = false;
  private disposed = false;
  private widthCss = 1;
  private heightCss = 1;
  /** the GPU can render to half-float targets (required by the HDR post chain) */
  private readonly postSupported: boolean;
  private post: PostPipeline | null = null;
  /** contextVersion | samples | bloom scale the current chain was built for */
  private postKey = '';
  /** sizeVersion the current chain was sized for */
  private postSizeVersion = -1;
  private readonly bufferSize = new THREE.Vector2();
  private readonly adaptive = new AdaptiveResolution();
  /** whether the last beginFrame() asked for adaptive resolution (race) or the user's fixed choice (menus) */
  private adaptiveActive = false;
  private lastFrameAt = Number.NaN;
  private readonly onResize = (): void => this.resize();
  private readonly onLost = (): void => {
    this.contextLost = true;
  };
  private readonly onRestored = (): void => {
    this.contextLost = false;
    this.contextVersion++;
    this.resize();
  };

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.quality = qualityProfile(settings.quality);
    // listeners first so a loss during creation is tracked
    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: settings.antialias !== false,
        alpha: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      });
    } catch (err) {
      canvas.removeEventListener('webglcontextlost', this.onLost, false);
      canvas.removeEventListener('webglcontextrestored', this.onRestored, false);
      throw err;
    }
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.enabled = shadowSizeFor(settings) > 0;
    r.shadowMap.autoUpdate = false;
    r.autoClear = false;
    r.setClearColor(0x06080d, 1);
    this.postSupported = r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
    if (!canvas.style.display) canvas.style.display = 'block';
    window.addEventListener('resize', this.onResize);
    document.addEventListener('fullscreenchange', this.onResize);
    this.resize();
  }

  /** Re-apply quality / resolution scale / shadows. (antialias can only change on the next page load.) */
  applySettings(settings: Settings): void {
    if (this.disposed) return;
    this.settings = settings;
    this.quality = qualityProfile(settings.quality);
    this.renderer.shadowMap.enabled = shadowSizeFor(settings) > 0;
    if (!this.postEnabled) this.releasePost();
    this.settingsVersion++;
    this.resize();
  }

  /**
   * Match the drawing buffer to the viewport size × devicePixelRatio (≤ 2) × resolutionScale × the adaptive
   * resolution scale (1 outside races).
   */
  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, Math.floor(window.innerWidth || this.canvas.clientWidth || 1));
    const h = Math.max(1, Math.floor(window.innerHeight || this.canvas.clientHeight || 1));
    const scale = clamp(Number.isFinite(this.settings.resolutionScale) ? this.settings.resolutionScale : 1, 0.5, 1);
    const pr = Math.min(window.devicePixelRatio || 1, 2) * scale * this.adaptive.scale;
    if (w === this.widthCss && h === this.heightCss && Math.abs(this.renderer.getPixelRatio() - pr) < 1e-6 && this.sizeVersion > 0) return;
    this.widthCss = w;
    this.heightCss = h;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, true);
    this.sizeVersion++;
  }

  /**
   * Call once per drawn frame (by the scene that draws it). `adaptive` = race views: the real frame time (time
   * between calls) feeds the adaptive resolution controller, which resizes the drawing buffer in ~10 % steps
   * between 60 % and 100 % of the user's choice. Menus pass false and always render at the user's choice.
   */
  beginFrame(adaptive: boolean): void {
    if (this.disposed) return;
    const now = performance.now();
    const frameSec = (now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    if (adaptive !== this.adaptiveActive) {
      this.adaptiveActive = adaptive;
      this.resetAdaptiveResolution();
      return;
    }
    if (adaptive && this.adaptive.sample(frameSec)) this.resize();
  }

  /** Back to the user's full resolution with fresh frame-time windows (e.g. a new race scene). */
  resetAdaptiveResolution(): void {
    if (this.disposed) return;
    const prev = this.adaptive.scale;
    this.adaptive.reset();
    if (prev !== this.adaptive.scale) this.resize();
  }

  /** Adaptive resolution: current fraction (0.6..1) of the user's pixel ratio (for HUD / debug). */
  get adaptiveScale(): number {
    return this.adaptive.scale;
  }

  /** Average frame time (ms) of the last 2 s adaptive-resolution window (NaN before the first / outside races). */
  get frameTimeMs(): number {
    return this.adaptive.lastAverageMs;
  }

  /** Effective pixel ratio of the drawing buffer. */
  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  /** The post chain is on for the current quality (and the GPU renders half-float targets). */
  get postEnabled(): boolean {
    return this.quality.post && this.postSupported;
  }

  /**
   * The shared post chain sized to the drawing buffer, or null when post is off (quality low, no half-float
   * render targets, context lost). Rebuilt after a context restore or an anti-aliasing / bloom-scale change.
   * Single full-screen views only: split-screen renders directly (see RaceScene.render).
   */
  postPipeline(): PostPipeline | null {
    if (this.disposed || !this.postEnabled || this.isContextLost()) return null;
    const maxSamples = this.renderer.capabilities.maxSamples || 0;
    const samples = this.settings.antialias !== false ? Math.min(POST_MSAA_SAMPLES, maxSamples) : 0;
    const bloomScale = this.quality.bloomScale;
    const key = `${this.contextVersion}|${samples}|${bloomScale}`;
    if (!this.post || key !== this.postKey) {
      this.releasePost();
      this.post = new PostPipeline(this.renderer, { samples, bloomScale });
      this.postKey = key;
    }
    if (this.postSizeVersion !== this.sizeVersion) {
      this.renderer.getDrawingBufferSize(this.bufferSize);
      this.post.setSize(this.bufferSize.x, this.bufferSize.y);
      this.postSizeVersion = this.sizeVersion;
    }
    return this.post;
  }

  private releasePost(): void {
    this.post?.dispose();
    this.post = null;
    this.postKey = '';
    this.postSizeVersion = -1;
  }

  /** Logical (CSS) size of the canvas. */
  get width(): number {
    return this.widthCss;
  }

  get height(): number {
    return this.heightCss;
  }

  isContextLost(): boolean {
    if (this.contextLost) return true;
    try {
      return this.renderer.getContext().isContextLost();
    } catch {
      return true;
    }
  }

  /**
   * Convert a normalized CSS-style viewport (origin top-left) to renderer.setViewport / setScissor
   * arguments (logical pixels, origin bottom-left; three multiplies by the pixel ratio itself).
   */
  viewportRect(vp: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    const W = this.widthCss;
    const H = this.heightCss;
    const nx = clamp(Number.isFinite(vp.x) ? vp.x : 0, 0, 1);
    const ny = clamp(Number.isFinite(vp.y) ? vp.y : 0, 0, 1);
    const nw = clamp(Number.isFinite(vp.w) ? vp.w : 1, 0, 1 - nx);
    const nh = clamp(Number.isFinite(vp.h) ? vp.h : 1, 0, 1 - ny);
    const x = Math.round(nx * W);
    const w = Math.max(1, Math.round((nx + nw) * W) - x);
    const top = Math.round(ny * H);
    const bottom = Math.round((ny + nh) * H);
    const h = Math.max(1, bottom - top);
    return { x, y: H - bottom, w, h };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('fullscreenchange', this.onResize);
    this.canvas.removeEventListener('webglcontextlost', this.onLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored, false);
    this.releasePost();
    this.renderer.dispose();
  }
}
