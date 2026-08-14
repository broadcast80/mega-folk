import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { EngineInstrumentation } from '@babylonjs/core/Instrumentation/engineInstrumentation.js';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation.js';
import type { Scene } from '@babylonjs/core/scene.js';

export type FrameReport = {
  fps: number;
  /** Milliseconds between *presented* frames. */
  p50: number;
  p95: number;
  p99: number;
  cpuMs: number;
  /** Real GPU time, or null when the adapter cannot measure it. */
  gpuMs: number | null;
  drawCalls: number;
  /** True when the GPU is behind the submit rate — the FPS number is lying. */
  backlog: boolean;
};

const WINDOW = 180;

/**
 * Honest frame measurement.
 *
 * A plain FPS counter measures how fast the render loop spins, which on WebGPU
 * is not how fast frames reach the screen: `scene.render()` only submits
 * commands and does not wait for the GPU. So this tracks two things a counter
 * cannot — the distribution of intervals between presented frames, and the real
 * GPU time from timestamp queries — and says so out loud when the GPU is busier
 * than the interval between frames, because that is the state where the counter
 * reads 60 and the picture crawls.
 */
export class FrameStats {
  private readonly intervals: number[] = [];
  private readonly cpuTimes: number[] = [];
  private readonly engineInstrumentation: EngineInstrumentation;
  private readonly sceneInstrumentation: SceneInstrumentation;
  private lastFrameAt = performance.now();
  private frameStartedAt = 0;
  private reportedAt = 0;

  constructor(engine: AbstractEngine, scene: Scene, private readonly gpuTiming: boolean) {
    this.engineInstrumentation = new EngineInstrumentation(engine);
    this.engineInstrumentation.captureGPUFrameTime = gpuTiming;
    this.sceneInstrumentation = new SceneInstrumentation(scene);
  }

  /** Call at the top of the render loop, before anything else. */
  beginFrame(): void {
    const now = performance.now();
    this.intervals.push(now - this.lastFrameAt);
    if (this.intervals.length > WINDOW) this.intervals.shift();
    this.lastFrameAt = now;
    this.frameStartedAt = now;
  }

  /** Call after `scene.render()`. */
  endFrame(): void {
    this.cpuTimes.push(performance.now() - this.frameStartedAt);
    if (this.cpuTimes.length > WINDOW) this.cpuTimes.shift();
  }

  /** A report at most every `intervalMs`, or null in between. */
  report(intervalMs = 500): FrameReport | null {
    const now = performance.now();
    if (now - this.reportedAt < intervalMs) return null;
    this.reportedAt = now;

    const p50 = percentile(this.intervals, 0.5);
    const gpuMs = this.gpuTiming
      ? this.engineInstrumentation.gpuFrameTimeCounter.current * 0.000001
      : null;
    return {
      fps: p50 > 0 ? Math.round(1000 / p50) : 0,
      p50,
      p95: percentile(this.intervals, 0.95),
      p99: percentile(this.intervals, 0.99),
      cpuMs: average(this.cpuTimes),
      gpuMs,
      drawCalls: this.sceneInstrumentation.drawCallsCounter.current,
      backlog: gpuMs !== null && gpuMs > p50 * 1.35,
    };
  }

  dispose(): void {
    this.engineInstrumentation.dispose();
    this.sceneInstrumentation.dispose();
  }
}

/** Percentile over a copy, so the caller's ring buffer keeps its order. */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}
