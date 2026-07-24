import { Group, Mesh, MeshLambertMaterial } from 'three';
import type { TileCell } from '../domain/terrain/terrain';
import { createTerrainBatchGeometry } from './terrainGeometry';

export class TerrainRenderer {
  readonly referenceRoot = new Group();
  private readonly material = new MeshLambertMaterial({ vertexColors: true });
  private mesh: Mesh | null = null;
  private tiles: readonly TileCell[] | null = null;

  constructor() {
    this.referenceRoot.name = 'ReferenceTerrainRoot';
  }

  update(tiles: readonly TileCell[]): boolean {
    if (tiles === this.tiles) return false;
    this.tiles = tiles;
    this.disposeMeshes();
    const mesh = new Mesh(createTerrainBatchGeometry(tiles), this.material);
    mesh.name = 'ReferenceTerrain';
    mesh.castShadow = true;
    this.referenceRoot.add(mesh);
    this.mesh = mesh;
    return true;
  }

  dispose(): void {
    this.disposeMeshes();
    this.material.dispose();
  }

  private disposeMeshes(): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
  }
}
