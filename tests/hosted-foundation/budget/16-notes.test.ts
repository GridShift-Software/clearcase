// Synthetic SQLite/D1-double call budgets. These do not measure a deployed Worker or save latency.
import { expect, it } from 'vitest';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { load as document, actions } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import { counters, countedD1, measure } from './harness.ts';
import { authority, auditLog, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, RV1, SHA_A } from '../user-work/world.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { readFileSync } from 'node:fs';
import { requestAuditSink } from '../../../src/lib/audit/facades.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { ISSUER } from '../user-work/world.ts';
import { docCase, PARENT } from '../../publication/shards/12-world.ts';
import { CASE_ID, published } from '../../publication/shards/world.ts';
import { oneLookupLocals } from './one-lookup.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { load as layout } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';

function notes() {
  const db = database(); bind(db);
  const c = counters(), auth = authority(); auth.grant('editor', CASE, 'editor');
  const reader = caseReader({ published: RV1, versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }] } });
  const work = createD1UserWork({ db: countedD1(d1(db), c), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(), audit: auditLog().sink, store: reader.reader, now: () => new Date('2200-01-01T00:00:00Z') });
  return { db, c, work };
}

it('16 case notes read checks binding and returns the empty case in one D1 query', async () => {
  const w = notes();
  try {
    const result = await measure(w.c, () => w.work.notesFor({ caseId: CASE, target: null }));
    expect(result.thrown).toBeUndefined(); expect(result.value).toEqual([]);
    expect(result.counts).toMatchObject({ d1: 1, clerk: 0, r2: 0 });
  } finally { w.db.close(); }
});

it('16 notes binding mismatch refuses, never disguises unavailable storage as an empty list', async () => {
  const db = database(), auth = authority(); auth.grant('editor', CASE, 'editor');
  const reader = caseReader({ published: RV1, versions: {} });
  const work = createD1UserWork({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(), audit: auditLog().sink, store: reader.reader, now: () => new Date('2200-01-01T00:00:00Z') });
  try { await expect(work.notesFor({ caseId: CASE, target: null })).rejects.toMatchObject({ code: 'storage-unavailable' }); }
  finally { db.close(); }
});

it('16 document loader uses one notes query plus one links call beyond publication authorization', async () => {
  const w = notes();
  try {
    const target: C.NoteTarget = { kind: 'document', anchor: { caseId: CASE, resultsVersion: RV1, refAtCreation: 'D-001', sha256: SHA_A } };
    await w.work.addNote({ caseId: CASE, operationId: 'document-note', expected: { kind: 'absent' }, target, body: 'Synthetic page note' });
    let links = 0, anchors = 0;
    const doc = { ref: 'D-001', source: 'results', fields: {}, state: { original: { sha256: SHA_A }, flags: [] }, attachments: [], assetIds: { own: 'D-001' }, mediaType: 'application/pdf', originalState: 'available' };
    const locals = {
      // Publication and asset serving have separate budget suites; count the route's calls, not an invented full-request cost.
      store: { publication: async () => ({ versionId: RV1, shardManifestSha256: 'a'.repeat(64), shards: { 'doc/D-001.json': 100 } }) },
      userWork: { ...w.work, anchorFor: async () => { anchors++; throw new Error('extra anchor lookup'); } },
      assets: { links: async () => { links++; return { originalHref: '/original', downloadHref: '/download', viewerHref: '/viewer' }; } },
      shards: { read: async () => Response.json(doc) },
    } as unknown as C.RequestServices;
    const result = await measure(w.c, () => document({ locals, params: { caseId: CASE, version: RV1, ref: 'D-001' }, url: new URL('https://synthetic.invalid/') } as never));
    expect(result.thrown).toBeUndefined();
    expect(result.value?.notes).toMatchObject([{ body: 'Synthetic page note', refAtCreation: 'D-001' }]);
    expect([result.counts.d1, links, anchors]).toEqual([1, 1, 0]);
  } finally { w.db.close(); }
});

it('16 document note action survives a loader roundtrip, and the bound read fetches only that document', async () => {
  const w = notes();
  try {
    const doc = { ref: 'D-001', source: 'results', fields: {}, state: { original: { sha256: SHA_A }, flags: [] }, attachments: [], assetIds: {}, mediaType: null, originalState: 'missing' };
    const locals = {
      store: { publication: async () => ({ versionId: RV1, shardManifestSha256: 'a'.repeat(64), shards: { 'doc/D-001.json': 100 } }) },
      userWork: w.work, shards: { read: async () => Response.json(doc) },
    } as unknown as C.RequestServices;
    const form = new FormData(); form.set('body', 'Synthetic action roundtrip'); form.set('operationId', 'action-roundtrip');
    const event = { locals, params: { caseId: CASE, version: RV1, ref: 'D-001' }, url: new URL('https://synthetic.invalid/'),
      request: new Request('https://synthetic.invalid/?/note', { method: 'POST', body: form }) };
    // The answer carries the saved note and a fresh operation id for the next form, so the page shows it without a reload.
    expect(await actions.note!(event as never)).toEqual({ saved: true, operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      note: expect.objectContaining({ body: 'Synthetic action roundtrip', refAtCreation: 'D-001', resultsVersion: RV1, anchorSha256: SHA_A, status: 'here', intact: true, version: expect.any(String) }) });
    // Populate many other targets with deliberately corrupt JSON: a bounded document read must never fetch/decode them.
    const insert = w.db.prepare(`INSERT INTO uw_note (case_id,note_id,target_kind,anchor_results_version,anchor_ref,anchor_sha256,target_json,body,body_sha256,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 200; i++) insert.run(CASE, `other-${i}`, 'document', RV1, 'D-OTHER', SHA_A, 'not-json', 'Other document', 'invalid', '2200-01-01T00:00:00Z', `other-${i}`);
    const result = await measure(w.c, () => document(event as never));
    expect(result.thrown).toBeUndefined(); expect(result.counts.d1).toBe(1);
    expect(result.value?.notes).toMatchObject([{ body: 'Synthetic action roundtrip', refAtCreation: 'D-001', resultsVersion: RV1, anchorSha256: SHA_A }]);
    expect(result.value?.notes).toHaveLength(1);
    w.db.prepare('DELETE FROM uw_note WHERE anchor_ref = ?').run('D-001');
    expect((await document(event as never)).notes).toEqual([]); // the LEFT JOIN retains the valid binding for an empty document
  } finally { w.db.close(); }
});

it('16 note save commits its audit in exactly one D1 batch, with no post-commit audit append', async () => {
  const db = database(); bind(db);
  const auth = authority(); auth.grant('editor', CASE, 'editor');
  db.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
  const config = auditConfig({ clientId: CLIENT, trustedIssuers: [ISSUER], limits: { maxEventBytes: 4096, maxRows: 100, maxReadRows: 100, maxDenialRows: 100, maxDenialsPerActor: 100, maxPageRows: 50, maxPagesPerRequest: 5 } });
  const c = counters(), raw = d1(db), now = () => new Date('2200-01-01T00:00:00Z');
  let batches = 0, appended = 0;
  const original = raw.batch;
  raw.batch = async statements => { batches++; return original(statements); };
  const binding = countedD1(raw, c);
  await provisionAuditBinding({ db: binding, config, now });
  const identity = auth.identity(), real = requestAuditSink({ db: binding, config, requester: { kind: 'verified', principal: identity.principal!, sessionId: identity.sessionId! }, now });
  const work = createD1UserWork({ db: binding, config: { clientId: CLIENT, limits: LIMITS }, identity,
    audit: { ...real, append: async event => { appended++; return real.append(event); } },
    store: caseReader({ published: RV1, versions: {} }).reader, now });
  try {
    const result = await measure(c, () => work.addNote({ caseId: CASE, operationId: 'atomic-budget', expected: { kind: 'absent' }, target: { kind: 'case' }, body: 'Synthetic budget note' }));
    expect(result.thrown).toBeUndefined(); expect(result.value?.kind).toBe('written');
    expect([batches, appended]).toEqual([1, 0]);
    expect(db.prepare('SELECT action FROM native_audit_events').get()).toEqual({ action: 'user-work.note-add' });
    console.log('16 atomic note save foreground calls (authorization double; preflight reads included)', result.counts);
  } finally { db.close(); }
});

it('16 records the full document visit over production authority: one new notes query beyond the inherited links cost', async () => {
  const b = await docCase(), pending: Promise<void>[] = [];
  try {
    const dep = await published(b), hash = Buffer.from(PARENT.padEnd(32, '_')).toString('hex');
    dep.db.sqlite.prepare('INSERT INTO rs_original (sha256,size,object_key,etag,media_family) VALUES (?,4,?,?,?)').run(hash, `orig/${hash}`, 'synthetic-etag', 'pdf');
    dep.db.sqlite.prepare('INSERT INTO rs_case_original (case_id,asset_id,sha256,filename,media_type,finalized_at) VALUES (?,?,?,?,?,?)').run(CASE_ID, PARENT, hash, `${PARENT}.pdf`, 'application/pdf', '2200-01-01T00:00:00Z');
    const c = counters(), cache = memoryShardCache();
    const visit = async () => {
      const { l } = await oneLookupLocals(dep, c, cache, pending);
      const e = { locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion, ref: PARENT }, url: new URL('https://client-a.example.invalid/') } as never;
      return Promise.all([layout(e), document(e)]);
    };
    const cold = await measure(c, visit); expect(cold.thrown).toBeUndefined();
    await Promise.all(pending.splice(0));
    const warm = await measure(c, visit); expect(warm.thrown).toBeUndefined();
    // Measurement, not a claim that the ticket's <=2 D1 beyond-authorization target is met: 12's links still cost 2.
    expect(warm.counts.d1).toBe(4); expect(warm.counts.clerk).toBe(0);
    expect(cold.counts.r2 - warm.counts.r2).toBe(2);
    console.log('16 full document visit (production authority), cold', cold.counts, 'warm', warm.counts, 'target beyond authorization=2; measured=3');
  } finally { await Promise.all(pending); await b.cleanup(); }
});
