import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Camera,
  DataTexture,
  DynamicDrawUsage,
  DoubleSide,
  FrontSide,
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
  Vector4,
  type Side,
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
  type InkFillSurfaceId,
  type InkGroupData,
  type InkShape,
} from '../domain/ink/ink';

/** Shared mutable uniforms for every Fill material mounted by one GridSceneView. */
export type InkFillLightingState = {
  lightDirection: Vector3;
  ambientIrradiance: Vector3;
  hardShadowFrontFaceMap: { value: Texture | null };
  hardShadowBackFaceMap: { value: Texture | null };
  hardShadowMatrix: Matrix4;
  hardShadowTexelSize: Vector2;
  hardShadowRadius: { value: number };
  hardShadowEnabled: { value: number };
};

export function createInkFillLightingState(): InkFillLightingState {
  return {
    lightDirection: new Vector3(-4.5, 7.5, 4.5).normalize(),
    ambientIrradiance: new Vector3(0.22, 0.22, 0.22),
    hardShadowFrontFaceMap: { value: null },
    hardShadowBackFaceMap: { value: null },
    hardShadowMatrix: new Matrix4(),
    hardShadowTexelSize: new Vector2(1, 1),
    hardShadowRadius: { value: 1 },
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
): Group {
  const root = new Group();
  root.name = 'InkGroup';
  root.position.set(data.anchorPosition.x, data.anchorPosition.y, data.anchorPosition.z);
  root.rotation.y = ((data.placementRotation ?? 0) * Math.PI) / 180;
  for (const shape of data.compiled.shapes) {
    const source = data.shapes.find((candidate) => candidate.id === shape.shapeId);
    const shapeRoot = source ? createInkShapeRenderRoot(shape, source, lighting) : null;
    if (shapeRoot) root.add(shapeRoot);
  }
  return root;
}

/** Creates one independently replaceable Shape root: Fill, authored Outline, then optional surface Ribbon. */
export function createInkShapeRenderRoot(
  shape: CompiledInkShape,
  source: InkShape,
  lighting = createInkFillLightingState(),
): Group {
  const root = new Group();
  root.name = 'InkShape';
  root.userData.inkShapeId = shape.shapeId;
  root.add(createInkShapeContentRoot());
  applyInkShapeRenderTransform(root, source);
  const content = getInkShapeContentRoot(root);
  for (const fill of shape.fill) content.add(createInkFillSurfaceMesh(fill, source, lighting));
  const outline = createInkShapeRenderMesh(shape, source, false);
  if (outline) content.add(outline);
  const surfaceOutline = createInkSurfaceOutlineRenderer(root, content, source);
  if (surfaceOutline) content.add(surfaceOutline.mesh);
  return root;
}

/** Reuses Fill Surface geometry/materials and changes only the affected texture payload. */
export function updateInkShapeFillSurfaces(
  root: Group,
  fills: readonly CompiledInkFillSurface[],
  source: InkShape,
  lighting = createInkFillLightingState(),
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

  updateInkShapeSurfaceOutline(root, source);
}

/** Updates the enabled analytic smooth-surface Ribbons for the active camera. */
export function updateInkSurfaceOutlines(root: Object3D, camera: Camera): void {
  root.traverse((object) => getInkSurfaceOutlineRenderer(object)?.update(camera));
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

  constructor(createMaterial: () => ShaderMaterial = createInkRibbonMaterial) {
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
  ) {
    this.preview = new InkRibbonPreview(() => createInkSurfaceOutlineMaterial(shape, this.emptyFillAlphaTexture));
    this.mesh = this.preview.mesh;
    this.mesh.name = 'InkSurfaceOutline';
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

type InkFillAlphaSource = Readonly<{ texture: Texture; crop: Vector4 }>;

function createInkSurfaceOutlineRenderer(root: Group, content: Group, shape: InkShape): InkSurfaceOutlineRenderer | null {
  if ((shape.kind !== 'sphere' && shape.kind !== 'cylinder') || !shape.surfaceOutline.enabled) return null;
  const renderer = new InkSurfaceOutlineRenderer(content, shape);
  root.userData[INK_SURFACE_OUTLINE_RENDERER_KEY] = renderer;
  renderer.syncFillAlpha();
  return renderer;
}

function updateInkShapeSurfaceOutline(root: Group, shape: InkShape): void {
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
  const next = createInkSurfaceOutlineRenderer(root, getInkShapeContentRoot(root), shape);
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
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function getInkFillAlphaSource(mesh: Mesh): InkFillAlphaSource | null {
  const texture = mesh.userData.inkFillTexture;
  const material = mesh.material;
  if (!(texture instanceof Texture) || !(material instanceof ShaderMaterial)) return null;
  const min = material.uniforms.inkFillUvMin?.value;
  const size = material.uniforms.inkFillUvSize?.value;
  if (!(min instanceof Vector2) || !(size instanceof Vector2)) return null;
  return { texture, crop: new Vector4(min.x, min.y, size.x, size.y) };
}

function setInkFillAlphaUniform(material: ShaderMaterial, name: string, source: InkFillAlphaSource | undefined, fallback: Texture): void {
  material.uniforms[name]!.value = source?.texture ?? fallback;
  (material.uniforms[`${name}Crop`]!.value as Vector4).copy(source?.crop ?? EMPTY_INK_FILL_ALPHA_CROP);
}

const EMPTY_INK_FILL_ALPHA_CROP = new Vector4(0, 0, 1, 1);
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
  // These two alpha-clipped materials are used only by InkHardShadowMap.
  // Front-facing visible fragments sample the BackSide capture; back-facing
  // visible fragments sample the FrontSide capture.
  mesh.userData.inkHardShadowBackFaceDepthMaterial = createInkFillHardShadowDepthMaterial(material, BackSide);
  mesh.userData.inkHardShadowFrontFaceDepthMaterial = createInkFillHardShadowDepthMaterial(material, FrontSide);
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
  (mesh.userData.inkHardShadowBackFaceDepthMaterial as ShaderMaterial | undefined)?.dispose();
  (mesh.userData.inkHardShadowFrontFaceDepthMaterial as ShaderMaterial | undefined)?.dispose();
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
      inkHardShadowFrontFaceMap: lighting.hardShadowFrontFaceMap,
      inkHardShadowBackFaceMap: lighting.hardShadowBackFaceMap,
      inkHardShadowMatrix: { value: lighting.hardShadowMatrix },
      inkHardShadowTexelSize: { value: lighting.hardShadowTexelSize },
      inkHardShadowRadius: lighting.hardShadowRadius,
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
uniform sampler2DShadow inkHardShadowFrontFaceMap;
uniform sampler2DShadow inkHardShadowBackFaceMap;
uniform mat4 inkHardShadowMatrix;
uniform vec2 inkHardShadowTexelSize;
uniform float inkHardShadowRadius;
uniform float inkHardShadowEnabled;
varying vec2 vInkFillUv;
varying vec3 vInkWorldPosition;
varying vec3 vInkWorldNormal;

// Each sampler2DShadow lookup performs a linearly filtered hardware depth
// comparison. Keep the five Vogel-disk offsets fixed: PBR's per-pixel rotation
// is appropriate for continuous soft light, but becomes visible dither after
// Ink thresholds that light to a binary band.
vec2 inkVogelDiskSample(int sampleIndex, int sampleCount, float phi) {
  const float goldenAngle = 2.399963229728653;
  float radius = sqrt((float(sampleIndex) + 0.5) / float(sampleCount));
  float theta = float(sampleIndex) * goldenAngle + phi;
  return vec2(cos(theta), sin(theta)) * radius;
}

float sampleInkHardShadowFrontFacePcf(vec3 shadowUvDepth) {
  float radius = inkHardShadowRadius * inkHardShadowTexelSize.x;
  const float phi = 0.0;
  return (
    texture(inkHardShadowFrontFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(0, 5, phi) * radius, shadowUvDepth.z)) +
    texture(inkHardShadowFrontFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(1, 5, phi) * radius, shadowUvDepth.z)) +
    texture(inkHardShadowFrontFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(2, 5, phi) * radius, shadowUvDepth.z)) +
    texture(inkHardShadowFrontFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(3, 5, phi) * radius, shadowUvDepth.z)) +
    texture(inkHardShadowFrontFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(4, 5, phi) * radius, shadowUvDepth.z))
  ) * 0.2;
}

float sampleInkHardShadowBackFacePcf(vec3 shadowUvDepth) {
  float radius = inkHardShadowRadius * inkHardShadowTexelSize.x;
  const float phi = 0.0;
  return (
    texture(inkHardShadowBackFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(0, 5, phi) * radius, shadowUvDepth.z)) +
    texture(inkHardShadowBackFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(1, 5, phi) * radius, shadowUvDepth.z)) +
    texture(inkHardShadowBackFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(2, 5, phi) * radius, shadowUvDepth.z)) +
    texture(inkHardShadowBackFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(3, 5, phi) * radius, shadowUvDepth.z)) +
    texture(inkHardShadowBackFaceMap, vec3(shadowUvDepth.xy + inkVogelDiskSample(4, 5, phi) * radius, shadowUvDepth.z))
  ) * 0.2;
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
    vec4 shadowPosition = inkHardShadowMatrix * vec4(vInkWorldPosition, 1.0);
    vec3 shadowUvDepth = shadowPosition.xyz / shadowPosition.w;
    bool inside = shadowUvDepth.x >= 0.0 && shadowUvDepth.x <= 1.0
      && shadowUvDepth.y >= 0.0 && shadowUvDepth.y <= 1.0
      && shadowUvDepth.z >= 0.0 && shadowUvDepth.z <= 1.0;
    if (inside) {
      // Pair each visible side with the opposite capture side so a DoubleSide
      // Fill does not compare its inner surface against its own depth.
      float shadowVisibility = gl_FrontFacing
        ? sampleInkHardShadowBackFacePcf(shadowUvDepth)
        : sampleInkHardShadowFrontFacePcf(shadowUvDepth);
      if (shadowVisibility <= 0.5) directBand = 0.5;
    }
  }
  gl_FragColor = vec4(colour.rgb * (vec3(directBand) + inkAmbientIrradiance), 1.0);
}`,
  });
}

/** The dynamic Ribbon samples Fill alpha in the Shape's source chart space. */
function createInkSurfaceOutlineMaterial(shape: InkSurfaceOutlineShape, emptyFillAlphaTexture: Texture): ShaderMaterial {
  const isSphere = shape.kind === 'sphere';
  return new ShaderMaterial({
    vertexColors: true,
    uniforms: {
      ...(shape.kind === 'sphere'
        ? createInkSphereFillAlphaUniforms(emptyFillAlphaTexture)
        : createInkCylinderFillAlphaUniforms(shape.height, emptyFillAlphaTexture)),
    },
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    toneMapped: false,
    vertexShader: createInkRibbonVertexShader(
      'varying vec3 vInkSurfacePosition;',
      'vInkSurfacePosition = position;',
    ),
    fragmentShader: `
varying vec3 vInkColor;
varying vec3 vInkSurfacePosition;
${isSphere ? INK_SPHERE_FILL_ALPHA_FRAGMENT : INK_CYLINDER_FILL_ALPHA_FRAGMENT}
void main() {
  if (getInkSurfaceFillAlpha() < 0.5) discard;
  gl_FragColor = vec4(vInkColor, 1.0);
}`,
  });
}

function createInkSphereFillAlphaUniforms(emptyFillAlphaTexture: Texture): Record<string, { value: Texture | Vector4 }> {
  const uniforms: Record<string, { value: Texture | Vector4 }> = {};
  for (const face of INK_SPHERE_FILL_UNIFORMS) {
    uniforms[face.name] = { value: emptyFillAlphaTexture };
    uniforms[`${face.name}Crop`] = { value: EMPTY_INK_FILL_ALPHA_CROP.clone() };
  }
  return uniforms;
}

function createInkCylinderFillAlphaUniforms(height: number, emptyFillAlphaTexture: Texture): Record<string, { value: Texture | Vector4 | number }> {
  return {
    inkFillSide: { value: emptyFillAlphaTexture },
    inkFillSideCrop: { value: EMPTY_INK_FILL_ALPHA_CROP.clone() },
    inkCylinderHeight: { value: height },
  };
}

const INK_SURFACE_FILL_ALPHA_HELPER = `
float sampleInkFillAlpha(sampler2D map, vec4 crop, vec2 chartUv) {
  vec2 textureUv = (chartUv - crop.xy) / crop.zw;
  if (textureUv.x < 0.0 || textureUv.x > 1.0 || textureUv.y < 0.0 || textureUv.y > 1.0) return 0.0;
  return texture2D(map, textureUv).a;
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
      ? sampleInkFillAlpha(inkFillPositiveX, inkFillPositiveXCrop, chartUv)
      : sampleInkFillAlpha(inkFillNegativeX, inkFillNegativeXCrop, chartUv);
  }
  if (magnitude.y >= magnitude.z) {
    float divisor = max(0.00000001, magnitude.y);
    vec2 chartUv = direction.y >= 0.0
      ? vec2(direction.x / divisor, direction.z / divisor) * 0.5 + 0.5
      : vec2(direction.x / divisor, -direction.z / divisor) * 0.5 + 0.5;
    return direction.y >= 0.0
      ? sampleInkFillAlpha(inkFillPositiveY, inkFillPositiveYCrop, chartUv)
      : sampleInkFillAlpha(inkFillNegativeY, inkFillNegativeYCrop, chartUv);
  }
  float divisor = max(0.00000001, magnitude.z);
  vec2 chartUv = direction.z >= 0.0
    ? vec2(direction.x / divisor, direction.y / divisor) * 0.5 + 0.5
    : vec2(-direction.x / divisor, direction.y / divisor) * 0.5 + 0.5;
  return direction.z >= 0.0
    ? sampleInkFillAlpha(inkFillPositiveZ, inkFillPositiveZCrop, chartUv)
    : sampleInkFillAlpha(inkFillNegativeZ, inkFillNegativeZCrop, chartUv);
}`;

const INK_CYLINDER_FILL_ALPHA_FRAGMENT = `
uniform sampler2D inkFillSide;
uniform vec4 inkFillSideCrop;
uniform float inkCylinderHeight;
${INK_SURFACE_FILL_ALPHA_HELPER}

float getInkSurfaceFillAlpha() {
  float angle = atan(vInkSurfacePosition.z, vInkSurfacePosition.x);
  vec2 chartUv = vec2(angle / (3.141592653589793 * 2.0) + 0.5, vInkSurfacePosition.y / inkCylinderHeight + 0.5);
  return sampleInkFillAlpha(inkFillSide, inkFillSideCrop, chartUv);
}`;

/**
 * The dedicated Ink shadow pass must discard the same transparent pixels as
 * the visible Fill shader. Otherwise each sparse Fill atlas would cast its
 * whole rectangular chart into the scene.
 */
function createInkFillHardShadowDepthMaterial(fillMaterial: ShaderMaterial, side: Side): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      inkFillMap: fillMaterial.uniforms.inkFillMap!,
      inkFillUvMin: fillMaterial.uniforms.inkFillUvMin!,
      inkFillUvSize: fillMaterial.uniforms.inkFillUvSize!,
    },
    depthTest: true,
    depthWrite: true,
    colorWrite: false,
    side,
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
varying vec2 vInkFillUv;
void main() {
  vec2 fillUv = (vInkFillUv - inkFillUvMin) / inkFillUvSize;
  if (fillUv.x < 0.0 || fillUv.x > 1.0 || fillUv.y < 0.0 || fillUv.y > 1.0) discard;
  if (texture2D(inkFillMap, fillUv).a < 0.5) discard;
  gl_FragColor = vec4(1.0);
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
  // Sphere Fill keeps six independent UV charts, so chart-edge vertices must
  // remain duplicated. Their positions already lie on the unit sphere: reuse
  // that radial direction as the normal so matching seam positions shade
  // identically instead of receiving each chart's one-sided face normal.
  geometry.setAttribute('normal', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
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
    vertexShader: createInkRibbonVertexShader(),
    fragmentShader: `
varying vec3 vInkColor;
void main() {
  gl_FragColor = vec4(vInkColor, 1.0);
}`,
  });
}

function createInkRibbonVertexShader(varyings = '', mainExtension = ''): string {
  return `
attribute vec3 inkPrevious;
attribute vec3 inkNext;
attribute vec3 inkFallbackNormal;
attribute float inkSide;
attribute float inkTangentOffset;
attribute float inkWidth;
varying vec3 vInkColor;
${varyings}

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
  ${mainExtension}
  gl_Position = clipPosition;
  gl_Position.z = clipPosition.w * depthOffsetClipPosition.z / depthOffsetClipPosition.w;
}`;
}

function createDynamicAttribute(length: number, itemSize: number): BufferAttribute {
  return new BufferAttribute(new Float32Array(length), itemSize).setUsage(DynamicDrawUsage);
}

function markDynamicUpdate(attribute: BufferAttribute, count: number): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count);
  attribute.needsUpdate = true;
}
