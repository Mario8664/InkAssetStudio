import { describe, expect, it, vi } from 'vitest';
import {
  BackSide,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
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
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { compileInkShape, createInkCuboidShape, createInkOutlineStroke, createInkPlaneShape, createInkSphereGeometry, createInkSphereShape, paintInkFill } from '../src/domain/ink/ink';
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
import {
  applyInkShapeRenderTransform,
  createInkFillLightingState,
  createInkShapeRenderRoot,
  updateInkShapeFillSurfaces,
  updateInkShapeNormalOutset,
} from '../src/render/InkGroupRenderer';
import { hasRendererMaterial, InkHardShadowMap } from '../src/render/InkHardShadowMap';
import { disposeObjectTree } from '../src/render/dispose';

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

  it('keeps all Sphere faces outward and uses front-visible/back-shadow Fill sides', () => {
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
    expect((fill.material as ShaderMaterial).side).toBe(FrontSide);
    expect((fill.userData.inkHardShadowDepthMaterial as ShaderMaterial).side).toBe(BackSide);
    const fillPositions = fill.geometry.getAttribute('position');
    const fillIndices = fill.geometry.getIndex()!;
    const first = new Vector3().fromBufferAttribute(fillPositions, fillIndices.getX(0));
    const second = new Vector3().fromBufferAttribute(fillPositions, fillIndices.getX(1));
    const third = new Vector3().fromBufferAttribute(fillPositions, fillIndices.getX(2));
    expect(second.clone().sub(first).cross(third.clone().sub(first)).z).toBeGreaterThan(0);
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
    const root = createInkShapeRenderRoot(compileInkShape(shape), shape, createInkFillLightingState(), { useSourceNormalOutset: true });
    const fills = root.children.filter((child): child is Mesh => child instanceof Mesh && child.name === 'InkFillSurface');
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

  it('creates and disposes a non-casting live-source Normal Outset shell', () => {
    const shape = createInkSphereShape();
    shape.normalOutset = { enabled: true, color: '#5a3e16', distance: 0.08 };
    const root = createInkShapeRenderRoot(compileInkShape(shape), shape, createInkFillLightingState(), { useSourceNormalOutset: true });
    const shell = root.getObjectByName('InkNormalOutsetShell') as Mesh;
    expect(shell).toBeInstanceOf(Mesh);
    expect((shell.material as ShaderMaterial).side).toBe(BackSide);
    expect(shell.castShadow).toBe(false);

    const disposeGeometry = vi.spyOn(shell.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(shell.material as ShaderMaterial, 'dispose');
    updateInkShapeNormalOutset(root, null, { ...shape, normalOutset: { ...shape.normalOutset, enabled: false } }, { useSourceNormalOutset: true });
    expect(root.getObjectByName('InkNormalOutsetShell')).toBeUndefined();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
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
    expect(root.getObjectByName('InkNormalOutsetShell')).toBeInstanceOf(Mesh);

    const repainted = paintInkFill(transformed, [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }], '#ff004d', 0.12, 'circle', false);
    const recompiled = compileInkShape(repainted, undefined, compiled);
    updateInkShapeFillSurfaces(root, recompiled.fill, recompiled.normalOutset, repainted, createInkFillLightingState(), { useSourceNormalOutset: true });
    expect(root.getObjectByName('InkShapeRibbon')).toBe(ribbon);
    expect(root.getObjectByName('InkFillSurface')).toBe(fill);
    expect(fill.geometry).toBe(fillGeometry);
    expect(fill.material).toBe(fillMaterial);
    expect(fill.userData.inkFillTexture).toBe(fillTexture);
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
