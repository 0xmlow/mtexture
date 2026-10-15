import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { drape, cords, dissolveGeometry, bakeDissolveTexture } from './wraplab.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Web build: the same engine as the desktop app, with browser file handling.
// Nothing is uploaded — files are read in memory and the result downloads.
const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/';
const extOf = name => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase(); };
const stemOf = name => { const i = name.lastIndexOf('.'); return i < 0 ? name : name.slice(0, i); };

const MODEL_EXTS = new Set(['.glb', '.gltf', '.fbx']);
const ART_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);

// ---------- state ----------
const state = {
  modelName: null,
  artName: null,
  sidecars: new Map(), // filename -> File, for .gltf files that reference a .bin / textures
  lastUrl: null,
  base: null,          // pristine loaded model (never mutated)
  animations: [],
  flipV: false,        // FBX UVs assume flipY=true textures; we convert
  texture: null,
  artCanvas: null,     // kept so the dissolve mask can be baked from the pixels
  dissolveTex: null,
  wrapped: null,       // clone currently in the scene / exported
  mode: 'native',      // projection: how the art maps onto the surface
  treatment: 'skin',   // what happens to the object itself
  tiles: 1,
  amount: 1,
  busy: false,
};

// ---------- three.js viewport ----------
const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0d0d);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
camera.position.set(2, 1.5, 3);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;

const grid = new THREE.GridHelper(10, 20, 0x2962ff, 0x1a2233);
grid.material.transparent = true;
grid.material.opacity = 0.35;
scene.add(grid);
scene.add(new THREE.HemisphereLight(0xf0f4f8, 0x223344, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(3, 5, 4);
scene.add(key);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

function fitCamera(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.7;
  camera.near = maxDim / 200;
  camera.far = maxDim * 50;
  camera.position.copy(center).add(new THREE.Vector3(dist * 0.7, dist * 0.5, dist * 0.85));
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  grid.position.y = box.min.y;
  grid.scale.setScalar(Math.max(maxDim / 5, 0.001));
}

// ---------- UI helpers ----------
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const exportBtn = document.getElementById('exportBtn');
const emptyState = document.getElementById('emptyState');

function setStatus(msg, kind = '') {
  statusEl.className = kind;
  statusText.innerHTML = '';
  statusText.textContent = msg;
}
function setStatusLink(prefix, url, name, suffix = '') {
  statusEl.className = 'ok';
  statusText.innerHTML = '';
  statusText.append(prefix + ' ');
  const a = document.createElement('a');
  a.className = 'path';
  a.href = url;
  a.download = name;
  a.textContent = name;
  a.title = 'download again';
  statusText.appendChild(a);
  if (suffix) statusText.append(' ' + suffix);
}

// ---------- loading ----------
// A .gltf points at its .bin and textures by relative path. In a browser there is no
// folder to look in, so the files dropped alongside it are served from memory instead.
const manager = new THREE.LoadingManager();
const sidecarUrls = new Map();
manager.setURLModifier(url => {
  if (/^(data|blob|https?):/.test(url) && !url.startsWith(location.origin + '/__m/')) return url;
  const name = decodeURIComponent(url.split(/[\/\\]/).pop().split('?')[0]);
  const f = state.sidecars.get(name);
  if (!f) return url;
  if (!sidecarUrls.has(name)) sidecarUrls.set(name, URL.createObjectURL(f));
  return sidecarUrls.get(name);
});

const draco = new DRACOLoader().setDecoderPath(THREE_CDN + 'draco/gltf/');
const ktx2 = new KTX2Loader().setTranscoderPath(THREE_CDN + 'basis/').detectSupport(renderer);
const gltfLoader = new GLTFLoader(manager)
  .setDRACOLoader(draco)
  .setKTX2Loader(ktx2)
  .setMeshoptDecoder(MeshoptDecoder);
const fbxLoader = new FBXLoader(manager);

async function loadModel(file) {
  const ext = extOf(file.name);
  const buf = await file.arrayBuffer();
  const base = location.origin + '/__m/';
  if (ext === '.fbx') {
    const group = fbxLoader.parse(buf, base);
    return { root: group, animations: group.animations || [], flipV: true };
  }
  const gltf = await gltfLoader.parseAsync(ext === '.gltf' ? new TextDecoder().decode(buf) : buf, base);
  return { root: gltf.scene, animations: gltf.animations || [], flipV: false };
}

async function loadArt(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (err) {
    // Safari decodes HEIC natively; other browsers fall back to an <img> or give up
    bmp = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(/\.hei[cf]$/i.test(file.name)
          ? 'this browser cannot read HEIC — use Safari, or export the art as JPG/PNG'
          : 'cannot read that image'));
      };
      img.src = url;
    });
  }
  const MAX = 4096;
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false; // glTF convention; FBX UVs get their V flipped to match
  // GLTFExporter embeds textures as PNG unless told otherwise, which turns a 2048px
  // painting into ~8MB per asset. JPEG at 0.92 costs nothing visible and is ~15x smaller.
  tex.userData.mimeType = 'image/jpeg';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { tex, canvas };
}

// ---------- UV projection ----------
function boxProjectUV(geo) {
  const out = geo.index ? geo.toNonIndexed() : geo;
  out.computeBoundingBox();
  const bb = out.boundingBox;
  const size = new THREE.Vector3().subVectors(bb.max, bb.min);
  size.x = size.x || 1; size.y = size.y || 1; size.z = size.z || 1;
  const pos = out.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let j = 0; j < 3; j++) {
      const v = [a, b, c][j];
      let u, w;
      if (ax >= ay && ax >= az) {
        u = (v.z - bb.min.z) / size.z;
        w = 1 - (v.y - bb.min.y) / size.y;
      } else if (ay >= ax && ay >= az) {
        u = (v.x - bb.min.x) / size.x;
        w = 1 - (v.z - bb.min.z) / size.z;
      } else {
        u = (v.x - bb.min.x) / size.x;
        w = 1 - (v.y - bb.min.y) / size.y;
      }
      uv[(i + j) * 2] = u;
      uv[(i + j) * 2 + 1] = w;
    }
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

function sphereProjectUV(geo) {
  const out = geo.index ? geo.toNonIndexed() : geo;
  out.computeBoundingBox();
  const center = out.boundingBox.getCenter(new THREE.Vector3());
  const pos = out.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).sub(center).normalize();
    uv[i * 2] = 0.5 + Math.atan2(v.z, v.x) / (2 * Math.PI);
    uv[i * 2 + 1] = 0.5 - Math.asin(THREE.MathUtils.clamp(v.y, -1, 1)) / Math.PI;
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

function cylinderProjectUV(geo) {
  // wraps the art around the vertical axis like a label — no seams down the sides,
  // which suits bottles, vases, lanterns, anything turned on a lathe
  const out = geo.index ? geo.toNonIndexed() : geo;
  out.computeBoundingBox();
  const bb = out.boundingBox;
  const c = bb.getCenter(new THREE.Vector3());
  const h = (bb.max.y - bb.min.y) || 1;
  const pos = out.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) - c.x, y = pos.getY(i), z = pos.getZ(i) - c.z;
    let u = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
    uv[i*2] = u;
    uv[i*2+1] = 1 - (y - bb.min.y) / h;
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

function planarProjectUV(geo) {
  // one flat projection down the model's thinnest axis: the whole painting lands
  // once, unbroken, like a poster pressed onto the form
  const out = geo.index ? geo.toNonIndexed() : geo;
  out.computeBoundingBox();
  const bb = out.boundingBox;
  const size = new THREE.Vector3().subVectors(bb.max, bb.min);
  size.x = size.x || 1; size.y = size.y || 1; size.z = size.z || 1;
  const thin = size.z <= size.x && size.z <= size.y ? 'z' : (size.x <= size.y ? 'x' : 'y');
  const pos = out.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const p = { x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) };
    let u, v;
    if (thin === 'z')      { u = (p.x - bb.min.x)/size.x; v = 1 - (p.y - bb.min.y)/size.y; }
    else if (thin === 'x') { u = (p.z - bb.min.z)/size.z; v = 1 - (p.y - bb.min.y)/size.y; }
    else                   { u = (p.x - bb.min.x)/size.x; v = 1 - (p.z - bb.min.z)/size.z; }
    uv[i*2] = u; uv[i*2+1] = v;
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

function scaleUV(geo, tiles) {
  const uv = geo.attributes.uv;
  if (!uv || tiles === 1) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * tiles, uv.getY(i) * tiles);
  uv.needsUpdate = true;
  return geo;
}

function flipVAttr(geo) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  uv.needsUpdate = true;
}

// ---------- wrap ----------
function buildWrapped() {
  const root = SkeletonUtils.clone(state.base);
  const draped = [];
  root.traverse(obj => {
    if (!obj.isMesh) return;
    let geo = obj.geometry.clone();

    // 1 · treatment first — it only moves vertices, and projecting afterwards means
    // the painting describes the FINAL form rather than the shape before draping
    if (state.treatment === 'drape') geo = drape(geo, state.amount);
    else if (state.treatment === 'dissolve') geo = dissolveGeometry(geo, state.amount);

    // 2 · projection — how the painting maps onto that surface
    if (state.mode === 'box') geo = boxProjectUV(geo);
    else if (state.mode === 'sphere') geo = sphereProjectUV(geo);
    else if (state.mode === 'cylinder') geo = cylinderProjectUV(geo);
    else if (state.mode === 'planar') geo = planarProjectUV(geo);
    else {
      if (!geo.attributes.uv) geo = boxProjectUV(geo);
      else if (state.flipV) flipVAttr(geo);
    }

    scaleUV(geo, state.tiles);
    // Projection returns non-indexed geometry — every triangle owns its three
    // vertices, which triples the file. Re-indexing merges the corners that really
    // are identical (same position, uv and normal) and changes nothing visually.
    if (!geo.index) {
      try {
        const before = geo.attributes.position.count;
        const m = mergeVertices(geo, 1e-6);
        if (m.attributes.position.count < before) geo = m;
      } catch (err) { /* keep the unindexed geometry */ }
    }
    obj.geometry = geo;

    // 3 · surface
    const dissolving = state.treatment === 'dissolve';
    const mat = new THREE.MeshStandardMaterial({
      map: dissolving ? state.dissolveTex : state.texture,
      roughness: state.treatment === 'drape' ? 0.62 : 0.55,
      metalness: state.treatment === 'drape' ? 0.02 : 0.08,
    });
    if (dissolving) {
      // glTF has no alphaMap; it reads alpha from the base colour texture, and
      // alphaTest exports cleanly as alphaMode MASK
      mat.alphaTest = 0.5;
      mat.side = THREE.DoubleSide;
      mat.transparent = false;
    }
    mat.name = 'MTexture_wrap';
    obj.material = mat;
    if (state.treatment === 'drape') draped.push(obj);
  });

  // cords go on the largest draped mesh only — one bundle, not one per part
  if (state.treatment === 'drape' && draped.length) {
    let biggest = draped[0], bv = -1;
    for (const o of draped) {
      o.geometry.computeBoundingBox();
      const s = o.geometry.boundingBox.getSize(new THREE.Vector3());
      const v = s.x * s.y * s.z;
      if (v > bv) { bv = v; biggest = o; }
    }
    const cordMat = new THREE.MeshStandardMaterial({ color: 0x2d2b28, roughness: 0.9 });
    cordMat.name = 'MTexture_cord';
    cords(biggest.geometry).forEach((cg, i) => {
      const m = new THREE.Mesh(cg, cordMat);
      m.name = 'MTexture_cord_' + i;
      biggest.add(m);   // child of the mesh, so it inherits the same transform
    });
  }
  return root;
}

function ensureDissolveTexture() {
  if (state.treatment !== 'dissolve' || state.dissolveTex || !state.artCanvas) return;
  const baked = bakeDissolveTexture(state.artCanvas, 0.24);
  const t = new THREE.CanvasTexture(baked);
  t.flipY = false;
  t.userData.mimeType = 'image/png';   // the erosion lives in the alpha channel
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  state.dissolveTex = t;
}

function outputName() {
  const clean = s => s.trim().replace(/[\/\\:*?"<>|]/g, '_');
  const suffix = state.treatment === 'skin' ? '' : `__${state.treatment}`;
  return `${clean(stemOf(state.modelName))}__wrapped-in__${clean(stemOf(state.artName))}${suffix}.MTexture.glb`;
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function exportGLB(root) {
  const exporter = new GLTFExporter();
  const opts = { binary: true, animations: state.animations };
  return new Promise((resolve, reject) => {
    const onDone = ab => resolve(ab);
    exporter.parse(root, onDone, err => {
      if (opts.animations.length) {
        // some FBX clips do not survive re-export; retry without them
        exporter.parse(root, onDone, reject, { binary: true });
      } else reject(err);
    }, opts);
  });
}

// The browser asks before every download, so only a fresh drop (or the button)
// downloads; changing a projection or dial just re-wraps the preview.
async function wrapAndExport(save = false) {
  if (!state.base || !state.texture || state.busy) return;
  state.busy = true;
  exportBtn.disabled = true;
  setStatus('WRAPPING...');
  try {
    await new Promise(r => setTimeout(r, 30)); // let the status paint
    ensureDissolveTexture();
    const root = buildWrapped();
    if (state.wrapped) scene.remove(state.wrapped);
    state.wrapped = root;
    scene.add(root);
    emptyState.style.display = 'none';
    fitCamera(root);

    setStatus('EXPORTING...');
    const ab = await exportGLB(root);
    const name = outputName();
    if (state.lastUrl) URL.revokeObjectURL(state.lastUrl);
    state.lastUrl = URL.createObjectURL(new Blob([ab], { type: 'model/gltf-binary' }));
    const mb = (ab.byteLength / 1e6).toFixed(1) + 'MB';
    if (save) {
      download(state.lastUrl, name);
      setStatusLink('SPAT OUT →', state.lastUrl, name, mb);
    } else {
      setStatusLink('WRAPPED. HIT SPIT IT OUT TO DOWNLOAD →', state.lastUrl, name, mb);
    }
  } catch (err) {
    console.error(err);
    setStatus('FAILED: ' + (err && err.message ? err.message : err), 'err');
  } finally {
    state.busy = false;
    exportBtn.disabled = !(state.base && state.texture);
  }
}

// ---------- intake ----------
async function takeModel(file) {
  setStatus('LOADING MODEL: ' + file.name);
  const { root, animations, flipV } = await loadModel(file);
  state.modelName = file.name;
  state.base = root;
  state.animations = animations;
  state.flipV = flipV;
  const slot = document.getElementById('modelSlot');
  slot.classList.add('filled');
  document.getElementById('modelHint').style.display = 'none';
  document.getElementById('modelName').textContent = file.name;
}

async function takeArt(file) {
  setStatus('LOADING ART: ' + file.name);
  const { tex, canvas } = await loadArt(file);
  if (state.texture) state.texture.dispose();
  if (state.dissolveTex) { state.dissolveTex.dispose(); state.dissolveTex = null; }
  state.artName = file.name;
  state.texture = tex;
  state.artCanvas = canvas;
  const slot = document.getElementById('artSlot');
  slot.classList.add('filled');
  document.getElementById('artHint').style.display = 'none';
  document.getElementById('artName').textContent = file.name;
  const thumb = document.getElementById('artThumb');
  thumb.src = canvas.toDataURL('image/jpeg', 0.8);
  thumb.style.display = 'block';
}

async function intake(files) {
  try {
    const models = files.filter(f => MODEL_EXTS.has(extOf(f.name)));
    // with a model in the drop, every other file is a possible .bin / texture for it;
    // the art is whichever image is not referenced by a .gltf
    if (models.length) {
      state.sidecars = new Map(files.map(f => [f.name, f]));
      for (const u of sidecarUrls.values()) URL.revokeObjectURL(u);
      sidecarUrls.clear();
    }
    let gltfRefs = new Set();
    for (const m of models) {
      if (extOf(m.name) !== '.gltf') continue;
      try {
        const j = JSON.parse(await m.text());
        for (const x of [...(j.buffers || []), ...(j.images || [])])
          if (x.uri && !x.uri.startsWith('data:')) gltfRefs.add(decodeURIComponent(x.uri.split('/').pop()));
      } catch (e) { /* the loader will report it */ }
    }
    for (const f of models) await takeModel(f);
    for (const f of files) {
      const ext = extOf(f.name);
      if (MODEL_EXTS.has(ext) || gltfRefs.has(f.name) || ext === '.bin' || ext === '.ktx2') continue;
      if (ART_EXTS.has(ext)) await takeArt(f);
      else setStatus('IGNORED ' + f.name + ' (unsupported type)', 'err');
    }
    if (state.base && state.texture) {
      await wrapAndExport(true);
    } else if (state.base) {
      setStatus('MODEL LOADED. NOW DROP YOUR ART.');
    } else if (state.texture) {
      setStatus('ART LOADED. NOW DROP A 3D MODEL.');
    }
  } catch (err) {
    console.error(err);
    setStatus('FAILED: ' + (err && err.message ? err.message : err), 'err');
  }
}

// ---------- drag and drop ----------
let dragDepth = 0;
document.addEventListener('dragenter', e => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', e => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  if (files.length) intake(files);
});

for (const [slot, kind] of [['modelSlot', 'model'], ['artSlot', 'art']]) {
  const el = document.getElementById(slot);
  el.addEventListener('dragover', () => el.classList.add('dragover'));
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', () => el.classList.remove('dragover'));
  const pick = document.getElementById(kind + 'Pick');
  el.addEventListener('click', () => pick.click());
  pick.addEventListener('change', () => {
    const files = [...pick.files];
    pick.value = '';
    if (files.length) intake(files);
  });
}

// ---------- controls ----------
const tipEl = document.getElementById('tip');
function advise() {
  if (!tipEl) return;
  let msg = '';
  // box projection picks its axis per triangle from the face normal, so on a dense
  // scan neighbouring triangles land on different axes and the surface breaks into
  // a patchwork of scales. Learned the hard way.
  let dense = 0;
  if (state.base) state.base.traverse(o => { if (o.isMesh) dense += o.geometry.attributes.position.count; });
  if (state.mode === 'box' && dense > 120000)
    msg = 'DENSE MESH + BOX: expect a scaled patchwork. TRY CYLINDER, PLANAR OR NATIVE.';
  else if (state.treatment === 'dissolve' && state.mode === 'box' && dense > 120000)
    msg = 'DISSOLVE READS BEST OVER A CONTINUOUS UV. TRY NATIVE OR CYLINDER.';
  tipEl.textContent = msg;
}

for (const btn of document.querySelectorAll('.modes button[data-mode]')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modes button[data-mode]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    advise();
    if (state.base && state.texture) wrapAndExport();
  });
}
for (const btn of document.querySelectorAll('.modes button[data-treat]')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modes button[data-treat]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.treatment = btn.dataset.treat;
    advise();
    if (state.base && state.texture) wrapAndExport();
  });
}
for (const [id, key] of [['tiles', 'tiles'], ['amount', 'amount']]) {
  const el = document.getElementById(id);
  if (!el) continue;
  const out = document.getElementById(id + 'Val');
  const read = () => {
    const v = id === 'tiles' ? Number(el.value) / 4 : Number(el.value) / 10;
    state[key] = v;
    out.textContent = v.toFixed(1);
  };
  el.addEventListener('input', read);
  el.addEventListener('change', () => { read(); if (state.base && state.texture) wrapAndExport(); });
  read();
}
exportBtn.addEventListener('click', () => wrapAndExport(true));
