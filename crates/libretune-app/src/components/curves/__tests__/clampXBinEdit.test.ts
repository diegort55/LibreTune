import { describe, expect, it } from 'vitest';
import { clampXBinEdit } from '../clampXBinEdit';

describe('clampXBinEdit', () => {
  it('clamps to the axis range when there is only one bin', () => {
    expect(clampXBinEdit([50], 0, 500, 0, 100)).toBe(100);
    expect(clampXBinEdit([50], 0, -20, 0, 100)).toBe(0);
  });

  it('prevents an edit from crossing a genuinely distinct neighbor (ascending)', () => {
    // Regression: editing -10.0 to -35 used to produce [-35, -40, -20, ...],
    // silently reordering the axis instead of rejecting the crossing edit.
    const bins = [-40, -20, 0, 20, 40];
    expect(clampXBinEdit(bins, 1, -45, -40, 100)).toBe(-40); // would cross prev (-40)
    expect(clampXBinEdit(bins, 1, 10, -40, 100)).toBe(0); // would cross next (0)
    expect(clampXBinEdit(bins, 1, -5, -40, 100)).toBe(-5); // within bounds, unclamped
  });

  it('prevents crossing in a descending axis too', () => {
    const bins = [40, 20, 0, -20, -40];
    expect(clampXBinEdit(bins, 1, 45, -40, 100)).toBe(40); // would cross prev (40)
    expect(clampXBinEdit(bins, 1, -10, -40, 100)).toBe(0); // would cross next (0)
  });

  it('lets a freshly-added curve (every bin at the same default) be edited on any cell', () => {
    // Before this fix, only the last cell (no "next" neighbor) could ever
    // leave the default - every other cell clamped straight back to it.
    const bins = [0, 0, 0, 0, 0, 0];
    expect(clampXBinEdit(bins, 0, 50, 0, 100)).toBe(50);
    expect(clampXBinEdit(bins, 2, 50, 0, 100)).toBe(50);
    expect(clampXBinEdit(bins, 5, 50, 0, 100)).toBe(50);
  });

  it('re-engages the boundary against a neighbor once it holds a real value', () => {
    // Same flat run, but bin 3 has already been set to a real value (50) -
    // bin 2 (still 0, tied with its own value) can move freely up to that
    // boundary but no further; bin 1 (tied on both sides) still moves freely.
    const bins = [0, 0, 0, 50, 0, 0];
    expect(clampXBinEdit(bins, 2, 80, 0, 100)).toBe(50); // clamped at the real neighbor
    expect(clampXBinEdit(bins, 2, 30, 0, 100)).toBe(30); // within bounds, unclamped
    expect(clampXBinEdit(bins, 1, 999, 0, 100)).toBe(100); // still only axis-bounded
  });
});
