// tools/verify.mjs — wrap a set of models every way the app can, headless, and
// check every output loads back. Run before every release:
//
//   node tools/verify.mjs <outDir> <art.jpg> <model.glb> [model2.glb ...]
//
// ELECTRON=/path/to/electron overrides the binary (default: ./node_modules/.bin/electron).
// Writes <outDir>/<model>__<case>.png screenshots and a summary table.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [outDir, art, ...models] = process.argv.slice(2);
if (!outDir || !art || !models.length) {
  console.error('usage: node tools/verify.mjs <outDir> <art> <model> [model ...]');
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ELECTRON = process.env.ELECTRON || path.join(ROOT, 'node_modules/.bin/electron');
fs.mkdirSync(outDir, { recursive: true });

const CASES = (process.env.CASES ? process.env.CASES.split(',') : null);
const ALL = {
  native:      ['native', 'skin', {}],
  box:         ['box', 'skin', {}],
  tri:         ['triplanar', 'skin', {}],
  cyl:         ['cylinder', 'skin', {}],
  sphere:      ['sphere', 'skin', {}],
  planar:      ['planar', 'skin', {}],
  view:        ['view', 'skin', {}],
  boxbake:     ['box', 'skin', { bake: true, keep: true, finish: 'original' }],
  stain:       ['triplanar', 'skin', { blend: 'multiply', mix: 0.8, keep: true }],
  gloss:       ['cylinder', 'skin', { finish: 'gloss', impasto: 0.6, tiles: 2, rotate: 30 }],
  drape:       ['box', 'drape', {}],
  dissolve:    ['native', 'dissolve', {}],
  dissolvetri: ['triplanar', 'dissolve', {}],
  normalize:   ['planar', 'skin', { normalize: true, size: 1024 }],
};
const cases = Object.entries(ALL).filter(([k]) => !CASES || CASES.includes(k));

function run(model, [name, [mode, treatment, opts]]) {
  return new Promise(resolve => {
    const stem = path.basename(model).replace(/\.[^.]+$/, '');
    // each case gets its own copy so outputs never collide
    const dir = path.join(outDir, stem + '__' + name);
    fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, path.basename(model));
    if (!fs.existsSync(copy)) fs.copyFileSync(model, copy);
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.MTexture.glb')) fs.unlinkSync(path.join(dir, f));
    const shot = path.join(outDir, `${stem}__${name}.png`);
    const env = { ...process.env, MTEXTURE_SHOT: shot, MTEXTURE_OPTS: JSON.stringify(opts), MTEXTURE_DEBUG: path.join(dir, 'debug.txt') };
    const t0 = Date.now();
    const p = spawn(ELECTRON, [ROOT, '--test', copy, path.resolve(art), mode, treatment], { env });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    const timer = setTimeout(() => { p.kill('SIGKILL'); out += '\nTIMEOUT'; }, 90000);
    p.on('close', () => {
      clearTimeout(timer);
      const ok = /TEST_OK (.+)/.exec(out);
      const glb = ok ? ok[1].trim() : null;
      let note = '';
      if (glb && fs.existsSync(glb)) {
        const b = fs.readFileSync(glb);
        const jsonLen = b.readUInt32LE(12);
        const json = JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'));
        const ext = (json.extensionsUsed || []).join(',');
        note = `${(b.length / 1e6).toFixed(2)}MB meshes=${json.meshes.length} tex=${(json.textures || []).length}${ext ? ' ext=' + ext : ''}`;
      } else note = (out.match(/TEST_FAIL.*|TIMEOUT/) || ['no output'])[0];
      const dbg = fs.existsSync(env.MTEXTURE_DEBUG) ? fs.readFileSync(env.MTEXTURE_DEBUG, 'utf8').trim().split('\n').pop() : '';
      resolve({ model: stem, name, ok: !!glb, ms: Date.now() - t0, note, dbg });
    });
  });
}

const rows = [];
for (const m of models) for (const c of cases) {
  const r = await run(path.resolve(m), c);
  rows.push(r);
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.model.padEnd(18)} ${r.name.padEnd(12)} ${String(r.ms).padStart(6)}ms  ${r.note}`);
  if (r.dbg) console.log('     ' + r.dbg);
}
const failed = rows.filter(r => !r.ok).length;
console.log(failed ? `VERIFY FAILED: ${failed} of ${rows.length}` : `VERIFY OK: ${rows.length} wraps`);
process.exit(failed ? 1 : 0);
