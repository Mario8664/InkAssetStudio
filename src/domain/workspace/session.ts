import type { InkFillBrushShape, InkPlaneOrientation } from '../ink/ink';
import { DEFAULT_INK_FILL_BRUSH_SIZE, DEFAULT_INK_STROKE_COLOR, DEFAULT_INK_STROKE_WIDTH } from '../ink/ink';
import { DEFAULT_TILE_COLOR, isPico8ColorId, type Pico8ColorId } from '../terrain/pico8';
import type { TileKind, TileRotation } from '../terrain/terrain';

export type WorkspaceMode = 'navigate' | 'terrain' | 'select' | 'shape' | 'draw';
export type InkDrawTool = 'outline' | 'outline-eraser' | 'fill-brush' | 'fill-eraser' | 'fill-bucket' | 'picker';
export type TransformMode = 'translate' | 'rotate';
export type TerrainAction = 'place' | 'erase';

export type StudioEditorSession = {
  mode: WorkspaceMode;
  drawTool: InkDrawTool;
  activeReferenceId: string | null;
  activeShapeId: string | null;
  pressureEnabled: boolean;
  straightLineEnabled: boolean;
  outlineColor: string;
  fillColor: string;
  palette: string[];
  outlineWidth: number;
  outlineEraserWidth: number;
  fillBrushSize: number;
  fillBrushShape: InkFillBrushShape;
  terrainKind: TileKind;
  terrainAction: TerrainAction;
  terrainRotation: TileRotation;
  terrainColor: Pico8ColorId;
  terrainLayer: number;
  planeOrientation: InkPlaneOrientation;
  transformMode: TransformMode;
  showTerrainEdges: boolean;
  showInfiniteGrid: boolean;
  showAxes: boolean;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
};

export const DEFAULT_PALETTE = ['#000000', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c'];

export function createStudioEditorSession(): StudioEditorSession {
  return {
    mode: 'draw',
    drawTool: 'outline',
    activeReferenceId: null,
    activeShapeId: null,
    pressureEnabled: true,
    straightLineEnabled: false,
    outlineColor: DEFAULT_INK_STROKE_COLOR,
    fillColor: '#fff1e8',
    palette: [...DEFAULT_PALETTE],
    outlineWidth: DEFAULT_INK_STROKE_WIDTH,
    outlineEraserWidth: 0.1,
    fillBrushSize: DEFAULT_INK_FILL_BRUSH_SIZE,
    fillBrushShape: 'circle',
    terrainKind: 'block',
    terrainAction: 'place',
    terrainRotation: 0,
    terrainColor: DEFAULT_TILE_COLOR,
    terrainLayer: 0,
    planeOrientation: 'camera',
    transformMode: 'translate',
    showTerrainEdges: true,
    showInfiniteGrid: true,
    showAxes: true,
    leftPanelOpen: true,
    rightPanelOpen: true,
  };
}

export function normalizeStudioEditorSession(value: unknown): StudioEditorSession {
  const fallback = createStudioEditorSession();
  if (!value || typeof value !== 'object') return fallback;
  const source = value as Partial<StudioEditorSession> & { showGrid?: unknown };
  const color = (candidate: unknown, defaultValue: string): string => typeof candidate === 'string' && /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : defaultValue;
  const number = (candidate: unknown, defaultValue: number, minimum: number, maximum: number): number => typeof candidate === 'number' && Number.isFinite(candidate)
    ? Math.min(maximum, Math.max(minimum, candidate))
    : defaultValue;
  return {
    mode: isOneOf(source.mode, ['navigate', 'terrain', 'select', 'shape', 'draw']) ? source.mode : fallback.mode,
    drawTool: isOneOf(source.drawTool, ['outline', 'outline-eraser', 'fill-brush', 'fill-eraser', 'fill-bucket', 'picker']) ? source.drawTool : fallback.drawTool,
    activeReferenceId: typeof source.activeReferenceId === 'string' || source.activeReferenceId === null ? source.activeReferenceId : fallback.activeReferenceId,
    activeShapeId: typeof source.activeShapeId === 'string' || source.activeShapeId === null ? source.activeShapeId : fallback.activeShapeId,
    pressureEnabled: typeof source.pressureEnabled === 'boolean' ? source.pressureEnabled : fallback.pressureEnabled,
    straightLineEnabled: typeof source.straightLineEnabled === 'boolean' ? source.straightLineEnabled : fallback.straightLineEnabled,
    outlineColor: color(source.outlineColor, fallback.outlineColor),
    fillColor: color(source.fillColor, fallback.fillColor),
    palette: Array.isArray(source.palette)
      ? source.palette.filter((entry): entry is string => typeof entry === 'string' && /^#[0-9a-f]{6}$/i.test(entry)).slice(0, 32)
      : fallback.palette,
    outlineWidth: number(source.outlineWidth, fallback.outlineWidth, 0.005, 0.5),
    outlineEraserWidth: number(source.outlineEraserWidth, fallback.outlineEraserWidth, 0.01, 1),
    fillBrushSize: number(source.fillBrushSize, fallback.fillBrushSize, 0.02, 1),
    fillBrushShape: isOneOf(source.fillBrushShape, ['circle', 'square']) ? source.fillBrushShape : fallback.fillBrushShape,
    terrainKind: isOneOf(source.terrainKind, ['block', 'slope', 'corner-slope']) ? source.terrainKind : fallback.terrainKind,
    terrainAction: isOneOf(source.terrainAction, ['place', 'erase']) ? source.terrainAction : fallback.terrainAction,
    terrainRotation: isOneOf(source.terrainRotation, [0, 90, 180, 270]) ? source.terrainRotation : fallback.terrainRotation,
    terrainColor: isPico8ColorId(source.terrainColor) ? source.terrainColor : fallback.terrainColor,
    terrainLayer: Math.round(number(source.terrainLayer, fallback.terrainLayer, -1_000, 1_000)),
    planeOrientation: isOneOf(source.planeOrientation, ['x', 'y', 'z', 'camera']) ? source.planeOrientation : fallback.planeOrientation,
    transformMode: isOneOf(source.transformMode, ['translate', 'rotate']) ? source.transformMode : fallback.transformMode,
    showTerrainEdges: typeof source.showTerrainEdges === 'boolean'
      ? source.showTerrainEdges
      : typeof source.showGrid === 'boolean'
        ? source.showGrid
        : fallback.showTerrainEdges,
    showInfiniteGrid: typeof source.showInfiniteGrid === 'boolean' ? source.showInfiniteGrid : fallback.showInfiniteGrid,
    showAxes: typeof source.showAxes === 'boolean' ? source.showAxes : fallback.showAxes,
    leftPanelOpen: typeof source.leftPanelOpen === 'boolean' ? source.leftPanelOpen : fallback.leftPanelOpen,
    rightPanelOpen: typeof source.rightPanelOpen === 'boolean' ? source.rightPanelOpen : fallback.rightPanelOpen,
  };
}

function isOneOf<T extends string | number>(value: unknown, candidates: readonly T[]): value is T {
  return candidates.some((candidate) => candidate === value);
}
