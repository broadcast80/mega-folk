import type { HexGrid } from './hexGrid.js';
import { computeHydrology, DRY, HydrologyWorkspace, SEA } from './hydrology.js';
import type { Hydrology } from './hydrology.js';

export type ErosionSettings = {
  passes: number;
  /** Stream-power coefficient: how hard rivers cut toward their outlet. */
  strength: number;
  /** Hillslope diffusion, which turns fresh cuts into rounded valleys. */
  diffusion: number;
  /** Tectonic uplift, so long runs sharpen ridges instead of erasing them. */
  uplift: number;
  /** Wave attack, which planes the land the sea touches into beaches. */
  coastal: number;
};

/**
 * Diffusion is deliberately small: it is applied every pass, so 0.1 over 25
 * passes is a two-cell blur that erases the valley network the stream power
 * just cut.
 */
export const EROSION_DEFAULTS: Omit<ErosionSettings, 'passes'> = {
  strength: 0.006,
  diffusion: 0.025,
  uplift: 0.0016,
  coastal: 0.16,
};

/**
 * Stream-power erosion in the implicit Braun & Willett form. Cells are updated
 * from the coast upwards, so a cell always sees its receiver's new height and
 * can never overshoot below it — that is what makes long runs stable and gives
 * branching valley networks instead of noise smoothed into mush.
 *
 * This is the one genuinely expensive stage of world generation: every pass is
 * a full hydrology solve. Two things keep the cost down. The lake grouping is
 * not requested here, because nothing in the loop reads it, and every buffer
 * comes from one workspace instead of being reallocated per pass. What is left
 * is the pass count, and that is a knob on `WorldParams`, not a constant.
 */
export function erodeTerrain(
  grid: HexGrid,
  elevation: Float32Array,
  land: Float32Array,
  seaLevel: number,
  settings: ErosionSettings,
  wander?: Float32Array,
): void {
  if (settings.passes <= 0) return;
  const workspace = new HydrologyWorkspace(grid.size, grid.width);
  const scratch = new Float32Array(grid.size);
  for (let pass = 0; pass < settings.passes; pass++) {
    const hydrology = computeHydrology(grid, elevation, seaLevel, { wander, workspace, lakes: false });
    incise(elevation, hydrology, seaLevel, settings.strength);
    diffuse(grid, elevation, hydrology, seaLevel, settings.diffusion, scratch);
    attackCoast(grid, elevation, hydrology, seaLevel, settings.coastal, scratch);
    raise(elevation, land, seaLevel, settings.uplift);
  }
}

function incise(elevation: Float32Array, hydrology: Hydrology, seaLevel: number, strength: number): void {
  const { order, downstream, flow, waterKind, waterLevel } = hydrology;
  // `order` runs highest first; walking it backwards means every receiver has
  // already been lowered when its donors are processed.
  for (let position = order.length - 1; position >= 0; position--) {
    const index = order[position];
    const receiver = downstream[index];
    if (receiver < 0 || elevation[index] <= seaLevel) continue;
    const base = waterKind[receiver] === DRY ? elevation[receiver] : waterLevel[receiver];
    if (base >= elevation[index]) continue;
    const rate = strength * Math.sqrt(flow[index]);
    elevation[index] = (elevation[index] + rate * base) / (1 + rate);
  }
}

function diffuse(
  grid: HexGrid,
  elevation: Float32Array,
  hydrology: Hydrology,
  seaLevel: number,
  amount: number,
  scratch: Float32Array,
): void {
  if (amount <= 0) return;
  scratch.set(elevation);
  for (let index = 0; index < grid.size; index++) {
    if (hydrology.waterKind[index] === SEA || elevation[index] <= seaLevel) continue;
    let total = 0;
    let count = 0;
    for (let slot = 0; slot < 6; slot++) {
      const neighbour = grid.neighbour(index, slot);
      if (neighbour < 0) continue;
      total += elevation[neighbour];
      count++;
    }
    if (count === 0) continue;
    scratch[index] = elevation[index] + (total / count - elevation[index]) * amount;
  }
  elevation.set(scratch);
}

/**
 * Waves plane the shoreline down toward sea level. Without it every coast keeps
 * the raw cliff it was born with and the map reads as a stamped-out plateau
 * surrounded by water.
 */
function attackCoast(
  grid: HexGrid,
  elevation: Float32Array,
  hydrology: Hydrology,
  seaLevel: number,
  amount: number,
  scratch: Float32Array,
): void {
  if (amount <= 0) return;
  scratch.set(elevation);
  for (let index = 0; index < grid.size; index++) {
    if (hydrology.waterKind[index] === SEA || elevation[index] <= seaLevel) continue;
    let exposure = 0;
    for (let slot = 0; slot < 6; slot++) {
      const neighbour = grid.neighbour(index, slot);
      if (neighbour >= 0 && hydrology.waterKind[neighbour] === SEA) exposure++;
    }
    if (exposure === 0) continue;
    const pull = amount * (exposure / 6);
    scratch[index] = elevation[index] + (seaLevel + 0.004 - elevation[index]) * pull;
  }
  elevation.set(scratch);
}

function raise(elevation: Float32Array, land: Float32Array, seaLevel: number, amount: number): void {
  if (amount <= 0) return;
  const above = Math.max(1e-6, 1 - seaLevel);
  for (let index = 0; index < elevation.length; index++) {
    if (elevation[index] <= seaLevel) continue;
    const height = (elevation[index] - seaLevel) / above;
    elevation[index] = Math.min(1, elevation[index] + amount * land[index] * (0.3 + 0.7 * height));
  }
}
