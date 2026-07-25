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

  it('migrates the retired Navigate and Layer session into Pencil-first defaults', () => {
    const session = normalizeStudioEditorSession({
      mode: 'navigate',
      terrainLayer: 12,
      terrainOperation: 'rectangle',
      terrainAxis: 'z',
      snapEnabled: true,
      transformSnapUnit: 0.25,
    });
    expect(session.mode).toBe('draw');
    expect('terrainLayer' in session).toBe(false);
    expect(session.terrainOperation).toBe('rectangle');
    expect(session.terrainAxis).toBe('z');
    expect(session.snapEnabled).toBe(true);
    expect(session.transformSnapUnit).toBe(0.25);
  });

  it('defaults Terrain to a horizontal brush and Painting translation snap unit', () => {
    const session = createStudioEditorSession();
    expect(session.terrainOperation).toBe('brush');
    expect(session.terrainAxis).toBe('y');
    expect(session.transformSnapUnit).toBe(0.5);
    expect(session.snapEnabled).toBe(false);
  });

  it('persists the Shape-only intrinsic size handle mode', () => {
    expect(normalizeStudioEditorSession({ transformMode: 'resize' }).transformMode).toBe('resize');
  });
});
