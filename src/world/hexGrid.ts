/**
 * Odd-row offset hex grid on a cylinder: periodic west/east, finite
 * north/south. All six neighbours are precomputed, because every hydrology and
 * erosion pass walks them for every cell dozens of times per world.
 *
 * Direction order is clockwise from east: 0 E, 1 SE, 2 SW, 3 W, 4 NW, 5 NE,
 * matching `CORNERS` in `hexLayout.ts` — corner `i` is shared with the
 * neighbours in directions `i - 1` and `i`.
 */

const EVEN_ROW = [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]] as const;
const ODD_ROW = [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]] as const;

export const NEIGHBOUR_OFFSETS = { even: EVEN_ROW, odd: ODD_ROW } as const;

export function wrapColumn(col: number, width: number): number {
  return ((col % width) + width) % width;
}

export class HexGrid {
  readonly size: number;
  /** Six slots per cell; -1 marks a missing neighbour past the north/south rim. */
  readonly links: Int32Array;

  constructor(readonly width: number, readonly height: number) {
    this.size = width * height;
    this.links = new Int32Array(this.size * 6).fill(-1);
    for (let row = 0; row < height; row++) {
      const offsets = row % 2 === 0 ? EVEN_ROW : ODD_ROW;
      for (let col = 0; col < width; col++) {
        const index = row * width + col;
        for (let slot = 0; slot < 6; slot++) {
          const nextRow = row + offsets[slot][1];
          if (nextRow < 0 || nextRow >= height) continue;
          this.links[index * 6 + slot] = nextRow * width + wrapColumn(col + offsets[slot][0], width);
        }
      }
    }
  }

  colOf(index: number): number { return index % this.width; }
  rowOf(index: number): number { return (index / this.width) | 0; }
  indexOf(col: number, row: number): number { return row * this.width + wrapColumn(col, this.width); }

  neighbour(index: number, slot: number): number { return this.links[index * 6 + slot]; }

  /** Border rows are where the ocean can leave the map. */
  isRim(index: number): boolean {
    const row = this.rowOf(index);
    return row === 0 || row === this.height - 1;
  }
}
