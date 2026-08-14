import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Scene } from '@babylonjs/core/scene.js';
// Side-effect import. Without it `thinInstanceSetBuffer` exists but silently
// does nothing: no buffer, no error, and `thinInstanceCount` stays undefined.
import '@babylonjs/core/Meshes/thinInstanceMesh.js';

import type { ScatterLayer, VegetationPlan } from '../world/index.js';
import { LEAF_SHADES, TRUNK_COLOR } from './palette.js';

export type VegetationResult = {
  meshes: Mesh[];
  trees: number;
  bushes: number;
  triangles: number;
  buildMs: number;
};

/** Trunk height at scale 1. The crown is stacked on top of exactly this. */
const TRUNK_HEIGHT = 0.55;

/**
 * All the plants in the world in three draw calls.
 *
 * Every plant is a thin instance of one of three prototypes, so the cost of a
 * forest is the cost of its triangles, not of its objects: 100k trees are three
 * meshes, three materials and three buffers. Leaf variety comes from a
 * per-instance colour rather than from three materials, which is what keeps it
 * at one draw call per prototype.
 */
export function createVegetation(
  scene: Scene,
  plan: VegetationPlan,
  options: { shadows: boolean },
): VegetationResult {
  const started = performance.now();

  const foliage = new StandardMaterial('foliage', scene);
  foliage.specularColor = Color3.Black();
  foliage.ambientColor = Color3.White();
  const bark = new StandardMaterial('bark', scene);
  bark.specularColor = Color3.Black();
  bark.ambientColor = Color3.White();

  const trunkMesh = prototype('trunk', trunkGeometry(0.075, TRUNK_HEIGHT), scene, bark);
  const crownMesh = prototype('crown', crownGeometry(0.42, 1), scene, foliage);
  const bushMesh = prototype('bush', crownGeometry(0.3, 0.6), scene, foliage);

  const trunks = buildBuffers(plan.trees, 'trunk');
  const crowns = buildBuffers(plan.trees, 'crown');
  const bushes = buildBuffers(plan.bushes, 'bush');

  const meshes: Mesh[] = [];
  let triangles = 0;
  const apply = (mesh: Mesh, buffers: InstanceBuffers): void => {
    if (buffers.count === 0) {
      mesh.setEnabled(false);
      return;
    }
    mesh.thinInstanceSetBuffer('matrix', buffers.matrices, 16, true);
    mesh.thinInstanceSetBuffer('color', buffers.colors, 4, true);
    // Without a refreshed bounding box the frustum test culls the whole layer
    // the moment the camera stops looking at the origin.
    mesh.thinInstanceRefreshBoundingInfo(false);
    mesh.receiveShadows = options.shadows;
    triangles += (mesh.getTotalIndices() / 3) * buffers.count;
    meshes.push(mesh);
  };

  apply(trunkMesh, trunks);
  apply(crownMesh, crowns);
  apply(bushMesh, bushes);

  foliage.freeze();
  bark.freeze();

  return {
    meshes,
    trees: plan.trees.count,
    bushes: plan.bushes.count,
    triangles,
    buildMs: performance.now() - started,
  };
}

type InstanceBuffers = { matrices: Float32Array; colors: Float32Array; count: number };

/**
 * One matrix and one colour per instance.
 *
 * The buffers are allocated at their final size up front: growing plain arrays
 * to a hundred thousand trees costs tens of megabytes of boxed numbers and a
 * visible stall before the first frame.
 */
function buildBuffers(layer: ScatterLayer, kind: 'trunk' | 'crown' | 'bush'): InstanceBuffers {
  const count = layer.count;
  const matrices = new Float32Array(count * 16);
  const colors = new Float32Array(count * 4);

  const matrix = Matrix.Identity();
  const scaling = new Vector3();
  const translation = new Vector3();
  const rotation = new Quaternion();
  const axis = Vector3.Up();

  for (let index = 0; index < count; index++) {
    const scale = layer.scale[index];
    const x = layer.position[index * 3];
    const y = layer.position[index * 3 + 1];
    const z = layer.position[index * 3 + 2];
    scaling.set(scale, scale, scale);
    // The crown rides on top of the trunk and shares its scale, so a tall tree
    // is a tall trunk with its crown lifted to match.
    translation.set(x, kind === 'crown' ? y + TRUNK_HEIGHT * scale : y, z);
    Quaternion.RotationAxisToRef(axis, layer.yaw[index], rotation);
    Matrix.ComposeToRef(scaling, rotation, translation, matrix);
    matrices.set(matrix.m, index * 16);

    const color = kind === 'trunk' ? TRUNK_COLOR : LEAF_SHADES[layer.shade[index] % LEAF_SHADES.length];
    colors[index * 4] = color[0];
    colors[index * 4 + 1] = color[1];
    colors[index * 4 + 2] = color[2];
    colors[index * 4 + 3] = 1;
  }

  return { matrices, colors, count };
}

/** Flat-shaded geometry needs its own vertex per face, so nothing is indexed. */
type RawGeometry = { positions: number[]; normals: number[] };

function prototype(name: string, geometry: RawGeometry, scene: Scene, material: StandardMaterial): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = new Float32Array(geometry.positions);
  data.normals = new Float32Array(geometry.normals);
  // Babylon builds its submeshes from the index buffer: geometry without
  // indices reports `getTotalIndices() === 0` and draws absolutely nothing,
  // with no error anywhere.
  const vertexCount = geometry.positions.length / 3;
  const indices = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index++) indices[index] = index;
  data.indices = indices;
  data.applyToMesh(mesh, false);
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}

function pushTriangle(
  out: RawGeometry,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): void {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length; ny /= length; nz /= length;
  out.positions.push(...a, ...b, ...c);
  for (let i = 0; i < 3; i++) out.normals.push(nx, ny, nz);
}

/** Hexagonal trunk: six side quads, twelve triangles, no caps. */
function trunkGeometry(radius: number, height: number): RawGeometry {
  const out: RawGeometry = { positions: [], normals: [] };
  for (let i = 0; i < 6; i++) {
    const a0 = (Math.PI / 3) * i;
    const a1 = (Math.PI / 3) * (i + 1);
    const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius;
    const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
    pushTriangle(out, [x0, 0, z0], [x1, 0, z1], [x1, height, z1]);
    pushTriangle(out, [x0, 0, z0], [x1, height, z1], [x0, height, z0]);
  }
  return out;
}

/** Icosahedron, optionally squashed: twenty triangles for a crown or a bush. */
function crownGeometry(radius: number, squash: number): RawGeometry {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: Array<[number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const scale = radius / Math.hypot(1, t, 0);
  // Lifted by its own squashed radius, so the shape sits *on* its origin rather
  // than half-buried in the ground it is placed on.
  const points = raw.map(([x, y, z]) =>
    [x * scale, y * scale * squash + radius * squash, z * scale] as [number, number, number]);

  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const out: RawGeometry = { positions: [], normals: [] };
  for (const [a, b, c] of faces) pushTriangle(out, points[a], points[b], points[c]);
  return out;
}
