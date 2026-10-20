// Synthetic stand-ins for formats the alpha viewers do not read. Only the leading bytes that identify each format are
// real (PST/OST `!BDN` header, 7z, RAR, gzip, bzip2, xz signatures); the rest is filler, so none of these opens in any
// tool. `opaque.bin` has no signature at all: unknown bytes must fail closed, not fall back to text.
import { gzipSync } from 'node:zlib';

const filler = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 17 + (i >> 3)) & 0xff);
const withHead = (head, n, seed) => { const b = filler(n, seed); b.set(head); return b; };

export function unknownBlobs() {
  const pst = withHead([0x21, 0x42, 0x44, 0x4e, 0, 0, 0, 0, 0x53, 0x4d], 512, 1);
  const ost = withHead([0x21, 0x42, 0x44, 0x4e, 0, 0, 0, 0, 0x53, 0x4f], 512, 2);
  return {
    'synthetic-mailbox.pst': pst,
    'synthetic-cache.ost': ost,
    'synthetic-archive.7z': withHead([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4], 400, 3),
    'synthetic-archive.rar': withHead([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00], 400, 4),
    'synthetic-takeout.tgz': gzipSync(Buffer.from('GZIP-SYNTHETIC-TOKEN '.repeat(40))),
    'opaque.bin': filler(600, 5).map((v) => (v === 0 ? 1 : v) | 0x80),
  };
}
