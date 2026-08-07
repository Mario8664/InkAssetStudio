import { describe, expect, it } from 'vitest';
import { AdaptiveRenderScale } from '../src/render/AdaptiveRenderScale';

describe('adaptive render scale', () => {
  it('bounds a Retina backing store by physical-pixel budget', () => {
    const scale = new AdaptiveRenderScale();
    const pixelRatio = scale.setViewport(1024, 768, 2);

    expect(pixelRatio).toBeLessThan(2);
    expect(1024 * 768 * pixelRatio * pixelRatio).toBeLessThanOrEqual(2_000_001);
  });

  it('changes scale only after sustained pressure outside a Pencil gesture', () => {
    const scale = new AdaptiveRenderScale();
    const initial = scale.setViewport(1024, 768, 2);

    scale.setInteractionActive(true);
    expect(scale.reportFrame(24, 1_000)).toBeNull();
    expect(scale.reportFrame(24, 1_001)).toBeNull();
    expect(scale.reportFrame(24, 1_002)).toBeNull();

    scale.setInteractionActive(false);
    expect(scale.reportFrame(24, 1_003)).toBeNull();
    expect(scale.reportFrame(24, 1_004)).toBeNull();
    const reduced = scale.reportFrame(24, 1_005);

    expect(reduced).not.toBeNull();
    expect(reduced!).toBeLessThan(initial);
  });

  it('restores available detail only after prolonged frame headroom', () => {
    const scale = new AdaptiveRenderScale();
    const initial = scale.setViewport(1024, 768, 2);
    scale.reportFrame(24, 1_000);
    scale.reportFrame(24, 1_001);
    const reduced = scale.reportFrame(24, 1_002)!;

    let restored: number | null = null;
    for (let index = 0; index < 120; index += 1) restored = scale.reportFrame(12, 2_010 + index);

    expect(reduced).toBeLessThan(initial);
    expect(restored).not.toBeNull();
    expect(restored!).toBeGreaterThan(reduced);
    expect(restored!).toBeLessThanOrEqual(initial);
  });
});
