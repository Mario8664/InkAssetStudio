import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import { SAVED_PAINTING_INK_APPEARANCE } from '../src/domain/workspace/inkAppearance';
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

  it('uses Painting saved non-TAA Ink appearance values as the Editor Session defaults', () => {
    const session = createStudioEditorSession();
    expect(session.inkAppearance).toEqual(SAVED_PAINTING_INK_APPEARANCE);
    expect(session.inkAppearance).not.toBe(SAVED_PAINTING_INK_APPEARANCE);
    expect(session.inkAppearance.watercolorFill).not.toBe(SAVED_PAINTING_INK_APPEARANCE.watercolorFill);
    expect(session.inkAppearance.watercolorFill.waterEdge).not.toBe(SAVED_PAINTING_INK_APPEARANCE.watercolorFill.waterEdge);
    expect(session.inkAppearance.watercolorFill.diffusion).not.toBe(SAVED_PAINTING_INK_APPEARANCE.watercolorFill.diffusion);
  });

  it('migrates an older session to the saved Watercolor defaults', () => {
    expect(normalizeStudioEditorSession({ mode: 'draw' }).inkAppearance).toEqual(SAVED_PAINTING_INK_APPEARANCE);
  });

  it('preserves an existing palette while adding Fill water defaults to an older session', () => {
    const session = normalizeStudioEditorSession({ palette: ['#123456', '#abcdef'] });
    expect(session.palette).toEqual(['#123456', '#abcdef']);
    expect(session.fillSoftRadius).toBe(0.05);
    expect(session.fillWaterOpacity).toBe(0.5);
  });

  it('normalizes the added Fill water tools and bounded session settings', () => {
    const session = normalizeStudioEditorSession({
      drawTool: 'fill-water-eraser',
      fillSoftRadius: 9,
      fillWaterOpacity: -1,
    });
    expect(session.drawTool).toBe('fill-water-eraser');
    expect(session.fillSoftRadius).toBe(1);
    expect(session.fillWaterOpacity).toBe(0);
  });

  it('normalizes the Source choice and clamps every bounded Watercolor setting', () => {
    const appearance = normalizeStudioEditorSession({
      inkAppearance: {
        appearance: 'source',
        crayonGrainDensity: 999,
        crayonMinimumOpacity: -2,
        watercolorFill: {
          noiseScale: 0,
          waterEdge: {
            enabled: false,
            width: 99,
            contrastThreshold: -1,
            edgeDarkening: 4,
            offsetStrength: -3,
          },
          diffusion: {
            enabled: false,
            softTailRadius: 99,
            colorMixRadius: -2,
            colorMixStrength: 9,
            interiorPigmentStrength: -1,
            interiorFadeColor: '#ABCDEF',
          },
        },
      },
    }).inkAppearance;
    expect(appearance).toEqual({
      appearance: 'source',
      crayonGrainDensity: 512,
      crayonMinimumOpacity: 0,
      watercolorFill: {
        noiseScale: 0.001,
        waterEdge: {
          enabled: false,
          width: 32,
          contrastThreshold: 0,
          edgeDarkening: 1,
          offsetStrength: 0,
        },
        diffusion: {
          enabled: false,
          softTailRadius: 16,
          colorMixRadius: 0,
          colorMixStrength: 1,
          interiorPigmentStrength: 0,
          interiorFadeColor: '#abcdef',
        },
      },
    });
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
    snapshot.inkAppearance.watercolorFill.waterEdge.width = 12;
    expect(session.inkAppearance.watercolorFill.waterEdge.width).toBe(4);
    expect(structuredClone(snapshot)).toEqual(snapshot);
  });
});
