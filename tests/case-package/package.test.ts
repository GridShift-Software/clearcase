// Behaviour of conversion, validation, the immutable candidate, byte verification and the
// read model, on synthetic packages only.
import { spawnSync } from 'node:child_process';
import { readdir, readFile, rm, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ADAPTER, convertV5, importCandidate, readCandidate, reassembleV5, verifyCandidateBytes, writePackageDir,
  canonicalText, matchAnchor, viewSeeds, type ImportResult,
} from '../../src/lib/case-package/index.ts';
import { V5_DATASETS } from '../../src/lib/case-package/registry.ts';
import { sha256Hex } from '../../src/lib/case-package/hash.ts';
import { canonicalBytes } from '../../src/lib/case-package/canonical.ts';
import { buildSynth, editManifestOnly, editPackage, resealFiles, type Built } from './fixtures/build.ts';
import { malform } from './fixtures/malform.ts';
import { withPresentation } from './fixtures/presentation';
import { cleanup, synthHtml, synthRoots, tempDir } from './fixtures/synth.ts';
import { storedZip } from './fixtures/zip.ts';

const roots: string[] = [];
const built = async (tag: string, edit?: Parameters<typeof buildSynth>[1], opts?: Parameters<typeof buildSynth>[2]): Promise<Built> => {
  const b = await buildSynth(tag, edit, opts);
  roots.push(b.root);
  return b;
};
afterAll(async () => { for (const r of roots) await cleanup(r); });

const codes = (r: ImportResult) => new Set(r.diagnostics.map((d) => d.code));
const errors = (r: ImportResult) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const importFiles = (files: Map<string, Uint8Array>, caseDir: string, opts = {}) => importCandidate({ files }, caseDir, opts);

function expectReject(r: ImportResult, code: string): void {
  expect(r.verdict).toBe('reject');
  expect(r.candidate).toBeNull();
  expect(codes(r)).toContain(code);
}

describe('a complete synthetic candidate', () => {
  it('converts every recognized dataset and validates with only the expected warnings', async () => {
    const b = await built('complete', withPresentation);
    expect(b.result.ok).toBe(true);
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('report');
    expect(r.candidate).not.toBeNull();
    expect(errors(r)).toEqual([]);
    const keys = r.candidate!.datasetKeys();
    for (const d of V5_DATASETS) expect(keys).toContain(d.key);
    expect(r.counts.CITE_UNRESOLVED).toBe(1);
    expect(r.counts.V5_META_COUNT_DISAGREEMENT).toBe(2);
    expect(r.counts.DS_UNSUPPORTED_FIELD).toBeUndefined();
    expect(r.candidate!.resultsVersion).toBe(b.result.manifest!.resultsVersion);
    expect(r.candidate!.resultsVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('reassembles DATA, META, __SCHED__ and __CASELINES_IDX__ losslessly', async () => {
    const b = await built('lossless');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    const c = r.candidate!;
    const back = reassembleV5(c.datasetKeys().map((k) => c.dataset(k)!));
    const src = synthRoots();
    expect(canonicalText(back.DATA)).toBe(canonicalText(src.DATA));
    expect(canonicalText(back.META)).toBe(canonicalText(src.META));
    expect(canonicalText(back['window.__SCHED__'])).toBe(canonicalText(src.SCHED));
    expect(canonicalText(back['window.__CASELINES_IDX__'])).toBe(canonicalText(src.CASELINES));
  });

  it('distinguishes unsupported media from missing text', async () => {
    const b = await built('media');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    const pdfNone = r.diagnostics.find((d) => d.subject === 'OD-003' && d.code === 'TEXT_NONE');
    const jpgNone = r.diagnostics.find((d) => d.subject === 'OD-004' && d.code === 'MEDIA_UNSUPPORTED');
    expect(pdfNone?.severity).toBe('warning');
    expect(jpgNone?.severity).toBe('info');
    expect(r.diagnostics.some((d) => d.subject === 'OD-004' && d.code === 'TEXT_NONE')).toBe(false);
    // the source value stays unchanged in the register
    const row = (r.candidate!.dataset('chronology')!.data as any[]).find((x) => x.ref === 'OD-004');
    expect(row.text_status).toBe('none');
  });

  it('keeps raw META and exposes derived counts next to it', async () => {
    const b = await built('meta');
    const rd = readCandidate((await importCandidate(b.pkgDir, b.caseDir)).candidate!);
    expect(rd.sourceMeta!.textNone).toBe(1);
    expect(rd.sourceMeta!.emails).toBe(1);
    const d = rd.derivedCounts();
    expect(d.byTextStatus.none).toBe(2);
    expect(d.emails).toBe(2);
    expect(d.documents).toBe(7);
  });
});

describe('rejection returns diagnostics and no candidate', () => {
  it('rejects malformed JSON', async () => {
    const b = await built('malformed');
    const files = new Map(b.files);
    files.set('datasets/people.json', new TextEncoder().encode('{"envelope": '));
    expectReject(await importFiles(resealFiles(files), b.caseDir), 'JSON_MALFORMED');
  });

  it('rejects duplicate refs', async () => {
    const b = await built('dupref', (r) => { const c = r.DATA.chronology as any[]; c.push({ ...c[0], n: '8' }); });
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expectReject(r, 'ID_DUPLICATE');
    expect(r.diagnostics.find((d) => d.code === 'ID_DUPLICATE')!.subject).toBe('OD-001');
  });

  it('rejects a ref outside the grammar and a row without a ref', async () => {
    const b = await built('badref');
    const r = await importFiles(editPackage(b.files, 'datasets/chronology.json', (v) => { v.data[0].ref = 'od 1'; delete v.data[1].ref; }), b.caseDir);
    expectReject(r, 'ID_REF_INVALID');
  });

  for (const [label, p, code] of [
    ['parent traversal', '../outside.pdf', 'ASSET_PATH_TRAVERSAL'],
    ['absolute path', '/etc/passwd', 'ASSET_PATH_TRAVERSAL'],
    ['drive letter', 'C:/x.pdf', 'ASSET_PATH_TRAVERSAL'],
    ['URL drive form', 'C|/x.pdf', 'ASSET_PATH_TRAVERSAL'],
    ['backslash traversal', '..\\x.pdf', 'ASSET_PATH_TRAVERSAL'],
    ['inner traversal', 'DISCOVERY A/../../x.pdf', 'ASSET_PATH_TRAVERSAL'],
    ['reserved area', '.clearcase/x.pdf', 'ASSET_PATH_RESERVED'],
    ['NUL byte', 'a\u0000b.pdf', 'ASSET_PATH_INVALID'],
  ] as const) {
    it(`rejects an asset path with ${label}`, async () => {
      const b = await built('trav');
      const r = await importFiles(editPackage(b.files, 'assets.json', (v) => { v.assets['OD-001'].path = p; }), b.caseDir);
      expectReject(r, code);
    });
  }

  it('rejects an unsupported package version with one actionable error before any shape check', async () => {
    const b = await built('version');
    for (const edit of [(m: any) => { m.formatVersion = 2; }, (m: any) => { delete m.formatVersion; m.schemaVersion = '1.0'; }, (m: any) => { m.formatVersion = '1'; m.files = 'garbage'; }]) {
      const r = await importFiles(resealFiles(b.files, edit), b.caseDir);
      expectReject(r, 'VER_UNSUPPORTED');
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(1);
      expect(r.diagnostics[0]!.hint).toMatch(/upgrade|convert/i);
    }
  });

  it('rejects a closed-manifest violation but accepts x- extensions', async () => {
    const b = await built('closed');
    expectReject(await importFiles(resealFiles(b.files, (m) => { m.note = 'extra'; }), b.caseDir), 'PKG_MANIFEST_INVALID');
    const ok = await importFiles(resealFiles(b.files, (m) => { m.extensions = { 'x-producer-note': { any: 'thing' } }; }), b.caseDir);
    expect(ok.verdict).not.toBe('reject');
  });

  it('rejects count mismatches between manifest, envelope and records', async () => {
    const b = await built('count');
    expectReject(await importFiles(editPackage(b.files, 'datasets/people.json', (v) => { v.count = 5; }), b.caseDir), 'DS_COUNT_MISMATCH');
    expectReject(await importFiles(resealFiles(b.files, (m) => { m.files.find((f: any) => f.key === 'people').count = 9; }), b.caseDir), 'DS_MANIFEST_MISMATCH');
  });

  it('rejects non-canonical, tampered, missing and unlisted-only files appropriately', async () => {
    const b = await built('canon');
    const files = new Map(b.files);
    const env = JSON.parse(new TextDecoder().decode(files.get('datasets/people.json')!));
    files.set('datasets/people.json', new TextEncoder().encode(JSON.stringify(env)));
    expectReject(await importFiles(resealFiles(files), b.caseDir), 'PKG_NONCANONICAL');
    const tampered = new Map(b.files);
    tampered.set('datasets/people.json', new TextEncoder().encode(new TextDecoder().decode(b.files.get('datasets/people.json')!).replace('Ann Lee', 'Ann Lea')));
    expectReject(await importFiles(tampered, b.caseDir), 'PKG_FILE_HASH_MISMATCH');
    const missing = new Map(b.files);
    missing.delete('datasets/people.json');
    expectReject(await importFiles(missing, b.caseDir), 'PKG_FILE_MISSING');
    const extra = new Map(b.files);
    extra.set('notes.txt', new Uint8Array([1]));
    const r = await importFiles(extra, b.caseDir);
    expect(r.verdict).toBe('report');
    expect(codes(r)).toContain('PKG_UNLISTED_FILE');
    expect(r.candidate!.paths()).not.toContain('notes.txt');
    expectReject(await importFiles(editManifestOnly(b.files, (m) => { m.resultsVersion = 'sha256:' + '0'.repeat(64); }), b.caseDir), 'PKG_VERSION_MISMATCH');
    expectReject(await importFiles(editManifestOnly(b.files, (m) => { m.inputRevision.sources[0].size += 1; }), b.caseDir), 'PKG_INPUT_REVISION_MISMATCH');
  });

  it('rejects user work inside results at any depth', async () => {
    const b = await built('userwork');
    expectReject(await importFiles(editPackage(b.files, 'datasets/matter.json', (v) => { v.data.storyline[0].extra = { deep: { syn_case_deadlines_v1: [] } }; }), b.caseDir), 'DS_USERWORK_EMBEDDED');
    expectReject(await importFiles(editPackage(b.files, 'datasets/people.json', (v) => { v.provenance.source = 'local-storage'; }), b.caseDir), 'DS_USERWORK_EMBEDDED');
    const renamed = resealFiles(new Map([...editPackage(b.files, 'datasets/witnesses.json', (v) => { v.key = 'deadlines'; })].map(([p, x]) => [p === 'datasets/witnesses.json' ? 'datasets/deadlines.json' : p, x])),
      (m) => { const f = m.files.find((x: any) => x.key === 'witnesses'); f.key = 'deadlines'; f.path = 'datasets/deadlines.json'; m.files.sort((a: any, c: any) => (a.path < c.path ? -1 : 1)); });
    expectReject(await importFiles(renamed, b.caseDir), 'DS_USERWORK_EMBEDDED');
  });

  it('rejects an unknown required schema and preserves an unknown optional one', async () => {
    const b = await built('schema');
    expectReject(await importFiles(resealFiles(editPackage(b.files, 'datasets/people.json', (v) => { v.schema = 'v5.people@2'; }, false), (m) => { m.files.find((f: any) => f.key === 'people').schema = 'v5.people@2'; }), b.caseDir), 'DS_SCHEMA_UNSUPPORTED');
    // a registered key cannot be relabelled to escape its schema
    expectReject(await importFiles(resealFiles(editPackage(b.files, 'datasets/chronology.json', (v) => { v.schema = 'opaque@1'; v.required = false; }, false), (m) => { const f = m.files.find((x: any) => x.key === 'chronology'); f.schema = 'opaque@1'; f.required = false; }), b.caseDir), 'DS_SCHEMA_UNSUPPORTED');
    // a new optional dataset with an unknown schema is preserved but never typed for views
    const extra = new Map(b.files);
    const env = { envelope: 'clearcase.dataset/1', key: 'future-notes', kind: 'generated', schema: 'v6.future-notes@1', required: false, count: 1, provenance: { source: 'pipeline', sourcePath: 'X', adapter: 'x@1' }, data: [{ a: 1 }] };
    const bytes = canonicalBytes(env);
    extra.set('datasets/future-notes.json', bytes);
    const opt = await importFiles(resealFiles(extra, (m) => { m.files.push({ path: 'datasets/future-notes.json', role: 'dataset', key: 'future-notes', kind: 'generated', schema: 'v6.future-notes@1', required: false, count: 1, sha256: sha256Hex(bytes), size: bytes.byteLength }); m.files.sort((x: any, y: any) => (x.path < y.path ? -1 : 1)); }), b.caseDir);
    expect(opt.verdict).toBe('report');
    expect(codes(opt)).toContain('DS_UNKNOWN_SCHEMA');
    expect(opt.candidate!.dataset('future-notes')).not.toBeNull();
    expect(readCandidate(opt.candidate!).dataset('future-notes')).toBeNull();
  });

  it('reports an unknown field as preserved but unsupported', async () => {
    const b = await built('field', (r) => { (r.DATA.people as any[])[0].nickname = 'A'; });
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('report');
    expect(r.diagnostics.find((d) => d.code === 'DS_UNSUPPORTED_FIELD')?.subject).toBe('nickname');
    expect((r.candidate!.dataset('people')!.data as any[])[0].nickname).toBe('A');
  });

  describe('a malformed record in every recognized dataset is rejected', () => {
    for (const d of V5_DATASETS) {
      it(d.key, async () => {
        const b = await built(`bad-${d.key}`, withPresentation);
        const file = `datasets/${d.key}.json`;
        const r = await importFiles(editPackage(b.files, file, (v) => { v.data = malform(d.data, v.data); v.count = Array.isArray(v.data) ? v.data.length : Object.keys(v.data).length; }), b.caseDir);
        expectReject(r, 'DS_SHAPE_INVALID');
        expect(r.diagnostics.find((x) => x.code === 'DS_SHAPE_INVALID')!.file).toBe(file);
      });
    }
  });
});

describe('the candidate is an immutable snapshot', () => {
  it('ignores later changes to the producer directory and to caller-owned buffers', async () => {
    const b = await built('immut');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    const c = r.candidate!;
    const before = sha256Hex(c.fileBytes('datasets/people.json')!);
    await writeFile(path.join(b.pkgDir, 'datasets', 'people.json'), 'changed');
    await rm(path.join(b.pkgDir, 'manifest.json'));
    expect(sha256Hex(c.fileBytes('datasets/people.json')!)).toBe(before);
    const files = new Map([...b.files].map(([p, x]) => [p, new Uint8Array(x)]));
    const m = await importFiles(files, b.caseDir);
    for (const buf of files.values()) buf.fill(0);
    expect(sha256Hex(m.candidate!.fileBytes('manifest.json')!)).toBe(m.candidate!.manifestSha256);
    const copy = m.candidate!.fileBytes('manifest.json')!;
    copy.fill(0);
    expect(sha256Hex(m.candidate!.fileBytes('manifest.json')!)).toBe(m.candidate!.manifestSha256);
    expect(() => { (m.candidate!.dataset('people')!.data as any[])[0].name = 'x'; }).toThrow();
    expect(() => { (m.candidate as any).resultsVersion = 'x'; }).toThrow();
    expect(Object.isFrozen(m.candidate!.manifest)).toBe(true);
  });

  it('persists and reloads through a caller-owned byte collection with the same identity', async () => {
    const b = await built('persist');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    const stored = new Map<string, Uint8Array>();
    for (const { path: p, bytes } of r.candidate!.snapshot()) stored.set(p, bytes);
    expect(verifyCandidateBytes(stored, r.candidate!.identity())).toEqual({ ok: true, problems: [] });
    const again = await importFiles(stored, b.caseDir);
    expect(again.candidate!.resultsVersion).toBe(r.candidate!.resultsVersion);
    expect(again.candidate!.manifestSha256).toBe(r.candidate!.manifestSha256);
    expect(again.diagnosticsSha256).toBe(r.diagnosticsSha256);
  });

  it('verifyCandidateBytes detects extra, missing and changed files and a wrong identity', async () => {
    const b = await built('vbytes');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    const id = r.candidate!.identity();
    const base = new Map([...r.candidate!.snapshot()].map((x) => [x.path, x.bytes]));
    const extra = new Map(base); extra.set('x.json', new Uint8Array([1]));
    expect(verifyCandidateBytes(extra, id).ok).toBe(false);
    const missing = new Map(base); missing.delete('assets.json');
    expect(verifyCandidateBytes(missing, id).ok).toBe(false);
    const changed = new Map(base); const x = new Uint8Array(changed.get('datasets/people.json')!); x[10] ^= 1; changed.set('datasets/people.json', x);
    expect(verifyCandidateBytes(changed, id).problems.join()).toMatch(/sha256/);
    expect(verifyCandidateBytes(base, { ...id, manifestSha256: '0'.repeat(64) }).ok).toBe(false);
    expect(verifyCandidateBytes(base, { ...id, resultsVersion: 'sha256:' + '0'.repeat(64) }).ok).toBe(false);
  });
});

describe('read model', () => {
  it('routes attachments to the parent, directly, or as unavailable', async () => {
    const b = await built('attach', (r) => {
      (r.DATA.chronology as any[]).push({ ...(r.DATA.chronology as any[])[0], ref: 'AT-001', n: '8', seq: '8', pr: 'EM-0001', url: './_attachments/EM-0001/quote.pdf', size: 20, doc_type: 'other' });
      (r.DATA.chronology as any[]).push({ ...(r.DATA.chronology as any[])[0], ref: 'AT-002', n: '9', seq: '9', pr: 'EM-0001', url: './_attachments/EM-0001/gone.pdf', size: 20, doc_type: 'other' });
    });
    await mkdir(path.join(b.caseDir, '_attachments', 'EM-0001'), { recursive: true });
    // the attachment file is created after conversion, so reconvert to index it
    await writeFile(path.join(b.caseDir, '_attachments', 'EM-0001', 'quote.pdf'), '%PDF-1.4\n% quote\n%%EOF\n');
    const conv = await convertV5({ html: b.html, htmlName: 'w.html', caseFolder: b.caseDir, caseId: 'synthetic-case' });
    await unlink(path.join(b.caseDir, 'MAIL', 'EM-0002 Statement café.msg'));
    const r = await importFiles(conv.files!, b.caseDir);
    expect(r.verdict).toBe('report');
    const rd = readCandidate(r.candidate!);
    expect(rd.attachmentsOf('EM-0001').map((a) => a.key)).toEqual(['AT-001', 'AT-002', 'EM-0001.a1', 'EM-0001.a2', 'EM-0001.a3']);
    expect(rd.resolveAttachment('EM-0001.a2')).toMatchObject({ route: 'parent', parentRef: 'EM-0001', member: 'image001.png' });
    expect(rd.resolveAttachment('AT-001')).toMatchObject({ route: 'direct', parentRef: 'EM-0001', original: { path: '_attachments/EM-0001/quote.pdf' } });
    expect(rd.resolveAttachment('AT-002')).toMatchObject({ route: 'unavailable', reason: 'original-missing' });
    expect(rd.resolveAttachment('EM-0002.a1')).toMatchObject({ route: 'unavailable', reason: 'parent-missing' });
    expect(rd.documentState('EM-0002')).toMatchObject({ file: 'missing', flags: ['missing-original'] });
    expect(rd.documentState('OD-001')).toMatchObject({ file: 'present', preview: 'inline-isolated' });
    expect(rd.documentState('EM-0001')).toMatchObject({ file: 'present', preview: 'text-sandboxed' });
    expect(rd.documentState('NOPE-1')).toBeNull();
    expect(codes(r)).toContain('ORIG_MISSING');
  });

  it('gives seeds stable ids, shows conflicts, and re-anchors notes by fingerprint', async () => {
    const b = await built('seeds');
    const rd1 = readCandidate((await importCandidate(b.pkgDir, b.caseDir)).candidate!);
    const seeds1 = rd1.seeds();
    expect(seeds1.map((s) => s.datasetKey).sort()).toEqual(['filings', 'lit-crossexam-seed']);
    const b2 = await built('seeds2', (r) => { ((r.DATA.filings as any).registerSeed[0]).status = 'Changed'; (r.DATA.chronology as any[]).reverse(); });
    const rd2 = readCandidate((await importCandidate(b2.pkgDir, b2.caseDir)).candidate!);
    const seeds2 = rd2.seeds();
    const f1 = seeds1.find((s) => s.datasetKey === 'filings')!;
    const f2 = seeds2.find((s) => s.datasetKey === 'filings')!;
    expect(f2.seedId).toBe(f1.seedId);
    expect(f2.seedSha256).not.toBe(f1.seedSha256);
    const overlay = { caseId: 'synthetic-case', datasetKey: 'filings', seedId: f1.seedId, baseSeedSha256: f1.seedSha256, fields: { response: 'Edited' } };
    expect(viewSeeds(seeds1, [overlay]).find((v) => v.state !== 'seed')?.state).toBe('edited');
    expect(viewSeeds(seeds2, [overlay]).find((v) => v.state !== 'seed')?.state).toBe('conflict');
    const anchor = { caseId: 'synthetic-case', sha256: rd1.documentState('OD-002')!.original!.sha256, refAtCreation: 'OD-002', resultsVersion: rd1.resultsVersion };
    expect(matchAnchor(anchor, rd2.originals())).toEqual({ status: 'exact', ref: 'OD-002' });
    expect(matchAnchor(anchor, rd2.originals().map((o) => (o.ref === 'OD-002' ? { ...o, ref: 'OD-099' } : o)))).toEqual({ status: 'exact', ref: 'OD-099' });
    expect(matchAnchor(anchor, [...rd2.originals(), { ref: 'OD-777', sha256: anchor.sha256 }]).status).toBe('ambiguous');
    expect(matchAnchor({ ...anchor, sha256: '0'.repeat(64) }, rd2.originals()).status).toBe('missing');
  });
});

describe('deterministic identity', () => {
  const allBytes = async (dir: string) => {
    const out = new Map<string, string>();
    for (const f of (await readdir(dir, { recursive: true })).sort()) {
      const b = await readFile(path.join(dir, f)).catch(() => null);
      if (b) out.set(f, sha256Hex(b));
    }
    return out;
  };

  it('is byte-identical across concurrency, output directory, HTML name, unrelated files and a producer patch', async () => {
    const a = await built('det-a', undefined, { concurrency: 1 });
    const b = await built('det-b', undefined, { concurrency: 16, htmlName: 'renamed.html' });
    expect(b.result.manifest!.resultsVersion).toBe(a.result.manifest!.resultsVersion);
    expect(b.result.manifest!.inputRevision.id).toBe(a.result.manifest!.inputRevision.id);
    expect(b.result.manifest!.inputRevision.sources[0]!.name).toBe('renamed.html');
    const same = await built('det-c', undefined, { concurrency: 16 });
    expect(await allBytes(same.pkgDir)).toEqual(await allBytes(a.pkgDir));
    await writeFile(path.join(a.caseDir, 'unrelated.txt'), 'not referenced');
    const saved = ADAPTER.version;
    (ADAPTER as { version: string }).version = '0.1.99';
    try {
      const c = await convertV5({ html: a.html, htmlName: 'workspace.html', caseFolder: a.caseDir, caseId: 'synthetic-case' });
      expect(c.manifest!.resultsVersion).toBe(a.result.manifest!.resultsVersion);
      expect(c.manifest!.producer.version).toBe('0.1.99');
    } finally {
      (ADAPTER as { version: string }).version = saved;
    }
  });

  it('does not depend on TZ or LANG', async () => {
    const a = await built('det-env');
    const script = `import { convertV5 } from '${path.resolve('src/lib/case-package/v5/adapter.ts')}'; import { readFile } from 'node:fs/promises';
      const r = await convertV5({ html: await readFile(process.argv[2]), htmlName: 'workspace.html', caseFolder: process.argv[3], caseId: 'synthetic-case' }); console.log(r.manifest.resultsVersion);`;
    const htmlPath = path.join(a.root, 'w.html');
    await writeFile(htmlPath, a.html);
    const scriptPath = path.join(a.root, 'env.ts');
    await writeFile(scriptPath, script);
    for (const env of [{ TZ: 'Pacific/Chatham', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }, { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }]) {
      const p = spawnSync(process.execPath, [scriptPath, htmlPath, a.caseDir], { env: { ...process.env, ...env }, encoding: 'utf8' });
      expect(p.status, p.stderr).toBe(0);
      expect(p.stdout.trim()).toBe(a.result.manifest!.resultsVersion);
    }
  });

  it('changes identity when narrative or original bytes change', async () => {
    const a = await built('det-n');
    const n = await built('det-n2', (r) => { (r.DATA.matter as any).storyline[0].t += '!'; });
    expect(n.result.manifest!.resultsVersion).not.toBe(a.result.manifest!.resultsVersion);
    await writeFile(path.join(a.caseDir, 'DISCOVERY A', 'OD-002 Invoice 1001.pdf'), '%PDF-1.4\n% synthetic invoice 1002\n%%EOF\n');
    const c = await convertV5({ html: a.html, htmlName: 'workspace.html', caseFolder: a.caseDir, caseId: 'synthetic-case' });
    expect(c.manifest!.resultsVersion).not.toBe(a.result.manifest!.resultsVersion);
    expect(c.manifest!.inputRevision.id).toBe(a.result.manifest!.inputRevision.id);
    // the old package no longer matches the changed original
    expectReject(await importCandidate(a.pkgDir, a.caseDir), 'ORIG_FINGERPRINT_MISMATCH');
  });

  it('keeps created from META.builtAt and out of the identity', async () => {
    const a = await built('created');
    expect(a.result.manifest!.created).toBe('2001-05-06T07:08');
    const c = await convertV5({ html: a.html, htmlName: 'workspace.html', caseFolder: a.caseDir, caseId: 'synthetic-case', created: '1999-12-30T00:00', caseLabel: 'Other label' });
    expect(c.manifest!.resultsVersion).toBe(a.result.manifest!.resultsVersion);
    const other = await convertV5({ html: a.html, htmlName: 'workspace.html', caseFolder: a.caseDir, caseId: 'another-case' });
    expect(other.manifest!.resultsVersion).not.toBe(a.result.manifest!.resultsVersion);
  });
});

describe('zip transport', () => {
  it('imports the same package from a zip with the same identity', async () => {
    const b = await built('zip');
    const zipPath = path.join(b.root, 'pkg.zip');
    await writeFile(zipPath, storedZip(b.files));
    const fromDir = await importCandidate(b.pkgDir, b.caseDir);
    const fromZip = await importCandidate(zipPath, b.caseDir);
    expect(fromZip.verdict).toBe('report');
    expect(fromZip.candidate!.resultsVersion).toBe(fromDir.candidate!.resultsVersion);
    expect(fromZip.diagnosticsSha256).toBe(fromDir.diagnosticsSha256);
  });

  it('rejects a traversal entry and a non-zip file', async () => {
    const b = await built('zipbad');
    const zipPath = path.join(b.root, 'bad.zip');
    await writeFile(zipPath, storedZip(new Map([...b.files, ['../escape.json', new Uint8Array([1])]])));
    expectReject(await importCandidate(zipPath, b.caseDir), 'ARC_ENTRY_INVALID');
    await writeFile(zipPath, 'not a zip');
    expectReject(await importCandidate(zipPath, b.caseDir), 'ARC_MALFORMED');
  });
});

describe('v5 extraction never evaluates the HTML', () => {
  it('refuses computed, encoded, duplicated and trailing-code payloads', async () => {
    const dir = await tempDir('extract');
    roots.push(dir);
    const r = synthRoots();
    const base = new TextDecoder().decode(synthHtml(r));
    const cases: [string, string][] = [
      [base.replace(/^const DATA = .*$/m, "const DATA = JSON.parse(atob('e30='));"), 'V5_PAYLOAD_ENCODED'],
      [base.replace(/^const META = (.*)$/m, 'const META = $1\nconst META = {};'), 'V5_PAYLOAD_AMBIGUOUS'],
      [base.replace(/^(const DATA = .*);$/m, '$1; alert(1);'), 'V5_PAYLOAD_NOT_JSON'],
      [base.replace(/^const DATA = .*$/m, ''), 'V5_PAYLOAD_MISSING'],
      [base.replace(/^const META = \{/m, 'const META = {"a":1,"a":2,'), 'JSON_DUPLICATE_KEY'],
    ];
    for (const [html, code] of cases) {
      const c = await convertV5({ html: new TextEncoder().encode(html), htmlName: 'w.html', caseFolder: dir, caseId: 'x' });
      expect(c.ok).toBe(false);
      expect(c.files).toBeNull();
      expect(c.diagnostics.map((d) => d.code)).toContain(code);
    }
    expect((globalThis as { __executed?: boolean }).__executed).toBeUndefined();
  });
});
