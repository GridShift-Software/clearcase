// Tiny deterministic zip writer for the hostile transport cases. It writes exactly what it is
// told, including lies: wrong sizes or CRC, encrypted or unknown-method flags, unix symlink and
// FIFO modes, duplicate or traversing names, raw (non-UTF-8) name bytes, broken directories.
// Synthetic, test-only; never used to read anything.
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  /** a string is written as UTF-8; bytes are written verbatim */
  name: string | Uint8Array;
  /** uncompressed bytes (default empty) */
  data?: Uint8Array;
  /** 0 stored (default), 8 deflate; any other number is written as-is over `compressed` or `data` */
  method?: number;
  /** payload override (written instead of the stored or deflated data) */
  compressed?: Uint8Array;
  /** general purpose flags; default sets 0x800 (UTF-8) when a string name is not ASCII */
  flags?: number;
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  /** "version made by" host byte: 3 = unix (default), 0 = MS-DOS */
  host?: number;
  /** unix mode written to the external attributes (default 0o100644, or 0o040755 for "x/") */
  mode?: number;
  diskStart?: number;
  /** local header offset written to the central directory (default: the real offset) */
  localOffset?: number;
}

export interface ZipOptions {
  /** entry count written to the end record (default: the real count) */
  count?: number;
  cdOffset?: number;
  cdSize?: number;
  /** "number of this disk" and "disk where the central directory starts" */
  disk?: number;
  cdDisk?: number;
  /** drop this many bytes from the end of the archive */
  truncate?: number;
  /** omit the end-of-central-directory record */
  noEocd?: boolean;
}

const enc = new TextEncoder();
const u16 = (n: number) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
const u32 = (n: number) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

export function writeZip(entries: ZipEntrySpec[], o: ZipOptions = {}): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let localSize = 0;
  for (const e of entries) {
    const name = typeof e.name === 'string' ? enc.encode(e.name) : e.name;
    const data = e.data ?? new Uint8Array();
    const method = e.method ?? 0;
    const payload = e.compressed ?? (method === 8 ? new Uint8Array(deflateRawSync(data)) : data);
    const ascii = typeof e.name !== 'string' || /^[\x00-\x7f]*$/.test(e.name);
    const flags = e.flags ?? (ascii ? 0 : 0x800);
    const crc = e.crc ?? crc32(data) >>> 0;
    const csize = e.compressedSize ?? payload.byteLength;
    const usize = e.uncompressedSize ?? data.byteLength;
    const isDir = name.length > 0 && name[name.length - 1] === 0x2f;
    const mode = e.mode ?? (isDir ? 0o040755 : 0o100644);
    const host = e.host ?? 3;
    const offset = localSize;
    // local file header: time 0, date 1980-01-01 (deterministic)
    const lh = concat([u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0x21),
      u32(crc), u32(csize), u32(usize), u16(name.length), u16(0), name, payload]);
    local.push(lh);
    localSize += lh.byteLength;
    central.push(concat([u32(0x02014b50), u16((host << 8) | 20), u16(20), u16(flags), u16(method), u16(0), u16(0x21),
      u32(crc), u32(csize), u32(usize), u16(name.length), u16(0), u16(0),
      u16(e.diskStart ?? 0), u16(0), u32((mode << 16) >>> 0), u32(e.localOffset ?? offset), name]));
  }
  const cd = concat(central);
  const parts = [...local, cd];
  if (!o.noEocd) {
    const count = o.count ?? entries.length;
    parts.push(concat([u32(0x06054b50), u16(o.disk ?? 0), u16(o.cdDisk ?? 0), u16(count), u16(count),
      u32(o.cdSize ?? cd.byteLength), u32(o.cdOffset ?? localSize), u16(0)]));
  }
  const bytes = concat(parts);
  return o.truncate ? bytes.subarray(0, bytes.length - o.truncate) : bytes;
}

/** Zip entries for every file of an in-memory package (deflated, sorted, unix regular files). */
export function packageEntries(files: ReadonlyMap<string, Uint8Array>, method = 8): ZipEntrySpec[] {
  return [...files.keys()].sort().map((name) => ({ name, data: files.get(name)!, method }));
}
