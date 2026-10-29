# ~M.Texture~

Wrap your 3D assets in your 2D art. An MLow tool.

Drop or pick a 3D model and a piece of art; ~M.Texture~ retextures every mesh with the art,
shows a live preview, and writes a new `.glb` next to the original model.

## What's new in v3

Everything learned from three months of building 3D worlds went back into the tool.

- **One painting across the whole model.** Projections run in model space, not per
  part. A lantern's post, chain and cage used to get three paintings at three scales;
  now one painting runs across all of them at one density.
- **BOX no longer shatters dense scans.** It picks its axis per *region*: normals are
  smoothed over the mesh and each triangle follows a majority vote of its corners. It
  also reads the right way round on every face (v2 mirrored the back, left and bottom).
- **TRI (triplanar)**: three projections blended softly, baked into the model's own UVs.
  The answer to box seams on organic forms.
- **VIEW**: a projector at the camera. Orbit to an angle, hit AIM, and the painting lands
  whole and upright on whatever you were looking at.
- **True proportions.** Paintings keep their aspect ratio instead of being squeezed to
  the bounding box. CYL wraps a whole number of times so it stays seamless, and its seam
  sits at the back. The old stretch is one click away.
- **Placement dials**: TILES (scales about the centre), TURN, SHIFT. They preview live.
- **BAKE into the model's own UVs** on the GPU, with island dilation so mipmaps never
  bleed. The mesh stays whole, its relief maps still line up, and the art can be mixed
  into the original surface (REPLACE, STAIN, OVERLAY, MIX). Overlapping (mirrored) UVs
  are detected and flagged.
- **Surfaces**: MATTE, SATIN, GLOSS (clearcoat), METAL, FABRIC (sheen), AS IS. IMPASTO
  raises the painting's own brushwork into a normal map. KEEP ORIGINAL RELIEF MAPS keeps
  the model's normal and occlusion maps under the art. All of it exports as standard glTF
  (KHR_materials_clearcoat, KHR_materials_sheen).
- **Parts.** Drop up to six pieces of art. Click any part of the model to cycle it through
  them and finally back to its ORIGINAL material (keep the glass of a lantern as glass).
- **DRAPE and DISSOLVE, fixed.** Long edges are subdivided first (a box with eight corners
  cannot bend), DRAPE smooths with Taubin passes that do not shrink (v2 collapsed thin
  parts to nothing) and pins open edges, and DISSOLVE melts through one smooth field so a
  bottle cap no longer floats off its bottle.
- **Viewport**: Khronos PBR Neutral tone mapping (keeps the painting's colours), a soft key
  shadow and contact shadow, hold SPACE or BEFORE to compare with the original, SPIN.
- **Export**: texture size cap (1K, 2K, 4K), NORMALIZE (1 m, on the floor, centred), a
  transparent PNG snapshot, and the settings written into the file under
  `extras.mtexture` so every output says how it was made.
- **One codebase.** `docs/` is the app for both the browser and the desktop. The desktop
  loads three from `node_modules` (works offline), the browser from a CDN. The engine can
  no longer drift between the two.

## Use it in the browser

**https://0xmlow.github.io/mtexture/**: the same tool, nothing to install. Drop a model and
your art; it wraps them, and SPIT IT OUT downloads the new `.glb`. Files never leave your
computer. For a `.gltf`, drop its `.bin` and texture files in the same drop. HEIC art works
in Safari; elsewhere, export it as JPG or PNG first.

## Run it

**From source:**

```bash
npm install
npm start
```

**As a Mac app:** build it once, then double-click the result:

```bash
npm install
npx @electron/packager . "M.Texture" --out=dist --overwrite --prune
codesign --force --deep -s - "dist/M.Texture-darwin-arm64/M.Texture.app"
```

`electron` must stay in devDependencies or `--prune` bundles the whole runtime. Packager's
`--icon` does nothing here; copy `assets/icon.icns` over `Contents/Resources/electron.icns`
and sign again.

## Use it

1. Add a 3D model (`.glb`, `.gltf`, `.fbx`) and one or more pieces of art (`.jpg`, `.png`,
   `.heic`, `.webp`). Drag them anywhere into the window, or click a slot.
2. Pick a PROJECTION and a TREATMENT, then dress it: placement, surface, bake.
3. Click parts of the model to give them different art, or their original material.
4. On the desktop every settled change is saved next to the model (turn that off under
   EXPORT); in the browser, SPIT IT OUT downloads.

Output name: `{model}__wrapped-in__{art}.MTexture.glb`, with `__drape` or `__dissolve`
appended when the treatment is not SKIN. It never overwrites a file it did not create this
session; it adds `-2`, `-3`, and so on instead.

## Projection: how the art maps onto the surface

- **NATIVE**: the model's own UV layout. Meshes with no UVs fall back to BOX.
- **BOX**: six sides, the axis chosen by region. Good for hard-surface pieces.
- **TRI**: three sides blended, baked into the model's UVs. Best on scans and organic forms.
  Needs a UV layout; without one it falls back to BOX and says so.
- **CYL**: a label round the vertical axis. Bottles, vases, lanterns.
- **SPHERE**: a globe. Wide (2:1) art reads best.
- **PLANAR**: one flat projection, the whole painting once. AUTO goes down the thinnest
  axis; FRONT, SIDE and TOP choose. The most legible option when the art must stay readable.
- **VIEW**: a projector at the camera. AIM FROM HERE re-aims it.

## Treatment: what happens to the object itself

- **SKIN**: the art on the object, form untouched.
- **DRAPE**: Christo, in software. The surface is subdivided, inflated slightly, smoothed
  hard so it spans its own hollows the way cloth does, wrinkled with low-frequency noise,
  and cinched with cords traced round the widest points. Finishes as FABRIC by default.
- **DISSOLVE**: the painting eats the object. The form sags (the top more than the base)
  and the artwork's dark passages are clipped out of the surface: a fixed 24% of it, so a
  whole series loses the same fraction however dark each painting is.

AMOUNT scales how far the treatment goes. Treatments run *before* projection, so the art
describes the final draped or melted form.

## Notes

- FBX in, GLB out. HEIC is converted through macOS `sips` on the desktop.
- Animations are carried through when the exporter can keep them, and play in the preview.
- Compressed GLBs (Draco, Meshopt, KTX2) load fine.
- **Everything survives export.** No custom shaders reach the file: GLTFExporter cannot
  carry one. The GPU bake writes an ordinary texture. DISSOLVE's erosion lives in the alpha
  channel of the base colour (glTF has no alpha map), exported as `alphaMode: MASK`.
- **Textures export as JPEG** (q 0.92) except where alpha matters. Projected geometry is
  re-indexed before export.
- **Baked files are bigger** when KEEP ORIGINAL RELIEF MAPS or STAIN carries the model's own
  textures along. Use the 1K or 2K cap for distribution.

## Testing

```bash
npx electron . --test <model> <art> [native|box|triplanar|cylinder|sphere|planar|view] [skin|drape|dissolve]
```

`MTEXTURE_SHOT=/path.png` saves a screenshot, `MTEXTURE_DEBUG=/path.txt` logs each wrap,
and `MTEXTURE_OPTS='{"bake":true,"finish":"gloss"}'` passes any batch job field.

`node tools/verify.mjs <outDir> <art> <model> [model ...]` runs fourteen cases per model
(every projection, bake, stain, gloss and impasto, both treatments, normalize), checks
every output parses, and saves a screenshot of each. `CASES=box,tri` narrows it.

## Batch

```bash
npx electron . --batch jobs.json
```

`jobs.json` is an array of jobs. Only `model`, `art` and `out` are required:

```json
[{"model": "/path/model.glb", "art": "/path/painting.jpg", "out": "/path/out.glb",
  "projection": "box", "treatment": "skin", "tiles": 1, "amount": 1,
  "fit": "true", "axis": "auto", "rotate": 0, "offsetU": 0, "offsetV": 0,
  "finish": "auto", "impasto": 0, "keep": false,
  "bake": false, "blend": "replace", "mix": 1,
  "size": 2048, "normalize": false, "name": "label for the log"}]
```

It prints `OK`/`SKIP`/`FAIL` per job and `BATCH_DONE` at the end. An output that already
exists is skipped, so a stopped run resumes. v3 defaults differ from v2 (true proportions,
one painting per model): add `"fit": "stretch"` to get closer to old batches.

## Layout

```
main.js            Electron shell: window, file dialogs, --test and --batch
docs/index.html    the page (browser and desktop)
docs/app.js        viewport, controls, parts, hooks
docs/platform.js   the only file that knows browser from desktop
docs/engine/       the wrap: project.js, bake.js, surface.js, wraplab.js, wrap.js, glb.js
tools/verify.mjs   the headless test matrix
```

## Stack and credits

Electron + [three.js](https://threejs.org/) 0.185. Display face is
[Syne](https://fonts.google.com/specimen/Syne) (SIL Open Font License). Logo, evil eye and
blossom marks are MLow brand assets.

## Implementation notes, for whoever touches the engine next

- Deformation adjacency is built from **position**, never from the index. `mergeVertices()`
  compares every attribute, so a mesh carrying per-triangle UVs merges nothing and smoothing
  blows it into confetti.
- Read quantised attributes with `getX`..`getW`, never `getComponent` (raw ints).
- The bake encodes coverage in alpha (covered texels 0.5..1, empty 0) so dilation can tell
  them apart and the dissolve mask survives it.
- The browser pane in the Claude app can show stale frames; check state through
  `window.__mt` before trusting a screenshot.
