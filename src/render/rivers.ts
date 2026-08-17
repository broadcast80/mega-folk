import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Scene } from '@babylonjs/core/scene.js';

import { riverWidthForFlow, type World } from '../world/index.js';
import { RIVER_COLOR } from './palette.js';

export type RiverResult = { mesh: Mesh | null; segments: number; triangles: number };

/** Where a river sits above the ground it runs on, to keep it off the z-buffer fight. */
const LIFT = 0.045;

/**
 * Rivers as one ribbon mesh through the cell centres they drain.
 *
 * The generator produces the drainage graph, not geometry: every land cell
 * above the catchment threshold has one downstream neighbour, and this walks
 * those pairs. Drawing them centre to centre is the simple reading of that
 * graph — Civ-style rivers running along hex *sides* need the dual grid, which
 * is a separate job and does not change the data underneath.
 */
export function createRivers(scene: Scene, world: World): RiverResult {
  const { rivers, surface, cells } = world;
  if (rivers.length === 0) return { mesh: null, segments: 0, triangles: 0 };

  const positions = new Float32Array(rivers.length * 4 * 3);
  const normals = new Float32Array(rivers.length * 4 * 3);
  const indices = new Uint32Array(rivers.length * 2 * 3);
  let vertex = 0;
  let cursor = 0;
  let segments = 0;

  for (const river of rivers) {
    const from = cells[river.from];
    const to = cells[river.to];
    const [fromX, fromZ] = surface.centreOf(from);
    const [toX, toZ] = surface.centreOf(to);
    const fromY = surface.heightForCell(from) + LIFT;
    // A river reaching the sea or a lake ends at the water surface, not at the
    // seabed the receiving cell's centre sits on.
    const toY = (to.water ? surface.waterHeightForCell(to) : surface.heightForCell(to)) + LIFT;

    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const length = Math.hypot(dx, dz);
    // Hydrology wraps east/west, while the current renderer deliberately shows
    // one flat copy of the cylindrical world. A neighbour across that seam is
    // hundreds of units away in rendered coordinates; joining the two centres
    // would draw a flashing blue stripe across the entire continent.
    if (length < 1e-4 || length > 2.1) continue;
    const half = riverWidthForFlow(river.flow) / 2;
    // Perpendicular in the ground plane; the ribbon is always horizontal in
    // cross-section, however steep the valley it runs down.
    const px = (-dz / length) * half;
    const pz = (dx / length) * half;

    const base = vertex;
    write(positions, normals, vertex++, fromX - px, fromY, fromZ - pz);
    write(positions, normals, vertex++, fromX + px, fromY, fromZ + pz);
    write(positions, normals, vertex++, toX + px, toY, toZ + pz);
    write(positions, normals, vertex++, toX - px, toY, toZ - pz);

    indices[cursor++] = base;
    indices[cursor++] = base + 1;
    indices[cursor++] = base + 2;
    indices[cursor++] = base;
    indices[cursor++] = base + 2;
    indices[cursor++] = base + 3;
    segments++;
  }

  const mesh = new Mesh('rivers', scene);
  const data = new VertexData();
  data.positions = positions.subarray(0, vertex * 3);
  data.normals = normals.subarray(0, vertex * 3);
  data.indices = indices.subarray(0, cursor);
  data.applyToMesh(mesh, false);

  const material = new StandardMaterial('river', scene);
  material.diffuseColor = new Color3(RIVER_COLOR[0], RIVER_COLOR[1], RIVER_COLOR[2]);
  material.specularColor = new Color3(0.25, 0.28, 0.3);
  // Winding follows the drainage direction, which can run either way around the
  // map, so both faces are drawn rather than guessing an orientation per
  // segment. The normals are authored straight up regardless.
  material.backFaceCulling = false;
  // Rivers are surface decals. Let the terrain establish scene depth, then
  // draw every part of the river without writing depth again. Tributary ribbons
  // overlap at confluences; if they write depth they fight each other whenever
  // the camera moves, despite having the same colour and height.
  material.disableDepthWrite = true;
  material.zOffset = -1;
  material.freeze();
  mesh.material = material;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.freezeWorldMatrix();

  return { mesh, segments, triangles: segments * 2 };
}

function write(positions: Float32Array, normals: Float32Array, vertex: number, x: number, y: number, z: number): void {
  positions[vertex * 3] = x;
  positions[vertex * 3 + 1] = y;
  positions[vertex * 3 + 2] = z;
  normals[vertex * 3] = 0;
  normals[vertex * 3 + 1] = 1;
  normals[vertex * 3 + 2] = 0;
}
