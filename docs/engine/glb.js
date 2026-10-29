// glb.js — write the wrapped model out as one .glb.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export const VERSION = '3.0.0';

// opts: { animations, normalize, maxTextureSize, meta }
// normalize: longest side 1 m, sitting on y = 0, centred. Outputs otherwise keep the
// source's own size and units, which is right for a kit and wrong for a gallery
// plinth that seats things by their bounding box.
export async function exportGLB(root, opts = {}) {
  const parent = root.parent;
  const holder = new THREE.Group();
  holder.name = 'MTexture';
  holder.userData.mtexture = { version: VERSION, ...(opts.meta || {}) };
  holder.add(root);
  if (opts.normalize) {
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (!box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const k = 1 / Math.max(size.x, size.y, size.z, 1e-9);
      holder.scale.setScalar(k);
      holder.position.set(-c.x * k, -box.min.y * k, -c.z * k);
    }
  }
  const exporter = new GLTFExporter();
  const base = { binary: true, maxTextureSize: opts.maxTextureSize || Infinity };
  try {
    try {
      return await exporter.parseAsync(holder, { ...base, animations: opts.animations || [] });
    } catch (err) {
      // some FBX clips do not survive re-export; keep the model, drop the clips
      if (opts.animations && opts.animations.length) return await exporter.parseAsync(holder, base);
      throw err;
    }
  } finally {
    holder.remove(root);
    if (parent) parent.add(root);
  }
}

// {model}__wrapped-in__{art}[__treatment].MTexture.glb, as it always was
export function outputStem(modelName, artName, treatment) {
  const clean = x => x.trim().replace(/\.[^.]+$/, '').replace(/[\/\\:*?"<>|]/g, '_');
  const suffix = treatment && treatment !== 'skin' ? `__${treatment}` : '';
  return `${clean(modelName)}__wrapped-in__${clean(artName)}${suffix}`;
}
