// GRS-266 (from the #191 review, High 2): every user-work write commits its change and its audit event in one D1
// batch. Over the real GRS-116 request sink, a full audit log makes the event's insert fail inside the change batch:
// nothing of the change is committed. Retrying the same operationId once the log has room commits both, and a further
// replay returns the stored result with no second event.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { createD1UserWork, d1WorkRevision } from '../../../src/lib/user-work/hosted/index.ts';
import { auditConfig, requestAuditSink } from '../../../src/lib/audit/index.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { authority, bind, CASE, caseReader, CLIENT, d1, database, ISSUER, LIMITS, RV1, SHA_A } from './world.ts';

const NOW = () => new Date('2026-10-28T00:00:00.000Z');
const MARKS = 'bundles_schedule_mark', OWNER = 'GRS-19', ROOM = 1000;
const SEED = 'd'.repeat(64);
const config = (maxRows: number) => auditConfig({ clientId: CLIENT, trustedIssuers: [ISSUER], limits: { maxEventBytes: 4096, maxRows, maxReadRows: 100, maxDenialRows: 10, maxDenialsPerActor: 5, maxPageRows: 50, maxPagesPerRequest: 5 } });

async function world() {
  const db = database(); bind(db);
  db.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
  db.exec(readFileSync('src/lib/user-work/hosted/migrations/0002_bundle_tables.sql', 'utf8'));
  const binding = d1(db);
  await provisionAuditBinding({ db: binding, config: config(ROOM), now: NOW });
  const auth = authority(); auth.grant('editor', CASE, 'editor');
  const identity = auth.identity();
  const reader = caseReader({ published: RV1, versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }] }, seeds: { [RV1]: [{ datasetKey: 'parties', seedId: 'p1', seedSha256: SEED, record: {} }] } });
  const requester = { kind: 'verified' as const, principal: identity.kind === 'verified' ? identity.principal : null!, sessionId: identity.sessionId! };
  /** The request's work over a log that holds `maxRows` events: the sink and the work share one binding. */
  const work = (maxRows = ROOM) => createD1UserWork({ db: binding, config: { clientId: CLIENT, limits: LIMITS }, identity,
    audit: requestAuditSink({ db: binding, config: config(maxRows), requester, now: NOW }), store: reader.reader, now: NOW });
  const events = () => (db.prepare('SELECT count(*) AS n FROM native_audit_events').get() as { n: number }).n;
  const actions = () => (db.prepare('SELECT action FROM native_audit_events ORDER BY rowid').all() as { action: string }[]).map((r) => r.action);
  const state = () => ['uw_case', 'uw_operation', 'uw_register_row', 'uw_seed_overlay', 'uw_table_row'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  const revision = d1WorkRevision({ db: binding, config: { clientId: CLIENT, limits: LIMITS } });
  // One unrelated event first, so a full log (maxRows at the event count) is never a zero limit.
  await putRow(work(), 'prime', 'prime');
  return { db, work, events, actions, state, revision: () => revision({ caseId: CASE }) };
}
type World = Awaited<ReturnType<typeof world>>;
type Act = (work: C.AsyncUserWork) => Promise<C.Written<unknown> | 'absent' | { kind: string }>;
const mark = (locator: string) => ({ case_id: CASE, locator, selected: 1, co: 'C' });
const putRow = (work: C.AsyncUserWork, rowId: string, operationId: string) => work.putRow({ caseId: CASE, store: 'time', rowId, fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId });
const putMark = (work: C.AsyncUserWork, locator: string, operationId: string) => work.putTableRow({ caseId: CASE, table: MARKS, owner: OWNER, row: mark(locator), expected: { kind: 'absent' }, operationId });
const versionOf = async (r: Promise<C.Written<unknown> | { kind: string }>) => { const w = await r; if (w.kind !== 'written') throw new Error(`not written: ${w.kind}`); return (w as C.Written<unknown>).version; };

/** Each path: `prepare` makes what the change needs (with room in the log) and returns the change itself. */
const PATHS: { action: string; prepare: (w: World) => Promise<Act> }[] = [
  { action: 'user-work.row-put', prepare: async () => (work) => putRow(work, 'r1', 'op') },
  { action: 'user-work.row-delete', prepare: async (w) => {
    const version = await versionOf(putRow(w.work(), 'r1', 'setup'));
    return (work) => work.deleteRow({ caseId: CASE, store: 'time', rowId: 'r1', expected: { kind: 'match', version }, operationId: 'op' });
  } },
  { action: 'user-work.register-replace', prepare: async (w) => {
    const version = await versionOf(putRow(w.work(), 'r1', 'setup'));
    return (work) => work.registers.open({ caseId: CASE, store: 'time' }).replace({ rowId: 'r1', fields: { hours: 2 }, expected: version, operationId: 'op' });
  } },
  { action: 'user-work.overlay-put', prepare: async () => (work) => work.putSeedOverlay({ caseId: CASE, overlay: { caseId: CASE, datasetKey: 'parties', seedId: 'p1', baseSeedSha256: SEED, fields: { name: 'Synthetic party' } }, expected: { kind: 'absent' }, operationId: 'op' }) },
  { action: 'user-work.seed-remove', prepare: async () => (work) => work.registers.seeds({ caseId: CASE, datasetKey: 'parties', resultsVersion: RV1 }).remove({ seedId: 'p1', expected: id('row-version', `seed:${SEED}`), operationId: 'op' }) },
  { action: 'user-work.table-row-put', prepare: async () => (work) => putMark(work, 'a', 'op') },
  { action: 'user-work.table-rows-put', prepare: async (w) => {
    const expectedRevision = await w.revision();
    return (work) => work.putTableRows({ caseId: CASE, table: MARKS, owner: OWNER, rows: [mark('a'), mark('b')], expectedRevision, operationId: 'op' });
  } },
  { action: 'user-work.table-row-delete', prepare: async (w) => {
    const version = await versionOf(putMark(w.work(), 'a', 'setup'));
    return (work) => work.deleteTableRow({ caseId: CASE, table: MARKS, owner: OWNER, key: { case_id: CASE, locator: 'a' }, expected: { kind: 'match', version }, operationId: 'op' });
  } },
];

describe('a failed audit insert fails the change batch, on every write path', () => {
  for (const path of PATHS) {
    it(`${path.action}: nothing is committed, then a retry commits the change and exactly one event`, async () => {
      const w = await world();
      try {
        const act = await path.prepare(w);
        const before = w.state(), held = w.events();
        // A full log: the sink's insert refuses inside the change's own batch.
        await expect(act(w.work(held))).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'not-written' });
        expect(w.state()).toEqual(before);
        expect(w.events()).toBe(held);
        const result = await act(w.work());
        expect(result).toMatchObject({ kind: 'written' });
        expect(w.events()).toBe(held + 1);
        expect(w.actions().at(-1)).toBe(path.action);
        expect(w.db.prepare("SELECT audited_at FROM uw_operation WHERE operation_id = 'op'").get()).toEqual({ audited_at: NOW().toISOString() });
        expect(w.state()).not.toEqual(before);
        // A replay of the same operation returns the stored result and adds no event.
        expect(await act(w.work())).toEqual(result);
        expect(w.events()).toBe(held + 1);
      } finally { w.db.close(); }
    });
  }
});
