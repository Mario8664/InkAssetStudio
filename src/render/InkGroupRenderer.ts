import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DynamicDrawUsage,
  DoubleSide,
  Float32BufferAttribute,
  Group,
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
} from 'three';
import {
  DEFAULT_INK_NORMAL_OUTSET_COLOR,
  DEFAULT_INK_NORMAL_OUTSET_DISTANCE,
  INK_CYLINDER_SEGMENTS,
  INK_FILL_PIXELS_PER_WORLD_UNIT,
  INK_SPHERE_FACE_SEGMENTS,
  getInkFrustumFacePosition,
  type CompiledInkFillSurface,
  type CompiledInkNormalOutset,
  type CompiledInkRibbon,
  type CompiledInkShape,
  type InkCuboidFace,
  type InkFillSurfaceId,
  type InkGroupData,
  type InkShape,
} from '../domain/ink/ink';

/** Studio previews current source settings before the Worker result arrives. */
export type InkShapeRenderOptions = {
  useSourceNormalOutset?: boolean;
};

/** Shared mutable uniforms for every Fill material mounted by one GridSceneView. */
export type InkFillLightingState = {
  lightDirection: Vector3;
  ambientIrradiance: Vector3;
  hardShadowMap: { value: Texture | null };
  hardShadowMatrix: Matrix4;
  hardShadowBias: { value: number };
  hardShadowNormalBias: { value: number };
  hardShadowEnabled: { value: number };
};

export function createInkFillLightingState(): InkFillLightingState {
  return {
    lightDirection: new Vector3(-4.5, 7.5, 4.5).normalize(),
    ambientIrradiance: new Vector3(0.22, 0.22, 0.22),
    hardShadowMap: { value: null },
    hardShadowMatrix: new Matrix4(),
    hardShadowBias: { value: 0.00125 },
    hardShadowNormalBias: { value: 1 / INK_FILL_PIXELS_PER_WORLD_UNIT },
    hardShadowEnabled: { value: 0 },
  };
}

/**
 * Materializes only already-compiled ribbon attributes. Source strokes are
 * never sampled or triangulated in the Game Window.
 */
export function createInkGroupRenderRoot(
  data: InkGroupData,
  lighting = createInkFillLightingState(),
  options: InkShapeRenderOptions = {},
): Group {
  const root = new Group();
  root.name = 'InkGroup';
  root.position.set(data.anchorPosition.x, data.anchorPosition.y, data.anchorPosition.z);
  root.rotation.y = ((data.placementRotation ?? 0) * Math.PI) / 180;
  for (const shape of data.compiled.shapes) {
    const source = data.shapes.find((candidate) => candidate.id === shape.shapeId);
    const shapeRoot = source ? createInkShapeRenderRoot(shape, source, lighting, options) : null;
    if (shapeRoot) root.add(shapeRoot);
  }
  return root;
}

/** Creates one independently replaceable Shape root: Fill, alpha-clipped outset shell, then Outline. */
export function createInkShapeRenderRoot(
  shape: CompiledInkShape,
  source: InkShape,
  lighting = createInkFillLightingState(),
  options: InkShapeRenderOptions = {},
): Group {
  const root = new Group();
  root.name = 'InkShape';
  root.userData.inkShapeId = shape.shapeId;
  root.add(createInkShapeContentRoot());
  applyInkShapeRenderTransform(root, source);
  const content = getInkShapeContentRoot(root);
  for (const fill of shape.fill) content.add(createInkFillSurfaceMesh(fill, source, lighting));
  updateInkShapeNormalOutset(root, shape.normalOutset, source, options);
  const outline = createInkShapeRenderMesh(shape, source, false);
  if (outline) content.add(outline);
  return root;
}

/** Reuses Fill Surface geometry/materials and changes only the affected texture payload. */
export function updateInkShapeFillSurfaces(
  root: Group,
  fills: readonly CompiledInkFillSurface[],
  normalOutset: CompiledInkNormalOutset | null,
  source: InkShape,
  lighting = createInkFillLightingState(),
  options: InkShapeRenderOptions = {},
): void {
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
    else content.add(createInkFillSurfaceMesh(fill, source, lighting));
  }

  updateInkShapeNormalOutset(root, normalOutset, source, options);
}

/** Replaces only one Shape's compiled Ribbon while preserving its Fill resources. */
export function updateInkShapeRibbon(root: Group, ribbon: CompiledInkRibbon): void {
  const content = getInkShapeContentRoot(root);
  const existing = content.children.find((child) => child instanceof Mesh && child.name === 'InkShapeRibbon') as Mesh | undefined;
  if (existing) {
    existing.removeFromParent();
    existing.geometry.dispose();
    const materials = Array.isArray(existing.material) ? existing.material : [existing.material];
    materials.forEach((material) => material.dispose());
  }
  if (ribbon.indices.length === 0) return;
  const replacement = createInkRibbonMesh(ribbon);
  replacement.name = 'InkShapeRibbon';
  content.add(replacement);
}

/** Creates, updates, or removes alpha-clipped outset surfaces from live source settings. */
export function updateInkShapeNormalOutset(
  root: Group,
  normalOutset: CompiledInkNormalOutset | null,
  source: InkShape,
  options: InkShapeRenderOptions = {},
): void {
  const next = resolveInkNormalOutsetRenderSettings(normalOutset, source, options);
  const fills = getInkFillSurfaceMeshes(root);
  const existing = root.children.find((child) => child.name === 'InkNormalOutsetShell');
  if (!next || fills.size === 0) {
    if (existing) {
      disposeInkNormalOutsetObject(existing);
      existing.removeFromParent();
    }
    return;
  }
  const geometryKey = getInkNormalOutsetGeometryKey(source, next.distance);
  if (!(existing instanceof Group) || existing.userData.inkNormalOutsetGeometryKey !== geometryKey) {
    if (existing) {
      disposeInkNormalOutsetObject(existing);
      existing.removeFromParent();
    }
    root.add(createInkNormalOutsetShell(next, source, fills));
    return;
  }
  updateInkNormalOutsetShell(existing, next, source, fills);
}

/**
 * Editor-only preview that retains one Geometry and Material for the entire
 * pointer gesture. Its buffers grow geometrically but are never recreated for
 * ordinary pointer movement.
 */
export class InkRibbonPreview {
  readonly mesh: Mesh;
  private readonly geometry = new BufferGeometry();
  private readonly material = createInkRibbonMaterial();
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

  constructor() {
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
 * content-coordinate child rather than the Shape transform itself, leaving
 * Normal Outset geometry in true world units.
 */
export function applyInkShapeRenderTransform(target: Object3D, shape: InkShape): void {
  target.position.set(shape.position.x, shape.position.y, shape.position.z);
  target.rotation.set(shape.rotation.x, shape.rotation.y, shape.rotation.z, 'YXZ');
  const content = target instanceof Group ? findInkShapeContentRoot(target) : null;
  if (content) {
    target.scale.set(1, 1, 1);
    applyInkShapeContentDimensions(content, shape);
    return;
  }
  applyInkShapeContentDimensions(target, shape);
}

/** Creates one independently replaceable Ink Shape render mesh. */
export function createInkShapeRenderMesh(shape: CompiledInkShape, source: InkShape, applyTransform = true): Mesh | null {
  if (shape.ribbon.indices.length === 0) return null;
  const mesh = createInkRibbonMesh(shape.ribbon);
  mesh.name = 'InkShapeRibbon';
  mesh.userData.inkShapeId = shape.shapeId;
  if (applyTransform) applyInkShapeRenderTransform(mesh, source);
  return mesh;
}

type InkNormalOutsetRenderSettings = CompiledInkNormalOutset & { enabled: boolean };

function resolveInkNormalOutsetRenderSettings(
  normalOutset: CompiledInkNormalOutset | null,
  shape: InkShape,
  options: InkShapeRenderOptions,
): InkNormalOutsetRenderSettings | null {
  if (!options.useSourceNormalOutset) return normalOutset ? { ...normalOutset, enabled: true } : null;
  if (shape.kind === 'plane' || !shape.normalOutset?.enabled) return null;
  return {
    enabled: true,
    color: shape.normalOutset.color ?? DEFAULT_INK_NORMAL_OUTSET_COLOR,
    distance: shape.normalOutset.distance ?? DEFAULT_INK_NORMAL_OUTSET_DISTANCE,
  };
}

function getInkFillSurfaceMeshes(root: Group): Map<InkFillSurfaceId, Mesh> {
  const fills = new Map<InkFillSurfaceId, Mesh>();
  const content = getInkShapeContentRoot(root);
  for (const child of content.children) {
    if (!(child instanceof Mesh) || child.name !== 'InkFillSurface' || typeof child.userData.inkFillSurfaceId !== 'string') continue;
    fills.set(child.userData.inkFillSurfaceId as InkFillSurfaceId, child);
  }
  return fills;
}

function createInkNormalOutsetShell(
  outset: InkNormalOutsetRenderSettings,
  shape: InkShape,
  fills: ReadonlyMap<InkFillSurfaceId, Mesh>,
): Group {
  const shell = new Group();
  shell.name = 'InkNormalOutsetShell';
  shell.userData.inkNormalOutsetGeometryKey = getInkNormalOutsetGeometryKey(shape, outset.distance);
  shell.visible = outset.enabled;
  for (const [id, fill] of fills) shell.add(createInkNormalOutsetSurfaceMesh(id, outset, shape, fill));
  return shell;
}

function updateInkNormalOutsetShell(
  shell: Group,
  outset: InkNormalOutsetRenderSettings,
  shape: InkShape,
  fills: ReadonlyMap<InkFillSurfaceId, Mesh>,
): void {
  shell.visible = outset.enabled;
  const existing = new Map<InkFillSurfaceId, Mesh>();
  for (const child of shell.children) {
    if (!(child instanceof Mesh) || child.name !== 'InkNormalOutsetSurface' || typeof child.userData.inkFillSurfaceId !== 'string') continue;
    existing.set(child.userData.inkFillSurfaceId as InkFillSurfaceId, child);
  }
  for (const [id, mesh] of existing) {
    if (fills.has(id)) continue;
    disposeInkNormalOutsetMesh(mesh);
    mesh.removeFromParent();
    existing.delete(id);
  }
  for (const [id, fill] of fills) {
    const mesh = existing.get(id);
    if (mesh) updateInkNormalOutsetSurfaceMesh(mesh, outset, fill);
    else shell.add(createInkNormalOutsetSurfaceMesh(id, outset, shape, fill));
  }
}

function createInkNormalOutsetSurfaceMesh(
  id: InkFillSurfaceId,
  outset: InkNormalOutsetRenderSettings,
  shape: InkShape,
  fill: Mesh,
): Mesh {
  const mesh = new Mesh(
    createInkNormalOutsetSurfaceGeometry(id, shape, outset.distance),
    createInkNormalOutsetMaterial(outset, fill.material as ShaderMaterial),
  );
  mesh.name = 'InkNormalOutsetSurface';
  mesh.userData.inkFillSurfaceId = id;
  mesh.castShadow = false;
  return mesh;
}

function updateInkNormalOutsetSurfaceMesh(mesh: Mesh, outset: InkNormalOutsetRenderSettings, fill: Mesh): void {
  const material = mesh.material as ShaderMaterial;
  setRawSrgbColor(material.uniforms.inkNormalOutsetColor!.value as Color, outset.color);
  copyInkFillAlphaClipUniforms(material, fill.material as ShaderMaterial);
}

function disposeInkNormalOutsetObject(object: Object3D): void {
  if (object instanceof Mesh) {
    disposeInkNormalOutsetMesh(object);
    return;
  }
  for (const child of [...object.children]) {
    if (child instanceof Mesh) disposeInkNormalOutsetMesh(child);
    child.removeFromParent();
  }
}

function disposeInkNormalOutsetMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
  (mesh.material as ShaderMaterial).dispose();
}

function createInkNormalOutsetSurfaceGeometry(id: InkFillSurfaceId, shape: InkShape, distance: number): BufferGeometry {
  if (shape.kind === 'cuboid' && isInkCuboidFace(id)) return createCuboidNormalOutsetSurfaceGeometry(id, shape, distance);
  if (shape.kind === 'sphere' && isInkCuboidFace(id)) {
    const geometry = createSphereFillSurfaceGeometry(id);
    geometry.scale(shape.radius + distance, shape.radius + distance, shape.radius + distance);
    return geometry;
  }
  if (shape.kind === 'cylinder') return createCylinderFillSurfaceGeometry({
    ...shape,
    radius: shape.radius + distance,
    height: shape.height + distance * 2,
  }, id);
  if (shape.kind === 'frustum') {
    const dimensions = getMiteredFrustumOutsetDimensions(shape, distance);
    return createFrustumFillSurfaceGeometry({ ...shape, ...dimensions }, id);
  }
  return new BufferGeometry();
}

function createCuboidNormalOutsetSurfaceGeometry(
  face: InkCuboidFace,
  shape: Extract<InkShape, { kind: 'cuboid' }>,
  distance: number,
): BufferGeometry {
  const dimensions = {
    x: shape.size.x + distance * 2,
    y: shape.size.y + distance * 2,
    z: shape.size.z + distance * 2,
  };
  return createSurfaceQuad(
    getCuboidOutsetFacePosition(face, -0.5, -0.5, dimensions),
    getCuboidOutsetFacePosition(face, 0.5, -0.5, dimensions),
    getCuboidOutsetFacePosition(face, -0.5, 0.5, dimensions),
    getCuboidOutsetFacePosition(face, 0.5, 0.5, dimensions),
    face === 'positive-z' || face === 'negative-z',
  );
}

function getCuboidOutsetFacePosition(
  face: InkCuboidFace,
  u: number,
  v: number,
  dimensions: { x: number; y: number; z: number },
): Vector3 {
  const unitPosition = getCuboidFacePosition(face, u, v);
  return new Vector3(
    unitPosition.x * dimensions.x,
    unitPosition.y * dimensions.y,
    unitPosition.z * dimensions.z,
  );
}

function getInkNormalOutsetGeometryKey(shape: InkShape, distance: number): string {
  if (shape.kind === 'cuboid') return `cuboid:${shape.size.x}:${shape.size.y}:${shape.size.z}:${distance}`;
  if (shape.kind === 'sphere') return `sphere:${shape.radius}:${distance}`;
  if (shape.kind === 'cylinder') return `cylinder:${shape.radius}:${shape.height}:${distance}`;
  if (shape.kind === 'frustum') return `frustum:${shape.topSize}:${shape.bottomSize}:${shape.height}:${distance}`;
  return 'plane';
}

/** Offsets each Frustum face plane by distance and intersects the moved planes at its corners. */
function getMiteredFrustumOutsetDimensions(
  shape: Extract<InkShape, { kind: 'frustum' }>,
  distance: number,
): { topSize: number; bottomSize: number; height: number } {
  const sideSlope = (shape.topSize - shape.bottomSize) / (shape.height * 2);
  const sideNormalLength = Math.hypot(1, sideSlope);
  const outerHalfHeight = shape.height * 0.5 + distance;
  const sidePlaneOffset = (shape.topSize + shape.bottomSize) * 0.25 + distance * sideNormalLength;
  return {
    topSize: (sidePlaneOffset + sideSlope * outerHalfHeight) * 2,
    bottomSize: (sidePlaneOffset - sideSlope * outerHalfHeight) * 2,
    height: outerHalfHeight * 2,
  };
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

function createInkFillSurfaceMesh(fill: CompiledInkFillSurface, shape: InkShape, lighting: InkFillLightingState): Mesh {
  const texture = new DataTexture(new Uint8Array(fill.rgba), fill.width, fill.height, RGBAFormat, UnsignedByteType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const material = createInkFillSurfaceMaterial(texture, fill, shape, lighting);
  const mesh = new Mesh(createInkFillSurfaceGeometry(fill, shape), material);
  mesh.name = 'InkFillSurface';
  mesh.userData.inkFillSurfaceId = fill.id;
  mesh.userData.inkFillTexture = texture;
  mesh.userData.inkFillGeometryKey = getInkFillGeometryKey(fill, shape);
  // This material is used only by InkHardShadowMap. Keeping it separate from
  // castShadow prevents Ink from entering the shared PBR/Reference shadow map.
  mesh.userData.inkHardShadowDepthMaterial = createInkFillHardShadowDepthMaterial(material);
  return mesh;
}

function updateInkFillSurfaceMesh(mesh: Mesh, fill: CompiledInkFillSurface, shape: InkShape): void {
  const texture = mesh.userData.inkFillTexture as DataTexture;
  const image = texture.image as { data: Uint8Array; width: number; height: number };
  if (image.width !== fill.width || image.height !== fill.height) {
    const replacement = new DataTexture(new Uint8Array(fill.rgba), fill.width, fill.height, RGBAFormat, UnsignedByteType);
    replacement.magFilter = NearestFilter;
    replacement.minFilter = NearestFilter;
    replacement.generateMipmaps = false;
    replacement.needsUpdate = true;
    (mesh.material as ShaderMaterial).uniforms.inkFillMap!.value = replacement;
    mesh.userData.inkFillTexture = replacement;
    texture.dispose();
  } else {
    let firstChanged = -1;
    let lastChanged = -1;
    for (let index = 0; index < fill.rgba.length; index += 1) {
      const next = fill.rgba[index] ?? 0;
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
  const crop = getInkFillCrop(fill, shape);
  const material = mesh.material as ShaderMaterial;
  (material.uniforms.inkFillUvMin!.value as Vector2).set(crop.minX, crop.minY);
  (material.uniforms.inkFillUvSize!.value as Vector2).set(crop.width, crop.height);
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
  mesh.geometry.dispose();
  (mesh.material as ShaderMaterial).dispose();
}

function createInkFillSurfaceMaterial(
  texture: DataTexture,
  fill: CompiledInkFillSurface,
  shape: InkShape,
  lighting: InkFillLightingState,
): ShaderMaterial {
  const crop = getInkFillCrop(fill, shape);
  return new ShaderMaterial({
    uniforms: {
      inkFillMap: { value: texture },
      inkFillUvMin: { value: new Vector2(crop.minX, crop.minY) },
      inkFillUvSize: { value: new Vector2(crop.width, crop.height) },
      inkLightDirection: { value: lighting.lightDirection },
      inkAmbientIrradiance: { value: lighting.ambientIrradiance },
      inkHardShadowMap: lighting.hardShadowMap,
      inkHardShadowMatrix: { value: lighting.hardShadowMatrix },
      inkHardShadowBias: lighting.hardShadowBias,
      inkHardShadowNormalBias: lighting.hardShadowNormalBias,
      inkHardShadowEnabled: lighting.hardShadowEnabled,
    },
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -0.5,
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
uniform vec3 inkLightDirection;
uniform vec3 inkAmbientIrradiance;
uniform sampler2D inkHardShadowMap;
uniform mat4 inkHardShadowMatrix;
uniform float inkHardShadowBias;
uniform float inkHardShadowNormalBias;
uniform float inkHardShadowEnabled;
varying vec2 vInkFillUv;
varying vec3 vInkWorldPosition;
varying vec3 vInkWorldNormal;

float unpackInkDepth(vec4 packedDepth) {
  return dot(packedDepth, vec4(255.0 / 256.0, 255.0 / 65536.0, 255.0 / 16777216.0, 255.0 / 4294967296.0));
}

void main() {
  vec2 fillUv = (vInkFillUv - inkFillUvMin) / inkFillUvSize;
  if (fillUv.x < 0.0 || fillUv.x > 1.0 || fillUv.y < 0.0 || fillUv.y > 1.0) discard;
  vec4 colour = texture2D(inkFillMap, fillUv);
  if (colour.a < 0.5) discard;
  vec3 normal = normalize(vInkWorldNormal);
  if (!gl_FrontFacing) normal = -normal;
  vec3 lightDirection = normalize(inkLightDirection);
  float normalLight = dot(normal, lightDirection);
  float halfLambert = clamp(normalLight * 0.5 + 0.5, 0.0, 1.0);
  float directBand = halfLambert >= 0.5 ? 1.0 : 0.5;
  if (directBand > 0.5 && inkHardShadowEnabled > 0.5) {
    // A nearest 64 px/world-unit map can otherwise sample a closer point on
    // a curved Fill surface itself. Offset the receiver by one shadow texel;
    // at grazing angles scale the normal distance to preserve depth clearance.
    float normalBiasScale = 1.0 / max(0.25, normalLight);
    vec3 shadowReceiverPosition = vInkWorldPosition + normal * inkHardShadowNormalBias * normalBiasScale;
    vec4 shadowPosition = inkHardShadowMatrix * vec4(shadowReceiverPosition, 1.0);
    vec3 shadowUvDepth = shadowPosition.xyz / shadowPosition.w;
    bool inside = shadowUvDepth.x >= 0.0 && shadowUvDepth.x <= 1.0
      && shadowUvDepth.y >= 0.0 && shadowUvDepth.y <= 1.0
      && shadowUvDepth.z >= 0.0 && shadowUvDepth.z <= 1.0;
    if (inside && shadowUvDepth.z > unpackInkDepth(texture2D(inkHardShadowMap, shadowUvDepth.xy)) + inkHardShadowBias) directBand = 0.5;
  }
  gl_FragColor = vec4(colour.rgb * (vec3(directBand) + inkAmbientIrradiance), 1.0);
}`,
  });
}

/** The alpha-clipped shell renders only its inward-facing side. */
function createInkNormalOutsetMaterial(outset: CompiledInkNormalOutset, fillMaterial: ShaderMaterial): ShaderMaterial {
  const fillUniforms = fillMaterial.uniforms;
  return new ShaderMaterial({
    uniforms: {
      // Ink source colours are authored sRGB bytes. The display phase writes
      // them directly, so do not let Three convert this uniform to linear.
      inkNormalOutsetColor: { value: createRawSrgbColor(outset.color) },
      inkFillMap: { value: fillUniforms.inkFillMap!.value },
      inkFillUvMin: { value: fillUniforms.inkFillUvMin!.value },
      inkFillUvSize: { value: fillUniforms.inkFillUvSize!.value },
    },
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: BackSide,
    toneMapped: false,
    vertexShader: `
varying vec2 vInkFillUv;
void main() {
  // Geometry positions already represent the complete world-unit outset.
  vInkFillUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: `
uniform vec3 inkNormalOutsetColor;
uniform sampler2D inkFillMap;
uniform vec2 inkFillUvMin;
uniform vec2 inkFillUvSize;
varying vec2 vInkFillUv;
void main() {
  vec2 fillUv = (vInkFillUv - inkFillUvMin) / inkFillUvSize;
  if (fillUv.x < 0.0 || fillUv.x > 1.0 || fillUv.y < 0.0 || fillUv.y > 1.0) discard;
  if (texture2D(inkFillMap, fillUv).a < 0.5) discard;
  gl_FragColor = vec4(inkNormalOutsetColor, 1.0);
}`,
  });
}

function copyInkFillAlphaClipUniforms(outsetMaterial: ShaderMaterial, fillMaterial: ShaderMaterial): void {
  const outsetUniforms = outsetMaterial.uniforms;
  const fillUniforms = fillMaterial.uniforms;
  outsetUniforms.inkFillMap!.value = fillUniforms.inkFillMap!.value;
  outsetUniforms.inkFillUvMin!.value = fillUniforms.inkFillUvMin!.value;
  outsetUniforms.inkFillUvSize!.value = fillUniforms.inkFillUvSize!.value;
}

function createRawSrgbColor(value: string): Color {
  return setRawSrgbColor(new Color(), value);
}

function setRawSrgbColor(color: Color, value: string): Color {
  const parsed = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!parsed) return color.setRGB(0, 0, 0);
  color.r = Number.parseInt(parsed[1]!, 16) / 255;
  color.g = Number.parseInt(parsed[2]!, 16) / 255;
  color.b = Number.parseInt(parsed[3]!, 16) / 255;
  return color;
}

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
    },
    depthTest: true,
    depthWrite: true,
    side: BackSide,
    vertexShader: `
varying vec2 vInkFillUv;
void main() {
  vInkFillUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: `
#include <packing>
uniform sampler2D inkFillMap;
uniform vec2 inkFillUvMin;
uniform vec2 inkFillUvSize;
varying vec2 vInkFillUv;
void main() {
  vec2 fillUv = (vInkFillUv - inkFillUvMin) / inkFillUvSize;
  if (fillUv.x < 0.0 || fillUv.x > 1.0 || fillUv.y < 0.0 || fillUv.y > 1.0) discard;
  if (texture2D(inkFillMap, fillUv).a < 0.5) discard;
  gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
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
      const angle = fraction * Math.PI * 2;
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
  const dimensions = shape.kind === 'cuboid' && isInkCuboidFace(fill.id)
    ? getCuboidFaceFillDimensions(shape, fill.id)
    : shape.kind === 'sphere' && isInkCuboidFace(fill.id)
      ? { width: Math.max(1, Math.ceil(shape.radius * 2 * INK_FILL_PIXELS_PER_WORLD_UNIT)), height: Math.max(1, Math.ceil(shape.radius * 2 * INK_FILL_PIXELS_PER_WORLD_UNIT)) }
      : shape.kind === 'cylinder'
        ? getCylinderFillDimensions(shape, fill.id)
        : shape.kind === 'frustum' && isInkCuboidFace(fill.id)
          ? getFrustumFillDimensions(shape, fill.id)
      : { width: 1, height: 1 };
  return { minX: fill.minX / dimensions.width, minY: fill.minY / dimensions.height, width: fill.width / dimensions.width, height: fill.height / dimensions.height };
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

function createInkRibbonMesh(ribbon: CompiledInkRibbon): Mesh {
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

  const mesh = new Mesh(geometry, createInkRibbonMaterial());
  mesh.name = 'InkRibbon';
  return mesh;
}

function createInkRibbonMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexColors: true,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    // The ribbon's lateral direction is derived from the current camera, so a
    // visible stroke cannot rely on a fixed geometric front face.
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    toneMapped: false,
    vertexShader: `
attribute vec3 inkPrevious;
attribute vec3 inkNext;
attribute vec3 inkFallbackNormal;
attribute float inkSide;
attribute float inkTangentOffset;
attribute float inkWidth;
varying vec3 vInkColor;

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
  float halfWidth = inkWidth * 0.5;
  float surfaceDepthClearance = (
    abs(dot(sideways, normalWorld) * inkSide)
    + abs(dot(tangent, normalWorld) * inkTangentOffset)
  ) * halfWidth + max(0.0005, inkWidth * 0.01);
  float viewNormalAlignment = max(dot(viewDirection, normalWorld), 0.2);
  float viewDepthOffset = min(surfaceDepthClearance / viewNormalAlignment, inkWidth * 2.0);
  vec3 widenedWorld = currentWorld + (sideways * inkSide + tangent * inkTangentOffset) * halfWidth;
  vec4 viewPosition = viewMatrix * vec4(widenedWorld, 1.0);
  vec4 clipPosition = projectionMatrix * viewPosition;
  vec4 depthOffsetClipPosition = projectionMatrix * vec4(viewPosition.xyz + vec3(0.0, 0.0, viewDepthOffset), 1.0);
  vInkColor = color;
  gl_Position = clipPosition;
  gl_Position.z = clipPosition.w * depthOffsetClipPosition.z / depthOffsetClipPosition.w;
}`,
    fragmentShader: `
varying vec3 vInkColor;
void main() {
  gl_FragColor = vec4(vInkColor, 1.0);
}`,
  });
}

function createDynamicAttribute(length: number, itemSize: number): BufferAttribute {
  return new BufferAttribute(new Float32Array(length), itemSize).setUsage(DynamicDrawUsage);
}

function markDynamicUpdate(attribute: BufferAttribute, count: number): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count);
  attribute.needsUpdate = true;
}
