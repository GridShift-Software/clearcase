// GRS-266: every change audits inside its own batch when the sink is atomic, the table and register reads are one
// query each with the binding, and a table row can wait for an object before it commits.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/index.ts';
import { auditConfig, requestAuditSink } from '../../../src/lib/audit/index.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { auditLog, authority, bind, CASE, caseReader, CLIENT, d1, database, ISSUER, LIMITS, OTHER_CLIENT, RV1 } from './world.ts';
import { counters, countedD1, measure } from '../budget/harness.ts';

const NOW = () => new Date('2026-10-28T00:00:00.000Z');
const MARKS = 'bundles_schedule_mark';

function setup(o: { db?: DatabaseSync; audit?: (db: ReturnType<typeof d1>, identity: C.Identity) => C.AuditSink } = {}) {
  const db = o.db ?? (() => { const d = database(); bind(d); return d; })();
  db.exec(readFileSync('src/lib/user-work/hosted/migrations/0002_bundle_tables.sql', 'utf8'));
  const auth = authority(); auth.grant('editor', CASE, 'editor');
  const audit = auditLog(), raw = d1(db), c = counters();
  let batches = 0;
  const batch = raw.batch.bind(raw);
  raw.batch = async (s) => { batches++; return batch(s); };
  const binding = countedD1(raw, c), identity = auth.identity();
  const work = createD1UserWork({ db: binding, config: { clientId: CLIENT, limits: LIMITS }, identity, audit: o.audit ? o.audit(binding, identity) : audit.sink,
    store: caseReader({ published: RV1, versions: {} }).reader, now: NOW });
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return { db, auth, audit, work, c, batches: () => batches, count };
}
const mark = (locator: string) => ({ case_id: CASE, locator, selected: 1, co: 'C' });

describe('every change audits in its batch', () => {
  it('commits a register row, a table row and a delete with their audit events in one batch each, never appending after', async () => {
    const w = setup();
    try {
      const row = await w.work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'row' });
      expect(row.kind).toBe('written');
      await w.work.putTableRow({ caseId: CASE, table: MARKS, owner: 'GRS-19', row: mark('a'), expected: { kind: 'absent' }, operationId: 'mark' });
      const current = (await w.work.listRows({ caseId: CASE, store: 'time' }))[0]!;
      await w.work.deleteRow({ caseId: CASE, store: 'time', rowId: 'r1', expected: { kind: 'match', version: current.version }, operationId: 'delete' });
      expect(w.batches()).toBe(3);
      expect(w.audit.state.appends).toBe(0);
      expect([...w.audit.events.values()].map((e) => e.action)).toEqual(['user-work.row-put', 'user-work.table-row-put', 'user-work.row-delete']);
      expect(w.count('SELECT count(*) AS n FROM uw_operation WHERE audited_at IS NULL')).toBe(0);
    } finally { w.db.close(); }
  });

  it('writes nothing when the atomic audit is refused, and the same operation id saves once the audit is back', async () => {
    const w = setup();
    try {
      w.audit.state.down = true;
      await expect(w.work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op' }))
        .rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'not-written' });
      await expect(w.work.putTableRow({ caseId: CASE, table: MARKS, owner: 'GRS-19', row: mark('a'), expected: { kind: 'absent' }, operationId: 'mark' }))
        .rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'not-written' });
      expect([w.count('SELECT count(*) AS n FROM uw_register_row'), w.count('SELECT count(*) AS n FROM uw_table_row'), w.count('SELECT count(*) AS n FROM uw_operation')]).toEqual([0, 0, 0]);
      w.audit.state.down = false;
      expect((await w.work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op' })).kind).toBe('written');
      expect(w.audit.events.size).toBe(1);
    } finally { w.db.close(); }
  });

  it('over the GRS-116 request sink, a full audit log fails the change batch: the row is not written', async () => {
    const db = database(); bind(db);
    db.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
    const config = auditConfig({ clientId: CLIENT, trustedIssuers: [ISSUER], limits: { maxEventBytes: 2048, maxRows: 1, maxReadRows: 100, maxDenialRows: 10, maxDenialsPerActor: 5, maxPageRows: 50, maxPagesPerRequest: 5 } });
    await provisionAuditBinding({ db: d1(db), config, now: NOW });
    // The sink and the work share the request's one binding, as hostedServices composes them.
    const w = setup({ db, audit: (binding, identity) => requestAuditSink({ db: binding, config, requester: { kind: 'verified', principal: identity.kind === 'verified' ? identity.principal : null!, sessionId: identity.sessionId! }, now: NOW }) });
    try {
      expect((await w.work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'first' })).kind).toBe('written');
      expect(db.prepare('SELECT action FROM native_audit_events').all()).toEqual([{ action: 'user-work.row-put' }]);
      await expect(w.work.putRow({ caseId: CASE, store: 'time', rowId: 'r2', fields: { hours: 2 }, anchor: null, expected: { kind: 'absent' }, operationId: 'second' }))
        .rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'not-written' });
      expect(w.count('SELECT count(*) AS n FROM uw_register_row')).toBe(1);
      expect(w.batches()).toBe(2);
    } finally { db.close(); }
  });
});

describe('table and register reads are one query with the binding', () => {
  it('reads a defined table and a register in one D1 call each, and refuses an unbound, foreign or other-version store', async () => {
    const w = setup();
    try {
      await w.work.putTableRow({ caseId: CASE, table: MARKS, owner: 'GRS-19', row: mark('b'), expected: { kind: 'absent' }, operationId: 'b' });
      await w.work.putTableRow({ caseId: CASE, table: MARKS, owner: 'GRS-19', row: mark('a'), expected: { kind: 'absent' }, operationId: 'a' });
      const table = await measure(w.c, () => w.work.listTableRows({ caseId: CASE, table: MARKS }));
      expect(table.value?.map((r) => r.cells.locator)).toEqual(['a', 'b']);
      expect(table.counts.d1).toBe(1);
      const empty = await measure(w.c, () => w.work.listRows({ caseId: CASE, store: 'time' }));
      expect(empty.value).toEqual([]); expect(empty.counts.d1).toBe(1);
      await expect(w.work.listTableRows({ caseId: CASE, table: 'undefined_table' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(w.work.listTableRows({ caseId: CASE, table: 'note' })).rejects.toMatchObject({ code: 'table-built-in' });
    } finally { w.db.close(); }
    for (const prepare of [(d: DatabaseSync) => void d, (d: DatabaseSync) => bind(d, OTHER_CLIENT), (d: DatabaseSync) => bind(d, CLIENT, 2)]) {
      const db = database(); prepare(db);
      db.exec('CREATE TABLE IF NOT EXISTS uw_batch_guard (token TEXT NOT NULL)');
      const other = setup({ db });
      try {
        await expect(other.work.listTableRows({ caseId: CASE, table: MARKS })).rejects.toMatchObject({ code: 'storage-unavailable' });
        await expect(other.work.listRows({ caseId: CASE, store: 'time' })).rejects.toMatchObject({ code: 'storage-unavailable' });
      } finally { db.close(); }
    }
  });
});

describe('a table row that waits for an object', () => {
  it('commits only after commitAfter is fulfilled, and a rejection writes nothing and rethrows its reason', async () => {
    const w = setup();
    try {
      let release!: () => void;
      const object = new Promise<void>((r) => { release = r; });
      const saving = w.work.putTableRow({ caseId: CASE, table: MARKS, owner: 'GRS-19', row: mark('a'), expected: { kind: 'absent' }, operationId: 'held', commitAfter: object });
      await new Promise((r) => setTimeout(r, 20));
      expect([w.count('SELECT count(*) AS n FROM uw_table_row'), w.batches()]).toEqual([0, 0]);
      release();
      expect((await saving).kind).toBe('written');
      expect(w.count('SELECT count(*) AS n FROM uw_table_row')).toBe(1);
      const reason = new Error('object not stored');
      await expect(w.work.putTableRow({ caseId: CASE, table: MARKS, owner: 'GRS-19', row: mark('b'), expected: { kind: 'absent' }, operationId: 'refused', commitAfter: Promise.reject(reason) })).rejects.toBe(reason);
      expect([w.count('SELECT count(*) AS n FROM uw_table_row'), w.count('SELECT count(*) AS n FROM uw_operation'), w.batches()]).toEqual([1, 1, 1]);
    } finally { w.db.close(); }
  });

  // #194 review: the object write can outlast the authority checked before it. A grant or session lost while the row
  // waits refuses the row (`forbidden`, or `invalid-session` as every user-work call refuses a revoked session), with
  // nothing committed and no audit event.
  for (const [lost, code, revoke] of [
    ['the case grant is removed', 'forbidden', (w: ReturnType<typeof setup>) => w.auth.grant('editor', CASE, null)],
    ['the session is revoked', 'invalid-session', (w: ReturnType<typeof setup>) => w.auth.revoke('session-editor')],
  ] as const) {
    it(`refuses the row when ${lost} while it waits for the object`, async () => {
      const w = setup();
      try {
        let release!: () => void;
        const object = new Promise<void>((r) => { release = r; });
        const saving = w.work.putTableRow({ caseId: CASE, table: MARKS, owner: 'GRS-19', row: mark('a'), expected: { kind: 'absent' }, operationId: 'held', commitAfter: object });
        saving.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 20));
        revoke(w);
        release();
        await expect(saving).rejects.toMatchObject({ code });
        expect([w.count('SELECT count(*) AS n FROM uw_table_row'), w.count('SELECT count(*) AS n FROM uw_operation'), w.batches()]).toEqual([0, 0, 0]);
        expect([...w.audit.events.values()].filter((e) => e.outcome === 'succeeded')).toEqual([]);
      } finally { w.db.close(); }
    });
  }
});
