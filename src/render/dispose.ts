import { Material, Mesh, Object3D, Texture } from 'three';

export function disposeObjectTree(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(disposeMaterial);
    const backFaceDepth = object.userData.inkHardShadowBackFaceDepthMaterial;
    if (backFaceDepth instanceof Material) backFaceDepth.dispose();
    const frontFaceDepth = object.userData.inkHardShadowFrontFaceDepthMaterial;
    if (frontFaceDepth instanceof Material) frontFaceDepth.dispose();
    const texture = object.userData.inkFillTexture;
    if (texture instanceof Texture) texture.dispose();
    const surfaceOutlineFallback = object.userData.inkSurfaceOutlineEmptyFillAlphaTexture;
    if (surfaceOutlineFallback instanceof Texture) surfaceOutlineFallback.dispose();
  });
  root.clear();
}

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
  material.dispose();
}
