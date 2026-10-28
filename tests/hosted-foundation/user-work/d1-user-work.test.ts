// GRS-117 hosted user work over the node:sqlite D1 stand-in. Synthetic cases only; NOT evidence of Cloudflare D1.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { UserWorkDefinitionAuthority } from '../../../src/lib/user-work/hosted/index.ts';
import { createD1UserWork, d1WorkRevision, userWorkConfig } from '../../../src/lib/user-work/hosted/index.ts';
import { provisionD1UserWork } from '../../../src/lib/user-work/hosted/provision.ts';
import { auditConfig, requestAuditSink } from '../../../src/lib/audit/index.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { readFileSync } from 'node:fs';
import {
  appendOnly, auditLog, authority, bind, CASE, caseReader, CLIENT, d1, database, ISSUER, LIMITS, OTHER_CASE, OTHER_CLIENT, RV1, RV2,
  SHA_A, SHA_B, SHA_C, type Fault,
} from './world.ts';

const NOW = () => new Date('2026-10-25T00:00:00.000Z');
const temp: string[] = [];
afterAll(() => { for (const dir of temp) rmSync(dir, { recursive: true, force: true }); });
function written<T>(r: C.Written<T> | 'absent'): Extract<C.Written<T>, { kind: 'written' }> { if (r === 'absent' || r.kind !== 'written') throw new Error(`expected written, got ${r === 'absent' ? r : r.kind}`); return r; }
const costs: C.TableDefinition = { name: 'costs', owner: 'costs-owner', description: 'Synthetic costs', scope: 'case', columns: [{ name: 'case_id', type: 'TEXT', notNull: true }, { name: 'id', type: 'TEXT' }, { name: 'amount', type: 'REAL' }], primaryKey: ['id'] };
// Explicit synthetic administrative grant, independent of the case-grant map. No production default is installed.
const definitionAdministrators = new Set([JSON.stringify([ISSUER, 'editor', 'client'])]);
const tableDefinitions: UserWorkDefinitionAuthority = {
  async authorize({ actor }) {
    if (actor.kind !== 'verified' || !definitionAdministrators.has(JSON.stringify([actor.principal.issuer, actor.principal.subject, actor.principal.kind]))) throw contractError('forbidden');
  },
};
const seedRow = (seedId: string, seedSha256: string): C.SeedRow => ({ datasetKey: 'parties', seedId, seedSha256, record: { name: `Synthetic ${seedId}` } });

function setup(o: { db?: DatabaseSync; published?: C.ResultsVersion | null } = {}) {
  const db = o.db ?? (() => { const d = database(); bind(d); return d; })();
  const auth = authority();
  for (const c of [CASE, OTHER_CASE]) { auth.grant('editor', c, 'editor'); auth.grant('viewer', c, 'viewer'); }
  const audit = auditLog();
  const reader = caseReader({
    published: o.published === undefined ? RV1 : o.published,
    // RV2 reuses ref D-001 for different content; the RV1 document moved to D-009. D-010 and D-011 share content C.
    versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }, { ref: 'D-002', sha256: SHA_B }, { ref: 'D-003', sha256: null }], [RV2]: [{ ref: 'D-001', sha256: SHA_B }, { ref: 'D-009', sha256: SHA_A }, { ref: 'D-010', sha256: SHA_C }, { ref: 'D-011', sha256: SHA_C }] },
    seeds: { [RV1]: [seedRow('p1', 'd'.repeat(64)), seedRow('p2', 'e'.repeat(64))] },
  });
  const make = (a: { subject?: string; fault?: Fault; clientId?: C.ClientId; identity?: C.Identity; audit?: C.AuditSink; database?: DatabaseSync } = {}) => createD1UserWork({
    db: d1(a.database ?? db, a.fault ?? {}), config: { clientId: CLIENT, limits: LIMITS }, identity: a.identity ?? auth.identity(a.subject ?? 'editor', a.clientId ?? CLIENT), audit: a.audit ?? audit.sink, store: reader.reader, now: NOW, tableDefinitions,
  });
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { db, auth, audit, reader, make, count };
}

describe('configuration, binding and provisioning', () => {
  it('requires every limit and the trusted client id, with no defaults', () => {
    expect(() => userWorkConfig({ clientId: CLIENT })).toThrow(TypeError);
    expect(() => userWorkConfig({ clientId: 'Not A Client', limits: LIMITS })).toThrow(TypeError);
    expect(() => userWorkConfig({ clientId: CLIENT, limits: { ...LIMITS, maxSnapshotBytes: 3_000_000 } })).toThrow(TypeError);
    expect(userWorkConfig({ clientId: CLIENT, limits: LIMITS }).limits).toEqual(LIMITS);
    const { auth, audit, reader } = setup();
    expect(() => createD1UserWork({ db: null, config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(), audit: undefined as never, store: reader.reader, now: NOW })).toThrow(TypeError);
    expect(audit.events.size).toBe(0);
  });

  it('refuses an unbound, foreign, other-version or missing database and never binds it from a request', async () => {
    for (const prepare of [(d: DatabaseSync) => void d, (d: DatabaseSync) => bind(d, OTHER_CLIENT), (d: DatabaseSync) => bind(d, CLIENT, 2)]) {
      const db = database(); prepare(db);
      const { make } = setup({ db }), work = make();
      await expect(work.listRows({ caseId: CASE, store: 'time' })).rejects.toMatchObject({ code: 'storage-unavailable' });
      await expect(work.putRow({ caseId: CASE, store: 'time', rowId: null, fields: {}, anchor: null, expected: { kind: 'absent' }, operationId: 'op' })).rejects.toMatchObject({ code: 'storage-unavailable' });
      expect(db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 0 });
    }
    const unbound = database();
    const { make } = setup({ db: unbound });
    await expect(make().notesFor({ caseId: CASE, target: null })).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(unbound.prepare('SELECT count(*) AS n FROM uw_binding').get()).toEqual({ n: 0 });
    const { auth, audit, reader } = setup();
    const missing = createD1UserWork({ db: null, config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(), audit: audit.sink, store: reader.reader, now: NOW });
    await expect(missing.notesFor({ caseId: CASE, target: null })).rejects.toMatchObject({ code: 'storage-unavailable' });
  });

  it('provisions once from trusted code and never rebinds another client', async () => {
    const db = database();
    expect(await provisionD1UserWork({ db: d1(db), clientId: CLIENT, now: NOW })).toEqual({ clientId: CLIENT, schemaVersion: 1 });
    expect(await provisionD1UserWork({ db: d1(db), clientId: CLIENT, now: NOW })).toEqual({ clientId: CLIENT, schemaVersion: 1 });
    await expect(provisionD1UserWork({ db: d1(db), clientId: OTHER_CLIENT, now: NOW })).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(() => db.prepare("UPDATE uw_binding SET client_id = 'client-b'").run()).toThrow(/fixed/);
    expect(() => db.prepare('DELETE FROM uw_binding').run()).toThrow(/cannot be deleted/);
    expect(() => db.prepare('UPDATE uw_binding SET schema_version = 0').run()).toThrow(/never decreases/);
  });

  it('refuses an identity from another client before touching storage', async () => {
    const { make, db } = setup(), work = make({ clientId: OTHER_CLIENT });
    await expect(work.listRows({ caseId: CASE, store: 'time' })).rejects.toMatchObject({ code: 'wrong-client' });
    await expect(work.putRow({ caseId: CASE, store: 'time', rowId: null, fields: {}, anchor: null, expected: { kind: 'absent' }, operationId: 'op' })).rejects.toMatchObject({ code: 'wrong-client' });
    expect(db.prepare('SELECT count(*) AS n FROM uw_operation').get()).toEqual({ n: 0 });
  });
});

describe('authorization and revocation on every operation', () => {
  it('asks revocation and the case grant for each read and write, and audits denials', async () => {
    const { make, auth, audit } = setup(), work = make();
    await work.listRows({ caseId: CASE, store: 'time' });
    written(await work.putRow({ caseId: CASE, store: 'time', rowId: null, fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op-1' }));
    expect(auth.state.calls).toEqual(['revocation:editor', 'revocation:editor', `authorize:editor:${CASE}:read`, 'revocation:editor', 'revocation:editor', `authorize:editor:${CASE}:write-user-work`]);
    const viewer = make({ subject: 'viewer' });
    expect((await viewer.listRows({ caseId: CASE, store: 'time' })).length).toBe(1);
    await expect(viewer.putRow({ caseId: CASE, store: 'time', rowId: null, fields: {}, anchor: null, expected: { kind: 'absent' }, operationId: 'op-v' })).rejects.toMatchObject({ code: 'forbidden' });
    const stranger = make({ subject: 'stranger' });
    await expect(stranger.notesFor({ caseId: CASE, target: null })).rejects.toMatchObject({ code: 'forbidden' });
    const denials = [...audit.events.values()].filter((e) => e.outcome === 'denied');
    expect(denials.map((e) => [e.action, e.object.caseId])).toEqual([['user-work.write', CASE], ['user-work.read', CASE]]);
  });

  it('binds a revoked session, a withdrawn grant and a same-operation replay at once', async () => {
    const { make, auth } = setup(), work = make();
    const first = written(await work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op-1' }));
    auth.grant('editor', CASE, null);
    await expect(work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op-1' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(work.listRows({ caseId: CASE, store: 'time' })).rejects.toMatchObject({ code: 'forbidden' });
    auth.grant('editor', CASE, 'editor');
    expect(await work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op-1' })).toEqual(first);
    auth.revoke('session-editor');
    await expect(work.listRows({ caseId: CASE, store: 'time' })).rejects.toMatchObject({ code: 'invalid-session' });
    await expect(work.tables()).rejects.toMatchObject({ code: 'invalid-session' });
    await expect(work.defineTable({ definition: costs })).rejects.toMatchObject({ code: 'invalid-session' });
    auth.state.identityDown = true;
    await expect(make({ subject: 'viewer' }).listRows({ caseId: CASE, store: 'time' })).rejects.toMatchObject({ code: 'identity-unavailable' });
  });
});

describe('every user-work category, without a published results version', () => {
  it('persists case Notes, register rows, overlays and defined tables for a case with no publication', async () => {
    const { make } = setup({ published: null }), work = make();
    const note = written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'note', target: { kind: 'case' }, body: ' a\r\nb ' }));
    expect(note.value).toMatchObject({ body: 'a\nb', target: { kind: 'case' }, status: 'here', intact: true });
    expect(await work.notesFor({ caseId: CASE, target: { kind: 'case' } })).toEqual([{ ...note.value, version: note.version }]);
    expect(await work.summary({ caseId: CASE, resultsVersion: null })).toMatchObject({ total: 1, here: 1, detached: [] });
    const row = written(await work.putRow({ caseId: CASE, store: 'time', rowId: null, fields: { hours: 2, billable: true, memo: null }, anchor: null, expected: { kind: 'absent' }, operationId: 'row' }));
    const register = work.registers.open({ caseId: CASE, store: 'time' });
    written(await register.replace({ rowId: row.value.rowId, expected: row.version, fields: { hours: 3 }, operationId: 'row-edit' }));
    expect((await register.rows()).map((r) => r.fields)).toEqual([{ hours: 3 }]);
    written(await work.putSeedOverlay({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'overlay', overlay: { caseId: CASE, datasetKey: 'parties', seedId: 'p1', baseSeedSha256: 'd'.repeat(64), fields: { name: 'Edited' } } }));
    expect((await work.overlays({ caseId: CASE })).map((o) => o.fields)).toEqual([{ name: 'Edited' }]);
    await work.defineTable({ definition: costs });
    await work.defineTable({ definition: costs });
    await expect(work.defineTable({ definition: { ...costs, description: 'Other shape' } })).rejects.toMatchObject({ code: 'table-conflict' });
    await expect(work.defineTable({ definition: { ...costs, name: 'note' } })).rejects.toMatchObject({ code: 'table-built-in' });
    const cost = written(await work.putTableRow({ caseId: CASE, table: 'costs', owner: 'costs-owner', row: { case_id: CASE, id: 'c1', amount: 12.5 }, expected: { kind: 'absent' }, operationId: 'cost' }));
    await expect(work.putTableRow({ caseId: CASE, table: 'costs', owner: 'other-owner', row: { case_id: CASE, id: 'c1', amount: 1 }, expected: { kind: 'match', version: cost.version }, operationId: 'cost-owner' })).rejects.toMatchObject({ code: 'table-conflict' });
    expect(await work.listTableRows({ caseId: CASE, table: 'costs' })).toEqual([{ cells: { case_id: CASE, id: 'c1', amount: 12.5 }, version: cost.version }]);
    expect(await work.registerStores({ caseId: CASE })).toEqual(['time']);
    expect((await work.tables()).map((t) => t.name)).toEqual(['note', 'seed_overlay', 'register_row', 'costs']);
    written(await work.deleteTableRow({ caseId: CASE, table: 'costs', owner: 'costs-owner', key: { case_id: CASE, id: 'c1' }, expected: { kind: 'match', version: cost.version }, operationId: 'cost-delete' }));
    written(await work.deleteNote({ caseId: CASE, id: note.value.id, expected: { kind: 'match', version: note.version }, operationId: 'note-delete' }));
    expect(await work.deleteNote({ caseId: CASE, id: note.value.id, expected: { kind: 'match', version: note.version }, operationId: 'note-delete-2' })).toEqual({ kind: 'gone' });
  });

  it('applies register commands atomically against the expected case revision', async () => {
    const { make, db } = setup(), work = make(), revision = d1WorkRevision({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS } });
    const register = work.registers.open({ caseId: CASE, store: 'time' });
    const start = await revision({ caseId: CASE });
    expect(start).toBe('revision-0');
    const bulk = written(await register.apply({ commands: [{ kind: 'add', fields: { hours: 1 } }, { kind: 'add', fields: { hours: 2 } }], expectedRevision: start, operationId: 'bulk' }));
    expect(await revision({ caseId: CASE })).toBe(bulk.caseRevision);
    const rows = await register.rows();
    expect(rows.map((r) => r.fields.hours)).toEqual([1, 2]);
    expect(await register.apply({ commands: [{ kind: 'remove', rowId: rows[0]!.rowId }, { kind: 'replace', rowId: 'absent', fields: {} }], expectedRevision: bulk.caseRevision, operationId: 'failed-bulk' })).toEqual({ kind: 'gone' });
    expect(await register.apply({ commands: [{ kind: 'remove', rowId: rows[0]!.rowId }], expectedRevision: start, operationId: 'stale-bulk' })).toEqual({ kind: 'stale' });
    expect((await register.rows()).length).toBe(2);
    expect(await work.putTableRows({ caseId: CASE, table: 'costs', owner: 'costs-owner', rows: [], expectedRevision: start, operationId: 'stale-table' })).toEqual({ kind: 'stale' });
  });

  it('removes a seed only against the exact published version, by its seed or overlay version', async () => {
    const { make, reader } = setup(), work = make();
    const seeds = work.registers.seeds({ caseId: CASE, resultsVersion: RV1, datasetKey: 'parties' });
    const view = (await seeds.views()).find((v) => 'seed' in v && v.seed.seedId === 'p2')!;
    expect(view.version).toBe(`seed:${'e'.repeat(64)}`);
    const removed = written(await seeds.remove({ seedId: 'p2', expected: view.version, operationId: 'seed-delete' }));
    expect(await seeds.remove({ seedId: 'p2', expected: view.version, operationId: 'seed-delete' })).toEqual(removed);
    expect(await seeds.remove({ seedId: 'p2', expected: view.version, operationId: 'seed-stale' })).toEqual({ kind: 'stale' });
    expect(await seeds.remove({ seedId: 'absent', expected: view.version, operationId: 'absent-seed' })).toBe('absent');
    expect((await seeds.views()).find((v) => 'overlay' in v && v.overlay.seedId === 'p2')).toMatchObject({ state: 'edited', overlay: { fields: { deleted: true } } });
    reader.state.published = RV2;
    await expect(seeds.remove({ seedId: 'p1', expected: id('row-version', `seed:${'d'.repeat(64)}`), operationId: 'unpublished' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('validates inputs before any write', async () => {
    const { make, count } = setup(), work = make();
    const bad: Promise<unknown>[] = [
      work.putRow({ caseId: CASE, store: 'Bad Store', rowId: null, fields: {}, anchor: null, expected: { kind: 'absent' }, operationId: 'a' }),
      work.putRow({ caseId: CASE, store: 'time', rowId: null, fields: { nested: { x: 1 } } as never, anchor: null, expected: { kind: 'absent' }, operationId: 'b' }),
      work.putRow({ caseId: CASE, store: 'time', rowId: null, fields: {}, anchor: null, expected: { kind: 'absent' }, operationId: 'bad op id!' }),
      work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'c', target: { kind: 'case' }, body: '   ' }),
      work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'd', target: { kind: 'case', extra: 1 } as never, body: 'x' }),
    ];
    for (const p of bad) await expect(p).rejects.toMatchObject({ code: 'invalid' });
    expect(count('uw_operation')).toBe(0);
  });
});

describe('concurrency, idempotency, lost acknowledgements and restart', () => {
  it('lets writers of different rows both succeed but never loses a concurrent update of the same row', async () => {
    const { make } = setup(), a = make(), b = make();
    const both = await Promise.all([
      a.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'a1' }),
      b.putRow({ caseId: CASE, store: 'time', rowId: 'r2', fields: { hours: 2 }, anchor: null, expected: { kind: 'absent' }, operationId: 'b1' }),
    ]);
    expect(both.map((r) => r.kind)).toEqual(['written', 'written']);
    const same = await Promise.all([
      a.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n1', target: { kind: 'case' }, body: 'one' }),
      b.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n2', target: { kind: 'case' }, body: 'two' }),
    ]);
    expect(same.map((r) => r.kind)).toEqual(['written', 'written']);
    const note = written(same[0]!);
    const deletes = await Promise.all([
      a.deleteNote({ caseId: CASE, id: note.value.id, expected: { kind: 'match', version: note.version }, operationId: 'd1' }),
      b.deleteNote({ caseId: CASE, id: note.value.id, expected: { kind: 'match', version: note.version }, operationId: 'd2' }),
    ]);
    expect(deletes.map((r) => r.kind).sort()).toEqual(['gone', 'written']);
    expect((await a.notesFor({ caseId: CASE, target: null })).map((n) => n.body)).toEqual(['two']);
  });

  it('refuses a writer whose batch lands after a competing writer committed between its read and its batch', async () => {
    const { make, db } = setup(), b = make();
    const first = written(await b.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'seed' }));
    let competing: C.Written<C.AddResult> | null = null;
    const a = make({ fault: { beforeBatch: async () => { competing = await b.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 3 }, anchor: null, expected: { kind: 'match', version: first.version }, operationId: 'b-edit' }); } } });
    expect(await a.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 2 }, anchor: null, expected: { kind: 'match', version: first.version }, operationId: 'a-edit' })).toEqual({ kind: 'stale' });
    expect(competing!.kind).toBe('written');
    expect((await b.listRows({ caseId: CASE, store: 'time' })).map((r) => r.fields)).toEqual([{ hours: 3 }]);
    expect(db.prepare("SELECT count(*) AS n FROM uw_operation WHERE operation_id = 'a-edit'").get()).toEqual({ n: 0 });
    // A writer of another row in the same case is retried against the new revision and succeeds.
    const c = make({ fault: { beforeBatch: async () => { await b.putRow({ caseId: CASE, store: 'time', rowId: 'r9', fields: { hours: 9 }, anchor: null, expected: { kind: 'absent' }, operationId: 'b-other' }); } } });
    expect((await c.putRow({ caseId: CASE, store: 'time', rowId: 'r2', fields: { hours: 2 }, anchor: null, expected: { kind: 'absent' }, operationId: 'c-new' })).kind).toBe('written');
    // A snapshot whose case changed before its batch is refused, never stored against the old revision.
    const work = make(), revision = d1WorkRevision({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS } });
    const saved = await work.exportAll({ caseId: CASE }), at = await revision({ caseId: CASE });
    const racing = make({ fault: { beforeBatch: async () => { await b.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'b-note', target: { kind: 'case' }, body: 'Racing' }); } } });
    await expect(racing.snapshots.put({ caseId: CASE, snapshot: saved, revision: at })).rejects.toMatchObject({ code: 'snapshot-failed' });
    expect(db.prepare('SELECT count(*) AS n FROM uw_snapshot').get()).toEqual({ n: 0 });
  });

  it('replays the same operation without a second write, and refuses a reused id with another request or principal', async () => {
    const { make, auth, count, audit } = setup(), work = make();
    auth.grant('other', CASE, 'editor');
    const first = written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'note-1', target: { kind: 'case' }, body: 'Same' }));
    expect(await make().addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'note-1', target: { kind: 'case' }, body: 'Same' })).toEqual(first);
    expect(count('uw_note')).toBe(1);
    await expect(work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'note-1', target: { kind: 'case' }, body: 'Different' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(make({ subject: 'other' }).addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'note-1', target: { kind: 'case' }, body: 'Same' })).rejects.toMatchObject({ code: 'invalid' });
    // The same operation id on another case is another operation.
    written(await work.addNote({ caseId: OTHER_CASE, expected: { kind: 'absent' }, operationId: 'note-1', target: { kind: 'case' }, body: 'Same' }));
    expect([...audit.events.values()].filter((e) => e.outcome === 'succeeded').length).toBe(2);
  });

  it('decides a failed batch from durable state: lost acknowledgement, failure before commit and unknown outcome', async () => {
    const { make, count, audit } = setup();
    const lost = written(await make({ fault: { batchAfterCommit: true } }).putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'lost' }));
    expect(count('uw_register_row')).toBe(1);
    expect([...audit.events.values()].some((e) => e.version === lost.version)).toBe(true);
    await expect(make({ fault: { batchBefore: true } }).putRow({ caseId: CASE, store: 'time', rowId: 'r2', fields: { hours: 2 }, anchor: null, expected: { kind: 'absent' }, operationId: 'before' })).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true, outcome: 'not-written' });
    expect(count('uw_register_row')).toBe(1);
    await expect(make({ fault: { batchAfterCommit: true, readsAfterBatchFailure: true } }).putRow({ caseId: CASE, store: 'time', rowId: 'r3', fields: { hours: 3 }, anchor: null, expected: { kind: 'absent' }, operationId: 'unknown' })).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true, outcome: 'unknown' });
    // The unknown outcome had in fact committed; the retry finds it and appends its event once.
    const retried = written(await make().putRow({ caseId: CASE, store: 'time', rowId: 'r3', fields: { hours: 3 }, anchor: null, expected: { kind: 'absent' }, operationId: 'unknown' }));
    expect(count('uw_register_row')).toBe(2);
    expect([...audit.events.values()].filter((e) => e.version === retried.version).length).toBe(1);
  });

  it('keeps a write whose audit acknowledgement was lost and acknowledges the identical event on retry', async () => {
    // The append-and-replay path: a sink without atomic audit (an atomic sink fails the batch instead, below).
    const { make, audit, db } = setup(), work = make({ audit: appendOnly(audit.sink) });
    audit.state.failAfterStore = true;
    await expect(work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op' })).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'written-unaudited', retryable: true });
    expect(db.prepare('SELECT audited_at FROM uw_operation').get()).toEqual({ audited_at: null });
    const again = written(await work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op' }));
    expect(audit.events.size).toBe(1);
    expect([...audit.events.values()][0]).toMatchObject({ action: 'user-work.row-put', outcome: 'succeeded', version: again.version, object: { kind: 'case', id: CASE, caseId: CASE } });
    expect(db.prepare('SELECT audited_at FROM uw_operation').get()).toEqual({ audited_at: NOW().toISOString() });
    expect(() => db.prepare('UPDATE uw_operation SET audited_at = NULL').run()).toThrow(/recorded once/);
    expect(() => db.prepare("UPDATE uw_operation SET result_json = '{}'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM uw_operation').run()).toThrow(/cannot be deleted/);
  });

  it('persists work, versions and the operation ledger across a restart of the database and adapter', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'grs117-')); temp.push(dir);
    const file = path.join(dir, 'user-work.sqlite');
    const first = database(file); bind(first);
    const before = setup({ db: first });
    const note = written(await before.make().addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'note', target: { kind: 'case' }, body: 'Survives restart' }));
    await before.make().defineTable({ definition: costs });
    first.close();
    const reopened = database(file, false), after = setup({ db: reopened }), work = after.make();
    expect(await work.notesFor({ caseId: CASE, target: null })).toEqual([{ ...note.value, version: note.version }]);
    expect(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'note', target: { kind: 'case' }, body: 'Survives restart' })).toEqual(note);
    expect((await work.tables()).map((t) => t.name)).toContain('costs');
    expect(await work.deleteNote({ caseId: CASE, id: note.value.id, expected: { kind: 'match', version: id('row-version', 'stale-token') }, operationId: 'stale' })).toEqual({ kind: 'stale' });
    reopened.close();
  });
});

describe('stable anchors across results versions and withdrawal', () => {
  it('follows content, not a reused ref, and keeps changed, removed and ambiguous targets unresolved', async () => {
    const { make } = setup(), work = make();
    const anchor = await work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-001' });
    expect(anchor).toEqual({ caseId: CASE, resultsVersion: RV1, refAtCreation: 'D-001', sha256: SHA_A });
    written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n-a', target: { kind: 'document', anchor }, body: 'About content A' }));
    const moved = await work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-002' });
    written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n-b', target: { kind: 'document', anchor: moved }, body: 'About content B' }));
    const unhashed = await work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-003' });
    written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n-c', target: { kind: 'document', anchor: unhashed }, body: 'No original' }));
    // RV2 reused D-001 for content B: the note follows content A to D-009 and never moves to the reused ref.
    expect(await work.resolve({ anchor, into: { caseId: CASE, resultsVersion: RV2 } })).toEqual({ status: 'exact', refs: ['D-009'] });
    expect(await work.resolve({ anchor: { ...anchor, sha256: SHA_C }, into: { caseId: CASE, resultsVersion: RV2 } })).toEqual({ status: 'ambiguous', refs: ['D-010', 'D-011'] });
    expect(await work.resolve({ anchor: { ...anchor, sha256: 'f'.repeat(64) as C.Sha256 }, into: { caseId: CASE, resultsVersion: RV2 } })).toEqual({ status: 'missing', refs: [] });
    expect(await work.resolve({ anchor: unhashed, into: { caseId: CASE, resultsVersion: RV2 } })).toEqual({ status: 'unanchored', refs: [] });
    const summary = await work.summary({ caseId: CASE, resultsVersion: RV2 });
    expect(summary).toMatchObject({ total: 3, exact: 2, unanchored: 1, byRef: [{ ref: 'D-009', n: 1, status: 'exact' }, { ref: 'D-001', n: 1, status: 'exact' }] });
    expect(summary.byRef.find((r) => r.ref === 'D-001')!.status).toBe('exact'); // content B moved to D-001 in RV2
    expect(summary.detached.map((n) => n.body)).toEqual(['No original']);
    // An anchor whose digest is not the content its ref had in that version is refused, never stored.
    await expect(work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'forged', target: { kind: 'document', anchor: { ...anchor, sha256: SHA_B } }, body: 'Forged' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'cross', target: { kind: 'document', anchor: { ...anchor, caseId: OTHER_CASE } }, body: 'Cross case' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(work.resolve({ anchor, into: { caseId: OTHER_CASE, resultsVersion: RV2 } })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps Notes and registers readable and writable at case level after results are withdrawn', async () => {
    const { make, reader } = setup(), work = make();
    const anchor = await work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-001' });
    const note = written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n', target: { kind: 'document', anchor }, body: 'Before withdrawal' }));
    written(await work.putRow({ caseId: CASE, store: 'time', rowId: null, fields: { hours: 1 }, anchor, expected: { kind: 'absent' }, operationId: 'r' }));
    reader.state.published = null; reader.state.withdrawn.add(RV1);
    expect((await work.notesFor({ caseId: CASE, target: null })).map((n) => n.id)).toEqual([note.value.id]);
    expect(await work.summary({ caseId: CASE, resultsVersion: null })).toMatchObject({ total: 1, unanchored: 1, detached: [{ id: note.value.id, status: 'unanchored' }] });
    expect((await work.listRows({ caseId: CASE, store: 'time' }))[0]!.anchor).toEqual(anchor);
    written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n2', target: { kind: 'case' }, body: 'After withdrawal' }));
    await expect(work.resolve({ anchor, into: { caseId: CASE, resultsVersion: RV1 } })).resolves.toEqual({ status: 'here', refs: ['D-001'] });
    await expect(work.summary({ caseId: CASE, resultsVersion: RV1 })).resolves.toMatchObject({ total: 2 });
    await expect(work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-001' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('export, snapshot and restore', () => {
  async function populate(work: C.AsyncUserWork) {
    const anchor = await work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-001' });
    written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'p-note', target: { kind: 'document', anchor }, body: 'Anchored' }));
    written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'p-analysis', target: { kind: 'analysis', resultsVersion: RV1, section: 'overview' }, body: 'Analysis' }));
    written(await work.putSeedOverlay({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'p-overlay', overlay: { caseId: CASE, datasetKey: 'parties', seedId: 'p1', baseSeedSha256: 'd'.repeat(64), fields: { name: 'Edited' } } }));
    written(await work.putRow({ caseId: CASE, store: 'selections', rowId: null, fields: { selected: true }, anchor, expected: { kind: 'absent' }, operationId: 'p-row' }));
    await work.defineTable({ definition: costs });
    written(await work.putTableRow({ caseId: CASE, table: 'costs', owner: 'costs-owner', row: { case_id: CASE, id: 'c1', amount: 100 }, expected: { kind: 'absent' }, operationId: 'p-cost' }));
    return anchor;
  }

  it('round-trips every category and anchor into a fresh database behind an audited pre-restore snapshot', async () => {
    const source = setup(), work = source.make(), anchor = await populate(work);
    const saved = await work.exportAll({ caseId: CASE });
    expect(saved.tables.map((t) => [t.name, t.rows.length])).toEqual([['note', 2], ['seed_overlay', 1], ['register_row', 1], ['costs', 1]]);
    const target = setup(), fresh = target.make(), revision = d1WorkRevision({ db: d1(target.db), config: { clientId: CLIENT, limits: LIMITS } });
    written(await fresh.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'existing', target: { kind: 'case' }, body: 'Kept in the pre-restore snapshot' }));
    const current = await fresh.exportAll({ caseId: CASE }), expectedRevision = await revision({ caseId: CASE });
    const preRestore = await fresh.snapshots.put({ caseId: CASE, snapshot: current, revision: expectedRevision });
    const restored = written(await fresh.importAll({ caseId: CASE, snapshot: saved, expectedRevision, preRestore, operationId: 'restore' }));
    expect(restored.value).toMatchObject({ tables: 4, rows: 5, cases: [CASE] });
    const { exportedAt: _a, ...after } = await fresh.exportAll({ caseId: CASE }), { exportedAt: _b, ...before } = saved;
    expect(after).toEqual(before);
    expect((await fresh.notesFor({ caseId: CASE, target: { kind: 'document', anchor } })).map((n) => n.body)).toEqual(['Anchored']);
    expect((await fresh.listRows({ caseId: CASE, store: 'selections' }))[0]!.anchor).toEqual(anchor);
    expect((await fresh.listTableRows({ caseId: CASE, table: 'costs' }))[0]!.cells.amount).toBe(100);
    expect(await fresh.snapshots.get({ caseId: CASE, id: preRestore })).toEqual(current);
    expect(target.db.prepare('SELECT audited_at FROM uw_table_definition').get()).toEqual({ audited_at: NOW().toISOString() });
    expect(() => target.db.prepare('DELETE FROM uw_snapshot').run()).toThrow(/cannot be deleted/);
    expect(() => target.db.prepare('DELETE FROM uw_table_definition').run()).toThrow(/cannot be deleted/);
  });

  it('guards restore by revision and receipt, and keeps prior work when the restore audit is not acknowledged', async () => {
    // The append-and-replay path: a sink without atomic audit (an atomic sink fails the batch instead).
    const { make: plain, db, audit } = setup(), make = () => plain({ audit: appendOnly(audit.sink) }), work = make(), revision = d1WorkRevision({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS } });
    await populate(plain()); // notes need the atomic sink
    const saved = await work.exportAll({ caseId: CASE }), at = await revision({ caseId: CASE });
    await expect(work.snapshots.put({ caseId: CASE, snapshot: { ...saved, tables: saved.tables.slice(1) }, revision: at })).rejects.toMatchObject({ code: 'snapshot-failed' });
    const receipt = await work.snapshots.put({ caseId: CASE, snapshot: saved, revision: at });
    await expect(make().snapshots.get({ caseId: OTHER_CASE, id: receipt })).rejects.toMatchObject({ code: 'forbidden' });
    written(await work.registers.open({ caseId: CASE, store: 'time' }).add({ fields: { hours: 1 }, operationId: 'intervening' }));
    expect(await work.importAll({ caseId: CASE, expectedRevision: at, operationId: 'stale-restore', snapshot: saved, preRestore: receipt })).toEqual({ kind: 'stale' });
    const now = await revision({ caseId: CASE });
    await expect(work.importAll({ caseId: CASE, expectedRevision: now, operationId: 'old-receipt', snapshot: saved, preRestore: receipt })).rejects.toMatchObject({ code: 'snapshot-failed' });
    const current = await work.exportAll({ caseId: CASE });
    // A snapshot whose audit event was never acknowledged returns no receipt and cannot guard a restore.
    audit.state.down = true;
    await expect(work.snapshots.put({ caseId: CASE, snapshot: current, revision: now })).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'written-unaudited' });
    audit.state.down = false;
    const unaudited = (db.prepare('SELECT snapshot_id FROM uw_snapshot WHERE audited_at IS NULL').get() as { snapshot_id: string }).snapshot_id;
    await expect(work.importAll({ caseId: CASE, expectedRevision: now, operationId: 'unaudited', snapshot: saved, preRestore: id('snapshot', unaudited) })).rejects.toMatchObject({ code: 'snapshot-failed' });
    const preRestore = await work.snapshots.put({ caseId: CASE, snapshot: current, revision: now });
    const empty = { ...saved, tables: [] };
    audit.state.down = true;
    await expect(work.importAll({ caseId: CASE, expectedRevision: now, operationId: 'restore', snapshot: empty, preRestore })).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'written-unaudited' });
    // The restore is durable but unacknowledged; the prior work stays in the pre-restore snapshot, nothing is lost.
    audit.state.down = false;
    expect(await work.snapshots.get({ caseId: CASE, id: preRestore })).toEqual(current);
    written(await work.importAll({ caseId: CASE, expectedRevision: now, operationId: 'restore', snapshot: empty, preRestore }));
    expect((await work.exportAll({ caseId: CASE })).tables.every((t) => t.rows.length === 0)).toBe(true);
    expect([...audit.events.values()].filter((e) => e.action === 'user-work.restore').length).toBe(1);
  });

  it('refuses keys held by another case and malformed snapshot rows', async () => {
    const { make, db } = setup(), work = make();
    await work.defineTable({ definition: costs });
    written(await work.putTableRow({ caseId: CASE, table: 'costs', owner: 'costs-owner', row: { case_id: CASE, id: 'shared', amount: 1 }, expected: { kind: 'absent' }, operationId: 'a' }));
    await expect(work.putTableRow({ caseId: OTHER_CASE, table: 'costs', owner: 'costs-owner', row: { case_id: OTHER_CASE, id: 'shared', amount: 2 }, expected: { kind: 'absent' }, operationId: 'b' })).rejects.toMatchObject({ code: 'restore-key-collision' });
    // A competing case takes the key between the read and the batch: the batch fails and is reported as a collision.
    const racing = make({ fault: { beforeBatch: async () => { db.prepare("INSERT INTO uw_table_row (table_name, row_key, case_id, cells_json, version) VALUES ('costs', '[\"race\"]', ?, '{}', 'v')").run(CASE); } } });
    await expect(racing.putTableRow({ caseId: OTHER_CASE, table: 'costs', owner: 'costs-owner', row: { case_id: OTHER_CASE, id: 'race', amount: 2 }, expected: { kind: 'absent' }, operationId: 'c' })).rejects.toMatchObject({ code: 'restore-key-collision' });
    expect(db.prepare('SELECT case_id FROM uw_table_row WHERE row_key = ?').get('["race"]')).toEqual({ case_id: CASE });
    const other = await work.exportAll({ caseId: OTHER_CASE }), revision = d1WorkRevision({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS } });
    const at = await revision({ caseId: OTHER_CASE }), receipt = await work.snapshots.put({ caseId: OTHER_CASE, snapshot: other, revision: at });
    const stolen = { ...other, tables: other.tables.map((t) => t.name === 'costs' ? { ...t, rows: [{ case_id: OTHER_CASE, id: 'shared', amount: 9 }] } : t) };
    await expect(work.importAll({ caseId: OTHER_CASE, snapshot: stolen, expectedRevision: at, preRestore: receipt, operationId: 'steal' })).rejects.toMatchObject({ code: 'restore-key-collision' });
    const forgedNote = { ...other, tables: other.tables.map((t) => t.name === 'note' ? { ...t, rows: [{ case_id: OTHER_CASE, id: 'wrong-id', payload: JSON.stringify({ id: 'n1', body: 'x', createdAt: NOW().toISOString(), intact: true, candidates: [], status: 'here', target: { kind: 'case' } }) }] } : t) };
    await expect(work.importAll({ caseId: OTHER_CASE, snapshot: forgedNote, expectedRevision: at, preRestore: receipt, operationId: 'forged' })).rejects.toMatchObject({ code: 'restore-key' });
    expect(await make().listTableRows({ caseId: OTHER_CASE, table: 'costs' })).toEqual([]);
  });

  it('marks a stored row whose content no longer matches its digest as not intact', async () => {
    const { make, db } = setup(), work = make();
    written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n', target: { kind: 'case' }, body: 'Original' }));
    db.prepare("UPDATE uw_note SET body = 'Tampered'").run();
    expect((await work.notesFor({ caseId: CASE, target: null }))[0]).toMatchObject({ body: 'Tampered', intact: false });
  });
});

describe('batch bounds', () => {
  it('refuses a restore larger than one guarded batch whole, never in parts', async () => {
    const { make, db, auth, audit, reader } = setup(), work = make();
    for (let i = 0; i < 6; i++) written(await work.putRow({ caseId: CASE, store: 'time', rowId: `r${i}`, fields: { i }, anchor: null, expected: { kind: 'absent' }, operationId: `r${i}` }));
    const saved = await work.exportAll({ caseId: CASE }), revision = d1WorkRevision({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS } });
    const at = await revision({ caseId: CASE }), receipt = await work.snapshots.put({ caseId: CASE, snapshot: saved, revision: at });
    const small = createD1UserWork({ db: d1(db), config: { clientId: CLIENT, limits: { ...LIMITS, maxStatementsPerBatch: 8 } }, identity: auth.identity(), audit: audit.sink, store: reader.reader, now: NOW });
    await expect(small.importAll({ caseId: CASE, snapshot: saved, expectedRevision: at, preRestore: receipt, operationId: 'too-big' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await revision({ caseId: CASE })).toBe(at);
    expect((await work.listRows({ caseId: CASE, store: 'time' })).length).toBe(6);
  });
});

describe('the GRS-116 audit sink as the injected AuditSink', () => {
  it('acknowledges user-work events through requestAuditSink over the same client database', async () => {
    const db = database(); bind(db);
    db.exec(readFileSync(new URL('../../../src/lib/audit/migrations/0001_native_audit.sql', import.meta.url), 'utf8'));
    const config = auditConfig({ clientId: CLIENT, trustedIssuers: [ISSUER], limits: { maxEventBytes: 2048, maxRows: 100, maxReadRows: 100, maxDenialRows: 10, maxDenialsPerActor: 5, maxPageRows: 50, maxPagesPerRequest: 5 } });
    await provisionAuditBinding({ db: d1(db), config, now: NOW });
    const { auth, reader } = setup({ db });
    const identity = auth.identity();
    const binding = d1(db);
    const sink = requestAuditSink({ db: binding, config, requester: { kind: 'verified', principal: identity.kind === 'verified' ? identity.principal : null!, sessionId: identity.sessionId! }, now: NOW });
    const work = createD1UserWork({ db: binding, config: { clientId: CLIENT, limits: LIMITS }, identity, audit: sink, store: reader.reader, now: NOW, tableDefinitions });
    const note = written(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n', target: { kind: 'case' }, body: 'Audited' }));
    await work.defineTable({ definition: costs });
    const rows = db.prepare('SELECT action, case_id, outcome FROM native_audit_events ORDER BY seq').all();
    expect(rows).toEqual([{ action: 'user-work.note-add', case_id: CASE, outcome: 'succeeded' }, { action: 'user-work.table-define', case_id: null, outcome: 'succeeded' }]);
    expect(await work.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'n', target: { kind: 'case' }, body: 'Audited' })).toEqual(note);
  });
});
