// Ticket 17a call budgets over the synthetic SQLite/D1 double. These count calls; they do not measure a deployed Worker or a save time.
import { expect, it } from 'vitest';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { hostedRegisterActions, hostedRegisterLoad } from '../../../src/lib/views/registers/hosted.server.ts';
import { hostedRegisterSlots } from '../../../src/lib/views/hosted/overview-slots.server.ts';
import { counters, countedD1, measure } from './harness.ts';
import { authority, auditLog, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, RV1, SHA_A } from '../user-work/world.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';

function world() {
  const db = database(); bind(db);
  const c = counters(), auth = authority(); auth.grant('editor', CASE, 'editor');
  const reader = caseReader({ published: RV1, versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }] } });
  const raw = d1(db);
  let batches = 0;
  const batch = raw.batch;
  raw.batch = async (statements) => { batches++; return batch(statements); };
  const work = createD1UserWork({ db: countedD1(raw, c), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(), audit: auditLog().sink, store: reader.reader, now: () => new Date('2026-11-01T10:00:00Z') });
  const locals = {
    userWork: work, runtime: { now: () => new Date('2026-11-01T10:00:00Z') },
    store: { publication: async () => ({ versionId: RV1, publishedAt: null, previousVersionId: null, shardManifestSha256: 'a'.repeat(64), shards: { 'doc/D-001.json': 100 } }) },
  } as unknown as C.RequestServices;
  const params = { caseId: CASE, version: RV1 };
  const save = (view: 'deadlines_tab' | 'timesheet_tab', fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return hostedRegisterActions(view).save({ locals, params, request: new Request('https://synthetic.invalid/?/save', { method: 'POST', body: form }) } as never);
  };
  return { db, c, locals, params, save, batches: () => batches };
}
const deadline = { title: 'Synthetic budget deadline', date: '2026-11-04', cat: 'Filing', note: '' };

it('17a a register page view is one D1 query beyond authorization, and no R2 or Clerk call', async () => {
  const w = world();
  try {
    await w.save('deadlines_tab', deadline);
    const result = await measure(w.c, () => hostedRegisterLoad('deadlines_tab')({ locals: w.locals, params: w.params } as never));
    expect(result.thrown).toBeUndefined();
    expect(result.value?.rows).toHaveLength(1);
    expect(result.counts).toMatchObject({ d1: 1, clerk: 0, r2: 0, otherFetch: 0 });
  } finally { w.db.close(); }
});

it('17a a register page with document refs stays at one query while the refs are of this version', async () => {
  const w = world();
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries({ ref: 'D-001', date: '2026-11-02', desc: 'Synthetic', basis: 'Litigation' })) form.set(k, v);
    await hostedRegisterActions('privilege_tab').save({ locals: w.locals, params: w.params, request: new Request('https://synthetic.invalid/?/save', { method: 'POST', body: form }) } as never);
    const result = await measure(w.c, () => hostedRegisterLoad('privilege_tab')({ locals: w.locals, params: w.params } as never));
    expect(result.thrown).toBeUndefined();
    expect(result.counts.d1).toBe(1);
  } finally { w.db.close(); }
});

// The ticket's one-batch target, met since GRS-266: the register row, its operation ledger and its audit event commit in
// one batch, as note changes do, with no acknowledgement batch after it.
it('17a a deadline save is one batch: the change and its audit together', async () => {
  const w = world();
  try {
    const result = await measure(w.c, () => w.save('deadlines_tab', deadline));
    expect(result.thrown).toBeUndefined();
    expect(result.value).toMatchObject({ saved: true });
    expect(w.batches()).toBe(1);
    expect(w.db.prepare("SELECT count(*) AS n FROM uw_operation WHERE audited_at IS NOT NULL").get()).toEqual({ n: 1 });
    console.log('17a deadline save foreground calls (authorization double; preflight reads included)', result.counts, 'batches', w.batches(), 'target=1');
  } finally { w.db.close(); }
});

it('17a a replayed save (same operation id) writes nothing more', async () => {
  const w = world();
  try {
    await w.save('deadlines_tab', { ...deadline, operationId: 'one-write' });
    const before = w.batches();
    await w.save('deadlines_tab', { ...deadline, operationId: 'one-write' });
    expect(w.db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 1 });
    expect(w.batches()).toBe(before);
  } finally { w.db.close(); }
});

it('17a the overview\'s two register tiles add two D1 queries and fill from the saved rows', async () => {
  const w = world();
  try {
    await w.save('deadlines_tab', deadline);
    await w.save('deadlines_tab', { ...deadline, title: 'Past', date: '2026-10-01' });
    await w.save('timesheet_tab', { date: '2026-11-02', fee_earner: 'A', activity: 'B', hours: '2', rate: '500', billed: 'no' });
    const result = await measure(w.c, () => hostedRegisterSlots(w.locals, { caseId: CASE }));
    expect(result.thrown).toBeUndefined();
    expect(result.counts.d1).toBe(2);
    expect(result.value).toMatchObject([
      { slot: { id: 'deadlines' }, status: 'filled', data: { value: '1' } },
      { slot: { id: 'unbilled-time' }, status: 'filled', data: { value: '2.0 h' } },
    ]);
  } finally { w.db.close(); }
});

it('17a a register that cannot be read leaves its tile in an error state and the other tile filled', async () => {
  const w = world();
  try {
    const inner = w.locals.userWork;
    const userWork = { ...inner, readViewWork: async (a: Parameters<typeof inner.readViewWork>[0]) => { if (a.store === 'timesheet') throw new Error('synthetic outage'); return inner.readViewWork(a); } };
    const slots = await hostedRegisterSlots({ ...w.locals, userWork }, { caseId: CASE });
    expect(slots.map((s) => [s.slot.id, s.status])).toEqual([['deadlines', 'filled'], ['unbilled-time', 'error']]);
  } finally { w.db.close(); }
});
