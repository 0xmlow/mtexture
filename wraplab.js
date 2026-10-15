// wraplab.js — geometry + mask engine for ~M.Texture~
// Everything here must survive GLTFExporter, so treatments are baked into geometry
// and into an RGBA texture, never into a custom shader.
import * as THREE from 'three';

// ---------- value noise (3D), enough for melt and wrinkle ----------
function hash3(x, y, z) {
  let h = x * 374761393 + y * 668265263 + z * 1274126177;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
const fade = t => t * t * (3 - 2 * t);
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  let n = 0;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
    const wx = i ? u : 1 - u, wy = j ? v : 1 - v, wz = k ? w : 1 - w;
    n += hash3(xi + i, yi + j, zi + k) * wx * wy * wz;
  }
  return n * 2 - 1;
}

// ---------- topology ----------
// Adjacency is built from POSITION, not from the index. mergeVertices() compares
// every attribute, so a mesh carrying per-triangle projected UVs merges nothing —
// each triangle stays its own island and "smoothing" just blows the model apart
// into loose confetti. Co-located vertices are grouped and moved together instead,
// which keeps the surface watertight while leaving the UV layout untouched.
function positionGroups(geo, tol) {
  const pos = geo.attributes.position, n = pos.count;
  const map = new Map(), gid = new Int32Array(n), members = [];
  const q = 1 / Math.max(tol, 1e-9);
  for (let i = 0; i < n; i++) {
    const k = Math.round(pos.getX(i)*q) + ',' + Math.round(pos.getY(i)*q) + ',' + Math.round(pos.getZ(i)*q);
    let g = map.get(k);
    if (g === undefined) { g = members.length; map.set(k, g); members.push([]); }
    gid[i] = g; members[g].push(i);
  }
  return { gid, members };
}

function groupAdjacency(geo, gid) {
  const idx = geo.index ? geo.index.array : null;
  const count = geo.index ? geo.index.count : geo.attributes.position.count;
  const at = i => (idx ? idx[i] : i);
  const nb = new Map();
  const add = (a, b) => {
    if (a === b) return;
    let s = nb.get(a); if (!s) { s = new Set(); nb.set(a, s); } s.add(b);
  };
  for (let i = 0; i + 2 < count; i += 3) {
    const a = gid[at(i)], b = gid[at(i+1)], c = gid[at(i+2)];
    add(a,b); add(a,c); add(b,a); add(b,c); add(c,a); add(c,b);
  }
  return nb;
}

function laplacian(geo, grp, nb, iterations, factor) {
  const pos = geo.attributes.position, { members } = grp, G = members.length;
  const gx = new Float32Array(G), gy = new Float32Array(G), gz = new Float32Array(G);
  for (let g = 0; g < G; g++) {
    const i = members[g][0];
    gx[g] = pos.getX(i); gy[g] = pos.getY(i); gz[g] = pos.getZ(i);
  }
  const nx = new Float32Array(G), ny = new Float32Array(G), nz = new Float32Array(G);
  for (let it = 0; it < iterations; it++) {
    for (let g = 0; g < G; g++) {
      const s = nb.get(g);
      if (!s || !s.size) { nx[g] = gx[g]; ny[g] = gy[g]; nz[g] = gz[g]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (const m of s) { sx += gx[m]; sy += gy[m]; sz += gz[m]; }
      const k = 1 / s.size;
      nx[g] = gx[g] + (sx*k - gx[g]) * factor;
      ny[g] = gy[g] + (sy*k - gy[g]) * factor;
      nz[g] = gz[g] + (sz*k - gz[g]) * factor;
    }
    gx.set(nx); gy.set(ny); gz.set(nz);
  }
  for (let g = 0; g < G; g++)
    for (const i of members[g]) pos.setXYZ(i, gx[g], gy[g], gz[g]);
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function alongNormals(geo, grp, fn) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  for (const g of grp.members) {
    let nx = 0, ny = 0, nz = 0;
    for (const i of g) { nx += nrm.getX(i); ny += nrm.getY(i); nz += nrm.getZ(i); }
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    const i0 = g[0];
    const d = fn(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
    if (!d) continue;
    for (const i of g) pos.setXYZ(i, pos.getX(i) + nx*d, pos.getY(i) + ny*d, pos.getZ(i) + nz*d);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function scaleOf(geo) {
  geo.computeBoundingBox();
  const s = geo.boundingBox.getSize(new THREE.Vector3());
  return Math.max(s.x, s.y, s.z) || 1;
}

// ---------- DRAPE ----------
// Christo, in software. Inflate the surface, then smooth it hard so it spans the
// hollows the way real cloth does. Done on the model's own topology rather than a
// separate shell, so its silhouette and UVs both survive.
export function drape(geo, amount = 1) {
  const g = geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const S = scaleOf(g);
  const grp = positionGroups(g, S * 1e-5);
  const nb = groupAdjacency(g, grp.gid);
  alongNormals(g, grp, () => S * 0.020 * amount);
  laplacian(g, grp, nb, Math.round(10 * amount) + 4, 0.62);
  const f = 2.6 / S;
  alongNormals(g, grp, (x, y, z) => noise3(x*f, y*f, z*f) * S * 0.013 * amount);
  return g;
}

// Cinch cords: slice the draped silhouette at three heights and run a tube through
// the widest points, so the cord hugs the bundle instead of floating around it.
export function cords(geo, opts = {}) {
  const { rings = [0.24, 0.52, 0.78], segments = 96, radius = 0.011 } = opts;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const size = bb.getSize(new THREE.Vector3());
  const S = Math.max(size.x, size.y, size.z) || 1;
  const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
  const pos = geo.attributes.position;
  const out = [];
  for (const t of rings) {
    const y = bb.min.y + size.y * t, band = size.y * 0.10;
    const best = new Float32Array(segments);
    for (let i = 0; i < pos.count; i++) {
      const py = pos.getY(i);
      if (Math.abs(py - y) > band) continue;
      const dx = pos.getX(i) - cx, dz = pos.getZ(i) - cz;
      const r = Math.hypot(dx, dz);
      let a = Math.atan2(dz, dx) / (Math.PI * 2); a = (a + 1) % 1;
      const s = Math.min(segments - 1, Math.floor(a * segments));
      if (r > best[s]) best[s] = r;
    }
    // fill any empty slots from their neighbours so the curve stays closed
    let seen = best.some(v => v > 0);
    if (!seen) continue;
    for (let pass = 0; pass < 3; pass++)
      for (let s = 0; s < segments; s++)
        if (best[s] === 0) best[s] = Math.max(best[(s + 1) % segments], best[(s - 1 + segments) % segments]);
    const pts = [];
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const r = best[s] * 1.012 + S * 0.004;
      pts.push(new THREE.Vector3(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.4);
    out.push(new THREE.TubeGeometry(curve, segments, S * radius * 0.5, 8, true));
  }
  return out;
}

// ---------- DISSOLVE ----------
// Sag the form with low-frequency noise. noise scale here is feature SIZE relative
// to the object: anything small covers the surface in bumps instead of melting it.
export function dissolveGeometry(geo, amount = 1) {
  const g = geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const S = scaleOf(g);
  const grp = positionGroups(g, S * 1e-5);
  const f1 = 0.62 / S, f2 = 1.35 / S;
  alongNormals(g, grp, (x, y, z) =>
    (noise3(x*f1, y*f1, z*f1) * 0.055 + noise3(x*f2, y*f2, z*f2) * 0.022) * S * amount);
  return g;
}

// Bake the erosion into the artwork's alpha channel. glTF has no alphaMap — it reads
// alpha from the base colour texture — so this is the only form the export can carry.
export function bakeDissolveTexture(artCanvas, coverage = 0.24) {
  const W = artCanvas.width, H = artCanvas.height;
  const N = 128;
  const small = document.createElement('canvas');
  small.width = small.height = N;
  const sc = small.getContext('2d', { willReadFrequently: true });
  sc.filter = 'blur(6px)';
  sc.drawImage(artCanvas, 0, 0, N, N);
  sc.filter = 'none';
  const sd = sc.getImageData(0, 0, N, N).data;

  const lum = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++)
    lum[i] = 0.2126*sd[i*4] + 0.7152*sd[i*4+1] + 0.0722*sd[i*4+2];
  // fixed coverage, so every object in a series loses the same fraction no matter
  // how dark its painting happens to be
  const sorted = Float32Array.from(lum).sort();
  const thr = sorted[Math.floor(sorted.length * coverage)];

  const mask = sc.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const v = lum[i] > thr ? 255 : 0;
    mask.data[i*4] = mask.data[i*4+1] = mask.data[i*4+2] = v;
    mask.data[i*4+3] = 255;
  }
  sc.putImageData(mask, 0, 0);

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const oc = out.getContext('2d', { willReadFrequently: true });
  oc.drawImage(artCanvas, 0, 0);
  oc.imageSmoothingEnabled = false;
  const up = document.createElement('canvas');
  up.width = W; up.height = H;
  const uc = up.getContext('2d', { willReadFrequently: true });
  uc.imageSmoothingEnabled = false;
  uc.drawImage(small, 0, 0, W, H);
  const ud = uc.getImageData(0, 0, W, H).data;
  const od = oc.getImageData(0, 0, W, H);
  for (let i = 0; i < W * H; i++) od.data[i*4+3] = ud[i*4] > 127 ? 255 : 0;
  oc.putImageData(od, 0, 0);
  return out;
}
