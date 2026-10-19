// Shared by the import side (Bun) and the renderers (browser): content sniffing, the ZIP central-directory reader with
// bounded extraction, CRC-32 and A1 address parsing. Pure JavaScript, no Node or DOM APIs.
import { Inflate } from 'fflate';

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const startsWith = (b, sig) => sig.every((v, i) => b[i] === v);

/** What the bytes are, independent of the file name or declared MIME. */
export function sniff(b) {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46])) return { kind: 'pdf', mime: 'application/pdf' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return { kind: 'image', mime: 'image/png' };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (ascii(b, 0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return { kind: 'media', mime: 'audio/wav' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ') return { kind: 'media', mime: 'video/x-msvideo' };
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return { kind: 'image', mime: 'image/tiff' };
  if (startsWith(b, [0x49, 0x49, 0x2b, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2b])) return { kind: 'image', mime: 'image/tiff', variant: 'bigtiff' };
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (['avif', 'avis'].includes(brand)) return { kind: 'image', mime: 'image/avif' };
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(brand)) return { kind: 'image', mime: 'image/heic' };
    if (brand === 'qt  ') return { kind: 'media', mime: 'video/quicktime' };
    if (brand.startsWith('M4A')) return { kind: 'media', mime: 'audio/mp4' };
    return { kind: 'media', mime: 'video/mp4' };
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'media', mime: ascii(b, 0, 64).includes('webm') ? 'video/webm' : 'video/x-matroska' };
  if (ascii(b, 0, 4) === 'OggS') return { kind: 'media', mime: 'audio/ogg' };
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'media', mime: 'audio/mpeg' };
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) { const format = oleFormat(b); return { kind: 'ole', format, mime: OLE_MIME[format] }; }
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) { const format = zipFormat(b); return { kind: 'zip', format, mime: ZIP_MIME[format] }; }
  if (startsWith(b, [0x50, 0x4b, 0x07, 0x08])) return { kind: 'zip', format: 'zip', mime: 'application/zip', variant: 'split' };
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 512)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { kind: 'active-text', mime: 'image/svg+xml' };
  if (head.startsWith('<html') || head.startsWith('<!doctype html') || head.startsWith('<script')) return { kind: 'active-text', mime: 'text/html' };
  if (head.startsWith('from ') && /\n(subject|from|message-id|date):/i.test(head)) return { kind: 'mbox', mime: 'application/mbox' };
  if (/^(received|from|to|subject|date|message-id|mime-version|return-path|delivered-to|x-[\w-]+):/i.test(head)) return { kind: 'email', mime: 'message/rfc822' };
  if (startsWith(b, [0x78, 0x9f, 0x3e, 0x22])) return { kind: 'tnef', mime: 'application/ms-tnef' };
  const container = containerOf(b);
  if (container) return { kind: 'unsupported-container', mime: container.mime, format: container.format };
  return looksLikeText(b) ? { kind: 'text', mime: 'text/plain' } : { kind: 'unknown', mime: 'application/octet-stream' };
}

/** Container formats the alpha does not open: a mailbox store, an archive or a compression wrapper (never previewed, always held). */
function containerOf(b) {
  if (ascii(b, 0, 4) === '!BDN') return { format: ascii(b, 8, 2) === 'SO' ? 'ost' : 'pst', mime: 'application/vnd.ms-outlook-pst' };
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { format: '7z', mime: 'application/x-7z-compressed' };
  if (ascii(b, 0, 4) === 'Rar!' && b[4] === 0x1a && b[5] === 0x07) return { format: 'rar', mime: 'application/vnd.rar' };
  if (startsWith(b, [0x1f, 0x8b])) return { format: 'gzip', mime: 'application/gzip' };
  if (ascii(b, 0, 3) === 'BZh') return { format: 'bzip2', mime: 'application/x-bzip2' };
  if (startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { format: 'xz', mime: 'application/x-xz' };
  if (startsWith(b, [0x28, 0xb5, 0x2f, 0xfd])) return { format: 'zstd', mime: 'application/zstd' };
  if (ascii(b, 257, 5) === 'ustar') return { format: 'tar', mime: 'application/x-tar' };
  return null;
}

/** Text means valid UTF-8 with no NUL and almost no other control characters. Anything else is not text: the default is to refuse. */
function looksLikeText(b) {
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return false; }
  let control = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c === 0) return false; if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) control++; }
  return control <= s.length / 50;
}

const ZIP_MIME = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'ooxml-other': 'application/zip', zip: 'application/zip' };
const OLE_MIME = { msg: 'application/vnd.ms-outlook', doc: 'application/msword', xls: 'application/vnd.ms-excel', 'ole-other': 'application/x-ole-storage' };

/** A ZIP is Word or a workbook by the OOXML parts it holds (a package needs [Content_Types].xml), never by its name. */
function zipFormat(b) {
  const names = new Set(listZip(b).entries.map((e) => e.path));
  if (!names.has('[Content_Types].xml')) return 'zip';
  if (names.has('word/document.xml')) return 'docx';
  if (names.has('xl/workbook.xml')) return 'xlsx';
  return 'ooxml-other';
}

/** The stream and storage names in an OLE compound file's directory (MS-CFB), or null when the structure cannot be walked. */
export function oleNames(b) {
  try {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const shift = v.getUint16(30, true);
    if (shift !== 9 && shift !== 12) return null;
    const ss = 1 << shift, per = ss / 4, end = 0xfffffffa;
    const at = (sector) => (sector + 1) * ss;
    const fatSectors = [];
    for (let i = 0; i < 109 && fatSectors.length < v.getUint32(44, true); i++) fatSectors.push(v.getUint32(76 + i * 4, true));
    for (let d = v.getUint32(68, true), guard = 0; d < end && guard < 4096; guard++) {
      for (let i = 0; i < per - 1 && fatSectors.length < v.getUint32(44, true); i++) fatSectors.push(v.getUint32(at(d) + i * 4, true));
      d = v.getUint32(at(d) + (per - 1) * 4, true);
    }
    const next = (n) => v.getUint32(at(fatSectors[Math.floor(n / per)]) + (n % per) * 4, true);
    const names = [];
    for (let n = v.getUint32(48, true), guard = 0; n < end && guard < 65536; n = next(n), guard++) {
      for (let o = at(n); o < at(n) + ss; o += 128) {
        const len = v.getUint16(o + 64, true);
        if (v.getUint8(o + 66) !== 0 && len >= 2 && len <= 64) names.push(new TextDecoder('utf-16le').decode(b.subarray(o, o + len - 2)));
      }
    }
    return names;
  } catch { return null; }
}

function oleFormat(b) {
  const names = new Set(oleNames(b) ?? []);
  if (names.has('__properties_version1.0')) return 'msg';
  if (names.has('WordDocument')) return 'doc';
  if (names.has('Workbook') || names.has('Book')) return 'xls';
  return 'ole-other';
}

let table;
export function crc32(b, crc = 0) {
  if (!table) { table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
  crc = ~crc >>> 0;
  for (let i = 0; i < b.length; i++) crc = table[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

export const ZIP_LIMITS = Object.freeze({ maxEntries: 10000, maxEntryBytes: 64 << 20, maxTotalBytes: 512 << 20, maxDepth: 3 });

/** Every central-directory entry in order (duplicates kept), with the reasons it cannot be previewed. */
export function listZip(b, limits = ZIP_LIMITS) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return { error: 'no-end-of-central-directory', entries: [] };
  const count = v.getUint16(eocd + 10, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) return { error: 'zip64-unsupported', entries: [] };
  if (count > limits.maxEntries) return { error: 'too-many-entries', entries: [] };
  const entries = [];
  const dec = new TextDecoder();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) return { error: 'corrupt-central-directory', entries };
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const attrs = v.getUint32(p + 38, true), local = v.getUint32(p + 42, true);
    const path = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    const mode = attrs >>> 16;
    const e = { ordinal: i, path, method, flags, crc, csize, size, local, directory: path.endsWith('/'), problems: [] };
    if (flags & 1) e.problems.push('encrypted');
    if (![0, 8].includes(method)) e.problems.push(`unsupported-method-${method}`);
    if ((mode & 0o170000) === 0o120000) e.problems.push('symlink');
    if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.includes('\\') || path.split('/').includes('..')) e.problems.push('unsafe-path');
    if (size > limits.maxEntryBytes) e.problems.push('declared-size-over-limit');
    entries.push(e);
    p += 46 + nlen + xlen + clen;
  }
  const seen = new Map();
  for (const e of entries) seen.set(e.path, (seen.get(e.path) ?? 0) + 1);
  for (const e of entries) e.duplicateName = seen.get(e.path) > 1;
  return { error: null, entries };
}

/** Extract one entry with a hard expansion cap and a CRC check; never trusts the declared size. */
export function extractEntry(b, e, limits = ZIP_LIMITS) {
  if (e.problems.length) return { ok: false, reason: e.problems[0] };
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(e.local, true) !== 0x04034b50) return { ok: false, reason: 'corrupt-local-header' };
  const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
  const comp = b.subarray(start, start + e.csize);
  if (e.method === 0) {
    if (crc32(comp) !== e.crc) return { ok: false, reason: 'crc-mismatch' };
    return { ok: true, bytes: comp.slice() };
  }
  const chunks = [];
  let total = 0, over = false;
  const inf = new Inflate((c) => { if (over) return; total += c.length; if (total > limits.maxEntryBytes) { over = true; return; } chunks.push(c); });
  for (let o = 0; o < comp.length && !over; o += 65536) inf.push(comp.subarray(o, o + 65536), o + 65536 >= comp.length);
  if (over) return { ok: false, reason: 'expansion-limit-exceeded', expandedAtStop: total };
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  if (crc32(out) !== e.crc) return { ok: false, reason: 'crc-mismatch' };
  return { ok: true, bytes: out };
}

const MAX_COL = 16384, MAX_ROW = 1048576;
/** 'B7' or 'B2:C4' to zero-based bounds, or null when it is not a valid A1 reference inside Excel's grid. */
export function parseA1(ref) {
  const one = (s) => {
    const m = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(s);
    if (!m) return null;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
    const r = +m[2];
    return c <= MAX_COL && r <= MAX_ROW ? { c: c - 1, r: r - 1 } : null;
  };
  const [a, b, extra] = String(ref).toUpperCase().split(':');
  if (extra !== undefined) return null;
  const s = one(a), e = b === undefined ? s : one(b);
  if (!s || !e) return null;
  return { s: { r: Math.min(s.r, e.r), c: Math.min(s.c, e.c) }, e: { r: Math.max(s.r, e.r), c: Math.max(s.c, e.c) } };
}
