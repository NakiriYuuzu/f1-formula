/**
 * Benchmark loop. Each timed frame is one 1/60 s step of the real session (sim, HUD, scene, post chain) followed by a
 * 1 × 1 readPixels, which cannot return before the GPU has finished the frame. The loop yields to the event loop
 * between frames but never waits for the display, so the numbers do not depend on the monitor's refresh rate.
 */
import { Vector2 } from 'three';
import type { QualityLevel } from '../../core/types';
import type { GameRenderer } from '../../render/GameRenderer';
import { guessQuality, isSoftwareGpu } from '../../render/core/autoQuality';
import type { QualityProfile } from '../../render/core/quality';
import {
  summarize,
  type BenchCounters,
  type BenchEnv,
  type BenchParams,
  type BenchResult,
  type BenchRow,
  type BenchScenario,
} from './benchSpec';

export interface BenchHost {
  readonly gr: GameRenderer;
  /** Make `level` the quality of the next scenes, with these table fields overridden. */
  setQuality(level: QualityLevel, tune: Partial<QualityProfile>): void;
  /** Load the scenario as the running session; resolves once frames can be drawn. */
  load(scenario: BenchScenario): Promise<void>;
  /** Fast-forward `seconds` of play (no frames timed) and draw once. */
  runUp(seconds: number): void;
  /** One frame: 1/60 s of play, the HUD, a draw. */
  frame(): void;
  /** Session phase ('lights', 'running', ...). */
  phase(): string;
  unload(): void;
}

export interface BenchHooks {
  progress(message: string): void;
  row(result: BenchResult): void;
}

const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
let waiting: (() => void) | null = null;
if (channel) {
  channel.port1.onmessage = () => {
    const f = waiting;
    waiting = null;
    f?.();
  };
}

/** Back to the event loop and straight on: no display refresh, no timer clamp. */
function yieldNow(): Promise<void> {
  return new Promise((resolve) => {
    if (!channel) {
      setTimeout(resolve, 0);
      return;
    }
    waiting = resolve;
    channel.port2.postMessage(0);
  });
}

function readEnv(gr: GameRenderer): BenchEnv {
  const gl = gr.renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  return {
    userAgent: navigator.userAgent,
    gpu,
    software: isSoftwareGpu(gpu),
    autoPick: guessQuality(gpu),
    deviceDpr: window.devicePixelRatio || 1,
    maxSamples: gr.renderer.capabilities.maxSamples || 0,
    startedAt: new Date().toISOString(),
  };
}

function median(values: number[]): number {
  return summarize(values).median;
}

export async function runBench(host: BenchHost, p: BenchParams, hooks: BenchHooks): Promise<BenchResult> {
  const gr = host.gr;
  const gl = gr.renderer.getContext();
  const info = gr.renderer.info;
  const pixel = new Uint8Array(4);
  const bufferSize = new Vector2();
  const result: BenchResult = {
    version: 1,
    env: readEnv(gr),
    params: {
      qualities: p.qualities,
      scenarios: p.scenarios.map((s) => s.id),
      dprs: p.dprs,
      scale: p.scale,
      cssWidth: p.width,
      cssHeight: p.height,
      frames: p.frames,
      warmup: p.warmup,
      runs: p.runs,
      antialias: p.antialias,
      tune: p.tune,
      ab: p.ab,
    },
    rows: [],
    done: false,
  };
  let errors = 0;
  const consoleError = console.error;
  console.error = (...args: unknown[]): void => {
    errors++;
    consoleError.apply(console, args);
  };
  const autoReset = info.autoReset;
  info.autoReset = false;
  const tuned = Object.keys(p.tune).length > 0;
  const total = p.runs * p.dprs.length * p.qualities.length * p.scenarios.length * (p.ab ? 2 : 1);
  let cell = 0;

  try {
    for (let run = 1; run <= p.runs; run++) {
      for (const dpr of p.dprs) {
        gr.setBenchView({ width: p.width, height: p.height, dpr });
        for (const quality of p.qualities) {
          for (const scenario of p.scenarios) {
            // alternate which variant goes first so drift and warm-up favour neither
            const variants: ('base' | 'tuned')[] = !tuned ? ['base'] : p.ab ? (run % 2 === 1 ? ['base', 'tuned'] : ['tuned', 'base']) : ['tuned'];
            for (const variant of variants) {
              cell++;
              hooks.progress(`${cell}/${total}  ${quality} · ${scenario.id}${variant === 'tuned' ? ' (tuned)' : ''} · run ${run}`);
              host.setQuality(quality, variant === 'tuned' ? p.tune : {});
              await host.load(scenario);
              if (scenario.runUpSeconds > 0) host.runUp(p.runUp ?? scenario.runUpSeconds);
              const frames = Math.max(1, Math.min(p.frames, scenario.maxFrames - p.warmup));
              const ms: number[] = [];
              const cpu: number[] = [];
              const wait: number[] = [];
              const calls: number[] = [];
              const tris: number[] = [];
              const errorsBefore = errors;
              for (let i = 0; i < p.warmup + frames; i++) {
                info.reset();
                const t0 = performance.now();
                host.frame();
                const t1 = performance.now();
                gr.renderer.setRenderTarget(null);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                const t2 = performance.now();
                if (i >= p.warmup) {
                  ms.push(t2 - t0);
                  cpu.push(t1 - t0);
                  wait.push(t2 - t1);
                  calls.push(info.render.calls);
                  tris.push(info.render.triangles);
                }
                await yieldNow();
              }
              if (p.hold) {
                result.done = true;
                hooks.progress('hold');
                return result;
              }
              const fc = gr.frameCost;
              const size = gr.renderer.getDrawingBufferSize(bufferSize);
              const counters: BenchCounters = {
                drawCalls: median(calls),
                triangles: median(tris),
                programs: info.programs?.length ?? 0,
                canvasWidth: size.x,
                canvasHeight: size.y,
                canvasPixels: size.x * size.y,
                canvasSamples: gr.canvasSamples,
                sceneSamples: fc.sceneSamples,
                fullscreenPasses: fc.fullscreenPasses,
                postFillMpx: Math.round(fc.postFillPixels / 1e4) / 100,
                shadowRenders: fc.shadowRenders,
                lights: fc.lights,
                shadowLights: fc.shadowLights,
                ibl: fc.ibl,
              };
              const row: BenchRow = {
                run,
                variant,
                quality,
                dpr,
                pixelRatio: Math.round(gr.pixelRatio * 1000) / 1000,
                scenario: scenario.id,
                frames,
                frameMs: summarize(ms),
                cpuMs: summarize(cpu),
                gpuWaitMs: summarize(wait),
                counters,
                phaseEnd: host.phase(),
                errors: errors - errorsBefore,
              };
              result.rows.push(row);
              host.unload();
              hooks.row(result);
            }
          }
        }
      }
    }
    result.done = true;
    return result;
  } finally {
    console.error = consoleError;
    info.autoReset = autoReset;
  }
}
