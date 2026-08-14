import type { HexGrid } from './hexGrid.js';
import { hashCoords } from './random.js';
import { isRadixSortable, radixSortIndices } from './sort.js';

export const DRY = 0;
export const SEA = 1;
export const LAKE = 2;

/**
 * The slope the depression filler leaves behind. Large enough to survive float
 * rounding, small enough to be invisible in the terrain.
 */
const SPILL = 1e-5;

/**
 * How deep filled water has to stand before the cell counts as a lake. Without
 * it every flat plain becomes one: the filler leaves each cell a hair above its
 * neighbour, so `filled > elevation` holds across whole basins that hold no
 * real water. At this vertical scale it is roughly a metre.
 */
const LAKE_DEPTH = 0.005;

export type LakeInfo = { id: number; level: number; cells: number; spill: number; outlet: number };

export type Hydrology = {
  /** Elevation with depressions filled: the surface water actually runs on. */
  filled: Float32Array;
  downstream: Int32Array;
  /** Non-sea cells, highest filled level first. */
  order: Int32Array;
  flow: Float32Array;
  waterKind: Uint8Array;
  waterLevel: Float32Array;
  /** Only filled when `lakes` was requested; -1 everywhere otherwise. */
  lakeId: Int32Array;
  lakes: LakeInfo[];
};

export type HydrologyOptions = {
  /** Per-cell direction preferences, so rivers wander instead of running straight. */
  wander?: Float32Array;
  /**
   * Group lake cells into basins with a level, a spill point and an outlet.
   * Erosion never reads that, and building it is pure cost inside the loop, so
   * it is off unless the caller asks.
   */
  lakes?: boolean;
  /** Reusable buffers. Erosion runs this dozens of times and reallocating hurts. */
  workspace?: HydrologyWorkspace;
};

/**
 * Scratch buffers shared between hydrology passes. The arrays are fully
 * rewritten on every pass, so reuse is safe and saves ~10 allocations of
 * `size` elements per erosion pass.
 */
export class HydrologyWorkspace {
  readonly waterKind: Uint8Array;
  readonly filled: Float32Array;
  readonly waterLevel: Float32Array;
  readonly lakeId: Int32Array;
  readonly downstream: Int32Array;
  readonly flow: Float32Array;
  readonly order: Int32Array;
  readonly visited: Uint8Array;
  readonly queue: Int32Array;
  readonly sortScratch: Int32Array;
  readonly heap: CostHeap;

  constructor(size: number, width: number) {
    this.waterKind = new Uint8Array(size);
    this.filled = new Float32Array(size);
    this.waterLevel = new Float32Array(size);
    this.lakeId = new Int32Array(size);
    this.downstream = new Int32Array(size);
    this.flow = new Float32Array(size);
    this.order = new Int32Array(size);
    this.visited = new Uint8Array(size);
    this.queue = new Int32Array(size);
    this.sortScratch = new Int32Array(size);
    this.heap = new CostHeap(Math.max(64, width * 4));
  }
}

/**
 * One priority-flood pass answers every water question at once: which basins
 * are sea, which are lakes, where each lake spills, and which way every land
 * cell drains. Filling with a tiny outward slope guarantees each cell a
 * strictly lower neighbour, so flow accumulation never needs a sink special
 * case and lake surfaces automatically point at their own outlet.
 */
export function computeHydrology(
  grid: HexGrid,
  elevation: Float32Array,
  seaLevel: number,
  options: HydrologyOptions = {},
): Hydrology {
  const workspace = options.workspace ?? new HydrologyWorkspace(grid.size, grid.width);
  const waterKind = workspace.waterKind.fill(DRY);
  floodSea(grid, elevation, seaLevel, waterKind, workspace);
  const filled = fillDepressions(grid, elevation, seaLevel, waterKind, workspace);
  const waterLevel = workspace.waterLevel;
  const lakeId = workspace.lakeId.fill(-1);
  for (let index = 0; index < grid.size; index++) {
    if (waterKind[index] === SEA) { waterLevel[index] = seaLevel; continue; }
    if (filled[index] - elevation[index] > LAKE_DEPTH) waterKind[index] = LAKE;
    waterLevel[index] = waterKind[index] === LAKE ? filled[index] : elevation[index];
  }
  const downstream = routeDownhill(grid, filled, waterKind, workspace, options.wander);
  const lakes = options.lakes
    ? collectLakes(grid, filled, waterKind, lakeId, waterLevel)
    : [];
  const order = sortByFilledDescending(grid, filled, waterKind, workspace);
  const flow = accumulate(order, downstream, workspace.flow);
  return { filled, downstream, order, flow, waterKind, waterLevel, lakeId, lakes };
}

/** Ocean is water connected to the northern or southern rim; the rest is lake. */
function floodSea(
  grid: HexGrid,
  elevation: Float32Array,
  seaLevel: number,
  waterKind: Uint8Array,
  workspace: HydrologyWorkspace,
): void {
  const queue = workspace.queue;
  let tail = 0;
  for (let index = 0; index < grid.size; index++) {
    if (!grid.isRim(index) || elevation[index] >= seaLevel || waterKind[index]) continue;
    waterKind[index] = SEA;
    queue[tail++] = index;
  }
  if (tail === 0) {
    // A world with no rim water still needs one outlet, otherwise every basin
    // is a lake and rivers have nowhere to go.
    let lowest = 0;
    for (let index = 0; index < grid.size; index++) {
      if (grid.isRim(index) && elevation[index] < elevation[lowest]) lowest = index;
    }
    waterKind[lowest] = SEA;
    queue[tail++] = lowest;
  }
  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    for (let slot = 0; slot < 6; slot++) {
      const next = grid.neighbour(index, slot);
      if (next < 0 || waterKind[next] || elevation[next] >= seaLevel) continue;
      waterKind[next] = SEA;
      queue[tail++] = next;
    }
  }
}

function fillDepressions(
  grid: HexGrid,
  elevation: Float32Array,
  seaLevel: number,
  waterKind: Uint8Array,
  workspace: HydrologyWorkspace,
): Float32Array {
  const filled = workspace.filled;
  const visited = workspace.visited.fill(0);
  const heap = workspace.heap;
  heap.clear();
  for (let index = 0; index < grid.size; index++) {
    if (waterKind[index] !== SEA) continue;
    filled[index] = Math.min(elevation[index], seaLevel);
    visited[index] = 1;
    heap.push(index, seaLevel);
  }
  while (heap.size > 0) {
    const cost = heap.peekCost();
    const index = heap.pop();
    for (let slot = 0; slot < 6; slot++) {
      const next = grid.neighbour(index, slot);
      if (next < 0 || visited[next]) continue;
      visited[next] = 1;
      filled[next] = Math.max(elevation[next], cost + SPILL);
      heap.push(next, filled[next]);
    }
  }
  for (let index = 0; index < grid.size; index++) if (!visited[index]) filled[index] = elevation[index];
  return filled;
}

/**
 * Every cell gets its own preference for each of the six directions, so the
 * choice below is "steep enough", not "steepest". Taking the steepest neighbour
 * is what makes rivers ruler-straight: on the gentle fill slope the depression
 * filler leaves, the drop is identical in several directions and the first slot
 * wins every time, draining a whole basin along one compass bearing. The
 * weights are hashed from the cell, so the wander is part of the seed and the
 * erosion passes carve the valley the finished river actually takes.
 */
export function wanderWeights(grid: HexGrid, seed: number): Float32Array {
  const weights = new Float32Array(grid.size * 6);
  for (let index = 0; index < grid.size; index++) {
    for (let slot = 0; slot < 6; slot++) {
      weights[index * 6 + slot] = 0.4 + hashCoords(seed, index, slot) / 4294967295 * 0.6;
    }
  }
  return weights;
}

function routeDownhill(
  grid: HexGrid,
  filled: Float32Array,
  waterKind: Uint8Array,
  workspace: HydrologyWorkspace,
  wander?: Float32Array,
): Int32Array {
  const downstream = workspace.downstream.fill(-1);
  for (let index = 0; index < grid.size; index++) {
    if (waterKind[index] === SEA) continue;
    let best = -1;
    let bestScore = 0;
    for (let slot = 0; slot < 6; slot++) {
      const next = grid.neighbour(index, slot);
      if (next < 0) continue;
      const drop = filled[index] - filled[next];
      // Only a strictly lower receiver, whatever the weight says: that is what
      // keeps the drainage a forest and the accumulation loop-free.
      if (drop <= 0) continue;
      const score = wander ? drop * wander[index * 6 + slot] : drop;
      if (score <= bestScore) continue;
      bestScore = score;
      best = next;
    }
    downstream[index] = best;
  }
  return downstream;
}

function collectLakes(
  grid: HexGrid,
  filled: Float32Array,
  waterKind: Uint8Array,
  lakeId: Int32Array,
  waterLevel: Float32Array,
): LakeInfo[] {
  const lakes: LakeInfo[] = [];
  for (let start = 0; start < grid.size; start++) {
    if (waterKind[start] !== LAKE || lakeId[start] >= 0) continue;
    const id = lakes.length;
    const members = [start];
    lakeId[start] = id;
    let level = filled[start];
    for (let head = 0; head < members.length; head++) {
      const index = members[head];
      level = Math.max(level, filled[index]);
      for (let slot = 0; slot < 6; slot++) {
        const next = grid.neighbour(index, slot);
        if (next < 0 || waterKind[next] !== LAKE || lakeId[next] >= 0) continue;
        lakeId[next] = id;
        members.push(next);
      }
    }
    let spill = -1;
    let outlet = -1;
    let lowest = Infinity;
    for (const index of members) {
      for (let slot = 0; slot < 6; slot++) {
        const next = grid.neighbour(index, slot);
        if (next < 0 || lakeId[next] === id || filled[next] > filled[index] || filled[next] >= lowest) continue;
        lowest = filled[next];
        spill = index;
        outlet = next;
      }
    }
    for (const index of members) waterLevel[index] = level;
    lakes.push({ id, level, cells: members.length, spill, outlet });
  }
  return lakes;
}

/**
 * Non-sea cells, highest filled level first.
 *
 * This is the hottest sort in the generator — once per erosion pass — so it
 * goes through the radix path whenever the heights allow it, which they do for
 * every field this generator produces.
 */
function sortByFilledDescending(
  grid: HexGrid,
  filled: Float32Array,
  waterKind: Uint8Array,
  workspace: HydrologyWorkspace,
): Int32Array {
  const buffer = workspace.order;
  let count = 0;
  for (let index = 0; index < grid.size; index++) {
    if (waterKind[index] !== SEA) buffer[count++] = index;
  }
  const order = buffer.subarray(0, count);
  if (isRadixSortable(filled)) {
    radixSortIndices(order, filled, workspace.sortScratch);
    order.reverse();
    return order;
  }
  const sorted = Array.from(order).sort((a, b) => filled[b] - filled[a]);
  order.set(sorted);
  return order;
}

function accumulate(order: Int32Array, downstream: Int32Array, flow: Float32Array): Float32Array {
  flow.fill(1);
  for (let position = 0; position < order.length; position++) {
    const index = order[position];
    const next = downstream[index];
    if (next >= 0) flow[next] += flow[index];
  }
  return flow;
}

/** Binary heap over (index, cost) pairs; avoids one object per pushed cell. */
class CostHeap {
  private costs: Float64Array;
  private items: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.costs = new Float64Array(capacity);
    this.items = new Int32Array(capacity);
  }

  clear(): void { this.size = 0; }

  push(item: number, cost: number): void {
    if (this.size === this.costs.length) this.grow();
    let index = this.size++;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.costs[parent] <= cost) break;
      this.costs[index] = this.costs[parent];
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.costs[index] = cost;
    this.items[index] = item;
  }

  peekCost(): number { return this.costs[0]; }

  pop(): number {
    const top = this.items[0];
    this.size--;
    if (this.size === 0) return top;
    const cost = this.costs[this.size];
    const item = this.items[this.size];
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.size) break;
      const right = left + 1;
      const child = right < this.size && this.costs[right] < this.costs[left] ? right : left;
      if (this.costs[child] >= cost) break;
      this.costs[index] = this.costs[child];
      this.items[index] = this.items[child];
      index = child;
    }
    this.costs[index] = cost;
    this.items[index] = item;
    return top;
  }

  private grow(): void {
    const costs = new Float64Array(this.costs.length * 2);
    const items = new Int32Array(this.items.length * 2);
    costs.set(this.costs);
    items.set(this.items);
    this.costs = costs;
    this.items = items;
  }
}
