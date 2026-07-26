<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import {
  createDefaultInkSurfaceOutlineSettings,
  createInkCuboidShape,
  createInkCylinderShape,
  createInkFrustumShape,
  createInkPlaneShape,
  createInkSphereShape,
  getCameraFacingInkPlaneRotation,
  resampleInkShapeFill,
  type InkShape,
  type InkVector3,
} from '../domain/ink/ink';
import { DEFAULT_PREVIEW_LIGHTING, clonePreviewLighting } from '../domain/lighting/lighting';
import { PICO_8_COLORS } from '../domain/terrain/pico8';
import { createTerrainTile, type TileKind, type TileRotation } from '../domain/terrain/terrain';
import type { StudioEditorSession, WorkspaceMode } from '../domain/workspace/session';
import { cloneStudioEditorSession, createStudioEditorSession, normalizeStudioEditorSession } from '../domain/workspace/session';
import {
  addInkGroup,
  addInkShape,
  createStudioDocument,
  getInkReference,
  getInkSourceByReference,
  removeInkGroup,
  removeInkShape,
  renameInkGroup,
  updateInkReference,
  updateInkShapeAuthor,
  type InkStudioWorkFile,
} from '../domain/workspace/workspace';
import { WorkspaceStore, type WorkspaceSnapshot } from '../domain/workspace/WorkspaceStore';
import { InkEditorController } from '../editor/InkEditorController';
import { PencilTransformController } from '../editor/PencilTransformController';
import { TerrainEditorController } from '../editor/TerrainEditorController';
import { WorkspaceRenderer } from '../render/WorkspaceRenderer';
import { downloadStudioDocument, readStudioDocumentFile } from '../storage/files';
import { loadCurrentDocument, loadDocumentSavedAt, loadEditorSession, saveDocument, saveEditorSession } from '../storage/indexedDb';
import { InkCompilationCoordinator } from '../workers/InkCompilationCoordinator';
import { normalizeStudioDocumentInWorker } from '../workers/workspaceLoader';

const canvas = ref<HTMLCanvasElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const session = reactive<StudioEditorSession>(createStudioEditorSession());
const snapshot = shallowRef<WorkspaceSnapshot | null>(null);
const loading = ref(true);
const online = ref(navigator.onLine);
const message = ref<{ text: string; tone: 'info' | 'error' } | null>(null);
const lastSavedAt = ref<number | null>(null);
const paletteEditing = ref(false);
const lightingPanelOpen = ref(false);
let store: WorkspaceStore | null = null;
let renderer: WorkspaceRenderer | null = null;
let controller: InkEditorController | null = null;
let terrainController: TerrainEditorController | null = null;
let transformController: PencilTransformController | null = null;
let compiler: InkCompilationCoordinator | null = null;
let unsubscribe: (() => void) | null = null;
let saveTimer: number | null = null;
let sessionTimer: number | null = null;
let messageTimer: number | null = null;
let pendingSave: { document: InkStudioWorkFile; revision: number } | null = null;

const document = computed(() => snapshot.value?.document ?? null);
const activeReference = computed(() => document.value ? getInkReference(document.value, session.activeReferenceId) : null);
const activeGroup = computed(() => document.value ? getInkSourceByReference(document.value, session.activeReferenceId) : null);
const activeShape = computed(() => activeGroup.value?.shapes.find((shape) => shape.id === session.activeShapeId) ?? null);
const activeSurfaceOutline = computed(() => {
  const shape = activeShape.value;
  return shape && (shape.kind === 'sphere' || shape.kind === 'cylinder')
    ? shape.surfaceOutline ?? createDefaultInkSurfaceOutlineSettings()
    : null;
});
const isDirty = computed(() => !!snapshot.value && snapshot.value.revision > snapshot.value.savedRevision);
const isUnexported = computed(() => !!snapshot.value && snapshot.value.revision > snapshot.value.exportedRevision);
const saveLabel = computed(() => isDirty.value ? 'Saving…' : isUnexported.value ? 'Saved locally · not exported' : 'Saved locally');
const savedTimeLabel = computed(() => lastSavedAt.value === null ? '' : new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}).format(lastSavedAt.value));

onMounted(async () => {
  try {
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    window.addEventListener('pagehide', flushPersistence);
    window.document.addEventListener('visibilitychange', handleVisibilityChange);
    const [storedDocument, storedSession] = await Promise.all([
      loadCurrentDocument().catch(() => null),
      loadEditorSession().catch(() => null),
    ]);
    const normalized = storedDocument ? await normalizeStudioDocumentInWorker(storedDocument) : null;
    const initialDocument = normalized?.ok ? normalized.document : createStudioDocument();
    lastSavedAt.value = await loadDocumentSavedAt(initialDocument.documentId).catch(() => null);
    if (storedSession) Object.assign(session, normalizeStudioEditorSession(storedSession));
    if (!initialDocument.ink.assetReferences.some((reference) => reference.id === session.activeReferenceId)) {
      session.activeReferenceId = initialDocument.ink.assetReferences[0]?.id ?? null;
    }
    const initialGroup = getInkSourceByReference(initialDocument, session.activeReferenceId);
    if (!initialGroup?.shapes.some((shape) => shape.id === session.activeShapeId)) session.activeShapeId = initialGroup?.shapes[0]?.id ?? null;
    store = new WorkspaceStore(initialDocument);
    if (!canvas.value) throw new Error('Studio canvas did not mount.');
    renderer = new WorkspaceRenderer(canvas.value, (warning) => showMessage(warning, 'error'));
    transformController = new PencilTransformController({ renderer, store, getSession: () => session });
    controller = new InkEditorController({
      renderer,
      store,
      getSession: () => session,
      updateSession,
      showMessage,
      isTransformPointerClaimed: (pointerId) => transformController?.isPointerClaimed(pointerId) ?? false,
    });
    terrainController = new TerrainEditorController({ renderer, store, getSession: () => session, showMessage });
    unsubscribe = store.subscribe((next) => {
      snapshot.value = next;
      normalizeSelection(next.document);
      renderer?.update(next.document, session);
      transformController?.sync(next.document, session);
      terrainController?.syncSession();
      if (next.revision > next.savedRevision) scheduleSave(next.document, next.revision);
    });
    compiler = new InkCompilationCoordinator(
      store,
      (error) => showMessage(error, 'error'),
      (assetId, shapeId) => renderer?.releaseStrokePreviewHandoffs(assetId, shapeId),
    );
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Unable to open Ink Asset Studio.', 'error');
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  flushPersistence();
  if (messageTimer !== null) window.clearTimeout(messageTimer);
  unsubscribe?.();
  compiler?.dispose();
  controller?.dispose();
  terrainController?.dispose();
  transformController?.dispose();
  renderer?.dispose();
  window.removeEventListener('online', updateOnline);
  window.removeEventListener('offline', updateOnline);
  window.removeEventListener('pagehide', flushPersistence);
  window.document.removeEventListener('visibilitychange', handleVisibilityChange);
});

watch(() => [
  session.mode,
  session.activeReferenceId,
  session.activeShapeId,
  session.excludedShapeIds,
  session.showTerrainEdges,
  session.showInfiniteGrid,
  session.showAxes,
] as const, () => {
  const current = store?.getDocument() ?? document.value;
  if (!current) return;
  renderer?.update(current, session);
  transformController?.sync(current, session);
  terrainController?.syncSession();
});

watch(activeShape, (shape) => {
  // Planes have no intrinsic dimensions. Do not leave their inspector in a
  // hidden Size/Radius mode after selecting one from a non-planar Shape.
  if (shape?.kind === 'plane' && session.transformMode === 'resize') session.transformMode = 'translate';
});

watch(() => [session.transformMode, session.transformSpace, session.snapEnabled, session.transformSnapUnit] as const, () => {
  const current = store?.getDocument() ?? document.value;
  if (current) transformController?.sync(current, session);
});

watch(() => [
  session.terrainAction,
  session.terrainOperation,
  session.terrainAxis,
  session.terrainKind,
  session.terrainRotation,
  session.terrainColor,
] as const, () => terrainController?.syncSession());

watch(session, () => {
  if (sessionTimer !== null) window.clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => { void persistEditorSession(); }, 350);
}, { deep: true });

function updateOnline(): void { online.value = navigator.onLine; }

function handleVisibilityChange(): void {
  if (window.document.visibilityState === 'hidden') flushPersistence();
}

function flushPersistence(): void {
  void flushDocumentSave();
  void persistEditorSession();
}

function updateSession(update: Partial<StudioEditorSession>): void { Object.assign(session, update); }

function setMode(mode: WorkspaceMode): void {
  session.mode = mode;
  if (mode !== 'shape' && session.transformMode === 'resize') session.transformMode = 'translate';
  lightingPanelOpen.value = false;
  if (mode === 'draw' && !session.activeReferenceId && document.value?.ink.assetReferences[0]) {
    session.activeReferenceId = document.value.ink.assetReferences[0].id;
  }
}

function undo(): void { store?.undo(); }
function redo(): void { store?.redo(); }
function focusSelection(): void { renderer?.focusSelection(); }

function scheduleSave(value: InkStudioWorkFile, revision: number): void {
  pendingSave = { document: value, revision };
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void flushDocumentSave(); }, 600);
}

async function flushDocumentSave(): Promise<void> {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = null;
  const pending = pendingSave;
  pendingSave = null;
  if (!pending) return;
  try {
    lastSavedAt.value = await saveDocument(pending.document);
    store?.markSaved(pending.revision);
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Unable to save the local draft.', 'error');
  }
}

async function persistEditorSession(): Promise<void> {
  if (sessionTimer !== null) window.clearTimeout(sessionTimer);
  sessionTimer = null;
  try {
    await saveEditorSession(cloneStudioEditorSession(session));
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Unable to save the editor session.', 'error');
  }
}

function normalizeSelection(value: InkStudioWorkFile): void {
  if (!value.ink.assetReferences.some((reference) => reference.id === session.activeReferenceId)) {
    session.activeReferenceId = value.ink.assetReferences[0]?.id ?? null;
  }
  const group = getInkSourceByReference(value, session.activeReferenceId);
  if (!group?.shapes.some((shape) => shape.id === session.activeShapeId)) session.activeShapeId = group?.shapes[0]?.id ?? null;
}

function newDocument(): void {
  if (isUnexported.value && !window.confirm('Create a new work scene? The current scene has changes that were not exported.')) return;
  const next = createStudioDocument();
  store?.replace(next, 'New work scene', false);
  session.activeReferenceId = next.ink.assetReferences[0]?.id ?? null;
  session.activeShapeId = next.ink.embeddedAssets[0]?.group.shapes[0]?.id ?? null;
  showMessage('Created a new offline work scene.');
}

function exportDocument(): void {
  if (!document.value) return;
  downloadStudioDocument(document.value);
  store?.markExported();
  showMessage('Work scene exported to Files.');
}

async function importDocument(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const result = await readStudioDocumentFile(file);
  if (!result.ok) { showMessage(result.error, 'error'); return; }
  if (isUnexported.value && !window.confirm('Open the selected work scene? The current scene has changes that were not exported.')) return;
  store?.replace(result.document);
  normalizeSelection(result.document);
  showMessage(`Opened ${result.document.name}.`);
}

function renameDocument(event: Event): void {
  const name = (event.target as HTMLInputElement).value.trim();
  if (name) store?.transact('Rename work scene', (value) => value.name === name ? value : { ...value, name });
}

function createGroup(): void {
  if (!store) return;
  let referenceId = '';
  store.transact('Create Ink Group', (value) => {
    const result = addInkGroup(value);
    referenceId = result.referenceId;
    return result.document;
  });
  session.activeReferenceId = referenceId;
  session.activeShapeId = getInkSourceByReference(store.getDocument(), referenceId)?.shapes[0]?.id ?? null;
  session.mode = 'draw';
}

function deleteGroup(id: string): void {
  if (!window.confirm('Delete this Ink Group and all its editable content?')) return;
  store?.transact('Delete Ink Group', (value) => removeInkGroup(value, id));
}

function selectGroup(referenceId: string): void {
  session.activeReferenceId = referenceId;
  session.activeShapeId = getInkSourceByReference(document.value!, referenceId)?.shapes[0]?.id ?? null;
}

function setGroupName(event: Event): void {
  if (!session.activeReferenceId) return;
  const name = (event.target as HTMLInputElement).value;
  store?.transact('Rename Ink Group', (value) => renameInkGroup(value, session.activeReferenceId!, name));
}

function setReferencePosition(axis: keyof InkVector3, event: Event): void {
  const reference = activeReference.value;
  if (!reference) return;
  const next = finiteInput(event, reference.anchorPosition[axis]);
  store?.transact('Move Ink Group', (value) => updateInkReference(value, reference.id, { anchorPosition: { ...reference.anchorPosition, [axis]: next } }));
}

function setReferenceRotation(event: Event): void {
  const reference = activeReference.value;
  const rotation = Number((event.target as HTMLSelectElement).value) as 0 | 90 | 180 | 270;
  if (reference) store?.transact('Rotate Ink Group', (value) => updateInkReference(value, reference.id, { rotation }));
}

function createShape(kind: InkShape['kind'], orientation = session.planeOrientation): void {
  if (!store || !session.activeReferenceId) return;
  const cameraRotation = orientation === 'camera' && renderer
    ? getCameraFacingInkPlaneRotation(renderer.camera.quaternion, activeReference.value?.rotation ?? 0)
    : { x: 0, y: 0, z: 0 };
  const shape = kind === 'plane'
    ? createInkPlaneShape(orientation, cameraRotation)
    : kind === 'cuboid' ? createInkCuboidShape()
      : kind === 'sphere' ? createInkSphereShape()
        : kind === 'cylinder' ? createInkCylinderShape()
          : createInkFrustumShape();
  store.transact(`Create ${kind} Shape`, (value) => addInkShape(value, session.activeReferenceId!, shape));
  session.activeShapeId = shape.id;
  session.mode = 'shape';
}

function createPlane(orientation: StudioEditorSession['planeOrientation']): void {
  session.planeOrientation = orientation;
  createShape('plane', orientation);
}

function deleteShape(shapeId: string): void {
  if (!session.activeReferenceId || !window.confirm('Delete this Shape and all of its Ink content?')) return;
  store?.transact('Delete Ink Shape', (value) => removeInkShape(value, session.activeReferenceId!, shapeId));
  session.excludedShapeIds = session.excludedShapeIds.filter((id) => id !== shapeId);
}

function toggleShapeDrawingExclusion(shapeId: string): void {
  session.excludedShapeIds = session.excludedShapeIds.includes(shapeId)
    ? session.excludedShapeIds.filter((id) => id !== shapeId)
    : [...session.excludedShapeIds, shapeId];
}

function selectTerrainKind(kind: TileKind): void {
  session.terrainKind = kind;
  showTerrainToolPreview();
}

function selectTerrainRotation(rotation: TileRotation): void {
  session.terrainRotation = rotation;
  showTerrainToolPreview();
}

function selectTerrainColor(color: StudioEditorSession['terrainColor']): void {
  session.terrainColor = color;
  showTerrainToolPreview();
}

function showTerrainToolPreview(): void {
  renderer?.showTerrainToolPreview(createTerrainTile(
    session.terrainKind,
    session.terrainRotation,
    0,
    0,
    0,
    session.terrainColor,
  ));
}

function setTransformSnapUnit(event: Event): void {
  const input = event.target as HTMLInputElement;
  const raw = Number(input.value);
  const fallback = Number.isFinite(session.transformSnapUnit) && session.transformSnapUnit > 0
    ? session.transformSnapUnit
    : 0.5;
  session.transformSnapUnit = Number.isFinite(raw)
    ? Math.min(1_000, Math.max(0.001, raw))
    : fallback;
  input.value = String(session.transformSnapUnit);
}

function setShapeVector(field: 'position' | 'rotation', axis: keyof InkVector3, event: Event): void {
  const shape = activeShape.value;
  if (!shape || !session.activeReferenceId) return;
  const shown = field === 'rotation' ? shape[field][axis] * 180 / Math.PI : shape[field][axis];
  const raw = finiteInput(event, shown);
  const next = field === 'rotation' ? raw * Math.PI / 180 : raw;
  store?.transact(field === 'position' ? 'Move Ink Shape' : 'Rotate Ink Shape', (value) => updateInkShapeAuthor(
    value,
    session.activeReferenceId!,
    shape.id,
    (current) => ({ ...current, [field]: { ...current[field], [axis]: next } }),
  ));
}

function setShapeSize(axis: keyof InkVector3, event: Event): void {
  const shape = activeShape.value;
  if (!shape || shape.kind !== 'cuboid' || !session.activeReferenceId) return;
  const next = Math.max(0.05, finiteInput(event, shape.size[axis]));
  store?.transact('Resize Ink Cuboid', (value) => updateInkShapeAuthor(value, session.activeReferenceId!, shape.id, (current) => current.kind === 'cuboid'
    ? resampleInkShapeFill(current, { ...current, size: { ...current.size, [axis]: next } })
    : current));
}

function setShapeRadius(event: Event): void {
  const shape = activeShape.value;
  if (!shape || shape.kind !== 'sphere' || !session.activeReferenceId) return;
  const next = Math.max(0.05, finiteInput(event, shape.radius));
  store?.transact('Resize Ink Sphere', (value) => updateInkShapeAuthor(value, session.activeReferenceId!, shape.id, (current) => current.kind === 'sphere'
    ? resampleInkShapeFill(current, { ...current, radius: next })
    : current));
}

function setCylinderDimension(field: 'radius' | 'height', event: Event): void {
  const shape = activeShape.value;
  if (!shape || shape.kind !== 'cylinder' || !session.activeReferenceId) return;
  const next = Math.max(0.05, finiteInput(event, shape[field]));
  store?.transact('Resize Ink Cylinder', (value) => updateInkShapeAuthor(value, session.activeReferenceId!, shape.id, (current) => current.kind === 'cylinder'
    ? resampleInkShapeFill(current, { ...current, [field]: next })
    : current));
}

function setFrustumDimension(field: 'topSize' | 'bottomSize' | 'height', event: Event): void {
  const shape = activeShape.value;
  if (!shape || shape.kind !== 'frustum' || !session.activeReferenceId) return;
  const next = Math.max(0.05, finiteInput(event, shape[field]));
  store?.transact('Resize Ink Frustum', (value) => updateInkShapeAuthor(value, session.activeReferenceId!, shape.id, (current) => current.kind === 'frustum'
    ? resampleInkShapeFill(current, { ...current, [field]: next })
    : current));
}

function setSurfaceOutlineEnabled(event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked;
  updateActiveSurfaceOutline('Toggle Ink surface outline', undefined, (current) => ({ ...current, enabled }));
}

function setSurfaceOutlineWidth(event: Event): void {
  const fallback = activeSurfaceOutline.value?.width ?? createDefaultInkSurfaceOutlineSettings().width;
  const width = boundedInput(event, fallback, 0.001, 1);
  updateActiveSurfaceOutline('Set Ink surface outline width', 'surface-outline:width', (current) => ({ ...current, width }));
}

function updateActiveSurfaceOutline(
  label: string,
  coalescedKey: string | undefined,
  update: (current: ReturnType<typeof createDefaultInkSurfaceOutlineSettings>) => ReturnType<typeof createDefaultInkSurfaceOutlineSettings>,
): void {
  const shape = activeShape.value;
  const referenceId = session.activeReferenceId;
  if (!store || !shape || (shape.kind !== 'sphere' && shape.kind !== 'cylinder') || !referenceId) return;
  const apply = (value: InkStudioWorkFile) => updateInkShapeAuthor(value, referenceId, shape.id, (current) => current.kind !== 'sphere' && current.kind !== 'cylinder'
    ? current
    : { ...current, surfaceOutline: update(current.surfaceOutline ?? createDefaultInkSurfaceOutlineSettings()) });
  if (coalescedKey) store.transactCoalesced(`${coalescedKey}:${shape.id}`, label, apply);
  else store.transact(label, apply);
}

function updateLighting(path: string, raw: string | number): void {
  store?.transactCoalesced(`preview-lighting:${path}`, 'Set preview lighting', (value) => {
    const lighting = structuredClone(value.previewLighting);
    const parts = path.split('.');
    let target = lighting as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    const key = parts.at(-1)!;
    if (target[key] === raw) return value;
    target[key] = raw;
    return { ...value, previewLighting: lighting };
  });
}

function setLightingRange(path: string, event: Event, fallback: number, minimum: number, maximum: number): void {
  updateLighting(path, boundedInput(event, fallback, minimum, maximum));
}

function setSessionRange(
  field: 'outlineWidth' | 'outlineEraserWidth' | 'fillBrushSize',
  event: Event,
  minimum: number,
  maximum: number,
): void {
  session[field] = boundedInput(event, session[field], minimum, maximum);
}

function resetLightingToPainting(): void {
  store?.transact('Restore Painting lighting', (value) => {
    const lighting = clonePreviewLighting(DEFAULT_PREVIEW_LIGHTING);
    return JSON.stringify(value.previewLighting) === JSON.stringify(lighting)
      ? value
      : { ...value, previewLighting: lighting };
  });
}

function addPaletteColor(): void {
  const color = session.drawTool === 'outline' ? session.outlineColor : session.fillColor;
  if (session.palette.length >= 32) { showMessage('The palette is limited to 32 colors.', 'error'); return; }
  session.palette = [...session.palette, color];
}

function removePaletteColor(index: number): void {
  session.palette = session.palette.filter((_, candidate) => candidate !== index);
}

function setPaletteColor(index: number, event: Event): void {
  const color = (event.target as HTMLInputElement).value;
  session.palette = session.palette.map((entry, candidate) => candidate === index ? color : entry);
}

function movePaletteColor(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= session.palette.length) return;
  const next = [...session.palette];
  [next[index], next[target]] = [next[target]!, next[index]!];
  session.palette = next;
}

function usePaletteColor(color: string): void {
  if (session.drawTool === 'outline' || session.drawTool === 'outline-eraser') session.outlineColor = color;
  else session.fillColor = color;
}

function showMessage(text: string, tone: 'info' | 'error' = 'info'): void {
  message.value = { text, tone };
  if (messageTimer !== null) window.clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => { message.value = null; }, 3200);
}

function finiteInput(event: Event, fallback: number): number {
  const value = Number((event.target as HTMLInputElement).value);
  return Number.isFinite(value) ? value : fallback;
}

function boundedInput(event: Event, fallback: number, minimum: number, maximum: number): number {
  const input = event.target as HTMLInputElement;
  const value = finiteInput(event, fallback);
  const bounded = Math.min(maximum, Math.max(minimum, value));
  input.value = String(bounded);
  return bounded;
}

function degrees(value: number): number { return Math.round(value * 180 / Math.PI * 100) / 100; }
</script>

<template>
  <div class="studio-shell" :class="{ loading }">
    <header class="topbar">
      <button class="icon-button panel-toggle" title="Toggle Groups" @click="session.leftPanelOpen = !session.leftPanelOpen">☰</button>
      <input v-if="document" class="document-name" :value="document.name" aria-label="Work scene name" @change="renameDocument" />
      <span class="save-state" :class="{ pending: isDirty }" title="The local draft can be reclaimed by iPadOS. Export important work to Files."><i />{{ saveLabel }}<time v-if="savedTimeLabel">{{ savedTimeLabel }}</time></span>
      <span class="backup-note">Local draft ≠ backup</span>
      <span class="network-state" :class="{ offline: !online }">{{ online ? 'Online' : 'Offline' }}</span>
      <div class="topbar-spacer" />
      <button class="history-button" title="Undo" :disabled="!snapshot?.canUndo" @click="undo"><span aria-hidden="true">↶</span> Undo</button>
      <button class="history-button" title="Redo" :disabled="!snapshot?.canRedo" @click="redo"><span aria-hidden="true">↷</span> Redo</button>
      <button @click="newDocument">New</button>
      <button @click="fileInput?.click()">Open</button>
      <button class="primary" @click="exportDocument">Export</button>
      <input ref="fileInput" class="hidden-input" type="file" accept=".json,.inkstudio-work.json,application/json" @change="importDocument" />
      <button class="icon-button panel-toggle" title="Toggle Inspector" @click="session.rightPanelOpen = !session.rightPanelOpen">⚙</button>
    </header>

    <nav class="modebar" aria-label="Editor mode">
      <button :class="{ active: session.mode === 'terrain' }" @click="setMode('terrain')">Terrain</button>
      <button :class="{ active: session.mode === 'select' }" @click="setMode('select')">Group</button>
      <button :class="{ active: session.mode === 'shape' }" @click="setMode('shape')">Shape</button>
      <button :class="{ active: session.mode === 'draw' }" @click="setMode('draw')">Draw</button>
      <button :class="{ active: lightingPanelOpen }" @click="lightingPanelOpen = !lightingPanelOpen">Lighting</button>
      <button class="focus-button" :disabled="!session.activeReferenceId" @click="focusSelection">Focus</button>
    </nav>

    <aside v-if="session.leftPanelOpen" class="panel left-panel">
      <div class="panel-heading">
        <div><strong>Ink Groups</strong><small>{{ document?.ink.assetReferences.length ?? 0 }} groups</small></div>
        <button class="round-button" title="New Group" @click="createGroup">＋</button>
      </div>
      <div class="group-list">
        <div
          v-for="reference in document?.ink.assetReferences"
          :key="reference.id"
          class="list-row-shell"
          :class="{ active: reference.id === session.activeReferenceId }"
        >
          <button class="group-row" @click="selectGroup(reference.id)">
            <span class="group-dot" />
            <span>{{ document?.ink.embeddedAssets.find(asset => asset.assetId === reference.assetId)?.group.name }}</span>
            <small>{{ reference.anchorPosition.x.toFixed(1) }}, {{ reference.anchorPosition.z.toFixed(1) }}</small>
          </button>
          <button class="list-delete-button" :aria-label="`Delete ${document?.ink.embeddedAssets.find(asset => asset.assetId === reference.assetId)?.group.name ?? 'Group'}`" title="Delete Group" @click="deleteGroup(reference.id)">⌫</button>
        </div>
      </div>
      <div v-if="activeGroup" class="shape-list-section">
        <div class="subheading"><span>Shapes</span><span>{{ activeGroup.shapes.length }}</span></div>
        <div
          v-for="(shape, index) in activeGroup.shapes"
          :key="shape.id"
          class="list-row-shell shape-list-row"
          :class="{ active: shape.id === session.activeShapeId }"
        >
          <button class="shape-row" @click="session.activeShapeId = shape.id; session.mode = 'shape'">
            <span>{{ shape.kind === 'plane' ? '▱' : shape.kind === 'cuboid' ? '⬡' : shape.kind === 'sphere' ? '●' : shape.kind === 'cylinder' ? '▯' : '△' }}</span>
            <span>{{ shape.kind }} {{ index + 1 }}</span>
          </button>
          <button
            class="list-delete-button shape-visibility-button"
            :class="{ active: !session.excludedShapeIds.includes(shape.id) }"
            :aria-label="`${session.excludedShapeIds.includes(shape.id) ? 'Show' : 'Hide'} ${shape.kind} ${index + 1} for drawing`"
            :title="session.excludedShapeIds.includes(shape.id) ? 'Allow drawing on Shape' : 'Temporarily hide from drawing'"
            @click="toggleShapeDrawingExclusion(shape.id)"
          >👁</button>
          <button class="list-delete-button" :aria-label="`Delete ${shape.kind} ${index + 1}`" title="Delete Shape" @click="deleteShape(shape.id)">⌫</button>
        </div>
        <label class="shape-create-label">Add Plane</label>
        <div class="plane-create-row" aria-label="Plane orientation">
          <button title="Plane normal X" @click="createPlane('x')">X</button>
          <button title="Plane normal Y" @click="createPlane('y')">Y</button>
          <button title="Plane normal Z" @click="createPlane('z')">Z</button>
          <button title="Face the current editor camera" @click="createPlane('camera')">Camera</button>
        </div>
        <div class="shape-create-row">
          <button @click="createShape('cuboid')">+ Box</button>
          <button @click="createShape('sphere')">+ Sphere</button>
          <button @click="createShape('cylinder')">+ Cylinder</button>
          <button @click="createShape('frustum')">+ Frustum</button>
        </div>
      </div>
    </aside>

    <main class="viewport">
      <canvas ref="canvas" aria-label="Ink Studio 3D viewport" />
      <div class="viewport-hint">
        <template v-if="session.mode === 'terrain'">Pencil: {{ session.terrainOperation }} {{ session.terrainAction }} · finger: orbit / pan / zoom</template>
        <template v-else-if="session.mode === 'select'">Pencil: select or use the Group handle · finger: orbit / pan / zoom</template>
        <template v-else-if="session.mode === 'shape'">Pencil: select or use Shape and size handles · finger: orbit / pan / zoom</template>
        <template v-else>Apple Pencil draws · finger: orbit / pan / zoom</template>
      </div>
    </main>

    <aside v-if="session.rightPanelOpen" class="panel right-panel">
      <template v-if="session.mode === 'terrain' && !lightingPanelOpen">
        <div class="panel-heading"><div><strong>Terrain</strong><small>Painting-compatible cells</small></div></div>
        <section>
          <label>Action</label>
          <div class="segmented"><button :class="{ active: session.terrainAction === 'place' }" @click="session.terrainAction = 'place'">Place</button><button :class="{ active: session.terrainAction === 'erase' }" @click="session.terrainAction = 'erase'">Erase</button></div>
          <label>Operation</label>
          <div class="terrain-operation-buttons">
            <button :class="{ active: session.terrainOperation === 'brush' }" title="Continuous grid brush" @click="session.terrainOperation = 'brush'">🖌</button>
            <button :class="{ active: session.terrainOperation === 'rectangle' }" title="Filled rectangle" @click="session.terrainOperation = 'rectangle'">▣</button>
          </div>
          <label>Work Plane</label>
          <div class="terrain-axis-buttons">
            <button v-for="axis in (['x', 'y', 'z'] as const)" :key="axis" :class="{ active: session.terrainAxis === axis }" :title="`${axis.toUpperCase()} work plane`" @click="session.terrainAxis = axis">{{ axis.toUpperCase() }}</button>
          </div>
          <label>Tile</label>
          <div class="terrain-tools">
            <button v-for="kind in (['block', 'slope', 'corner-slope'] as const)" :key="kind" class="terrain-tool" :class="{ active: session.terrainKind === kind }" :title="kind" @click="selectTerrainKind(kind)">
              <svg v-if="kind === 'block'" class="tile-icon-svg" viewBox="0 0 48 36" aria-hidden="true">
                <polygon class="tile-icon-top" points="14,12 24,6 34,12 24,18" /><polygon class="tile-icon-left" points="14,12 24,18 24,30 14,24" /><polygon class="tile-icon-right" points="24,18 34,12 34,24 24,30" /><polyline class="tile-icon-line" points="14,12 24,18 34,12 24,6 14,12" /><polyline class="tile-icon-line" points="14,24 24,30 34,24" /><line class="tile-icon-line" x1="14" y1="12" x2="14" y2="24" /><line class="tile-icon-line" x1="24" y1="18" x2="24" y2="30" /><line class="tile-icon-line" x1="34" y1="12" x2="34" y2="24" />
              </svg>
              <svg v-else-if="kind === 'slope'" class="tile-icon-svg" viewBox="0 0 48 36" aria-hidden="true">
                <polygon class="tile-icon-left" points="14,12 24,30 14,24" /><polygon class="tile-icon-right" points="24,6 34,24 24,30" /><polygon class="tile-icon-top" points="14,12 24,6 34,24 24,30" /><line class="tile-icon-line" x1="14" y1="12" x2="24" y2="6" /><line class="tile-icon-line" x1="14" y1="12" x2="24" y2="30" /><line class="tile-icon-line" x1="24" y1="6" x2="34" y2="24" /><line class="tile-icon-line" x1="14" y1="24" x2="24" y2="30" /><line class="tile-icon-line" x1="14" y1="12" x2="14" y2="24" />
              </svg>
              <svg v-else class="tile-icon-svg" viewBox="0 0 48 36" aria-hidden="true">
                <polygon class="tile-icon-left" points="24,6 14,24 24,30" /><polygon class="tile-icon-right" points="24,6 24,30 34,24" /><polyline class="tile-icon-line" points="14,24 24,30 34,24" /><line class="tile-icon-line" x1="24" y1="6" x2="14" y2="24" /><line class="tile-icon-line" x1="24" y1="6" x2="24" y2="30" /><line class="tile-icon-line" x1="24" y1="6" x2="34" y2="24" />
              </svg>
            </button>
          </div>
          <label>Direction</label>
          <div class="terrain-direction-pad" aria-label="Terrain direction">
            <button class="north" :class="{ active: session.terrainRotation === 0 }" title="North (−Z)" @click="selectTerrainRotation(0)">↑</button>
            <button class="west" :class="{ active: session.terrainRotation === 270 }" title="West (−X)" @click="selectTerrainRotation(270)">←</button>
            <button class="east" :class="{ active: session.terrainRotation === 90 }" title="East (+X)" @click="selectTerrainRotation(90)">→</button>
            <button class="south" :class="{ active: session.terrainRotation === 180 }" title="South (+Z)" @click="selectTerrainRotation(180)">↓</button>
          </div>
          <label>Fixed PICO-8 Color</label>
          <div class="pico-palette"><button v-for="color in PICO_8_COLORS" :key="color.id" :class="{ active: session.terrainColor === color.id }" :style="{ background: color.hex }" :title="`PICO-8 ${color.label}`" @click="selectTerrainColor(color.id)" /></div>
          <p class="note">Terrain uses only the fixed PICO-8 16-color set. Pencil edits; fingers always navigate.</p>
          <div class="viewport-guide-options">
            <strong>Viewport Guides</strong>
            <label class="check-row"><input v-model="session.showTerrainEdges" type="checkbox" /> Show tile edges</label>
            <label class="check-row"><input v-model="session.showInfiniteGrid" type="checkbox" /> Show infinite grid</label>
            <label class="check-row"><input v-model="session.showAxes" type="checkbox" /> Show coordinate axes</label>
          </div>
        </section>
      </template>

      <template v-else-if="lightingPanelOpen">
        <div class="panel-heading">
          <div><strong>Preview Lighting</strong><small>Painting Global Lighting</small></div>
          <button class="lighting-reset-button" title="Restore all current Painting lighting values" @click="resetLightingToPainting">Reset</button>
        </div>
        <section v-if="document" class="lighting-section">
          <div class="viewport-guide-options">
            <strong>Viewport Guides</strong>
            <label class="check-row"><input v-model="session.showTerrainEdges" type="checkbox" /> Show tile edges</label>
            <label class="check-row"><input v-model="session.showInfiniteGrid" type="checkbox" /> Show infinite grid</label>
            <label class="check-row"><input v-model="session.showAxes" type="checkbox" /> Show coordinate axes</label>
          </div>
          <div class="day-phase-control">
            <label>Day / Night <input aria-label="Day and night phase value" class="lighting-range-number" :value="document.previewLighting.dayNightPhase" type="number" min="-1" max="1" step="0.01" @change="setLightingRange('dayNightPhase', $event, 0, -1, 1)" /></label>
            <input aria-label="Day and night phase" :value="document.previewLighting.dayNightPhase" type="range" min="-1" max="1" step="0.01" @input="updateLighting('dayNightPhase', finiteInput($event, 0))" />
            <div class="phase-ticks"><span>−1 Midnight</span><span>0 Noon</span><span>+1 Midnight</span></div>
          </div>
          <label>Sun Path Tilt X <input aria-label="Sun path tilt X value" class="lighting-range-number" :value="document.previewLighting.sunPathTiltXDegrees" type="number" min="-89" max="89" step="0.1" @change="setLightingRange('sunPathTiltXDegrees', $event, -12, -89, 89)" /></label>
          <input :value="document.previewLighting.sunPathTiltXDegrees" type="range" min="-89" max="89" step="0.1" @input="updateLighting('sunPathTiltXDegrees', finiteInput($event, -12))" />
          <label>Path Offset Z <input aria-label="Sun path offset Z value" class="lighting-range-number" :value="document.previewLighting.sunPathOffsetZDegrees" type="number" min="-180" max="180" step="0.1" @change="setLightingRange('sunPathOffsetZDegrees', $event, 15, -180, 180)" /></label>
          <input :value="document.previewLighting.sunPathOffsetZDegrees" type="range" min="-180" max="180" step="0.1" @input="updateLighting('sunPathOffsetZDegrees', finiteInput($event, 15))" />
          <label class="lighting-number-row">Terrain Bounce <input type="number" min="0" max="20" step="0.05" :value="document.previewLighting.terrainBounceIntensity" @input="updateLighting('terrainBounceIntensity', finiteInput($event, 0.5))" /></label>
          <div class="lighting-profile-grid">
            <div class="lighting-profile-card">
              <strong>Day Profile</strong>
              <label>Main Color <input type="color" :value="document.previewLighting.day.main.color" @input="updateLighting('day.main.color', ($event.target as HTMLInputElement).value)" /></label>
              <label>Main Intensity <input type="number" min="0" max="50" step="0.1" :value="document.previewLighting.day.main.intensity" @input="updateLighting('day.main.intensity', finiteInput($event, 3.2))" /></label>
              <label>Ambient Color <input type="color" :value="document.previewLighting.day.ambient.color" @input="updateLighting('day.ambient.color', ($event.target as HTMLInputElement).value)" /></label>
              <label>Ambient Intensity <input type="number" min="0" max="50" step="0.01" :value="document.previewLighting.day.ambient.intensity" @input="updateLighting('day.ambient.intensity', finiteInput($event, 0.22))" /></label>
              <label>Background <input type="color" :value="document.previewLighting.day.backgroundColor" @input="updateLighting('day.backgroundColor', ($event.target as HTMLInputElement).value)" /></label>
              <label>Sky <input type="color" :value="document.previewLighting.day.skyColor" @input="updateLighting('day.skyColor', ($event.target as HTMLInputElement).value)" /></label>
              <label>Ground <input type="color" :value="document.previewLighting.day.groundColor" @input="updateLighting('day.groundColor', ($event.target as HTMLInputElement).value)" /></label>
              <label>Reflection <input type="number" min="0" max="20" step="0.01" :value="document.previewLighting.day.reflectionIntensity" @input="updateLighting('day.reflectionIntensity', finiteInput($event, 0.45))" /></label>
              <label>Bounce Brightness <input type="number" min="0" max="20" step="0.05" :value="document.previewLighting.day.terrainBounceBrightness" @input="updateLighting('day.terrainBounceBrightness', finiteInput($event, 1))" /></label>
            </div>
            <div class="lighting-profile-card">
              <strong>Night Profile</strong>
              <label>Main Color <input type="color" :value="document.previewLighting.night.main.color" @input="updateLighting('night.main.color', ($event.target as HTMLInputElement).value)" /></label>
              <label>Main Intensity <input type="number" min="0" max="50" step="0.1" :value="document.previewLighting.night.main.intensity" @input="updateLighting('night.main.intensity', finiteInput($event, 0.8))" /></label>
              <label>Ambient Color <input type="color" :value="document.previewLighting.night.ambient.color" @input="updateLighting('night.ambient.color', ($event.target as HTMLInputElement).value)" /></label>
              <label>Ambient Intensity <input type="number" min="0" max="50" step="0.01" :value="document.previewLighting.night.ambient.intensity" @input="updateLighting('night.ambient.intensity', finiteInput($event, 0.1))" /></label>
              <label>Background <input type="color" :value="document.previewLighting.night.backgroundColor" @input="updateLighting('night.backgroundColor', ($event.target as HTMLInputElement).value)" /></label>
              <label>Sky <input type="color" :value="document.previewLighting.night.skyColor" @input="updateLighting('night.skyColor', ($event.target as HTMLInputElement).value)" /></label>
              <label>Ground <input type="color" :value="document.previewLighting.night.groundColor" @input="updateLighting('night.groundColor', ($event.target as HTMLInputElement).value)" /></label>
              <label>Reflection <input type="number" min="0" max="20" step="0.01" :value="document.previewLighting.night.reflectionIntensity" @input="updateLighting('night.reflectionIntensity', finiteInput($event, 0.02))" /></label>
              <label>Bounce Brightness <input type="number" min="0" max="20" step="0.05" :value="document.previewLighting.night.terrainBounceBrightness" @input="updateLighting('night.terrainBounceBrightness', finiteInput($event, 0.1))" /></label>
            </div>
          </div>
          <p class="note">All values are saved with the work scene. Sky, Ground, Reflection and Bounce remain available for Painting compatibility; this Reference preview keeps PMREM and terrain bounce disabled. GTAO and PCF shadows stay off, while Ink keeps its dedicated hard shadow.</p>
        </section>
      </template>

      <template v-else-if="activeGroup && activeReference">
        <div class="panel-heading"><div><strong>{{ session.mode === 'shape' ? 'Shape Inspector' : 'Group Inspector' }}</strong><small>{{ activeGroup.name }}</small></div></div>
        <section>
          <template v-if="session.mode === 'select' || session.mode === 'shape'">
            <label>Transform Handle</label>
            <div class="segmented"><button :class="{ active: session.transformMode === 'translate' }" @click="session.transformMode = 'translate'">Move XYZ</button><button :class="{ active: session.transformMode === 'rotate' }" @click="session.transformMode = 'rotate'">{{ session.mode === 'select' ? 'Rotate Y' : 'Rotate XYZ' }}</button><button v-if="session.mode === 'shape' && activeShape?.kind !== 'plane'" :class="{ active: session.transformMode === 'resize' }" @click="session.transformMode = 'resize'">{{ activeShape?.kind === 'cuboid' ? 'Size XYZ' : activeShape?.kind === 'sphere' ? 'Radius' : activeShape?.kind === 'cylinder' ? 'Radius / Height' : 'Top / Height / Bottom' }}</button></div>
            <div class="segmented transform-space"><button :class="{ active: session.transformSpace === 'world' }" @click="session.transformSpace = 'world'">World</button><button :class="{ active: session.transformSpace === 'local' }" @click="session.transformSpace = 'local'">Local</button></div>
            <div class="snap-settings">
              <label class="check-row"><input v-model="session.snapEnabled" type="checkbox" /> Snap</label>
              <label>Translation Unit <input type="number" min="0.001" max="1000" step="0.01" :value="session.transformSnapUnit" @change="setTransformSnapUnit" /></label>
            </div>
          </template>
          <label>Group Name</label><input :value="activeGroup.name" @change="setGroupName" />
          <label>Anchor Position</label>
          <div class="vector-row"><label>X<input type="number" step="0.1" :value="activeReference.anchorPosition.x" @change="setReferencePosition('x', $event)" /></label><label>Y<input type="number" step="0.1" :value="activeReference.anchorPosition.y" @change="setReferencePosition('y', $event)" /></label><label>Z<input type="number" step="0.1" :value="activeReference.anchorPosition.z" @change="setReferencePosition('z', $event)" /></label></div>
          <label>Placement Rotation</label><select :value="activeReference.rotation" @change="setReferenceRotation"><option :value="0">0°</option><option :value="90">90°</option><option :value="180">180°</option><option :value="270">270°</option></select>
        </section>
        <section v-if="activeShape && session.mode === 'shape'" class="shape-inspector">
          <div class="subheading"><span>{{ activeShape.kind }} Shape</span></div>
          <label>Position</label>
          <div class="vector-row"><label>X<input type="number" step="0.1" :value="activeShape.position.x" @change="setShapeVector('position', 'x', $event)" /></label><label>Y<input type="number" step="0.1" :value="activeShape.position.y" @change="setShapeVector('position', 'y', $event)" /></label><label>Z<input type="number" step="0.1" :value="activeShape.position.z" @change="setShapeVector('position', 'z', $event)" /></label></div>
          <label>Rotation</label>
          <div class="vector-row"><label>X<input type="number" step="1" :value="degrees(activeShape.rotation.x)" @change="setShapeVector('rotation', 'x', $event)" /></label><label>Y<input type="number" step="1" :value="degrees(activeShape.rotation.y)" @change="setShapeVector('rotation', 'y', $event)" /></label><label>Z<input type="number" step="1" :value="degrees(activeShape.rotation.z)" @change="setShapeVector('rotation', 'z', $event)" /></label></div>
          <template v-if="activeShape.kind === 'cuboid'">
            <label>Size</label><div class="vector-row"><label>X<input type="number" min="0.05" step="0.1" :value="activeShape.size.x" @change="setShapeSize('x', $event)" /></label><label>Y<input type="number" min="0.05" step="0.1" :value="activeShape.size.y" @change="setShapeSize('y', $event)" /></label><label>Z<input type="number" min="0.05" step="0.1" :value="activeShape.size.z" @change="setShapeSize('z', $event)" /></label></div>
          </template>
          <template v-else-if="activeShape.kind === 'sphere'"><label>Radius</label><input type="number" min="0.05" step="0.1" :value="activeShape.radius" @change="setShapeRadius" /></template>
          <template v-else-if="activeShape.kind === 'cylinder'"><label>Dimensions</label><div class="vector-row"><label>Radius<input type="number" min="0.05" step="0.1" :value="activeShape.radius" @change="setCylinderDimension('radius', $event)" /></label><label>Height<input type="number" min="0.05" step="0.1" :value="activeShape.height" @change="setCylinderDimension('height', $event)" /></label></div></template>
          <template v-else-if="activeShape.kind === 'frustum'"><label>Dimensions</label><div class="vector-row"><label>Top<input type="number" min="0.05" step="0.1" :value="activeShape.topSize" @change="setFrustumDimension('topSize', $event)" /></label><label>Bottom<input type="number" min="0.05" step="0.1" :value="activeShape.bottomSize" @change="setFrustumDimension('bottomSize', $event)" /></label><label>Height<input type="number" min="0.05" step="0.1" :value="activeShape.height" @change="setFrustumDimension('height', $event)" /></label></div></template>
          <fieldset v-if="activeSurfaceOutline" class="surface-outline-settings">
            <legend>Surface Outline</legend>
            <label class="checkbox-label"><input :checked="activeSurfaceOutline.enabled" type="checkbox" @change="setSurfaceOutlineEnabled" /> Enabled</label>
            <template v-if="activeSurfaceOutline.enabled">
              <label>Width
                <span class="range-input-row">
                  <input :value="activeSurfaceOutline.width" type="range" min="0.001" max="1" step="0.001" @input="setSurfaceOutlineWidth" />
                  <input aria-label="Surface outline width" class="precision-number" :value="activeSurfaceOutline.width" type="number" min="0.001" max="1" step="0.001" @change="setSurfaceOutlineWidth" />
                </span>
              </label>
            </template>
            <p class="note">This camera-facing Ribbon uses a world-unit width and is clipped to opaque Fill pixels. It does not enter Ink hard shadows.</p>
          </fieldset>
          <p class="note">Shape transforms use source-local coordinates. Ribbon width remains in world units.</p>
        </section>
      </template>
      <div v-else class="empty-state">Create or select an Ink Group.</div>
    </aside>

    <footer v-if="session.mode === 'draw'" class="tooltray">
      <div class="tool-group tool-tabs">
        <button :class="{ active: session.drawTool === 'outline' }" @click="session.drawTool = 'outline'">Outline</button>
        <button :class="{ active: session.drawTool === 'outline-eraser' }" @click="session.drawTool = 'outline-eraser'">Line Erase</button>
        <button :class="{ active: session.drawTool === 'fill-brush' }" @click="session.drawTool = 'fill-brush'">Fill Paint</button>
        <button :class="{ active: session.drawTool === 'fill-eraser' }" @click="session.drawTool = 'fill-eraser'">Fill Erase</button>
        <button :class="{ active: session.drawTool === 'fill-bucket' }" @click="session.drawTool = 'fill-bucket'">Bucket</button>
        <button :class="{ active: session.drawTool === 'picker' }" @click="session.drawTool = 'picker'">Picker</button>
      </div>
      <div class="tool-group palette-row">
        <button v-for="(color, index) in session.palette" :key="`${color}-${index}`" class="ink-swatch" :style="{ background: color }" :title="`Use ${color}`" :aria-label="`Use palette color ${color}`" @click="usePaletteColor(color)" />
        <button class="small-button" title="Add current color" @click="addPaletteColor">＋</button>
        <button class="small-button" title="Edit and reorder palette" :class="{ active: paletteEditing }" @click="paletteEditing = !paletteEditing">✎</button>
      </div>
      <div class="tool-group tool-options">
        <label class="color-field"><span>Color</span><input v-if="session.drawTool === 'outline' || session.drawTool === 'outline-eraser'" v-model="session.outlineColor" type="color" /><input v-else v-model="session.fillColor" type="color" /></label>
        <label v-if="session.drawTool === 'outline'">Width <span class="range-input-row"><input v-model.number="session.outlineWidth" type="range" min="0.005" max="0.5" step="0.005" /><input aria-label="Outline width" class="precision-number" :value="session.outlineWidth" type="number" min="0.005" max="0.5" step="0.005" @change="setSessionRange('outlineWidth', $event, 0.005, 0.5)" /></span></label>
        <label v-else-if="session.drawTool === 'outline-eraser'">Width <span class="range-input-row"><input v-model.number="session.outlineEraserWidth" type="range" min="0.01" max="1" step="0.01" /><input aria-label="Outline eraser width" class="precision-number" :value="session.outlineEraserWidth" type="number" min="0.01" max="1" step="0.01" @change="setSessionRange('outlineEraserWidth', $event, 0.01, 1)" /></span></label>
        <label v-else>Size <span class="range-input-row"><input v-model.number="session.fillBrushSize" type="range" min="0.02" max="1" step="0.01" /><input aria-label="Fill brush size" class="precision-number" :value="session.fillBrushSize" type="number" min="0.02" max="1" step="0.01" @change="setSessionRange('fillBrushSize', $event, 0.02, 1)" /></span></label>
        <div v-if="session.drawTool === 'fill-brush' || session.drawTool === 'fill-eraser'" class="segmented compact"><button :class="{ active: session.fillBrushShape === 'circle' }" @click="session.fillBrushShape = 'circle'">●</button><button :class="{ active: session.fillBrushShape === 'square' }" @click="session.fillBrushShape = 'square'">■</button></div>
        <button class="toggle" :class="{ active: session.pressureEnabled }" title="Use Apple Pencil pressure for new outline points" @click="session.pressureEnabled = !session.pressureEnabled">Pressure {{ session.pressureEnabled ? 'On' : 'Off' }}</button>
        <button v-if="session.drawTool === 'outline'" class="toggle" :class="{ active: session.straightLineEnabled }" @click="session.straightLineEnabled = !session.straightLineEnabled">Straight {{ session.straightLineEnabled ? 'On' : 'Off' }}</button>
      </div>
      <section v-if="paletteEditing" class="palette-editor" aria-label="Palette editor">
        <header><strong>Edit Palette</strong><button @click="paletteEditing = false">Done</button></header>
        <div class="palette-editor-list">
          <div v-for="(color, index) in session.palette" :key="`edit-${index}`" class="palette-editor-row">
            <input type="color" :value="color" :aria-label="`Edit palette color ${index + 1}`" @input="setPaletteColor(index, $event)" />
            <button :disabled="index === 0" title="Move left" @click="movePaletteColor(index, -1)">←</button>
            <button :disabled="index === session.palette.length - 1" title="Move right" @click="movePaletteColor(index, 1)">→</button>
            <button class="palette-delete" title="Remove color" @click="removePaletteColor(index)">⌫</button>
          </div>
        </div>
      </section>
    </footer>

    <div v-if="message" class="toast" :class="message.tone">{{ message.text }}</div>
    <div v-if="loading" class="loading-cover"><div class="studio-mark">墨</div><strong>Opening offline workspace…</strong></div>
  </div>
</template>
