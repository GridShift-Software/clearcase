// A zip64 extended-information extra field on a central directory entry (APPNOTE 4.5.3): Google Drive's archiver
// writes one for entries past 2 GB even when the archive itself stays under 4 GB, with the fixed offset field at
// 0xffffffff. The reader resolves the offset (and sizes) from that field; a short field is a malformed archive.
import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { withLimits } from '../../src/lib/case-package/limits.ts';
import { readCentralDirectory, readEntry, ZipError } from '../../src/lib/case-package/zip.ts';
import { writeZip } from './hostile/zip-writer.ts';

const L = withLimits({});
const u16 = (n: number) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return new Uint8Array(b); };
const zip64 = (...fields: Uint8Array[]) => { const body = Buffer.concat(fields); return new Uint8Array(Buffer.concat([u16(0x0001), u16(body.length), body])); };

async function tempZip(bytes: Uint8Array) {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'cc-zip64-')), 'a.zip');
  await writeFile(file, bytes);
  return open(file, 'r');
}

describe('zip64 extended-information extra field', () => {
  test('an entry whose fixed offset is 0xffffffff is read at the offset in its zip64 field', async () => {
    const first = new TextEncoder().encode('first entry, long enough to push the second one along');
    const second = new TextEncoder().encode('%PDF-second');
    // the second entry's real local header offset is the first local header's length (30 + name + data)
    const realOffset = 30 + 'a.txt'.length + first.length;
    const fh = await tempZip(writeZip([
      { name: 'a.txt', data: first },
      { name: 'b.pdf', data: second, localOffset: 0xffffffff, centralExtra: zip64(u64(realOffset)) },
    ]));
    const entries = await readCentralDirectory(fh, L);
    expect(entries.map((e) => [e.name, e.localHeaderOffset])).toEqual([['a.txt', 0], ['b.pdf', realOffset]]);
    expect(Buffer.from(await readEntry(fh, entries[1]!)).toString()).toBe('%PDF-second');
    await fh.close();
  });

  test('sizes marked 0xffffffff come from the field too, in the APPNOTE order', async () => {
    const data = new TextEncoder().encode('sized by zip64');
    const fh = await tempZip(writeZip([
      { name: 's.txt', data, compressedSize: 0xffffffff, uncompressedSize: 0xffffffff, centralExtra: zip64(u64(data.length), u64(data.length)) },
    ]));
    const [e] = await readCentralDirectory(fh, L);
    expect([e!.compressedSize, e!.uncompressedSize]).toEqual([data.length, data.length]);
    expect(Buffer.from(await readEntry(fh, e!)).toString()).toBe('sized by zip64');
    await fh.close();
  });

  test('a zip64 field too short for the marked offset is malformed, not an out-of-bounds entry', async () => {
    const fh = await tempZip(writeZip([{ name: 'x.txt', data: new Uint8Array([1]), localOffset: 0xffffffff, centralExtra: zip64(u16(7)) }]));
    await expect(readCentralDirectory(fh, L)).rejects.toMatchObject({ code: 'ARC_MALFORMED', message: expect.stringContaining('zip64 extra field lacks') } satisfies Partial<ZipError>);
    await fh.close();
  });

  test('without a zip64 field a 0xffffffff offset is still out of bounds', async () => {
    const fh = await tempZip(writeZip([{ name: 'x.txt', data: new Uint8Array([1]), localOffset: 0xffffffff }]));
    await expect(readCentralDirectory(fh, L)).rejects.toMatchObject({ code: 'ARC_MALFORMED', message: 'entry data out of bounds' });
    await fh.close();
  });
});
