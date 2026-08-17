import { INRADIUS } from './hexLayout.js';
import { hashCoords, hashString } from './random.js';
import type { TerrainSurface } from './surface.js';
import type { WorldCell } from './types.js';
import { riverWidthForFlow } from './riverShape.js';

/**
 * Where plants grow, decided from world data alone.
 *
 * This is deliberately not part of the renderer. The plan is plain arrays of
 * positions, so the same placement can be drawn, saved, replayed or reasoned
 * about by game rules (cover, line of sight, felling a forest) without asking
 * the GPU anything.
 */

export type ScatterLayer = {
  count: number;
  /** Three floats per item: x, y, z. */
  position: Float32Array;
  scale: Float32Array;
  yaw: Float32Array;
  /** Index into the renderer's shade palette, so one prototype has variety. */
  shade: Uint8Array;
};

export type VegetationPlan = {
  trees: ScatterLayer;
  bushes: ScatterLayer;
  /** How many hexes carry at least one tree: the forest, in game terms. */
  woodedHexes: number;
};

export type VegetationSettings = {
  /** Trees on a fully wooded hex, before per-hex jitter. */
  treesPerHex: number;
  /** Bushes on a fully wooded hex; open grassland gets a share of this. */
  bushesPerHex: number;
  /** Hard ceiling, so a huge map cannot allocate itself out of memory. */
  maxTrees: number;
  maxBushes: number;
};

export const VEGETATION_DEFAULTS: Readonly<VegetationSettings> = {
  treesPerHex: 7,
  bushesPerHex: 3,
  maxTrees: 400_000,
  maxBushes: 200_000,
};

/** Number of leaf shades the renderer offers. */
const SHADES = 3;

/** Height above sea level as a share of the generated dry range. */
export function relativeLandHeight(cell: WorldCell, seaLevel: number): number {
  return Math.max(0, (cell.elevation - seaLevel) / Math.max(0.01, 1 - seaLevel));
}

/**
 * Potential tree cover, independent of the ground biome. Wet slopes stay wooded
 * through the highlands and the lower mountains, then trees thin out across a
 * broad timberline before the exposed summit. Snow never grows trees.
 */
export function naturalForestCover(cell: WorldCell, seaLevel: number): number {
  if (cell.water || cell.biome === 'snowy-mountain') return 0;
  if (cell.biome === 'forest') return 1;
  if (cell.biome === 'grassland') return 0.12;
  if (cell.biome !== 'highland' && cell.biome !== 'mountain') return 0;
  return 1 - smoothstep(0.82, 0.94, relativeLandHeight(cell, seaLevel));
}

function emptyLayer(capacity: number): ScatterLayer {
  return {
    count: 0,
    position: new Float32Array(capacity * 3),
    scale: new Float32Array(capacity),
    yaw: new Float32Array(capacity),
    shade: new Uint8Array(capacity),
  };
}

function push(
  layer: ScatterLayer,
  x: number, y: number, z: number,
  scale: number, yaw: number, shade: number,
): void {
  if (layer.count * 3 + 2 >= layer.position.length) return;
  const slot = layer.count;
  layer.position[slot * 3] = x;
  layer.position[slot * 3 + 1] = y;
  layer.position[slot * 3 + 2] = z;
  layer.scale[slot] = scale;
  layer.yaw[slot] = yaw;
  layer.shade[slot] = shade;
  layer.count = slot + 1;
}

/** Trims the buffers to what was placed, so nothing draws at the origin. */
function seal(layer: ScatterLayer): ScatterLayer {
  if (layer.count * 3 === layer.position.length) return layer;
  return {
    count: layer.count,
    position: layer.position.subarray(0, layer.count * 3),
    scale: layer.scale.subarray(0, layer.count),
    yaw: layer.yaw.subarray(0, layer.count),
    shade: layer.shade.subarray(0, layer.count),
  };
}

/**
 * Scatters plants across every land hex of the world.
 *
 * Placement is hashed from the cell and the slot, never from a running RNG, so
 * one hex can be re-planted later — after a fire, a road or a city — without
 * moving the trees on any other hex.
 */
export function planVegetation(
  surface: TerrainSurface,
  settings: Partial<VegetationSettings> = {},
): VegetationPlan {
  const config = { ...VEGETATION_DEFAULTS, ...settings };
  const { cells, params } = surface.world;
  const seed = hashString(`${params.seed}:vegetation`);
  const seaLevel = params.seaLevel;
  // A cell has at most one outgoing river segment. Indexing it once lets every
  // candidate plant inspect its own segment and the six segments entering from
  // neighbours without scanning the entire river network.
  const riverFrom = new Int32Array(cells.length).fill(-1);
  for (let index = 0; index < surface.world.rivers.length; index++) {
    riverFrom[surface.world.rivers[index].from] = index;
  }

  // Capacity from the actual wooded area rather than from the cell count: a
  // 36%-land map would otherwise allocate three times the buffer it fills.
  let cover = 0;
  for (const cell of cells) cover += naturalForestCover(cell, seaLevel);
  const treeCapacity = Math.min(config.maxTrees, Math.ceil(cover * config.treesPerHex * 1.4) + 64);
  const bushCapacity = Math.min(config.maxBushes, Math.ceil(cover * config.bushesPerHex * 1.4) + 64);

  const trees = emptyLayer(treeCapacity);
  const bushes = emptyLayer(bushCapacity);
  let woodedHexes = 0;

  // Plant radius, kept inside the hex so a trunk never crosses into its
  // neighbour and hangs over a cliff edge.
  const radius = INRADIUS * 0.86;

  for (const cell of cells) {
    const density = naturalForestCover(cell, seaLevel);
    if (density <= 0) continue;
    const [centreX, centreZ] = surface.centreOf(cell);

    const jitter = hashCoords(seed, cell.index, 1) / 4294967295;
    const treeCount = Math.round(density * config.treesPerHex * (0.55 + jitter * 0.9));
    const bushCount = Math.round(density * config.bushesPerHex * (0.4 + jitter * 1.2));
    if (treeCount > 0) woodedHexes++;

    for (let slot = 0; slot < treeCount; slot++) {
      const spot = placeInHex(seed, cell, slot, centreX, centreZ, radius);
      const y = surface.heightInCell(cell, spot.x, spot.z);
      // A shoreline hex is half beach: keep trunks out of the water.
      if (y <= surface.settings.seaSurfaceY + 0.02) continue;
      if (touchesRiver(surface, riverFrom, cell, spot.x, spot.z, 0.2)) continue;
      push(trees, spot.x, y, spot.z,
        0.8 + spot.a * 0.9,
        spot.b * Math.PI * 2,
        Math.floor(spot.c * SHADES) % SHADES);
    }

    for (let slot = 0; slot < bushCount; slot++) {
      const spot = placeInHex(seed ^ 0x5bf03635, cell, slot, centreX, centreZ, radius);
      const y = surface.heightInCell(cell, spot.x, spot.z);
      if (y <= surface.settings.seaSurfaceY + 0.02) continue;
      if (touchesRiver(surface, riverFrom, cell, spot.x, spot.z, 0.28)) continue;
      push(bushes, spot.x, y, spot.z,
        0.55 + spot.a * 0.55,
        spot.b * Math.PI * 2,
        Math.floor(spot.c * SHADES) % SHADES);
    }
  }

  return { trees: seal(trees), bushes: seal(bushes), woodedHexes };
}

/** True when a plant crown/trunk would overlap a river or its immediate bank. */
function touchesRiver(
  surface: TerrainSurface,
  riverFrom: Int32Array,
  cell: WorldCell,
  x: number,
  z: number,
  clearance: number,
): boolean {
  if (riverFrom[cell.index] >= 0 && nearSegment(surface, riverFrom[cell.index], x, z, clearance)) return true;
  for (let direction = 0; direction < 6; direction++) {
    const neighbour = surface.neighbourAt(cell, direction);
    if (!neighbour) continue;
    const segment = riverFrom[neighbour.index];
    // The clearance around a wide channel and its centre junction can extend
    // slightly into every adjacent hex, even when that channel flows onward in
    // another direction rather than directly into this cell.
    if (segment >= 0 && nearSegment(surface, segment, x, z, clearance)) return true;
  }
  return false;
}

function nearSegment(
  surface: TerrainSurface,
  segmentIndex: number,
  x: number,
  z: number,
  clearance: number,
): boolean {
  const segment = surface.world.rivers[segmentIndex];
  const from = surface.world.cells[segment.from];
  const to = surface.world.cells[segment.to];
  const [ax, az] = surface.centreOf(from);
  const [bx, bz] = surface.centreOf(to);
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  // Same flat-map seam rule as the river renderer: this logical connection is
  // not a visible segment until the renderer itself gains wrapped copies.
  if (lengthSquared > 2.1 * 2.1) return false;
  const amount = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared))
    : 0;
  const offsetX = x - (ax + dx * amount);
  const offsetZ = z - (az + dz * amount);
  const radius = riverWidthForFlow(segment.flow) / 2 + clearance;
  return offsetX * offsetX + offsetZ * offsetZ < radius * radius;
}

/** Hashed point inside a hex, plus three spare unit values for the caller. */
function placeInHex(
  seed: number,
  cell: WorldCell,
  slot: number,
  centreX: number,
  centreZ: number,
  radius: number,
): { x: number; z: number; a: number; b: number; c: number } {
  const key = cell.index * 16 + slot;
  const u = hashCoords(seed, key, 0x11) / 4294967295;
  const v = hashCoords(seed, key, 0x22) / 4294967295;
  // sqrt keeps the disc evenly covered instead of crowding the centre.
  const distance = Math.sqrt(u) * radius;
  const angle = v * Math.PI * 2;
  return {
    x: centreX + Math.cos(angle) * distance,
    z: centreZ + Math.sin(angle) * distance,
    a: hashCoords(seed, key, 0x33) / 4294967295,
    b: hashCoords(seed, key, 0x44) / 4294967295,
    c: hashCoords(seed, key, 0x55) / 4294967295,
  };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-9, edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
}
