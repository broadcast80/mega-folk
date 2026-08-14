import { buildElevation, seaLevelForLand, shapeElevation } from './elevation.js';
import { EROSION_DEFAULTS, erodeTerrain } from './erosion.js';
import { HexGrid } from './hexGrid.js';
import { computeHydrology, DRY, LAKE, SEA, wanderWeights, type Hydrology } from './hydrology.js';
import { periodicFbm, verticalFrequencyScale } from './noise.js';
import { hashCoords, hashString } from './random.js';
import type { Biome, GeneratedWorld, RiverSegment, WorldCell, WorldParams, WorldStats } from './types.js';

/** Above 1 keeps most land low and gentle, and the summits rare. */
const RELIEF_CURVE = 1.68;
const DOMAIN_WARP = 0.32;
/**
 * Catchment a cell needs before it carries a drawn river, as a share of the
 * map. A fixed cell count makes every map a net of creeks — the drainage graph
 * reaches every hollow by construction, so this threshold is the only thing
 * deciding what counts as a river at all. Reading it from the map size keeps a
 * river the same fraction of a continent on any size.
 */
const RIVER_CATCHMENT_SHARE = 0.0018;
const MINIMUM_RIVER_CATCHMENT = 28;
/** Share of the dry range where a mountain mass has its foot. */
const RIDGE_FOOT = 0.65;
/** How far to look for the spine of the mass a cell belongs to. */
const RIDGE_SPINE_RADIUS = 5;
/** Half-width, in cells, a mass needs before it earns the full crest height. */
const RIDGE_FULL_WIDTH = 3;
/** Crest height kept regardless of the along-ridge variation. */
const RIDGE_VARIATION = 0.42;
/** Steepest step a cell may have and still count as buildable, in world units. */
const MAX_BUILD_STEP = 0.26;
/**
 * Matches the broad curve in `TerrainSurface`: elevation only means something
 * through it. The crest lift the surface adds on top is deliberately left out —
 * that is a shape inside one cell, not a step between two of them.
 */
const HEIGHT_AMPLITUDE = 2.8 * 1.15;
const HEIGHT_EXPONENT = 1.18;

/**
 * Islands, independent inland relief, then water and erosion.
 *
 * Coastline rank decides which cells are dry; a separate relief rank
 * distributes plains, hills, valleys and ranges on that land. Water is then
 * simulated rather than assumed — sea, lakes, drainage, catchment — and rivers
 * erode the terrain they run through.
 *
 * Every stage is timed into `stats.stageMs`, because "the world takes a while"
 * is not a bug report and this is where the answer lives.
 */
export function generateWorld(params: WorldParams): GeneratedWorld {
  const started = now();
  const stageMs: Record<string, number> = {};
  let stageStart = started;
  const stage = (name: string): void => {
    const current = now();
    stageMs[name] = current - stageStart;
    stageStart = current;
  };

  const grid = new HexGrid(params.width, params.height);
  const wander = wanderWeights(grid, hashString(`${params.seed}:rivers`));
  stage('grid');

  const field = buildElevation(grid, params, DOMAIN_WARP);
  stage('elevation');

  // Never more land than the non-polar band can hold: past that the rank pass
  // hands dry cells to the polar rows instead of widening the continents.
  const landPercent = Math.min(params.landPercent, field.dryBudget);
  const elevation = Float32Array.from(field.raw);
  const shapingLevel = shapeElevation(elevation, field.relief, landPercent, RELIEF_CURVE);
  stage('shaping');

  erodeTerrain(grid, elevation, field.land, shapingLevel, {
    ...EROSION_DEFAULTS,
    passes: params.erosionPasses,
  }, wander);
  stage('erosion');

  // Two solves, because both things that eat into the requested land share are
  // only knowable afterwards: erosion moves cells across the waterline, and
  // basins that were dry ground in the rank pass fill up as lakes.
  let seaLevel = seaLevelForLand(elevation, landPercent);
  let hydrology = computeHydrology(grid, elevation, seaLevel, { wander, lakes: true });
  const missing = countWater(hydrology.waterKind) / grid.size - (1 - landPercent);
  if (Math.abs(missing) > 0.005) {
    seaLevel = seaLevelForLand(elevation, Math.min(field.dryBudget, landPercent + missing));
    hydrology = computeHydrology(grid, elevation, seaLevel, { wander, lakes: true });
  }
  promoteInlandSeas(grid, hydrology);
  stage('hydrology');

  const resolved: WorldParams = { ...params, seaLevel };
  const waterDistance = measureWaterDistance(grid, hydrology.waterKind);
  const slope = measureSlope(grid, elevation, hydrology.waterKind, seaLevel);
  const cells = buildCells(grid, resolved, elevation, hydrology, waterDistance, slope);
  measureRidges(grid, cells, resolved);
  const landmassSizes = labelLandmasses(grid, cells);
  const rivers = collectRivers(grid, cells, hydrology);
  stage('cells');

  return {
    params: resolved,
    cells,
    rivers,
    stats: buildStats(grid, cells, hydrology, landmassSizes, rivers, now() - started, stageMs),
  };
}

/** Elevation as the renderer's world height, so a slope is a real step. */
export function heightOf(elevation: number, seaLevel: number): number {
  if (elevation <= seaLevel) return 0;
  return Math.pow((elevation - seaLevel) / Math.max(0.01, 1 - seaLevel), HEIGHT_EXPONENT) * HEIGHT_AMPLITUDE;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * How far inside a mountain mass every cell sits, as a 0..1 crest factor. It is
 * a distance transform, not a per-cell height: cells at the foot score 0 and
 * the score climbs inward, so the renderer can raise a whole range as one
 * landform growing out of the ground it stands on. Sampling the elevation of a
 * single hex instead turns a range into a row of cones.
 *
 * The depth is normalised against the widest point nearby rather than used raw.
 * Raw depth saturates a few cells in, which gives a broad massif a flat top and
 * a wall at its foot; against the local width the crest lands on the spine of
 * the mass wherever it runs, and the flanks fall away to the foot on both
 * sides. A narrow spur is scaled down by that same width, so it stays a
 * shoulder of the range instead of standing as tall as its main ridge.
 */
function measureRidges(grid: HexGrid, cells: WorldCell[], params: WorldParams): void {
  const depth = new Int32Array(grid.size).fill(-1);
  const queue = new Int32Array(grid.size);
  let tail = 0;
  for (let index = 0; index < grid.size; index++) {
    const cell = cells[index];
    const land = (cell.elevation - params.seaLevel) / Math.max(0.01, 1 - params.seaLevel);
    // The walk starts on the ground the massif rises out of, so depth 1 is its
    // first inner ring and the foot itself stays at zero.
    if (!cell.water && land >= RIDGE_FOOT) continue;
    depth[index] = 0;
    queue[tail++] = index;
  }
  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    for (let slot = 0; slot < 6; slot++) {
      const next = grid.neighbour(index, slot);
      if (next < 0 || depth[next] >= 0) continue;
      depth[next] = depth[index] + 1;
      queue[tail++] = next;
    }
  }

  const spine = localMaximum(grid, depth, RIDGE_SPINE_RADIUS);
  const seed = hashString(`${params.seed}:ridge`);
  const variation = smoothedNoise(grid, cells, seed);
  for (let index = 0; index < grid.size; index++) {
    const width = spine[index];
    if (depth[index] <= 0 || width <= 0) { cells[index].ridge = 0; continue; }
    const climb = Math.min(1, depth[index] / width);
    const stature = Math.min(1, width / RIDGE_FULL_WIDTH);
    cells[index].ridge = climb * stature
      * (RIDGE_VARIATION + (1 - RIDGE_VARIATION) * variation[index]);
  }
}

/** Deepest cell within `radius` steps: how wide the mass is where this cell is. */
function localMaximum(grid: HexGrid, depth: Int32Array, radius: number): Int32Array {
  let current = depth;
  // Typed as the parameter, not as a fresh array: the two buffers are swapped
  // below, and a narrower inferred type makes that swap a type error.
  let next: typeof depth = new Int32Array(grid.size);
  for (let pass = 0; pass < radius; pass++) {
    for (let index = 0; index < grid.size; index++) {
      let best = current[index];
      for (let slot = 0; slot < 6; slot++) {
        const neighbour = grid.neighbour(index, slot);
        if (neighbour >= 0 && current[neighbour] > best) best = current[neighbour];
      }
      next[index] = best;
    }
    const swap = current; current = next; next = swap;
  }
  return current;
}

/** Hashed per cell, then averaged over the neighbourhood: shoulders and saddles
 * spread over a few cells rather than alternating hex by hex. */
function smoothedNoise(grid: HexGrid, cells: WorldCell[], seed: number): Float32Array {
  const raw = new Float32Array(grid.size);
  for (let index = 0; index < grid.size; index++) {
    raw[index] = hashCoords(seed, cells[index].col, cells[index].row) / 4294967295;
  }
  const smoothed = new Float32Array(grid.size);
  for (let index = 0; index < grid.size; index++) {
    let total = raw[index];
    let count = 1;
    for (let slot = 0; slot < 6; slot++) {
      const neighbour = grid.neighbour(index, slot);
      if (neighbour < 0) continue;
      total += raw[neighbour];
      count++;
    }
    smoothed[index] = total / count;
  }
  return smoothed;
}

/**
 * A basin big enough to have its own coastline is an inland sea, not a lake. It
 * keeps its own water level and its outlet; only its size decides how it reads
 * to the biome table and to the renderer.
 */
function promoteInlandSeas(grid: HexGrid, hydrology: Hydrology): void {
  const minimum = Math.max(24, grid.size * 0.004);
  for (const lake of hydrology.lakes) {
    if (lake.cells < minimum) continue;
    for (let index = 0; index < grid.size; index++) {
      if (hydrology.lakeId[index] === lake.id) hydrology.waterKind[index] = SEA;
    }
  }
}

function countWater(waterKind: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < waterKind.length; index++) if (waterKind[index] !== DRY) total++;
  return total;
}

function measureSlope(
  grid: HexGrid,
  elevation: Float32Array,
  waterKind: Uint8Array,
  seaLevel: number,
): Float32Array {
  const slope = new Float32Array(grid.size);
  for (let index = 0; index < grid.size; index++) {
    if (waterKind[index] === SEA) continue;
    const height = heightOf(elevation[index], seaLevel);
    let worst = 0;
    for (let slot = 0; slot < 6; slot++) {
      const neighbour = grid.neighbour(index, slot);
      if (neighbour < 0) continue;
      worst = Math.max(worst, Math.abs(heightOf(elevation[neighbour], seaLevel) - height));
    }
    slope[index] = worst;
  }
  return slope;
}

function measureWaterDistance(grid: HexGrid, waterKind: Uint8Array): Float32Array {
  const distance = new Float32Array(grid.size).fill(Infinity);
  const queue = new Int32Array(grid.size);
  let tail = 0;
  for (let index = 0; index < grid.size; index++) {
    if (waterKind[index] === DRY) continue;
    distance[index] = 0;
    queue[tail++] = index;
  }
  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    for (let slot = 0; slot < 6; slot++) {
      const next = grid.neighbour(index, slot);
      if (next < 0 || distance[next] <= distance[index] + 1) continue;
      distance[next] = distance[index] + 1;
      queue[tail++] = next;
    }
  }
  return distance;
}

function buildCells(
  grid: HexGrid,
  params: WorldParams,
  elevation: Float32Array,
  hydrology: Hydrology,
  waterDistance: Float32Array,
  slope: Float32Array,
): WorldCell[] {
  const seed = hashString(`${params.seed}:climate`);
  const orographic = marchWind(grid, elevation, params.seaLevel, hydrology.waterKind);
  const lastRow = Math.max(1, params.height - 1);
  const aspect = verticalFrequencyScale(params.width, params.height);
  const cells: WorldCell[] = new Array(grid.size);
  for (let index = 0; index < grid.size; index++) {
    const col = grid.colOf(index);
    const row = grid.rowOf(index);
    const kind = hydrology.waterKind[index];
    const height = elevation[index];
    const x = col / params.width;
    const y = row / lastRow;
    // One regional north-to-south gradient rather than a whole planet with an
    // equator, subtropics and two frozen poles.
    const south = y;
    // Altitude cooling is read from the share of the dry range, not from raw
    // elevation: this field uses the whole 0..1 scale, so an absolute lapse rate
    // would freeze every continental interior.
    const altitude = Math.max(0, (height - params.seaLevel) / Math.max(0.01, 1 - params.seaLevel));
    const temperature = clamp01(0.5 + south * 0.2
      + (periodicFbm(seed ^ 0xdb4f0b91, x, y, 5, 0.5, aspect) - 0.5) * 0.1 - altitude * 0.3);
    const regional = periodicFbm(seed ^ 0x4f1bbcdc, x, y, 2, 4, 0.5, aspect);
    const coast = Math.max(0, 1 - waterDistance[index] / 9) * 0.2;
    // Big rivers and lakes water their own valley; that is what puts forest in
    // the middle of an otherwise dry continent.
    const river = Math.min(0.26, Math.log1p(hydrology.flow[index]) / 26);
    const moisture = clamp01(0.32 + regional * 0.34 + orographic[index] * 0.42 + coast + river);
    cells[index] = {
      index, col, row,
      elevation: height,
      temperature,
      moisture,
      waterDistance: waterDistance[index],
      biome: biomeAt(height, params.seaLevel, kind, temperature, moisture, waterDistance[index]),
      water: kind !== DRY,
      waterKind: kind === SEA ? 'sea' : kind === LAKE ? 'lake' : 'none',
      waterLevel: kind === SEA ? params.seaLevel : hydrology.waterLevel[index],
      flow: hydrology.flow[index],
      slope: slope[index],
      ridge: 0,
      landmass: 0,
      downstream: hydrology.downstream[index],
    };
  }
  return cells;
}

/**
 * Prevailing westerlies carried across the cylinder: humidity is picked up over
 * water and dropped when the wind is forced uphill, which leaves the lee side
 * of every eroded ridge dry. Two laps let the wrap-around seam settle.
 */
function marchWind(
  grid: HexGrid,
  elevation: Float32Array,
  seaLevel: number,
  waterKind: Uint8Array,
): Float32Array {
  const wetness = new Float32Array(grid.size);
  for (let row = 0; row < grid.height; row++) {
    let humidity = 0.55;
    for (let step = 0; step < grid.width * 2; step++) {
      const index = grid.indexOf(step, row);
      if (waterKind[index] !== DRY) {
        humidity = Math.min(1, humidity + (1 - humidity) * 0.18);
        wetness[index] = Math.max(wetness[index], humidity);
        continue;
      }
      const previous = grid.indexOf(step - 1, row);
      const climb = Math.max(0, elevation[index] - elevation[previous]);
      const rain = humidity * (0.035 + climb * 6.5);
      humidity = Math.max(0, humidity - rain * 0.85 - 0.004);
      wetness[index] = clamp01(rain * 6 + humidity * 0.55);
      if (elevation[index] <= seaLevel) humidity = Math.min(1, humidity + 0.06);
    }
  }
  return wetness;
}

function biomeAt(
  elevation: number,
  seaLevel: number,
  kind: number,
  temperature: number,
  moisture: number,
  waterDistance: number,
): Biome {
  if (kind === LAKE) return 'lake';
  if (kind === SEA) return elevation < seaLevel - 0.1 ? 'deep-ocean' : 'shallow-ocean';
  // Height is read as a share of the dry range rather than as a raw elevation:
  // this generator normalises its field, so absolute cut-offs would drift with
  // every sea level the land-share control picks.
  const height = (elevation - seaLevel) / Math.max(0.01, 1 - seaLevel);
  if (height > 0.975 && temperature < 0.34) return 'snowy-mountain';
  // Most of a mountain belongs to the wooded highland belt; the rock biome is
  // reserved for the short zone around and above the treeline.
  if (height > 0.9) return 'mountain';
  if (height > 0.52) return 'highland';
  if (waterDistance === 1 && height < 0.14) return 'beach';
  if (moisture < 0.6) return 'grassland';
  return 'forest';
}

function labelLandmasses(grid: HexGrid, cells: WorldCell[]): number[] {
  const sizes: number[] = [];
  const queue = new Int32Array(grid.size);
  let label = 0;
  for (const cell of cells) cell.landmass = cell.water ? -1 : 0;
  for (let start = 0; start < cells.length; start++) {
    if (cells[start].water || cells[start].landmass) continue;
    label++;
    let tail = 0;
    queue[tail++] = start;
    cells[start].landmass = label;
    for (let head = 0; head < tail; head++) {
      const index = queue[head];
      for (let slot = 0; slot < 6; slot++) {
        const next = grid.neighbour(index, slot);
        if (next < 0 || cells[next].water || cells[next].landmass) continue;
        cells[next].landmass = label;
        queue[tail++] = next;
      }
    }
    sizes.push(tail);
  }
  return sizes.sort((a, b) => b - a);
}

/**
 * Rivers are the drainage graph above a catchment threshold, so a river is
 * exactly where enough water actually collects. Each cell has one downstream
 * neighbour, which is what the renderer follows when it draws them.
 */
function collectRivers(grid: HexGrid, cells: WorldCell[], hydrology: Hydrology): RiverSegment[] {
  const threshold = Math.max(MINIMUM_RIVER_CATCHMENT, grid.size * RIVER_CATCHMENT_SHARE);
  const rivers: RiverSegment[] = [];
  for (let index = 0; index < grid.size; index++) {
    const next = hydrology.downstream[index];
    if (next < 0) continue;
    if (hydrology.flow[index] < threshold) continue;
    // A river ends where it reaches standing water. Its drainage does continue
    // across the lake to the spill point — that is how the outlet river gets its
    // catchment — but a drawn river crossing a lake is a river running over a
    // lake, so only the inflow segment is kept and the outlet starts a new one.
    if (cells[index].water) continue;
    rivers.push({ from: index, to: next, flow: hydrology.flow[index] });
  }
  return rivers;
}

function buildStats(
  grid: HexGrid,
  cells: WorldCell[],
  hydrology: Hydrology,
  landmassSizes: number[],
  rivers: RiverSegment[],
  generationMs: number,
  stageMs: Record<string, number>,
): WorldStats {
  const biomeCounts = new Map<Biome, number>();
  let land = 0;
  let sea = 0;
  let lake = 0;
  let buildable = 0;
  let coastline = 0;
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    biomeCounts.set(cell.biome, (biomeCounts.get(cell.biome) ?? 0) + 1);
    if (cell.waterKind === 'sea') { sea++; continue; }
    if (cell.waterKind === 'lake') { lake++; continue; }
    land++;
    if (cell.slope <= MAX_BUILD_STEP) buildable++;
    for (let slot = 0; slot < 6; slot++) {
      const neighbour = grid.neighbour(index, slot);
      if (neighbour >= 0 && cells[neighbour].water) coastline++;
    }
  }
  const percent = (value: number) => Math.round(value / cells.length * 100);
  return {
    cells: cells.length,
    landPercent: percent(land),
    seaPercent: percent(sea),
    lakePercent: Math.round(lake / cells.length * 1000) / 10,
    lakes: hydrology.lakes.length,
    landmasses: landmassSizes.filter((size) => size >= 16).length,
    largestLandmassPercent: land ? Math.round(Math.max(0, ...landmassSizes) / land * 100) : 0,
    flatLandPercent: land ? Math.round(buildable / land * 100) : 0,
    coastline,
    rivers: countRiverSources(rivers),
    generationMs,
    stageMs,
    biomeCounts,
  };
}

function countRiverSources(segments: RiverSegment[]): number {
  const incoming = new Set(segments.map((segment) => segment.to));
  return new Set(segments.filter((segment) => !incoming.has(segment.from)).map((segment) => segment.from)).size;
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
