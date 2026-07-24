import { isInkCompiledCurrent, type InkGroupData } from '../domain/ink/ink';
import type { WorkspaceStore } from '../domain/workspace/WorkspaceStore';
import type { InkCompileRequest, InkCompileResponse } from './inkCompilerMessages';

type PendingCompile = {
  assetId: string;
  source: InkGroupData;
};

/** Owns one compiler Worker and reconciles derived payloads without adding Undo entries. */
export class InkCompilationCoordinator {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingCompile>();
  private readonly inFlightByAsset = new Map<string, number>();
  private readonly failedByAsset = new Map<string, InkGroupData>();
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
    this.unsubscribe = store.subscribe(() => this.queueStaleGroups());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.terminate();
    this.pending.clear();
    this.inFlightByAsset.clear();
    this.failedByAsset.clear();
  }

  private queueStaleGroups(): void {
    if (this.disposed) return;
    for (const embedded of this.store.getDocument().ink.embeddedAssets) {
      if (isInkCompiledCurrent(embedded.group)
        || this.inFlightByAsset.has(embedded.assetId)
        || this.failedByAsset.get(embedded.assetId) === embedded.group) continue;
      const requestId = this.nextRequestId;
      this.nextRequestId += 1;
      this.pending.set(requestId, { assetId: embedded.assetId, source: embedded.group });
      this.inFlightByAsset.set(embedded.assetId, requestId);
      const request: InkCompileRequest = {
        type: 'compile-group',
        requestId,
        assetId: embedded.assetId,
        group: embedded.group,
      };
      this.worker.postMessage(request);
    }
  }

  private readonly handleMessage = (event: MessageEvent<InkCompileResponse>): void => {
    const response = event.data;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    this.inFlightByAsset.delete(pending.assetId);
    if (response.type === 'compile-error') {
      this.failedByAsset.set(pending.assetId, pending.source);
      this.onError(`Ink compilation failed: ${response.error}`);
      this.queueStaleGroups();
      return;
    }
    if (!isInkCompiledCurrent(response.group)) {
      this.failedByAsset.set(pending.assetId, pending.source);
      this.onError('Ink compilation returned an invalid derived payload.');
      this.queueStaleGroups();
      return;
    }
    this.failedByAsset.delete(pending.assetId);
    this.store.reconcileDerived((document) => {
      const current = document.ink.embeddedAssets.find((embedded) => embedded.assetId === pending.assetId)?.group;
      if (current !== pending.source) return document;
      const embeddedAssets = document.ink.embeddedAssets.map((embedded) => embedded.assetId === pending.assetId
        ? { ...embedded, group: response.group }
        : embedded);
      return { ...document, ink: { ...document.ink, embeddedAssets } };
    });
    this.queueStaleGroups();
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    this.onError(`Ink compiler Worker stopped: ${event.message || 'unknown error'}`);
  };
}
