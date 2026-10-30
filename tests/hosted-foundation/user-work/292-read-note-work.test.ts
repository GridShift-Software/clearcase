// GRS-292: readNoteWork, the one read of a case's notes and one register's rows, over the real D1 user work (node:sqlite
// double). Synthetic cases, notes and fingerprints only: not evidence of Cloudflare D1 or a deployed Worker.
import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: {} }));
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { counters, countedD1, measure } from '../budget/harness.ts';
import { authority, auditLog, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, OTHER_CASE, OTHER_CLIENT, RV1, SHA_A, SHA_B } from './world.ts';

const STORE = 'original-page-notes';
function world(o: { bound?: 'mine' | 'other' | 'none' } = {}) {
  const db = database();
  if ((o.bound ?? 'mine') !== 'none') bind(db, o.bound === 'other' ? OTHER_CLIENT : CLIENT);
  const auth = authority(); auth.grant('editor', CASE, 'editor'); auth.grant('editor', OTHER_CASE, 'editor'); auth.grant('reader', CASE, 'viewer');
  const c = counters();
  let op = 0;
  const reader = caseReader({ published: RV1, versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }, { ref: 'D-002', sha256: SHA_B }] } });
  const work = (subject = 'editor') => createD1UserWork({ db: countedD1(d1(db), c), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(subject), audit: auditLog().sink, store: reader.reader, now: () => new Date('2200-01-01T00:00:00Z') });
  const row = (caseId: C.CaseId, assetId: string, sha256: string, body: string) =>
    work().putRow({ caseId, expected: { kind: 'absent' }, operationId: `row-${++op}`, store: STORE, rowId: null, fields: { assetId, page: 1, body, sha256 }, anchor: null });
  const note = (caseId: C.CaseId, ref: string | null, body: string) => work().addNote({ caseId, expected: { kind: 'absent' }, operationId: `note-${++op}`, body,
    target: ref ? { kind: 'document', anchor: { caseId, resultsVersion: RV1, refAtCreation: ref, sha256: ref === 'D-001' ? SHA_A : SHA_B } } : { kind: 'case' } });
  return { db, c, work, row, note };
}
const docTarget = (caseId: C.CaseId, ref = 'D-001'): C.NoteTarget => ({ kind: 'document', anchor: { caseId, resultsVersion: RV1, refAtCreation: ref, sha256: ref === 'D-001' ? SHA_A : SHA_B } });

it('292 one D1 query returns the case notes and the register rows, the binding included, for a reader too', async () => {
  const w = world();
  try {
    await w.note(CASE, null, 'Synthetic case note'); await w.note(CASE, 'D-001', 'Synthetic document note');
    await w.row(CASE, 'D-001', SHA_A, 'Synthetic page note');
    await w.row(OTHER_CASE, 'D-001', SHA_A, 'Synthetic other case page note'); await w.note(OTHER_CASE, null, 'Synthetic other case note');
    const r = await measure(w.c, () => w.work('reader').readNoteWork({ caseId: CASE, target: null, store: STORE }));
    expect(r.thrown).toBeUndefined(); expect(r.counts).toMatchObject({ d1: 1, clerk: 0, r2: 0 });
    expect(r.value!.notes.map((n) => n.body)).toEqual(['Synthetic case note', 'Synthetic document note']);
    expect(r.value!.rows.map((x) => x.fields.body)).toEqual(['Synthetic page note']);
    // the same rows and notes the separate reads give, digests and versions included
    expect(r.value!.rows).toEqual(await w.work().listRows({ caseId: CASE, store: STORE }));
    expect(r.value!.notes).toEqual(await w.work().notesFor({ caseId: CASE, target: null }));
  } finally { w.db.close(); }
});

it('292 a document read keeps only its own notes and the rows with its fingerprint, without reading the rest', async () => {
  const w = world();
  try {
    await w.note(CASE, 'D-001', 'Synthetic note on D-001'); await w.note(CASE, 'D-002', 'Synthetic note on D-002');
    await w.row(CASE, 'D-001', SHA_A, 'Synthetic page note on A'); await w.row(CASE, 'D-009', SHA_A, 'Synthetic page note on the same bytes');
    await w.row(CASE, 'D-002', SHA_B, 'Synthetic page note on B');
    // a stored row that is not JSON at all must not fail the bounded read, nor be returned by it
    w.db.prepare(`INSERT INTO uw_register_row (case_id, store, row_id, anchor_json, fields_json, fields_sha256, created_at, updated_at, version) VALUES (?, ?, 'broken', NULL, 'not-json', 'x', '2200-01-01T00:00:00Z', '2200-01-01T00:00:00Z', 'v')`).run(CASE, STORE);
    const r = await measure(w.c, () => w.work().readNoteWork({ caseId: CASE, target: docTarget(CASE), store: STORE, rowsWhere: { field: 'sha256', equals: SHA_A } }));
    expect(r.thrown).toBeUndefined(); expect(r.counts.d1).toBe(1);
    expect(r.value!.notes.map((n) => n.body)).toEqual(['Synthetic note on D-001']);
    expect(r.value!.rows.map((x) => x.fields.body)).toEqual(['Synthetic page note on A', 'Synthetic page note on the same bytes']);
  } finally { w.db.close(); }
});

it('292 an unbound or foreign binding refuses, never answers empty lists', async () => {
  for (const bound of ['none', 'other'] as const) {
    const w = world({ bound });
    try { await expect(w.work().readNoteWork({ caseId: CASE, target: null, store: STORE })).rejects.toMatchObject({ code: 'storage-unavailable' }); }
    finally { w.db.close(); }
  }
});

it('292 no grant, an anchor of another case, a bad store or a selector that is not a plain field are refused before a row is read', async () => {
  const w = world();
  try {
    await w.row(CASE, 'D-001', SHA_A, 'Synthetic page note');
    const before = w.c.d1;
    await expect(w.work('stranger').readNoteWork({ caseId: CASE, target: null, store: STORE })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.work().readNoteWork({ caseId: CASE, target: docTarget(OTHER_CASE), store: STORE })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.work().readNoteWork({ caseId: CASE, target: null, store: '../x' })).rejects.toMatchObject({ code: 'invalid' });
    for (const field of ['sha256") OR 1=1 --', '$.sha256', 'a.b', ''])
      await expect(w.work().readNoteWork({ caseId: CASE, target: null, store: STORE, rowsWhere: { field, equals: SHA_A } }), field).rejects.toMatchObject({ code: 'invalid' });
    expect(w.c.d1).toBe(before);
  } finally { w.db.close(); }
});
