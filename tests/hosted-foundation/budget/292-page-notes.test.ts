// GRS-292: a page note saved in an original's viewer is found on the case notes list and on its document's My notes,
// for the same D1 calls those pages made before (266's notes list, 16's document page). Synthetic SQLite/D1 and R2
// doubles: call counts and virtual round trips, not a deployed Worker's latency.
import { expect, it } from 'vitest';
import { rcWorld } from './266-world.ts';
import { counters, countedD1, measure } from './harness.ts';
import { oneLookupLocals } from './one-lookup.ts';
import { load as notesLoad } from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import { POST as pageNotePost } from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/notes/+server.ts';
import { load as document } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import { load as layout } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { authority, auditLog, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, RV1, SHA_A, SHA_B } from '../user-work/world.ts';
import { docCase, PARENT } from '../../publication/shards/12-world.ts';
import { CASE_ID, locals, published } from '../../publication/shards/world.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';

const STORE = 'original-page-notes';

it('292 a page note saved through the viewer is on the case notes list after reload: still 3 D1 calls, 2 on the critical path', async () => {
  const w = await rcWorld();
  try {
    const [{ asset_id: assetId }] = w.db.rows<{ asset_id: string }>("SELECT asset_id FROM rs_case_original WHERE case_id = 'case-a' ORDER BY asset_id LIMIT 1");
    const body = JSON.stringify({ page: 2, body: 'Synthetic page note from the viewer', operationId: 'rc-page-note' });
    const saved = await w.request(`/originals/${encodeURIComponent(assetId!)}/notes`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } },
      (locals, request, url) => pageNotePost({ locals, params: { caseId: 'case-a', assetId }, request, url } as never));
    expect(saved.thrown).toBeUndefined(); expect(saved.value?.status).toBe(201);
    await Promise.all(w.pending.splice(0));
    const r = await w.timed('/notes', { method: 'GET' }, (locals, _r, url) => notesLoad({ locals, params: { caseId: 'case-a' }, url } as never));
    expect(r.thrown).toBeUndefined();
    expect(r.value?.notes.state).toBe('available');
    expect(r.value?.pageNotes).toMatchObject({ unreadable: 0, items: [{ assetId, page: 2, body: 'Synthetic page note from the viewer', intact: true, href: `/cases/case-a/originals/${encodeURIComponent(assetId!)}/view?page=2` }] });
    // 266 pins the notes list at 3 D1 calls, 2 sequential: the page notes ride in the notes read
    expect(r.counts).toMatchObject({ d1: 3, clerk: 0, otherFetch: 0 }); expect(r.sequential).toBe(2);
    // the row is the viewer's own, unchanged by being listed
    expect(w.db.rows("SELECT json_extract(fields_json, '$.body') AS body FROM uw_register_row WHERE store = ?", STORE)).toEqual([{ body: 'Synthetic page note from the viewer' }]);
    w.db.sqlite.prepare('INSERT INTO uw_register_row (case_id, store, row_id, fields_json, fields_sha256, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('case-a', STORE, 'malformed-page-row', 'null', 'digest', '2200-01-01T00:00:00Z', '2200-01-01T00:00:00Z', 'malformed-version');
    const reloaded = await w.timed('/notes', { method: 'GET' }, (locals, _r, url) => notesLoad({ locals, params: { caseId: 'case-a' }, url } as never));
    expect(reloaded.thrown).toBeUndefined();
    expect(reloaded.value?.notes.state).toBe('available');
    expect(reloaded.value?.pageNotes).toMatchObject({ unreadable: 1, items: [{ body: 'Synthetic page note from the viewer' }] });
    expect(reloaded.counts).toMatchObject({ d1: 3, clerk: 0, otherFetch: 0 }); expect(reloaded.sequential).toBe(2);
  } finally { await w.cleanup(); }
});

it('292 the document loader shows the page notes on its original\'s bytes in its one notes query, beside its one links call', async () => {
  const db = database(); bind(db);
  const c = counters(), auth = authority(); auth.grant('editor', CASE, 'editor');
  const work = createD1UserWork({ db: countedD1(d1(db), c), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(), audit: auditLog().sink,
    store: caseReader({ published: RV1, versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }] } }).reader, now: () => new Date('2200-01-01T00:00:00Z') });
  try {
    let op = 0;
    const put = (assetId: string, sha256: string, page: number, body: string) => work.putRow({ caseId: CASE, expected: { kind: 'absent' }, operationId: `p-${++op}`, store: STORE, rowId: null, fields: { assetId, page, body, sha256 }, anchor: null });
    await put('D-001', SHA_A, 7, 'Synthetic page seven'); await put('D-044', SHA_A, 1, 'Synthetic same bytes, other asset id'); await put('D-001', SHA_B, 1, 'Synthetic other bytes');
    await work.addNote({ caseId: CASE, operationId: 'doc-note', expected: { kind: 'absent' }, target: { kind: 'document', anchor: { caseId: CASE, resultsVersion: RV1, refAtCreation: 'D-001', sha256: SHA_A } }, body: 'Synthetic document note' });
    let links = 0, anchors = 0;
    const doc = { ref: 'D-001', source: 'results', fields: {}, state: { original: { sha256: SHA_A }, flags: [] }, attachments: [], assetIds: { own: 'D-001' }, mediaType: 'application/pdf', originalState: 'available' };
    const locals = {
      store: { publication: async () => ({ versionId: RV1, shardManifestSha256: 'a'.repeat(64), shards: { 'doc/D-001.json': 100 } }) },
      userWork: { ...work, anchorFor: async () => { anchors++; throw new Error('extra anchor lookup'); } },
      assets: { links: async () => { links++; return { originalHref: '/original', downloadHref: '/download', viewerHref: '/viewer' }; } },
      shards: { read: async () => Response.json(doc) },
    } as unknown as C.RequestServices;
    const result = await measure(c, () => document({ locals, params: { caseId: CASE, version: RV1, ref: 'D-001' }, url: new URL('https://synthetic.invalid/') } as never));
    expect(result.thrown).toBeUndefined();
    expect(result.value?.notes).toMatchObject([{ body: 'Synthetic document note' }]);
    expect(result.value?.pageNotes.map((n) => [n.page, n.body, n.here, n.href])).toEqual([
      [1, 'Synthetic same bytes, other asset id', false, '/cases/synthetic-case/originals/D-044/view?page=1'],
      [7, 'Synthetic page seven', true, '/cases/synthetic-case/originals/D-001/view?page=7'],
    ]);
    // 16 pins this loader at one notes query and one links call: unchanged
    expect([result.counts.d1, links, anchors]).toEqual([1, 1, 0]);
    await work.putRow({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'malformed-doc-note', store: STORE, rowId: null,
      fields: { assetId: 'D-001', sha256: SHA_A, body: 'Synthetic missing page' }, anchor: null });
    const reloaded = await measure(c, () => document({ locals, params: { caseId: CASE, version: RV1, ref: 'D-001' }, url: new URL('https://synthetic.invalid/') } as never));
    expect(reloaded.thrown).toBeUndefined();
    expect(reloaded.value?.pageNotes).toHaveLength(2);
    expect(reloaded.value?.pageNotesUnreadable).toBe(1);
    expect(reloaded.counts.d1).toBe(1); expect([links, anchors]).toEqual([2, 0]);
  } finally { db.close(); }
});

it('292 the full document visit over production authority shows an existing page note for the same 4 warm D1 calls 16 measured', async () => {
  const b = await docCase(), pending: Promise<void>[] = [];
  try {
    const dep = await published(b), hash = Buffer.from(PARENT.padEnd(32, '_')).toString('hex');
    dep.db.sqlite.prepare('INSERT INTO rs_original (sha256,size,object_key,etag,media_family) VALUES (?,4,?,?,?)').run(hash, `orig/${hash}`, 'synthetic-etag', 'pdf');
    dep.db.sqlite.prepare('INSERT INTO rs_case_original (case_id,asset_id,sha256,filename,media_type,finalized_at) VALUES (?,?,?,?,?,?)').run(CASE_ID, PARENT, hash, `${PARENT}.pdf`, 'application/pdf', '2200-01-01T00:00:00Z');
    const [{ sha }] = dep.db.sqlite.prepare("SELECT json_extract(state_json, '$.original.sha256') AS sha FROM rs_document WHERE ref = ?").all(PARENT) as { sha: string }[];
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const c = counters(), cache = memoryShardCache();
    const visit = async () => {
      const { l } = await oneLookupLocals(dep, c, cache, pending);
      const e = { locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion, ref: PARENT }, url: new URL('https://client-a.example.invalid/') } as never;
      return Promise.all([layout(e), document(e)]);
    };
    const cold = await measure(c, visit); expect(cold.thrown).toBeUndefined();
    await Promise.all(pending.splice(0));
    // an existing page note, as the viewer stored it before this change (the first visit created the user-work tables)
    const fields = JSON.stringify({ assetId: PARENT, page: 3, body: 'Synthetic existing page note', sha256: sha });
    dep.db.sqlite.prepare('INSERT INTO uw_register_row (case_id, store, row_id, anchor_json, fields_json, fields_sha256, created_at, updated_at, version) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(CASE_ID, STORE, 'existing-row', fields, Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fields))).toString('hex'), '2200-01-01T00:00:00Z', '2200-01-01T00:00:00Z', 'existing-version');
    const warm = await measure(c, visit); expect(warm.thrown).toBeUndefined();
    expect(warm.value?.[1].pageNotes).toMatchObject([{ rowId: 'existing-row', version: 'existing-version', page: 3, body: 'Synthetic existing page note', here: true, intact: true }]);
    expect(warm.counts.d1).toBe(4); expect(warm.counts.clerk).toBe(0);
  } finally { await Promise.all(pending); await b.cleanup(); }
});

it('292 the overview notes summary counts the case\'s stored page notes inside its one lookup query, as the d1 summary does', async () => {
  const b = await docCase(), pending: Promise<void>[] = [];
  try {
    const dep = await published(b), rv = b.built.record.resultsVersion as C.ResultsVersion, caseId = CASE_ID as C.CaseId;
    const legacy = locals(dep);
    const empty = await legacy.userWork.summary({ caseId, resultsVersion: rv });
    expect(empty.pageNotes).toBe(0);
    const noteBody = 'Synthetic case note', noteDigest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(noteBody))).toString('hex');
    dep.db.sqlite.prepare("INSERT INTO uw_note (case_id, note_id, target_kind, anchor_results_version, anchor_ref, anchor_sha256, target_json, body, body_sha256, created_at, version) VALUES (?, 'case-note', 'case', NULL, NULL, NULL, '{\"kind\":\"case\"}', ?, ?, '2200-01-01T00:00:00Z', 'v-n')").run(CASE_ID, noteBody, noteDigest);
    // two page notes as the viewer stores them, one of them no longer a readable page note: both are stored, both count
    const insert = dep.db.sqlite.prepare('INSERT INTO uw_register_row (case_id, store, row_id, anchor_json, fields_json, fields_sha256, created_at, updated_at, version) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)');
    insert.run(CASE_ID, STORE, 'page-a', JSON.stringify({ assetId: PARENT, page: 1, body: 'Synthetic page note', sha256: 'e'.repeat(64) }), 'x', '2200-01-01T00:00:00Z', '2200-01-01T00:00:00Z', 'v-a');
    insert.run(CASE_ID, STORE, 'page-b', JSON.stringify({ assetId: PARENT, body: 'no page' }), 'x', '2200-01-01T00:00:00Z', '2200-01-01T00:00:00Z', 'v-b');
    // another register's rows and another case's page notes do not count
    insert.run(CASE_ID, 'deadlines', 'deadline-a', JSON.stringify({ title: 'Synthetic deadline' }), 'x', '2200-01-01T00:00:00Z', '2200-01-01T00:00:00Z', 'v-d');
    insert.run('synthetic-other-case', STORE, 'page-other', JSON.stringify({ assetId: PARENT, page: 1, body: 'Other case', sha256: 'e'.repeat(64) }), 'x', '2200-01-01T00:00:00Z', '2200-01-01T00:00:00Z', 'v-o');
    const expected = await legacy.userWork.summary({ caseId, resultsVersion: rv });
    expect(expected).toMatchObject({ total: 1, here: 1, pageNotes: 2 });
    const c = counters();
    const { l } = await oneLookupLocals(dep, c, memoryShardCache(), pending);
    const result = await measure(c, () => l.userWork.summary({ caseId, resultsVersion: rv }));
    expect(result.thrown).toBeUndefined(); expect(result.value).toEqual(expected);
    // 09b's one-read summary: the count rides in the grant/case/publication/notes lookup, no row is decoded
    expect(result.counts).toMatchObject({ d1: 1, clerk: 0, r2: 0 });
  } finally { await Promise.all(pending); await b.cleanup(); }
});
