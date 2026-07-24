import { DEFAULT_TILE_COLOR, isPico8ColorId, type Pico8ColorId } from './pico8';

export type TileKind = 'block' | 'slope' | 'corner-slope';
export type TileRotation = 0 | 90 | 180 | 270;
export type TileCell = {
  x: number;
  y: number;
  z: number;
  kind: TileKind;
  rotation: TileRotation;
  color: Pico8ColorId;
};

export type TerrainCellPosition = Pick<TileCell, 'x' | 'y' | 'z'>;
export type TerrainTileChange = TerrainCellPosition & {
  before: TileCell | null;
  after: TileCell | null;
};

export type TerrainHeightFieldCorner = { x: number; z: number; height: number };
export const TILE_ROTATIONS: readonly TileRotation[] = [0, 90, 180, 270];

export function createTerrainTile(
  kind: TileKind,
  rotation: TileRotation,
  x: number,
  y: number,
  z: number,
  color: Pico8ColorId = DEFAULT_TILE_COLOR,
): TileCell {
  return { kind, rotation, x, y, z, color };
}

/** Unrotated north-facing surface used by Painting and Studio. */
export function getTerrainHeightFieldCorners(kind: TileKind): readonly TerrainHeightFieldCorner[] {
  const heights = kind === 'block' ? [1, 1, 1, 1] : kind === 'slope' ? [0, 0, 1, 1] : [0, 0, 1, 0];
  return [
    { x: -0.5, z: 0.5, height: heights[0]! },
    { x: 0.5, z: 0.5, height: heights[1]! },
    { x: 0.5, z: -0.5, height: heights[2]! },
    { x: -0.5, z: -0.5, height: heights[3]! },
  ];
}

export function getTileSurfaceHeight(tile: TileCell, localX = 0, localZ = 0): number {
  if (tile.kind === 'block') return tile.y + 1;
  const base = rotateAroundY(localX, localZ, tile.rotation);
  const u = clamp01(0.5 - base.z);
  if (tile.kind === 'slope') return tile.y + u;
  const v = clamp01(base.x + 0.5);
  return tile.y + Math.min(u, v);
}

export function rotateTile(rotation: TileRotation, direction: 1 | -1): TileRotation {
  const index = TILE_ROTATIONS.indexOf(rotation);
  return TILE_ROTATIONS[(index + direction + TILE_ROTATIONS.length) % TILE_ROTATIONS.length]!;
}

export function tileKey(tile: Pick<TileCell, 'x' | 'y' | 'z'>): string {
  return `${tile.x},${tile.y},${tile.z}`;
}

export function compareTiles(left: TileCell, right: TileCell): number {
  return left.y - right.y || left.z - right.z || left.x - right.x;
}

export function isTileCell(value: unknown): value is TileCell {
  if (!value || typeof value !== 'object') return false;
  const tile = value as Partial<TileCell>;
  return Number.isInteger(tile.x) && Number.isInteger(tile.y) && Number.isInteger(tile.z)
    && (tile.kind === 'block' || tile.kind === 'slope' || tile.kind === 'corner-slope')
    && (tile.rotation === 0 || tile.rotation === 90 || tile.rotation === 180 || tile.rotation === 270)
    && isPico8ColorId(tile.color);
}

export function isValidTerrainCell(x: number, y: number, z: number): boolean {
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) && Number.isSafeInteger(z)
    && Math.abs(x) <= 1_000 && Math.abs(y) <= 1_000 && Math.abs(z) <= 1_000;
}

function rotateAroundY(x: number, z: number, degrees: number): { x: number; z: number } {
  const radians = degrees * Math.PI / 180;
  return {
    x: Math.cos(radians) * x + Math.sin(radians) * z,
    z: -Math.sin(radians) * x + Math.cos(radians) * z,
  };
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
