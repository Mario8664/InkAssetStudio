import {
  Color,
  HalfFloatType,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  ShaderMaterial,
  ShaderChunk,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';

export const TERRAIN_EDGE_DARKEN_FACTOR = 0.75;
export const TERRAIN_EDGE_MINIMUM_LINEAR = [0.018, 0.021, 0.020] as const;

export class MapReferenceLayer {
  readonly mesh: Mesh;
  private readonly referenceMaterial: MeshLambertMaterial;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly terrainEdgesVisibleUniform = { value: 1 };
  private target: WebGLRenderTarget | null = null;
  private enabled = false;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private samples = 0;

  constructor(private readonly renderer: WebGLRenderer) {
    this.referenceMaterial = new MeshLambertMaterial({ vertexColors: true });
    this.referenceMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.terrainEdgesVisible = this.terrainEdgesVisibleUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec3 terrainBarycentric;
attribute vec3 terrainEdgeMask;
varying vec3 vTerrainBarycentric;
varying vec3 vTerrainEdgeMask;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vTerrainBarycentric = terrainBarycentric;
vTerrainEdgeMask = terrainEdgeMask;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float terrainEdgesVisible;
varying vec3 vTerrainBarycentric;
varying vec3 vTerrainEdgeMask;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
vec3 terrainEdgeCoverage = 1.0 - smoothstep(
  vec3(0.0),
  fwidth(vTerrainBarycentric) * 1.25,
  vTerrainBarycentric
);
float terrainEdge = max(
  max(terrainEdgeCoverage.x * vTerrainEdgeMask.x, terrainEdgeCoverage.y * vTerrainEdgeMask.y),
  terrainEdgeCoverage.z * vTerrainEdgeMask.z
);
// Painting's 0.75 face-relative darkening is retained, with a subtle
// blue-grey floor so even a black tile never receives a pure-black outline.
vec3 terrainEdgeColour = max(
  diffuseColor.rgb * ${TERRAIN_EDGE_DARKEN_FACTOR.toFixed(2)},
  vec3(${TERRAIN_EDGE_MINIMUM_LINEAR.map((value) => value.toFixed(3)).join(', ')})
);
diffuseColor.rgb = mix(diffuseColor.rgb, terrainEdgeColour, terrainEdge * terrainEdgesVisible);`)
        .replace(
          '#include <lights_lambert_pars_fragment>',
          createHalfLambertShaderChunk(),
        );
    };
    this.referenceMaterial.customProgramCacheKey = () => 'ink-studio-map-reference-half-lambert-terrain-edges-v2';
    this.compositeMaterial = new ShaderMaterial({
      uniforms: { mapReferenceTexture: { value: null } },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D mapReferenceTexture; varying vec2 vUv; void main() { vec4 colour = texture2D(mapReferenceTexture, vUv); if (colour.a <= 0.0) discard; gl_FragColor = colour; }',
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.compositeMaterial);
    this.mesh.name = 'MapReferenceLayer';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.visible = false;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.mesh.visible = enabled;
    if (enabled) this.ensureTarget();
    else this.disposeTarget();
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.pixelRatio = Math.max(1, pixelRatio);
    if (this.target) this.target.setSize(this.getPhysicalWidth(), this.getPhysicalHeight());
  }

  setSamples(samples: number): void {
    const nextSamples = Math.max(0, Math.round(samples));
    if (nextSamples === this.samples) return;
    this.samples = nextSamples;
    if (!this.target) return;
    this.disposeTarget();
    if (this.enabled) this.ensureTarget();
  }

  setTerrainEdgesVisible(visible: boolean): void {
    this.terrainEdgesVisibleUniform.value = visible ? 1 : 0;
  }

  render(scene: Scene, camera: Camera, mapRoots: ReadonlySet<Object3D>): void {
    if (!this.enabled || !this.target || mapRoots.size === 0) return;
    const mapObjects = new Set<Object3D>();
    mapRoots.forEach((root) => root.traverse((object) => mapObjects.add(object)));
    const rootVisibility = new Map<Object3D, boolean>();
    mapRoots.forEach((root) => {
      rootVisibility.set(root, root.visible);
      root.visible = true;
    });
    const visibility = new Map<Object3D, boolean>();
    scene.traverse((object) => {
      if (mapObjects.has(object) || !isRenderable(object)) return;
      visibility.set(object, object.visible);
      object.visible = false;
    });
    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    const previousClearColor = this.renderer.getClearColor(new Color());
    const previousClearAlpha = this.renderer.getClearAlpha();
    const previousOverrideMaterial = scene.overrideMaterial;
    try {
      this.renderer.setRenderTarget(this.target);
      this.renderer.autoClear = false;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true, false);
      scene.overrideMaterial = this.referenceMaterial;
      this.renderer.render(scene, camera);
    } finally {
      scene.overrideMaterial = previousOverrideMaterial;
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setClearColor(previousClearColor, previousClearAlpha);
      visibility.forEach((visible, object) => { object.visible = visible; });
      rootVisibility.forEach((visible, root) => { root.visible = visible; });
    }
  }

  dispose(): void {
    this.disposeTarget();
    this.mesh.geometry.dispose();
    this.compositeMaterial.dispose();
    this.referenceMaterial.dispose();
  }

  private ensureTarget(): void {
    if (this.target) return;
    this.target = new WebGLRenderTarget(this.getPhysicalWidth(), this.getPhysicalHeight(), {
      type: HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.samples,
    });
    this.target.texture.name = 'MapReferenceLayer.color';
    this.compositeMaterial.uniforms.mapReferenceTexture!.value = this.target.texture;
  }

  private disposeTarget(): void {
    this.target?.dispose();
    this.target = null;
    this.compositeMaterial.uniforms.mapReferenceTexture!.value = null;
  }

  private getPhysicalWidth(): number { return Math.max(1, Math.round(this.width * this.pixelRatio)); }

  private getPhysicalHeight(): number { return Math.max(1, Math.round(this.height * this.pixelRatio)); }
}

export function createHalfLambertShaderChunk(source = ShaderChunk.lights_lambert_pars_fragment): string {
  return source.replace(
    'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );',
    'float dotNL = saturate( dot( geometryNormal, directLight.direction ) * 0.5 + 0.5 );',
  );
}

function isRenderable(object: Object3D): boolean {
  return (object as Object3D & { isMesh?: boolean }).isMesh === true
    || (object as Object3D & { isLine?: boolean }).isLine === true
    || (object as Object3D & { isPoints?: boolean }).isPoints === true
    || (object as Object3D & { isSprite?: boolean }).isSprite === true;
}
