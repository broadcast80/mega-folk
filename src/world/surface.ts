import {
  cellAtPoint,
  cellCentre,
  COLUMN_STRIDE,
  CORNERS,
  cornerSector,
  INRADIUS,
  ROW_STRIDE,
  triangleWeights,
} from './hexLayout.js';
import { NEIGHBOUR_OFFSETS, wrapColumn } from './hexGrid.js';
import { periodicFbm } from './noise.js';
import { hashString } from './random.js';
import type { GeneratedWorld, WorldCell } from './types.js';

export type SurfaceSettings = {
  /** One multiplier over the whole vertical axis: relief exaggeration. */
  verticalScale: number;
  landAmplitude: number;
  landExponent: number;
  oceanDepth: number;
  oceanExponent: number;
  /** Sub-hex bumpiness, so a plain is not a mirror. */
  detailAmplitude: number;
  /** Height a full crest adds above the broad curve. */
  ridgeAmplitude: number;
  /** Above 1 keeps the lower flanks gentle and saves the height for the crest. */
  ridgeExponent: number;
  /** Height of the sea vertices in the integrated terrain/water surface. */
  seaSurfaceY: number;
};

export const SURFACE_DEFAULTS: Readonly<SurfaceSettings> = {
  verticalScale: 1.15,
  landAmplitude: 2.8,
  landExponent: 1.18,
  oceanDepth: 0.32,
  oceanExponent: 0.72,
  detailAmplitude: 0.08,
  ridgeAmplitude: 4.6,
  ridgeExponent: 1.4,
  seaSurfaceY: 0.008,
};

export type SurfaceHit = { x: number; y: number; z: number; cell: WorldCell };

export type WorldBounds = {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  spanX: number; spanZ: number;
  centreX: number; centreZ: number;
};

/**
 * The deterministic CPU description of the visible ground.
 *
 * It owns no GPU state. The terrain mesh, tree placement, the camera and hit
 * testing all ask this one object how high the ground is, so they cannot drift
 * apart — and none of them needs the renderer to exist to get an answer.
 */
export class TerrainSurface {
  readonly settings: Readonly<SurfaceSettings>;
  readonly width: number;
  readonly height: number;
  readonly bounds: WorldBounds;
  /** Highest point the surface can reach anywhere: the ray march's ceiling. */
  readonly maxHeight: number;
  private readonly cells: WorldCell[];
  private readonly detailSeed: number;
  private readonly detailFrequency: number;

  constructor(readonly world: GeneratedWorld, settings: Partial<SurfaceSettings> = {}) {
    this.settings = { ...SURFACE_DEFAULTS, ...settings };
    this.width = world.params.width;
    this.height = world.params.height;
    this.cells = world.cells;

    const minX = -INRADIUS;
    const maxX = (this.width - 1 + 0.5) * COLUMN_STRIDE + INRADIUS;
    const minZ = -1;
    const maxZ = (this.height - 1) * ROW_STRIDE + 1;
    this.bounds = {
      minX, maxX, minZ, maxZ,
      spanX: maxX - minX,
      spanZ: maxZ - minZ,
      centreX: (minX + maxX) / 2,
      centreZ: (minZ + maxZ) / 2,
    };

    this.detailSeed = hashString(world.params.seed) ^ 0x51f15e;
    this.detailFrequency = Math.max(8, Math.round(this.width / 4));
    this.maxHeight = (this.settings.landAmplitude + this.settings.ridgeAmplitude
      + this.settings.detailAmplitude) * this.settings.verticalScale + 1;
  }

  /** Cell by offset coordinates. Columns wrap; rows past the rim do not exist. */
  cellAt(col: number, row: number): WorldCell | undefined {
    if (row < 0 || row >= this.height) return undefined;
    return this.cells[row * this.width + wrapColumn(col, this.width)];
  }

  cellAtWorld(x: number, z: number): WorldCell | undefined {
    const [col, row] = cellAtPoint(x, z);
    return this.cellAt(col, row);
  }

  centreOf(cell: WorldCell): [number, number] {
    return cellCentre(cell.col, cell.row);
  }

  neighbourAt(cell: WorldCell, direction: number): WorldCell | undefined {
    const offsets = cell.row % 2 === 0 ? NEIGHBOUR_OFFSETS.even : NEIGHBOUR_OFFSETS.odd;
    const [dc, dr] = offsets[((direction % 6) + 6) % 6];
    return this.cellAt(cell.col + dc, cell.row + dr);
  }

  /** Ground height at a cell centre. */
  heightForCell(cell: WorldCell): number {
    const [x, z] = this.centreOf(cell);
    return this.heightFromElevation(cell.elevation, x, z) + this.ridgeLift(cell.ridge);
  }

  /**
   * Ground height at one corner of a cell.
   *
   * The value is averaged over the three cells that meet at the corner, so two
   * neighbours computing "their" corner independently get exactly the same
   * number and the terrain mesh is watertight however tall the mountains are.
   */
  cornerHeight(cell: WorldCell, corner: number): number {
    const index = ((corner % 6) + 6) % 6;
    const [centreX, centreZ] = this.centreOf(cell);
    return this.heightFromElevation(
      this.cornerElevation(cell, index),
      centreX + CORNERS[index][0],
      centreZ + CORNERS[index][1],
    ) + this.ridgeLift(this.cornerRidge(cell, index));
  }

  cornerElevation(cell: WorldCell, corner: number): number {
    const a = this.neighbourAt(cell, corner - 1);
    const b = this.neighbourAt(cell, corner);
    let total = cell.elevation;
    let count = 1;
    if (a) { total += a.elevation; count++; }
    if (b) { total += b.elevation; count++; }
    return total / count;
  }

  cornerRidge(cell: WorldCell, corner: number): number {
    const a = this.neighbourAt(cell, corner - 1);
    const b = this.neighbourAt(cell, corner);
    let total = cell.ridge;
    let count = 1;
    if (a) { total += a.ridge; count++; }
    if (b) { total += b.ridge; count++; }
    return total / count;
  }

  /**
   * Ground height at an arbitrary point, interpolated over the same
   * centre/corner triangle the mesh is built from — so a tree placed here sits
   * on the drawn surface, not near it.
   */
  heightAtWorld(x: number, z: number): number | undefined {
    const cell = this.cellAtWorld(x, z);
    if (!cell) return undefined;
    return this.heightInCell(cell, x, z);
  }

  /**
   * The same interpolation when the caller already knows the cell.
   *
   * Placement loops iterate cells and scatter points inside them, so making
   * them re-derive the cell from the point costs a nearest-centre search per
   * plant for an answer they were holding all along.
   */
  heightInCell(cell: WorldCell, x: number, z: number): number {
    const [centreX, centreZ] = this.centreOf(cell);
    const localX = x - centreX;
    const localZ = z - centreZ;
    const corner = cornerSector(localX, localZ);
    const next = (corner + 1) % 6;
    const [centreWeight, cornerWeight, nextWeight] = triangleWeights(localX, localZ, corner, next);
    const elevation = cell.elevation * centreWeight
      + this.cornerElevation(cell, corner) * cornerWeight
      + this.cornerElevation(cell, next) * nextWeight;
    const ridge = cell.ridge * centreWeight
      + this.cornerRidge(cell, corner) * cornerWeight
      + this.cornerRidge(cell, next) * nextWeight;
    return this.heightFromElevation(elevation, x, z) + this.ridgeLift(ridge);
  }

  /** Height of the water surface on a cell: global sea, or the lake's level. */
  waterHeightForCell(cell: WorldCell): number {
    if (cell.waterKind !== 'lake') return this.settings.seaSurfaceY;
    const [x, z] = this.centreOf(cell);
    return this.heightFromElevation(cell.waterLevel, x, z);
  }

  /**
   * Height the mountain mass adds above the broad curve. `ridge` describes the
   * massif — zero at its foot, one on its crest — and it is interpolated exactly
   * like elevation, so a range climbs out of the surrounding ground as one
   * landform. Reading a single cell here would put a cone on every mountain hex.
   */
  ridgeLift(ridge: number): number {
    if (ridge <= 0) return 0;
    return Math.pow(Math.min(1, ridge), this.settings.ridgeExponent)
      * this.settings.ridgeAmplitude * this.settings.verticalScale;
  }

  /**
   * First point where a ray meets the ground.
   *
   * This is the project's hit test, and it deliberately does not touch the
   * terrain mesh: marching the height function costs a few dozen samples and is
   * independent of how the ground happens to be drawn, whereas mesh picking on
   * a 360k-triangle single mesh walks triangles. The march steps below one hex
   * so it cannot tunnel through a ridge, then bisects for the exact crossing.
   */
  raycast(
    originX: number, originY: number, originZ: number,
    dirX: number, dirY: number, dirZ: number,
    maxDistance = 4000,
  ): SurfaceHit | null {
    const length = Math.hypot(dirX, dirY, dirZ) || 1;
    const dx = dirX / length;
    const dy = dirY / length;
    const dz = dirZ / length;

    // Skip the empty sky: start where the ray drops below the highest possible
    // ground, and stop once it is below the deepest ocean floor.
    let start = 0;
    if (originY > this.maxHeight) {
      if (dy >= 0) return null;
      start = (originY - this.maxHeight) / -dy;
    }
    const floor = -this.settings.oceanDepth * this.settings.verticalScale - 1;
    let end = maxDistance;
    if (dy < 0) end = Math.min(end, (originY - floor) / -dy);
    if (start >= end) return null;

    const step = 0.45;
    let previousT = start;
    let previousGap = this.gapAt(originX + dx * start, originY + dy * start, originZ + dz * start);
    if (previousGap !== undefined && previousGap <= 0) {
      return this.hitAt(originX + dx * start, originY + dy * start, originZ + dz * start);
    }

    for (let t = start + step; t <= end; t += step) {
      const gap = this.gapAt(originX + dx * t, originY + dy * t, originZ + dz * t);
      if (gap === undefined || gap > 0) {
        previousT = t;
        previousGap = gap;
        continue;
      }
      // Bisect between the last airborne sample and this one.
      let low = previousGap === undefined ? t - step : previousT;
      let high = t;
      for (let iteration = 0; iteration < 16; iteration++) {
        const middle = (low + high) / 2;
        const sample = this.gapAt(originX + dx * middle, originY + dy * middle, originZ + dz * middle);
        if (sample === undefined || sample > 0) low = middle; else high = middle;
      }
      return this.hitAt(originX + dx * high, originY + dy * high, originZ + dz * high);
    }
    return null;
  }

  /** Ray height above the ground, or undefined outside the map. */
  private gapAt(x: number, y: number, z: number): number | undefined {
    const ground = this.heightAtWorld(x, z);
    return ground === undefined ? undefined : y - ground;
  }

  private hitAt(x: number, y: number, z: number): SurfaceHit | null {
    const cell = this.cellAtWorld(x, z);
    return cell ? { x, y, z, cell } : null;
  }

  private heightFromElevation(elevation: number, x: number, z: number): number {
    const { seaLevel } = this.world.params;
    const scale = this.settings.verticalScale;
    if (elevation < seaLevel) {
      const depth = (seaLevel - elevation) / Math.max(0.01, seaLevel);
      return -Math.pow(depth, this.settings.oceanExponent) * this.settings.oceanDepth * scale;
    }
    const land = (elevation - seaLevel) / Math.max(0.01, 1 - seaLevel);
    const coastLift = smoothstep(0, 0.055, land) * 0.018;
    const broadHeight = Math.pow(Math.max(0, land), this.settings.landExponent)
      * this.settings.landAmplitude * scale;
    const detailMask = smoothstep(0.025, 0.12, land);
    return coastLift + broadHeight + this.detailAtWorld(x, z) * detailMask;
  }

  private detailAtWorld(x: number, z: number): number {
    const u = x / (COLUMN_STRIDE * this.width);
    const v = z / (ROW_STRIDE * this.height);
    const noise = periodicFbm(this.detailSeed, u, v, this.detailFrequency, 3) - 0.5;
    return noise * 2 * this.settings.detailAmplitude * this.settings.verticalScale;
  }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-9, edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
}
