import { Group, Mesh, MeshLambertMaterial, type Intersection } from 'three';
import { tileKey, type TerrainTileChange, type TileCell } from '../domain/terrain/terrain';
import { createTerrainGeometryBatch } from './terrainGeometry';

const TERRAIN_CHUNK_SIZE = 16;

type TerrainChunk = {
  mesh: Mesh | null;
  tiles: Map<string, TileCell>;
};

export class TerrainRenderer {
  readonly referenceRoot = new Group();
  private readonly material = new MeshLambertMaterial({ vertexColors: true });
  private readonly chunks = new Map<string, TerrainChunk>();
  private readonly tilesByCell = new Map<string, TileCell>();
  private tiles: readonly TileCell[] | null = null;
  private pendingPatch: readonly TerrainTileChange[] | null = null;

  constructor() {
    this.referenceRoot.name = 'ReferenceTerrainRoot';
  }

  update(tiles: readonly TileCell[]): boolean {
    if (tiles === this.tiles) return false;
    if (this.tiles && this.pendingPatch) {
      const patch = this.pendingPatch;
      this.pendingPatch = null;
      this.tiles = tiles;
      return this.applyPatch(patch);
    }
    this.pendingPatch = null;
    this.tiles = tiles;
    this.rebuildAll(tiles);
    return true;
  }

  preparePatch(changes: readonly TerrainTileChange[]): void {
    this.pendingPatch = changes;
  }

  getPickMeshes(): readonly Mesh[] {
    return [...this.chunks.values()].flatMap((chunk) => chunk.mesh ? [chunk.mesh] : []);
  }

  getTileFromIntersection(intersection: Intersection): TileCell | null {
    if (!(intersection.object instanceof Mesh) || intersection.faceIndex === undefined || intersection.faceIndex === null) return null;
    const sources = intersection.object.userData.sourceTilesByTriangle as readonly TileCell[] | undefined;
    return sources?.[intersection.faceIndex] ?? null;
  }

  dispose(): void {
    this.disposeMeshes();
    this.material.dispose();
  }

  private disposeMeshes(): void {
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    this.tilesByCell.clear();
  }

  private rebuildAll(tiles: readonly TileCell[]): void {
    this.disposeMeshes();
    for (const tile of tiles) {
      const key = tileKey(tile);
      this.tilesByCell.set(key, tile);
      const chunkKey = getTerrainChunkKey(tile);
      let chunk = this.chunks.get(chunkKey);
      if (!chunk) {
        chunk = { mesh: null, tiles: new Map() };
        this.chunks.set(chunkKey, chunk);
      }
      chunk.tiles.set(key, tile);
    }
    for (const [key, chunk] of [...this.chunks]) this.mountChunk(key, chunk);
  }

  private applyPatch(changes: readonly TerrainTileChange[]): boolean {
    const affectedChunks = new Set<string>();
    for (const change of changes) {
      const key = tileKey(change);
      const before = this.tilesByCell.get(key) ?? change.before;
      if (before) {
        const chunkKey = getTerrainChunkKey(before);
        this.chunks.get(chunkKey)?.tiles.delete(key);
        affectedChunks.add(chunkKey);
        this.tilesByCell.delete(key);
      }
      if (change.after) {
        const chunkKey = getTerrainChunkKey(change.after);
        let chunk = this.chunks.get(chunkKey);
        if (!chunk) {
          chunk = { mesh: null, tiles: new Map() };
          this.chunks.set(chunkKey, chunk);
        }
        chunk.tiles.set(key, change.after);
        this.tilesByCell.set(key, change.after);
        affectedChunks.add(chunkKey);
      }
    }
    for (const key of affectedChunks) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      if (chunk.tiles.size === 0) {
        this.disposeChunk(chunk);
        this.chunks.delete(key);
      } else {
        this.mountChunk(key, chunk);
      }
    }
    return affectedChunks.size > 0;
  }

  private mountChunk(key: string, chunk: TerrainChunk): void {
    if (chunk.mesh) {
      chunk.mesh.removeFromParent();
      chunk.mesh.geometry.dispose();
    }
    const batch = createTerrainGeometryBatch([...chunk.tiles.values()]);
    const mesh = new Mesh(batch.geometry, this.material);
    mesh.name = `ReferenceTerrainChunk:${key}`;
    mesh.castShadow = true;
    mesh.userData.sourceTilesByTriangle = batch.sourceTilesByTriangle;
    chunk.mesh = mesh;
    this.referenceRoot.add(mesh);
  }

  private disposeChunk(chunk: TerrainChunk): void {
    chunk.mesh?.removeFromParent();
    chunk.mesh?.geometry.dispose();
    chunk.mesh = null;
  }
}

function getTerrainChunkKey(cell: Pick<TileCell, 'x' | 'y' | 'z'>): string {
  return `${Math.floor(cell.x / TERRAIN_CHUNK_SIZE)}:${Math.floor(cell.y / TERRAIN_CHUNK_SIZE)}:${Math.floor(cell.z / TERRAIN_CHUNK_SIZE)}`;
}
