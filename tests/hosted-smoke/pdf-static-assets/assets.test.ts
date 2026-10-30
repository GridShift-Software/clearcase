import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOSTED_PDF_PACKAGE_DIGEST, HOSTED_PDF_READER_DIGEST, parsePdfAssetArgs, patchPdfWorker, prepareHostedPdfAssets } from '../../../scripts/hosted-pdf-assets.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const reader = 'src/lib/viewer/hosted/static/pdf-reader.mjs';
let scratch: string, root: string, publicRoot: string, pkg: string;
function put(path: string, bytes: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
function prepare() { return prepareHostedPdfAssets({ root, publicRoot }); }
function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name), prefix + e.name + '/') : [prefix + e.name]).sort();
}
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'clearcase-pdf-assets-'));
  root = join(scratch, 'source'); publicRoot = join(scratch, 'public'); pkg = join(root, 'node_modules/pdfjs-dist');
  mkdirSync(publicRoot); mkdirSync(pkg, { recursive: true });
  cpSync(join(repo, 'package.json'), join(root, 'package.json'));
  for (const path of ['package.json', 'LICENSE', 'build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'standard_fonts', 'cmaps', 'iccs', 'wasm']) {
    const target = join(pkg, path); mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repo, 'node_modules/pdfjs-dist', path), target, { recursive: true });
  }
  mkdirSync(dirname(join(root, reader)), { recursive: true });
  cpSync(join(repo, reader), join(root, reader));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('deterministic public PDF asset preparation', () => {
  it('copies exactly the required pinned bytes and emits a sorted, independently checked inventory', () => {
    // Decoys must not be copied or evaluated.
    for (const path of ['build/pdf.min.mjs.map', 'build/pdf.sandbox.min.mjs', 'wasm/private.wasm', 'lib/server.js']) put(join(pkg, path), 'throw new Error("must never run")');
    put(join(publicRoot, 'unrelated.txt'), 'keep');
    const inventory = prepare();
    expect(inventory.packageDigest).toBe(HOSTED_PDF_PACKAGE_DIGEST);
    expect(inventory.readerDigest).toBe(HOSTED_PDF_READER_DIGEST);
    expect(inventory.pdfjsVersion).toBe('6.4.299');
    expect(inventory.files).toHaveLength(198);
    // The viewer's image decoders are their plain-JS builds; no .wasm file is served.
    expect(inventory.files.filter(f => f.path.startsWith('pdfjs/wasm/')).map(f => f.path)).toEqual(['LICENSE_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_JBIG2', 'LICENSE_PDFJS_OPENJPEG', 'jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js'].map(n => 'pdfjs/wasm/' + n));
    expect(walk(join(publicRoot, 'pdfjs')).map(p => 'pdfjs/' + p)).toEqual(inventory.files.map(f => f.path));
    for (const f of inventory.files) {
      const bytes = readFileSync(join(publicRoot, f.path));
      expect(f.bytes).toBe(bytes.length);
      expect(f.sha256).toBe('sha256:' + createHash('sha256').update(bytes).digest('hex'));
      const path = f.path.slice('pdfjs/'.length);
      if (path === 'pdf-viewer-worker.mjs') { expect(bytes.equals(patchPdfWorker(readFileSync(join(pkg, 'build/pdf.worker.min.mjs'))))).toBe(true); continue; }
      const source = path === 'pdf-reader.mjs' ? join(root, reader) : join(pkg, path.startsWith('pdf.') ? 'build/' + path : path);
      expect(bytes.equals(readFileSync(source))).toBe(true);
    }
    expect(readFileSync(join(publicRoot, 'unrelated.txt'), 'utf8')).toBe('keep');
    const other = join(scratch, 'other'); mkdirSync(other);
    expect(prepareHostedPdfAssets({ root, publicRoot: other })).toEqual(inventory);
    const source = readFileSync(join(publicRoot, 'pdfjs/pdf-reader.mjs'), 'utf8');
    for (const ref of ['./pdf.min.mjs', './pdf-viewer-worker.mjs', 'standard_fonts/', 'cmaps/', 'iccs/', 'wasm/']) expect(source).toContain(ref);
  });

  for (const path of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE', 'cmaps/78-EUC-H.bcmap', 'standard_fonts/FoxitFixed.pfb', 'iccs/CGATS001Compat-v2-micro.icc', 'wasm/jbig2_nowasm_fallback.js']) {
    it('rejects missing input ' + path + ' before writing output', () => {
      rmSync(join(pkg, path));
      expect(prepare).toThrow(); expect(existsSync(join(publicRoot, 'pdfjs'))).toBe(false);
    });
    it('rejects changed bytes ' + path, () => {
      writeFileSync(join(pkg, path), 'tampered');
      expect(prepare).toThrow(/mismatch/); expect(existsSync(join(publicRoot, 'pdfjs'))).toBe(false);
    });
  }
  it('rejects a same-bytes resource rename (path binding)', () => {
    renameSync(join(pkg, 'cmaps/78-EUC-H.bcmap'), join(pkg, 'cmaps/renamed.bcmap'));
    expect(prepare).toThrow(/path\+bytes mismatch/);
  });
  it('rejects extra maps, private modules and nested directories in resource roots', () => {
    for (const path of ['cmaps/extra.map', 'standard_fonts/private.server.js', 'iccs/nested']) {
      if (path.endsWith('nested')) mkdirSync(join(pkg, path)); else put(join(pkg, path), 'private');
      expect(prepare).toThrow(); rmSync(join(pkg, path), { recursive: true });
    }
    expect(existsSync(join(publicRoot, 'pdfjs'))).toBe(false);
  });
  it('rejects a changed or missing reviewed reader', () => {
    writeFileSync(join(root, reader), 'changed'); expect(prepare).toThrow(/reader bytes mismatch/);
    rmSync(join(root, reader)); expect(prepare).toThrow();
  });
  it('rejects wrong declared pin or installed package identity/version', () => {
    put(join(root, 'package.json'), '{"devDependencies":{"pdfjs-dist":"^6.4.299"}}');
    expect(prepare).toThrow(/exact pin/);
    cpSync(join(repo, 'package.json'), join(root, 'package.json'));
    for (const metadata of [{ name: 'other', version: '6.4.299' }, { name: 'pdfjs-dist', version: '6.4.298' }, {}]) {
      put(join(pkg, 'package.json'), JSON.stringify(metadata)); expect(prepare).toThrow(/exact pin/);
    }
  });
  it('rejects input file and ancestor symlinks even with identical trusted bytes', () => {
    for (const path of [join(pkg, 'build/pdf.min.mjs'), join(pkg, 'cmaps'), pkg, join(root, reader)]) {
      const moved = path + '-real'; renameSync(path, moved); symlinkSync(moved, path);
      expect(prepare).toThrow(/symlink refused/);
      rmSync(path); renameSync(moved, path);
    }
    expect(existsSync(join(publicRoot, 'pdfjs'))).toBe(false);
  });
  it('refuses existing output without deleting it, including a symlink', () => {
    mkdirSync(join(publicRoot, 'pdfjs')); put(join(publicRoot, 'pdfjs/keep'), 'keep');
    expect(prepare).toThrow(); expect(readFileSync(join(publicRoot, 'pdfjs/keep'), 'utf8')).toBe('keep');
    rmSync(join(publicRoot, 'pdfjs'), { recursive: true }); symlinkSync(pkg, join(publicRoot, 'pdfjs'));
    expect(prepare).toThrow(); expect(existsSync(join(pkg, 'LICENSE'))).toBe(true);
  });
  it('rejects symlinked public roots or ancestors and missing public roots', () => {
    const alias = join(scratch, 'alias'); symlinkSync(publicRoot, alias);
    expect(() => prepareHostedPdfAssets({ root, publicRoot: alias })).toThrow(/symlink/);
    mkdirSync(join(publicRoot, 'child'));
    expect(() => prepareHostedPdfAssets({ root, publicRoot: join(alias, 'child') })).toThrow(/symlink/);
    expect(() => prepareHostedPdfAssets({ root, publicRoot: join(scratch, 'absent') })).toThrow();
  });
  it('accepts only explicit nonduplicated CLI paths', () => {
    expect(parsePdfAssetArgs(['--root', '.', '--public-root', 'out'])).toEqual({ root: resolve('.'), publicRoot: resolve('out') });
    for (const args of [[], ['--root', '.'], ['--root', '.', '--root', 'x'], ['--root', '.', '--out', 'x'], ['--root', '.', '--public-root', '--bad']]) expect(parsePdfAssetArgs(args)).toBeNull();
  });
});
