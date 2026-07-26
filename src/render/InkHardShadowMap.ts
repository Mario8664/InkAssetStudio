import {
  Color,
  Mesh,
  MeshDepthMaterial,
  NearestFilter,
  RGBADepthPacking,
  UnsignedByteType,
  WebGLRenderTarget,
  type DirectionalLight,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { InkFillLightingState } from './InkGroupRenderer';

type ShadowCasterState = {
  visible: boolean;
  material: Material | Material[];
};

/** Ink-only depth map. It never changes Three's PCF shadow configuration. */
export class InkHardShadowMap {
  private readonly depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  private target: WebGLRenderTarget | null = null;
  private width = 0;
  private height = 0;
  private dirty = true;
  private disabled = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly light: DirectionalLight,
    private readonly lighting: InkFillLightingState,
    private readonly onWarning: (message: string) => void = () => undefined,
    private readonly isApprovedCaster: (mesh: Mesh) => boolean = () => true,
  ) {
    this.depthMaterial.name = 'InkHardShadowDepth';
  }

  markDirty(): void { this.dirty = true; }

  /** Renders only approved Mesh casters into a nearest-sampled Ink-only map. */
  renderIfNeeded(force = false): void {
    if (this.disabled || (!force && !this.dirty)) return;
    this.scene.updateMatrixWorld(true);
    this.light.shadow.updateMatrices(this.light);
    const camera = this.light.shadow.camera;
    const width = Math.max(1, Math.ceil(Math.abs(camera.right - camera.left) * 64));
    const height = Math.max(1, Math.ceil(Math.abs(camera.top - camera.bottom) * 64));
    const maximum = this.renderer.capabilities.maxTextureSize;
    if (width > maximum || height > maximum) {
      this.disabled = true;
      this.lighting.hardShadowEnabled.value = 0;
      const message = `Ink hard shadow requires ${width} × ${height}px at 64 px/world-unit, exceeding this GPU's ${maximum}px texture limit. Move distant content closer together, then reopen the Studio to restore hard shadows.`;
      console.error(message);
      this.onWarning(message);
      return;
    }
    this.ensureTarget(width, height);
    const target = this.target;
    if (!target) return;
    const casterStates = new Map<Mesh, ShadowCasterState>();
    const suppressedRenderableStates = new Map<Object3D, boolean>();
    this.scene.traverse((object) => {
      if (object instanceof Mesh) {
        const inkDepthMaterial = object.userData.inkHardShadowDepthMaterial as Material | undefined;
        const isCaster = this.isApprovedCaster(object) && (object.castShadow || inkDepthMaterial !== undefined);
        casterStates.set(object, { visible: object.visible, material: object.material });
        object.visible = object.visible && isCaster;
        if (inkDepthMaterial) object.material = inkDepthMaterial;
        else if (isCaster) object.material = this.depthMaterial;
        return;
      }

      // Packed depth lives in colour channels, so depthWrite=false does not
      // prevent Line/Points/Sprite helpers from corrupting the sampled map.
      if (hasRendererMaterial(object)) {
        suppressedRenderableStates.set(object, object.visible);
        object.visible = false;
      }
    });
    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    const previousShadowEnabled = this.renderer.shadowMap.enabled;
    const previousClearColor = this.renderer.getClearColor(new Color());
    const previousClearAlpha = this.renderer.getClearAlpha();
    const previousBackground = this.scene.background;
    try {
      this.renderer.setRenderTarget(target);
      this.renderer.autoClear = true;
      this.renderer.shadowMap.enabled = false;
      // RGBA depth's clear value must be exactly 1.0 rather than the scene
      // background colour, which otherwise force-clears the target again from
      // WebGLBackground.render and becomes a false depth occluder.
      this.scene.background = null;
      this.renderer.setClearColor(0xffffff, 1);
      this.renderer.clear(true, true, false);
      this.renderer.render(this.scene, camera);
      this.lighting.hardShadowMatrix.copy(this.light.shadow.matrix);
      this.lighting.hardShadowEnabled.value = 1;
      this.dirty = false;
    } finally {
      this.renderer.shadowMap.enabled = previousShadowEnabled;
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setClearColor(previousClearColor, previousClearAlpha);
      this.scene.background = previousBackground;
      casterStates.forEach((state, mesh) => {
        mesh.visible = state.visible;
        mesh.material = state.material;
      });
      suppressedRenderableStates.forEach((visible, object) => { object.visible = visible; });
    }
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.depthMaterial.dispose();
    this.lighting.hardShadowMap.value = null;
    this.lighting.hardShadowEnabled.value = 0;
  }

  private ensureTarget(width: number, height: number): void {
    if (this.target && this.width === width && this.height === height) return;
    this.target?.dispose();
    this.target = new WebGLRenderTarget(width, height, {
      type: UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.name = 'InkHardShadowMap.depth';
    this.target.texture.minFilter = NearestFilter;
    this.target.texture.magFilter = NearestFilter;
    this.target.texture.generateMipmaps = false;
    this.width = width;
    this.height = height;
    this.lighting.hardShadowMap.value = this.target.texture as Texture;
  }
}

/** Mesh is handled separately so it can be tested as an approved caster. */
export function hasRendererMaterial(object: Object3D): boolean {
  return 'material' in object;
}
