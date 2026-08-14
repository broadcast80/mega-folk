import { hashCoords } from './random.js';

/**
 * How many times the field repeats north–south for each repeat east–west.
 *
 * A hex row is 1.5 tall and a column `sqrt(3)` wide, and the map is much wider
 * than it is tall, so a feature spanning 1/f of the width has to span the same
 * *world distance* vertically to come out round. Without this the whole field
 * is stretched east–west and every ridge, valley and river runs horizontally.
 *
 * It scales the frequency, not the coordinate: scaling y instead leaves the low
 * octaves with barely one lattice row across the map and the coastlines come
 * out rectangular.
 */
export function verticalFrequencyScale(width: number, height: number): number {
  return (1.5 * Math.max(1, height - 1)) / (Math.sqrt(3) * Math.max(1, width));
}

/** Periodic west/east, finite north/south. `aspect` from `verticalFrequencyScale`. */
export function periodicFbm(
  seed: number,
  x: number,
  y: number,
  baseFrequency: number,
  octaves = 5,
  gain = 0.5,
  aspect = 1,
): number {
  let total = 0;
  let amplitude = 1;
  let normalization = 0;
  let step = 1;
  for (let octave = 0; octave < octaves; octave++) {
    const periodX = Math.max(1, Math.round(baseFrequency * step));
    const frequencyY = Math.max(1, Math.round(baseFrequency * aspect * step));
    total += periodicValueNoise(seed + octave * 0x9e3779b9, x * periodX, y * frequencyY, periodX) * amplitude;
    normalization += amplitude;
    amplitude *= gain;
    step *= 2;
  }
  return total / normalization;
}

/**
 * Ridged multifractal: folding the noise around its midpoint turns smooth blobs
 * into creases, which is what gives mountain chains instead of a second helping
 * of rolling hills.
 */
export function ridgedFbm(
  seed: number,
  x: number,
  y: number,
  frequency: number,
  octaves = 5,
  aspect = 1,
): number {
  let total = 0;
  let amplitude = 1;
  let normalization = 0;
  let weight = 1;
  let step = 1;
  for (let octave = 0; octave < octaves; octave++) {
    const periodX = Math.max(1, Math.round(frequency * step));
    const frequencyY = Math.max(1, Math.round(frequency * aspect * step));
    const sample = periodicValueNoise(seed + octave * 0x85ebca6b, x * periodX, y * frequencyY, periodX);
    const ridge = 1 - Math.abs(sample * 2 - 1);
    const shaped = ridge * ridge * weight;
    weight = Math.max(0, Math.min(1, shaped * 1.6));
    total += shaped * amplitude;
    normalization += amplitude;
    amplitude *= 0.55;
    step *= 2;
  }
  return total / normalization;
}

function periodicValueNoise(seed: number, x: number, y: number, periodX: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const top = lerp(lattice(seed, x0, y0, periodX), lattice(seed, x0 + 1, y0, periodX), fx);
  const bottom = lerp(lattice(seed, x0, y0 + 1, periodX), lattice(seed, x0 + 1, y0 + 1, periodX), fx);
  return lerp(top, bottom, fy);
}

function lattice(seed: number, x: number, y: number, periodX: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  return hashCoords(seed, wrappedX, y) / 4294967295;
}

function fade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}
