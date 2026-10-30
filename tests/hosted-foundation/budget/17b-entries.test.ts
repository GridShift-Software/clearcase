// Ticket 17b call budgets over the synthetic SQLite/D1 double: what each of the seven views' writes costs, and that a page view
// is still the one user-work query 14b budgeted. These count calls; they do not measure a deployed Worker or a save time.
import { expect, it } from 'vitest';
import * as authorities from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/authorities_tab/+page.server.ts';
import * as heads from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/heads_tab/+page.server.ts';
import * as crossexam from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/crossexam_tab/+page.server.ts';
import * as enforcement from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/enforcement_tab/+page.server.ts';
import * as payments from '../../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/payments_tab/+page.server.ts';
import * as filings from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/filings_tab/+page.server.ts';
import * as info from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/info_required_tab/+page.server.ts';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { counters, countedD1, measure } from './harness.ts';
import { authority, auditLog, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, RV1, SHA_A } from '../user-work/world.ts';
import { list, localsOf, post } from '../../litigation/17b-world.ts';

function world() {
  const db = database(); bind(db);
  const c = counters(), auth = authority(); auth.grant('editor', CASE, 'editor');
  const reader = caseReader({ published: RV1, versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }] } });
  const raw = d1(db);
  let batches = 0;
  const batch = raw.batch;
  raw.batch = async (statements) => { batches++; return batch(statements); };
  const work = createD1UserWork({ db: countedD1(raw, c), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(), audit: auditLog().sink, store: reader.reader, now: () => new Date('2026-11-01T10:00:00Z') });
  return { db, c, locals: localsOf(work, auth.identity()), params: { caseId: CASE, version: RV1 }, batches: () => batches, reset: () => { batches = 0; } };
}
type W = ReturnType<typeof world>;
const at = (w: W) => w as never;

// The views, each with one synthetic entry to add and what to read back after it.
const entry = { head: 'Synthetic heading', sub: 'Synthetic submission', auth: '', ref: '' };
const adds: [string, { actions?: Record<string, unknown>; load?: unknown }, string, Record<string, string>][] = [
  ['authorities_tab', authorities, 'add', { topic: '', authority: 'Synthetic v Budget', proposition: '' }],
  ['heads_tab', heads, 'add', entry],
  ['crossexam_tab', crossexam, 'add', { witness: 'Synthetic witness', topic: 'T', put: '', docs: '' }],
  ['payments_tab', payments, 'add', { date: '2026-03-01', amount: '10.00', method: '', note: '' }],
  ['filings_tab', filings, 'add', { filing: 'Synthetic notice', fdate: '', fparty: '', response: '', rdate: '', ref: '' }],
  ['info_required_tab', info, 'toggle', { key: 'info:one', done: 'true', version: 'none' }],
  ['enforcement_tab', enforcement, 'status', { stepKey: 'step-key-1', status: 'Done', version: 'none' }],
];

// The ticket's one-batch target, met since GRS-266: a register row, seed overlay or table row change commits with its
// operation ledger and its audit event in one batch, as note changes do, with no acknowledgement batch after it.
it.each(adds)('17b a %s save is one batch: the change and its audit together', async (name, route, action, form) => {
  const w = world();
  try {
    const result = await measure(w.c, () => post(at(w) as never, route, action, form));
    expect(result.thrown).toBeUndefined();
    expect(result.value).not.toMatchObject({ status: expect.any(Number) });
    expect(w.batches()).toBe(1);
    expect(w.db.prepare('SELECT count(*) AS n FROM uw_operation WHERE audited_at IS NOT NULL').get()).toEqual({ n: 1 });
    console.log(`17b ${name} save: foreground calls`, result.counts, 'batches', w.batches(), 'target=1');
  } finally { w.db.close(); }
});

const deletes: [string, { actions?: Record<string, unknown>; load?: unknown }, (row: any) => Record<string, string>, (page: any) => any][] = [
  ['heads_tab', heads, (r) => ({ rowId: r.del, confirm: r.del }), (p) => p.rows[0]],
  ['payments_tab', payments, (r) => ({ rowId: r.rowId, hash: r.hash }), (p) => p.payments[0]],
  ['crossexam_tab', crossexam, (r) => ({ seedId: r.del, confirm: r.del }), (p) => p.rows[0]],
];
it.each(deletes)('17b a %s delete is one batch: the change and its audit together', async (name, route, form, pick) => {
  const w = world();
  try {
    if (name !== 'crossexam_tab') await post(at(w) as never, route, 'add', name === 'heads_tab' ? entry : { date: '', amount: '10.00', method: '', note: '' });
    const row = pick(await list(at(w) as never, route));
    w.reset();
    const result = await measure(w.c, () => post(at(w) as never, route, 'delete', form(row)));
    expect(result.thrown).toBeUndefined();
    expect(result.value).toMatchObject({ op: 'delete' });
    expect(w.batches()).toBe(1);
    console.log(`17b ${name} delete: foreground calls`, result.counts, 'batches', w.batches(), 'target=1');
  } finally { w.db.close(); }
});

it('17b a replayed save (same operation id) writes nothing more', async () => {
  const w = world();
  try {
    const form = { ...entry, addId: 'ffffffff-1111-2222-3333-444444444444' };
    await post(at(w) as never, heads, 'add', form);
    const before = w.batches();
    await post(at(w) as never, heads, 'add', form);
    expect(w.db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 1 });
    expect(w.batches()).toBe(before);
  } finally { w.db.close(); }
});

// 14b's read budget for these routes is asserted over the built synthetic case in 14b-mixed.test.ts, which runs these same
// routes' loads; this checks that the loads kept to one user-work query beyond authorization after the writes were added.
it.each([['authorities_tab', authorities], ['heads_tab', heads], ['crossexam_tab', crossexam], ['payments_tab', payments], ['filings_tab', filings], ['info_required_tab', info], ['enforcement_tab', enforcement]] as const)('17b a %s page view is one D1 query beyond authorization, and no Clerk call', async (_name, route) => {
  const w = world();
  try {
    const result = await measure(w.c, () => list(at(w) as never, route));
    expect(result.thrown).toBeUndefined();
    expect(result.counts).toMatchObject({ d1: 1, clerk: 0, otherFetch: 0 });
  } finally { w.db.close(); }
});
