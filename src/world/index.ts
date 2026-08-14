/**
 * The world layer's public surface.
 *
 * Everything below this file is headless: no Babylon, no DOM, no globals. The
 * renderer and the game rules both consume `World`, and neither can reach past
 * it into a generation detail. `scripts/check-boundaries.mjs` enforces that.
 */

import { generateWorld } from './generator.js';
import { TerrainSurface } from './surface.js';
import type { SurfaceSettings } from './surface.js';
import type { GeneratedWorld, WorldCell, WorldParams } from './types.js';

export type { Biome, GeneratedWorld, RiverSegment, WorldCell, WorldParams, WorldShape, WorldStats } from './types.js';
export type { SurfaceHit, SurfaceSettings, WorldBounds } from './surface.js';
export type { ScatterLayer, VegetationPlan, VegetationSettings } from './vegetation.js';
export { TerrainSurface, SURFACE_DEFAULTS } from './surface.js';
export { planVegetation, naturalForestCover, VEGETATION_DEFAULTS } from './vegetation.js';
export { generateWorld } from './generator.js';
export * from './hexLayout.js';
export { mulberry32, hashString, hashCoords } from './random.js';
export type { Rng } from './random.js';

export const WORLD_DEFAULTS: WorldParams = {
  seed: 'neo-war',
  width: 288,
  height: 208,
  shape: 'islands',
  landPercent: 0.24,
  // City-folk ran 17–26 passes here and spent two thirds of generation on them.
  // The valley network is cut in the first handful; the rest only rounds it off.
  erosionPasses: 8,
  seaLevel: 0,
};

/**
 * A generated world plus the surface that reads it. This is the object the rest
 * of the game holds on to.
 */
export class World {
  readonly generated: GeneratedWorld;
  readonly surface: TerrainSurface;

  constructor(params: WorldParams, surfaceSettings?: Partial<SurfaceSettings>) {
    this.generated = generateWorld(params);
    this.surface = new TerrainSurface(this.generated, surfaceSettings);
  }

  get params(): WorldParams { return this.generated.params; }
  get cells(): WorldCell[] { return this.generated.cells; }
  get rivers() { return this.generated.rivers; }
  get stats() { return this.generated.stats; }
  get bounds() { return this.surface.bounds; }
  get width(): number { return this.generated.params.width; }
  get height(): number { return this.generated.params.height; }

  cellAt(col: number, row: number): WorldCell | undefined {
    return this.surface.cellAt(col, row);
  }

  cellAtWorld(x: number, z: number): WorldCell | undefined {
    return this.surface.cellAtWorld(x, z);
  }

  /** Dry, gentle land nearest the map centre: where a first base belongs. */
  findStartCell(): WorldCell | undefined {
    const centreCol = Math.floor(this.width / 2);
    const centreRow = Math.floor(this.height / 2);
    let best: WorldCell | undefined;
    let bestScore = Infinity;
    for (const cell of this.cells) {
      if (cell.water || cell.waterDistance < 2 || cell.slope > 0.26) continue;
      if (cell.biome === 'mountain' || cell.biome === 'snowy-mountain') continue;
      const dc = cell.col - centreCol;
      const dr = cell.row - centreRow;
      const score = dc * dc + dr * dr;
      if (score >= bestScore) continue;
      bestScore = score;
      best = cell;
    }
    return best;
  }
}
