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

export default async function importclass(c, { full }) {
  if (!full) return;
  unknownBytes(c);
  byBytes(c);
  await nesting(c);
}
