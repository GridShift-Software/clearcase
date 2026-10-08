// Media types, text capability and the serving policy for original bytes.
// Capability decides which textStatus values are consistent:
//   text: an extractor exists (pdf, e-mail, office, plain text, html)
//   ocr:  only OCR can yield text (images)
//   none: no extractor (archives, unknown binaries)
// "Unsupported media" (no extractor) and "missing text" (extractor ran, nothing came out)
// are different findings. Browser-safe: no Node built-ins.

export type TextStatus = 'extracted' | 'ocr' | 'none' | 'pending' | 'unsupported';
export const TEXT_STATUSES: readonly TextStatus[] = ['extracted', 'ocr', 'none', 'pending', 'unsupported'];
export type Capability = 'text' | 'ocr' | 'none';
/** How the app may serve an original. Never from the application origin. */
export type ServeMode = 'inline-isolated' | 'text-sandboxed' | 'download';

interface MediaDef { type: string; cap: Capability; serve: ServeMode; family: string; container: boolean }

const M = (type: string, cap: Capability, serve: ServeMode, family: string, container = false): MediaDef => ({ type, cap, serve, family, container });

const BY_EXT: Record<string, MediaDef> = {
  pdf: M('application/pdf', 'text', 'inline-isolated', 'pdf'),
  eml: M('message/rfc822', 'text', 'text-sandboxed', 'email', true),
  msg: M('application/vnd.ms-outlook', 'text', 'download', 'ole', true),
  jpg: M('image/jpeg', 'ocr', 'inline-isolated', 'jpeg'),
  jpeg: M('image/jpeg', 'ocr', 'inline-isolated', 'jpeg'),
  png: M('image/png', 'ocr', 'inline-isolated', 'png'),
  gif: M('image/gif', 'ocr', 'inline-isolated', 'gif'),
  webp: M('image/webp', 'ocr', 'inline-isolated', 'webp'),
  tif: M('image/tiff', 'ocr', 'download', 'tiff'),
  tiff: M('image/tiff', 'ocr', 'download', 'tiff'),
  bmp: M('image/bmp', 'ocr', 'download', 'bmp'),
  docx: M('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text', 'download', 'zip'),
  xlsx: M('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text', 'download', 'zip'),
  pptx: M('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text', 'download', 'zip'),
  doc: M('application/msword', 'text', 'download', 'ole'),
  xls: M('application/vnd.ms-excel', 'text', 'download', 'ole'),
  ppt: M('application/vnd.ms-powerpoint', 'text', 'download', 'ole'),
  rtf: M('application/rtf', 'text', 'download', 'rtf'),
  txt: M('text/plain', 'text', 'text-sandboxed', 'text'),
  csv: M('text/csv', 'text', 'text-sandboxed', 'text'),
  htm: M('text/html', 'text', 'text-sandboxed', 'html'),
  html: M('text/html', 'text', 'text-sandboxed', 'html'),
  xml: M('application/xml', 'text', 'download', 'xml'),
  svg: M('image/svg+xml', 'none', 'download', 'html'), // scriptable: never inline
  zip: M('application/zip', 'none', 'download', 'zip', true),
};
const OCTET: MediaDef = M('application/octet-stream', 'none', 'download', 'unknown');
const BY_TYPE = new Map<string, MediaDef>(Object.values(BY_EXT).map((d) => [d.type, d]));

export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return m ? m[1]!.toLowerCase() : '';
}
export const mediaTypeForName = (name: string): string => (BY_EXT[extOf(name)] ?? OCTET).type;
const def = (mediaType: string): MediaDef => BY_TYPE.get(mediaType) ?? OCTET;
export const capabilityOf = (mediaType: string): Capability => def(mediaType).cap;
export const isContainer = (mediaType: string): boolean => def(mediaType).container;
export const serveModeOf = (mediaType: string): ServeMode => def(mediaType).serve;

/** Is textStatus consistent with what the media type allows? */
export function textStatusConsistent(mediaType: string, s: TextStatus): boolean {
  const cap = capabilityOf(mediaType);
  if (s === 'pending') return true;
  if (cap === 'text') return s !== 'unsupported';
  if (cap === 'ocr') return s !== 'extracted';
  return s === 'unsupported';
}

/**
 * Response headers for serving an original. Rules for the importer's originals server:
 * a separate loopback origin (the hardened prototype uses http://clearcase-originals.localhost:<port>
 * bound to 127.0.0.1), always nosniff, never text/html, image/svg+xml or XML. HTML, e-mail and
 * text are shown as sandboxed text/plain; active or unknown types download; images are inline
 * with a sandbox CSP; PDFs are inline on the separate origin (Chromium's viewer refuses a
 * sandboxed document, so the pilot renders PDFs in a sandboxed pdf.js frame; GRS-12 measures it).
 */
export function servePolicy(mediaType: string, filename: string, contentMismatch = false): { mode: ServeMode; headers: Record<string, string> } {
  const d = def(mediaType);
  const mode: ServeMode = contentMismatch ? 'download' : d.serve;
  const name = filename.slice(filename.lastIndexOf('/') + 1).replace(/[\u0000-\u001f\u007f-\u009f"\\‪-‮⁦-⁩]/g, '_').slice(0, 200) || 'original';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const cd = (kind: string) => `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
  const common = { 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-site', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, no-store' };
  if (mode === 'download') {
    return { mode, headers: { ...common, 'Content-Type': 'application/octet-stream', 'Content-Disposition': cd('attachment'), 'Content-Security-Policy': "sandbox; default-src 'none'" } };
  }
  if (mode === 'text-sandboxed') {
    return { mode, headers: { ...common, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': cd('inline'), 'Content-Security-Policy': "sandbox; default-src 'none'" } };
  }
  const csp = d.family === 'pdf' ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self'";
  return { mode, headers: { ...common, 'Content-Type': d.type, 'Content-Disposition': cd('inline'), 'Content-Security-Policy': csp } };
}

/** Content sniff of the first bytes; a family name, or null when undecidable. */
export function sniffFamily(head: Uint8Array): string | null {
  const b = head;
  const starts = (...xs: number[]) => xs.every((x, k) => b[k] === x);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf';
  if (starts(0xff, 0xd8, 0xff)) return 'jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06)) return 'zip';
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'ole';
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return 'tiff';
  if (starts(0x42, 0x4d)) return 'bmp';
  if (starts(0x7b, 0x5c, 0x72, 0x74, 0x66)) return 'rtf';
  let raw = '';
  for (let i = 0; i < Math.min(b.length, 1024); i++) raw += String.fromCharCode(b[i]!);
  if (raw.includes('%PDF-')) return 'pdf'; // PDF allows leading bytes before the header
  const text = raw.slice(0, 512).toLowerCase().replace(/^(?:\s|ï»¿)+/, '');
  if (/^(<!doctype html|<html|<script|<svg|<\?xml[^>]*>\s*<svg|<body|<iframe)/.test(text) || /<script[\s>]/.test(text)) return 'html';
  return null;
}

/** Declared media vs sniffed family. Only a positive contradiction counts. */
export function contentContradictsType(mediaType: string, head: Uint8Array): boolean {
  const fam = sniffFamily(head);
  const d = def(mediaType);
  if (fam === 'html') return !['html', 'text', 'email', 'xml'].includes(d.family);
  if (fam === null) return ['pdf', 'jpeg', 'png', 'gif', 'webp', 'zip', 'ole'].includes(d.family) && head.length > 0;
  if (d.family === 'unknown' || d.family === 'text' || d.family === 'email') return false;
  return fam !== d.family;
}
