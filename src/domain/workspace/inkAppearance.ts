export type InkAppearanceMode = 'source' | 'watercolor';

export type InkWatercolorFillSettings = {
  /** Stable Group-local 3D noise frequency in cycles per world unit. */
  noiseScale: number;
  waterEdge: {
    enabled: boolean;
    /** Approximate edge search width in CSS pixels. */
    width: number;
    contrastThreshold: number;
    edgeDarkening: number;
    /** World-unit colour-buffer offset driven by the stable noise field. */
    offsetStrength: number;
  };
  diffusion: {
    enabled: boolean;
    /** Approximate inward multiscale blur radius in CSS pixels. */
    softTailRadius: number;
    /** Approximate similar-colour mixing radius in CSS pixels. */
    colorMixRadius: number;
    colorMixStrength: number;
    interiorPigmentStrength: number;
    interiorFadeColor: string;
  };
};

/** Studio-only preview state. It never enters an exported work scene. */
export type StudioInkAppearance = {
  appearance: InkAppearanceMode;
  crayonGrainDensity: number;
  crayonMinimumOpacity: number;
  watercolorFill: InkWatercolorFillSettings;
};

export const INK_CRAYON_GRAIN_DENSITY_MIN = 32;
export const INK_CRAYON_GRAIN_DENSITY_MAX = 512;
export const INK_WATERCOLOR_NOISE_SCALE_MIN = 0.001;
export const INK_WATERCOLOR_NOISE_SCALE_MAX = 64;
export const INK_WATERCOLOR_EDGE_WIDTH_MIN = 0;
export const INK_WATERCOLOR_EDGE_WIDTH_MAX = 32;
export const INK_WATERCOLOR_SOFT_TAIL_RADIUS_MIN = 0;
export const INK_WATERCOLOR_SOFT_TAIL_RADIUS_MAX = 16;
export const INK_WATERCOLOR_COLOR_MIX_RADIUS_MIN = 0;
export const INK_WATERCOLOR_COLOR_MIX_RADIUS_MAX = 16;

/** Values copied from Painting's saved Ink Global Setting on 2026-08-05. */
export const SAVED_PAINTING_INK_APPEARANCE: Readonly<StudioInkAppearance> = {
  appearance: 'watercolor',
  crayonGrainDensity: 96,
  crayonMinimumOpacity: 0.3,
  watercolorFill: {
    noiseScale: 3,
    waterEdge: {
      enabled: true,
      width: 4,
      contrastThreshold: 0.24,
      edgeDarkening: 0.47,
      offsetStrength: 0.03,
    },
    diffusion: {
      enabled: true,
      softTailRadius: 15,
      colorMixRadius: 5,
      colorMixStrength: 1,
      interiorPigmentStrength: 0.8,
      interiorFadeColor: '#f9f5f1',
    },
  },
};

export function createStudioInkAppearance(): StudioInkAppearance {
  return cloneStudioInkAppearance(SAVED_PAINTING_INK_APPEARANCE);
}

export function cloneStudioInkAppearance(value: Readonly<StudioInkAppearance>): StudioInkAppearance {
  return {
    ...value,
    watercolorFill: {
      ...value.watercolorFill,
      waterEdge: { ...value.watercolorFill.waterEdge },
      diffusion: { ...value.watercolorFill.diffusion },
    },
  };
}

export function normalizeStudioInkAppearance(value: unknown): StudioInkAppearance {
  const fallback = createStudioInkAppearance();
  if (!value || typeof value !== 'object') return fallback;
  const source = value as Partial<StudioInkAppearance>;
  const watercolorFill = source.watercolorFill && typeof source.watercolorFill === 'object'
    ? source.watercolorFill as Partial<InkWatercolorFillSettings>
    : {};
  const waterEdge = watercolorFill.waterEdge && typeof watercolorFill.waterEdge === 'object'
    ? watercolorFill.waterEdge as Partial<InkWatercolorFillSettings['waterEdge']>
    : {};
  const diffusion = watercolorFill.diffusion && typeof watercolorFill.diffusion === 'object'
    ? watercolorFill.diffusion as Partial<InkWatercolorFillSettings['diffusion']>
    : {};
  return {
    appearance: source.appearance === 'source' ? 'source' : fallback.appearance,
    crayonGrainDensity: Math.round(boundedNumber(
      source.crayonGrainDensity,
      fallback.crayonGrainDensity,
      INK_CRAYON_GRAIN_DENSITY_MIN,
      INK_CRAYON_GRAIN_DENSITY_MAX,
    )),
    crayonMinimumOpacity: boundedNumber(source.crayonMinimumOpacity, fallback.crayonMinimumOpacity, 0, 1),
    watercolorFill: {
      noiseScale: boundedNumber(
        watercolorFill.noiseScale,
        fallback.watercolorFill.noiseScale,
        INK_WATERCOLOR_NOISE_SCALE_MIN,
        INK_WATERCOLOR_NOISE_SCALE_MAX,
      ),
      waterEdge: {
        enabled: typeof waterEdge.enabled === 'boolean' ? waterEdge.enabled : fallback.watercolorFill.waterEdge.enabled,
        width: boundedNumber(
          waterEdge.width,
          fallback.watercolorFill.waterEdge.width,
          INK_WATERCOLOR_EDGE_WIDTH_MIN,
          INK_WATERCOLOR_EDGE_WIDTH_MAX,
        ),
        contrastThreshold: boundedNumber(
          waterEdge.contrastThreshold,
          fallback.watercolorFill.waterEdge.contrastThreshold,
          0,
          1,
        ),
        edgeDarkening: boundedNumber(
          waterEdge.edgeDarkening,
          fallback.watercolorFill.waterEdge.edgeDarkening,
          0,
          1,
        ),
        offsetStrength: minimumNumber(
          waterEdge.offsetStrength,
          fallback.watercolorFill.waterEdge.offsetStrength,
          0,
        ),
      },
      diffusion: {
        enabled: typeof diffusion.enabled === 'boolean' ? diffusion.enabled : fallback.watercolorFill.diffusion.enabled,
        softTailRadius: boundedNumber(
          diffusion.softTailRadius,
          fallback.watercolorFill.diffusion.softTailRadius,
          INK_WATERCOLOR_SOFT_TAIL_RADIUS_MIN,
          INK_WATERCOLOR_SOFT_TAIL_RADIUS_MAX,
        ),
        colorMixRadius: boundedNumber(
          diffusion.colorMixRadius,
          fallback.watercolorFill.diffusion.colorMixRadius,
          INK_WATERCOLOR_COLOR_MIX_RADIUS_MIN,
          INK_WATERCOLOR_COLOR_MIX_RADIUS_MAX,
        ),
        colorMixStrength: boundedNumber(
          diffusion.colorMixStrength,
          fallback.watercolorFill.diffusion.colorMixStrength,
          0,
          1,
        ),
        interiorPigmentStrength: boundedNumber(
          diffusion.interiorPigmentStrength,
          fallback.watercolorFill.diffusion.interiorPigmentStrength,
          0,
          1,
        ),
        interiorFadeColor: isColor(diffusion.interiorFadeColor)
          ? diffusion.interiorFadeColor.toLowerCase()
          : fallback.watercolorFill.diffusion.interiorFadeColor,
      },
    },
  };
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function minimumNumber(value: unknown, fallback: number, minimum: number): number {
  return Math.max(minimum, finiteNumber(value, fallback));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
