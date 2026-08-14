import type { HexGrid } from './hexGrid.js';
import { periodicFbm, ridgedFbm, verticalFrequencyScale } from './noise.js';
import { hashString } from './random.js';
import { radixSortIndices, isRadixSortable } from './sort.js';
import type { WorldParams, WorldShape } from './types.js';

export type ElevationField = {
  /** Normalised 0..1 coastline score, before any hydrology. */
  raw: Float32Array;
  /** Independent inland relief score: plains, hills, valleys and ranges. */
  relief: Float32Array;
  /** Mountain-belt uplift inside the islands; erosion sharpens what it marks. */
  land: Float32Array;
  /**
   * Largest share of the map that may be dry before the rank pass starts
   * handing cells to the polar band. Asking for more land than the continents
   * hold does not widen them — it lifts the highest polar cells out of the sea,
   * and that is how continents end up running into the top and bottom border.
   */
  dryBudget: number;
};

/**
 * Where the polar bias starts, and the latitude by which it is deep enough to
 * hold the continental field under water on its own. Past
 * `POLAR_OCEAN_LATITUDE` the rows are cut out of the ranking as a backstop; the
 * drop above is what actually keeps the coast away from the border, so the
 * polar shore is a contour of the noise instead of the frame of the map.
 */
const POLAR_SHORE_LATITUDE = 0.45;
const POLAR_DROP_LATITUDE = 0.8;
const POLAR_OCEAN_LATITUDE = 0.85;
const POLAR_DROP = 0.75;

/**
 * How many island groups the map is built from. Low, and in map units rather
 * than cells: a landform has to mean the same thing on every map size.
 */
const SHAPES: Record<WorldShape, {
  count: [number, number];
  radius: [number, number];
  stretch: [number, number];
}> = {
  // `islands` is the Japanese-style volcanic arc used by the game. Its main
  // islands are laid out explicitly below; these ranges only describe the
  // smaller islands around it.
  islands: { count: [5, 8], radius: [0.018, 0.038], stretch: [1.1, 2.1] },
  archipelago: { count: [14, 20], radius: [0.042, 0.072], stretch: [1, 1.7] },
};

export const SEA_LEVEL = 0.32;

type IslandSeed = {
  x: number;
  y: number;
  radius: number;
  stretch: number;
  angle: number;
  /** Seeds in one group blend into a single island; groups get a sea strait. */
  group: number;
  /** How strongly this part of the island lifts its central mountain spine. */
  mountains: number;
};

type IslandScratch = { influence: Float64Array; spine: Float64Array };

/**
 * Coastline and inland relief are deliberately independent. Several warped,
 * elongated seed fields form the main islands and their mutual boundaries are
 * lowered into guaranteed straits, while broad noise and ridged fields build
 * plains, hills, basins and ranges inside them. A mountain therefore cannot win
 * the coastline ranking and weld two islands into one continent.
 */
export function buildElevation(grid: HexGrid, params: WorldParams, warp: number): ElevationField {
  const seed = hashString(`${params.seed}:relief`);
  const shape = SHAPES[params.shape];
  const raw = new Float32Array(grid.size);
  const relief = new Float32Array(grid.size);
  const land = new Float32Array(grid.size);
  const lastRow = Math.max(1, params.height - 1);
  // Detail frequency follows the cell count, not the map rectangle: fixed
  // frequencies give a bigger world the same handful of features stretched over
  // more cells, which reads as a smoother, emptier map instead of a larger one.
  // Island count stays in map units, so a larger map gains detail inside each
  // landform instead of silently gaining more continents.
  const detailScale = Math.max(1, params.width / 192);
  // Every term below is sampled with the map's own proportions, so a feature is
  // as tall as it is wide instead of being smeared along the equator.
  const aspect = verticalFrequencyScale(params.width, params.height);
  const islandSeeds = params.shape === 'islands'
    ? buildJapaneseArc(params.seed, shape, aspect)
    : buildIslandSeeds(params.seed, shape, aspect);
  const islandGroups = 1 + Math.max(...islandSeeds.map((island) => island.group));
  const islandScratch: IslandScratch = {
    influence: new Float64Array(islandGroups),
    spine: new Float64Array(islandGroups),
  };
  const beltFrequency = 2.3 + seededUnit(params.seed, 'belt-frequency') * 1.5;
  const valleyFrequency = 2 + seededUnit(params.seed, 'valley-frequency');
  let minimum = Infinity;
  let maximum = -Infinity;
  let minimumRelief = Infinity;
  let maximumRelief = -Infinity;
  let dry = 0;

  for (let index = 0; index < grid.size; index++) {
    const x = grid.colOf(index) / params.width;
    const y = grid.rowOf(index) / lastRow;
    // The warp offsets are themselves periodic in x, so the warped field still
    // wraps exactly across the seam.
    const warpX = (periodicFbm(seed ^ 0x27d4eb2f, x, y, 2, 3, 0.5, aspect) - 0.5) * warp;
    const warpY = (periodicFbm(seed ^ 0x165667b1, x, y, 2, 3, 0.5, aspect) - 0.5) * warp * 0.65;
    const wx = x + warpX;
    const wy = y + warpY;
    // Several warped, elongated influence fields guarantee ocean gaps between
    // land groups. Noise only roughens their contour; it cannot join the whole
    // middle of the cylinder into one rectangular land belt.
    const breakup = periodicFbm(seed ^ 0x68e31da4, wx, wy, 4.8, 4, 0.52, aspect);
    const coast = periodicFbm(seed ^ 0x9e3779b9, wx, wy, 8.5 * detailScale, 5, 0.52, aspect);
    const bays = ridgedFbm(seed ^ 0x32d64f2d, wx, wy, 5.2, 4, aspect);
    const island = islandInfluence(wx, wy, aspect, islandSeeds, islandScratch);
    const islandBase = island.coast;
    const islandScore = islandBase
      + (breakup - 0.5) * 0.07 + (coast - 0.5) * 0.045
      - Math.pow(bays, 3) * 0.022 - polarDrop(y) * 0.35;

    // Orogeny. A ridged field is creases rather than blobs, but only its narrow
    // top is a chain: a wide band of it is hills that happen to be high, which
    // is how a whole continental interior turns into one grey mass. The belt
    // term is deliberately low frequency — that is what makes a range run for
    // dozens of cells — and the crest rides on it, so a range is a broken spine
    // rather than a smooth wall.
    const broadRelief = periodicFbm(seed ^ 0x6c8e9cf5, wx, wy, 2.8, 4, 0.52, aspect);
    const rolling = periodicFbm(seed ^ 0x1b56c4e9, wx, wy, 6.5 * detailScale, 5, 0.53, aspect);
    const hills = ridgedFbm(seed ^ 0x45d9f3b, wx, wy, 8.5 * detailScale, 4, aspect);
    const belt = ridgedFbm(seed ^ 0x7f4a7c15, wx, wy, beltFrequency, 4, aspect);
    const crest = ridgedFbm(seed ^ 0x2545f491, wx, wy, 4.2 * detailScale, 5, aspect);
    const volcanicSpine = Math.pow(island.spine, 1.35) * (0.42 + crest * 0.58);
    const range = Math.max(
      Math.pow(smoothstep(0.58, 0.97, belt), 1.65) * (0.25 + 0.75 * crest) * 0.72,
      volcanicSpine,
    );
    // A separate broad crease lowers terrain through the ranges: long inhabited
    // basins and passes instead of one monotonically rising massif.
    const valley = Math.pow(ridgedFbm(seed ^ 0x94d049bb, wx, wy, valleyFrequency, 3, aspect), 2.8);
    const interior = smoothstep(-0.025, 0.08, islandBase);
    const reliefScore = broadRelief * 0.18 + rolling * 0.24 + hills * 0.18
      + range * 1.48 - valley * 0.28 + interior * 0.1;
    // Uplift follows the ranges inside the islands, not the coastline: erosion
    // then sharpens the chains it is given instead of lifting the interior
    // evenly, which is the other half of why highlands otherwise spread until
    // they touch.
    land[index] = 0.08 + range * 1.58;
    // The polar rows are dropped out of the running entirely, so the rank pass
    // files them under deepest ocean whatever sea level it later solves for.
    // Clamping them to a fixed height instead lets them resurface the moment the
    // final level comes out lower than the clamp.
    const polar = latitude(y) >= POLAR_OCEAN_LATITUDE;
    raw[index] = polar ? islandScore - 4 : islandScore;
    relief[index] = reliefScore;
    if (!polar) dry++;
    if (islandScore < minimum) minimum = islandScore;
    if (islandScore > maximum) maximum = islandScore;
    if (reliefScore < minimumRelief) minimumRelief = reliefScore;
    if (reliefScore > maximumRelief) maximumRelief = reliefScore;
  }

  const span = Math.max(1e-6, maximum - minimum);
  const reliefSpan = Math.max(1e-6, maximumRelief - minimumRelief);
  for (let index = 0; index < grid.size; index++) {
    raw[index] = (raw[index] - minimum) / span;
    relief[index] = (relief[index] - minimumRelief) / reliefSpan;
  }
  // A margin under the band, so its last rows stay open sea rather than a wall
  // of land pressed flat against the map border.
  return { raw, relief, land, dryBudget: (dry / grid.size) * 0.9 };
}

/**
 * Rewrites the fields by rank instead of by value. Coastline rank decides what
 * is land, then the independent relief rank distributes inland heights. Land
 * share, ocean depth and peak rarity stay controllable without letting a high
 * mountain score bridge a strait.
 *
 * `curve` above 1 spends most of the dry range on gentle low ground and keeps
 * the top of the range for a few real summits.
 */
export function shapeElevation(
  elevation: Float32Array,
  relief: Float32Array,
  landPercent: number,
  curve: number,
): number {
  const coastOrder = orderAscending(elevation);
  const waterCells = Math.round((1 - landPercent) * coastOrder.length);

  // Rank the dry cells by relief. Sorting the *slice* by a second key means
  // building a keyed copy first; the radix sort works on a dense key array.
  const dryCount = coastOrder.length - waterCells;
  const dryOrder = coastOrder.slice(waterCells);
  const dryKeys = new Float32Array(dryCount);
  for (let position = 0; position < dryCount; position++) dryKeys[position] = relief[dryOrder[position]];
  const dryPositions = orderAscending(dryKeys);

  const heightRank = new Int32Array(elevation.length).fill(-1);
  for (let position = 0; position < dryCount; position++) {
    heightRank[dryOrder[dryPositions[position]]] = position;
  }

  for (let position = 0; position < coastOrder.length; position++) {
    const index = coastOrder[position];
    if (position < waterCells) {
      // Shelf first, abyss last: shallow water hugs every coast.
      const depth = 1 - position / Math.max(1, waterCells);
      elevation[index] = SEA_LEVEL * (1 - Math.pow(depth, 0.75));
    } else {
      const height = heightRank[index] / Math.max(1, dryCount - 1);
      elevation[index] = SEA_LEVEL + (1 - SEA_LEVEL) * Math.pow(height, curve);
    }
  }
  return SEA_LEVEL;
}

/**
 * Sea level as a quantile of the finished field. The rank pass sets the shape
 * of the distribution, but erosion still moves cells across the waterline —
 * coastal attack in particular eats shore cells — so the level the world ships
 * with is solved once more at the end, against the eroded heights.
 */
export function seaLevelForLand(elevation: Float32Array, landPercent: number): number {
  const sorted = Float32Array.from(elevation).sort();
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((1 - landPercent) * (sorted.length - 1))),
  );
  return sorted[position];
}

function orderAscending(keys: Float32Array): Int32Array {
  const order = new Int32Array(keys.length);
  for (let index = 0; index < keys.length; index++) order[index] = index;
  if (isRadixSortable(keys)) return radixSortIndices(order, keys);
  return Int32Array.from(Array.from(order).sort((a, b) => keys[a] - keys[b]));
}

function seededUnit(seed: string, channel: string): number {
  return hashString(`${seed}:${channel}`) / 4294967295;
}

function mix(range: [number, number], amount: number): number {
  return range[0] + (range[1] - range[0]) * amount;
}

function buildIslandSeeds(seed: string, shape: (typeof SHAPES)[WorldShape], aspect: number): IslandSeed[] {
  const amount = Math.round(mix(shape.count, seededUnit(seed, 'island-count')));
  const offsetX = seededUnit(seed, 'island-offset-x');
  const offsetY = seededUnit(seed, 'island-offset-y');
  const seeds: IslandSeed[] = [];
  for (let index = 0; index < amount; index++) {
    // Irrational steps distribute the centres without a rigid grid, while the
    // hashed jitter keeps the same seed fully deterministic.
    const jitterX = (seededUnit(seed, `island-${index}-x`) - 0.5) * 0.14;
    const jitterY = (seededUnit(seed, `island-${index}-y`) - 0.5) * 0.16;
    const x = fract(offsetX + index * 0.61803398875 + jitterX);
    const y = 0.17 + fract(offsetY + index * 0.41421356237 + jitterY) * 0.66;
    const radius = mix(shape.radius, seededUnit(seed, `island-${index}-radius`))
      * (index < 3 ? 1.18 : 1);
    seeds.push({
      x, y,
      radius: Math.min(radius, aspect * 0.26),
      stretch: mix(shape.stretch, seededUnit(seed, `island-${index}-stretch`)),
      angle: seededUnit(seed, `island-${index}-angle`) * Math.PI,
      group: index,
      mountains: 0.7,
    });
  }
  return seeds;
}

/**
 * A recognisable Japanese island arc rather than unrelated blobs.
 *
 * Honshu is a curved chain of overlapping ellipses in one group. Kyushu,
 * Shikoku and Hokkaido are separate groups, so the influence field cuts narrow
 * straits between them. Seeded offsets and local jitter keep worlds different
 * without destroying the tectonic north-east / south-west structure.
 */
function buildJapaneseArc(
  seed: string,
  minorShape: (typeof SHAPES)[WorldShape],
  aspect: number,
): IslandSeed[] {
  const turn = (seededUnit(seed, 'arc-angle') - 0.5) * 0.12;
  const shiftX = (seededUnit(seed, 'arc-x') - 0.5) * 0.08;
  const shiftY = (seededUnit(seed, 'arc-y') - 0.5) * 0.07;
  const cosine = Math.cos(turn);
  const sine = Math.sin(turn);
  const seeds: IslandSeed[] = [];
  const add = (
    x: number, y: number, radius: number, stretch: number,
    angle: number, group: number, mountains: number,
    key: string,
  ): void => {
    const jx = (seededUnit(seed, `${key}-x`) - 0.5) * 0.018;
    const jy = (seededUnit(seed, `${key}-y`) - 0.5) * 0.018;
    const px = x - 0.5;
    const py = y - 0.5;
    seeds.push({
      x: 0.5 + px * cosine - py * sine + shiftX + jx,
      y: 0.5 + px * sine + py * cosine + shiftY + jy,
      radius: Math.min(radius * (0.92 + seededUnit(seed, `${key}-r`) * 0.16), aspect * 0.23),
      stretch,
      angle: angle + turn + (seededUnit(seed, `${key}-a`) - 0.5) * 0.14,
      group,
      mountains,
    });
  };

  // Hokkaido, curved Honshu, Shikoku and Kyushu.
  add(0.72, 0.22, 0.058, 1.25, -0.72, 1, 0.9, 'hokkaido');
  add(0.65, 0.32, 0.052, 1.72, -0.72, 2, 1, 'honshu-ne');
  add(0.56, 0.42, 0.049, 1.85, -0.82, 2, 1, 'honshu-mid');
  add(0.47, 0.52, 0.048, 1.72, -0.72, 2, 0.95, 'honshu-sw');
  add(0.38, 0.59, 0.032, 1.55, -0.25, 3, 0.62, 'shikoku');
  add(0.29, 0.65, 0.052, 1.22, -0.82, 4, 0.86, 'kyushu');

  // Ryukyu and small Sea-of-Japan / Pacific islands. Each remains its own
  // landmass, while their small radii stop the land-share rank from inflating
  // them into extra continents.
  const minorCount = Math.round(mix(minorShape.count, seededUnit(seed, 'minor-count')));
  for (let index = 0; index < minorCount; index++) {
    const ryukyu = index < Math.ceil(minorCount * 0.6);
    const t = (index + 1) / (minorCount + 1);
    const x = ryukyu
      ? 0.27 - t * 0.16
      : 0.42 + seededUnit(seed, `minor-${index}-x`) * 0.38;
    const y = ryukyu
      ? 0.69 + t * 0.16
      : 0.24 + seededUnit(seed, `minor-${index}-y`) * 0.42;
    add(
      x, y,
      mix(minorShape.radius, seededUnit(seed, `minor-${index}-radius`)),
      mix(minorShape.stretch, seededUnit(seed, `minor-${index}-stretch`)),
      ryukyu ? -0.7 : seededUnit(seed, `minor-${index}-angle`) * Math.PI,
      10 + index,
      0.28,
      `minor-${index}`,
    );
  }
  return seeds;
}

function islandInfluence(
  x: number,
  y: number,
  aspect: number,
  seeds: IslandSeed[],
  scratch: IslandScratch,
): { coast: number; spine: number } {
  scratch.influence.fill(-Infinity);
  scratch.spine.fill(0);
  for (const seed of seeds) {
    const dx = wrappedDelta(x, seed.x);
    const dy = (y - seed.y) * aspect;
    const cosine = Math.cos(seed.angle);
    const sine = Math.sin(seed.angle);
    const along = dx * cosine + dy * sine;
    const across = -dx * sine + dy * cosine;
    const distance = Math.hypot(along / seed.stretch, across * seed.stretch);
    const influence = seed.radius - distance;
    const lengthFade = 1 - smoothstep(seed.radius * 0.58, seed.radius, Math.abs(along / seed.stretch));
    const spineWidth = Math.max(0.006, seed.radius * 0.42 / seed.stretch);
    const spine = Math.exp(-(across * across) / (2 * spineWidth * spineWidth))
      * lengthFade * seed.mountains;
    if (influence > scratch.influence[seed.group]) scratch.influence[seed.group] = influence;
    if (spine > scratch.spine[seed.group]) scratch.spine[seed.group] = spine;
  }
  let best = -Infinity;
  let second = -Infinity;
  let spine = 0;
  for (let group = 0; group < scratch.influence.length; group++) {
    if (scratch.influence[group] > best) {
      second = best;
      best = scratch.influence[group];
      spine = scratch.spine[group];
    } else if (scratch.influence[group] > second) second = scratch.influence[group];
  }
  // The boundary between two influence fields is deliberately depressed: a
  // Voronoi-like sea channel, so even close elongated islands get a strait
  // instead of joining through a one-cell land bridge.
  const separation = best - second;
  const channel = 1 - smoothstep(0.006, 0.045, separation);
  // This cut must remain deeper than coastline noise and erosion combined.
  // Otherwise the global land-share solve lifts a one-cell bridge across every
  // named strait and the whole Japanese chain becomes one landmass again.
  return { coast: best - channel * 0.19, spine };
}

function wrappedDelta(value: number, centre: number): number {
  const plain = value - centre;
  return plain - Math.round(plain);
}

function fract(value: number): number { return value - Math.floor(value); }

/**
 * Ocean at the top and bottom of the map, because the world is a cylinder and a
 * continent cut off by the frame reads as a bug. The drop has to be deep enough
 * to sink any continental value before the hard cut arrives: a shallower bias
 * only narrows the land, and a crest still climbs into the polar band as a
 * straight-sided tongue that the map border then guillotines. It is gradual, so
 * the polar shore is still a coastline with bays.
 */
function polarDrop(y: number): number {
  return smoothstep(POLAR_SHORE_LATITUDE, POLAR_DROP_LATITUDE, latitude(y)) * POLAR_DROP;
}

function latitude(y: number): number { return Math.abs(y * 2 - 1); }

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-9, edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
}
