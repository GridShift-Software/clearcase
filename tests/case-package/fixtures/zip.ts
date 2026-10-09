// Minimal stored-entry zip writer for transport tests (valid archives only).
import { crc32 } from 'node:zlib';

export function storedZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, Buffer.from(data));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    centrals.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.size, 8); eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}
