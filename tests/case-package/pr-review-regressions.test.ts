// Regressions for the external PR #4 review at adf4fa9: R1 (a carried-forward ORIG_MISSING
// acknowledgement waived a different document under the same ref) and R2 (a zip entry's
// compressed bytes were allocated in full before any bound applied). Each failed before its fix.
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants, crc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canActivate, importCandidate, type ImportResult } from '../../src/lib/case-package/index.ts';
import { LIMITS, withLimits } from '../../src/lib/case-package/limits.ts';
import { readCentralDirectory, readEntry, ZipError, type ZipEntry } from '../../src/lib/case-package/zip.ts';
import { miniPackage } from './hostile/cases.ts';
import { writeZip, type ZipEntrySpec } from './hostile/zip-writer.ts';

const enc = new TextEncoder();
let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc02-pr4-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('R1: a missing-original warning is bound to the document, not only its ref', () => {
  const missingFp = (r: ImportResult) => r.diagnostics.filter((d) => d.code === 'ORIG_MISSING').map((d) => d.fingerprint);
  const importDocs = async (caseDir: string, docs: { ref: string; path: string; text: string }[]) =>
    importCandidate({ files: miniPackage({ docs: docs.map((d) => ({ ref: d.ref, path: d.path, bytes: enc.encode(d.text) })) }) }, caseDir);

  it('does not let an acknowledged missing document waive a different missing document under the same ref', async () => {
    const caseDir = path.join(root, 'r1-same-case');
    await mkdir(caseDir, { recursive: true });
    const first = await importDocs(caseDir, [{ ref: 'GT-001', path: 'old.pdf', text: '%PDF-1.4 invented old original' }]);
    const second = await importDocs(caseDir, [{ ref: 'GT-001', path: 'different.pdf', text: '%PDF-1.4 invented different original, other bytes' }]);
    expect(missingFp(first)).toHaveLength(1);
    expect(missingFp(second)).toHaveLength(1);
    expect(missingFp(second)[0]).not.toBe(missingFp(first)[0]);
    expect(canActivate(first, null, first.warningFingerprints).ok).toBe(true);
    const d = canActivate(second, null, first.warningFingerprints);
    expect(d.ok).toBe(false);
    expect(d.newWarnings).toContain(missingFp(second)[0]);
  });

  it('does not waive a different document that keeps the same ref and path but other indexed bytes', async () => {
    const caseDir = path.join(root, 'r1-same-path');
    await mkdir(caseDir, { recursive: true });
    const first = await importDocs(caseDir, [{ ref: 'GT-001', path: 'memo.pdf', text: '%PDF-1.4 invented memo, first' }]);
    const second = await importDocs(caseDir, [{ ref: 'GT-001', path: 'memo.pdf', text: '%PDF-1.4 invented memo, second edition' }]);
    expect(missingFp(second)[0]).not.toBe(missingFp(first)[0]);
    expect(canActivate(second, null, first.warningFingerprints).ok).toBe(false);
  });

  it('keeps the fingerprint of an unchanged missing document stable across rebuilt packages', async () => {
    const caseDir = path.join(root, 'r1-stable');
    await mkdir(caseDir, { recursive: true });
    const gt = { ref: 'GT-001', path: 'old.pdf', text: '%PDF-1.4 invented old original' };
    const first = await importDocs(caseDir, [gt]);
    const again = await importDocs(caseDir, [gt]);
    const grown = await importDocs(caseDir, [{ ref: 'GT-000', path: 'other.pdf', text: '%PDF-1.4 invented other' }, gt]);
    expect(missingFp(again)).toEqual(missingFp(first));
    expect(missingFp(grown)).toContain(missingFp(first)[0]);
    expect(canActivate(again, null, first.warningFingerprints)).toMatchObject({ ok: true, newWarnings: [] });
  });
});

describe('R2: compressed entry bytes are bounded before anything is allocated for them', () => {
  /** A FileHandle that records the length of every read it serves. */
  const recording = (fh: FileHandle) => {
    const reads: number[] = [];
    const h = { stat: () => fh.stat(), read: (b: Buffer, o: number, len: number, pos: number) => { reads.push(len); return fh.read(b, o, len, pos); } };
    return { fh: h as unknown as FileHandle, reads };
  };
  const zipFile = async (name: string, entries: ZipEntrySpec[]) => {
    const file = path.join(root, `${name}.zip`);
    await writeFile(file, writeZip(entries));
    return file;
  };
  const PAD = 2_097_155;
  /** the reviewer's probe: one byte of output in a valid deflate stream padded past every bound */
  const padded = () => {
    const d = deflateRawSync(enc.encode('x'));
    const out = new Uint8Array(PAD);
    out.set(d);
    return out;
  };
  const probeLimits = withLimits({ archiveEntryBytes: 16, archiveTotalBytes: 32 });
  const codeOf = async (p: Promise<unknown>) => p.then(() => 'accepted', (e) => (e instanceof ZipError ? e.code : `threw ${String(e)}`));

  it('rejects the padded deflate probe in the central directory without reading the padding', async () => {
    const file = await zipFile('probe', [{ name: 'x.txt', data: enc.encode('x'), method: 8, compressed: padded() }]);
    const fh = await open(file);
    try {
      const r = recording(fh);
      expect(await codeOf(readCentralDirectory(r.fh, probeLimits))).toBe('ARC_LIMIT');
      expect(Math.max(...r.reads)).toBeLessThan(PAD);
      expect(await codeOf(readCentralDirectory(r.fh, withLimits(undefined)))).toBe('ARC_LIMIT');
    } finally {
      await fh.close();
    }
  });

  it('refuses an entry whose compressed size exceeds its declared output before any read', async () => {
    const file = await zipFile('probe-entry', [{ name: 'x.txt', data: enc.encode('x'), method: 8, compressed: padded() }]);
    const fh = await open(file);
    try {
      const r = recording(fh);
      const e: ZipEntry = { name: 'x.txt', method: 8, flags: 0, crc32: crc32(enc.encode('x')) >>> 0, compressedSize: PAD, uncompressedSize: 1, localHeaderOffset: 0, isDirectory: false };
      expect(await codeOf(readEntry(r.fh, e))).toBe('ARC_LIMIT');
      expect(r.reads).toEqual([]);
    } finally {
      await fh.close();
    }
  });

  it.each([
    ['compressed larger than declared', 1, PAD],
    ['compressed smaller than declared', 100, 1],
  ])('rejects a stored entry with inconsistent sizes in the central directory (%s)', async (label, usize, csize) => {
    const data = new Uint8Array(Math.max(usize, csize)).fill(0x61);
    const file = await zipFile(`stored-${usize}-${csize}`, [{ name: 'x.txt', data: data.subarray(0, usize), compressed: data.subarray(0, csize), uncompressedSize: usize, compressedSize: csize }]);
    const fh = await open(file);
    try {
      const r = recording(fh);
      expect(await codeOf(readCentralDirectory(r.fh, LIMITS))).toBe('ARC_MALFORMED');
      expect(Math.max(...r.reads)).toBeLessThan(PAD);
    } finally {
      await fh.close();
    }
  });

  it('rejects the probe end to end as ARC_LIMIT with an actionable message', async () => {
    const caseDir = path.join(root, 'r2-case');
    await mkdir(caseDir, { recursive: true });
    const file = await zipFile('probe-import', [{ name: 'manifest.json', data: enc.encode('x'), method: 8, compressed: padded() }]);
    const r = await importCandidate(file, caseDir, { limits: { archiveEntryBytes: 16, archiveTotalBytes: 32 } });
    expect(r.verdict).toBe('reject');
    const d = r.diagnostics.find((x) => x.code === 'ARC_LIMIT');
    expect(d?.message).toMatch(/compressed/);
    expect(d?.subject).toBe('manifest.json');
  });

  it('still accepts incompressible data deflated with fixed Huffman codes (worst legitimate expansion)', async () => {
    let s = 7;
    const data = Uint8Array.from({ length: 64 * 1024 }, () => 144 + ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16) % 112);
    const compressed = new Uint8Array(deflateRawSync(data, { strategy: constants.Z_FIXED }));
    expect(compressed.byteLength).toBeGreaterThan(data.byteLength);
    const file = await zipFile('fixed', [{ name: 'x.bin', data, method: 8, compressed }]);
    const fh = await open(file);
    try {
      const [e] = await readCentralDirectory(fh, LIMITS);
      expect(Buffer.from(await readEntry(fh, e!)).equals(Buffer.from(data))).toBe(true);
    } finally {
      await fh.close();
    }
  });
});
