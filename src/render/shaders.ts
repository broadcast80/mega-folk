/**
 * Static shader registration.
 *
 * Babylon 9 fetches a material's shader with a dynamic import the first time an
 * effect is created. In a dev server a stale chunk turns that into an HTTP
 * request that answers with `index.html`, and the compiler then reports a
 * syntax error in a shader nobody wrote. Importing them up front removes the
 * failure mode entirely, at the cost of a few kilobytes in the main bundle.
 *
 * WGSL is loaded on demand rather than statically, because it is dead weight on
 * the WebGL path — but it is awaited before the first frame, not during it.
 */

import '@babylonjs/core/Shaders/default.vertex.js';
import '@babylonjs/core/Shaders/default.fragment.js';
import '@babylonjs/core/Shaders/color.vertex.js';
import '@babylonjs/core/Shaders/color.fragment.js';

export async function loadWebGpuShaders(): Promise<void> {
  await Promise.all([
    import('@babylonjs/core/ShadersWGSL/default.vertex.js'),
    import('@babylonjs/core/ShadersWGSL/default.fragment.js'),
    import('@babylonjs/core/ShadersWGSL/color.vertex.js'),
    import('@babylonjs/core/ShadersWGSL/color.fragment.js'),
  ]);
}
