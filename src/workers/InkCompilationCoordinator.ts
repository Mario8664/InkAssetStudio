import type { CompiledInkShape, InkGroupData, InkShape } from '../domain/ink/ink';
import type { WorkspaceStore } from '../domain/workspace/WorkspaceStore';
import type { InkCompileRequest, InkCompileResponse, InkCompilerGroupSource } from './inkCompilerMessages';

type PendingCompile = {
  assetId: string;
  shape: InkShape;
};

/**
 * Owns one compiler Worker. A stroke sends only its changed author Shape;
 * sibling Shapes and their compiled GPU payloads stay in the main document.
 */
export class InkCompilationCoordinator {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingCompile>();
  private readonly pendingRequestByShape = new Map<string, number>();
  private readonly latestShapeByKey = new Map<string, InkShape>();
  private readonly failedShapeByKey = new Map<string, InkShape>();
  private readonly observedGroups = new Map<string, InkGroupData>();
  private readonly initializedAssets = new Set<string>();
  private readonly unsubscribe: () => void;
  private nextRequestId = 1;
  private disposed = false;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly onError: (message: string) => void,
  ) {
    this.worker = new Worker(new URL('./inkCompiler.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.unsubscribe = store.subscribe(() => this.observeDocument());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.terminate();
    this.pending.clear();
    this.pendingRequestByShape.clear();
    this.latestShapeByKey.clear();
    this.failedShapeByKey.clear();
    this.observedGroups.clear();
    this.initializedAssets.clear();
  }

  private observeDocument(): void {
    if (this.disposed) return;
    const nextAssetIds = new Set<string>();
    for (const embedded of this.store.getDocument().ink.embeddedAssets) {
      nextAssetIds.add(embedded.assetId);
      const previous = this.observedGroups.get(embedded.assetId);
      if (!previous || shouldReinitializeWorkerGroup(previous, embedded.group)) {
        this.initializeGroup(embedded.assetId, embedded.group);
        this.observedGroups.set(embedded.assetId, embedded.group);
        continue;
      }
      if (previous !== embedded.group) {
        for (const shape of getChangedShapes(previous, embedded.group)) {
          const key = shapeKey(embedded.assetId, shape.id);
          this.latestShapeByKey.set(key, shape);
          if (this.failedShapeByKey.get(key) !== shape) this.dispatchLatestShape(embedded.assetId, shape.id);
        }
      }
      this.observedGroups.set(embedded.assetId, embedded.group);
    }
    for (const assetId of this.observedGroups.keys()) {
      if (nextAssetIds.has(assetId)) continue;
      this.observedGroups.delete(assetId);
      this.initializedAssets.delete(assetId);
    }
  }

  private initializeGroup(assetId: string, group: InkGroupData): void {
    const source: InkCompilerGroupSource = {
      id: group.id,
      name: group.name,
      anchorPosition: group.anchorPosition,
      ...(group.placementRotation === undefined ? {} : { placementRotation: group.placementRotation }),
      shapes: group.shapes,
    };
    const request: InkCompileRequest = {
      type: 'initialize-group',
      assetId,
      group: source,
      // Metadata lets the Worker build a correct Group hash without copying
      // any existing Ribbon or Fill buffers across the message boundary.
      compiledShapes: group.compiled.shapes.map((shape) => ({
        shapeId: shape.shapeId,
        sourceHash: shape.sourceHash,
        ribbonSourceHash: shape.ribbonSourceHash,
      })),
    };
    this.worker.postMessage(request);
    this.initializedAssets.add(assetId);
  }

  private dispatchLatestShape(assetId: string, shapeId: string): void {
    const key = shapeKey(assetId, shapeId);
    if (!this.initializedAssets.has(assetId) || this.pendingRequestByShape.has(key)) return;
    const shape = this.latestShapeByKey.get(key);
    if (!shape) return;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.pending.set(requestId, { assetId, shape });
    this.pendingRequestByShape.set(key, requestId);
    const request: InkCompileRequest = { type: 'compile-shape', requestId, assetId, shape };
    this.worker.postMessage(request);
  }

  private readonly handleMessage = (event: MessageEvent<InkCompileResponse>): void => {
    const response = event.data;
    if (response.type === 'compile-error') {
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      const key = shapeKey(pending.assetId, pending.shape.id);
      this.pendingRequestByShape.delete(key);
      this.failedShapeByKey.set(key, pending.shape);
      this.onError(`Ink compilation failed: ${response.error}`);
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.assetId !== response.assetId || pending.shape.id !== response.shapeId) return;
    this.pending.delete(response.requestId);
    const key = shapeKey(pending.assetId, pending.shape.id);
    this.pendingRequestByShape.delete(key);
    this.failedShapeByKey.delete(key);
    this.store.reconcileDerived((document) => {
      const embedded = document.ink.embeddedAssets.find((entry) => entry.assetId === pending.assetId);
      const currentShape = embedded?.group.shapes.find((shape) => shape.id === pending.shape.id);
      if (!embedded || currentShape !== pending.shape) return document;
      const compiledShapes: CompiledInkShape[] = [];
      for (const shape of embedded.group.shapes) {
        const compiled = shape.id === response.shapeId
          ? response.compiledShape
          : getCompiledShape(embedded.group, shape.id);
        if (!compiled) return document;
        compiledShapes.push(compiled);
      }
      const group: InkGroupData = {
        ...embedded.group,
        visualFootprint: response.visualFootprint,
        compiled: {
          ...embedded.group.compiled,
          sourceHash: response.groupSourceHash,
          shapes: compiledShapes,
        },
      };
      return {
        ...document,
        ink: {
          ...document.ink,
          embeddedAssets: document.ink.embeddedAssets.map((entry) => entry.assetId === pending.assetId
            ? { ...entry, group }
            : entry),
        },
      };
    });
    if (this.latestShapeByKey.get(key) === pending.shape) this.latestShapeByKey.delete(key);
    this.dispatchLatestShape(pending.assetId, pending.shape.id);
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    this.onError(`Ink compiler Worker stopped: ${event.message || 'unknown error'}`);
  };
}

function getChangedShapes(previous: InkGroupData, next: InkGroupData): InkShape[] {
  const priorById = new Map(previous.shapes.map((shape) => [shape.id, shape]));
  return next.shapes.filter((shape) => priorById.get(shape.id) !== shape);
}

function shouldReinitializeWorkerGroup(previous: InkGroupData, next: InkGroupData): boolean {
  if (previous.shapes.length !== next.shapes.length) return true;
  return next.shapes.some((shape) => !previous.shapes.some((candidate) => candidate.id === shape.id));
}

function getCompiledShape(group: InkGroupData, shapeId: string): CompiledInkShape | undefined {
  return group.compiled.shapes.find((shape) => shape.shapeId === shapeId);
}

function shapeKey(assetId: string, shapeId: string): string { return `${assetId}:${shapeId}`; }
