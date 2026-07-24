import { BufferGeometry, Color, Float32BufferAttribute, Mesh } from 'three';
import { getPico8ColorHex } from '../domain/terrain/pico8';
import { getTerrainHeightFieldCorners, type TileCell } from '../domain/terrain/terrain';

export function createTerrainBatchGeometry(tiles: readonly TileCell[]): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const barycentric: number[] = [];
  const edgeMasks: number[] = [];
  for (const tile of tiles) appendTileGeometry(tile, positions, colors, barycentric, edgeMasks);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('terrainBarycentric', new Float32BufferAttribute(barycentric, 3));
  geometry.setAttribute('terrainEdgeMask', new Float32BufferAttribute(edgeMasks, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function appendTileGeometry(
  tile: TileCell,
  positions: number[],
  colors: number[],
  barycentric: number[],
  edgeMasks: number[],
): void {
  const corners = getWorldCorners(tile);
  const bottom = corners.map((corner) => ({ ...corner, y: tile.y }));
  const color = new Color(getPico8ColorHex(tile.color));
  appendTriangle(corners[0]!, corners[1]!, corners[2]!, color, [1, 0, 1], positions, colors, barycentric, edgeMasks);
  appendTriangle(corners[0]!, corners[2]!, corners[3]!, color, [1, 1, 0], positions, colors, barycentric, edgeMasks);
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    if (corners[index]!.y <= tile.y && corners[next]!.y <= tile.y) continue;
    appendTriangle(bottom[index]!, bottom[next]!, corners[next]!, color, [1, 0, 1], positions, colors, barycentric, edgeMasks);
    appendTriangle(bottom[index]!, corners[next]!, corners[index]!, color, [1, 1, 0], positions, colors, barycentric, edgeMasks);
  }
}

function getWorldCorners(tile: TileCell): Array<{ x: number; y: number; z: number }> {
  const radians = -tile.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return getTerrainHeightFieldCorners(tile.kind).map((corner) => ({
    x: tile.x + cosine * corner.x + sine * corner.z,
    y: tile.y + corner.height,
    z: tile.z - sine * corner.x + cosine * corner.z,
  }));
}

function appendTriangle(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  c: { x: number; y: number; z: number },
  color: Color,
  edgeMask: readonly [number, number, number],
  positions: number[],
  colors: number[],
  barycentric: number[],
  edgeMasks: number[],
): void {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  barycentric.push(1, 0, 0, 0, 1, 0, 0, 0, 1);
  for (let index = 0; index < 3; index += 1) colors.push(color.r, color.g, color.b);
  for (let index = 0; index < 3; index += 1) edgeMasks.push(...edgeMask);
}

export function isTerrainMesh(value: unknown): value is Mesh { return value instanceof Mesh && value.name === 'ReferenceTerrain'; }
