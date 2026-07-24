import { compareTiles, createTerrainTile, isValidTerrainCell, tileKey, type TerrainCellPosition, type TerrainTileChange, type TileCell, type TileRotation } from '../domain/terrain/terrain';
import type { StudioEditorSession, TerrainWorkAxis } from '../domain/workspace/session';
import type { WorkspaceStore } from '../domain/workspace/WorkspaceStore';
import type { TerrainPick } from '../render/WorkspaceRenderer';
import { WorkspaceRenderer } from '../render/WorkspaceRenderer';
import { isApplePencilPointer } from './pointerInput';

const MAX_RECTANGLE_AFFECTED_CELLS = 4_096;

type EditIntent = 'place' | 'remove';

type TerrainGesture = {
  pointerId: number;
  operation: 'brush' | 'rectangle';
  intent: EditIntent;
  axis: TerrainWorkAxis;
  planeCoordinate: number;
  anchor: TerrainCellPosition;
  lastCell: TerrainCellPosition;
  kind: StudioEditorSession['terrainKind'];
  rotation: StudioEditorSession['terrainRotation'];
  color: StudioEditorSession['terrainColor'];
  sourceTiles: ReadonlyMap<string, TileCell>;
  changes: Map<string, TerrainTileChange>;
  rectangleOverLimit: boolean;
};

export type TerrainEditorControllerOptions = {
  renderer: WorkspaceRenderer;
  store: WorkspaceStore;
  getSession: () => StudioEditorSession;
  showMessage: (message: string, tone?: 'info' | 'error') => void;
};

/** Apple-Pencil-only Painting-compatible terrain brush and rectangle editor. */
export class TerrainEditorController {
  private gesture: TerrainGesture | null = null;
  private hover: { x: number; y: number } | null = null;
  private sourceTiles: readonly TileCell[] | null = null;
  private sourceTilesByCell = new Map<string, TileCell>();
  private disposed = false;

  constructor(private readonly options: TerrainEditorControllerOptions) {
    const canvas = options.renderer.canvas;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerCancel);
    canvas.addEventListener('lostpointercapture', this.handleLostCapture);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
    window.addEventListener('blur', this.cancelGesture);
  }

  syncSession(): void {
    if (this.disposed) return;
    if (this.options.getSession().mode !== 'terrain') {
      if (!this.gesture) this.options.renderer.clearTerrainPreview();
      return;
    }
    if (!this.gesture) this.refreshHoverPreview();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelGesture();
    const canvas = this.options.renderer.canvas;
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    canvas.removeEventListener('lostpointercapture', this.handleLostCapture);
    canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    window.removeEventListener('blur', this.cancelGesture);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!isApplePencilPointer(event) || event.button !== 0 || this.gesture || this.options.getSession().mode !== 'terrain') return;
    const session = this.options.getSession();
    const pick = this.options.renderer.pickTerrain(event.clientX, event.clientY, session.terrainAxis);
    if (!pick) return;
    const intent: EditIntent = session.terrainAction === 'place' ? 'place' : 'remove';
    const anchor = this.getInitialCell(pick, intent, session.terrainAxis);
    if (!anchor) return;
    const sourceTiles = this.getSourceTilesByCell();
    this.gesture = {
      pointerId: event.pointerId,
      operation: session.terrainOperation,
      intent,
      axis: session.terrainAxis,
      planeCoordinate: anchor[session.terrainAxis],
      anchor,
      lastCell: anchor,
      kind: session.terrainKind,
      rotation: session.terrainRotation,
      color: session.terrainColor,
      sourceTiles: new Map(sourceTiles),
      changes: new Map(),
      rectangleOverLimit: false,
    };
    if (session.terrainOperation === 'brush') this.addCellChange(this.gesture, anchor);
    else this.rebuildRectangle(this.gesture, anchor);
    this.showGesturePreview(this.gesture);
    this.options.renderer.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!isApplePencilPointer(event)) return;
    if (!this.gesture) {
      this.hover = { x: event.clientX, y: event.clientY };
      if (this.options.getSession().mode === 'terrain') this.refreshHoverPreview();
      return;
    }
    if (event.pointerId !== this.gesture.pointerId) return;
    this.extendGesture(event.clientX, event.clientY);
    event.preventDefault();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
    this.extendGesture(event.clientX, event.clientY);
    const gesture = this.gesture;
    this.gesture = null;
    if (this.options.renderer.canvas.hasPointerCapture(event.pointerId)) this.options.renderer.canvas.releasePointerCapture(event.pointerId);
    this.commit(gesture);
    this.refreshHoverPreview();
    event.preventDefault();
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.gesture?.pointerId) this.cancelGesture();
  };

  private readonly handleLostCapture = (event: PointerEvent): void => {
    if (event.pointerId === this.gesture?.pointerId) this.cancelGesture();
  };

  private readonly handlePointerLeave = (event: PointerEvent): void => {
    if (!isApplePencilPointer(event) || this.gesture) return;
    this.hover = null;
    this.options.renderer.clearTerrainPreview();
  };

  private extendGesture(clientX: number, clientY: number): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const cell = this.options.renderer.pickTerrainCellOnPlane(clientX, clientY, gesture.axis, gesture.planeCoordinate);
    if (!cell) return;
    if (gesture.operation === 'brush') {
      for (const next of getPixelPerfectTerrainLineCells(gesture.lastCell, cell, gesture.axis)) this.addCellChange(gesture, next);
      gesture.lastCell = cell;
    } else {
      this.rebuildRectangle(gesture, cell);
    }
    this.showGesturePreview(gesture);
  }

  private getInitialCell(pick: TerrainPick, intent: EditIntent, axis: TerrainWorkAxis): TerrainCellPosition | null {
    if (intent === 'remove') return pick.source === 'terrain' ? { x: pick.tile.x, y: pick.tile.y, z: pick.tile.z } : null;
    const cell = this.options.renderer.getTerrainPlacementCell(pick, axis);
    if (!cell || !isValidTerrainCell(cell.x, cell.y, cell.z)) return null;
    return this.getSourceTilesByCell().has(tileKey(cell)) ? null : cell;
  }

  private addCellChange(gesture: TerrainGesture, cell: TerrainCellPosition): void {
    if (!isValidTerrainCell(cell.x, cell.y, cell.z)) return;
    const key = tileKey(cell);
    if (gesture.changes.has(key)) return;
    const before = gesture.sourceTiles.get(key) ?? null;
    if (gesture.intent === 'remove') {
      if (before) gesture.changes.set(key, { ...cell, before, after: null });
      return;
    }
    if (before) return;
    gesture.changes.set(key, {
      ...cell,
      before: null,
      after: createTerrainTile(gesture.kind, gesture.rotation, cell.x, cell.y, cell.z, gesture.color),
    });
  }

  private rebuildRectangle(gesture: TerrainGesture, endpoint: TerrainCellPosition): void {
    gesture.changes.clear();
    gesture.rectangleOverLimit = !isRectangleWithinLimit(gesture, endpoint, MAX_RECTANGLE_AFFECTED_CELLS);
    if (gesture.rectangleOverLimit) return;
    if (usesSteppedSlopeRectangle(gesture)) {
      this.rebuildSteppedSlopeRectangle(gesture, endpoint);
      return;
    }
    for (const cell of createTerrainRectangleCells(gesture.anchor, endpoint, gesture.axis)) this.addCellChange(gesture, cell);
  }

  private rebuildSteppedSlopeRectangle(gesture: TerrainGesture, endpoint: TerrainCellPosition): void {
    const downhill = getSlopeDownhillDirection(gesture.rotation);
    const perpendicular = { x: -downhill.z, z: downhill.x };
    const offset = { x: endpoint.x - gesture.anchor.x, z: endpoint.z - gesture.anchor.z };
    const signedLength = dotHorizontal(offset, downhill);
    const length = Math.abs(signedLength);
    const step = signedLength < 0 ? -1 : 1;
    const dragsDownhill = signedLength > 0;
    const perpendicularLength = dotHorizontal(offset, perpendicular);
    for (let width = Math.min(0, perpendicularLength); width <= Math.max(0, perpendicularLength); width += 1) {
      for (let path = 0; path <= length; path += 1) {
        const downhillOffset = path * step;
        const cell = {
          x: gesture.anchor.x + downhill.x * downhillOffset + perpendicular.x * width,
          y: gesture.anchor.y - downhillOffset,
          z: gesture.anchor.z + downhill.z * downhillOffset + perpendicular.z * width,
        };
        this.addTypedPlacement(gesture, cell, 'slope', gesture.rotation);
        const isAboveLowestEnd = dragsDownhill ? path < length : path > 0;
        if (isAboveLowestEnd) this.addTypedPlacement(gesture, { ...cell, y: cell.y - 1 }, 'block', 0);
      }
    }
  }

  private addTypedPlacement(
    gesture: TerrainGesture,
    cell: TerrainCellPosition,
    kind: StudioEditorSession['terrainKind'],
    rotation: TileRotation,
  ): void {
    if (!isValidTerrainCell(cell.x, cell.y, cell.z)) return;
    const key = tileKey(cell);
    if (gesture.changes.has(key) || gesture.sourceTiles.has(key)) return;
    gesture.changes.set(key, {
      ...cell,
      before: null,
      after: createTerrainTile(kind, rotation, cell.x, cell.y, cell.z, gesture.color),
    });
  }

  private showGesturePreview(gesture: TerrainGesture): void {
    if (gesture.rectangleOverLimit) {
      this.options.renderer.clearTerrainPreview();
      return;
    }
    const tiles = [...gesture.changes.values()].flatMap((change) => {
      const tile = gesture.intent === 'place' ? change.after : change.before;
      return tile ? [tile] : [];
    });
    if (tiles.length > 0) this.options.renderer.setTerrainPreviews(tiles, gesture.intent === 'place' ? 'place' : 'remove');
    else this.options.renderer.clearTerrainPreview();
  }

  private refreshHoverPreview(): void {
    if (!this.hover || this.gesture || this.options.getSession().mode !== 'terrain') {
      if (!this.gesture) this.options.renderer.clearTerrainPreview();
      return;
    }
    const session = this.options.getSession();
    const pick = this.options.renderer.pickTerrain(this.hover.x, this.hover.y, session.terrainAxis);
    if (!pick) {
      this.options.renderer.clearTerrainPreview();
      return;
    }
    if (session.terrainAction === 'erase') {
      if (pick.source === 'terrain') this.options.renderer.setTerrainPreviews([pick.tile], 'remove');
      else this.options.renderer.clearTerrainPreview();
      return;
    }
    const cell = this.options.renderer.getTerrainPlacementCell(pick, session.terrainAxis);
    if (!cell || this.getSourceTilesByCell().has(tileKey(cell))) {
      this.options.renderer.clearTerrainPreview();
      return;
    }
    this.options.renderer.setTerrainPreviews([
      createTerrainTile(session.terrainKind, session.terrainRotation, cell.x, cell.y, cell.z, session.terrainColor),
    ], 'place');
  }

  private commit(gesture: TerrainGesture): void {
    if (gesture.rectangleOverLimit) {
      this.options.showMessage(`Rectangle is limited to ${MAX_RECTANGLE_AFFECTED_CELLS} terrain cells.`, 'error');
      this.options.renderer.clearTerrainPreview();
      return;
    }
    const changes = [...gesture.changes.values()];
    if (changes.length === 0) return;
    this.options.renderer.prepareTerrainPatch(changes);
    const label = gesture.operation === 'brush'
      ? gesture.intent === 'place' ? 'Brush terrain' : 'Erase terrain'
      : gesture.intent === 'place' ? 'Rectangle terrain' : 'Rectangle erase terrain';
    this.options.store.transact(label, (document) => {
      const byCell = new Map(document.terrain.tiles.map((tile) => [tileKey(tile), tile]));
      for (const change of changes) {
        const key = tileKey(change);
        if (change.after) byCell.set(key, change.after);
        else byCell.delete(key);
      }
      return { ...document, terrain: { tiles: [...byCell.values()].sort(compareTiles) } };
    });
  }

  private getSourceTilesByCell(): ReadonlyMap<string, TileCell> {
    const tiles = this.options.store.getDocument().terrain.tiles;
    if (tiles !== this.sourceTiles) {
      this.sourceTiles = tiles;
      this.sourceTilesByCell = new Map(tiles.map((tile) => [tileKey(tile), tile]));
    }
    return this.sourceTilesByCell;
  }

  private readonly cancelGesture = (): void => {
    const pointerId = this.gesture?.pointerId ?? null;
    this.gesture = null;
    if (pointerId !== null && this.options.renderer.canvas.hasPointerCapture(pointerId)) {
      this.options.renderer.canvas.releasePointerCapture(pointerId);
    }
    this.options.renderer.clearTerrainPreview();
  };
}

export function getPixelPerfectTerrainLineCells(
  start: TerrainCellPosition,
  end: TerrainCellPosition,
  axis: TerrainWorkAxis,
): TerrainCellPosition[] {
  const [firstAxis, secondAxis] = getPlaneAxes(axis);
  const cells: TerrainCellPosition[] = [];
  let first = start[firstAxis];
  let second = start[secondAxis];
  const endFirst = end[firstAxis];
  const endSecond = end[secondAxis];
  const deltaFirst = Math.abs(endFirst - first);
  const deltaSecond = Math.abs(endSecond - second);
  const stepFirst = first < endFirst ? 1 : -1;
  const stepSecond = second < endSecond ? 1 : -1;
  let error = deltaFirst - deltaSecond;
  while (true) {
    cells.push(createCellOnPlane(axis, start[axis], first, second));
    if (first === endFirst && second === endSecond) break;
    const doubled = error * 2;
    if (doubled > -deltaSecond) {
      error -= deltaSecond;
      first += stepFirst;
    }
    if (doubled < deltaFirst) {
      error += deltaFirst;
      second += stepSecond;
    }
  }
  return cells;
}

export function createTerrainRectangleCells(
  start: TerrainCellPosition,
  end: TerrainCellPosition,
  axis: TerrainWorkAxis,
): TerrainCellPosition[] {
  const [firstAxis, secondAxis] = getPlaneAxes(axis);
  const cells: TerrainCellPosition[] = [];
  for (let second = Math.min(start[secondAxis], end[secondAxis]); second <= Math.max(start[secondAxis], end[secondAxis]); second += 1) {
    for (let first = Math.min(start[firstAxis], end[firstAxis]); first <= Math.max(start[firstAxis], end[firstAxis]); first += 1) {
      cells.push(createCellOnPlane(axis, start[axis], first, second));
    }
  }
  return cells;
}

function getPlaneAxes(axis: TerrainWorkAxis): readonly [TerrainWorkAxis, TerrainWorkAxis] {
  if (axis === 'x') return ['y', 'z'];
  if (axis === 'y') return ['x', 'z'];
  return ['x', 'y'];
}

function createCellOnPlane(
  axis: TerrainWorkAxis,
  coordinate: number,
  first: number,
  second: number,
): TerrainCellPosition {
  const [firstAxis, secondAxis] = getPlaneAxes(axis);
  const cell: TerrainCellPosition = { x: 0, y: 0, z: 0 };
  cell[axis] = coordinate;
  cell[firstAxis] = first;
  cell[secondAxis] = second;
  return cell;
}

function usesSteppedSlopeRectangle(gesture: TerrainGesture): boolean {
  return gesture.operation === 'rectangle' && gesture.intent === 'place' && gesture.kind === 'slope' && gesture.axis === 'y';
}

function isRectangleWithinLimit(gesture: TerrainGesture, endpoint: TerrainCellPosition, limit: number): boolean {
  if (usesSteppedSlopeRectangle(gesture)) {
    const downhill = getSlopeDownhillDirection(gesture.rotation);
    const perpendicular = { x: -downhill.z, z: downhill.x };
    const offset = { x: endpoint.x - gesture.anchor.x, z: endpoint.z - gesture.anchor.z };
    const pathLength = Math.abs(dotHorizontal(offset, downhill)) + 1;
    const width = Math.abs(dotHorizontal(offset, perpendicular)) + 1;
    const cellsPerWidth = pathLength * 2 - 1;
    return Number.isSafeInteger(cellsPerWidth) && cellsPerWidth <= limit && width <= Math.floor(limit / cellsPerWidth);
  }
  const [firstAxis, secondAxis] = getPlaneAxes(gesture.axis);
  const firstSpan = Math.abs(endpoint[firstAxis] - gesture.anchor[firstAxis]) + 1;
  const secondSpan = Math.abs(endpoint[secondAxis] - gesture.anchor[secondAxis]) + 1;
  return Number.isSafeInteger(firstSpan) && Number.isSafeInteger(secondSpan)
    && firstSpan <= limit && secondSpan <= Math.floor(limit / firstSpan);
}

function getSlopeDownhillDirection(rotation: TileRotation): { x: -1 | 0 | 1; z: -1 | 0 | 1 } {
  if (rotation === 0) return { x: 0, z: 1 };
  if (rotation === 90) return { x: -1, z: 0 };
  if (rotation === 180) return { x: 0, z: -1 };
  return { x: 1, z: 0 };
}

function dotHorizontal(left: { x: number; z: number }, right: { x: number; z: number }): number {
  return left.x * right.x + left.z * right.z;
}
