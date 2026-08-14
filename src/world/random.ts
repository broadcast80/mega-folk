/** Hashes and PRNGs. Everything seeded, nothing global: the same seed has to
 * rebuild the same world on any machine and in any order. */

export function hashString(text: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashCoords(seed: number, x: number, y: number): number {
  let hash = seed >>> 0;
  hash = Math.imul(hash ^ Math.imul(x, 374761393), 668265263);
  hash = Math.imul(hash ^ Math.imul(y, 2246822519), 2654435761);
  hash ^= hash >>> 15;
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Hashed unit value in [0, 1). Stateless, so call order never matters. */
export function unitAt(seed: number, x: number, y: number): number {
  return hashCoords(seed, x, y) / 4294967296;
}

export type Rng = () => number;

/** Small, fast, seedable stream. Use one per subsystem, never a shared global. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
