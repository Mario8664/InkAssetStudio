import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  DataTexture,
  DynamicDrawUsage,
  DoubleSide,
  Float32BufferAttribute,
  GLSL3,
  Group,
  type IUniform,
  Matrix3,
  Mesh,
  Object3D,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  Matrix4,
  NearestFilter,
  UnsignedByteType,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import {
  DEFAULT_INK_STROKE_COLOR,
  INK_CYLINDER_SEGMENTS,
  INK_FILL_PIXELS_PER_WORLD_UNIT,
  INK_SPHERE_FACE_SEGMENTS,
  getInkFrustumFacePosition,
  type CompiledInkFillSurface,
  type CompiledInkRibbon,
  type CompiledInkShape,
  type InkCuboidFace,
  type InkFillRgbaPatch,
  type InkFillSurfaceId,
  type InkFillWaterAlphaPatch,
  type InkGroupData,
  type InkShape,
} from '../domain/ink/ink';
import { SAVED_PAINTING_INK_APPEARANCE } from '../domain/workspace/inkAppearance';

/** Dedicated camera layers used by Studio's Ink subpasses. */
export const INK_FILL_RENDER_LAYER = 1;
export const INK_RIBBON_RENDER_LAYER = 2;

export function setInkDisplayRenderLayer(root: Object3D): void {
  root.traverse((object) => object.layers.set(
    object instanceof Mesh && object.name === 'InkFillSurface'
      ? INK_FILL_RENDER_LAYER
      : INK_RIBBON_RENDER_LAYER,
  ));
}

/** Shared mutable uniforms for every Fill material mounted by one GridSceneView. */
export type InkFillLightingState = {
  lightDirection: Vector3;
  ambientIrradiance: Vector3;
  hardShadowMap: { value: Texture | null };
  hardShadowOwnerMap: { value: Texture | null };
  hardShadowTexelSize: Vector2;
  hardShadowMatrix: Matrix4;
  hardShadowEnabled: { value: number };
  hardShadowOwnerMapEnabled: { value: number };
};

/** Shared mutable preview choice and Watercolor material parameters. */
export type InkRenderAppearanceState = {
  watercolorEnabled: { value: number };
  crayonGrainDensity: { value: number };
  crayonMinimumOpacity: { value: number };
  watercolorNoiseScale: { value: number };
};

type InkDisplayDepthState = {
  sceneDepth: { value: Texture | null };
  sceneDepthSize: Vector2;
  sceneDepthEnabled: { value: number };
};

type InkRenderFeatures = Readonly<{
  sceneDepth: boolean;
  hardShadows: boolean;
}>;

const STUDIO_INK_RENDER_FEATURES: InkRenderFeatures = { sceneDepth: false, hardShadows: true };

function createInkDisplayDepthState(): InkDisplayDepthState {
  return {
    sceneDepth: { value: null },
    sceneDepthSize: new Vector2(1, 1),
    sceneDepthEnabled: { value: 0 },
  };
}

/** Zero is background; the red owner channel provides 255 concurrent Shape IDs. */
export const INK_HARD_SHADOW_OWNER_ID_LIMIT = 255;

export type InkHardShadowOwnerState = {
  id: { value: number };
};

const INK_HARD_SHADOW_OWNER_STATE_KEY = 'inkHardShadowOwnerState';
const INK_WATERCOLOR_CAPTURE_STATE_KEY = 'inkWatercolorCaptureState';
export const INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY = 'inkWatercolorFillCaptureMaterial';

/** Shared by Fill Shapes in one Group; transient and never serialized. */
export type InkWatercolorCaptureState = {
  stableSeed: { value: number };
};

export function createInkFillLightingState(): InkFillLightingState {
  return {
    lightDirection: new Vector3(-4.5, 7.5, 4.5).normalize(),
    ambientIrradiance: new Vector3(0.22, 0.22, 0.22),
    hardShadowMap: { value: null },
    hardShadowOwnerMap: { value: null },
    hardShadowTexelSize: new Vector2(1, 1),
    hardShadowMatrix: new Matrix4(),
    hardShadowEnabled: { value: 0 },
    hardShadowOwnerMapEnabled: { value: 0 },
  };
}

export function createInkRenderAppearanceState(): InkRenderAppearanceState {
  const defaults = SAVED_PAINTING_INK_APPEARANCE;
  return {
    watercolorEnabled: { value: defaults.appearance === 'watercolor' ? 1 : 0 },
    crayonGrainDensity: { value: defaults.crayonGrainDensity },
    crayonMinimumOpacity: { value: defaults.crayonMinimumOpacity },
    watercolorNoiseScale: { value: defaults.watercolorFill.noiseScale },
  };
}

function createInkWatercolorCaptureState(stableId: string): InkWatercolorCaptureState {
  return { stableSeed: { value: createInkStableSeed(stableId) } };
}

export function getInkWatercolorCaptureState(root: Object3D): InkWatercolorCaptureState | null {
  return (root.userData[INK_WATERCOLOR_CAPTURE_STATE_KEY] as InkWatercolorCaptureState | undefined) ?? null;
}

function getOrCreateInkWatercolorCaptureState(root: Object3D, stableId: string): InkWatercolorCaptureState {
  const existing = getInkWatercolorCaptureState(root);
  if (existing) return existing;
  const created = createInkWatercolorCaptureState(stableId);
  root.userData[INK_WATERCOLOR_CAPTURE_STATE_KEY] = created;
  return created;
}

const INK_WATERCOLOR_MARCHING_SQUARES_GLSL = `
float getInkWatercolorMarchingSquaresCoverage(
  float bottomLeft,
  float bottomRight,
  float topRight,
  float topLeft,
  vec2 localPosition
) {
  float caseIndex = bottomLeft + bottomRight * 2.0 + topRight * 4.0 + topLeft * 8.0;
  if (caseIndex < 0.5) return 0.0;
  if (caseIndex > 14.5) return 1.0;
  if (caseIndex < 1.5) return localPosition.x + localPosition.y < 0.5 ? 1.0 : 0.0;
  if (caseIndex < 2.5) return (1.0 - localPosition.x) + localPosition.y < 0.5 ? 1.0 : 0.0;
  if (caseIndex < 3.5) return localPosition.y < 0.5 ? 1.0 : 0.0;
  if (caseIndex < 4.5) return (1.0 - localPosition.x) + (1.0 - localPosition.y) < 0.5 ? 1.0 : 0.0;
  if (caseIndex < 5.5) return localPosition.x + localPosition.y < 0.5
    || localPosition.x + localPosition.y > 1.5 ? 1.0 : 0.0;
  if (caseIndex < 6.5) return localPosition.x > 0.5 ? 1.0 : 0.0;
  if (caseIndex < 7.5) return localPosition.x + (1.0 - localPosition.y) >= 0.5 ? 1.0 : 0.0;
  if (caseIndex < 8.5) return localPosition.x + (1.0 - localPosition.y) < 0.5 ? 1.0 : 0.0;
  if (caseIndex < 9.5) return localPosition.x < 0.5 ? 1.0 : 0.0;
  if (caseIndex < 10.5) return (1.0 - localPosition.x) + localPosition.y < 0.5
    || localPosition.x + (1.0 - localPosition.y) < 0.5 ? 1.0 : 0.0;
  if (caseIndex < 11.5) return (1.0 - localPosition.x) + (1.0 - localPosition.y) >= 0.5 ? 1.0 : 0.0;
  if (caseIndex < 12.5) return localPosition.y > 0.5 ? 1.0 : 0.0;
  if (caseIndex < 13.5) return (1.0 - localPosition.x) + localPosition.y >= 0.5 ? 1.0 : 0.0;
  return localPosition.x + localPosition.y >= 0.5 ? 1.0 : 0.0;
}`;

/**
 * Watercolor keeps authored RGB at a nearest opaque texel and reconstructs
 * only its binary alpha contour. This display-time interpretation never
 * changes source pixels, their compact layout, or Source appearance.
 */
const INK_WATERCOLOR_CONTOURED_FILL_GLSL = `
vec2 getInkWatercolorContourDomainUv(vec2 textureUv) {
  // Keep the continuous position inside the authored chart, including the
  // half-cell range between a guard texel and its first authored texel.
  vec2 contentMin = inkFillTextureUvOffset;
  vec2 contentMax = inkFillTextureUvOffset + inkFillTextureUvScale - inkFillTexelSize * 0.0001;
  return clamp(textureUv, contentMin, max(contentMin, contentMax));
}

vec2 getInkWatercolorContourTexelUv(vec2 texelCell) {
  vec2 halfTexel = inkFillTexelSize * 0.5;
  return clamp((texelCell + vec2(0.5)) * inkFillTexelSize, halfTexel, vec2(1.0) - halfTexel);
}

vec4 sampleInkWatercolorContourTexel(vec2 texelCell) {
  return texture2D(inkFillMap, getInkWatercolorContourTexelUv(texelCell));
}

vec4 sampleInkWatercolorNearestSource(vec2 textureUv) {
  vec2 texelCell = floor(textureUv / inkFillTexelSize);
  return sampleInkWatercolorContourTexel(texelCell);
}

bool hasInkWatercolorSameRgb(vec4 left, vec4 right) {
  return all(equal(left.rgb, right.rgb));
}

float getInkWatercolorContourCoverage(vec2 textureUv) {
  vec2 domainUv = getInkWatercolorContourDomainUv(textureUv);
  vec2 texelPosition = domainUv / inkFillTexelSize - vec2(0.5);
  vec2 texelCell = floor(texelPosition);
  vec2 localPosition = fract(texelPosition);
  float bottomLeft = step(0.5, sampleInkWatercolorContourTexel(texelCell).a);
  float bottomRight = step(0.5, sampleInkWatercolorContourTexel(texelCell + vec2(1.0, 0.0)).a);
  float topRight = step(0.5, sampleInkWatercolorContourTexel(texelCell + vec2(1.0, 1.0)).a);
  float topLeft = step(0.5, sampleInkWatercolorContourTexel(texelCell + vec2(0.0, 1.0)).a);
  return getInkWatercolorMarchingSquaresCoverage(bottomLeft, bottomRight, topRight, topLeft, localPosition);
}

vec4 sampleInkWatercolorContouredSource(vec2 textureUv) {
  vec2 domainUv = getInkWatercolorContourDomainUv(textureUv);
  vec2 texelPosition = domainUv / inkFillTexelSize - vec2(0.5);
  vec2 texelCell = floor(texelPosition);
  vec2 localPosition = fract(texelPosition);
  vec4 bottomLeft = sampleInkWatercolorContourTexel(texelCell);
  vec4 bottomRight = sampleInkWatercolorContourTexel(texelCell + vec2(1.0, 0.0));
  vec4 topRight = sampleInkWatercolorContourTexel(texelCell + vec2(1.0, 1.0));
  vec4 topLeft = sampleInkWatercolorContourTexel(texelCell + vec2(0.0, 1.0));

  // Only reconstruct an interior colour edge when every corner is authored
  // opaque and the cell has exactly two RGB labels. The selected label owns a
  // Marching Squares region; the other label owns its complement. No RGBs are
  // interpolated, and ambiguous checkerboards remain raw nearest samples.
  bool allOpaque = bottomLeft.a >= 0.5
    && bottomRight.a >= 0.5
    && topRight.a >= 0.5
    && topLeft.a >= 0.5;
  if (allOpaque) {
    vec4 selectedColour = bottomLeft;
    bool bottomRightIsSelected = hasInkWatercolorSameRgb(bottomRight, selectedColour);
    bool topRightIsSelected = hasInkWatercolorSameRgb(topRight, selectedColour);
    bool topLeftIsSelected = hasInkWatercolorSameRgb(topLeft, selectedColour);
    bool hasAlternateColour = !bottomRightIsSelected || !topRightIsSelected || !topLeftIsSelected;
    vec4 alternateColour = !bottomRightIsSelected ? bottomRight
      : (!topRightIsSelected ? topRight : topLeft);
    bool hasExactlyTwoColours = hasAlternateColour
      && (bottomRightIsSelected || hasInkWatercolorSameRgb(bottomRight, alternateColour))
      && (topRightIsSelected || hasInkWatercolorSameRgb(topRight, alternateColour))
      && (topLeftIsSelected || hasInkWatercolorSameRgb(topLeft, alternateColour));
    if (hasExactlyTwoColours) {
      float selectedBottomLeft = 1.0;
      float selectedBottomRight = bottomRightIsSelected ? 1.0 : 0.0;
      float selectedTopRight = topRightIsSelected ? 1.0 : 0.0;
      float selectedTopLeft = topLeftIsSelected ? 1.0 : 0.0;
      float selectedCase = selectedBottomLeft + selectedBottomRight * 2.0
        + selectedTopRight * 4.0 + selectedTopLeft * 8.0;
      bool checkerboard = abs(selectedCase - 5.0) < 0.5 || abs(selectedCase - 10.0) < 0.5;
      if (!checkerboard) {
        float selectedCoverage = getInkWatercolorMarchingSquaresCoverage(
          selectedBottomLeft,
          selectedBottomRight,
          selectedTopRight,
          selectedTopLeft,
          localPosition
        );
        return selectedCoverage >= 0.5 ? selectedColour : alternateColour;
      }
    }
  }

  vec4 nearestOpaque = bottomLeft;
  float nearestDistance = 1000000.0;
  float bottomLeftDistance = dot(localPosition, localPosition);
  float bottomRightDistance = dot(localPosition - vec2(1.0, 0.0), localPosition - vec2(1.0, 0.0));
  float topRightDistance = dot(localPosition - vec2(1.0), localPosition - vec2(1.0));
  float topLeftDistance = dot(localPosition - vec2(0.0, 1.0), localPosition - vec2(0.0, 1.0));
  if (bottomLeft.a >= 0.5 && bottomLeftDistance < nearestDistance) { nearestOpaque = bottomLeft; nearestDistance = bottomLeftDistance; }
  if (bottomRight.a >= 0.5 && bottomRightDistance < nearestDistance) { nearestOpaque = bottomRight; nearestDistance = bottomRightDistance; }
  if (topRight.a >= 0.5 && topRightDistance < nearestDistance) { nearestOpaque = topRight; nearestDistance = topRightDistance; }
  if (topLeft.a >= 0.5 && topLeftDistance < nearestDistance) nearestOpaque = topLeft;
  return nearestOpaque;
}`;

/** Dilutes local wet pigment at capture time, allowing full water to reach paper white. */
const INK_WATERCOLOR_WET_WASH_GLSL = `
vec3 getInkWatercolorWetWash(vec3 pigment, float wetness) {
  float wetCurve = pow(clamp(wetness, 0.0, 1.0), 0.75);
  float pigmentLightness = dot(pigment, vec3(0.299, 0.587, 0.114));
  vec3 softenedPigment = mix(pigment, vec3(pigmentLightness), wetCurve * 0.12);
  return mix(softenedPigment, vec3(1.0), wetCurve);
}`;

/** Watercolor-only nearest visibility with continuous Marching Squares edges. */
const INK_WATERCOLOR_CONTOURED_HARD_SHADOW_GLSL = `
bool isInkHardShadowSelfOwner(vec2 shadowUv) {
  if (inkHardShadowOwnerMapEnabled < 0.5 || inkHardShadowOwnerId < 0.5) return false;
  float capturedOwnerId = floor(texture2D(inkHardShadowOwnerMap, shadowUv).r * 255.0 + 0.5);
  return abs(capturedOwnerId - inkHardShadowOwnerId) < 0.5;
}

float sampleInkHardShadowVisibilityTap(vec2 shadowUv, float receiverDepth) {
  if (isInkHardShadowSelfOwner(shadowUv)) return 1.0;
  float casterDepth = texture2D(inkHardShadowMap, shadowUv).r;
  return receiverDepth <= casterDepth ? 1.0 : 0.0;
}

float sampleInkHardShadowCenterVisibility(vec3 shadowUvDepth) {
  return sampleInkHardShadowVisibilityTap(shadowUvDepth.xy, shadowUvDepth.z);
}

float sampleInkWatercolorHardShadowVisibilityCell(vec2 texelCell, float receiverDepth) {
  vec2 halfTexel = inkHardShadowTexelSize * 0.5;
  vec2 shadowUv = clamp((texelCell + vec2(0.5)) * inkHardShadowTexelSize, halfTexel, vec2(1.0) - halfTexel);
  return sampleInkHardShadowVisibilityTap(shadowUv, receiverDepth);
}

float sampleInkWatercolorContouredHardShadowVisibility(vec3 shadowUvDepth) {
  vec2 clampedUv = clamp(shadowUvDepth.xy, vec2(0.0), vec2(1.0) - inkHardShadowTexelSize * 0.0001);
  vec2 texelPosition = clampedUv / inkHardShadowTexelSize - vec2(0.5);
  vec2 texelCell = floor(texelPosition);
  vec2 localPosition = fract(texelPosition);
  float bottomLeft = sampleInkWatercolorHardShadowVisibilityCell(texelCell, shadowUvDepth.z);
  float bottomRight = sampleInkWatercolorHardShadowVisibilityCell(texelCell + vec2(1.0, 0.0), shadowUvDepth.z);
  float topRight = sampleInkWatercolorHardShadowVisibilityCell(texelCell + vec2(1.0, 1.0), shadowUvDepth.z);
  float topLeft = sampleInkWatercolorHardShadowVisibilityCell(texelCell + vec2(0.0, 1.0), shadowUvDepth.z);
  return getInkWatercolorMarchingSquaresCoverage(bottomLeft, bottomRight, topRight, topLeft, localPosition);
}`;


function getInkHardShadowOwnerState(root: Object3D): InkHardShadowOwnerState {
  const existing = root.userData[INK_HARD_SHADOW_OWNER_STATE_KEY] as InkHardShadowOwnerState | undefined;
  if (existing) return existing;
  const created: InkHardShadowOwnerState = { id: { value: 0 } };
  root.userData[INK_HARD_SHADOW_OWNER_STATE_KEY] = created;
  return created;
}

/** Owner IDs are transient preview state and never enter a Studio work file. */
export function setInkHardShadowOwnerId(shapeRoot: Object3D, ownerId: number): void {
  const normalized = Number.isInteger(ownerId) && ownerId > 0
    ? Math.min(INK_HARD_SHADOW_OWNER_ID_LIMIT, ownerId)
    : 0;
  getInkHardShadowOwnerState(shapeRoot).id.value = normalized;
}

/**
 * Materializes only already-compiled ribbon attributes. Source strokes are
 * never sampled or triangulated in the Game Window.
 */
export function createInkGroupRenderRoot(
  data: InkGroupData,
  lighting = createInkFillLightingState(),
  appearance = createInkRenderAppearanceState(),
): Group {
  const root = new Group();
  root.name = 'InkGroup';
  const watercolorCapture = getOrCreateInkWatercolorCaptureState(root, data.id);
  root.position.set(data.anchorPosition.x, data.anchorPosition.y, data.anchorPosition.z);
  root.rotation.y = ((data.placementRotation ?? 0) * Math.PI) / 180;
  for (const shape of data.compiled.shapes) {
    const source = data.shapes.find((candidate) => candidate.id === shape.shapeId);
    const shapeRoot = source ? createInkShapeRenderRoot(shape, source, lighting, appearance, watercolorCapture) : null;
    if (shapeRoot) root.add(shapeRoot);
  }
  return root;
}

/** Creates one independently replaceable Shape root: Fill, authored Outline, then optional surface Ribbon. */
export function createInkShapeRenderRoot(
  shape: CompiledInkShape,
  source: InkShape,
  lighting = createInkFillLightingState(),
  appearance = createInkRenderAppearanceState(),
  watercolorCaptureState?: InkWatercolorCaptureState,
): Group {
  const root = new Group();
  root.name = 'InkShape';
  root.userData.inkShapeId = shape.shapeId;
  const watercolorCapture = watercolorCaptureState ?? createInkWatercolorCaptureState(source.id);
  root.userData[INK_WATERCOLOR_CAPTURE_STATE_KEY] = watercolorCapture;
  const hardShadowOwner = getInkHardShadowOwnerState(root);
  root.add(createInkShapeContentRoot());
  applyInkShapeRenderTransform(root, source);
  const content = getInkShapeContentRoot(root);
  for (const fill of shape.fill) content.add(createInkFillSurfaceMesh(
    fill,
    source,
    lighting,
    hardShadowOwner,
    appearance,
    watercolorCapture,
  ));
  const outline = createInkShapeRenderMesh(shape, source, false, appearance);
  if (outline) content.add(outline);
  const watercolorOutline = createInkShapeWatercolorOutlineMesh(shape, source, false, appearance);
  if (watercolorOutline) content.add(watercolorOutline);
  const surfaceOutline = createInkSurfaceOutlineRenderer(root, content, source, appearance);
  if (surfaceOutline) content.add(surfaceOutline.mesh);
  return root;
}

/** Reuses Fill Surface geometry/materials and changes only the affected texture payload. */
export function updateInkShapeFillSurfaces(
  root: Group,
  fills: readonly CompiledInkFillSurface[],
  source: InkShape,
  lighting = createInkFillLightingState(),
  appearance = createInkRenderAppearanceState(),
): void {
  const watercolorCapture = getOrCreateInkWatercolorCaptureState(root, source.id);
  const content = getInkShapeContentRoot(root);
  const existing = new Map<InkFillSurfaceId, Mesh>();
  for (const child of content.children) if (child instanceof Mesh && child.name === 'InkFillSurface' && typeof child.userData.inkFillSurfaceId === 'string') {
    existing.set(child.userData.inkFillSurfaceId as InkFillSurfaceId, child);
  }
  const nextIds = new Set(fills.map((fill) => fill.id));
  for (const [id, mesh] of existing) {
    if (nextIds.has(id)) continue;
    disposeInkFillSurfaceMesh(mesh);
    mesh.removeFromParent();
    existing.delete(id);
  }
  for (const fill of fills) {
    const mesh = existing.get(fill.id);
    if (mesh) updateInkFillSurfaceMesh(mesh, fill, source);
    else content.add(createInkFillSurfaceMesh(
      fill,
      source,
      lighting,
      getInkHardShadowOwnerState(root),
      appearance,
      watercolorCapture,
    ));
  }

  updateInkShapeSurfaceOutline(root, source, appearance);
}

/** Uploads Water/Water Eraser alpha runs without recompiling or recreating Fill resources. */
export function updateInkShapeFillAlphaPatches(
  root: Group,
  patches: readonly InkFillWaterAlphaPatch[],
): boolean {
  if (patches.length === 0) return true;
  const content = findInkShapeContentRoot(root);
  if (!content) return false;
  const meshes = new Map<InkFillSurfaceId, Mesh>();
  for (const child of content.children) if (child instanceof Mesh
    && child.name === 'InkFillSurface'
    && typeof child.userData.inkFillSurfaceId === 'string') {
    meshes.set(child.userData.inkFillSurfaceId as InkFillSurfaceId, child);
  }

  type PatchOperation = Readonly<{
    texture: DataTexture;
    image: { data: Uint8Array; width: number; height: number };
    textureX: number;
    textureY: number;
    alpha: Uint8Array;
  }>;
  const operations: PatchOperation[] = [];
  for (const patch of patches) {
    if (patch.alpha.length === 0) continue;
    const mesh = meshes.get(patch.id);
    const texture = mesh?.userData.inkFillTexture as DataTexture | undefined;
    const layout = mesh?.userData.inkFillTexturePatchLayout as InkFillTexturePatchLayout | undefined;
    const image = texture?.image as { data?: unknown; width?: unknown; height?: unknown } | undefined;
    if (!texture || !layout || !(image?.data instanceof Uint8Array)
      || typeof image.width !== 'number' || typeof image.height !== 'number'
      || !Number.isInteger(patch.x) || !Number.isInteger(patch.y)
      || patch.x < layout.minX || patch.x + patch.alpha.length > layout.minX + layout.width
      || patch.y < layout.minY || patch.y >= layout.minY + layout.height) return false;
    const textureX = layout.textureOffsetX + patch.x - layout.minX;
    const textureY = layout.textureOffsetY + patch.y - layout.minY;
    if (textureX < 0 || textureX + patch.alpha.length > image.width
      || textureY < 0 || textureY >= image.height) return false;
    operations.push({
      texture,
      image: image as { data: Uint8Array; width: number; height: number },
      textureX,
      textureY,
      alpha: patch.alpha,
    });
  }

  const touchedTextures = new Set(operations.map((operation) => operation.texture));
  for (const operation of operations) {
    const firstPixel = operation.textureY * operation.image.width + operation.textureX;
    for (let index = 0; index < operation.alpha.length; index += 1) {
      operation.image.data[(firstPixel + index) * 4 + 3] = operation.alpha[index]!;
    }
    operation.texture.addUpdateRange(firstPixel * 4, operation.alpha.length * 4);
  }
  for (const texture of touchedTextures) texture.needsUpdate = true;
  return true;
}

/** Uploads incremental Fill Blur RGB runs without rebuilding Fill resources. */
export function updateInkShapeFillRgbaPatches(
  root: Group,
  patches: readonly InkFillRgbaPatch[],
): boolean {
  if (patches.length === 0) return true;
  const content = findInkShapeContentRoot(root);
  if (!content) return false;
  const meshes = new Map<InkFillSurfaceId, Mesh>();
  for (const child of content.children) if (child instanceof Mesh
    && child.name === 'InkFillSurface'
    && typeof child.userData.inkFillSurfaceId === 'string') {
    meshes.set(child.userData.inkFillSurfaceId as InkFillSurfaceId, child);
  }

  type PatchOperation = Readonly<{
    texture: DataTexture;
    image: { data: Uint8Array; width: number; height: number };
    textureX: number;
    textureY: number;
    rgba: Uint8Array;
  }>;
  const operations: PatchOperation[] = [];
  for (const patch of patches) {
    if (patch.rgba.length === 0) continue;
    const pixelCount = patch.rgba.length / 4;
    const mesh = meshes.get(patch.id);
    const texture = mesh?.userData.inkFillTexture as DataTexture | undefined;
    const layout = mesh?.userData.inkFillTexturePatchLayout as InkFillTexturePatchLayout | undefined;
    const image = texture?.image as { data?: unknown; width?: unknown; height?: unknown } | undefined;
    if (!Number.isInteger(pixelCount) || !texture || !layout || !(image?.data instanceof Uint8Array)
      || typeof image.width !== 'number' || typeof image.height !== 'number'
      || !Number.isInteger(patch.x) || !Number.isInteger(patch.y)
      || patch.x < layout.minX || patch.x + pixelCount > layout.minX + layout.width
      || patch.y < layout.minY || patch.y >= layout.minY + layout.height) return false;
    const textureX = layout.textureOffsetX + patch.x - layout.minX;
    const textureY = layout.textureOffsetY + patch.y - layout.minY;
    if (textureX < 0 || textureX + pixelCount > image.width
      || textureY < 0 || textureY >= image.height) return false;
    operations.push({
      texture,
      image: image as { data: Uint8Array; width: number; height: number },
      textureX,
      textureY,
      rgba: patch.rgba,
    });
  }

  const pendingRanges = new Map<DataTexture, Array<readonly [number, number]>>();
  for (const operation of operations) {
    const firstPixel = operation.textureY * operation.image.width + operation.textureX;
    operation.image.data.set(operation.rgba, firstPixel * 4);
    let ranges = pendingRanges.get(operation.texture);
    if (!ranges) {
      operation.texture.clearUpdateRanges();
      ranges = [];
      pendingRanges.set(operation.texture, ranges);
    }
    ranges.push([firstPixel * 4, firstPixel * 4 + operation.rgba.length]);
  }
  for (const [texture, ranges] of pendingRanges) {
    ranges.sort((left, right) => left[0] - right[0]);
    let start = -1;
    let end = -1;
    for (const range of ranges) {
      if (start < 0) {
        start = range[0];
        end = range[1];
      } else if (range[0] <= end) {
        end = Math.max(end, range[1]);
      } else {
        texture.addUpdateRange(start, end - start);
        start = range[0];
        end = range[1];
      }
    }
    if (start >= 0) texture.addUpdateRange(start, end - start);
    texture.needsUpdate = true;
  }
  return true;
}

/** Updates the enabled analytic smooth-surface Ribbons for the active camera. */
export function updateInkSurfaceOutlines(root: Object3D, camera: Camera): void {
  root.traverse((object) => getInkSurfaceOutlineRenderer(object)?.update(camera));
}

/** Replaces only one Shape's compiled Ribbon while preserving its Fill resources. */
export function updateInkShapeRibbon(
  root: Group,
  ribbon: CompiledInkRibbon,
  source: InkShape,
  appearance = createInkRenderAppearanceState(),
): void {
  const content = getInkShapeContentRoot(root);
  for (const child of [...content.children]) {
    if (!(child instanceof Mesh) || (child.name !== 'InkShapeRibbon' && child.name !== 'InkShapeWatercolorRibbon')) continue;
    child.removeFromParent();
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  }
  if (ribbon.indices.length > 0) {
    const sourceOutline = createInkSourceRibbonMesh(ribbon, appearance);
    sourceOutline.name = 'InkShapeRibbon';
    sourceOutline.userData.inkShapeId = source.id;
    content.add(sourceOutline);
    const watercolorOutline = createInkWatercolorRibbonMesh(
      ribbon,
      source,
      appearance,
      createInkStableSeed(source.id),
    );
    watercolorOutline.name = 'InkShapeWatercolorRibbon';
    watercolorOutline.userData.inkShapeId = source.id;
    content.add(watercolorOutline);
  }
  updateInkShapeSurfaceOutline(root, source, appearance);
}

/**
 * Editor-only preview that retains one Geometry and Material for the entire
 * pointer gesture. Its buffers grow geometrically but are never recreated for
 * ordinary pointer movement.
 */
export class InkRibbonPreview {
  readonly mesh: Mesh;
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private capacity = 0;
  private position!: BufferAttribute;
  private previous!: BufferAttribute;
  private next!: BufferAttribute;
  private fallbackNormals!: BufferAttribute;
  private sides!: BufferAttribute;
  private tangentOffsets!: BufferAttribute;
  private widths!: BufferAttribute;
  private colors!: BufferAttribute;
  private indices!: BufferAttribute;

  constructor(createMaterial: () => ShaderMaterial = createInkPreviewRibbonMaterial) {
    this.material = createMaterial();
    this.ensureCapacity(2, 6);
    this.geometry.setDrawRange(0, 0);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'InkRibbonPreview';
    // The dynamic draw range has no stable bounding sphere while it grows.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  update(ribbon: CompiledInkRibbon): void {
    const vertexCount = ribbon.positions.length / 3;
    this.ensureCapacity(vertexCount, ribbon.indices.length);
    this.position.array.set(ribbon.positions);
    this.previous.array.set(ribbon.previous);
    this.next.array.set(ribbon.next);
    this.fallbackNormals.array.set(ribbon.fallbackNormals);
    this.sides.array.set(ribbon.sides);
    this.tangentOffsets.array.set(ribbon.tangentOffsets);
    this.widths.array.set(ribbon.widths);
    this.colors.array.set(ribbon.colors);
    this.indices.array.set(ribbon.indices);
    markDynamicUpdate(this.position, ribbon.positions.length);
    markDynamicUpdate(this.previous, ribbon.previous.length);
    markDynamicUpdate(this.next, ribbon.next.length);
    markDynamicUpdate(this.fallbackNormals, ribbon.fallbackNormals.length);
    markDynamicUpdate(this.sides, ribbon.sides.length);
    markDynamicUpdate(this.tangentOffsets, ribbon.tangentOffsets.length);
    markDynamicUpdate(this.widths, ribbon.widths.length);
    markDynamicUpdate(this.colors, ribbon.colors.length);
    markDynamicUpdate(this.indices, ribbon.indices.length);
    this.geometry.setDrawRange(0, ribbon.indices.length);
    this.mesh.visible = ribbon.indices.length > 0;
  }

  clear(): void {
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private ensureCapacity(vertexCount: number, indexCount: number): void {
    if (vertexCount <= this.capacity && indexCount <= this.indices?.array.length) return;
    this.capacity = Math.max(16, this.capacity * 2, vertexCount);
    const indexCapacity = Math.max(48, this.indices?.array.length ?? 0, indexCount, this.capacity * 3);
    this.position = createDynamicAttribute(this.capacity * 3, 3);
    this.previous = createDynamicAttribute(this.capacity * 3, 3);
    this.next = createDynamicAttribute(this.capacity * 3, 3);
    this.fallbackNormals = createDynamicAttribute(this.capacity * 3, 3);
    this.sides = createDynamicAttribute(this.capacity, 1);
    this.tangentOffsets = createDynamicAttribute(this.capacity, 1);
    this.widths = createDynamicAttribute(this.capacity, 1);
    this.colors = createDynamicAttribute(this.capacity * 3, 3);
    this.indices = new BufferAttribute(new Uint32Array(indexCapacity), 1).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('inkPrevious', this.previous);
    this.geometry.setAttribute('inkNext', this.next);
    this.geometry.setAttribute('inkFallbackNormal', this.fallbackNormals);
    this.geometry.setAttribute('inkSide', this.sides);
    this.geometry.setAttribute('inkTangentOffset', this.tangentOffsets);
    this.geometry.setAttribute('inkWidth', this.widths);
    this.geometry.setAttribute('color', this.colors);
    this.geometry.setIndex(this.indices);
  }
}

/**
 * Applies the authored Shape transform. Intrinsic dimensions live on the
 * content-coordinate child rather than the Shape transform itself. Ribbon
 * shader expansion remains in world units under every intrinsic dimension.
 */
export function applyInkShapeRenderTransform(target: Object3D, shape: InkShape): void {
  target.position.set(shape.position.x, shape.position.y, shape.position.z);
  target.rotation.set(shape.rotation.x, shape.rotation.y, shape.rotation.z, 'YXZ');
  const content = target instanceof Group ? findInkShapeContentRoot(target) : null;
  if (content) {
    target.scale.set(1, 1, 1);
    applyInkShapeContentDimensions(content, shape);
  } else {
    applyInkShapeContentDimensions(target, shape);
  }
  const shapeToGroup = createInkShapeToGroupMatrix(shape);
  target.traverse((object) => {
    const captureMaterial = object.userData[INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY] as ShaderMaterial | undefined;
    (captureMaterial?.uniforms.inkShapeToGroupMatrix?.value as Matrix4 | undefined)?.copy(shapeToGroup);
  });
}

/** Shape-local transform into the parent Ink Group, excluding group placement. */
function createInkShapeToGroupMatrix(shape: InkShape): Matrix4 {
  const transform = new Object3D();
  transform.position.set(shape.position.x, shape.position.y, shape.position.z);
  transform.rotation.set(shape.rotation.x, shape.rotation.y, shape.rotation.z, 'YXZ');
  applyInkShapeContentDimensions(transform, shape);
  transform.updateMatrix();
  return transform.matrix.clone();
}

/** Creates one independently replaceable Ink Shape render mesh. */
export function createInkShapeRenderMesh(
  shape: CompiledInkShape,
  source: InkShape,
  applyTransform = true,
  appearance = createInkRenderAppearanceState(),
): Mesh | null {
  if (shape.ribbon.indices.length === 0) return null;
  const mesh = createInkSourceRibbonMesh(shape.ribbon, appearance);
  mesh.name = 'InkShapeRibbon';
  mesh.userData.inkShapeId = shape.shapeId;
  if (applyTransform) applyInkShapeRenderTransform(mesh, source);
  return mesh;
}

/** Watercolor reuses compiled continuous Ribbon topology with Group-local grain. */
function createInkShapeWatercolorOutlineMesh(
  shape: CompiledInkShape,
  source: InkShape,
  applyTransform = true,
  appearance = createInkRenderAppearanceState(),
): Mesh | null {
  if (shape.ribbon.indices.length === 0) return null;
  const mesh = createInkWatercolorRibbonMesh(
    shape.ribbon,
    source,
    appearance,
    createInkStableSeed(source.id),
  );
  mesh.name = 'InkShapeWatercolorRibbon';
  mesh.userData.inkShapeId = shape.shapeId;
  if (applyTransform) applyInkShapeRenderTransform(mesh, source);
  return mesh;
}

type InkSurfaceOutlineShape = Extract<InkShape, { kind: 'sphere' | 'cylinder' }>;

const INK_SURFACE_OUTLINE_RENDERER_KEY = 'inkSurfaceOutlineRenderer';
const INK_SURFACE_OUTLINE_SPHERE_SEGMENTS = 48;
const INK_SURFACE_OUTLINE_COLOR = parseInkDisplayColor(DEFAULT_INK_STROKE_COLOR);
const INK_SPHERE_FILL_UNIFORMS: readonly Readonly<{ id: InkCuboidFace; name: string }>[] = [
  { id: 'positive-x', name: 'inkFillPositiveX' },
  { id: 'negative-x', name: 'inkFillNegativeX' },
  { id: 'positive-y', name: 'inkFillPositiveY' },
  { id: 'negative-y', name: 'inkFillNegativeY' },
  { id: 'positive-z', name: 'inkFillPositiveZ' },
  { id: 'negative-z', name: 'inkFillNegativeZ' },
];

/** One persistent dynamic Ribbon for an enabled analytic smooth Shape. */
class InkSurfaceOutlineRenderer {
  readonly mesh: Mesh;
  private readonly preview: InkRibbonPreview;
  private readonly material: ShaderMaterial;
  private readonly ribbon = createDynamicInkRibbon();
  private readonly localCamera = new Vector3();
  private readonly lastLocalCamera = new Vector3(Number.NaN, Number.NaN, Number.NaN);
  private readonly sphereAxis = new Vector3();
  private readonly sphereBasisA = new Vector3();
  private readonly sphereBasisB = new Vector3();
  private readonly spherePoints = Array.from({ length: INK_SURFACE_OUTLINE_SPHERE_SEGMENTS }, () => new Vector3());
  private readonly cylinderPoints = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private readonly cylinderNormals = [new Vector3(), new Vector3()];
  private readonly firstCylinderPoints: readonly Vector3[] = [this.cylinderPoints[0]!, this.cylinderPoints[1]!];
  private readonly secondCylinderPoints: readonly Vector3[] = [this.cylinderPoints[2]!, this.cylinderPoints[3]!];
  private readonly firstCylinderNormals: readonly Vector3[] = [this.cylinderNormals[0]!, this.cylinderNormals[0]!];
  private readonly secondCylinderNormals: readonly Vector3[] = [this.cylinderNormals[1]!, this.cylinderNormals[1]!];
  private readonly emptyFillAlphaTexture = createEmptyInkFillAlphaTexture();
  private hasResolvedCamera = false;

  constructor(
    private readonly content: Group,
    private readonly shape: InkSurfaceOutlineShape,
    appearance: InkRenderAppearanceState,
  ) {
    this.preview = new InkRibbonPreview(() => createInkSurfaceOutlineMaterial(
      shape,
      this.emptyFillAlphaTexture,
      appearance,
    ));
    this.mesh = this.preview.mesh;
    this.mesh.name = 'InkSurfaceOutline';
    this.mesh.layers.set(INK_RIBBON_RENDER_LAYER);
    this.mesh.userData.inkSurfaceOutlineShapeId = shape.id;
    this.mesh.userData.inkSurfaceOutlineEmptyFillAlphaTexture = this.emptyFillAlphaTexture;
    this.material = this.mesh.material as ShaderMaterial;
  }

  update(camera: Camera): void {
    this.content.updateWorldMatrix(true, false);
    this.localCamera.copy(camera.position);
    this.content.worldToLocal(this.localCamera);
    if (this.hasResolvedCamera && this.lastLocalCamera.distanceToSquared(this.localCamera) <= 1e-12) return;
    this.hasResolvedCamera = true;
    this.lastLocalCamera.copy(this.localCamera);
    const visible = this.shape.kind === 'sphere' ? this.updateSphereRibbon() : this.updateCylinderRibbons();
    if (!visible) {
      this.preview.clear();
      return;
    }
    this.preview.update(this.ribbon);
  }

  syncFillAlpha(): void {
    const fills = new Map<InkFillSurfaceId, InkFillAlphaSource>();
    for (const child of this.content.children) {
      if (!(child instanceof Mesh) || child.name !== 'InkFillSurface' || typeof child.userData.inkFillSurfaceId !== 'string') continue;
      const source = getInkFillAlphaSource(child);
      if (source) fills.set(child.userData.inkFillSurfaceId as InkFillSurfaceId, source);
    }
    if (this.shape.kind === 'cylinder') {
      setInkFillAlphaUniform(this.material, 'inkFillSide', fills.get('side'), this.emptyFillAlphaTexture);
      return;
    }
    for (const face of INK_SPHERE_FILL_UNIFORMS) setInkFillAlphaUniform(this.material, face.name, fills.get(face.id), this.emptyFillAlphaTexture);
  }

  matches(shape: InkShape): boolean {
    if ((shape.kind !== 'sphere' && shape.kind !== 'cylinder')
      || shape.kind !== this.shape.kind
      || shape.surfaceOutline.enabled !== this.shape.surfaceOutline.enabled
      || shape.surfaceOutline.width !== this.shape.surfaceOutline.width) return false;
    return shape.kind !== 'cylinder'
      || (this.shape.kind === 'cylinder'
        && shape.radius === this.shape.radius
        && shape.height === this.shape.height);
  }

  dispose(): void {
    this.preview.dispose();
    this.emptyFillAlphaTexture.dispose();
    delete this.mesh.userData.inkSurfaceOutlineEmptyFillAlphaTexture;
  }

  private updateSphereRibbon(): boolean {
    const distance = this.localCamera.length();
    if (distance <= 1.0001) return false;
    this.sphereAxis.copy(this.localCamera).multiplyScalar(1 / distance);
    const reference = Math.abs(this.sphereAxis.y) < 0.9 ? UP_AXIS : RIGHT_AXIS;
    this.sphereBasisA.crossVectors(this.sphereAxis, reference).normalize();
    this.sphereBasisB.crossVectors(this.sphereAxis, this.sphereBasisA).normalize();
    const circleCenter = 1 / distance;
    const circleRadius = Math.sqrt(Math.max(0, 1 - circleCenter * circleCenter));
    for (let index = 0; index < this.spherePoints.length; index += 1) {
      const angle = index / this.spherePoints.length * Math.PI * 2;
      this.spherePoints[index]!.copy(this.sphereAxis).multiplyScalar(circleCenter)
        .addScaledVector(this.sphereBasisA, Math.cos(angle) * circleRadius)
        .addScaledVector(this.sphereBasisB, Math.sin(angle) * circleRadius);
    }
    resetDynamicInkRibbon(this.ribbon);
    appendDynamicInkRibbonPath(this.ribbon, this.spherePoints, this.spherePoints, this.shape.surfaceOutline.width, true);
    return true;
  }

  private updateCylinderRibbons(): boolean {
    if (this.shape.kind !== 'cylinder') return false;
    const horizontalDistance = Math.hypot(this.localCamera.x, this.localCamera.z);
    const radius = this.shape.radius;
    if (horizontalDistance <= radius + 0.0001) return false;
    const viewX = this.localCamera.x / horizontalDistance;
    const viewZ = this.localCamera.z / horizontalDistance;
    const tangentCenterDistance = radius * radius / horizontalDistance;
    const tangentOffset = radius * Math.sqrt(Math.max(0, 1 - radius * radius / (horizontalDistance * horizontalDistance)));
    const centerX = viewX * tangentCenterDistance;
    const centerZ = viewZ * tangentCenterDistance;
    const perpendicularX = -viewZ * tangentOffset;
    const perpendicularZ = viewX * tangentOffset;
    const halfHeight = this.shape.height * 0.5;
    this.setCylinderGenerator(0, centerX + perpendicularX, centerZ + perpendicularZ, halfHeight);
    this.setCylinderGenerator(1, centerX - perpendicularX, centerZ - perpendicularZ, halfHeight);
    resetDynamicInkRibbon(this.ribbon);
    appendDynamicInkRibbonPath(this.ribbon, this.firstCylinderPoints, this.firstCylinderNormals, this.shape.surfaceOutline.width, false);
    appendDynamicInkRibbonPath(this.ribbon, this.secondCylinderPoints, this.secondCylinderNormals, this.shape.surfaceOutline.width, false);
    return true;
  }

  private setCylinderGenerator(generator: 0 | 1, x: number, z: number, halfHeight: number): void {
    if (this.shape.kind !== 'cylinder') return;
    const pointOffset = generator * 2;
    const normal = this.cylinderNormals[generator]!;
    normal.set(x / this.shape.radius, 0, z / this.shape.radius);
    this.cylinderPoints[pointOffset]!.set(x, -halfHeight, z);
    this.cylinderPoints[pointOffset + 1]!.set(x, halfHeight, z);
  }
}

type InkFillAlphaSource = Readonly<{
  texture: Texture;
  crop: Vector4;
  textureUvOffset: Vector2;
  textureUvScale: Vector2;
}>;

function createInkSurfaceOutlineRenderer(
  root: Group,
  content: Group,
  shape: InkShape,
  appearance: InkRenderAppearanceState,
): InkSurfaceOutlineRenderer | null {
  if ((shape.kind !== 'sphere' && shape.kind !== 'cylinder') || !shape.surfaceOutline.enabled) return null;
  const renderer = new InkSurfaceOutlineRenderer(content, shape, appearance);
  root.userData[INK_SURFACE_OUTLINE_RENDERER_KEY] = renderer;
  renderer.syncFillAlpha();
  return renderer;
}

function updateInkShapeSurfaceOutline(
  root: Group,
  shape: InkShape,
  appearance: InkRenderAppearanceState,
): void {
  const existing = getInkSurfaceOutlineRenderer(root);
  const shouldRender = (shape.kind === 'sphere' || shape.kind === 'cylinder') && shape.surfaceOutline.enabled;
  if (!shouldRender) {
    disposeInkSurfaceOutlineRenderer(root, existing);
    return;
  }
  if (existing?.matches(shape)) {
    existing.syncFillAlpha();
    return;
  }
  disposeInkSurfaceOutlineRenderer(root, existing);
  const next = createInkSurfaceOutlineRenderer(root, getInkShapeContentRoot(root), shape, appearance);
  if (next) getInkShapeContentRoot(root).add(next.mesh);
}

function disposeInkSurfaceOutlineRenderer(root: Group, renderer: InkSurfaceOutlineRenderer | null): void {
  if (!renderer) return;
  renderer.mesh.removeFromParent();
  renderer.dispose();
  delete root.userData[INK_SURFACE_OUTLINE_RENDERER_KEY];
}

function getInkSurfaceOutlineRenderer(root: Object3D): InkSurfaceOutlineRenderer | null {
  const renderer = root.userData[INK_SURFACE_OUTLINE_RENDERER_KEY];
  return renderer instanceof InkSurfaceOutlineRenderer ? renderer : null;
}

function createEmptyInkFillAlphaTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, RGBAFormat, UnsignedByteType);
  configureInkFillTexture(texture);
  return texture;
}

function getInkFillAlphaSource(mesh: Mesh): InkFillAlphaSource | null {
  const texture = mesh.userData.inkFillTexture;
  const material = mesh.material;
  if (!(texture instanceof Texture) || !(material instanceof ShaderMaterial)) return null;
  const min = material.uniforms.inkFillUvMin?.value;
  const size = material.uniforms.inkFillUvSize?.value;
  const textureUvOffset = material.uniforms.inkFillTextureUvOffset?.value;
  const textureUvScale = material.uniforms.inkFillTextureUvScale?.value;
  if (!(min instanceof Vector2) || !(size instanceof Vector2)
    || !(textureUvOffset instanceof Vector2) || !(textureUvScale instanceof Vector2)) return null;
  return {
    texture,
    crop: new Vector4(min.x, min.y, size.x, size.y),
    textureUvOffset: textureUvOffset.clone(),
    textureUvScale: textureUvScale.clone(),
  };
}

function setInkFillAlphaUniform(material: ShaderMaterial, name: string, source: InkFillAlphaSource | undefined, fallback: Texture): void {
  material.uniforms[name]!.value = source?.texture ?? fallback;
  (material.uniforms[`${name}Crop`]!.value as Vector4).copy(source?.crop ?? EMPTY_INK_FILL_ALPHA_CROP);
  (material.uniforms[`${name}TextureUvOffset`]!.value as Vector2).copy(source?.textureUvOffset ?? EMPTY_INK_FILL_TEXTURE_UV_OFFSET);
  (material.uniforms[`${name}TextureUvScale`]!.value as Vector2).copy(source?.textureUvScale ?? EMPTY_INK_FILL_TEXTURE_UV_SCALE);
}

const EMPTY_INK_FILL_ALPHA_CROP = new Vector4(0, 0, 1, 1);
const EMPTY_INK_FILL_TEXTURE_UV_OFFSET = new Vector2();
const EMPTY_INK_FILL_TEXTURE_UV_SCALE = new Vector2(1, 1);
const UP_AXIS = new Vector3(0, 1, 0);
const RIGHT_AXIS = new Vector3(1, 0, 0);

function parseInkDisplayColor(value: string): Readonly<{ r: number; g: number; b: number }> {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  return match
    ? { r: Number.parseInt(match[1]!, 16) / 255, g: Number.parseInt(match[2]!, 16) / 255, b: Number.parseInt(match[3]!, 16) / 255 }
    : { r: 0, g: 0, b: 0 };
}

function createDynamicInkRibbon(): CompiledInkRibbon {
  return { positions: [], previous: [], next: [], fallbackNormals: [], sides: [], tangentOffsets: [], widths: [], colors: [], indices: [] };
}

function resetDynamicInkRibbon(ribbon: CompiledInkRibbon): void {
  ribbon.positions.length = 0;
  ribbon.previous.length = 0;
  ribbon.next.length = 0;
  ribbon.fallbackNormals.length = 0;
  ribbon.sides.length = 0;
  ribbon.tangentOffsets.length = 0;
  ribbon.widths.length = 0;
  ribbon.colors.length = 0;
  ribbon.indices.length = 0;
}

function appendDynamicInkRibbonPath(
  ribbon: CompiledInkRibbon,
  points: readonly Vector3[],
  normals: readonly Vector3[],
  width: number,
  closed: boolean,
): void {
  if (points.length < 2 || points.length !== normals.length) return;
  const start = ribbon.positions.length / 3;
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[closed ? (index + points.length - 1) % points.length : Math.max(0, index - 1)]!;
    const following = points[closed ? (index + 1) % points.length : Math.min(points.length - 1, index + 1)]!;
    for (const side of [-1, 1]) appendDynamicInkRibbonVertex(ribbon, points[index]!, previous, following, normals[index]!, side, 0, width);
  }
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const first = start + index * 2;
    const next = start + ((index + 1) % points.length) * 2;
    ribbon.indices.push(first, first + 1, next, first + 1, next + 1, next);
  }
  if (closed) return;
  appendDynamicInkRibbonCap(ribbon, points[0]!, points[1]!, normals[0]!, width, -1);
  appendDynamicInkRibbonCap(ribbon, points[points.length - 1]!, points[points.length - 2]!, normals[points.length - 1]!, width, 1);
}

function appendDynamicInkRibbonCap(
  ribbon: CompiledInkRibbon,
  endpoint: Vector3,
  neighbour: Vector3,
  normal: Vector3,
  width: number,
  direction: -1 | 1,
): void {
  const prior = direction < 0 ? endpoint : neighbour;
  const following = direction < 0 ? neighbour : endpoint;
  const center = appendDynamicInkRibbonVertex(ribbon, endpoint, prior, following, normal, 0, 0, width);
  let previousArc = -1;
  for (let index = 0; index <= 6; index += 1) {
    const angle = Math.PI * index / 6;
    const currentArc = appendDynamicInkRibbonVertex(ribbon, endpoint, prior, following, normal, Math.cos(angle), direction * Math.sin(angle), width);
    if (previousArc >= 0) ribbon.indices.push(center, previousArc, currentArc);
    previousArc = currentArc;
  }
}

function appendDynamicInkRibbonVertex(
  ribbon: CompiledInkRibbon,
  current: Vector3,
  previous: Vector3,
  next: Vector3,
  normal: Vector3,
  side: number,
  tangentOffset: number,
  width: number,
): number {
  const index = ribbon.positions.length / 3;
  ribbon.positions.push(current.x, current.y, current.z);
  ribbon.previous.push(previous.x, previous.y, previous.z);
  ribbon.next.push(next.x, next.y, next.z);
  ribbon.fallbackNormals.push(normal.x, normal.y, normal.z);
  ribbon.sides.push(side);
  ribbon.tangentOffsets.push(tangentOffset);
  ribbon.widths.push(width);
  ribbon.colors.push(INK_SURFACE_OUTLINE_COLOR.r, INK_SURFACE_OUTLINE_COLOR.g, INK_SURFACE_OUTLINE_COLOR.b);
  return index;
}

function createInkShapeContentRoot(): Group {
  const content = new Group();
  content.name = 'InkShapeContent';
  return content;
}

function findInkShapeContentRoot(root: Group): Group | null {
  const content = root.children.find((child) => child instanceof Group && child.name === 'InkShapeContent');
  return content instanceof Group ? content : null;
}

function getInkShapeContentRoot(root: Group): Group {
  const content = findInkShapeContentRoot(root);
  if (!content) throw new Error('Ink Shape render root is missing its content coordinate space.');
  return content;
}

function applyInkShapeContentDimensions(target: Object3D, shape: InkShape): void {
  if (shape.kind === 'cuboid') target.scale.set(shape.size.x, shape.size.y, shape.size.z);
  else if (shape.kind === 'sphere') target.scale.setScalar(shape.radius);
  else target.scale.set(1, 1, 1);
}

function createInkFillSurfaceMesh(
  fill: CompiledInkFillSurface,
  shape: InkShape,
  lighting: InkFillLightingState,
  hardShadowOwner: InkHardShadowOwnerState,
  appearance: InkRenderAppearanceState,
  watercolorCapture: InkWatercolorCaptureState,
): Mesh {
  const textureLayout = createInkFillTextureLayout(fill, shape);
  const texture = createInkFillTexture(textureLayout);
  const material = createInkFillSurfaceMaterial(
    texture,
    fill,
    shape,
    textureLayout,
    lighting,
    hardShadowOwner,
    appearance,
  );
  const mesh = new Mesh(createInkFillSurfaceGeometry(fill, shape), material);
  mesh.name = 'InkFillSurface';
  mesh.layers.set(INK_FILL_RENDER_LAYER);
  mesh.userData.inkFillSurfaceId = fill.id;
  mesh.userData.inkFillTexture = texture;
  mesh.userData.inkFillTexturePatchLayout = getInkFillTexturePatchLayout(fill, textureLayout);
  mesh.userData.inkFillGeometryKey = getInkFillGeometryKey(fill, shape);
  // This material is used only by InkHardShadowMap. Keeping it separate from
  // castShadow prevents Ink from entering the shared PBR/Reference shadow map.
  mesh.userData.inkHardShadowDepthMaterial = createInkFillHardShadowDepthMaterial(material);
  mesh.userData[INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY] = createInkWatercolorFillCaptureMaterial(
    material,
    shape,
    watercolorCapture,
    appearance,
  );
  return mesh;
}

function updateInkFillSurfaceMesh(mesh: Mesh, fill: CompiledInkFillSurface, shape: InkShape): void {
  const textureLayout = createInkFillTextureLayout(fill, shape);
  const texture = mesh.userData.inkFillTexture as DataTexture;
  const image = texture.image as { data: Uint8Array; width: number; height: number };
  if (image.width !== textureLayout.width || image.height !== textureLayout.height) {
    const replacement = createInkFillTexture(textureLayout);
    (mesh.material as ShaderMaterial).uniforms.inkFillMap!.value = replacement;
    mesh.userData.inkFillTexture = replacement;
    texture.dispose();
  } else {
    let firstChanged = -1;
    let lastChanged = -1;
    for (let index = 0; index < textureLayout.data.length; index += 1) {
      const next = textureLayout.data[index] ?? 0;
      if (image.data[index] === next) continue;
      image.data[index] = next;
      if (firstChanged < 0) firstChanged = index;
      lastChanged = index;
    }
    if (firstChanged >= 0) {
      const firstChangedPixel = Math.floor(firstChanged / 4);
      const lastChangedPixel = Math.floor(lastChanged / 4);
      const firstChangedRow = Math.floor(firstChangedPixel / image.width);
      const lastChangedRow = Math.floor(lastChangedPixel / image.width);
      texture.clearUpdateRanges();
      for (let row = firstChangedRow; row <= lastChangedRow; row += 1) {
        const firstPixelInRow = row === firstChangedRow ? firstChangedPixel % image.width : 0;
        const lastPixelInRow = row === lastChangedRow ? lastChangedPixel % image.width : image.width - 1;
        texture.addUpdateRange(
          (row * image.width + firstPixelInRow) * 4,
          (lastPixelInRow - firstPixelInRow + 1) * 4,
        );
      }
      texture.needsUpdate = true;
    }
  }
  mesh.userData.inkFillTexturePatchLayout = getInkFillTexturePatchLayout(fill, textureLayout);
  const crop = getInkFillCrop(fill, shape);
  const material = mesh.material as ShaderMaterial;
  (material.uniforms.inkFillUvMin!.value as Vector2).set(crop.minX, crop.minY);
  (material.uniforms.inkFillUvSize!.value as Vector2).set(crop.width, crop.height);
  (material.uniforms.inkFillTextureUvOffset!.value as Vector2).copy(textureLayout.uvOffset);
  (material.uniforms.inkFillTextureUvScale!.value as Vector2).copy(textureLayout.uvScale);
  (material.uniforms.inkFillTexelSize!.value as Vector2).set(1 / textureLayout.width, 1 / textureLayout.height);
  const captureMaterial = mesh.userData[INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY] as ShaderMaterial | undefined;
  (captureMaterial?.uniforms.inkShapeToGroupMatrix?.value as Matrix4 | undefined)?.copy(createInkShapeToGroupMatrix(shape));
  const geometryKey = getInkFillGeometryKey(fill, shape);
  if (mesh.userData.inkFillGeometryKey !== geometryKey) {
    mesh.geometry.dispose();
    mesh.geometry = createInkFillSurfaceGeometry(fill, shape);
    mesh.userData.inkFillGeometryKey = geometryKey;
  }
}

function disposeInkFillSurfaceMesh(mesh: Mesh): void {
  (mesh.userData.inkFillTexture as DataTexture | undefined)?.dispose();
  (mesh.userData.inkHardShadowDepthMaterial as ShaderMaterial | undefined)?.dispose();
  (mesh.userData[INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY] as ShaderMaterial | undefined)?.dispose();
  mesh.geometry.dispose();
  (mesh.material as ShaderMaterial).dispose();
}

type InkFillTextureLayout = Readonly<{
  data: Uint8Array;
  width: number;
  height: number;
  uvOffset: Vector2;
  uvScale: Vector2;
  textureOffsetX: number;
  textureOffsetY: number;
}>;

type InkFillTexturePatchLayout = Readonly<{
  minX: number;
  minY: number;
  width: number;
  height: number;
  textureOffsetX: number;
  textureOffsetY: number;
}>;

function getInkFillTexturePatchLayout(
  fill: CompiledInkFillSurface,
  layout: InkFillTextureLayout,
): InkFillTexturePatchLayout {
  return {
    minX: fill.minX,
    minY: fill.minY,
    width: fill.width,
    height: fill.height,
    textureOffsetX: layout.textureOffsetX,
    textureOffsetY: layout.textureOffsetY,
  };
}

/**
 * Internal compact-chart boundaries receive transparent guard texels. A Fill
 * touching the finite chart boundary has no guard on that side, so hardware
 * clamp-to-edge repeats its authored border texel across numerical UV drift.
 */
function createInkFillTextureLayout(fill: CompiledInkFillSurface, shape: InkShape): InkFillTextureLayout {
  const dimensions = getInkFillChartDimensions(fill, shape);
  if (!dimensions) {
    return {
      data: new Uint8Array(fill.rgba),
      width: fill.width,
      height: fill.height,
      uvOffset: new Vector2(),
      uvScale: new Vector2(1, 1),
      textureOffsetX: 0,
      textureOffsetY: 0,
    };
  }
  const leftGuard = fill.minX > 0 ? 1 : 0;
  const rightGuard = fill.minX + fill.width < dimensions.width ? 1 : 0;
  const bottomGuard = fill.minY > 0 ? 1 : 0;
  const topGuard = fill.minY + fill.height < dimensions.height ? 1 : 0;
  const width = leftGuard + fill.width + rightGuard;
  const height = bottomGuard + fill.height + topGuard;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < fill.height; y += 1) {
    const sourceOffset = y * fill.width * 4;
    const destinationOffset = ((y + bottomGuard) * width + leftGuard) * 4;
    data.set(fill.rgba.slice(sourceOffset, sourceOffset + fill.width * 4), destinationOffset);
  }
  return {
    data,
    width,
    height,
    uvOffset: new Vector2(leftGuard / width, bottomGuard / height),
    uvScale: new Vector2(fill.width / width, fill.height / height),
    textureOffsetX: leftGuard,
    textureOffsetY: bottomGuard,
  };
}

function createInkFillTexture(layout: InkFillTextureLayout): DataTexture {
  const texture = new DataTexture(layout.data, layout.width, layout.height, RGBAFormat, UnsignedByteType);
  configureInkFillTexture(texture);
  return texture;
}

function configureInkFillTexture(texture: DataTexture): void {
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
}

function createInkDisplayDepthUniforms(displayDepth: InkDisplayDepthState, enabled: boolean): Record<string, IUniform> {
  return enabled ? {
    inkSceneDepth: displayDepth.sceneDepth,
    inkSceneDepthSize: { value: displayDepth.sceneDepthSize },
    inkSceneDepthEnabled: displayDepth.sceneDepthEnabled,
  } : {};
}

function createInkHardShadowUniforms(
  lighting: InkFillLightingState,
  hardShadowOwner: InkHardShadowOwnerState,
  enabled: boolean,
): Record<string, IUniform> {
  return enabled ? {
    inkHardShadowMap: lighting.hardShadowMap,
    inkHardShadowOwnerMap: lighting.hardShadowOwnerMap,
    inkHardShadowTexelSize: { value: lighting.hardShadowTexelSize },
    inkHardShadowMatrix: { value: lighting.hardShadowMatrix },
    inkHardShadowEnabled: lighting.hardShadowEnabled,
    inkHardShadowOwnerMapEnabled: lighting.hardShadowOwnerMapEnabled,
    inkHardShadowOwnerId: hardShadowOwner.id,
  } : {};
}

const INK_DISPLAY_DEPTH_FRAGMENT = `
uniform sampler2D inkSceneDepth;
uniform vec2 inkSceneDepthSize;
uniform float inkSceneDepthEnabled;

bool isInkOccludedByScene() {
  if (inkSceneDepthEnabled < 0.5) return false;
  vec2 sceneUv = gl_FragCoord.xy / inkSceneDepthSize;
  float sceneDepth = texture2D(inkSceneDepth, sceneUv).x;
  return gl_FragCoord.z > sceneDepth + 0.00002;
}`;

const INK_NO_DISPLAY_DEPTH_FRAGMENT = `
bool isInkOccludedByScene() { return false; }`;

function getInkDisplayDepthFragment(features: InkRenderFeatures): string {
  return features.sceneDepth ? INK_DISPLAY_DEPTH_FRAGMENT : INK_NO_DISPLAY_DEPTH_FRAGMENT;
}

function createInkFillSurfaceMaterial(
  texture: DataTexture,
  fill: CompiledInkFillSurface,
  shape: InkShape,
  textureLayout: InkFillTextureLayout,
  lighting: InkFillLightingState,
  hardShadowOwner: InkHardShadowOwnerState,
  appearance: InkRenderAppearanceState,
): ShaderMaterial {
  const displayDepth = createInkDisplayDepthState();
  const features = STUDIO_INK_RENDER_FEATURES;
  const crop = getInkFillCrop(fill, shape);
  return new ShaderMaterial({
    uniforms: {
      inkFillMap: { value: texture },
      inkFillUvMin: { value: new Vector2(crop.minX, crop.minY) },
      inkFillUvSize: { value: new Vector2(crop.width, crop.height) },
      inkFillTextureUvOffset: { value: textureLayout.uvOffset.clone() },
      inkFillTextureUvScale: { value: textureLayout.uvScale.clone() },
      inkFillTexelSize: { value: new Vector2(1 / textureLayout.width, 1 / textureLayout.height) },
      inkWatercolorEnabled: appearance.watercolorEnabled,
      inkLightDirection: { value: lighting.lightDirection },
      inkAmbientIrradiance: { value: lighting.ambientIrradiance },
      ...createInkHardShadowUniforms(lighting, hardShadowOwner, features.hardShadows),
      ...createInkDisplayDepthUniforms(displayDepth, features.sceneDepth),
    },
    transparent: false,
    depthTest: true,
    depthWrite: true,
    // Visible Fill can be authored from either side.
    side: DoubleSide,
    toneMapped: false,
    vertexShader: `
varying vec2 vInkFillUv;
varying vec3 vInkWorldPosition;
varying vec3 vInkWorldNormal;
void main() {
  vInkFillUv = uv;
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vInkWorldPosition = worldPosition.xyz;
  vInkWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}`,
    fragmentShader: `
uniform sampler2D inkFillMap;
uniform vec2 inkFillUvMin;
uniform vec2 inkFillUvSize;
uniform vec2 inkFillTextureUvOffset;
uniform vec2 inkFillTextureUvScale;
uniform vec2 inkFillTexelSize;
uniform float inkWatercolorEnabled;
uniform vec3 inkLightDirection;
uniform vec3 inkAmbientIrradiance;
${features.hardShadows ? `
uniform sampler2D inkHardShadowMap;
uniform sampler2D inkHardShadowOwnerMap;
uniform vec2 inkHardShadowTexelSize;
uniform mat4 inkHardShadowMatrix;
uniform float inkHardShadowEnabled;
uniform float inkHardShadowOwnerMapEnabled;
uniform float inkHardShadowOwnerId;
` : ''}
varying vec2 vInkFillUv;
varying vec3 vInkWorldPosition;
varying vec3 vInkWorldNormal;
${getInkDisplayDepthFragment(features)}

${INK_WATERCOLOR_MARCHING_SQUARES_GLSL}

${features.hardShadows ? INK_WATERCOLOR_CONTOURED_HARD_SHADOW_GLSL : ''}

${INK_WATERCOLOR_CONTOURED_FILL_GLSL}

void main() {
  vec2 fillUv = (vInkFillUv - inkFillUvMin) / inkFillUvSize;
  vec2 textureUv = inkFillTextureUvOffset + fillUv * inkFillTextureUvScale;
  vec2 domainUv = getInkWatercolorContourDomainUv(textureUv);
  float displayCoverage = inkWatercolorEnabled > 0.5
    ? getInkWatercolorContourCoverage(domainUv)
    : step(0.5, sampleInkWatercolorNearestSource(domainUv).a);
  if (displayCoverage < 0.5) discard;
  vec4 sourceColour = inkWatercolorEnabled > 0.5
    ? sampleInkWatercolorContouredSource(domainUv)
    : sampleInkWatercolorNearestSource(domainUv);
  if (isInkOccludedByScene()) discard;
  vec3 baseWash = sourceColour.rgb;
  vec3 normal = vInkWorldNormal;
  float normalLength = length(normal);
  normal = normalLength > 0.00001 ? normal / normalLength : vec3(0.0, 1.0, 0.0);
  if (!gl_FrontFacing) normal = -normal;
  vec3 lightDirection = inkLightDirection;
  float lightDirectionLength = length(lightDirection);
  lightDirection = lightDirectionLength > 0.00001 ? lightDirection / lightDirectionLength : vec3(0.0, 1.0, 0.0);
  float normalLight = dot(normal, lightDirection);
  float halfLambert = clamp(normalLight * 0.5 + 0.5, 0.0, 1.0);
  float directBand = halfLambert >= 0.5 ? 1.0 : 0.5;
  ${features.hardShadows ? `
  if (directBand > 0.5 && inkHardShadowEnabled > 0.5) {
    vec4 shadowPosition = inkHardShadowMatrix * vec4(vInkWorldPosition, 1.0);
    vec3 shadowUvDepth = shadowPosition.xyz / shadowPosition.w;
    bool inside = shadowUvDepth.x >= 0.0 && shadowUvDepth.x <= 1.0
      && shadowUvDepth.y >= 0.0 && shadowUvDepth.y <= 1.0
      && shadowUvDepth.z >= 0.0 && shadowUvDepth.z <= 1.0;
    if (inside) {
      float shadowVisibility = inkWatercolorEnabled > 0.5
        ? sampleInkWatercolorContouredHardShadowVisibility(shadowUvDepth)
        : sampleInkHardShadowCenterVisibility(shadowUvDepth);
      directBand = mix(0.5, 1.0, shadowVisibility);
    }
  }
` : ''}
  gl_FragColor = vec4(baseWash * (vec3(directBand) + inkAmbientIrradiance), 1.0);
}`,
  });
}

/**
 * Captures the visible, lit Watercolor Fill colour in a viewport-local target.
 */
function createInkWatercolorFillCaptureMaterial(
  fillMaterial: ShaderMaterial,
  shape: InkShape,
  watercolorCapture: InkWatercolorCaptureState,
  appearance: InkRenderAppearanceState,
): ShaderMaterial {
  const features = STUDIO_INK_RENDER_FEATURES;
  const material = new ShaderMaterial({
    name: 'InkWatercolorFillCaptureMaterial',
    glslVersion: GLSL3,
    uniforms: {
      inkFillMap: fillMaterial.uniforms.inkFillMap!,
      inkFillUvMin: fillMaterial.uniforms.inkFillUvMin!,
      inkFillUvSize: fillMaterial.uniforms.inkFillUvSize!,
      inkFillTextureUvOffset: fillMaterial.uniforms.inkFillTextureUvOffset!,
      inkFillTextureUvScale: fillMaterial.uniforms.inkFillTextureUvScale!,
      inkFillTexelSize: fillMaterial.uniforms.inkFillTexelSize!,
      inkLightDirection: fillMaterial.uniforms.inkLightDirection!,
      inkAmbientIrradiance: fillMaterial.uniforms.inkAmbientIrradiance!,
      inkShapeToGroupMatrix: { value: createInkShapeToGroupMatrix(shape) },
      inkWatercolorNoiseSeed: watercolorCapture.stableSeed,
      inkWatercolorNoiseScale: appearance.watercolorNoiseScale,
      ...(features.hardShadows ? {
        inkHardShadowMap: fillMaterial.uniforms.inkHardShadowMap!,
        inkHardShadowOwnerMap: fillMaterial.uniforms.inkHardShadowOwnerMap!,
        inkHardShadowTexelSize: fillMaterial.uniforms.inkHardShadowTexelSize!,
        inkHardShadowMatrix: fillMaterial.uniforms.inkHardShadowMatrix!,
        inkHardShadowEnabled: fillMaterial.uniforms.inkHardShadowEnabled!,
        inkHardShadowOwnerMapEnabled: fillMaterial.uniforms.inkHardShadowOwnerMapEnabled!,
        inkHardShadowOwnerId: fillMaterial.uniforms.inkHardShadowOwnerId!,
      } : {}),
      ...(features.sceneDepth ? {
        inkSceneDepth: fillMaterial.uniforms.inkSceneDepth!,
        inkSceneDepthSize: fillMaterial.uniforms.inkSceneDepthSize!,
        inkSceneDepthEnabled: fillMaterial.uniforms.inkSceneDepthEnabled!,
      } : {}),
    },
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    toneMapped: false,
vertexShader: `
uniform mat4 inkShapeToGroupMatrix;
varying vec2 vInkFillUv;
varying vec3 vInkWorldPosition;
varying vec3 vInkWorldNormal;
varying vec3 vInkGroupPosition;
void main() {
  vInkFillUv = uv;
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vInkWorldPosition = worldPosition.xyz;
  vInkWorldNormal = normalize(mat3(modelMatrix) * normal);
  vInkGroupPosition = (inkShapeToGroupMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}`,
    fragmentShader: `
layout(location = 0) out highp vec4 inkWatercolorShaded;
layout(location = 1) out highp vec4 inkWatercolorNoise;
uniform sampler2D inkFillMap;
uniform vec2 inkFillUvMin;
uniform vec2 inkFillUvSize;
uniform vec2 inkFillTextureUvOffset;
uniform vec2 inkFillTextureUvScale;
uniform vec2 inkFillTexelSize;
uniform vec3 inkLightDirection;
uniform vec3 inkAmbientIrradiance;
uniform float inkWatercolorNoiseSeed;
uniform float inkWatercolorNoiseScale;
${features.hardShadows ? `
uniform sampler2D inkHardShadowMap;
uniform sampler2D inkHardShadowOwnerMap;
uniform vec2 inkHardShadowTexelSize;
uniform mat4 inkHardShadowMatrix;
uniform float inkHardShadowEnabled;
uniform float inkHardShadowOwnerMapEnabled;
uniform float inkHardShadowOwnerId;
` : ''}
varying vec2 vInkFillUv;
varying vec3 vInkWorldPosition;
varying vec3 vInkWorldNormal;
varying vec3 vInkGroupPosition;
${getInkDisplayDepthFragment(features)}

${INK_WATERCOLOR_MARCHING_SQUARES_GLSL}

${features.hardShadows ? INK_WATERCOLOR_CONTOURED_HARD_SHADOW_GLSL : ''}

${INK_WATERCOLOR_CONTOURED_FILL_GLSL}

${INK_WATERCOLOR_WET_WASH_GLSL}

float inkWatercolorNoiseHash(vec3 value) {
  return fract(sin(dot(value, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

float inkWatercolorSmoothNoise(vec3 value) {
  vec3 cell = floor(value);
  vec3 localPosition = fract(value);
  vec3 blend = localPosition * localPosition * localPosition
    * (localPosition * (localPosition * 6.0 - 15.0) + 10.0);
  float x00 = mix(inkWatercolorNoiseHash(cell), inkWatercolorNoiseHash(cell + vec3(1.0, 0.0, 0.0)), blend.x);
  float x10 = mix(inkWatercolorNoiseHash(cell + vec3(0.0, 1.0, 0.0)), inkWatercolorNoiseHash(cell + vec3(1.0, 1.0, 0.0)), blend.x);
  float x01 = mix(inkWatercolorNoiseHash(cell + vec3(0.0, 0.0, 1.0)), inkWatercolorNoiseHash(cell + vec3(1.0, 0.0, 1.0)), blend.x);
  float x11 = mix(inkWatercolorNoiseHash(cell + vec3(0.0, 1.0, 1.0)), inkWatercolorNoiseHash(cell + vec3(1.0, 1.0, 1.0)), blend.x);
  return mix(mix(x00, x10, blend.y), mix(x01, x11, blend.y), blend.z);
}

vec2 getInkWatercolorNoise() {
  float scale = max(inkWatercolorNoiseScale, 0.001);
  vec3 position = vInkGroupPosition * scale;
  vec3 seedOffset = vec3(
    inkWatercolorNoiseSeed * 197.0,
    inkWatercolorNoiseSeed * 389.0,
    inkWatercolorNoiseSeed * 571.0
  );
  return vec2(
    inkWatercolorSmoothNoise(position + seedOffset),
    inkWatercolorSmoothNoise(position + seedOffset.yzx + vec3(17.0, 31.0, 47.0))
  );
}

void main() {
  vec2 fillUv = (vInkFillUv - inkFillUvMin) / inkFillUvSize;
  vec2 textureUv = inkFillTextureUvOffset + fillUv * inkFillTextureUvScale;
  vec2 domainUv = getInkWatercolorContourDomainUv(textureUv);
  if (getInkWatercolorContourCoverage(domainUv) < 0.5) discard;
  vec4 sourceColour = sampleInkWatercolorContouredSource(domainUv);
  if (isInkOccludedByScene()) discard;

  vec3 normal = vInkWorldNormal;
  float normalLength = length(normal);
  normal = normalLength > 0.00001 ? normal / normalLength : vec3(0.0, 1.0, 0.0);
  if (!gl_FrontFacing) normal = -normal;
  vec3 lightDirection = inkLightDirection;
  float lightDirectionLength = length(lightDirection);
  lightDirection = lightDirectionLength > 0.00001 ? lightDirection / lightDirectionLength : vec3(0.0, 1.0, 0.0);
  float halfLambert = clamp(dot(normal, lightDirection) * 0.5 + 0.5, 0.0, 1.0);
  float directBand = halfLambert >= 0.5 ? 1.0 : 0.5;
  ${features.hardShadows ? `
  if (directBand > 0.5 && inkHardShadowEnabled > 0.5) {
    vec4 shadowPosition = inkHardShadowMatrix * vec4(vInkWorldPosition, 1.0);
    vec3 shadowUvDepth = shadowPosition.xyz / shadowPosition.w;
    bool inside = shadowUvDepth.x >= 0.0 && shadowUvDepth.x <= 1.0
      && shadowUvDepth.y >= 0.0 && shadowUvDepth.y <= 1.0
      && shadowUvDepth.z >= 0.0 && shadowUvDepth.z <= 1.0;
    if (inside) directBand = mix(0.5, 1.0, sampleInkWatercolorContouredHardShadowVisibility(shadowUvDepth));
  }
` : ''}
  float waterAmount = clamp((1.0 - sourceColour.a) * 2.0, 0.0, 1.0);
  float wetVariation = (getInkWatercolorNoise().x - 0.5) * 0.04 * waterAmount;
  vec3 baseWash = getInkWatercolorWetWash(sourceColour.rgb, clamp(waterAmount + wetVariation, 0.0, 1.0));
  vec3 shadedColor = baseWash * (vec3(directBand) + inkAmbientIrradiance);
  inkWatercolorShaded = vec4(shadedColor, 1.0);
  inkWatercolorNoise = vec4(getInkWatercolorNoise(), waterAmount, 1.0);
}`,
  });
  return material;
}

/** The dynamic Ribbon samples Fill alpha in the Shape's source chart space. */
function createInkSurfaceOutlineMaterial(
  shape: InkSurfaceOutlineShape,
  emptyFillAlphaTexture: Texture,
  appearance: InkRenderAppearanceState,
): ShaderMaterial {
  const displayDepth = createInkDisplayDepthState();
  const features = STUDIO_INK_RENDER_FEATURES;
  const isSphere = shape.kind === 'sphere';
  return new ShaderMaterial({
    vertexColors: true,
    uniforms: {
      ...createInkDisplayDepthUniforms(displayDepth, features.sceneDepth),
      ...createInkCrayonOutlineUniforms(shape, appearance, createInkStableSeed(shape.id)),
      ...(shape.kind === 'sphere'
        ? createInkSphereFillAlphaUniforms(emptyFillAlphaTexture)
        : createInkCylinderFillAlphaUniforms(shape.height, emptyFillAlphaTexture)),
    },
    // Layered Ribbon fragments intentionally accumulate like repeated crayon
    // pressure. The material keeps scene-depth testing but cannot write depth,
    // otherwise a translucent fragment would incorrectly hide later pigment.
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
    vertexShader: createInkCrayonRibbonVertexShader(
      'varying vec3 vInkSurfacePosition;',
      'vInkSurfacePosition = position;',
    ),
    fragmentShader: `
varying vec3 vInkColor;
varying vec3 vInkSurfacePosition;
${INK_CRAYON_OUTLINE_FRAGMENT_UNIFORMS}
${isSphere ? INK_SPHERE_FILL_ALPHA_FRAGMENT : INK_CYLINDER_FILL_ALPHA_FRAGMENT}
${INK_CRAYON_OUTLINE_FRAGMENT}
${getInkDisplayDepthFragment(features)}

void main() {
  if (getInkSurfaceFillAlpha() < 0.5) discard;
  if (isInkOccludedByScene()) discard;
  float opacity = inkWatercolorEnabled > 0.5 ? getInkCrayonOutlineOpacity() : 1.0;
  gl_FragColor = vec4(vInkColor, opacity);
}`,
  });
}

function createInkSphereFillAlphaUniforms(emptyFillAlphaTexture: Texture): Record<string, { value: Texture | Vector2 | Vector4 }> {
  const uniforms: Record<string, { value: Texture | Vector2 | Vector4 }> = {};
  for (const face of INK_SPHERE_FILL_UNIFORMS) {
    uniforms[face.name] = { value: emptyFillAlphaTexture };
    uniforms[`${face.name}Crop`] = { value: EMPTY_INK_FILL_ALPHA_CROP.clone() };
    uniforms[`${face.name}TextureUvOffset`] = { value: EMPTY_INK_FILL_TEXTURE_UV_OFFSET.clone() };
    uniforms[`${face.name}TextureUvScale`] = { value: EMPTY_INK_FILL_TEXTURE_UV_SCALE.clone() };
  }
  return uniforms;
}

function createInkCylinderFillAlphaUniforms(height: number, emptyFillAlphaTexture: Texture): Record<string, { value: Texture | Vector2 | Vector4 | number }> {
  return {
    inkFillSide: { value: emptyFillAlphaTexture },
    inkFillSideCrop: { value: EMPTY_INK_FILL_ALPHA_CROP.clone() },
    inkFillSideTextureUvOffset: { value: EMPTY_INK_FILL_TEXTURE_UV_OFFSET.clone() },
    inkFillSideTextureUvScale: { value: EMPTY_INK_FILL_TEXTURE_UV_SCALE.clone() },
    inkCylinderHeight: { value: height },
  };
}

const INK_SURFACE_FILL_ALPHA_HELPER = `
float sampleInkFillAlpha(sampler2D map, vec4 crop, vec2 textureUvOffset, vec2 textureUvScale, vec2 chartUv) {
  vec2 textureUv = (chartUv - crop.xy) / crop.zw;
  return texture2D(map, textureUvOffset + textureUv * textureUvScale).a;
}`;

const INK_SPHERE_FILL_ALPHA_FRAGMENT = `
uniform sampler2D inkFillPositiveX;
uniform sampler2D inkFillNegativeX;
uniform sampler2D inkFillPositiveY;
uniform sampler2D inkFillNegativeY;
uniform sampler2D inkFillPositiveZ;
uniform sampler2D inkFillNegativeZ;
uniform vec4 inkFillPositiveXCrop;
uniform vec4 inkFillNegativeXCrop;
uniform vec4 inkFillPositiveYCrop;
uniform vec4 inkFillNegativeYCrop;
uniform vec4 inkFillPositiveZCrop;
uniform vec4 inkFillNegativeZCrop;
uniform vec2 inkFillPositiveXTextureUvOffset;
uniform vec2 inkFillNegativeXTextureUvOffset;
uniform vec2 inkFillPositiveYTextureUvOffset;
uniform vec2 inkFillNegativeYTextureUvOffset;
uniform vec2 inkFillPositiveZTextureUvOffset;
uniform vec2 inkFillNegativeZTextureUvOffset;
uniform vec2 inkFillPositiveXTextureUvScale;
uniform vec2 inkFillNegativeXTextureUvScale;
uniform vec2 inkFillPositiveYTextureUvScale;
uniform vec2 inkFillNegativeYTextureUvScale;
uniform vec2 inkFillPositiveZTextureUvScale;
uniform vec2 inkFillNegativeZTextureUvScale;
${INK_SURFACE_FILL_ALPHA_HELPER}

float getInkSurfaceFillAlpha() {
  vec3 direction = normalize(vInkSurfacePosition);
  vec3 magnitude = abs(direction);
  if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) {
    float divisor = max(0.00000001, magnitude.x);
    vec2 chartUv = direction.x >= 0.0
      ? vec2(direction.z / divisor, direction.y / divisor) * 0.5 + 0.5
      : vec2(-direction.z / divisor, direction.y / divisor) * 0.5 + 0.5;
    return direction.x >= 0.0
      ? sampleInkFillAlpha(inkFillPositiveX, inkFillPositiveXCrop, inkFillPositiveXTextureUvOffset, inkFillPositiveXTextureUvScale, chartUv)
      : sampleInkFillAlpha(inkFillNegativeX, inkFillNegativeXCrop, inkFillNegativeXTextureUvOffset, inkFillNegativeXTextureUvScale, chartUv);
  }
  if (magnitude.y >= magnitude.z) {
    float divisor = max(0.00000001, magnitude.y);
    vec2 chartUv = direction.y >= 0.0
      ? vec2(direction.x / divisor, direction.z / divisor) * 0.5 + 0.5
      : vec2(direction.x / divisor, -direction.z / divisor) * 0.5 + 0.5;
    return direction.y >= 0.0
      ? sampleInkFillAlpha(inkFillPositiveY, inkFillPositiveYCrop, inkFillPositiveYTextureUvOffset, inkFillPositiveYTextureUvScale, chartUv)
      : sampleInkFillAlpha(inkFillNegativeY, inkFillNegativeYCrop, inkFillNegativeYTextureUvOffset, inkFillNegativeYTextureUvScale, chartUv);
  }
  float divisor = max(0.00000001, magnitude.z);
  vec2 chartUv = direction.z >= 0.0
    ? vec2(direction.x / divisor, direction.y / divisor) * 0.5 + 0.5
    : vec2(-direction.x / divisor, direction.y / divisor) * 0.5 + 0.5;
  return direction.z >= 0.0
    ? sampleInkFillAlpha(inkFillPositiveZ, inkFillPositiveZCrop, inkFillPositiveZTextureUvOffset, inkFillPositiveZTextureUvScale, chartUv)
    : sampleInkFillAlpha(inkFillNegativeZ, inkFillNegativeZCrop, inkFillNegativeZTextureUvOffset, inkFillNegativeZTextureUvScale, chartUv);
}`;

const INK_CYLINDER_FILL_ALPHA_FRAGMENT = `
uniform sampler2D inkFillSide;
uniform vec4 inkFillSideCrop;
uniform vec2 inkFillSideTextureUvOffset;
uniform vec2 inkFillSideTextureUvScale;
uniform float inkCylinderHeight;
${INK_SURFACE_FILL_ALPHA_HELPER}

float getInkSurfaceFillAlpha() {
  float angle = atan(vInkSurfacePosition.z, vInkSurfacePosition.x);
  vec2 chartUv = vec2(angle / (3.141592653589793 * 2.0) + 0.5, vInkSurfacePosition.y / inkCylinderHeight + 0.5);
  return sampleInkFillAlpha(inkFillSide, inkFillSideCrop, inkFillSideTextureUvOffset, inkFillSideTextureUvScale, chartUv);
}`;

/**
 * The dedicated Ink shadow pass must discard the same transparent pixels as
 * the visible Fill shader. Otherwise each sparse Fill atlas would cast its
 * whole rectangular chart into the scene.
 */
function createInkFillHardShadowDepthMaterial(fillMaterial: ShaderMaterial): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      inkFillMap: fillMaterial.uniforms.inkFillMap!,
      inkFillUvMin: fillMaterial.uniforms.inkFillUvMin!,
      inkFillUvSize: fillMaterial.uniforms.inkFillUvSize!,
      inkFillTextureUvOffset: fillMaterial.uniforms.inkFillTextureUvOffset!,
      inkFillTextureUvScale: fillMaterial.uniforms.inkFillTextureUvScale!,
      inkFillTexelSize: fillMaterial.uniforms.inkFillTexelSize!,
      inkHardShadowOwnerId: fillMaterial.uniforms.inkHardShadowOwnerId!,
    },
    depthTest: true,
    depthWrite: true,
    colorWrite: true,
    side: DoubleSide,
    vertexShader: `
varying vec2 vInkFillUv;
void main() {
  vInkFillUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: `
uniform sampler2D inkFillMap;
uniform vec2 inkFillUvMin;
uniform vec2 inkFillUvSize;
uniform vec2 inkFillTextureUvOffset;
uniform vec2 inkFillTextureUvScale;
uniform vec2 inkFillTexelSize;
uniform float inkHardShadowOwnerId;
varying vec2 vInkFillUv;
void main() {
  vec2 fillUv = (vInkFillUv - inkFillUvMin) / inkFillUvSize;
  vec2 textureUv = inkFillTextureUvOffset + fillUv * inkFillTextureUvScale;
  vec2 halfTexel = inkFillTexelSize * 0.5;
  vec2 contentMin = inkFillTextureUvOffset + halfTexel;
  vec2 contentMax = inkFillTextureUvOffset + inkFillTextureUvScale - halfTexel;
  vec2 contentUv = clamp(textureUv, contentMin, contentMax);
  vec2 sourceTexelUv = (floor(contentUv / inkFillTexelSize) + vec2(0.5)) * inkFillTexelSize;
  if (texture2D(inkFillMap, sourceTexelUv).a < 0.5) discard;
  gl_FragColor = vec4(inkHardShadowOwnerId / 255.0, 0.0, 0.0, 1.0);
}`,
  });
}

function createInkFillSurfaceGeometry(fill: CompiledInkFillSurface, shape: InkShape): BufferGeometry {
  if (shape.kind === 'plane') {
    const width = fill.width / INK_FILL_PIXELS_PER_WORLD_UNIT;
    const height = fill.height / INK_FILL_PIXELS_PER_WORLD_UNIT;
    const geometry = new PlaneGeometry(width, height);
    geometry.translate((fill.minX + fill.width * 0.5) / INK_FILL_PIXELS_PER_WORLD_UNIT, (fill.minY + fill.height * 0.5) / INK_FILL_PIXELS_PER_WORLD_UNIT, 0);
    return geometry;
  }
  if (shape.kind === 'cuboid') return isInkCuboidFace(fill.id) ? createCuboidFillSurfaceGeometry(fill.id) : new BufferGeometry();
  if (shape.kind === 'sphere') return isInkCuboidFace(fill.id) ? createSphereFillSurfaceGeometry(fill.id) : new BufferGeometry();
  if (shape.kind === 'cylinder') return createCylinderFillSurfaceGeometry(shape, fill.id);
  return createFrustumFillSurfaceGeometry(shape, fill.id);
}

function createCuboidFillSurfaceGeometry(id: InkCuboidFace): BufferGeometry {
  return createSurfaceQuad(
    getCuboidFacePosition(id, -0.5, -0.5),
    getCuboidFacePosition(id, 0.5, -0.5),
    getCuboidFacePosition(id, -0.5, 0.5),
    getCuboidFacePosition(id, 0.5, 0.5),
    id === 'positive-z' || id === 'negative-z',
  );
}

function createSphereFillSurfaceGeometry(id: InkCuboidFace): BufferGeometry {
  const geometry = new BufferGeometry();
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const segments = INK_SPHERE_FACE_SEGMENTS;
  for (let y = 0; y <= segments; y += 1) for (let x = 0; x <= segments; x += 1) {
    const u = x / segments - 0.5;
    const v = y / segments - 0.5;
    const position = getCuboidFacePosition(id, u, v).normalize();
    positions.push(position.x, position.y, position.z);
    uvs.push(x / segments, y / segments);
  }
  for (let y = 0; y < segments; y += 1) for (let x = 0; x < segments; x += 1) {
    const topLeft = y * (segments + 1) + x;
    const topRight = topLeft + 1;
    const bottomLeft = topLeft + segments + 1;
    const bottomRight = bottomLeft + 1;
    if (id === 'positive-z' || id === 'negative-z') {
      indices.push(topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft);
    } else {
      indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createCylinderFillSurfaceGeometry(shape: Extract<InkShape, { kind: 'cylinder' }>, id: InkFillSurfaceId): BufferGeometry {
  if (id === 'side') {
    const geometry = new BufferGeometry();
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let index = 0; index <= INK_CYLINDER_SEGMENTS; index += 1) {
      const fraction = index / INK_CYLINDER_SEGMENTS;
      // The side Fill chart stores the local +X generator at u = 0.5.
      // Reverse that offset here so the shader's atan2 chart lookup samples
      // the authored Fill at its matching cylinder-side position.
      const angle = (fraction - 0.5) * Math.PI * 2;
      const x = Math.cos(angle) * shape.radius;
      const z = Math.sin(angle) * shape.radius;
      positions.push(x, -shape.height * 0.5, z, x, shape.height * 0.5, z);
      uvs.push(fraction, 0, fraction, 1);
    }
    for (let index = 0; index < INK_CYLINDER_SEGMENTS; index += 1) {
      const bottomLeft = index * 2;
      const topLeft = bottomLeft + 1;
      const bottomRight = bottomLeft + 2;
      const topRight = bottomLeft + 3;
      indices.push(bottomLeft, topLeft, bottomRight, topLeft, topRight, bottomRight);
    }
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }
  if (id === 'top' || id === 'bottom') return createCylinderCapFillGeometry(shape, id);
  return new BufferGeometry();
}

function createCylinderCapFillGeometry(shape: Extract<InkShape, { kind: 'cylinder' }>, side: 'top' | 'bottom'): BufferGeometry {
  const geometry = new BufferGeometry();
  const y = side === 'top' ? shape.height * 0.5 : -shape.height * 0.5;
  const positions: number[] = [0, y, 0];
  const uvs: number[] = [0.5, 0.5];
  const indices: number[] = [];
  for (let index = 0; index < INK_CYLINDER_SEGMENTS; index += 1) {
    const angle = index / INK_CYLINDER_SEGMENTS * Math.PI * 2;
    const x = Math.cos(angle) * shape.radius;
    const z = Math.sin(angle) * shape.radius;
    positions.push(x, y, z);
    uvs.push(x / (shape.radius * 2) + 0.5, z / (shape.radius * 2) + 0.5);
  }
  for (let index = 0; index < INK_CYLINDER_SEGMENTS; index += 1) {
    const current = index + 1;
    const next = (index + 1) % INK_CYLINDER_SEGMENTS + 1;
    if (side === 'top') indices.push(0, next, current);
    else indices.push(0, current, next);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createFrustumFillSurfaceGeometry(shape: Extract<InkShape, { kind: 'frustum' }>, id: InkFillSurfaceId): BufferGeometry {
  if (!isInkCuboidFace(id)) return new BufferGeometry();
  return createSurfaceQuad(
    getInkFrustumFacePosition(shape, { face: id, u: -0.5, v: -0.5, pressure: 1 }),
    getInkFrustumFacePosition(shape, { face: id, u: 0.5, v: -0.5, pressure: 1 }),
    getInkFrustumFacePosition(shape, { face: id, u: -0.5, v: 0.5, pressure: 1 }),
    getInkFrustumFacePosition(shape, { face: id, u: 0.5, v: 0.5, pressure: 1 }),
    id === 'positive-z' || id === 'negative-z',
  );
}

function getInkFillCrop(fill: CompiledInkFillSurface, shape: InkShape): { minX: number; minY: number; width: number; height: number } {
  if (shape.kind === 'plane') return { minX: 0, minY: 0, width: 1, height: 1 };
  const dimensions = getInkFillChartDimensions(fill, shape) ?? { width: 1, height: 1 };
  return { minX: fill.minX / dimensions.width, minY: fill.minY / dimensions.height, width: fill.width / dimensions.width, height: fill.height / dimensions.height };
}

function getInkFillChartDimensions(fill: CompiledInkFillSurface, shape: InkShape): { width: number; height: number } | null {
  if (shape.kind === 'plane') return null;
  return shape.kind === 'cuboid' && isInkCuboidFace(fill.id)
    ? getCuboidFaceFillDimensions(shape, fill.id)
    : shape.kind === 'sphere' && isInkCuboidFace(fill.id)
      ? { width: Math.max(1, Math.ceil(shape.radius * 2 * INK_FILL_PIXELS_PER_WORLD_UNIT)), height: Math.max(1, Math.ceil(shape.radius * 2 * INK_FILL_PIXELS_PER_WORLD_UNIT)) }
      : shape.kind === 'cylinder'
        ? getCylinderFillDimensions(shape, fill.id)
      : shape.kind === 'frustum' && isInkCuboidFace(fill.id)
          ? getFrustumFillDimensions(shape, fill.id)
      : null;
}

function getInkFillGeometryKey(fill: CompiledInkFillSurface, shape: InkShape): string {
  if (shape.kind === 'plane') return `${fill.minX}:${fill.minY}:${fill.width}:${fill.height}`;
  if (shape.kind === 'cylinder') return `cylinder:${fill.id}:${shape.radius}:${shape.height}`;
  if (shape.kind === 'frustum') return `frustum:${fill.id}:${shape.topSize}:${shape.bottomSize}:${shape.height}`;
  return shape.kind;
}

/** `±Z` use the opposite winding under Ink's persisted u/v chart convention. */
function createSurfaceQuad(
  topLeft: Vector3,
  topRight: Vector3,
  bottomLeft: Vector3,
  bottomRight: Vector3,
  reverseWinding = false,
): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    topLeft.x, topLeft.y, topLeft.z,
    topRight.x, topRight.y, topRight.z,
    bottomLeft.x, bottomLeft.y, bottomLeft.z,
    bottomRight.x, bottomRight.y, bottomRight.z,
  ], 3));
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geometry.setIndex(reverseWinding ? [0, 1, 2, 1, 3, 2] : [0, 2, 1, 1, 2, 3]);
  geometry.computeVertexNormals();
  return geometry;
}

function getCuboidFaceFillDimensions(shape: Extract<InkShape, { kind: 'cuboid' }>, face: InkCuboidFace): { width: number; height: number } {
  const horizontal = face === 'positive-x' || face === 'negative-x' ? shape.size.z : shape.size.x;
  const vertical = face === 'positive-y' || face === 'negative-y' ? shape.size.z : shape.size.y;
  return { width: Math.max(1, Math.ceil(horizontal * INK_FILL_PIXELS_PER_WORLD_UNIT)), height: Math.max(1, Math.ceil(vertical * INK_FILL_PIXELS_PER_WORLD_UNIT)) };
}

function isInkCuboidFace(id: InkFillSurfaceId): id is InkCuboidFace {
  return id === 'positive-x' || id === 'negative-x' || id === 'positive-y'
    || id === 'negative-y' || id === 'positive-z' || id === 'negative-z';
}

function getCylinderFillDimensions(shape: Extract<InkShape, { kind: 'cylinder' }>, id: InkFillSurfaceId): { width: number; height: number } {
  if (id === 'side') return {
    width: Math.max(1, Math.ceil(Math.PI * 2 * shape.radius * INK_FILL_PIXELS_PER_WORLD_UNIT)),
    height: Math.max(1, Math.ceil(shape.height * INK_FILL_PIXELS_PER_WORLD_UNIT)),
  };
  const side = Math.max(1, Math.ceil(shape.radius * 2 * INK_FILL_PIXELS_PER_WORLD_UNIT));
  return { width: side, height: side };
}

function getFrustumFillDimensions(shape: Extract<InkShape, { kind: 'frustum' }>, id: InkFillSurfaceId): { width: number; height: number } {
  if (id === 'positive-y' || id === 'negative-y') {
    const size = id === 'positive-y' ? shape.topSize : shape.bottomSize;
    const pixels = Math.max(1, Math.ceil(size * INK_FILL_PIXELS_PER_WORLD_UNIT));
    return { width: pixels, height: pixels };
  }
  const width = Math.max(1, Math.ceil((shape.topSize + shape.bottomSize) * 0.5 * INK_FILL_PIXELS_PER_WORLD_UNIT));
  const height = Math.max(1, Math.ceil(Math.hypot(shape.height, (shape.topSize - shape.bottomSize) * 0.5) * INK_FILL_PIXELS_PER_WORLD_UNIT));
  return { width, height };
}

/** Unit-box local coordinates match Ink's persisted Cuboid face u/v convention. */
function getCuboidFacePosition(face: InkCuboidFace, u: number, v: number): Vector3 {
  if (face === 'positive-x') return new Vector3(0.5, v, u);
  if (face === 'negative-x') return new Vector3(-0.5, v, -u);
  if (face === 'positive-y') return new Vector3(u, 0.5, v);
  if (face === 'negative-y') return new Vector3(u, -0.5, -v);
  if (face === 'positive-z') return new Vector3(u, v, 0.5);
  return new Vector3(-u, v, -0.5);
}

function createInkSourceRibbonMesh(
  ribbon: CompiledInkRibbon,
  appearance = createInkRenderAppearanceState(),
): Mesh {
  const mesh = new Mesh(createInkRibbonGeometry(ribbon), createInkSourceRibbonMaterial(appearance));
  mesh.name = 'InkRibbon';
  mesh.layers.set(INK_RIBBON_RENDER_LAYER);
  return mesh;
}

function createInkWatercolorRibbonMesh(
  ribbon: CompiledInkRibbon,
  source: InkShape,
  appearance: InkRenderAppearanceState,
  stableSeed: number,
): Mesh {
  const mesh = new Mesh(createInkRibbonGeometry(ribbon), createInkWatercolorRibbonMaterial(source, appearance, stableSeed));
  mesh.name = 'InkWatercolorRibbon';
  mesh.layers.set(INK_RIBBON_RENDER_LAYER);
  return mesh;
}

function createInkRibbonGeometry(ribbon: CompiledInkRibbon): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(ribbon.positions, 3));
  geometry.setAttribute('inkPrevious', new Float32BufferAttribute(ribbon.previous, 3));
  geometry.setAttribute('inkNext', new Float32BufferAttribute(ribbon.next, 3));
  geometry.setAttribute('inkFallbackNormal', new Float32BufferAttribute(ribbon.fallbackNormals, 3));
  geometry.setAttribute('inkSide', new Float32BufferAttribute(ribbon.sides, 1));
  geometry.setAttribute('inkTangentOffset', new Float32BufferAttribute(ribbon.tangentOffsets, 1));
  geometry.setAttribute('inkWidth', new Float32BufferAttribute(ribbon.widths, 1));
  geometry.setAttribute('color', new Float32BufferAttribute(ribbon.colors, 3));
  geometry.setIndex(ribbon.indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createInkSourceRibbonMaterial(
  appearance = createInkRenderAppearanceState(),
): ShaderMaterial {
  const displayDepth = createInkDisplayDepthState();
  const features = STUDIO_INK_RENDER_FEATURES;
  return new ShaderMaterial({
    vertexColors: true,
    uniforms: {
      ...createInkDisplayDepthUniforms(displayDepth, features.sceneDepth),
      inkWatercolorEnabled: appearance.watercolorEnabled,
    },
    transparent: false,
    depthTest: true,
    depthWrite: true,
    // The ribbon's lateral direction is derived from the current camera, so a
    // visible stroke cannot rely on a fixed geometric front face.
    side: DoubleSide,
    toneMapped: false,
    vertexShader: createInkRibbonVertexShader(),
    fragmentShader: `
varying vec3 vInkColor;
uniform float inkWatercolorEnabled;
${getInkDisplayDepthFragment(features)}

void main() {
  if (inkWatercolorEnabled > 0.5) discard;
  if (isInkOccludedByScene()) discard;
  gl_FragColor = vec4(vInkColor, 1.0);
}`,
  });
}

function createInkPreviewRibbonMaterial(): ShaderMaterial {
  const displayDepth = createInkDisplayDepthState();
  const features = STUDIO_INK_RENDER_FEATURES;
  return new ShaderMaterial({
    vertexColors: true,
    uniforms: createInkDisplayDepthUniforms(displayDepth, features.sceneDepth),
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    toneMapped: false,
    vertexShader: createInkRibbonVertexShader(),
    fragmentShader: `
varying vec3 vInkColor;
${getInkDisplayDepthFragment(features)}
void main() {
  if (isInkOccludedByScene()) discard;
  gl_FragColor = vec4(vInkColor, 1.0);
}`,
  });
}

function createInkWatercolorRibbonMaterial(
  shape: InkShape,
  appearance: InkRenderAppearanceState,
  stableSeed: number,
): ShaderMaterial {
  const displayDepth = createInkDisplayDepthState();
  const features = STUDIO_INK_RENDER_FEATURES;
  return new ShaderMaterial({
    vertexColors: true,
    uniforms: {
      ...createInkDisplayDepthUniforms(displayDepth, features.sceneDepth),
      ...createInkCrayonOutlineUniforms(shape, appearance, stableSeed),
    },
    // Layered Ribbon fragments intentionally accumulate like repeated crayon
    // pressure. The material keeps scene-depth testing but cannot write depth,
    // otherwise a translucent fragment would incorrectly hide later pigment.
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
    vertexShader: createInkCrayonRibbonVertexShader(),
    fragmentShader: `
varying vec3 vInkColor;
${INK_CRAYON_OUTLINE_FRAGMENT_UNIFORMS}
${getInkDisplayDepthFragment(features)}
${INK_CRAYON_OUTLINE_FRAGMENT}

void main() {
  if (inkWatercolorEnabled < 0.5) discard;
  if (isInkOccludedByScene()) discard;
  float opacity = getInkCrayonOutlineOpacity();
  gl_FragColor = vec4(vInkColor, opacity);
}`,
  });
}

function createInkRibbonVertexShader(
  extraVaryings = '',
  extraAssignments = '',
  ribbonWidthExpression = 'inkWidth',
  extraFunctions = '',
): string {
  return `
attribute vec3 inkPrevious;
attribute vec3 inkNext;
attribute vec3 inkFallbackNormal;
attribute float inkSide;
attribute float inkTangentOffset;
attribute float inkWidth;
varying vec3 vInkColor;
${extraVaryings}
${extraFunctions}

void main() {
  vec3 currentWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 previousWorld = (modelMatrix * vec4(inkPrevious, 1.0)).xyz;
  vec3 nextWorld = (modelMatrix * vec4(inkNext, 1.0)).xyz;
  vec3 tangent = nextWorld - previousWorld;
  float tangentLength = length(tangent);
  tangent = tangentLength > 0.00001 ? tangent / tangentLength : vec3(1.0, 0.0, 0.0);
  vec3 viewDirection = normalize(cameraPosition - currentWorld);
  vec3 sideways = cross(viewDirection, tangent);
  float sidewaysLength = length(sideways);
  vec3 normalWorld = normalize(mat3(modelMatrix) * inkFallbackNormal);
  if (dot(viewDirection, normalWorld) < 0.0) normalWorld = -normalWorld;
  vec3 fallbackSideways = cross(normalWorld, tangent);
  float fallbackLength = length(fallbackSideways);
  fallbackSideways = fallbackLength > 0.00001 ? fallbackSideways / fallbackLength : vec3(1.0, 0.0, 0.0);
  vec3 viewSideways = sidewaysLength > 0.00001 ? sideways / sidewaysLength : fallbackSideways;
  // Blend before the camera direction becomes parallel to a stroke. This keeps
  // neighbouring vertices in one continuous frame instead of threshold-flipping.
  sideways = normalize(mix(fallbackSideways, viewSideways, smoothstep(0.0005, 0.02, sidewaysLength)));
  float ribbonWidth = ${ribbonWidthExpression};
  float halfWidth = ribbonWidth * 0.5;
  float surfaceDepthClearance = (
    abs(dot(sideways, normalWorld) * inkSide)
    + abs(dot(tangent, normalWorld) * inkTangentOffset)
  ) * halfWidth + max(0.0005, ribbonWidth * 0.01);
  float viewNormalAlignment = max(dot(viewDirection, normalWorld), 0.2);
  // A world-space clearance becomes a smaller clip-depth delta as the camera
  // moves away. This keeps a Ribbon over its own Fill without allowing the
  // fixed raster-space polygon offset to grow into a foreground crossing.
  float viewDepthOffset = min(surfaceDepthClearance / viewNormalAlignment, ribbonWidth * 2.0);
  vec3 widenedWorld = currentWorld + (sideways * inkSide + tangent * inkTangentOffset) * halfWidth;
  vec4 viewPosition = viewMatrix * vec4(widenedWorld, 1.0);
  vec4 clipPosition = projectionMatrix * viewPosition;
  vec4 depthOffsetClipPosition = projectionMatrix * vec4(viewPosition.xyz + vec3(0.0, 0.0, viewDepthOffset), 1.0);
  vInkColor = color;
  ${extraAssignments}
  gl_Position = clipPosition;
  gl_Position.z = clipPosition.w * depthOffsetClipPosition.z / depthOffsetClipPosition.w;
}`;
}

function createInkCrayonOutlineUniforms(
  shape: InkShape,
  appearance: InkRenderAppearanceState,
  stableSeed: number,
): Record<string, { value: number | Matrix3 | Matrix4 }> {
  const shapeToGroup = createInkShapeToGroupMatrix(shape);
  return {
    inkWatercolorEnabled: appearance.watercolorEnabled,
    inkCrayonSeed: { value: stableSeed },
    inkCrayonGrainDensity: appearance.crayonGrainDensity,
    inkCrayonMinimumOpacity: appearance.crayonMinimumOpacity,
    inkShapeToGroupMatrix: { value: shapeToGroup },
    inkShapeNormalToGroupMatrix: { value: new Matrix3().getNormalMatrix(shapeToGroup) },
  };
}

function createInkCrayonRibbonVertexShader(extraVaryings = '', extraAssignments = ''): string {
  return createInkRibbonVertexShader(
    `${extraVaryings}
varying vec2 vInkCrayonRibbonCoordinate;
varying vec3 vInkCrayonSamplePosition;
uniform mat4 inkShapeToGroupMatrix;
uniform mat3 inkShapeNormalToGroupMatrix;`,
    `${extraAssignments}
  vInkCrayonRibbonCoordinate = vec2(inkSide, inkTangentOffset);
  // Reconstruct the stable, physically expanded Ribbon point in the parent
  // Ink Group's local space. This deliberately uses neither the camera-facing
  // billboard direction nor any path-length parameter for the grain field.
  vec3 groupCenter = (inkShapeToGroupMatrix * vec4(position, 1.0)).xyz;
  vec3 groupPrevious = (inkShapeToGroupMatrix * vec4(inkPrevious, 1.0)).xyz;
  vec3 groupNext = (inkShapeToGroupMatrix * vec4(inkNext, 1.0)).xyz;
  vec3 groupTangent = groupNext - groupPrevious;
  float groupTangentLength = length(groupTangent);
  groupTangent = groupTangentLength > 0.00001 ? groupTangent / groupTangentLength : vec3(1.0, 0.0, 0.0);
  vec3 groupNormal = inkShapeNormalToGroupMatrix * inkFallbackNormal;
  float groupNormalLength = length(groupNormal);
  groupNormal = groupNormalLength > 0.00001 ? groupNormal / groupNormalLength : vec3(0.0, 0.0, 1.0);
  vec3 groupSideways = cross(groupNormal, groupTangent);
  float groupSidewaysLength = length(groupSideways);
  groupSideways = groupSidewaysLength > 0.00001 ? groupSideways / groupSidewaysLength : vec3(1.0, 0.0, 0.0);
  vInkCrayonSamplePosition = groupCenter
    + (groupSideways * inkSide + groupTangent * inkTangentOffset) * inkWidth * 0.5;`,
  );
}

const INK_CRAYON_OUTLINE_FRAGMENT_UNIFORMS = `
varying vec2 vInkCrayonRibbonCoordinate;
varying vec3 vInkCrayonSamplePosition;
uniform float inkWatercolorEnabled;
uniform float inkCrayonSeed;
uniform float inkCrayonGrainDensity;
uniform float inkCrayonMinimumOpacity;`;

const INK_CRAYON_OUTLINE_FRAGMENT = `
float inkCrayonOutlineHash(vec3 value) {
  return fract(sin(dot(value, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

float inkCrayonOutlineNoise(vec3 value) {
  vec3 cell = floor(value);
  vec3 localPosition = fract(value);
  // Quintic interpolation makes both the pigment value and its first
  // derivative continuous at cell boundaries, unlike a cell-constant hash.
  vec3 blend = localPosition * localPosition * localPosition
    * (localPosition * (localPosition * 6.0 - 15.0) + 10.0);
  float x00 = mix(inkCrayonOutlineHash(cell), inkCrayonOutlineHash(cell + vec3(1.0, 0.0, 0.0)), blend.x);
  float x10 = mix(inkCrayonOutlineHash(cell + vec3(0.0, 1.0, 0.0)), inkCrayonOutlineHash(cell + vec3(1.0, 1.0, 0.0)), blend.x);
  float x01 = mix(inkCrayonOutlineHash(cell + vec3(0.0, 0.0, 1.0)), inkCrayonOutlineHash(cell + vec3(1.0, 0.0, 1.0)), blend.x);
  float x11 = mix(inkCrayonOutlineHash(cell + vec3(0.0, 1.0, 1.0)), inkCrayonOutlineHash(cell + vec3(1.0, 1.0, 1.0)), blend.x);
  return mix(mix(x00, x10, blend.y), mix(x01, x11, blend.y), blend.z);
}

float getInkCrayonOutlineOpacity() {
  // Grain is sampled from the reconstructed Group-local point, so original
  // segment length never determines the size or phase of a grain cell.
  float edgeDistance = length(vInkCrayonRibbonCoordinate);
  float protectedCore = 1.0 - smoothstep(0.12, 0.32, edgeDistance);
  vec3 toothPosition = vInkCrayonSamplePosition * inkCrayonGrainDensity + vec3(
    inkCrayonSeed * 197.0,
    inkCrayonSeed * 389.0,
    inkCrayonSeed * 571.0
  );
  float tooth = inkCrayonOutlineNoise(toothPosition);
  float edgeWear = smoothstep(0.16, 0.98, edgeDistance);
  float cutoff = mix(0.22, 0.56, edgeWear);
  float pigmentMask = sqrt(smoothstep(cutoff, cutoff + 0.12, tooth));
  float wearCoverage = mix(inkCrayonMinimumOpacity, 1.0, pigmentMask);

  // The core retains high continuous coverage to preserve stroke readability;
  // a user-set floor of 1.0 deliberately restores full opacity.
  float protectedCoreCoverage = max(0.92, inkCrayonMinimumOpacity);
  float targetCoverage = mix(wearCoverage, protectedCoreCoverage, protectedCore);

  // Keep the Group-local wax wear as true continuous alpha. The material uses
  // normal transparent blending, so overlapping Ribbon fragments retain their
  // pressure-like accumulation without turning sub-pixel coverage into 0/1
  // holes that can visibly shimmer during motion.
  return targetCoverage;
}`;

/** Stable [0, 1) shader seed derived from a persisted Ink identifier. */
function createInkStableSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function createDynamicAttribute(length: number, itemSize: number): BufferAttribute {
  return new BufferAttribute(new Float32Array(length), itemSize).setUsage(DynamicDrawUsage);
}

function markDynamicUpdate(attribute: BufferAttribute, count: number): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count);
  attribute.needsUpdate = true;
}
