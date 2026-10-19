// Import-side classes from the GRS-97 review, asserted on the descriptors the candidate import produced. Each block
// names the finding it closes. No browser is needed except where a block opens a reader.
import { createStore, importAll } from '../import.mjs';
import { OUT_ROOT } from '../paths.mjs';
import path from 'node:path';

const F = 'import';
const C = 'candidate import (classifier, descriptor, recursion budget)';

/** The descriptors one level below `id`, found through the trusted child list. */
export const kids = (c, id) => (c.descriptors.get(id)?.children ?? []).filter((ch) => ch.assetId).map((ch) => ({ ch, d: c.descriptors.get(ch.assetId) }));
const codes = (d) => (d?.holds ?? []).map((h) => h.code);

// H1: bytes that match no reader, and containers the alpha does not take, are `unknown` and held wherever they sit.
const UNKNOWN = {
  'synthetic-mailbox.pst': 'bulk-mailbox-needs-manual-extraction',
  'synthetic-cache.ost': 'bulk-mailbox-needs-manual-extraction',
  'synthetic-archive.7z': 'unsupported-container-needs-manual-extraction',
  'synthetic-archive.rar': 'unsupported-container-needs-manual-extraction',
  'synthetic-takeout.tgz': 'unsupported-container-needs-manual-extraction',
  'opaque.bin': 'unrecognised-format',
};

function unknownBytes(c) {
  const where = {
    'top level': (name) => c.descriptors.get(`unknown/${name}`),
    'inside a ZIP': (name) => kids(c, 'archive/unknown-members.zip').find((k) => k.ch.path === name)?.d,
    'attached to an EML': (name) => kids(c, 'email/unknown-attachments.eml').find((k) => k.ch.name === name)?.d,
  };
  for (const [place, find] of Object.entries(where)) {
    for (const [name, want] of Object.entries(UNKNOWN)) {
      const d = find(name);
      c.record(F, `unknown/${name}`, C, `unrecognised or unsupported bytes ${place} import as 'unknown' with the hold '${want}'`, !!d && d.family === 'unknown' && codes(d).includes(want), `family 'unknown'; holds include '${want}'`, d ? { family: d.family, mime: d.mime, holds: codes(d) } : 'descriptor missing');
    }
  }
}

// M1: the family comes from the bytes (ZIP parts, OLE directory), never from the file name.
const BY_BYTES = {
  'rename/full-content-docx.zip': ['word', []],
  'rename/main-xlsx.zip': ['sheet', []],
  'rename/basic-zip.docx': ['archive', []],
  'rename/legacy-doc.dat': ['word', []],
  'rename/main-xls.dat': ['sheet', []],
  'rename/outlook-save-as-msg.dat': ['email', []],
  'rename/outlook-save-as-msg.doc': ['email', []],
  'rename/text-named.msg': ['text', []],
  'rename/pptx-shaped.zip': ['unknown', ['unsupported-office-format']],
};

function byBytes(c) {
  for (const [id, [family, wantHolds]] of Object.entries(BY_BYTES)) {
    const d = c.descriptors.get(id);
    c.record(F, id, C, `family comes from the bytes (${family}), not from the file name`, d?.family === family && wantHolds.every((w) => codes(d).includes(w)), `family '${family}'${wantHolds.length ? `; holds include ${wantHolds.join(', ')}` : ''}`, d ? { family: d.family, mime: d.mime, holds: codes(d) } : 'descriptor missing');
  }
}

/** Every descriptor reachable from `id` through the trusted child lists, root first. */
export function subtree(c, id, out = []) {
  const d = c.descriptors.get(id);
  if (!d) return out;
  out.push(d);
  for (const { d: k } of kids(c, id)) subtree(c, k.assetId, out);
  return out;
}

// M2: one depth counter and one expansion budget across archive and email recursion.
async function nesting(c) {
  for (const id of ['archive/nest-zip-6.zip', 'archive/nest-eml-zip-chain.zip']) {
    const tree = subtree(c, id);
    const limited = tree.filter((d) => codes(d).includes('nesting-limit'));
    const leaf = tree.some((d) => d.family === 'text');
    c.record(F, id, C, 'nesting deeper than the limit raises nesting-limit and is not expanded further', limited.length === 1 && !leaf, "exactly one container holds 'nesting-limit'; the innermost leaf is not reachable", { held: limited.map((d) => d.assetId), reachable: tree.length, leaf });
  }
  const only = new Set(['archive/budget-mixed.zip']);
  const limits = { ...c.store.limits, maxTotalBytes: 1000000 };
  const store = createStore(path.join(OUT_ROOT, 'fixtures'), { limits, only });
  const ds = await importAll(store);
  const held = [...ds.values()].filter((d) => codes(d).includes('archive-total-expansion-limit'));
  c.record(F, 'archive/budget-mixed.zip', C, 'one expansion budget covers a ZIP and the EML inside it', held.length >= 1, "a descriptor in the tree holds 'archive-total-expansion-limit' although each container alone stays under the cap", { held: held.map((d) => d.assetId), assets: [...ds.keys()] });
}

// M3: prepared page images are found by rendition.page, never by position, and a gap is a hold and a refusal.
async function pageImages(c) {
  const id = 'image/tiff-gappy.tif';
  const d = c.descriptors.get(id);
  c.record(F, id, C, 'a TIFF whose page count differs from its prepared page-image set is held', codes(d).includes('rendition-page-count-mismatch') && c.descriptors.get('image/tiff-multipage-g4.tif').holds.length === 0, "holds include 'rendition-page-count-mismatch'; the complete 3-image set has no hold", { pages: d?.pages ?? null, renditions: d?.renditions?.map((r) => r.page), holds: codes(d) });
  const extras = ['image/tiff-gappy.rendition-p1.png', 'image/tiff-gappy.rendition-p3.png'];
  await c.open(id, { kind: 'file' }, { extra: extras });
  const miss = await c.navigate({ kind: 'original-page', page: 2 });
  const afterMiss = (await c.rstate())?.image;
  c.record(F, id, 'prepared page images (PNG per page)', 'original page 2 with no page image is refused, and the view does not show page 3 under that label', miss.resolution?.ok === false && miss.resolution?.code === 'unmapped-original-location' && afterMiss?.page !== 3, "resolution.code === 'unmapped-original-location'; the displayed page is not 3", { resolution: miss.resolution, page: afterMiss?.page });
  const hit = await c.navigate({ kind: 'original-page', page: 3 });
  const shown = (await c.rstate())?.image;
  c.record(F, id, 'prepared page images (PNG per page)', 'original page 3 shows the image whose rendition.page is 3', hit.resolution?.ok === true && shown?.shownAsset === 'image/tiff-gappy.rendition-p3.png', "ok; shownAsset is the rendition.page 3 image", { resolution: hit.resolution, shown: shown?.shownAsset });
  const all = [3, 1, 2].map((n) => `image/tiff-multipage-g4.rendition-p${n}.png`);
  await c.open('image/tiff-multipage-g4.tif', { kind: 'file' }, { extra: all });
  const rows = [];
  for (const n of [1, 2, 3]) { const r = await c.navigate({ kind: 'original-page', page: n }); rows.push({ n, ok: r.resolution?.ok, shown: (await c.rstate())?.image?.shownAsset }); }
  c.record(F, 'image/tiff-multipage-g4.tif', 'prepared page images (PNG per page)', 'page images supplied out of order are still found by rendition.page', rows.every((r) => r.ok && r.shown === `image/tiff-multipage-g4.rendition-p${r.n}.png`), 'original page n shows the rendition.page n image whatever the order of the extras', rows);
}

// M6: a Gmail message forwarded as an attachment: nested messages two levels down, and the export provenance it models.
async function gmailForward(c) {
  const id = 'email/gmail-forwarded.eml';
  const fx = c.store.manifest.fixtures.find((f) => f.id === id);
  c.record(F, id, C, 'the fixture states that it is a structure model and names the client shape it imitates', fx?.provenance?.modelled === true && typeof fx.provenance.shape === 'string' && fx.provenance.exportedFrom === null, 'manifest provenance: modelled true, shape named, exportedFrom null (no real export)', fx?.provenance ?? null);
  const l1 = kids(c, id);
  const mid = l1.find((k) => k.d?.mime === 'message/rfc822');
  const l2 = mid ? kids(c, mid.d.assetId) : [];
  const earlier = l2.find((k) => k.d?.mime === 'message/rfc822');
  const l3 = earlier ? kids(c, earlier.d.assetId) : [];
  c.record(F, id, C, 'a forwarded-as-attachment message expands two levels: message, its PDF and its earlier message, that message\'s notes', l1.length === 1 && mid?.d.family === 'email' && l2.some((k) => k.d?.mime === 'application/pdf') && earlier?.d.family === 'email' && l3.length === 1 && l3[0].d.family === 'text' && [id, mid?.d.assetId, earlier?.d.assetId].every((x) => x && c.descriptors.get(x).holds.length === 0), 'EML -> message/rfc822 (email) -> [pdf, message/rfc822 (email) -> text]; no holds', { l1: l1.map((k) => k.ch.name), l2: l2.map((k) => [k.ch.name, k.d?.mime]), l3: l3.map((k) => k.ch.name) });
  await c.open(id);
  const headers = (await c.inFrame(() => document.querySelector('#all-headers pre')?.textContent ?? '')).toLowerCase();
  const order = ['delivered-to:', 'x-google-smtp-source:', 'arc-seal:', 'authentication-results:', 'x-gm-message-state:'].map((h) => headers.indexOf(h));
  c.record(F, id, C, 'the Gmail transport headers are kept in original order in the reader', order.every((o, i) => o >= 0 && (i === 0 || order[i - 1] < o)), 'Delivered-To, X-Google-Smtp-Source, ARC-Seal, Authentication-Results and X-Gm-Message-State present, in that order', order);
  const hops = [];
  let cur = id;
  for (let level = 0; level < 2; level++) {
    const child = c.descriptors.get(cur).children.find((x) => x.mime === 'message/rfc822');
    await c.inFrame((k) => { setTimeout(() => document.querySelector(`.attachments button[data-key="${k}"]`)?.click(), 0); }, child.key);
    await sleep(900);
    const sh = await c.page.evaluate(() => window.__shell.current());
    hops.push({ level, family: sh?.family, ready: (await c.rstate())?.ready });
    cur = child.assetId;
  }
  c.record(F, id, 'postal-mime 4.0.11 + DOMPurify 3.4.17', 'the forwarded message and the earlier message inside it each open in the email reader', hops.length === 2 && hops.every((h) => h.family === 'email' && h.ready === true), 'two hops, each opened as email and ready', hops);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function importclass(c, { full }) {
  if (!full) return;
  unknownBytes(c);
  byBytes(c);
  await nesting(c);
  await pageImages(c);
  await gmailForward(c);
}
