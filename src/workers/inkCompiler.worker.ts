import {
  calculateInkVisualFootprint,
  compileInkShape,
  hashInkGroupSource,
  hashInkShapeSource,
  type CompiledInkShape,
} from '../domain/ink/ink';
import type {
  InkCompileRequest,
  InkCompileResponse,
  InkCompiledShapeMetadata,
  InkCompilerGroupSource,
} from './inkCompilerMessages';

type WorkerGroupState = {
  group: InkCompilerGroupSource;
  metadataByShapeId: Map<string, InkCompiledShapeMetadata>;
  compiledByShapeId: Map<string, CompiledInkShape>;
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<InkCompileRequest>) => void) | null;
  postMessage: (message: InkCompileResponse) => void;
};

const workerScope = self as unknown as WorkerScope;
const groups = new Map<string, WorkerGroupState>();

workerScope.onmessage = (event): void => {
  const request = event.data;
  if (request.type === 'initialize-group') {
    groups.set(request.assetId, {
      group: request.group,
      metadataByShapeId: new Map(request.compiledShapes.map((shape) => [shape.shapeId, shape])),
      compiledByShapeId: new Map(),
    });
    return;
  }
  try {
    const state = groups.get(request.assetId);
    if (!state) throw new Error('The Ink compiler has not received this Group source.');
    const shapeIndex = state.group.shapes.findIndex((shape) => shape.id === request.shape.id);
    if (shapeIndex < 0) throw new Error('The changed Ink Shape is not present in the compiler source.');
    const shapes = [...state.group.shapes];
    shapes[shapeIndex] = request.shape;
    state.group = { ...state.group, shapes };

    // The first edit after opening may need one Ribbon rebuild for this Shape.
    // Subsequent Fill/surface-outline edits reuse the Worker-owned Ribbon alone.
    const compiledShape = compileInkShape(
      request.shape,
      hashInkShapeSource(request.shape),
      state.compiledByShapeId.get(request.shape.id),
    );
    state.compiledByShapeId.set(request.shape.id, compiledShape);
    state.metadataByShapeId.set(request.shape.id, {
      shapeId: compiledShape.shapeId,
      sourceHash: compiledShape.sourceHash,
      ribbonSourceHash: compiledShape.ribbonSourceHash,
    });

    const compiledShapes = state.group.shapes.map((shape) => state.metadataByShapeId.get(shape.id) ?? {
      shapeId: shape.id,
      sourceHash: hashInkShapeSource(shape),
      ribbonSourceHash: '',
    });
    workerScope.postMessage({
      type: 'compiled-shape',
      requestId: request.requestId,
      assetId: request.assetId,
      shapeId: request.shape.id,
      compiledShape,
      groupSourceHash: hashInkGroupSource(state.group, compiledShapes),
      visualFootprint: calculateInkVisualFootprint(state.group),
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
