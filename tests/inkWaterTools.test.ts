import { describe, expect, it } from 'vitest';
import {
  INK_FILL_COVERAGE_ALPHA_MIN,
  blurInkFill,
  bucketFillInkShape,
  compileInkFill,
  consumeInkFillWaterAlphaPatches,
  createInkFillWaterStrokeState,
  createInkCuboidShape,
  createInkPlaneShape,
  eraseInkFillWater,
  paintInkFill,
  paintInkFillWater,
  type InkShape,
} from '../src/domain/ink/ink';

const center = { x: 0, y: 0, pressure: 1 };

function createPaintedPlane(): InkShape {
  return paintInkFill(createInkPlaneShape('z', { x: 0, y: 0, z: 0 }), [center], '#29adff', 0.1, 'square');
}

function pixelAt(shape: InkShape, x = 0, y = 0): number[] {
  const surface = compileInkFill(shape).find((candidate) => candidate.id === 'plane');
  expect(surface).toBeDefined();
  const offset = ((y - surface!.minY) * surface!.width + x - surface!.minX) * 4;
  return surface!.rgba.slice(offset, offset + 4);
}

describe('Ink Fill water tools', () => {
  it('blurs only authored Fill RGB while retaining its opacity encoding', () => {
    const plane = createInkPlaneShape('z', { x: 0, y: 0, z: 0 });
    const painted = paintInkFill(
      paintInkFill(plane, [{ x: -0.1, y: 0, pressure: 1 }], '#ff004d', 0.2, 'square'),
      [{ x: 0.1, y: 0, pressure: 1 }],
      '#29adff',
      0.2,
      'square',
    );
    const before = pixelAt(painted);
    const blurred = blurInkFill(painted, [center], 0.03, 'circle');
    const after = pixelAt(blurred);

    expect(after[0]).toBeGreaterThan(before[0]!);
    expect(after[3]).toBe(before[3]);
  });

  it('writes wetness into opaque alpha without changing Fill coverage or RGB', () => {
    const dry = createPaintedPlane();
    const wet = paintInkFillWater(dry, [center], 0.02, 0, 'square', 0.5);
    const before = pixelAt(dry);
    const after = pixelAt(wet);

    expect(before[3]).toBe(255);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(after[3]).toBeGreaterThanOrEqual(INK_FILL_COVERAGE_ALPHA_MIN);
    expect(after[3]).toBeLessThan(before[3]!);
  });

  it('uses the strongest contribution for duplicate samples in one drag, then accumulates later strokes', () => {
    const dry = createPaintedPlane();
    const single = paintInkFillWater(dry, [center], 0.02, 0, 'square', 0.5, false, createInkFillWaterStrokeState());
    const sameStroke = paintInkFillWater(
      dry,
      [center, center, center],
      0.02,
      0,
      'square',
      0.5,
      false,
      createInkFillWaterStrokeState(),
    );
    const nextStroke = paintInkFillWater(single, [center], 0.02, 0, 'square', 0.5);

    expect(pixelAt(sameStroke)[3]).toBe(pixelAt(single)[3]);
    expect(pixelAt(nextStroke)[3]).toBeLessThan(pixelAt(single)[3]!);
  });

  it('emits contiguous per-frame alpha runs while retaining per-gesture de-duplication', () => {
    const dry = createPaintedPlane();
    const state = createInkFillWaterStrokeState();
    const wet = paintInkFillWater(dry, [center], 0.04, 0.02, 'square', 0.5, false, state);
    const patches = consumeInkFillWaterAlphaPatches(state, dry.id);

    expect(patches.length).toBeGreaterThan(0);
    expect(consumeInkFillWaterAlphaPatches(state, dry.id)).toEqual([]);
    for (const patch of patches) {
      expect(patch.alpha.length).toBeGreaterThan(0);
      for (let index = 0; index < patch.alpha.length; index += 1) {
        expect(patch.alpha[index]).toBe(pixelAt(wet, patch.x + index, patch.y)[3]);
      }
    }

    const duplicate = paintInkFillWater(wet, [center], 0.04, 0.02, 'square', 0.5, false, state);
    expect(duplicate).toBe(wet);
    expect(consumeInkFillWaterAlphaPatches(state, dry.id)).toEqual([]);
  });

  it('feathers water beyond the solid core and allows the reverse tool to re-dry it', () => {
    const dry = createPaintedPlane();
    const wet = paintInkFillWater(dry, [center], 0.02, 0.04, 'circle', 0.5);
    const coreAlpha = pixelAt(wet)[3]!;
    const featherAlpha = pixelAt(wet, 2, 0)[3]!;
    const dried = eraseInkFillWater(wet, [center], 0.02, 0.04, 'circle', 0.5);

    expect(featherAlpha).toBeLessThan(255);
    expect(featherAlpha).toBeGreaterThan(coreAlpha);
    expect(pixelAt(dried)[3]).toBeGreaterThan(coreAlpha);
    expect(pixelAt(dried).slice(0, 3)).toEqual(pixelAt(wet).slice(0, 3));
  });

  it('keeps finite chart-neighbour mapping in alpha patches', () => {
    let dry: InkShape = createInkCuboidShape();
    dry = bucketFillInkShape(dry, { face: 'positive-z', u: 0, v: 0, pressure: 1 }, '#29adff');
    const state = createInkFillWaterStrokeState();
    const wet = paintInkFillWater(
      dry,
      [{ face: 'positive-z', u: 0.49, v: 0, pressure: 1 }],
      0.2,
      0.04,
      'circle',
      0.5,
      false,
      state,
    );
    const patches = consumeInkFillWaterAlphaPatches(state, dry.id);

    expect(new Set(patches.map((patch) => patch.id))).toEqual(new Set(['positive-z', 'positive-x']));
    const compiled = new Map(compileInkFill(wet).map((surface) => [surface.id, surface]));
    for (const patch of patches) {
      const surface = compiled.get(patch.id)!;
      for (let index = 0; index < patch.alpha.length; index += 1) {
        const offset = ((patch.y - surface.minY) * surface.width + patch.x + index - surface.minX) * 4 + 3;
        expect(patch.alpha[index]).toBe(surface.rgba[offset]);
      }
    }
  });
});
