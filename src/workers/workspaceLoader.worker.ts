import { normalizeStudioDocument, parseStudioWorkFile, type WorkspaceValidationResult } from '../domain/workspace/workspace';

type WorkspaceLoadRequest =
  | { operation: 'normalize'; value: unknown }
  | { operation: 'parse-file'; file: File };

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkspaceLoadRequest>) => void) | null;
  postMessage: (message: WorkspaceValidationResult) => void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = async (event): Promise<void> => {
  try {
    const result = event.data.operation === 'parse-file'
      ? parseStudioWorkFile(await event.data.file.text(), event.data.file.size)
      : normalizeStudioDocument(event.data.value);
    workerScope.postMessage(result);
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to validate the work scene.',
    });
  }
};
