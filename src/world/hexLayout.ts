/**
 * Pointy-top hex geometry in world units, with a circumradius of exactly 1.
 *
 * One hex is one world unit across its centre-to-corner radius everywhere in
 * this project. Nothing here scales anything: if a hex ever needs to be bigger,
 * that is a camera distance, not a different layout.
 *
 * Grid storage is odd-row offset (`col`, `row`), the same addressing the
 * generator uses, so the layout functions take offset coordinates and no code
 * has to hold two coordinate systems in its head at once.
 */

export const SQRT3 = Math.sqrt(3);

/** Centre to edge midpoint. */
export const INRADIUS = SQRT3 / 2;

/** World-space distance between the centres of two rows. */
export const ROW_STRIDE = 1.5;

/** World-space distance between the centres of two columns in the same row. */
export const COLUMN_STRIDE = SQRT3;

/**
 * Corner offsets, clockwise from east-north-east. Corner `i` lies between the
 * neighbours in directions `i - 1` and `i` (direction 0 is east), which is the
 * pairing `TerrainSurface` uses to share corner heights between cells.
 */
export const CORNERS: ReadonlyArray<readonly [number, number]> = Array.from({ length: 6 }, (_, i) => {
  const angle = (Math.PI / 180) * (60 * i - 30);
  return [Math.cos(angle), Math.sin(angle)] as const;
});

/** Centre of a cell in world space. */
export function cellCentre(col: number, row: number): [number, number] {
  return [(col + (row & 1) * 0.5) * COLUMN_STRIDE, row * ROW_STRIDE];
}

export function cellCentreX(col: number, row: number): number {
  return (col + (row & 1) * 0.5) * COLUMN_STRIDE;
}

export function cellCentreZ(row: number): number {
  return row * ROW_STRIDE;
}

/**
 * Offset coordinates of the cell containing a world point.
 *
 * The nearest centre among the three candidate rows *is* the containing hex —
 * hexagons are the Voronoi cells of their own centres — so this needs no
 * cube rounding and no special case at the row seams.
 */
export function cellAtPoint(x: number, z: number): [number, number] {
  const nearestRow = Math.round(z / ROW_STRIDE);
  let bestCol = 0;
  let bestRow = 0;
  let bestDistance = Infinity;
  for (let row = nearestRow - 1; row <= nearestRow + 1; row++) {
    const col = Math.round(x / COLUMN_STRIDE - (row & 1) * 0.5);
    const dx = x - cellCentreX(col, row);
    const dz = z - cellCentreZ(row);
    const distance = dx * dx + dz * dz;
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    bestCol = col;
    bestRow = row;
  }
  return [bestCol, bestRow];
}

/**
 * Barycentric weights of a point inside the triangle formed by the hex centre
 * and two adjacent corners. Weights are clamped into the triangle, so a point
 * slightly outside the hex still returns a sane blend instead of extrapolating.
 */
export function triangleWeights(
  x: number,
  z: number,
  first: number,
  second: number,
): [number, number, number] {
  const a = CORNERS[first];
  const b = CORNERS[second];
  const determinant = a[0] * b[1] - b[0] * a[1];
  let firstWeight = (x * b[1] - b[0] * z) / determinant;
  let secondWeight = (a[0] * z - x * a[1]) / determinant;
  firstWeight = Math.max(0, firstWeight);
  secondWeight = Math.max(0, secondWeight);
  const outer = firstWeight + secondWeight;
  if (outer > 1) {
    firstWeight /= outer;
    secondWeight /= outer;
  }
  return [Math.max(0, 1 - firstWeight - secondWeight), firstWeight, secondWeight];
}

/** Corner index whose wedge (corner `i` to corner `i + 1`) contains the point. */
export function cornerSector(localX: number, localZ: number): number {
  const raw = (Math.atan2(localZ, localX) + Math.PI / 6) / (Math.PI / 3);
  const wrapped = ((raw % 6) + 6) % 6;
  return Math.floor(wrapped);
}
