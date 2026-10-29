// platform.js — the only file that knows whether it is in a browser or in the
// desktop app. Everything else works on "items": { name, file?, path? }.
export const desktop = !!(window.process && window.process.versions && window.process.versions.electron);

const node = desktop ? {
  fs: require('fs'), path: require('path'), os: require('os'), cp: require('child_process'),
  url: require('url'), ipc: require('electron').ipcRenderer, webUtils: require('electron').webUtils,
} : null;
export const ipc = node ? node.ipc : null;

export const extOf = name => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase(); };

export function itemFromPath(p) {
  return { name: node.path.basename(p), path: p, file: null };
}

export function itemsFromDrop(dt) {
  return [...dt.files].map(f => ({
    name: f.name, file: f, path: node ? node.webUtils.getPathForFile(f) || null : null,
  }));
}

export async function readBytes(item) {
  if (item.path && node) {
    const b = node.fs.readFileSync(item.path);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  return item.file.arrayBuffer();
}

// Where a .gltf's relative .bin and texture paths resolve. On the desktop that is the
// model's own folder; in a browser there is no folder, so the app serves the files
// dropped alongside it from memory through a URL modifier.
export function baseUrlFor(item) {
  if (item.path && node) return node.url.pathToFileURL(node.path.dirname(item.path)).href + '/';
  return location.origin + '/__m/';
}

export async function decodeImage(item) {
  const heic = /\.hei[cf]$/i.test(item.name);
  if (heic && item.path && node) {
    // macOS converts HEIC for us
    const tmp = node.path.join(node.os.tmpdir(), 'mtexture-' + Date.now() + '.png');
    node.cp.execFileSync('sips', ['-s', 'format', 'png', item.path, '--out', tmp]);
    const b = node.fs.readFileSync(tmp);
    node.fs.unlinkSync(tmp);
    return createImageBitmap(new Blob([b]));
  }
  const blob = item.file || new Blob([await readBytes(item)]);
  try { return await createImageBitmap(blob); }
  catch (err) {
    // Safari decodes HEIC through <img>; other browsers give up here
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(heic ? 'this browser cannot read HEIC: use Safari, or export the art as JPG/PNG' : 'cannot read that image'));
      };
      img.src = url;
    });
  }
}

export async function pick(kind) {
  if (node) {
    const p = await node.ipc.invoke('pick', kind);
    return p ? p.map(itemFromPath) : [];
  }
  const input = document.getElementById(kind === 'model' ? 'modelPick' : 'artPick');
  return new Promise(resolve => {
    input.onchange = () => { const fs = [...input.files].map(f => ({ name: f.name, file: f, path: null })); input.value = ''; resolve(fs); };
    input.click();
  });
}

// Desktop: write next to the model, never clobbering a file this session did not
// make. Web: download. Returns { label, url?, path? } for the status line.
const made = new Set();
export function save(stem, ext, bytes, nextTo, mime) {
  if (node) {
    const dir = nextTo && nextTo.path ? node.path.dirname(nextTo.path) : node.os.homedir() + '/Downloads';
    let out = node.path.join(dir, stem + ext);
    if (node.fs.existsSync(out) && !made.has(out)) {
      let n = 2;
      while (node.fs.existsSync(node.path.join(dir, `${stem}-${n}${ext}`))) n++;
      out = node.path.join(dir, `${stem}-${n}${ext}`);
    }
    node.fs.writeFileSync(out, Buffer.from(bytes));
    made.add(out);
    return { label: out, path: out };
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = stem + ext;
  document.body.appendChild(a); a.click(); a.remove();
  return { label: stem + ext, url, name: stem + ext };
}

export function reveal(p) { if (node) node.ipc.send('reveal', p); }

// Batch and test hooks only exist on the desktop.
export function writeFile(p, bytes) {
  node.fs.mkdirSync(node.path.dirname(p), { recursive: true });
  node.fs.writeFileSync(p, Buffer.from(bytes));
  return node.fs.statSync(p).size;
}
export function readJSON(p) { return JSON.parse(node.fs.readFileSync(p, 'utf8')); }
export function exists(p) { return node.fs.existsSync(p) && node.fs.statSync(p).size > 1000; }
export function debugLog(line) {
  const f = node && window.process.env.MTEXTURE_DEBUG;
  if (f) node.fs.appendFileSync(f, line + '\n');
}
