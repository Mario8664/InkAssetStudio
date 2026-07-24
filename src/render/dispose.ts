import { Material, Mesh, Object3D, Texture } from 'three';

export function disposeObjectTree(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(disposeMaterial);
    const depth = object.userData.inkHardShadowDepthMaterial;
    if (depth instanceof Material) depth.dispose();
    const texture = object.userData.inkFillTexture;
    if (texture instanceof Texture) texture.dispose();
  });
  root.clear();
}

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
  material.dispose();
}
