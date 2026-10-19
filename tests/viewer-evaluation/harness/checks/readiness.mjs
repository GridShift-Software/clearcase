// Readiness and candidate import. Two states from GRS-136/ADR 0011: while processing, acknowledged originals are
// retrievable, and the viewer opens what it can open as it is (PDF, native images, and here also workbooks, email, native
// media and ZIP); only a format that needs a manually prepared preview shows "Preview pending processing"; at
// publication every file, child and supplied location must preview, or the whole update is held.
const F = 'readiness';
const C = 'readiness contract (import holds + reader smoke + location resolution)';

/** The processing-state list of contract section 1: rejected, viewable (the reader opens the original as it is) or pending. */
export function processingState(d) {
  if (d.holds.some((h) => ['active-content-not-accepted', 'content-type-mismatch'].includes(h.code))) return 'rejected-at-acknowledgement';
  return d.native ? 'viewable' : 'preview-pending-processing';
}

/** The preview each original publishes with (asset id + reader family + extras), per the frozen matrix. */
function previewOf(c, id) {
  const d = c.descriptors.get(id);
  const r = d.renditions ?? [];
  if (d.family === 'pdf') { const p = r.find((x) => x.kind === 'pdf' && x.role === 'rendition'); return { id: p ? p.assetId : id, family: 'pdf' }; }
  if (d.family === 'email') { const p = r.find((x) => x.kind === 'body-text'); return p ? { id, family: 'email', extra: [p.assetId] } : { id, family: 'email' }; }
  if (d.family === 'word') { const p = r.find((x) => x.kind === 'pdf' && x.role === 'rendition'); return p ? { id: p.assetId, family: 'pdf' } : null; }
  if (d.family === 'image' && !d.native) { const pages = r.filter((x) => x.kind === 'page-image').map((x) => x.assetId); return pages.length ? { id, family: 'image', extra: pages } : null; }
  if (d.family === 'media' && d.mime === 'video/x-msvideo') { const p = r.find((x) => x.role === 'rendition'); return p ? { id: p.assetId, family: 'media' } : null; }
  return { id, family: d.family };
}

/** Every descendant (attachments, members) of an original, depth first. */
function descendants(c, id) {
  const out = [];
  for (const ch of c.descriptors.get(id).children ?? []) if (ch.assetId) { out.push(ch.assetId); out.push(...descendants(c, ch.assetId)); }
  return out;
}

async function evaluate(c, name, files) {
  const reasons = [];
  for (const { id, refs = [] } of files) {
    const d = c.descriptors.get(id);
    for (const h of d.holds) reasons.push({ file: id, code: h.code });
    const p = previewOf(c, id);
    if (!p) { reasons.push({ file: id, code: 'required-preview-missing' }); continue; }
    for (const held of [p.id, ...(p.extra ?? [])].filter((x) => x !== id)) for (const h of c.descriptors.get(held).holds) reasons.push({ file: held, code: h.code });
    const r = await c.open(p.id, { kind: 'file' }, { family: p.family, extra: p.extra, timeoutMs: 45000 });
    if (r.type !== 'ready') { reasons.push({ file: id, code: `preview-failed:${r.code ?? r.type}` }); continue; }
    for (const ref of refs) { const n = await c.navigate(ref); if (!n.resolution?.ok) reasons.push({ file: id, ref, code: n.resolution?.code ?? 'no-resolution' }); }
    for (const child of descendants(c, id)) {
      const cd = c.descriptors.get(child);
      for (const h of cd.holds) reasons.push({ file: child, code: h.code });
      if (cd.family === 'unknown') { reasons.push({ file: child, code: 'child-preview-failed:no-reader' }); continue; }
      const cp = previewOf(c, child);
      const cr = cp ? await c.open(cp.id, { kind: 'file' }, { family: cp.family, extra: cp.extra, timeoutMs: 45000 }) : { type: 'missing' };
      if (cr.type !== 'ready') reasons.push({ file: child, code: `child-preview-failed:${cr.code ?? cr.type}` });
    }
  }
  return { name, ready: reasons.length === 0, reasons };
}

export default async function readiness(c, { full }) {
  if (!full) return;
  const want = {
    'pdf/text-basic.pdf': 'viewable', 'image/png-pattern.png': 'viewable', 'image/jpeg-exif-orientation-6.jpg': 'viewable',
    'sheet/main.xlsx': 'viewable', 'sheet/chart.xlsx': 'viewable', 'email/gmail-download.eml': 'viewable', 'email/outlook-save-as.msg': 'viewable',
    'media/mp4-h264-aac-faststart.mp4': 'viewable', 'archive/basic.zip': 'viewable',
    'image/tiff-multipage-g4.tif': 'preview-pending-processing', 'image/heic-pattern.heic': 'preview-pending-processing', 'word/full-content.docx': 'preview-pending-processing', 'word/legacy.doc': 'preview-pending-processing',
    'media/avi-mpeg4-mp3.avi': 'preview-pending-processing', 'pdf/encrypted-user-password.pdf': 'preview-pending-processing', 'pdf/truncated.pdf': 'preview-pending-processing', 'media/mp4-truncated.mp4': 'preview-pending-processing',
    'email/outlook-rtf-only.msg': 'preview-pending-processing', 'email/gmail-takeout.mbox': 'preview-pending-processing', 'unknown/synthetic-mailbox.pst': 'preview-pending-processing', 'unknown/opaque.bin': 'preview-pending-processing',
    'image/svg-masquerade.png': 'rejected-at-acknowledgement',
  };
  const states = Object.fromEntries(Object.keys(want).map((id) => [id, processingState(c.descriptors.get(id))]));
  c.record(F, '(processing state)', C, 'processing state: natively readable originals viewable, only formats needing a prepared preview pending', JSON.stringify(states) === JSON.stringify(want), 'computed states equal the table in contract section 1', states);
  const viewable = Object.entries(states).filter(([, s]) => s === 'viewable').map(([id]) => id);
  for (const id of viewable) { const r = await c.open(id); c.record(F, id, C, 'a processing-state "viewable" original really opens', r.type === 'ready', 'ready', { type: r.type }); }

  const base = [
    { id: 'pdf/text-basic.pdf', refs: [{ kind: 'original-page', page: 2 }] },
    { id: 'image/png-pattern.png', refs: [{ kind: 'file' }] },
    { id: 'image/tiff-multipage-g4.tif', refs: [{ kind: 'original-page', page: 3 }] },
    { id: 'word/full-content.docx', refs: [{ kind: 'rendition-page', version: 1, page: 2 }] },
    { id: 'sheet/main.xlsx', refs: [{ kind: 'cell', sheet: 'Summary', ref: 'B7' }, { kind: 'cell', sheet: 'HiddenSheet', ref: 'A1' }] },
    { id: 'email/gmail-download.eml', refs: [{ kind: 'attachment', key: 1 }] },
    { id: 'media/mp4-h264-aac-faststart.mp4', refs: [{ kind: 'media-time', seconds: 3 }] },
    { id: 'archive/basic.zip', refs: [{ kind: 'archive-entry', ordinal: 5 }] },
  ];
  const A = await evaluate(c, 'A complete', base);
  c.record(F, 'candidate A', C, 'complete candidate is ready to publish', A.ready, 'no import holds, every preview and child preview ready, every supplied location resolves', A.reasons);
  const B = await evaluate(c, 'B one failing child', [...base, { id: 'email/hostile.eml' }]);
  c.record(F, 'candidate B', C, 'one file with a failing part holds the whole update', !B.ready && B.reasons.every((r) => r.file.startsWith('email/hostile.eml')), 'not ready; every reason belongs to hostile.eml (the other eight files are fine)', B.reasons);
  const Cc = await evaluate(c, 'C unmatched locations', [{ id: 'pdf/text-basic.pdf', refs: [{ kind: 'original-page', page: 9 }] }, { id: 'sheet/main.xlsx', refs: [{ kind: 'cell', sheet: 'Nope', ref: 'A1' }] }, { id: 'email/gmail-download.eml', refs: [{ kind: 'attachment', name: 'notes.txt' }] }, { id: 'word/full-content.docx', refs: [{ kind: 'original-page', page: 2 }] }]);
  const codes = Cc.reasons.map((r) => r.code).sort();
  c.record(F, 'candidate C', C, 'unmatched supplied locations hold the update for repair, each with its own code', !Cc.ready && JSON.stringify(codes) === JSON.stringify(['ambiguous-attachment', 'invalid-target', 'invalid-target', 'unmapped-original-location']), 'codes: invalid page, unknown sheet, ambiguous attachment name, original page with no verified mapping to the prepared PDF', Cc.reasons);
  const D = await evaluate(c, 'D stale rendition', [{ id: 'word/full-content.docx', refs: [{ kind: 'rendition-page', version: 2, page: 1 }] }]);
  c.record(F, 'candidate D', C, 'a reference to a different rendition version holds the update', !D.ready && D.reasons.some((r) => r.code === 'stale-rendition'), "reason 'stale-rendition'", D.reasons);
  const E = await evaluate(c, 'E missing rendition', [{ id: 'image/tiff-lzw.tif' }]);
  c.record(F, 'candidate E', C, 'a format that needs a prepared rendition holds the update until it exists', !E.ready && E.reasons.some((r) => r.code === 'prepared-rendition-missing'), "reason 'prepared-rendition-missing'", E.reasons);
  const G = await evaluate(c, 'G unknown bytes', [{ id: 'archive/unknown-members.zip' }, { id: 'email/unknown-attachments.eml' }]);
  const gKids = G.reasons.filter((r) => r.file.includes('#'));
  c.record(F, 'candidate G', C, 'unrecognised or unsupported bytes inside a ZIP and on an EML hold the whole update', !G.ready && ['archive/unknown-members.zip#', 'email/unknown-attachments.eml#'].every((p) => new Set(gKids.filter((r) => r.file.startsWith(p)).map((r) => r.file)).size === 6), 'not ready; each of the six blobs in each container carries a hold', G.reasons);
  const Fc = await evaluate(c, 'F reader fails at run time', [{ id: 'image/png-corrupt-body.png' }]);
  c.record(F, 'candidate F', C, 'a file that passes import but whose reader fails holds the update with preview-failed', !Fc.ready && c.descriptors.get('image/png-corrupt-body.png').holds.length === 0 && Fc.reasons.some((r) => r.code.startsWith('preview-failed:')), "no import hold on the file; not ready; reason 'preview-failed:<reader code>'", { holds: c.descriptors.get('image/png-corrupt-body.png').holds, reasons: Fc.reasons });
  const H = await evaluate(c, 'H encrypted PDF with a decrypted rendition', [{ id: 'pdf/encrypted-with-rendition.pdf' }]);
  const H0 = await evaluate(c, 'H0 encrypted PDF alone', [{ id: 'pdf/encrypted-user-password.pdf' }]);
  c.record(F, 'candidate H', C, 'an encrypted PDF publishes once its decrypted rendition is linked, and is held without one', H.ready && !H0.ready && H0.reasons.some((r) => r.code === 'pdf-encrypted-needs-decrypted-rendition'), 'with the rendition: ready; the unlinked twin: held pdf-encrypted-needs-decrypted-rendition', { linked: H.reasons, alone: H0.reasons });
  const I = await evaluate(c, 'I RTF-only MSG with a companion', [{ id: 'email/outlook-rtf-only-with-companion.msg' }]);
  const I0 = await evaluate(c, 'I0 RTF-only MSG alone', [{ id: 'email/outlook-rtf-only.msg' }]);
  c.record(F, 'candidate I', C, 'an RTF-only MSG publishes once its readable companion is linked, and is held without one', I.ready && !I0.ready && I0.reasons.some((r) => r.code === 'rtf-only-body-needs-companion'), 'with the companion: ready; the unlinked twin: held rtf-only-body-needs-companion', { linked: I.reasons, alone: I0.reasons });
  await c.open('email/outlook-rtf-only-with-companion.msg', { kind: 'file' }, { extra: ['email/outlook-rtf-only-with-companion.companion-v1.txt'] });
  const shown = await c.inFrame(() => ({ text: document.getElementById('rtf-companion')?.textContent ?? '', pending: !!document.getElementById('rtf-only') }));
  c.record(F, 'candidate I', C, 'the email reader shows the reviewed companion in place of the pending notice', shown.text.includes('MSG-RTF-COMPANION-TOKEN') && !shown.pending, 'companion text shown; no "companion is required" notice', shown);
}
