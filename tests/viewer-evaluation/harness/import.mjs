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

/** Which reader family previews what the bytes are. Only plain text consults the name (a .csv is text shown as a grid). */
const FAMILY_BY_FORMAT = { zip: { docx: 'word', xlsx: 'sheet', zip: 'archive' }, ole: { msg: 'email', doc: 'word', xls: 'sheet' } };
function familyOf(s, name) {
  if (FAMILY_BY_FORMAT[s.kind]) return FAMILY_BY_FORMAT[s.kind][s.format] ?? 'unknown';
  if (s.kind === 'text' && /\.csv$/i.test(name)) return 'sheet';
  return { pdf: 'pdf', image: 'image', media: 'media', email: 'email', mbox: 'email', text: 'text' }[s.kind] ?? 'unknown';
}

const DECLARED = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic', '.tif': 'image/tiff' };

export function createStore(fixtureDir, { limits = ZIP_LIMITS, only = null } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
  const assets = new Map();
  /** Every asset knows its depth (containers above it) and shares one expansion budget with the whole tree it came from. */
  const add = (id, bytes, name, extra = {}) => {
    const s = sniff(bytes);
    const parent = extra.parent ? assets.get(extra.parent.assetId) : null;
    const a = { id, bytes, name, sha256: sha(bytes), size: bytes.length, mime: s.mime, kind: s.kind, variant: s.variant, format: s.format, pages: s.pages, family: familyOf(s, name), depth: parent ? parent.depth + 1 : 0, budget: parent ? parent.budget : { bytes: 0, nodes: 0 }, ...extra };
    assets.set(id, a);
    return a;
  };
  for (const f of manifest.fixtures.filter((x) => !only || only.has(x.id))) add(f.id, new Uint8Array(readFileSync(path.join(fixtureDir, f.file))), path.basename(f.file), { fixture: f });
  return { manifest, assets, add, limits };
}

const attachment = (key, o) => ({ kind: 'attachment', key, assetId: null, name: null, mime: null, declaredMime: null, sha256: null, contentId: null, inline: false, embeddedMessage: false, ...o });
const member = (key, o) => ({ kind: 'member', key, path: '', directory: false, assetId: null, mime: null, family: null, sha256: null, size: null, duplicateName: false, problems: [], ...o });

/** The attachments of an EML or MSG as raw items (bytes and the trusted entry), before depth and budget decide what is kept. */
async function emailItems(a, { hasBodyCompanion }) {
  const items = [], holds = [];
  if (a.kind === 'ole') {
    const r = new MsgReader(a.bytes);
    const d = r.getFileData();
    if (d.error) return { items, holds: [{ code: 'email-parse-failed', detail: d.error }] };
    if (!d.body && !d.bodyHtml && !d.html && d.compressedRtf && !hasBodyCompanion) holds.push({ code: 'rtf-only-body-needs-companion', detail: a.id });
    for (const [i, att] of d.attachments.entries()) {
      const name = att.innerMsgContent ? `${att.name ?? 'embedded'}.msg` : (att.fileName ?? `attachment-${i}`);
      items.push({ name, bytes: new Uint8Array(r.getAttachment(att).content), entry: attachment(String(i), { name, declaredMime: att.attachMimeTag ?? null, contentId: att.pidContentId ?? null, embeddedMessage: !!att.innerMsgContent }) });
    }
    return { items, holds };
  }
  const raw = new TextDecoder().decode(a.bytes);
  for (const m of raw.matchAll(/Content-Transfer-Encoding:\s*base64\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)(?=\r?\n--|$)/gi)) {
    if (/[^A-Za-z0-9+/=\s]/.test(m[1])) holds.push({ code: 'malformed-mime-part', detail: 'base64 body contains characters outside the alphabet' });
  }
  const e = await PostalMime.parse(a.bytes, { attachmentEncoding: 'arraybuffer' });
  for (const [i, att] of e.attachments.entries()) {
    items.push({ name: att.filename ?? `attachment-${i}`, bytes: new Uint8Array(att.content), entry: attachment(String(i), { name: att.filename ?? null, declaredMime: att.mimeType ?? null, contentId: att.contentId ?? null, inline: att.disposition === 'inline', embeddedMessage: att.mimeType === 'message/rfc822' }) });
  }
  return { items, holds };
}

/** The members of a ZIP as raw items; a member that cannot be extracted has no bytes and carries its reason. */
function zipItems(a) {
  const { error, entries } = listZip(a.bytes);
  const holds = error ? [{ code: `archive-${error}`, detail: a.id }] : [];
  const items = [];
  for (const e of entries) {
    const base = { path: e.path, duplicateName: e.duplicateName };
    if (e.directory && !e.problems.length) { items.push({ entry: member(String(e.ordinal), { ...base, directory: true }) }); continue; }
    const x = extractEntry(a.bytes, e);
    if (!x.ok) { holds.push({ code: `archive-${x.reason}`, detail: `${a.id}#${e.ordinal} ${JSON.stringify(e.path)}` }); items.push({ entry: member(String(e.ordinal), { ...base, problems: [x.reason] }) }); continue; }
    items.push({ name: e.path.split('/').pop() || `entry-${e.ordinal}`, bytes: x.bytes, entry: member(String(e.ordinal), { ...base, size: x.bytes.length }), ordinal: e.ordinal });
  }
  return { items, holds };
}

/**
 * Expand one container into child assets. Archives and email share one rule set: a container at the depth limit that has
 * contents is held (nesting-limit) and not expanded, and every extracted byte and node counts against the one budget the
 * whole tree shares, so no mix of ZIPs and messages can exceed what one archive may.
 */
async function expand(store, a, ctx) {
  const { items, holds } = a.family === 'email' ? await emailItems(a, ctx) : zipItems(a);
  const limits = store.limits;
  if (items.length && a.depth >= limits.maxDepth) return { children: [], holds: [...holds, { code: 'nesting-limit', detail: `${a.id} sits at depth ${a.depth} and holds ${items.length} item(s); the limit is ${limits.maxDepth}` }] };
  const children = [];
  for (const it of items) {
    if (!it.bytes) { children.push(it.entry); continue; }
    if (a.budget.nodes + 1 > limits.maxEntries) { holds.push({ code: 'archive-too-many-entries', detail: `${a.id}: more than ${limits.maxEntries} items in the whole tree` }); break; }
    if (a.budget.bytes + it.bytes.length > limits.maxTotalBytes) { holds.push({ code: 'archive-total-expansion-limit', detail: `${a.id}: the tree would pass ${limits.maxTotalBytes} bytes` }); break; }
    a.budget.nodes++; a.budget.bytes += it.bytes.length;
    const child = store.add(`${a.id}#${it.entry.key}`, it.bytes, it.name, { parent: { assetId: a.id, key: it.entry.key } });
    if (child.kind === 'tnef') holds.push({ code: 'tnef-needs-companion', detail: child.id });
    children.push({ ...it.entry, assetId: child.id, mime: child.mime, sha256: child.sha256, ...(it.entry.kind === 'member' ? { family: child.family, size: it.bytes.length } : {}) });
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
  if (['zip', 'ole'].includes(a.kind) && a.format === (a.kind === 'zip' ? 'ooxml-other' : 'ole-other')) holds.push({ code: 'unsupported-office-format', detail: `${a.name} is a ${a.kind === 'zip' ? 'ZIP-based package' : 'compound file'} that is not Word, a workbook or an Outlook message` });
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
  const linked = (renditions.get(a.id) ?? []).map((r) => ({ assetId: r.id, kind: r.fixture.page ? 'page-image' : r.name.endsWith('.txt') ? 'ocr-text' : r.name.endsWith('.vtt') ? 'captions' : 'pdf', version: r.fixture.version ?? 1, page: r.fixture.page ?? null, sha256: r.sha256, role: /supplement/.test(r.name) ? 'supplement' : 'rendition' }));
  let children = [];
  if ((a.family === 'email' && a.kind !== 'mbox') || a.family === 'archive') { const r = await expand(store, a, { hasBodyCompanion: false }); children = r.children; holds.push(...r.holds); }
  let visualParts = [];
  if (a.family === 'sheet' && a.kind === 'zip') {
    visualParts = listZip(a.bytes).entries.map((e) => e.path).filter((p) => /^xl\/(charts|drawings)\/[^/]+\.xml$/.test(p));
    if (visualParts.length && !linked.some((r) => r.role === 'supplement')) holds.push({ code: 'sheet-visual-content-needs-supplement', detail: `${a.name}: ${visualParts.join(', ')}` });
  }
  const pageImages = linked.filter((r) => r.kind === 'page-image').map((r) => r.page).sort((x, y) => x - y);
  if (a.mime === 'image/tiff' && pageImages.length && JSON.stringify(pageImages) !== JSON.stringify(Array.from({ length: a.pages ?? 0 }, (_, i) => i + 1))) holds.push({ code: 'rendition-page-count-mismatch', detail: `${a.name} has ${a.pages ?? 'an unreadable number of'} page(s); the prepared page images are numbered ${JSON.stringify(pageImages)}` });
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
    pages: a.pages ?? null,
    limits: { zip: ZIP_LIMITS },
    holds,
  };
  descriptors.set(a.id, d);
  return d;
}
