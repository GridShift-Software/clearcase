// GRS-45 (BASE-R3): bundle, index, extract, part and schedule files outside the document register are package
// assets under a non-ref key P-<sha256(path)[:16]>, verified at import like every original. Synthetic data only.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertV5, importCandidate, readCandidate, type ImportResult } from '../../src/lib/case-package/index.ts';
import { pathAssetKey, sha256Hex } from '../../src/lib/case-package/hash.ts';
import { isAssetKey, isPathKey, isRef } from '../../src/lib/case-package/refs.ts';
import { buildSynth, editPackage, type Built } from './fixtures/build.ts';
import { cleanup } from './fixtures/synth.ts';

const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });
const codes = (r: ImportResult) => r.diagnostics.map((d) => d.code);
const errors = (r: ImportResult) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const url = (p: string) => './' + p.split('/').map(encodeURIComponent).join('/');
const pdf = (s: string) => new TextEncoder().encode(`%PDF-1.4\n% ${s}\n%%EOF\n`);

const ON_DISK = {
  'BUNDLES/Bundle C.pdf': pdf('invented bundle'),
  'BUNDLES/Index C.pdf': pdf('invented index'),
  // byte-identical to the register original OD-001 (an extract of a whole document)
  'BUNDLES/extracts/Item 1.pdf': pdf('synthetic agreement'),
  'SOURCES/Part one.pdf': pdf('invented part'),
  'SOURCES/Schedule file.pdf': pdf('invented schedule file'),
};

/** A synthetic case whose bundle and schedule locators name files outside the register, on disk or not. */
async function packageFiles(tag: string): Promise<Built> {
  const b = await buildSynth(tag, (r) => {
    const bundles = r.DATA.bundles as any;
    bundles.caselinesSrc = url('SOURCES/Part one.pdf');
    bundles.list.push({
      ...bundles.list[0], no: '3', name: 'Bundle C', file: url('BUNDLES/Bundle C.pdf'), indexFile: url('BUNDLES/Index C.pdf'),
      rows: [
        { key: 'OD-1', n: 1, desc: 'Invented', from: 1, to: 2, pages: 2, sliceUrl: url('BUNDLES/extracts/Item 1.pdf'), parts: [{ url: url('SOURCES/Part one.pdf') + '#page=2', name: 'Part one.pdf', rel: 'Part one.pdf', from: 2, to: 3 }] },
        // a register path, a missing file, a folder and an unsafe locator are not package files
        { key: 'OD-2', n: 2, desc: 'Invented', from: 3, to: 3, pages: 1, sliceUrl: url('BUNDLES/extracts/Gone.pdf'), parts: [{ url: url('DISCOVERY A/OD-001 Supply agreement.pdf'), name: 'x', rel: 'x', from: 1, to: 1 }, { url: './SOURCES/', name: 'folder', rel: 'folder', from: 1, to: 1 }] },
      ],
    });
    (r.SCHED as any).discovery.push({ no: 2, date: '', desc: 'Invented', co: 'C', nfiles: 2, files: [{ fn: 'Schedule file.pdf', url: url('SOURCES/Schedule file.pdf'), co: 'C' }, { fn: 'again', url: url('BUNDLES/Bundle C.pdf'), co: 'C' }] });
  });
  roots.push(b.root);
  for (const [p, bytes] of Object.entries(ON_DISK)) {
    await mkdir(path.dirname(path.join(b.caseDir, p)), { recursive: true });
    await writeFile(path.join(b.caseDir, p), bytes);
  }
  // the files are created after the first conversion, so convert again to index them
  const result = await convertV5({ html: b.html, htmlName: 'workspace.html', caseFolder: b.caseDir, caseId: 'synthetic-case' });
  return { ...b, result, files: result.files! };
}

const assetsOf = (files: Map<string, Uint8Array>) => JSON.parse(new TextDecoder().decode(files.get('assets.json'))).assets as Record<string, any>;

describe('package-file asset keys', () => {
  it('are P- and the first 16 hex digits of the sha256 of the path, never a ref', () => {
    const k = pathAssetKey('BUNDLES/Bundle C.pdf');
    expect(k).toBe('P-' + sha256Hex('BUNDLES/Bundle C.pdf').slice(0, 16));
    expect(isPathKey(k) && isAssetKey(k)).toBe(true);
    expect(isRef(k)).toBe(false);
    for (const bad of ['P-0123456789ABCDEF', 'P-0123456789abcde', 'P-0123456789abcdef0', 'P-../../etc/passwd', 'p-0123456789abcdef', 'P-0123456789abcdeg']) expect(isAssetKey(bad), bad).toBe(false);
    // a sixteen-digit key is still not a ref (refs have at most eight digits)
    expect(isRef('P-0123456789012345')).toBe(false);
  });
});

describe('the v5 adapter indexes package files', () => {
  it('collects bundle, index, extract, part, CaseLines and schedule files once each, skipping register paths, folders and unsafe locators', async () => {
    const b = await packageFiles('pkgfiles');
    expect(b.result.ok).toBe(true);
    const assets = assetsOf(b.files);
    const pkg = Object.entries(assets).filter(([k]) => k.startsWith('P-'));
    const byPath: Record<string, { key: string; kind: string }> = Object.fromEntries(pkg.map(([k, a]) => [a.path, { key: k, kind: a.kind }]));
    expect(Object.keys(byPath).sort()).toEqual([...Object.keys(ON_DISK), 'BUNDLES/extracts/Gone.pdf'].sort());
    for (const [p, v] of Object.entries(byPath)) expect(v.key).toBe(pathAssetKey(p));
    expect(byPath['BUNDLES/extracts/Gone.pdf']!.kind).toBe('missing');
    for (const p of Object.keys(ON_DISK)) {
      expect(byPath[p]!.kind).toBe('file');
      expect(assets[byPath[p]!.key]).toMatchObject({ sha256: sha256Hex(ON_DISK[p as keyof typeof ON_DISK]), size: ON_DISK[p as keyof typeof ON_DISK].byteLength, mediaType: 'application/pdf' });
      expect(assets[byPath[p]!.key].parentRef).toBeUndefined();
    }
    // the register's own path keeps its ref and gains no P- alias
    expect(pkg.some(([, a]) => a.path === 'DISCOVERY A/OD-001 Supply agreement.pdf')).toBe(false);
  });

  it('imports them as verified originals that are not documents', async () => {
    const b = await packageFiles('pkgimport');
    const r = await importCandidate({ files: b.files }, b.caseDir);
    expect(errors(r)).toEqual([]);
    // no orphan, text or shared-content diagnostics for package files (the part is byte-identical to the schedule
    // file and the bundle may equal a document); the missing extract is reported as missing
    expect(r.diagnostics.filter((d) => d.subject?.startsWith('P-')).map((d) => d.code).sort()).toEqual(['ASSET_MISSING_AT_BUILD']);
    expect(r.diagnostics.filter((d) => d.code === 'ASSET_DUPLICATE_CONTENT' && d.subject === sha256Hex(ON_DISK['BUNDLES/extracts/Item 1.pdf']).slice(0, 16))).toEqual([]);
    const key = pathAssetKey('BUNDLES/Bundle C.pdf');
    expect(r.candidate!.original(key)).toMatchObject({ path: 'BUNDLES/Bundle C.pdf', status: 'verified' });
    expect(r.candidate!.isUnavailable(pathAssetKey('BUNDLES/extracts/Gone.pdf'))).toBe(true);
    // re-anchoring by fingerprint and the document counts see documents only
    const rd = readCandidate(r.candidate!);
    expect(rd.originals().length).toBeGreaterThan(0);
    expect(rd.originals().filter((o) => isPathKey(o.ref))).toEqual([]);
    expect(rd.documentState(key)).toBeNull();
  });

  it('refuses a package-file key that is not the digest of its path, an embedded one, and one with a parent', async () => {
    const b = await packageFiles('pkgbad');
    const key = pathAssetKey('BUNDLES/Bundle C.pdf');
    const swapped = editPackage(b.files, 'assets.json', (v) => { v.assets[key].path = 'BUNDLES/Index C.pdf'; v.assets[pathAssetKey('BUNDLES/Index C.pdf')].path = 'BUNDLES/Bundle C.pdf'; });
    expect(codes(await importCandidate({ files: swapped }, b.caseDir))).toContain('ID_REF_INVALID');
    const embedded = editPackage(b.files, 'assets.json', (v) => { v.assets[key] = { kind: 'embedded', parentRef: 'EM-0001', ordinal: 1, member: 'x.pdf', mediaType: 'application/pdf', textStatus: 'pending' }; });
    const e = await importCandidate({ files: embedded }, b.caseDir);
    expect(e.verdict).toBe('reject');
    expect(codes(e)).toContain('ID_REF_INVALID');
    const parented = editPackage(b.files, 'assets.json', (v) => { v.assets[key].parentRef = 'EM-0001'; });
    const p = await importCandidate({ files: parented }, b.caseDir);
    expect(p.verdict).toBe('reject');
    expect(codes(p)).toContain('ID_REF_INVALID');
  });

  it('refuses a package file that links out of the case folder, as for a register original', async () => {
    const b = await packageFiles('pkgescape');
    const { symlink } = await import('node:fs/promises');
    await symlink('/etc/hostname', path.join(b.caseDir, 'BUNDLES', 'Escape.pdf'));
    const html = new TextDecoder().decode(b.html).replace(url('BUNDLES/Index C.pdf'), url('BUNDLES/Escape.pdf'));
    const r = await convertV5({ html: new TextEncoder().encode(html), htmlName: 'workspace.html', caseFolder: b.caseDir, caseId: 'synthetic-case' });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'ORIG_ESCAPE')?.subject).toBe(pathAssetKey('BUNDLES/Escape.pdf'));
  });
});
