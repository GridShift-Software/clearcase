// Synthetic SQLite stand-in only. These exercise the adapter, not real D1 or provider boundaries.
import { expect, it } from 'vitest';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { createD1UserWork, d1WorkRevision, type D1UserWorkOptions } from '../../../src/lib/user-work/hosted/index.ts';
import { auditLog, authority, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, OTHER_CASE, OTHER_CLIENT, RV1, SHA_A } from './world.ts';

const NOW = () => new Date('2026-10-25T00:00:00.000Z');
const costs: C.TableDefinition = { name: 'costs', owner: 'feature-costs', scope: 'case', description: 'Trusted costs', columns: [{ name: 'case_id', type: 'TEXT', notNull: true }, { name: 'id', type: 'TEXT' }], primaryKey: ['id'] };
function setup() {
  const db = database(); bind(db);
  const auth = authority(); auth.grant('editor', CASE, 'editor'); auth.grant('editor', OTHER_CASE, 'editor');
  const audit = auditLog();
  const reader = caseReader({ published: RV1, versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }] }, seeds: { [RV1]: [{ datasetKey: 'parties', seedId: 'p1', seedSha256: 'd'.repeat(64), record: {} }] } });
  const make = (options: Partial<D1UserWorkOptions> = {}) => createD1UserWork({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(), audit: audit.sink, store: reader.reader, now: NOW, ...options });
  const revision = () => d1WorkRevision({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS } })({ caseId: CASE });
  return { db, auth, audit, reader, make, revision };
}
function written<T>(r: C.Written<T> | 'absent') {
  if (r === 'absent' || r.kind !== 'written') throw new Error('expected written');
  return r;
}

it('audits each early authority refusal once, with scope, even when the sink fails', async () => {
  const { db, make, auth, audit, revision } = setup(), work = make();
  const anchor = await work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-001' });
  const snapshot = await work.exportAll({ caseId: CASE });
  const receipt = await work.snapshots.put({ caseId: CASE, snapshot, revision: await revision() });
  const anonymous: C.Identity = { kind: 'anonymous', principal: null, sessionId: null, clientId: CLIENT, checkRevocation: async () => {}, authorize: async () => { throw contractError('unauthenticated'); } };
  const cases: [() => Promise<unknown>, string, C.CaseId | null, string][] = [
    [() => make({ identity: auth.identity('editor', OTHER_CLIENT) }).notesFor({ caseId: CASE, target: null }), 'wrong-client', CASE, 'user-work.read'],
    [() => work.resolve({ anchor, into: { caseId: OTHER_CASE, resultsVersion: RV1 } }), 'forbidden', OTHER_CASE, 'user-work.read'],
    [() => work.addNote({ caseId: OTHER_CASE, target: { kind: 'document', anchor }, body: 'x', expected: { kind: 'absent' }, operationId: 'cross-note' }), 'forbidden', OTHER_CASE, 'user-work.write'],
    [() => work.putSeedOverlay({ caseId: OTHER_CASE, overlay: { caseId: CASE, datasetKey: 'parties', seedId: 'p1', baseSeedSha256: 'd'.repeat(64), fields: {} }, expected: { kind: 'absent' }, operationId: 'cross-overlay' }), 'forbidden', OTHER_CASE, 'user-work.write'],
    [() => work.putRow({ caseId: OTHER_CASE, anchor, store: 'time', rowId: null, fields: {}, expected: { kind: 'absent' }, operationId: 'cross-row' }), 'forbidden', OTHER_CASE, 'user-work.write'],
    [() => make({ identity: anonymous }).defineTable({ definition: costs }), 'unauthenticated', null, 'user-work.write'],
    [() => work.snapshots.get({ caseId: OTHER_CASE, id: receipt }), 'forbidden', OTHER_CASE, 'user-work.read'],
    [() => make({ identity: auth.identity('unassigned') }).summary({ caseId: CASE, resultsVersion: null }), 'forbidden', CASE, 'user-work.read'],
  ];
  for (const [request, code, caseId, action] of cases) {
    audit.events.clear(); const before = audit.state.appends;
    await expect(request()).rejects.toMatchObject({ code });
    expect(audit.state.appends - before).toBe(1);
    expect([...audit.events.values()]).toMatchObject([{ action, object: { caseId }, outcome: 'denied', at: NOW().toISOString() }]);
    audit.state.down = true;
    const failedBefore = audit.state.appends;
    await expect(request()).rejects.toMatchObject({ code });
    expect(audit.state.appends - failedBefore).toBe(1);
    audit.state.down = false;
  }
  expect(db.prepare('SELECT count(*) AS n FROM uw_operation').get()).toEqual({ n: 0 });
});

it('replays analysis Notes and seed removals after withdrawal, but validates fresh operations', async () => {
  for (const kind of ['analysis', 'seed'] as const) {
    const { make, audit, reader, db } = setup();
    const request = (operationId = 'retry') => kind === 'analysis'
      ? make().addNote({ caseId: CASE, target: { kind: 'analysis', resultsVersion: RV1, section: 'overview' }, body: 'Analysis', expected: { kind: 'absent' }, operationId })
      : make().registers.seeds({ caseId: CASE, datasetKey: 'parties', resultsVersion: RV1 }).remove({ seedId: 'p1', expected: id('row-version', `seed:${'d'.repeat(64)}`), operationId });
    audit.state.down = true;
    await expect(request()).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'written-unaudited' });
    reader.state.withdrawn.add(RV1); reader.state.published = null; audit.state.down = false;
    expect(written(await request()).kind).toBe('written');
    expect(db.prepare('SELECT audited_at FROM uw_operation').get()).toEqual({ audited_at: NOW().toISOString() });
    await expect(request('fresh')).rejects.toMatchObject({ code: 'forbidden' });
    expect(db.prepare('SELECT count(*) AS n FROM uw_operation').get()).toEqual({ n: 1 });
  }
});

it('retries under a new current session of the same principal, never a revoked session or another actor', async () => {
  const { make, audit, auth, reader, db } = setup();
  const target: C.NoteTarget = { kind: 'document', anchor: { caseId: CASE, resultsVersion: RV1, refAtCreation: 'D-001', sha256: SHA_A } };
  const request = { caseId: CASE, operationId: 'retry', expected: { kind: 'absent' as const }, target, body: 'Same actor' };
  audit.state.down = true;
  await expect(make().addNote(request)).rejects.toMatchObject({ code: 'audit-unavailable' });
  audit.state.down = false; reader.state.withdrawn.add(RV1); auth.revoke('session-editor');
  await expect(make().addNote(request)).rejects.toMatchObject({ code: 'invalid-session' });
  auth.grant('other', CASE, 'editor');
  await expect(make({ identity: auth.identity('other') }).addNote(request)).rejects.toMatchObject({ code: 'invalid' });
  auth.grant('editor', CASE, null);
  const current = make({ identity: auth.identity('editor', CLIENT, 'new-session') });
  await expect(current.addNote(request)).rejects.toMatchObject({ code: 'forbidden' });
  auth.grant('editor', CASE, 'editor');
  expect(written(await current.addNote(request)).value.body).toBe('Same actor');
  expect(db.prepare('SELECT count(*) AS n FROM uw_note').get()).toEqual({ n: 1 });
  expect([...audit.events.values()].filter(e => e.action === 'user-work.note-add')).toHaveLength(1);
});
