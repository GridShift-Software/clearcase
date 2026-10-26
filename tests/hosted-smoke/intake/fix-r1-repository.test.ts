// GRS-137 intake fix r1, added with the fix (not RED: it needs `reserveRevision` and the `reserved` state). Unit doubles only.
import { describe, expect, it } from 'vitest';
import { CASE_A, CLIENT, SqliteD1, hex, syntheticPdf } from './doubles.ts';
import { MIGRATIONS, repositoryFor } from './harness.ts';

const AT = '2026-10-24T12:00:00.000Z';
const s = (operationId: string) => ({ clientId: CLIENT, caseId: CASE_A, operationId });
function world() {
  const db = new SqliteD1(MIGRATIONS), repo = repositoryFor(db);
  const declare = (operationId: string, tag = 'x', assetId = `sub-${operationId}`) => {
    const bytes = syntheticPdf(tag);
    return repo.declare({ ...s(operationId), assetId, path: 'a/claim.pdf', filename: 'claim.pdf', mediaType: 'application/pdf', size: bytes.byteLength, sha256: hex(bytes), principal: { issuer: 'https://issuer.test', subject: 'user-a' }, at: AT });
  };
  return { db, repo, declare };
}
const states = (db: SqliteD1) => db.rows<{ operation_id: string; state: string }>('SELECT operation_id, state FROM submissions_upload ORDER BY operation_id');

describe('reserveRevision is the durable precommit; commitRevision marks it final', () => {
  it('reserves once with the same manifest on every retry, keeps the upload pending, then finalizes idempotently', async () => {
    const { db, repo, declare } = world(), op = 'op-reserve-0000000001';
    await declare(op);
    await expect(repo.reserveRevision({ ...s(op), at: AT })).rejects.toMatchObject({ code: 'storage-unavailable' });
    await repo.markStored({ ...s(op), at: AT });
    const m = await repo.reserveRevision({ ...s(op), at: AT });
    expect(await repo.reserveRevision({ ...s(op), at: '2027-01-01T00:00:00.000Z' })).toEqual(m);
    expect(m).toMatchObject({ revisionId: `subrev-${op}`, sequence: 1, finalizedAt: AT });
    expect(states(db)).toEqual([{ operation_id: op, state: 'reserved' }]);
    expect((await repo.upload({ ...s(op) }))?.state).toBe('reserved');
    expect(await repo.commitRevision({ ...s(op), at: AT })).toEqual(m);
    expect(await repo.commitRevision({ ...s(op), at: AT })).toEqual(m);
    expect(states(db)).toEqual([{ operation_id: op, state: 'finalized' }]);
  });

  it('keeps the one-step commit of a stored upload working', async () => {
    const { db, repo, declare } = world(), op = 'op-reserve-0000000002';
    await declare(op);
    await repo.markStored({ ...s(op), at: AT });
    expect((await repo.commitRevision({ ...s(op), at: AT })).sequence).toBe(1);
    expect(states(db)).toEqual([{ operation_id: op, state: 'finalized' }]);
  });

  it('takes the next sequence for a second reservation and never reuses a reserved one', async () => {
    const { repo, declare } = world(), a = 'op-reserve-0000000003', b = 'op-reserve-0000000004';
    for (const op of [a, b]) { await declare(op, op); await repo.markStored({ ...s(op), at: AT }); }
    expect((await repo.reserveRevision({ ...s(a), at: AT })).sequence).toBe(1);
    expect((await repo.reserveRevision({ ...s(b), at: AT })).sequence).toBe(2);
  });
});

describe('the migration refuses what only a rogue statement could try', () => {
  it('refuses a state that skips ahead, a reserved or final state without a recorded revision, and a revision from an unstored upload', async () => {
    const { db, repo, declare } = world(), op = 'op-trigger-00000000001';
    await declare(op);
    expect(() => db.exec("UPDATE submissions_upload SET state = 'finalized'")).toThrow(/fixed|needs its recorded revision/);
    expect(() => db.exec("UPDATE submissions_upload SET state = 'reserved'")).toThrow(/fixed|needs its recorded revision/);
    expect(states(db)).toEqual([{ operation_id: op, state: 'received' }]);
    await repo.markStored({ ...s(op), at: AT });
    expect(() => db.exec("UPDATE submissions_upload SET state = 'reserved'")).toThrow(/needs its recorded revision/);
    expect(() => db.exec("UPDATE submissions_upload SET state = 'finalized'")).toThrow(/needs its recorded revision/);
    expect(states(db)).toEqual([{ operation_id: op, state: 'stored' }]);
    await declare('op-trigger-00000000002', 'y');
    expect(() => db.exec(`INSERT INTO submissions_revision VALUES ('client-a', 'case-a', 'subrev-x', 1, 'op-trigger-00000000002', 1, '${AT}')`)).toThrow(/immutable/);
    expect(db.rows('SELECT * FROM submissions_revision')).toEqual([]);
  });

  it('refuses a revision with a gap in its sequence and a file that does not match its declaration', async () => {
    const { db, repo, declare } = world(), op = 'op-trigger-00000000003';
    await declare(op);
    await repo.markStored({ ...s(op), at: AT });
    expect(() => db.exec(`INSERT INTO submissions_revision VALUES ('client-a', 'case-a', 'subrev-x', 4, '${op}', 1, '${AT}')`)).toThrow(/immutable/);
    db.exec(`INSERT INTO submissions_revision VALUES ('client-a', 'case-a', 'subrev-x', 1, '${op}', 1, '${AT}')`);
    expect(() => db.exec(`INSERT INTO submissions_file VALUES ('client-a', 'case-a', 'subrev-x', 'a/claim.pdf', 'a/claim.pdf', 'claim.pdf', 'application/pdf', 1, '${'f'.repeat(64)}', 'sub-${op}')`)).toThrow(/match its declaration/);
    expect(db.rows('SELECT * FROM submissions_file')).toEqual([]);
  });

  it('refuses to declare a second operation on an existing asset key and leaves the first row as it was', async () => {
    const { db, repo, declare } = world();
    await declare('op-trigger-00000000004', 'a', 'sub-shared');
    const before = db.rows('SELECT * FROM submissions_upload');
    await expect(declare('op-trigger-00000000005', 'b', 'sub-shared')).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(db.rows('SELECT * FROM submissions_upload')).toEqual(before);
    expect(await repo.upload({ ...s('op-trigger-00000000005') })).toBeNull();
  });
});
