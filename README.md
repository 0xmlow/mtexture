# ~M.Texture~

Wrap your 3D assets in your 2D art. An MLow tool.

Drop or pick a 3D model and a piece of art; ~M.Texture~ retextures every mesh with the art,
shows a live preview, and writes a new `.glb` next to the original model.

## Use it in the browser

**https://0xmlow.github.io/mtexture/**: the same tool, nothing to install. Drop a model and
your art; it wraps them and downloads the new `.glb`. Files never leave your computer.
For a `.gltf`, drop its `.bin` and texture files in the same drop. Changing the projection,
treatment or dials re-wraps the preview; hit SPIT IT OUT to download that version.
HEIC art works in Safari; elsewhere, export it as JPG or PNG first.

The web build lives in `docs/` (GitHub Pages serves it from there). It shares `wraplab.js`
with the desktop app; `docs/renderer.js` is the desktop renderer with browser file handling,
so a change to the wrap engine in `renderer.js` needs copying across.

## Run it

**From source:**

```bash
npm install
npm start
```

**As a Mac app:** build it once, then double-click the result (it is fully standalone and can live in /Applications or the Dock):

```bash
npm install
npx electron-packager . "M.Texture" --out=dist --overwrite --icon=assets/icon.icns --prune
codesign --force --deep -s - "dist/M.Texture-darwin-arm64/M.Texture.app"
```

## Use it

1. Add a 3D model: `.glb`, `.gltf`, or `.fbx`. Drag it anywhere into the window, or click the MODEL slot to browse.
2. Add your art: `.jpg`, `.jpeg`, `.png`, `.heic`, or `.webp`. Drag or click the ART slot.
3. Pick a PROJECTION and a TREATMENT. It wraps, previews, and spits the new asset out
   automatically, in the same folder as the original model.

Output name: `{model}__wrapped-in__{art}.MTexture.glb`, with `__drape` or `__dissolve`
appended when the treatment is not SKIN. It never overwrites a file it did not create this
session; it adds `-2`, `-3`, and so on instead.

Both files can go in as one drop. Drop or pick a new model or new art any time to re-wrap.

## Projection — how the art maps onto the surface

- **NATIVE**: uses the model's own UV layout (best when the model was unwrapped properly). Meshes with no UVs fall back to box projection.
- **BOX**: projects the art onto the model from all six sides. Good for hard-surface pieces.
- **SPHERE**: wraps the art around the model like a globe. Good for organic or round pieces.
- **CYLINDER**: wraps it around the vertical axis like a label. No seams down the sides —
  best for bottles, vases, lanterns, anything turned on a lathe.
- **PLANAR**: one flat projection down the model's thinnest axis. The whole painting lands
  once, unbroken, like a poster pressed onto the form. The most legible option when the
  art itself must stay readable.

**Box projection picks its axis per triangle, from the face normal.** On a dense scan,
neighbouring triangles land on different axes and the surface breaks into a patchwork of
scales. The app warns you when the mesh is dense enough for this to bite; reach for
CYLINDER, PLANAR or NATIVE there.

## Treatment — what happens to the object itself

- **SKIN**: the art on the object, form untouched. The original behaviour.
- **DRAPE**: Christo, in software. The surface is inflated slightly and then smoothed hard
  so it spans its own hollows the way cloth does, wrinkled with low-frequency noise, and
  cinched with cords traced around the widest points of the draped silhouette.
- **DISSOLVE**: the painting stops sitting on the object and starts eating it. The form
  sags under large-scale noise, and the artwork's own dark passages are clipped out of the
  surface — a fixed 24% of it, so a whole series loses the same fraction no matter how
  dark or light each painting happens to be.

Two dials: **TILES** repeats the art across the surface, **AMOUNT** scales how far the
treatment goes.

Treatments run *before* projection, so the art describes the final draped or melted form
rather than the shape it started as.

## Notes

- FBX in, GLB out: everything exports as `.glb` since it is the portable standard (OpenSea, Blender, three.js, Spline all read it).
- HEIC images are converted through macOS `sips` automatically (macOS only).
- Animations are carried through when the exporter can keep them.
- Compressed GLBs (Draco, Meshopt) load fine.
- **Everything survives export.** No treatment uses a custom shader, because GLTFExporter
  cannot carry one. DISSOLVE bakes its erosion into the alpha channel of the base colour
  texture, which glTF reads as `alphaMode: MASK` — glTF has no separate alpha map.
- **Textures export as JPEG** (quality 0.92) rather than PNG — a 2048px painting is
  ~400KB instead of ~8MB, with nothing visible lost. The DISSOLVE texture stays PNG
  because its erosion lives in the alpha channel.
- **Projected geometry is re-indexed before export.** Projection has to un-index a mesh
  to give each triangle its own UVs; merging back the corners that really are identical
  roughly halves the file and changes nothing on screen.
- Headless smoke test: `npx electron . --test <model> <art> [native|box|sphere|cylinder|planar] [skin|drape|dissolve]`;
  set `MTEXTURE_SHOT=/path.png` to capture a screenshot, and `MTEXTURE_DEBUG=/path.txt` to
  log per-mesh vertex counts, index state and NaN checks after treatment.

## Batch

Wrapping a few hundred assets one process at a time is mostly Electron startup. Batch
mode does the lot in a single process — 300 assets in about 70 seconds.

```bash
npx electron . --batch jobs.json
```

`jobs.json` is an array of jobs. Only `model`, `art` and `out` are required:

```json
[{"model": "/path/model.glb", "art": "/path/painting.jpg",
  "projection": "box", "treatment": "skin",
  "tiles": 1, "amount": 1,
  "out": "/path/out.glb", "name": "label for the log"}]
```

It prints `OK`/`SKIP`/`FAIL` per job and `BATCH_DONE <n> ok, <n> failed, <n>s` at the end.
An output that already exists is skipped, so a stopped run resumes where it left off.

## Stack and credits

Electron + [three.js](https://threejs.org/) (GLTFLoader, FBXLoader, GLTFExporter). Display face is [Syne](https://fonts.google.com/specimen/Syne) (SIL Open Font License), bundled in `assets/fonts/`. Logo, evil eye, and blossom marks are MLow brand assets.

## Implementation note, for whoever touches `wraplab.js` next

Deformation adjacency is built from **position**, never from the index. `mergeVertices()`
compares every attribute, so a mesh carrying per-triangle projected UVs merges nothing —
each triangle stays its own island, and "smoothing" blows the model apart into loose
confetti. Co-located vertices are grouped and moved together instead, which keeps the
surface watertight while leaving the UV layout untouched.
