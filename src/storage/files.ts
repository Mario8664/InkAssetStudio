import {
  MAX_WORK_FILE_BYTES,
  MAX_WORK_FILE_SIZE_LABEL,
  serializeStudioDocument,
  type InkStudioWorkFile,
  type WorkspaceValidationResult,
} from '../domain/workspace/workspace';
import { parseStudioWorkFileInWorker } from '../workers/workspaceLoader';

export function downloadStudioDocument(document: InkStudioWorkFile): void {
  const blob = new Blob([serializeStudioDocument(document)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = `${sanitizeFileName(document.name)}.inkstudio-work.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function readStudioDocumentFile(file: File): Promise<WorkspaceValidationResult> {
  if (file.size > MAX_WORK_FILE_BYTES) return { ok: false, error: `The work file exceeds the ${MAX_WORK_FILE_SIZE_LABEL} safety limit.` };
  // Blob/File structured cloning is cheap. Reading the UTF-8 text and parsing
  // it inside the Worker keeps a large import off the interactive PWA thread.
  return parseStudioWorkFileInWorker(file);
}

function sanitizeFileName(name: string): string {
  const normalized = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '');
  return normalized || 'Untitled Ink Scene';
}
