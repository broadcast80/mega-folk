import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Scene } from '@babylonjs/core/scene.js';

import { CORNERS } from '../world/hexLayout.js';
import type { World } from '../world/index.js';
import { colorForCell } from './palette.js';

export type TerrainResult = {
  mesh: Mesh;
  vertices: number;
  triangles: number;
  buildMs: number;
};

/**
 * Which cell actually owns each corner.
 *
 * Three hexes meet at every corner, so a naive build computes each corner three
 * times. Every corner of a pointy-top hex is either the top vertex (corner 5)
 * or the bottom vertex (corner 2) of exactly one of those three cells, so
 * caching two heights per cell removes the duplicate work: `direction` is the
 * neighbour that owns the corner (-1 meaning this cell itself) and `slot` is
 * which of its two canonical corners it is.
 */
const CORNER_OWNER: ReadonlyArray<{ direction: number; slot: 0 | 1 }> = [
  { direction: 5, slot: 1 }, // ENE corner = bottom vertex of the NE neighbour
  { direction: 1, slot: 0 }, // ESE corner = top vertex of the SE neighbour
  { direction: -1, slot: 1 }, // bottom vertex, owned here
  { direction: 2, slot: 0 }, // WSW corner = top vertex of the SW neighbour
  { direction: 4, slot: 1 }, // WNW corner = bottom vertex of the NW neighbour
  { direction: -1, slot: 0 }, // top vertex, owned here
];

/** Canonical corner index for each slot: 0 is the top vertex, 1 the bottom. */
const SLOT_CORNER = [5, 2] as const;

/**
 * The whole world as one mesh: seven vertices per hex, six triangles, one draw
 * call, no chunks.
 *
 * Vertices are not shared between hexes, which is what lets every hex carry its
 * own flat biome colour without a second material. Corner *heights* are shared
 * through the cache above, so neighbouring hexes agree on the ground they meet
 * at and the surface is watertight however tall the mountains get.
 */
export function createTerrain(
  scene: Scene,
  world: World,
  options: { shadows: boolean },
): TerrainResult {
  const started = performance.now();
  const { surface, cells } = world;
  const size = cells.length;
  const seaLevel = world.params.seaLevel;

  const vertexCount = size * 7;
  const triangleCount = size * 6;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 4);
  const indices = new Uint32Array(triangleCount * 3);

  // Two canonical corner heights per cell, filled before the mesh walk so a
  // neighbour's value is always ready when it is asked for.
  const cornerCache = new Float32Array(size * 2);
  for (let index = 0; index < size; index++) {
    const cell = cells[index];
    cornerCache[index * 2] = surface.cornerHeight(cell, SLOT_CORNER[0]);
    cornerCache[index * 2 + 1] = surface.cornerHeight(cell, SLOT_CORNER[1]);
  }

  let vertex = 0;
  let cursor = 0;
  for (let index = 0; index < size; index++) {
    const cell = cells[index];
    const [centreX, centreZ] = surface.centreOf(cell);
    // Water cells meet high land through averaged corners. If their blue floor
    // is allowed to use those shared heights, it emerges above the water plane
    // as a blue ramp climbing a mountain. Keep the submerged side of the seam
    // below its own water surface; the plane/lake top closes the tiny gap.
    const waterCeiling = cell.water
      ? surface.waterHeightForCell(cell) - 0.006
      : Infinity;
    const centreY = Math.min(surface.heightForCell(cell), waterCeiling);

    const base = vertex;
    positions[vertex * 3] = centreX;
    positions[vertex * 3 + 1] = centreY;
    positions[vertex * 3 + 2] = centreZ;
    colorForCell(cell, seaLevel, colors, vertex * 4);
    vertex++;

    for (let corner = 0; corner < 6; corner++) {
      const owner = CORNER_OWNER[corner];
      let cornerY: number;
      if (owner.direction < 0) {
        cornerY = cornerCache[index * 2 + owner.slot];
      } else {
        const neighbour = surface.neighbourAt(cell, owner.direction);
        // Past the north or south rim there is no owner, so this cell computes
        // the corner itself. The value is the same average either way.
        cornerY = neighbour
          ? cornerCache[neighbour.index * 2 + owner.slot]
          : surface.cornerHeight(cell, corner);
      }
      positions[vertex * 3] = centreX + CORNERS[corner][0];
      positions[vertex * 3 + 1] = Math.min(cornerY, waterCeiling);
      positions[vertex * 3 + 2] = centreZ + CORNERS[corner][1];
      colors.copyWithin(vertex * 4, base * 4, base * 4 + 4);
      vertex++;
    }

    // Winding is (centre, i + 1, i): in a right-handed scene the reverse order
    // gives a downward normal, the ground stops catching the sun, and the whole
    // world renders as unlit slate.
    for (let corner = 0; corner < 6; corner++) {
      indices[cursor++] = base;
      indices[cursor++] = base + 1 + ((corner + 1) % 6);
      indices[cursor++] = base + 1 + corner;
    }
  }

  const mesh = new Mesh('terrain', scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.colors = colors;

  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  // Babylon computes normals with its native left-handed winding, so in a
  // right-handed scene the ground can come out facing away from the sky.
  // Rather than guess the convention, measure it once and flip.
  let upward = 0;
  for (let i = 1; i < normals.length; i += 3) upward += normals[i];
  if (upward < 0) {
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
    for (let i = 0; i < indices.length; i += 3) {
      const swap = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = swap;
    }
  }
  data.normals = normals;
  data.applyToMesh(mesh, false);

  const material = new StandardMaterial('terrain', scene);
  material.specularColor = Color3.Black();
  material.ambientColor = Color3.White();
  mesh.material = material;
  // Hit testing goes through the height field, not through this mesh: a
  // 360k-triangle single mesh is the worst possible thing to CPU-pick against.
  mesh.isPickable = false;
  mesh.receiveShadows = options.shadows;
  // The world never moves. Freezing skips the per-frame matrix and material
  // dirty checks for the largest mesh in the scene.
  mesh.freezeWorldMatrix();
  material.freeze();

  return {
    mesh,
    vertices: vertexCount,
    triangles: triangleCount,
    buildMs: performance.now() - started,
  };
}
