import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  type ColorRepresentation,
} from 'three';

type GridBounds = {
  minimumCellX: number;
  maximumCellX: number;
  minimumCellZ: number;
  maximumCellZ: number;
  axisLength: number;
};

export type EditorViewportGuidesOptions = {
  camera: PerspectiveCamera;
  radius?: number;
  cellSize?: number;
  y?: number;
  gridColor?: ColorRepresentation;
  gridOpacity?: number;
  axisOpacity?: number;
};

/** Studio-owned editor guides. They never enter work-scene data or exports. */
export class EditorViewportGuides extends Group {
  private readonly gridMaterial: LineBasicMaterial;
  private readonly xAxisMaterial: MeshBasicMaterial;
  private readonly yAxisMaterial: MeshBasicMaterial;
  private readonly zAxisMaterial: MeshBasicMaterial;
  private readonly camera: PerspectiveCamera;
  private readonly cellSize: number;
  private readonly axisThickness: number;
  private readonly y: number;
  private readonly fallbackRadius: number;
  private gridLines: LineSegments | null = null;
  private xAxis: Mesh | null = null;
  private yAxis: Mesh | null = null;
  private zAxis: Mesh | null = null;
  private bounds: GridBounds | null = null;
  private gridVisible = true;
  private axesVisible = true;

  constructor(options: EditorViewportGuidesOptions) {
    super();
    this.name = 'EditorViewportGuides';
    this.camera = options.camera;
    this.fallbackRadius = Math.max(1, Math.floor(options.radius ?? 64));
    this.cellSize = options.cellSize ?? 1;
    this.y = options.y ?? 0;
    this.gridMaterial = new LineBasicMaterial({
      color: options.gridColor ?? '#8090a0',
      transparent: true,
      opacity: options.gridOpacity ?? 0.28,
      depthWrite: false,
    });
    const axisOpacity = options.axisOpacity ?? 0.38;
    this.axisThickness = Math.max(this.cellSize * 0.045, 0.035);
    this.xAxisMaterial = createAxisMaterial('#df6f70', axisOpacity);
    this.yAxisMaterial = createAxisMaterial('#78bc86', axisOpacity);
    this.zAxisMaterial = createAxisMaterial('#6f91cf', axisOpacity);
    this.update();
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
    if (this.gridLines) this.gridLines.visible = visible;
  }

  setAxesVisible(visible: boolean): void {
    this.axesVisible = visible;
    if (this.xAxis) this.xAxis.visible = visible;
    if (this.yAxis) this.yAxis.visible = visible;
    if (this.zAxis) this.zAxis.visible = visible;
  }

  update(): void {
    const nextBounds = this.computeBounds();
    if (areSameBounds(this.bounds, nextBounds)) return;
    this.bounds = nextBounds;
    this.rebuildGrid(nextBounds);
    this.rebuildAxes(nextBounds.axisLength);
  }

  dispose(): void {
    this.disposeLine(this.gridLines);
    this.disposeMesh(this.xAxis);
    this.disposeMesh(this.yAxis);
    this.disposeMesh(this.zAxis);
    this.gridLines = null;
    this.xAxis = null;
    this.yAxis = null;
    this.zAxis = null;
    this.gridMaterial.dispose();
    this.xAxisMaterial.dispose();
    this.yAxisMaterial.dispose();
    this.zAxisMaterial.dispose();
    this.clear();
  }

  private computeBounds(): GridBounds {
    const finiteFar = Number.isFinite(this.camera.far) ? this.camera.far : this.fallbackRadius * this.cellSize;
    const viewRadius = Math.max(this.cellSize, finiteFar);
    const centerCellX = worldCoordinateToCell(this.camera.position.x, this.cellSize);
    const centerCellZ = worldCoordinateToCell(this.camera.position.z, this.cellSize);
    const radiusCells = Math.max(1, Math.ceil(viewRadius / this.cellSize) + 2);
    const axisLength = ceilToCellSize(Math.max(
      viewRadius,
      Math.abs(this.camera.position.x) + viewRadius,
      Math.abs(this.camera.position.y) + viewRadius,
      Math.abs(this.camera.position.z) + viewRadius,
    ), this.cellSize);
    return {
      minimumCellX: centerCellX - radiusCells,
      maximumCellX: centerCellX + radiusCells,
      minimumCellZ: centerCellZ - radiusCells,
      maximumCellZ: centerCellZ + radiusCells,
      axisLength,
    };
  }

  private rebuildGrid(bounds: GridBounds): void {
    this.disposeLine(this.gridLines);
    const minimumX = (bounds.minimumCellX - 0.5) * this.cellSize;
    const maximumX = (bounds.maximumCellX + 0.5) * this.cellSize;
    const minimumZ = (bounds.minimumCellZ - 0.5) * this.cellSize;
    const maximumZ = (bounds.maximumCellZ + 0.5) * this.cellSize;
    const positions: number[] = [];
    for (let x = minimumX; x <= maximumX + 0.0001; x += this.cellSize) positions.push(x, this.y, minimumZ, x, this.y, maximumZ);
    for (let z = minimumZ; z <= maximumZ + 0.0001; z += this.cellSize) positions.push(minimumX, this.y, z, maximumX, this.y, z);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    this.gridLines = new LineSegments(geometry, this.gridMaterial);
    this.gridLines.name = 'InfiniteEditorGrid';
    this.gridLines.visible = this.gridVisible;
    this.gridLines.frustumCulled = false;
    this.add(this.gridLines);
  }

  private rebuildAxes(axisLength: number): void {
    this.disposeMesh(this.xAxis);
    this.disposeMesh(this.yAxis);
    this.disposeMesh(this.zAxis);
    this.xAxis = createAxisMesh('x', axisLength, this.axisThickness, this.y, this.xAxisMaterial);
    this.yAxis = createAxisMesh('y', axisLength, this.axisThickness, this.y, this.yAxisMaterial);
    this.zAxis = createAxisMesh('z', axisLength, this.axisThickness, this.y, this.zAxisMaterial);
    this.xAxis.visible = this.axesVisible;
    this.yAxis.visible = this.axesVisible;
    this.zAxis.visible = this.axesVisible;
    this.add(this.xAxis, this.yAxis, this.zAxis);
  }

  private disposeLine(line: LineSegments | null): void {
    if (!line) return;
    line.geometry.dispose();
    line.removeFromParent();
  }

  private disposeMesh(mesh: Mesh | null): void {
    if (!mesh) return;
    mesh.geometry.dispose();
    mesh.removeFromParent();
  }
}

function createAxisMesh(axis: 'x' | 'y' | 'z', axisLength: number, thickness: number, y: number, material: MeshBasicMaterial): Mesh {
  const span = axisLength * 2;
  const geometry = axis === 'x'
    ? new BoxGeometry(span, thickness, thickness)
    : axis === 'y'
      ? new BoxGeometry(thickness, span, thickness)
      : new BoxGeometry(thickness, thickness, span);
  const mesh = new Mesh(geometry, material);
  mesh.name = `${axis.toUpperCase()}AxisGuide`;
  const groundAxisY = y + thickness * 0.5 + 0.006;
  if (axis === 'y') mesh.position.set(0, 0, 0);
  else mesh.position.set(0, groundAxisY, 0);
  mesh.renderOrder = 1;
  return mesh;
}

function createAxisMaterial(color: ColorRepresentation, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
}

function worldCoordinateToCell(coordinate: number, cellSize: number): number {
  return Math.floor(coordinate / cellSize + 0.5);
}

function ceilToCellSize(value: number, cellSize: number): number {
  return Math.ceil(value / cellSize) * cellSize;
}

function areSameBounds(left: GridBounds | null, right: GridBounds): boolean {
  return left !== null
    && left.minimumCellX === right.minimumCellX
    && left.maximumCellX === right.maximumCellX
    && left.minimumCellZ === right.minimumCellZ
    && left.maximumCellZ === right.maximumCellZ
    && left.axisLength === right.axisLength;
}
