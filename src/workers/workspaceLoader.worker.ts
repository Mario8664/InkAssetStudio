import { normalizeStudioDocument, parseStudioWorkFile, type WorkspaceValidationResult } from '../domain/workspace/workspace';

type WorkspaceLoadRequest =
  | { operation: 'normalize'; value: unknown }
  | { operation: 'parse'; text: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkspaceLoadRequest>) => void) | null;
  postMessage: (message: WorkspaceValidationResult) => void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = (event): void => {
  try {
    const result = event.data.operation === 'parse'
      ? parseStudioWorkFile(event.data.text)
      : normalizeStudioDocument(event.data.value);
    workerScope.postMessage(result);
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to validate the work scene.',
    });
  }
};
