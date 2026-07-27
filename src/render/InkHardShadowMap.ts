import {
  Color,
  DepthFormat,
  DepthTexture,
  LessEqualCompare,
  LinearFilter,
  Mesh,
  UnsignedIntType,
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

type InkShadowTarget = {
  target: WebGLRenderTarget;
  depthTexture: DepthTexture;
};

type InkShadowTargets = {
  frontFace: InkShadowTarget;
  backFace: InkShadowTarget;
};

type ShadowCaptureMaterialKey = 'inkHardShadowFrontFaceDepthMaterial' | 'inkHardShadowBackFaceDepthMaterial';

/**
 * Ink-only paired native depth maps. The BackSide capture is sampled by
 * visible front faces and the FrontSide capture by visible back faces, so a
 * DoubleSide Fill does not compare either visible side with its own depth.
 */
export class InkHardShadowMap {
  private targets: InkShadowTargets | null = null;
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
  ) {}

  markDirty(): void { this.dirty = true; }

  /** Captures both alpha-clipped Ink Fill sides into native depth textures. */
  renderIfNeeded(force = false): void {
    this.lighting.hardShadowRadius.value = this.light.shadow.radius;
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
    this.ensureTargets(width, height);
    const targets = this.targets;
    if (!targets) return;

    const casterStates = new Map<Mesh, ShadowCasterState>();
    const suppressedRenderableStates = new Map<Object3D, boolean>();
    this.scene.traverse((object) => {
      if (object instanceof Mesh) {
        casterStates.set(object, { visible: object.visible, material: object.material });
        return;
      }

      // Suppress non-Mesh renderers so References and editor helpers cannot
      // affect either isolated Ink-only capture.
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
      this.renderer.autoClear = true;
      this.renderer.shadowMap.enabled = false;
      this.scene.background = null;
      this.renderer.setClearColor(0xffffff, 1);
      this.renderCapture(targets.backFace.target, casterStates, 'inkHardShadowBackFaceDepthMaterial', camera);
      this.renderCapture(targets.frontFace.target, casterStates, 'inkHardShadowFrontFaceDepthMaterial', camera);
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
    this.targets?.frontFace.target.dispose();
    this.targets?.backFace.target.dispose();
    this.targets = null;
    this.lighting.hardShadowFrontFaceMap.value = null;
    this.lighting.hardShadowBackFaceMap.value = null;
    this.lighting.hardShadowTexelSize.set(1, 1);
    this.lighting.hardShadowEnabled.value = 0;
  }

  private renderCapture(
    target: WebGLRenderTarget,
    casterStates: Map<Mesh, ShadowCasterState>,
    materialKey: ShadowCaptureMaterialKey,
    camera: DirectionalLight['shadow']['camera'],
  ): void {
    casterStates.forEach((state, mesh) => {
      const material = mesh.userData[materialKey] as Material | undefined;
      mesh.visible = state.visible && material !== undefined;
      if (material) mesh.material = material;
    });
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, camera);
  }

  private ensureTargets(width: number, height: number): void {
    if (this.targets && this.width === width && this.height === height) return;
    this.targets?.frontFace.target.dispose();
    this.targets?.backFace.target.dispose();
    const frontFace = createInkShadowTarget(width, height, 'InkHardShadowMap.front-face');
    const backFace = createInkShadowTarget(width, height, 'InkHardShadowMap.back-face');
    this.targets = { frontFace, backFace };
    this.width = width;
    this.height = height;
    this.lighting.hardShadowFrontFaceMap.value = frontFace.depthTexture as Texture;
    this.lighting.hardShadowBackFaceMap.value = backFace.depthTexture as Texture;
    this.lighting.hardShadowTexelSize.set(1 / width, 1 / height);
  }
}

function createInkShadowTarget(width: number, height: number, name: string): InkShadowTarget {
  const depthTexture = new DepthTexture(width, height, UnsignedIntType);
  depthTexture.name = `${name}.depth`;
  depthTexture.format = DepthFormat;
  depthTexture.compareFunction = LessEqualCompare;
  depthTexture.minFilter = LinearFilter;
  depthTexture.magFilter = LinearFilter;
  depthTexture.generateMipmaps = false;
  const target = new WebGLRenderTarget(width, height, {
    depthBuffer: true,
    depthTexture,
    stencilBuffer: false,
  });
  target.texture.name = `${name}.unused-colour`;
  target.texture.generateMipmaps = false;
  return { target, depthTexture };
}

/** Mesh is handled separately so it can be tested as an approved caster. */
export function hasRendererMaterial(object: Object3D): boolean {
  return 'material' in object;
}
