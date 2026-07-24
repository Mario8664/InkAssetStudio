import type { WorkspaceValidationResult } from '../domain/workspace/workspace';

type WorkspaceLoadRequest =
  | { operation: 'normalize'; value: unknown }
  | { operation: 'parse'; text: string };

export function normalizeStudioDocumentInWorker(value: unknown): Promise<WorkspaceValidationResult> {
  return runWorkspaceLoader({ operation: 'normalize', value });
}

export function parseStudioWorkFileInWorker(text: string): Promise<WorkspaceValidationResult> {
  return runWorkspaceLoader({ operation: 'parse', text });
}

function runWorkspaceLoader(request: WorkspaceLoadRequest): Promise<WorkspaceValidationResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./workspaceLoader.worker.ts', import.meta.url), { type: 'module' });
    const timeout = window.setTimeout(() => finish({ ok: false, error: 'Work-file validation timed out.' }), 60_000);
    const finish = (result: WorkspaceValidationResult): void => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve(result);
    };
    worker.addEventListener('message', (event: MessageEvent<WorkspaceValidationResult>) => finish(event.data), { once: true });
    worker.addEventListener('error', (event) => finish({ ok: false, error: event.message || 'Work-file validation Worker failed.' }), { once: true });
    worker.postMessage(request);
  });
}
