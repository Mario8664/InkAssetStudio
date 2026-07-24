import { describe, expect, it } from 'vitest';
import { createStudioEditorSession, normalizeStudioEditorSession } from '../src/domain/workspace/session';

describe('Editor viewport session', () => {
  it('enables all three independent viewport guides by default', () => {
    const session = createStudioEditorSession();
    expect(session.showTerrainEdges).toBe(true);
    expect(session.showInfiniteGrid).toBe(true);
    expect(session.showAxes).toBe(true);
  });

  it('migrates the legacy local grid switch to tile edges only', () => {
    const session = normalizeStudioEditorSession({ showGrid: false });
    expect(session.showTerrainEdges).toBe(false);
    expect(session.showInfiniteGrid).toBe(true);
    expect(session.showAxes).toBe(true);
  });

  it('round-trips independent viewport guide choices', () => {
    const session = normalizeStudioEditorSession({
      showTerrainEdges: false,
      showInfiniteGrid: false,
      showAxes: true,
    });
    expect(session.showTerrainEdges).toBe(false);
    expect(session.showInfiniteGrid).toBe(false);
    expect(session.showAxes).toBe(true);
  });
});
