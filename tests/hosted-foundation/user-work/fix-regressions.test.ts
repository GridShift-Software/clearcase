// Synthetic SQLite stand-in only. These exercise the adapter, not real D1 or provider boundaries.
import { expect, it } from 'vitest';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { createD1UserWork, d1WorkRevision, type D1UserWorkOptions, type UserWorkDefinitionAuthority } from '../../../src/lib/user-work/hosted/index.ts';
import { auditLog, authority, bind, CASE, caseReader, CLIENT, d1, database, ISSUER, LIMITS, OTHER_CASE, OTHER_CLIENT, RV1, SHA_A } from './world.ts';
import { canonical, definition } from '../../../src/lib/user-work/hosted/validate.ts';
import { auditConfig, requestAuditSink } from '../../../src/lib/audit/index.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { readFileSync } from 'node:fs';

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
    expect([...audit.events.values()]).toMatchObject([{ action, object: { caseId }, outcome: 'denied', at: NOW().toISOString(), version: null }]);
    const event = [...audit.events.values()][0]!;
    expect(event.object).toEqual(caseId ? { kind: 'case', id: caseId, caseId } : { kind: 'user-work', id: 'tables', caseId: null });
    expect(event.actor).toMatchObject(code === 'unauthenticated' ? { kind: 'anonymous', principal: null, sessionId: null } : { kind: 'verified', principal: { issuer: ISSUER, kind: 'client' } });
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
    expect(written<unknown>(await request()).kind).toBe('written');
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

it('requires explicit table authority for editors and staff too, and accepts only an exact trusted catalogue entry', async () => {
  const { make, auth, db, audit } = setup();
  const editor = auth.identity();
  if (editor.kind !== 'verified') throw new Error('fixture');
  const staff: C.Identity = { ...editor, principal: { ...editor.principal, kind: 'staff' } };
  for (const identity of [editor, staff]) {
    await expect(make({ identity }).defineTable({ definition: costs })).rejects.toMatchObject({ code: 'forbidden' });
  }
  const catalogue: UserWorkDefinitionAuthority = { async authorize(a) {
    expect(a.clientId).toBe(CLIENT);
    if (canonical(a.definition) !== canonical(definition(costs))) throw contractError('forbidden');
  } };
  // Trusted feature registration is lazy and does not invent any case grant for this member.
  const feature = make({ identity: auth.identity('unassigned'), tableDefinitions: catalogue });
  await feature.defineTable({ definition: costs });
  await feature.defineTable({ definition: costs });
  await expect(feature.defineTable({ definition: { ...costs, name: 'poison', owner: 'unassigned' } })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(feature.notesFor({ caseId: CASE, target: null })).rejects.toMatchObject({ code: 'forbidden' });
  expect(db.prepare('SELECT name, owner FROM uw_table_definition').all()).toEqual([{ name: 'costs', owner: 'feature-costs' }]);
  expect([...audit.events.values()].filter(e => e.action === 'user-work.table-define')).toHaveLength(1);
});

it('refuses implicit restore definitions without authority, without changing any case data', async () => {
  const source = setup();
  const catalogue: UserWorkDefinitionAuthority = { async authorize(a) {
    if (canonical(a.definition) !== canonical(definition(costs))) throw contractError('forbidden');
  } };
  await source.make({ tableDefinitions: catalogue }).defineTable({ definition: costs });
  const snapshot = await source.make().exportAll({ caseId: CASE });
  const { make, revision, db, audit } = setup(), work = make();
  const note = written(await work.addNote({ caseId: CASE, target: { kind: 'case' }, body: 'Keep', expected: { kind: 'absent' }, operationId: 'keep' }));
  const current = await work.exportAll({ caseId: CASE }), expectedRevision = await revision();
  const preRestore = await work.snapshots.put({ caseId: CASE, snapshot: current, revision: expectedRevision });
  const request = { caseId: CASE, snapshot, expectedRevision, preRestore, operationId: 'restore' };
  const before = audit.state.appends;
  await expect(work.importAll(request)).rejects.toMatchObject({ code: 'forbidden' });
  expect(audit.state.appends - before).toBe(1);
  expect([...audit.events.values()].at(-1)).toMatchObject({ action: 'user-work.write', object: { caseId: CASE }, outcome: 'denied' });
  expect(db.prepare('SELECT count(*) AS n FROM uw_table_definition').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) AS n FROM uw_operation').get()).toEqual({ n: 1 });
  expect((await work.notesFor({ caseId: CASE, target: null })).map(n => n.id)).toEqual([note.value.id]);
  expect(await revision()).toBe(expectedRevision);
  written(await make({ tableDefinitions: catalogue }).importAll(request));
  expect(db.prepare('SELECT name FROM uw_table_definition').all()).toEqual([{ name: 'costs' }]);
  // Once registered by trusted code, ordinary case editors may restore rows without schema authority.
  const registered = await work.exportAll({ caseId: CASE }), next = await revision();
  const nextReceipt = await work.snapshots.put({ caseId: CASE, snapshot: registered, revision: next });
  written(await work.importAll({ ...request, expectedRevision: next, preRestore: nextReceipt, operationId: 'ordinary-restore' }));
});

it('rechecks the session after an awaited definition authority and fresh Note context lookup', async () => {
  {
    const { make, auth, db } = setup();
    await expect(make({ tableDefinitions: { async authorize() { auth.revoke('session-editor'); } } }).defineTable({ definition: costs })).rejects.toMatchObject({ code: 'invalid-session' });
    expect(db.prepare('SELECT count(*) AS n FROM uw_table_definition').get()).toEqual({ n: 0 });
  }
  {
    const { make, auth, db, reader } = setup();
    const store = new Proxy(reader.reader, { get(target, key) {
      if (key === 'documentRow') return async (a: C.VersionScope & { ref: string }) => { const row = await target.documentRow(a); auth.revoke('session-editor'); return row; };
      return Reflect.get(target, key);
    } });
    const anchor: C.Anchor = { caseId: CASE, resultsVersion: RV1, refAtCreation: 'D-001', sha256: SHA_A };
    await expect(make({ store }).addNote({ caseId: CASE, target: { kind: 'document', anchor }, body: 'No write', expected: { kind: 'absent' }, operationId: 'revoked' })).rejects.toMatchObject({ code: 'invalid-session' });
    expect(db.prepare('SELECT count(*) AS n FROM uw_operation').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM uw_note').get()).toEqual({ n: 0 });
  }
});

it('acknowledges the original event through the real request audit facade from a later current session', async () => {
  const { make, auth, db, audit } = setup();
  db.exec(readFileSync(new URL('../../../src/lib/audit/migrations/0001_native_audit.sql', import.meta.url), 'utf8'));
  const config = auditConfig({ clientId: CLIENT, trustedIssuers: [ISSUER], limits: { maxEventBytes: 2048, maxRows: 100, maxReadRows: 100, maxDenialRows: 10, maxDenialsPerActor: 5, maxPageRows: 50, maxPagesPerRequest: 5 } });
  await provisionAuditBinding({ db: d1(db), config, now: NOW });
  const request = { caseId: CASE, target: { kind: 'case' as const }, body: 'Durable', expected: { kind: 'absent' as const }, operationId: 'cross-session' };
  audit.state.down = true;
  await expect(make().addNote(request)).rejects.toMatchObject({ code: 'audit-unavailable' });
  auth.revoke('session-editor');
  const identity = auth.identity('editor', CLIENT, 'later-session');
  if (identity.kind !== 'verified') throw new Error('fixture');
  const sink = requestAuditSink({ db: d1(db), config, requester: { kind: 'verified', principal: identity.principal, sessionId: identity.sessionId }, now: NOW });
  const retry = make({ identity, audit: sink });
  const first = written(await retry.addNote(request));
  expect(await retry.addNote(request)).toEqual(first);
  expect(db.prepare('SELECT audited_at FROM uw_operation').get()).toEqual({ audited_at: NOW().toISOString() });
  expect(db.prepare('SELECT action, outcome FROM native_audit_events').all()).toEqual([{ action: 'user-work.note-add', outcome: 'succeeded' }]);
  const original = JSON.parse((db.prepare('SELECT event_json FROM uw_operation').get() as { event_json: string }).event_json) as C.AuditEvent;
  expect(original.actor.sessionId).toBe('session-editor');
});

it('does not release a durable replay result when its current session is revoked during audit acknowledgement', async () => {
  const { make, auth, audit, db } = setup();
  const request = { caseId: CASE, target: { kind: 'case' as const }, body: 'Private result', expected: { kind: 'absent' as const }, operationId: 'release' };
  audit.state.down = true;
  await expect(make().addNote(request)).rejects.toMatchObject({ code: 'audit-unavailable' });
  audit.state.down = false;
  const sink: C.AuditSink = { async append(event) { const result = await audit.sink.append(event); if (event.outcome === 'succeeded') auth.revoke('session-editor'); return result; } };
  await expect(make({ audit: sink }).addNote(request)).rejects.toMatchObject({ code: 'invalid-session' });
  expect(db.prepare('SELECT count(*) AS n FROM uw_note').get()).toEqual({ n: 1 });
  expect([...audit.events.values()].filter(e => e.outcome === 'denied')).toHaveLength(1);
  const recovered = make({ identity: auth.identity('editor', CLIENT, 'recovery-session') });
  expect(written(await recovered.addNote(request)).value.body).toBe('Private result');
  expect(db.prepare('SELECT count(*) AS n FROM uw_operation').get()).toEqual({ n: 1 });
});

it('rechecks an explicit definition grant immediately before direct and implicit registration', async () => {
  const trusted: UserWorkDefinitionAuthority = { async authorize() {} };
  const source = setup();
  await source.make({ tableDefinitions: trusted }).defineTable({ definition: costs });
  const snapshot = await source.make().exportAll({ caseId: CASE });
  for (const mode of ['direct', 'restore'] as const) {
    const { make, db, revision } = setup();
    let checks = 0;
    const tableDefinitions: UserWorkDefinitionAuthority = { async authorize() { if (++checks > 1) throw contractError('forbidden'); } };
    const work = make({ tableDefinitions });
    if (mode === 'direct') {
      await expect(work.defineTable({ definition: costs })).rejects.toMatchObject({ code: 'forbidden' });
    } else {
      const current = await work.exportAll({ caseId: CASE }), expectedRevision = await revision();
      const preRestore = await work.snapshots.put({ caseId: CASE, snapshot: current, revision: expectedRevision });
      await expect(work.importAll({ caseId: CASE, snapshot, expectedRevision, preRestore, operationId: 'revoked-definition' })).rejects.toMatchObject({ code: 'forbidden' });
      expect(await revision()).toBe(expectedRevision);
    }
    expect(checks).toBe(2);
    expect(db.prepare('SELECT count(*) AS n FROM uw_table_definition').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM uw_operation').get()).toEqual({ n: 0 });
  }
});
