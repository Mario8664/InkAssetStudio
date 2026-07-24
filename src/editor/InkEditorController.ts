import { Vector3 } from 'three';
import {
  bucketFillInkShape,
  createInkOutlineStroke,
  paintInkFill,
  sampleInkFillColor,
  type InkCuboidStrokePoint,
  type InkOutlineStroke,
  type InkShape,
  type InkSurfacePoint,
} from '../domain/ink/ink';
import type { StudioEditorSession } from '../domain/workspace/session';
import {
  getInkReference,
  updateInkReference,
  updateInkShape,
  updateInkShapeAuthor,
} from '../domain/workspace/workspace';
import { compareTiles, createTerrainTile, tileKey } from '../domain/terrain/terrain';
import type { WorkspaceStore } from '../domain/workspace/WorkspaceStore';
import type { InkSurfaceHit } from '../render/WorkspaceRenderer';
import { WorkspaceRenderer } from '../render/WorkspaceRenderer';

type PendingInkSegment = {
  referenceId: string;
  shapeId: string;
  shape: InkShape;
  points: InkSurfacePoint[];
  lastScreenX: number;
  lastScreenY: number;
  lastTimestamp: number;
};

type PendingTransform =
  | {
      kind: 'group';
      referenceId: string;
      startAnchor: { x: number; y: number; z: number };
      startPlanePoint: Vector3;
      currentAnchor: { x: number; y: number; z: number };
    }
  | {
      kind: 'shape';
      referenceId: string;
      shapeId: string;
      groupRotation: number;
      startPosition: { x: number; y: number; z: number };
      startRotation: { x: number; y: number; z: number };
      startPlanePoint: Vector3;
      startClientX: number;
      currentPosition: { x: number; y: number; z: number };
      currentRotation: { x: number; y: number; z: number };
    };

const STABILIZER_FOLLOW_AT_MIN_SPEED = 0.06;
const STABILIZER_FOLLOW_AT_MAX_SPEED = 0.9;
const STABILIZER_MAX_SPEED_PIXELS_PER_MILLISECOND = 0.85;
const STABILIZER_REFERENCE_INTERVAL_MILLISECONDS = 1000 / 60;

export type InkEditorControllerOptions = {
  renderer: WorkspaceRenderer;
  store: WorkspaceStore;
  getSession: () => StudioEditorSession;
  updateSession: (update: Partial<StudioEditorSession>) => void;
  showMessage: (message: string, tone?: 'info' | 'error') => void;
};

export class InkEditorController {
  private pointerId: number | null = null;
  private pendingInk: PendingInkSegment[] = [];
  private pendingTerrainCells = new Map<string, { x: number; y: number; z: number }>();
  private usesRawPointerUpdates = false;
  private previewFrame: number | null = null;
  private hasDocumentPreview = false;
  private pendingTransform: PendingTransform | null = null;

  constructor(private readonly options: InkEditorControllerOptions) {
    const canvas = options.renderer.canvas;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerrawupdate', this.handlePointerRawUpdate);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerCancel);
    canvas.addEventListener('lostpointercapture', this.handleLostCapture);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
    window.addEventListener('blur', this.cancelGesture);
  }

  dispose(): void {
    this.cancelGesture();
    const canvas = this.options.renderer.canvas;
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerrawupdate', this.handlePointerRawUpdate);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    canvas.removeEventListener('lostpointercapture', this.handleLostCapture);
    canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    window.removeEventListener('blur', this.cancelGesture);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.pointerId !== null) return;
    const session = this.options.getSession();
    if (session.mode === 'navigate') return;
    if (session.mode === 'terrain') {
      const cell = this.options.renderer.pickTerrainCell(event.clientX, event.clientY, session.terrainLayer);
      if (!cell) return;
      this.beginGesture(event);
      this.pendingTerrainCells.set(tileKey(cell), cell);
      event.preventDefault();
      return;
    }
    if (session.mode === 'select') {
      const hit = this.options.renderer.pickGroup(event.clientX, event.clientY);
      if (hit) {
        if (hit.referenceId === session.activeReferenceId) this.beginGroupTransform(event, hit.referenceId);
        else this.options.updateSession({ activeReferenceId: hit.referenceId, activeShapeId: null });
      }
      event.preventDefault();
      return;
    }
    const pressure = resolvePointerPressure(event, session.pressureEnabled);
    const hit = this.options.renderer.pickInkSurface(event.clientX, event.clientY, pressure);
    if (!hit) return;
    if (session.activeShapeId !== hit.shapeId) this.options.updateSession({ activeShapeId: hit.shapeId });
    if (session.mode === 'shape') {
      if (hit.shapeId === session.activeShapeId) this.beginShapeTransform(event, hit);
      event.preventDefault();
      return;
    }
    if (session.drawTool === 'picker') {
      const color = sampleInkFillColor(hit.shape, hit.point);
      if (color) this.options.updateSession({ fillColor: color });
      else this.options.showMessage('The selected Ink pixel is transparent.');
      event.preventDefault();
      return;
    }
    if (session.drawTool === 'fill-bucket') {
      this.options.store.transact('Bucket fill', (document) => updateInkShapeAuthor(
        document,
        hit.referenceId,
        hit.shapeId,
        (shape) => bucketFillInkShape(shape, hit.point, session.fillColor),
      ));
      event.preventDefault();
      return;
    }
    this.beginGesture(event);
    this.appendInkHit(hit, event.clientX, event.clientY, event.timeStamp);
    this.updateStrokePreview();
    event.preventDefault();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const session = this.options.getSession();
    if (this.pointerId === null) {
      if (session.mode === 'draw') this.updateCursor(event);
      return;
    }
    if (event.pointerId !== this.pointerId) return;
    if (this.pendingTransform) { this.updateTransform(event); return; }
    if (this.usesRawPointerUpdates && session.mode === 'draw') return;
    this.appendEventSamples(event);
  };

  private readonly handlePointerRawUpdate = (event: Event): void => {
    if (!(event instanceof PointerEvent) || event.pointerId !== this.pointerId || !this.usesRawPointerUpdates) return;
    this.appendEventSamples(event, false);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.appendEventSamples(event);
    const session = this.options.getSession();
    if (this.pendingTransform) this.commitTransform();
    else if (session.mode === 'terrain') this.commitTerrain(session);
    else if (session.mode === 'draw') this.commitInk(session);
    this.endGesture();
    event.preventDefault();
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId) this.cancelGesture();
  };

  private readonly handleLostCapture = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId) this.cancelGesture();
  };

  private readonly handlePointerLeave = (): void => {
    if (this.pointerId === null) this.options.renderer.hideCursor();
  };

  private beginGesture(event: PointerEvent): void {
    this.pointerId = event.pointerId;
    this.pendingInk = [];
    this.pendingTerrainCells.clear();
    this.usesRawPointerUpdates = event.pointerType === 'pen' && 'onpointerrawupdate' in window;
    this.options.renderer.canvas.setPointerCapture(event.pointerId);
  }

  private beginGroupTransform(event: PointerEvent, referenceId: string): void {
    const reference = getInkReference(this.options.store.getDocument(), referenceId);
    if (!reference) return;
    const point = this.options.renderer.pickHorizontalPlane(event.clientX, event.clientY, reference.anchorPosition.y);
    if (!point) return;
    this.beginGesture(event);
    this.options.renderer.controls.enabled = false;
    this.pendingTransform = {
      kind: 'group',
      referenceId,
      startAnchor: { ...reference.anchorPosition },
      startPlanePoint: point,
      currentAnchor: { ...reference.anchorPosition },
    };
  }

  private beginShapeTransform(event: PointerEvent, hit: InkSurfaceHit): void {
    const reference = getInkReference(this.options.store.getDocument(), hit.referenceId);
    if (!reference) return;
    const point = this.options.renderer.pickHorizontalPlane(event.clientX, event.clientY, hit.world.y);
    if (!point) return;
    this.beginGesture(event);
    this.options.renderer.controls.enabled = false;
    this.pendingTransform = {
      kind: 'shape',
      referenceId: hit.referenceId,
      shapeId: hit.shapeId,
      groupRotation: reference.rotation,
      startPosition: { ...hit.shape.position },
      startRotation: { ...hit.shape.rotation },
      startPlanePoint: point,
      startClientX: event.clientX,
      currentPosition: { ...hit.shape.position },
      currentRotation: { ...hit.shape.rotation },
    };
  }

  private updateTransform(event: PointerEvent): void {
    const transform = this.pendingTransform;
    if (!transform) return;
    let preview = this.options.store.getDocument();
    if (transform.kind === 'group') {
      const point = this.options.renderer.pickHorizontalPlane(event.clientX, event.clientY, transform.startAnchor.y);
      if (!point) return;
      transform.currentAnchor = {
        x: transform.startAnchor.x + point.x - transform.startPlanePoint.x,
        y: transform.startAnchor.y,
        z: transform.startAnchor.z + point.z - transform.startPlanePoint.z,
      };
      preview = updateInkReference(preview, transform.referenceId, { anchorPosition: transform.currentAnchor });
    } else if (this.options.getSession().transformMode === 'rotate') {
      transform.currentRotation = {
        ...transform.startRotation,
        y: transform.startRotation.y + (event.clientX - transform.startClientX) * 0.01,
      };
      preview = updateInkShape(preview, transform.referenceId, transform.shapeId, (shape) => ({ ...shape, rotation: { ...transform.currentRotation } }));
    } else {
      const worldY = transform.startPlanePoint.y;
      const point = this.options.renderer.pickHorizontalPlane(event.clientX, event.clientY, worldY);
      if (!point) return;
      const worldDelta = point.clone().sub(transform.startPlanePoint);
      const radians = -transform.groupRotation * Math.PI / 180;
      const localX = Math.cos(radians) * worldDelta.x + Math.sin(radians) * worldDelta.z;
      const localZ = -Math.sin(radians) * worldDelta.x + Math.cos(radians) * worldDelta.z;
      transform.currentPosition = {
        x: transform.startPosition.x + localX,
        y: transform.startPosition.y,
        z: transform.startPosition.z + localZ,
      };
      preview = updateInkShape(preview, transform.referenceId, transform.shapeId, (shape) => ({ ...shape, position: { ...transform.currentPosition } }));
    }
    this.hasDocumentPreview = true;
    this.options.renderer.update(preview, this.options.getSession());
    event.preventDefault();
  }

  private commitTransform(): void {
    const transform = this.pendingTransform;
    if (!transform) return;
    if (transform.kind === 'group') {
      this.options.store.transact('Move Ink Group', (document) => updateInkReference(document, transform.referenceId, { anchorPosition: transform.currentAnchor }));
    } else if (this.options.getSession().transformMode === 'rotate') {
      this.options.store.transact('Rotate Ink Shape', (document) => updateInkShapeAuthor(document, transform.referenceId, transform.shapeId, (shape) => ({ ...shape, rotation: { ...transform.currentRotation } })));
    } else {
      this.options.store.transact('Move Ink Shape', (document) => updateInkShapeAuthor(document, transform.referenceId, transform.shapeId, (shape) => ({ ...shape, position: { ...transform.currentPosition } })));
    }
  }

  private appendEventSamples(event: PointerEvent, includeCoalesced = true): void {
    const session = this.options.getSession();
    if (session.mode === 'terrain') {
      const cell = this.options.renderer.pickTerrainCell(event.clientX, event.clientY, session.terrainLayer);
      if (cell) this.pendingTerrainCells.set(tileKey(cell), cell);
      return;
    }
    if (session.mode !== 'draw') return;
    const samples = includeCoalesced ? event.getCoalescedEvents?.() ?? [event] : [event];
    for (const sample of samples.length > 0 ? samples : [event]) {
      const hit = this.options.renderer.pickInkSurface(
        sample.clientX,
        sample.clientY,
        resolvePointerPressure(sample, session.pressureEnabled),
      );
      if (hit) this.appendInkHit(hit, sample.clientX, sample.clientY, sample.timeStamp);
    }
    this.updateStrokePreview();
    this.scheduleDocumentPreview();
  }

  private appendInkHit(hit: InkSurfaceHit, screenX: number, screenY: number, timestamp: number): void {
    let segment = this.pendingInk.at(-1);
    if (!segment || segment.referenceId !== hit.referenceId || segment.shapeId !== hit.shapeId) {
      segment = { referenceId: hit.referenceId, shapeId: hit.shapeId, shape: hit.shape, points: [], lastScreenX: screenX, lastScreenY: screenY, lastTimestamp: timestamp };
      this.pendingInk.push(segment);
    }
    const prior = segment.points.at(-1);
    const screenDistance = Math.hypot(screenX - segment.lastScreenX, screenY - segment.lastScreenY);
    if (prior && screenDistance <= 0.0001) return;
    const point = prior ? stabilizeInkPoint(segment.shape, prior, hit.point, screenDistance, timestamp - segment.lastTimestamp) : hit.point;
    if (prior && sameSurfacePoint(prior, point)) return;
    segment.points.push({ ...point });
    segment.lastScreenX = screenX;
    segment.lastScreenY = screenY;
    segment.lastTimestamp = timestamp;
    const session = this.options.getSession();
    this.options.renderer.showCursor(hit, getToolRadius(session), session.fillBrushShape === 'square' && isFillTool(session.drawTool));
  }

  private updateStrokePreview(): void {
    const session = this.options.getSession();
    if (session.drawTool !== 'outline') { this.options.renderer.clearStrokePreview(); return; }
    const segment = this.pendingInk.at(-1);
    if (!segment) return;
    const points = getOutlineCommitPoints(segment.shape, segment.points, session.straightLineEnabled);
    this.options.renderer.showStrokePreview(segment.referenceId, segment.shape, points, session.outlineColor, session.outlineWidth);
  }

  private scheduleDocumentPreview(): void {
    const tool = this.options.getSession().drawTool;
    if (tool === 'outline' || tool === 'fill-bucket' || tool === 'picker' || this.previewFrame !== null) return;
    this.previewFrame = window.requestAnimationFrame(() => {
      this.previewFrame = null;
      const session = this.options.getSession();
      let preview = this.options.store.getDocument();
      for (const segment of this.pendingInk) {
        if (segment.points.length === 0) continue;
        preview = updateInkShape(preview, segment.referenceId, segment.shapeId, (shape) => applyInkTool(shape, segment.points, session));
      }
      this.hasDocumentPreview = preview !== this.options.store.getDocument();
      if (this.hasDocumentPreview) this.options.renderer.update(preview, session);
    });
  }

  private updateCursor(event: PointerEvent): void {
    const session = this.options.getSession();
    const hit = this.options.renderer.pickInkSurface(event.clientX, event.clientY, resolvePointerPressure(event, session.pressureEnabled));
    if (hit) this.options.renderer.showCursor(hit, getToolRadius(session), session.fillBrushShape === 'square' && isFillTool(session.drawTool));
    else this.options.renderer.hideCursor();
  }

  private commitInk(session: StudioEditorSession): void {
    if (this.pendingInk.length === 0) return;
    const label = getInkHistoryLabel(session.drawTool);
    this.options.store.transact(label, (document) => {
      let next = document;
      for (const segment of this.pendingInk) {
        if (segment.points.length === 0) continue;
        next = updateInkShapeAuthor(next, segment.referenceId, segment.shapeId, (shape) => applyInkTool(shape, segment.points, session));
      }
      return next;
    });
  }

  private commitTerrain(session: StudioEditorSession): void {
    if (this.pendingTerrainCells.size === 0) return;
    this.options.store.transact(session.terrainAction === 'place' ? 'Place terrain' : 'Erase terrain', (document) => {
      const changes = new Map(this.pendingTerrainCells);
      const retained = document.terrain.tiles.filter((tile) => !changes.has(tileKey(tile)));
      const additions = session.terrainAction === 'place'
        ? [...changes.values()].map((cell) => createTerrainTile(session.terrainKind, session.terrainRotation, cell.x, cell.y, cell.z, session.terrainColor))
        : [];
      return { ...document, terrain: { tiles: [...retained, ...additions].sort(compareTiles) } };
    });
  }

  private endGesture(): void {
    const pointerId = this.pointerId;
    this.pointerId = null;
    this.pendingInk = [];
    this.pendingTerrainCells.clear();
    this.pendingTransform = null;
    this.usesRawPointerUpdates = false;
    if (this.previewFrame !== null) window.cancelAnimationFrame(this.previewFrame);
    this.previewFrame = null;
    this.options.renderer.clearStrokePreview();
    if (this.hasDocumentPreview) {
      this.hasDocumentPreview = false;
      this.options.renderer.update(this.options.store.getDocument(), this.options.getSession());
    }
    if (pointerId !== null && this.options.renderer.canvas.hasPointerCapture(pointerId)) {
      this.options.renderer.canvas.releasePointerCapture(pointerId);
    }
    this.options.renderer.controls.enabled = this.options.getSession().mode === 'navigate';
  }

  private readonly cancelGesture = (): void => {
    this.endGesture();
    this.options.renderer.hideCursor();
  };
}

export function resolvePointerPressure(event: Pick<PointerEvent, 'pointerType' | 'pressure'>, enabled: boolean): number {
  if (!enabled || event.pointerType !== 'pen' || !Number.isFinite(event.pressure) || event.pressure <= 0) return 1;
  return Math.min(1, Math.max(0.05, event.pressure));
}

export function eraseInkOutline(shape: InkShape, eraserPoints: readonly InkSurfacePoint[], width: number): InkShape {
  if (eraserPoints.length === 0 || shape.strokes.length === 0) return shape;
  const radius = Math.max(0.001, width * 0.5);
  let changed = false;
  const strokes: InkOutlineStroke[] = [];
  for (const stroke of shape.strokes) {
    let segment: InkSurfacePoint[] = [];
    let part = 0;
    const flush = (): void => {
      if (segment.length >= 2) strokes.push({ ...stroke, id: part === 0 ? stroke.id : `ink-stroke-${crypto.randomUUID()}`, points: segment });
      segment = [];
      part += 1;
    };
    for (const point of stroke.points) {
      const covered = surfaceDistanceToPath(shape, point, eraserPoints) <= radius;
      if (covered) { changed = true; flush(); }
      else segment.push({ ...point });
    }
    flush();
  }
  return changed ? { ...shape, strokes } : shape;
}

function applyInkTool(shape: InkShape, points: readonly InkSurfacePoint[], session: StudioEditorSession): InkShape {
  if (session.drawTool === 'outline') {
    const commitPoints = getOutlineCommitPoints(shape, points, session.straightLineEnabled);
    const last = points.at(-1);
    const stroke = commitPoints.length >= 2 ? createInkOutlineStroke(commitPoints, session.outlineColor, session.outlineWidth) : null;
    const next = stroke ? { ...shape, strokes: [...shape.strokes, stroke] } : shape;
    if (!last) return next;
    if (next.kind === 'plane' && isPlanePoint(last)) return { ...next, lastOutlineEnd: { x: last.x, y: last.y } };
    if (next.kind === 'cuboid' && isCuboidPoint(last)) return { ...next, lastOutlineEnd: { ...last } };
    return next;
  }
  if (session.drawTool === 'outline-eraser') return eraseInkOutline(shape, points, session.outlineEraserWidth);
  if (session.drawTool === 'fill-brush') return paintInkFill(shape, points, session.fillColor, session.fillBrushSize, session.fillBrushShape, false);
  if (session.drawTool === 'fill-eraser') return paintInkFill(shape, points, session.fillColor, session.fillBrushSize, session.fillBrushShape, true);
  return shape;
}

function getOutlineCommitPoints(shape: InkShape, points: readonly InkSurfacePoint[], straight: boolean): InkSurfacePoint[] {
  if (!straight || points.length === 0) return points.map((point) => ({ ...point }));
  const end = points.at(-1)!;
  if (shape.kind === 'plane' && isPlanePoint(end) && shape.lastOutlineEnd) {
    return [{ ...shape.lastOutlineEnd, pressure: 1 }, { ...end }];
  }
  if (shape.kind === 'cuboid' && isCuboidPoint(end) && shape.lastOutlineEnd?.face === end.face) {
    return [{ ...shape.lastOutlineEnd }, { ...end }];
  }
  return [{ ...end }];
}

function surfaceDistanceToPath(shape: InkShape, point: InkSurfacePoint, path: readonly InkSurfacePoint[]): number {
  if (path.length === 0) return Infinity;
  const target = surfaceVector(shape, point);
  const vectors = path.map((entry) => surfaceVector(shape, entry)).filter((entry): entry is Vector3 => entry !== null);
  if (!target || vectors.length === 0) return Infinity;
  let minimum = target.distanceTo(vectors[0]!);
  for (let index = 1; index < vectors.length; index += 1) minimum = Math.min(minimum, distanceToSegment(target, vectors[index - 1]!, vectors[index]!));
  return minimum;
}

function surfaceVector(shape: InkShape, point: InkSurfacePoint): Vector3 | null {
  if (shape.kind === 'plane' && isPlanePoint(point)) return new Vector3(point.x, point.y, 0);
  if (shape.kind === 'cuboid' && isCuboidPoint(point)) return cuboidPoint(shape, point);
  if (shape.kind === 'sphere' && isSpherePoint(point)) return new Vector3(point.x, point.y, point.z).normalize().multiplyScalar(shape.radius);
  return null;
}

function distanceToSegment(point: Vector3, start: Vector3, end: Vector3): number {
  const segment = end.clone().sub(start);
  const lengthSquared = segment.lengthSq();
  if (lengthSquared <= 1e-12) return point.distanceTo(start);
  const factor = Math.min(1, Math.max(0, point.clone().sub(start).dot(segment) / lengthSquared));
  return point.distanceTo(start.clone().addScaledVector(segment, factor));
}

function stabilizeInkPoint(
  shape: InkShape,
  previous: InkSurfacePoint,
  raw: InkSurfacePoint,
  screenDistance: number,
  elapsedRaw: number,
): InkSurfacePoint {
  const elapsed = Math.max(1, elapsedRaw);
  const speed = Math.min(1, screenDistance / elapsed / STABILIZER_MAX_SPEED_PIXELS_PER_MILLISECOND);
  const response = speed * speed * (3 - 2 * speed);
  const referenceFollow = STABILIZER_FOLLOW_AT_MIN_SPEED + (STABILIZER_FOLLOW_AT_MAX_SPEED - STABILIZER_FOLLOW_AT_MIN_SPEED) * response;
  const follow = 1 - (1 - referenceFollow) ** (elapsed / STABILIZER_REFERENCE_INTERVAL_MILLISECONDS);
  if (shape.kind === 'plane' && isPlanePoint(previous) && isPlanePoint(raw)) {
    return { x: previous.x + (raw.x - previous.x) * follow, y: previous.y + (raw.y - previous.y) * follow, pressure: previous.pressure + (raw.pressure - previous.pressure) * follow };
  }
  if (shape.kind === 'cuboid' && isCuboidPoint(previous) && isCuboidPoint(raw) && previous.face === raw.face) {
    return { face: raw.face, u: previous.u + (raw.u - previous.u) * follow, v: previous.v + (raw.v - previous.v) * follow, pressure: previous.pressure + (raw.pressure - previous.pressure) * follow };
  }
  if (shape.kind === 'sphere' && isSpherePoint(previous) && isSpherePoint(raw)) {
    const direction = new Vector3(previous.x, previous.y, previous.z).lerp(new Vector3(raw.x, raw.y, raw.z), follow).normalize();
    return { x: direction.x, y: direction.y, z: direction.z, pressure: previous.pressure + (raw.pressure - previous.pressure) * follow };
  }
  return raw;
}

function cuboidPoint(shape: Extract<InkShape, { kind: 'cuboid' }>, point: InkCuboidStrokePoint): Vector3 {
  if (point.face === 'positive-x') return new Vector3(shape.size.x * 0.5, point.v * shape.size.y, point.u * shape.size.z);
  if (point.face === 'negative-x') return new Vector3(-shape.size.x * 0.5, point.v * shape.size.y, -point.u * shape.size.z);
  if (point.face === 'positive-y') return new Vector3(point.u * shape.size.x, shape.size.y * 0.5, point.v * shape.size.z);
  if (point.face === 'negative-y') return new Vector3(point.u * shape.size.x, -shape.size.y * 0.5, -point.v * shape.size.z);
  if (point.face === 'positive-z') return new Vector3(point.u * shape.size.x, point.v * shape.size.y, shape.size.z * 0.5);
  return new Vector3(-point.u * shape.size.x, point.v * shape.size.y, -shape.size.z * 0.5);
}

function sameSurfacePoint(left: InkSurfacePoint, right: InkSurfacePoint): boolean {
  if (isCuboidPoint(left) && isCuboidPoint(right)) return left.face === right.face && Math.abs(left.u - right.u) < 1e-6 && Math.abs(left.v - right.v) < 1e-6;
  if (isSpherePoint(left) && isSpherePoint(right)) return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) < 1e-6;
  if (isPlanePoint(left) && isPlanePoint(right)) return Math.hypot(left.x - right.x, left.y - right.y) < 1e-6;
  return false;
}

function isPlanePoint(point: InkSurfacePoint): point is { x: number; y: number; pressure: number } { return 'x' in point && 'y' in point && !('z' in point); }
function isCuboidPoint(point: InkSurfacePoint): point is InkCuboidStrokePoint { return 'face' in point; }
function isSpherePoint(point: InkSurfacePoint): point is { x: number; y: number; z: number; pressure: number } { return 'x' in point && 'y' in point && 'z' in point; }
function isFillTool(tool: StudioEditorSession['drawTool']): boolean { return tool === 'fill-brush' || tool === 'fill-eraser' || tool === 'fill-bucket'; }

function getToolRadius(session: StudioEditorSession): number {
  if (session.drawTool === 'outline') return session.outlineWidth * 0.5;
  if (session.drawTool === 'outline-eraser') return session.outlineEraserWidth * 0.5;
  return session.fillBrushSize * 0.5;
}

function getInkHistoryLabel(tool: StudioEditorSession['drawTool']): string {
  if (tool === 'outline') return 'Draw outline';
  if (tool === 'outline-eraser') return 'Erase outline';
  if (tool === 'fill-brush') return 'Paint fill';
  if (tool === 'fill-eraser') return 'Erase fill';
  return 'Edit Ink';
}
