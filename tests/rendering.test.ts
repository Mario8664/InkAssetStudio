import { describe, expect, it } from 'vitest';
import { DoubleSide, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry } from 'three';
import { createInkCuboidShape, createInkOutlineStroke, createInkPlaneShape, createInkSphereShape } from '../src/domain/ink/ink';
import { createTerrainTile } from '../src/domain/terrain/terrain';
import { EditorViewportGuides } from '../src/render/EditorViewportGuides';
import {
  ACTIVE_INK_SHAPE_GRID,
  ACTIVE_INK_SHAPE_SURFACE,
  INACTIVE_INK_SHAPE_GRID,
  INACTIVE_INK_SHAPE_SURFACE,
  createInkShapePreview,
  disposeInkShapePreviewTree,
  getInkPlanePreviewBounds,
} from '../src/render/InkShapePreview';
import {
  TERRAIN_EDGE_DARKEN_FACTOR,
  TERRAIN_EDGE_MINIMUM_LINEAR,
  createHalfLambertShaderChunk,
} from '../src/render/MapReferenceLayer';
import { createTerrainBatchGeometry } from '../src/render/terrainGeometry';

describe('Reference rendering', () => {
  it('supplies edge masks that hide the top-face triangle diagonal', () => {
    const geometry = createTerrainBatchGeometry([createTerrainTile('block', 0, 0, 0, 0)]);
    const barycentric = geometry.getAttribute('terrainBarycentric');
    const edgeMask = geometry.getAttribute('terrainEdgeMask');
    expect(barycentric.count).toBe(geometry.getAttribute('position').count);
    expect(edgeMask.count).toBe(barycentric.count);
    expect(Array.from(edgeMask.array).slice(0, 9)).toEqual([1, 0, 1, 1, 0, 1, 1, 0, 1]);
    expect(Array.from(edgeMask.array).slice(9, 18)).toEqual([1, 1, 0, 1, 1, 0, 1, 1, 0]);
    geometry.dispose();
  });

  it('keeps Painting edge contrast without allowing a pure-black edge floor', () => {
    expect(TERRAIN_EDGE_DARKEN_FACTOR).toBe(0.75);
    expect(TERRAIN_EDGE_MINIMUM_LINEAR.every((component) => component > 0)).toBe(true);
  });

  it('injects Half-Lambert before Three expands the light ShaderChunk', () => {
    const chunk = createHalfLambertShaderChunk();
    expect(chunk).toContain('dot( geometryNormal, directLight.direction ) * 0.5 + 0.5');
    expect(chunk).not.toContain('dotNL = saturate( dot( geometryNormal, directLight.direction ) );');
  });

  it('uses separate, non-black infinite-grid and coordinate-axis helpers', () => {
    const camera = new PerspectiveCamera(42, 1, 0.05, 20);
    const guides = new EditorViewportGuides({ camera });
    const grid = guides.getObjectByName('InfiniteEditorGrid') as LineSegments | undefined;
    expect(grid?.material).toBeInstanceOf(LineBasicMaterial);
    expect((grid?.material as LineBasicMaterial).color.getHex()).not.toBe(0x000000);
    for (const name of ['XAxisGuide', 'YAxisGuide', 'ZAxisGuide']) {
      const axis = guides.getObjectByName(name) as Mesh | undefined;
      expect(axis?.material).toBeInstanceOf(MeshBasicMaterial);
      expect((axis?.material as MeshBasicMaterial).color.getHex()).not.toBe(0x000000);
    }
    guides.dispose();
  });

  it('matches Painting active and inactive Shape surface styles without a wireframe material', () => {
    const shape = createInkPlaneShape('z', { x: 0, y: 0, z: 0 });
    for (const [active, surfaceStyle, gridStyle] of [
      [true, ACTIVE_INK_SHAPE_SURFACE, ACTIVE_INK_SHAPE_GRID],
      [false, INACTIVE_INK_SHAPE_SURFACE, INACTIVE_INK_SHAPE_GRID],
    ] as const) {
      const preview = createInkShapePreview(shape, active);
      const surface = preview.surface.material as MeshBasicMaterial;
      const grid = preview.grid.material as LineBasicMaterial;
      expect(surface.color.getHexString()).toBe(surfaceStyle.color.slice(1));
      expect(surface.opacity).toBe(surfaceStyle.opacity);
      expect(surface.wireframe).toBe(false);
      expect(surface.depthTest).toBe(true);
      expect(surface.depthWrite).toBe(false);
      expect(surface.side).toBe(DoubleSide);
      expect(grid.color.getHexString()).toBe(gridStyle.color.slice(1));
      expect(grid.opacity).toBe(gridStyle.opacity);
      expect(grid.depthTest).toBe(true);
      expect(grid.depthWrite).toBe(false);
      disposeInkShapePreviewTree(preview.root);
    }
  });

  it('expands a Plane preview around authored Outline and Fill content', () => {
    const plane = createInkPlaneShape('z', { x: 0, y: 0, z: 0 });
    plane.strokes = [createInkOutlineStroke([
      { x: 2, y: -1, pressure: 1 },
      { x: 2.25, y: -0.75, pressure: 1 },
    ], '#000000', 0.04)];
    plane.fill.surfaces = [{
      id: 'plane',
      blocks: [{ x: 12, y: 8, rgba: new Array(16 * 16 * 4).fill(0) }],
    }];
    expect(getInkPlanePreviewBounds(plane)).toEqual({ minX: -0.5, maxX: 3.5, minY: -1.25, maxY: 2.5 });
    const preview = createInkShapePreview(plane, false);
    const geometry = preview.surface.geometry as PlaneGeometry;
    expect(geometry.parameters.width).toBe(4);
    expect(geometry.parameters.height).toBe(3.75);
    expect(preview.surface.position.toArray()).toEqual([1.5, 0.625, 0]);
    disposeInkShapePreviewTree(preview.root);
  });

  it('builds Painting-compatible Cuboid and 4x4-per-face Sphere reference grids', () => {
    const cuboid = createInkShapePreview(createInkCuboidShape(), false);
    const sphere = createInkShapePreview(createInkSphereShape(), false);
    expect(cuboid.grid.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(sphere.grid.geometry.getAttribute('position').count).toBe(480);
    disposeInkShapePreviewTree(cuboid.root);
    disposeInkShapePreviewTree(sphere.root);
  });
});
