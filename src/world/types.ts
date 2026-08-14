/**
 * Data model of a generated world. Nothing in `world/` knows about Babylon,
 * the DOM or the game rules: it produces plain arrays that the renderer draws
 * and the game layer reasons about.
 */

/** Sea, or a filled depression standing above it. */
export type WaterKind = 'none' | 'sea' | 'lake';

export type WorldShape = 'islands' | 'archipelago';

export type Biome =
  | 'deep-ocean' | 'shallow-ocean' | 'lake' | 'beach'
  | 'grassland' | 'forest' | 'highland' | 'mountain' | 'snowy-mountain';

export type WorldParams = {
  seed: string;
  width: number;
  height: number;
  shape: WorldShape;
  /** Requested share of dry land, 0..1. The generator solves sea level for it. */
  landPercent: number;
  /**
   * Erosion passes. Each one is a full hydrology solve, so this is the single
   * knob that decides how long generation takes.
   */
  erosionPasses: number;
  /**
   * Solved, not requested: `generateWorld` returns the params it actually used,
   * so terrain height, water colour and the minimap all read one number instead
   * of re-deriving it.
   */
  seaLevel: number;
};

export type WorldCell = {
  /** `row * width + col`. Cells are addressed by index, never by string key. */
  index: number;
  col: number;
  row: number;
  elevation: number;
  temperature: number;
  moisture: number;
  /** Steps to the nearest water cell; 0 on water itself. */
  waterDistance: number;
  biome: Biome;
  water: boolean;
  waterKind: WaterKind;
  /** Height of this cell's water surface: sea level, or the lake's own level. */
  waterLevel: number;
  /** Upstream cells draining through here — the catchment, in cells. */
  flow: number;
  /** Steepest height step to a neighbour, in world units. */
  slope: number;
  /**
   * How deep the cell sits inside a mountain mass, 0 at the foot and 1 on the
   * crest. It describes the massif rather than the hex, so a range can rise as
   * one landform instead of becoming a row of cones.
   */
  ridge: number;
  /** Connected-component id of the landmass; -1 on water. */
  landmass: number;
  /** Index of the cell this one drains into, or -1. */
  downstream: number;
};

export type RiverSegment = { from: number; to: number; flow: number };

export type WorldStats = {
  cells: number;
  landPercent: number;
  seaPercent: number;
  lakePercent: number;
  lakes: number;
  landmasses: number;
  largestLandmassPercent: number;
  /** Share of land gentle enough to build on. */
  flatLandPercent: number;
  coastline: number;
  rivers: number;
  generationMs: number;
  /** Per-stage cost, so a slow world says which stage was slow. */
  stageMs: Record<string, number>;
  biomeCounts: Map<Biome, number>;
};

export type GeneratedWorld = {
  params: WorldParams;
  cells: WorldCell[];
  rivers: RiverSegment[];
  stats: WorldStats;
};
