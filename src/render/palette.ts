import type { Biome, WorldCell } from '../world/index.js';

/**
 * Terrain colours.
 *
 * Babylon's default shader treats material and vertex colours as gamma-encoded
 * and converts them to linear itself, so these are plain sRGB values straight
 * out of a colour picker. Do not "linearise" them on the way in — that is one
 * gamma step of extra darkening, and it is the classic way a Babylon port comes
 * out muddier than the Three.js original it replaced.
 */

export type Rgb = readonly [number, number, number];

function rgb(hex: number): Rgb {
  return [
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  ];
}

export const BIOME_COLORS: Record<Biome, Rgb> = {
  'deep-ocean': rgb(0x163f59),
  'shallow-ocean': rgb(0x28718a),
  lake: rgb(0x2f7f8e),
  beach: rgb(0xe4ce8b),
  grassland: rgb(0x83a95c),
  forest: rgb(0x396d48),
  highland: rgb(0x6f825e),
  mountain: rgb(0x77796f),
  'snowy-mountain': rgb(0xe1e7e2),
};

export const SEA_COLOR = rgb(0x1d5f7d);
export const LAKE_COLOR = rgb(0x2f7f8e);
export const RIVER_COLOR = rgb(0x3f92aa);
export const SKY_COLOR = rgb(0x87a9c9);

/** Three leaf shades, carried per instance so one prototype covers a forest. */
export const LEAF_SHADES: Rgb[] = [
  rgb(0x3a6b34),
  rgb(0x4a8040),
  rgb(0x2e5730),
];

export const TRUNK_COLOR = rgb(0x4f3a28);

/**
 * Per-hex colour with a small deterministic wobble.
 *
 * Flat biome colours over 60k hexes read as printed paper. The wobble is hashed
 * from the cell, not random, so the same world always looks the same, and it is
 * driven by moisture and height so the variation follows the terrain instead of
 * fighting it.
 */
export function colorForCell(cell: WorldCell, seaLevel: number, out: Float32Array, offset: number): void {
  const base = BIOME_COLORS[cell.biome];
  // Hashed from the coordinates: cheap, stable, and independent of iteration
  // order, so a chunked rebuild cannot change the colour of a hex.
  const noise = ((Math.imul(cell.col + 1, 0x9e3779b1) ^ Math.imul(cell.row + 1, 0x85ebca6b)) >>> 8 & 0xff) / 255;
  const wobble = 0.94 + noise * 0.12;
  // Wetter ground reads greener and darker, drier ground lighter.
  const dryness = cell.water ? 0 : Math.max(0, 0.62 - cell.moisture) * 0.35;
  // Height bleaches exposed rock a little, which separates ridges from flanks.
  const land = Math.max(0, (cell.elevation - seaLevel) / Math.max(0.01, 1 - seaLevel));
  const bleach = cell.water ? 0 : Math.max(0, land - 0.55) * 0.22;

  out[offset] = clamp01(base[0] * wobble + dryness + bleach);
  out[offset + 1] = clamp01(base[1] * wobble + dryness * 0.75 + bleach);
  out[offset + 2] = clamp01(base[2] * wobble + dryness * 0.3 + bleach);
  out[offset + 3] = 1;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
