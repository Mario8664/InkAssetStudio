import { describe, expect, it } from 'vitest';
import { createInkOutlineStroke, createInkPlaneShape, getCameraFacingInkPlaneRotation } from '../src/domain/ink/ink';
import { chooseInkFallbackPlane, eraseInkOutline, resolveInkGesturePoint } from '../src/editor/InkEditorController';
import { closestRayLineParameter } from '../src/editor/PencilTransformController';
import { PencilPresenceTracker, canNavigateWithFinger, isApplePencilPointer, isFingerNavigationPointer } from '../src/editor/pointerInput';
import { Euler, Quaternion, Vector3 } from 'three';

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

  it('keeps an infinite Plane fallback only until the gesture reaches a non-Plane Shape', () => {
    const active = { referenceId: 'reference-active', shapeId: 'plane-active' };
    expect(chooseInkFallbackPlane(null, active)).toEqual(active);
    expect(chooseInkFallbackPlane({ referenceId: 'reference-a', shapeId: 'plane-a', shapeKind: 'plane' }, active)).toEqual({
      referenceId: 'reference-a',
      shapeId: 'plane-a',
    });
    expect(chooseInkFallbackPlane({ referenceId: 'reference-a', shapeId: 'box-a', shapeKind: 'cuboid' }, active)).toBeNull();
  });

  it('creates a Camera Plane in Group-local space while preserving the camera world orientation', () => {
    const camera = new Quaternion().setFromEuler(new Euler(-0.35, 0.7, 0.08, 'YXZ'));
    const local = getCameraFacingInkPlaneRotation(camera, 90);
    const group = new Quaternion().setFromEuler(new Euler(0, Math.PI * 0.5, 0, 'YXZ'));
    const reconstructed = group.multiply(new Quaternion().setFromEuler(new Euler(local.x, local.y, local.z, 'YXZ')));
    expect(Math.abs(reconstructed.dot(camera))).toBeCloseTo(1, 6);
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

  it('locks finger navigation while a Pencil hovers or draws in the viewport', () => {
    const pencil = new PencilPresenceTracker();
    const finger = { pointerType: 'touch' } as PointerEvent;
    const penHover = { pointerId: 7, pointerType: 'pen', type: 'pointerenter' } as PointerEvent;

    expect(canNavigateWithFinger(finger, pencil.isPresent)).toBe(true);
    pencil.observe(penHover);
    expect(pencil.isPresent).toBe(true);
    expect(canNavigateWithFinger(finger, pencil.isPresent)).toBe(false);

    pencil.observe({ ...penHover, type: 'pointerdown' } as PointerEvent);
    pencil.observe({ ...penHover, type: 'pointerup' } as PointerEvent);
    expect(pencil.isPresent).toBe(true);
    expect(canNavigateWithFinger(finger, pencil.isPresent)).toBe(false);

    pencil.observe({ ...penHover, type: 'pointerleave' } as PointerEvent);
    expect(pencil.isPresent).toBe(false);
    expect(canNavigateWithFinger(finger, pencil.isPresent)).toBe(true);
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
