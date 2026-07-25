import { describe, expect, it } from 'vitest';
import {
  INK_COMPILED_FORMAT_VERSION,
  compileInkShape,
  createInkCuboidShape,
  createInkOutlineStroke,
  createInkPlaneShape,
  createInkSphereShape,
  paintInkFill,
  resampleInkShapeFill,
  type InkShape,
  type InkSurfacePoint,
} from '../src/domain/ink/ink';

describe('Painting-compatible Ink Shapes', () => {
  const cases: Array<{ label: string; shape: InkShape; points: InkSurfacePoint[] }> = [
    {
      label: 'Plane',
      shape: createInkPlaneShape('camera', { x: 0, y: 0, z: 0 }),
      points: [{ x: -0.25, y: 0, pressure: 0.4 }, { x: 0.25, y: 0.1, pressure: 0.9 }],
    },
    {
      label: 'Cuboid',
      shape: createInkCuboidShape(),
      points: [
        { face: 'positive-z', u: -0.25, v: 0, pressure: 0.4 },
        { face: 'positive-z', u: 0.25, v: 0.1, pressure: 0.9 },
      ],
    },
    {
      label: 'Sphere',
      shape: createInkSphereShape(),
      points: [
        { x: 1, y: 0, z: 0, pressure: 0.4 },
        { x: 0.9805806757, y: 0.1961161351, z: 0, pressure: 0.7 },
        { x: 0.9238795325, y: 0.3826834324, z: 0, pressure: 0.9 },
      ],
    },
  ];

  for (const entry of cases) {
    it(`compiles editable Outline and Fill data for ${entry.label}`, () => {
      const outlined = {
        ...entry.shape,
        strokes: [createInkOutlineStroke(entry.points, '#ff004d', 0.04)],
      } as InkShape;
      const painted = paintInkFill(outlined, [entry.points[0]!], '#29adff', 0.12, 'circle', false);
      const compiled = compileInkShape(painted);
      expect(compiled.ribbon.positions.length).toBeGreaterThan(0);
      expect(compiled.ribbon.indices.length).toBeGreaterThan(0);
      expect(compiled.fill.length).toBeGreaterThan(0);
      expect(compiled.fill.some((surface) => surface.rgba.some((channel) => channel !== 0))).toBe(true);
    });
  }

  it('compiles Normal Outset as v13 Shape configuration without rebuilding Ribbon data', () => {
    const shape = createInkCuboidShape();
    const outlined = {
      ...shape,
      strokes: [createInkOutlineStroke([
        { face: 'positive-z', u: -0.2, v: 0, pressure: 1 },
        { face: 'positive-z', u: 0.2, v: 0, pressure: 1 },
      ], '#000000', 0.04)],
    } as InkShape;
    const before = compileInkShape(outlined);
    const enabled = {
      ...outlined,
      normalOutset: { enabled: true, color: '#5A3E16', distance: 0.075 },
    } as InkShape;
    const after = compileInkShape(enabled, undefined, before);

    expect(INK_COMPILED_FORMAT_VERSION).toBe(13);
    expect(after.normalOutset).toEqual({ color: '#5a3e16', distance: 0.075 });
    expect(after.ribbon).toBe(before.ribbon);
    expect(compileInkShape({ ...enabled, normalOutset: { ...enabled.normalOutset!, enabled: false } }).normalOutset).toBeNull();
  });

  it('resamples only finite Cuboid Fill charts when intrinsic size changes', () => {
    const painted = paintInkFill(
      createInkCuboidShape(),
      [{ face: 'positive-z', u: 0, v: 0, pressure: 1 }],
      '#29adff',
      0.12,
      'circle',
      false,
    ) as Extract<InkShape, { kind: 'cuboid' }>;
    const before = painted.fill.surfaces.find((surface) => surface.id === 'positive-z')!;
    const resized = resampleInkShapeFill(painted, { ...painted, size: { x: 2, y: 3, z: 1 } });
    const after = resized.fill.surfaces.find((surface) => surface.id === 'positive-z')!;

    expect(after.width).toBe(before.width! * 2);
    expect(after.height).toBe(before.height! * 3);
    expect(after.blocks).not.toHaveLength(0);
    expect(resized.strokes).toBe(painted.strokes);
  });
});
