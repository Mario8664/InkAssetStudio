import { describe, expect, it } from 'vitest';
import {
  INK_FILL_COVERAGE_ALPHA_MIN,
  appendInkFillBlurWorkPoints,
  blurInkFill,
  bucketFillInkShape,
  consumeInkFillBlurRgbaPatches,
  compileInkFill,
  createInkFillBlurWork,
  consumeInkFillWaterAlphaPatches,
  createInkFillWaterStrokeState,
  createInkCuboidShape,
  createInkPlaneShape,
  eraseInkFillWater,
  paintInkFill,
  paintInkFillWater,
  processInkFillBlurWork,
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

function coveragePixelCount(shape: InkShape): number {
  return compileInkFill(shape).reduce((count, surface) => {
    for (let offset = 3; offset < surface.rgba.length; offset += 4) {
      if (surface.rgba[offset]! >= INK_FILL_COVERAGE_ALPHA_MIN) count += 1;
    }
    return count;
  }, 0);
}

function changedRgbPixelCount(before: InkShape, after: InkShape): number {
  const previous = new Map(compileInkFill(before).map((surface) => [surface.id, surface]));
  return compileInkFill(after).reduce((count, surface) => {
    const prior = previous.get(surface.id);
    if (!prior) return count;
    for (let offset = 0; offset < surface.rgba.length; offset += 4) {
      if (surface.rgba[offset] !== prior.rgba[offset]
        || surface.rgba[offset + 1] !== prior.rgba[offset + 1]
        || surface.rgba[offset + 2] !== prior.rgba[offset + 2]) count += 1;
    }
    return count;
  }, 0);
}

describe('Ink Fill water tools', () => {
  it('scales Fill Brush and Fill Eraser coverage by sampled pressure', () => {
    const shape = createInkPlaneShape('z', { x: 0, y: 0, z: 0 });
    const lightBrush = paintInkFill(shape, [{ x: 0, y: 0, pressure: 0.25 }], '#29adff', 0.2, 'circle');
    const fullBrush = paintInkFill(shape, [{ x: 0, y: 0, pressure: 1 }], '#29adff', 0.2, 'circle');
    const lightlyErased = paintInkFill(fullBrush, [{ x: 0, y: 0, pressure: 0.25 }], '#29adff', 0.2, 'circle', true);
    const fullyErased = paintInkFill(fullBrush, [{ x: 0, y: 0, pressure: 1 }], '#29adff', 0.2, 'circle', true);

    expect(coveragePixelCount(lightBrush)).toBeLessThan(coveragePixelCount(fullBrush));
    expect(coveragePixelCount(lightlyErased)).toBeGreaterThan(coveragePixelCount(fullyErased));
  });

  it('scales Water and Water Eraser strength by sampled pressure', () => {
    const dry = createPaintedPlane();
    const lowPressureWet = paintInkFillWater(dry, [{ x: 0, y: 0, pressure: 0.25 }], 0.02, 0, 'square', 0.8);
    const fullPressureWet = paintInkFillWater(dry, [{ x: 0, y: 0, pressure: 1 }], 0.02, 0, 'square', 0.8);
    const lowPressureDry = eraseInkFillWater(fullPressureWet, [{ x: 0, y: 0, pressure: 0.25 }], 0.02, 0, 'square', 0.8);
    const fullPressureDry = eraseInkFillWater(fullPressureWet, [{ x: 0, y: 0, pressure: 1 }], 0.02, 0, 'square', 0.8);

    expect(pixelAt(lowPressureWet)[3]).toBeGreaterThan(pixelAt(fullPressureWet)[3]!);
    expect(pixelAt(lowPressureDry)[3]).toBeLessThan(pixelAt(fullPressureDry)[3]!);
  });

  it('scales directional Fill Smudge coverage by sampled pressure', () => {
    const redFill = paintInkFill(createInkPlaneShape('z', { x: 0, y: 0, z: 0 }), [center], '#ff004d', 0.5, 'square');
    const source = paintInkFill(redFill, [{ x: -0.12, y: 0, pressure: 1 }], '#29adff', 0.06, 'square');
    const lowPressureBlur = blurInkFill(source, [{ x: -0.12, y: 0, pressure: 0.25 }, { x: 0.12, y: 0, pressure: 0.25 }], 0.2, 'circle');
    const fullPressureBlur = blurInkFill(source, [{ x: -0.12, y: 0, pressure: 1 }, { x: 0.12, y: 0, pressure: 1 }], 0.2, 'circle');

    expect(changedRgbPixelCount(source, lowPressureBlur)).toBeLessThan(changedRgbPixelCount(source, fullPressureBlur));
  });

  it('uses the initial Fill Smudge dab only to pick up existing pigment', () => {
    const source = createPaintedPlane();

    expect(blurInkFill(source, [center], 0.2, 'circle')).toBe(source);
  });

  it('processes an ordered large Smudge gesture in a small number of bounded frames', () => {
    const redFill = paintInkFill(createInkPlaneShape('z', { x: 0, y: 0, z: 0 }), [center], '#ff004d', 0.5, 'square');
    const source = paintInkFill(redFill, [{ x: -0.1, y: 0, pressure: 1 }], '#29adff', 0.08, 'circle');
    const points = [
      { x: -0.1, y: 0, pressure: 1 },
      { x: 0, y: 0, pressure: 1 },
      { x: 0.1, y: 0, pressure: 1 },
    ];
    const work = createInkFillBlurWork(source, points.slice(0, 2), 0.5, 'circle')!;
    expect(appendInkFillBlurWorkPoints(work, points.slice(1), 0.5)).toBe(true);
    const patches = [];
    let result = source;
    let frameCount = 0;
    const firstFrame = processInkFillBlurWork(work, 4_096);
    expect(firstFrame.processedTargetCount).toBeLessThanOrEqual(4_096);
    result = firstFrame.shape;
    patches.push(...consumeInkFillBlurRgbaPatches(work));
    frameCount += 1;
    while (!work.complete) {
      const progress = processInkFillBlurWork(work, 4_096);
      expect(progress.processedTargetCount).toBeLessThanOrEqual(4_096);
      result = progress.shape;
      patches.push(...consumeInkFillBlurRgbaPatches(work));
      frameCount += 1;
    }

    expect(frameCount).toBeLessThanOrEqual(2);
    expect(patches.some((patch) => patch.rgba.length > 0)).toBe(true);
    expect(result).toEqual(blurInkFill(source, points, 0.5, 'circle'));
  }, 15_000);

  it('smudges only authored Fill RGB while retaining its opacity encoding', () => {
    const plane = createInkPlaneShape('z', { x: 0, y: 0, z: 0 });
    const painted = paintInkFill(
      paintInkFill(plane, [center], '#ff004d', 0.25, 'square'),
      [{ x: -0.1, y: 0, pressure: 1 }],
      '#29adff',
      0.05,
      'square',
    );
    const before = pixelAt(painted, 6, 0);
    const blurred = blurInkFill(painted, [{ x: -0.1, y: 0, pressure: 1 }, { x: 0.1, y: 0, pressure: 1 }], 0.05, 'circle');
    const after = pixelAt(blurred, 6, 0);

    expect(after[2]).toBeGreaterThan(before[2]!);
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
