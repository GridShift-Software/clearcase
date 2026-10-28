import { expect, test } from 'vitest';
import { fixture, CASE } from '../hosted-foundation/user-work/helpers';
import { CLIENT, OTHER_CASE, OTHER_CLIENT, LIMITS, d1 } from '../hosted-foundation/user-work/world';
import { createD1UserWork } from '../../src/lib/user-work/hosted';

test('14b combined read preserves row/overlay decoders and insertion order in exactly one fresh D1 read', async () => {
  const f = fixture();
  try {
    const work = f.make();
    for (const rowId of ['second-alphabetically', 'first-alphabetically']) {
      expect((await work.putRow({ caseId: CASE, store: 'filings-register', rowId, anchor: null, fields: { filing: rowId },
        expected: { kind: 'absent' }, operationId: crypto.randomUUID() })).kind).toBe('written');
    }
    expect((await work.putSeedOverlay({ caseId: CASE, overlay: { caseId: CASE, datasetKey: 'filings', seedId: 'seed-one', baseSeedSha256: 'a'.repeat(64), fields: { filing: 'Edited' } },
      expected: { kind: 'absent' }, operationId: crypto.randomUUID() })).kind).toBe('written');
    const expected = { rows: await work.listRows({ caseId: CASE, store: 'filings-register' }), overlays: await work.overlays({ caseId: CASE, datasetKey: 'filings' }) };
    const db = d1(f.db);
    const fresh = createD1UserWork({ db, config: { clientId: CLIENT, limits: LIMITS }, identity: f.auth.identity(), audit: f.audit.sink, store: f.reader.reader, now: () => new Date('2200-01-01T00:00:00Z') });
    expect(await fresh.readViewWork({ caseId: CASE, store: 'filings-register', datasetKey: 'filings' })).toEqual(expected);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]).toMatch(/^SELECT/);
    expect(expected.rows.map((r) => r.rowId)).toEqual(['second-alphabetically', 'first-alphabetically']);
    expect((await fresh.readViewWork({ caseId: CASE, store: 'heads' }))).toEqual({ rows: [], overlays: [] });
    // Integrity evidence is retained by the existing decoder, not silently discarded by the aggregate.
    f.db.exec("UPDATE uw_register_row SET fields_json = '{\"filing\":\"tampered\"}' WHERE row_id = 'first-alphabetically'");
    expect((await fresh.readViewWork({ caseId: CASE, store: 'filings-register' })).rows[1]!.intact).toBe(false);
  } finally { f.db.close(); }
});

test.each(['missing-binding', 'wrong-binding', 'wrong-schema', 'wrong-case', 'revoked'] as const)('14b combined read refuses %s', async (reason) => {
  const f = fixture();
  try {
    if (reason === 'missing-binding') f.db.exec('DELETE FROM uw_binding');
    if (reason === 'wrong-binding') f.db.prepare('UPDATE uw_binding SET client_id = ?').run(OTHER_CLIENT);
    if (reason === 'wrong-schema') f.db.exec('UPDATE uw_binding SET schema_version = 2');
    if (reason === 'revoked') f.auth.revoke('session-editor');
    await expect(f.make().readViewWork({ caseId: reason === 'wrong-case' ? OTHER_CASE : CASE, store: 'heads' })).rejects.toMatchObject({ code: reason === 'wrong-case' ? 'forbidden' : reason === 'revoked' ? 'invalid-session' : 'storage-unavailable' });
  } finally { f.db.close(); }
});
