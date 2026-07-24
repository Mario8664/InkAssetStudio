import { MAX_WORK_FILE_BYTES, serializeStudioDocument, type InkStudioWorkFile, type WorkspaceValidationResult } from '../domain/workspace/workspace';
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
  if (file.size > MAX_WORK_FILE_BYTES) return { ok: false, error: 'The work file exceeds the 32 MB safety limit.' };
  return parseStudioWorkFileInWorker(await file.text());
}

function sanitizeFileName(name: string): string {
  const normalized = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '');
  return normalized || 'Untitled Ink Scene';
}
