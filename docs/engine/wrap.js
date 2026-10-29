// wrap.js — one model, one or more paintings, one wrapped clone. No file I/O here:
// the desktop app, the web page and batch mode all call the same function, so the
// engine can never drift between them again.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { drape, cords, dissolveGeometry, bakeDissolveTexture } from './wraplab.js';
import { modelFrame, project, uvBakeable } from './project.js';
import { bakeMesh } from './bake.js';
import { makeSurface, originalSurface, resolveFinish, impastoNormal } from './surface.js';

export const NOTES = {
  nouv: 'NO UV LAYOUT ON SOME PARTS: TRIPLANAR AND BAKE NEED ONE. THOSE PARTS USED BOX.',
  tiled: 'SOME UVs TILE PAST 0..1, SO THEY CANNOT BE BAKED. THOSE PARTS WERE PROJECTED DIRECTLY.',
  keep: 'ORIGINAL MAPS ONLY LINE UP WITH NATIVE OR BAKED UVs. TURN ON BAKE TO KEEP THEM.',
  overlap: 'UV ISLANDS OVERLAP (MIRRORED PARTS): THE BAKED ART REPEATS THERE.',
  noview: 'VIEW PROJECTION NEEDS AN AIM. ORBIT TO THE ANGLE YOU WANT AND HIT AIM.',
};

export function canvasTexture(canvas, { srgb = true, mime = 'image/jpeg', anisotropy = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.flipY = false;                       // glTF convention
  t.userData.mimeType = mime;            // JPEG unless alpha matters: ~15x smaller than PNG
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  return t;
}

// Per-art derived textures, made once and kept on the art record.
function dissolveTexOf(art, anisotropy) {
  if (!art.dissolveTex) art.dissolveTex = canvasTexture(bakeDissolveTexture(art.canvas, 0.24), { mime: 'image/png', anisotropy });
  return art.dissolveTex;
}
function impastoOf(art, anisotropy) {
  if (!art.impastoTex) art.impastoTex = canvasTexture(impastoNormal(art.canvas), { srgb: false, anisotropy });
  return art.impastoTex;
}

function worldArea(geo, M) {
  const pos = geo.attributes.position, idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(M);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(M);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(M);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return area;
}

const pow2 = v => 2 ** Math.round(Math.log2(Math.max(1, v)));

// cache: { key, treated: Map<index, BufferGeometry> } — treatments are the slow
// part (drape smooths for dozens of iterations), so placement dials only re-project.
export function wrapModel({ base, renderer, arts, s, cache, preview = false }) {
  const report = { notes: new Set(), overlap: 0, baked: 0, parts: 0, tris: 0, textures: 0 };
  const root = SkeletonUtils.clone(base);
  root.updateMatrixWorld(true);
  const frame = modelFrame(root);
  const aniso = renderer.capabilities.getMaxAnisotropy();

  const tkey = `${s.treatment}|${s.amount}`;
  if (cache.key !== tkey) { cache.key = tkey; cache.treated = new Map(); }

  const meshes = [];
  root.traverse(o => { if (o.isMesh) meshes.push(o); });
  report.parts = meshes.length;

  // texture budget: bake sizes follow each part's share of the surface
  const wantsBake = s.bake || s.mode === 'triplanar';
  const areas = wantsBake ? meshes.map(m => worldArea(m.geometry, m.matrixWorld)) : [];
  const total = areas.reduce((x, y) => x + y, 0) || 1;
  const budget = preview ? Math.min(512, s.size) : s.size;

  const drapedObjs = [];
  meshes.forEach((obj, i) => {
    obj.userData.mtIndex = i;
    const ai = s.partArt && s.partArt.has(i) ? s.partArt.get(i) : s.artIndex;
    const art = arts[ai];
    if (ai < 0 || !art) { report.tris += triCount(obj.geometry); return; } // this part keeps its own material

    let treated = cache.treated.get(i);
    if (!treated) {
      treated = obj.geometry.clone();
      if (s.treatment === 'drape') treated = drape(treated, s.amount);
      else if (s.treatment === 'dissolve') treated = dissolveGeometry(treated, s.amount);
      cache.treated.set(i, treated);
    }
    let geo = treated.clone();
    const dissolving = s.treatment === 'dissolve';
    const artTex = dissolving ? dissolveTexOf(art, aniso) : art.tex;
    const orig = originalSurface(obj.material);
    let mode = s.mode;
    if (mode === 'view' && !s.view) report.notes.add('noview');
    const popts = { mode, axis: s.axis, fit: s.fit, aspect: art.aspect, place: s.place, view: s.view, flipV: s.flipV };

    let map = null, uvsKept = false, bakedCanvas = null;
    if (mode !== 'native' && wantsBake) {
      const ok = uvBakeable(geo, s.flipV);
      if (ok.ok) {
        if (s.flipV) {
          const uv = geo.attributes.uv;
          for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - uv.getY(k));
        }
        const { geo: pg } = project(geo.clone(), obj.matrixWorld, frame, popts, 'proj');
        const share = Math.sqrt((areas[i] || 0) / total);
        const size = Math.max(256, Math.min(budget, pow2(budget * share)));
        const mixOrig = orig && (s.blend !== 'replace' || s.mix < 1) && !s.flipV;
        const { canvas, overlap } = bakeMesh(renderer, pg, {
          size, art: artTex, triplanar: mode === 'triplanar',
          orig: mixOrig ? { map: orig.map, color: orig.color } : null,
          blend: s.blend, mix: s.mix, alpha: dissolving,
        });
        pg.dispose();
        if (overlap > 0.03) report.notes.add('overlap');
        report.overlap = Math.max(report.overlap, overlap);
        bakedCanvas = canvas;
        map = canvasTexture(canvas, { mime: dissolving ? 'image/png' : 'image/jpeg', anisotropy: aniso });
        map.userData.mtOwned = true;   // made for this wrap only: dispose it with the wrap
        map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
        uvsKept = true;
        report.baked++;
      } else {
        report.notes.add(ok.why);
        if (mode === 'triplanar') mode = 'box';
      }
    } else if (mode === 'triplanar') mode = 'box';

    if (!map) {
      const r = project(geo, obj.matrixWorld, frame, { ...popts, mode }, 'uv');
      geo = r.geo;
      if (mode === 'native' && !treated.attributes.uv) report.notes.add('nouv');
      // projection returns one vertex per corner; merge the corners that really are
      // identical (same position, uv and normal), which changes nothing visually
      if (!geo.index) {
        try {
          const before = geo.attributes.position.count;
          const m = mergeVertices(geo, 1e-6);
          if (m.attributes.position.count < before) geo = m;
        } catch (err) { /* keep the unindexed geometry */ }
      }
      map = artTex;
      uvsKept = mode === 'native' && !!treated.attributes.uv;
    }

    if (s.keep && !uvsKept) report.notes.add('keep');
    const keep = orig && (s.keep && uvsKept ? orig
      : { ...orig, normalMap: null, roughnessMap: null, metalnessMap: null, aoMap: null });

    let normalMap = null;
    if (s.impasto > 0) {
      if (bakedCanvas) {
        normalMap = canvasTexture(impastoNormal(bakedCanvas), { srgb: false, anisotropy: aniso });
        normalMap.userData.mtOwned = true;
        report.textures++;
      }
      else normalMap = impastoOf(art, aniso);
    }

    obj.geometry = geo;
    obj.material = makeSurface({
      finish: resolveFinish(s.finish, s.treatment), map, keep,
      normalMap, normalStrength: s.impasto * 1.6, alpha: dissolving,
    });
    if (bakedCanvas) report.textures++;
    report.tris += triCount(geo);
    if (s.treatment === 'drape') drapedObjs.push(obj);
  });

  // cords go on the largest draped mesh only: one bundle, not one per part
  if (drapedObjs.length) {
    let biggest = drapedObjs[0], bv = -1;
    for (const o of drapedObjs) {
      o.geometry.computeBoundingBox();
      const z = o.geometry.boundingBox.getSize(new THREE.Vector3());
      const v = z.x * z.y * z.z;
      if (v > bv) { bv = v; biggest = o; }
    }
    const cordMat = new THREE.MeshPhysicalMaterial({ color: 0x2d2b28, roughness: 0.9, sheen: 0.6, sheenRoughness: 0.7 });
    cordMat.name = 'MTexture_cord';
    cords(biggest.geometry).forEach((cg, k) => {
      const m = new THREE.Mesh(cg, cordMat);
      m.name = 'MTexture_cord_' + k;
      m.userData.mtCord = true;
      biggest.add(m);
    });
  }
  return { root, report, frame };
}

function triCount(geo) {
  return Math.floor((geo.index ? geo.index.count : geo.attributes.position.count) / 3);
}
