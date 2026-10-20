// Bundle the renderers with Bun (browser target, ESM, minified) into .local/viewer-evaluation/www, copy the pdf.js
// runtime assets, and measure each library's gzip transfer bytes from a one-import bundle of the pinned package.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { HERE, OUT_ROOT } from './paths.mjs';

const WWW = path.join(OUT_ROOT, 'www');
const NM = path.join(HERE, 'node_modules');
rmSync(WWW, { recursive: true, force: true });
mkdirSync(path.join(WWW, 'r'), { recursive: true });

const renderers = readdirSync(path.join(HERE, 'harness', 'renderers')).filter((f) => f.endsWith('.mjs') && f !== 'common.mjs');
const built = await Bun.build({ entrypoints: [...renderers.map((f) => path.join(HERE, 'harness', 'renderers', f)), path.join(HERE, 'harness', 'shell', 'shell.mjs')], outdir: path.join(WWW, 'r'), naming: { entry: '[name].[ext]' }, target: 'browser', format: 'esm', minify: true, splitting: false, define: { 'process.env.NODE_ENV': '"production"' } });
if (!built.success) { for (const l of built.logs) console.error(l); process.exit(1); }
cpSync(path.join(HERE, 'harness', 'shell', 'shell.html'), path.join(WWW, 'shell.html'));
cpSync(path.join(HERE, 'harness', 'renderers', 'renderer.css'), path.join(WWW, 'r', 'renderer.css'));
const PDF = path.join(NM, 'pdfjs-dist');
mkdirSync(path.join(WWW, 'vendor', 'pdfjs'), { recursive: true });
for (const f of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'web/pdf_viewer.css']) cpSync(path.join(PDF, f), path.join(WWW, 'vendor', 'pdfjs', path.basename(f)));
for (const d of ['cmaps', 'standard_fonts']) cpSync(path.join(PDF, d), path.join(WWW, 'vendor', 'pdfjs', d), { recursive: true });
cpSync(path.join(NM, 'tabulator-tables', 'dist', 'css', 'tabulator.min.css'), path.join(WWW, 'vendor', 'tabulator.min.css'));

// ---- library transfer sizes: each pinned package alone, bundled the way a lazy per-format chunk would ship ----
const gz = (b) => gzipSync(b, { level: 9 }).length;
const dirBytes = (d) => readdirSync(d, { recursive: true }).map((f) => path.join(d, f)).filter((f) => statSync(f).isFile()).reduce((n, f) => ({ raw: n.raw + statSync(f).size, gzip: n.gzip + gz(readFileSync(f)) }), { raw: 0, gzip: 0 });
const probe = path.join(OUT_ROOT, 'size-probe');
rmSync(probe, { recursive: true, force: true });
mkdirSync(probe, { recursive: true });
symlinkSync(NM, path.join(probe, 'node_modules'), 'dir'); // the one-import entries live in the ignored probe dir and resolve packages through this link
const LIBS = {
  'docx-preview': "import * as m from 'docx-preview'; globalThis.m = m;",
  xlsx: "import * as m from 'xlsx'; globalThis.m = m;",
  'tabulator-tables': "import { TabulatorFull } from 'tabulator-tables'; globalThis.m = TabulatorFull;",
  'postal-mime': "import m from 'postal-mime'; globalThis.m = m;",
  '@kenjiuno/msgreader': "import m from '@kenjiuno/msgreader'; import { Buffer } from 'buffer'; globalThis.Buffer = Buffer; globalThis.m = m;",
  dompurify: "import m from 'dompurify'; globalThis.m = m;",
  fflate: "import { Unzip, UnzipInflate, Inflate } from 'fflate'; globalThis.m = [Unzip, UnzipInflate, Inflate];",
};
const sizes = {};
for (const [name, src] of Object.entries(LIBS)) {
  const entry = path.join(probe, `size-${name.replace(/\W/g, '_')}.mjs`);
  writeFileSync(entry, src);
  try {
    const r = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
    if (!r.success) throw new Error(r.logs.join('\n'));
    const js = new Uint8Array(await r.outputs[0].arrayBuffer());
    const version = JSON.parse(readFileSync(path.join(NM, name, 'package.json'), 'utf8')).version;
    sizes[name] = { version, rawBytes: js.length, gzipBytes: gz(js) };
  } finally { rmSync(entry, { force: true }); }
}
const tabCss = readFileSync(path.join(NM, 'tabulator-tables', 'dist', 'css', 'tabulator.min.css'));
sizes['tabulator-tables'].cssGzipBytes = gz(tabCss);
const pdfCore = ['pdf.min.mjs', 'pdf.worker.min.mjs'].map((f) => readFileSync(path.join(PDF, 'build', f)));
sizes['pdfjs-dist'] = {
  version: JSON.parse(readFileSync(path.join(PDF, 'package.json'), 'utf8')).version,
  rawBytes: pdfCore.reduce((n, b) => n + b.length, 0), gzipBytes: pdfCore.reduce((n, b) => n + gz(b), 0),
  cmapsGzipBytes: dirBytes(path.join(PDF, 'cmaps')).gzip, standardFontsGzipBytes: dirBytes(path.join(PDF, 'standard_fonts')).gzip,
  cssGzipBytes: gz(readFileSync(path.join(PDF, 'web', 'pdf_viewer.css'))),
};
const rendererSizes = Object.fromEntries(readdirSync(path.join(WWW, 'r')).filter((f) => f.endsWith('.js')).map((f) => { const b = readFileSync(path.join(WWW, 'r', f)); return [f, { rawBytes: b.length, gzipBytes: gz(b) }]; }));
writeFileSync(path.join(OUT_ROOT, 'sizes.json'), JSON.stringify({ bun: Bun.version, libraries: sizes, renderers: rendererSizes }, null, 1));
rmSync(probe, { recursive: true, force: true });
console.log(`built ${renderers.length} renderers into ${WWW}`);
for (const [k, v] of Object.entries(sizes)) console.log(`${k}@${v.version}: ${v.gzipBytes} B gzip`);
