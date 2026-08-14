import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import type { Scene } from '@babylonjs/core/scene.js';

import { CORNERS } from '../world/hexLayout.js';
import type { TerrainSurface, WorldCell } from '../world/index.js';

/** Lift above the ground, enough to clear the terrain without floating. */
const LIFT = 0.035;

/**
 * The hex under the cursor, drawn as a lid that follows the ground.
 *
 * It is one seven-vertex mesh whose positions are rewritten when the highlight
 * moves, rather than a mesh per hex or a mesh rebuilt per frame. The corner
 * heights come from the same surface the terrain mesh was built from, so the
 * highlight lies flat on the hex it marks even on a steep slope.
 */
export class HexCursor {
  readonly mesh: Mesh;
  private readonly positions = new Float32Array(7 * 3);
  private current: WorldCell | null = null;

  constructor(scene: Scene, private readonly surface: TerrainSurface, color = new Color3(1, 0.92, 0.55)) {
    this.mesh = new Mesh('hex-cursor', scene);
    const data = new VertexData();
    data.positions = this.positions;
    data.normals = new Float32Array(7 * 3).map((_, index) => (index % 3 === 1 ? 1 : 0));
    const indices = new Uint32Array(6 * 3);
    for (let corner = 0; corner < 6; corner++) {
      indices[corner * 3] = 0;
      indices[corner * 3 + 1] = 1 + ((corner + 1) % 6);
      indices[corner * 3 + 2] = 1 + corner;
    }
    data.indices = indices;
    // Updatable: the positions are rewritten every time the highlight moves.
    data.applyToMesh(this.mesh, true);

    const material = new StandardMaterial('hex-cursor', scene);
    material.emissiveColor = color;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    // Unlit on purpose: a highlight that dims in shadow is a bad highlight.
    material.disableLighting = true;
    material.alpha = 0.34;
    material.backFaceCulling = false;
    // Pull it toward the camera in the depth test rather than trusting the lift
    // alone, which loses at grazing angles.
    material.zOffset = -4;
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = false;
    this.mesh.setEnabled(false);
  }

  get cell(): WorldCell | null { return this.current; }

  /** Moves the highlight, or hides it when the pointer leaves the map. */
  show(cell: WorldCell | null): void {
    if (cell === this.current) return;
    this.current = cell;
    if (!cell) {
      this.mesh.setEnabled(false);
      return;
    }
    const [centreX, centreZ] = this.surface.centreOf(cell);
    this.write(0, centreX, this.surface.heightForCell(cell) + LIFT, centreZ);
    for (let corner = 0; corner < 6; corner++) {
      this.write(
        corner + 1,
        centreX + CORNERS[corner][0],
        this.surface.cornerHeight(cell, corner) + LIFT,
        centreZ + CORNERS[corner][1],
      );
    }
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions);
    this.mesh.setEnabled(true);
  }

  dispose(): void {
    this.mesh.material?.dispose();
    this.mesh.dispose();
  }

  private write(vertex: number, x: number, y: number, z: number): void {
    this.positions[vertex * 3] = x;
    this.positions[vertex * 3 + 1] = y;
    this.positions[vertex * 3 + 2] = z;
  }
}
