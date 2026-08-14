/**
 * Index sorting by a Float32 key, in linear time.
 *
 * Generation sorts tens of thousands of indices by height several times per
 * erosion pass. With a comparator that is the single most expensive thing the
 * generator does — `Array#sort` on 60k boxed indices costs more than the whole
 * hydrology solve around it. A radix sort over the raw bit pattern replaces the
 * comparison tree with four counting passes.
 *
 * IEEE-754 bit patterns of *non-negative* floats compare exactly like unsigned
 * integers, which is what makes this legal. Elevations here live in 0..1, but a
 * negative value would silently sort to the wrong end, so the callers check the
 * precondition and fall back to a comparator sort instead of trusting it.
 */

const RADIX_BITS = 8;
const BUCKETS = 1 << RADIX_BITS;

/** True when every value is non-negative and finite: the radix precondition. */
export function isRadixSortable(values: Float32Array): boolean {
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!(value >= 0) || value === Infinity) return false;
  }
  return true;
}

/**
 * Sorts `indices` in place, ascending by `keys[index]`.
 *
 * `scratch` is the caller's reusable buffer; passing one keeps a per-pass
 * allocation out of the erosion loop.
 */
export function radixSortIndices(
  indices: Int32Array,
  keys: Float32Array,
  scratch?: Int32Array,
): Int32Array {
  const count = indices.length;
  if (count < 2) return indices;

  const bits = new Uint32Array(count);
  const view = new Uint32Array(keys.buffer, keys.byteOffset, keys.length);
  for (let position = 0; position < count; position++) bits[position] = view[indices[position]];

  let source = indices;
  let target = scratch && scratch.length >= count ? scratch.subarray(0, count) : new Int32Array(count);
  let sourceBits = bits;
  let targetBits = new Uint32Array(count);
  const histogram = new Uint32Array(BUCKETS);

  for (let shift = 0; shift < 32; shift += RADIX_BITS) {
    histogram.fill(0);
    for (let position = 0; position < count; position++) {
      histogram[(sourceBits[position] >>> shift) & (BUCKETS - 1)]++;
    }
    // A byte where every key agrees carries no information; skipping it saves a
    // full scatter pass, and elevations share their top bytes almost always.
    if (histogram[(sourceBits[0] >>> shift) & (BUCKETS - 1)] === count) continue;

    let running = 0;
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      const size = histogram[bucket];
      histogram[bucket] = running;
      running += size;
    }
    for (let position = 0; position < count; position++) {
      const key = sourceBits[position];
      const slot = histogram[(key >>> shift) & (BUCKETS - 1)]++;
      target[slot] = source[position];
      targetBits[slot] = key;
    }

    const swapIndices = source; source = target; target = swapIndices;
    const swapBits = sourceBits; sourceBits = targetBits; targetBits = swapBits;
  }

  // An odd number of scatter passes leaves the result in the scratch buffer.
  if (source !== indices) indices.set(source);
  return indices;
}

/** Ascending index order over `keys`, radix when possible, comparator when not. */
export function sortedIndicesAscending(keys: Float32Array, scratch?: Int32Array): Int32Array {
  const indices = new Int32Array(keys.length);
  for (let index = 0; index < keys.length; index++) indices[index] = index;
  if (isRadixSortable(keys)) return radixSortIndices(indices, keys, scratch);
  return Int32Array.from(
    Array.from(indices).sort((a, b) => keys[a] - keys[b]),
  );
}
