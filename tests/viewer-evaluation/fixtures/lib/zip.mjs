// Raw ZIP writer for synthetic and hostile archive fixtures: duplicate names, traversal paths, symlinks, wrong CRCs,
// encryption flags and unsupported methods are written exactly as asked, which fflate's zipSync refuses to do.
import { deflateRawSync } from 'node:zlib';
import { Deflate } from 'fflate';

const enc = new TextEncoder();
export const crc32 = (b) => Bun.hash.crc32(b) >>> 0;

/** entries: [{ name, data (Uint8Array|string), method 0|8|n, crc, flags, unixMode, raw (precompressed bytes), size }] */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : (e.data ?? new Uint8Array());
    const name = enc.encode(e.name);
    const method = e.method ?? 8;
    const comp = e.raw ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const flags = (e.flags ?? 0) | 0x0800; // UTF-8 names
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, flags, true); lh.setUint16(8, method, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true);
    lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 0x031e, true); ch.setUint16(6, 20, true); ch.setUint16(8, flags, true);
    ch.setUint16(10, method, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(38, ((e.unixMode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, true); ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of all) { out.set(b, o); o += b.length; }
  return out;
}

/** Deflate `total` zero bytes in 1 MiB slices without holding the expansion in memory (bounded bomb fixture). */
export function zeroBomb(total) {
  const chunks = [];
  const d = new Deflate({ level: 9 }, (c) => chunks.push(c));
  const slice = new Uint8Array(1 << 20);
  for (let left = total; left > 0; left -= slice.length) d.push(left > slice.length ? slice : slice.subarray(0, left), left <= slice.length);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
