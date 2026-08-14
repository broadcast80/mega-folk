import { Engine } from '@babylonjs/core/Engines/engine.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
// Adds `captureGPUFrameTime` to the WebGL engine. Without it, engine
// instrumentation throws the moment GPU timing is switched on — and only on the
// WebGL path, because WebGPU has its own.
import '@babylonjs/core/Engines/Extensions/engine.query.js';

import { loadWebGpuShaders } from './shaders.js';

export type Backend = 'webgpu' | 'webgl';

export type EngineHandle = {
  engine: AbstractEngine;
  backend: Backend;
  /** True when the adapter can answer with real GPU frame time. */
  gpuTiming: boolean;
};

export class EngineUnavailableError extends Error {}

/**
 * Creates the requested engine — and never silently falls back.
 *
 * A quiet downgrade to WebGL is how a project ends up comparing WebGPU against
 * WebGL and measuring WebGL twice. If WebGPU was asked for and cannot be had,
 * that is a message on screen, not a different renderer.
 */
export async function createEngine(
  canvas: HTMLCanvasElement,
  options: { backend: Backend; antialias: boolean; pixelRatio: number },
): Promise<EngineHandle> {
  const handle = options.backend === 'webgl'
    ? createWebGl(canvas, options.antialias)
    : await createWebGpu(canvas, options.antialias);

  handle.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio, options.pixelRatio));
  return handle;
}

function createWebGl(canvas: HTMLCanvasElement, antialias: boolean): EngineHandle {
  const engine = new Engine(canvas, antialias, {
    alpha: false,
    antialias,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    stencil: false,
  }, true);
  return { engine, backend: 'webgl', gpuTiming: Boolean(engine.getCaps().timerQuery) };
}

async function createWebGpu(canvas: HTMLCanvasElement, antialias: boolean): Promise<EngineHandle> {
  if (!await WebGPUEngine.IsSupportedAsync) {
    throw new EngineUnavailableError(
      'WebGPU недоступен в этом браузере. Игра намеренно не откатывается на WebGL — '
      + 'добавьте ?backend=webgl, если нужен запасной путь.',
    );
  }

  // `navigator.gpu` is not in the DOM lib this project compiles against, and
  // only two members are needed, so they are described locally rather than by
  // pulling in a whole types package.
  type MinimalAdapter = { features: { has(name: string): boolean } };
  type NavigatorGpu = {
    requestAdapter(options?: { powerPreference?: string }): Promise<MinimalAdapter | null>;
  };
  const gpu = (navigator as unknown as { gpu?: NavigatorGpu }).gpu;
  const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new EngineUnavailableError(
      'navigator.gpu.requestAdapter() вернул null. Страница открыта не по localhost? '
      + 'WebGPU требует secure context.',
    );
  }
  // Optional adapter feature: without it the HUD says so instead of quietly
  // showing CPU time in a slot labelled "gpu".
  const canTime = adapter.features.has('timestamp-query');

  const engine = new WebGPUEngine(canvas, {
    antialias,
    powerPreference: 'high-performance',
    deviceDescriptor: canTime ? { requiredFeatures: ['timestamp-query'] } : undefined,
  });
  await engine.initAsync();
  await loadWebGpuShaders();
  if (canTime) engine.enableGPUTimingMeasurements = true;
  return { engine, backend: 'webgpu', gpuTiming: canTime };
}
