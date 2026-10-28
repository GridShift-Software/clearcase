// The request budget harness (./harness.ts) over the hosted routes that exist today, `/cases` and `/cases/[caseId]`, and its
// own self-test. The interim budgets below are generous on purpose: they sit just above what the routes make now (the
// counts are in the PR body) and only tighten, towards PAGE_VIEW in ./budget.ts, as the tickets that own each route land.
// UNIT counts over D1 and R2 doubles, with an identity that makes no D1 or Clerk call: see the note at the top of ./harness.ts.
import { describe, expect, it } from 'vitest';
import { load as casesLoad } from '../../../deploy/client/routes/cases/+page.server.ts';
import { load as caseLoad } from '../../../deploy/client/routes/cases/[caseId]/+page.server.ts';
import { MUTATION, PAGE_VIEW, PDF_RANGE, type Budget } from './budget.ts';
import { BudgetExceeded, assertWithinBudget, counters, countedD1, countedR2, expectWithinBudget, hostedWorld, measure, overruns, routeEvent } from './harness.ts';
import { deployment } from '../storage/fixture.ts';

/** Today's ceilings, a little above the counts of 28 October (/cases: 2 D1, 1 R2; /cases/[caseId]: 21 D1, 2 R2), so a route that gets chattier fails here. */
const INTERIM = {
  cases: { clerk: 0, d1: 3, r2: 2 },
  caseOverview: { clerk: 0, d1: 25, r2: 3 },
} satisfies Record<string, Budget>;

describe('request budget: the hosted routes that exist today', () => {
  it('/cases lists the client\'s cases within its interim budget', async () => {
    const w = await hostedWorld();
    const r = await expectWithinBudget('/cases', INTERIM.cases, w.counters, () => casesLoad(routeEvent(w.locals)));
    expect(r.thrown).toBeUndefined();
    expect(r.value).toMatchObject({ cases: [{ caseId: 'case-a', published: true }] });
    console.info(`budget counts /cases ${JSON.stringify(r.counts)}`);
  });

  it('/cases/[caseId] shows the published overview within its interim budget', async () => {
    const w = await hostedWorld();
    const r = await expectWithinBudget('/cases/[caseId]', INTERIM.caseOverview, w.counters, () => caseLoad(routeEvent(w.locals, { caseId: 'case-a' }, 'https://client-a.example.invalid/cases/case-a')));
    expect(r.thrown).toBeUndefined();
    expect(r.value).toMatchObject({ caseId: 'case-a', overview: { documents: { total: 2 } }, originals: { state: 'available' } });
    console.info(`budget counts /cases/[caseId] ${JSON.stringify(r.counts)}`);
  });

  it('/cases/[caseId] for a case with no published version reads far less', async () => {
    const w = await hostedWorld({ published: false });
    const r = await expectWithinBudget('/cases/[caseId] pending', INTERIM.caseOverview, w.counters, () => caseLoad(routeEvent(w.locals, { caseId: 'case-a' }, 'https://client-a.example.invalid/cases/case-a')));
    expect(r.value).toMatchObject({ results: { kind: 'pending' }, overview: null });
    console.info(`budget counts /cases/[caseId] pending ${JSON.stringify(r.counts)}`);
  });

  it('the target budgets are the spec\'s, and the routes are not at them yet', async () => {
    expect(PAGE_VIEW).toEqual({ clerk: 0, d1: 1, r2: 1 });
    expect(PDF_RANGE).toEqual({ clerk: 0, d1: 0, r2: 1 });
    expect(MUTATION).toEqual({ clerk: 0, d1: 1 });
    const w = await hostedWorld();
    const r = await measure(w.counters, () => caseLoad(routeEvent(w.locals, { caseId: 'case-a' }, 'https://client-a.example.invalid/cases/case-a')));
    // Documents today's distance from PAGE_VIEW; when a ticket brings the route within it, tighten INTERIM and drop this line.
    expect(overruns(r.counts, PAGE_VIEW).length).toBeGreaterThan(0);
  });
});

describe('request budget: the harness fails a route above its budget', () => {
  const clerk = 'https://clerk.example.invalid/v1/client';
  /** A route that makes `n` Clerk calls, `d` D1 statements and `r` R2 reads, as the real ones would. */
  const chatty = (w: Awaited<ReturnType<typeof hostedWorld>>, n: { clerk?: number; d1?: number; r2?: number; other?: number }) => async () => {
    for (let i = 0; i < (n.clerk ?? 0); i++) await fetch(clerk);
    for (let i = 0; i < (n.other ?? 0); i++) await fetch('https://elsewhere.example.invalid/');
    const db = countedD1(w.db, w.counters), bucket = countedR2(w.bucket, w.counters);
    for (let i = 0; i < (n.d1 ?? 0); i++) await db.prepare('SELECT 1 AS one').first();
    for (let i = 0; i < (n.r2 ?? 0); i++) await bucket.head('identity/client.json');
    return 'ok';
  };

  it('passes a route that makes exactly its budget', async () => {
    const w = await hostedWorld({ published: false });
    const r = await expectWithinBudget('chatty', { clerk: 2, d1: 1, r2: 1 }, w.counters, chatty(w, { clerk: 2, d1: 1, r2: 1 }));
    expect(r.counts).toEqual({ clerk: 2, d1: 1, r2: 1, otherFetch: 0 });
  });

  it('fails a route with one Clerk call more than its budget', async () => {
    const w = await hostedWorld({ published: false });
    const err = await expectWithinBudget('chatty', { clerk: 2, d1: 1, r2: 1 }, w.counters, chatty(w, { clerk: 3, d1: 1, r2: 1 })).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect(err.over).toEqual(['clerk: 3 calls, budget 2']);
  });

  it('fails one D1 query more, one R2 read more, and a fetch to any other host', async () => {
    const w = await hostedWorld({ published: false });
    const budget = { clerk: 0, d1: 1, r2: 1 };
    expect((await expectWithinBudget('d1', budget, w.counters, chatty(w, { d1: 2 })).catch((e) => e)).over).toEqual(['d1: 2 calls, budget 1']);
    expect((await expectWithinBudget('r2', budget, w.counters, chatty(w, { r2: 2 })).catch((e) => e)).over).toEqual(['r2: 2 calls, budget 1']);
    expect((await expectWithinBudget('other', budget, w.counters, chatty(w, { other: 1 })).catch((e) => e)).over).toEqual(['otherFetch: 1 calls to a host that is not Clerk, budget 0']);
  });

  it('counts one batch as one D1 round trip, however many statements it holds', async () => {
    const dep = deployment('client-a', []), c = counters(), db = countedD1(dep.db, c);
    const insert = (name: string) => db.prepare('INSERT INTO rs_case (case_id, case_label) VALUES (?, ?)').bind(name, name);
    const r = await measure(c, () => db.batch([insert('case-x'), insert('case-y'), insert('case-z')]));
    expect(r.thrown).toBeUndefined();
    expect(r.counts.d1).toBe(1);
    expect(() => assertWithinBudget('mutation', r.counts, MUTATION)).not.toThrow();
    expect(dep.db.rows('SELECT case_id FROM rs_case ORDER BY case_id')).toHaveLength(3);
  });

  it('restores fetch after the route, and does not count the setup before it', async () => {
    const before = globalThis.fetch;
    const w = await hostedWorld({ published: false });
    expect(w.counters.snapshot()).toEqual({ clerk: 0, d1: 0, r2: 0, otherFetch: 0 });
    await measure(w.counters, async () => { await fetch(clerk); });
    expect(globalThis.fetch).toBe(before);
    await measure(w.counters, async () => { throw new Error('refused'); });
    expect(globalThis.fetch).toBe(before);
  });
});
