import type {
  CompiledInkShape,
  InkGroupData,
  InkShape,
  InkVisualFootprint,
} from '../domain/ink/ink';

/** Author data retained by the compiler Worker; no GPU-ready arrays are copied here. */
export type InkCompilerGroupSource = Pick<InkGroupData, 'id' | 'name' | 'anchorPosition' | 'placementRotation' | 'shapes'>;
export type InkCompiledShapeMetadata = Pick<CompiledInkShape, 'shapeId' | 'sourceHash' | 'ribbonSourceHash'>;

export type InkCompileRequest =
  | {
      type: 'initialize-group';
      assetId: string;
      group: InkCompilerGroupSource;
      compiledShapes: InkCompiledShapeMetadata[];
    }
  | {
      type: 'compile-shape';
      requestId: number;
      assetId: string;
      shape: InkShape;
    };

export type InkCompileResponse =
  | {
      type: 'compiled-shape';
      requestId: number;
      assetId: string;
      shapeId: string;
      compiledShape: CompiledInkShape;
      groupSourceHash: string;
      visualFootprint: InkVisualFootprint;
    }
  | {
      type: 'compile-error';
      requestId: number;
      assetId: string;
      error: string;
    };
