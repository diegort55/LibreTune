/**
 * Clamps a typed X-bin edit so it can never leave the axis' bins out of
 * order (the ECU looks a curve up by walking bins in order; an edit that
 * jumps past a neighbor silently reorders the axis without any error - see
 * commit c21a181/history for the original [-35, -40, -20, ...] corruption).
 *
 * A neighbor still tied at this cell's own pre-edit value isn't a real
 * ordering boundary yet - it's the common case of a freshly-added curve
 * where every bin defaults to 0.0. Without this exception no cell but the
 * very last one could ever leave that default: editing any interior/first
 * bin would clamp straight back down to its identical "next" neighbor.
 * Once a bin actually holds something else, it becomes a real boundary
 * again for its neighbors.
 */
export function clampXBinEdit(
  bins: number[],
  index: number,
  typedValue: number,
  axisMin: number,
  axisMax: number,
): number {
  let clamped = Math.max(axisMin, Math.min(axisMax, typedValue));

  const ascending = bins.length < 2 || bins[0] <= bins[bins.length - 1];
  const ownValue = bins[index];
  const prev = index > 0 ? bins[index - 1] : undefined;
  const next = index < bins.length - 1 ? bins[index + 1] : undefined;

  if (ascending) {
    if (prev !== undefined && prev !== ownValue) clamped = Math.max(clamped, prev);
    if (next !== undefined && next !== ownValue) clamped = Math.min(clamped, next);
  } else {
    if (prev !== undefined && prev !== ownValue) clamped = Math.min(clamped, prev);
    if (next !== undefined && next !== ownValue) clamped = Math.max(clamped, next);
  }

  return clamped;
}
