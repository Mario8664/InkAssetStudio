import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import {
  compileInkShapeRibbon,
  createInkOutlineStroke,
  type InkCuboidFace,
  type InkGroupData,
  type InkShape,
  type InkSurfacePoint,
} from '../domain/ink/ink';
import { resolvePreviewLighting } from '../domain/lighting/lighting';
import type { StudioEditorSession } from '../domain/workspace/session';
import { getInkSourceByReference, resolveInkGroups, type InkStudioWorkFile } from '../domain/workspace/workspace';
import {
  InkRibbonPreview,
  applyInkShapeRenderTransform,
  createInkFillLightingState,
  createInkGroupRenderRoot,
  type InkFillLightingState,
} from './InkGroupRenderer';
import { InkHardShadowMap } from './InkHardShadowMap';
import { EditorViewportGuides } from './EditorViewportGuides';
import { createInkShapePreview, disposeInkShapePreviewTree } from './InkShapePreview';
import { MapReferenceLayer } from './MapReferenceLayer';
import { TerrainRenderer } from './TerrainRenderer';
import { disposeObjectTree } from './dispose';

type InkRenderEntry = {
  source: InkGroupData;
  anchorKey: string;
  root: Group;
};

export type InkSurfaceHit = {
  referenceId: string;
  shapeId: string;
  shape: InkShape;
  point: InkSurfacePoint;
  world: Vector3;
  normal: Vector3;
};

export type GroupHit = { referenceId: string };

export class WorkspaceRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(42, 1, 0.05, 300);
  readonly controls: OrbitControls;
  readonly inkLighting: InkFillLightingState = createInkFillLightingState();
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly outputPass: OutputPass;
  private readonly terrain = new TerrainRenderer();
  private readonly editorGuides: EditorViewportGuides;
  private readonly inkRoot = new Group();
  private readonly helperRoot = new Group();
  private readonly groupPivotRoot = new Group();
  private readonly cursorRoot = new Group();
  private readonly strokePreviewRoot = new Group();
  private readonly referenceLayer: MapReferenceLayer;
  private readonly mainLight = new DirectionalLight(0xffffff, 3.2);
  private readonly ambientLight = new AmbientLight(0xffffff, 0.22);
  private readonly hardShadow: InkHardShadowMap;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly inkEntries = new Map<string, InkRenderEntry>();
  private readonly shapePickers: Mesh[] = [];
  private readonly pivotPickers: Mesh[] = [];
  private readonly cursor: Mesh;
  private readonly strokePreview = new InkRibbonPreview();
  private document: InkStudioWorkFile | null = null;
  private session: StudioEditorSession | null = null;
  private editHelperStateKey: string | null = null;
  private frameRequested = false;
  private disposed = false;
  private resizeObserver: ResizeObserver;

  constructor(readonly canvas: HTMLCanvasElement, onWarning: (message: string) => void = () => undefined) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = false;
    this.camera.position.set(8, 8, 8);
    this.camera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.5, 0);
    this.controls.enableDamping = false;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 80;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.addEventListener('change', this.handleControlsChange);
    const composerTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: Math.min(4, this.renderer.capabilities.maxSamples),
    });
    composerTarget.texture.name = 'InkAssetStudio.composer';
    this.composer = new EffectComposer(this.renderer, composerTarget);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.outputPass);
    this.referenceLayer = new MapReferenceLayer(this.renderer);
    this.referenceLayer.setEnabled(true);
    this.referenceLayer.setSamples(Math.min(4, this.renderer.capabilities.maxSamples));
    this.mainLight.name = 'StudioMainLight';
    this.mainLight.position.set(-12, 20, 12);
    this.mainLight.target.position.set(0, 0, 0);
    this.mainLight.shadow.camera.near = 0.1;
    this.mainLight.shadow.camera.far = 160;
    this.mainLight.shadow.camera.left = -16;
    this.mainLight.shadow.camera.right = 16;
    this.mainLight.shadow.camera.top = 16;
    this.mainLight.shadow.camera.bottom = -16;
    this.editorGuides = new EditorViewportGuides({ camera: this.camera, y: 0.002 });
    this.scene.add(
      this.referenceLayer.mesh,
      this.terrain.referenceRoot,
      this.editorGuides,
      this.inkRoot,
      this.helperRoot,
      this.groupPivotRoot,
      this.cursorRoot,
      this.strokePreviewRoot,
      this.mainLight,
      this.mainLight.target,
      this.ambientLight,
    );
    this.terrain.referenceRoot.visible = false;
    this.inkRoot.name = 'InkRoot';
    this.helperRoot.name = 'InkEditHelpers';
    this.groupPivotRoot.name = 'InkGroupPivots';
    this.cursorRoot.name = 'InkBrushCursor';
    this.strokePreviewRoot.name = 'InkStrokePreviewRoot';
    this.cursor = new Mesh(
      new RingGeometry(0.09, 0.105, 40),
      new MeshBasicMaterial({ color: 0x111111, depthTest: false, depthWrite: false, side: DoubleSide }),
    );
    this.cursor.visible = false;
    this.cursor.renderOrder = 2000;
    this.cursorRoot.add(this.cursor);
    this.strokePreviewRoot.add(this.strokePreview.mesh);
    this.hardShadow = new InkHardShadowMap(this.renderer, this.scene, this.mainLight, this.inkLighting, onWarning);
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(canvas);
    this.handleResize();
    this.requestRender();
  }

  update(document: InkStudioWorkFile, session: StudioEditorSession): void {
    this.document = document;
    this.session = session;
    const terrainChanged = this.terrain.update(document.terrain.tiles);
    this.referenceLayer.setTerrainEdgesVisible(session.showTerrainEdges);
    this.editorGuides.setGridVisible(session.showInfiniteGrid);
    this.editorGuides.setAxesVisible(session.showAxes);
    const inkChanged = this.updateInkGroups(document);
    const lightingDirectionChanged = this.applyLighting(document);
    if (terrainChanged || inkChanged || lightingDirectionChanged) this.hardShadow.markDirty();
    if (terrainChanged || inkChanged) this.updateShadowBounds(document);
    const editHelperStateKey = `${session.mode}|${session.activeReferenceId ?? ''}|${session.activeShapeId ?? ''}`;
    const selectionChanged = this.editHelperStateKey !== editHelperStateKey || inkChanged;
    this.editHelperStateKey = editHelperStateKey;
    if (selectionChanged) this.rebuildEditHelpers();
    this.controls.enabled = session.mode === 'navigate';
    this.requestRender();
  }

  pickInkSurface(clientX: number, clientY: number, pressure: number): InkSurfaceHit | null {
    if (!this.document || !this.session) return null;
    this.setRay(clientX, clientY);
    const intersections = this.raycaster.intersectObjects(this.shapePickers, false);
    const intersection = intersections[0];
    if (!intersection || !(intersection.object instanceof Mesh)) return null;
    const referenceId = intersection.object.userData.referenceId as string | undefined;
    const shapeId = intersection.object.userData.shapeId as string | undefined;
    const source = referenceId ? getInkSourceByReference(this.document, referenceId) : null;
    const shape = source?.shapes.find((candidate) => candidate.id === shapeId);
    if (!referenceId || !shapeId || !shape) return null;
    // Painting's dynamic Plane helper is translated to the content bounds.
    // Plane author coordinates remain relative to the Shape root, while
    // Cuboid/Sphere coordinates remain relative to their scaled surface mesh.
    const local = shape.kind === 'plane'
      ? intersection.object.parent?.worldToLocal(intersection.point.clone()) ?? intersection.object.worldToLocal(intersection.point.clone())
      : intersection.object.worldToLocal(intersection.point.clone());
    const normalLocal = intersection.face?.normal.clone() ?? new Vector3(0, 0, 1);
    const normal = normalLocal.transformDirection(intersection.object.matrixWorld).normalize();
    return {
      referenceId,
      shapeId,
      shape,
      point: getSurfacePoint(shape, local, normalLocal, pressure),
      world: intersection.point.clone(),
      normal,
    };
  }

  pickGroup(clientX: number, clientY: number): GroupHit | null {
    this.setRay(clientX, clientY);
    const hit = this.raycaster.intersectObjects(this.pivotPickers, false)[0];
    const referenceId = hit?.object.userData.referenceId as string | undefined;
    return referenceId ? { referenceId } : null;
  }

  pickTerrainCell(clientX: number, clientY: number, layer: number): { x: number; y: number; z: number } | null {
    this.setRay(clientX, clientY);
    const point = this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -(layer + 1)), new Vector3());
    return point ? { x: Math.floor(point.x + 0.5), y: layer, z: Math.floor(point.z + 0.5) } : null;
  }

  pickHorizontalPlane(clientX: number, clientY: number, worldY: number): Vector3 | null {
    this.setRay(clientX, clientY);
    return this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -worldY), new Vector3());
  }

  showCursor(hit: InkSurfaceHit, radius: number, square = false): void {
    this.cursor.geometry.dispose();
    this.cursor.geometry = square
      ? new PlaneGeometry(radius * 2, radius * 2)
      : new RingGeometry(Math.max(0.002, radius - 0.008), radius + 0.008, 40);
    this.cursor.position.copy(hit.world).addScaledVector(hit.normal, 0.006);
    this.cursor.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), hit.normal);
    this.cursor.visible = true;
    this.requestRender();
  }

  hideCursor(): void { if (this.cursor.visible) { this.cursor.visible = false; this.requestRender(); } }

  showStrokePreview(referenceId: string, shape: InkShape, points: readonly InkSurfacePoint[], color: string, width: number): void {
    if (!this.document || points.length < 2) { this.clearStrokePreview(); return; }
    const reference = this.document.ink.assetReferences.find((candidate) => candidate.id === referenceId);
    if (!reference) { this.clearStrokePreview(); return; }
    const previewShape: InkShape = { ...shape, strokes: [createInkOutlineStroke(points, color, width)] };
    this.strokePreview.update(compileInkShapeRibbon(previewShape));
    this.strokePreviewRoot.position.set(reference.anchorPosition.x, reference.anchorPosition.y, reference.anchorPosition.z);
    this.strokePreviewRoot.rotation.set(0, reference.rotation * Math.PI / 180, 0);
    applyInkShapeRenderTransform(this.strokePreview.mesh, shape);
    this.requestRender();
  }

  clearStrokePreview(): void { this.strokePreview.clear(); this.requestRender(); }

  focusSelection(): void {
    if (!this.document || !this.session?.activeReferenceId) return;
    const reference = this.document.ink.assetReferences.find((candidate) => candidate.id === this.session!.activeReferenceId);
    if (!reference) return;
    this.controls.target.set(reference.anchorPosition.x, reference.anchorPosition.y, reference.anchorPosition.z);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(direction, 7);
    this.controls.update();
    this.requestRender();
  }

  requestRender(): void {
    if (this.frameRequested || this.disposed) return;
    this.frameRequested = true;
    window.requestAnimationFrame(this.render);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('change', this.handleControlsChange);
    this.controls.dispose();
    this.hardShadow.dispose();
    this.referenceLayer.dispose();
    this.editorGuides.dispose();
    this.terrain.dispose();
    this.inkEntries.forEach((entry) => disposeObjectTree(entry.root));
    this.inkEntries.clear();
    disposeInkShapePreviewTree(this.helperRoot);
    disposeObjectTree(this.groupPivotRoot);
    this.cursor.geometry.dispose();
    (this.cursor.material as MeshBasicMaterial).dispose();
    this.strokePreview.dispose();
    this.renderPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }

  private updateInkGroups(document: InkStudioWorkFile): boolean {
    const resolved = resolveInkGroups(document);
    const sources = new Map(document.ink.embeddedAssets.map((embedded) => [embedded.assetId, embedded.group]));
    const references = new Map(document.ink.assetReferences.map((reference) => [reference.id, reference]));
    const nextIds = new Set(resolved.map((group) => group.id));
    let changed = false;
    for (const [id, entry] of this.inkEntries) {
      if (nextIds.has(id)) continue;
      disposeObjectTree(entry.root);
      entry.root.removeFromParent();
      this.inkEntries.delete(id);
      changed = true;
    }
    for (const group of resolved) {
      const reference = references.get(group.id)!;
      const source = sources.get(reference.assetId)!;
      const anchorKey = `${reference.anchorPosition.x}:${reference.anchorPosition.y}:${reference.anchorPosition.z}:${reference.rotation}`;
      const existing = this.inkEntries.get(group.id);
      if (existing?.source === source && existing.anchorKey === anchorKey) continue;
      if (existing) {
        disposeObjectTree(existing.root);
        existing.root.removeFromParent();
      }
      const root = createInkGroupRenderRoot(group, this.inkLighting);
      root.userData.referenceId = group.id;
      this.inkRoot.add(root);
      this.inkEntries.set(group.id, { source, anchorKey, root });
      changed = true;
    }
    return changed;
  }

  private rebuildEditHelpers(): void {
    disposeInkShapePreviewTree(this.helperRoot);
    disposeObjectTree(this.groupPivotRoot);
    this.shapePickers.length = 0;
    this.pivotPickers.length = 0;
    if (!this.document || !this.session) return;
    const showPivots = this.session.mode === 'select';
    if (showPivots) for (const reference of this.document.ink.assetReferences) {
      const selected = reference.id === this.session.activeReferenceId;
      const pivot = new Mesh(
        new BoxGeometry(selected ? 0.2 : 0.14, selected ? 0.2 : 0.14, selected ? 0.2 : 0.14),
        new MeshBasicMaterial({ color: selected ? 0xf3b85f : 0xd94545, depthTest: false, depthWrite: false }),
      );
      pivot.position.set(reference.anchorPosition.x, reference.anchorPosition.y, reference.anchorPosition.z);
      pivot.userData.referenceId = reference.id;
      pivot.renderOrder = 1500;
      this.groupPivotRoot.add(pivot);
      this.pivotPickers.push(pivot);
    }
    const referenceId = this.session.activeReferenceId;
    const source = getInkSourceByReference(this.document, referenceId);
    const reference = this.document.ink.assetReferences.find((candidate) => candidate.id === referenceId);
    if (!source || !reference || this.session.mode === 'navigate' || this.session.mode === 'terrain') return;
    const groupRoot = new Group();
    groupRoot.position.set(reference.anchorPosition.x, reference.anchorPosition.y, reference.anchorPosition.z);
    groupRoot.rotation.y = reference.rotation * Math.PI / 180;
    this.helperRoot.add(groupRoot);
    for (const shape of source.shapes) {
      const active = this.session.mode !== 'draw' && shape.id === this.session.activeShapeId;
      const preview = createInkShapePreview(shape, active);
      preview.surface.userData.referenceId = reference.id;
      preview.surface.userData.shapeId = shape.id;
      groupRoot.add(preview.root);
      this.shapePickers.push(preview.surface);
    }
  }

  private applyLighting(document: InkStudioWorkFile): boolean {
    const resolved = resolvePreviewLighting(document.previewLighting);
    const nextDirection = new Vector3(resolved.direction.x, resolved.direction.y, resolved.direction.z).normalize();
    const changedDirection = this.inkLighting.lightDirection.distanceToSquared(nextDirection) > 1e-10;
    this.inkLighting.lightDirection.copy(nextDirection);
    const ambient = new Color().setRGB(
      resolved.ambientColor.r,
      resolved.ambientColor.g,
      resolved.ambientColor.b,
    ).multiplyScalar(resolved.ambientIntensity);
    this.inkLighting.ambientIrradiance.set(ambient.r, ambient.g, ambient.b);
    this.scene.background = new Color().setRGB(
      resolved.backgroundColor.r,
      resolved.backgroundColor.g,
      resolved.backgroundColor.b,
    );
    this.mainLight.color.setRGB(resolved.mainColor.r, resolved.mainColor.g, resolved.mainColor.b);
    this.mainLight.intensity = resolved.mainIntensity;
    this.ambientLight.color.setRGB(resolved.ambientColor.r, resolved.ambientColor.g, resolved.ambientColor.b);
    this.ambientLight.intensity = resolved.ambientIntensity;
    this.mainLight.position.copy(this.mainLight.target.position).addScaledVector(nextDirection, 50);
    this.requestRender();
    return changedDirection;
  }

  private updateShadowBounds(document: InkStudioWorkFile): void {
    let minimumX = -4, maximumX = 4, minimumZ = -4, maximumZ = 4, maximumY = 4;
    for (const tile of document.terrain.tiles) {
      minimumX = Math.min(minimumX, tile.x - 1);
      maximumX = Math.max(maximumX, tile.x + 1);
      minimumZ = Math.min(minimumZ, tile.z - 1);
      maximumZ = Math.max(maximumZ, tile.z + 1);
      maximumY = Math.max(maximumY, tile.y + 2);
    }
    for (const reference of document.ink.assetReferences) {
      minimumX = Math.min(minimumX, reference.anchorPosition.x - 4);
      maximumX = Math.max(maximumX, reference.anchorPosition.x + 4);
      minimumZ = Math.min(minimumZ, reference.anchorPosition.z - 4);
      maximumZ = Math.max(maximumZ, reference.anchorPosition.z + 4);
      maximumY = Math.max(maximumY, reference.anchorPosition.y + 6);
    }
    const center = new Vector3((minimumX + maximumX) * 0.5, maximumY * 0.35, (minimumZ + maximumZ) * 0.5);
    const extent = Math.max(6, maximumX - minimumX, maximumZ - minimumZ, maximumY) * 0.75 + 3;
    this.mainLight.target.position.copy(center);
    this.mainLight.position.copy(center).addScaledVector(this.inkLighting.lightDirection, 50);
    this.mainLight.shadow.camera.left = -extent;
    this.mainLight.shadow.camera.right = extent;
    this.mainLight.shadow.camera.top = extent;
    this.mainLight.shadow.camera.bottom = -extent;
    this.mainLight.shadow.camera.far = Math.max(80, extent * 6);
    this.mainLight.shadow.camera.updateProjectionMatrix();
  }

  private setRay(clientX: number, clientY: number): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.set(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private readonly handleControlsChange = (): void => { this.requestRender(); };

  private readonly handleResize = (): void => {
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.referenceLayer.setSize(width, height, this.renderer.getPixelRatio());
    this.requestRender();
  };

  private readonly render = (): void => {
    this.frameRequested = false;
    if (this.disposed) return;
    this.editorGuides.update();
    this.referenceLayer.render(this.scene, this.camera, new Set<Object3D>([this.terrain.referenceRoot]));
    const previousTerrainVisibility = this.terrain.referenceRoot.visible;
    this.terrain.referenceRoot.visible = true;
    this.hardShadow.renderIfNeeded();
    this.terrain.referenceRoot.visible = previousTerrainVisibility;
    this.composer.render();
  };
}

function getSurfacePoint(shape: InkShape, local: Vector3, normal: Vector3, pressure: number): InkSurfacePoint {
  if (shape.kind === 'plane') return { x: local.x, y: local.y, pressure };
  if (shape.kind === 'sphere') {
    const direction = local.normalize();
    return { x: direction.x, y: direction.y, z: direction.z, pressure };
  }
  const face = getCuboidFace(normal);
  if (face === 'positive-x') return { face, u: local.z, v: local.y, pressure };
  if (face === 'negative-x') return { face, u: -local.z, v: local.y, pressure };
  if (face === 'positive-y') return { face, u: local.x, v: local.z, pressure };
  if (face === 'negative-y') return { face, u: local.x, v: -local.z, pressure };
  if (face === 'positive-z') return { face, u: local.x, v: local.y, pressure };
  return { face, u: -local.x, v: local.y, pressure };
}

function getCuboidFace(normal: Vector3): InkCuboidFace {
  const x = Math.abs(normal.x), y = Math.abs(normal.y), z = Math.abs(normal.z);
  if (x >= y && x >= z) return normal.x >= 0 ? 'positive-x' : 'negative-x';
  if (y >= z) return normal.y >= 0 ? 'positive-y' : 'negative-y';
  return normal.z >= 0 ? 'positive-z' : 'negative-z';
}
