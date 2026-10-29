// app.js — ~M.Texture~ v3. The viewport, the controls and the hooks. The wrap itself
// lives in engine/, shared verbatim by the browser and the desktop app.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import * as P from './platform.js';
import { wrapModel, canvasTexture, NOTES } from './engine/wrap.js';
import { exportGLB, outputStem, VERSION } from './engine/glb.js';

const MODEL_EXTS = new Set(['.glb', '.gltf', '.fbx']);
const ART_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);
const SIDE_EXTS = new Set(['.bin', '.ktx2', '.jpg', '.jpeg', '.png', '.webp']);
const MAX_ARTS = 6;

document.body.classList.add(P.desktop ? 'desk' : 'web');
if (P.desktop) document.getElementById('emptySmall').textContent = 'THE NEW ASSET LANDS NEXT TO THE ORIGINAL';

// ---------- settings (everything the engine reads) ----------
const S = {
  mode: 'native', axis: 'auto', fit: 'true',
  tiles: 1, rotate: 0, offsetU: 0, offsetV: 0,
  treatment: 'skin', amount: 1,
  finish: 'auto', impasto: 0, keep: false,
  bake: false, blend: 'replace', mix: 1,
  size: 2048, normalize: false, autosave: true,
  view: null,
};
const state = {
  model: null,          // { item, root, animations, flipV, baseGeos: Set }
  arts: [],             // { item, name, canvas, tex, aspect, thumb }
  artIndex: 0,
  partArt: new Map(),   // mesh index -> art index, or -1 to keep the original
  sidecars: new Map(),  // filename -> item, for .gltf files in a browser
  wrapped: null, report: null, cache: {},
  before: null, mixer: null, framed: false,
  lastSave: null,
};

// ---------- viewport ----------
const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Khronos PBR Neutral: built for product shots, it keeps the painting's own colours
// where filmic curves would bend them
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.prepend(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;

const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 5000);
camera.position.set(2, 1.5, 3);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;

scene.add(new THREE.HemisphereLight(0xf0f4f8, 0x223344, 0.35));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(3, 5, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0x9fc0ff, 0.7);
rim.position.set(-4, 2.5, -3);
scene.add(rim);

// stage: a shadow catcher plus a soft contact shadow (the cheapest realism win
// there is: a radial gradient under the object)
const stage = new THREE.Group();
const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32 }));
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.receiveShadow = true;
const contact = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)'); grad.addColorStop(0.45, 'rgba(0,0,0,0.22)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2; m.renderOrder = -1;
  return m;
})();
const grid = new THREE.GridHelper(10, 20, 0x2962ff, 0x1a2233);
grid.material.transparent = true; grid.material.opacity = 0.18; grid.material.depthWrite = false;
stage.add(shadowCatcher, contact, grid);
scene.add(stage);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
function render() {
  const dt = clock.getDelta();
  if (state.mixer) state.mixer.update(dt);
  controls.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(render);

function setStage(frame) {
  const { box, center, L } = frame;
  stage.position.set(center.x, box.min.y, center.z);
  shadowCatcher.scale.setScalar(L * 6);
  const fx = frame.size.x * 1.35, fz = frame.size.z * 1.35;
  contact.scale.set(Math.max(fx, L * 0.4), Math.max(fz, L * 0.4), 1);
  contact.position.y = L * 0.0008;
  grid.scale.setScalar(Math.max(L / 3.5, 0.001));
  const sc = key.shadow.camera, r = L * 1.2;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = L * 0.05; sc.far = L * 8;
  sc.updateProjectionMatrix();
  key.position.copy(center).add(new THREE.Vector3(L * 1.2, L * 2.2, L * 1.6));
  key.target.position.copy(center);
}

function fitCamera(frame) {
  const { center, L } = frame;
  const dist = L * 1.9;
  camera.near = L / 200; camera.far = L * 60;
  camera.position.copy(center).add(new THREE.Vector3(dist * 0.62, dist * 0.42, dist * 0.82));
  camera.updateProjectionMatrix();
  controls.target.copy(center);
}

// ---------- status ----------
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const exportBtn = document.getElementById('exportBtn');
const shotBtn = document.getElementById('shotBtn');
const emptyState = document.getElementById('emptyState');
const tipEl = document.getElementById('tip');
const statsEl = document.getElementById('stats');
const partHint = document.getElementById('partHint');
const toastEl = document.getElementById('toast');

function setStatus(msg, kind = '') { statusEl.className = kind; statusText.textContent = msg; }
function setStatusSaved(prefix, res) {
  statusEl.className = 'ok';
  statusText.textContent = prefix + ' ';
  const a = document.createElement(res.url ? 'a' : 'span');
  a.className = 'path';
  a.textContent = res.label;
  if (res.url) { a.href = res.url; a.download = res.name; a.title = 'download again'; }
  else { a.title = 'reveal in Finder'; a.onclick = () => P.reveal(res.path); }
  statusText.appendChild(a);
}
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}
const errMsg = err => (err && err.message ? err.message : String(err));

// ---------- loading ----------
const manager = new THREE.LoadingManager();
const sidecarUrls = new Map();
manager.setURLModifier(url => {
  if (/^(data|blob):/.test(url)) return url;
  const name = decodeURIComponent(url.split(/[\/\\]/).pop().split('?')[0]);
  const it = state.sidecars.get(name);
  if (!it || !it.file) return url;
  if (!sidecarUrls.has(name)) sidecarUrls.set(name, URL.createObjectURL(it.file));
  return sidecarUrls.get(name);
});
const LIBS = window.MT_THREE_BASE + 'examples/jsm/libs/';
const draco = new DRACOLoader().setDecoderPath(LIBS + 'draco/gltf/');
const ktx2 = new KTX2Loader().setTranscoderPath(LIBS + 'basis/').detectSupport(renderer);
const gltfLoader = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
const fbxLoader = new FBXLoader(manager);

async function loadModel(item) {
  const ext = P.extOf(item.name), buf = await P.readBytes(item), base = P.baseUrlFor(item);
  if (ext === '.fbx') {
    const group = fbxLoader.parse(buf, base);
    // FBX UVs assume flipY = true textures; the engine converts
    return { root: group, animations: group.animations || [], flipV: true };
  }
  const gltf = await gltfLoader.parseAsync(ext === '.gltf' ? new TextDecoder().decode(buf) : buf, base);
  return { root: gltf.scene, animations: gltf.animations || [], flipV: false };
}

async function loadArt(item) {
  const bmp = await P.decodeImage(item);
  const MAX = 4096;
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  const tex = canvasTexture(canvas, { anisotropy: renderer.capabilities.getMaxAnisotropy() });
  const t = document.createElement('canvas'), k = 116 / Math.max(canvas.width, canvas.height);
  t.width = Math.round(canvas.width * k); t.height = Math.round(canvas.height * k);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return { item, name: item.name, canvas, tex, aspect: canvas.width / canvas.height, thumb: t.toDataURL('image/jpeg', 0.8) };
}

function disposeArt(a) {
  a.tex.dispose();
  if (a.dissolveTex) a.dissolveTex.dispose();
  if (a.impastoTex) a.impastoTex.dispose();
}

async function takeModel(item) {
  setStatus('LOADING MODEL: ' + item.name, 'busy');
  const m = await loadModel(item);
  m.item = item;
  m.root.updateMatrixWorld(true);
  m.baseGeos = new Set(); m.baseMats = new Set();
  m.root.traverse(o => {
    if (!o.isMesh) return;
    m.baseGeos.add(o.geometry);
    [].concat(o.material).forEach(x => m.baseMats.add(x));
  });
  if (state.before) scene.remove(state.before);
  state.before = SkeletonUtils.clone(m.root);
  state.before.visible = false;
  state.before.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(state.before);
  state.model = m;
  state.partArt.clear();
  state.cache = {};
  state.framed = false;
  S.view = null;
  document.getElementById('modelSlot').classList.add('filled');
  document.getElementById('modelHint').style.display = 'none';
  document.getElementById('modelName').textContent = item.name;
}

async function takeArt(item, { replace = false } = {}) {
  setStatus('LOADING ART: ' + item.name, 'busy');
  const art = await loadArt(item);
  if (replace) { state.arts.forEach(disposeArt); state.arts = []; state.partArt.clear(); }
  if (state.arts.length >= MAX_ARTS) disposeArt(state.arts.shift());
  state.arts.push(art);
  state.artIndex = state.arts.length - 1;
  renderTray();
}

function renderTray() {
  const tray = document.getElementById('artTray');
  tray.innerHTML = '';
  state.arts.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 't' + (i === state.artIndex ? ' active' : '');
    d.title = a.name + (i === state.artIndex ? ' (default)' : ': click to make it the default');
    d.innerHTML = `<img src="${a.thumb}"><span class="n">${i + 1}</span><span class="x" title="remove">×</span>`;
    d.onclick = e => {
      if (e.target.classList.contains('x')) return removeArt(i);
      state.artIndex = i; renderTray(); requestWrap('full');
    };
    tray.appendChild(d);
  });
  document.getElementById('artSlot').classList.toggle('filled', state.arts.length > 0);
  document.getElementById('artHint').innerHTML = state.arts.length
    ? `${state.arts.length} piece${state.arts.length > 1 ? 's' : ''}: drop or click to add<br><small>click a part of the model to dress it in another</small>`
    : 'drop a .jpg / .png / .heic / .webp<br>or click to browse<br><small>drop more than one to dress parts differently</small>';
  updateButtons();
}

function removeArt(i) {
  disposeArt(state.arts[i]);
  state.arts.splice(i, 1);
  // re-point part overrides past the removed slot
  for (const [k, v] of [...state.partArt]) {
    if (v === i) state.partArt.delete(k);
    else if (v > i) state.partArt.set(k, v - 1);
  }
  state.artIndex = Math.min(state.artIndex, Math.max(0, state.arts.length - 1));
  renderTray();
  if (state.arts.length) requestWrap('full');
  else clearWrapped();
}

function updateButtons() {
  const ready = !!(state.model && state.arts.length);
  exportBtn.disabled = !ready;
  shotBtn.disabled = !state.model;
}

// ---------- wrapping ----------
function engineSettings() {
  return {
    ...S,
    place: { tiles: S.tiles, rotate: THREE.MathUtils.degToRad(S.rotate), offsetU: S.offsetU, offsetV: S.offsetV },
    flipV: state.model.flipV, partArt: state.partArt, artIndex: state.artIndex,
  };
}

function disposeWrapped(root) {
  const m = state.model;
  root.traverse(o => {
    if (!o.isMesh) return;
    if (!m || !m.baseGeos.has(o.geometry)) o.geometry.dispose();
    for (const mat of [].concat(o.material)) {
      if (m && m.baseMats.has(mat)) continue;
      for (const k of ['map', 'normalMap']) if (mat[k] && mat[k].userData.mtOwned) mat[k].dispose();
      mat.dispose();
    }
  });
}

function clearWrapped() {
  if (state.wrapped) { scene.remove(state.wrapped); disposeWrapped(state.wrapped); state.wrapped = null; }
  state.mixer = null;
}

let pending = null, running = false;
const RANK = { preview: 0, full: 1, save: 2 };
// preview: placement dials while dragging (bakes at 512); full: a settled change;
// save: full plus writing the file
function requestWrap(kind = 'full') {
  if (!state.model || !state.arts.length) return;
  if (!pending || RANK[kind] > RANK[pending]) pending = kind;
  if (!running) requestAnimationFrame(runWrap);
}

async function runWrap() {
  if (running || !pending) return;
  running = true;
  const kind = pending; pending = null;
  try {
    await doWrap(kind !== 'preview');
    if (kind === 'save' || (kind === 'full' && P.desktop && S.autosave)) await saveGLB();
  } catch (err) {
    console.error(err);
    setStatus('FAILED: ' + errMsg(err), 'err');
    if (P.ipc) P.ipc.send('test-error', errMsg(err));
  } finally {
    running = false;
    if (pending) requestAnimationFrame(runWrap);
  }
}

async function doWrap(full) {
  if (full) { setStatus('WRAPPING...', 'busy'); await new Promise(r => setTimeout(r, 16)); }
  const t0 = performance.now();
  const { root, report, frame } = wrapModel({
    base: state.model.root, renderer, arts: state.arts, s: engineSettings(), cache: state.cache, preview: !full,
  });
  clearWrapped();
  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  state.wrapped = root;
  state.report = report;
  root.visible = !comparing;
  scene.add(root);
  if (state.model.animations.length) {
    state.mixer = new THREE.AnimationMixer(root);
    state.mixer.clipAction(state.model.animations[0]).play();
  }
  emptyState.style.display = 'none';
  if (!state.framed) { setStage(frame); fitCamera(frame); state.framed = true; }
  report.ms = Math.round(performance.now() - t0);
  updateStats(); advise();
  if (full && !(P.desktop && S.autosave)) setStatus(`WRAPPED IN ${report.ms} MS. SPIT IT OUT WHEN READY.`, 'ok');
  P.debugLog(`wrap|mode=${S.mode}|treat=${S.treatment}|tris=${report.tris}|baked=${report.baked}|overlap=${report.overlap.toFixed(3)}|notes=${[...report.notes].join(',')}|ms=${report.ms}`);
}

function meta() {
  const arts = state.arts.map(a => a.name);
  return {
    tool: '~M.Texture~ by MLow', model: state.model.item.name,
    art: arts[state.artIndex], arts,
    parts: Object.fromEntries([...state.partArt].map(([k, v]) => [k, v < 0 ? 'original' : arts[v]])),
    projection: S.mode, axis: S.mode === 'planar' ? S.axis : undefined, fit: S.fit,
    tiles: S.tiles, rotate: S.rotate, offset: [S.offsetU, S.offsetV],
    treatment: S.treatment, amount: S.amount, finish: S.finish, impasto: S.impasto,
    keep: S.keep, bake: S.bake || S.mode === 'triplanar', blend: S.blend, mix: S.mix,
    made: new Date().toISOString(),
  };
}

async function exportBytes() {
  return exportGLB(state.wrapped, {
    animations: state.model.animations, normalize: S.normalize, maxTextureSize: S.size, meta: meta(),
  });
}

async function saveGLB() {
  if (!state.wrapped) return null;
  setStatus('EXPORTING...', 'busy');
  const bytes = await exportBytes();
  const stem = outputStem(state.model.item.name, state.arts[state.artIndex].name, S.treatment);
  const res = P.save(stem, '.MTexture.glb', bytes, state.model.item, 'model/gltf-binary');
  if (state.lastSave && state.lastSave.url) URL.revokeObjectURL(state.lastSave.url);
  state.lastSave = res;
  setStatusSaved(`SPAT OUT (${(bytes.byteLength / 1e6).toFixed(2)} MB) →`, res);
  if (P.ipc) P.ipc.send('test-done', res.path || res.label);
  return res;
}

function snapshot() {
  const prevRatio = renderer.getPixelRatio();
  grid.visible = false;
  renderer.setPixelRatio(Math.min(3, prevRatio * 2));
  resize();
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.setPixelRatio(prevRatio);
  grid.visible = true;
  resize();
  const bin = atob(url.split(',')[1]), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stem = state.arts.length
    ? outputStem(state.model.item.name, state.arts[state.artIndex].name, S.treatment)
    : state.model.item.name.replace(/\.[^.]+$/, '');
  const res = P.save(stem, '.png', bytes.buffer, state.model.item, 'image/png');
  setStatusSaved('SNAPSHOT →', res);
}

function updateStats() {
  const r = state.report;
  if (!r) { statsEl.textContent = ''; return; }
  const bits = [`${r.parts} PART${r.parts === 1 ? '' : 'S'}`, `${(r.tris / 1000).toFixed(r.tris < 10000 ? 1 : 0)}K TRIS`];
  if (r.baked) bits.push(`${r.baked} BAKED`);
  bits.push(`${r.ms} MS`);
  statsEl.textContent = bits.join(' · ');
  partHint.textContent = r.parts > 1 ? 'CLICK A PART TO CYCLE ITS ART · ORIGINAL' : (state.arts.length > 1 ? 'CLICK THE MODEL TO CYCLE ITS ART' : '');
}

function advise() {
  const r = state.report, msgs = [];
  if (r) {
    for (const n of r.notes) msgs.push(NOTES[n]);
    let hasUv = false;
    state.model.root.traverse(o => { if (o.isMesh && o.geometry.attributes.uv) hasUv = true; });
    if (S.mode === 'box' && r.tris > 120000 && hasUv)
      msgs.push('DENSE MESH: TRY TRI. IT BLENDS THE SIDES INSTEAD OF CUTTING BETWEEN THEM.');
    if (S.mode === 'sphere' && S.fit === 'true')
      msgs.push('SPHERE ALWAYS WRAPS ONCE; WIDE (2:1) ART READS BEST.');
    if (S.treatment === 'dissolve' && S.mode === 'box' && r.tris > 120000)
      msgs.push('DISSOLVE READS BEST OVER A CONTINUOUS UV. TRY NATIVE, CYL OR TRI.');
  }
  tipEl.textContent = [...new Set(msgs)].join('\n');
  tipEl.style.whiteSpace = 'pre-line';
}

// ---------- intake ----------
async function intake(items, opts = {}) {
  try {
    let model = null; const arts = [];
    for (const it of items) {
      const ext = P.extOf(it.name);
      if (MODEL_EXTS.has(ext)) model = it;
      else if (ART_EXTS.has(ext)) arts.push(it);
      else if (!SIDE_EXTS.has(ext)) setStatus('IGNORED ' + it.name + ' (unsupported type)', 'err');
    }
    // a .gltf's companions arrive in the same drop; images named by the .gltf are
    // its textures, not art
    if (model && P.extOf(model.name) === '.gltf') {
      for (const it of items) if (it !== model) state.sidecars.set(it.name, it);
      const text = new TextDecoder().decode(await P.readBytes(model));
      const used = new Set((JSON.parse(text).images || []).map(im => decodeURIComponent((im.uri || '').split('/').pop())));
      for (let i = arts.length - 1; i >= 0; i--) if (used.has(arts[i].name)) arts.splice(i, 1);
    }
    if (model) await takeModel(model);
    for (const a of arts) await takeArt(a, opts);
    updateButtons();
    if (state.model && state.arts.length) requestWrap(opts.save ? 'save' : 'full');
    else if (state.model) setStatus('MODEL LOADED. NOW DROP YOUR ART.');
    else if (state.arts.length) setStatus('ART LOADED. NOW DROP A 3D MODEL.');
  } catch (err) {
    console.error(err);
    setStatus('FAILED: ' + errMsg(err), 'err');
    if (P.ipc) P.ipc.send('test-error', errMsg(err));
  }
}

let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragleave', e => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const items = P.itemsFromDrop(e.dataTransfer);
  if (items.length) intake(items);
});
for (const [id, kind] of [['modelSlot', 'model'], ['artSlot', 'art']]) {
  const el = document.getElementById(id);
  el.addEventListener('dragover', () => el.classList.add('dragover'));
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', () => el.classList.remove('dragover'));
  el.addEventListener('click', async () => { const items = await P.pick(kind); if (items.length) intake(items); });
}

// ---------- controls ----------
function syncSubRows() {
  document.getElementById('axisRow').classList.toggle('show', S.mode === 'planar');
  document.getElementById('aimRow').classList.toggle('show', S.mode === 'view');
}
function setChoice(k, v) {
  S[k] = k === 'size' ? Number(v) : v;
  document.querySelectorAll(`.modes button[data-k="${k}"]`).forEach(b => b.classList.toggle('active', b.dataset.v === String(v)));
  syncSubRows();
}
function aim() {
  camera.updateMatrixWorld();
  S.view = { matrix: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), aspect: camera.aspect };
  setSpin(false);
}
document.querySelectorAll('.modes button[data-k]').forEach(btn => btn.addEventListener('click', () => {
  const k = btn.dataset.k, v = btn.dataset.v;
  setChoice(k, v);
  if (k === 'mode' && v === 'view' && !S.view) aim();
  if (k === 'size' && !(S.bake || S.mode === 'triplanar')) return; // size only changes the export
  requestWrap('full');
}));
document.getElementById('aimBtn').addEventListener('click', () => { aim(); toast('AIMED FROM HERE'); requestWrap('full'); });

const DIALS = {
  tiles:   { read: v => v / 4, show: v => v.toFixed(2).replace(/0$/, ''), live: true },
  rotate:  { read: v => v, show: v => `${v}°`, live: true },
  offsetU: { read: v => v / 100, show: v => v.toFixed(2), live: true },
  offsetV: { read: v => v / 100, show: v => v.toFixed(2), live: true },
  amount:  { read: v => v / 10, show: v => v.toFixed(1), live: false },  // treatments are slow
  impasto: { read: v => v / 10, show: v => v.toFixed(1), live: false },
  mix:     { read: v => v / 10, show: v => v.toFixed(1), live: false },
};
const dialEls = {};
for (const [id, d] of Object.entries(DIALS)) {
  const el = document.getElementById(id), out = document.getElementById(id + 'Val');
  dialEls[id] = el;
  const read = () => { S[id] = d.read(Number(el.value)); out.textContent = d.show(S[id]); };
  el.addEventListener('input', () => { read(); if (d.live) requestWrap('preview'); });
  el.addEventListener('change', () => { read(); requestWrap('full'); });
  read();
}
function setDial(id, value) {
  const d = DIALS[id], el = dialEls[id];
  el.value = String(id === 'tiles' ? value * 4 : id === 'rotate' ? value : (id === 'offsetU' || id === 'offsetV') ? value * 100 : value * 10);
  S[id] = d.read(Number(el.value));
  document.getElementById(id + 'Val').textContent = d.show(S[id]);
}
document.getElementById('placeReset').addEventListener('click', () => {
  setDial('tiles', 1); setDial('rotate', 0); setDial('offsetU', 0); setDial('offsetV', 0);
  requestWrap('full');
});
for (const id of ['keep', 'bake', 'normalize', 'autosave']) {
  const el = document.getElementById(id);
  S[id] = el.checked;
  el.addEventListener('change', () => {
    S[id] = el.checked;
    if (id === 'keep' || id === 'bake') requestWrap('full');
  });
}
exportBtn.addEventListener('click', async () => {
  if (running) { pending = 'save'; return; }
  try { await saveGLB(); } catch (err) { setStatus('FAILED: ' + errMsg(err), 'err'); }
});
shotBtn.addEventListener('click', () => { try { snapshot(); } catch (err) { setStatus('FAILED: ' + errMsg(err), 'err'); } });

// turntable and before/after
const spinBtn = document.getElementById('spinBtn');
function setSpin(on) { controls.autoRotate = on; spinBtn.classList.toggle('on', on); }
spinBtn.addEventListener('click', () => setSpin(!controls.autoRotate));
let comparing = false;
const compareBtn = document.getElementById('compareBtn');
function setCompare(on) {
  comparing = on;
  compareBtn.classList.toggle('on', on);
  if (state.wrapped) state.wrapped.visible = !on;
  if (state.before) state.before.visible = on;
}
compareBtn.addEventListener('pointerdown', () => setCompare(true));
window.addEventListener('pointerup', () => { if (comparing) setCompare(false); });
const typing = e => /INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
window.addEventListener('keydown', e => { if (e.code === 'Space' && !typing(e) && !e.repeat) { e.preventDefault(); setCompare(true); } });
window.addEventListener('keyup', e => { if (e.code === 'Space') setCompare(false); });

// click a part: cycle it through the paintings and then its own original surface
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || !state.wrapped || comparing) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(state.wrapped, true).find(h => h.object.isMesh);
  if (!hit) return;
  let o = hit.object;
  while (o && o.userData.mtIndex === undefined) o = o.parent; // cords belong to their mesh
  if (!o) return;
  const i = o.userData.mtIndex;
  const cur = state.partArt.has(i) ? state.partArt.get(i) : state.artIndex;
  const options = [...state.arts.keys(), -1];
  const next = options[(options.indexOf(cur) + 1) % options.length];
  if (next === state.artIndex) state.partArt.delete(i); else state.partArt.set(i, next);
  toast(`${(o.name || 'PART ' + (i + 1)).toUpperCase()} → ${next < 0 ? 'ORIGINAL' : 'ART ' + (next + 1)}`);
  requestWrap('full');
});

syncSubRows();

// ---------- desktop hooks: batch and test ----------
// Batch: a JSON array of jobs, one Electron process for all of them.
// { model, art, out, name, projection, treatment, tiles, amount, rotate, offsetU,
//   offsetV, fit, axis, finish, impasto, keep, bake, blend, mix, size, normalize }
if (P.ipc) {
  P.ipc.on('batch-load', async (e, { jobFile }) => {
    let jobs;
    try { jobs = P.readJSON(jobFile); }
    catch (err) { P.ipc.send('batch-error', 'cannot read job file: ' + err.message); return; }
    let ok = 0, failed = 0;
    const t0 = Date.now();
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      try {
        if (P.exists(j.out)) { ok++; P.ipc.send('batch-progress', `SKIP ${i + 1}/${jobs.length} ${j.name || ''}`); continue; }
        applyJob(j);
        if (!state.model || state.model.item.path !== j.model) await takeModel(P.itemFromPath(j.model));
        if (!state.arts.length || state.arts[0].item.path !== j.art || state.arts.length > 1) await takeArt(P.itemFromPath(j.art), { replace: true });
        await doWrap(true);
        const size = P.writeFile(j.out, await exportBytes());
        ok++;
        P.ipc.send('batch-progress', `OK   ${i + 1}/${jobs.length} ${(j.name || j.out.split('/').pop()).slice(0, 46)} ${(size / 1e6).toFixed(2)}MB`);
      } catch (err) {
        failed++;
        P.ipc.send('batch-progress', `FAIL ${i + 1}/${jobs.length} ${(j.name || '').slice(0, 46)} ${errMsg(err)}`);
      }
      await new Promise(r => setTimeout(r, 12)); // let the preview paint and memory settle
    }
    P.ipc.send('batch-done', `${ok} ok, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  });

  P.ipc.on('test-load', (e, { modelPath, artPath, mode, treatment, opts }) => {
    applyJob({ projection: mode, treatment, ...(opts || {}) });
    intake([P.itemFromPath(modelPath), P.itemFromPath(artPath)], { save: true });
  });
}

function applyJob(j) {
  const pick = (k, v) => { if (v !== undefined && v !== null) setChoice(k, String(v)); };
  pick('mode', j.projection || 'box');
  pick('treatment', j.treatment || 'skin');
  pick('fit', j.fit || 'true');
  pick('axis', j.axis || 'auto');
  pick('finish', j.finish || 'auto');
  pick('blend', j.blend || 'replace');
  pick('size', j.size || 2048);
  setDial('tiles', j.tiles ?? 1); setDial('rotate', j.rotate ?? 0);
  setDial('offsetU', j.offsetU ?? 0); setDial('offsetV', j.offsetV ?? 0);
  setDial('amount', j.amount ?? 1); setDial('impasto', j.impasto ?? 0); setDial('mix', j.mix ?? 1);
  for (const k of ['keep', 'bake', 'normalize']) { S[k] = !!j[k]; document.getElementById(k).checked = S[k]; }
  S.autosave = false;
}

// for headless checks and the browser pane, which suspends rAF when hidden
window.__mt = { S, state, scene, camera, renderer, controls, render, requestWrap, doWrap, exportBytes, aim, VERSION };
