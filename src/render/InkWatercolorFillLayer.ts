import {
  Color,
  DepthFormat,
  DepthTexture,
  GLSL3,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  WebGLRenderTarget,
  type Material,
  type Texture,
  type WebGLRenderer,
} from 'three';
import {
  INK_FILL_RENDER_LAYER,
  INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY,
} from './InkGroupRenderer';
import type { InkWatercolorFillSettings } from '../domain/workspace/inkAppearance';

/** Editor-only inspection mode for the transient Watercolor Fill capture. */
export type InkWatercolorFillDebugView =
  | 'final'
  | 'shaded-color'
  | 'fill-depth'
  | 'boundary-mask'
  | 'color-edge'
  | 'water-edge'
  | 'noise'
  | 'soft-tail';

const INK_WATERCOLOR_DEBUG_VIEW_INDEX: Readonly<Record<InkWatercolorFillDebugView, number>> = {
  final: 0,
  'shaded-color': 1,
  'fill-depth': 2,
  'boundary-mask': 3,
  'color-edge': 4,
  'water-edge': 5,
  noise: 6,
  'soft-tail': 7,
};

const SOFT_TAIL_LEVEL_COUNT = 3;

/**
 * Studio-owned Watercolor Fill capture and composite passes. Every target is
 * viewport-local and transient: none becomes Ink authoring or Worker data.
 */
export class InkWatercolorFillLayer {
  private readonly fullscreenScene = new Scene();
  private readonly fullscreenCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly seedMaterial = createInkWatercolorSeedMaterial();
  private readonly downsampleMaterial = createInkWatercolorDownsampleMaterial();
  private readonly blurMaterial = createInkWatercolorBlurMaterial();
  private readonly compositeMaterial = createInkWatercolorCompositeMaterial();
  private readonly fullscreenMesh: Mesh;
  private captureTarget: WebGLRenderTarget | null = null;
  private seedTarget: WebGLRenderTarget | null = null;
  private readonly softTailTargets: WebGLRenderTarget[] = [];
  private readonly softTailScratchTargets: WebGLRenderTarget[] = [];
  private fillMeshes: readonly Mesh[] = [];
  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  constructor(private readonly renderer: WebGLRenderer) {
    this.fullscreenMesh = new Mesh(new PlaneGeometry(2, 2), this.compositeMaterial);
    this.fullscreenMesh.name = 'InkWatercolorFillFullscreen';
    this.fullscreenMesh.frustumCulled = false;
    this.fullscreenScene.add(this.fullscreenMesh);
  }

  /** Updated only when Ink render resources change, never by camera movement. */
  setFillMeshes(fillMeshes: readonly Mesh[]): void {
    for (const mesh of fillMeshes) {
      if (!mesh.userData[INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY]) {
        throw new Error(`Ink Fill ${mesh.uuid} has no Watercolor capture material.`);
      }
    }
    this.fillMeshes = [...fillMeshes];
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.pixelRatio = Math.max(1, pixelRatio);
    this.captureTarget?.setSize(this.getPhysicalWidth(), this.getPhysicalHeight());
    this.seedTarget?.setSize(this.getPhysicalWidth(), this.getPhysicalHeight());
    for (let level = 0; level < SOFT_TAIL_LEVEL_COUNT; level += 1) {
      const levelWidth = this.getSoftTailWidth(level);
      const levelHeight = this.getSoftTailHeight(level);
      this.softTailTargets[level]?.setSize(levelWidth, levelHeight);
      this.softTailScratchTargets[level]?.setSize(levelWidth, levelHeight);
    }
    this.seedMaterial.uniforms.inkWatercolorTextureSize!.value.set(
      this.getPhysicalWidth(),
      this.getPhysicalHeight(),
    );
    this.seedMaterial.uniforms.inkWatercolorPixelRatio!.value = this.pixelRatio;
    this.blurMaterial.uniforms.inkWatercolorFilterStep!.value = this.pixelRatio;
    this.downsampleMaterial.uniforms.inkWatercolorDepthTextureSize!.value.set(
      this.getPhysicalWidth(),
      this.getPhysicalHeight(),
    );
    this.blurMaterial.uniforms.inkWatercolorDepthTextureSize!.value.set(
      this.getPhysicalWidth(),
      this.getPhysicalHeight(),
    );
  }

  /** Changes pass uniforms only; targets and Fill meshes stay intact. */
  setSettings(settings: Readonly<InkWatercolorFillSettings>): void {
    const { waterEdge, diffusion } = settings;
    this.seedMaterial.uniforms.inkWatercolorWaterEdgeEnabled!.value = waterEdge.enabled ? 1 : 0;
    this.seedMaterial.uniforms.inkWatercolorWaterEdgeWidth!.value = waterEdge.width;
    this.seedMaterial.uniforms.inkWatercolorWaterEdgeContrastThreshold!.value = waterEdge.contrastThreshold;
    this.seedMaterial.uniforms.inkWatercolorWaterEdgeOffsetStrength!.value = waterEdge.enabled
      ? waterEdge.offsetStrength
      : 0;
    this.compositeMaterial.uniforms.inkWatercolorWaterEdgeEnabled!.value = waterEdge.enabled ? 1 : 0;
    this.compositeMaterial.uniforms.inkWatercolorWaterEdgeDarkening!.value = waterEdge.edgeDarkening;
    this.compositeMaterial.uniforms.inkWatercolorWaterEdgeOffsetStrength!.value = waterEdge.enabled
      ? waterEdge.offsetStrength
      : 0;
    for (const material of [this.downsampleMaterial, this.blurMaterial]) {
      material.uniforms.inkWatercolorWaterEdgeOffsetStrength!.value = waterEdge.enabled
        ? waterEdge.offsetStrength
        : 0;
      material.uniforms.inkWatercolorWaterEdgeContrastThreshold!.value = waterEdge.contrastThreshold;
    }
    this.compositeMaterial.uniforms.inkWatercolorDiffusionEnabled!.value = diffusion.enabled ? 1 : 0;
    this.compositeMaterial.uniforms.inkWatercolorSoftTailRadius!.value = diffusion.softTailRadius;
    this.compositeMaterial.uniforms.inkWatercolorColorMixRadius!.value = diffusion.colorMixRadius;
    this.compositeMaterial.uniforms.inkWatercolorColorMixStrength!.value = diffusion.colorMixStrength;
    this.compositeMaterial.uniforms.inkWatercolorWaterEdgeContrastThreshold!.value = waterEdge.contrastThreshold;
    this.compositeMaterial.uniforms.inkWatercolorInteriorPigmentStrength!.value = diffusion.interiorPigmentStrength;
    this.compositeMaterial.uniforms.inkWatercolorInteriorFadeColor!.value.set(diffusion.interiorFadeColor);
  }

  /** Debug views are transient viewport state and do not change scene content. */
  setDebugView(view: InkWatercolorFillDebugView): void {
    this.compositeMaterial.uniforms.inkWatercolorDebugView!.value = INK_WATERCOLOR_DEBUG_VIEW_INDEX[view];
  }

  /**
   * Captures visible Fill colour/depth, restores exact alpha-clipped Fill depth
   * in the final target, then builds the hard Seed and depth-aware Soft Tail.
   */
  render(
    scene: Scene,
    camera: PerspectiveCamera | OrthographicCamera,
    finalTarget: WebGLRenderTarget | null,
  ): void {
    if (this.fillMeshes.length === 0) return;
    this.ensureTargets();
    const captureTarget = this.captureTarget;
    const seedTarget = this.seedTarget;
    if (!captureTarget || !seedTarget) return;

    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    const previousClearColor = this.renderer.getClearColor(new Color());
    const previousClearAlpha = this.renderer.getClearAlpha();
    const previousBackground = scene.background;
    const previousCameraLayers = camera.layers.mask;
    const captureStates = new Map<Mesh, Material | Material[]>();
    try {
      for (const mesh of this.fillMeshes) {
        const captureMaterial = mesh.userData[INK_WATERCOLOR_FILL_CAPTURE_MATERIAL_KEY] as Material | undefined;
        if (!captureMaterial) continue;
        captureStates.set(mesh, mesh.material);
        mesh.material = captureMaterial;
      }

      this.renderer.autoClear = false;
      this.renderer.setRenderTarget(captureTarget);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true, false);
      scene.background = null;
      camera.layers.set(INK_FILL_RENDER_LAYER);
      this.renderer.render(scene, camera);

      captureStates.forEach((material, mesh) => { mesh.material = material; });
      captureStates.clear();

      // Replay Fill depth before compositing so later Ribbon rendering keeps
      // the exact hardware/MSAA depth coverage.
      this.renderDepthOnly(scene, camera, finalTarget);

      this.updateCameraUniforms(camera);
      this.renderFullscreen(this.seedMaterial, seedTarget);
      this.renderSoftTailPyramid(seedTarget.texture);

      this.fullscreenMesh.material = this.compositeMaterial;
      this.renderer.setRenderTarget(finalTarget);
      this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
    } finally {
      captureStates.forEach((material, mesh) => { mesh.material = material; });
      this.fullscreenMesh.material = this.compositeMaterial;
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setClearColor(previousClearColor, previousClearAlpha);
      scene.background = previousBackground;
      camera.layers.mask = previousCameraLayers;
    }
  }

  /** Replays visible Watercolor Fill depth without changing the target colour. */
  renderDepthOnly(
    scene: Scene,
    camera: PerspectiveCamera | OrthographicCamera,
    target: WebGLRenderTarget | null,
  ): void {
    if (this.fillMeshes.length === 0) return;
    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    const previousBackground = scene.background;
    const previousCameraLayers = camera.layers.mask;
    const colorWrites = new Map<Material, boolean>();
    try {
      for (const mesh of this.fillMeshes) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          colorWrites.set(material, material.colorWrite);
          material.colorWrite = false;
        }
      }
      this.renderer.autoClear = false;
      this.renderer.setRenderTarget(target);
      scene.background = null;
      camera.layers.set(INK_FILL_RENDER_LAYER);
      this.renderer.render(scene, camera);
    } finally {
      colorWrites.forEach((colorWrite, material) => { material.colorWrite = colorWrite; });
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      scene.background = previousBackground;
      camera.layers.mask = previousCameraLayers;
    }
  }

  dispose(): void {
    this.captureTarget?.dispose();
    this.captureTarget = null;
    this.seedTarget?.dispose();
    this.seedTarget = null;
    this.softTailTargets.forEach((target) => { target.dispose(); });
    this.softTailScratchTargets.forEach((target) => { target.dispose(); });
    this.softTailTargets.length = 0;
    this.softTailScratchTargets.length = 0;
    this.fillMeshes = [];
    this.fullscreenMesh.removeFromParent();
    this.fullscreenMesh.geometry.dispose();
    this.seedMaterial.dispose();
    this.downsampleMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
  }

  private ensureTargets(): void {
    if (this.captureTarget) return;
    const width = this.getPhysicalWidth();
    const height = this.getPhysicalHeight();
    const depthTexture = new DepthTexture(width, height, UnsignedIntType);
    depthTexture.name = 'InkWatercolorFillLayer.depth';
    depthTexture.format = DepthFormat;
    depthTexture.minFilter = NearestFilter;
    depthTexture.magFilter = NearestFilter;
    depthTexture.generateMipmaps = false;
    this.captureTarget = new WebGLRenderTarget(width, height, {
      count: 2,
      depthBuffer: true,
      depthTexture,
      stencilBuffer: false,
    });
    const shadedColor = this.captureTarget.textures[0] as Texture;
    const noise = this.captureTarget.textures[1] as Texture;
    shadedColor.name = 'InkWatercolorFillLayer.shaded-color';
    noise.name = 'InkWatercolorFillLayer.noise';
    for (const texture of [shadedColor, noise]) {
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.generateMipmaps = false;
    }

    this.seedTarget = createMaskTarget(width, height, 'InkWatercolorFillLayer.water-edge-seed', NearestFilter);
    for (let level = 0; level < SOFT_TAIL_LEVEL_COUNT; level += 1) {
      this.softTailTargets.push(createMaskTarget(
        this.getSoftTailWidth(level),
        this.getSoftTailHeight(level),
        `InkWatercolorFillLayer.soft-tail-${level}`,
        LinearFilter,
      ));
      this.softTailScratchTargets.push(createMaskTarget(
        this.getSoftTailWidth(level),
        this.getSoftTailHeight(level),
        `InkWatercolorFillLayer.soft-tail-scratch-${level}`,
        LinearFilter,
      ));
    }

    this.seedMaterial.uniforms.inkWatercolorShadedColorMap!.value = shadedColor;
    this.seedMaterial.uniforms.inkWatercolorNoiseMap!.value = noise;
    this.seedMaterial.uniforms.inkWatercolorDepthMap!.value = depthTexture;
    this.downsampleMaterial.uniforms.inkWatercolorDepthMap!.value = depthTexture;
    this.blurMaterial.uniforms.inkWatercolorDepthMap!.value = depthTexture;
    this.downsampleMaterial.uniforms.inkWatercolorShadedColorMap!.value = shadedColor;
    this.downsampleMaterial.uniforms.inkWatercolorNoiseMap!.value = noise;
    this.blurMaterial.uniforms.inkWatercolorShadedColorMap!.value = shadedColor;
    this.blurMaterial.uniforms.inkWatercolorNoiseMap!.value = noise;
    this.compositeMaterial.uniforms.inkWatercolorShadedColorMap!.value = shadedColor;
    this.compositeMaterial.uniforms.inkWatercolorNoiseMap!.value = noise;
    this.compositeMaterial.uniforms.inkWatercolorDepthMap!.value = depthTexture;
    this.compositeMaterial.uniforms.inkWatercolorWaterEdgeSeedMap!.value = this.seedTarget.texture;
    for (let level = 0; level < SOFT_TAIL_LEVEL_COUNT; level += 1) {
      this.compositeMaterial.uniforms[`inkWatercolorSoftTailMap${level}`]!.value = this.softTailTargets[level]!.texture;
    }
    this.seedMaterial.uniforms.inkWatercolorTextureSize!.value.set(width, height);
    this.compositeMaterial.uniforms.inkWatercolorTextureSize!.value.set(width, height);
    this.downsampleMaterial.uniforms.inkWatercolorDepthTextureSize!.value.set(width, height);
    this.blurMaterial.uniforms.inkWatercolorDepthTextureSize!.value.set(width, height);
  }

  private updateCameraUniforms(camera: PerspectiveCamera | OrthographicCamera): void {
    const perspective = camera instanceof PerspectiveCamera ? 1 : 0;
    const projectionX = camera.projectionMatrix.elements[0] ?? 1;
    const projectionY = camera.projectionMatrix.elements[5] ?? 1;
    for (const material of [this.seedMaterial, this.downsampleMaterial, this.blurMaterial, this.compositeMaterial]) {
      material.uniforms.inkWatercolorCameraNear!.value = camera.near;
      material.uniforms.inkWatercolorCameraFar!.value = camera.far;
      material.uniforms.inkWatercolorPerspectiveCamera!.value = perspective;
    }
    (this.seedMaterial.uniforms.inkWatercolorProjectionScale!.value as Vector2).set(projectionX, projectionY);
    (this.downsampleMaterial.uniforms.inkWatercolorProjectionScale!.value as Vector2).set(projectionX, projectionY);
    (this.blurMaterial.uniforms.inkWatercolorProjectionScale!.value as Vector2).set(projectionX, projectionY);
    (this.compositeMaterial.uniforms.inkWatercolorProjectionScale!.value as Vector2).set(projectionX, projectionY);
  }

  private renderSoftTailPyramid(seedTexture: Texture): void {
    let sourceTexture = seedTexture;
    let sourceWidth = this.getPhysicalWidth();
    let sourceHeight = this.getPhysicalHeight();
    for (let level = 0; level < SOFT_TAIL_LEVEL_COUNT; level += 1) {
      const target = this.softTailTargets[level];
      const scratch = this.softTailScratchTargets[level];
      if (!target || !scratch) continue;

      this.downsampleMaterial.uniforms.inkWatercolorFilterSourceMap!.value = sourceTexture;
      this.downsampleMaterial.uniforms.inkWatercolorFilterSourceTexel!.value.set(1 / sourceWidth, 1 / sourceHeight);
      this.downsampleMaterial.uniforms.inkWatercolorFilterSourceHasColor!.value = level > 0 ? 1 : 0;
      this.renderFullscreen(this.downsampleMaterial, target);

      const levelWidth = this.getSoftTailWidth(level);
      const levelHeight = this.getSoftTailHeight(level);
      this.blurMaterial.uniforms.inkWatercolorFilterSourceMap!.value = target.texture;
      this.blurMaterial.uniforms.inkWatercolorFilterSourceTexel!.value.set(1 / levelWidth, 1 / levelHeight);
      this.blurMaterial.uniforms.inkWatercolorFilterSourceHasColor!.value = 1;
      this.blurMaterial.uniforms.inkWatercolorFilterDirection!.value.set(1, 0);
      this.renderFullscreen(this.blurMaterial, scratch);

      this.blurMaterial.uniforms.inkWatercolorFilterSourceMap!.value = scratch.texture;
      this.blurMaterial.uniforms.inkWatercolorFilterDirection!.value.set(0, 1);
      this.renderFullscreen(this.blurMaterial, target);

      sourceTexture = target.texture;
      sourceWidth = levelWidth;
      sourceHeight = levelHeight;
    }
  }

  private renderFullscreen(material: ShaderMaterial, target: WebGLRenderTarget): void {
    this.fullscreenMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
  }

  private getPhysicalWidth(): number { return Math.max(1, Math.round(this.width * this.pixelRatio)); }

  private getPhysicalHeight(): number { return Math.max(1, Math.round(this.height * this.pixelRatio)); }

  private getSoftTailWidth(level: number): number {
    return Math.max(1, Math.round(this.getPhysicalWidth() / (2 ** (level + 1))));
  }

  private getSoftTailHeight(level: number): number {
    return Math.max(1, Math.round(this.getPhysicalHeight() / (2 ** (level + 1))));
  }
}

function createMaskTarget(
  width: number,
  height: number,
  name: string,
  filter: typeof NearestFilter | typeof LinearFilter,
): WebGLRenderTarget {
  const target = new WebGLRenderTarget(width, height, { depthBuffer: false, stencilBuffer: false });
  target.texture.name = name;
  target.texture.minFilter = filter;
  target.texture.magFilter = filter;
  target.texture.generateMipmaps = false;
  return target;
}

function createFullscreenMaterial(
  fragmentShader: string,
  uniforms: ShaderMaterial['uniforms'],
  transparent = false,
): ShaderMaterial {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms,
    depthTest: false,
    depthWrite: false,
    transparent,
    toneMapped: false,
    vertexShader: `
out vec2 vInkWatercolorUv;
void main() {
  vInkWatercolorUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`,
    fragmentShader,
  });
}

function createInkWatercolorSeedMaterial(): ShaderMaterial {
  return createFullscreenMaterial(`
uniform sampler2D inkWatercolorShadedColorMap;
uniform sampler2D inkWatercolorNoiseMap;
uniform sampler2D inkWatercolorDepthMap;
uniform vec2 inkWatercolorTextureSize;
uniform float inkWatercolorPixelRatio;
uniform float inkWatercolorCameraNear;
uniform float inkWatercolorCameraFar;
uniform float inkWatercolorPerspectiveCamera;
uniform vec2 inkWatercolorProjectionScale;
uniform float inkWatercolorWaterEdgeEnabled;
uniform float inkWatercolorWaterEdgeWidth;
uniform float inkWatercolorWaterEdgeContrastThreshold;
uniform float inkWatercolorWaterEdgeOffsetStrength;
in vec2 vInkWatercolorUv;
layout(location = 0) out vec4 inkWatercolorSeedOutput;

float getInkWatercolorViewZ(float depth) {
  if (inkWatercolorPerspectiveCamera > 0.5) {
    return (inkWatercolorCameraNear * inkWatercolorCameraFar)
      / ((inkWatercolorCameraFar - inkWatercolorCameraNear) * depth - inkWatercolorCameraFar);
  }
  return depth * (inkWatercolorCameraNear - inkWatercolorCameraFar) - inkWatercolorCameraNear;
}

bool isInkWatercolorOffsetSourceCovered(vec2 sourceUv) {
  return texture(inkWatercolorShadedColorMap, sourceUv).a >= 0.5;
}

vec2 getInkWatercolorScreenUvPerWorldUnit(float viewZ) {
  float perspectiveScale = inkWatercolorPerspectiveCamera > 0.5
    ? 1.0 / max(abs(viewZ), 0.0001)
    : 1.0;
  return inkWatercolorProjectionScale * (0.5 * perspectiveScale);
}

vec2 getInkWatercolorWarpUv(vec2 destinationUv, float destinationViewZ, vec2 texel) {
  vec2 noise = texture(inkWatercolorNoiseMap, destinationUv).rg;
  vec2 offset = (noise * 2.0 - 1.0)
    * inkWatercolorWaterEdgeOffsetStrength
    * getInkWatercolorScreenUvPerWorldUnit(destinationViewZ);
  return clamp(destinationUv + offset, texel * 0.5, vec2(1.0) - texel * 0.5);
}

void main() {
  vec2 texel = 1.0 / inkWatercolorTextureSize;
  vec2 effectTexel = texel * inkWatercolorPixelRatio;
  float centerDepth = texture(inkWatercolorDepthMap, vInkWatercolorUv).r;
  if (centerDepth >= 0.999999) discard;
  float centerViewZ = getInkWatercolorViewZ(centerDepth);
  vec2 centerWarpUv = getInkWatercolorWarpUv(vInkWatercolorUv, centerViewZ, texel);
  bool centerWarpValid = isInkWatercolorOffsetSourceCovered(centerWarpUv);
  vec2 centerColorUv = centerWarpValid ? centerWarpUv : vInkWatercolorUv;
  vec3 centerShadedColor = texture(inkWatercolorShadedColorMap, centerColorUv).rgb;
  float boundaryMask = 0.0;
  float colorEdgeMask = 0.0;
  if (inkWatercolorWaterEdgeWidth > 0.0001) {
    const vec2 edgeDirections[8] = vec2[8](
      vec2(-1.0, 0.0), vec2(1.0, 0.0), vec2(0.0, -1.0), vec2(0.0, 1.0),
      vec2(-0.70710678, -0.70710678), vec2(0.70710678, -0.70710678),
      vec2(-0.70710678, 0.70710678), vec2(0.70710678, 0.70710678)
    );
    const float edgeScales[4] = float[4](0.125, 0.375, 0.625, 0.875);
    for (int directionIndex = 0; directionIndex < 8; directionIndex += 1) {
      for (int scaleIndex = 0; scaleIndex < 4; scaleIndex += 1) {
        float edgeWeight = 1.0 - edgeScales[scaleIndex];
        vec2 edgeUv = clamp(
          vInkWatercolorUv + edgeDirections[directionIndex]
            * effectTexel * inkWatercolorWaterEdgeWidth * edgeScales[scaleIndex],
          texel * 0.5,
          vec2(1.0) - texel * 0.5
        );
        float neighbourDepth = texture(inkWatercolorDepthMap, edgeUv).r;
        if (neighbourDepth >= 0.999999) {
          boundaryMask = max(boundaryMask, edgeWeight);
          break;
        }
        if (!isInkWatercolorOffsetSourceCovered(edgeUv)) continue;
        float neighbourViewZ = getInkWatercolorViewZ(neighbourDepth);
        vec2 neighbourWarpUv = getInkWatercolorWarpUv(edgeUv, neighbourViewZ, texel);
        bool neighbourWarpValid = isInkWatercolorOffsetSourceCovered(neighbourWarpUv);
        vec2 neighbourColorUv = neighbourWarpValid ? neighbourWarpUv : edgeUv;
        vec3 neighbourShadedColor = texture(inkWatercolorShadedColorMap, neighbourColorUv).rgb;
        float colourDelta = length(neighbourShadedColor - centerShadedColor);
        float colourContrast = smoothstep(
          inkWatercolorWaterEdgeContrastThreshold,
          inkWatercolorWaterEdgeContrastThreshold + 0.10,
          colourDelta
        );
        colorEdgeMask = max(colorEdgeMask, colourContrast * edgeWeight);
      }
    }
  }
  float waterEdge = inkWatercolorWaterEdgeEnabled > 0.5
    ? max(boundaryMask, colorEdgeMask)
    : 0.0;
  inkWatercolorSeedOutput = vec4(waterEdge, boundaryMask, colorEdgeMask, 1.0);
}`,
  {
    inkWatercolorShadedColorMap: { value: null },
    inkWatercolorNoiseMap: { value: null },
    inkWatercolorDepthMap: { value: null },
    inkWatercolorTextureSize: { value: new Vector2(1, 1) },
    inkWatercolorPixelRatio: { value: 1 },
    inkWatercolorCameraNear: { value: 0.1 },
    inkWatercolorCameraFar: { value: 1000 },
    inkWatercolorPerspectiveCamera: { value: 1 },
    inkWatercolorProjectionScale: { value: new Vector2(1, 1) },
    inkWatercolorWaterEdgeEnabled: { value: 1 },
    inkWatercolorWaterEdgeWidth: { value: 4 },
    inkWatercolorWaterEdgeContrastThreshold: { value: 0.18 },
    inkWatercolorWaterEdgeOffsetStrength: { value: 0.1 },
  });
}

function createInkWatercolorDownsampleMaterial(): ShaderMaterial {
  return createFullscreenMaterial(`${getInkWatercolorDepthFilterShader()}
void main() {
  vec2 texel = inkWatercolorFilterSourceTexel;
  vec2 referenceUv = vInkWatercolorUv;
  float referenceDepth = 1.0;
  float referenceDistance = 1e20;
  bool hasReference = false;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv,
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv + vec2(texel.x, 0.0),
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv - vec2(texel.x, 0.0),
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv + vec2(0.0, texel.y),
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv - vec2(0.0, texel.y),
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (!hasReference) {
    inkWatercolorFilterOutput = vec4(0.0);
    return;
  }
  float centerViewZ = getInkWatercolorFilterViewZ(referenceDepth);
  vec2 depthSlope = getInkWatercolorFilterDepthSlope(referenceUv, centerViewZ);
  vec3 centerGuideColor = getInkWatercolorFilterOriginalColor(referenceUv, centerViewZ);
  float maskValue = 0.0;
  float maskWeight = 0.0;
  vec3 colorSum = vec3(0.0);
  float colorWeight = 0.0;
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv,
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.5,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv + vec2(texel.x, 0.0),
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.125,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv - vec2(texel.x, 0.0),
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.125,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv + vec2(0.0, texel.y),
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.125,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv - vec2(0.0, texel.y),
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.125,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  vec3 diffusedColor = colorWeight > 0.0001 ? colorSum / colorWeight : centerGuideColor;
  inkWatercolorFilterOutput = vec4(maskWeight > 0.0001 ? maskValue / maskWeight : 0.0, diffusedColor);
}`,
  createInkWatercolorFilterUniforms());
}

function createInkWatercolorBlurMaterial(): ShaderMaterial {
  const uniforms = createInkWatercolorFilterUniforms();
  uniforms.inkWatercolorFilterDirection = { value: new Vector2(1, 0) };
  uniforms.inkWatercolorFilterStep = { value: 1 };
  return createFullscreenMaterial(`${getInkWatercolorDepthFilterShader()}
uniform vec2 inkWatercolorFilterDirection;
uniform float inkWatercolorFilterStep;
void main() {
  vec2 stepUv = inkWatercolorFilterDirection * inkWatercolorFilterSourceTexel * inkWatercolorFilterStep;
  vec2 referenceUv = vInkWatercolorUv;
  float referenceDepth = 1.0;
  float referenceDistance = 1e20;
  bool hasReference = false;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv,
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv + stepUv,
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv - stepUv,
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv + stepUv * 2.0,
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (selectInkWatercolorFilterReference(
    vInkWatercolorUv - stepUv * 2.0,
    referenceDistance,
    referenceUv,
    referenceDepth
  )) hasReference = true;
  if (!hasReference) {
    inkWatercolorFilterOutput = vec4(0.0);
    return;
  }
  float centerViewZ = getInkWatercolorFilterViewZ(referenceDepth);
  vec2 depthSlope = getInkWatercolorFilterDepthSlope(referenceUv, centerViewZ);
  vec3 centerGuideColor = getInkWatercolorFilterOriginalColor(referenceUv, centerViewZ);
  float maskValue = 0.0;
  float maskWeight = 0.0;
  vec3 colorSum = vec3(0.0);
  float colorWeight = 0.0;
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv,
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.375,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv + stepUv,
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.25,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv - stepUv,
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.25,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv + stepUv * 2.0,
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.0625,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  accumulateInkWatercolorFilterSample(
    vInkWatercolorUv - stepUv * 2.0,
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    0.0625,
    maskValue,
    maskWeight,
    colorSum,
    colorWeight
  );
  vec3 diffusedColor = colorWeight > 0.0001 ? colorSum / colorWeight : centerGuideColor;
  inkWatercolorFilterOutput = vec4(maskWeight > 0.0001 ? maskValue / maskWeight : 0.0, diffusedColor);
}`,
  uniforms);
}

function createInkWatercolorFilterUniforms(): ShaderMaterial['uniforms'] {
  return {
    inkWatercolorFilterSourceMap: { value: null },
    inkWatercolorShadedColorMap: { value: null },
    inkWatercolorNoiseMap: { value: null },
    inkWatercolorDepthMap: { value: null },
    inkWatercolorFilterSourceTexel: { value: new Vector2(1, 1) },
    inkWatercolorDepthTextureSize: { value: new Vector2(1, 1) },
    inkWatercolorFilterSourceHasColor: { value: 0 },
    inkWatercolorCameraNear: { value: 0.1 },
    inkWatercolorCameraFar: { value: 1000 },
    inkWatercolorPerspectiveCamera: { value: 1 },
    inkWatercolorProjectionScale: { value: new Vector2(1, 1) },
    inkWatercolorWaterEdgeContrastThreshold: { value: 0.18 },
    inkWatercolorWaterEdgeOffsetStrength: { value: 0.1 },
  };
}


function getInkWatercolorDepthFilterShader(): string {
  return `
uniform sampler2D inkWatercolorFilterSourceMap;
uniform sampler2D inkWatercolorShadedColorMap;
uniform sampler2D inkWatercolorNoiseMap;
uniform sampler2D inkWatercolorDepthMap;
uniform vec2 inkWatercolorFilterSourceTexel;
uniform vec2 inkWatercolorDepthTextureSize;
uniform float inkWatercolorFilterSourceHasColor;
uniform float inkWatercolorCameraNear;
uniform float inkWatercolorCameraFar;
uniform float inkWatercolorPerspectiveCamera;
uniform vec2 inkWatercolorProjectionScale;
uniform float inkWatercolorWaterEdgeContrastThreshold;
uniform float inkWatercolorWaterEdgeOffsetStrength;
in vec2 vInkWatercolorUv;
layout(location = 0) out vec4 inkWatercolorFilterOutput;

float getInkWatercolorFilterViewZ(float depth) {
  if (inkWatercolorPerspectiveCamera > 0.5) {
    return (inkWatercolorCameraNear * inkWatercolorCameraFar)
      / ((inkWatercolorCameraFar - inkWatercolorCameraNear) * depth - inkWatercolorCameraFar);
  }
  return depth * (inkWatercolorCameraNear - inkWatercolorCameraFar) - inkWatercolorCameraNear;
}

bool isInkWatercolorFilterOffsetSourceCovered(vec2 sourceUv) {
  return texture(inkWatercolorShadedColorMap, sourceUv).a >= 0.5;
}

float getInkWatercolorFilterDepthDelta(vec2 sampleUv, float centerViewZ) {
  float sampleDepth = texture(inkWatercolorDepthMap, sampleUv).r;
  if (sampleDepth >= 0.999999) return 1e20;
  return abs(getInkWatercolorFilterViewZ(sampleDepth) - centerViewZ);
}

vec2 getInkWatercolorFilterDepthSlope(vec2 centerUv, float centerViewZ) {
  vec2 depthTexel = 1.0 / inkWatercolorDepthTextureSize;
  float slopeX = min(
    getInkWatercolorFilterDepthDelta(centerUv + vec2(depthTexel.x, 0.0), centerViewZ),
    getInkWatercolorFilterDepthDelta(centerUv - vec2(depthTexel.x, 0.0), centerViewZ)
  );
  float slopeY = min(
    getInkWatercolorFilterDepthDelta(centerUv + vec2(0.0, depthTexel.y), centerViewZ),
    getInkWatercolorFilterDepthDelta(centerUv - vec2(0.0, depthTexel.y), centerViewZ)
  );
  return vec2(slopeX >= 1e19 ? 0.0 : slopeX, slopeY >= 1e19 ? 0.0 : slopeY);
}

bool selectInkWatercolorFilterReference(
  vec2 sampleUv,
  inout float referenceDistance,
  inout vec2 referenceUv,
  inout float referenceDepth
) {
  float sampleDepth = texture(inkWatercolorDepthMap, sampleUv).r;
  if (sampleDepth >= 0.999999) return false;
  vec2 sampleDistance = (sampleUv - vInkWatercolorUv) * inkWatercolorDepthTextureSize;
  float distanceSquared = dot(sampleDistance, sampleDistance);
  if (distanceSquared < referenceDistance) {
    referenceDistance = distanceSquared;
    referenceUv = sampleUv;
    referenceDepth = sampleDepth;
  }
  return true;
}

vec2 getInkWatercolorFilterScreenUvPerWorldUnit(float viewZ) {
  float perspectiveScale = inkWatercolorPerspectiveCamera > 0.5
    ? 1.0 / max(abs(viewZ), 0.0001)
    : 1.0;
  return inkWatercolorProjectionScale * (0.5 * perspectiveScale);
}

vec3 getInkWatercolorFilterOriginalColor(
  vec2 destinationUv,
  float destinationViewZ
) {
  vec2 depthTexel = 1.0 / inkWatercolorDepthTextureSize;
  vec2 noise = texture(inkWatercolorNoiseMap, destinationUv).rg;
  vec2 offset = (noise * 2.0 - 1.0)
    * inkWatercolorWaterEdgeOffsetStrength
    * getInkWatercolorFilterScreenUvPerWorldUnit(destinationViewZ);
  vec2 sourceUv = clamp(destinationUv + offset, depthTexel * 0.5, vec2(1.0) - depthTexel * 0.5);
  bool sourceValid = isInkWatercolorFilterOffsetSourceCovered(sourceUv);
  return texture(inkWatercolorShadedColorMap, sourceValid ? sourceUv : destinationUv).rgb;
}

bool getInkWatercolorCompatibleFilterSample(
  vec2 sampleUv,
  vec2 referenceUv,
  float centerViewZ,
  vec2 depthSlope,
  vec3 centerGuideColor,
  out float maskValue,
  out vec3 colorValue,
  out float colorFlow
) {
  float sampleDepth = texture(inkWatercolorDepthMap, sampleUv).r;
  if (sampleDepth >= 0.999999) return false;
  vec2 sampleDistance = abs(sampleUv - referenceUv) * inkWatercolorDepthTextureSize;
  float depthTolerance = max(0.015, abs(centerViewZ) * 0.0025)
    + dot(depthSlope, sampleDistance) * 1.5;
  float sampleViewZ = getInkWatercolorFilterViewZ(sampleDepth);
  if (abs(sampleViewZ - centerViewZ) > depthTolerance) return false;
  vec4 sourceValue = texture(inkWatercolorFilterSourceMap, sampleUv);
  maskValue = sourceValue.r;
  vec2 colorUv = sampleUv;
  float colorViewZ = sampleViewZ;
  colorValue = vec3(0.0);
  vec3 sampleGuideColor = vec3(0.0);
  colorFlow = 0.0;
  if (inkWatercolorFilterSourceHasColor > 0.5) {
    ivec2 sourceSize = textureSize(inkWatercolorFilterSourceMap, 0);
    ivec2 sourceCoord = clamp(
      ivec2(floor(sampleUv * vec2(sourceSize))),
      ivec2(0),
      sourceSize - ivec2(1)
    );
    colorUv = (vec2(sourceCoord) + vec2(0.5)) / vec2(sourceSize);
    float colorDepth = texture(inkWatercolorDepthMap, colorUv).r;
    if (colorDepth >= 0.999999) return true;
    vec2 colorDistance = abs(colorUv - referenceUv) * inkWatercolorDepthTextureSize;
    float colorDepthTolerance = max(0.015, abs(centerViewZ) * 0.0025)
      + dot(depthSlope, colorDistance) * 1.5;
    colorViewZ = getInkWatercolorFilterViewZ(colorDepth);
    if (abs(colorViewZ - centerViewZ) > colorDepthTolerance) return true;
    colorValue = texelFetch(inkWatercolorFilterSourceMap, sourceCoord, 0).gba;
    sampleGuideColor = getInkWatercolorFilterOriginalColor(colorUv, colorViewZ);
  } else {
    colorValue = getInkWatercolorFilterOriginalColor(sampleUv, sampleViewZ);
    sampleGuideColor = colorValue;
  }
  float colorDelta = length(sampleGuideColor - centerGuideColor);
  colorFlow = inkWatercolorWaterEdgeContrastThreshold > 0.0001
    ? 1.0 - smoothstep(
      inkWatercolorWaterEdgeContrastThreshold * 0.5,
      inkWatercolorWaterEdgeContrastThreshold,
      colorDelta
    )
    : 1.0 - step(0.0001, colorDelta);
  return true;
}

void accumulateInkWatercolorFilterSample(
  vec2 sampleUv,
  vec2 referenceUv,
  float centerViewZ,
  vec2 depthSlope,
  vec3 centerGuideColor,
  float kernelWeight,
  inout float maskValue,
  inout float maskWeight,
  inout vec3 colorSum,
  inout float colorWeight
) {
  float sampleMask = 0.0;
  vec3 sampleColor = vec3(0.0);
  float sampleColorFlow = 0.0;
  if (!getInkWatercolorCompatibleFilterSample(
    sampleUv,
    referenceUv,
    centerViewZ,
    depthSlope,
    centerGuideColor,
    sampleMask,
    sampleColor,
    sampleColorFlow
  )) return;
  maskValue += sampleMask * kernelWeight;
  maskWeight += kernelWeight;
  float colorKernelWeight = kernelWeight * sampleColorFlow;
  colorSum += sampleColor * colorKernelWeight;
  colorWeight += colorKernelWeight;
}
`;
}

function createInkWatercolorCompositeMaterial(): ShaderMaterial {
  return createFullscreenMaterial(`
uniform sampler2D inkWatercolorShadedColorMap;
uniform sampler2D inkWatercolorNoiseMap;
uniform sampler2D inkWatercolorDepthMap;
uniform sampler2D inkWatercolorWaterEdgeSeedMap;
uniform sampler2D inkWatercolorSoftTailMap0;
uniform sampler2D inkWatercolorSoftTailMap1;
uniform sampler2D inkWatercolorSoftTailMap2;
uniform vec2 inkWatercolorTextureSize;
uniform float inkWatercolorCameraNear;
uniform float inkWatercolorCameraFar;
uniform float inkWatercolorPerspectiveCamera;
uniform vec2 inkWatercolorProjectionScale;
uniform float inkWatercolorWaterEdgeEnabled;
uniform float inkWatercolorWaterEdgeDarkening;
uniform float inkWatercolorWaterEdgeContrastThreshold;
uniform float inkWatercolorWaterEdgeOffsetStrength;
uniform float inkWatercolorDiffusionEnabled;
uniform float inkWatercolorSoftTailRadius;
uniform float inkWatercolorColorMixRadius;
uniform float inkWatercolorColorMixStrength;
uniform float inkWatercolorInteriorPigmentStrength;
uniform vec3 inkWatercolorInteriorFadeColor;
uniform float inkWatercolorDebugView;
in vec2 vInkWatercolorUv;
layout(location = 0) out vec4 inkWatercolorOutput;

vec4 getInkWatercolorDiffusionSample(float radius) {
  if (radius <= 0.0001) return vec4(0.0);
  float level = clamp(log2(max(radius, 4.0) / 4.0), 0.0, 2.0);
  vec4 sampleValue = vec4(0.0);
  sampleValue += texture(inkWatercolorSoftTailMap0, vInkWatercolorUv) * max(0.0, 1.0 - abs(level - 0.0));
  sampleValue += texture(inkWatercolorSoftTailMap1, vInkWatercolorUv) * max(0.0, 1.0 - abs(level - 1.0));
  sampleValue += texture(inkWatercolorSoftTailMap2, vInkWatercolorUv) * max(0.0, 1.0 - abs(level - 2.0));
  return sampleValue;
}

float getInkWatercolorSoftTail() {
  float tail = getInkWatercolorDiffusionSample(inkWatercolorSoftTailRadius).r;
  return clamp(tail * 2.0 * min(1.0, inkWatercolorSoftTailRadius / 4.0), 0.0, 1.0);
}

float getInkWatercolorViewZ(float depth) {
  if (inkWatercolorPerspectiveCamera > 0.5) {
    return (inkWatercolorCameraNear * inkWatercolorCameraFar)
      / ((inkWatercolorCameraFar - inkWatercolorCameraNear) * depth - inkWatercolorCameraFar);
  }
  return depth * (inkWatercolorCameraNear - inkWatercolorCameraFar) - inkWatercolorCameraNear;
}

bool isInkWatercolorOffsetSourceCovered(vec2 sourceUv) {
  return texture(inkWatercolorShadedColorMap, sourceUv).a >= 0.5;
}

vec2 getInkWatercolorScreenUvPerWorldUnit(float viewZ) {
  float perspectiveScale = inkWatercolorPerspectiveCamera > 0.5
    ? 1.0 / max(abs(viewZ), 0.0001)
    : 1.0;
  return inkWatercolorProjectionScale * (0.5 * perspectiveScale);
}

vec2 getInkWatercolorWarpUv(vec2 destinationUv, float destinationViewZ) {
  vec2 texel = 1.0 / inkWatercolorTextureSize;
  vec2 noise = texture(inkWatercolorNoiseMap, destinationUv).rg;
  vec2 offset = (noise * 2.0 - 1.0)
    * inkWatercolorWaterEdgeOffsetStrength
    * getInkWatercolorScreenUvPerWorldUnit(destinationViewZ);
  return clamp(destinationUv + offset, texel * 0.5, vec2(1.0) - texel * 0.5);
}

vec3 getInkWatercolorWarpSample(
  vec2 destinationUv,
  float destinationViewZ
) {
  vec2 warpUv = getInkWatercolorWarpUv(destinationUv, destinationViewZ);
  bool warpValid = isInkWatercolorOffsetSourceCovered(warpUv);
  return vec3(warpUv, warpValid ? 1.0 : 0.0);
}

vec3 getInkWatercolorWarpedShadedColor(
  vec2 destinationUv,
  float destinationViewZ
) {
  vec3 warpSample = getInkWatercolorWarpSample(destinationUv, destinationViewZ);
  return texture(inkWatercolorShadedColorMap, warpSample.z > 0.5 ? warpSample.xy : destinationUv).rgb;
}

float getInkWatercolorCompositeDepthDelta(vec2 sampleUv, float centerViewZ) {
  float sampleDepth = texture(inkWatercolorDepthMap, sampleUv).r;
  if (sampleDepth >= 0.999999) return 1e20;
  return abs(getInkWatercolorViewZ(sampleDepth) - centerViewZ);
}

vec2 getInkWatercolorCompositeDepthSlope(float centerViewZ) {
  vec2 depthTexel = 1.0 / inkWatercolorTextureSize;
  float slopeX = min(
    getInkWatercolorCompositeDepthDelta(vInkWatercolorUv + vec2(depthTexel.x, 0.0), centerViewZ),
    getInkWatercolorCompositeDepthDelta(vInkWatercolorUv - vec2(depthTexel.x, 0.0), centerViewZ)
  );
  float slopeY = min(
    getInkWatercolorCompositeDepthDelta(vInkWatercolorUv + vec2(0.0, depthTexel.y), centerViewZ),
    getInkWatercolorCompositeDepthDelta(vInkWatercolorUv - vec2(0.0, depthTexel.y), centerViewZ)
  );
  return vec2(slopeX >= 1e19 ? 0.0 : slopeX, slopeY >= 1e19 ? 0.0 : slopeY);
}

float getInkWatercolorColorFlow(vec3 centerGuideColor, vec3 sampleGuideColor) {
  float colorDelta = length(sampleGuideColor - centerGuideColor);
  return inkWatercolorWaterEdgeContrastThreshold > 0.0001
    ? 1.0 - smoothstep(
      inkWatercolorWaterEdgeContrastThreshold * 0.5,
      inkWatercolorWaterEdgeContrastThreshold,
      colorDelta
    )
    : 1.0 - step(0.0001, colorDelta);
}

void accumulateInkWatercolorCompositeColor(
  sampler2D colorMap,
  ivec2 sampleCoord,
  ivec2 colorMapSize,
  float bilinearWeight,
  float centerViewZ,
  vec2 depthSlope,
  vec3 centerGuideColor,
  inout vec3 colorSum,
  inout float colorWeight
) {
  vec2 sampleUv = (vec2(sampleCoord) + vec2(0.5)) / vec2(colorMapSize);
  float sampleDepth = texture(inkWatercolorDepthMap, sampleUv).r;
  if (sampleDepth >= 0.999999) return;
  vec2 sampleDistance = abs(sampleUv - vInkWatercolorUv) * inkWatercolorTextureSize;
  float depthTolerance = max(0.015, abs(centerViewZ) * 0.0025)
    + dot(depthSlope, sampleDistance) * 1.5;
  float sampleViewZ = getInkWatercolorViewZ(sampleDepth);
  if (abs(sampleViewZ - centerViewZ) > depthTolerance) return;
  vec3 sampleGuideColor = getInkWatercolorWarpedShadedColor(sampleUv, sampleViewZ);
  float sampleWeight = bilinearWeight * getInkWatercolorColorFlow(centerGuideColor, sampleGuideColor);
  colorSum += texelFetch(colorMap, sampleCoord, 0).gba * sampleWeight;
  colorWeight += sampleWeight;
}

vec3 sampleInkWatercolorDiffusionColorMap(
  sampler2D colorMap,
  float centerViewZ,
  vec2 depthSlope,
  vec3 centerGuideColor
) {
  ivec2 colorMapSize = textureSize(colorMap, 0);
  vec2 samplePosition = vInkWatercolorUv * vec2(colorMapSize) - vec2(0.5);
  ivec2 baseCoord = ivec2(floor(samplePosition));
  vec2 blend = fract(samplePosition);
  ivec2 maxCoord = colorMapSize - ivec2(1);
  ivec2 coord00 = clamp(baseCoord, ivec2(0), maxCoord);
  ivec2 coord10 = clamp(baseCoord + ivec2(1, 0), ivec2(0), maxCoord);
  ivec2 coord01 = clamp(baseCoord + ivec2(0, 1), ivec2(0), maxCoord);
  ivec2 coord11 = clamp(baseCoord + ivec2(1, 1), ivec2(0), maxCoord);
  vec3 colorSum = vec3(0.0);
  float colorWeight = 0.0;
  accumulateInkWatercolorCompositeColor(
    colorMap, coord00, colorMapSize, (1.0 - blend.x) * (1.0 - blend.y),
    centerViewZ, depthSlope, centerGuideColor, colorSum, colorWeight
  );
  accumulateInkWatercolorCompositeColor(
    colorMap, coord10, colorMapSize, blend.x * (1.0 - blend.y),
    centerViewZ, depthSlope, centerGuideColor, colorSum, colorWeight
  );
  accumulateInkWatercolorCompositeColor(
    colorMap, coord01, colorMapSize, (1.0 - blend.x) * blend.y,
    centerViewZ, depthSlope, centerGuideColor, colorSum, colorWeight
  );
  accumulateInkWatercolorCompositeColor(
    colorMap, coord11, colorMapSize, blend.x * blend.y,
    centerViewZ, depthSlope, centerGuideColor, colorSum, colorWeight
  );
  return colorWeight > 0.0001 ? colorSum / colorWeight : centerGuideColor;
}

vec3 getInkWatercolorDiffusionColorLevel(
  int level,
  float centerViewZ,
  vec2 depthSlope,
  vec3 centerGuideColor
) {
  if (level == 0) return sampleInkWatercolorDiffusionColorMap(
    inkWatercolorSoftTailMap0, centerViewZ, depthSlope, centerGuideColor
  );
  if (level == 1) return sampleInkWatercolorDiffusionColorMap(
    inkWatercolorSoftTailMap1, centerViewZ, depthSlope, centerGuideColor
  );
  return sampleInkWatercolorDiffusionColorMap(
    inkWatercolorSoftTailMap2, centerViewZ, depthSlope, centerGuideColor
  );
}

vec3 getInkWatercolorDiffusedColor(float radius, float centerViewZ, vec3 centerGuideColor) {
  if (radius <= 0.0001) return centerGuideColor;
  float level = clamp(log2(max(radius, 4.0) / 4.0), 0.0, 2.0);
  int lowerLevel = int(floor(level));
  int upperLevel = min(lowerLevel + 1, 2);
  vec2 depthSlope = getInkWatercolorCompositeDepthSlope(centerViewZ);
  vec3 lowerColor = getInkWatercolorDiffusionColorLevel(
    lowerLevel, centerViewZ, depthSlope, centerGuideColor
  );
  if (upperLevel == lowerLevel) return lowerColor;
  vec3 upperColor = getInkWatercolorDiffusionColorLevel(
    upperLevel, centerViewZ, depthSlope, centerGuideColor
  );
  return mix(lowerColor, upperColor, fract(level));
}

void main() {
  vec4 centerNoise = texture(inkWatercolorNoiseMap, vInkWatercolorUv);
  float centerDepth = texture(inkWatercolorDepthMap, vInkWatercolorUv).r;
  if (centerDepth >= 0.999999) discard;
  int debugView = int(floor(inkWatercolorDebugView + 0.5));
  if (debugView == 2) {
    inkWatercolorOutput = vec4(vec3(centerDepth), 1.0);
    return;
  }
  if (debugView == 6) {
    inkWatercolorOutput = vec4(centerNoise.rg, 0.0, 1.0);
    return;
  }
  float centerViewZ = getInkWatercolorViewZ(centerDepth);
  vec3 centerShadedColor = getInkWatercolorWarpedShadedColor(vInkWatercolorUv, centerViewZ);
  vec3 seedMasks = texture(inkWatercolorWaterEdgeSeedMap, vInkWatercolorUv).rgb;
  float waterEdgeSeed = seedMasks.r;
  float softTail = getInkWatercolorSoftTail();
  if (debugView == 1) {
    inkWatercolorOutput = vec4(centerShadedColor, 1.0);
    return;
  }
  if (debugView == 3) {
    inkWatercolorOutput = vec4(vec3(seedMasks.g), 1.0);
    return;
  }
  if (debugView == 4) {
    inkWatercolorOutput = vec4(vec3(seedMasks.b), 1.0);
    return;
  }
  if (debugView == 5) {
    inkWatercolorOutput = vec4(vec3(waterEdgeSeed), 1.0);
    return;
  }
  if (debugView == 7) {
    inkWatercolorOutput = vec4(vec3(sqrt(softTail)), 1.0);
    return;
  }
  float waterEdgeEnabled = step(0.5, inkWatercolorWaterEdgeEnabled);
  float diffusionEnabled = step(0.5, inkWatercolorDiffusionEnabled);
  float diffusionSource = waterEdgeEnabled * diffusionEnabled;
  // B stores local brush wetness from the capture attachment. Dry Fill must
  // retain its original pigment instead of receiving a global paper-white wash.
  float localWetness = clamp(centerNoise.b, 0.0, 1.0);
  float localDiffusion = max(waterEdgeSeed, softTail) * diffusionSource * localWetness;
  float pigmentStrength = mix(1.0, inkWatercolorInteriorPigmentStrength, localDiffusion);
  vec3 diffusedShadedColor = getInkWatercolorDiffusedColor(
    inkWatercolorColorMixRadius,
    centerViewZ,
    centerShadedColor
  );
  float colorMixRadiusEnabled = step(0.0001, inkWatercolorColorMixRadius);
  float waterEdgeMixProtection = 1.0 - step(0.0001, waterEdgeSeed);
  float colorMixWeight = diffusionSource
    * colorMixRadiusEnabled
    * inkWatercolorColorMixStrength
    * waterEdgeMixProtection;
  vec3 mixedShadedColor = mix(centerShadedColor, diffusedShadedColor, colorMixWeight);
  float pigmentLoad = 1.0 + 2.0 * waterEdgeSeed * inkWatercolorWaterEdgeDarkening * waterEdgeEnabled;
  vec3 depositedPigment = pow(max(mixedShadedColor, vec3(0.0001)), vec3(pigmentLoad));
  vec3 tintedPigment = depositedPigment * inkWatercolorInteriorFadeColor;
  vec3 diffusedPigment = mix(centerShadedColor, tintedPigment, pigmentStrength);
  inkWatercolorOutput = vec4(diffusedPigment, 1.0);
}`,
  {
    inkWatercolorShadedColorMap: { value: null },
    inkWatercolorNoiseMap: { value: null },
    inkWatercolorDepthMap: { value: null },
    inkWatercolorWaterEdgeSeedMap: { value: null },
    inkWatercolorSoftTailMap0: { value: null },
    inkWatercolorSoftTailMap1: { value: null },
    inkWatercolorSoftTailMap2: { value: null },
    inkWatercolorTextureSize: { value: new Vector2(1, 1) },
    inkWatercolorCameraNear: { value: 0.1 },
    inkWatercolorCameraFar: { value: 1000 },
    inkWatercolorPerspectiveCamera: { value: 1 },
    inkWatercolorProjectionScale: { value: new Vector2(1, 1) },
    inkWatercolorWaterEdgeEnabled: { value: 1 },
    inkWatercolorWaterEdgeDarkening: { value: 0.28 },
    inkWatercolorWaterEdgeContrastThreshold: { value: 0.18 },
    inkWatercolorWaterEdgeOffsetStrength: { value: 0.1 },
    inkWatercolorDiffusionEnabled: { value: 1 },
    inkWatercolorSoftTailRadius: { value: 16 },
    inkWatercolorColorMixRadius: { value: 12 },
    inkWatercolorColorMixStrength: { value: 0.15 },
    inkWatercolorInteriorPigmentStrength: { value: 0.45 },
    inkWatercolorInteriorFadeColor: { value: new Color('#ffffff') },
    inkWatercolorDebugView: { value: 0 },
  });
}
