import { describe, expect, it, vi } from 'vitest';
import {
  BackSide,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  type Material,
  type Intersection,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import {
  compileInkShape,
  createInkCuboidShape,
  createInkCylinderGeometry,
  createInkCylinderShape,
  createInkFrustumGeometry,
  createInkFrustumShape,
  createInkOutlineStroke,
  createInkPlaneShape,
  createInkSphereGeometry,
  createInkSphereShape,
  paintInkFill,
} from '../src/domain/ink/ink';
import type { InkCuboidFace, InkShape } from '../src/domain/ink/ink';
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
import { TerrainRenderer } from '../src/render/TerrainRenderer';
import {
  applyInkShapeRenderTransform,
  createInkFillLightingState,
  createInkShapeRenderRoot,
  updateInkShapeFillSurfaces,
  updateInkShapeNormalOutset,
  updateInkShapeRibbon,
} from '../src/render/InkGroupRenderer';
import { hasRendererMaterial, InkHardShadowMap } from '../src/render/InkHardShadowMap';
import { disposeObjectTree } from '../src/render/dispose';
import { createTerrainPreviewMaterial, TERRAIN_PREVIEW_COLOR, TERRAIN_PREVIEW_OPACITY } from '../src/render/WorkspaceRenderer';

describe('Reference rendering', () => {
  it('uses the Painting fixed blue placement preview for both depth-tested and overlay previews', () => {
    expect(TERRAIN_PREVIEW_COLOR).toBe('#74c7f7');
    expect(TERRAIN_PREVIEW_OPACITY).toBe(0.42);
    const placement = createTerrainPreviewMaterial(false);
    expect(placement.color.getHexString()).toBe('74c7f7');
    expect(placement.opacity).toBe(0.42);
    expect(placement.depthTest).toBe(true);
    expect(placement.depthWrite).toBe(false);
    expect(placement.vertexColors).toBe(false);
    const overlay = createTerrainPreviewMaterial(true);
    expect(overlay.color.getHexString()).toBe('74c7f7');
    expect(overlay.opacity).toBe(0.42);
    expect(overlay.depthTest).toBe(false);
    expect(overlay.depthWrite).toBe(false);
    expect(overlay.vertexColors).toBe(false);
    placement.dispose();
    overlay.dispose();
  });

  it('rebuilds only changed Terrain chunks and preserves triangle-to-tile raycast mapping', () => {
    const first = createTerrainTile('block', 0, 0, 0, 0, 'blue');
    const distant = createTerrainTile('slope', 90, 20, 0, 0, 'green');
    const terrain = new TerrainRenderer();
    expect(terrain.update([first, distant])).toBe(true);
    const before = terrain.getPickMeshes();
    const firstChunk = before.find((mesh) => mesh.name.endsWith(':0:0:0'))!;
    const distantChunk = before.find((mesh) => mesh.name.endsWith(':1:0:0'))!;
    expect(terrain.getTileFromIntersection({ object: firstChunk, faceIndex: 0 } as unknown as Intersection)).toBe(first);

    const repainted = createTerrainTile('block', 0, 0, 0, 0, 'red');
    terrain.preparePatch([{ x: 0, y: 0, z: 0, before: first, after: repainted }]);
    expect(terrain.update([repainted, distant])).toBe(true);
    const after = terrain.getPickMeshes();
    const replacedFirstChunk = after.find((mesh) => mesh.name.endsWith(':0:0:0'))!;
    expect(replacedFirstChunk).not.toBe(firstChunk);
    expect(after.find((mesh) => mesh.name.endsWith(':1:0:0'))).toBe(distantChunk);
    expect(terrain.getTileFromIntersection({ object: replacedFirstChunk, faceIndex: 0 } as unknown as Intersection)).toBe(repainted);
    terrain.dispose();
  });

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

  it('keeps all Sphere faces outward and uses double-visible/back-shadow Fill sides', () => {
    const sphereGeometry = createInkSphereGeometry(1);
    const positions = sphereGeometry.getAttribute('position');
    const indices = sphereGeometry.getIndex()!;
    for (let index = 0; index < indices.count; index += 3) {
      const first = new Vector3().fromBufferAttribute(positions, indices.getX(index));
      const second = new Vector3().fromBufferAttribute(positions, indices.getX(index + 1));
      const third = new Vector3().fromBufferAttribute(positions, indices.getX(index + 2));
      const normal = second.clone().sub(first).cross(third.clone().sub(first));
      const centroid = first.clone().add(second).add(third).multiplyScalar(1 / 3);
      expect(normal.dot(centroid)).toBeGreaterThan(0);
    }
    const normals = sphereGeometry.getAttribute('normal');
    for (let index = 0; index < positions.count; index += 1) {
      const position = new Vector3().fromBufferAttribute(positions, index).normalize();
      const normal = new Vector3().fromBufferAttribute(normals, index).normalize();
      expect(normal.distanceTo(position)).toBeLessThan(0.000001);
    }
    sphereGeometry.dispose();

    const painted = paintInkFill(
      createInkCuboidShape(),
      [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }],
      '#29adff',
      0.12,
      'circle',
      false,
    );
    const root = createInkShapeRenderRoot(compileInkShape(painted), painted, createInkFillLightingState(), { useSourceNormalOutset: true });
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    expect((fill.material as ShaderMaterial).side).toBe(DoubleSide);
    expect((fill.userData.inkHardShadowDepthMaterial as ShaderMaterial).side).toBe(BackSide);
    const fillPositions = fill.geometry.getAttribute('position');
    const fillIndices = fill.geometry.getIndex()!;
    const first = new Vector3().fromBufferAttribute(fillPositions, fillIndices.getX(0));
    const second = new Vector3().fromBufferAttribute(fillPositions, fillIndices.getX(1));
    const third = new Vector3().fromBufferAttribute(fillPositions, fillIndices.getX(2));
    expect(second.clone().sub(first).cross(third.clone().sub(first)).z).toBeGreaterThan(0);
    disposeObjectTree(root);
  });

  it('builds outward Cylinder and Frustum geometry with double-visible Fill and live Normal Outset shells', () => {
    for (const geometry of [createInkCylinderGeometry(0.75, 1.5), createInkFrustumGeometry(0.6, 1.2, 1.5)]) {
      const positions = geometry.getAttribute('position');
      const indices = geometry.getIndex()!;
      for (let index = 0; index < indices.count; index += 3) {
        const first = new Vector3().fromBufferAttribute(positions, indices.getX(index));
        const second = new Vector3().fromBufferAttribute(positions, indices.getX(index + 1));
        const third = new Vector3().fromBufferAttribute(positions, indices.getX(index + 2));
        const normal = second.clone().sub(first).cross(third.clone().sub(first));
        const centroid = first.clone().add(second).add(third).multiplyScalar(1 / 3);
        expect(normal.dot(centroid)).toBeGreaterThan(0);
      }
      geometry.dispose();
    }

    const cylinder = createInkCylinderShape();
    cylinder.normalOutset = { enabled: true, color: '#5a3e16', distance: 0.08 };
    const frustum = createInkFrustumShape();
    frustum.normalOutset = { enabled: true, color: '#5a3e16', distance: 0.08 };
    const samples: Array<{ shape: InkShape; point: Parameters<typeof paintInkFill>[1][number] }> = [
      { shape: cylinder, point: { surface: 'side', u: 0, v: 0, pressure: 1 } },
      { shape: frustum, point: { face: 'positive-z', u: 0, v: 0, pressure: 1 } },
    ];
    for (const sample of samples) {
      const painted = paintInkFill(sample.shape, [sample.point], '#29adff', 0.12, 'circle', false);
      const root = createInkShapeRenderRoot(compileInkShape(painted), painted, createInkFillLightingState(), { useSourceNormalOutset: true });
      const fill = root.getObjectByName('InkFillSurface') as Mesh;
      const shell = root.getObjectByName('InkNormalOutsetShell') as Group;
      const shellSurface = shell.getObjectByName('InkNormalOutsetSurface') as Mesh;
      expect((fill.material as ShaderMaterial).side).toBe(DoubleSide);
      expect((fill.userData.inkHardShadowDepthMaterial as ShaderMaterial).side).toBe(BackSide);
      expect(shell).toBeInstanceOf(Group);
      expect(shellSurface).toBeInstanceOf(Mesh);
      expect(shellSurface.castShadow).toBe(false);
      const positions = shellSurface.geometry.getAttribute('position');
      const maximumY = Math.max(...Array.from({ length: positions.count }, (_, index) => Math.abs(positions.getY(index))));
      expect(maximumY).toBeCloseTo(0.58);
      if (sample.shape.kind === 'cylinder') {
        const maximumRadius = Math.max(...Array.from({ length: positions.count }, (_, index) => Math.hypot(positions.getX(index), positions.getZ(index))));
        expect(maximumRadius).toBeCloseTo(0.58);
      } else {
        const topHalfSize = Math.max(...Array.from({ length: positions.count }, (_, index) => positions.getY(index) > 0 ? Math.max(Math.abs(positions.getX(index)), Math.abs(positions.getZ(index))) : 0));
        const bottomHalfSize = Math.max(...Array.from({ length: positions.count }, (_, index) => positions.getY(index) < 0 ? Math.max(Math.abs(positions.getX(index)), Math.abs(positions.getZ(index))) : 0));
        expect(topHalfSize * 2).toBeCloseTo(0.6249230177);
        expect(bottomHalfSize * 2).toBeCloseTo(1.2049230177);
      }
      disposeObjectTree(root);
    }
  });

  it('keeps Fill triangles outward on all six Cuboid charts', () => {
    const directions: Record<InkCuboidFace, Vector3> = {
      'positive-x': new Vector3(1, 0, 0),
      'negative-x': new Vector3(-1, 0, 0),
      'positive-y': new Vector3(0, 1, 0),
      'negative-y': new Vector3(0, -1, 0),
      'positive-z': new Vector3(0, 0, 1),
      'negative-z': new Vector3(0, 0, -1),
    };
    let shape: InkShape = createInkCuboidShape();
    for (const face of Object.keys(directions) as InkCuboidFace[]) {
      shape = paintInkFill(shape, [{ face, u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    }
    const root = createInkShapeRenderRoot(compileInkShape(shape), shape, createInkFillLightingState(), { useSourceNormalOutset: true });
    const fills: Mesh[] = [];
    root.traverse((child) => {
      if (child instanceof Mesh && child.name === 'InkFillSurface') fills.push(child);
    });
    expect(fills).toHaveLength(6);
    for (const fill of fills) {
      const face = fill.userData.inkFillSurfaceId as InkCuboidFace;
      const positions = fill.geometry.getAttribute('position');
      const indices = fill.geometry.getIndex()!;
      const first = new Vector3().fromBufferAttribute(positions, indices.getX(0));
      const second = new Vector3().fromBufferAttribute(positions, indices.getX(1));
      const third = new Vector3().fromBufferAttribute(positions, indices.getX(2));
      const normal = second.clone().sub(first).cross(third.clone().sub(first));
      expect(normal.dot(directions[face]), face).toBeGreaterThan(0);
    }
    disposeObjectTree(root);
  });

  it('alpha-clips Normal Outset surfaces to Fill charts and disposes them when disabled', () => {
    const shape = createInkSphereShape();
    shape.normalOutset = { enabled: true, color: '#5a3e16', distance: 0.08 };
    const emptyRoot = createInkShapeRenderRoot(compileInkShape(shape), shape, createInkFillLightingState(), { useSourceNormalOutset: true });
    expect(emptyRoot.getObjectByName('InkNormalOutsetShell')).toBeUndefined();
    disposeObjectTree(emptyRoot);

    const painted = paintInkFill(shape, [{ x: 1, y: 0, z: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const root = createInkShapeRenderRoot(compileInkShape(painted), painted, createInkFillLightingState(), { useSourceNormalOutset: true });
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    const shell = root.getObjectByName('InkNormalOutsetShell') as Group;
    const surface = shell.getObjectByName('InkNormalOutsetSurface') as Mesh;
    const material = surface.material as ShaderMaterial;
    expect(shell).toBeInstanceOf(Group);
    expect(surface).toBeInstanceOf(Mesh);
    expect(material.side).toBe(BackSide);
    expect(surface.castShadow).toBe(false);
    expect(material.uniforms.inkFillMap!.value).toBe((fill.material as ShaderMaterial).uniforms.inkFillMap!.value);
    expect(material.fragmentShader).toContain('texture2D(inkFillMap, fillUv).a < 0.5');

    const disposeGeometry = vi.spyOn(surface.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material, 'dispose');
    updateInkShapeNormalOutset(root, null, { ...painted, normalOutset: { ...painted.normalOutset!, enabled: false } }, { useSourceNormalOutset: true });
    expect(root.getObjectByName('InkNormalOutsetShell')).toBeUndefined();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    disposeObjectTree(root);
  });

  it('keeps Cuboid dimensions intrinsic while Normal Outset remains a fixed world-unit distance', () => {
    const shape = createInkCuboidShape();
    shape.normalOutset = { enabled: true, color: '#5a3e16', distance: 0.08 };
    const painted = paintInkFill(shape, [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const compiled = compileInkShape(painted);
    const root = createInkShapeRenderRoot(compiled, painted, createInkFillLightingState(), { useSourceNormalOutset: true });
    const content = root.getObjectByName('InkShapeContent') as Group;
    const shell = root.getObjectByName('InkNormalOutsetShell') as Group;
    const surface = shell.getObjectByName('InkNormalOutsetSurface') as Mesh;
    const originalGeometry = surface.geometry;
    const resized = { ...painted, size: { x: 3, y: 2, z: 0.5 } };

    applyInkShapeRenderTransform(root, resized);
    updateInkShapeNormalOutset(root, compiled.normalOutset, resized, { useSourceNormalOutset: true });
    root.updateMatrixWorld(true);

    expect(root.scale.toArray()).toEqual([1, 1, 1]);
    expect(content.scale.toArray()).toEqual([3, 2, 0.5]);
    const resizedShell = root.getObjectByName('InkNormalOutsetShell') as Group;
    const resizedSurface = resizedShell.getObjectByName('InkNormalOutsetSurface') as Mesh;
    expect(resizedSurface.geometry).not.toBe(originalGeometry);
    const shellPositions = Array.from(resizedSurface.geometry.getAttribute('position').array);
    const expectedShellPositions = [
      -1.58, -1.08, 0.33,
      1.58, -1.08, 0.33,
      -1.58, 1.08, 0.33,
      1.58, 1.08, 0.33,
    ];
    expect(shellPositions).toHaveLength(expectedShellPositions.length);
    for (const [index, expected] of expectedShellPositions.entries()) expect(shellPositions[index]).toBeCloseTo(expected);
    expect(resizedShell.getWorldScale(new Vector3()).toArray()).toEqual([1, 1, 1]);
    const shellMaterial = resizedSurface.material as ShaderMaterial;
    expect(shellMaterial.uniforms.inkNormalOutsetDistance).toBeUndefined();
    expect(shellMaterial.vertexShader).not.toContain('outwardWorldNormal');
    disposeObjectTree(root);
  });

  it('reuses Ribbon and Fill GPU resources across Transform, Fill, and Normal Outset edits', () => {
    const shape = createInkCuboidShape();
    shape.strokes = [createInkOutlineStroke([
      { face: 'positive-z', u: -0.2, v: 0, pressure: 1 },
      { face: 'positive-z', u: 0.2, v: 0, pressure: 1 },
    ], '#000000', 0.04)];
    const painted = paintInkFill(shape, [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const compiled = compileInkShape(painted);
    const root = createInkShapeRenderRoot(compiled, painted, createInkFillLightingState(), { useSourceNormalOutset: true });
    const ribbon = root.getObjectByName('InkShapeRibbon') as Mesh;
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    const fillGeometry = fill.geometry;
    const fillMaterial = fill.material;
    const fillTexture = fill.userData.inkFillTexture;

    const transformed = {
      ...painted,
      position: { x: 2, y: 3, z: -1 },
      rotation: { x: 0.1, y: 0.2, z: 0.3 },
      normalOutset: { enabled: true, color: '#5a3e16', distance: 0.08 },
    };
    applyInkShapeRenderTransform(root, transformed);
    updateInkShapeNormalOutset(root, compiled.normalOutset, transformed, { useSourceNormalOutset: true });
    expect(root.getObjectByName('InkShapeRibbon')).toBe(ribbon);
    expect(root.getObjectByName('InkFillSurface')).toBe(fill);
    expect(root.position.toArray()).toEqual([2, 3, -1]);
    const shell = root.getObjectByName('InkNormalOutsetShell') as Group;
    const shellSurface = shell.getObjectByName('InkNormalOutsetSurface') as Mesh;
    expect(shell).toBeInstanceOf(Group);
    expect(shellSurface).toBeInstanceOf(Mesh);
    expect((shellSurface.material as ShaderMaterial).uniforms.inkFillMap!.value).toBe(fillTexture);

    const repainted = paintInkFill(transformed, [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }], '#ff004d', 0.12, 'circle', false);
    const recompiled = compileInkShape(repainted, undefined, compiled);
    updateInkShapeFillSurfaces(root, recompiled.fill, recompiled.normalOutset, repainted, createInkFillLightingState(), { useSourceNormalOutset: true });
    expect(root.getObjectByName('InkShapeRibbon')).toBe(ribbon);
    expect(root.getObjectByName('InkFillSurface')).toBe(fill);
    expect(fill.geometry).toBe(fillGeometry);
    expect(fill.material).toBe(fillMaterial);
    expect(fill.userData.inkFillTexture).toBe(fillTexture);
    expect((shellSurface.material as ShaderMaterial).uniforms.inkFillMap!.value).toBe(fillTexture);
    disposeObjectTree(root);
  });

  it('updates an erased Ribbon without recreating the Shape Fill resources', () => {
    const shape = createInkCuboidShape();
    shape.strokes = [createInkOutlineStroke([
      { face: 'positive-z', u: -0.2, v: 0, pressure: 1 },
      { face: 'positive-z', u: 0.2, v: 0, pressure: 1 },
    ], '#000000', 0.04)];
    const painted = paintInkFill(shape, [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const root = createInkShapeRenderRoot(compileInkShape(painted), painted, createInkFillLightingState());
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    updateInkShapeRibbon(root, compileInkShape({ ...painted, strokes: [] }).ribbon);
    expect(root.getObjectByName('InkShapeRibbon')).toBeUndefined();
    expect(root.getObjectByName('InkFillSurface')).toBe(fill);
    disposeObjectTree(root);
  });

  it('identifies Line helpers for packed-depth hard-shadow suppression', () => {
    const preview = createInkShapePreview(createInkPlaneShape('z', { x: 0, y: 0, z: 0 }), false);
    expect(hasRendererMaterial(preview.grid)).toBe(true);
    expect(hasRendererMaterial(new Group())).toBe(false);
    disposeInkShapePreviewTree(preview.root);
  });

  it('isolates non-casters and restores every captured state when hard-shadow rendering throws', () => {
    const scene = new Scene();
    const sceneBackground = new Color(0x334455);
    scene.background = sceneBackground;
    const casterMaterial = new MeshBasicMaterial({ color: 0xffffff });
    const caster = new Mesh(new PlaneGeometry(1, 1), casterMaterial);
    caster.castShadow = true;
    const nonCasterMaterial = new MeshBasicMaterial({ color: 0xffffff });
    const nonCaster = new Mesh(new PlaneGeometry(1, 1), nonCasterMaterial);
    const helper = new LineSegments(new PlaneGeometry(1, 1), new LineBasicMaterial({ color: 0xffffff }));
    scene.add(caster, nonCaster, helper);

    const light = new DirectionalLight();
    scene.add(light);
    const originalTarget = {} as WebGLRenderTarget;
    const originalClearColor = new Color(0x123456);
    let currentTarget: WebGLRenderTarget | null = originalTarget;
    let clearColor = originalClearColor.clone();
    let clearAlpha = 0.4;
    let observed: { casterMaterial: Material | Material[]; nonCasterVisible: boolean; helperVisible: boolean; background: Scene['background'] } | null = null;
    const renderer = {
      capabilities: { maxTextureSize: 4096 },
      autoClear: false,
      shadowMap: { enabled: true },
      getRenderTarget: () => currentTarget,
      setRenderTarget: (target: WebGLRenderTarget | null) => { currentTarget = target; },
      getClearColor: (target: Color) => target.copy(clearColor),
      getClearAlpha: () => clearAlpha,
      setClearColor: (color: Color | number, alpha: number) => {
        clearColor = color instanceof Color ? color.clone() : new Color(color);
        clearAlpha = alpha;
      },
      clear: () => undefined,
      render: () => {
        observed = {
          casterMaterial: caster.material,
          nonCasterVisible: nonCaster.visible,
          helperVisible: helper.visible,
          background: scene.background,
        };
        throw new Error('synthetic renderer failure');
      },
    } as unknown as WebGLRenderer;
    const lighting = createInkFillLightingState();
    const hardShadow = new InkHardShadowMap(renderer, scene, light, lighting);

    expect(() => hardShadow.renderIfNeeded(true)).toThrow('synthetic renderer failure');
    expect(observed).not.toBeNull();
    expect(observed!.casterMaterial).not.toBe(casterMaterial);
    expect(observed!.nonCasterVisible).toBe(false);
    expect(observed!.helperVisible).toBe(false);
    expect(observed!.background).toBeNull();
    expect(caster.visible).toBe(true);
    expect(caster.material).toBe(casterMaterial);
    expect(nonCaster.visible).toBe(true);
    expect(nonCaster.material).toBe(nonCasterMaterial);
    expect(helper.visible).toBe(true);
    expect(scene.background).toBe(sceneBackground);
    expect(currentTarget).toBe(originalTarget);
    expect(renderer.autoClear).toBe(false);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(clearColor.getHex()).toBe(originalClearColor.getHex());
    expect(clearAlpha).toBe(0.4);

    hardShadow.dispose();
    caster.geometry.dispose();
    casterMaterial.dispose();
    nonCaster.geometry.dispose();
    nonCasterMaterial.dispose();
    helper.geometry.dispose();
    (helper.material as LineBasicMaterial).dispose();
  });
});
