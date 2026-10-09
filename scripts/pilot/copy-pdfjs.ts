#!/usr/bin/env bun
// Postbuild: bundle the pinned pdf.js and our viewer into build/pdfjs/ (served ONLY by the originals listener), and
// stamp build/clearcase-build.json with the source revision the build was made from (read by the live doctor), and
// replace adapter-node's build/index.js, which binds 0.0.0.0 unless HOST is set and skips the exact-Host check, with
// a stub that refuses to start: scripts/pilot/start.ts is the only supported entry.
// The pdf.js scripting sandbox (pdf.sandbox*.mjs), its QuickJS evaluator and the wasm binaries are NOT copied.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const build = join(root, 'build');
const out = join(build, 'pdfjs');
if (!existsSync(join(build, 'handler.js'))) throw new Error('build/handler.js is missing: run vite build first');
const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version as string;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copy = (from: string, to = from) => cpSync(join(src, from), join(out, to), { recursive: true });
copy('build/pdf.min.mjs', 'pdf.min.mjs');
copy('build/pdf.worker.min.mjs', 'pdf.worker.min.mjs');
copy('web/pdf_viewer.css', 'pdf_viewer.css');
copy('web/images', 'images');
copy('standard_fonts');
copy('cmaps');
copy('iccs');
mkdirSync(join(out, 'wasm'));
for (const f of ['openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js']) copy(`wasm/${f}`, `wasm/${f}`);
copy('LICENSE', 'LICENSE');
const viewer = join(root, 'src', 'lib', 'local-case', 'viewer');
for (const f of ['viewer.mjs', 'viewer.css', 'wrapper.mjs', 'frame.html']) cpSync(join(viewer, f), join(out, f));

writeFileSync(join(build, 'index.js'), `// Not a ClearCase entry: start the pilot with \`bun run --bun start\` (scripts/pilot/start.ts).
console.error('FATAL: build/index.js is not a supported ClearCase entry (it would listen on every network interface). Start the pilot with \`bun run --bun start\` (scripts/pilot/start.ts), which listens on 127.0.0.1 only.');
process.exit(1);
`);

const files: Record<string, string> = {};
const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files[relative(out, p)] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
walk(out);
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ pdfjsVersion: version, files }, null, 1));

const git = (...a: string[]) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
// An isolated build from `git archive` has no .git: its caller names the revision it exported.
const exported = process.env.CLEARCASE_SOURCE_REVISION ?? null;
const stamp = { revision: exported ?? git('rev-parse', 'HEAD'), dirty: exported ? false : git('status', '--porcelain', '--untracked-files=no') !== '', exported: exported !== null, builtAt: new Date().toISOString(), bun: process.versions.bun ?? null, pdfjs: version, buildId: createHash('sha256').update(readFileSync(join(build, 'handler.js'))).digest('hex').slice(0, 16) };
writeFileSync(join(build, 'clearcase-build.json'), JSON.stringify(stamp, null, 1) + '\n');
console.log(`pdf.js ${version} bundled: ${Object.keys(files).length} files -> ${relative(root, out)}; build ${stamp.buildId} from ${stamp.revision?.slice(0, 12) ?? 'unknown'}${stamp.dirty ? ' (dirty)' : ''}`);
