// Read-only verification of originals in the case folder: containment, file types, fingerprints,
// bounds before hashing (proved with sparse files), deadline, cancellation and progress.
import { spawnSync } from 'node:child_process';
import { lstat, readdir, readFile, rename, stat, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importCandidate, readCandidate, type ImportResult } from '../../src/lib/case-package/index.ts';
import { sha256Hex } from '../../src/lib/case-package/hash.ts';
import type { Progress } from '../../src/lib/case-package/originals.ts';
import { buildSynth, editPackage, type Built } from './fixtures/build.ts';
import { cleanup } from './fixtures/synth.ts';

const roots: string[] = [];
const built = async (tag: string): Promise<Built> => { const b = await buildSynth(tag); roots.push(b.root); return b; };
afterAll(async () => { for (const r of roots) await cleanup(r); });

const codes = (r: ImportResult) => new Set(r.diagnostics.map((d) => d.code));
const OD1 = 'DISCOVERY A/OD-001 Supply agreement.pdf';
const GiB = 1024 ** 3;

/** Listing, sizes, mtimes and content digests of everything under a folder. */
async function fingerprintTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of (await readdir(dir, { recursive: true })).sort()) {
    const p = path.join(dir, f);
    const s = await lstat(p);
    const digest = s.isFile() && s.size < 1 << 20 ? sha256Hex(await readFile(p)) : '';
    out.push(`${f}|${s.mode}|${s.size}|${s.mtimeMs}|${digest}`);
  }
  return out;
}

describe('containment and file types', () => {
  it('rejects a file symlink that escapes the case folder, even with identical bytes', async () => {
    const b = await built('esc-file');
    const outside = path.join(b.root, 'outside.pdf');
    await rename(path.join(b.caseDir, OD1), outside);
    await symlink(outside, path.join(b.caseDir, OD1));
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('reject');
    expect(r.candidate).toBeNull();
    expect(codes(r)).toContain('ORIG_ESCAPE');
  });

  it('rejects an intermediate directory symlink that escapes', async () => {
    const b = await built('esc-dir');
    const outside = path.join(b.root, 'elsewhere');
    await rename(path.join(b.caseDir, 'DISCOVERY A'), outside);
    await symlink(outside, path.join(b.caseDir, 'DISCOVERY A'));
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(codes(r)).toContain('ORIG_ESCAPE');
    expect(r.verdict).toBe('reject');
  });

  it('accepts a symlink that stays inside the case folder', async () => {
    const b = await built('inside-link');
    await rename(path.join(b.caseDir, OD1), path.join(b.caseDir, 'real.pdf'));
    await symlink(path.join(b.caseDir, 'real.pdf'), path.join(b.caseDir, OD1));
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('report');
    expect(r.candidate!.original('OD-001')!.path).toBe(OD1);
  });

  it('refuses a FIFO without hanging', async () => {
    const b = await built('fifo');
    await unlink(path.join(b.caseDir, OD1));
    expect(spawnSync('mkfifo', [path.join(b.caseDir, OD1)]).status).toBe(0);
    const t = Date.now();
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(codes(r)).toContain('ORIG_NOT_FILE');
    expect(r.verdict).toBe('reject');
  });

  it('flags a missing cited original as a warning that stays visible', async () => {
    const b = await built('missing');
    await unlink(path.join(b.caseDir, OD1));
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('report');
    expect(codes(r)).toContain('ORIG_MISSING');
    expect(r.diagnostics.find((d) => d.code === 'CITE_TARGET_NO_ORIGINAL')?.subject).toBe('OD-001');
    expect(readCandidate(r.candidate!).documentState('OD-001')).toMatchObject({ file: 'missing', preview: 'none' });
    expect(r.candidate!.isUnavailable('OD-001')).toBe(true);
  });

  it('rejects a same-size replacement of an original', async () => {
    const b = await built('replaced');
    const p = path.join(b.caseDir, OD1);
    const bytes = await readFile(p);
    bytes[bytes.length - 2] ^= 1;
    await writeFile(p, bytes);
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(codes(r)).toContain('ORIG_FINGERPRINT_MISMATCH');
    expect(r.candidate).toBeNull();
  });

  it('records the real on-disk name for a case-only or normalisation-only match', async () => {
    const b = await built('case');
    await rename(path.join(b.caseDir, OD1), path.join(b.caseDir, 'DISCOVERY A', 'od-001 supply agreement.PDF'));
    const nfc = 'MAIL/EM-0002 Statement café.msg';
    const nfd = nfc.normalize('NFD');
    await rename(path.join(b.caseDir, nfc), path.join(b.caseDir, nfd));
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('report');
    expect(r.diagnostics.filter((d) => d.code === 'ORIG_CASE_MISMATCH').map((d) => d.subject).sort()).toEqual(['EM-0002', 'OD-001']);
    expect(r.candidate!.original('OD-001')!.path).toBe('DISCOVERY A/od-001 supply agreement.PDF');
    expect(r.candidate!.original('EM-0002')!.path).toBe(nfd);
    expect(r.candidate!.original('EM-0002')!.path).not.toBe(nfc);
  });

  it('flags content that contradicts its type as download-only', async () => {
    const b = await built('sniff');
    const p = path.join(b.caseDir, OD1);
    const html = '<script>x()</script>'.padEnd((await stat(p)).size, ' ');
    await writeFile(p, html);
    const files = editPackage(b.files, 'assets.json', (v) => { v.assets['OD-001'].sha256 = sha256Hex(html); });
    const r = await importCandidate({ files }, b.caseDir);
    expect(codes(r)).toContain('ORIG_MEDIA_MISMATCH');
    expect(readCandidate(r.candidate!).documentState('OD-001')).toMatchObject({ preview: 'download', flags: ['download-only'] });
  });

  it('requires the case folder', async () => {
    const b = await built('nofolder');
    const r = await importCandidate(b.pkgDir, path.join(b.root, 'absent'));
    expect(codes(r)).toContain('ORIG_CASE_FOLDER_INVALID');
    expect(r.candidate).toBeNull();
  });
});

describe('bounds before hashing, deadline and cancellation', () => {
  it('rejects an original above 8 GiB before reading it (sparse file)', async () => {
    const b = await built('big1');
    await truncate(path.join(b.caseDir, OD1), 8 * GiB + 1);
    const t = Date.now();
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(codes(r)).toContain('ORIG_TOO_LARGE');
    expect(r.candidate).toBeNull();
  });

  it('rejects a declared original above 8 GiB structurally', async () => {
    const b = await built('big2');
    const r = await importCandidate({ files: editPackage(b.files, 'assets.json', (v) => { v.assets['OD-001'].size = 8 * GiB + 1; }) }, b.caseDir);
    expect(codes(r)).toContain('ASSET_TOO_LARGE');
  });

  it('rejects more than 32 GiB of unique referenced originals before hashing (sparse files)', async () => {
    const b = await built('big3');
    const refs = ['OD-001', 'OD-002', 'OD-003', 'OD-004', 'SD-001'];
    const files = editPackage(b.files, 'assets.json', (v) => { for (const ref of refs) { v.assets[ref].size = 7 * GiB; } });
    for (const ref of refs) await truncate(path.join(b.caseDir, refPath(ref)), 7 * GiB);
    const t = Date.now();
    const r = await importCandidate({ files }, b.caseDir);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(codes(r)).toContain('ORIG_TOTAL_TOO_LARGE');
    expect(r.candidate).toBeNull();
  });

  it('stops at the validation deadline with no candidate', async () => {
    const b = await built('deadline');
    const p = path.join(b.caseDir, OD1);
    await truncate(p, 4 * GiB);
    const files = editPackage(b.files, 'assets.json', (v) => { v.assets['OD-001'].size = 4 * GiB; });
    const t = Date.now();
    const r = await importCandidate({ files }, b.caseDir, { limits: { validationDeadlineMs: 300 } });
    expect(Date.now() - t).toBeLessThan(3000);
    expect(codes(r)).toContain('IMPORT_DEADLINE');
    expect(r.verdict).toBe('reject');
    expect(r.candidate).toBeNull();
  });

  it('cancels on an abort signal with no candidate, and reports progress', async () => {
    const b = await built('abort');
    await truncate(path.join(b.caseDir, OD1), 4 * GiB);
    const files = editPackage(b.files, 'assets.json', (v) => { v.assets['OD-001'].size = 4 * GiB; });
    const ac = new AbortController();
    const seen: Progress[] = [];
    const r = await importCandidate({ files }, b.caseDir, { signal: ac.signal, onProgress: (p) => { seen.push(p); if (p.phase === 'hash' && p.bytesDone > 0) ac.abort(); } });
    expect(codes(r)).toContain('IMPORT_ABORTED');
    expect(r.candidate).toBeNull();
    expect(seen.map((p) => p.phase)).toEqual(expect.arrayContaining(['snapshot', 'validate', 'stat', 'hash']));
  });
});

describe('the case folder is never written', () => {
  it('leaves the case folder and the package byte-identical after accepted, rejected and interrupted imports', async () => {
    const b = await built('nowrite');
    const before = await fingerprintTree(b.caseDir);
    const pkgBefore = await fingerprintTree(b.pkgDir);
    await importCandidate(b.pkgDir, b.caseDir);
    await importCandidate({ files: editPackage(b.files, 'assets.json', (v) => { v.assets['OD-001'].path = '../x'; }) }, b.caseDir);
    await importCandidate(b.pkgDir, b.caseDir, { limits: { validationDeadlineMs: 0 } });
    expect(await fingerprintTree(b.caseDir)).toEqual(before);
    expect(await fingerprintTree(b.pkgDir)).toEqual(pkgBefore);
    expect((await readdir(b.caseDir)).includes('.clearcase')).toBe(false);
  });

  it('opens originals read-only (a read-only case folder imports)', async () => {
    const b = await built('ro');
    spawnSync('chmod', ['-R', 'a-w', b.caseDir]);
    try {
      const r = await importCandidate(b.pkgDir, b.caseDir);
      expect(r.verdict).toBe('report');
    } finally {
      spawnSync('chmod', ['-R', 'u+w', b.caseDir]);
    }
  });
});

const PATHS: Record<string, string> = {
  'OD-001': OD1,
  'OD-002': 'DISCOVERY A/OD-002 Invoice 1001.pdf',
  'OD-003': 'DISCOVERY A/OD-003 Scan.pdf',
  'OD-004': 'DISCOVERY A/OD-004 Photo.jpg',
  'SD-001': 'DISCOVERY B/SD-001 Statement.pdf',
};
function refPath(ref: string): string { return PATHS[ref]!; }
