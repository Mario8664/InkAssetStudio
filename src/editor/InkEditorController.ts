import { Vector3 } from 'three';
import {
  appendInkFillBlurWorkPoints,
  blurInkFill,
  bucketFillInkShape,
  consumeInkFillBlurRgbaPatches,
  consumeInkFillWaterAlphaPatches,
  createInkFillBlurWork,
  createInkFillWaterStrokeState,
  createInkOutlineStroke,
  eraseInkFillWater,
  getInkFillBrushRadii,
  getInkCylinderSurfacePosition,
  getInkFrustumFacePosition,
  INK_FILL_PIXELS_PER_WORLD_UNIT,
  normalizeInkFillShape,
  paintInkFill,
  paintInkFillWater,
  processInkFillBlurWork,
  sampleInkFillColor,
  type InkCuboidStrokePoint,
  type InkCylinderStrokePoint,
  type InkFillWaterStrokeState,
  type InkFillBlurWork,
  type InkOutlineStroke,
  type InkShape,
  type InkSurfacePoint,
} from '../domain/ink/ink';
import type { StudioEditorSession } from '../domain/workspace/session';
import {
  updateInkShapeAuthor,
} from '../domain/workspace/workspace';
import type { WorkspaceStore } from '../domain/workspace/WorkspaceStore';
import type { InkSurfaceHit, InkStrokePreviewSegment } from '../render/WorkspaceRenderer';
import { WorkspaceRenderer } from '../render/WorkspaceRenderer';
import { isApplePencilPointer } from './pointerInput';

type PendingInkSegment = {
  referenceId: string;
  shapeId: string;
  shape: InkShape;
  points: InkSurfacePoint[];
  processedPointCount: number;
  lastScreenX: number;
  lastScreenY: number;
  lastTimestamp: number;
};

type WorkingShape = {
  referenceId: string;
  shape: InkShape;
};

const STABILIZER_FOLLOW_AT_MIN_SPEED = 0.06;
const STABILIZER_FOLLOW_AT_MAX_SPEED = 0.9;
const STABILIZER_MAX_SPEED_PIXELS_PER_MILLISECOND = 0.85;
const STABILIZER_REFERENCE_INTERVAL_MILLISECONDS = 1000 / 60;
const FINAL_SAMPLE_MIN_SCREEN_DISTANCE_PIXELS = 0.5;
const FILL_BLUR_TARGET_TEXEL_BUDGET = 96;

export type InkEditorControllerOptions = {
  renderer: WorkspaceRenderer;
  store: WorkspaceStore;
  getSession: () => StudioEditorSession;
  updateSession: (update: Partial<StudioEditorSession>) => void;
  showMessage: (message: string, tone?: 'info' | 'error') => void;
  isTransformPointerClaimed?: (pointerId: number) => boolean;
};

/** Pencil-only Ink authoring; Touch is left entirely to OrbitControls. */
export class InkEditorController {
  private pointerId: number | null = null;
  private pendingInk: PendingInkSegment[] = [];
  private readonly workingShapes = new Map<string, WorkingShape>();
  /** One drag keeps only the strongest wet/dry contribution per Fill texel. */
  private waterStrokeState: InkFillWaterStrokeState | null = null;
  private readonly blurWorks = new Map<string, InkFillBlurWork>();
  private blurPointerReleased = false;
  private usesRawPointerUpdates = false;
  private receivedRawPointerUpdate = false;
  private previewFrame: number | null = null;
  private disposed = false;

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
    if (this.disposed) return;
    this.disposed = true;
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
    if (!isApplePencilPointer(event) || event.button !== 0 || this.pointerId !== null) return;
    if (this.options.isTransformPointerClaimed?.(event.pointerId)) return;
    const session = this.options.getSession();
    if (session.mode === 'terrain') return;
    if (session.mode === 'select') {
      const hit = this.options.renderer.pickGroup(event.clientX, event.clientY);
      if (hit) this.options.updateSession({ activeReferenceId: hit.referenceId, activeShapeId: null });
      event.preventDefault();
      return;
    }

    const hit = this.options.renderer.pickInkSurface(
      event.clientX,
      event.clientY,
      resolvePointerPressure(event, session.pressureEnabled),
      this.getFallbackPlane(),
    );
    if (!hit) return;
    if (session.activeShapeId !== hit.shapeId) this.options.updateSession({ activeShapeId: hit.shapeId });
    if (session.mode === 'shape') {
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
        (shape) => bucketFillInkShape(shape, hit.point, session.fillColor, session.fillBucketContiguous),
      ));
      event.preventDefault();
      return;
    }
    this.beginGesture(event);
    this.appendInkHit(hit, event.clientX, event.clientY, event.timeStamp);
    this.updateStrokePreview();
    this.scheduleLivePreview();
    event.preventDefault();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!isApplePencilPointer(event)) return;
    const session = this.options.getSession();
    if (this.pointerId === null) {
      if (session.mode === 'draw') this.updateCursor(event);
      return;
    }
    if (event.pointerId !== this.pointerId) return;
    const appendCoalesced = shouldAppendCoalescedPointerMove(this.usesRawPointerUpdates, this.receivedRawPointerUpdate);
    // Raw samples only replace the matching coalesced pointermove interval.
    // Reset here so one isolated raw update cannot suppress the rest of the gesture.
    this.receivedRawPointerUpdate = false;
    if (!appendCoalesced) return;
    this.appendEventSamples(event);
  };

  private readonly handlePointerRawUpdate = (event: Event): void => {
    if (!(event instanceof PointerEvent)
      || !isApplePencilPointer(event)
      || event.pointerId !== this.pointerId
      || !this.usesRawPointerUpdates) return;
    // iPad Safari can dispatch raw pen positions with a zero pressure while
    // the following coalesced pointermove contains the actual Pencil force.
    // Do not let such a raw event suppress the pressure-bearing fallback.
    if (this.options.getSession().pressureEnabled && !hasUsablePencilPressure(event)) return;
    this.receivedRawPointerUpdate = true;
    this.appendEventSamples(event, false);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!isApplePencilPointer(event) || event.pointerId !== this.pointerId) return;
    this.appendEventSamples(event, false, true);
    const session = this.options.getSession();
    if (session.drawTool === 'fill-blur') {
      this.blurPointerReleased = true;
      this.flushLivePreview();
      event.preventDefault();
      return;
    }
    this.flushLivePreview();
    const committed = this.commitInk(session);
    if (committed && session.drawTool === 'outline') this.options.renderer.retainStrokePreviewsUntilCompiled();
    this.endGesture(false);
    event.preventDefault();
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId) this.cancelGesture();
  };

  private readonly handleLostCapture = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId && shouldCancelInkGestureOnLostPointerCapture(this.blurPointerReleased)) {
      this.cancelGesture();
    }
  };

  private readonly handlePointerLeave = (event: PointerEvent): void => {
    if (isApplePencilPointer(event) && this.pointerId === null) this.options.renderer.hideCursor();
  };

  private beginGesture(event: PointerEvent): void {
    this.pointerId = event.pointerId;
    this.pendingInk = [];
    this.workingShapes.clear();
    this.blurWorks.clear();
    this.blurPointerReleased = false;
    this.waterStrokeState = isWaterAdjustmentTool(this.options.getSession().drawTool)
      ? createInkFillWaterStrokeState()
      : null;
    this.usesRawPointerUpdates = event.pointerType === 'pen';
    this.receivedRawPointerUpdate = false;
    this.options.renderer.canvas.setPointerCapture(event.pointerId);
  }

  private appendEventSamples(event: PointerEvent, includeCoalesced = true, complete = false): void {
    if (this.options.getSession().mode !== 'draw') return;
    const session = this.options.getSession();
    const samples = includeCoalesced ? event.getCoalescedEvents?.() ?? [event] : [event];
    const pointerSamples = samples.length > 0 ? samples : [event];
    for (let index = 0; index < pointerSamples.length; index += 1) {
      const sample = pointerSamples[index]!;
      const previousPressure = this.pendingInk.at(-1)?.points.at(-1)?.pressure;
      const hit = this.options.renderer.pickInkSurface(
        sample.clientX,
        sample.clientY,
        resolvePointerPressure(sample, session.pressureEnabled, previousPressure),
        this.getFallbackPlane(),
      );
      if (hit) this.appendInkHit(
        hit,
        sample.clientX,
        sample.clientY,
        sample.timeStamp,
        complete && index === pointerSamples.length - 1,
      );
    }
    this.updateStrokePreview();
    this.scheduleLivePreview();
  }

  private appendInkHit(hit: InkSurfaceHit, screenX: number, screenY: number, timestamp: number, complete = false): void {
    let segment = this.pendingInk.at(-1);
    if (!segment || segment.referenceId !== hit.referenceId || segment.shapeId !== hit.shapeId) {
      segment = {
        referenceId: hit.referenceId,
        shapeId: hit.shapeId,
        shape: hit.shape,
        points: [],
        processedPointCount: 0,
        lastScreenX: screenX,
        lastScreenY: screenY,
        lastTimestamp: timestamp,
      };
      this.pendingInk.push(segment);
    }
    const prior = segment.points.at(-1);
    const screenDistance = Math.hypot(screenX - segment.lastScreenX, screenY - segment.lastScreenY);
    if (prior && (
      screenDistance <= 0.0001
      || (complete && screenDistance < FINAL_SAMPLE_MIN_SCREEN_DISTANCE_PIXELS)
    )) return;
    const point = prior
      ? resolveInkGesturePoint(segment.shape, prior, hit.point, screenDistance, timestamp - segment.lastTimestamp, complete)
      : hit.point;
    if (prior && sameSurfacePoint(prior, point)) return;
    segment.points.push({ ...point });
    segment.lastScreenX = screenX;
    segment.lastScreenY = screenY;
    segment.lastTimestamp = timestamp;
    const session = this.options.getSession();
    this.options.renderer.showCursor(
      hit,
      getToolRadius(session, hit.point.pressure),
      session.fillBrushShape === 'square' && isFillTool(session.drawTool),
      getToolOuterRadius(session),
    );
  }

  private updateStrokePreview(): void {
    const session = this.options.getSession();
    if (session.drawTool !== 'outline') {
      this.options.renderer.clearStrokePreview();
      return;
    }
    const previews: InkStrokePreviewSegment[] = this.pendingInk.flatMap((segment) => {
      const points = getOutlineCommitPoints(segment.shape, segment.points, session.straightLineEnabled);
      return points.length >= 2 ? [{ referenceId: segment.referenceId, shape: segment.shape, points }] : [];
    });
    this.options.renderer.showStrokePreviews(previews, session.outlineColor, session.outlineWidth);
  }

  private scheduleLivePreview(): void {
    const tool = this.options.getSession().drawTool;
    if (tool !== 'fill-brush' && tool !== 'fill-eraser' && tool !== 'fill-blur' && !isWaterAdjustmentTool(tool) && tool !== 'outline-eraser') return;
    if (this.previewFrame !== null) return;
    this.previewFrame = window.requestAnimationFrame(() => {
      this.previewFrame = null;
      this.flushLivePreview();
    });
  }

  private flushLivePreview(): void {
    if (this.previewFrame !== null) window.cancelAnimationFrame(this.previewFrame);
    this.previewFrame = null;
    const session = this.options.getSession();
    if (session.drawTool !== 'fill-brush' && session.drawTool !== 'fill-eraser' && session.drawTool !== 'fill-blur' && !isWaterAdjustmentTool(session.drawTool) && session.drawTool !== 'outline-eraser') return;
    if (session.drawTool === 'fill-blur') {
      this.flushBlurLivePreview(session);
      return;
    }
    const waterPreviews = new Map<string, WorkingShape>();
    for (const segment of this.pendingInk) {
      if (segment.processedPointCount >= segment.points.length) continue;
      const key = workingShapeKey(segment.referenceId, segment.shapeId);
      const working = this.workingShapes.get(key) ?? { referenceId: segment.referenceId, shape: segment.shape };
      const firstNew = segment.processedPointCount;
      const points = segment.points.slice(Math.max(0, firstNew - 1));
      const shape = applyInkTool(working.shape, points, session, this.waterStrokeState ?? undefined);
      segment.processedPointCount = segment.points.length;
      if (shape === working.shape) continue;
      this.workingShapes.set(key, { referenceId: segment.referenceId, shape });
      if (session.drawTool === 'outline-eraser') this.options.renderer.previewInkRibbon(segment.referenceId, shape);
      else if (isWaterAdjustmentTool(session.drawTool) && this.waterStrokeState) {
        waterPreviews.set(key, { referenceId: segment.referenceId, shape });
      }
      else this.options.renderer.previewInkFill(segment.referenceId, shape);
    }
    if (this.waterStrokeState) for (const preview of waterPreviews.values()) {
      this.options.renderer.previewInkFillWater(
        preview.referenceId,
        preview.shape,
        consumeInkFillWaterAlphaPatches(this.waterStrokeState, preview.shape.id),
      );
    }
  }

  private flushBlurLivePreview(session: StudioEditorSession): void {
    let remainingBudget = FILL_BLUR_TARGET_TEXEL_BUDGET;
    for (const segment of this.pendingInk) {
      const key = workingShapeKey(segment.referenceId, segment.shapeId);
      let working = this.workingShapes.get(key) ?? { referenceId: segment.referenceId, shape: segment.shape };
      let work = this.blurWorks.get(key);
      if (segment.processedPointCount < segment.points.length) {
        const firstNew = segment.processedPointCount;
        const points = segment.points.slice(Math.max(0, firstNew - 1));
        segment.processedPointCount = segment.points.length;
        if (work) appendInkFillBlurWorkPoints(work, points, session.fillBrushSize);
        else work = createInkFillBlurWork(working.shape, points, session.fillBrushSize, session.fillBrushShape) ?? undefined;
        this.workingShapes.set(key, working);
        if (work) this.blurWorks.set(key, work);
      }
      if (!work || remainingBudget <= 0) continue;
      const progress = processInkFillBlurWork(work, remainingBudget);
      remainingBudget -= progress.processedTargetCount;
      working = { referenceId: segment.referenceId, shape: progress.shape };
      this.workingShapes.set(key, working);
      const patches = consumeInkFillBlurRgbaPatches(work);
      if (patches.length > 0) this.options.renderer.previewInkFillBlur(segment.referenceId, progress.shape, patches);
      if (progress.complete) this.blurWorks.delete(key);
    }
    if (this.blurPointerReleased && !this.hasPendingBlurWork()) {
      this.commitInk(session);
      this.endGesture(false);
      return;
    }
    if (this.hasPendingBlurWork()) this.scheduleLivePreview();
  }

  private hasPendingBlurWork(): boolean {
    return this.blurWorks.size > 0 || this.pendingInk.some((segment) => segment.processedPointCount < segment.points.length);
  }

  private updateCursor(event: PointerEvent): void {
    const session = this.options.getSession();
    const hit = this.options.renderer.pickInkSurface(
      event.clientX,
      event.clientY,
      resolvePointerPressure(event, session.pressureEnabled),
      this.getFallbackPlane(),
    );
    if (hit) this.options.renderer.showCursor(
      hit,
      getToolRadius(session, hit.point.pressure),
      session.fillBrushShape === 'square' && isFillTool(session.drawTool),
      getToolOuterRadius(session),
    );
    else this.options.renderer.hideCursor();
  }

  private commitInk(session: StudioEditorSession): boolean {
    if (this.pendingInk.length === 0) return false;
    const label = getInkHistoryLabel(session.drawTool);
    return this.options.store.transact(label, (document) => {
      let next = document;
      if (this.workingShapes.size > 0) {
        for (const working of this.workingShapes.values()) {
          const shape = isWaterAdjustmentTool(session.drawTool) ? normalizeInkFillShape(working.shape) : working.shape;
          next = updateInkShapeAuthor(next, working.referenceId, working.shape.id, () => shape);
        }
        return next;
      }
      for (const segment of this.pendingInk) {
        if (segment.points.length === 0) continue;
        next = updateInkShapeAuthor(next, segment.referenceId, segment.shapeId, (shape) => applyInkTool(shape, segment.points, session));
      }
      return next;
    });
  }

  private getFallbackPlane(): { referenceId: string; shapeId: string } | null {
    const segment = this.pendingInk.at(-1);
    const session = this.options.getSession();
    return chooseInkFallbackPlane(
      segment ? { referenceId: segment.referenceId, shapeId: segment.shapeId, shapeKind: segment.shape.kind } : null,
      session.activeReferenceId && session.activeShapeId
      ? { referenceId: session.activeReferenceId, shapeId: session.activeShapeId }
        : null,
    );
  }

  private endGesture(restorePreview: boolean): void {
    const pointerId = this.pointerId;
    this.pointerId = null;
    if (this.previewFrame !== null) window.cancelAnimationFrame(this.previewFrame);
    this.previewFrame = null;
    this.options.renderer.clearStrokePreview();
    if (restorePreview) {
      const document = this.options.store.getDocument();
      for (const working of this.workingShapes.values()) {
        const reference = document.ink.assetReferences.find((entry) => entry.id === working.referenceId);
        const source = reference ? document.ink.embeddedAssets.find((entry) => entry.assetId === reference.assetId)?.group : null;
        const shape = source?.shapes.find((entry) => entry.id === working.shape.id);
        if (!shape) continue;
        if (this.options.getSession().drawTool === 'outline-eraser') this.options.renderer.previewInkRibbon(working.referenceId, shape);
        else this.options.renderer.previewInkFill(working.referenceId, shape);
      }
    }
    this.pendingInk = [];
    this.workingShapes.clear();
    this.blurWorks.clear();
    this.blurPointerReleased = false;
    this.waterStrokeState = null;
    this.usesRawPointerUpdates = false;
    this.receivedRawPointerUpdate = false;
    if (pointerId !== null && this.options.renderer.canvas.hasPointerCapture(pointerId)) {
      this.options.renderer.canvas.releasePointerCapture(pointerId);
    }
  }

  private readonly cancelGesture = (): void => {
    this.endGesture(true);
    this.options.renderer.hideCursor();
  };
}

export function resolvePointerPressure(
  event: Pick<PointerEvent, 'pointerType' | 'pressure'>,
  enabled: boolean,
  previousPressure?: number,
): number {
  if (!enabled || event.pointerType !== 'pen') return 1;
  if (!Number.isFinite(event.pressure) || event.pressure <= 0) return previousPressure ?? 1;
  return Math.min(1, Math.max(0.05, event.pressure));
}

/**
 * Pointer capture is normally released immediately after Pencil-up. Blur keeps
 * its in-memory batch alive past that event, so that expected release must not
 * discard the batch before its remaining frames can commit one author edit.
 */
export function shouldCancelInkGestureOnLostPointerCapture(blurPointerReleased: boolean): boolean {
  return !blurPointerReleased;
}

export function hasUsablePencilPressure(event: Pick<PointerEvent, 'pointerType' | 'pressure'>): boolean {
  return event.pointerType === 'pen' && Number.isFinite(event.pressure) && event.pressure > 0;
}

/** A raw update replaces only the next matching coalesced pointermove interval. */
export function shouldAppendCoalescedPointerMove(prefersRawInput: boolean, receivedRawInput: boolean): boolean {
  return !prefersRawInput || !receivedRawInput;
}

/** Once a stroke reaches a non-Plane Shape, it must not jump back to the selected Plane behind it. */
export function chooseInkFallbackPlane(
  preceding: { referenceId: string; shapeId: string; shapeKind: InkShape['kind'] } | null,
  active: { referenceId: string; shapeId: string } | null,
): { referenceId: string; shapeId: string } | null {
  if (preceding) return preceding.shapeKind === 'plane'
    ? { referenceId: preceding.referenceId, shapeId: preceding.shapeId }
    : null;
  return active;
}

/** The real release point closes a stroke without allowing the streaming stabilizer to shorten it. */
export function resolveInkGesturePoint(
  shape: InkShape,
  previous: InkSurfacePoint,
  raw: InkSurfacePoint,
  screenDistance: number,
  elapsedRaw: number,
  complete: boolean,
): InkSurfacePoint {
  return complete ? raw : stabilizeInkPoint(shape, previous, raw, screenDistance, elapsedRaw);
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
      if (covered) {
        changed = true;
        flush();
      } else segment.push({ ...point });
    }
    flush();
  }
  return changed ? { ...shape, strokes } : shape;
}

function applyInkTool(
  shape: InkShape,
  points: readonly InkSurfacePoint[],
  session: StudioEditorSession,
  waterStrokeState?: InkFillWaterStrokeState,
): InkShape {
  if (session.drawTool === 'outline') {
    const commitPoints = getOutlineCommitPoints(shape, points, session.straightLineEnabled);
    const last = points.at(-1);
    const stroke = commitPoints.length >= 2 ? createInkOutlineStroke(commitPoints, session.outlineColor, session.outlineWidth) : null;
    const next = stroke ? { ...shape, strokes: [...shape.strokes, stroke] } : shape;
    if (!last) return next;
    if (next.kind === 'plane' && isPlanePoint(last)) return { ...next, lastOutlineEnd: { x: last.x, y: last.y } };
    if ((next.kind === 'cuboid' || next.kind === 'frustum') && isCuboidPoint(last)) return { ...next, lastOutlineEnd: { ...last } };
    return next;
  }
  if (session.drawTool === 'outline-eraser') return eraseInkOutline(shape, points, session.outlineEraserWidth);
  if (session.drawTool === 'fill-brush') return paintInkFill(shape, points, session.fillColor, session.fillBrushSize, session.fillBrushShape, false);
  if (session.drawTool === 'fill-eraser') return paintInkFill(shape, points, session.fillColor, session.fillBrushSize, session.fillBrushShape, true);
  if (session.drawTool === 'fill-blur') return blurInkFill(shape, points, session.fillBrushSize, session.fillBrushShape);
  if (session.drawTool === 'fill-water') return paintInkFillWater(
    shape, points, session.fillBrushSize, session.fillSoftRadius, session.fillBrushShape,
    session.fillWaterOpacity, false, waterStrokeState,
  );
  if (session.drawTool === 'fill-water-eraser') return eraseInkFillWater(
    shape, points, session.fillBrushSize, session.fillSoftRadius, session.fillBrushShape,
    session.fillWaterOpacity, false, waterStrokeState,
  );
  return shape;
}

function getOutlineCommitPoints(shape: InkShape, points: readonly InkSurfacePoint[], straight: boolean): InkSurfacePoint[] {
  if (!straight || points.length === 0) return points.map((point) => ({ ...point }));
  const end = points.at(-1)!;
  if (shape.kind === 'plane' && isPlanePoint(end) && shape.lastOutlineEnd) {
    return [{ ...shape.lastOutlineEnd, pressure: 1 }, { ...end }];
  }
  if ((shape.kind === 'cuboid' || shape.kind === 'frustum') && isCuboidPoint(end) && shape.lastOutlineEnd?.face === end.face) {
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
  if (shape.kind === 'cylinder' && isCylinderPoint(point)) return getInkCylinderSurfacePosition(shape, point);
  if (shape.kind === 'frustum' && isCuboidPoint(point)) return getInkFrustumFacePosition(shape, point);
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
  if (shape.kind === 'cylinder' && isCylinderPoint(previous) && isCylinderPoint(raw) && previous.surface === raw.surface) {
    let deltaU = raw.u - previous.u;
    if (previous.surface === 'side') {
      if (deltaU > 0.5) deltaU -= 1;
      if (deltaU < -0.5) deltaU += 1;
    }
    const u = previous.u + deltaU * follow;
    return {
      surface: raw.surface,
      u: previous.surface === 'side' ? ((u + 0.5) % 1 + 1) % 1 - 0.5 : u,
      v: previous.v + (raw.v - previous.v) * follow,
      pressure: previous.pressure + (raw.pressure - previous.pressure) * follow,
    };
  }
  if (shape.kind === 'frustum' && isCuboidPoint(previous) && isCuboidPoint(raw) && previous.face === raw.face) {
    return { face: raw.face, u: previous.u + (raw.u - previous.u) * follow, v: previous.v + (raw.v - previous.v) * follow, pressure: previous.pressure + (raw.pressure - previous.pressure) * follow };
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
  if (isCylinderPoint(left) && isCylinderPoint(right)) return left.surface === right.surface && Math.abs(left.u - right.u) < 1e-6 && Math.abs(left.v - right.v) < 1e-6;
  if (isPlanePoint(left) && isPlanePoint(right)) return Math.hypot(left.x - right.x, left.y - right.y) < 1e-6;
  return false;
}

function workingShapeKey(referenceId: string, shapeId: string): string {
  return `${referenceId}:${shapeId}`;
}

function isPlanePoint(point: InkSurfacePoint): point is { x: number; y: number; pressure: number } {
  return 'x' in point && 'y' in point && !('z' in point);
}

function isCuboidPoint(point: InkSurfacePoint): point is InkCuboidStrokePoint {
  return 'face' in point;
}

function isSpherePoint(point: InkSurfacePoint): point is { x: number; y: number; z: number; pressure: number } {
  return 'x' in point && 'y' in point && 'z' in point;
}

function isCylinderPoint(point: InkSurfacePoint): point is InkCylinderStrokePoint {
  return 'surface' in point;
}

function isFillTool(tool: StudioEditorSession['drawTool']): boolean {
  return tool === 'fill-brush' || tool === 'fill-eraser' || tool === 'fill-blur' || isWaterAdjustmentTool(tool) || tool === 'fill-bucket';
}

function isWaterAdjustmentTool(tool: StudioEditorSession['drawTool']): boolean {
  return tool === 'fill-water' || tool === 'fill-water-eraser';
}

function isPressureSizedFillTool(tool: StudioEditorSession['drawTool']): boolean {
  return tool === 'fill-brush' || tool === 'fill-eraser' || tool === 'fill-blur';
}

function getToolRadius(session: StudioEditorSession, pressure = 1): number {
  if (session.drawTool === 'outline') return session.outlineWidth * 0.5;
  if (session.drawTool === 'outline-eraser') return session.outlineEraserWidth * 0.5;
  const radius = getInkFillBrushRadii(session.fillBrushSize).core / INK_FILL_PIXELS_PER_WORLD_UNIT;
  return isPressureSizedFillTool(session.drawTool) ? radius * Math.min(1, Math.max(0.05, pressure)) : radius;
}

function getToolOuterRadius(session: StudioEditorSession): number | undefined {
  if (!isWaterAdjustmentTool(session.drawTool)) return undefined;
  return getInkFillBrushRadii(session.fillBrushSize, session.fillSoftRadius).outer / INK_FILL_PIXELS_PER_WORLD_UNIT;
}

function getInkHistoryLabel(tool: StudioEditorSession['drawTool']): string {
  if (tool === 'outline') return 'Draw outline';
  if (tool === 'outline-eraser') return 'Erase outline';
  if (tool === 'fill-brush') return 'Paint fill';
  if (tool === 'fill-eraser') return 'Erase fill';
  if (tool === 'fill-blur') return 'Blur fill';
  if (tool === 'fill-water') return 'Mark water';
  if (tool === 'fill-water-eraser') return 'Erase water';
  return 'Edit Ink';
}
