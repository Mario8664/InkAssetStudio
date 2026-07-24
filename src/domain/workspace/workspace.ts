import {
  INK_COMPILED_FORMAT_VERSION,
  createInkAssetReference,
  createInkEmbeddedAsset,
  createInkGroupData,
  createInkPlaneShape,
  upgradeInkGroupData,
  withCompiledInkGroup,
  type InkAssetReference,
  type InkEmbeddedAsset,
  type InkGroupData,
  type InkGroupRotation,
  type InkManagerData,
  type InkShape,
  type InkVector3,
} from '../ink/ink';
import {
  DEFAULT_PREVIEW_LIGHTING,
  clonePreviewLighting,
  isStudioPreviewLighting,
  upgradePreviewLightingDefaults,
  type StudioPreviewLighting,
} from '../lighting/lighting';
import { compareTiles, createTerrainTile, isTileCell, tileKey, type TileCell } from '../terrain/terrain';

export const STUDIO_WORK_FORMAT = 'ink-asset-studio-work';
export const STUDIO_WORK_FORMAT_VERSION = 1;
export const PAINTING_INK_ASSET_SCHEMA_VERSION = 3;
export const STUDIO_TERRAIN_SCHEMA_VERSION = 1;
export const MAX_WORK_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_TERRAIN_TILES = 20_000;
export const MAX_INK_GROUPS = 500;
export const MAX_SHAPES_PER_GROUP = 500;
export const MAX_STROKE_POINTS_PER_GROUP = 2_000_000;
export const MAX_FILL_BLOCKS_PER_GROUP = 200_000;

export type InkStudioWorkFile = {
  format: typeof STUDIO_WORK_FORMAT;
  formatVersion: typeof STUDIO_WORK_FORMAT_VERSION;
  sourceCompatibility: {
    paintingInkAssetSchemaVersion: typeof PAINTING_INK_ASSET_SCHEMA_VERSION;
    paintingInkCompiledFormatVersion: typeof INK_COMPILED_FORMAT_VERSION;
    terrainSchemaVersion: typeof STUDIO_TERRAIN_SCHEMA_VERSION;
  };
  documentId: string;
  name: string;
  terrain: { tiles: TileCell[] };
  ink: Pick<InkManagerData, 'embeddedAssets' | 'assetReferences'>;
  previewLighting: StudioPreviewLighting;
};

export type WorkspaceValidationResult =
  | { ok: true; document: InkStudioWorkFile }
  | { ok: false; error: string };

export function createStudioDocument(name = 'Untitled Ink Scene'): InkStudioWorkFile {
  const group = createInkGroupData('Group 1');
  const embedded = createInkEmbeddedAsset(group);
  const reference = createInkAssetReference(embedded.assetId, { x: 0, y: 1, z: 0 });
  const tiles: TileCell[] = [];
  for (let z = -2; z <= 2; z += 1) for (let x = -2; x <= 2; x += 1) tiles.push(createTerrainTile('block', 0, x, 0, z));
  return {
    format: STUDIO_WORK_FORMAT,
    formatVersion: STUDIO_WORK_FORMAT_VERSION,
    sourceCompatibility: {
      paintingInkAssetSchemaVersion: PAINTING_INK_ASSET_SCHEMA_VERSION,
      paintingInkCompiledFormatVersion: INK_COMPILED_FORMAT_VERSION,
      terrainSchemaVersion: STUDIO_TERRAIN_SCHEMA_VERSION,
    },
    documentId: `ink-work-${crypto.randomUUID()}`,
    name,
    terrain: { tiles: tiles.sort(compareTiles) },
    ink: { embeddedAssets: [embedded], assetReferences: [reference] },
    previewLighting: clonePreviewLighting(),
  };
}

export function createEmptyStudioDocument(name = 'Untitled Ink Scene'): InkStudioWorkFile {
  return {
    ...createStudioDocument(name),
    terrain: { tiles: [] },
    ink: { embeddedAssets: [], assetReferences: [] },
  };
}

export function parseStudioWorkFile(text: string): WorkspaceValidationResult {
  if (new Blob([text]).size > MAX_WORK_FILE_BYTES) return { ok: false, error: 'The work file exceeds the 32 MB safety limit.' };
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { return { ok: false, error: 'The selected file is not valid JSON.' }; }
  return normalizeStudioDocument(value);
}

export function normalizeStudioDocument(value: unknown): WorkspaceValidationResult {
  if (!value || typeof value !== 'object') return invalid('The work file root must be an object.');
  const source = value as Partial<InkStudioWorkFile>;
  if (source.format !== STUDIO_WORK_FORMAT || source.formatVersion !== STUDIO_WORK_FORMAT_VERSION) {
    return invalid('This Ink Studio work-file version is not supported.');
  }
  if (typeof source.documentId !== 'string' || !source.documentId || typeof source.name !== 'string' || !source.name.trim()) {
    return invalid('The work file has an invalid document id or name.');
  }
  if (!source.terrain || !Array.isArray(source.terrain.tiles) || source.terrain.tiles.length > MAX_TERRAIN_TILES) {
    return invalid('The work file has invalid or excessive terrain data.');
  }
  const tileIds = new Set<string>();
  const tiles: TileCell[] = [];
  for (const candidate of source.terrain.tiles) {
    if (!isTileCell(candidate)) return invalid('The work file contains an invalid terrain tile.');
    const key = tileKey(candidate);
    if (tileIds.has(key)) return invalid(`The work file contains duplicate terrain cell ${key}.`);
    tileIds.add(key);
    tiles.push({ ...candidate });
  }
  if (!source.ink || !Array.isArray(source.ink.embeddedAssets) || !Array.isArray(source.ink.assetReferences)
    || source.ink.embeddedAssets.length > MAX_INK_GROUPS || source.ink.assetReferences.length > MAX_INK_GROUPS) {
    return invalid('The work file has invalid or excessive Ink Group data.');
  }
  const assetIds = new Set<string>();
  const embeddedAssets: InkEmbeddedAsset[] = [];
  for (const candidate of source.ink.embeddedAssets) {
    if (!candidate || typeof candidate !== 'object') return invalid('The work file contains an invalid Ink source.');
    const raw = candidate as Partial<InkEmbeddedAsset>;
    if (typeof raw.assetId !== 'string' || !raw.assetId || assetIds.has(raw.assetId)) return invalid('Ink source ids must be non-empty and unique.');
    const upgraded = upgradeInkGroupData(raw.group);
    if (!upgraded || upgraded.shapes.length > MAX_SHAPES_PER_GROUP) return invalid(`Ink source ${raw.assetId} is invalid or has too many Shapes.`);
    const counts = countGroupPayload(upgraded);
    if (counts.strokePoints > MAX_STROKE_POINTS_PER_GROUP || counts.fillBlocks > MAX_FILL_BLOCKS_PER_GROUP) {
      return invalid(`Ink source ${raw.assetId} exceeds the editable-content safety limits.`);
    }
    const group: InkGroupData = withCompiledInkGroup({
      ...upgraded,
      id: raw.assetId,
      anchorPosition: { x: 0, y: 0, z: 0 },
    });
    assetIds.add(raw.assetId);
    embeddedAssets.push({ assetId: raw.assetId, group });
  }
  const referenceIds = new Set<string>();
  const assetReferences: InkAssetReference[] = [];
  for (const candidate of source.ink.assetReferences) {
    if (!isAssetReference(candidate) || referenceIds.has(candidate.id) || !assetIds.has(candidate.assetId)) {
      return invalid('The work file contains an invalid, duplicate, or unresolved Ink reference.');
    }
    referenceIds.add(candidate.id);
    assetReferences.push({ ...candidate, anchorPosition: { ...candidate.anchorPosition } });
  }
  if (!isStudioPreviewLighting(source.previewLighting)) return invalid('The work file contains invalid preview lighting.');
  return {
    ok: true,
    document: {
      format: STUDIO_WORK_FORMAT,
      formatVersion: STUDIO_WORK_FORMAT_VERSION,
      sourceCompatibility: {
        paintingInkAssetSchemaVersion: PAINTING_INK_ASSET_SCHEMA_VERSION,
        paintingInkCompiledFormatVersion: INK_COMPILED_FORMAT_VERSION,
        terrainSchemaVersion: STUDIO_TERRAIN_SCHEMA_VERSION,
      },
      documentId: source.documentId,
      name: source.name.trim(),
      terrain: { tiles: tiles.sort(compareTiles) },
      ink: { embeddedAssets, assetReferences },
      previewLighting: upgradePreviewLightingDefaults(source.previewLighting),
    },
  };
}

export function serializeStudioDocument(document: InkStudioWorkFile): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function addInkGroup(
  document: InkStudioWorkFile,
  name = `Group ${document.ink.assetReferences.length + 1}`,
  anchorPosition: InkVector3 = { x: 0, y: 1, z: 0 },
): { document: InkStudioWorkFile; referenceId: string } {
  const embedded = createInkEmbeddedAsset(createInkGroupData(name));
  const reference = createInkAssetReference(embedded.assetId, anchorPosition);
  return {
    document: {
      ...document,
      ink: {
        embeddedAssets: [...document.ink.embeddedAssets, embedded],
        assetReferences: [...document.ink.assetReferences, reference],
      },
    },
    referenceId: reference.id,
  };
}

export function removeInkGroup(document: InkStudioWorkFile, referenceId: string): InkStudioWorkFile {
  const reference = document.ink.assetReferences.find((candidate) => candidate.id === referenceId);
  if (!reference) return document;
  return {
    ...document,
    ink: {
      assetReferences: document.ink.assetReferences.filter((candidate) => candidate.id !== referenceId),
      embeddedAssets: document.ink.embeddedAssets.filter((candidate) => candidate.assetId !== reference.assetId),
    },
  };
}

export function updateInkReference(
  document: InkStudioWorkFile,
  referenceId: string,
  update: Partial<Pick<InkAssetReference, 'anchorPosition' | 'rotation'>>,
): InkStudioWorkFile {
  let changed = false;
  const assetReferences = document.ink.assetReferences.map((reference) => {
    if (reference.id !== referenceId) return reference;
    changed = true;
    return {
      ...reference,
      ...(update.anchorPosition ? { anchorPosition: { ...update.anchorPosition } } : {}),
      ...(update.rotation !== undefined ? { rotation: update.rotation } : {}),
    };
  });
  return changed ? { ...document, ink: { ...document.ink, assetReferences } } : document;
}

export function updateInkSource(
  document: InkStudioWorkFile,
  assetId: string,
  update: (group: InkGroupData) => InkGroupData,
): InkStudioWorkFile {
  let changed = false;
  const embeddedAssets = document.ink.embeddedAssets.map((embedded) => {
    if (embedded.assetId !== assetId) return embedded;
    const next = update(embedded.group);
    if (next === embedded.group) return embedded;
    changed = true;
    return {
      assetId,
      group: withCompiledInkGroup({
        ...next,
        id: assetId,
        anchorPosition: { x: 0, y: 0, z: 0 },
      }, embedded.group),
    };
  });
  return changed ? { ...document, ink: { ...document.ink, embeddedAssets } } : document;
}

/**
 * Applies author data without compiling it on the UI thread. The existing
 * compiled payload remains a renderable cache until InkCompilationCoordinator
 * replaces it with the Worker result.
 */
export function updateInkSourceAuthor(
  document: InkStudioWorkFile,
  assetId: string,
  update: (group: InkGroupData) => InkGroupData,
): InkStudioWorkFile {
  let changed = false;
  const embeddedAssets = document.ink.embeddedAssets.map((embedded) => {
    if (embedded.assetId !== assetId) return embedded;
    const next = update(embedded.group);
    if (next === embedded.group) return embedded;
    changed = true;
    return {
      assetId,
      group: {
        ...next,
        id: assetId,
        anchorPosition: { x: 0, y: 0, z: 0 },
        visualFootprint: embedded.group.visualFootprint,
        compiled: embedded.group.compiled,
      },
    };
  });
  return changed ? { ...document, ink: { ...document.ink, embeddedAssets } } : document;
}

export function renameInkGroup(document: InkStudioWorkFile, referenceId: string, name: string): InkStudioWorkFile {
  const reference = getInkReference(document, referenceId);
  const trimmed = name.trim();
  return reference && trimmed ? updateInkSource(document, reference.assetId, (group) => group.name === trimmed ? group : { ...group, name: trimmed }) : document;
}

export function addInkShape(document: InkStudioWorkFile, referenceId: string, shape: InkShape): InkStudioWorkFile {
  const reference = getInkReference(document, referenceId);
  return reference ? updateInkSource(document, reference.assetId, (group) => ({ ...group, shapes: [...group.shapes, shape] })) : document;
}

export function addDefaultPlaneShape(document: InkStudioWorkFile, referenceId: string): InkStudioWorkFile {
  return addInkShape(document, referenceId, createInkPlaneShape('camera', { x: 0, y: 0, z: 0 }));
}

export function removeInkShape(document: InkStudioWorkFile, referenceId: string, shapeId: string): InkStudioWorkFile {
  const reference = getInkReference(document, referenceId);
  return reference ? updateInkSource(document, reference.assetId, (group) => {
    const shapes = group.shapes.filter((shape) => shape.id !== shapeId);
    return shapes.length === group.shapes.length ? group : { ...group, shapes };
  }) : document;
}

export function updateInkShape(
  document: InkStudioWorkFile,
  referenceId: string,
  shapeId: string,
  update: (shape: InkShape) => InkShape,
): InkStudioWorkFile {
  const reference = getInkReference(document, referenceId);
  if (!reference) return document;
  return updateInkSource(document, reference.assetId, (group) => {
    let changed = false;
    const shapes = group.shapes.map((shape) => {
      if (shape.id !== shapeId) return shape;
      const next = update(shape);
      changed ||= next !== shape;
      return next;
    });
    return changed ? { ...group, shapes } : group;
  });
}

export function updateInkShapeAuthor(
  document: InkStudioWorkFile,
  referenceId: string,
  shapeId: string,
  update: (shape: InkShape) => InkShape,
): InkStudioWorkFile {
  const reference = getInkReference(document, referenceId);
  if (!reference) return document;
  return updateInkSourceAuthor(document, reference.assetId, (group) => {
    let changed = false;
    const shapes = group.shapes.map((shape) => {
      if (shape.id !== shapeId) return shape;
      const next = update(shape);
      changed ||= next !== shape;
      return next;
    });
    return changed ? { ...group, shapes } : group;
  });
}

export function resolveInkGroups(document: InkStudioWorkFile): InkGroupData[] {
  const sources = new Map(document.ink.embeddedAssets.map((asset) => [asset.assetId, asset.group]));
  return document.ink.assetReferences.flatMap((reference) => {
    const source = sources.get(reference.assetId);
    return source ? [{ ...source, id: reference.id, anchorPosition: { ...reference.anchorPosition }, placementRotation: reference.rotation }] : [];
  });
}

export function getInkReference(document: InkStudioWorkFile, referenceId: string | null): InkAssetReference | null {
  return referenceId ? document.ink.assetReferences.find((reference) => reference.id === referenceId) ?? null : null;
}

export function getInkSourceByReference(document: InkStudioWorkFile, referenceId: string | null): InkGroupData | null {
  const reference = getInkReference(document, referenceId);
  return reference ? document.ink.embeddedAssets.find((asset) => asset.assetId === reference.assetId)?.group ?? null : null;
}

export function getSourceIdForReference(document: InkStudioWorkFile, referenceId: string): string | null {
  return getInkReference(document, referenceId)?.assetId ?? null;
}

export function isInkGroupRotation(value: number): value is InkGroupRotation { return value === 0 || value === 90 || value === 180 || value === 270; }

function countGroupPayload(group: InkGroupData): { strokePoints: number; fillBlocks: number } {
  let strokePoints = 0;
  let fillBlocks = 0;
  for (const shape of group.shapes) {
    for (const stroke of shape.strokes) strokePoints += stroke.points.length;
    for (const surface of shape.fill.surfaces) fillBlocks += surface.blocks.length;
  }
  return { strokePoints, fillBlocks };
}

function isAssetReference(value: unknown): value is InkAssetReference {
  if (!value || typeof value !== 'object') return false;
  const reference = value as Partial<InkAssetReference>;
  return typeof reference.id === 'string' && !!reference.id
    && typeof reference.assetId === 'string' && !!reference.assetId
    && isVector3(reference.anchorPosition)
    && typeof reference.rotation === 'number' && isInkGroupRotation(reference.rotation);
}

function isVector3(value: unknown): value is InkVector3 {
  if (!value || typeof value !== 'object') return false;
  const vector = value as Partial<InkVector3>;
  return [vector.x, vector.y, vector.z].every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function invalid(error: string): WorkspaceValidationResult { return { ok: false, error }; }

export function createDefaultLighting(): StudioPreviewLighting { return clonePreviewLighting(DEFAULT_PREVIEW_LIGHTING); }
