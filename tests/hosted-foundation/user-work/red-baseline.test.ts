// RED-first adverse examples for GRS-117, written against the naive skeleton before the implementation: a competing
// writer holding the same expected version must be refused (no lost update), and a write whose audit event is not
// acknowledged must not report success yet must keep the data for a same-operation retry.
import { describe, expect, it } from 'vitest';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { auditLog, authority, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, RV1 } from './world.ts';

function setup() {
  const db = database(); bind(db);
  const auth = authority(); auth.grant('editor', CASE, 'editor');
  const audit = auditLog();
  const { reader } = caseReader({ published: RV1, versions: { [RV1]: [] } });
  const make = (fault = {}) => createD1UserWork({ db: d1(db, fault), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(), audit: audit.sink, store: reader, now: () => new Date('2026-10-25T00:00:00.000Z') });
  return { db, auth, audit, make };
}

describe('GRS-117 RED baseline', () => {
  it('refuses the second of two writers holding the same expected version', async () => {
    const { make } = setup(), a = make(), b = make();
    const first = await a.putRow({ caseId: CASE, store: 'time', rowId: 'row-1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op-1' });
    if (first.kind !== 'written') throw new Error(first.kind);
    const results = await Promise.all([
      a.putRow({ caseId: CASE, store: 'time', rowId: 'row-1', fields: { hours: 2 }, anchor: null, expected: { kind: 'match', version: first.version }, operationId: 'op-2' }),
      b.putRow({ caseId: CASE, store: 'time', rowId: 'row-1', fields: { hours: 3 }, anchor: null, expected: { kind: 'match', version: first.version }, operationId: 'op-3' }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(['stale', 'written']);
  });

  it('gives no success before the audit acknowledgement and keeps the write for a same-operation retry', async () => {
    const { make, audit } = setup(), a = make();
    audit.state.down = true;
    await expect(a.putRow({ caseId: CASE, store: 'time', rowId: 'row-1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op-1' })).rejects.toMatchObject({ code: 'audit-unavailable', retryable: true });
    audit.state.down = false;
    const retried = await a.putRow({ caseId: CASE, store: 'time', rowId: 'row-1', fields: { hours: 1 }, anchor: null, expected: { kind: 'absent' }, operationId: 'op-1' });
    expect(retried.kind).toBe('written');
    expect(audit.events.size).toBe(1);
  });
});
