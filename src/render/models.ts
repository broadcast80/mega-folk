import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
// Registers the glTF/GLB loader. Without it `LoadAssetContainerAsync` reports
// that it cannot find a plugin for the extension.
import '@babylonjs/loaders/glTF/2.0/index.js';

/**
 * GLB models drawn as thin instances.
 *
 * This is the pipeline for everything the game will place on the map in bulk —
 * buildings, wrecks, props, units that share a mesh. It is written once, here,
 * because the two mistakes it avoids are both silent:
 *
 *  - a loaded glTF arrives as a node hierarchy under a root with its own
 *    transform. Instancing that draws every instance at the origin unless the
 *    hierarchy is flattened and the transform baked into the vertices;
 *  - an asset URL must go through the bundler. A hand-written `./assets/x.glb`
 *    works in dev and breaks in a build: nothing references the file, so it is
 *    never emitted, the path 404s, the server answers with `index.html`, and
 *    the loader reports `Unexpected magic` on what it thinks is a model.
 *    Resolve URLs with `new URL('./assets/x.glb', import.meta.url).href` or
 *    `import.meta.glob(..., { query: '?url' })` and pass the result in.
 */

export type ModelPlacement = {
  x: number;
  y: number;
  z: number;
  /** Uniform scale, including the asset's own unit conversion. */
  scale: number;
  /** Rotation around the vertical axis, in radians. */
  yaw: number;
};

export type InstancedModel = {
  /** One entry per drawable mesh in the asset: also one draw call per frame. */
  meshes: Mesh[];
  instances: number;
  triangles: number;
};

/**
 * Loads one GLB and draws `placements` copies of it.
 *
 * The number of draw calls is the number of meshes *inside the model*, not the
 * number of placements — one model placed ten thousand times still costs what
 * one model costs. Splitting an asset into fewer meshes is therefore worth more
 * than any culling scheme.
 */
export async function loadInstancedModel(
  scene: Scene,
  url: string,
  placements: readonly ModelPlacement[],
  options: { pickable?: boolean } = {},
): Promise<InstancedModel> {
  const container = await LoadAssetContainerAsync(url, scene);
  container.addAllToScene();

  const drawable: Mesh[] = [];
  for (const node of container.meshes) {
    const mesh = node as Mesh;
    if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) {
      mesh.setEnabled(false);
      continue;
    }
    // `setParent(null)` keeps the world transform while dropping the glTF root;
    // baking then folds that transform into the vertex data, so nothing is left
    // to walk per frame.
    mesh.setParent(null);
    mesh.bakeCurrentTransformIntoVertices();
    mesh.isPickable = options.pickable ?? false;
    drawable.push(mesh);
  }

  const matrices = new Float32Array(placements.length * 16);
  const matrix = Matrix.Identity();
  const scaling = new Vector3();
  const translation = new Vector3();
  const rotation = new Quaternion();
  const axis = Vector3.Up();
  for (let index = 0; index < placements.length; index++) {
    const placement = placements[index];
    scaling.set(placement.scale, placement.scale, placement.scale);
    translation.set(placement.x, placement.y, placement.z);
    Quaternion.RotationAxisToRef(axis, placement.yaw, rotation);
    Matrix.ComposeToRef(scaling, rotation, translation, matrix);
    matrices.set(matrix.m, index * 16);
  }

  let triangles = 0;
  const meshes: Mesh[] = [];
  for (const mesh of drawable) {
    if (placements.length === 0) {
      // A prototype with no instances still costs a draw call at the origin.
      mesh.setEnabled(false);
      continue;
    }
    mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
    // Without this the bounding box stays at the origin and the frustum test
    // culls every instance the moment the camera looks away from it.
    mesh.thinInstanceRefreshBoundingInfo(false);
    triangles += (mesh.getTotalIndices() / 3) * placements.length;
    meshes.push(mesh);
  }

  return { meshes, instances: placements.length, triangles };
}
