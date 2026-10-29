// project.js — how the painting maps onto the surface.
//
// Every projection works in MODEL space, not per mesh: one painting runs across all
// the parts of a model at one density, instead of being restretched to each part's
// own bounding box (a lantern's cap, cage and handle used to get three different
// paintings at three different scales).
//
// Coordinates: s runs left to right across the painting, t runs top to bottom.
// Textures are flipY = false (glTF), so t = 0 is the painting's top row.
import * as THREE from 'three';
import { positionGroups, groupAdjacency } from './wraplab.js';

const TAU = Math.PI * 2;

// The six ways to look at a box face: right and up vectors as seen from outside,
// so the painting reads the right way round on every side (the old box projection
// mirrored it on the back, left and bottom faces).
const VIEWS = [
  { axis: 0, r: [0, 0, -1], u: [0, 1, 0] },  // +x
  { axis: 0, r: [0, 0, 1], u: [0, 1, 0] },   // -x
  { axis: 1, r: [1, 0, 0], u: [0, 0, -1] },  // +y (top, front edge at the bottom)
  { axis: 1, r: [1, 0, 0], u: [0, 0, 1] },   // -y
  { axis: 2, r: [1, 0, 0], u: [0, 1, 0] },   // +z (front)
  { axis: 2, r: [-1, 0, 0], u: [0, 1, 0] },  // -z
];
const dot3 = (a, x, y, z) => a[0] * x + a[1] * y + a[2] * z;

// ---------- the model frame ----------
// root must already have its world matrices updated; meshes are measured in
// the space of root's parent, which is where the export lands.
export function modelFrame(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3(), b = new THREE.Box3();
  root.traverse(o => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    box.union(b);
  });
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  ['x', 'y', 'z'].forEach(k => { if (!(size[k] > 1e-9)) size[k] = 1e-3; });
  return { box, center, size, L: Math.max(size.x, size.y, size.z) };
}

// ---------- placement: tiles, rotation, shift ----------
// Tiles scale about the CENTRE of the painting, so turning the dial up keeps the
// middle of the art on the middle of the object (scaling from the corner slid the
// whole painting off sideways). Rotation happens in physical units, so a landscape
// painting turned 90 degrees stays a painting instead of a squeezed one.
export function placer(p, aspect) {
  const c = Math.cos(p.rotate || 0), s = Math.sin(p.rotate || 0);
  const k = p.tiles || 1, ou = p.offsetU || 0, ov = p.offsetV || 0;
  return (u, v, out) => {
    const x = (u - 0.5) * aspect, y = v - 0.5;
    const xr = x * c - y * s, yr = x * s + y * c;
    out[0] = (xr / aspect) * k + 0.5 + ou;
    out[1] = yr * k + 0.5 + ov;
    return out;
  };
}

// ---------- helpers ----------
function modelPositions(geo, M) {
  const pos = geo.attributes.position, n = pos.count;
  const P = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(M);
    P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
  }
  return P;
}

// Painting size in model units for a view, given the face extents w x h.
// TRUE keeps the painting's proportions and covers the face (no edge of the
// painting shows); STRETCH is the old behaviour, painting squeezed to the face.
function paintSize(fit, w, h, A) {
  if (fit === 'stretch') return [w, h];
  const Pw = Math.max(w, h * A);
  return [Pw, Pw / A];
}

// Smoothed axis choice. Box projection used to pick its axis per triangle from the
// raw face normal: on a dense scan neighbouring triangles land on different axes and
// the surface shatters into a patchwork of scales. Here normals are averaged over
// co-located vertices, smoothed across the mesh a number of rings that grows with
// density, and then each triangle takes a majority vote of its corners. Patches
// become regions.
function smoothedNormals(geo, P) {
  const n = geo.attributes.position.count, tris = Math.floor(n / 3);
  geo.computeBoundingBox();
  const s = geo.boundingBox.getSize(new THREE.Vector3());
  const grp = positionGroups(geo, Math.max(s.x, s.y, s.z, 1e-6) * 1e-5);
  const G = grp.members.length;
  const gn = new Float32Array(G * 3);
  for (let t = 0; t < tris; t++) {
    const a = t * 9, ax = P[a], ay = P[a + 1], az = P[a + 2];
    const e1x = P[a + 3] - ax, e1y = P[a + 4] - ay, e1z = P[a + 5] - az;
    const e2x = P[a + 6] - ax, e2y = P[a + 7] - ay, e2z = P[a + 8] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (let j = 0; j < 3; j++) {
      const g = grp.gid[t * 3 + j] * 3;
      gn[g] += nx; gn[g + 1] += ny; gn[g + 2] += nz;
    }
  }
  const norm = arr => {
    for (let g = 0; g < G; g++) {
      const L = Math.hypot(arr[g * 3], arr[g * 3 + 1], arr[g * 3 + 2]) || 1;
      arr[g * 3] /= L; arr[g * 3 + 1] /= L; arr[g * 3 + 2] /= L;
    }
  };
  norm(gn);
  const iters = Math.max(3, Math.min(40, Math.round(Math.sqrt(tris) / 40)));
  const nb = groupAdjacency(geo, grp.gid);
  let cur = gn, nxt = new Float32Array(G * 3);
  for (let it = 0; it < iters; it++) {
    for (let g = 0; g < G; g++) {
      let x = cur[g * 3], y = cur[g * 3 + 1], z = cur[g * 3 + 2];
      const ss = nb.get(g);
      if (ss) for (const m of ss) { x += cur[m * 3]; y += cur[m * 3 + 1]; z += cur[m * 3 + 2]; }
      nxt[g * 3] = x; nxt[g * 3 + 1] = y; nxt[g * 3 + 2] = z;
    }
    norm(nxt);
    [cur, nxt] = [nxt, cur];
  }
  return { gid: grp.gid, G, gn: cur };
}

function viewCode(x, y, z) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
  if (ay >= az) return y >= 0 ? 2 : 3;
  return z >= 0 ? 4 : 5;
}

function boxCodes(geo, P) {
  const n = geo.attributes.position.count, tris = Math.floor(n / 3);
  const { gid, G, gn } = smoothedNormals(geo, P);
  const code = new Uint8Array(tris);
  for (let t = 0; t < tris; t++) {
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < 3; j++) { const g = gid[t * 3 + j] * 3; x += gn[g]; y += gn[g + 1]; z += gn[g + 2]; }
    code[t] = viewCode(x, y, z);
  }
  // two passes of majority vote: corners elect, triangles follow two of three
  const votes = new Uint32Array(G * 6), best = new Uint8Array(G);
  for (let pass = 0; pass < 2; pass++) {
    votes.fill(0);
    for (let t = 0; t < tris; t++) for (let j = 0; j < 3; j++) votes[gid[t * 3 + j] * 6 + code[t]]++;
    for (let g = 0; g < G; g++) {
      let b = 0;
      for (let c = 1; c < 6; c++) if (votes[g * 6 + c] > votes[g * 6 + b]) b = c;
      best[g] = b;
    }
    for (let t = 0; t < tris; t++) {
      const a = best[gid[t * 3]], b = best[gid[t * 3 + 1]], c = best[gid[t * 3 + 2]];
      if (a === b || a === c) code[t] = a; else if (b === c) code[t] = b;
    }
  }
  return { code, gid, gn };
}

// Unwrap a triangle's s values across a seam of width `period` so the triangle
// does not smear the whole painting across itself (the stripe down the back of
// every old cylinder and sphere wrap).
function unwrapTri(uv, i, period) {
  const s0 = uv[i * 2];
  for (let j = 1; j < 3; j++) {
    const k = (i + j) * 2;
    while (uv[k] - s0 > period / 2) uv[k] -= period;
    while (uv[k] - s0 < -period / 2) uv[k] += period;
  }
}

// ---------- the projections ----------
// opts: { mode, axis, fit, aspect, place, view: {matrix: Matrix4 (viewProj), aspect} }
// attr: name of the attribute to write ('uv' to texture directly, 'proj' to bake)
// Returns { geo, note } — geo is non-indexed for every projected mode.
export function project(src, M, frame, opts, attr = 'uv') {
  const mode = opts.mode;
  const A = opts.aspect || 1;
  const place = placer(opts.place || {}, A);
  const tmp = [0, 0];

  if (mode === 'native') {
    if (!src.attributes.uv) return project(src, M, frame, { ...opts, mode: 'box' }, attr);
    const geo = src;
    const uv = geo.attributes.uv;
    const out = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      const v = opts.flipV ? 1 - uv.getY(i) : uv.getY(i);
      place(uv.getX(i), v, tmp);
      out[i * 2] = tmp[0]; out[i * 2 + 1] = tmp[1];
    }
    geo.setAttribute(attr, new THREE.BufferAttribute(out, 2));
    return { geo, note: null };
  }

  const geo = src.index ? src.toNonIndexed() : src;
  const n = geo.attributes.position.count, tris = Math.floor(n / 3);
  const P = modelPositions(geo, M);
  const c = frame.center, S = frame.size;
  const uv = new Float32Array(n * 2);
  let note = null;

  if (mode === 'box' || mode === 'triplanar') {
    const { code, gid, gn } = boxCodes(geo, P);
    const sizeFor = v => {
      if (opts.fit === 'stretch') {
        const w = Math.abs(dot3(v.r, S.x, S.y, S.z)), h = Math.abs(dot3(v.u, S.x, S.y, S.z));
        return [w, h];
      }
      // one density for every face, so the painting is the same size all round
      const Pw = frame.L * Math.max(1, A);
      return [Pw, Pw / A];
    };
    const sz = VIEWS.map(sizeFor);
    const projectTo = (vi, i, out, o) => {
      const v = VIEWS[vi], [Pw, Ph] = sz[vi];
      const x = P[i * 3] - c.x, y = P[i * 3 + 1] - c.y, z = P[i * 3 + 2] - c.z;
      place(0.5 + dot3(v.r, x, y, z) / Pw, 0.5 - dot3(v.u, x, y, z) / Ph, tmp);
      out[o] = tmp[0]; out[o + 1] = tmp[1];
    };
    if (mode === 'box') {
      for (let t = 0; t < tris; t++) for (let j = 0; j < 3; j++) projectTo(code[t], t * 3 + j, uv, (t * 3 + j) * 2);
    } else {
      // triplanar: three projections plus blend weights, blended per pixel at bake
      // time. The sign of each axis comes from the triangle so a triangle never
      // straddles a mirrored pair.
      const pX = new Float32Array(n * 2), pY = new Float32Array(n * 2), pZ = new Float32Array(n * 2);
      const tw = new Float32Array(n * 3);
      for (let t = 0; t < tris; t++) {
        let sx = 0, sy = 0, sz2 = 0;
        for (let j = 0; j < 3; j++) { const g = gid[t * 3 + j] * 3; sx += gn[g]; sy += gn[g + 1]; sz2 += gn[g + 2]; }
        for (let j = 0; j < 3; j++) {
          const i = t * 3 + j;
          projectTo(sx >= 0 ? 0 : 1, i, pX, i * 2);
          projectTo(sy >= 0 ? 2 : 3, i, pY, i * 2);
          projectTo(sz2 >= 0 ? 4 : 5, i, pZ, i * 2);
          const g = gid[i] * 3;
          // sharpness 4: wide enough to hide the seams, narrow enough not to ghost
          let wx = gn[g] ** 4, wy = gn[g + 1] ** 4, wz = gn[g + 2] ** 4;
          const sum = wx + wy + wz || 1;
          tw[i * 3] = wx / sum; tw[i * 3 + 1] = wy / sum; tw[i * 3 + 2] = wz / sum;
        }
      }
      geo.setAttribute('pX', new THREE.BufferAttribute(pX, 2));
      geo.setAttribute('pY', new THREE.BufferAttribute(pY, 2));
      geo.setAttribute('pZ', new THREE.BufferAttribute(pZ, 2));
      geo.setAttribute('tw', new THREE.BufferAttribute(tw, 3));
      uv.set(pZ); // a sensible single projection if anything reads 'proj'
    }
  } else if (mode === 'planar') {
    let vi;
    if (opts.axis === 'x') vi = 0; else if (opts.axis === 'y') vi = 2; else if (opts.axis === 'z') vi = 4;
    else vi = S.z <= S.x && S.z <= S.y ? 4 : (S.x <= S.y ? 0 : 2); // auto: down the thinnest axis
    const v = VIEWS[vi];
    const [Pw, Ph] = paintSize(opts.fit,
      Math.abs(dot3(v.r, S.x, S.y, S.z)), Math.abs(dot3(v.u, S.x, S.y, S.z)), A);
    for (let i = 0; i < n; i++) {
      const x = P[i * 3] - c.x, y = P[i * 3 + 1] - c.y, z = P[i * 3 + 2] - c.z;
      place(0.5 + dot3(v.r, x, y, z) / Pw, 0.5 - dot3(v.u, x, y, z) / Ph, tmp);
      uv[i * 2] = tmp[0]; uv[i * 2 + 1] = tmp[1];
    }
  } else if (mode === 'cylinder') {
    // the seam goes at the back, where nobody looks; the painting's centre faces front
    const h = S.y, circ = Math.PI * (S.x + S.z) / 2;
    let wraps = 1, Ph = h;
    if (opts.fit !== 'stretch') {
      // keep the painting's proportions by wrapping it a whole number of times
      wraps = Math.max(1, Math.round(circ / (h * A)));
    }
    const raw = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = P[i * 3] - c.x, y = P[i * 3 + 1] - c.y, z = P[i * 3 + 2] - c.z;
      raw[i * 2] = 0.5 + wraps * Math.atan2(x, z) / TAU;
      raw[i * 2 + 1] = 0.5 - y / Ph;
    }
    for (let t = 0; t < tris; t++) unwrapTri(raw, t * 3, wraps);
    for (let i = 0; i < n; i++) { place(raw[i * 2], raw[i * 2 + 1], tmp); uv[i * 2] = tmp[0]; uv[i * 2 + 1] = tmp[1]; }
  } else if (mode === 'sphere') {
    const raw = new Float32Array(n * 2), pole = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = P[i * 3] - c.x, y = P[i * 3 + 1] - c.y, z = P[i * 3 + 2] - c.z;
      const L = Math.hypot(x, y, z) || 1;
      raw[i * 2] = 0.5 + Math.atan2(x, z) / TAU;
      raw[i * 2 + 1] = 0.5 - Math.asin(THREE.MathUtils.clamp(y / L, -1, 1)) / Math.PI;
      pole[i] = Math.abs(y / L) > 0.9995 ? 1 : 0;
    }
    for (let t = 0; t < tris; t++) {
      const i = t * 3;
      // a vertex on the pole has no longitude: borrow its neighbours'
      for (let j = 0; j < 3; j++) if (pole[i + j]) {
        const a = (i + (j + 1) % 3) * 2, b = (i + (j + 2) % 3) * 2;
        let sa = raw[a], sb = raw[b];
        if (sb - sa > 0.5) sb -= 1; else if (sa - sb > 0.5) sa -= 1;
        raw[(i + j) * 2] = (sa + sb) / 2;
      }
      unwrapTri(raw, i, 1);
    }
    for (let i = 0; i < n; i++) { place(raw[i * 2], raw[i * 2 + 1], tmp); uv[i * 2] = tmp[0]; uv[i * 2 + 1] = tmp[1]; }
  } else if (mode === 'view') {
    // a projector at the camera: whatever you were looking at gets the painting,
    // whole and the right way up, fitted inside the frame
    const view = opts.view;
    if (!view) return project(src, M, frame, { ...opts, mode: 'planar' }, attr);
    const va = view.aspect, e = view.matrix.elements;
    const Pw = A > va ? 2 * va : 2 * A, Ph = Pw / A;
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const cw = Math.max(1e-6, e[3] * x + e[7] * y + e[11] * z + e[15]);
      place(0.5 + (cx / cw) * va / Pw, 0.5 - (cy / cw) / Ph, tmp);
      uv[i * 2] = tmp[0]; uv[i * 2 + 1] = tmp[1];
    }
  } else {
    throw new Error('unknown projection ' + mode);
  }

  geo.setAttribute(attr, new THREE.BufferAttribute(uv, 2));
  return { geo, note };
}

// Do the model's own UVs make a bakeable atlas? Tiled UVs (brick walls repeated
// four times) cannot be baked into one texture.
export function uvBakeable(geo, flipV) {
  const uv = geo.attributes.uv;
  if (!uv) return { ok: false, why: 'nouv' };
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const a = uv.getX(i), b = flipV ? 1 - uv.getY(i) : uv.getY(i);
    if (a < lo) lo = a; if (b < lo) lo = b;
    if (a > hi) hi = a; if (b > hi) hi = b;
  }
  if (lo < -0.02 || hi > 1.02) return { ok: false, why: 'tiled' };
  return { ok: true };
}
