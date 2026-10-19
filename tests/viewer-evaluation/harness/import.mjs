// The candidate-import side of the evaluation (stands in for the trusted Worker or operator step): classify every
// fixture by its bytes, hash it, extract the closed child graph (email attachments, nested messages, archive members)
// and record the holds a failed preview puts on the whole update. Renderers receive the resulting descriptors.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import PostalMime from 'postal-mime';
import MsgReaderModule from '@kenjiuno/msgreader';
import { sniff, listZip, extractEntry, ZIP_LIMITS } from './shared/formats.mjs';

const MsgReader = MsgReaderModule.default ?? MsgReaderModule;
const sha = (b) => createHash('sha256').update(b).digest('hex');
export const SCHEMA = 'clearcase.viewer-descriptor/1';

/** Which reader family previews a sniffed kind (declared names never decide this). */
function familyOf(kind, name) {
  if (kind === 'zip') return /\.docx$/i.test(name) ? 'word' : /\.xlsx$/i.test(name) ? 'sheet' : 'archive';
  if (kind === 'ole') return /\.msg$/i.test(name) ? 'email' : /\.xls$/i.test(name) ? 'sheet' : /\.doc$/i.test(name) ? 'word' : 'unknown';
  if (kind === 'text' && /\.csv$/i.test(name)) return 'sheet';
  return { pdf: 'pdf', image: 'image', media: 'media', email: 'email', mbox: 'email', text: 'text' }[kind] ?? 'unknown';
}

const DECLARED = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic', '.tif': 'image/tiff' };

export function createStore(fixtureDir) {
  const manifest = JSON.parse(readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
  const assets = new Map();
  const add = (id, bytes, name, extra = {}) => {
    const s = sniff(bytes);
    const a = { id, bytes, name, sha256: sha(bytes), size: bytes.length, mime: s.mime, kind: s.kind, variant: s.variant, format: s.format, pages: s.pages, family: familyOf(s.kind, name), ...extra };
    assets.set(id, a);
    return a;
  };
  for (const f of manifest.fixtures) add(f.id, new Uint8Array(readFileSync(path.join(fixtureDir, f.file))), path.basename(f.file), { fixture: f });
  return { manifest, assets, add };
}

/** Expand the attachment graph of an EML or MSG into child assets; returns [{key, ...}] and holds. */
async function emailChildren(store, a, depth = 0) {
  const children = [], holds = [];
  if (depth > ZIP_LIMITS.maxDepth) return { children, holds: [{ code: 'nesting-limit', detail: a.id }] };
  if (a.kind === 'ole') {
    const r = new MsgReader(a.bytes);
    const d = r.getFileData();
    if (d.error) return { children, holds: [{ code: 'email-parse-failed', detail: d.error }] };
    if (!d.body && !d.bodyHtml && !d.html && d.compressedRtf) holds.push({ code: 'rtf-only-body-needs-companion', detail: a.id });
    for (const [i, att] of d.attachments.entries()) {
      const c = r.getAttachment(att);
      const name = att.innerMsgContent ? `${att.name ?? 'embedded'}.msg` : (att.fileName ?? `attachment-${i}`);
      const child = store.add(`${a.id}#${i}`, new Uint8Array(c.content), name, { parent: { assetId: a.id, key: String(i) } });
      children.push({ key: String(i), assetId: child.id, name, mime: child.mime, sha256: child.sha256, contentId: att.pidContentId ?? null, embeddedMessage: !!att.innerMsgContent });
      if (child.family === 'email') { const n = await emailChildren(store, child, depth + 1); child.children = n.children; holds.push(...n.holds); }
    }
    return { children, holds };
  }
  const raw = new TextDecoder().decode(a.bytes);
  for (const m of raw.matchAll(/Content-Transfer-Encoding:\s*base64\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)(?=\r?\n--|$)/gi)) {
    if (/[^A-Za-z0-9+/=\s]/.test(m[1])) holds.push({ code: 'malformed-mime-part', detail: 'base64 body contains characters outside the alphabet' });
  }
  const e = await PostalMime.parse(a.bytes, { attachmentEncoding: 'arraybuffer' });
  for (const [i, att] of e.attachments.entries()) {
    const bytes = new Uint8Array(att.content);
    const child = store.add(`${a.id}#${i}`, bytes, att.filename ?? `attachment-${i}`, { parent: { assetId: a.id, key: String(i) } });
    children.push({ key: String(i), assetId: child.id, name: att.filename, mime: child.mime, declaredMime: att.mimeType, sha256: child.sha256, contentId: att.contentId ?? null, inline: att.disposition === 'inline' });
    if (child.kind === 'tnef') holds.push({ code: 'tnef-needs-companion', detail: `${a.id}#${i}` });
    if (child.family === 'email') { const n = await emailChildren(store, child, depth + 1); child.children = n.children; holds.push(...n.holds); }
  }
  return { children, holds };
}

function archiveChildren(store, a) {
  const { error, entries } = listZip(a.bytes);
  const holds = error ? [{ code: `archive-${error}`, detail: a.id }] : [];
  const children = [];
  let total = 0;
  for (const e of entries) {
    if (e.directory && !e.problems.length) { children.push({ key: String(e.ordinal), path: e.path, directory: true, problems: [] }); continue; }
    const x = extractEntry(a.bytes, e);
    if (!x.ok) { holds.push({ code: `archive-${x.reason}`, detail: `${a.id}#${e.ordinal} ${JSON.stringify(e.path)}` }); children.push({ key: String(e.ordinal), path: e.path, problems: [x.reason], duplicateName: e.duplicateName }); continue; }
    total += x.bytes.length;
    if (total > ZIP_LIMITS.maxTotalBytes) { holds.push({ code: 'archive-total-expansion-limit', detail: a.id }); break; }
    const name = e.path.split('/').pop() || `entry-${e.ordinal}`;
    const child = store.add(`${a.id}#${e.ordinal}`, x.bytes, name, { parent: { assetId: a.id, key: String(e.ordinal) } });
    children.push({ key: String(e.ordinal), path: e.path, assetId: child.id, mime: child.mime, family: child.family, sha256: child.sha256, size: x.bytes.length, duplicateName: e.duplicateName, problems: [] });
  }
  return { children, holds };
}

const NEEDS_RENDITION = new Set(['image/tiff', 'image/heic', 'video/x-msvideo']);

/** Build every descriptor. Prepared renditions link back to their originals through the manifest's renditionOf. */
export async function importAll(store) {
  const renditions = new Map();
  for (const a of store.assets.values()) {
    const of = a.fixture?.renditionOf;
    if (of) { if (!renditions.has(of)) renditions.set(of, []); renditions.get(of).push(a); }
  }
  const descriptors = new Map();
  for (const a of [...store.assets.values()]) {
    if (a.parent) continue;
    await describe(store, a, renditions, descriptors);
  }
  for (const a of store.assets.values()) if (a.parent && !descriptors.has(a.id)) await describe(store, a, renditions, descriptors);
  return descriptors;
}

async function describe(store, a, renditions, descriptors) {
  const holds = [];
  const f = a.fixture ?? {};
  const ext = path.extname(a.name).toLowerCase();
  if (DECLARED[ext] && DECLARED[ext] !== a.mime && !(ext === '.tif' && a.mime === 'image/tiff')) holds.push({ code: 'content-type-mismatch', detail: `${a.name} is ${a.mime}` });
  if (a.kind === 'active-text') holds.push({ code: 'active-content-not-accepted', detail: `${a.name} sniffed as ${a.mime}` });
  if (a.kind === 'mbox' || (a.kind === 'unsupported-container' && ['pst', 'ost'].includes(a.format))) holds.push({ code: 'bulk-mailbox-needs-manual-extraction', detail: `${a.name} (${a.format ?? 'mbox'})` });
  else if (a.kind === 'unsupported-container') holds.push({ code: 'unsupported-container-needs-manual-extraction', detail: `${a.name} is ${a.format}` });
  if (a.kind === 'unknown') holds.push({ code: 'unrecognised-format', detail: `${a.name}: the bytes match no reader and are not text` });
  if (a.family === 'unknown' && !holds.length) holds.push({ code: 'no-reader', detail: `${a.name} (${a.mime}) has no reader` });
  if (a.kind === 'pdf') {
    const tail = new TextDecoder('latin1').decode(a.bytes.subarray(Math.max(0, a.size - 1024)));
    if (!/%%EOF\s*$/.test(tail) || !tail.includes('startxref')) holds.push({ code: 'pdf-damaged', detail: `${a.name}: no startxref/%%EOF trailer` });
    if (/\/Encrypt(?=[\s()<>[\]{}/%]|$)/.test(new TextDecoder('latin1').decode(a.bytes))) holds.push({ code: 'pdf-encrypted-needs-decrypted-rendition', detail: a.name });
  }
  if (['video/mp4', 'video/quicktime', 'audio/mp4'].includes(a.mime)) {
    // ISO BMFF top-level boxes must tile the file exactly; a box running past the end means the file was cut
    const v = new DataView(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength);
    let o = 0, ok = true;
    while (o + 8 <= a.size) {
      let size = v.getUint32(o);
      if (size === 1) size = o + 16 <= a.size ? Number(v.getBigUint64(o + 8)) : Infinity;
      else if (size === 0) size = a.size - o;
      if (size < 8 || o + size > a.size) { ok = false; break; }
      o += size;
    }
    if (!ok || o !== a.size) holds.push({ code: 'media-damaged', detail: `${a.name}: top-level box at ${o} runs past the end of the file` });
  }
  if (a.variant === 'split') holds.push({ code: 'archive-split-unsupported', detail: a.name });
  let children = a.children ?? [];
  if (a.family === 'email' && a.kind !== 'mbox' && !a.children) { const r = await emailChildren(store, a); children = r.children; holds.push(...r.holds); a.children = children; }
  if (a.family === 'archive' && !a.children) { const r = archiveChildren(store, a); children = r.children; holds.push(...r.holds); a.children = children; }
  const linked = (renditions.get(a.id) ?? []).map((r) => ({ assetId: r.id, kind: r.fixture.page ? 'page-image' : r.name.endsWith('.txt') ? 'ocr-text' : r.name.endsWith('.vtt') ? 'captions' : 'pdf', version: r.fixture.version ?? 1, page: r.fixture.page ?? null, sha256: r.sha256, role: /supplement/.test(r.name) ? 'supplement' : 'rendition' }));
  let visualParts = [];
  if (a.family === 'sheet' && a.kind === 'zip') {
    visualParts = listZip(a.bytes).entries.map((e) => e.path).filter((p) => /^xl\/(charts|drawings)\/[^/]+\.xml$/.test(p));
    if (visualParts.length && !linked.some((r) => r.role === 'supplement')) holds.push({ code: 'sheet-visual-content-needs-supplement', detail: `${a.name}: ${visualParts.join(', ')}` });
  }
  if (NEEDS_RENDITION.has(a.mime) && !linked.length && !f.renditionOf) holds.push({ code: 'prepared-rendition-missing', detail: `${a.name} (${a.mime}) has no native in-app reader` });
  const d = {
    schema: SCHEMA,
    assetId: a.id, name: a.name, family: a.family, mime: a.mime, variant: a.variant ?? null, size: a.size, sha256: a.sha256,
    role: f.renditionOf ? (/supplement/.test(a.name) ? 'supplement' : 'rendition') : a.parent ? 'child' : 'original',
    original: f.renditionOf ? { assetId: f.renditionOf, sha256: store.assets.get(f.renditionOf)?.sha256 ?? null } : null,
    rendition: f.renditionOf ? { version: f.version ?? 1, page: f.page ?? null, mapping: { kind: 'none' } } : null,
    renditions: linked,
    children,
    parent: a.parent ?? null,
    visualParts,
    limits: { zip: ZIP_LIMITS },
    holds,
  };
  descriptors.set(a.id, d);
  return d;
}
