import { describe, expect, it } from 'vitest';
import { createInkOutlineStroke, createInkPlaneShape } from '../src/domain/ink/ink';
import { eraseInkOutline, resolveInkGesturePoint } from '../src/editor/InkEditorController';
import { closestRayLineParameter } from '../src/editor/PencilTransformController';
import { isApplePencilPointer, isFingerNavigationPointer } from '../src/editor/pointerInput';
import { Vector3 } from 'three';

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

describe('Ink gesture sampling', () => {
  it('uses streaming stabilization while moving but preserves the exact Pencil-up endpoint', () => {
    const shape = createInkPlaneShape('camera', { x: 0, y: 0, z: 0 });
    const previous = { x: 0, y: 0, pressure: 0.25 };
    const raw = { x: 1, y: -0.5, pressure: 0.8 };
    const moving = resolveInkGesturePoint(shape, previous, raw, 2, 16, false);
    const released = resolveInkGesturePoint(shape, previous, raw, 2, 16, true);

    expect(moving).not.toEqual(raw);
    expect(released).toBe(raw);
  });
});

describe('iPad editor input boundaries', () => {
  it('accepts only Pencil for authoring and only touch for navigation', () => {
    expect(isApplePencilPointer({ pointerType: 'pen' } as PointerEvent)).toBe(true);
    expect(isApplePencilPointer({ pointerType: 'touch' } as PointerEvent)).toBe(false);
    expect(isApplePencilPointer({ pointerType: 'mouse' } as PointerEvent)).toBe(false);
    expect(isFingerNavigationPointer({ pointerType: 'touch' } as PointerEvent)).toBe(true);
    expect(isFingerNavigationPointer({ pointerType: 'pen' } as PointerEvent)).toBe(false);
  });

  it('projects intrinsic size drags onto the selected Shape axis', () => {
    const parameter = closestRayLineParameter(
      new Vector3(2, 3, 5),
      new Vector3(0, 0, -1),
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
    );
    expect(parameter).toBeCloseTo(2);
  });
});
