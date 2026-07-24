import { describe, expect, it } from 'vitest';
import { createInkOutlineStroke, createInkPlaneShape } from '../src/domain/ink/ink';
import { eraseInkOutline } from '../src/editor/InkEditorController';

describe('outline eraser', () => {
  it('uses the complete eraser path and preserves editable stroke fragments', () => {
    const shape = createInkPlaneShape('camera', { x: 0, y: 0, z: 0 });
    const stroke = createInkOutlineStroke([
      { x: -1, y: 0, pressure: 1 },
      { x: -0.5, y: 0, pressure: 1 },
      { x: 0, y: 0, pressure: 1 },
      { x: 0.5, y: 0, pressure: 1 },
      { x: 1, y: 0, pressure: 1 },
    ], '#000000', 0.05);
    const erased = eraseInkOutline({ ...shape, strokes: [stroke] }, [
      { x: 0, y: -0.5, pressure: 1 },
      { x: 0, y: 0.5, pressure: 1 },
    ], 0.2);

    expect(erased.strokes).toHaveLength(2);
    expect(erased.strokes.map((entry) => entry.points.length)).toEqual([2, 2]);
    expect(erased.strokes.flatMap((entry) => entry.points).every((point) => 'x' in point && point.x !== 0)).toBe(true);
  });
});
