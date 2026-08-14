import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Scene } from '@babylonjs/core/scene.js';
// No `shadowGeneratorSceneComponent` side-effect import here on purpose: since
// Babylon 9 the ShadowGenerator constructor registers that component itself,
// and the module is no longer listed in the package's `sideEffects`, so
// importing it only earns a bundler warning about an import it is dropping.

import { SKY_COLOR } from './palette.js';
import type { Backend } from './engine.js';

export type SceneOptions = {
  backend: Backend;
  shadows: boolean;
  shadowMapSize: number;
  /** Half-width of the sun's ortho box, in world units. */
  shadowSpan: number;
  /** Compile the shadow pass as GLSL on WebGPU. See the note at its use. */
  shadowGlsl: boolean;
  /** Hemispheric fill intensity. See the note below before raising it. */
  fill: number;
  /** Camera far plane, also the shadow depth budget. */
  far: number;
};

export type SceneRig = {
  scene: Scene;
  sun: DirectionalLight;
  fill: HemisphericLight;
  shadowGenerator: ShadowGenerator | null;
  /** Adds a mesh as a shadow caster, if shadows are on at all. */
  addCaster(mesh: AbstractMesh): void;
  /** Empties the caster list, for when the whole world is being replaced. */
  clearCasters(): void;
  /** Keeps the sun's ortho box over the point the camera is looking at. */
  followTarget(x: number, y: number, z: number): void;
};

/** Direction the sunlight travels. Low enough that hills throw a long shadow. */
const SUN_DIRECTION = new Vector3(-0.45, -0.85, -0.3).normalize();

export function createScene(engine: AbstractEngine, options: SceneOptions): SceneRig {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(SKY_COLOR[0], SKY_COLOR[1], SKY_COLOR[2], 1);
  // Ambient is added on top of every light and is never shadowed, so a bright
  // one flattens the picture and takes the shadow term with it.
  scene.ambientColor = new Color3(0.12, 0.13, 0.16);
  // Nothing in this scene reacts to hover through Babylon's own picking — the
  // hex cursor ray-marches the height field instead — so the per-move scene
  // pick is pure cost.
  scene.skipPointerMovePicking = true;

  /**
   * Fill light. This number decides whether shadows are visible at all: the sun
   * is the only caster, so fill is exactly what washes them out. At 0.72
   * against a sun of 1.15, shadowed ground keeps most of its brightness and the
   * shadows — rendered correctly all along — simply cannot be seen. If shadows
   * ever look missing, check this before going near the shadow pass.
   */
  const fill = new HemisphericLight('fill', new Vector3(0.2, 1, 0.15), scene);
  fill.intensity = options.fill;
  fill.groundColor = new Color3(0.32, 0.34, 0.38);
  fill.specular = Color3.Black();

  const sun = new DirectionalLight('sun', SUN_DIRECTION.clone(), scene);
  sun.intensity = 1.35;
  sun.specular = new Color3(0.15, 0.15, 0.14);
  sun.position = new Vector3(0, 220, 0);

  let shadowGenerator: ShadowGenerator | null = null;
  if (options.shadows) {
    // The world is ~500 units across. Auto-fitting the sun frustum to casters
    // that span all of it stretches one shadow map over the whole map and
    // produces nothing you can see, so the box is pinned to a usable span and
    // moved with the camera — shadows are crisp where the player is looking,
    // and there are none beyond that. That is the trade, and it is deliberate.
    sun.autoUpdateExtends = false;
    sun.shadowMinZ = 1;
    sun.shadowMaxZ = options.shadowSpan * 6;
    sun.orthoLeft = -options.shadowSpan;
    sun.orthoRight = options.shadowSpan;
    sun.orthoBottom = -options.shadowSpan;
    sun.orthoTop = options.shadowSpan;

    // Shadow shader language on WebGPU, and the one setting here with history.
    //
    // Every caster in this scene is a thin-instance mesh. On Babylon 9.21.0 the
    // native WGSL shadow variant built an invalid render pipeline for those on
    // Dawn — the pass produced nothing and the scene rendered shadowless — and
    // the documented way out was `forceGLSL`, which is what city-folk and the
    // WebGPU bench both do. On 9.21.2 that path is the one that breaks instead:
    // it routes the shadow shader through glslang and throws "GLSL compilation
    // failed" before the first frame. So the default is now the native WGSL
    // path, and the old compatibility route is one URL parameter away
    // (`?shadowglsl=1`) for the day the framework flips again. Note that GLSL
    // on WebGPU also pulls twgsl from the Babylon CDN, so the WGSL default is
    // the only one that works offline.
    //
    // `useRedTextureType` drops the pointless RGBA half-float attachment.
    shadowGenerator = new ShadowGenerator(
      options.shadowMapSize,
      sun,
      false,
      null,
      true,
      options.shadowGlsl && options.backend === 'webgpu',
    );
    shadowGenerator.usePercentageCloserFiltering = true;
    shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    shadowGenerator.bias = 0.0005;
    shadowGenerator.normalBias = 0.025;
    shadowGenerator.setDarkness(0.12);
  }

  const generator = shadowGenerator;
  const back = options.shadowSpan * 2.5;

  return {
    scene,
    sun,
    fill,
    shadowGenerator,
    addCaster(mesh: AbstractMesh): void {
      // `false` skips the descendant walk: these meshes are flat prototypes.
      generator?.addShadowCaster(mesh, false);
    },
    clearCasters(): void {
      // Disposing a mesh does not reliably take it out of a shadow map's render
      // list, and a disposed caster left there is drawn on the next shadow pass.
      const shadowMap = generator?.getShadowMap();
      if (shadowMap?.renderList) shadowMap.renderList.length = 0;
    },
    followTarget(x: number, y: number, z: number): void {
      if (!generator) return;
      sun.position.set(
        x - SUN_DIRECTION.x * back,
        y - SUN_DIRECTION.y * back,
        z - SUN_DIRECTION.z * back,
      );
    },
  };
}
