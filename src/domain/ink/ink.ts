import { BufferGeometry, Euler, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three';
import { hashDerivedAssetSource } from './derivedAssets';

export const INK_MANAGER_OBJECT_TYPE = 'painting.ink-manager';
/** v15 retires Normal Outset shells in favour of analytic smooth-surface Ribbons. */
export const INK_COMPILED_FORMAT_VERSION = 15;
export const INK_SPHERE_FACE_SEGMENTS = 4;
export const INK_CYLINDER_SEGMENTS = 16;
export const INK_FILL_PIXELS_PER_WORLD_UNIT = 64;
export const INK_FILL_BLOCK_SIZE = 16;

export type InkGridCell = { x: number; y: number; z: number };
/** Inclusive local grid-cell range occupied visually by an Ink source. */
export type InkVisualFootprint = { min: InkGridCell; max: InkGridCell };
export type InkVector2 = { x: number; y: number };
export type InkVector3 = { x: number; y: number; z: number };
export type InkPlaneOrientation = 'x' | 'y' | 'z' | 'camera';
export type InkCuboidFace = 'positive-x' | 'negative-x' | 'positive-y' | 'negative-y' | 'positive-z' | 'negative-z';
export type InkCylinderSurface = 'side' | 'top' | 'bottom';
export type InkFillSurfaceId = 'plane' | InkCuboidFace | InkCylinderSurface;
export type InkFillBrushShape = 'square' | 'circle';
/** Grid-aligned Group placement rotation, expressed in quarter turns around Y. */
export type InkGroupRotation = 0 | 90 | 180 | 270;

/** Plane points stay in the Plane's local two-dimensional authoring coordinates. */
export type InkPlaneStrokePoint = InkVector2 & { pressure: number };
/** Cuboid points are normalized to the selected face, so they follow size changes. */
export type InkCuboidStrokePoint = { face: InkCuboidFace; u: number; v: number; pressure: number };
/** Sphere points are local unit directions, independent of radius and UV seams. */
export type InkSphereStrokePoint = InkVector3 & { pressure: number };
/** Cylinder points use one side chart or one of its two circular cap charts. */
export type InkCylinderStrokePoint = { surface: InkCylinderSurface; u: number; v: number; pressure: number };
export type InkSurfacePoint = InkPlaneStrokePoint | InkCuboidStrokePoint | InkSphereStrokePoint | InkCylinderStrokePoint;

export type InkOutlineStroke = {
  id: string;
  color: string;
  width: number;
  points: InkSurfacePoint[];
};

/** A sparse, serialized 16 × 16 RGBA texture tile. Values are 0–255 bytes. */
export type InkFillBlock = { x: number; y: number; rgba: number[] };

/** One 2D chart of a Shape's editable Fill Layer. */
export type InkFillSurface = {
  id: InkFillSurfaceId;
  /** Finite Cuboid/Sphere chart resolution. Plane charts are unbounded. */
  width?: number;
  height?: number;
  blocks: InkFillBlock[];
};

/** Editable source pixels, not replayable brush samples. */
export type InkFillLayer = { surfaces: InkFillSurface[] };

/** View-dependent Ribbon settings for a supported smooth finite surface. */
export type InkSurfaceOutlineSettings = {
  enabled: boolean;
  width: number;
};

type InkShapeBase = {
  id: string;
  position: InkVector3;
  rotation: InkVector3;
  strokes: InkOutlineStroke[];
  fill: InkFillLayer;
};

export type InkPlaneShape = InkShapeBase & {
  kind: 'plane';
  /** The creation affordance; the saved rotation is authoritative afterwards. */
  orientation: InkPlaneOrientation;
  /**
   * The latest outline endpoint on this Plane. It is authoring state for the
   * Shift straight-line assist, not compiled render geometry.
   */
  lastOutlineEnd?: InkVector2 | null;
};

export type InkCuboidShape = InkShapeBase & {
  kind: 'cuboid';
  /** Intrinsic dimensions, not a Transform scale. */
  size: InkVector3;
  /**
   * The latest outline endpoint on this Cuboid. It retains its surface face
   * for the Shift straight-line assist, but never affects compiled geometry.
   */
  lastOutlineEnd?: InkCuboidStrokePoint | null;
};

export type InkSphereShape = InkShapeBase & {
  kind: 'sphere';
  /** Intrinsic radius, not a Transform scale. */
  radius: number;
  /** View-dependent sphere silhouette Ribbon settings. */
  surfaceOutline: InkSurfaceOutlineSettings;
};

export type InkCylinderShape = InkShapeBase & {
  kind: 'cylinder';
  /** Intrinsic dimensions, not a Transform scale. */
  radius: number;
  height: number;
  /** View-dependent side-silhouette Ribbon settings; cap faces stay unoutlined. */
  surfaceOutline: InkSurfaceOutlineSettings;
};

export type InkFrustumShape = InkShapeBase & {
  kind: 'frustum';
  /** Side lengths of the Y-up square caps, not a Transform scale. */
  topSize: number;
  bottomSize: number;
  height: number;
  lastOutlineEnd?: InkCuboidStrokePoint | null;
};

export type InkShape = InkPlaneShape | InkCuboidShape | InkSphereShape | InkCylinderShape | InkFrustumShape;

/**
 * Pre-triangulated local-space ribbon attributes. The shader only expands the
 * already-built topology against the camera; it never re-samples source lines.
 */
export type CompiledInkRibbon = {
  positions: number[];
  previous: number[];
  next: number[];
  fallbackNormals: number[];
  sides: number[];
  tangentOffsets: number[];
  widths: number[];
  colors: number[];
  indices: number[];
};

/** One Ink Shape's reusable, precompiled Ribbon payload. */
export type CompiledInkShape = {
  shapeId: string;
  sourceHash: string;
  /** Hash of the Outline-only source used to reuse Ribbon buffers during Fill previews. */
  ribbonSourceHash: string;
  ribbon: CompiledInkRibbon;
  fill: CompiledInkFillSurface[];
};

/** A tightly packed, GPU-ready rectangular portion of one Fill chart. */
export type CompiledInkFillSurface = {
  id: InkFillSurfaceId;
  minX: number;
  minY: number;
  width: number;
  height: number;
  rgba: number[];
};

export type CompiledInkGroup = {
  formatVersion: number;
  sourceHash: string;
  shapes: CompiledInkShape[];
};

/** Complete Ink content used by both embedded and exported Ink asset sources. */
export type InkGroupData = {
  id: string;
  name: string;
  /** World-space placement pivot. Asset sources always keep it at the origin. */
  anchorPosition: InkVector3;
  /** Runtime/editor-only resolved placement rotation for an asset reference. */
  placementRotation?: InkGroupRotation;
  /** Worker-derived local visual bounds used by the asset browser and placement preview. */
  visualFootprint?: InkVisualFootprint;
  shapes: InkShape[];
  compiled: CompiledInkGroup;
};

/** A scene-owned source asset which is not exposed through the project asset browser. */
export type InkEmbeddedAsset = {
  assetId: string;
  group: InkGroupData;
};

/** A scene-owned placement that resolves its authored content from an Ink asset source. */
export type InkAssetReference = {
  id: string;
  assetId: string;
  anchorPosition: InkVector3;
  rotation: InkGroupRotation;
};

export type InkManagerData = {
  /** Resolved Editor/Game view payload. Persisted authoring data must keep this empty. */
  groups: InkGroupData[];
  /** Scene-private Ink sources. They may only be referenced by this Scene. */
  embeddedAssets: InkEmbeddedAsset[];
  /** All scene placements, resolving from either an embedded or an exported source. */
  assetReferences: InkAssetReference[];
};

export const DEFAULT_INK_STROKE_COLOR = '#000000';
export const DEFAULT_INK_STROKE_WIDTH = 0.035;
export const DEFAULT_INK_CUBOID_SIZE: InkVector3 = { x: 1, y: 1, z: 1 };
export const DEFAULT_INK_SPHERE_RADIUS = 0.5;
export const DEFAULT_INK_FILL_BRUSH_SIZE = 0.1;
const CUBOID_FACE_ORDER: readonly InkCuboidFace[] = [
  'positive-x', 'negative-x', 'positive-y', 'negative-y', 'positive-z', 'negative-z',
];
const INK_SPHERE_UNIT_VERTICES = createInkSphereUnitVertices();
const INK_SPHERE_TRIANGLE_INDICES = createInkSphereTriangleIndices();
const MAX_COMPILED_SPHERE_SEGMENT_ANGLE = Math.PI / 18;

export function createInkGroupData(name = 'Group 1', id = `ink-group-${crypto.randomUUID()}`): InkGroupData {
  const data: Omit<InkGroupData, 'compiled'> = {
    id,
    name,
    anchorPosition: { x: 0, y: 0, z: 0 },
    shapes: [createInkPlaneShape('camera', { x: 0, y: 0, z: 0 })],
  };
  return { ...data, visualFootprint: calculateInkVisualFootprint(data), compiled: compileInkGroup(data) };
}

export function createInkManagerData(): InkManagerData { return { groups: [], embeddedAssets: [], assetReferences: [] }; }

/** Creates one scene-private source with the same authored semantics as an exported asset. */
export function createInkEmbeddedAsset(
  groupSource: InkGroupData,
  assetId = `ink-embedded-${crypto.randomUUID()}`,
): InkEmbeddedAsset {
  const source = structuredClone(groupSource) as InkGroupData;
  source.id = assetId;
  source.anchorPosition = { x: 0, y: 0, z: 0 };
  delete source.placementRotation;
  return { assetId, group: withCompiledInkGroup(source) };
}

export function getInkEmbeddedAsset(data: InkManagerData, assetId: string): InkEmbeddedAsset | null {
  return data.embeddedAssets.find((asset) => asset.assetId === assetId) ?? null;
}

export function createInkAssetReference(
  assetId: string,
  anchorPosition: InkVector3 = { x: 0, y: 0, z: 0 },
  rotation: InkGroupRotation = 0,
  id = `ink-reference-${crypto.randomUUID()}`,
): InkAssetReference {
  return { id, assetId, anchorPosition: { ...anchorPosition }, rotation };
}

export function createInkPlaneShape(
  orientation: InkPlaneOrientation,
  cameraRotation: InkVector3,
): InkPlaneShape {
  return {
    id: `ink-shape-${crypto.randomUUID()}`,
    kind: 'plane',
    orientation,
    position: { x: 0, y: 0, z: 0 },
    rotation: getInitialPlaneRotation(orientation, cameraRotation),
    strokes: [],
    fill: createEmptyInkFillLayer(),
    lastOutlineEnd: null,
  };
}

/** Converts the editor camera's world orientation into an Ink Group's local YXZ rotation. */
export function getCameraFacingInkPlaneRotation(
  cameraQuaternion: Readonly<{ x: number; y: number; z: number; w: number }>,
  groupRotationDegrees: number,
): InkVector3 {
  const camera = new Quaternion(cameraQuaternion.x, cameraQuaternion.y, cameraQuaternion.z, cameraQuaternion.w).normalize();
  const inverseGroup = new Quaternion()
    .setFromEuler(new Euler(0, groupRotationDegrees * Math.PI / 180, 0, 'YXZ'))
    .invert();
  const local = new Euler().setFromQuaternion(inverseGroup.multiply(camera), 'YXZ');
  return { x: local.x, y: local.y, z: local.z };
}

export function createInkCuboidShape(): InkCuboidShape {
  return {
    id: `ink-shape-${crypto.randomUUID()}`,
    kind: 'cuboid',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { ...DEFAULT_INK_CUBOID_SIZE },
    strokes: [],
    fill: createEmptyInkFillLayer(),
    lastOutlineEnd: null,
  };
}

export function createInkSphereShape(): InkSphereShape {
  return {
    id: `ink-shape-${crypto.randomUUID()}`,
    kind: 'sphere',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    radius: DEFAULT_INK_SPHERE_RADIUS,
    strokes: [],
    fill: createEmptyInkFillLayer(),
    surfaceOutline: createDefaultInkSurfaceOutlineSettings(),
  };
}

export function createInkCylinderShape(): InkCylinderShape {
  return {
    id: `ink-shape-${crypto.randomUUID()}`,
    kind: 'cylinder',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    radius: DEFAULT_INK_SPHERE_RADIUS,
    height: 1,
    strokes: [],
    fill: createEmptyInkFillLayer(),
    surfaceOutline: createDefaultInkSurfaceOutlineSettings(),
  };
}

export function createInkFrustumShape(): InkFrustumShape {
  return {
    id: `ink-shape-${crypto.randomUUID()}`,
    kind: 'frustum',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    topSize: 0.5,
    bottomSize: 1,
    height: 1,
    strokes: [],
    fill: createEmptyInkFillLayer(),
    lastOutlineEnd: null,
  };
}

export function createEmptyInkFillLayer(): InkFillLayer { return { surfaces: [] }; }
export function createDefaultInkSurfaceOutlineSettings(): InkSurfaceOutlineSettings {
  return { enabled: false, width: DEFAULT_INK_STROKE_WIDTH };
}

/** Creates the sole 6-face × 4 × 4 cube Sphere surface used for picking and compilation. */
export function createInkSphereGeometry(radius: number): BufferGeometry {
  const geometry = new BufferGeometry();
  const positions: number[] = [];
  const normals: number[] = [];
  for (const vertex of INK_SPHERE_UNIT_VERTICES) {
    positions.push(vertex.x * radius, vertex.y * radius, vertex.z * radius);
    // The six cube-sphere charts duplicate boundary vertices. Supplying the
    // Radial normals keep the cube-sphere Fill surface lighting continuous.
    normals.push(vertex.x, vertex.y, vertex.z);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(INK_SPHERE_TRIANGLE_INDICES);
  return geometry;
}

/** Final-dimension shared-vertex geometry for a cylindrical Shape. */
export function createInkCylinderGeometry(radius: number, height: number): BufferGeometry {
  const geometry = new BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  const halfHeight = height * 0.5;
  for (let index = 0; index < INK_CYLINDER_SEGMENTS; index += 1) {
    const angle = index / INK_CYLINDER_SEGMENTS * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    positions.push(x, halfHeight, z, x, -halfHeight, z);
  }
  const topCenter = positions.length / 3;
  positions.push(0, halfHeight, 0);
  const bottomCenter = positions.length / 3;
  positions.push(0, -halfHeight, 0);
  for (let index = 0; index < INK_CYLINDER_SEGMENTS; index += 1) {
    const next = (index + 1) % INK_CYLINDER_SEGMENTS;
    const top = index * 2;
    const bottom = top + 1;
    const nextTop = next * 2;
    const nextBottom = nextTop + 1;
    indices.push(top, nextBottom, bottom, top, nextTop, nextBottom);
    indices.push(topCenter, nextTop, top);
    indices.push(bottomCenter, bottom, nextBottom);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A final-dimension, shared-corner square frustum with continuous outset normals. */
export function createInkFrustumGeometry(topSize: number, bottomSize: number, height: number): BufferGeometry {
  const geometry = new BufferGeometry();
  const halfHeight = height * 0.5;
  const top = topSize * 0.5;
  const bottom = bottomSize * 0.5;
  geometry.setAttribute('position', new Float32BufferAttribute([
    -top, halfHeight, -top, top, halfHeight, -top, top, halfHeight, top, -top, halfHeight, top,
    -bottom, -halfHeight, -bottom, bottom, -halfHeight, -bottom, bottom, -halfHeight, bottom, -bottom, -halfHeight, bottom,
  ], 3));
  geometry.setIndex([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

export function createInkOutlineStroke(
  points: readonly InkSurfacePoint[],
  color = DEFAULT_INK_STROKE_COLOR,
  width = DEFAULT_INK_STROKE_WIDTH,
): InkOutlineStroke {
  return {
    id: `ink-stroke-${crypto.randomUUID()}`,
    color: normalizeInkStrokeColor(color),
    width: clampInkStrokeWidth(width),
    points: points.map((point) => ({ ...point, pressure: clampPressure(point.pressure) })),
  };
}

export function withCompiledInkGroup(
  data: InkGroupData,
  previous: InkGroupData | null = data,
): InkGroupData {
  const source = { anchorPosition: data.anchorPosition, shapes: data.shapes };
  return {
    ...data,
    visualFootprint: calculateInkVisualFootprint(source),
    compiled: compileInkGroup(source, previous?.compiled, previous?.shapes),
  };
}

/** Rebinds an existing compiled payload after a placement-only source change. */
export function withInkGroupCompiledSourceHash(data: InkGroupData): InkGroupData {
  return {
    ...data,
    compiled: {
      ...data.compiled,
      sourceHash: hashInkGroupSource({ anchorPosition: data.anchorPosition, shapes: data.shapes }, data.compiled.shapes),
    },
  };
}

/**
 * Calculates a conservative local footprint without touching compiled Ribbon
 * buffers. This function is invoked by the Ink Worker for authored edits;
 * synchronous callers only use it for a newly-created, tiny Group.
 */
export function calculateInkVisualFootprint(source: Pick<InkGroupData, 'shapes'>): InkVisualFootprint {
  const minimum = new Vector3(Infinity, Infinity, Infinity);
  const maximum = new Vector3(-Infinity, -Infinity, -Infinity);
  let hasVisualContent = false;
  for (const shape of source.shapes) {
    const bounds = getInkShapeVisualBounds(shape);
    if (!bounds) continue;
    hasVisualContent = true;
    forEachBoundsCorner(bounds.min, bounds.max, (corner) => {
      const world = transformInkShapePoint(shape, corner);
      minimum.min(world);
      maximum.max(world);
    });
  }
  if (!hasVisualContent) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return {
    min: { x: Math.floor(minimum.x + 0.5), y: Math.floor(minimum.y + 0.5), z: Math.floor(minimum.z + 0.5) },
    max: { x: Math.ceil(maximum.x - 0.5), y: Math.ceil(maximum.y - 0.5), z: Math.ceil(maximum.z - 0.5) },
  };
}

/** Returns a safe, persisted fallback for older sources until their next Worker compile. */
export function getInkVisualFootprint(group: Pick<InkGroupData, 'visualFootprint'>): InkVisualFootprint {
  return group.visualFootprint ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
}

function getInkShapeVisualBounds(shape: InkShape): { min: Vector3; max: Vector3 } | null {
  const points: Vector3[] = [];
  let outlineMargin = 0;
  for (const stroke of shape.strokes) {
    outlineMargin = Math.max(outlineMargin, stroke.width * 0.5);
    for (const point of stroke.points) points.push(getInkShapePoint(shape, point));
  }
  const hasFill = shape.fill.surfaces.some((surface) => surface.blocks.length > 0);
  const surfaceOutlineMargin = hasFill && (shape.kind === 'sphere' || shape.kind === 'cylinder') && shape.surfaceOutline.enabled
    ? clampInkStrokeWidth(shape.surfaceOutline.width) * 0.5
    : 0;
  if (shape.kind === 'plane') {
    for (const surface of shape.fill.surfaces) {
      if (surface.id !== 'plane' || surface.blocks.length === 0) continue;
      for (const block of surface.blocks) {
        points.push(
          new Vector3(block.x * INK_FILL_BLOCK_SIZE / INK_FILL_PIXELS_PER_WORLD_UNIT, block.y * INK_FILL_BLOCK_SIZE / INK_FILL_PIXELS_PER_WORLD_UNIT, 0),
          new Vector3((block.x + 1) * INK_FILL_BLOCK_SIZE / INK_FILL_PIXELS_PER_WORLD_UNIT, (block.y + 1) * INK_FILL_BLOCK_SIZE / INK_FILL_PIXELS_PER_WORLD_UNIT, 0),
        );
      }
    }
  } else if (hasFill) {
    const extent = getInkShapeExtent(shape);
    points.push(extent.clone().multiplyScalar(-1), extent);
  }
  if (points.length === 0) return null;
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const point of points) {
    min.min(point);
    max.max(point);
  }
  const visualMargin = outlineMargin + surfaceOutlineMargin;
  if (visualMargin > 0) min.addScalar(-visualMargin), max.addScalar(visualMargin);
  return { min, max };
}

function getInkShapePoint(shape: InkShape, point: InkSurfacePoint): Vector3 {
  if (shape.kind === 'plane' && 'x' in point) return new Vector3(point.x, point.y, 0);
  if (shape.kind === 'cuboid' && 'face' in point) {
    return getInkCuboidFacePosition(point.face, point.u, point.v).multiply(new Vector3(shape.size.x, shape.size.y, shape.size.z));
  }
  if (shape.kind === 'sphere' && 'z' in point) return new Vector3(point.x, point.y, point.z).multiplyScalar(shape.radius);
  if (shape.kind === 'cylinder' && isInkCylinderStrokePoint(point)) return getInkCylinderSurfacePosition(shape, point);
  if (shape.kind === 'frustum' && isInkCuboidStrokePoint(point)) return getInkFrustumFacePosition(shape, point);
  return new Vector3();
}

function getInkShapeExtent(shape: Exclude<InkShape, InkPlaneShape>): Vector3 {
  if (shape.kind === 'cuboid') return new Vector3(shape.size.x * 0.5, shape.size.y * 0.5, shape.size.z * 0.5);
  if (shape.kind === 'sphere') return new Vector3(shape.radius, shape.radius, shape.radius);
  if (shape.kind === 'cylinder') return new Vector3(shape.radius, shape.height * 0.5, shape.radius);
  const halfSize = Math.max(shape.topSize, shape.bottomSize) * 0.5;
  return new Vector3(halfSize, shape.height * 0.5, halfSize);
}

function transformInkShapePoint(shape: InkShape, point: Vector3): Vector3 {
  return point.applyEuler(new Euler(shape.rotation.x, shape.rotation.y, shape.rotation.z, 'YXZ')).add(new Vector3(shape.position.x, shape.position.y, shape.position.z));
}

function forEachBoundsCorner(minimum: Vector3, maximum: Vector3, visit: (corner: Vector3) => void): void {
  for (const x of [minimum.x, maximum.x]) for (const y of [minimum.y, maximum.y]) for (const z of [minimum.z, maximum.z]) visit(new Vector3(x, y, z));
}

/**
 * Reuses every Shape whose normalized local Ribbon is unchanged. Group anchors,
 * Shape transforms, Cuboid dimensions and Sphere radius do not invalidate that
 * Ribbon, although intrinsic dimension changes do rebuild their finite Fill chart.
 */
export function compileInkGroup(
  source: Pick<InkGroupData, 'anchorPosition' | 'shapes'>,
  previous?: CompiledInkGroup,
  _previousShapes?: readonly InkShape[],
): CompiledInkGroup {
  const canReusePrevious = previous?.formatVersion === INK_COMPILED_FORMAT_VERSION;
  const previousByShapeId = new Map(canReusePrevious ? previous.shapes.map((shape) => [shape.shapeId, shape]) : []);
  const shapes = source.shapes.map((shape) => {
    const prior = previousByShapeId.get(shape.id);
    const sourceHash = hashInkShapeSource(shape);
    return prior && prior.sourceHash === sourceHash ? prior : compileInkShape(shape, sourceHash, prior);
  });
  return {
    formatVersion: INK_COMPILED_FORMAT_VERSION,
    sourceHash: hashInkGroupSource(source, shapes),
    shapes,
  };
}

/** Compiles one Ink Shape without touching any sibling Shape. */
export function compileInkShape(
  shape: InkShape,
  sourceHash = hashInkShapeSource(shape),
  priorCompiled?: CompiledInkShape,
): CompiledInkShape {
  const ribbonSourceHash = hashInkRibbonSource(shape);
  if (priorCompiled?.ribbonSourceHash === ribbonSourceHash) {
    return {
      shapeId: shape.id,
      sourceHash,
      ribbonSourceHash,
      ribbon: priorCompiled.ribbon,
      fill: compileInkFill(shape),
    };
  }
  return {
    shapeId: shape.id,
    sourceHash,
    ribbonSourceHash,
    ribbon: compileInkShapeRibbon(shape),
    fill: compileInkFill(shape),
  };
}

/**
 * Produces only the temporary Ribbon geometry. Editor previews deliberately
 * skip source hashes and Fill compilation because neither affects the visible
 * in-progress line and both can grow with the entire authored Group.
 */
export function compileInkShapeRibbon(shape: InkShape): CompiledInkRibbon {
  const positions: number[] = [];
  const previous: number[] = [];
  const next: number[] = [];
  const fallbackNormals: number[] = [];
  const sides: number[] = [];
  const tangentOffsets: number[] = [];
  const widths: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const transform = new Matrix4();
  for (const stroke of shape.strokes) appendStrokeRibbon(
    shape,
    stroke,
    transform,
    positions,
    previous,
    next,
    fallbackNormals,
    sides,
    tangentOffsets,
    widths,
    colors,
    indices,
  );
  return { positions, previous, next, fallbackNormals, sides, tangentOffsets, widths, colors, indices };
}

type InkFillPixelCoordinate = {
  id: InkFillSurfaceId;
  x: number;
  y: number;
  width?: number;
  height?: number;
};

/**
 * Applies sampled colour stamps directly to sparse editable texture blocks.
 * The samples are deliberately transient input; no brush path is serialized.
 */
export function paintInkFill(
  shape: InkShape,
  points: readonly InkSurfacePoint[],
  color: string,
  size: number,
  brush: InkFillBrushShape,
  erase = false,
): InkShape {
  if (points.length === 0 || !Number.isFinite(size) || size <= 0) return shape;
  const fill = cloneInkFillLayer(shape.fill);
  const copiedBlocks = new Set<InkFillBlock>();
  const rgba = erase ? [0, 0, 0, 0] : toInkFillRgba(color);
  const radius = Math.max(0.5, size * INK_FILL_PIXELS_PER_WORLD_UNIT * 0.5);
  let prior: InkFillPixelCoordinate | null = null;
  for (const point of points) {
    const coordinate = getInkFillPixelCoordinate(shape, point);
    if (!coordinate) continue;
    const steps = prior && prior.id === coordinate.id
      ? Math.max(1, Math.ceil(Math.hypot(coordinate.x - prior.x, coordinate.y - prior.y) / Math.max(1, radius * 0.5)))
      : 1;
    for (let step = 1; step <= steps; step += 1) {
      const fraction = prior && prior.id === coordinate.id ? step / steps : 1;
      const x = prior && prior.id === coordinate.id ? prior.x + (coordinate.x - prior.x) * fraction : coordinate.x;
      const y = prior && prior.id === coordinate.id ? prior.y + (coordinate.y - prior.y) * fraction : coordinate.y;
      stampInkFill(fill, coordinate.id, x, y, coordinate.width, coordinate.height, radius, brush, rgba, copiedBlocks);
    }
    prior = coordinate;
  }
  normalizeInkFillLayer(fill);
  return { ...shape, fill };
}

/** Returns the unlit authored Fill colour at one Shape-local surface point. */
export function sampleInkFillColor(shape: InkShape, point: InkSurfacePoint): string | null {
  const coordinate = getInkFillPixelCoordinate(shape, point);
  if (!coordinate) return null;
  const surface = shape.fill.surfaces.find((candidate) => candidate.id === coordinate.id);
  if (!surface) return null;
  const rgba = readInkFillPixel(surface, Math.floor(coordinate.x), Math.floor(coordinate.y));
  if ((rgba[3] ?? 0) < 128) return null;
  return `#${[rgba[0], rgba[1], rgba[2]]
    .map((channel) => Math.round(Math.min(255, Math.max(0, channel ?? 0))).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Fills one chart-connected region; outlined pixels form immutable Bucket Fill boundaries. */
export function bucketFillInkShape(shape: InkShape, point: InkSurfacePoint, color: string): InkShape {
  const start = getInkFillPixelCoordinate(shape, point);
  if (!start) return shape;
  const fill = cloneInkFillLayer(shape.fill);
  const copiedBlocks = new Set<InkFillBlock>();
  const startSurface = ensureInkFillSurface(fill, start.id, start.width, start.height);
  const boundsBySurface = new Map<InkFillSurfaceId, { minX: number; minY: number; maxX: number; maxY: number }>();
  const barrierBySurface = new Map<InkFillSurfaceId, Set<string>>();
  const getBounds = (coordinate: InkFillPixelCoordinate): { minX: number; minY: number; maxX: number; maxY: number } => {
    const existing = boundsBySurface.get(coordinate.id);
    if (existing) return existing;
    const surface = ensureInkFillSurface(fill, coordinate.id, coordinate.width, coordinate.height);
    const bounds = getInkFillBounds(shape, surface, coordinate);
    boundsBySurface.set(coordinate.id, bounds);
    barrierBySurface.set(coordinate.id, rasterizeInkFillBoundary(shape, coordinate.id, bounds));
    return bounds;
  };
  const bounds = getBounds(start);
  const startX = clampInteger(Math.floor(start.x), bounds.minX, bounds.maxX - 1);
  const startY = clampInteger(Math.floor(start.y), bounds.minY, bounds.maxY - 1);
  const replacement = toInkFillRgba(color);
  const target = readInkFillPixel(startSurface, startX, startY);
  if (sameInkFillRgba(target, replacement)) return shape;
  if (barrierBySurface.get(start.id)!.has(`${startX},${startY}`)) return shape;

  const pending: Array<InkFillPixelCoordinate> = [{ ...start, x: startX, y: startY }];
  const visited = new Set<string>();
  const changed: InkFillPixelCoordinate[] = [];
  const maxPixels = 524_288;
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index]!;
    const currentBounds = getBounds(current);
    if (current.x < currentBounds.minX || current.x >= currentBounds.maxX || current.y < currentBounds.minY || current.y >= currentBounds.maxY) continue;
    const key = `${current.id}:${current.x},${current.y}`;
    const surface = ensureInkFillSurface(fill, current.id, current.width, current.height);
    if (visited.has(key) || barrierBySurface.get(current.id)!.has(`${current.x},${current.y}`) || !sameInkFillRgba(readInkFillPixel(surface, current.x, current.y), target)) continue;
    visited.add(key);
    changed.push(current);
    // Refuse an accidental, unbounded fill without committing a partial result.
    if (changed.length > maxPixels) return shape;
    const neighbours = [
      getInkFillNeighbour(shape, current, 1, 0), getInkFillNeighbour(shape, current, -1, 0),
      getInkFillNeighbour(shape, current, 0, 1), getInkFillNeighbour(shape, current, 0, -1),
    ];
    for (const neighbour of neighbours) if (neighbour) pending.push(neighbour);
  }
  if (changed.length === 0) return shape;
  for (const pixel of changed) {
    const surface = ensureInkFillSurface(fill, pixel.id, pixel.width, pixel.height);
    writeInkFillPixel(surface, pixel.x, pixel.y, replacement, copiedBlocks);
  }
  normalizeInkFillLayer(fill);
  return { ...shape, fill };
}

/** Moves one pixel through a finite Shape chart edge without introducing a UV seam. */
function getInkFillNeighbour(shape: InkShape, current: InkFillPixelCoordinate, deltaX: number, deltaY: number): InkFillPixelCoordinate | null {
  if (current.id === 'plane') return { ...current, x: current.x + deltaX, y: current.y + deltaY };
  const dimensions = getInkFillSurfaceDimensions(shape, current.id);
  if (!dimensions) return null;
  const x = current.x + deltaX;
  const y = current.y + deltaY;
  if (x >= 0 && x < dimensions.width && y >= 0 && y < dimensions.height) return { ...current, x, y, ...dimensions };
  if (shape.kind === 'cylinder') {
    // The side chart is periodic around the circumference. Cap charts remain
    // separate finite charts so a bucket cannot flow through a projected edge.
    if (current.id !== 'side' || y < 0 || y >= dimensions.height) return null;
    const wrappedX = ((x % dimensions.width) + dimensions.width) % dimensions.width;
    return { ...current, x: wrappedX, y, ...dimensions };
  }
  if (!isCuboidFace(current.id)) return null;
  const u = (x + 0.5) / dimensions.width - 0.5;
  const v = (y + 0.5) / dimensions.height - 0.5;
  const cubePosition = getInkCuboidFacePosition(current.id, u, v);
  if (shape.kind === 'sphere') {
    const direction = cubePosition.normalize();
    const chart = getInkSphereChart({ x: direction.x, y: direction.y, z: direction.z, pressure: 1 });
    const nextDimensions = getInkFillSurfaceDimensions(shape, chart.face)!;
    return { id: chart.face, x: clampInteger(Math.floor((chart.u + 0.5) * nextDimensions.width), 0, nextDimensions.width - 1), y: clampInteger(Math.floor((chart.v + 0.5) * nextDimensions.height), 0, nextDimensions.height - 1), ...nextDimensions };
  }
  if (shape.kind !== 'cuboid' && shape.kind !== 'frustum') return null;
  const chart = getInkCuboidChart(cubePosition);
  const nextDimensions = getInkFillSurfaceDimensions(shape, chart.face)!;
  return { id: chart.face, x: clampInteger(Math.floor((chart.u + 0.5) * nextDimensions.width), 0, nextDimensions.width - 1), y: clampInteger(Math.floor((chart.v + 0.5) * nextDimensions.height), 0, nextDimensions.height - 1), ...nextDimensions };
}

/** Resamples only finite Fill charts after an intrinsic dimension change. */
export function resampleInkShapeFill(previous: InkShape, next: InkShape): InkShape {
  if (previous.kind !== next.kind || previous.fill.surfaces.length === 0) return next;
  if (next.kind === 'plane') return next;
  const fill = createEmptyInkFillLayer();
  for (const previousSurface of previous.fill.surfaces) {
    const targetDimensions = getInkFillSurfaceDimensions(next, previousSurface.id);
    if (!targetDimensions || !previousSurface.width || !previousSurface.height) {
      fill.surfaces.push(cloneInkFillSurface(previousSurface));
      continue;
    }
    const target = ensureInkFillSurface(fill, previousSurface.id, targetDimensions.width, targetDimensions.height);
    forEachInkFillPixel(previousSurface, (x, y, rgba) => {
      if (rgba[3] === 0) return;
      const minX = Math.floor(x * targetDimensions.width / previousSurface.width!);
      const maxX = Math.max(minX, Math.ceil((x + 1) * targetDimensions.width / previousSurface.width!) - 1);
      const minY = Math.floor(y * targetDimensions.height / previousSurface.height!);
      const maxY = Math.max(minY, Math.ceil((y + 1) * targetDimensions.height / previousSurface.height!) - 1);
      for (let destinationY = minY; destinationY <= maxY; destinationY += 1) {
        for (let destinationX = minX; destinationX <= maxX; destinationX += 1) {
          if (destinationX >= 0 && destinationX < targetDimensions.width && destinationY >= 0 && destinationY < targetDimensions.height) {
            writeInkFillPixel(target, destinationX, destinationY, rgba);
          }
        }
      }
    });
  }
  normalizeInkFillLayer(fill);
  return { ...next, fill };
}

/** Builds compact RGBA rectangles for the renderer; empty sparse blocks are omitted. */
export function compileInkFill(shape: InkShape): CompiledInkFillSurface[] {
  const compiled: CompiledInkFillSurface[] = [];
  for (const surface of shape.fill.surfaces) {
    const bounds = getInkFillOccupiedBounds(surface);
    if (!bounds) continue;
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const rgba = new Array<number>(width * height * 4).fill(0);
    forEachInkFillPixel(surface, (x, y, pixel) => {
      if (x < bounds.minX || x >= bounds.maxX || y < bounds.minY || y >= bounds.maxY) return;
      const offset = ((y - bounds.minY) * width + (x - bounds.minX)) * 4;
      rgba[offset] = pixel[0] ?? 0;
      rgba[offset + 1] = pixel[1] ?? 0;
      rgba[offset + 2] = pixel[2] ?? 0;
      rgba[offset + 3] = pixel[3] ?? 0;
    });
    compiled.push({ id: surface.id, minX: bounds.minX, minY: bounds.minY, width, height, rgba });
  }
  return compiled;
}

function cloneInkFillLayer(fill: InkFillLayer): InkFillLayer {
  return {
    surfaces: fill.surfaces.map((surface) => ({
      id: surface.id,
      ...(surface.width !== undefined ? { width: surface.width } : {}),
      ...(surface.height !== undefined ? { height: surface.height } : {}),
      blocks: [...surface.blocks],
    })),
  };
}

function cloneInkFillSurface(surface: InkFillSurface): InkFillSurface {
  return {
    id: surface.id,
    ...(surface.width !== undefined ? { width: surface.width } : {}),
    ...(surface.height !== undefined ? { height: surface.height } : {}),
    blocks: surface.blocks.map((block) => ({ x: block.x, y: block.y, rgba: [...block.rgba] })),
  };
}

function getInkFillPixelCoordinate(shape: InkShape, point: InkSurfacePoint): InkFillPixelCoordinate | null {
  if (shape.kind === 'plane' && isInkPlaneStrokePoint(point)) {
    return { id: 'plane', x: point.x * INK_FILL_PIXELS_PER_WORLD_UNIT, y: point.y * INK_FILL_PIXELS_PER_WORLD_UNIT };
  }
  if (shape.kind === 'cuboid' && isInkCuboidStrokePoint(point)) {
    const dimensions = getInkFillSurfaceDimensions(shape, point.face)!;
    return { id: point.face, x: (point.u + 0.5) * dimensions.width, y: (point.v + 0.5) * dimensions.height, ...dimensions };
  }
  if (shape.kind === 'sphere' && isInkSphereStrokePoint(point)) {
    const chart = getInkSphereChart(point);
    const dimensions = getInkFillSurfaceDimensions(shape, chart.face)!;
    return { id: chart.face, x: (chart.u + 0.5) * dimensions.width, y: (chart.v + 0.5) * dimensions.height, ...dimensions };
  }
  if (shape.kind === 'cylinder' && isInkCylinderStrokePoint(point)) {
    const dimensions = getInkFillSurfaceDimensions(shape, point.surface)!;
    return {
      id: point.surface,
      x: (point.u + 0.5) * dimensions.width,
      y: (point.v + 0.5) * dimensions.height,
      ...dimensions,
    };
  }
  if (shape.kind === 'frustum' && isInkCuboidStrokePoint(point)) {
    const dimensions = getInkFillSurfaceDimensions(shape, point.face)!;
    return { id: point.face, x: (point.u + 0.5) * dimensions.width, y: (point.v + 0.5) * dimensions.height, ...dimensions };
  }
  return null;
}

function getInkFillSurfaceDimensions(shape: InkShape, id: InkFillSurfaceId): { width: number; height: number } | null {
  if (shape.kind === 'plane') return id === 'plane' ? null : null;
  if (shape.kind === 'sphere') {
    const side = Math.max(1, Math.ceil(shape.radius * 2 * INK_FILL_PIXELS_PER_WORLD_UNIT));
    return { width: side, height: side };
  }
  if (shape.kind === 'cylinder') {
    if (id === 'side') {
      return {
        width: Math.max(1, Math.ceil(Math.PI * 2 * shape.radius * INK_FILL_PIXELS_PER_WORLD_UNIT)),
        height: Math.max(1, Math.ceil(shape.height * INK_FILL_PIXELS_PER_WORLD_UNIT)),
      };
    }
    if (id === 'top' || id === 'bottom') {
      const side = Math.max(1, Math.ceil(shape.radius * 2 * INK_FILL_PIXELS_PER_WORLD_UNIT));
      return { width: side, height: side };
    }
    return null;
  }
  if (id === 'plane') return null;
  if (shape.kind === 'frustum') {
    if (id === 'positive-y' || id === 'negative-y') {
      const size = id === 'positive-y' ? shape.topSize : shape.bottomSize;
      const pixels = Math.max(1, Math.ceil(size * INK_FILL_PIXELS_PER_WORLD_UNIT));
      return { width: pixels, height: pixels };
    }
    const horizontal = (shape.topSize + shape.bottomSize) * 0.5;
    const vertical = Math.hypot(shape.height, (shape.topSize - shape.bottomSize) * 0.5);
    return {
      width: Math.max(1, Math.ceil(horizontal * INK_FILL_PIXELS_PER_WORLD_UNIT)),
      height: Math.max(1, Math.ceil(vertical * INK_FILL_PIXELS_PER_WORLD_UNIT)),
    };
  }
  const horizontal = id === 'positive-x' || id === 'negative-x' ? shape.size.z : shape.size.x;
  const vertical = id === 'positive-y' || id === 'negative-y' ? shape.size.z : shape.size.y;
  return {
    width: Math.max(1, Math.ceil(horizontal * INK_FILL_PIXELS_PER_WORLD_UNIT)),
    height: Math.max(1, Math.ceil(vertical * INK_FILL_PIXELS_PER_WORLD_UNIT)),
  };
}

function getInkSphereChart(point: InkSphereStrokePoint): { face: InkCuboidFace; u: number; v: number } {
  const direction = new Vector3(point.x, point.y, point.z).normalize();
  const absoluteX = Math.abs(direction.x);
  const absoluteY = Math.abs(direction.y);
  const absoluteZ = Math.abs(direction.z);
  // Fixed axis order makes an exact edge address deterministic.
  if (absoluteX >= absoluteY && absoluteX >= absoluteZ) {
    const divisor = Math.max(1e-8, absoluteX);
    return direction.x >= 0
      ? { face: 'positive-x', u: direction.z / divisor * 0.5, v: direction.y / divisor * 0.5 }
      : { face: 'negative-x', u: -direction.z / divisor * 0.5, v: direction.y / divisor * 0.5 };
  }
  if (absoluteY >= absoluteZ) {
    const divisor = Math.max(1e-8, absoluteY);
    return direction.y >= 0
      ? { face: 'positive-y', u: direction.x / divisor * 0.5, v: direction.z / divisor * 0.5 }
      : { face: 'negative-y', u: direction.x / divisor * 0.5, v: -direction.z / divisor * 0.5 };
  }
  const divisor = Math.max(1e-8, absoluteZ);
  return direction.z >= 0
    ? { face: 'positive-z', u: direction.x / divisor * 0.5, v: direction.y / divisor * 0.5 }
    : { face: 'negative-z', u: -direction.x / divisor * 0.5, v: direction.y / divisor * 0.5 };
}

function getInkCuboidChart(position: Vector3): { face: InkCuboidFace; u: number; v: number } {
  const absoluteX = Math.abs(position.x);
  const absoluteY = Math.abs(position.y);
  const absoluteZ = Math.abs(position.z);
  if (absoluteX >= absoluteY && absoluteX >= absoluteZ) {
    const divisor = Math.max(1e-8, absoluteX);
    return position.x >= 0
      ? { face: 'positive-x', u: position.z / divisor * 0.5, v: position.y / divisor * 0.5 }
      : { face: 'negative-x', u: -position.z / divisor * 0.5, v: position.y / divisor * 0.5 };
  }
  if (absoluteY >= absoluteZ) {
    const divisor = Math.max(1e-8, absoluteY);
    return position.y >= 0
      ? { face: 'positive-y', u: position.x / divisor * 0.5, v: position.z / divisor * 0.5 }
      : { face: 'negative-y', u: position.x / divisor * 0.5, v: -position.z / divisor * 0.5 };
  }
  const divisor = Math.max(1e-8, absoluteZ);
  return position.z >= 0
    ? { face: 'positive-z', u: position.x / divisor * 0.5, v: position.y / divisor * 0.5 }
    : { face: 'negative-z', u: -position.x / divisor * 0.5, v: position.y / divisor * 0.5 };
}

function getInkCuboidFacePosition(face: InkCuboidFace, u: number, v: number): Vector3 {
  if (face === 'positive-x') return new Vector3(0.5, v, u);
  if (face === 'negative-x') return new Vector3(-0.5, v, -u);
  if (face === 'positive-y') return new Vector3(u, 0.5, v);
  if (face === 'negative-y') return new Vector3(u, -0.5, -v);
  if (face === 'positive-z') return new Vector3(u, v, 0.5);
  return new Vector3(-u, v, -0.5);
}

export function getInkCylinderSurfacePosition(shape: InkCylinderShape, point: InkCylinderStrokePoint): Vector3 {
  if (point.surface === 'side') {
    const angle = (point.u + 0.5) * Math.PI * 2;
    return new Vector3(Math.cos(angle) * shape.radius, point.v * shape.height, Math.sin(angle) * shape.radius);
  }
  const y = point.surface === 'top' ? shape.height * 0.5 : -shape.height * 0.5;
  return new Vector3(point.u * shape.radius * 2, y, point.v * shape.radius * 2);
}

/** Converts a picked local cylinder surface position back to its authored chart point. */
export function getInkCylinderSurfacePoint(
  shape: InkCylinderShape,
  position: Vector3,
  surface: InkCylinderSurface,
  pressure: number,
): InkCylinderStrokePoint {
  if (surface === 'side') {
    const angle = Math.atan2(position.z, position.x);
    const wrappedAngle = angle < 0 ? angle + Math.PI * 2 : angle;
    return { surface, u: wrappedAngle / (Math.PI * 2) - 0.5, v: position.y / shape.height, pressure };
  }
  return { surface, u: position.x / (shape.radius * 2), v: position.z / (shape.radius * 2), pressure };
}

export function getInkFrustumFacePosition(shape: InkFrustumShape, point: InkCuboidStrokePoint): Vector3 {
  const halfHeight = shape.height * 0.5;
  const topHalf = shape.topSize * 0.5;
  const bottomHalf = shape.bottomSize * 0.5;
  if (point.face === 'positive-y') return new Vector3(point.u * shape.topSize, halfHeight, point.v * shape.topSize);
  if (point.face === 'negative-y') return new Vector3(point.u * shape.bottomSize, -halfHeight, -point.v * shape.bottomSize);
  const progress = point.v + 0.5;
  const halfSize = bottomHalf + (topHalf - bottomHalf) * progress;
  const y = -halfHeight + shape.height * progress;
  if (point.face === 'positive-x') return new Vector3(halfSize, y, point.u * halfSize * 2);
  if (point.face === 'negative-x') return new Vector3(-halfSize, y, -point.u * halfSize * 2);
  if (point.face === 'positive-z') return new Vector3(point.u * halfSize * 2, y, halfSize);
  return new Vector3(-point.u * halfSize * 2, y, -halfSize);
}

function ensureInkFillSurface(fill: InkFillLayer, id: InkFillSurfaceId, width?: number, height?: number): InkFillSurface {
  let surface = fill.surfaces.find((candidate) => candidate.id === id);
  if (!surface) {
    surface = { id, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), blocks: [] };
    fill.surfaces.push(surface);
  }
  if (width !== undefined) surface.width = width;
  if (height !== undefined) surface.height = height;
  return surface;
}

function stampInkFill(
  fill: InkFillLayer,
  id: InkFillSurfaceId,
  centerX: number,
  centerY: number,
  width: number | undefined,
  height: number | undefined,
  radius: number,
  brush: InkFillBrushShape,
  rgba: readonly number[],
  copiedBlocks: Set<InkFillBlock>,
): void {
  const surface = ensureInkFillSurface(fill, id, width, height);
  const minX = Math.max(width === undefined ? -Infinity : 0, Math.floor(centerX - radius));
  const maxX = Math.min(width === undefined ? Infinity : width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(height === undefined ? -Infinity : 0, Math.floor(centerY - radius));
  const maxY = Math.min(height === undefined ? Infinity : height - 1, Math.ceil(centerY + radius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const deltaX = x + 0.5 - centerX;
      const deltaY = y + 0.5 - centerY;
      if (brush === 'circle' && deltaX * deltaX + deltaY * deltaY > radius * radius) continue;
      writeInkFillPixel(surface, x, y, rgba, copiedBlocks);
    }
  }
}

function getInkFillBounds(shape: InkShape, surface: InkFillSurface, start: InkFillPixelCoordinate): { minX: number; minY: number; maxX: number; maxY: number } {
  if (surface.width !== undefined && surface.height !== undefined) return { minX: 0, minY: 0, maxX: surface.width, maxY: surface.height };
  const occupied = getInkFillOccupiedBounds(surface);
  const outline = getInkFillOutlineBounds(shape, start.id);
  const minX = Math.floor(Math.min(occupied?.minX ?? start.x, outline?.minX ?? start.x, start.x)) - INK_FILL_BLOCK_SIZE;
  const minY = Math.floor(Math.min(occupied?.minY ?? start.y, outline?.minY ?? start.y, start.y)) - INK_FILL_BLOCK_SIZE;
  const maxX = Math.ceil(Math.max(occupied?.maxX ?? start.x + 1, outline?.maxX ?? start.x + 1, start.x + 1)) + INK_FILL_BLOCK_SIZE;
  const maxY = Math.ceil(Math.max(occupied?.maxY ?? start.y + 1, outline?.maxY ?? start.y + 1, start.y + 1)) + INK_FILL_BLOCK_SIZE;
  return { minX, minY, maxX, maxY };
}

function getInkFillOutlineBounds(shape: InkShape, id: InkFillSurfaceId): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of shape.strokes) for (const point of stroke.points) {
    const coordinate = getInkFillPixelCoordinate(shape, point);
    if (!coordinate || coordinate.id !== id) continue;
    minX = Math.min(minX, coordinate.x);
    minY = Math.min(minY, coordinate.y);
    maxX = Math.max(maxX, coordinate.x);
    maxY = Math.max(maxY, coordinate.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function rasterizeInkFillBoundary(shape: InkShape, id: InkFillSurfaceId, bounds: { minX: number; minY: number; maxX: number; maxY: number }): Set<string> {
  const pixels = new Set<string>();
  for (const stroke of shape.strokes) {
    let prior: InkFillPixelCoordinate | null = null;
    for (const point of stroke.points) {
      const coordinate = getInkFillPixelCoordinate(shape, point);
      if (!coordinate || coordinate.id !== id) {
        prior = null;
        continue;
      }
      if (prior) {
        const steps = Math.max(1, Math.ceil(Math.hypot(coordinate.x - prior.x, coordinate.y - prior.y)));
        const radius = Math.max(1, Math.ceil(stroke.width * INK_FILL_PIXELS_PER_WORLD_UNIT * 0.5));
        for (let step = 0; step <= steps; step += 1) {
          const x = Math.round(prior.x + (coordinate.x - prior.x) * step / steps);
          const y = Math.round(prior.y + (coordinate.y - prior.y) * step / steps);
          for (let offsetY = -radius; offsetY <= radius; offsetY += 1) for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
            const boundaryX = x + offsetX;
            const boundaryY = y + offsetY;
            if (boundaryX >= bounds.minX && boundaryX < bounds.maxX && boundaryY >= bounds.minY && boundaryY < bounds.maxY) pixels.add(`${boundaryX},${boundaryY}`);
          }
        }
      }
      prior = coordinate;
    }
  }
  return pixels;
}

function getInkFillOccupiedBounds(surface: InkFillSurface): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const blocks = surface.blocks.filter((block) => hasInkFillBlockColor(block));
  if (blocks.length === 0) return null;
  return {
    minX: Math.min(...blocks.map((block) => block.x * INK_FILL_BLOCK_SIZE)),
    minY: Math.min(...blocks.map((block) => block.y * INK_FILL_BLOCK_SIZE)),
    maxX: Math.max(...blocks.map((block) => (block.x + 1) * INK_FILL_BLOCK_SIZE)),
    maxY: Math.max(...blocks.map((block) => (block.y + 1) * INK_FILL_BLOCK_SIZE)),
  };
}

function readInkFillPixel(surface: InkFillSurface, x: number, y: number): number[] {
  const block = surface.blocks.find((candidate) => candidate.x === floorDivide(x, INK_FILL_BLOCK_SIZE) && candidate.y === floorDivide(y, INK_FILL_BLOCK_SIZE));
  if (!block) return [0, 0, 0, 0];
  const offset = ((modulo(y, INK_FILL_BLOCK_SIZE) * INK_FILL_BLOCK_SIZE) + modulo(x, INK_FILL_BLOCK_SIZE)) * 4;
  return [block.rgba[offset] ?? 0, block.rgba[offset + 1] ?? 0, block.rgba[offset + 2] ?? 0, block.rgba[offset + 3] ?? 0];
}

function writeInkFillPixel(surface: InkFillSurface, x: number, y: number, rgba: readonly number[], copiedBlocks?: Set<InkFillBlock>): void {
  const blockX = floorDivide(x, INK_FILL_BLOCK_SIZE);
  const blockY = floorDivide(y, INK_FILL_BLOCK_SIZE);
  let blockIndex = surface.blocks.findIndex((candidate) => candidate.x === blockX && candidate.y === blockY);
  let block = blockIndex >= 0 ? surface.blocks[blockIndex] : undefined;
  if (!block) {
    block = { x: blockX, y: blockY, rgba: new Array<number>(INK_FILL_BLOCK_SIZE * INK_FILL_BLOCK_SIZE * 4).fill(0) };
    surface.blocks.push(block);
    copiedBlocks?.add(block);
  } else if (copiedBlocks && !copiedBlocks.has(block)) {
    block = { x: block.x, y: block.y, rgba: [...block.rgba] };
    surface.blocks[blockIndex] = block;
    copiedBlocks.add(block);
  }
  const offset = ((modulo(y, INK_FILL_BLOCK_SIZE) * INK_FILL_BLOCK_SIZE) + modulo(x, INK_FILL_BLOCK_SIZE)) * 4;
  block.rgba[offset] = rgba[0] ?? 0;
  block.rgba[offset + 1] = rgba[1] ?? 0;
  block.rgba[offset + 2] = rgba[2] ?? 0;
  block.rgba[offset + 3] = rgba[3] ?? 0;
}

function forEachInkFillPixel(surface: InkFillSurface, callback: (x: number, y: number, rgba: number[]) => void): void {
  for (const block of surface.blocks) for (let y = 0; y < INK_FILL_BLOCK_SIZE; y += 1) for (let x = 0; x < INK_FILL_BLOCK_SIZE; x += 1) {
    const offset = (y * INK_FILL_BLOCK_SIZE + x) * 4;
    callback(block.x * INK_FILL_BLOCK_SIZE + x, block.y * INK_FILL_BLOCK_SIZE + y, [block.rgba[offset] ?? 0, block.rgba[offset + 1] ?? 0, block.rgba[offset + 2] ?? 0, block.rgba[offset + 3] ?? 0]);
  }
}

function normalizeInkFillLayer(fill: InkFillLayer): void {
  for (const surface of fill.surfaces) {
    surface.blocks = surface.blocks.filter(hasInkFillBlockColor).sort((left, right) => left.y - right.y || left.x - right.x);
  }
  fill.surfaces = fill.surfaces.filter((surface) => surface.blocks.length > 0).sort((left, right) => left.id.localeCompare(right.id));
}

function hasInkFillBlockColor(block: InkFillBlock): boolean {
  for (let index = 3; index < block.rgba.length; index += 4) if (block.rgba[index] !== 0) return true;
  return false;
}

function sameInkFillRgba(left: readonly number[], right: readonly number[]): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2] && left[3] === right[3];
}

function toInkFillRgba(color: string): number[] {
  const parsed = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  return parsed ? [Number.parseInt(parsed[1]!, 16), Number.parseInt(parsed[2]!, 16), Number.parseInt(parsed[3]!, 16), 255] : [0, 0, 0, 255];
}

function floorDivide(value: number, divisor: number): number { return Math.floor(value / divisor); }
function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }
function clampInteger(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

export function isInkGroupData(value: unknown): value is InkGroupData {
  if (!isInkGroupSource(value)) return false;
  const candidate = value as Partial<InkGroupData>;
  return isCompiledInkGroup(candidate.compiled)
    && candidate.compiled.sourceHash === hashInkGroupSource(
      { anchorPosition: candidate.anchorPosition!, shapes: candidate.shapes! },
      candidate.compiled.shapes,
    )
    && candidate.compiled.shapes.length === candidate.shapes!.length
    && candidate.shapes!.every((shape) => candidate.compiled!.shapes.some((compiled) => (
      compiled.shapeId === shape.id && compiled.sourceHash === hashInkShapeSource(shape)
    )));
}

/** Accepts a complete serialized source even while its Worker-derived payload is pending refresh. */
export function isInkGroupSerializedData(value: unknown): value is InkGroupData {
  return isInkGroupSource(value) && isCompiledInkGroup((value as Partial<InkGroupData>).compiled);
}

function isInkGroupSource(value: unknown): value is Omit<InkGroupData, 'compiled'> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkGroupData>;
  return typeof candidate.id === 'string' && !!candidate.id
    && typeof candidate.name === 'string' && !!candidate.name.trim()
    && isVector3(candidate.anchorPosition)
    && (candidate.placementRotation === undefined || isInkGroupRotation(candidate.placementRotation))
    && Array.isArray(candidate.shapes)
    && candidate.shapes.every(isInkShape);
}

export function isInkManagerData(value: unknown): value is InkManagerData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkManagerData>;
  const ids = new Set<string>();
  if (!Array.isArray(candidate.groups) || candidate.groups.length !== 0) return false;
  const assetIds = new Set<string>();
  if (!Array.isArray(candidate.embeddedAssets) || !candidate.embeddedAssets.every((asset) => (
    isInkEmbeddedAsset(asset) && !assetIds.has(asset.assetId) && !!assetIds.add(asset.assetId)
  ))) return false;
  return Array.isArray(candidate.assetReferences) && candidate.assetReferences.every((reference) => (
    isInkAssetReference(reference) && !ids.has(reference.id) && !!ids.add(reference.id)
  ));
}

export function isInkCompiledCurrent(data: InkGroupData): boolean {
  return isInkGroupData(data);
}

/**
 * v1–v5 data stored Canvas Planes directly. v6 Sphere samples used unstable
 * UV coordinates and are intentionally retired rather than reprojected.
 */
export function upgradeInkManagerCompiledData(value: unknown): InkManagerData | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<InkManagerData>;
  if (!Array.isArray(candidate.groups) || candidate.groups.length !== 0) return null;
  const ids = new Set<string>();
  const embeddedAssets: InkEmbeddedAsset[] = [];
  const assetIds = new Set<string>();
  for (const rawAsset of candidate.embeddedAssets ?? []) {
    const asset = upgradeInkEmbeddedAsset(rawAsset);
    if (!asset || assetIds.has(asset.assetId)) return null;
    assetIds.add(asset.assetId);
    embeddedAssets.push(asset);
  }
  const assetReferences: InkAssetReference[] = [];
  for (const rawReference of candidate.assetReferences ?? []) {
    const reference = upgradeInkAssetReference(rawReference);
    if (!reference || ids.has(reference.id)) return null;
    ids.add(reference.id);
    assetReferences.push(reference);
  }
  return {
    groups: [],
    embeddedAssets,
    assetReferences,
  };
}

function isInkEmbeddedAsset(value: unknown): value is InkEmbeddedAsset {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkEmbeddedAsset>;
  return typeof candidate.assetId === 'string' && !!candidate.assetId
    && isInkGroupSerializedData(candidate.group)
    && candidate.group.id === candidate.assetId;
}

function upgradeInkEmbeddedAsset(value: unknown): InkEmbeddedAsset | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<InkEmbeddedAsset>;
  if (typeof candidate.assetId !== 'string' || !candidate.assetId) return null;
  const group = upgradeInkGroupData(candidate.group);
  if (!group) return null;
  return group.id === candidate.assetId
    ? { assetId: candidate.assetId, group }
    : createInkEmbeddedAsset(group, candidate.assetId);
}

function isInkAssetReference(value: unknown): value is InkAssetReference {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkAssetReference>;
  return typeof candidate.id === 'string' && !!candidate.id
    && typeof candidate.assetId === 'string' && !!candidate.assetId
    && isVector3(candidate.anchorPosition)
    && isInkGroupRotation(candidate.rotation);
}

function upgradeInkAssetReference(value: unknown): InkAssetReference | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<InkAssetReference> & { anchorCell?: unknown };
  const anchorPosition = isVector3(candidate.anchorPosition)
    ? candidate.anchorPosition
    : isGridCell(candidate.anchorCell)
      ? candidate.anchorCell
      : null;
  if (typeof candidate.id !== 'string' || !candidate.id
    || typeof candidate.assetId !== 'string' || !candidate.assetId
    || !anchorPosition || !isInkGroupRotation(candidate.rotation)) return null;
  return {
    id: candidate.id,
    assetId: candidate.assetId,
    anchorPosition: { ...anchorPosition },
    rotation: candidate.rotation,
  };
}

function isInkGroupRotation(value: unknown): value is InkGroupRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

export function upgradeInkGroupData(value: unknown): InkGroupData | null {
  // Current assets are loaded as trusted project data. Retaining their
  // immutable compiled payload avoids re-compiling every large Group on the UI
  // thread merely to migrate a catalog that is already current.
  if (isInkGroupSerializedData(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<InkGroupData> & { anchorCell?: unknown; planes?: unknown };
  const anchorPosition = isVector3(candidate.anchorPosition)
    ? candidate.anchorPosition
    : isGridCell(candidate.anchorCell)
      ? candidate.anchorCell
      : null;
  if (typeof candidate.id !== 'string' || !candidate.id
    || typeof candidate.name !== 'string' || !candidate.name.trim()
    || !anchorPosition) return null;
  const shapes = upgradeShapes(candidate.shapes) ?? upgradeLegacyPlanes(candidate.planes);
  if (!shapes) return null;
  const source = {
    id: candidate.id,
    name: candidate.name,
    anchorPosition: { ...anchorPosition },
    shapes,
  };
  return { ...source, compiled: compileInkGroup(source) };
}

function upgradeShapes(value: unknown): InkShape[] | null {
  if (!Array.isArray(value)) return null;
  const shapes: InkShape[] = [];
  for (const rawShape of value) {
    const upgradedShape = upgradeRetiredNormalOutsetAndSurfaceOutline(rawShape);
    if (upgradedShape && isInkShape(upgradedShape)) {
      const withFill = upgradedShape.fill ? upgradedShape : { ...upgradedShape, fill: createEmptyInkFillLayer() };
      shapes.push((withFill.kind === 'plane' || withFill.kind === 'cuboid' || withFill.kind === 'frustum') && withFill.lastOutlineEnd === undefined
        ? { ...withFill, lastOutlineEnd: null }
        : withFill);
      continue;
    }
    const retiredSphere = retireLegacySphereStrokes(rawShape);
    if (!retiredSphere) return null;
    shapes.push(retiredSphere);
  }
  return shapes;
}

/** Retires legacy shell data and gives supported curved Shapes their default setting. */
function upgradeRetiredNormalOutsetAndSurfaceOutline(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const candidate = value as Record<string, unknown>;
  const { normalOutset: _retiredNormalOutset, surfaceOutline, ...withoutRetiredSetting } = candidate;
  if (candidate.kind !== 'sphere' && candidate.kind !== 'cylinder') return withoutRetiredSetting;
  return {
    ...withoutRetiredSetting,
    surfaceOutline: isInkSurfaceOutlineSettings(surfaceOutline)
      ? surfaceOutline
      : createDefaultInkSurfaceOutlineSettings(),
  };
}

/** v6 Sphere UV strokes are not geometrically compatible with v7 and must be redrawn. */
function retireLegacySphereStrokes(value: unknown): InkSphereShape | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<InkSphereShape>;
  if (candidate.kind !== 'sphere'
    || typeof candidate.id !== 'string' || !candidate.id
    || !isVector3(candidate.position) || !isVector3(candidate.rotation)
    || !isFiniteRange(candidate.radius, 0.05, 64)
    || !Array.isArray(candidate.strokes) || !candidate.strokes.every(isLegacyInkSphereStroke)) return null;
  return {
    id: candidate.id,
    kind: 'sphere',
    position: { ...candidate.position },
    rotation: { ...candidate.rotation },
    radius: candidate.radius,
    strokes: [],
    fill: createEmptyInkFillLayer(),
    surfaceOutline: createDefaultInkSurfaceOutlineSettings(),
  };
}

function upgradeLegacyPlanes(value: unknown): InkShape[] | null {
  if (!Array.isArray(value)) return null;
  const shapes: InkShape[] = [];
  for (const rawPlane of value) {
    const plane = upgradeLegacyPlane(rawPlane);
    if (!plane) return null;
    shapes.push(plane);
  }
  return shapes;
}

function upgradeLegacyPlane(value: unknown): InkPlaneShape | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<InkPlaneShape>;
  if (!isPlaneOrientation(candidate.orientation)
    || typeof candidate.id !== 'string' || !candidate.id
    || !isVector3(candidate.position) || !isVector3(candidate.rotation)
    || !Array.isArray(candidate.strokes) || !candidate.strokes.every(isLegacyInkOutlineStroke)) return null;
  return {
    id: candidate.id,
    kind: 'plane',
    orientation: candidate.orientation,
    position: { ...candidate.position },
    rotation: { ...candidate.rotation },
    strokes: candidate.strokes.map((stroke) => ({
      id: stroke.id,
      color: stroke.color,
      width: stroke.width,
      points: (stroke.points as InkPlaneStrokePoint[]).map((point) => ({ x: point.x, y: point.y, pressure: point.pressure })),
    })),
    fill: createEmptyInkFillLayer(),
    lastOutlineEnd: null,
  };
}

function appendStrokeRibbon(
  shape: InkShape,
  stroke: InkOutlineStroke,
  transform: Matrix4,
  positions: number[],
  previous: number[],
  next: number[],
  fallbackNormals: number[],
  sides: number[],
  tangentOffsets: number[],
  widths: number[],
  colors: number[],
  indices: number[],
): void {
  if (stroke.points.length < 2) return;
  const color = parseInkColor(stroke.color);
  const sampledPoints: ResolvedInkStrokePoint[] = [];
  let previousSpherePoint: InkSphereStrokePoint | null = null;
  let previousCuboidPoint: InkCuboidStrokePoint | null = null;
  for (const point of stroke.points) {
    const resolved = resolveInkShapePoint(shape, point, transform);
    if (!resolved) continue;
    if (shape.kind === 'sphere' && previousSpherePoint && isInkSphereStrokePoint(point)) {
      appendSphereSegmentSamples(shape, transform, previousSpherePoint, point, sampledPoints);
    }
    if (shape.kind === 'cuboid' && previousCuboidPoint && isInkCuboidStrokePoint(point)) {
      appendCuboidSurfaceSegmentSamples(transform, previousCuboidPoint, point, sampledPoints);
    }
    const previousPoint = sampledPoints.at(-1);
    // Input sampling should already suppress these, but compiled data must also
    // be safe when loading a manually edited document.
    if (!previousPoint || previousPoint.position.distanceToSquared(resolved.position) > 1e-10) sampledPoints.push(resolved);
    previousSpherePoint = shape.kind === 'sphere' && isInkSphereStrokePoint(point) ? point : null;
    previousCuboidPoint = shape.kind === 'cuboid' && isInkCuboidStrokePoint(point) ? point : null;
  }
  if (sampledPoints.length < 2) return;
  const startIndex = positions.length / 3;
  for (let index = 0; index < sampledPoints.length; index += 1) {
    const current = sampledPoints[index]!;
    const prior = sampledPoints[Math.max(0, index - 1)]!;
    const following = sampledPoints[Math.min(sampledPoints.length - 1, index + 1)]!;
    for (const side of [-1, 1]) appendRibbonVertex(
      current.position,
      prior.position,
      following.position,
      current.normal,
      side,
      0,
      current.pressure,
      stroke.width,
      color,
      positions,
      previous,
      next,
      fallbackNormals,
      sides,
      tangentOffsets,
      widths,
      colors,
    );
  }
  for (let index = 0; index < sampledPoints.length - 1; index += 1) {
    const first = startIndex + index * 2;
    indices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
  }
  appendRoundRibbonCap(sampledPoints[0]!, sampledPoints[1]!, stroke.width, -1, color, positions, previous, next, fallbackNormals, sides, tangentOffsets, widths, colors, indices);
  appendRoundRibbonCap(sampledPoints[sampledPoints.length - 1]!, sampledPoints[sampledPoints.length - 2]!, stroke.width, 1, color, positions, previous, next, fallbackNormals, sides, tangentOffsets, widths, colors, indices);
}

type ResolvedInkStrokePoint = { position: Vector3; normal: Vector3; pressure: number };

type CuboidAxis = 'x' | 'y' | 'z';

/**
 * Adds hard-edge surface samples between Cuboid faces. Source points remain
 * face-local; only the compiled Ribbon receives these deterministic bridges.
 */
function appendCuboidSurfaceSegmentSamples(
  transform: Matrix4,
  from: InkCuboidStrokePoint,
  to: InkCuboidStrokePoint,
  destination: ResolvedInkStrokePoint[],
): void {
  if (from.face === to.face) return;
  const path = getCuboidFacePath(from.face, to.face);
  const fromPosition = resolveCuboidPoint(from).position;
  const toPosition = resolveCuboidPoint(to).position;
  for (let index = 0; index < path.length - 1; index += 1) {
    const firstFace = path[index]!;
    const secondFace = path[index + 1]!;
    const position = findCuboidEdgePoint(fromPosition, toPosition, firstFace, secondFace);
    const normal = getCuboidFaceNormal(firstFace).add(getCuboidFaceNormal(secondFace)).normalize();
    const previous = destination.at(-1);
    const transformedPosition = position.applyMatrix4(transform);
    if (previous && previous.position.distanceToSquared(transformedPosition) <= 1e-10) continue;
    destination.push({
      position: transformedPosition,
      normal: normal.transformDirection(transform).normalize(),
      pressure: from.pressure + (to.pressure - from.pressure) * ((index + 1) / path.length),
    });
  }
}

/** A deterministic minimum-hop route prevents sparse samples from cutting through a Cuboid. */
function getCuboidFacePath(from: InkCuboidFace, to: InkCuboidFace): InkCuboidFace[] {
  if (from === to) return [from];
  const previous = new Map<InkCuboidFace, InkCuboidFace | null>([[from, null]]);
  const queue: InkCuboidFace[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const candidate of CUBOID_FACE_ORDER) {
      if (previous.has(candidate) || !areCuboidFacesAdjacent(current, candidate)) continue;
      previous.set(candidate, current);
      if (candidate === to) {
        const path: InkCuboidFace[] = [];
        let cursor: InkCuboidFace | null = to;
        while (cursor) {
          path.unshift(cursor);
          cursor = previous.get(cursor) ?? null;
        }
        return path;
      }
      queue.push(candidate);
    }
  }
  return [from, to];
}

function areCuboidFacesAdjacent(first: InkCuboidFace, second: InkCuboidFace): boolean {
  if (first === second) return false;
  return getCuboidFaceNormal(first).dot(getCuboidFaceNormal(second)) === 0;
}

/** Chooses the shortest two-face route through the shared edge, with stable tie breaking. */
function findCuboidEdgePoint(from: Vector3, to: Vector3, firstFace: InkCuboidFace, secondFace: InkCuboidFace): Vector3 {
  const first = getCuboidFaceAxis(firstFace);
  const second = getCuboidFaceAxis(secondFace);
  const freeAxis = (['x', 'y', 'z'] as const).find((axis) => axis !== first.axis && axis !== second.axis)!;
  const point = new Vector3();
  point[first.axis] = first.sign * 0.5;
  point[second.axis] = second.sign * 0.5;
  let low = -0.5;
  let high = 0.5;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const lowerThird = (2 * low + high) / 3;
    const upperThird = (low + 2 * high) / 3;
    point[freeAxis] = lowerThird;
    const lowerDistance = point.distanceTo(from) + point.distanceTo(to);
    point[freeAxis] = upperThird;
    const upperDistance = point.distanceTo(from) + point.distanceTo(to);
    if (lowerDistance <= upperDistance) high = upperThird;
    else low = lowerThird;
  }
  point[freeAxis] = (low + high) * 0.5;
  return point;
}

function getCuboidFaceAxis(face: InkCuboidFace): { axis: CuboidAxis; sign: number } {
  if (face === 'positive-x') return { axis: 'x', sign: 1 };
  if (face === 'negative-x') return { axis: 'x', sign: -1 };
  if (face === 'positive-y') return { axis: 'y', sign: 1 };
  if (face === 'negative-y') return { axis: 'y', sign: -1 };
  if (face === 'positive-z') return { axis: 'z', sign: 1 };
  return { axis: 'z', sign: -1 };
}

function getCuboidFaceNormal(face: InkCuboidFace): Vector3 {
  const { axis, sign } = getCuboidFaceAxis(face);
  const normal = new Vector3();
  normal[axis] = sign;
  return normal;
}

/** Adds compiled-only surface samples so one sparse input segment cannot cut through a faceted Sphere. */
function appendSphereSegmentSamples(
  shape: InkSphereShape,
  transform: Matrix4,
  from: InkSphereStrokePoint,
  to: InkSphereStrokePoint,
  destination: ResolvedInkStrokePoint[],
): void {
  const start = new Vector3(from.x, from.y, from.z).normalize();
  const end = new Vector3(to.x, to.y, to.z).normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, start.dot(end))));
  const segments = Math.ceil(angle / MAX_COMPILED_SPHERE_SEGMENT_ANGLE);
  for (let index = 1; index < segments; index += 1) {
    const fraction = index / segments;
    const direction = start.clone().lerp(end, fraction).normalize();
    const pressure = from.pressure + (to.pressure - from.pressure) * fraction;
    const sample = resolveInkShapePoint(shape, { x: direction.x, y: direction.y, z: direction.z, pressure }, transform);
    if (sample) destination.push(sample);
  }
}

function resolveInkShapePoint(shape: InkShape, point: InkSurfacePoint, transform: Matrix4): ResolvedInkStrokePoint | null {
  const local = resolveInkShapePointLocal(shape, point);
  if (!local) return null;
  return {
    position: local.position.applyMatrix4(transform),
    normal: local.normal.transformDirection(transform).normalize(),
    pressure: clampPressure(point.pressure),
  };
}

function resolveInkShapePointLocal(shape: InkShape, point: InkSurfacePoint): { position: Vector3; normal: Vector3 } | null {
  if (shape.kind === 'plane' && isInkPlaneStrokePoint(point)) {
    return { position: new Vector3(point.x, point.y, 0), normal: new Vector3(0, 0, 1) };
  }
  if (shape.kind === 'cuboid' && isInkCuboidStrokePoint(point)) return resolveCuboidPoint(point);
  if (shape.kind === 'sphere' && isInkSphereStrokePoint(point)) return resolveSpherePoint(point);
  if (shape.kind === 'cylinder' && isInkCylinderStrokePoint(point)) return resolveCylinderPoint(shape, point);
  if (shape.kind === 'frustum' && isInkCuboidStrokePoint(point)) return resolveFrustumPoint(shape, point);
  return null;
}

/** Compiled Cuboid points occupy a unit local box; Shape scale owns the size. */
function resolveCuboidPoint(point: InkCuboidStrokePoint): { position: Vector3; normal: Vector3 } {
  if (point.face === 'positive-x') return { position: new Vector3(0.5, point.v, point.u), normal: new Vector3(1, 0, 0) };
  if (point.face === 'negative-x') return { position: new Vector3(-0.5, point.v, -point.u), normal: new Vector3(-1, 0, 0) };
  if (point.face === 'positive-y') return { position: new Vector3(point.u, 0.5, point.v), normal: new Vector3(0, 1, 0) };
  if (point.face === 'negative-y') return { position: new Vector3(point.u, -0.5, -point.v), normal: new Vector3(0, -1, 0) };
  if (point.face === 'positive-z') return { position: new Vector3(point.u, point.v, 0.5), normal: new Vector3(0, 0, 1) };
  return { position: new Vector3(-point.u, point.v, -0.5), normal: new Vector3(0, 0, -1) };
}

/** Compiled Sphere points lie on the unit 6-face × 4 × 4 surface; Shape scale owns the radius. */
function resolveSpherePoint(point: InkSphereStrokePoint): { position: Vector3; normal: Vector3 } {
  const direction = new Vector3(point.x, point.y, point.z).normalize();
  return projectInkSphereDirection(direction);
}

function resolveCylinderPoint(shape: InkCylinderShape, point: InkCylinderStrokePoint): { position: Vector3; normal: Vector3 } {
  const position = getInkCylinderSurfacePosition(shape, point);
  if (point.surface === 'top') return { position, normal: new Vector3(0, 1, 0) };
  if (point.surface === 'bottom') return { position, normal: new Vector3(0, -1, 0) };
  return { position, normal: new Vector3(position.x, 0, position.z).normalize() };
}

function resolveFrustumPoint(shape: InkFrustumShape, point: InkCuboidStrokePoint): { position: Vector3; normal: Vector3 } {
  const position = getInkFrustumFacePosition(shape, point);
  if (point.face === 'positive-y') return { position, normal: new Vector3(0, 1, 0) };
  if (point.face === 'negative-y') return { position, normal: new Vector3(0, -1, 0) };
  const rise = (shape.bottomSize - shape.topSize) * 0.5;
  if (point.face === 'positive-x') return { position, normal: new Vector3(shape.height, rise, 0).normalize() };
  if (point.face === 'negative-x') return { position, normal: new Vector3(-shape.height, rise, 0).normalize() };
  if (point.face === 'positive-z') return { position, normal: new Vector3(0, rise, shape.height).normalize() };
  return { position, normal: new Vector3(0, rise, -shape.height).normalize() };
}

function projectInkSphereDirection(direction: Vector3): { position: Vector3; normal: Vector3 } {
  for (let index = 0; index < INK_SPHERE_TRIANGLE_INDICES.length; index += 3) {
    const first = INK_SPHERE_UNIT_VERTICES[INK_SPHERE_TRIANGLE_INDICES[index]!]!;
    const second = INK_SPHERE_UNIT_VERTICES[INK_SPHERE_TRIANGLE_INDICES[index + 1]!]!;
    const third = INK_SPHERE_UNIT_VERTICES[INK_SPHERE_TRIANGLE_INDICES[index + 2]!]!;
    const distance = intersectRayWithTriangle(direction, first, second, third);
    if (distance === null) continue;
    const position = direction.clone().multiplyScalar(distance);
    const normal = second.clone().sub(first).cross(third.clone().sub(first)).normalize();
    if (normal.dot(position) < 0) normal.negate();
    return { position, normal };
  }
  // Every non-zero direction intersects this convex surface. Preserve a safe
  // fallback for externally edited input that approaches the zero vector.
  return { position: direction.clone(), normal: direction.clone() };
}

/** Möller–Trumbore ray/triangle intersection for the unit Sphere surface. */
function intersectRayWithTriangle(direction: Vector3, first: Vector3, second: Vector3, third: Vector3): number | null {
  const edgeOne = second.clone().sub(first);
  const edgeTwo = third.clone().sub(first);
  const determinant = edgeOne.dot(direction.clone().cross(edgeTwo));
  if (Math.abs(determinant) <= 1e-8) return null;
  const inverseDeterminant = 1 / determinant;
  const fromFirst = first.clone().negate();
  const u = fromFirst.dot(direction.clone().cross(edgeTwo)) * inverseDeterminant;
  if (u < -1e-8 || u > 1 + 1e-8) return null;
  const v = direction.dot(fromFirst.clone().cross(edgeOne)) * inverseDeterminant;
  if (v < -1e-8 || u + v > 1 + 1e-8) return null;
  const distance = edgeTwo.dot(fromFirst.clone().cross(edgeOne)) * inverseDeterminant;
  return distance > 1e-8 ? distance : null;
}

function createInkSphereUnitVertices(): Vector3[] {
  const vertices: Vector3[] = [];
  for (const face of CUBOID_FACE_ORDER) {
    for (let y = 0; y <= INK_SPHERE_FACE_SEGMENTS; y += 1) {
      for (let x = 0; x <= INK_SPHERE_FACE_SEGMENTS; x += 1) {
        const u = x / INK_SPHERE_FACE_SEGMENTS - 0.5;
        const v = y / INK_SPHERE_FACE_SEGMENTS - 0.5;
        vertices.push(resolveCuboidPoint({ face, u, v, pressure: 1 }).position.normalize());
      }
    }
  }
  return vertices;
}

function createInkSphereTriangleIndices(): number[] {
  const indices: number[] = [];
  const verticesPerFace = (INK_SPHERE_FACE_SEGMENTS + 1) ** 2;
  for (let faceIndex = 0; faceIndex < CUBOID_FACE_ORDER.length; faceIndex += 1) {
    const face = CUBOID_FACE_ORDER[faceIndex]!;
    const first = faceIndex * verticesPerFace;
    for (let y = 0; y < INK_SPHERE_FACE_SEGMENTS; y += 1) {
      for (let x = 0; x < INK_SPHERE_FACE_SEGMENTS; x += 1) {
        const topLeft = first + y * (INK_SPHERE_FACE_SEGMENTS + 1) + x;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + INK_SPHERE_FACE_SEGMENTS + 1;
        const bottomRight = bottomLeft + 1;
        // ±Z charts reverse their local U orientation relative to the other
        // cube faces. Reverse their winding so every sphere face has outward
        // geometry normals for ray helpers and Fill lighting.
        if (face === 'positive-z' || face === 'negative-z') {
          indices.push(topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft);
        } else {
          indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
        }
      }
    }
  }
  return indices;
}

/** The camera-facing shader expands this small fan into a world-width round cap. */
function appendRoundRibbonCap(
  endpoint: ResolvedInkStrokePoint,
  neighbour: ResolvedInkStrokePoint,
  width: number,
  direction: -1 | 1,
  color: { r: number; g: number; b: number },
  positions: number[],
  previous: number[],
  next: number[],
  fallbackNormals: number[],
  sides: number[],
  tangentOffsets: number[],
  widths: number[],
  colors: number[],
  indices: number[],
): void {
  const prior = direction < 0 ? endpoint : neighbour;
  const following = direction < 0 ? neighbour : endpoint;
  const center = appendRibbonVertex(endpoint.position, prior.position, following.position, endpoint.normal, 0, 0, endpoint.pressure, width, color, positions, previous, next, fallbackNormals, sides, tangentOffsets, widths, colors);
  const arc: number[] = [];
  const segments = 6;
  for (let index = 0; index <= segments; index += 1) {
    const angle = (Math.PI * index) / segments;
    arc.push(appendRibbonVertex(endpoint.position, prior.position, following.position, endpoint.normal, Math.cos(angle), direction * Math.sin(angle), endpoint.pressure, width, color, positions, previous, next, fallbackNormals, sides, tangentOffsets, widths, colors));
  }
  for (let index = 0; index < arc.length - 1; index += 1) indices.push(center, arc[index]!, arc[index + 1]!);
}

function appendRibbonVertex(
  current: Vector3,
  prior: Vector3,
  following: Vector3,
  normal: Vector3,
  side: number,
  tangentOffset: number,
  pressure: number,
  width: number,
  color: { r: number; g: number; b: number },
  positions: number[],
  previous: number[],
  next: number[],
  fallbackNormals: number[],
  sides: number[],
  tangentOffsets: number[],
  widths: number[],
  colors: number[],
): number {
  const vertex = positions.length / 3;
  positions.push(current.x, current.y, current.z);
  previous.push(prior.x, prior.y, prior.z);
  next.push(following.x, following.y, following.z);
  fallbackNormals.push(normal.x, normal.y, normal.z);
  sides.push(side);
  tangentOffsets.push(tangentOffset);
  widths.push(width * pressure);
  colors.push(color.r, color.g, color.b);
  return vertex;
}

function getInitialPlaneRotation(orientation: InkPlaneOrientation, cameraRotation: InkVector3): InkVector3 {
  if (orientation === 'camera') return { ...cameraRotation };
  if (orientation === 'z') return { x: 0, y: 0, z: 0 };
  if (orientation === 'y') return { x: Math.PI * 0.5, y: 0, z: 0 };
  return { x: 0, y: Math.PI * 0.5, z: 0 };
}

function isInkShape(value: unknown): value is InkShape {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkShape>;
  if (typeof candidate.id !== 'string' || !candidate.id || !isVector3(candidate.position) || !isVector3(candidate.rotation)) return false;
  if (candidate.kind === 'plane') {
    return isPlaneOrientation(candidate.orientation)
      && isShapeStrokes(candidate.strokes, isInkPlaneStrokePoint)
      && (candidate.fill === undefined || isInkFillLayer(candidate.fill))
      && (candidate.lastOutlineEnd === undefined || candidate.lastOutlineEnd === null || isVector2(candidate.lastOutlineEnd));
  }
  if (candidate.kind === 'cuboid') {
    return isVector3InRange(candidate.size, 0.05, 64)
      && isShapeStrokes(candidate.strokes, isInkCuboidStrokePoint)
      && (candidate.fill === undefined || isInkFillLayer(candidate.fill))
      && (candidate.lastOutlineEnd === undefined || candidate.lastOutlineEnd === null || isInkCuboidStrokePoint(candidate.lastOutlineEnd));
  }
  if (candidate.kind === 'sphere') return isFiniteRange(candidate.radius, 0.05, 64)
    && isShapeStrokes(candidate.strokes, isInkSphereStrokePoint)
    && (candidate.fill === undefined || isInkFillLayer(candidate.fill))
    && isInkSurfaceOutlineSettings(candidate.surfaceOutline);
  if (candidate.kind === 'cylinder') return isFiniteRange(candidate.radius, 0.05, 64)
    && isFiniteRange(candidate.height, 0.05, 64)
    && isShapeStrokes(candidate.strokes, isInkCylinderStrokePoint)
    && (candidate.fill === undefined || isInkFillLayer(candidate.fill))
    && isInkSurfaceOutlineSettings(candidate.surfaceOutline);
  if (candidate.kind === 'frustum') return isFiniteRange(candidate.topSize, 0.05, 64)
    && isFiniteRange(candidate.bottomSize, 0.05, 64)
    && isFiniteRange(candidate.height, 0.05, 64)
    && isShapeStrokes(candidate.strokes, isInkCuboidStrokePoint)
    && (candidate.fill === undefined || isInkFillLayer(candidate.fill))
    && (candidate.lastOutlineEnd === undefined || candidate.lastOutlineEnd === null || isInkCuboidStrokePoint(candidate.lastOutlineEnd));
  return false;
}

function isInkSurfaceOutlineSettings(value: unknown): value is InkSurfaceOutlineSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkSurfaceOutlineSettings>;
  return typeof candidate.enabled === 'boolean'
    && isFiniteRange(candidate.width, 0.001, 1);
}

function isInkFillLayer(value: unknown): value is InkFillLayer {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkFillLayer>;
  const ids = new Set<string>();
  return Array.isArray(candidate.surfaces) && candidate.surfaces.every((surface) => (
    isInkFillSurface(surface) && !ids.has(surface.id) && !!ids.add(surface.id)
  ));
}

function isInkFillSurface(value: unknown): value is InkFillSurface {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkFillSurface>;
  const finiteSize = (candidate.width === undefined && candidate.height === undefined)
    || (Number.isInteger(candidate.width) && candidate.width! > 0 && Number.isInteger(candidate.height) && candidate.height! > 0);
  const ids = new Set<string>();
  return (candidate.id === 'plane' || isCuboidFace(candidate.id) || isInkCylinderSurface(candidate.id))
    && finiteSize
    && Array.isArray(candidate.blocks)
    && candidate.blocks.every((block) => isInkFillBlock(block) && !ids.has(`${block.x},${block.y}`) && !!ids.add(`${block.x},${block.y}`));
}

function isInkFillBlock(value: unknown): value is InkFillBlock {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkFillBlock>;
  return Number.isInteger(candidate.x) && Number.isInteger(candidate.y)
    && Array.isArray(candidate.rgba)
    && candidate.rgba.length === INK_FILL_BLOCK_SIZE * INK_FILL_BLOCK_SIZE * 4
    && candidate.rgba.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255);
}

function isShapeStrokes(points: unknown, pointValidator: (value: unknown) => boolean): points is InkOutlineStroke[] {
  return Array.isArray(points) && points.every((stroke) => isInkOutlineStroke(stroke, pointValidator));
}

function isInkOutlineStroke(value: unknown, pointValidator: (value: unknown) => boolean): value is InkOutlineStroke {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkOutlineStroke>;
  return typeof candidate.id === 'string' && !!candidate.id
    && typeof candidate.color === 'string' && /^#[0-9a-f]{6}$/i.test(candidate.color)
    && isFiniteRange(candidate.width, 0.001, 1)
    && Array.isArray(candidate.points) && candidate.points.every(pointValidator);
}

function isLegacyInkOutlineStroke(value: unknown): value is InkOutlineStroke {
  return isInkOutlineStroke(value, isInkPlaneStrokePoint);
}

function isLegacyInkSphereStroke(value: unknown): value is InkOutlineStroke {
  return isInkOutlineStroke(value, isLegacyInkSphereStrokePoint);
}

function isInkPlaneStrokePoint(value: unknown): value is InkPlaneStrokePoint {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkPlaneStrokePoint>;
  return isFiniteNumber(candidate.x) && isFiniteNumber(candidate.y) && isFiniteRange(candidate.pressure, 0.05, 8);
}

function isInkCuboidStrokePoint(value: unknown): value is InkCuboidStrokePoint {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkCuboidStrokePoint>;
  return isCuboidFace(candidate.face) && isFiniteRange(candidate.u, -0.5, 0.5) && isFiniteRange(candidate.v, -0.5, 0.5) && isFiniteRange(candidate.pressure, 0.05, 8);
}

function isInkSphereStrokePoint(value: unknown): value is InkSphereStrokePoint {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkSphereStrokePoint>;
  if (!isVector3(candidate) || !isFiniteRange((candidate as Partial<InkSphereStrokePoint>).pressure, 0.05, 8)) return false;
  const lengthSquared = candidate.x * candidate.x + candidate.y * candidate.y + candidate.z * candidate.z;
  return lengthSquared >= 0.999 && lengthSquared <= 1.001;
}

function isInkCylinderStrokePoint(value: unknown): value is InkCylinderStrokePoint {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkCylinderStrokePoint>;
  return isInkCylinderSurface(candidate.surface)
    && isFiniteRange(candidate.u, -0.5, 0.5)
    && isFiniteRange(candidate.v, -0.5, 0.5)
    && isFiniteRange(candidate.pressure, 0.05, 8);
}

function isInkCylinderSurface(value: unknown): value is InkCylinderSurface {
  return value === 'side' || value === 'top' || value === 'bottom';
}

function isLegacyInkSphereStrokePoint(value: unknown): value is { u: number; v: number; pressure: number } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { u?: unknown; v?: unknown; pressure?: unknown };
  return isFiniteRange(candidate.u, 0, 1) && isFiniteRange(candidate.v, 0, 1) && isFiniteRange(candidate.pressure, 0.05, 8);
}

function isCompiledInkGroup(value: unknown): value is CompiledInkGroup {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CompiledInkGroup>;
  return candidate.formatVersion === INK_COMPILED_FORMAT_VERSION
    && typeof candidate.sourceHash === 'string'
    && Array.isArray(candidate.shapes)
    && candidate.shapes.every(isCompiledInkShape);
}

function isCompiledInkShape(value: unknown): value is CompiledInkShape {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CompiledInkShape>;
  return typeof candidate.shapeId === 'string' && !!candidate.shapeId
    && typeof candidate.sourceHash === 'string'
    && typeof candidate.ribbonSourceHash === 'string'
    && isCompiledInkRibbon(candidate.ribbon)
    && Array.isArray(candidate.fill)
    && candidate.fill.every(isCompiledInkFillSurface);
}

function isCompiledInkFillSurface(value: unknown): value is CompiledInkFillSurface {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CompiledInkFillSurface>;
  return (candidate.id === 'plane' || isCuboidFace(candidate.id) || isInkCylinderSurface(candidate.id))
    && Number.isInteger(candidate.minX)
    && Number.isInteger(candidate.minY)
    && Number.isInteger(candidate.width) && candidate.width! > 0
    && Number.isInteger(candidate.height) && candidate.height! > 0
    && Array.isArray(candidate.rgba)
    && candidate.rgba.length === candidate.width! * candidate.height! * 4
    && candidate.rgba.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255);
}

function isCompiledInkRibbon(value: unknown): value is CompiledInkRibbon {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CompiledInkRibbon>;
  const vectorArrays = [candidate.positions, candidate.previous, candidate.next, candidate.fallbackNormals, candidate.colors];
  return vectorArrays.every((array) => isFiniteArray(array) && array.length % 3 === 0)
    && isFiniteArray(candidate.sides)
    && isFiniteArray(candidate.tangentOffsets)
    && isFiniteArray(candidate.widths)
    && Array.isArray(candidate.indices)
    && candidate.indices.every((index) => Number.isInteger(index) && index >= 0)
    && candidate.positions!.length / 3 === candidate.sides!.length
    && candidate.positions!.length / 3 === candidate.tangentOffsets!.length
    && candidate.positions!.length / 3 === candidate.widths!.length
    && candidate.positions!.length === candidate.previous!.length
    && candidate.positions!.length === candidate.next!.length
    && candidate.positions!.length === candidate.fallbackNormals!.length
    && candidate.positions!.length === candidate.colors!.length;
}

/** Hashes Group transform metadata plus precomputed per-Shape source hashes. */
export function hashInkGroupSource(
  source: Pick<InkGroupData, 'anchorPosition' | 'shapes'>,
  compiledShapes?: readonly Pick<CompiledInkShape, 'shapeId' | 'sourceHash'>[],
): string {
  const geometryHashByShapeId = new Map(compiledShapes?.map((shape) => [shape.shapeId, shape.sourceHash]));
  // The Group hash preserves all Shape parameters while folding each immutable
  // stroke payload into its already-canonical local-geometry hash. That avoids
  // reserializing every stroke on a transform-only edit.
  return hashInkData({
    anchorPosition: source.anchorPosition,
    shapes: source.shapes.map((shape) => ({
      id: shape.id,
      kind: shape.kind,
      position: shape.position,
      rotation: shape.rotation,
      ...(shape.kind === 'plane' ? { orientation: shape.orientation } : {}),
      ...(shape.kind === 'cuboid' ? { size: shape.size } : {}),
      ...(shape.kind === 'sphere' ? { radius: shape.radius } : {}),
      ...(shape.kind === 'cylinder' ? { radius: shape.radius, height: shape.height } : {}),
      ...(shape.kind === 'frustum' ? { topSize: shape.topSize, bottomSize: shape.bottomSize, height: shape.height } : {}),
      geometrySourceHash: geometryHashByShapeId.get(shape.id) ?? hashInkShapeSource(shape),
    })),
  });
}

/** Stroke, Fill, and surface-outline configuration changes require a new canonical Shape payload. */
/** Full author-data hash for one Shape; Worker compilation owns this hot path. */
export function hashInkShapeSource(shape: InkShape): string {
  return hashInkData({
    id: shape.id,
    kind: shape.kind,
    strokes: shape.strokes,
    fill: shape.fill,
    ...(shape.kind === 'sphere' || shape.kind === 'cylinder' ? { surfaceOutline: shape.surfaceOutline } : {}),
    ...(shape.kind === 'cylinder' ? { radius: shape.radius, height: shape.height } : {}),
    ...(shape.kind === 'frustum' ? { topSize: shape.topSize, bottomSize: shape.bottomSize, height: shape.height } : {}),
  });
}

function hashInkRibbonSource(shape: InkShape): string {
  return hashInkData({
    id: shape.id,
    kind: shape.kind,
    strokes: shape.strokes,
    ...(shape.kind === 'cylinder' ? { radius: shape.radius, height: shape.height } : {}),
    ...(shape.kind === 'frustum' ? { topSize: shape.topSize, bottomSize: shape.bottomSize, height: shape.height } : {}),
  });
}
function hashInkData(source: unknown): string { return hashDerivedAssetSource(source); }

function parseInkColor(value: string): { r: number; g: number; b: number } {
  const parsed = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!parsed) return { r: 0, g: 0, b: 0 };
  return {
    r: Number.parseInt(parsed[1]!, 16) / 255,
    g: Number.parseInt(parsed[2]!, 16) / 255,
    b: Number.parseInt(parsed[3]!, 16) / 255,
  };
}

function normalizeInkStrokeColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : DEFAULT_INK_STROKE_COLOR;
}

function clampInkStrokeWidth(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0.001, value)) : DEFAULT_INK_STROKE_WIDTH;
}

function isGridCell(value: unknown): value is InkGridCell {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkGridCell>;
  return Number.isInteger(candidate.x) && Number.isInteger(candidate.y) && Number.isInteger(candidate.z);
}

function isPlaneOrientation(value: unknown): value is InkPlaneOrientation {
  return value === 'x' || value === 'y' || value === 'z' || value === 'camera';
}

function isCuboidFace(value: unknown): value is InkCuboidFace {
  return value === 'positive-x' || value === 'negative-x' || value === 'positive-y'
    || value === 'negative-y' || value === 'positive-z' || value === 'negative-z';
}

function isVector3(value: unknown): value is InkVector3 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkVector3>;
  return isFiniteNumber(candidate.x) && isFiniteNumber(candidate.y) && isFiniteNumber(candidate.z);
}

function isVector2(value: unknown): value is InkVector2 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InkVector2>;
  return isFiniteNumber(candidate.x) && isFiniteNumber(candidate.y);
}

function isVector3InRange(value: unknown, minimum: number, maximum: number): value is InkVector3 {
  return isVector3(value) && isFiniteRange(value.x, minimum, maximum) && isFiniteRange(value.y, minimum, maximum) && isFiniteRange(value.z, minimum, maximum);
}

function isFiniteArray(value: unknown): value is number[] { return Array.isArray(value) && value.every(isFiniteNumber); }
function isFiniteRange(value: unknown, minimum: number, maximum: number): value is number { return isFiniteNumber(value) && value >= minimum && value <= maximum; }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function clampPressure(value: number): number { return Math.max(0.05, Math.min(8, value)); }
