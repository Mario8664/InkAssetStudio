import { describe, expect, it } from 'vitest';
import { resolvePointerPressure } from '../src/editor/InkEditorController';
import { normalizeStudioEditorSession } from '../src/domain/workspace/session';

describe('Apple Pencil pressure option', () => {
  it('records pen pressure only while pressure is enabled', () => {
    expect(resolvePointerPressure({ pointerType: 'pen', pressure: 0.42 }, true)).toBe(0.42);
    expect(resolvePointerPressure({ pointerType: 'pen', pressure: 0.42 }, false)).toBe(1);
  });

  it('uses a stable pressure for mouse, touch, and empty pen samples', () => {
    expect(resolvePointerPressure({ pointerType: 'mouse', pressure: 0.5 }, true)).toBe(1);
    expect(resolvePointerPressure({ pointerType: 'touch', pressure: 0.7 }, true)).toBe(1);
    expect(resolvePointerPressure({ pointerType: 'pen', pressure: 0 }, true)).toBe(1);
  });

  it('recovers invalid local session values without changing the default pressure policy', () => {
    const session = normalizeStudioEditorSession({
      pressureEnabled: 'invalid',
      palette: ['#ff004d', 'bad-color'],
      terrainColor: 'not-pico-8',
      outlineWidth: Number.POSITIVE_INFINITY,
    });
    expect(session.pressureEnabled).toBe(true);
    expect(session.palette).toEqual(['#ff004d']);
    expect(session.terrainColor).toBe('white');
    expect(session.outlineWidth).toBeGreaterThan(0);
  });
});
