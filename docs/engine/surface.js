// surface.js — what the painted object is made of.
//
// Everything here is a stock MeshPhysicalMaterial so it survives GLTFExporter:
// clearcoat and sheen export as KHR_materials_clearcoat / KHR_materials_sheen,
// which every serious viewer reads. Roughness factors stay at 1 wherever a map
// decides, because three multiplies the factor by the map (the room 183 lesson:
// 0.75 times a dark map reads as plastic).
import * as THREE from 'three';

export const FINISHES = {
  matte:  { roughness: 0.92, metalness: 0 },
  satin:  { roughness: 0.55, metalness: 0.04 },
  gloss:  { roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06 },
  metal:  { roughness: 0.28, metalness: 1 },
  fabric: { roughness: 0.86, metalness: 0, sheen: 1, sheenRoughness: 0.5, sheenColor: 0x5a5a5a },
};

export function resolveFinish(finish, treatment) {
  if (finish && finish !== 'auto') return finish;
  return treatment === 'drape' ? 'fabric' : 'satin';
}

// The original material, flattened to the bits a PBR export can carry.
export function originalSurface(mat) {
  const m = Array.isArray(mat) ? mat[0] : mat;
  if (!m) return null;
  return {
    map: m.map || null,
    color: m.color ? m.color.clone() : null,
    normalMap: m.normalMap || null,
    normalScale: m.normalScale ? m.normalScale.clone() : null,
    roughnessMap: m.roughnessMap || null,
    metalnessMap: m.metalnessMap || null,
    roughness: m.roughness, metalness: m.metalness,
    aoMap: m.aoMap || null, aoMapIntensity: m.aoMapIntensity,
    side: m.side,
  };
}

// opts: { finish, map, normalMap, normalStrength, keep (originalSurface | null), alpha }
export function makeSurface(opts) {
  const f = opts.finish === 'original' ? null : FINISHES[opts.finish] || FINISHES.satin;
  const k = opts.keep;
  const mat = new THREE.MeshPhysicalMaterial({ map: opts.map });
  if (f) {
    mat.roughness = f.roughness;
    mat.metalness = f.metalness;
    if (f.clearcoat) { mat.clearcoat = f.clearcoat; mat.clearcoatRoughness = f.clearcoatRoughness; }
    if (f.sheen) { mat.sheen = f.sheen; mat.sheenRoughness = f.sheenRoughness; mat.sheenColor.set(f.sheenColor); }
  }
  if (k) {
    // the original's own relief and wear, now under the painting
    if (k.normalMap) { mat.normalMap = k.normalMap; if (k.normalScale) mat.normalScale.copy(k.normalScale); }
    if (k.aoMap) { mat.aoMap = k.aoMap; mat.aoMapIntensity = k.aoMapIntensity ?? 1; }
  }
  if (opts.finish === 'original') {
    // the original's factors already pair with its maps, so copy both as they were
    mat.roughness = k?.roughness ?? 0.55;
    mat.metalness = k?.metalness ?? 0.04;
    if (k) { mat.roughnessMap = k.roughnessMap; mat.metalnessMap = k.metalnessMap; }
  }
  if (opts.normalMap) {
    mat.normalMap = opts.normalMap;
    mat.normalScale.set(opts.normalStrength ?? 1, opts.normalStrength ?? 1);
  }
  if (opts.alpha) {
    // glTF has no alphaMap; alpha rides in the base colour and alphaTest exports as MASK
    mat.alphaTest = 0.5;
    mat.side = THREE.DoubleSide;
    mat.transparent = false;
  }
  mat.name = 'MTexture_' + (opts.finish || 'satin');
  return mat;
}

// IMPASTO: the painting's own brushwork, raised. Luminance becomes height and a
// Sobel pass turns it into a tangent space normal map in the same UV layout as the
// colour, so it works for projected and baked textures alike.
export function impastoNormal(src, maxSize = 2048) {
  const scale = Math.min(1, maxSize / Math.max(src.width, src.height));
  const W = Math.max(1, Math.round(src.width * scale)), H = Math.max(1, Math.round(src.height * scale));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // a whisper of blur so the relief follows strokes, not JPEG blocks
  ctx.filter = `blur(${Math.max(0.6, W / 1400)}px)`;
  ctx.drawImage(src, 0, 0, W, H);
  ctx.filter = 'none';
  const d = ctx.getImageData(0, 0, W, H).data;
  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) h[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  const at = (x, y) => h[((y + H) % H) * W + ((x + W) % W)]; // wraps, so tiled art stays seamless
  const out = ctx.createImageData(W, H), o = out.data;
  const k = 2.2 * (W / 1024);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    // image rows run down, tangent space +Y runs up: so +dy (brighter below) tilts toward -Y
    let nx = -dx * k, ny = dy * k, nz = 1;
    const L = Math.hypot(nx, ny, nz);
    const i = (y * W + x) * 4;
    o[i] = (nx / L * 0.5 + 0.5) * 255;
    o[i + 1] = (ny / L * 0.5 + 0.5) * 255;
    o[i + 2] = (nz / L * 0.5 + 0.5) * 255;
    o[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}
