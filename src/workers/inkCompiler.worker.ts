import { withCompiledInkGroup } from '../domain/ink/ink';
import type { InkCompileRequest, InkCompileResponse } from './inkCompilerMessages';

type WorkerScope = {
  onmessage: ((event: MessageEvent<InkCompileRequest>) => void) | null;
  postMessage: (message: InkCompileResponse) => void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = (event): void => {
  const request = event.data;
  if (request.type !== 'compile-group') return;
  try {
    const group = withCompiledInkGroup(request.group, request.group);
    workerScope.postMessage({
      type: 'compiled-group',
      requestId: request.requestId,
      assetId: request.assetId,
      group,
    });
  } catch (error) {
    workerScope.postMessage({
      type: 'compile-error',
      requestId: request.requestId,
      assetId: request.assetId,
      error: error instanceof Error ? error.message : 'Unknown Ink compiler error.',
    });
  }
};
