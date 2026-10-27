// Fix round 3 (N1): a failed settlement write must not pin a session's capacity for good. Real service/stager and D1 adapters; local SQLite/R2 doubles, not provider evidence.
import { expect, it } from 'vitest';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { buildFixture, pdf } from './fixtures.ts';
import { sha256Hex, Durable, startProcess, RecordingStager, submissionOf } from './staged-world.ts';
import { STAGED_SESSION_TTL_MS, WRITER_RECOVERY_GRACE_MS, d1StagingLedger } from '../../../src/lib/results-review/native/staging/index.ts';

async function world() {
  const bytes = pdf('writer');
  const fx = buildFixture({ docs: [{ ref: 'OD-001', path: 'Letters/a.pdf', bytes }] });
  const durable = new Durable();
  const cap = [...fx.files.values()].reduce((n, b) => n + b.length, 0);
  const submissions = await submissionOf('case-a', [{ path: 'Letters/a.pdf', size: bytes.length, sha256: sha256Hex(bytes) }]);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const p = await startProcess({ durable, caseId: 'case-a', submissions, stager: new RecordingStager(), maxStagedBytes: cap, now: () => new Date(now) });
  const ledger = d1StagingLedger(durable.db, { rowsPerBatch: 3 });
  const key = { clientId: id('client', 'client-a'), caseId: id('case', 'case-a'), operationId: 'op-settle' };
  const staged = p.service.staged!;
  const open = (operationId = key.operationId) => staged.open(p.token, { operationId, submissionRevisionId: 'subrev-staged', manifest: fx.files.get('manifest.json')! });
  const files = () => new Map([...fx.files].filter(([path]) => path !== 'manifest.json'));
  const put = () => staged.put(p.token, { operationId: key.operationId, files: files() });
  const sweep = () => staged.sweep(p.token, { operationId: key.operationId });
  const stored = () => [...durable.r2.objects.values()].reduce((n, o) => n + o.bytes.length, 0);
  // Fails the settlement write (the writer-end insert) the next `times` times; the process stays alive.
  const failSettlement = (times: number) => {
    const prepare = durable.db.prepare.bind(durable.db);
    let left = times, seen = 0;
    durable.db.prepare = ((sql: string) => {
      if (left > 0 && sql.includes("'writer-end', w.key")) { left--; seen++; return { bind: () => ({ run: async () => { throw new Error('D1_ERROR: Network connection lost.'); } }) }; }
      return prepare(sql);
    }) as typeof durable.db.prepare;
    return { restore: () => { durable.db.prepare = prepare; }, seen: () => seen };
  };
  return { durable, cap, key, ledger, open, put, sweep, stored, failSettlement, advance: (ms: number) => { now += ms; }, now: () => now };
}

it('settles a writer after one transient settlement failure, so a sweep releases the session', async () => {
  const w = await world();
  expect((await w.open()).kind).toBe('progress');
  const fault = w.failSettlement(1);
  const out = await w.put();
  fault.restore();
  expect(fault.seen()).toBe(1);
  expect(out.kind).toBe('progress');
  expect(await w.ledger.writing(w.key)).toBe(false);
  w.advance(STAGED_SESSION_TTL_MS + 1);
  let last: unknown = null;
  for (let i = 0; i < 6; i++) last = await w.sweep();
  expect(last).toMatchObject({ state: 'done' });
  expect(await w.ledger.held(w.key)).toBe(0);
  expect(w.stored()).toBe(0);
});

it('fails the request when settlement keeps failing, holds the quota, and the recovery path releases it after a full sweep', async () => {
  const w = await world();
  expect((await w.open()).kind).toBe('progress');
  const fault = w.failSettlement(100);
  const failed = await w.put().then(() => null, (e) => e);
  fault.restore();
  expect(failed).not.toBeNull(); // visible, not a quiet success
  expect(fault.seen()).toBeGreaterThan(1); // retried, bounded
  expect(fault.seen()).toBeLessThan(10);
  expect(await w.ledger.writing(w.key)).toBe(true);
  w.advance(STAGED_SESSION_TTL_MS + 1);
  expect(await w.sweep()).toMatchObject({ state: 'sweeping', deleted: 0 });
  expect(await w.ledger.held(w.key)).toBe(w.cap);
  expect(w.stored()).toBeGreaterThan(0);
  // Younger than the grace period: refused, nothing changes.
  const young = new Date(w.now() - STAGED_SESSION_TTL_MS - 1).toISOString();
  expect(await w.ledger.recoverWriters({ ...w.key, startedBefore: young })).toBe(0);
  expect(await w.ledger.writing(w.key)).toBe(true);
  // Older than the grace period: the matching writer-end is inserted, and recovering twice is harmless.
  const cutoff = new Date(w.now() - WRITER_RECOVERY_GRACE_MS).toISOString();
  expect(await w.ledger.recoverWriters({ ...w.key, startedBefore: cutoff })).toBe(1);
  expect(await w.ledger.recoverWriters({ ...w.key, startedBefore: cutoff })).toBe(0);
  expect(await w.ledger.writing(w.key)).toBe(false);
  let last: unknown = null;
  for (let i = 0; i < 6 && (last as { state?: string } | null)?.state !== 'done'; i++) last = await w.sweep();
  expect(last).toMatchObject({ state: 'done' });
  expect(await w.ledger.held(w.key)).toBe(0);
  expect(w.stored()).toBe(0);
});

it('does not recover a writer that has no sweep under way', async () => {
  const w = await world();
  expect((await w.open()).kind).toBe('progress');
  const fault = w.failSettlement(100);
  await w.put().catch(() => undefined);
  fault.restore();
  w.advance(WRITER_RECOVERY_GRACE_MS * 2);
  const cutoff = new Date(w.now() - WRITER_RECOVERY_GRACE_MS).toISOString();
  expect(await w.ledger.recoverWriters({ ...w.key, startedBefore: cutoff })).toBe(0);
  expect(await w.ledger.writing(w.key)).toBe(true);
});

it('surfaces the R2 put error, not the settlement error, and still settles', async () => {
  const w = await world();
  expect((await w.open()).kind).toBe('progress');
  const original = w.durable.r2.put.bind(w.durable.r2);
  w.durable.r2.put = async () => { throw new Error('R2_PUT_FAILED'); };
  const err = await w.put().then(() => null, (e) => e);
  expect(String(err?.message ?? err)).toContain('R2_PUT_FAILED');
  expect(await w.ledger.writing(w.key)).toBe(false);
  // Both fail: the put's own error is the one the caller sees; the unsettled writer is left for the recovery path.
  const fault = w.failSettlement(100);
  const both = await w.put().then(() => null, (e) => e);
  fault.restore();
  w.durable.r2.put = original;
  expect(String(both?.message ?? both)).toContain('R2_PUT_FAILED');
  expect(await w.ledger.writing(w.key)).toBe(true);
});
