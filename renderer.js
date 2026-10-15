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

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { pathToFileURL } = require('url');
const { ipcRenderer, webUtils } = require('electron');

const MODEL_EXTS = new Set(['.glb', '.gltf', '.fbx']);
const ART_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);

// ---------- state ----------
const state = {
  modelPath: null,
  artPath: null,
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
  lastOutPath: null,
  lastPairKey: null,
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
function setStatusPath(prefix, outPath) {
  statusEl.className = 'ok';
  statusText.innerHTML = '';
  statusText.append(prefix + ' ');
  const a = document.createElement('span');
  a.className = 'path';
  a.textContent = outPath;
  a.title = 'reveal in Finder';
  a.onclick = () => ipcRenderer.send('reveal', outPath);
  statusText.appendChild(a);
}

// ---------- loading ----------
function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const draco = new DRACOLoader().setDecoderPath('./node_modules/three/examples/jsm/libs/draco/gltf/');
const ktx2 = new KTX2Loader().setTranscoderPath('./node_modules/three/examples/jsm/libs/basis/').detectSupport(renderer);
const gltfLoader = new GLTFLoader()
  .setDRACOLoader(draco)
  .setKTX2Loader(ktx2)
  .setMeshoptDecoder(MeshoptDecoder);
const fbxLoader = new FBXLoader();

async function loadModel(p) {
  const ext = path.extname(p).toLowerCase();
  const buf = fs.readFileSync(p);
  const dirUrl = pathToFileURL(path.dirname(p)).href + '/';
  if (ext === '.fbx') {
    const group = fbxLoader.parse(toArrayBuffer(buf), dirUrl);
    return { root: group, animations: group.animations || [], flipV: true };
  }
  const gltf = await gltfLoader.parseAsync(ext === '.gltf' ? buf.toString('utf8') : toArrayBuffer(buf), dirUrl);
  return { root: gltf.scene, animations: gltf.animations || [], flipV: false };
}

async function loadArt(p) {
  let src = p;
  const ext = path.extname(p).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    src = path.join(os.tmpdir(), 'mtexture-' + Date.now() + '.png');
    cp.execFileSync('sips', ['-s', 'format', 'png', p, '--out', src]);
  }
  const bytes = fs.readFileSync(src);
  const bmp = await createImageBitmap(new Blob([bytes]));
  const MAX = 4096;
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
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
    if (process.env.MTEXTURE_DEBUG) {
      const pa = geo.attributes.position.array;
      let nan = 0, minY = 1e9, maxY = -1e9;
      for (let i = 0; i < pa.length; i++) { if (!Number.isFinite(pa[i])) nan++; }
      for (let i = 1; i < pa.length; i += 3) { minY = Math.min(minY, pa[i]); maxY = Math.max(maxY, pa[i]); }
      fs.appendFileSync(process.env.MTEXTURE_DEBUG,
        `${obj.name}|treat=${state.treatment}|verts=${geo.attributes.position.count}` +
        `|idx=${geo.index ? geo.index.count : 'none'}|uv=${!!geo.attributes.uv}` +
        `|nan=${nan}|y=${minY.toFixed(3)}..${maxY.toFixed(3)}\n`);
    }

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

function outputPath() {
  const modelBase = path.basename(state.modelPath, path.extname(state.modelPath)).trim();
  const artBase = path.basename(state.artPath, path.extname(state.artPath)).trim();
  const dir = path.dirname(state.modelPath);
  const clean = s => s.replace(/[\/\\:*?"<>|]/g, '_');
  const suffix = state.treatment === 'skin' ? '' : `__${state.treatment}`;
  const stem = `${clean(modelBase)}__wrapped-in__${clean(artBase)}${suffix}`;
  const pairKey = state.modelPath + '::' + state.artPath;
  let out = path.join(dir, stem + '.MTexture.glb');
  // never clobber a file this session didn't create
  if (fs.existsSync(out) && !(pairKey === state.lastPairKey && out === state.lastOutPath)) {
    let n = 2;
    while (fs.existsSync(path.join(dir, `${stem}-${n}.MTexture.glb`))) n++;
    out = path.join(dir, `${stem}-${n}.MTexture.glb`);
  }
  return { out, pairKey };
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

async function wrapAndExport() {
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
    const { out, pairKey } = outputPath();
    fs.writeFileSync(out, Buffer.from(ab));
    state.lastOutPath = out;
    state.lastPairKey = pairKey;
    setStatusPath('SPAT OUT →', out);
    ipcRenderer.send('test-done', out);
  } catch (err) {
    console.error(err);
    setStatus('FAILED: ' + (err && err.message ? err.message : err), 'err');
    ipcRenderer.send('test-error', String(err && err.message ? err.message : err));
  } finally {
    state.busy = false;
    exportBtn.disabled = !(state.base && state.texture);
  }
}

// ---------- intake ----------
async function takeModel(p) {
  setStatus('LOADING MODEL: ' + path.basename(p));
  const { root, animations, flipV } = await loadModel(p);
  state.modelPath = p;
  state.base = root;
  state.animations = animations;
  state.flipV = flipV;
  const slot = document.getElementById('modelSlot');
  slot.classList.add('filled');
  document.getElementById('modelHint').style.display = 'none';
  document.getElementById('modelName').textContent = path.basename(p);
}

async function takeArt(p) {
  setStatus('LOADING ART: ' + path.basename(p));
  const { tex, canvas } = await loadArt(p);
  if (state.texture) state.texture.dispose();
  if (state.dissolveTex) { state.dissolveTex.dispose(); state.dissolveTex = null; }
  state.artPath = p;
  state.texture = tex;
  state.artCanvas = canvas;
  const slot = document.getElementById('artSlot');
  slot.classList.add('filled');
  document.getElementById('artHint').style.display = 'none';
  document.getElementById('artName').textContent = path.basename(p);
  const thumb = document.getElementById('artThumb');
  thumb.src = canvas.toDataURL('image/jpeg', 0.8);
  thumb.style.display = 'block';
}

async function intake(paths) {
  try {
    for (const p of paths) {
      const ext = path.extname(p).toLowerCase();
      if (MODEL_EXTS.has(ext)) await takeModel(p);
      else if (ART_EXTS.has(ext)) await takeArt(p);
      else setStatus('IGNORED ' + path.basename(p) + ' (unsupported type)', 'err');
    }
    if (state.base && state.texture) {
      await wrapAndExport();
    } else if (state.base) {
      setStatus('MODEL LOADED. NOW DROP YOUR ART.');
    } else if (state.texture) {
      setStatus('ART LOADED. NOW DROP A 3D MODEL.');
    }
  } catch (err) {
    console.error(err);
    setStatus('FAILED: ' + (err && err.message ? err.message : err), 'err');
    ipcRenderer.send('test-error', String(err && err.message ? err.message : err));
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
  const paths = [...e.dataTransfer.files].map(f => webUtils.getPathForFile(f)).filter(Boolean);
  if (paths.length) intake(paths);
});

for (const [slot, kind] of [['modelSlot', 'model'], ['artSlot', 'art']]) {
  const el = document.getElementById(slot);
  el.addEventListener('dragover', () => el.classList.add('dragover'));
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', () => el.classList.remove('dragover'));
  el.addEventListener('click', async () => {
    const p = await ipcRenderer.invoke('pick', kind);
    if (p) intake([p]);
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
exportBtn.addEventListener('click', () => wrapAndExport());

// ---------- batch hook ----------
// Reads a JSON array of {model, art, projection, treatment, out, tiles, amount} and
// wraps them one after another in this single process.
ipcRenderer.on('batch-load', async (e, { jobFile }) => {
  let jobs;
  try { jobs = JSON.parse(fs.readFileSync(jobFile, 'utf8')); }
  catch (err) { ipcRenderer.send('batch-error', 'cannot read job file: ' + err.message); return; }

  let ok = 0, failed = 0;
  const t0 = Date.now();
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    try {
      if (fs.existsSync(j.out) && fs.statSync(j.out).size > 1000) {
        ok++; ipcRenderer.send('batch-progress', `SKIP ${i + 1}/${jobs.length} ${j.name || ''}`);
        continue;
      }
      state.mode      = j.projection || 'box';
      state.treatment = j.treatment  || 'skin';
      state.tiles     = j.tiles  != null ? j.tiles  : 1;
      state.amount    = j.amount != null ? j.amount : 1;

      if (j.model !== state.modelPath) await takeModel(j.model);
      if (j.art   !== state.artPath)   await takeArt(j.art);

      ensureDissolveTexture();
      const root = buildWrapped();
      if (state.wrapped) scene.remove(state.wrapped);
      state.wrapped = root; scene.add(root);
      emptyState.style.display = 'none';
      fitCamera(root);

      const ab = await exportGLB(root);
      fs.mkdirSync(path.dirname(j.out), { recursive: true });
      fs.writeFileSync(j.out, Buffer.from(ab));
      ok++;
      const mb = (fs.statSync(j.out).size / 1e6).toFixed(2);
      ipcRenderer.send('batch-progress',
        `OK   ${i + 1}/${jobs.length} ${(j.name || path.basename(j.out)).slice(0, 46)} ${mb}MB`);
    } catch (err) {
      failed++;
      ipcRenderer.send('batch-progress',
        `FAIL ${i + 1}/${jobs.length} ${(j.name || '').slice(0, 46)} ${err && err.message}`);
    }
    // let the renderer breathe so the preview paints and memory is reclaimed
    await new Promise(r => setTimeout(r, 12));
  }
  ipcRenderer.send('batch-done',
    `${ok} ok, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
});

// ---------- test hook ----------
ipcRenderer.on('test-load', (e, { modelPath, artPath, mode, treatment }) => {
  if (mode) {
    state.mode = mode;
    document.querySelectorAll('.modes button[data-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === mode));
  }
  if (treatment) {
    state.treatment = treatment;
    document.querySelectorAll('.modes button[data-treat]').forEach(b =>
      b.classList.toggle('active', b.dataset.treat === treatment));
  }
  intake([modelPath, artPath]);
});
