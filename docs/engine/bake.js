// bake.js — paint the projection into the model's OWN UV layout.
//
// Direct projection throws the model's UVs away and splits every triangle. Baking
// keeps them: the mesh is rasterised in UV space on the GPU, each texel takes the
// painting through whatever projection was chosen, and the result is one texture
// in the original layout. The model stays indexed, its normal and roughness maps
// still line up, and triplanar blending (impossible as plain UVs) becomes possible.
//
// The lightmap lessons apply: islands are dilated so mipmaps never pull in the
// black between them, and the sampler stays flipY = false.
import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec2 proj;
#ifdef TRI
  attribute vec2 pX; attribute vec2 pY; attribute vec2 pZ; attribute vec3 tw;
  varying vec2 vX; varying vec2 vY; varying vec2 vZ; varying vec3 vW;
#endif
  varying vec2 vUv; varying vec2 vP;
  void main() {
    vUv = uv; vP = proj;
#ifdef TRI
    vX = pX; vY = pY; vZ = pZ; vW = tw;
#endif
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  }`;

const FRAG = /* glsl */`
  uniform sampler2D art;
  uniform sampler2D orig;
  uniform vec3 origColor;
  uniform float mixAmt;
  varying vec2 vUv; varying vec2 vP;
#ifdef TRI
  varying vec2 vX; varying vec2 vY; varying vec2 vZ; varying vec3 vW;
#endif
  vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  void main() {
#ifdef TRI
    vec3 w = vW / max(vW.x + vW.y + vW.z, 1e-5);
    vec4 a = texture2D(art, vX) * w.x + texture2D(art, vY) * w.y + texture2D(art, vZ) * w.z;
#else
    vec4 a = texture2D(art, vP);
#endif
    vec3 c = a.rgb;
#if defined(ORIG_MAP) || defined(ORIG_COLOR)
  #ifdef ORIG_MAP
    vec3 o = texture2D(orig, vUv).rgb * origColor;
  #else
    vec3 o = origColor;
  #endif
  #if BLEND == 1
    vec3 b = o * c * 1.6;
  #elif BLEND == 2
    vec3 b = mix(2.0 * o * c, 1.0 - 2.0 * (1.0 - o) * (1.0 - c), step(0.5, o));
  #else
    vec3 b = c;
  #endif
    c = mix(o, b, mixAmt);
#endif
    // alpha carries coverage AND the dissolve mask: covered texels sit at 0.5..1,
    // empty ones at 0, so dilation can tell them apart and the mask survives it
    gl_FragColor = vec4(toSRGB(c), 0.5 + 0.5 * a.a);
  }`;

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DILATE = /* glsl */`
  uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
  void main() {
    vec4 c = texture2D(src, vUv);
    if (c.a > 0.0) { gl_FragColor = c; return; }
    vec4 sum = vec4(0.0); float k = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec4 s = texture2D(src, vUv + vec2(float(x), float(y)) * texel);
      if (s.a > 0.0) { sum += s; k += 1.0; }
    }
    gl_FragColor = k > 0.0 ? sum / k : vec4(0.0);
  }`;

const COUNT_FRAG = /* glsl */`void main() { gl_FragColor = vec4(0.125); }`;

const BLEND = { replace: 0, multiply: 1, overlay: 2 };

function makeTarget(size) {
  return new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, generateMipmaps: false,
  });
}

function withTarget(renderer, fn) {
  const prev = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear, prevXr = renderer.xr.enabled;
  renderer.xr.enabled = false;
  try { return fn(); }
  finally {
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.xr.enabled = prevXr;
  }
}

const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// geo: non-indexed, with native 'uv' (glTF orientation) and either 'proj' or the
// triplanar set pX/pY/pZ/tw.
// opts: { size, art (Texture), triplanar, orig: {map, color} | null, blend, mix, alpha }
// returns { canvas, overlap } where overlap is the fraction of covered texels hit
// by more than one triangle (mirrored or stacked UV islands).
export function bakeMesh(renderer, geo, opts) {
  const size = opts.size || 2048;
  const defines = {};
  if (opts.triplanar) defines.TRI = '';
  const o = opts.orig;
  if (o && o.map) defines.ORIG_MAP = '';
  if (o && (o.map || o.color)) {
    defines.ORIG_COLOR = '';
    defines.BLEND = BLEND[opts.blend] ?? 0;
  }
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, defines,
    uniforms: {
      art: { value: opts.art },
      orig: { value: o && o.map ? o.map : null },
      origColor: { value: o && o.color ? o.color.clone() : new THREE.Color(1, 1, 1) },
      mixAmt: { value: opts.mix ?? 1 },
    },
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const dil = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT, fragmentShader: DILATE,
    uniforms: { src: { value: null }, texel: { value: new THREE.Vector2(1 / size, 1 / size) } },
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(quadGeo, dil);
  quad.frustumCulled = false;
  const qscene = new THREE.Scene();
  qscene.add(quad);

  let rtA = makeTarget(size), rtB = makeTarget(size);
  const px = new Uint8Array(size * size * 4);
  let overlap = 0;

  withTarget(renderer, () => {
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rtA);
    renderer.clear();
    renderer.render(scene, cam);

    // dilate: enough passes to bridge mip levels down to about 1/64 of the texture
    const passes = Math.max(4, Math.round(size / 128));
    for (let i = 0; i < passes; i++) {
      dil.uniforms.src.value = rtA.texture;
      renderer.setRenderTarget(rtB);
      renderer.clear();
      renderer.render(qscene, cam);
      [rtA, rtB] = [rtB, rtA];
    }
    renderer.readRenderTargetPixels(rtA, 0, 0, size, size, px);

    // overlap census at low resolution: additive coverage, then count the doubles
    const C = 256, rtC = makeTarget(C), cp = new Uint8Array(C * C * 4);
    const cm = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COUNT_FRAG, defines: opts.triplanar ? { TRI: '' } : {},
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      transparent: true, blending: THREE.AdditiveBlending,
    });
    mesh.material = cm;
    renderer.setRenderTarget(rtC);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rtC, 0, 0, C, C, cp);
    let cov = 0, dbl = 0;
    for (let i = 0; i < C * C; i++) { const v = cp[i * 4]; if (v > 8) { cov++; if (v > 48) dbl++; } }
    overlap = cov ? dbl / cov : 0;
    cm.dispose(); rtC.dispose();
  });

  // readback row 0 is uv.y = 0, which in glTF is the top of the image: no flip
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const a = px[i * 4 + 3];
    d[i * 4] = px[i * 4]; d[i * 4 + 1] = px[i * 4 + 1]; d[i * 4 + 2] = px[i * 4 + 2];
    // decode: 0.5..1 back to the painting's alpha; empty texels stay opaque
    d[i * 4 + 3] = opts.alpha ? (a >= 192 ? 255 : 0) : 255;
  }
  ctx.putImageData(img, 0, 0);

  mat.dispose(); dil.dispose(); quadGeo.dispose(); rtA.dispose(); rtB.dispose();
  return { canvas, overlap };
}
