import { Color, Vector3 } from 'three';

export type LightingProfile = {
  main: { color: string; intensity: number };
  ambient: { color: string; intensity: number };
  terrainBounceBrightness: number;
  backgroundColor: string;
  skyColor: string;
  groundColor: string;
  reflectionIntensity: number;
};

export type StudioPreviewLighting = {
  dayNightPhase: number;
  sunPathTiltXDegrees: number;
  sunPathOffsetZDegrees: number;
  terrainBounceIntensity: number;
  day: LightingProfile;
  night: LightingProfile;
};

/**
 * The current values saved by Painting's Global Lighting scene instance.
 * Studio keeps a local copy so its offline build never depends on Painting.
 */
export const DEFAULT_PREVIEW_LIGHTING: Readonly<StudioPreviewLighting> = {
  dayNightPhase: 0,
  sunPathTiltXDegrees: -12,
  sunPathOffsetZDegrees: 15,
  terrainBounceIntensity: 0.5,
  day: {
    main: { color: '#fff3df', intensity: 3.2 },
    ambient: { color: '#ffffff', intensity: 0.22 },
    terrainBounceBrightness: 1,
    backgroundColor: '#feead7',
    skyColor: '#d9e7eb',
    groundColor: '#b9cf93',
    reflectionIntensity: 0.45,
  },
  night: {
    main: { color: '#d1fff1', intensity: 0.8 },
    ambient: { color: '#5059e2', intensity: 0.1 },
    terrainBounceBrightness: 0.1,
    backgroundColor: '#0c0f13',
    skyColor: '#545b7d',
    groundColor: '#c4a997',
    reflectionIntensity: 0.02,
  },
};

const LEGACY_PREVIEW_LIGHTING: Readonly<StudioPreviewLighting> = {
  dayNightPhase: 0,
  sunPathTiltXDegrees: -25,
  sunPathOffsetZDegrees: 0,
  terrainBounceIntensity: 1,
  day: {
    main: { color: '#fff3df', intensity: 3.2 },
    ambient: { color: '#ffffff', intensity: 0.22 },
    terrainBounceBrightness: 1,
    backgroundColor: '#d9e7eb',
    skyColor: '#d9e7eb',
    groundColor: '#b9cf93',
    reflectionIntensity: 0.45,
  },
  night: {
    main: { color: '#d1fff1', intensity: 1 },
    ambient: { color: '#8a92ff', intensity: 0.1 },
    terrainBounceBrightness: 0.25,
    backgroundColor: '#0c0f13',
    skyColor: '#545b7d',
    groundColor: '#c4a997',
    reflectionIntensity: 0,
  },
};

export type LinearRgb = { r: number; g: number; b: number };

export type ResolvedLighting = {
  backgroundColor: LinearRgb;
  mainColor: LinearRgb;
  mainIntensity: number;
  ambientColor: LinearRgb;
  ambientIntensity: number;
  direction: { x: number; y: number; z: number };
};

export function clonePreviewLighting(source: Readonly<StudioPreviewLighting> = DEFAULT_PREVIEW_LIGHTING): StudioPreviewLighting {
  return {
    ...source,
    day: { ...source.day, main: { ...source.day.main }, ambient: { ...source.day.ambient } },
    night: { ...source.night, main: { ...source.night.main }, ambient: { ...source.night.ambient } },
  };
}

/**
 * Upgrades untouched drafts made with the first Studio lighting defaults.
 * A changed day/night phase is preserved; any other authored lighting change
 * makes the document custom and therefore leaves every value intact.
 */
export function upgradePreviewLightingDefaults(source: Readonly<StudioPreviewLighting>): StudioPreviewLighting {
  if (!sameSettingsExceptPhase(source, LEGACY_PREVIEW_LIGHTING)) return clonePreviewLighting(source);
  return { ...clonePreviewLighting(), dayNightPhase: source.dayNightPhase };
}

/** Mirrors Painting's profile blending and northern-hemisphere celestial path. */
export function resolvePreviewLighting(data: StudioPreviewLighting): ResolvedLighting {
  const phase = Math.min(1, Math.max(-1, data.dayNightPhase));
  const nightBlend = Math.abs(phase);
  const tiltRadians = degreesToRadians(data.sunPathTiltXDegrees);
  const sunDirection = new Vector3(0, 1, 0)
    .applyAxisAngle(new Vector3(1, 0, 0), tiltRadians)
    .applyAxisAngle(new Vector3(0, 0, 1), phase * Math.PI + degreesToRadians(data.sunPathOffsetZDegrees))
    .normalize();
  const maximumHeight = Math.max(0.001, Math.cos(tiltRadians));
  const intensityMultiplier = Math.min(1, Math.abs(sunDirection.y) / maximumHeight);
  const directProfile = sunDirection.y >= 0 ? data.day : data.night;
  if (sunDirection.y < 0) sunDirection.negate();
  return {
    backgroundColor: blendLinearColor(data.day.backgroundColor, data.night.backgroundColor, nightBlend),
    mainColor: toLinearRgb(new Color(directProfile.main.color)),
    mainIntensity: directProfile.main.intensity * intensityMultiplier,
    ambientColor: blendLinearColor(data.day.ambient.color, data.night.ambient.color, nightBlend),
    ambientIntensity: mix(data.day.ambient.intensity, data.night.ambient.intensity, nightBlend),
    direction: { x: sunDirection.x, y: sunDirection.y, z: sunDirection.z },
  };
}

export function isStudioPreviewLighting(value: unknown): value is StudioPreviewLighting {
  if (!value || typeof value !== 'object') return false;
  const lighting = value as Partial<StudioPreviewLighting>;
  return isFiniteNumber(lighting.dayNightPhase, -1, 1)
    && isFiniteNumber(lighting.sunPathTiltXDegrees, -89, 89)
    && isFiniteNumber(lighting.sunPathOffsetZDegrees, -180, 180)
    && isFiniteNumber(lighting.terrainBounceIntensity, 0, 20)
    && isLightingProfile(lighting.day) && isLightingProfile(lighting.night);
}

function isLightingProfile(value: unknown): value is LightingProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<LightingProfile>;
  return isLight(profile.main) && isLight(profile.ambient)
    && isFiniteNumber(profile.terrainBounceBrightness, 0, 20)
    && isColor(profile.backgroundColor) && isColor(profile.skyColor) && isColor(profile.groundColor)
    && isFiniteNumber(profile.reflectionIntensity, 0, 20);
}

function isLight(value: unknown): value is LightingProfile['main'] {
  if (!value || typeof value !== 'object') return false;
  const light = value as Partial<LightingProfile['main']>;
  return isColor(light.color) && isFiniteNumber(light.intensity, 0, 50);
}

function sameSettingsExceptPhase(left: Readonly<StudioPreviewLighting>, right: Readonly<StudioPreviewLighting>): boolean {
  return left.sunPathTiltXDegrees === right.sunPathTiltXDegrees
    && left.sunPathOffsetZDegrees === right.sunPathOffsetZDegrees
    && left.terrainBounceIntensity === right.terrainBounceIntensity
    && sameProfile(left.day, right.day)
    && sameProfile(left.night, right.night);
}

function sameProfile(left: Readonly<LightingProfile>, right: Readonly<LightingProfile>): boolean {
  return left.main.color === right.main.color && left.main.intensity === right.main.intensity
    && left.ambient.color === right.ambient.color && left.ambient.intensity === right.ambient.intensity
    && left.terrainBounceBrightness === right.terrainBounceBrightness
    && left.backgroundColor === right.backgroundColor
    && left.skyColor === right.skyColor
    && left.groundColor === right.groundColor
    && left.reflectionIntensity === right.reflectionIntensity;
}

function blendLinearColor(from: string, to: string, amount: number): LinearRgb {
  return toLinearRgb(new Color(from).lerp(new Color(to), amount));
}

function toLinearRgb(color: Color): LinearRgb { return { r: color.r, g: color.g, b: color.b }; }
function isColor(value: unknown): value is string { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value); }
function isFiniteNumber(value: unknown, minimum: number, maximum: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum; }
function mix(a: number, b: number, amount: number): number { return Math.max(0, a + (b - a) * amount); }
function degreesToRadians(value: number): number { return value * Math.PI / 180; }
