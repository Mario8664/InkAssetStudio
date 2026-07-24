import {
  BoxGeometry,
  Euler,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { InkShape, InkVector3 } from '../domain/ink/ink';
import type { StudioEditorSession } from '../domain/workspace/session';
import {
  getInkReference,
  getInkSourceByReference,
  updateInkReference,
  updateInkShapeAuthor,
  type InkStudioWorkFile,
} from '../domain/workspace/workspace';
import type { WorkspaceStore } from '../domain/workspace/WorkspaceStore';
import { WorkspaceRenderer } from '../render/WorkspaceRenderer';
import { disposeObjectTree } from '../render/dispose';
import { isApplePencilPointer } from './pointerInput';

type TransformSelection =
  | { kind: 'group'; referenceId: string; position: InkVector3; rotation: 0 | 90 | 180 | 270 }
  | { kind: 'shape'; referenceId: string; shape: InkShape };

type PendingTransform =
  | { kind: 'group'; referenceId: string; position: InkVector3; rotation: 0 | 90 | 180 | 270 }
  | { kind: 'shape'; referenceId: string; shape: InkShape };

type DimensionDrag = {
  pointerId: number;
  referenceId: string;
  axis: 'x' | 'y' | 'z';
  startParameter: number;
  startShape: Extract<InkShape, { kind: 'cuboid' | 'sphere' }>;
  currentShape: Extract<InkShape, { kind: 'cuboid' | 'sphere' }>;
  worldOrigin: Vector3;
  worldAxis: Vector3;
};

export type PencilTransformControllerOptions = {
  renderer: WorkspaceRenderer;
  store: WorkspaceStore;
  getSession: () => StudioEditorSession;
};

/** Painting-style TransformControls plus intrinsic Cuboid/Sphere size handles. */
export class PencilTransformController {
  private readonly proxy = new Object3D();
  private readonly controls: TransformControls;
  private readonly helper: Object3D;
  private readonly dimensionRoot = new Group();
  private readonly dimensionPickers: Mesh[] = [];
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private selection: TransformSelection | null = null;
  private pendingTransform: PendingTransform | null = null;
  private dimensionDrag: DimensionDrag | null = null;
  private claimedPointerId: number | null = null;
  private transformPointerCandidate: number | null = null;
  private visible = false;
  private disposed = false;

  constructor(private readonly options: PencilTransformControllerOptions) {
    const { renderer } = options;
    renderer.scene.add(this.proxy);
    this.controls = new TransformControls(renderer.camera, renderer.canvas);
    this.helper = this.controls.getHelper();
    removeNegativeAxisCones(this.helper);
    this.controls.setSpace('world');
    this.controls.setSize(0.85);
    this.controls.attach(this.proxy);
    renderer.scene.add(this.helper, this.dimensionRoot);
    this.dimensionRoot.name = 'InkIntrinsicSizeHandles';
    this.controls.addEventListener('objectChange', this.handleObjectChange);
    this.controls.addEventListener('dragging-changed', this.handleDraggingChanged);
    renderer.canvas.addEventListener('pointerdown', this.gateTransformPointer, { capture: true });
    renderer.canvas.addEventListener('pointermove', this.gateTransformPointer, { capture: true });
    renderer.canvas.addEventListener('pointerdown', this.handleDimensionPointerDown, { capture: true });
    renderer.canvas.addEventListener('pointermove', this.handleDimensionPointerMove, { capture: true });
    renderer.canvas.addEventListener('pointerup', this.handleDimensionPointerUp, { capture: true });
    renderer.canvas.addEventListener('pointercancel', this.handleDimensionPointerCancel, { capture: true });
    // Registered after TransformControls so its pointerdown has already
    // decided whether a Pencil hit a generic handle.
    renderer.canvas.addEventListener('pointerdown', this.captureTransformClaim);
    renderer.canvas.addEventListener('pointerup', this.releaseTransformClaim);
    renderer.canvas.addEventListener('pointercancel', this.releaseTransformClaim);
    renderer.controls.addEventListener('change', this.handleCameraChange);
    window.addEventListener('blur', this.cancelActiveInteraction);
    this.setVisible(false);
  }

  isPointerClaimed(pointerId: number): boolean {
    return this.claimedPointerId === pointerId
      || this.dimensionDrag?.pointerId === pointerId
      || (this.controls.dragging && this.transformPointerCandidate === pointerId);
  }

  sync(document: InkStudioWorkFile, session: StudioEditorSession): void {
    if (this.disposed || this.controls.dragging || this.dimensionDrag) return;
    this.selection = getTransformSelection(document, session);
    if (!this.selection) {
      this.setVisible(false);
      return;
    }
    this.setVisible(true);
    this.controls.setMode(session.transformMode);
    this.controls.setTranslationSnap(session.snapEnabled ? session.transformSnapUnit : null);
    this.controls.setRotationSnap(this.selection.kind === 'group' ? Math.PI / 2 : null);
    this.controls.showX = this.selection.kind === 'shape' || session.transformMode === 'translate';
    this.controls.showY = true;
    this.controls.showZ = this.selection.kind === 'shape' || session.transformMode === 'translate';
    if (this.selection.kind === 'group') {
      this.proxy.position.set(this.selection.position.x, this.selection.position.y, this.selection.position.z);
      this.proxy.rotation.set(0, this.selection.rotation * Math.PI / 180, 0, 'YXZ');
      this.clearDimensionHandles();
    } else {
      const world = shapeWorldTransform(document, this.selection.referenceId, this.selection.shape);
      this.proxy.position.copy(world.position);
      this.proxy.quaternion.copy(world.quaternion);
      this.refreshDimensionHandles(document, this.selection.referenceId, this.selection.shape);
    }
    this.proxy.updateMatrixWorld(true);
    this.options.renderer.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActiveInteraction();
    const canvas = this.options.renderer.canvas;
    this.controls.removeEventListener('objectChange', this.handleObjectChange);
    this.controls.removeEventListener('dragging-changed', this.handleDraggingChanged);
    canvas.removeEventListener('pointerdown', this.gateTransformPointer, { capture: true });
    canvas.removeEventListener('pointermove', this.gateTransformPointer, { capture: true });
    canvas.removeEventListener('pointerdown', this.handleDimensionPointerDown, { capture: true });
    canvas.removeEventListener('pointermove', this.handleDimensionPointerMove, { capture: true });
    canvas.removeEventListener('pointerup', this.handleDimensionPointerUp, { capture: true });
    canvas.removeEventListener('pointercancel', this.handleDimensionPointerCancel, { capture: true });
    canvas.removeEventListener('pointerdown', this.captureTransformClaim);
    canvas.removeEventListener('pointerup', this.releaseTransformClaim);
    canvas.removeEventListener('pointercancel', this.releaseTransformClaim);
    this.options.renderer.controls.removeEventListener('change', this.handleCameraChange);
    window.removeEventListener('blur', this.cancelActiveInteraction);
    this.controls.detach();
    this.controls.dispose();
    this.helper.removeFromParent();
    this.proxy.removeFromParent();
    this.clearDimensionHandles();
    this.dimensionRoot.removeFromParent();
  }

  private readonly gateTransformPointer = (event: PointerEvent): void => {
    if (this.controls.dragging) return;
    const allow = this.visible && isApplePencilPointer(event);
    this.controls.enabled = allow;
    if (event.type === 'pointerdown') this.transformPointerCandidate = allow ? event.pointerId : null;
  };

  private readonly captureTransformClaim = (event: PointerEvent): void => {
    if (!isApplePencilPointer(event) || !this.controls.dragging) return;
    this.claimedPointerId = event.pointerId;
    event.preventDefault();
  };

  private readonly releaseTransformClaim = (event: PointerEvent): void => {
    if (event.pointerId === this.claimedPointerId) this.claimedPointerId = null;
    if (event.pointerId === this.transformPointerCandidate) this.transformPointerCandidate = null;
  };

  private readonly handleDraggingChanged = (event: { value: unknown }): void => {
    if (event.value === true) {
      this.pendingTransform = this.selection ? clonePendingTransform(this.selection) : null;
      return;
    }
    const pending = this.pendingTransform;
    this.pendingTransform = null;
    if (!pending) return;
    if (pending.kind === 'group') {
      this.options.store.transact(
        this.options.getSession().transformMode === 'rotate' ? 'Rotate Ink Group' : 'Move Ink Group',
        (document) => updateInkReference(document, pending.referenceId, {
          anchorPosition: pending.position,
          rotation: pending.rotation,
        }),
      );
    } else {
      this.options.store.transact(
        this.options.getSession().transformMode === 'rotate' ? 'Rotate Ink Shape' : 'Move Ink Shape',
        (document) => updateInkShapeAuthor(document, pending.referenceId, pending.shape.id, () => pending.shape),
      );
    }
  };

  private readonly handleObjectChange = (): void => {
    const selection = this.selection;
    if (!selection) return;
    const document = this.options.store.getDocument();
    if (selection.kind === 'group') {
      const rotation = normalizeGroupRotation(this.proxy.rotation.y * 180 / Math.PI);
      const position = { x: this.proxy.position.x, y: this.proxy.position.y, z: this.proxy.position.z };
      this.pendingTransform = { kind: 'group', referenceId: selection.referenceId, position, rotation };
      this.options.renderer.previewGroupTransform(selection.referenceId, position, rotation);
      return;
    }
    const reference = getInkReference(document, selection.referenceId);
    if (!reference) return;
    const shape = shapeFromWorldTransform(selection.shape, reference.anchorPosition, reference.rotation, this.proxy.position, this.proxy.quaternion);
    this.pendingTransform = { kind: 'shape', referenceId: selection.referenceId, shape };
    this.options.renderer.previewShapeTransform(selection.referenceId, shape);
    this.refreshDimensionHandles(document, selection.referenceId, shape);
  };

  private readonly handleDimensionPointerDown = (event: PointerEvent): void => {
    if (!isApplePencilPointer(event) || event.button !== 0 || !this.visible || this.dimensionPickers.length === 0) return;
    const hit = this.pickDimensionHandle(event.clientX, event.clientY);
    const selection = this.selection;
    if (!hit || selection?.kind !== 'shape' || selection.shape.kind === 'plane') return;
    const worldOrigin = this.dimensionRoot.getWorldPosition(new Vector3());
    const worldAxis = axisVector(hit.axis).applyQuaternion(this.dimensionRoot.getWorldQuaternion(new Quaternion())).normalize();
    const parameter = closestRayLineParameter(this.raycaster.ray.origin, this.raycaster.ray.direction, worldOrigin, worldAxis);
    this.dimensionDrag = {
      pointerId: event.pointerId,
      referenceId: selection.referenceId,
      axis: hit.axis,
      startParameter: parameter,
      startShape: cloneIntrinsicShape(selection.shape),
      currentShape: cloneIntrinsicShape(selection.shape),
      worldOrigin,
      worldAxis,
    };
    this.claimedPointerId = event.pointerId;
    this.controls.enabled = false;
    this.options.renderer.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly handleDimensionPointerMove = (event: PointerEvent): void => {
    const drag = this.dimensionDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.setRay(event.clientX, event.clientY);
    const parameter = closestRayLineParameter(this.raycaster.ray.origin, this.raycaster.ray.direction, drag.worldOrigin, drag.worldAxis);
    const delta = parameter - drag.startParameter;
    if (drag.startShape.kind === 'cuboid') {
      drag.currentShape = {
        ...drag.startShape,
        size: {
          ...drag.startShape.size,
          [drag.axis]: Math.max(0.05, drag.startShape.size[drag.axis] + delta * 2),
        },
      };
    } else {
      drag.currentShape = { ...drag.startShape, radius: Math.max(0.05, drag.startShape.radius + delta) };
    }
    this.options.renderer.previewShapeTransform(drag.referenceId, drag.currentShape);
    this.refreshDimensionHandles(this.options.store.getDocument(), drag.referenceId, drag.currentShape);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly handleDimensionPointerUp = (event: PointerEvent): void => {
    const drag = this.dimensionDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.dimensionDrag = null;
    this.claimedPointerId = null;
    if (this.options.renderer.canvas.hasPointerCapture(event.pointerId)) this.options.renderer.canvas.releasePointerCapture(event.pointerId);
    const label = drag.currentShape.kind === 'cuboid' ? 'Resize Ink Cuboid' : 'Resize Ink Sphere';
    this.options.store.transact(label, (document) => updateInkShapeAuthor(document, drag.referenceId, drag.currentShape.id, () => drag.currentShape));
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly handleDimensionPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.dimensionDrag?.pointerId) return;
    this.cancelDimensionDrag();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly handleCameraChange = (): void => {
    const selection = this.selection;
    if (selection?.kind === 'shape') this.refreshDimensionHandles(this.options.store.getDocument(), selection.referenceId, this.dimensionDrag?.currentShape ?? selection.shape);
  };

  private pickDimensionHandle(clientX: number, clientY: number): { axis: 'x' | 'y' | 'z' } | null {
    this.setRay(clientX, clientY);
    const intersection = this.raycaster.intersectObjects(this.dimensionPickers, false)[0];
    const axis = intersection?.object.userData.dimensionAxis as 'x' | 'y' | 'z' | undefined;
    return axis ? { axis } : null;
  }

  private setRay(clientX: number, clientY: number): void {
    const bounds = this.options.renderer.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.options.renderer.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pointer, this.options.renderer.camera);
  }

  private refreshDimensionHandles(document: InkStudioWorkFile, referenceId: string, shape: InkShape): void {
    this.clearDimensionHandles();
    if (shape.kind === 'plane' || this.options.getSession().mode !== 'shape') return;
    const world = shapeWorldTransform(document, referenceId, shape);
    this.dimensionRoot.position.copy(world.position);
    this.dimensionRoot.quaternion.copy(world.quaternion);
    const distance = this.options.renderer.camera.position.distanceTo(world.position);
    const handleSize = Math.min(0.22, Math.max(0.07, distance * 0.018));
    const axes: Array<'x' | 'y' | 'z'> = shape.kind === 'cuboid' ? ['x', 'y', 'z'] : ['x'];
    for (const axis of axes) {
      const extent = shape.kind === 'cuboid' ? shape.size[axis] * 0.5 : shape.radius;
      const length = extent + handleSize * 1.6;
      const color = axis === 'x' ? 0xff5b5b : axis === 'y' ? 0x63d47a : 0x5b8dff;
      const line = new Mesh(
        new BoxGeometry(1, 1, 1),
        new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 }),
      );
      line.position.copy(axisVector(axis).multiplyScalar(length * 0.5));
      line.scale.set(
        axis === 'x' ? length : handleSize * 0.12,
        axis === 'y' ? length : handleSize * 0.12,
        axis === 'z' ? length : handleSize * 0.12,
      );
      line.renderOrder = 2100;
      const picker = new Mesh(
        new BoxGeometry(handleSize, handleSize, handleSize),
        new MeshBasicMaterial({ color: shape.kind === 'sphere' ? 0xf4d35e : color, depthTest: false, depthWrite: false }),
      );
      picker.position.copy(axisVector(axis).multiplyScalar(length));
      picker.userData.dimensionAxis = axis;
      picker.renderOrder = 2101;
      this.dimensionRoot.add(line, picker);
      this.dimensionPickers.push(picker);
    }
    this.dimensionRoot.visible = true;
    this.options.renderer.requestRender();
  }

  private clearDimensionHandles(): void {
    disposeObjectTree(this.dimensionRoot);
    this.dimensionRoot.clear();
    this.dimensionPickers.length = 0;
    this.dimensionRoot.visible = false;
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    this.helper.visible = visible;
    this.controls.enabled = false;
    if (!visible) this.clearDimensionHandles();
    this.options.renderer.requestRender();
  }

  private cancelDimensionDrag(): void {
    const drag = this.dimensionDrag;
    this.dimensionDrag = null;
    this.claimedPointerId = null;
    if (!drag) return;
    this.options.renderer.previewShapeTransform(drag.referenceId, drag.startShape);
    if (this.options.renderer.canvas.hasPointerCapture(drag.pointerId)) this.options.renderer.canvas.releasePointerCapture(drag.pointerId);
    this.refreshDimensionHandles(this.options.store.getDocument(), drag.referenceId, drag.startShape);
  }

  private readonly cancelActiveInteraction = (): void => {
    this.cancelDimensionDrag();
    this.claimedPointerId = null;
    this.transformPointerCandidate = null;
  };
}

function getTransformSelection(document: InkStudioWorkFile, session: StudioEditorSession): TransformSelection | null {
  if (!session.activeReferenceId) return null;
  const reference = getInkReference(document, session.activeReferenceId);
  if (!reference) return null;
  if (session.mode === 'select') {
    return {
      kind: 'group',
      referenceId: reference.id,
      position: { ...reference.anchorPosition },
      rotation: reference.rotation,
    };
  }
  if (session.mode !== 'shape' || !session.activeShapeId) return null;
  const shape = getInkSourceByReference(document, reference.id)?.shapes.find((entry) => entry.id === session.activeShapeId);
  return shape ? { kind: 'shape', referenceId: reference.id, shape } : null;
}

function clonePendingTransform(selection: TransformSelection): PendingTransform {
  if (selection.kind === 'group') return { ...selection, position: { ...selection.position } };
  return { kind: 'shape', referenceId: selection.referenceId, shape: cloneShapeTransform(selection.shape) };
}

function cloneShapeTransform(shape: InkShape): InkShape {
  if (shape.kind === 'cuboid') return { ...shape, position: { ...shape.position }, rotation: { ...shape.rotation }, size: { ...shape.size } };
  if (shape.kind === 'sphere') return { ...shape, position: { ...shape.position }, rotation: { ...shape.rotation } };
  return { ...shape, position: { ...shape.position }, rotation: { ...shape.rotation } };
}

function cloneIntrinsicShape(shape: Extract<InkShape, { kind: 'cuboid' | 'sphere' }>): Extract<InkShape, { kind: 'cuboid' | 'sphere' }> {
  return cloneShapeTransform(shape) as Extract<InkShape, { kind: 'cuboid' | 'sphere' }>;
}

function shapeWorldTransform(document: InkStudioWorkFile, referenceId: string, shape: InkShape): { position: Vector3; quaternion: Quaternion } {
  const reference = getInkReference(document, referenceId);
  const groupQuaternion = new Quaternion().setFromEuler(new Euler(0, (reference?.rotation ?? 0) * Math.PI / 180, 0, 'YXZ'));
  const position = new Vector3(shape.position.x, shape.position.y, shape.position.z)
    .applyQuaternion(groupQuaternion)
    .add(new Vector3(reference?.anchorPosition.x ?? 0, reference?.anchorPosition.y ?? 0, reference?.anchorPosition.z ?? 0));
  const shapeQuaternion = new Quaternion().setFromEuler(new Euler(shape.rotation.x, shape.rotation.y, shape.rotation.z, 'YXZ'));
  return { position, quaternion: groupQuaternion.clone().multiply(shapeQuaternion) };
}

function shapeFromWorldTransform(
  shape: InkShape,
  anchor: InkVector3,
  groupRotationDegrees: number,
  worldPosition: Vector3,
  worldQuaternion: Quaternion,
): InkShape {
  const groupQuaternion = new Quaternion().setFromEuler(new Euler(0, groupRotationDegrees * Math.PI / 180, 0, 'YXZ'));
  const inverseGroup = groupQuaternion.clone().invert();
  const localPosition = worldPosition.clone().sub(new Vector3(anchor.x, anchor.y, anchor.z)).applyQuaternion(inverseGroup);
  const localEuler = new Euler().setFromQuaternion(inverseGroup.multiply(worldQuaternion), 'YXZ');
  return {
    ...shape,
    position: { x: localPosition.x, y: localPosition.y, z: localPosition.z },
    rotation: { x: localEuler.x, y: localEuler.y, z: localEuler.z },
  };
}

function normalizeGroupRotation(degrees: number): 0 | 90 | 180 | 270 {
  const normalized = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  return normalized as 0 | 90 | 180 | 270;
}

function axisVector(axis: 'x' | 'y' | 'z'): Vector3 {
  return new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
}

/** Parameter of the closest point on an infinite line to a camera ray. */
export function closestRayLineParameter(
  rayOrigin: Vector3,
  rayDirection: Vector3,
  lineOrigin: Vector3,
  lineDirection: Vector3,
): number {
  const offset = rayOrigin.clone().sub(lineOrigin);
  const rayDotLine = rayDirection.dot(lineDirection);
  const denominator = 1 - rayDotLine * rayDotLine;
  if (Math.abs(denominator) < 1e-6) return offset.dot(lineDirection);
  return (offset.dot(lineDirection) - offset.dot(rayDirection) * rayDotLine) / denominator;
}

function removeNegativeAxisCones(root: Object3D): void {
  const center = new Vector3();
  const negativeCones: Mesh[] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh) || object.geometry.type !== 'CylinderGeometry') return;
    const axis = object.name;
    if (axis !== 'X' && axis !== 'Y' && axis !== 'Z') return;
    object.geometry.computeBoundingBox();
    object.geometry.boundingBox?.getCenter(center);
    const coordinate = axis === 'X' ? center.x : axis === 'Y' ? center.y : center.z;
    if (coordinate < 0) negativeCones.push(object);
  });
  for (const cone of negativeCones) {
    cone.parent?.remove(cone);
    cone.geometry.dispose();
  }
}
