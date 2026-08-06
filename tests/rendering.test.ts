import { describe, expect, it, vi } from 'vitest';
import {
  Color,
  DepthFormat,
  DepthTexture,
  DirectionalLight,
  DoubleSide,
  GLSL3,
  Group,
  NearestFilter,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  UnsignedIntType,
  type Material,
  type Intersection,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import {
  bucketFillInkShape,
  compileInkFill,
  compileInkShape,
  createInkCuboidShape,
  createInkCylinderGeometry,
  createInkCylinderShape,
  createInkFrustumGeometry,
  createInkFrustumShape,
  createInkGroupData,
  createInkOutlineStroke,
  createInkPlaneShape,
  createInkSphereGeometry,
  createInkSphereShape,
  paintInkFill,
  sampleInkFillColor,
  withCompiledInkGroup,
} from '../src/domain/ink/ink';
import type { InkCuboidFace, InkShape } from '../src/domain/ink/ink';
import { createTerrainTile } from '../src/domain/terrain/terrain';
import { SAVED_PAINTING_INK_APPEARANCE } from '../src/domain/workspace/inkAppearance';
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
  createInkFillLightingState,
  createInkRenderAppearanceState,
  createInkShapeRenderRoot,
  INK_FILL_RENDER_LAYER,
  INK_RIBBON_RENDER_LAYER,
  INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY,
  setInkHardShadowOwnerId,
  updateInkSurfaceOutlines,
  updateInkShapeFillSurfaces,
} from '../src/render/InkGroupRenderer';
import { hasRendererMaterial, InkHardShadowMap } from '../src/render/InkHardShadowMap';
import { InkWatercolorFillLayer } from '../src/render/InkWatercolorFillLayer';
import { disposeObjectTree } from '../src/render/dispose';
import {
  createTerrainPreviewMaterial,
  TERRAIN_PREVIEW_COLOR,
  TERRAIN_PREVIEW_OPACITY,
  WorkspaceRenderer,
} from '../src/render/WorkspaceRenderer';

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
    expect(firstChunk.castShadow).toBe(false);
    expect(distantChunk.castShadow).toBe(false);
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
      expect(surface.polygonOffset).toBe(true);
      expect(surface.polygonOffsetFactor).toBe(-1);
      expect(surface.polygonOffsetUnits).toBe(-1);
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

  it('keeps all Sphere faces outward and uses double-sided Fill capture', () => {
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
    const root = createInkShapeRenderRoot(compileInkShape(painted), painted, createInkFillLightingState());
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    expect((fill.material as ShaderMaterial).side).toBe(DoubleSide);
    expect((fill.userData.inkHardShadowDepthMaterial as ShaderMaterial).side).toBe(DoubleSide);
    const fillPositions = fill.geometry.getAttribute('position');
    const fillIndices = fill.geometry.getIndex()!;
    const first = new Vector3().fromBufferAttribute(fillPositions, fillIndices.getX(0));
    const second = new Vector3().fromBufferAttribute(fillPositions, fillIndices.getX(1));
    const third = new Vector3().fromBufferAttribute(fillPositions, fillIndices.getX(2));
    expect(second.clone().sub(first).cross(third.clone().sub(first)).z).toBeGreaterThan(0);
    disposeObjectTree(root);
  });

  it('mounts separate Source and Watercolor resources on dedicated Fill and Ribbon layers', () => {
    const shape = createInkCuboidShape();
    shape.strokes = [createInkOutlineStroke([
      { face: 'positive-z', u: -0.2, v: 0, pressure: 1 },
      { face: 'positive-z', u: 0.2, v: 0, pressure: 1 },
    ], '#000000', 0.04)];
    const painted = paintInkFill(shape, [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const appearance = createInkRenderAppearanceState();
    const root = createInkShapeRenderRoot(
      compileInkShape(painted),
      painted,
      createInkFillLightingState(),
      appearance,
    );
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    const sourceRibbon = root.getObjectByName('InkShapeRibbon') as Mesh;
    const watercolorRibbon = root.getObjectByName('InkShapeWatercolorRibbon') as Mesh;
    const fillMaterial = fill.material as ShaderMaterial;
    const sourceMaterial = sourceRibbon.material as ShaderMaterial;
    const watercolorMaterial = watercolorRibbon.material as ShaderMaterial;
    const captureMaterial = fill.userData[INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY] as ShaderMaterial;

    expect(fill.layers.mask).toBe(1 << INK_FILL_RENDER_LAYER);
    expect(sourceRibbon.layers.mask).toBe(1 << INK_RIBBON_RENDER_LAYER);
    expect(watercolorRibbon.layers.mask).toBe(1 << INK_RIBBON_RENDER_LAYER);
    expect(fillMaterial.uniforms.inkWatercolorEnabled).toBe(appearance.watercolorEnabled);
    expect(sourceMaterial.uniforms.inkWatercolorEnabled).toBe(appearance.watercolorEnabled);
    expect(watercolorMaterial.uniforms.inkWatercolorEnabled).toBe(appearance.watercolorEnabled);
    expect(fillMaterial.fragmentShader).toContain('sampleInkWatercolorNearestSource');
    expect(fillMaterial.fragmentShader).toContain('sampleInkWatercolorContouredSource');
    expect(sourceMaterial.fragmentShader).toContain('inkWatercolorEnabled > 0.5');
    expect(watercolorMaterial.fragmentShader).toContain('inkWatercolorEnabled < 0.5');
    expect(captureMaterial).toBeInstanceOf(ShaderMaterial);
    expect(captureMaterial.glslVersion).toBe(GLSL3);
    expect(captureMaterial.fragmentShader).toContain('layout(location = 0) out highp vec4 inkWatercolorShaded;');
    expect(captureMaterial.fragmentShader).toContain('layout(location = 1) out highp vec4 inkWatercolorNoise;');
    expect(captureMaterial.fragmentShader).toContain('getInkWatercolorWetWash');
    expect(captureMaterial.fragmentShader).toContain('float waterAmount = clamp((1.0 - sourceColour.a) * 2.0, 0.0, 1.0);');
    expect(captureMaterial.fragmentShader).toContain('inkWatercolorNoise = vec4(getInkWatercolorNoise(), waterAmount, 1.0);');
    expect(captureMaterial.uniforms.inkWatercolorNoiseScale).toBe(appearance.watercolorNoiseScale);

    const disposeCapture = vi.spyOn(captureMaterial, 'dispose');
    disposeObjectTree(root);
    expect(disposeCapture).toHaveBeenCalledOnce();
  });

  it('builds a three-level immediate Watercolor diffusion composite without temporal state', () => {
    const layer = new InkWatercolorFillLayer({} as WebGLRenderer);
    layer.setSize(320, 180, 2);
    layer.setSettings(SAVED_PAINTING_INK_APPEARANCE.watercolorFill);
    const internals = layer as unknown as {
      ensureTargets: () => void;
      captureTarget: WebGLRenderTarget;
      softTailTargets: WebGLRenderTarget[];
      softTailScratchTargets: WebGLRenderTarget[];
      seedMaterial: ShaderMaterial;
      downsampleMaterial: ShaderMaterial;
      blurMaterial: ShaderMaterial;
      compositeMaterial: ShaderMaterial;
    };
    internals.ensureTargets();
    expect(internals.captureTarget.textures).toHaveLength(2);
    expect(internals.softTailTargets).toHaveLength(3);
    expect(internals.softTailScratchTargets).toHaveLength(3);
    expect(internals.compositeMaterial.fragmentShader).toContain('inkWatercolorSoftTailMap0');
    expect(internals.compositeMaterial.fragmentShader).toContain('inkWatercolorSoftTailMap1');
    expect(internals.compositeMaterial.fragmentShader).toContain('inkWatercolorSoftTailMap2');
    expect(internals.seedMaterial.uniforms.inkWatercolorWaterEdgeWidth!.value).toBe(4);
    expect(internals.compositeMaterial.uniforms.inkWatercolorSoftTailRadius!.value).toBe(15);
    expect(internals.compositeMaterial.uniforms.inkWatercolorColorMixRadius!.value).toBe(5);
    expect(internals.compositeMaterial.fragmentShader).toContain('float localWetness = clamp(centerNoise.b, 0.0, 1.0);');
    expect(internals.compositeMaterial.fragmentShader).toContain('vec3 tintedPigment = depositedPigment * inkWatercolorInteriorFadeColor;');
    const shaderSource = [
      internals.seedMaterial.fragmentShader,
      internals.downsampleMaterial.fragmentShader,
      internals.blurMaterial.fragmentShader,
      internals.compositeMaterial.fragmentShader,
    ].join('\n');
    expect(shaderSource).not.toMatch(/temporal|history|reprojection|jitter/i);
    layer.dispose();
  });

  it('renders camera-facing smooth-surface Ribbons only for supported Shapes', () => {
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
    cylinder.surfaceOutline = { enabled: true, width: 0.08 };
    const paintedCylinder = paintInkFill(cylinder, [{ surface: 'side', u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const root = createInkShapeRenderRoot(compileInkShape(paintedCylinder), paintedCylinder, createInkFillLightingState());
    const camera = new PerspectiveCamera(42, 1, 0.05, 20);
    camera.position.set(3, 1, 3);
    camera.updateMatrixWorld(true);
    updateInkSurfaceOutlines(root, camera);
    const outline = root.getObjectByName('InkSurfaceOutline') as Mesh;
    expect(outline).toBeInstanceOf(Mesh);
    expect(outline.geometry.getIndex()!.count).toBeGreaterThan(0);
    expect((outline.material as ShaderMaterial).side).toBe(DoubleSide);

    const frustum = paintInkFill(createInkFrustumShape(), [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const frustumRoot = createInkShapeRenderRoot(compileInkShape(frustum), frustum, createInkFillLightingState());
    updateInkSurfaceOutlines(frustumRoot, camera);
    expect(frustumRoot.getObjectByName('InkSurfaceOutline')).toBeUndefined();
    disposeObjectTree(root);
    disposeObjectTree(frustumRoot);
  });

  it('keeps cylinder side Fill geometry in phase with its authored chart', () => {
    const cylinder = createInkCylinderShape();
    const painted = paintInkFill(
      cylinder,
      [{ surface: 'side', u: 0, v: 0, pressure: 1 }],
      '#29adff',
      0.12,
      'circle',
      false,
    );
    const root = createInkShapeRenderRoot(compileInkShape(painted), painted, createInkFillLightingState());
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    const positions = fill.geometry.getAttribute('position');
    const uvs = fill.geometry.getAttribute('uv');
    const expectedPositions = [
      { u: 0, x: -cylinder.radius, z: 0 },
      { u: 0.25, x: 0, z: -cylinder.radius },
      { u: 0.5, x: cylinder.radius, z: 0 },
      { u: 0.75, x: 0, z: cylinder.radius },
    ];

    for (const expected of expectedPositions) {
      const vertexIndex = Math.round(expected.u * 16) * 2;
      expect(uvs.getX(vertexIndex)).toBeCloseTo(expected.u, 6);
      expect(positions.getX(vertexIndex)).toBeCloseTo(expected.x, 6);
      expect(positions.getZ(vertexIndex)).toBeCloseTo(expected.z, 6);
    }

    disposeObjectTree(root);
  });

  it('uses transparent guards for internal Fill crops and clamps authored finite chart edges', () => {
    const cylinder = createInkCylinderShape();
    const full = bucketFillInkShape(cylinder, { surface: 'side', u: 0, v: 0, pressure: 1 }, '#29adff');
    const fullSide = compileInkFill(full).find((surface) => surface.id === 'side')!;
    const fullRoot = createInkShapeRenderRoot(compileInkShape(full), full, createInkFillLightingState());
    const fullMesh = fullRoot.getObjectByName('InkFillSurface') as Mesh;
    const fullTexture = fullMesh.userData.inkFillTexture;
    const fullMaterial = fullMesh.material as ShaderMaterial;
    expect(fullTexture.image.width).toBe(fullSide.width);
    expect(fullTexture.image.height).toBe(fullSide.height);
    expect(fullMaterial.uniforms.inkFillTextureUvOffset!.value.toArray()).toEqual([0, 0]);
    expect(fullMaterial.uniforms.inkFillTextureUvScale!.value.toArray()).toEqual([1, 1]);

    const partial = paintInkFill(
      cylinder,
      [{ surface: 'side', u: 0, v: 0, pressure: 1 }],
      '#29adff',
      0.1,
      'circle',
      false,
    );
    const partialSide = compileInkFill(partial).find((surface) => surface.id === 'side')!;
    const partialRoot = createInkShapeRenderRoot(compileInkShape(partial), partial, createInkFillLightingState());
    const partialMesh = partialRoot.getObjectByName('InkFillSurface') as Mesh;
    const partialTexture = partialMesh.userData.inkFillTexture;
    const partialMaterial = partialMesh.material as ShaderMaterial;
    const { width, height, data } = partialTexture.image;
    expect(partialSide.minX).toBeGreaterThan(0);
    expect(partialSide.minY).toBeGreaterThan(0);
    expect(partialSide.minX + partialSide.width).toBeLessThan(Math.ceil(Math.PI * 2 * cylinder.radius * 64));
    expect(partialSide.minY + partialSide.height).toBeLessThan(Math.ceil(cylinder.height * 64));
    expect(width).toBe(partialSide.width + 2);
    expect(height).toBe(partialSide.height + 2);
    expect(data[3]).toBe(0);
    expect(data[(width - 1) * 4 + 3]).toBe(0);
    expect(data[(height - 1) * width * 4 + 3]).toBe(0);
    expect(data[(width * height - 1) * 4 + 3]).toBe(0);
    expect(partialMaterial.uniforms.inkFillTextureUvOffset!.value.toArray()).toEqual([1 / width, 1 / height]);

    disposeObjectTree(fullRoot);
    disposeObjectTree(partialRoot);
  });

  it('replaces every matching colour across a Shape when Bucket Contiguous is disabled', () => {
    const first = { face: 'positive-z' as const, u: -0.25, v: 0, pressure: 1 };
    const second = { face: 'positive-z' as const, u: 0.25, v: 0, pressure: 1 };
    const painted = paintInkFill(
      paintInkFill(createInkCuboidShape(), [first], '#ff004d', 0.05, 'square', false),
      [second],
      '#ff004d',
      0.05,
      'square',
      false,
    );

    const connectedOnly = bucketFillInkShape(painted, first, '#29adff');
    expect(sampleInkFillColor(connectedOnly, first)).toBe('#29adff');
    expect(sampleInkFillColor(connectedOnly, second)).toBe('#ff004d');

    const wholeShape = bucketFillInkShape(painted, first, '#29adff', false);
    expect(sampleInkFillColor(wholeShape, first)).toBe('#29adff');
    expect(sampleInkFillColor(wholeShape, second)).toBe('#29adff');

    const transparentWholeShape = bucketFillInkShape(
      createInkCuboidShape(),
      { face: 'positive-z', u: 0, v: 0, pressure: 1 },
      '#29adff',
      false,
    );
    const surfaces = compileInkFill(transparentWholeShape);
    expect(surfaces).toHaveLength(6);
    expect(surfaces.every((surface) => surface.rgba.every((value, index) => index % 4 !== 3 || value === 255))).toBe(true);
  });

  it('clips a smooth-surface Ribbon to Fill alpha and releases it when disabled', () => {
    const sphere = createInkSphereShape();
    sphere.surfaceOutline = { enabled: true, width: 0.08 };
    const painted = paintInkFill(sphere, [{ x: 1, y: 0, z: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false) as typeof sphere;
    const compiled = compileInkShape(painted);
    const root = createInkShapeRenderRoot(compiled, painted, createInkFillLightingState());
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    const outline = root.getObjectByName('InkSurfaceOutline') as Mesh;
    const material = outline.material as ShaderMaterial;
    expect(material.uniforms.inkFillPositiveX!.value).toBe((fill.material as ShaderMaterial).uniforms.inkFillMap!.value);
    expect(material.fragmentShader).toContain('getInkSurfaceFillAlpha() < 0.5');
    const disposeGeometry = vi.spyOn(outline.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material, 'dispose');
    const disabled = { ...painted, surfaceOutline: { ...painted.surfaceOutline, enabled: false } };
    updateInkShapeFillSurfaces(root, compiled.fill, disabled, createInkFillLightingState());
    expect(root.getObjectByName('InkSurfaceOutline')).toBeUndefined();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    disposeObjectTree(root);
  });

  it('updates one persistent surface Ribbon as the camera moves without replacing Fill resources', () => {
    const cylinder = createInkCylinderShape();
    cylinder.surfaceOutline = { enabled: true, width: 0.035 };
    const painted = paintInkFill(cylinder, [{ surface: 'side', u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const root = createInkShapeRenderRoot(compileInkShape(painted), painted, createInkFillLightingState());
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    const outline = root.getObjectByName('InkSurfaceOutline') as Mesh;
    const camera = new PerspectiveCamera(42, 1, 0.05, 20);
    camera.position.set(3, 1, 0);
    camera.updateMatrixWorld(true);
    updateInkSurfaceOutlines(root, camera);
    const geometry = outline.geometry;
    camera.position.set(0, 1, 3);
    camera.updateMatrixWorld(true);
    updateInkSurfaceOutlines(root, camera);
    expect(root.getObjectByName('InkSurfaceOutline')).toBe(outline);
    expect(outline.geometry).toBe(geometry);

    const repainted = paintInkFill(painted, [{ surface: 'side', u: 0.25, v: 0, pressure: 1 }], '#ff004d', 0.12, 'circle', false);
    updateInkShapeFillSurfaces(root, compileInkShape(repainted).fill, repainted, createInkFillLightingState());
    expect(root.getObjectByName('InkFillSurface')).toBe(fill);
    expect(root.getObjectByName('InkSurfaceOutline')).toBe(outline);

    const resized = { ...repainted, radius: 0.75, height: 2 };
    updateInkShapeFillSurfaces(root, compileInkShape(resized).fill, resized, createInkFillLightingState());
    const resizedOutline = root.getObjectByName('InkSurfaceOutline') as Mesh;
    expect(resizedOutline).not.toBe(outline);
    expect((resizedOutline.material as ShaderMaterial).uniforms.inkCylinderHeight!.value).toBe(2);
    disposeObjectTree(root);
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
    const root = createInkShapeRenderRoot(compileInkShape(shape), shape, createInkFillLightingState());
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

  it('routes an Outline-only Worker result through Ribbon replacement without losing Fill shadow ownership', () => {
    const shape = createInkCuboidShape();
    shape.strokes = [createInkOutlineStroke([
      { face: 'positive-z', u: -0.2, v: 0, pressure: 1 },
      { face: 'positive-z', u: 0.2, v: 0, pressure: 1 },
    ], '#000000', 0.04)];
    const painted = paintInkFill(shape, [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const source = withCompiledInkGroup({
      ...createInkGroupData('Outline-only update', 'outline-only-update'),
      shapes: [painted],
    });
    const outlined = {
      ...painted,
      strokes: [...painted.strokes, createInkOutlineStroke([
        { face: 'positive-z', u: -0.2, v: 0.1, pressure: 1 },
        { face: 'positive-z', u: 0.2, v: 0.1, pressure: 1 },
      ], '#000000', 0.04)],
    };
    const updated = withCompiledInkGroup({ ...source, shapes: [outlined] });
    const lighting = createInkFillLightingState();
    const root = createInkShapeRenderRoot(source.compiled.shapes[0]!, painted, lighting);
    const groupRoot = new Group();
    groupRoot.add(root);
    type TestInkRenderEntry = {
      source: typeof source;
      anchorKey: string;
      root: Group;
      shapes: Map<string, Group>;
    };
    const entry: TestInkRenderEntry = {
      source,
      anchorKey: '0:0:0:0',
      root: groupRoot,
      shapes: new Map([[painted.id, root]]),
    };
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    const texture = fill.userData.inkFillTexture;
    const material = fill.material;
    const depthMaterial = fill.userData.inkHardShadowDepthMaterial as ShaderMaterial;
    const previousRibbon = root.getObjectByName('InkShapeRibbon');
    setInkHardShadowOwnerId(root, 37);

    const updateInkGroupShapes = (WorkspaceRenderer.prototype as unknown as {
      updateInkGroupShapes: (entry: TestInkRenderEntry, next: typeof updated) => boolean;
    }).updateInkGroupShapes;
    expect(updateInkGroupShapes.call({ inkLighting: lighting }, entry, updated)).toBe(false);

    expect(entry.shapes.get(painted.id)).toBe(root);
    expect(root.getObjectByName('InkFillSurface')).toBe(fill);
    expect(fill.userData.inkFillTexture).toBe(texture);
    expect(fill.material).toBe(material);
    expect(fill.userData.inkHardShadowDepthMaterial).toBe(depthMaterial);
    expect((material as ShaderMaterial).uniforms.inkHardShadowOwnerId!.value).toBe(37);
    expect(depthMaterial.uniforms.inkHardShadowOwnerId!.value).toBe(37);
    expect(root.getObjectByName('InkShapeRibbon')).not.toBe(previousRibbon);
    disposeObjectTree(groupRoot);
  });

  it('identifies Line helpers for Ink hard-shadow suppression', () => {
    const preview = createInkShapePreview(createInkPlaneShape('z', { x: 0, y: 0, z: 0 }), false);
    expect(hasRendererMaterial(preview.grid)).toBe(true);
    expect(hasRendererMaterial(new Group())).toBe(false);
    disposeInkShapePreviewTree(preview.root);
  });

  it('uses native nearest depth and restores every captured state when hard-shadow rendering throws', () => {
    const scene = new Scene();
    const sceneBackground = new Color(0x334455);
    scene.background = sceneBackground;
    const casterMaterial = new MeshBasicMaterial({ color: 0xffffff });
    const caster = new Mesh(new PlaneGeometry(1, 1), casterMaterial);
    const casterDepthMaterial = new MeshBasicMaterial({ color: 0xffffff });
    caster.userData.inkHardShadowDepthMaterial = casterDepthMaterial;
    const referenceMaterial = new MeshBasicMaterial({ color: 0xffffff });
    const referenceCaster = new Mesh(new PlaneGeometry(1, 1), referenceMaterial);
    referenceCaster.castShadow = true;
    const nonCasterMaterial = new MeshBasicMaterial({ color: 0xffffff });
    const nonCaster = new Mesh(new PlaneGeometry(1, 1), nonCasterMaterial);
    const helper = new LineSegments(new PlaneGeometry(1, 1), new LineBasicMaterial({ color: 0xffffff }));
    scene.add(caster, referenceCaster, nonCaster, helper);

    const light = new DirectionalLight();
    scene.add(light);
    const originalTarget = {} as WebGLRenderTarget;
    const originalClearColor = new Color(0x123456);
    let currentTarget: WebGLRenderTarget | null = originalTarget;
    let clearColor = originalClearColor.clone();
    let clearAlpha = 0.4;
    let shouldThrow = true;
    let observed: { casterMaterial: Material | Material[]; referenceVisible: boolean; nonCasterVisible: boolean; helperVisible: boolean; background: Scene['background'] } | null = null;
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
          referenceVisible: referenceCaster.visible,
          nonCasterVisible: nonCaster.visible,
          helperVisible: helper.visible,
          background: scene.background,
        };
        if (shouldThrow) throw new Error('synthetic renderer failure');
      },
    } as unknown as WebGLRenderer;
    const lighting = createInkFillLightingState();
    const hardShadow = new InkHardShadowMap(renderer, scene, light, lighting, () => undefined);

    expect(() => hardShadow.renderIfNeeded(true)).toThrow('synthetic renderer failure');
    expect(observed).not.toBeNull();
    expect(observed!.casterMaterial).not.toBe(casterMaterial);
    expect(observed!.referenceVisible).toBe(false);
    expect(observed!.nonCasterVisible).toBe(false);
    expect(observed!.helperVisible).toBe(false);
    expect(observed!.background).toBeNull();
    expect(caster.visible).toBe(true);
    expect(caster.material).toBe(casterMaterial);
    expect(referenceCaster.visible).toBe(true);
    expect(referenceCaster.material).toBe(referenceMaterial);
    expect(nonCaster.visible).toBe(true);
    expect(nonCaster.material).toBe(nonCasterMaterial);
    expect(helper.visible).toBe(true);
    expect(scene.background).toBe(sceneBackground);
    expect(currentTarget).toBe(originalTarget);
    expect(renderer.autoClear).toBe(false);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(clearColor.getHex()).toBe(originalClearColor.getHex());
    expect(clearAlpha).toBe(0.4);

    shouldThrow = false;
    hardShadow.renderIfNeeded(true);
    expect(lighting.hardShadowMap.value).toBeInstanceOf(DepthTexture);
    const depthTexture = lighting.hardShadowMap.value as DepthTexture;
    expect(depthTexture.format).toBe(DepthFormat);
    expect(depthTexture.type).toBe(UnsignedIntType);
    expect(depthTexture.compareFunction).toBeNull();
    expect(depthTexture.minFilter).toBe(NearestFilter);
    expect(depthTexture.magFilter).toBe(NearestFilter);
    expect(lighting.hardShadowOwnerMap.value).not.toBeNull();
    expect(lighting.hardShadowOwnerMap.value!.minFilter).toBe(NearestFilter);
    expect(lighting.hardShadowOwnerMap.value!.magFilter).toBe(NearestFilter);
    expect(lighting.hardShadowOwnerMapEnabled.value).toBe(1);
    expect(lighting.hardShadowTexelSize.x).toBeGreaterThan(0);
    expect(lighting.hardShadowTexelSize.x).toBeLessThan(1);
    expect(lighting.hardShadowTexelSize.y).toBeGreaterThan(0);
    expect(lighting.hardShadowTexelSize.y).toBeLessThan(1);

    hardShadow.dispose();
    expect(lighting.hardShadowTexelSize.toArray()).toEqual([1, 1]);
    caster.geometry.dispose();
    casterMaterial.dispose();
    casterDepthMaterial.dispose();
    referenceCaster.geometry.dispose();
    referenceMaterial.dispose();
    nonCaster.geometry.dispose();
    nonCasterMaterial.dispose();
    helper.geometry.dispose();
    (helper.material as LineBasicMaterial).dispose();
  });

  it('uses owner-aware Source-center and Watercolor-contoured hard Fill shadow bands', () => {
    const shape = paintInkFill(createInkCuboidShape(), [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }], '#29adff', 0.12, 'circle', false);
    const root = createInkShapeRenderRoot(compileInkShape(shape), shape, createInkFillLightingState());
    const fill = root.getObjectByName('InkFillSurface') as Mesh;
    const material = fill.material as ShaderMaterial;
    const depthMaterial = fill.userData.inkHardShadowDepthMaterial as ShaderMaterial;

    expect(material.side).toBe(DoubleSide);
    expect(material.fragmentShader).toContain('uniform sampler2D inkHardShadowMap;');
    expect(material.fragmentShader).toContain('uniform sampler2D inkHardShadowOwnerMap;');
    expect(material.fragmentShader).toContain('uniform vec2 inkHardShadowTexelSize;');
    expect(material.fragmentShader).toContain('isInkHardShadowSelfOwner(shadowUv)');
    expect(material.fragmentShader).toContain('receiverDepth <= casterDepth');
    expect(material.fragmentShader).toContain('sampleInkHardShadowCenterVisibility(shadowUvDepth)');
    expect(material.fragmentShader).toContain('sampleInkWatercolorContouredHardShadowVisibility(shadowUvDepth)');
    expect(material.fragmentShader).not.toContain('sampler2DShadow');
    expect(material.fragmentShader).not.toContain('inkVogelDiskSample');
    expect(material.fragmentShader).not.toContain('sampleInkHardShadowPcf');
    expect(material.fragmentShader).not.toContain('inkHardShadowBias');
    setInkHardShadowOwnerId(root, 42);
    expect(material.uniforms.inkHardShadowOwnerId!.value).toBe(42);
    expect(depthMaterial.uniforms.inkHardShadowOwnerId!.value).toBe(42);
    expect(depthMaterial.side).toBe(DoubleSide);
    expect(depthMaterial.colorWrite).toBe(true);
    expect(depthMaterial.fragmentShader).toContain('inkHardShadowOwnerId / 255.0');
    expect(depthMaterial.fragmentShader).not.toContain('packDepthToRGBA');
    disposeObjectTree(root);
  });
});
