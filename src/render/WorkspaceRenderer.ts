import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HalfFloatType,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
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
  compileInkFill,
  createInkOutlineStroke,
  getInkCylinderSurfacePoint,
  type CompiledInkFillSurface,
  type CompiledInkShape,
  type InkCuboidFace,
  type InkGroupData,
  type InkShape,
  type InkSurfacePoint,
} from '../domain/ink/ink';
import { resolvePreviewLighting } from '../domain/lighting/lighting';
import type { StudioEditorSession } from '../domain/workspace/session';
import type { TerrainWorkAxis } from '../domain/workspace/session';
import { isValidTerrainCell, type TerrainCellPosition, type TerrainTileChange, type TileCell } from '../domain/terrain/terrain';
import { getInkSourceByReference, resolveInkGroups, type InkStudioWorkFile } from '../domain/workspace/workspace';
import {
  InkRibbonPreview,
  applyInkShapeRenderTransform,
  createInkFillLightingState,
  createInkGroupRenderRoot,
  createInkRenderAppearanceState,
  createInkShapeRenderRoot,
  getInkWatercolorCaptureState,
  INK_HARD_SHADOW_OWNER_ID_LIMIT,
  INK_FILL_RENDER_LAYER,
  INK_RIBBON_RENDER_LAYER,
  INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY,
  setInkDisplayRenderLayer,
  setInkHardShadowOwnerId,
  type InkFillLightingState,
  type InkRenderAppearanceState,
  updateInkSurfaceOutlines,
  updateInkShapeFillSurfaces,
  updateInkShapeRibbon,
} from './InkGroupRenderer';
import { InkHardShadowMap } from './InkHardShadowMap';
import { InkWatercolorFillLayer } from './InkWatercolorFillLayer';
import { EditorViewportGuides } from './EditorViewportGuides';
import { createInkShapePreview, disposeInkShapePreviewTree, getInkPlanePreviewBounds, type InkShapePreview } from './InkShapePreview';
import { MapReferenceLayer } from './MapReferenceLayer';
import { TerrainRenderer } from './TerrainRenderer';
import { createTerrainBatchGeometry } from './terrainGeometry';
import { disposeObjectTree } from './dispose';
import { PencilPresenceTracker, canNavigateWithFinger } from '../editor/pointerInput';

export const TERRAIN_PREVIEW_COLOR = '#74c7f7';
export const TERRAIN_PREVIEW_OPACITY = 0.42;

type InkRenderEntry = {
  source: InkGroupData;
  anchorKey: string;
  root: Group;
  shapes: Map<string, Group>;
};

type InkRenderUpdate = {
  changed: boolean;
  hardShadowChanged: boolean;
  boundsChanged: boolean;
};

type InkHelperEntry = InkShapePreview & {
  referenceId: string;
  shapeId: string;
  geometryKey: string;
  active: boolean;
};

type StrokePreviewEntry = {
  root: Group;
  preview: InkRibbonPreview;
  referenceId: string | null;
  shapeId: string | null;
};

type HandoffStrokePreviewEntry = {
  root: Group;
  preview: InkRibbonPreview;
  assetId: string;
  shapeId: string;
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

export type TerrainPick =
  | { source: 'terrain'; tile: TileCell; point: Vector3; normal: Vector3 }
  | { source: 'work-plane'; point: Vector3 };

export type InkStrokePreviewSegment = {
  referenceId: string;
  shape: InkShape;
  points: readonly InkSurfacePoint[];
};

export class WorkspaceRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  /** Editor-only render tree kept out of all content and offscreen passes. */
  readonly editorOverlay = new Scene();
  readonly camera = new PerspectiveCamera(42, 1, 0.05, 300);
  readonly controls: OrbitControls;
  readonly inkLighting: InkFillLightingState = createInkFillLightingState();
  readonly inkAppearance: InkRenderAppearanceState = createInkRenderAppearanceState();
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
  private readonly strokePreviewHandoffRoot = new Group();
  private readonly terrainPreviewRoot = new Group();
  private readonly terrainToolPreviewRoot = new Group();
  private readonly referenceLayer: MapReferenceLayer;
  private readonly mainLight = new DirectionalLight(0xffffff, 3.2);
  private readonly ambientLight = new AmbientLight(0xffffff, 0.22);
  private readonly hardShadow: InkHardShadowMap;
  private readonly watercolorFill: InkWatercolorFillLayer;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly inkEntries = new Map<string, InkRenderEntry>();
  private readonly shapePickers: Mesh[] = [];
  private readonly pivotPickers: Mesh[] = [];
  private readonly cursorCircleGeometry = new RingGeometry(0.9, 1.1, 40);
  private readonly cursorSquareGeometry = new PlaneGeometry(2, 2);
  private readonly pencilPresence = new PencilPresenceTracker();
  private readonly cursor: Mesh;
  private readonly strokePreviews: StrokePreviewEntry[] = [];
  private readonly strokePreviewHandoffs: HandoffStrokePreviewEntry[] = [];
  private readonly helperEntries = new Map<string, InkHelperEntry>();
  private helperGroupRoot: Group | null = null;
  private helperGroupReferenceId: string | null = null;
  private terrainPreviewFrame = 0;
  private pendingTerrainPreview: { tiles: readonly TileCell[]; mode: 'place' | 'remove' } | null = null;
  private terrainToolPreviewTimer: number | null = null;
  private cursorIsSquare = false;
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
    // OrbitControls records every PointerEvent before it branches on pointerType.
    // The capture-phase gate also keeps support-hand touches out while a Pencil
    // is hovering or drawing, so their contact cannot rotate the camera.
    canvas.addEventListener('pointerover', this.gateOrbitPointer, { capture: true });
    canvas.addEventListener('pointerenter', this.gateOrbitPointer, { capture: true });
    canvas.addEventListener('pointerdown', this.gateOrbitPointer, { capture: true });
    canvas.addEventListener('pointermove', this.gateOrbitPointer, { capture: true });
    canvas.addEventListener('pointerup', this.gateOrbitPointer, { capture: true });
    canvas.addEventListener('pointercancel', this.gateOrbitPointer, { capture: true });
    canvas.addEventListener('pointerout', this.gateOrbitPointer, { capture: true });
    canvas.addEventListener('pointerleave', this.gateOrbitPointer, { capture: true });
    canvas.addEventListener('wheel', this.blockMouseWheelNavigation, { capture: true, passive: false });
    this.controls.target.set(0, 0.5, 0);
    this.controls.enableDamping = false;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 80;
    // Match Painting's editor-camera pitch range: orbit may pass the target
    // into negative Y, while small pole margins prevent an inverted singularity.
    this.controls.minPolarAngle = 0.01;
    this.controls.maxPolarAngle = Math.PI - 0.01;
    // OrbitControls already separates Touch from mouse-like Pointer Events.
    // Null mouse bindings leave one/two-finger navigation intact while making
    // Apple Pencil and desktop mouse inert for camera movement.
    this.controls.mouseButtons.LEFT = null;
    this.controls.mouseButtons.MIDDLE = null;
    this.controls.mouseButtons.RIGHT = null;
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
    this.editorOverlay.name = 'StudioEditorOverlay';
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
      this.strokePreviewHandoffRoot,
      this.terrainPreviewRoot,
      this.terrainToolPreviewRoot,
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
    this.strokePreviewHandoffRoot.name = 'InkStrokePreviewHandoffRoot';
    this.terrainPreviewRoot.name = 'TerrainEditPreviewRoot';
    this.terrainToolPreviewRoot.name = 'TerrainToolPreviewRoot';
    this.cursor = new Mesh(
      this.cursorCircleGeometry,
      new MeshBasicMaterial({ color: 0x111111, depthTest: false, depthWrite: false, side: DoubleSide }),
    );
    this.cursor.visible = false;
    this.cursor.renderOrder = 2000;
    this.cursorRoot.add(this.cursor);
    this.hardShadow = new InkHardShadowMap(
      this.renderer,
      this.scene,
      this.mainLight,
      this.inkLighting,
      onWarning,
    );
    this.watercolorFill = new InkWatercolorFillLayer(this.renderer);
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(canvas);
    this.handleResize();
    this.requestRender();
  }

  update(document: InkStudioWorkFile, session: StudioEditorSession): void {
    if (this.document && this.document.documentId !== document.documentId) this.clearStrokePreviewHandoffs();
    this.document = document;
    this.session = session;
    this.inkAppearance.watercolorEnabled.value = session.inkAppearance.appearance === 'watercolor' ? 1 : 0;
    this.inkAppearance.crayonGrainDensity.value = session.inkAppearance.crayonGrainDensity;
    this.inkAppearance.crayonMinimumOpacity.value = session.inkAppearance.crayonMinimumOpacity;
    this.inkAppearance.watercolorNoiseScale.value = session.inkAppearance.watercolorFill.noiseScale;
    this.watercolorFill.setSettings(session.inkAppearance.watercolorFill);
    this.terrain.update(document.terrain.tiles);
    this.referenceLayer.setEnabled(session.showReferenceTerrain);
    this.referenceLayer.setTerrainEdgesVisible(session.showTerrainEdges);
    this.editorGuides.setGridVisible(session.showInfiniteGrid);
    this.editorGuides.setAxesVisible(session.showAxes);
    const inkUpdate = this.updateInkGroups(document);
    const lightingDirectionChanged = this.applyLighting(document);
    if (inkUpdate.hardShadowChanged || lightingDirectionChanged) this.markInkHardShadowDirty();
    if (inkUpdate.boundsChanged) this.updateShadowBounds(document);
    const editHelperStateKey = `${session.mode}|${session.activeReferenceId ?? ''}|${session.activeShapeId ?? ''}|${session.excludedShapeIds.join('|')}`;
    const selectionChanged = this.editHelperStateKey !== editHelperStateKey || inkUpdate.changed;
    this.editHelperStateKey = editHelperStateKey;
    if (selectionChanged) this.syncEditHelpers();
    this.controls.enabled = true;
    this.requestRender();
  }

  pickInkSurface(
    clientX: number,
    clientY: number,
    pressure: number,
    fallbackPlane?: { referenceId: string; shapeId: string } | null,
  ): InkSurfaceHit | null {
    if (!this.document || !this.session) return null;
    this.setRay(clientX, clientY);
    const intersections = this.raycaster.intersectObjects(this.shapePickers, false);
    const intersection = intersections[0];
    if (intersection && intersection.object instanceof Mesh) {
      const referenceId = intersection.object.userData.referenceId as string | undefined;
      const shapeId = intersection.object.userData.shapeId as string | undefined;
      const source = referenceId ? getInkSourceByReference(this.document, referenceId) : null;
      const shape = source?.shapes.find((candidate) => candidate.id === shapeId);
      if (referenceId && shapeId && shape) {
        // A dynamic Plane surface is translated inside its Shape root. Author
        // coordinates stay relative to the root; Cuboid/Sphere charts stay
        // relative to their scaled surface mesh.
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
    }

    const candidate = fallbackPlane ?? (this.session.activeReferenceId && this.session.activeShapeId
      ? { referenceId: this.session.activeReferenceId, shapeId: this.session.activeShapeId }
      : null);
    if (!candidate) return null;
    const source = getInkSourceByReference(this.document, candidate.referenceId);
    const shape = source?.shapes.find((entry) => entry.id === candidate.shapeId);
    const helper = this.helperEntries.get(helperKey(candidate.referenceId, candidate.shapeId));
    if (!shape || this.session.excludedShapeIds.includes(shape.id) || shape.kind !== 'plane' || !helper) return null;
    helper.root.updateWorldMatrix(true, false);
    const origin = helper.root.getWorldPosition(new Vector3());
    const normal = new Vector3(0, 0, 1).applyQuaternion(helper.root.getWorldQuaternion(new Quaternion())).normalize();
    const world = this.raycaster.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(normal, origin), new Vector3());
    if (!world) return null;
    const local = helper.root.worldToLocal(world.clone());
    return {
      referenceId: candidate.referenceId,
      shapeId: candidate.shapeId,
      shape,
      point: { x: local.x, y: local.y, pressure },
      world,
      normal,
    };
  }

  pickGroup(clientX: number, clientY: number): GroupHit | null {
    this.setRay(clientX, clientY);
    const hit = this.raycaster.intersectObjects(this.pivotPickers, false)[0];
    const referenceId = hit?.object.userData.referenceId as string | undefined;
    return referenceId ? { referenceId } : null;
  }

  pickTerrain(clientX: number, clientY: number, axis: TerrainWorkAxis): TerrainPick | null {
    this.setRay(clientX, clientY);
    const intersection = this.raycaster.intersectObjects([...this.terrain.getPickMeshes()], false)[0];
    if (intersection) {
      const tile = this.terrain.getTileFromIntersection(intersection);
      const faceNormal = intersection.face?.normal;
      if (tile && faceNormal) {
        return {
          source: 'terrain',
          tile,
          point: intersection.point.clone(),
          normal: faceNormal.clone().transformDirection(intersection.object.matrixWorld).normalize(),
        };
      }
    }
    const point = this.intersectTerrainWorkPlane(axis, 0);
    return point ? { source: 'work-plane', point } : null;
  }

  getTerrainPlacementCell(pick: TerrainPick, axis: TerrainWorkAxis): TerrainCellPosition | null {
    if (pick.source === 'work-plane') {
      const cell = pointToTerrainCell(pick.point);
      cell[axis] = 0;
      return isValidTerrainCell(cell.x, cell.y, cell.z) ? cell : null;
    }
    const { tile, normal } = pick;
    if (normal.y > 0.5) return { x: tile.x, y: tile.y + 1, z: tile.z };
    if (normal.y < -0.5) return { x: tile.x, y: tile.y - 1, z: tile.z };
    if (Math.abs(normal.x) >= Math.abs(normal.z)) return { x: tile.x + Math.sign(normal.x), y: tile.y, z: tile.z };
    return { x: tile.x, y: tile.y, z: tile.z + Math.sign(normal.z) };
  }

  pickTerrainCellOnPlane(
    clientX: number,
    clientY: number,
    axis: TerrainWorkAxis,
    coordinate: number,
  ): TerrainCellPosition | null {
    if (!Number.isInteger(coordinate)) return null;
    this.setRay(clientX, clientY);
    const point = this.intersectTerrainWorkPlane(axis, coordinate);
    if (!point) return null;
    const cell = pointToTerrainCell(point);
    cell[axis] = coordinate;
    return isValidTerrainCell(cell.x, cell.y, cell.z) ? cell : null;
  }

  prepareTerrainPatch(changes: readonly TerrainTileChange[]): void {
    this.terrain.preparePatch(changes);
  }

  setTerrainPreviews(tiles: readonly TileCell[], mode: 'place' | 'remove'): void {
    this.pendingTerrainPreview = { tiles: [...tiles], mode };
    if (!this.terrainPreviewFrame) this.terrainPreviewFrame = requestAnimationFrame(this.flushTerrainPreview);
  }

  clearTerrainPreview(): void {
    this.pendingTerrainPreview = null;
    if (this.terrainPreviewFrame) cancelAnimationFrame(this.terrainPreviewFrame);
    this.terrainPreviewFrame = 0;
    disposeObjectTree(this.terrainPreviewRoot);
    this.terrainPreviewRoot.clear();
    this.requestRender();
  }

  showTerrainToolPreview(tile: TileCell): void {
    if (this.terrainToolPreviewTimer !== null) window.clearTimeout(this.terrainToolPreviewTimer);
    disposeObjectTree(this.terrainToolPreviewRoot);
    this.terrainToolPreviewRoot.clear();
    const mesh = new Mesh(
      createTerrainBatchGeometry([{ ...tile, x: 0, y: 0, z: 0 }]),
      createTerrainPreviewMaterial(true),
    );
    mesh.renderOrder = 3000;
    this.terrainToolPreviewRoot.position.set(0, 0, 0);
    this.terrainToolPreviewRoot.quaternion.identity();
    this.terrainToolPreviewRoot.add(mesh);
    this.terrainToolPreviewTimer = window.setTimeout(() => {
      this.terrainToolPreviewTimer = null;
      disposeObjectTree(this.terrainToolPreviewRoot);
      this.terrainToolPreviewRoot.clear();
      this.requestRender();
    }, 1_000);
    this.requestRender();
  }

  pickHorizontalPlane(clientX: number, clientY: number, worldY: number): Vector3 | null {
    this.setRay(clientX, clientY);
    return this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -worldY), new Vector3());
  }

  showCursor(hit: InkSurfaceHit, radius: number, square = false): void {
    if (this.cursorIsSquare !== square) {
      this.cursorIsSquare = square;
      this.cursor.geometry = square ? this.cursorSquareGeometry : this.cursorCircleGeometry;
    }
    this.cursor.scale.setScalar(Math.max(0.002, radius));
    this.cursor.position.copy(hit.world).addScaledVector(hit.normal, 0.006);
    this.cursor.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), hit.normal);
    this.cursor.visible = true;
    this.requestRender();
  }

  hideCursor(): void { if (this.cursor.visible) { this.cursor.visible = false; this.requestRender(); } }

  showStrokePreviews(segments: readonly InkStrokePreviewSegment[], color: string, width: number): void {
    if (!this.document) return;
    let used = 0;
    for (const segment of segments) {
      if (segment.points.length < 2) continue;
      const reference = this.document.ink.assetReferences.find((candidate) => candidate.id === segment.referenceId);
      if (!reference) continue;
      const entry = this.ensureStrokePreview(used++);
      entry.referenceId = segment.referenceId;
      entry.shapeId = segment.shape.id;
      const previewShape: InkShape = {
        ...segment.shape,
        strokes: [createInkOutlineStroke(segment.points, color, width)],
      };
      entry.preview.update(compileInkShapeRibbon(previewShape));
      entry.root.position.set(reference.anchorPosition.x, reference.anchorPosition.y, reference.anchorPosition.z);
      entry.root.rotation.set(0, reference.rotation * Math.PI / 180, 0);
      applyInkShapeRenderTransform(entry.preview.mesh, segment.shape);
      entry.root.visible = true;
    }
    for (let index = used; index < this.strokePreviews.length; index += 1) {
      this.clearStrokePreviewEntry(this.strokePreviews[index]!);
    }
    this.requestRender();
  }

  clearStrokePreview(): void {
    for (const entry of this.strokePreviews) this.clearStrokePreviewEntry(entry);
    this.requestRender();
  }

  retainStrokePreviewsUntilCompiled(): void {
    if (!this.document) {
      this.clearStrokePreview();
      return;
    }
    const retained: StrokePreviewEntry[] = [];
    for (const entry of this.strokePreviews) {
      const reference = entry.referenceId
        ? this.document.ink.assetReferences.find((candidate) => candidate.id === entry.referenceId)
        : null;
      if (!entry.root.visible || !reference || !entry.shapeId) {
        retained.push(entry);
        continue;
      }
      this.strokePreviewHandoffRoot.add(entry.root);
      this.strokePreviewHandoffs.push({
        root: entry.root,
        preview: entry.preview,
        assetId: reference.assetId,
        shapeId: entry.shapeId,
      });
    }
    this.strokePreviews.length = 0;
    this.strokePreviews.push(...retained);
    this.requestRender();
  }

  releaseStrokePreviewHandoffs(assetId: string, shapeId: string): void {
    let released = false;
    const retained: HandoffStrokePreviewEntry[] = [];
    for (const entry of this.strokePreviewHandoffs) {
      if (entry.assetId !== assetId || entry.shapeId !== shapeId) {
        retained.push(entry);
        continue;
      }
      this.recycleHandoffStrokePreview(entry);
      released = true;
    }
    if (!released) return;
    this.strokePreviewHandoffs.length = 0;
    this.strokePreviewHandoffs.push(...retained);
    this.requestRender();
  }

  previewInkFill(referenceId: string, shape: InkShape): void {
    const entry = this.inkEntries.get(referenceId);
    const root = entry?.shapes.get(shape.id);
    if (!root) return;
    updateInkShapeFillSurfaces(
      root,
      compileInkFill(shape),
      shape,
      this.inkLighting,
      this.inkAppearance,
    );
    applyInkShapeRenderTransform(root, shape);
    this.syncSingleInkHelper(referenceId, shape);
    this.markInkHardShadowDirty();
    this.requestRender();
  }

  previewInkRibbon(referenceId: string, shape: InkShape): void {
    const root = this.inkEntries.get(referenceId)?.shapes.get(shape.id);
    if (!root) return;
    updateInkShapeRibbon(root, compileInkShapeRibbon(shape), shape, this.inkAppearance);
    this.requestRender();
  }

  previewGroupTransform(referenceId: string, position: Readonly<{ x: number; y: number; z: number }>, rotationDegrees: number): void {
    const entry = this.inkEntries.get(referenceId);
    if (entry) {
      entry.root.position.set(position.x, position.y, position.z);
      entry.root.rotation.y = rotationDegrees * Math.PI / 180;
    }
    if (this.helperGroupReferenceId === referenceId && this.helperGroupRoot) {
      this.helperGroupRoot.position.set(position.x, position.y, position.z);
      this.helperGroupRoot.rotation.y = rotationDegrees * Math.PI / 180;
    }
    const pivot = this.pivotPickers.find((candidate) => candidate.userData.referenceId === referenceId);
    pivot?.position.set(position.x, position.y, position.z);
    if (entry && hasInkHardShadowCasterInGroup(entry.source)) this.markInkHardShadowDirty();
    this.requestRender();
  }

  previewShapeTransform(referenceId: string, shape: InkShape): void {
    const renderRoot = this.inkEntries.get(referenceId)?.shapes.get(shape.id);
    if (renderRoot) applyInkShapeRenderTransform(renderRoot, shape);
    const helper = this.helperEntries.get(helperKey(referenceId, shape.id));
    if (helper) applyInkShapeRenderTransform(helper.root, shape);
    const compiled = this.inkEntries.get(referenceId)?.source.compiled.shapes.find((entry) => entry.shapeId === shape.id);
    if (hasInkHardShadowCasterInShape(compiled)) this.markInkHardShadowDirty();
    this.requestRender();
  }

  /** Updates only one Shape's intrinsic dimensions and finite Fill chart preview. */
  previewShapeIntrinsicSize(referenceId: string, shape: InkShape): void {
    const root = this.inkEntries.get(referenceId)?.shapes.get(shape.id);
    const fills = compileInkFill(shape);
    if (root) {
      updateInkShapeFillSurfaces(root, fills, shape, this.inkLighting, this.inkAppearance);
      applyInkShapeRenderTransform(root, shape);
    }
    this.syncSingleInkHelper(referenceId, shape);
    if (fills.length > 0) this.markInkHardShadowDirty();
    this.requestRender();
  }

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
    this.canvas.removeEventListener('pointerover', this.gateOrbitPointer, { capture: true });
    this.canvas.removeEventListener('pointerenter', this.gateOrbitPointer, { capture: true });
    this.canvas.removeEventListener('pointerdown', this.gateOrbitPointer, { capture: true });
    this.canvas.removeEventListener('pointermove', this.gateOrbitPointer, { capture: true });
    this.canvas.removeEventListener('pointerup', this.gateOrbitPointer, { capture: true });
    this.canvas.removeEventListener('pointercancel', this.gateOrbitPointer, { capture: true });
    this.canvas.removeEventListener('pointerout', this.gateOrbitPointer, { capture: true });
    this.canvas.removeEventListener('pointerleave', this.gateOrbitPointer, { capture: true });
    this.canvas.removeEventListener('wheel', this.blockMouseWheelNavigation, { capture: true });
    if (this.terrainPreviewFrame) cancelAnimationFrame(this.terrainPreviewFrame);
    if (this.terrainToolPreviewTimer !== null) window.clearTimeout(this.terrainToolPreviewTimer);
    this.hardShadow.dispose();
    this.watercolorFill.dispose();
    this.referenceLayer.dispose();
    this.editorGuides.dispose();
    this.terrain.dispose();
    this.inkEntries.forEach((entry) => disposeObjectTree(entry.root));
    this.inkEntries.clear();
    disposeInkShapePreviewTree(this.helperRoot);
    disposeObjectTree(this.groupPivotRoot);
    disposeObjectTree(this.terrainPreviewRoot);
    disposeObjectTree(this.terrainToolPreviewRoot);
    this.cursorCircleGeometry.dispose();
    this.cursorSquareGeometry.dispose();
    (this.cursor.material as MeshBasicMaterial).dispose();
    for (const entry of this.strokePreviews) entry.preview.dispose();
    for (const entry of this.strokePreviewHandoffs) entry.preview.dispose();
    this.strokePreviews.length = 0;
    this.strokePreviewHandoffs.length = 0;
    this.renderPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }

  /** Reassigns transient owner IDs only when the Ink hard-shadow input is dirty. */
  private markInkHardShadowDirty(): void {
    this.assignInkHardShadowOwnerIds();
    this.hardShadow.markDirty();
  }

  private assignInkHardShadowOwnerIds(): void {
    let nextOwnerId = 1;
    const fillMeshes: Mesh[] = [];
    for (const entry of this.inkEntries.values()) {
      for (const shapeRoot of entry.shapes.values()) {
        let hasFill = false;
        shapeRoot.traverse((object) => {
          if (!(object instanceof Mesh) || object.name !== 'InkFillSurface') return;
          if (!object.userData[INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY]) {
            throw new Error(`Ink Fill ${object.uuid} has no Watercolor capture material.`);
          }
          hasFill = true;
          fillMeshes.push(object);
        });
        const ownerId = hasFill && nextOwnerId <= INK_HARD_SHADOW_OWNER_ID_LIMIT ? nextOwnerId++ : 0;
        setInkHardShadowOwnerId(shapeRoot, ownerId);
      }
    }
    this.watercolorFill.setFillMeshes(fillMeshes);
  }

  private updateInkGroups(document: InkStudioWorkFile): InkRenderUpdate {
    const resolved = resolveInkGroups(document);
    const sources = new Map(document.ink.embeddedAssets.map((embedded) => [embedded.assetId, embedded.group]));
    const references = new Map(document.ink.assetReferences.map((reference) => [reference.id, reference]));
    const nextIds = new Set(resolved.map((group) => group.id));
    let changed = false;
    let hardShadowChanged = false;
    let boundsChanged = false;
    for (const [id, entry] of this.inkEntries) {
      if (nextIds.has(id)) continue;
      hardShadowChanged ||= hasInkHardShadowCasterInGroup(entry.source);
      boundsChanged = true;
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
      if (!existing) {
        const root = createInkGroupRenderRoot(group, this.inkLighting, this.inkAppearance);
        setInkDisplayRenderLayer(root);
        root.userData.referenceId = group.id;
        this.inkRoot.add(root);
        this.inkEntries.set(group.id, {
          source,
          anchorKey,
          root,
          shapes: collectInkShapeRoots(root),
        });
        hardShadowChanged ||= hasInkHardShadowCasterInGroup(source);
        boundsChanged = true;
        changed = true;
        continue;
      }

      if (existing.anchorKey !== anchorKey) {
        const hasCaster = hasInkHardShadowCasterInGroup(existing.source) || hasInkHardShadowCasterInGroup(source);
        existing.root.position.set(reference.anchorPosition.x, reference.anchorPosition.y, reference.anchorPosition.z);
        existing.root.rotation.y = reference.rotation * Math.PI / 180;
        hardShadowChanged ||= hasCaster;
        boundsChanged = true;
      }
      if (existing.source !== source) {
        hardShadowChanged ||= this.updateInkGroupShapes(existing, source);
      }
      existing.source = source;
      existing.anchorKey = anchorKey;
      changed = true;
    }
    return { changed, hardShadowChanged, boundsChanged };
  }

  /** Reuses Shape roots and uploaded Ribbon buffers whenever their true source is unchanged. */
  private updateInkGroupShapes(entry: InkRenderEntry, source: InkGroupData): boolean {
    const previousShapes = new Map(entry.source.shapes.map((shape) => [shape.id, shape]));
    const nextShapes = new Map(source.shapes.map((shape) => [shape.id, shape]));
    const previousCompiled = new Map(entry.source.compiled.shapes.map((shape) => [shape.shapeId, shape]));
    const nextCompiled = new Map(source.compiled.shapes.map((shape) => [shape.shapeId, shape]));
    let hardShadowChanged = false;

    for (const [shapeId, root] of entry.shapes) {
      if (nextShapes.has(shapeId) && nextCompiled.has(shapeId)) continue;
      hardShadowChanged ||= hasInkHardShadowCasterInShape(previousCompiled.get(shapeId));
      disposeObjectTree(root);
      root.removeFromParent();
      entry.shapes.delete(shapeId);
    }

    for (const [shapeId, compiled] of nextCompiled) {
      const shape = nextShapes.get(shapeId);
      if (!shape) continue;
      const existing = entry.shapes.get(shapeId);
      const priorShape = previousShapes.get(shapeId);
      const priorCompiled = previousCompiled.get(shapeId);
      if (!existing) {
        const root = createInkShapeRenderRoot(
          compiled,
          shape,
          this.inkLighting,
          this.inkAppearance,
          getInkWatercolorCaptureState(entry.root) ?? undefined,
        );
        setInkDisplayRenderLayer(root);
        entry.root.add(root);
        entry.shapes.set(shapeId, root);
        hardShadowChanged ||= hasInkHardShadowCasterInShape(compiled);
        continue;
      }

      const shapeTransformChanged = !priorShape || didInkShapeTransformChange(priorShape, shape);
      const fillChanged = !sameCompiledInkFill(priorCompiled?.fill ?? [], compiled.fill);
      if ((shapeTransformChanged || fillChanged)
        && (hasInkHardShadowCasterInShape(priorCompiled) || hasInkHardShadowCasterInShape(compiled))) {
        hardShadowChanged = true;
      }

      if (priorCompiled?.sourceHash === compiled.sourceHash) {
        applyInkShapeRenderTransform(existing, shape);
        continue;
      }
      if (priorCompiled?.ribbonSourceHash === compiled.ribbonSourceHash) {
        applyInkShapeRenderTransform(existing, shape);
        updateInkShapeFillSurfaces(
          existing,
          compiled.fill,
          shape,
          this.inkLighting,
          this.inkAppearance,
        );
        setInkDisplayRenderLayer(existing);
        continue;
      }
      // An Outline-only Worker result changes its Ribbon hash but leaves both
      // Fill payload and Shape transform intact. Keep the Shape root so its
      // transient hard-shadow owner state remains paired with the capture.
      if (priorShape && priorCompiled && !shapeTransformChanged && !fillChanged) {
        applyInkShapeRenderTransform(existing, shape);
        updateInkShapeRibbon(existing, compiled.ribbon, shape, this.inkAppearance);
        setInkDisplayRenderLayer(existing);
        continue;
      }

      disposeObjectTree(existing);
      existing.removeFromParent();
      const replacement = createInkShapeRenderRoot(
        compiled,
        shape,
        this.inkLighting,
        this.inkAppearance,
        getInkWatercolorCaptureState(entry.root) ?? undefined,
      );
      setInkDisplayRenderLayer(replacement);
      entry.root.add(replacement);
      entry.shapes.set(shapeId, replacement);
    }
    return hardShadowChanged;
  }

  private syncEditHelpers(): void {
    if (!this.document || !this.session) {
      this.clearShapeHelpers();
      this.clearGroupPivots();
      return;
    }
    if (this.session.mode === 'select') {
      this.clearShapeHelpers();
      this.syncGroupPivots();
      return;
    }
    this.clearGroupPivots();
    if (this.session.mode === 'terrain') {
      this.clearShapeHelpers();
      return;
    }
    const referenceId = this.session.activeReferenceId;
    const source = getInkSourceByReference(this.document, referenceId);
    const reference = this.document.ink.assetReferences.find((candidate) => candidate.id === referenceId);
    if (!referenceId || !source || !reference) {
      this.clearShapeHelpers();
      return;
    }
    if (this.helperGroupReferenceId !== referenceId || !this.helperGroupRoot) {
      this.clearShapeHelpers();
      this.helperGroupRoot = new Group();
      this.helperGroupRoot.name = 'InkShapeHelperGroup';
      this.helperGroupReferenceId = referenceId;
      this.helperRoot.add(this.helperGroupRoot);
    }
    this.helperGroupRoot.position.set(reference.anchorPosition.x, reference.anchorPosition.y, reference.anchorPosition.z);
    this.helperGroupRoot.rotation.y = reference.rotation * Math.PI / 180;

    const visibleShapes = source.shapes.filter((shape) => !this.session!.excludedShapeIds.includes(shape.id));
    const nextShapeIds = new Set(visibleShapes.map((shape) => shape.id));
    for (const [key, entry] of this.helperEntries) {
      if (entry.referenceId === referenceId && nextShapeIds.has(entry.shapeId)) continue;
      entry.root.removeFromParent();
      disposeInkShapePreviewTree(entry.root);
      this.helperEntries.delete(key);
    }
    for (const shape of visibleShapes) this.syncSingleInkHelper(referenceId, shape);
    this.refreshShapePickers();
  }

  private syncSingleInkHelper(referenceId: string, shape: InkShape): void {
    if (!this.session || this.helperGroupReferenceId !== referenceId || !this.helperGroupRoot) return;
    const key = helperKey(referenceId, shape.id);
    const active = this.session.mode === 'shape' && shape.id === this.session.activeShapeId;
    const geometryKey = getInkShapeHelperGeometryKey(shape);
    const existing = this.helperEntries.get(key);
    if (!existing || existing.geometryKey !== geometryKey || existing.active !== active) {
      if (existing) {
        existing.root.removeFromParent();
        disposeInkShapePreviewTree(existing.root);
      }
      const preview = createInkShapePreview(shape, active);
      preview.surface.userData.referenceId = referenceId;
      preview.surface.userData.shapeId = shape.id;
      const entry: InkHelperEntry = { ...preview, referenceId, shapeId: shape.id, geometryKey, active };
      this.helperEntries.set(key, entry);
      this.helperGroupRoot.add(entry.root);
      this.refreshShapePickers();
      return;
    }
    applyInkShapeRenderTransform(existing.root, shape);
  }

  private syncGroupPivots(): void {
    this.clearGroupPivots();
    if (!this.document || !this.session) return;
    for (const reference of this.document.ink.assetReferences) {
      const selected = reference.id === this.session.activeReferenceId;
      const pivot = new Mesh(
        new BoxGeometry(selected ? 0.2 : 0.14, selected ? 0.2 : 0.14, selected ? 0.2 : 0.14),
        new MeshBasicMaterial({ color: selected ? 0x63c7fa : 0x548097, depthTest: false, depthWrite: false }),
      );
      pivot.position.set(reference.anchorPosition.x, reference.anchorPosition.y, reference.anchorPosition.z);
      pivot.userData.referenceId = reference.id;
      pivot.renderOrder = 1500;
      this.groupPivotRoot.add(pivot);
      this.pivotPickers.push(pivot);
    }
  }

  private clearShapeHelpers(): void {
    disposeInkShapePreviewTree(this.helperRoot);
    this.helperEntries.clear();
    this.shapePickers.length = 0;
    this.helperGroupRoot = null;
    this.helperGroupReferenceId = null;
  }

  private clearGroupPivots(): void {
    disposeObjectTree(this.groupPivotRoot);
    this.pivotPickers.length = 0;
  }

  private refreshShapePickers(): void {
    this.shapePickers.length = 0;
    for (const entry of this.helperEntries.values()) this.shapePickers.push(entry.surface);
  }

  private ensureStrokePreview(index: number): StrokePreviewEntry {
    const existing = this.strokePreviews[index];
    if (existing) return existing;
    const root = new Group();
    const preview = new InkRibbonPreview();
    root.add(preview.mesh);
    this.strokePreviewRoot.add(root);
    const entry = { root, preview, referenceId: null, shapeId: null };
    this.strokePreviews.push(entry);
    return entry;
  }

  private clearStrokePreviewEntry(entry: StrokePreviewEntry): void {
    entry.preview.clear();
    entry.root.visible = false;
    entry.referenceId = null;
    entry.shapeId = null;
  }

  private clearStrokePreviewHandoffs(): void {
    for (const entry of this.strokePreviewHandoffs) this.recycleHandoffStrokePreview(entry);
    this.strokePreviewHandoffs.length = 0;
  }

  private recycleHandoffStrokePreview(entry: HandoffStrokePreviewEntry): void {
    entry.preview.clear();
    entry.root.visible = false;
    this.strokePreviewRoot.add(entry.root);
    this.strokePreviews.push({ root: entry.root, preview: entry.preview, referenceId: null, shapeId: null });
  }

  private readonly flushTerrainPreview = (): void => {
    this.terrainPreviewFrame = 0;
    const preview = this.pendingTerrainPreview;
    this.pendingTerrainPreview = null;
    disposeObjectTree(this.terrainPreviewRoot);
    this.terrainPreviewRoot.clear();
    if (!preview || preview.tiles.length === 0 || this.disposed) return;
    const material = preview.mode === 'place'
      ? createTerrainPreviewMaterial(false)
      : new MeshBasicMaterial({ color: 0xd35f5f, transparent: true, opacity: 0.5, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const mesh = new Mesh(createTerrainBatchGeometry(preview.tiles), material);
    mesh.renderOrder = 20;
    this.terrainPreviewRoot.add(mesh);
    this.requestRender();
  };

  private intersectTerrainWorkPlane(axis: TerrainWorkAxis, coordinate: number): Vector3 | null {
    const normal = new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    return this.raycaster.ray.intersectPlane(new Plane(normal, -coordinate), new Vector3());
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
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private readonly handleControlsChange = (): void => { this.requestRender(); };

  private readonly gateOrbitPointer = (event: PointerEvent): void => {
    this.pencilPresence.observe(event);
    this.controls.enabled = canNavigateWithFinger(event, this.pencilPresence.isPresent);
  };

  private readonly blockMouseWheelNavigation = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

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
    this.watercolorFill.setSize(width, height, this.renderer.getPixelRatio());
    this.requestRender();
  };

  private readonly render = (): void => {
    this.frameRequested = false;
    if (this.disposed) return;
    this.camera.updateMatrixWorld();
    this.editorGuides.update();
    const hasReference = this.referenceLayer.render(this.scene, this.camera, new Set<Object3D>([this.terrain.referenceRoot]));
    this.hardShadow.renderIfNeeded();
    if (hasReference) this.renderReferenceOutput();
    this.renderInkDisplay(hasReference);
    this.renderEditorOverlay();
  };

  /** Stage 5: ACES + sRGB applies only to the captured Map Reference display. */
  private renderReferenceOutput(): void {
    this.renderScenePhase([this.referenceLayer.mesh], () => this.composer.render());
  }

  /**
   * Stage 6: Ink is composited after Reference output as original authored
   * sRGB bytes. Reference never writes the depth used by this stage.
   */
  private renderInkDisplay(hasReference: boolean): void {
    updateInkSurfaceOutlines(this.inkRoot, this.camera);
    const previousOutputColorSpace = this.renderer.outputColorSpace;
    const previousToneMapping = this.renderer.toneMapping;
    const previousExposure = this.renderer.toneMappingExposure;
    const previousAutoClear = this.renderer.autoClear;
    const previousClearColor = this.renderer.getClearColor(new Color());
    const previousClearAlpha = this.renderer.getClearAlpha();
    const previousBackground = this.scene.background;
    const previousCameraLayers = this.camera.layers.mask;
    try {
      this.renderer.setRenderTarget(null);
      this.renderer.outputColorSpace = LinearSRGBColorSpace;
      this.renderer.toneMapping = NoToneMapping;
      this.renderer.toneMappingExposure = 1;
      this.renderer.autoClear = false;
      this.scene.background = null;
      if (hasReference) this.renderer.clearDepth();
      else {
        const rawBackground = getRawSrgbBackground(previousBackground);
        this.renderer.setClearColor(rawBackground ?? previousClearColor, rawBackground ? 1 : previousClearAlpha);
        this.renderer.clear(true, true, false);
      }
      this.renderScenePhase([this.inkRoot, this.strokePreviewRoot, this.strokePreviewHandoffRoot], () => {
        if (this.inkAppearance.watercolorEnabled.value > 0.5) {
          this.watercolorFill.render(this.scene, this.camera, null);
          this.renderer.setRenderTarget(null);
          this.camera.layers.set(0);
          this.camera.layers.enable(INK_RIBBON_RENDER_LAYER);
          this.renderer.render(this.scene, this.camera);
          return;
        }
        this.camera.layers.set(0);
        this.camera.layers.enable(INK_FILL_RENDER_LAYER);
        this.camera.layers.enable(INK_RIBBON_RENDER_LAYER);
        this.renderer.render(this.scene, this.camera);
      });
    } finally {
      this.camera.layers.mask = previousCameraLayers;
      this.scene.background = previousBackground;
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setClearColor(previousClearColor, previousClearAlpha);
      this.renderer.toneMappingExposure = previousExposure;
      this.renderer.toneMapping = previousToneMapping;
      this.renderer.outputColorSpace = previousOutputColorSpace;
    }
  }

  /** Stage 7: Studio-only guides and controls are drawn after Ink. */
  private renderEditorOverlay(): void {
    const previousToneMapping = this.renderer.toneMapping;
    const previousExposure = this.renderer.toneMappingExposure;
    const previousAutoClear = this.renderer.autoClear;
    const previousBackground = this.scene.background;
    try {
      this.renderer.setRenderTarget(null);
      this.renderer.toneMapping = NoToneMapping;
      this.renderer.toneMappingExposure = 1;
      this.renderer.autoClear = false;
      this.scene.background = null;
      this.renderScenePhase(
        [this.editorGuides, this.helperRoot, this.groupPivotRoot, this.cursorRoot, this.terrainPreviewRoot, this.terrainToolPreviewRoot],
        () => this.renderer.render(this.scene, this.camera),
      );
      this.renderer.render(this.editorOverlay, this.camera);
    } finally {
      this.scene.background = previousBackground;
      this.renderer.autoClear = previousAutoClear;
      this.renderer.toneMappingExposure = previousExposure;
      this.renderer.toneMapping = previousToneMapping;
    }
  }

  private renderScenePhase(visibleRoots: readonly Object3D[], render: () => void): void {
    const rootStates = new Map<Object3D, boolean>();
    for (const root of this.getSceneRenderRoots()) {
      rootStates.set(root, root.visible);
      root.visible = root.visible && visibleRoots.includes(root);
    }
    try {
      render();
    } finally {
      rootStates.forEach((visible, root) => { root.visible = visible; });
    }
  }

  private getSceneRenderRoots(): readonly Object3D[] {
    return [
      this.referenceLayer.mesh,
      this.terrain.referenceRoot,
      this.editorGuides,
      this.inkRoot,
      this.helperRoot,
      this.groupPivotRoot,
      this.cursorRoot,
      this.strokePreviewRoot,
      this.strokePreviewHandoffRoot,
      this.terrainPreviewRoot,
      this.terrainToolPreviewRoot,
    ];
  }
}

export function createTerrainPreviewMaterial(overlay: boolean): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: TERRAIN_PREVIEW_COLOR,
    transparent: true,
    opacity: TERRAIN_PREVIEW_OPACITY,
    depthTest: !overlay,
    depthWrite: false,
    ...(overlay ? {} : { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  });
}

function helperKey(referenceId: string, shapeId: string): string {
  return `${referenceId}:${shapeId}`;
}

function getRawSrgbBackground(background: Scene['background']): Color | null {
  return background instanceof Color ? background.clone().convertLinearToSRGB() : null;
}

function getInkShapeHelperGeometryKey(shape: InkShape): string {
  if (shape.kind === 'plane') {
    const bounds = getInkPlanePreviewBounds(shape);
    return `plane:${bounds.minX}:${bounds.maxX}:${bounds.minY}:${bounds.maxY}`;
  }
  if (shape.kind === 'cuboid') return `cuboid:${shape.size.x}:${shape.size.y}:${shape.size.z}`;
  if (shape.kind === 'sphere') return `sphere:${shape.radius}`;
  if (shape.kind === 'cylinder') return `cylinder:${shape.radius}:${shape.height}`;
  return `frustum:${shape.topSize}:${shape.bottomSize}:${shape.height}`;
}

function pointToTerrainCell(point: Vector3): TerrainCellPosition {
  return {
    x: Math.floor(point.x + 0.5),
    y: Math.floor(point.y + 0.5),
    z: Math.floor(point.z + 0.5),
  };
}

function collectInkShapeRoots(root: Group): Map<string, Group> {
  const shapes = new Map<string, Group>();
  for (const child of root.children) {
    if (child instanceof Group && typeof child.userData.inkShapeId === 'string') {
      shapes.set(child.userData.inkShapeId, child);
    }
  }
  return shapes;
}

function hasInkHardShadowCasterInGroup(group: InkGroupData): boolean {
  return group.compiled.shapes.some((shape) => hasInkHardShadowCasterInShape(shape));
}

function hasInkHardShadowCasterInShape(shape: CompiledInkShape | undefined): boolean {
  return (shape?.fill.length ?? 0) > 0;
}

function didInkShapeTransformChange(previous: InkShape, next: InkShape): boolean {
  if (previous.kind !== next.kind
    || !sameInkVector3(previous.position, next.position)
    || !sameInkVector3(previous.rotation, next.rotation)) return true;
  if (previous.kind === 'cuboid' && next.kind === 'cuboid') return !sameInkVector3(previous.size, next.size);
  if (previous.kind === 'sphere' && next.kind === 'sphere') return previous.radius !== next.radius;
  if (previous.kind === 'cylinder' && next.kind === 'cylinder') return previous.radius !== next.radius || previous.height !== next.height;
  if (previous.kind === 'frustum' && next.kind === 'frustum') {
    return previous.topSize !== next.topSize || previous.bottomSize !== next.bottomSize || previous.height !== next.height;
  }
  return false;
}

/** Worker round-trips break reference equality, so compare the packed Fill payload exactly. */
function sameCompiledInkFill(
  previous: readonly CompiledInkFillSurface[],
  next: readonly CompiledInkFillSurface[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let surfaceIndex = 0; surfaceIndex < previous.length; surfaceIndex += 1) {
    const first = previous[surfaceIndex]!;
    const second = next[surfaceIndex]!;
    if (first === second) continue;
    if (first.id !== second.id
      || first.minX !== second.minX
      || first.minY !== second.minY
      || first.width !== second.width
      || first.height !== second.height
      || first.rgba.length !== second.rgba.length) return false;
    for (let componentIndex = 0; componentIndex < first.rgba.length; componentIndex += 1) {
      if (first.rgba[componentIndex] !== second.rgba[componentIndex]) return false;
    }
  }
  return true;
}

function sameInkVector3(
  previous: Readonly<{ x: number; y: number; z: number }>,
  next: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  return previous.x === next.x && previous.y === next.y && previous.z === next.z;
}

function getSurfacePoint(shape: InkShape, local: Vector3, normal: Vector3, pressure: number): InkSurfacePoint {
  if (shape.kind === 'plane') return { x: local.x, y: local.y, pressure };
  if (shape.kind === 'sphere') {
    const direction = local.normalize();
    return { x: direction.x, y: direction.y, z: direction.z, pressure };
  }
  if (shape.kind === 'cylinder') {
    if (normal.y > 0.5) return getInkCylinderSurfacePoint(shape, local, 'top', pressure);
    if (normal.y < -0.5) return getInkCylinderSurfacePoint(shape, local, 'bottom', pressure);
    return getInkCylinderSurfacePoint(shape, local, 'side', pressure);
  }
  const face = getCuboidFace(normal);
  if (shape.kind === 'frustum') {
    if (face === 'positive-y') return { face, u: local.x / shape.topSize, v: local.z / shape.topSize, pressure };
    if (face === 'negative-y') return { face, u: local.x / shape.bottomSize, v: -local.z / shape.bottomSize, pressure };
    const progress = Math.min(1, Math.max(0, local.y / shape.height + 0.5));
    const halfSize = (shape.bottomSize + (shape.topSize - shape.bottomSize) * progress) * 0.5;
    if (face === 'positive-x') return { face, u: local.z / (halfSize * 2), v: progress - 0.5, pressure };
    if (face === 'negative-x') return { face, u: -local.z / (halfSize * 2), v: progress - 0.5, pressure };
    if (face === 'positive-z') return { face, u: local.x / (halfSize * 2), v: progress - 0.5, pressure };
    return { face, u: -local.x / (halfSize * 2), v: progress - 0.5, pressure };
  }
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
