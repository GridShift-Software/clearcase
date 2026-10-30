// GRS-292: page notes written through the viewer's own path (addPageNote over the real D1 user work, node:sqlite double)
// read back as the case notes list and a document's My notes show them. Synthetic cases, originals and fingerprints
// only: not evidence of Cloudflare D1 or a deployed Worker.
import { expect, it } from 'vitest';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { addPageNote } from '../../../src/lib/viewer/hosted/page-notes.ts';
import { documentPageNotes, pageNotes, PAGE_NOTE_STORE } from '../../../src/lib/views/hosted/page-note-items.ts';
import { authority, auditLog, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, OTHER_CASE, RV1, SHA_A, SHA_B, SHA_C } from './world.ts';

const ORIGINALS: Record<string, Record<string, C.Sha256>> = {
  [CASE]: { 'D-001': SHA_A, 'D-002': SHA_B, 'D-007': SHA_A },
  [OTHER_CASE]: { 'D-001': SHA_A },
};
function world() {
  const db = database(); bind(db);
  const auth = authority(); auth.grant('editor', CASE, 'editor'); auth.grant('editor', OTHER_CASE, 'editor'); auth.grant('reader', CASE, 'viewer');
  let n = 0;
  const work = (subject = 'editor') => createD1UserWork({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(subject), audit: auditLog().sink,
    store: caseReader({ published: RV1, versions: { [RV1]: [] } }).reader, now: () => new Date(`2200-01-01T00:00:0${n++}Z`) });
  const assets = {
    async metadata({ asset }: { asset: C.AssetRef }) {
      const sha256 = ORIGINALS[asset.caseId]?.[asset.assetId];
      if (!sha256) throw Object.assign(new Error('not found'), { code: 'not-found' });
      return { sha256, size: 1, mediaType: 'application/pdf', filename: `${asset.assetId}.pdf`, objectVersion: 'v', etag: '"e"' };
    },
  } as unknown as C.AssetsAccess;
  const add = (caseId: C.CaseId, assetId: string, page: number, body: string) =>
    addPageNote({ work: work(), assets, caseId, assetId, page, body, operationId: `op-${caseId}-${assetId}-${page}-${body.length}` });
  return { db, work, add };
}

it('292 lists every page note of the case with its text, page and viewer link, and none of another case', async () => {
  const w = world();
  try {
    await w.add(CASE, 'D-001', 3, 'Synthetic note on page three');
    await w.add(CASE, 'D-002', 1, 'Synthetic note on another original');
    await w.add(OTHER_CASE, 'D-001', 3, 'Synthetic note of another case');
    const rows = await w.work('reader').listRows({ caseId: CASE, store: PAGE_NOTE_STORE });
    const list = pageNotes(CASE, rows);
    expect(list.unreadable).toBe(0);
    // newest first, as the notes list orders its notes; the time is the row's own
    expect(list.items.map((n) => [n.body, n.page, n.assetId, n.href, n.sha256])).toEqual([
      ['Synthetic note on another original', 1, 'D-002', '/cases/synthetic-case/originals/D-002/view?page=1', SHA_B],
      ['Synthetic note on page three', 3, 'D-001', '/cases/synthetic-case/originals/D-001/view?page=3', SHA_A],
    ]);
    expect(list.items.map((n) => n.createdAt)).toEqual(rows.map((r) => r.createdAt).reverse());
    expect(list.items.every((n) => n.intact)).toBe(true);
    expect(pageNotes(OTHER_CASE, await w.work().listRows({ caseId: OTHER_CASE, store: PAGE_NOTE_STORE })).items.map((n) => n.body)).toEqual(['Synthetic note of another case']);
  } finally { w.db.close(); }
});

it('292 a document shows the page notes written on its original\'s bytes: across asset ids and versions, never on other bytes', async () => {
  const w = world();
  try {
    await w.add(CASE, 'D-001', 5, 'Synthetic later page');
    await w.add(CASE, 'D-001', 2, 'Synthetic earlier page');
    await w.add(CASE, 'D-002', 2, 'Synthetic note on other bytes');
    const list = pageNotes(CASE, await w.work().listRows({ caseId: CASE, store: PAGE_NOTE_STORE }));
    // the document whose own original was written on: by page, each one marked as on this original
    expect(documentPageNotes(list, { sha256: SHA_A, assetId: 'D-001' }).map((n) => [n.page, n.body, n.here])).toEqual([[2, 'Synthetic earlier page', true], [5, 'Synthetic later page', true]]);
    // a duplicate (same bytes under another asset id), or the same document renumbered in a later version: shown, not as its own
    expect(documentPageNotes(list, { sha256: SHA_A, assetId: 'D-007' }).map((n) => [n.page, n.assetId, n.here])).toEqual([[2, 'D-001', false], [5, 'D-001', false]]);
    // a ref reused for different bytes, a document with no original, and bytes nobody wrote on show none
    expect(documentPageNotes(list, { sha256: SHA_C, assetId: 'D-001' })).toEqual([]);
    expect(documentPageNotes(list, { sha256: null, assetId: 'D-001' })).toEqual([]);
    expect(documentPageNotes(list, { sha256: SHA_B, assetId: 'D-002' }).map((n) => n.body)).toEqual(['Synthetic note on other bytes']);
  } finally { w.db.close(); }
});

it('292 reading page notes rewrites nothing, and a row that is not a readable page note is counted, not shown', async () => {
  const w = world();
  try {
    await w.add(CASE, 'D-001', 1, 'Synthetic kept note');
    const insert = w.db.prepare('INSERT INTO uw_register_row (case_id, store, row_id, anchor_json, fields_json, fields_sha256, created_at, updated_at, version) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)');
    for (const [rowId, fields] of [['no-page', { assetId: 'D-001', body: 'x', sha256: SHA_A }], ['bad-sha', { assetId: 'D-001', page: 1, body: 'x', sha256: 'abc' }], ['blank', { assetId: 'D-001', page: 1, body: ' ', sha256: SHA_A }]] as const)
      insert.run(CASE, PAGE_NOTE_STORE, rowId, JSON.stringify(fields), 'digest', '2200-01-02T00:00:00Z', '2200-01-02T00:00:00Z', `v-${rowId}`);
    const before = w.db.prepare('SELECT * FROM uw_register_row ORDER BY rowid').all();
    const cases = w.db.prepare('SELECT * FROM uw_case ORDER BY rowid').all();
    const list = pageNotes(CASE, await w.work().listRows({ caseId: CASE, store: PAGE_NOTE_STORE }));
    expect([list.items.map((n) => n.body), list.unreadable]).toEqual([['Synthetic kept note'], 3]);
    expect(w.db.prepare('SELECT * FROM uw_register_row ORDER BY rowid').all()).toEqual(before);
    expect(w.db.prepare('SELECT * FROM uw_case ORDER BY rowid').all()).toEqual(cases);
  } finally { w.db.close(); }
});

it('292 a stored row altered since it was saved is shown with intact false, so the page can say so', async () => {
  const w = world();
  try {
    await w.add(CASE, 'D-001', 4, 'Synthetic original text');
    w.db.prepare(`UPDATE uw_register_row SET fields_json = json_set(fields_json, '$.body', 'Synthetic altered text') WHERE store = ?`).run(PAGE_NOTE_STORE);
    const [item] = pageNotes(CASE, await w.work().listRows({ caseId: CASE, store: PAGE_NOTE_STORE })).items;
    expect(item).toMatchObject({ body: 'Synthetic altered text', intact: false, page: 4 });
  } finally { w.db.close(); }
});

it('292 an asset id is encoded into its viewer link', () => {
  const row = { rowId: 'r1', store: PAGE_NOTE_STORE, anchor: null, fields: { assetId: 'D 1/x?y', page: 2, body: 'Synthetic', sha256: SHA_A }, createdAt: '2200-01-01T00:00:00Z', updatedAt: '2200-01-01T00:00:00Z', intact: true, version: 'v1' } as unknown as C.Versioned<C.WorkRegisterRow>;
  expect(pageNotes(CASE, [row]).items[0]!.href).toBe('/cases/synthetic-case/originals/D%201%2Fx%3Fy/view?page=2');
});
