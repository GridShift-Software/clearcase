// Synthetic SQLite/D1-double call budgets. These do not measure a deployed Worker or save latency.
import { expect, it } from 'vitest';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { load as document } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import { counters, countedD1, measure } from './harness.ts';
import { authority, auditLog, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, RV1, SHA_A } from '../user-work/world.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';

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
