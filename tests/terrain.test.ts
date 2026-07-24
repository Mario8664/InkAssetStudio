import { describe, expect, it } from 'vitest';
import { createTerrainTile, getTerrainHeightFieldCorners, getTileSurfaceHeight, isValidTerrainCell, rotateTile } from '../src/domain/terrain/terrain';
import { createTerrainRectangleCells, getPixelPerfectTerrainLineCells } from '../src/editor/TerrainEditorController';

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

  it('connects skipped Pencil samples on the locked work plane', () => {
    expect(getPixelPerfectTerrainLineCells(
      { x: 0, y: 2, z: 0 },
      { x: 4, y: 2, z: 2 },
      'y',
    )).toEqual([
      { x: 0, y: 2, z: 0 },
      { x: 1, y: 2, z: 0 },
      { x: 2, y: 2, z: 1 },
      { x: 3, y: 2, z: 1 },
      { x: 4, y: 2, z: 2 },
    ]);
  });

  it('builds rectangles in each selected X/Y/Z work plane', () => {
    const cells = createTerrainRectangleCells(
      { x: 3, y: -1, z: 2 },
      { x: 3, y: 1, z: 4 },
      'x',
    );
    expect(cells).toHaveLength(9);
    expect(cells.every((cell) => cell.x === 3)).toBe(true);
    expect(cells).toContainEqual({ x: 3, y: -1, z: 2 });
    expect(cells).toContainEqual({ x: 3, y: 1, z: 4 });
  });

  it('rejects unsafe or out-of-studio-range Terrain coordinates', () => {
    expect(isValidTerrainCell(1, 2, 3)).toBe(true);
    expect(isValidTerrainCell(1.5, 2, 3)).toBe(false);
    expect(isValidTerrainCell(1_001, 0, 0)).toBe(false);
  });
});
