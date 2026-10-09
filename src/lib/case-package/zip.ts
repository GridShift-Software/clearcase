// Defensive zip reader for the optional package transport. The central directory is read
// and checked before any entry is decoded; entries are decoded in memory only (nothing is
// extracted to disk), with the compressed input bounded by the declared size before it is read
// and the actual expansion bounded by the declared size and CRC-32.
import type { FileHandle } from 'node:fs/promises';
import { crc32, inflateRawSync } from 'node:zlib';
import type { Limits } from './limits.ts';
import { checkRelPath, foldPath } from './paths.ts';

export type ZipErrorCode = 'ARC_MALFORMED' | 'ARC_UNSUPPORTED' | 'ARC_LIMIT' | 'ARC_ENTRY_INVALID';
export class ZipError extends Error {
  readonly code: ZipErrorCode;
  readonly entry?: string;
  constructor(code: ZipErrorCode, message: string, entry?: string) {
    super(message);
    this.code = code;
    this.entry = entry;
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

// ignoreBOM keeps a leading U+FEFF: member names stay byte-exact ("\uFEFFassets.json" is not assets.json)
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** Many writers store UTF-8 names without the UTF-8 flag; try UTF-8 first, then CP437. */
function decodeName(b: Uint8Array, utf8Flag: boolean): string {
  try {
    return utf8.decode(b);
  } catch {
    if (utf8Flag) throw new ZipError('ARC_MALFORMED', 'entry name is flagged UTF-8 but is not valid UTF-8');
    let s = '';
    for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80];
    return s;
  }
}

/**
 * Most compressed bytes a writer can produce for `n` bytes: stored is exact; deflate expands
 * incompressible data by at most a fixed-Huffman 9 bits per byte plus block headers.
 */
function maxCompressed(method: number, n: number): number {
  return method === 0 ? n : n + Math.ceil(n / 8) + 64;
}

/** Refuses compressed bytes its declared output cannot need, before anything is allocated for them. */
function checkCompressed(method: number, csize: number, usize: number, name: string): void {
  if (method === 0 && csize !== usize) throw new ZipError('ARC_MALFORMED', `stored entry declares ${csize} compressed and ${usize} uncompressed bytes; they must be equal`, name);
  if (csize > maxCompressed(method, usize)) throw new ZipError('ARC_LIMIT', `entry has ${csize} compressed bytes for ${usize} declared bytes (at most ${maxCompressed(method, usize)})`, name);
}

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new ZipError('ARC_MALFORMED', 'truncated archive');
  return buf;
}

/** Central directory with every bound and entry rule applied before anything is decoded. */
export async function readCentralDirectory(fh: FileHandle, L: Limits): Promise<ZipEntry[]> {
  const { size } = await fh.stat();
  if (size < 22) throw new ZipError('ARC_MALFORMED', 'too small to be a zip archive');
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eocd = -1;
  for (let k = tail.length - 22; k >= 0; k--) if (tail.readUInt32LE(k) === 0x06054b50) { eocd = k; break; }
  if (eocd < 0) throw new ZipError('ARC_MALFORMED', 'end of central directory not found');
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw new ZipError('ARC_UNSUPPORTED', 'multi-disk archives are not supported');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new ZipError('ARC_UNSUPPORTED', 'zip64 archives are not supported for packages');
  if (count > L.archiveEntries) throw new ZipError('ARC_LIMIT', `archive has ${count} entries (limit ${L.archiveEntries})`);
  if (cdOff + cdSize > size) throw new ZipError('ARC_MALFORMED', 'central directory out of bounds');
  // bound the directory by what `count` entries can occupy before reading it into memory
  if (cdSize > count * (46 + L.archiveNameBytes + 2 * 0xffff)) throw new ZipError('ARC_LIMIT', 'central directory larger than its entries can be');
  const cd = await readAt(fh, cdOff, cdSize);
  const out: ZipEntry[] = [];
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  const files = new Set<string>();
  const dirs = new Set<string>();
  let total = 0;
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('ARC_MALFORMED', 'bad central directory header');
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    const startDisk = cd.readUInt16LE(p + 34);
    const ext = cd.readUInt32LE(p + 38);
    const loff = cd.readUInt32LE(p + 42);
    if (p + 46 + nlen + xlen + clen > cd.length) throw new ZipError('ARC_MALFORMED', 'central directory entry overruns');
    if (nlen > L.archiveNameBytes) throw new ZipError('ARC_LIMIT', 'entry name too long');
    const name = decodeName(cd.subarray(p + 46, p + 46 + nlen), (flags & 0x800) !== 0);
    p += 46 + nlen + xlen + clen;
    if (startDisk !== 0) throw new ZipError('ARC_UNSUPPORTED', 'multi-disk entry', name);
    if (flags & 0x1) throw new ZipError('ARC_UNSUPPORTED', 'encrypted entry', name);
    const host = madeBy >> 8;
    const mode = ext >>> 16;
    if ((host === 3 || host === 19) && (mode & 0o170000) === 0o120000) throw new ZipError('ARC_ENTRY_INVALID', 'symlink entry', name);
    if ((host === 3 || host === 19) && (mode & 0o170000) !== 0 && (mode & 0o170000) !== 0o100000 && (mode & 0o170000) !== 0o040000) throw new ZipError('ARC_ENTRY_INVALID', 'special file entry', name);
    const isDirectory = name.endsWith('/');
    const rel = isDirectory ? name.slice(0, -1) : name;
    const pv = checkRelPath(rel);
    if (!pv.ok) throw new ZipError('ARC_ENTRY_INVALID', `unsafe entry name (${pv.reason})`, name);
    if (exact.has(name)) throw new ZipError('ARC_ENTRY_INVALID', 'duplicate entry', name);
    exact.add(name);
    const f = foldPath(name);
    if (folded.has(f)) throw new ZipError('ARC_ENTRY_INVALID', `entry collides with ${folded.get(f)} after case/NFC folding`, name);
    folded.set(f, name);
    if (isDirectory) { dirs.add(rel); continue; }
    if (method !== 0 && method !== 8) throw new ZipError('ARC_UNSUPPORTED', `compression method ${method}`, name);
    if (usize > L.archiveEntryBytes) throw new ZipError('ARC_LIMIT', `entry expands to ${usize} bytes (limit ${L.archiveEntryBytes})`, name);
    if (usize > L.archiveRatioFloor && usize > csize * L.archiveRatio) throw new ZipError('ARC_LIMIT', `compression ratio above ${L.archiveRatio}:1`, name);
    total += usize;
    if (total > L.archiveTotalBytes) throw new ZipError('ARC_LIMIT', `archive expands beyond ${L.archiveTotalBytes} bytes`);
    // compressed bytes are bounded by the declared size just checked, so the per-entry and total
    // bounds also cap what readEntry can allocate (at most 9/8 of each plus 64 bytes per entry)
    checkCompressed(method, csize, usize, name);
    if (loff + 30 > size || loff + csize > size) throw new ZipError('ARC_MALFORMED', 'entry data out of bounds', name);
    files.add(rel);
    out.push({ name, method, flags, crc32: crc, compressedSize: csize, uncompressedSize: usize, localHeaderOffset: loff, isDirectory });
  }
  // a file and a folder with the same name, or a file used as a folder prefix
  for (const fpath of files) {
    if (dirs.has(fpath)) throw new ZipError('ARC_ENTRY_INVALID', 'entry is both a file and a folder', fpath);
    const segs = fpath.split('/');
    for (let k = 1; k < segs.length; k++) if (files.has(segs.slice(0, k).join('/'))) throw new ZipError('ARC_ENTRY_INVALID', 'a file is used as a folder', fpath);
  }
  return out;
}

/** Decode one entry in memory; checks the local header, method, actual size and CRC-32. */
export async function readEntry(fh: FileHandle, e: ZipEntry): Promise<Buffer> {
  checkCompressed(e.method, e.compressedSize, e.uncompressedSize, e.name);
  const h = await readAt(fh, e.localHeaderOffset, 30);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new ZipError('ARC_MALFORMED', 'bad local header', e.name);
  const off = e.localHeaderOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const raw = e.compressedSize ? await readAt(fh, off, e.compressedSize) : Buffer.alloc(0);
  let data: Buffer;
  if (e.method === 0) data = raw;
  else {
    try {
      // maxOutputLength bounds the actual expansion even if the declared size lies
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.uncompressedSize) });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new ZipError(code === 'ERR_BUFFER_TOO_LARGE' || /too large|maxOutputLength/i.test(String(err)) ? 'ARC_LIMIT' : 'ARC_MALFORMED', 'entry expands beyond its declared size or is corrupt', e.name);
    }
  }
  if (data.length !== e.uncompressedSize) throw new ZipError('ARC_MALFORMED', 'decoded size differs from the declared size', e.name);
  if ((crc32(data) >>> 0) !== (e.crc32 >>> 0)) throw new ZipError('ARC_MALFORMED', 'CRC-32 mismatch', e.name);
  return data;
}
