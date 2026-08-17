/**
 * Visible width of a river with the given accumulated catchment.
 *
 * This lives in the headless world layer because both rendering and object
 * placement must agree on the space occupied by a river. Keeping a second
 * approximation in vegetation is how trunks end up growing through the water.
 */
export function riverWidthForFlow(flow: number): number {
  return Math.min(0.72, 0.16 + Math.sqrt(Math.max(0, flow)) * 0.022);
}
