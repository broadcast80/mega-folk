import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Scene } from '@babylonjs/core/scene.js';

import { CORNERS } from '../world/hexLayout.js';
import type { World } from '../world/index.js';
import { LAKE_COLOR, SEA_COLOR } from './palette.js';

export type WaterResult = {
  meshes: Mesh[];
  triangles: number;
};

/**
 * Two water surfaces, because a world has two kinds of water.
 *
 * The sea is one plane over the whole map: every sea cell shares one level by
 * definition, so a plane is both cheaper and flatter than any mesh built from
 * cells. Lakes are not — each basin keeps the level it filled to, which can
 * stand well above sea level — so they are drawn as their own hex tops.
 */
export function createWater(scene: Scene, world: World): WaterResult {
  const meshes: Mesh[] = [];
  let triangles = 0;

  const sea = createSeaPlane(scene, world);
  meshes.push(sea);
  triangles += 2;

  const lakes = createLakeSurfaces(scene, world);
  if (lakes) {
    meshes.push(lakes.mesh);
    triangles += lakes.triangles;
  }

  return { meshes, triangles };
}

function waterMaterial(scene: Scene, name: string, color: readonly [number, number, number], alpha: number): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = new Color3(color[0], color[1], color[2]);
  // A little specular is what makes water read as water rather than as blue
  // paper when the sun is low.
  material.specularColor = new Color3(0.35, 0.38, 0.4);
  material.specularPower = 96;
  material.alpha = alpha;
  material.backFaceCulling = false;
  return material;
}

function createSeaPlane(scene: Scene, world: World): Mesh {
  const { bounds } = world;
  const y = world.surface.settings.seaSurfaceY;
  const mesh = new Mesh('sea', scene);
  const data = new VertexData();
  data.positions = new Float32Array([
    bounds.minX, y, bounds.minZ,
    bounds.maxX, y, bounds.minZ,
    bounds.maxX, y, bounds.maxZ,
    bounds.minX, y, bounds.maxZ,
  ]);
  data.normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  data.indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  data.applyToMesh(mesh, false);
  mesh.material = waterMaterial(scene, 'sea', SEA_COLOR, 0.82);
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.alphaIndex = 0;
  mesh.freezeWorldMatrix();
  return mesh;
}

function createLakeSurfaces(scene: Scene, world: World): { mesh: Mesh; triangles: number } | null {
  const lakeCells = world.cells.filter((cell) => cell.waterKind === 'lake');
  if (lakeCells.length === 0) return null;

  const positions = new Float32Array(lakeCells.length * 7 * 3);
  const normals = new Float32Array(lakeCells.length * 7 * 3);
  const indices = new Uint32Array(lakeCells.length * 6 * 3);
  let vertex = 0;
  let cursor = 0;

  for (const cell of lakeCells) {
    const [centreX, centreZ] = world.surface.centreOf(cell);
    // One level for the whole basin, so lake hexes meet without a seam.
    const y = world.surface.waterHeightForCell(cell);
    const base = vertex;
    write(positions, normals, vertex++, centreX, y, centreZ);
    for (let corner = 0; corner < 6; corner++) {
      write(positions, normals, vertex++, centreX + CORNERS[corner][0], y, centreZ + CORNERS[corner][1]);
    }
    for (let corner = 0; corner < 6; corner++) {
      indices[cursor++] = base;
      indices[cursor++] = base + 1 + ((corner + 1) % 6);
      indices[cursor++] = base + 1 + corner;
    }
  }

  const mesh = new Mesh('lakes', scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.indices = indices;
  data.applyToMesh(mesh, false);
  mesh.material = waterMaterial(scene, 'lake', LAKE_COLOR, 0.86);
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.alphaIndex = 1;
  mesh.freezeWorldMatrix();
  return { mesh, triangles: lakeCells.length * 6 };
}

function write(positions: Float32Array, normals: Float32Array, vertex: number, x: number, y: number, z: number): void {
  positions[vertex * 3] = x;
  positions[vertex * 3 + 1] = y;
  positions[vertex * 3 + 2] = z;
  normals[vertex * 3] = 0;
  normals[vertex * 3 + 1] = 1;
  normals[vertex * 3 + 2] = 0;
}
