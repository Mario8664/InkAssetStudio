import {
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type BufferAttribute,
  type InterleavedBufferAttribute,
  type Object3D,
} from 'three';
import {
  INK_FILL_BLOCK_SIZE,
  INK_FILL_PIXELS_PER_WORLD_UNIT,
  INK_SPHERE_FACE_SEGMENTS,
  createInkSphereGeometry,
  type InkShape,
} from '../domain/ink/ink';
import { applyInkShapeRenderTransform } from './InkGroupRenderer';

export const ACTIVE_INK_SHAPE_SURFACE = { color: '#63c7fa', opacity: 0.34 } as const;
export const INACTIVE_INK_SHAPE_SURFACE = { color: '#548097', opacity: 0.16 } as const;
export const ACTIVE_INK_SHAPE_GRID = { color: '#b9ebff', opacity: 0.84 } as const;
export const INACTIVE_INK_SHAPE_GRID = { color: '#7aa0ae', opacity: 0.42 } as const;

export type InkShapePreview = {
  root: Group;
  surface: Mesh;
  grid: LineSegments;
};

/** Creates the same editor-only Shape surface and reference grid used by Painting. */
export function createInkShapePreview(shape: InkShape, active: boolean): InkShapePreview {
  const root = new Group();
  root.name = 'InkShapePreview';
  const style = active ? ACTIVE_INK_SHAPE_SURFACE : INACTIVE_INK_SHAPE_SURFACE;
  const material = new MeshBasicMaterial({
    color: style.color,
    transparent: true,
    opacity: style.opacity,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
  });
  const surface = shape.kind === 'plane'
    ? createInkPlaneSurface(shape, material)
    : shape.kind === 'cuboid'
      ? new Mesh(new BoxGeometry(1, 1, 1), material)
      : new Mesh(createInkSphereGeometry(1), material);
  surface.name = 'InkShapePreviewSurface';
  surface.renderOrder = active ? 4 : 3;
  const grid = createInkShapeReferenceGrid(shape, active);
  root.add(surface, grid);
  applyInkShapeRenderTransform(root, shape);
  return { root, surface, grid };
}

export function getInkPlanePreviewBounds(shape: Extract<InkShape, { kind: 'plane' }>): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = -0.5;
  let maxX = 0.5;
  let minY = -0.5;
  let maxY = 0.5;
  for (const stroke of shape.strokes) for (const point of stroke.points) {
    if (!('x' in point) || !('y' in point)) continue;
    minX = Math.min(minX, point.x - 0.25);
    maxX = Math.max(maxX, point.x + 0.25);
    minY = Math.min(minY, point.y - 0.25);
    maxY = Math.max(maxY, point.y + 0.25);
  }
  const fill = shape.fill.surfaces.find((surface) => surface.id === 'plane');
  for (const block of fill?.blocks ?? []) {
    minX = Math.min(minX, block.x * INK_FILL_BLOCK_SIZE / INK_FILL_PIXELS_PER_WORLD_UNIT - 0.25);
    maxX = Math.max(maxX, (block.x + 1) * INK_FILL_BLOCK_SIZE / INK_FILL_PIXELS_PER_WORLD_UNIT + 0.25);
    minY = Math.min(minY, block.y * INK_FILL_BLOCK_SIZE / INK_FILL_PIXELS_PER_WORLD_UNIT - 0.25);
    maxY = Math.max(maxY, (block.y + 1) * INK_FILL_BLOCK_SIZE / INK_FILL_PIXELS_PER_WORLD_UNIT + 0.25);
  }
  return { minX, maxX, minY, maxY };
}

/** Disposes both Mesh and LineSegments resources owned by the preview tree. */
export function disposeInkShapePreviewTree(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    const renderable = object as Object3D & { geometry?: unknown; material?: unknown };
    if (renderable.geometry instanceof BufferGeometry) geometries.add(renderable.geometry);
    const entries = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
    for (const material of entries) if (material instanceof Material) materials.add(material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  root.clear();
}

function createInkPlaneSurface(shape: Extract<InkShape, { kind: 'plane' }>, material: MeshBasicMaterial): Mesh {
  const bounds = getInkPlanePreviewBounds(shape);
  const surface = new Mesh(new PlaneGeometry(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY), material);
  surface.position.set((bounds.minX + bounds.maxX) * 0.5, (bounds.minY + bounds.maxY) * 0.5, 0);
  return surface;
}

function createInkShapeReferenceGrid(shape: InkShape, active: boolean): LineSegments {
  if (shape.kind === 'plane') return createInkPlaneGrid(getInkPlanePreviewBounds(shape), active);
  if (shape.kind === 'cuboid') return createInkCuboidGrid(shape, active);
  return createInkSphereGrid(active);
}

function createInkCuboidGrid(shape: Extract<InkShape, { kind: 'cuboid' }>, active: boolean): LineSegments {
  const positions: number[] = [];
  const xValues = getUnitReferenceGridCoordinates(shape.size.x);
  const yValues = getUnitReferenceGridCoordinates(shape.size.y);
  const zValues = getUnitReferenceGridCoordinates(shape.size.z);
  const outer = 0.501;
  for (const y of yValues) {
    appendReferenceLine(positions, outer, y, -outer, outer, y, outer);
    appendReferenceLine(positions, -outer, y, -outer, -outer, y, outer);
  }
  for (const z of zValues) {
    appendReferenceLine(positions, outer, -outer, z, outer, outer, z);
    appendReferenceLine(positions, -outer, -outer, z, -outer, outer, z);
  }
  for (const x of xValues) {
    appendReferenceLine(positions, x, outer, -outer, x, outer, outer);
    appendReferenceLine(positions, x, -outer, -outer, x, -outer, outer);
  }
  for (const z of zValues) {
    appendReferenceLine(positions, -outer, outer, z, outer, outer, z);
    appendReferenceLine(positions, -outer, -outer, z, outer, -outer, z);
  }
  for (const x of xValues) {
    appendReferenceLine(positions, x, -outer, outer, x, outer, outer);
    appendReferenceLine(positions, x, -outer, -outer, x, outer, -outer);
  }
  for (const y of yValues) {
    appendReferenceLine(positions, -outer, y, outer, outer, y, outer);
    appendReferenceLine(positions, -outer, y, -outer, outer, y, -outer);
  }
  return createInkReferenceGrid(positions, active);
}

function createInkSphereGrid(active: boolean): LineSegments {
  const sphere = createInkSphereGeometry(1);
  const attribute = sphere.getAttribute('position');
  const positions: number[] = [];
  const verticesPerFace = (INK_SPHERE_FACE_SEGMENTS + 1) ** 2;
  for (let face = 0; face < 6; face += 1) {
    const first = face * verticesPerFace;
    for (let y = 0; y <= INK_SPHERE_FACE_SEGMENTS; y += 1) for (let x = 0; x < INK_SPHERE_FACE_SEGMENTS; x += 1) {
      appendSphereGridEdge(positions, attribute, first + y * (INK_SPHERE_FACE_SEGMENTS + 1) + x, first + y * (INK_SPHERE_FACE_SEGMENTS + 1) + x + 1);
    }
    for (let x = 0; x <= INK_SPHERE_FACE_SEGMENTS; x += 1) for (let y = 0; y < INK_SPHERE_FACE_SEGMENTS; y += 1) {
      appendSphereGridEdge(positions, attribute, first + y * (INK_SPHERE_FACE_SEGMENTS + 1) + x, first + (y + 1) * (INK_SPHERE_FACE_SEGMENTS + 1) + x);
    }
  }
  sphere.dispose();
  return createInkReferenceGrid(positions, active);
}

function appendSphereGridEdge(
  positions: number[],
  attribute: BufferAttribute | InterleavedBufferAttribute,
  from: number,
  to: number,
): void {
  const offset = 1.002;
  positions.push(
    attribute.getX(from) * offset, attribute.getY(from) * offset, attribute.getZ(from) * offset,
    attribute.getX(to) * offset, attribute.getY(to) * offset, attribute.getZ(to) * offset,
  );
}

function getUnitReferenceGridCoordinates(size: number): number[] {
  const minimum = -size * 0.5;
  const maximum = size * 0.5;
  const coordinates = [minimum];
  for (let coordinate = Math.ceil(minimum); coordinate <= Math.floor(maximum); coordinate += 1) coordinates.push(coordinate);
  coordinates.push(maximum);
  return [...new Set(coordinates.map((coordinate) => coordinate / size))];
}

function appendReferenceLine(
  positions: number[],
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
): void {
  positions.push(fromX, fromY, fromZ, toX, toY, toZ);
}

function createInkReferenceGrid(positions: number[], active: boolean): LineSegments {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const style = active ? ACTIVE_INK_SHAPE_GRID : INACTIVE_INK_SHAPE_GRID;
  const material = new LineBasicMaterial({
    color: style.color,
    transparent: true,
    opacity: style.opacity,
    depthTest: true,
    depthWrite: false,
  });
  const grid = new LineSegments(geometry, material);
  grid.name = 'InkShapeReferenceGrid';
  grid.renderOrder = active ? 5 : 4;
  return grid;
}

function createInkPlaneGrid(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  active: boolean,
): LineSegments {
  const positions: number[] = [];
  const minGridX = Math.ceil(bounds.minX);
  const maxGridX = Math.floor(bounds.maxX);
  const minGridY = Math.ceil(bounds.minY);
  const maxGridY = Math.floor(bounds.maxY);
  for (let x = minGridX; x <= maxGridX; x += 1) positions.push(x, bounds.minY, 0.001, x, bounds.maxY, 0.001);
  for (let y = minGridY; y <= maxGridY; y += 1) positions.push(bounds.minX, y, 0.001, bounds.maxX, y, 0.001);
  positions.push(bounds.minX, bounds.minY, 0.002, bounds.maxX, bounds.minY, 0.002);
  positions.push(bounds.maxX, bounds.minY, 0.002, bounds.maxX, bounds.maxY, 0.002);
  positions.push(bounds.maxX, bounds.maxY, 0.002, bounds.minX, bounds.maxY, 0.002);
  positions.push(bounds.minX, bounds.maxY, 0.002, bounds.minX, bounds.minY, 0.002);
  return createInkReferenceGrid(positions, active);
}
