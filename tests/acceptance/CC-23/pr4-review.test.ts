// Round 3: independent acceptance regressions for the two PR #4 review findings.
// Synthetic data only. Each test drives the public library API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { importCandidate } from '../../../src/lib/case-package/import.ts';
import { LIMITS } from '../../../src/lib/case-package/limits.ts';
import { canActivate } from '../../../src/lib/case-package/policy.ts';
import { readCentralDirectory, readEntry, ZipError, type ZipEntry } from '../../../src/lib/case-package/zip.ts';
import type { ImportResult } from '../../../src/lib/case-package/candidate.ts';
import { editManifestOnly } from '../../case-package/fixtures/build.ts';
import { miniPackage } from '../../case-package/hostile/cases.ts';

const enc = new TextEncoder();
const pdfA = enc.encode('%PDF-1.4\n% invented round-three original A\n%%EOF\n');
const pdfB = enc.encode('%PDF-1.4\n% invented round-three original B\n%%EOF\n');
const pdfC = enc.encode('%PDF-1.4\n% invented round-three original Z\n%%EOF\n'); // same size as A, different bytes

let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc23-r3-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

/** The single ORIG_MISSING fingerprint of a result. */
function missingFingerprint(r: ImportResult): string {
  const found = r.diagnostics.filter((d) => d.code === 'ORIG_MISSING');
  expect(found).toHaveLength(1);
  expect(found[0].severity).toBe('warning');
  return found[0].fingerprint;
}

/** Import with an empty case folder, so every indexed original is missing. */
async function importMissing(docPath: string, bytes: Uint8Array, edit?: (m: any) => void) {
  const caseFolder = await mkdtemp(path.join(root, 'missing-'));
  let files = miniPackage({ docs: [{ ref: 'GT-001', path: docPath, bytes }] });
  if (edit) files = editManifestOnly(files, edit);
  const result = await importCandidate({ files }, caseFolder);
  expect(result.verdict).toBe('report');
  return result;
}

describe('CC-23 r3: a missing-original acknowledgement is bound to the document, not only its ref', () => {
  it.each([
    ['a different path and different bytes', 'old.pdf', pdfA, 'different.pdf', pdfB],
    ['the same path and size but different bytes', 'old.pdf', pdfA, 'old.pdf', pdfC],
    ['the same bytes at a different path', 'old.pdf', pdfA, 'moved/old.pdf', pdfA],
  ])('does not let GT-001 missing earlier waive GT-001 missing as %s', async (_label, firstPath, firstBytes, secondPath, secondBytes) => {
    const first = await importMissing(firstPath, firstBytes);
    const second = await importMissing(secondPath, secondBytes);
    expect(second.candidate?.caseId).toBe(first.candidate?.caseId);
    const fp = missingFingerprint(second);
    expect(fp).not.toBe(missingFingerprint(first));
    // the earlier result's accepted warnings, used as the trusted baseline, must not cover the new document
    const decision = canActivate(second, null, first.warningFingerprints);
    expect(decision.ok).toBe(false);
    expect(decision.newWarnings).toContain(fp);
    expect(decision.reasons.map((r) => r.code)).toContain('ACK_REQUIRED');
  });

  it('keeps the fingerprint of an unchanged missing document stable (positive control)', async () => {
    const first = await importMissing('old.pdf', pdfA);
    const again = await importMissing('old.pdf', pdfA);
    const relabelled = await importMissing('old.pdf', pdfA, (m) => { m.case.label = 'Changed display label'; });
    expect(missingFingerprint(again)).toBe(missingFingerprint(first));
    expect(missingFingerprint(relabelled)).toBe(missingFingerprint(first));
    for (const later of [again, relabelled]) {
      expect(canActivate(later, null)).toMatchObject({ ok: false });
      expect(canActivate(later, null, first.warningFingerprints)).toEqual({ ok: true, reasons: [], newWarnings: [] });
    }
  });
});

// ---- minimal zip writer (synthetic archives only) ----------------------------------------------

interface Member { name: string; method: 0 | 8; body: Uint8Array; usize: number; crc: number; csize?: number }

function zip(members: Member[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const name = Buffer.from(m.name, 'utf8');
    const csize = m.csize ?? m.body.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(m.method, 8);
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(m.crc, 14); local.writeUInt32LE(csize, 18); local.writeUInt32LE(m.usize, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(m.method, 10);
    cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(m.crc, 16); cd.writeUInt32LE(csize, 20); cd.writeUInt32LE(m.usize, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    parts.push(local, name, Buffer.from(m.body));
    offset += 30 + name.length + m.body.byteLength;
  }
  const cdBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cdBytes.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBytes, eocd]);
}

const stored = (name: string, data: Uint8Array): Member => ({ name, method: 0, body: data, usize: data.byteLength, crc: crc32(data) >>> 0 });
const deflated = (name: string, data: Uint8Array): Member => ({ name, method: 8, body: deflateRawSync(data), usize: data.byteLength, crc: crc32(data) >>> 0 });

/** A valid raw-deflate stream for `data`, prefixed by empty non-final stored blocks until it reaches `atLeast` bytes. */
function paddedDeflate(name: string, data: Uint8Array, atLeast: number): Member {
  const tail = deflateRawSync(data);
  const blocks = Math.ceil(Math.max(0, atLeast - tail.length) / 5);
  const pad = Buffer.alloc(blocks * 5);
  for (let k = 0; k < blocks; k++) pad.set([0x00, 0x00, 0x00, 0xff, 0xff], k * 5); // BFINAL=0 BTYPE=00, LEN=0, NLEN=0xffff
  return { name, method: 8, body: Buffer.concat([pad, tail]), usize: data.byteLength, crc: crc32(data) >>> 0 };
}

async function withArchive<T>(bytes: Uint8Array, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(root, 'zip-'));
  const file = path.join(dir, 'package.zip');
  await writeFile(file, bytes);
  return use(file);
}

/** A file handle that records every read request's length; the real handle serves it. */
function recording(fh: FileHandle, lengths: number[]): FileHandle {
  return new Proxy(fh, {
    get(target, prop) {
      if (prop === 'read') return (buf: Buffer, off: number, len: number, pos: number) => { lengths.push(len); return target.read(buf, off, len, pos); };
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const tight = { ...LIMITS, archiveEntryBytes: 16, archiveTotalBytes: 32 };
const x = enc.encode('x');

describe('CC-23 r3: zip compressed input is bounded by the declared size before it is read', () => {
  it('rejects a one-byte entry carried by a padded deflate stream under tight archive bounds', async () => {
    const member = paddedDeflate('x.txt', x, 2 * 1024 * 1024 + 3);
    expect(inflateCheck(member)).toBe('x');
    await withArchive(zip([member]), async (file) => {
      const fh = await open(file, 'r');
      try {
        await expect(readCentralDirectory(fh, tight)).rejects.toMatchObject({ code: 'ARC_LIMIT', entry: 'x.txt' });
      } finally { await fh.close(); }
    });
  });

  it.each([
    ['deflate', 8, 1, 8 * 1024 * 1024],
    ['stored', 0, 1, 8 * 1024 * 1024],
    ['stored', 0, 16, 17],
  ] as const)('readEntry refuses a %s entry (method %i) declaring %i output and %i compressed bytes before reading it', async (_m, method, usize, csize) => {
    const data = enc.encode('y'.repeat(usize));
    const lengths: number[] = [];
    await withArchive(zip([stored('y.txt', data)]), async (file) => {
      const fh = await open(file, 'r');
      try {
        const entry: ZipEntry = { name: 'y.txt', method, flags: 0x800, crc32: crc32(data) >>> 0, compressedSize: csize, uncompressedSize: usize, localHeaderOffset: 0, isDirectory: false };
        const err = await readEntry(recording(fh, lengths), entry).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(ZipError);
        expect((err as ZipError).code).toBe(method === 0 ? 'ARC_MALFORMED' : 'ARC_LIMIT');
        expect(lengths).toEqual([]); // nothing was allocated or read for the oversized input
      } finally { await fh.close(); }
    });
  });

  it('rejects a stored entry whose compressed and declared sizes disagree at the directory', async () => {
    const data = enc.encode('stored body');
    const lying: Member = { ...stored('s.txt', Buffer.concat([data, Buffer.alloc(64)])), usize: data.byteLength, crc: crc32(data) >>> 0 };
    await withArchive(zip([lying]), async (file) => {
      const fh = await open(file, 'r');
      try {
        await expect(readCentralDirectory(fh, LIMITS)).rejects.toMatchObject({ code: 'ARC_MALFORMED', entry: 's.txt' });
      } finally { await fh.close(); }
    });
  });

  it('still reads legitimate stored and deflate entries under the same tight bounds (positive control)', async () => {
    const s = enc.encode('stored 1');
    const d = enc.encode('deflate 2');
    await withArchive(zip([stored('a.txt', s), deflated('b.txt', d)]), async (file) => {
      const fh = await open(file, 'r');
      try {
        const entries = await readCentralDirectory(fh, tight);
        expect(entries.map((e) => [e.name, e.method])).toEqual([['a.txt', 0], ['b.txt', 8]]);
        expect(Buffer.from(await readEntry(fh, entries[0])).toString()).toBe('stored 1');
        expect(Buffer.from(await readEntry(fh, entries[1])).toString()).toBe('deflate 2');
      } finally { await fh.close(); }
    });
  });

  describe('through importCandidate with a .zip package', () => {
    const doc = enc.encode('%PDF-1.4\n% invented zipped original\n%%EOF\n');
    let caseFolder: string;
    let files: Map<string, Uint8Array>;
    beforeAll(async () => {
      caseFolder = await mkdtemp(path.join(root, 'zip-case-'));
      await writeFile(path.join(caseFolder, 'source.pdf'), doc);
      files = miniPackage({ docs: [{ ref: 'GT-001', path: 'source.pdf', bytes: doc }] });
    });

    it.each(['deflate', 'stored'])('imports a legitimate %s package (positive control)', async (kind) => {
      const members = [...files].map(([name, data]) => (kind === 'deflate' ? deflated(name, data) : stored(name, data)));
      const result = await withArchive(zip(members), (file) => importCandidate(file, caseFolder));
      expect(result.verdict).toBe('accept');
      expect(result.candidate?.original('GT-001')?.path).toBe('source.pdf');
    });

    it('rejects a package whose manifest is a valid deflate stream padded far beyond its declared size', async () => {
      const members = [...files].map(([name, data]) => (name === 'manifest.json' ? paddedDeflate(name, data, 2 * data.byteLength + 4096) : deflated(name, data)));
      const result = await withArchive(zip(members), (file) => importCandidate(file, caseFolder));
      expect(result.verdict).toBe('reject');
      expect(result.candidate).toBeNull();
      expect(result.diagnostics.map((d) => d.code)).toEqual(['ARC_LIMIT']);
    });
  });
});

/** Sanity: the padded stream is itself a valid deflate stream for its data. */
function inflateCheck(m: Member): string {
  return Buffer.from(inflateRawSync(m.body)).toString();
}
