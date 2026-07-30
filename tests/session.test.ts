import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import { cloneStudioEditorSession, createStudioEditorSession, normalizeStudioEditorSession } from '../src/domain/workspace/session';

describe('Editor viewport session', () => {
  it('enables reference terrain and all three independent viewport guides by default', () => {
    const session = createStudioEditorSession();
    expect(session.showReferenceTerrain).toBe(true);
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
      showReferenceTerrain: false,
      showTerrainEdges: false,
      showInfiniteGrid: false,
      showAxes: true,
    });
    expect(session.showReferenceTerrain).toBe(false);
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

  it('defaults Transform handles to World and persists Local with temporary drawing exclusions', () => {
    const defaults = createStudioEditorSession();
    expect(defaults.transformSpace).toBe('world');
    const session = normalizeStudioEditorSession({ transformSpace: 'local', excludedShapeIds: ['shape-a', 'shape-a', 7] });
    expect(session.transformSpace).toBe('local');
    expect(session.excludedShapeIds).toEqual(['shape-a']);
  });

  it('creates a structured-cloneable persistence snapshot from reactive session arrays', () => {
    const session = reactive(createStudioEditorSession());
    session.excludedShapeIds.push('shape-a');
    const snapshot = cloneStudioEditorSession(session);
    expect(snapshot.excludedShapeIds).toEqual(['shape-a']);
    expect(snapshot.excludedShapeIds).not.toBe(session.excludedShapeIds);
    expect(structuredClone(snapshot)).toEqual(snapshot);
  });
});
