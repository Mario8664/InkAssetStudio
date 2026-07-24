import { describe, expect, it } from 'vitest';
import { createTerrainTile, getTerrainHeightFieldCorners, getTileSurfaceHeight, rotateTile } from '../src/domain/terrain/terrain';

describe('Painting-compatible terrain', () => {
  it('keeps the confirmed north-facing slope heights', () => {
    expect(getTerrainHeightFieldCorners('slope').map((corner) => corner.height)).toEqual([0, 0, 1, 1]);
    const tile = createTerrainTile('slope', 0, 0, 2, 0);
    expect(getTileSurfaceHeight(tile, 0, -0.5)).toBe(3);
    expect(getTileSurfaceHeight(tile, 0, 0.5)).toBe(2);
  });

  it('cycles only the four serialized rotations', () => {
    expect(rotateTile(0, 1)).toBe(90);
    expect(rotateTile(0, -1)).toBe(270);
    expect(rotateTile(270, 1)).toBe(0);
  });
});
