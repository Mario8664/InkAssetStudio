import type { InkGroupData } from '../domain/ink/ink';

export type InkCompileRequest = {
  type: 'compile-group';
  requestId: number;
  assetId: string;
  group: InkGroupData;
};

export type InkCompileResponse =
  | {
      type: 'compiled-group';
      requestId: number;
      assetId: string;
      group: InkGroupData;
    }
  | {
      type: 'compile-error';
      requestId: number;
      assetId: string;
      error: string;
    };
