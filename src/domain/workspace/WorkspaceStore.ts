import type { InkStudioWorkFile } from './workspace';

export type WorkspaceSnapshot = {
  document: InkStudioWorkFile;
  revision: number;
  savedRevision: number;
  exportedRevision: number;
  historyLabel: string | null;
  canUndo: boolean;
  canRedo: boolean;
};

type HistoryEntry = { label: string; document: InkStudioWorkFile };

export class WorkspaceStore {
  private document: InkStudioWorkFile;
  private revision = 0;
  private savedRevision = -1;
  private exportedRevision = -1;
  private historyLabel: string | null = null;
  private coalesced: { key: string; lastUpdatedAt: number } | null = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();

  constructor(document: InkStudioWorkFile) { this.document = document; }

  getDocument(): InkStudioWorkFile { return this.document; }
  getRevision(): number { return this.revision; }

  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  transact(label: string, update: (document: InkStudioWorkFile) => InkStudioWorkFile): boolean {
    const next = update(this.document);
    if (next === this.document) return false;
    this.coalesced = null;
    this.undoStack.push({ label, document: this.document });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.document = next;
    this.revision += 1;
    this.historyLabel = label;
    this.emit();
    return true;
  }

  /** Merges rapid updates from one slider or color well into one Undo entry. */
  transactCoalesced(key: string, label: string, update: (document: InkStudioWorkFile) => InkStudioWorkFile): boolean {
    const next = update(this.document);
    if (next === this.document) return false;
    const now = Date.now();
    const continuesPrevious = this.coalesced?.key === key && now - this.coalesced.lastUpdatedAt <= 1_000;
    if (!continuesPrevious) {
      this.undoStack.push({ label, document: this.document });
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    this.coalesced = { key, lastUpdatedAt: now };
    this.document = next;
    this.revision += 1;
    this.historyLabel = label;
    this.emit();
    return true;
  }

  replace(document: InkStudioWorkFile, label = 'Open work scene', hasExternalBackup = true): void {
    this.document = document;
    this.revision += 1;
    this.savedRevision = this.revision - 1;
    this.exportedRevision = hasExternalBackup ? this.revision : -1;
    this.historyLabel = label;
    this.coalesced = null;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /** Replaces derived caches without creating content history or dirty state. */
  reconcileDerived(update: (document: InkStudioWorkFile) => InkStudioWorkFile): boolean {
    const next = update(this.document);
    if (next === this.document) return false;
    this.document = next;
    this.emit();
    return true;
  }

  undo(): boolean {
    this.coalesced = null;
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push({ label: this.historyLabel ?? 'Edit', document: this.document });
    this.document = entry.document;
    this.revision += 1;
    this.historyLabel = `Undo ${entry.label}`;
    this.emit();
    return true;
  }

  redo(): boolean {
    this.coalesced = null;
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.undoStack.push({ label: this.historyLabel ?? 'Edit', document: this.document });
    this.document = entry.document;
    this.revision += 1;
    this.historyLabel = `Redo ${entry.label}`;
    this.emit();
    return true;
  }

  markSaved(revision = this.revision): void { this.savedRevision = Math.max(this.savedRevision, revision); this.emit(); }
  markExported(): void { this.exportedRevision = this.revision; this.emit(); }

  snapshot(): WorkspaceSnapshot {
    return {
      document: this.document,
      revision: this.revision,
      savedRevision: this.savedRevision,
      exportedRevision: this.exportedRevision,
      historyLabel: this.historyLabel,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
