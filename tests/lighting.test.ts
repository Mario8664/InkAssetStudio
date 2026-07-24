import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREVIEW_LIGHTING,
  clonePreviewLighting,
  resolvePreviewLighting,
  upgradePreviewLightingDefaults,
  type StudioPreviewLighting,
} from '../src/domain/lighting/lighting';

describe('Painting-compatible preview lighting', () => {
  it('uses the values currently saved by Painting as the Studio defaults', () => {
    expect(DEFAULT_PREVIEW_LIGHTING).toEqual({
      dayNightPhase: 0,
      sunPathTiltXDegrees: -12,
      sunPathOffsetZDegrees: 15,
      terrainBounceIntensity: 0.5,
      day: {
        main: { color: '#fff3df', intensity: 3.2 },
        ambient: { color: '#ffffff', intensity: 0.22 },
        backgroundColor: '#feead7',
        skyColor: '#d9e7eb',
        groundColor: '#b9cf93',
        reflectionIntensity: 0.45,
        terrainBounceBrightness: 1,
      },
      night: {
        main: { color: '#d1fff1', intensity: 0.8 },
        ambient: { color: '#5059e2', intensity: 0.1 },
        backgroundColor: '#0c0f13',
        skyColor: '#545b7d',
        groundColor: '#c4a997',
        reflectionIntensity: 0.02,
        terrainBounceBrightness: 0.1,
      },
    });
  });

  it('matches Painting celestial-light profile selection and horizon attenuation', () => {
    const noon = resolvePreviewLighting(clonePreviewLighting());
    const midnight = resolvePreviewLighting({ ...clonePreviewLighting(), dayNightPhase: 1 });
    const expectedDay = new Color(DEFAULT_PREVIEW_LIGHTING.day.main.color);
    const expectedNight = new Color(DEFAULT_PREVIEW_LIGHTING.night.main.color);
    const expectedMultiplier = Math.cos(15 * Math.PI / 180);

    expect(noon.mainColor.r).toBeCloseTo(expectedDay.r, 10);
    expect(noon.mainColor.g).toBeCloseTo(expectedDay.g, 10);
    expect(noon.mainColor.b).toBeCloseTo(expectedDay.b, 10);
    expect(noon.mainIntensity).toBeCloseTo(3.2 * expectedMultiplier, 10);
    expect(noon.direction.y).toBeGreaterThan(0);

    expect(midnight.mainColor.r).toBeCloseTo(expectedNight.r, 10);
    expect(midnight.mainColor.g).toBeCloseTo(expectedNight.g, 10);
    expect(midnight.mainColor.b).toBeCloseTo(expectedNight.b, 10);
    expect(midnight.mainIntensity).toBeCloseTo(0.8 * expectedMultiplier, 10);
    expect(midnight.direction.y).toBeGreaterThan(0);
  });

  it('blends ambient and background colors in Three.js linear working space', () => {
    const lighting = { ...clonePreviewLighting(), dayNightPhase: 0.5 };
    const resolved = resolvePreviewLighting(lighting);
    const expectedAmbient = new Color(lighting.day.ambient.color).lerp(new Color(lighting.night.ambient.color), 0.5);
    const expectedBackground = new Color(lighting.day.backgroundColor).lerp(new Color(lighting.night.backgroundColor), 0.5);

    expect(resolved.ambientColor.r).toBeCloseTo(expectedAmbient.r, 10);
    expect(resolved.ambientColor.g).toBeCloseTo(expectedAmbient.g, 10);
    expect(resolved.ambientColor.b).toBeCloseTo(expectedAmbient.b, 10);
    expect(resolved.backgroundColor.r).toBeCloseTo(expectedBackground.r, 10);
    expect(resolved.backgroundColor.g).toBeCloseTo(expectedBackground.g, 10);
    expect(resolved.backgroundColor.b).toBeCloseTo(expectedBackground.b, 10);
    expect(resolved.ambientIntensity).toBeCloseTo(0.16, 10);
  });

  it('upgrades untouched legacy defaults while preserving authored lighting', () => {
    const legacy = createLegacyLighting();
    legacy.dayNightPhase = 0.35;
    expect(upgradePreviewLightingDefaults(legacy)).toEqual({
      ...clonePreviewLighting(DEFAULT_PREVIEW_LIGHTING),
      dayNightPhase: 0.35,
    });

    legacy.night.main.intensity = 0.9;
    expect(upgradePreviewLightingDefaults(legacy)).toEqual(legacy);
  });
});

function createLegacyLighting(): StudioPreviewLighting {
  return {
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
}
