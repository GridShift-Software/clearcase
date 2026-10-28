// GRS-261 fix round: the cloud reader's keyed documentRow keeps the final authority and publication fence. A publication
// withdrawn while the row read is in flight releases nothing, and the projection it does release is frozen.
import { expect, it } from 'vitest';
import { hostedWorld } from '../../hosted-foundation/budget/harness.ts';
import type { ResultsVersion } from '../../../src/lib/server/runtime/contracts.ts';

const KEYED = 'SELECT ref, ord, row_json, state_json, list_json FROM rs_document WHERE version_id = ? AND ref = ?';

/** A world whose keyed row read waits, after it is issued, until `resume()`. */
async function heldWorld() {
  const w = await hostedWorld();
  const rv = w.resultsVersion! as ResultsVersion;
  const ref = w.db.rows<{ ref: string }>('SELECT ref FROM rs_document WHERE version_id = ? ORDER BY ord LIMIT 1', rv)[0]!.ref;
  let resume!: () => void, issued!: () => void;
  const gate = new Promise<void>((r) => { resume = r; }), reached = new Promise<void>((r) => { issued = r; });
  const hold = (s: object): object => new Proxy(s, { get(t, k) {
    const v = (t as Record<string | symbol, unknown>)[k];
    if (k === 'bind') return (...a: unknown[]) => hold((v as (...a: unknown[]) => object).apply(t, a));
    if (k === 'first') return async (...a: unknown[]) => { issued(); await gate; return (v as (...a: unknown[]) => unknown).apply(t, a); };
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  } });
  const prepare = w.db.prepare.bind(w.db);
  w.db.prepare = ((sql: string) => (sql === KEYED ? hold(prepare(sql)) : prepare(sql))) as typeof w.db.prepare;
  const withdraw = () => w.db.exec("INSERT INTO rs_version_withdrawal (version_id, case_id, withdrawn_at) VALUES (?, ?, '2001-01-02T00:00:00Z')", rv, w.caseId);
  return { w, rv, ref, resume, reached, withdraw };
}

it('261 a publication withdrawn while the keyed row read is in flight releases no document', async () => {
  const { w, rv, ref, resume, reached, withdraw } = await heldWorld();
  const pending = w.locals.store.documentRow({ caseId: w.caseId, resultsVersion: rv, ref });
  pending.catch(() => undefined);
  await reached; await new Promise((r) => setTimeout(r, 0)); // every check issued before the row has answered
  withdraw(); resume();
  await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
});

it('261 an unknown ref is fenced too: after a withdrawal it is refused, not answered null', async () => {
  const { w, rv, resume, reached, withdraw } = await heldWorld();
  const pending = w.locals.store.documentRow({ caseId: w.caseId, resultsVersion: rv, ref: 'NO-SUCH-REF' });
  pending.catch(() => undefined);
  await reached; await new Promise((r) => setTimeout(r, 0));
  withdraw(); resume();
  await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
});

it('261 the released document row is frozen, nested fields included', async () => {
  const { w, rv, ref, resume } = await heldWorld();
  resume();
  const row = (await w.locals.store.documentRow({ caseId: w.caseId, resultsVersion: rv, ref }))!;
  expect(row.ref).toBe(ref);
  expect([Object.isFrozen(row), Object.isFrozen(row.state), Object.isFrozen(row.list), Object.isFrozen(row.row)]).toEqual([true, true, true, true]);
});
